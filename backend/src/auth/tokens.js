// Auth total sem dependências: JWT HS256 manual + API keys (sha256).
// WEB_SESSION anónima (24h) cumpre "tudo com auth" sem obrigar a conta.
import { createHmac, randomBytes, createHash } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64url = (s) => Buffer.from(s, 'base64url').toString('utf8');

export function signJwt(payload, secret, ttlSec = 86400) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token, secret) {
  const [h, b, s] = String(token || '').split('.');
  if (!h || !b || !s) return { ok: false, error: 'malformed' };
  const expect = createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  if (expect !== s) return { ok: false, error: 'bad_signature' };
  const payload = JSON.parse(unb64url(b));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, error: 'expired' };
  return { ok: true, payload };
}

export function mintApiKey() {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const hash = createHash('sha256').update(`${prefix}.${secret}`).digest('hex');
  return { key: `${prefix}.${secret}`, prefix, hash };
}

export function hashKey(presented) {
  return createHash('sha256').update(presented).digest('hex');
}
