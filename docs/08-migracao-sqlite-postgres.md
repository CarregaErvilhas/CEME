# 08 — Dois backends de BD: SQLite (dev) e PostgreSQL (produção)

> **Estado:** a migração está feita. A produção corre em PostgreSQL (serviço
> `db` no Zerops); dev e testes correm em SQLite. O SQLite **não** foi
> substituído — ficou como backend de dev, de propósito: arranque sem
> dependências e testes sem servidor. Este documento descreve como os dois
> convivem; o plano original da migração está no histórico do git.

## Porquê PostgreSQL em produção

Um ficheiro SQLite no contentor não sobrevive a um redeploy no Zerops (sem
disco persistente garantido) e não é partilhado entre réplicas. O
PostgreSQL gerido resolve persistência, backups e réplicas.

## Quem escolhe

O **ambiente**, não o código: `backend/src/db.js` usa o PostgreSQL quando há
`DATABASE_URL`, e o `node:sqlite` (`DB_PATH`, por omissão
`backend/data/ceme.db`) quando não há. O resto do código só vê
`query`/`get`/`run` (assíncronos) e escreve SQL num dialecto comum.

| peça | SQLite | PostgreSQL |
|---|---|---|
| ligação | `db.js` (`node:sqlite`) | `db/pg.js` (pool lazy; parsers de tipo) |
| schema | `db/schema.sql` | `db/schema.postgres.sql` |
| seed | `db/seed.js` | `db/seed.postgres.js` |
| placeholders | `$1, $2…` traduzidos para `?` em `db.js` | nativos |

## Regras para os dois dialectos

- **SQL comum.** `$N` em todo o lado; `ON CONFLICT … DO UPDATE` (upsert)
  funciona nos dois; `"from"`/`"to"` entre aspas (são reservadas).
- **Datas são texto `YYYY-MM-DD`.** No pg, o `pg.js` regista parsers para que
  `DATE`/`TIMESTAMP` não virem `Date` (que serializava como o dia anterior em
  UTC) — guardado em `pg-parity.test.js`.
- **"Hoje" vem do código, não da BD.** Nada de `CURRENT_DATE` para validades:
  é o dia UTC (o pool corre em UTC) e o SQLite também. O dia civil passa-se
  como parâmetro (`civilDay()`, ver docs/02).
- **Os dois schemas andam juntos.** Uma coluna, um índice ou uma tabela nova
  vai aos dois ficheiros. Os dois seeds também: `seed-parity.test.js`
  compara os dados (`CEMES`, `TARIFFS`, `NOTES`, `VERSIONS`, `CAMPAIGN_END`)
  e falha se divergirem.
- **O seed é convergente**, não "só insere": `ON CONFLICT … DO UPDATE` — um
  arranque com o seed novo actualiza os valores que mudaram (e não reabre
  campanhas que um operador fechou: `valid_to` fica de fora do UPDATE).

## Migrações (`db/migrate.js`)

O `CREATE TABLE IF NOT EXISTS` não acrescenta colunas a uma tabela que já
existe — foi isso que um dia deixou a produção em crash loop. Por isso, no
arranque (`server.js`), por esta ordem:

1. `migrateOmieTables()` — **antes** do schema: renomeia colunas cujo nome
   mudou (ex. `day_utc` → `day_lisbon`, sem perder dados) e só depois deita
   fora tabelas do OMIE com uma forma antiga incompatível (o schema recria-as);
2. o schema do dialecto;
3. `migrateAddedColumns()` — colunas novas em tabelas que já existem
   (`ADDED_COLUMNS`);
4. TAR, chave da env, seed, derivados do OMIE.

`migrate.test.js` cobre estes caminhos em SQLite. **Lacuna conhecida:** não
há testes end-to-end contra um PostgreSQL real (os caminhos `to_regclass`
do `migrate.js`, por exemplo, só correm em produção). Está no roadmap.

## Variáveis de ambiente

| variável | o que é | onde se define |
|---|---|---|
| `DATABASE_URL` | liga ao PostgreSQL | `zerops.yml` (`${db_connectionString}`, do serviço `db`) |
| `DB_PATH` | ficheiro SQLite (só sem `DATABASE_URL`) | local |
| `JWT_SECRET` | assina as sessões web | env secret do serviço `api` (gerada no import; editável na GUI) |
| `NODE_ENV` | `production` faz o `/v1/session` recusar a secret de dev (503) | `zerops.yml` |
| `CEME_API_KEY` | chave de terceiros (docs/04) | env secret, opcional |
| `CEME_READONLY`, `CEME_SKIP_SEED` | previews e snapshots (`docs/preview-envs.md`) | por ambiente |

As fontes e os TTLs do OMIE não são env vars: estão em `omie/tf.js`,
`omie/omiees.js` e `omie/pipeline.js` (docs/03).

## Verificar um deploy

`GET /healthz` (processo vivo) e `GET /readyz` (processo + BD, só de
loopback) são as rotas sem auth; o resto (`/v1/*`) precisa de sessão ou
chave. Ver `infra.md`.

## Voltar ao SQLite

Não há volta "de produção": os dados da produção (OMIE ingerido, chaves)
vivem no PostgreSQL e divergiram de qualquer `ceme.db` local (que está no
`.gitignore`). Correr sem `DATABASE_URL` dá um SQLite novo, semeado do zero
— serve para dev, não para recuperar a produção.
