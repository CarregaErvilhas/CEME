# 08 — Duas bases de dados: SQLite (dev) e PostgreSQL (produção)

O mesmo código corre contra duas bases de dados:

- **SQLite** em dev e nos testes: é um ficheiro, arranca sem instalares
  nada e os testes não precisam de servidor;
- **PostgreSQL** em produção (o serviço `db` no Zerops): sobrevive aos
  deploys, tem backups e é partilhado por todas as instâncias do servidor.
  Um ficheiro SQLite dentro do contentor perdia-se em cada deploy.

## Quem escolhe

O **ambiente**, não o código. `backend/src/db.js` usa o PostgreSQL quando
existe a variável `DATABASE_APP_URL` ou `DATABASE_URL` (a primeira ganha;
`db/url.js`), e o `node:sqlite` (ficheiro `DB_PATH`, por
omissão `backend/data/ceme.db`) quando não existe. O resto do código só vê
`query` / `get` / `run` / `exec` (assíncronas) e escreve SQL num dialecto
comum.

| peça | SQLite | PostgreSQL |
|---|---|---|
| ligação | `db/sqlite.js` (`node:sqlite`) | `db/pg.js` (pool criado na primeira query; conversões de tipos) |
| schema | `db/schema.sql` | `db/schema.postgres.sql` |
| seed | `db/seed.js` (o mesmo) | `db/seed.js` (o mesmo) |
| parâmetros | `$1, $2…` traduzidos para `?` em `db/sqlite.js` | nativos |

## Regras para escreveres SQL que corre nos dois

- **Parâmetros `$N`** sempre. Para "insere ou actualiza", usa
  `INSERT … ON CONFLICT … DO UPDATE SET col = EXCLUDED.col`, que funciona
  nos dois. `"from"` e
  `"to"` vão entre aspas (são palavras reservadas).
- **Escritas vão por `run()`**, nunca por `query()`: é o `run()` que respeita
  o modo readonly. Várias instruções de uma vez (o schema) vão por `exec()`,
  que também o respeita; o `run()` só corre uma.
- **Datas são texto `AAAA-MM-DD`.** No Postgres, o `pg.js` regista conversões
  para que `DATE` e `TIMESTAMP` não virem objectos `Date` (que, passados a
  JSON, podiam aparecer como o dia anterior). Testado em `pg-parity.test.js`.
- **"Hoje" vem do código, não da BD.** Nada de `CURRENT_DATE` para
  validades: dá o dia em UTC nos dois. O dia passa-se como parâmetro
  (`civilDay()`, vê [02](02-motor-calculo.md)).
- **Os dois schemas andam juntos.** Uma tabela, coluna ou índice novo vai aos
  dois ficheiros. O seed é um só (`db/seed.js`, com os dados em
  `db/seed-data.js`), por isso não há nada a sincronizar.
- **O seed é convergente:** um arranque com o seed novo actualiza os valores
  que mudaram, e não mexe em `valid_to` (para não reabrir uma versão
  fechada à mão).

## Arranque e migrações (`db/migrate.js`)

O schema corre em cada arranque com `CREATE TABLE IF NOT EXISTS`. Isso cria
tabelas que faltam, mas **não acrescenta colunas** a tabelas que já existem.
Por isso o arranque (`boot.js`) faz, por esta ordem:

1. o schema do dialecto em uso;
2. `migrateAddedColumns()` — acrescenta as colunas de `ADDED_COLUMNS` que
   faltem;
3. a chave da API, a TAR, o seed e os resumos do OMIE.

### Para acrescentares uma coluna a uma tabela que já existe

1. põe-na nos dois schemas (`schema.sql` e `schema.postgres.sql`);
2. põe-na em `ADDED_COLUMNS` (`db/migrate.js`);
3. põe-na na verificação do `backend/test/migrate.test.js` («toda a coluna
   nova do schema está na lista da migração»), que procura as colunas pelo
   nome e não descobre sozinho uma coluna nova.

Em produção os passos 1 e 2 não correm no processo da API: a role do
runtime não faz DDL. Correm em `db/migrate-cli.js`, com a role dona, e o
arranque só verifica que estão feitos (`CEME_SCHEMA_EXTERNAL=1`; vê
`infra.md`, «Privilégios da base de dados»). A regra para ti é a mesma: um
`ALTER TABLE` só pode estar em `migrate.js`, e uma tabela nova tem de entrar
em `db/grants.postgres.sql`.

Se te esqueceres do passo 2, o deploy falha: o seed tenta escrever numa
coluna que não existe na BD de produção, o serviço não arranca e o site dá
502.

A coluna nova nasce **vazia (NULL) e sem valor por omissão**; o seed
preenche depois o que souber. No Postgres, as colunas lêem-se com
`to_regclass`, que encontra a tabela pelo mesmo caminho que as queries
normais usam.

O `migrate.test.js` cobre tudo isto em SQLite. Os caminhos só do Postgres
não têm teste ([06](06-roadmap.md)); os scripts de privilégios têm só testes
estáticos (`grants.test.js`), porque não há servidor nos testes.

## Variáveis de ambiente

| variável | o que é | onde se define |
|---|---|---|
| `DATABASE_URL` | liga ao PostgreSQL (utilizador principal do `db`) | `zerops.yml` (`${db_connectionString}`, do serviço `db`) |
| `DATABASE_APP_URL` | liga à role `ceme_app`, só com DML; ganha à `DATABASE_URL` | variável secreta do serviço `api` |
| `DATABASE_MIGRATE_URL` | role dona, só para o `migrate-cli` (DDL) | `zerops.yml` (`${db_connectionString}`) |
| `CEME_SCHEMA_EXTERNAL` | `1` = o arranque não faz DDL, só verifica | `zerops.yml` |
| `DB_PATH` | ficheiro SQLite (só sem `DATABASE_URL`) | local |
| `JWT_SECRET` | assina as sessões ([04](04-api-auth.md)) | variável secreta do serviço `api` |
| `NODE_ENV` | `production` faz o servidor recusar o segredo de dev | `zerops.yml` |
| `CEME_API_KEY` | chave de terceiros ([04](04-api-auth.md)) | variável secreta, opcional |
| `CEME_TRUST_PROXY` | quantos proxies de confiança há à frente ([04](04-api-auth.md)) | variável do serviço |
| `CEME_READONLY`, `CEME_SKIP_SEED` | previews e cópias de dados ([preview-envs](preview-envs.md)) | por ambiente |

As fontes e os tempos de cache do OMIE não são variáveis: estão em
`omie/tf.js`, `omie/omiees.js` e `omie/pipeline.js` ([03](03-omie-ingestao.md)).

## Verificar um deploy

`GET /healthz` (processo vivo) e `GET /readyz` (processo + BD) não pedem
credencial; o resto precisa de sessão ou chave. Vê `infra.md`.

## SQLite local vs dados de produção

Correr sem `DATABASE_URL` dá-te um SQLite novo, criado a partir do seed.
Serve para desenvolver, não para recuperar a produção: os dados de produção
(preços do OMIE, chaves) vivem no PostgreSQL. Para isso há os backups do
Zerops (`infra.md`).
