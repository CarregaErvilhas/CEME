// Rate limit: no máximo N pedidos por minuto, contados em memória (cada
// instância do servidor conta os seus). A sessão web conta por IP; uma API
// key conta pela chave. O mapa de contadores tem um tecto de entradas, para
// um monte de IPs diferentes não encher a memória.
import { fail } from './respond.js';

const RATE_WINDOW_MS = 60_000;
export const RATE_DEFAULT = 60;        // pedidos/minuto por defeito
export const RATE_SESSION = 10;        // POST /v1/session por IP e minuto
const RATE_MAX_BUCKETS = 10_000;
const buckets = new Map();             // chave -> { count, resetAt }

// Conta mais um pedido para `key` e diz se ainda está dentro do `limit`.
// Devolve { allowed, remaining, reset } (reset em ms desde 1970).
export function rateBucket(key, limit) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    if (buckets.size >= RATE_MAX_BUCKETS) {
      // Cheio: apaga os expirados e, se não chegar, o mais antigo.
      for (const [k, v] of buckets) { if (now > v.resetAt) buckets.delete(k); }
      if (buckets.size >= RATE_MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
    }
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(key, b);
  }
  b.count += 1;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), reset: b.resetAt };
}

// Os cabeçalhos x-ratelimit-* que vão em cada resposta da API, para o
// cliente saber quanto lhe resta.
export const rlHeaders = (rl, limit) => ({
  'x-ratelimit-limit': String(limit),
  'x-ratelimit-remaining': String(rl.remaining),
  'x-ratelimit-reset': String(Math.ceil(rl.reset / 1000)),
  'retry-after': String(Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))),
});

// A resposta 429 ("demasiados pedidos").
export const rateLimited = (res, rl, limit) =>
  fail(res, 429, 'rate_limited', 'limite de requisições excedido; repetir depois de Retry-After', rlHeaders(rl, limit));
