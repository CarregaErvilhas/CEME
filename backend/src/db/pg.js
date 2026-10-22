// Helper de ligação a PostgreSQL (node-postgres / pg).
// Único ponto de pool do processo: db.js re-exporta daqui em modo pg e o
// seed.postgres.js também importa daqui — nunca dois pools na mesma
// instância. O pool é criado de forma LAZY: o import deste módulo (estático,
// pelo server.js via seed.postgres.js, mesmo em modo SQLite) não cria nem
// abre ligações; só a primeira query fá-lo, e nessa altura DATABASE_URL
// tem de estar definida.
// As queries usam placeholders $1, $2 ... em vez de ?.
import { Pool, types } from 'pg';

// Colunas DATE/TIMESTAMP guardam datas civis (início/fim de validade de
// tarifário), não instantes. Por omissão o pg converte-as em `Date` (meia-
// noite local), e o JSON.stringify serializa em UTC — '2026-10-15' sairia
// como '2026-10-14T23:00:00.000Z', ou seja o dia anterior e dependente do
// fuso do servidor. O SQLite devolvia a string tal como está, por isso
// repor a string é o que mantém os dois modos equivalentes.
// OIDs: 1082 = date, 1114 = timestamp without time zone, 1184 = timestamptz.
//
// O TIMESTAMPTZ (o instante do OMIE) volta como ISO-8601 UTC ('...Z'),
// normalizado — para o backend falar uma só língua com o SQLite e nunca
// depender do fuso da sessão.
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
      // max de 10 ligações por instância da api (suficiente para pet project)
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // A sessão em UTC: o instante do OMIE é lido e escrito em UTC, sem
      // depender do fuso do servidor (o que mudaria a chave primária!).
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
