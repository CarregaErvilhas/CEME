// Helper de ligação a PostgreSQL (node-postgres / pg).
// Único ponto de pool do processo: db.js re-exporta daqui em modo pg e o
// seed.postgres.js também importa daqui — nunca dois pools na mesma
// instância. O pool é criado de forma LAZY: o import deste módulo (estático,
// pelo server.js via seed.postgres.js, mesmo em modo SQLite) não cria nem
// abre ligações; só a primeira query fá-lo, e nessa altura DATABASE_URL
// tem de estar definida.
// As queries usam placeholders $1, $2 ... em vez de ?.
import { Pool } from 'pg';

let pool = null;
const getPool = () => {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // max de 10 ligações por instância da api (suficiente para pet project)
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => console.error('Erro inesperado no pool pg:', err));
  }
  return pool;
};

export async function query(sql, params = []) {
  const { rows } = await getPool().query(sql, params);
  return rows;
}

export async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export async function run(sql, params = []) {
  return getPool().query(sql, params);
}

export async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
