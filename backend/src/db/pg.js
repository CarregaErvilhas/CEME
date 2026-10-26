// Ligação ao PostgreSQL (biblioteca `pg`), usada só quando há DATABASE_URL.
//
// É o único sítio do processo com um pool de ligações (só o db.js importa
// daqui). O pool só nasce na primeira query: importar este ficheiro (os
// testes fazem-no, em SQLite) não abre ligação nenhuma.
// Os parâmetros escrevem-se $1, $2…
import { Pool, types } from 'pg';

// Conversões de tipos, para o Postgres devolver o mesmo que o SQLite:
//   - DATE e TIMESTAMP (datas de calendário, como o início de validade de um
//     tarifário) ficam como texto. Se o pg as passasse a `Date`, o
//     JSON.stringify escrevia-as em UTC e '2026-10-15' podia sair como o dia
//     anterior, conforme o fuso do servidor.
//   - TIMESTAMPTZ (um instante, como o de cada preço OMIE) sai em ISO-8601
//     UTC, terminado em 'Z'.
// Os números são os OIDs dos tipos no Postgres: 1082 = date,
// 1114 = timestamp without time zone, 1184 = timestamptz.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1114, (v) => v);
types.setTypeParser(1184, (v) => {
  // '2026-10-20 00:00:00+00' -> '2026-10-20T00:00:00.000Z'
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return v;
  const off = m[3] === '+00' ? 'Z' : `${m[3]}:${m[4] || '00'}`;
  return `${m[1]}T${m[2]}.000${off}`;
});

let pool = null;
const getPool = () => {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Até 10 ligações por instância da api.
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // A sessão corre em UTC, para os instantes (chave das tabelas do OMIE)
      // nunca dependerem do fuso do servidor.
      options: '-c timezone=UTC',
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
