// A porta de entrada para a base de dados.
//
// O resto do código só chama query/get/run/close (todas assíncronas) e não
// sabe que BD está por trás:
//   - com a variável de ambiente DATABASE_URL, liga ao PostgreSQL (produção),
//     através de db/pg.js, que é o único sítio onde existe o pool de ligações;
//   - sem ela, usa um ficheiro SQLite local (node:sqlite), para dev e testes.
//
// query(sql, params) → todas as linhas
// get(sql, params)   → a primeira linha, ou null
// run(sql, params)   → para INSERT/UPDATE/DELETE; vê `affected()` abaixo
// exec(sql)          → várias instruções de uma vez, sem parâmetros (o schema)
let queryImpl, getImpl, runImpl, execImpl, closeImpl;
let dbInstance = null; // só em SQLite: alguns testes mexem directamente na BD

if (process.env.DATABASE_URL) {
  const pg = await import('./db/pg.js');
  queryImpl = pg.query;
  getImpl = pg.get;
  runImpl = pg.run;
  execImpl = (sql) => pg.run(sql);
  closeImpl = pg.close;
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // A pasta data/ resolve-se a partir deste ficheiro (backend/data), não da
  // pasta onde arrancaste o node, para a BD estar sempre no mesmo sítio.
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const DATA_DIR = path.join(srcDir, '..', 'data');
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'ceme.db'));
  dbInstance = db;
  // Dois detalhes do node:sqlite:
  //   - prepare() só aceita UMA instrução. Para várias de uma vez (o schema)
  //     usa exec(), que vai por db.exec().
  //   - Não percebe os parâmetros `$1, $2…` do PostgreSQL. Como escreves o SQL
  //     sempre no estilo do Postgres, aqui troca-se cada `$N` por `?` e
  //     monta-se a lista de valores pela ordem em que os `$N` APARECEM. Se o
  //     `$2` aparece duas vezes (no VALUES e no SET de um upsert), o valor
  //     entra duas vezes na lista.
  const compile = (sql, params) => {
    const order = [];
    const out = sql.replace(/\$(\d+)/g, (_, n) => {
      order.push(Number(n) - 1);
      return '?';
    });
    return { sql: out, params: order.map(i => params[i]) };
  };
  queryImpl = async (sql, params = []) => {
    const { sql: q, params: p } = compile(sql, params);
    return db.prepare(q).all(...p);
  };
  getImpl = async (sql, params = []) => {
    const { sql: q, params: p } = compile(sql, params);
    return db.prepare(q).get(...p) || null;
  };
  runImpl = async (sql, params = []) => {
    const { sql: q, params: p } = compile(sql, params);
    return db.prepare(q).run(...p);
  };
  execImpl = async (sql) => { db.exec(sql); };
  closeImpl = async () => db.close();
}

// CEME_READONLY=1: estás ligado a uma BD que não é tua (por exemplo, um
// preview a ler a BD de produção). O arranque já salta as escritas, e aqui há
// uma última rede de segurança: qualquer `run()` ou `exec()` atira um erro em
// vez de escrever. O `query()` não tem esta guarda, por isso escritas têm de
// ir sempre por `run()` (ou `exec()`).
export const READONLY = process.env.CEME_READONLY === '1';
const refuse = async (sql) => { throw new Error(`CEME_READONLY: escrita recusada (${String(sql).trim().split(/\s+/).slice(0, 3).join(' ')} …)`); };
const guardedRun = READONLY ? refuse : runImpl;
const guardedExec = READONLY ? refuse : execImpl;

// true quando estás ligado ao PostgreSQL (há DATABASE_URL).
export const USE_PG = !!process.env.DATABASE_URL;

// Quantas linhas um `run()` mudou. O SQLite chama-lhe `changes` e o pg
// `rowCount`; isto dá-te o número nos dois casos.
export const affected = (res) => Number(res && (res.changes != null ? res.changes : res.rowCount)) || 0;

export { queryImpl as query, getImpl as get, guardedRun as run, guardedExec as exec, closeImpl as close, dbInstance };
