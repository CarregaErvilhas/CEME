// Pequenas ajudas para responder a pedidos HTTP, usadas por todos os
// módulos de src/http/.

// Responde com JSON. `nosniff` impede o browser de "adivinhar" que o JSON é
// HTML (e de o executar como tal).
export const json = (res, code, obj, extraHeaders = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(obj));
};

// Resposta de erro no formato da API: { error: { code, message } }.
export const fail = (res, status, code, message, extraHeaders) =>
  json(res, status, { error: { code, message } }, extraHeaders);

// Endereços da própria máquina (loopback), em IPv4, IPv6 e IPv4-em-IPv6.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = req => LOOPBACK.has(req.socket?.remoteAddress || '');

// O IP do cliente. Atrás de proxies (Cloudflare, balanceador) a ligação TCP
// vem sempre do proxy, e o IP real está no cabeçalho X-Forwarded-For.
// CEME_TRUST_PROXY=N diz quantos proxies de confiança há à frente: o IP é a
// N-ésima entrada a contar da DIREITA (as da esquerda o cliente pode
// inventar). Com 0 (por omissão) usa-se o IP da ligação.
const TRUST_PROXY = Math.max(0, parseInt(process.env.CEME_TRUST_PROXY || '0', 10) || 0);
export const clientIp = (req) => {
  if (TRUST_PROXY > 0) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const ip = hops[hops.length - TRUST_PROXY];
    if (ip) return ip;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
};
