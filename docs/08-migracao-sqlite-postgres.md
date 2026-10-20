# 08 — Migração SQLite → PostgreSQL (Zerops)

Objetivo: substituir o ficheiro SQLite local (`./data/ceme.db`) por uma
base de dados PostgreSQL gerenciada no Zerops, mantendo o backend
Node.js funcional e os 74 testes verdes.

## Porquê

O POC usa `node:sqlite` + ficheiro `.db` local. Isso não sobrevive a
redeploy/container efémero no Zerops (sem disco persistente garantido entre
builds) e não escala para múltiplas instâncias da API. O PostgreSQL do
Zerops resolve persistência, backups automáticos e HA como toggle.

## Escopo da migração

| Camada | Mudança |
|---|---|
| Driver | `node:sqlite` (`DatabaseSync`) → `pg` (node-postgres, assíncrono) |
| Schema | `schema.sql` (SQLite) → `schema.postgres.sql` (PostgreSQL) |
| Seed | `seed.js` (SQLite sync) → `seed.postgres.js` (pg async) |
| Queries | `?` placeholders → `$1`, `$2`…; `date('now')` → `CURRENT_DATE` |
| Conexão | `DB_PATH` ficheiro → `DATABASE_URL` env (injetada pelo Zerops) |
| Testes | `node --test` continua a funcionar com uma BD de teste (testcontainers ou DB local) |

## Ficheiros a criar / editar

```
backend/
  package.json            # adicionar dependência pg
  src/
    server.js             # adaptar para pg + DATABASE_URL
    db/
      schema.postgres.sql # schema em dialeto PostgreSQL
      seed.postgres.js    # seed idempotente (INSERT ... ON CONFLICT)
      pg.js               # helper de conexão/pool pg
    engine/               # sem alteração (cálculo puro, sem SQL direto)
    omie/                 # sem alteração (ler ficheiros cache, não BD)
    auth/                 # sem alteração (JWT em memória)
  test/
    poc.test.js           # ajustar setup para BD pg de teste
zerops.yml                # já criado (api + db + cache)
```

## Passo 1 — Adicionar dependência

```json
{
  "dependencies": {
    "pg": "^8.13.0"
  }
}
```

```sh
cd backend && npm install
```

## Passo 2 — Schema PostgreSQL (`backend/src/db/schema.postgres.sql`)

