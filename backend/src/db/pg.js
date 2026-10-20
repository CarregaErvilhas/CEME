// Helper de ligacao a PostgreSQL (node-postgres / pg).
// Substitui o node:sqlite (DatabaseSync) do POC.
// As queries usam placeholders $1, $2 ... em vez de ?.
// Todas as funcoes sao assincronas.
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // max de 10 ligacoes por instancia da api (suficiente para pet project)
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool pg:', err);
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
