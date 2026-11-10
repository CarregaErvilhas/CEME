// Quem está a pedir? Lê a credencial de cada pedido à API e emite as
// sessões web. Os detalhes do JWT e das API keys estão em auth/tokens.js.
import { randomUUID } from 'node:crypto';
import { get } from '../db.js';
import { signJwt, verifyJwt, hashKey } from '../auth/tokens.js';
import { json, fail, clientIp } from './respond.js';
import { rateBucket, rateOver, rateLimited, rlHeaders, RATE_SESSION, RATE_AUTH_FAIL } from './ratelimit.js';

// O segredo que assina os JWT. Sem JWT_SECRET usa-se um valor de dev
// conhecido, para correres local sem configurar nada. Em produção
// (NODE_ENV=production) com esse valor, o servidor arranca mas recusa emitir
// e aceitar tokens: com um segredo público qualquer pessoa fabricava sessões.
const DEV_FALLBACK = 'dev-only-change-me';
const SECRET = process.env.JWT_SECRET || DEV_FALLBACK;
const WEAK_SECRET = SECRET === DEV_FALLBACK;
const WEAK_IN_PROD = WEAK_SECRET && process.env.NODE_ENV === 'production';
if (WEAK_SECRET) console.warn('[ceme-v2] AVISO: JWT_SECRET não definida — a secret de dev "dev-only-change-me" está em uso. Qualquer pessoa pode fabricar sessões.',
  'Com NODE_ENV=production, POST /v1/session devolve 503 em vez de emitir tokens.',
  'Em publicação: export JWT_SECRET=<openssl rand -hex 32>.');

const SESSION_TTL = 86400; // 24 h, em segundos

// POST /v1/session: emite um token de sessão web. É a única rota da API sem
// auth, por isso tem o seu próprio rate limit, mais apertado.
export function issueSession(req, res) {
  const rl = rateBucket(`sess:${clientIp(req)}`, RATE_SESSION);
  const headers = rlHeaders(rl, RATE_SESSION);
  if (!rl.allowed) return rateLimited(res, rl, RATE_SESSION);
  if (WEAK_IN_PROD) return fail(res, 503, 'no_secret', 'JWT_SECRET em falta: export JWT_SECRET=<openssl rand -hex 32>', headers);
  const token = signJwt({ kind: 'WEB_SESSION', sid: randomUUID() }, SECRET, SESSION_TTL);
  return json(res, 200, { token, expires_in: SESSION_TTL }, headers);
}

// Chaves que passaram na BD há pouco (hash -> fim da validade). Só servem
// para saltar o bloqueio por IP de abaixo: a BD continua a ser consultada em
// cada pedido, por isso revogar uma chave tem efeito imediato. Quem adivinha
// chaves não consegue entrar aqui sem acertar numa chave válida.
const KNOWN_TTL_MS = 3_600_000;
const KNOWN_MAX = 1_000;
const knownKeys = new Map();
const rememberKey = (hash) => {
  if (knownKeys.size >= KNOWN_MAX) knownKeys.delete(knownKeys.keys().next().value);
  knownKeys.delete(hash);
  knownKeys.set(hash, Date.now() + KNOWN_TTL_MS);
};
const isKnownKey = (hash) => (knownKeys.get(hash) || 0) > Date.now();

// Lê a credencial do pedido (Bearer JWT ou X-API-Key).
// Devolve { ok: true, payload } ou { ok: false, error }. O payload tem
// sempre `kind`: 'WEB_SESSION' (browser) ou 'THIRD_PARTY' (API key, com
// `key` = prefixo da chave e `rate_limit` próprio, se houver).
//
// Cada X-API-Key falhada conta para o IP do cliente. Passado RATE_AUTH_FAIL
// num minuto, as chaves desse IP levam `{ ok: false, error: 'rate_limited',
// rl, limit }` sem ir à BD: quem tenta chaves ao calhas não gasta uma query
// por pedido. Uma chave que já passou na BD na última hora continua a
// entrar mesmo desse IP (vê `knownKeys`); uma chave válida usada pela
// primeira vez a partir de um IP bloqueado espera pelo fim do minuto. O
// Bearer não conta nem é bloqueado: verifica-se sem BD.
export async function auth(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    if (WEAK_IN_PROD) return { ok: false, error: 'no_secret' };
    return verifyJwt(h.slice(7), SECRET);
  }
  const k = req.headers['x-api-key'];
  if (k) {
    const kh = hashKey(String(k));
    const failKey = `authfail:${clientIp(req)}`;
    if (!isKnownKey(kh)) {
      const over = rateOver(failKey, RATE_AUTH_FAIL);
      if (over && !over.allowed) return { ok: false, error: 'rate_limited', rl: over, limit: RATE_AUTH_FAIL };
    }
    // Procura o hash da chave na BD (ignora chaves revogadas ou expiradas).
    const row = await get(`
      SELECT c.id AS client, c.name AS name, c.kind AS kind, c.rate_limit AS rate_limit
        FROM api_key k JOIN api_client c ON c.id = k.client_id
       WHERE k.hash = $1 AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)`, [kh]);
    if (!row) {
      rateBucket(failKey, RATE_AUTH_FAIL);
      return { ok: false, error: 'invalid_key' };
    }
    rememberKey(kh);
    return { ok: true, payload: { kind: row.kind, client: row.name, key: String(k).slice(0, 8), rate_limit: row.rate_limit } };
  }
  return { ok: false, error: 'missing' };
}
