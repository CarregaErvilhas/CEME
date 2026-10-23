// Unified DB interface: PostgreSQL (pg) quando DATABASE_URL está definida,
// SQLite (node:sqlite) para dev/testes locais.
// Todas as funções são assíncronas (query/get/run/close).
//
// Fonte única de pool: o pool pg vive só em db/pg.js (com criação lazy, para
// o import estático de seed.postgres.js pelo server.js em modo SQLite não
// criar um pool sem uso). Antes, db.js criava o seu próprio pool E o
// seed.postgres.js, via pg.js, criava outro — dois pools ao mesmo tempo em
// produção (até 20 ligações ao db partindo de uma instância).
let queryImpl, getImpl, runImpl, closeImpl;
let dbInstance = null; // apenas para SQLite (testes manipulam o ficheiro direto)

if (process.env.DATABASE_URL) {
  const pg = await import('./db/pg.js');
  queryImpl = pg.query;
  getImpl = pg.get;
  runImpl = pg.run;
  closeImpl = pg.close;
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // "./data" resolvido a partir do ficheiro: `node src/server.js` a partir da
  // raiz do repo criava ./data no sítio errado (BD vazia no arranque seguinte).
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const DATA_DIR = path.join(srcDir, '..', 'data');
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'ceme.db'));
  dbInstance = db;
  // node:sqlite: db.prepare() só aplica a UMA statement. O schema tem várias
  // statements separadas por ponto-e-vírgula, então usamos db.exec() quando
  // não há parâmetros (schema, inserts inline). Com parâmetros usamos prepare().
  //
  // Placeholders: o código do servidor escreve SQL em dialeto comum com
  // $1,$2,... (números, estilo pg). O node:sqlite não aceita `$N` — trata
  // "1" como nome de parâmetro ("Unknown named parameter '0'"). Tradução
  // local para "?": mantendo a ordem dos índices referenciados, incluindo
  // repetições (ex.: $1,$2 ... $3,$4 com valores repetidos) e referências
  // fora de ordem ($2 antes de $1).
  const compile = (sql, params) => {
    // A ordem é a das OCORRÊNCIAS, não a dos índices únicos: um
    // `ON CONFLICT DO UPDATE SET x = $2` usa o $2 duas vezes (no VALUES e
    // no SET) e são duas ocorrências — com a lista de índices únicos o
    // segundo ? ficava sem parâmetro e gravava NULL.
    const order = [];
    const out = sql.replace(/\$(\d+)/g, (_, n) => {
      order.push(Number(n) - 1);
      return '?';
    });
    return { sql: out, params: order.map(i => params[i]) };
  };
  queryImpl = async (sql, params = []) => {
    if (params.length === 0 && sql.includes(';')) {
      db.exec(sql);
      return [];
    }
    const { sql: q, params: p } = compile(sql, params);
    return db.prepare(q).all(...p);
  };
  getImpl = async (sql, params = []) => {
    const { sql: q, params: p } = compile(sql, params);
    return db.prepare(q).get(...p) || null;
  };
  runImpl = async (sql, params = []) => {
    if (params.length === 0 && sql.includes(';')) {
      db.exec(sql);
      return { changes: db.changes };
    }
    const { sql: q, params: p } = compile(sql, params);
    return db.prepare(q).run(...p);
  };
  closeImpl = async () => db.close();
}

// CEME_READONLY=1: a BD é de outro (produção, num preview) ou é um snapshot.
// O bootstrap já salta as escritas, mas há uma guarda de fundo AQUI, no
// caminho de escrita da app: qualquer `run()` que escape (o OMIE escrevia em
// modo readonly) rebenta em vez de mexer na BD dos outros. (O `query()` não é
// guardado — as migrações usam-no para DROP, e em readonly não correm.)
export const READONLY = process.env.CEME_READONLY === '1';
const guardedRun = READONLY
  ? async (sql) => { throw new Error(`CEME_READONLY: escrita recusada (${String(sql).trim().split(/\s+/).slice(0, 3).join(' ')} …)`); }
  : runImpl;

// Linhas afectadas por um `run()`, nos dois dialetos (node:sqlite → changes,
// pg → rowCount).
export const affected = (res) => Number(res && (res.changes != null ? res.changes : res.rowCount)) || 0;

export { queryImpl as query, getImpl as get, guardedRun as run, closeImpl as close, dbInstance };
