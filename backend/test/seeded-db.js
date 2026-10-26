// Ajuda para os testes: uma BD SQLite em memória com o schema e o seed
// reais. Cada chamada dá uma BD nova, por isso um teste pode mexer nela sem
// estragar os outros.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { seed } from '../src/db/seed.js';
import { sqliteApi } from '../src/db/sqlite.js';

const SCHEMA = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');

export async function seededDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  await seed(sqliteApi(db));
  return db;
}

// Corre o seed outra vez numa BD que já existe (para testar que é
// idempotente).
export const reseed = (db) => seed(sqliteApi(db));
