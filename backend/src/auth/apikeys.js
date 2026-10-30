// Gerir as API keys de terceiros na BD: criar, listar, rodar, revogar e mudar
// o limite. Quem usa isto é o tools/api-key.mjs; aqui não há I/O além da BD
// que recebes (`db` com query/get/run, como db.js ou sqliteApi), para os
// testes correrem com SQLite em memória.
//
// A linha `env-key` é da variável CEME_API_KEY (boot.js reescreve-a em cada
// arranque), por isso estas funções recusam mexer-lhe.
import { randomBytes } from 'node:crypto';
import { hashKey } from './tokens.js';

const ENV_KEY = 'env-key';
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Linhas mudadas por um run(): `changes` no SQLite, `rowCount` no pg (como o
// affected() de db.js, que aqui não se importa por abrir a BD).
const changed = (r) => Number(r?.changes ?? r?.rowCount ?? 0);

function checkClient(client) {
  if (!CLIENT_ID.test(String(client || ''))) {
    throw new Error(`cliente inválido (${client}): minúsculas, algarismos e hífens, 2 a 40 caracteres`);
  }
  if (client === ENV_KEY) throw new Error('env-key é gerida pela variável CEME_API_KEY, não por aqui');
}

function checkLimit(limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`limite inválido (${limit}): inteiro positivo, pedidos por minuto`);
  return n;
}

// Gera uma chave nova para `client` e grava só o hash. Devolve a chave em
// claro: é a única vez que ela existe fora do cliente.
async function addKey(db, client) {
  const key = randomBytes(32).toString('hex');
  const prefix = key.slice(0, 8);
  const id = `${client}-${prefix}`;
  await db.run(`INSERT INTO api_key (id, client_id, hash, prefix) VALUES ($1, $2, $3, $4)`,
    [id, client, hashKey(key), prefix]);
  return { id, key, prefix };
}

const getClient = (db, client) => db.get(`SELECT id, name, kind, rate_limit FROM api_client WHERE id = $1`, [client]);

// Cliente novo com a primeira chave. O `kind` é sempre THIRD_PARTY: com outro
// valor a chave entrava, mas o rate limit passava a ser por IP (http/api.js).
export async function createClient(db, client, { limit = 60, name } = {}) {
  checkClient(client);
  const n = checkLimit(limit);
  if (await getClient(db, client)) throw new Error(`o cliente ${client} já existe; para outra chave usa rotate`);
  await db.run(`INSERT INTO api_client (id, name, kind, rate_limit) VALUES ($1, $2, 'THIRD_PARTY', $3)`,
    [client, name || client, n]);
  return addKey(db, client);
}

// Mais uma chave para um cliente que já existe. As antigas continuam activas
// até as revogares, para o cliente trocar sem ficar sem serviço.
export async function rotateKey(db, client) {
  checkClient(client);
  if (!(await getClient(db, client))) throw new Error(`o cliente ${client} não existe; usa create`);
  return addKey(db, client);
}

// Revoga uma chave (pelo id) ou todas as activas de um cliente. Devolve
// quantas revogou.
export async function revoke(db, target) {
  if (target === ENV_KEY) throw new Error('env-key é gerida pela variável CEME_API_KEY: tira a variável e reinicia');
  const now = `revoked_at = CURRENT_TIMESTAMP`;
  const byKey = await db.run(`UPDATE api_key SET ${now} WHERE id = $1 AND client_id <> $2 AND revoked_at IS NULL`, [target, ENV_KEY]);
  const n = changed(byKey);
  if (n) return n;
  checkClient(target);
  const byClient = await db.run(`UPDATE api_key SET ${now} WHERE client_id = $1 AND revoked_at IS NULL`, [target]);
  return changed(byClient);
}

// Muda o limite (pedidos por minuto). O servidor lê-o da BD a cada pedido,
// por isso vale logo, sem reiniciar.
export async function setLimit(db, client, limit) {
  checkClient(client);
  const n = checkLimit(limit);
  const r = await db.run(`UPDATE api_client SET rate_limit = $1 WHERE id = $2`, [n, client]);
  if (!changed(r)) throw new Error(`o cliente ${client} não existe`);
  return n;
}

// Todos os clientes e as suas chaves (nunca o hash).
export function list(db) {
  return db.query(`
    SELECT c.id AS client, c.kind, c.rate_limit, k.id AS key_id, k.prefix, k.revoked_at, k.expires_at
      FROM api_client c LEFT JOIN api_key k ON k.client_id = c.id
     ORDER BY c.id, k.id`);
}
