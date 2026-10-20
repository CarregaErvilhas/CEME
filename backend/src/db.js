// Unified DB interface: PostgreSQL (pg) when DATABASE_URL is set,
// SQLite (node:sqlite) fallback for local dev/tests.
// Todas as funcoes sao assincronas (query/get/run/close).
let queryImpl, getImpl, runImpl, closeImpl;
let dbInstance = null; // apenas para SQLite (testes manipulam o ficheiro direto)

if (process.env.DATABASE_URL) {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', (err) => console.error('Erro inesperado no pool pg:', err));
  queryImpl = async (sql, params = []) => {
    const { rows } = await pool.query(sql, params);
    return rows;
  };
  getImpl = async (sql, params = []) => {
    const rows = await queryImpl(sql, params);
    return rows[0] || null;
  };
  runImpl = async (sql, params = []) => pool.query(sql, params);
  closeImpl = async () => pool.end();
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdirSync } = await import('node:fs');
  mkdirSync('./data', { recursive: true });
  const db = new DatabaseSync(process.env.DB_PATH || './data/ceme.db');
  dbInstance = db;
  // node:sqlite: db.prepare() so aplica a UMA statement. O schema tem varias
  // statements separadas por ponto-e-virgula, entao usamos db.exec() quando
  // nao ha parametros (schema, inserts inline). Com parametros usamos prepare().
  queryImpl = async (sql, params = []) => {
    if (params.length === 0 && sql.includes(';')) {
      db.exec(sql);
      return [];
    }
    return db.prepare(sql).all(params);
  };
  getImpl = async (sql, params = []) => {
    const row = db.prepare(sql).get(params);
    return row || null;
  };
  runImpl = async (sql, params = []) => {
    if (params.length === 0 && sql.includes(';')) {
      db.exec(sql);
      return { changes: db.changes };
    }
    return db.prepare(sql).run(params);
  };
  closeImpl = async () => db.close();
}

export { queryImpl as query, getImpl as get, runImpl as run, closeImpl as close, dbInstance };
