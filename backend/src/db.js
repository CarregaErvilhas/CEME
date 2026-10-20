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
    const used = [];
    const out = sql.replace(/\$(\d+)/g, (_, n) => {
      const idx = Number(n) - 1;
      if (!used.includes(idx)) used.push(idx);
      return '?';
    });
    return { sql: out, params: used.map(i => params[i]) };
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

export { queryImpl as query, getImpl as get, runImpl as run, closeImpl as close, dbInstance };