Diferenças chave vs SQLite:
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`
- `TEXT PRIMARY KEY` mantém-se
- `datetime('now')` → `now()`
- `REAL` → `REAL` (ou `DOUBLE PRECISION`)
- `INTEGER DEFAULT 0` para booleans → `BOOLEAN DEFAULT FALSE` (ou manter INTEGER)
- Remover `PRAGMA journal_mode = WAL` (não existe no Postgres)

Exemplo das tabelas principais:

```sql
CREATE TABLE IF NOT EXISTS ceme (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand_color TEXT,
  website TEXT, email TEXT, phone TEXT, whatsapp TEXT,
  created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tariff (
  id TEXT PRIMARY KEY,
  ceme_id TEXT NOT NULL REFERENCES ceme(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('FIXED','INDEXED')),
  voltage TEXT NOT NULL CHECK (voltage IN ('BT','MT','BT_MT')),
  schedule TEXT NOT NULL CHECK (schedule IN ('SIMPLES','BI_HORARIA')),
  cycle TEXT NOT NULL CHECK (cycle IN ('DIARIO','SEMANAL','SIMPLES')),
  green BOOLEAN DEFAULT FALSE,
  access TEXT,
  bundle BOOLEAN DEFAULT FALSE,
  popular BOOLEAN DEFAULT FALSE,
  source_url TEXT,
  regions TEXT NOT NULL DEFAULT 'CONT'
);

CREATE TABLE IF NOT EXISTS tariff_version (
  id SERIAL PRIMARY KEY,
  tariff_id TEXT NOT NULL REFERENCES tariff(id),
  valid_from DATE NOT NULL,
  valid_to DATE,
  campaign INTEGER DEFAULT 0,
  status TEXT DEFAULT 'DRAFT',
  origin TEXT,
  k_index_eur_mwh REAL,
  cgs_eur_mwh REAL,
  omie_aggregation TEXT DEFAULT 'SPLIT_VAZIO_FORA',
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_component (
  tariff_version_id INTEGER NOT NULL REFERENCES tariff_version(id),
  period TEXT NOT NULL CHECK (period IN ('VAZIO','FORA_VAZIO','UNICO')),
  energy_eur_kwh REAL,
  activation_eur REAL DEFAULT 0,
  support_eur REAL DEFAULT 0,
  iec_eur_kwh REAL DEFAULT 0,
  PRIMARY KEY (tariff_version_id, period)
);

CREATE TABLE IF NOT EXISTS tar (
  valid_from DATE NOT NULL,
  valid_to DATE,
  region TEXT NOT NULL DEFAULT 'CONT',
  voltage TEXT NOT NULL,
  period TEXT NOT NULL,
  price_eur_kwh REAL NOT NULL,
  PRIMARY KEY (valid_from, region, voltage, period)
);

CREATE TABLE IF NOT EXISTS omie_spot (
  ts_lisbon TIMESTAMP PRIMARY KEY,
  market_day DATE,
  market_period INTEGER,
  price_pt_eur_mwh REAL NOT NULL,
  price_es_eur_mwh REAL,
  source TEXT NOT NULL,
  flags TEXT,
  ingested_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS omie_daily (
  date DATE PRIMARY KEY,
  avg_pt REAL, avg_vazio_pt REAL,
  avg_fora_vazio_pt REAL, min_pt REAL, max_pt REAL, source TEXT
);
-- loss_profile, suggestion, api_client, api_key, audit_log idênticas em estrutura
```

## Passo 3 — Helper de conexão (`backend/src/db/pg.js`)

```js
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL opcional; o Zerops injeta DATABASE_URL já com os parâmetros certos
});

export async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export async function run(sql, params = []) {
  return pool.query(sql, params);
}

export function close() {
  return pool.end();
}
```

## Passo 4 — Adaptar `server.js`

Substituir:

```js
import { DatabaseSync } from 'node:sqlite';
// ...
mkdirSync('./data', { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8'));
```

por:

```js
import { query, get, run, close } from './db/pg.js';
// ...
// schema executado uma vez no arranque (idempotente)
await run(await readFile(new URL('./db/schema.postgres.sql', import.meta.url)));
await seed();  // seed agora usa pg
```

E substituir todas as chamadas `db.prepare(...).all()/get()/run()` por `query()`/`get()`/`run()` com placeholders `$1`, `$2`…

Exemplo de conversão:

```js
// Antes (SQLite)
const row = db.prepare('SELECT * FROM tariff WHERE id=?').get(id);

// Depois (Postgres)
const row = await get('SELECT * FROM tariff WHERE id=$1', [id]);
```

Notas específicas no `server.js`:
- `date('now')` nas queries → `CURRENT_DATE`
- `INSERT OR IGNORE` → `INSERT ... ON CONFLICT (id) DO NOTHING`
- `AUTOINCREMENT` no `tariff_version` → `SERIAL` (já no schema)
- O `seed(db)` passa a ser `await seed()` (async)

## Passo 5 — Adaptar `seed.js`

O seed atual é síncrono e usa `DatabaseSync`. Criar `seed.postgres.js` com
`pg`, usando `query()` e `ON CONFLICT` para idempotência:

```js
export async function seed() {
  // ceme
  for (const c of CEMES) {
    await query(
      `INSERT INTO ceme (id, name, brand_color, website) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      c
    );
  }
  // tariff, tariff_version, price_component, tar — idêntico raciocínio
}
```

## Passo 6 — Testes

Os testes em `backend/test/*.test.js` usam `node:sqlite` diretamente.
Criar um ficheiro de setup de teste que:

1. Leia `DATABASE_URL_TEST` (Postgres local ou container)
2. Rode `schema.postgres.sql` + `seed.postgres.js`
3. Exporte um helper `db` com `query/get/run` compatível com o que os testes esperam

Se quiser evitar instalar Postgres local nos testes, usar `testcontainers`
ou rodar os testes contra o serviço `db` do Zerops num ambiente de staging.

## Passo 7 — Variáveis de ambiente (Zerops)

No `zerops.yml` já estão mapeadas:

| Variável | Origem |
|---|---|
| `DATABASE_URL` | injetado automaticamente pelo serviço `db` |
| `JWT_SECRET` | definir com `zcli secret set JWT_SECRET=<valor>` |
| `PORT` | `3001` |
| `OMIE_URL` / `TIAGO_OMIE_CSV` | fixas no `zerops.yml` |

## Ordem de execução recomendada

1. Criar `zerops.yml` (feito) + `schema.postgres.sql` + `pg.js` + `seed.postgres.js`
2. Adaptar `server.js` para usar `pg`
3. Adicionar `pg` ao `package.json` e `npm install`
4. Criar DB de teste local e rodar `npm test` → 74 testes verdes
5. `zcli deploy` → Zerops cria `api`, `db`, `cache` e injeta `DATABASE_URL`
6. Verificar `GET /v1/health` e `GET /v1/tariffs` no endpoint deployado

## Rollback

O ficheiro `./data/ceme.db` continua no repositório (gitignorado ou não).
Para voltar ao POC SQLite: remover as dependências `pg`, restaurar o
`server.js` original e desfazer o `zerops.yml`.
