// Autenticação, sem bibliotecas externas.
//
// Toda a API pede uma credencial. Há dois tipos:
//   - JWT (JSON Web Token): um texto assinado que o servidor te dá em
//     POST /v1/session e que o browser manda em cada pedido. Tem três partes
//     separadas por pontos (cabeçalho.conteúdo.assinatura). A assinatura é um
//     HMAC-SHA256 com um segredo que só o servidor conhece (HS256): se alguém
//     mexer no conteúdo, a assinatura deixa de bater. Não tem dados
//     pessoais e expira ao fim de 24 h.
//   - API key: uma chave para apps de terceiros. Na BD só fica o hash
//     sha256 da chave, nunca a chave em claro.
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64url = (s) => Buffer.from(s, 'base64url').toString('utf8');

// Cria um JWT com `payload` + `exp` (expira daqui a `ttlSec` segundos).
export function signJwt(payload, secret, ttlSec = 86400) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

// Valida um JWT: forma, algoritmo, assinatura e validade.
// Devolve { ok: true, payload } ou { ok: false, error }. Nunca lança: um
// token estragado é só um token inválido.
//
// Duas protecções que vale a pena perceberes:
//   - o cabeçalho tem de dizer `alg: HS256`. Há ataques conhecidos em que o
//     token diz `alg: none` (sem assinatura) e uma validação descuidada
//     aceita-o;
//   - a assinatura compara-se com `timingSafeEqual`, que demora sempre o
//     mesmo tempo. Uma comparação normal (`===`) pára no primeiro carácter
//     diferente, e medindo esse tempo dava, em teoria, para adivinhar a
//     assinatura aos bocadinhos.
export function verifyJwt(token, secret) {
  const [h, b, s, extra] = String(token || '').split('.');
  if (!h || !b || !s || extra !== undefined) return { ok: false, error: 'malformed' };
  const header = parseJson(unb64url(h));
  if (header?.alg !== 'HS256') return { ok: false, error: 'malformed' };
  const expect = Buffer.from(createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url'));
  const got = Buffer.from(s);
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return { ok: false, error: 'bad_signature' };
  const payload = parseJson(unb64url(b));
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'malformed' };
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, error: 'expired' };
  return { ok: true, payload };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Gera uma API key nova, no formato `<prefixo>.<segredo>`. O prefixo (8
// caracteres hex) é público e serve para identificar a chave nos logs e no
// rate limit; o hash é o que se guarda na BD.
export function mintApiKey() {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const hash = createHash('sha256').update(`${prefix}.${secret}`).digest('hex');
  return { key: `${prefix}.${secret}`, prefix, hash };
}

// sha256 em hex da chave que o cliente apresentou, para comparar com a BD.
export function hashKey(presented) {
  return createHash('sha256').update(presented).digest('hex');
}
