// As funções query/get/run/exec/close de db.js por cima de uma BD
// node:sqlite (DatabaseSync). Não abre BD nenhuma sozinho: dás-lhe uma.
// db.js usa-o para o ficheiro de dev; os testes, para BDs em memória.
//
// Dois detalhes do node:sqlite:
//   - prepare() só aceita UMA instrução. Para várias de uma vez (o schema)
//     usa exec(), que vai por db.exec().
//   - Não percebe os parâmetros `$1, $2…` do PostgreSQL. Como escreves o SQL
//     sempre no estilo do Postgres, aqui troca-se cada `$N` por `?` e
//     monta-se a lista de valores pela ordem em que os `$N` APARECEM. Se o
//     `$2` aparece duas vezes (no VALUES e no SET de um upsert), o valor
//     entra duas vezes na lista.
export function sqliteApi(db) {
  const compile = (sql, params) => {
    const order = [];
    const out = sql.replace(/\$(\d+)/g, (_, n) => {
      order.push(Number(n) - 1);
      return '?';
    });
    return { sql: out, params: order.map(i => params[i]) };
  };
  return {
    query: async (sql, params = []) => {
      const { sql: q, params: p } = compile(sql, params);
      return db.prepare(q).all(...p);
    },
    get: async (sql, params = []) => {
      const { sql: q, params: p } = compile(sql, params);
      return db.prepare(q).get(...p) || null;
    },
    run: async (sql, params = []) => {
      const { sql: q, params: p } = compile(sql, params);
      return db.prepare(q).run(...p);
    },
    exec: async (sql) => { db.exec(sql); },
    close: async () => db.close(),
  };
}
