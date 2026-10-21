// Migrações de schema que o `CREATE TABLE IF NOT EXISTS` não cobre.
//
// A única que existe hoje: as tabelas do OMIE passaram a ser indexadas pelo
// instante em UTC (a chave antiga era a hora local, que se repete na mudança
// de hora). A tabela antiga está vazia — nunca foi usada — por isso pode
// ser deitada fora e recriada com a forma nova.
//
// Corre uma vez, no arranque, antes do schema: se a forma não bate certo,
// drop + o schema recria.
import { query } from '../db.js';

const USE_PG = !!process.env.DATABASE_URL;

// As colunas de uma tabela, nos dois dialects.
async function columns(table) {
  if (USE_PG) {
    const rows = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    );
    return rows.map(r => r.column_name);
  }
  const rows = await query(`PRAGMA table_info(${table})`);
  return rows.map(r => r.name);
}

async function tableExists(table) {
  if (USE_PG) {
    const rows = await query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
      [table]
    );
    return rows.length > 0;
  }
  const rows = await query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1`, [table]);
  return rows.length > 0;
}

// A forma que o omie_spot deve ter: indexada pelo instante UTC.
const SPOT_COLS = ['ts_utc', 'day_utc', 'min_utc', 'price_pt_eur_mwh', 'source'];
const DAILY_COLS = ['date', 'bd_v', 'bd_f', 'bs_v', 'bs_f'];

export async function migrateOmieTables() {
  const notes = [];

  if (await tableExists('omie_spot')) {
    const cols = await columns('omie_spot');
    if (cols.length && !SPOT_COLS.every(c => cols.includes(c))) {
      await query('DROP TABLE omie_spot');
      notes.push('omie_spot: forma antiga (hora local) deitada fora');
    }
  }
  if (await tableExists('omie_daily')) {
    const cols = await columns('omie_daily');
    if (cols.length && !DAILY_COLS.every(c => cols.includes(c))) {
      await query('DROP TABLE omie_daily');
      notes.push('omie_daily: forma antiga deitada fora');
    }
  }
  return notes;
}
