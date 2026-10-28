// Que ligação ao PostgreSQL usar. Sem efeitos de módulo, para db.js, pg.js e
// os testes a importarem à vontade.
//
//   - o runtime da API usa DATABASE_APP_URL (role só com DML) e, sem ela,
//     DATABASE_URL (o utilizador principal do serviço `db`);
//   - o migrate-cli (DDL) usa DATABASE_MIGRATE_URL e, sem ela, DATABASE_URL.
//
// Vê infra.md, «Privilégios da base de dados».
export const runtimeUrl = (env) => env.DATABASE_APP_URL || env.DATABASE_URL || '';
export const migrateUrl = (env) => env.DATABASE_MIGRATE_URL || env.DATABASE_URL || '';
