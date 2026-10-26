// O servidor HTTP. Um só processo serve tudo:
//   - as páginas HTML e os ficheiros estáticos (JS, CSS, ícones, PWA);
//   - a API em /v1/*, que pede sempre credencial (vê auth/tokens.js);
//   - /healthz e /readyz, para a plataforma saber se o processo está vivo.
//
// Usa só o módulo `node:http`, sem framework. O ficheiro lê-se de cima para
// baixo assim:
//   1. arranque: schema, migrações, chave da API, TAR, seed, resumos OMIE;
//   2. funções de apoio: datas, rate limit, autenticação, cotação de um
//      tarifário (quoteOne), negociação de língua;
//   3. handle(): o "router", uma sequência de `if (url.pathname === …)`;
//   4. o arranque do servidor na porta PORT.
//
// Glossário rápido (mais em docs/00-glossario.md):
//   CEME: a empresa que te vende a energia no posto (via cartão/app);
//   TAR:  tarifa de acesso às redes, fixada pela ERSE;
//   EGME: a taxa de activação cobrada por carregamento;
//   IEC:  imposto especial sobre a electricidade;
//   OMIE: o mercado grossista ibérico, de onde vem o preço dos indexados.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { query, get, run, dbInstance, READONLY } from './db.js';
import { signJwt, verifyJwt, hashKey } from './auth/tokens.js';
import { quoteFixed } from './engine/quote.js';
import { indexedPrice, LOSS_PLACEHOLDER } from './engine/indexed.js';
import { lossAt, lossByPeriod } from './engine/losses.js';
import { REGIONS, periodForRegion } from './engine/regions.js';
import { compareWithFixed, tallyWinners } from './engine/compare.js';
import { getDaily, getFutures, getQuarters, getStats, rebuildDerived, SOURCE_LABEL } from './omie/pipeline.js';
import { civilDay } from './omie/convert.js';
import { migrateOmieTables, migrateAddedColumns } from './db/migrate.js';
import { pickComponents } from './db/components.js';
import { VERSIONS } from './db/seed.postgres.js';

const PORT = Number(process.env.PORT || 3001);
const USE_PG = !!process.env.DATABASE_URL;
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

// Variáveis de ambiente opcionais (úteis em previews, docs/preview-envs.md):
//   CEME_READONLY=1  não escreve nada na BD: salta schema, seed, TAR e chave,
//                    o OMIE não actualiza, e db.js recusa qualquer escrita.
//                    Para ligares a uma BD que não é tua.
//   CEME_SKIP_SEED=1 corre tudo menos o seed, para não pisar dados copiados
//                    de outro ambiente.
const SKIP_SEED = READONLY || process.env.CEME_SKIP_SEED === '1';
const SKIP_SCHEMA = READONLY;
const SKIP_TAR = READONLY;
const SKIP_API_KEY = READONLY;

if (READONLY) console.warn('[ceme-v2] modo READONLY: bootstrap de escrita desactivado.');

// ---- Arranque (corre uma vez, antes de aceitar pedidos) ----
// A ordem importa: migrações do OMIE → schema → colunas novas → chave da
// API → TAR → seed → resumos do OMIE. Vê db/migrate.js.
if (!SKIP_SCHEMA) {
  const notes = await migrateOmieTables();
  for (const n of notes) console.warn(`[ceme-v2] migração: ${n}`);
}

// O schema do dialecto em uso (seguro de repetir).
if (!SKIP_SCHEMA) {
  const schemaFile = USE_PG
    ? new URL('./db/schema.postgres.sql', import.meta.url)
    : new URL('./db/schema.sql', import.meta.url);
  const schemaSql = await readFile(schemaFile, 'utf8');
  await run(schemaSql);
}

// Colunas novas em tabelas que já existiam (antes do seed, que as usa).
if (!SKIP_SCHEMA) {
  const notes = await migrateAddedColumns();
  for (const n of notes) console.warn(`[ceme-v2] migração: ${n}`);
}

// A API key de terceiros vem da variável CEME_API_KEY; na BD fica só o hash
// (linha 'env-key'). A variável manda:
//   - definida: grava o hash e reactiva a chave (trocar o valor invalida a
//     antiga);
//   - ausente: revoga a chave que estiver na BD.
if (!SKIP_API_KEY) {
  if (process.env.CEME_API_KEY) {
    const key = process.env.CEME_API_KEY;
    await run(`INSERT INTO api_client (id, name, kind) VALUES ('env-key', 'chave da env', 'THIRD_PARTY')
      ON CONFLICT (id) DO NOTHING`);
    await run(`INSERT INTO api_key (id, client_id, hash, prefix) VALUES ('env-key', 'env-key', $1, $2)
      ON CONFLICT (id) DO UPDATE SET hash = $1, prefix = $2, revoked_at = NULL`,
      [hashKey(key), key.slice(0, 8)]);
  } else {
    await run(`UPDATE api_key SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'env-key' AND revoked_at IS NULL`);
  }
}

// TAR da mobilidade eléctrica em 2026, em €/kWh sem IVA (ERSE, Diretiva
// n.º 1/2026, art. 23.º). A ERSE publica uma tabela só para Continente,
// Açores e Madeira; grava-se uma cópia por região porque a TAR procura-se
// sempre pela região do carregamento (uma região sem TAR é erro, nunca zero).
const TAR_2026 = { BT: { VAZIO: 0.0266, FORA_VAZIO: 0.1192 }, MT: { VAZIO: 0.0157, FORA_VAZIO: 0.0812 } };
if (!SKIP_TAR) {
  for (const region of Object.keys(REGIONS)) {
    for (const [voltage, byPeriod] of Object.entries(TAR_2026)) {
      for (const [period, price] of Object.entries(byPeriod)) {
        await run(`INSERT INTO tar (valid_from, valid_to, region, voltage, period, price_eur_kwh)
          VALUES ('2026-01-01', NULL, $1, $2, $3, $4)
          ON CONFLICT (valid_from, region, voltage, period) DO NOTHING`, [region, voltage, period, price]);
      }
    }
  }
}

// O seed (vê db/seed.js).
if (!SKIP_SEED) {
  if (USE_PG) {
    const { seed } = await import('./db/seed.postgres.js');
    await seed();
  } else {
    const { seed } = await import('./db/seed.js');
    await seed(dbInstance);
  }
} else {
  console.warn('[ceme-v2] seed saltado (CEME_SKIP_SEED/CEME_READONLY).');
}
// Recalcula os resumos do OMIE com o código actual, a partir do que já está
// na BD (sem ir à rede).
if (!READONLY) {
  try { await rebuildDerived(); console.log('[ceme-v2] derivados recalculados no arranque'); }
  catch (e) { console.warn('[ceme-v2] rebuildDerived falhou:', e.message); }
}

// Fórmula e perdas fixas de um indexado (VERSIONS no seed).
function vmeta(tid) {
  const v = VERSIONS[tid] || {};
  const loss = (v.loss != null) ? v.loss : null;
  return { loss, formula: v.formula || 'standard' };
}

// Valida um nome de fuso IANA vindo do browser (ex.: 'Europe/Lisbon'). Se
// for inválido, usa UTC.
function validTz(name) {
  if (!name || typeof name !== 'string' || name.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return name;
  } catch { return 'UTC'; }
}

// 'HH:MM' de um instante UTC, no fuso pedido.
function fmtTime(utcIso, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(new Date(utcIso));
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('hour')}:${get('minute')}`;
}

// O dia pedido ('AAAA-MM-DD', dia de Lisboa) ou, se não vier, hoje em Lisboa.
function quarterDay(date) {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return civilDay();
}

// "Hoje" em Portugal, para escolher a versão em vigor (vê civilDay).
const today = () => civilDay();

const json = (res, code, obj, extraHeaders = {}) => {
  // nosniff impede o browser de "adivinhar" que o JSON é HTML.
  res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(obj));
};

// Endereços da própria máquina (loopback), em IPv4, IPv6 e IPv4-em-IPv6.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopback = req => LOOPBACK.has(req.socket?.remoteAddress || '');

// A BD responde? Faz um SELECT 1 com 3 s de prazo e guarda a resposta 5 s,
// para não fazer uma query por cada verificação. Devolve true/false, nunca
// atira erro.
const DB_CHECK_TTL = 5000;
let dbCheck = null;
const dbAlive = async () => {
  const now = Date.now();
  if (dbCheck && now - dbCheck.at < DB_CHECK_TTL) return dbCheck.promise;
  const promise = (async () => {
    let timer;
    const guard = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), 3000);
      timer.unref?.();
    });
    try {
      return await Promise.race([query('SELECT 1').then(() => true, () => false), guard]);
    } finally {
      clearTimeout(timer);
    }
  })();
  dbCheck = { at: now, promise };
  return promise;
};

// Rate limit: no máximo N pedidos por minuto, contados em memória (cada
// instância conta os seus). A sessão web conta por IP; uma API key conta
// pela chave. O mapa de contadores tem um tecto de entradas, para um monte
// de IPs diferentes não encher a memória.
const RATE_WINDOW_MS = 60_000;
const RATE_DEFAULT = 60;        // pedidos/minuto por defeito
const RATE_SESSION = 10;        // POST /v1/session por IP e minuto
const RATE_MAX_BUCKETS = 10_000;
const buckets = new Map();      // chave -> { count, resetAt }
// Conta mais um pedido para `key` e diz se ainda está dentro do `limit`.
function rateBucket(key, limit) {
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
const rlHeaders = (rl, limit) => ({
  'x-ratelimit-limit': String(limit),
  'x-ratelimit-remaining': String(rl.remaining),
  'x-ratelimit-reset': String(Math.ceil(rl.reset / 1000)),
  'retry-after': String(Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))),
});
const rateLimited = (res, rl, limit) => json(res, 429, {
  error: { code: 'rate_limited', message: 'limite de requisições excedido; repetir depois de Retry-After' },
}, rlHeaders(rl, limit));

// O IP do cliente. Atrás de proxies (Cloudflare, balanceador) a ligação TCP
// vem sempre do proxy, e o IP real está no cabeçalho X-Forwarded-For.
// CEME_TRUST_PROXY=N diz quantos proxies de confiança há à frente: o IP é a
// N-ésima entrada a contar da DIREITA (as da esquerda o cliente pode
// inventar). Com 0 (por omissão) usa-se o IP da ligação.
const TRUST_PROXY = Math.max(0, parseInt(process.env.CEME_TRUST_PROXY || '0', 10) || 0);
const clientIp = (req) => {
  if (TRUST_PROXY > 0) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const ip = hops[hops.length - TRUST_PROXY];
    if (ip) return ip;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
};

// Lê a credencial do pedido. Devolve { ok: true, payload } ou { ok: false, error }.
async function auth(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    if (WEAK_IN_PROD) return { ok: false, error: 'no_secret' };
    return verifyJwt(h.slice(7), SECRET);
  }
  const k = req.headers['x-api-key'];
  if (k) {
    // Procura o hash da chave na BD (ignora chaves revogadas ou expiradas).
    const row = await get(`
      SELECT c.id AS client, c.name AS name, c.kind AS kind, c.rate_limit AS rate_limit
        FROM api_key k JOIN api_client c ON c.id = k.client_id
       WHERE k.hash = $1 AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)`, [hashKey(String(k))]);
    if (!row) return { ok: false, error: 'invalid_key' };
    return { ok: true, payload: { kind: row.kind, client: row.name, key: String(k).slice(0, 8), rate_limit: row.rate_limit } };
  }
  return { ok: false, error: 'missing' };
}

// Todos os tarifários, cada um com `vid` = a versão em vigor no dia `day`.
// Se o dia for anterior à primeira versão conhecida, usa a de hoje.
async function allTariffs(day = today()) {
  return await query(`
    SELECT t.*, c.name AS ceme_name,
      COALESCE(
        (SELECT v.id FROM tariff_version v
         WHERE v.tariff_id = t.id
           AND v.valid_from <= $1
           AND (v.valid_to IS NULL OR v.valid_to > $1)
         ORDER BY v.valid_from DESC LIMIT 1),
        (SELECT v.id FROM tariff_version v
         WHERE v.tariff_id = t.id
           AND v.valid_from > $1 AND v.valid_from <= $2
           AND (v.valid_to IS NULL OR v.valid_to > $2)
         ORDER BY v.valid_from DESC LIMIT 1)) AS vid
    FROM tariff t
    JOIN ceme c ON c.id = t.ceme_id
    ORDER BY t.id
  `, [day, today()]);
}

// Os preços de uma versão numa região: { price, act, iec, sup, split }.
async function comps(vid, region = 'CONT') {
  let rows = await query('SELECT * FROM price_component WHERE tariff_version_id = $1', [vid]);
  // Nas ilhas, as linhas de price_component_region vêm DEPOIS das do
  // Continente; como "a última vence", substituem-nas onde existirem.
  if (region && region !== 'CONT') {
    const reg = await query('SELECT * FROM price_component_region WHERE tariff_version_id = $1 AND region = $2', [vid, region]);
    rows = [...rows, ...reg];
  }
  return compRows(rows, vid);
}

// Transforma linhas de preço em { price, act, iec, sup, split }. O
// /v1/tabela também a usa, para mostrar os preços das ilhas à parte.
function compRows(rows, vid) {
  let out;
  try { out = pickComponents(rows); }
  catch (e) { throw new Error(`${e.message} na versão ${vid}`); }
  // split[período] = { energy, tar } quando se conhece a separação; senão null.
  const split = {};
  for (const r of rows) {
    split[r.period] = (r.energy_only_eur_kwh == null || r.tar_eur_kwh == null)
      ? null
      : { energy: r.energy_only_eur_kwh, tar: r.tar_eur_kwh };
  }
  out.split = split;
  return out;
}

// Taxa de activação (EGME). Usamos sempre o valor que o CEME publica. Cada
// tarifário vai com dois campos extra:
//   egme_legal:       o valor legal em vigor, para referência;
//   activation_stale: true se o CEME ainda publica o valor legal do ano
//                     anterior (provavelmente não actualizou a página).
// Um valor próprio acima do legal é legítimo e não é marcado.
const EGME_LEGAL = 0.1088; // €/carregamento, Regul. ERSE 7/2026 (em vigor 2026-01-01)
const EGME_PREVIOUS = 0.1572; // o valor legal de 2025
const egmeFlags = (act) => ({ egme_legal: EGME_LEGAL, activation_stale: Math.abs(act - EGME_PREVIOUS) < 1e-9 });

// A TAR em vigor num dia para (região, tensão, período), ou null se não
// houver. Para um dia anterior à primeira TAR conhecida, usa a mais antiga.
async function tarFor(region, voltage, period, day = today()) {
  const row = await get(
    `SELECT price_eur_kwh FROM tar
      WHERE region = $1 AND voltage = $2 AND period = $3
        AND valid_from <= $4 AND (valid_to IS NULL OR valid_to > $4)
      ORDER BY valid_from DESC LIMIT 1`,
    [region, voltage, period, day]
  ) || await get(
    `SELECT price_eur_kwh FROM tar
      WHERE region = $1 AND voltage = $2 AND period = $3 AND valid_from > $4
      ORDER BY valid_from ASC LIMIT 1`,
    [region, voltage, period, day]
  );
  return row?.price_eur_kwh ?? null;
}

// Cota UM tarifário: devolve os dados para o cartão dele, com o total em €
// e a conta parcela a parcela. Atira erro se faltar algum dado; quem chama
// apanha-o e deixa o tarifário de fora ("quarentena").
//   t:     linha de allTariffs()
//   at:    instante do carregamento; day: o dia dele na região
//   kwh, region
//   omie, omieVazio, omieFora, omieCycles: o OMIE de referência (€/kWh)
//   spot:  { omieKwh, loss } do quarto de hora do carregamento, se houver
async function quoteOne(t, { at, day, kwh, region, omie, omieVazio, omieFora, omieCycles, spot }) {
  const ver = await get('SELECT * FROM tariff_version WHERE id = $1', [t.vid]);
  const { price, act, iec, sup, split } = await comps(t.vid, region);
  const meta = {
    id: t.id, ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
    schedule: t.schedule, cycle: t.cycle, green: !!t.green, access: t.access,
    bundle: !!t.bundle, popular: !!t.popular, estimated: /~$/.test(t.name),
    source_url: t.source_url, valid_from: ver?.valid_from || null,
    notes: ver?.notes || null,
    brand: (await get('SELECT brand_color FROM ceme WHERE id = $1', [t.ceme_id]))?.brand_color || '#666',
  };
  if (t.kind === 'FIXED') {
    const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price, activation: act, support: sup, iec, region, split });
    return { ...meta, activation: act, iec, prices: price, split, avail: t.regions, ...egmeFlags(act), ...q };
  }
  // INDEXADO: calcula o €/kWh de cada período e depois usa a mesma conta dos
  // fixos. Nas ilhas o mercado ibérico não chega; usa-se o OMIE do
  // Continente e o cartão leva o aviso OMIE_CONT_REF.
  const here = REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF';
  // A TAR é a da região do carregamento. Sem TAR, erro (quarentena).
  const tarOf = async (per) => {
    const tar = await tarFor(region, t.voltage, per, day);
    if (tar == null) throw new Error(`sem TAR ${region}/${t.voltage}/${per} em ${day}`);
    return tar;
  };
  const vm = vmeta(t.id);
  // Perdas médias de cada período nesse dia (vê engine/losses.js).
  const lossPer = lossByPeriod(t.voltage, at, d => periodForRegion({ region, schedule: t.schedule, cycle: t.cycle, at: d }), `${region}|${t.schedule}|${t.cycle}`);
  // Que OMIE usar em cada período:
  //   SPLIT_VAZIO_FORA: a média desse período no ciclo DO TARIFÁRIO (o vazio
  //     do ciclo semanal não tem as mesmas horas que o do diário). Vem de
  //     `omieCycles[ciclo]`; se não vier, de omieVazio/omieFora; se não, `omie`.
  //   UNICA: `omie` para tudo.
  const agg = ver.omie_aggregation || 'SPLIT_VAZIO_FORA';
  const cyc = (omieCycles && omieCycles[t.cycle]) || {};
  const pair = { vazio: cyc.vazio ?? omieVazio, fora: cyc.fora ?? omieFora };
  const omieForPeriod = (per) => {
    if (agg === 'SPLIT_VAZIO_FORA') return (per === 'VAZIO' ? (pair.vazio ?? omie) : (pair.fora ?? omie));
    return omie;
  };
  // Se há `spot` (o OMIE do quarto de hora do carregamento), é esse que se
  // usa: é o que o CEME cobra de facto. As médias ficam como plano B.
  const spotKwh = spot?.omieKwh ?? null;
  const out = {};
  // Aqui a separação energia + TAR é exacta: a TAR é uma parcela da fórmula.
  const splitIdx = {};
  for (const per of ['VAZIO', 'FORA_VAZIO']) {
    const oref = spotKwh ?? omieForPeriod(per);
    const tar = await tarOf(per);
    const tarEurKwh = tar ?? 0;
    const price = indexedPrice({ omieEurKwh: oref, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh, loss: spot?.loss ?? lossPer?.[per] ?? vm.loss, formula: vm.formula }).price;
    out[per] = price;
    splitIdx[per] = tar == null ? null : { energy: price - tar, tar };
  }
  const omieRef = spotKwh ?? ((agg === 'SPLIT_VAZIO_FORA') ? (pair.vazio ?? omie) : omie);
  // Um indexado SIMPLES precisaria de um preço UNICO, que este código não
  // calcula. Não há nenhum no seed; se aparecer, usa-se o de fora de vazio
  // como aproximação (vê docs/06).
  if (t.schedule === 'SIMPLES' && out.UNICO == null) {
    out.UNICO = out.FORA_VAZIO ?? out.VAZIO ?? 0;
  }
  const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price: out, activation: act, support: sup, iec, region, split: splitIdx });
  return { ...meta, activation: act, iec, prices: out, split: splitIdx, estimated: false, omieRef, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh, loss: spot?.loss ?? lossPer?.[q.period] ?? vm.loss ?? LOSS_PLACEHOLDER[t.voltage], omieSpot: spotKwh != null, lossByPeriod: lossPer, formula: vm.formula, warning: here, avail: t.regions, ...egmeFlags(act), ...q };
}

// Língua das páginas. Cada HTML traz `window.__LANG__=null`; o servidor
// troca o null por "pt" ou "en" antes de enviar. (O regex aceita espaços à
// volta do `=`.)
const LANG_MARK = /window\.__LANG__\s*=\s*null/;

// Escolhe a língua pelo cabeçalho Accept-Language: inglês só se a língua
// preferida (maior `q`) for inglês; tudo o resto dá português.
function negotiateLang(header) {
  if (!header) return 'pt';
  const tags = String(header).split(',')
    .map(s => { const [tag, ...params] = s.trim().split(';'); const q = params.find(p => /^\s*q=/.test(p)); return { tag: tag.trim().toLowerCase(), q: q ? parseFloat(q.split('=')[1]) || 0 : 1 }; })
    .filter(t => t.tag && t.q > 0).sort((a, b) => b.q - a.q);
  return tags[0] && tags[0].tag.startsWith('en') ? 'en' : 'pt';
}

// Duas interfaces para a mesma API: o assistente (três perguntas) e o
// simulador completo. `/` mostra a que estiver no cookie `ceme_ui` (por
// omissão, o assistente). `/assistente` e `/simulador` mostram essa e gravam
// a escolha no cookie.
const UI = {
  assistente: { file: 'assistente.html' },
  completo: { file: 'index.html' },
};
// `null` = respeitar o cookie (a rota `/`); um valor = gravar essa escolha.
const UI_ROUTES = { '/': null, '/index.html': null, '/assistente': 'assistente', '/simulador': 'completo' };
const UI_COOKIE = 'ceme_ui';
const UI_COOKIE_MAX_AGE = 31536000; // 1 ano

// Outras páginas HTML, sem cookie. `/sobre` e `/about` são a mesma página
// (o mesmo para contactos).
const INFO_ROUTES = {
  '/sobre': 'about.html', '/about': 'about.html',
  '/contactos': 'contact.html', '/contact': 'contact.html',
  '/api': 'api.html',
  // Tabela em bruto dos tarifários em vigor. Não tem links a apontar para
  // ela e não é indexada pelos motores de busca.
  '/tabela': 'tabela.html',
};

// Página das estatísticas OMIE: /omie em qualquer domínio, e também a raiz
// `/` quando o pedido chega pelo domínio omie.cocofree.dev.
const OMIE_ROUTES = { '/omie': 'omie.html', '/omie.html': 'omie.html' };
const OMIE_HOST = 'omie.cocofree.dev';

// O valor do cookie `name`, ou null.
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}
// Interface escolhida no cookie; qualquer valor estranho dá o assistente.
const uiFromCookie = req => (readCookie(req, UI_COOKIE) === 'completo' ? 'completo' : 'assistente');
// O cabeçalho Set-Cookie da escolha de interface (válido 1 ano). Leva
// `Secure` só se o pedido veio por https; em dev, com http, o browser
// deitava-o fora.
function uiCookie(req, ui) {
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${UI_COOKIE}=${ui}; Path=/; Max-Age=${UI_COOKIE_MAX_AGE}; SameSite=Lax${https ? '; Secure' : ''}`;
}

// O método HTTP aceite por cada rota da API. Outro método dá 405.
const METHODS = {
  '/v1/health': 'GET', '/v1/cemes': 'GET', '/v1/tariffs': 'GET', '/v1/tar': 'GET',
  '/v1/tabela': 'GET',
  '/v1/omie/daily': 'GET', '/v1/omie/futures': 'GET', '/v1/omie/stats': 'GET',
  '/v1/indexed/quarters': 'GET',
  '/v1/session': 'POST', '/v1/simulate': 'POST',
};
const MAX_BODY = 64 * 1024; // tamanho máximo do corpo de um POST (64 KB)

// O router: recebe cada pedido e decide o que responder, pela ordem
// health → ficheiros estáticos → páginas HTML → API (auth, rate limit, rotas).
async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return json(res, 400, { error: { code: 'bad_request', message: 'alvo do pedido inválido' } }); }
  // Web sem auth (ficheiros estáticos); a API continua toda com auth.
  // HEAD é aceito (só read-only, corpo vazio) — sem isto, HEAD / dava 401.
  const readStatic = method => method === 'GET' || method === 'HEAD';
  // Verificações da plataforma (zerops.yml), sem auth:
  //   /healthz: "o processo está vivo?" Não toca na BD, para uma falha da BD
  //             não tirar o site do ar.
  //   /readyz:  "posso receber tráfego?" Também testa a BD. Usa-se num
  //             deploy, antes de pôr a versão nova a servir.
  if (readStatic(req.method) && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, up: Math.round(process.uptime()) });
  }
  if (readStatic(req.method) && url.pathname === '/readyz') {
    // Só testa a BD se o pedido vier da própria máquina (é de lá que a
    // plataforma pergunta). De fora responde 200 com `db: unknown`, para
    // ninguém usar isto para martelar a BD.
    if (!isLoopback(req)) return json(res, 200, { ok: true, db: 'unknown' });
    const alive = await dbAlive();
    if (!alive) {
      return json(res, 503, { ok: false, db: 'down', error: { code: 'db_unavailable', message: 'a BD não respondeu' } });
    }
    return json(res, 200, { ok: true, db: 'up' });
  }
  if (readStatic(req.method) && url.pathname === '/strings.js') {
    // Ficheiros estáticos. `no-store` em JS/CSS/HTML para o browser nunca
    // ficar com uma versão antiga depois de um deploy.
    try {
      const js = await readFile(new URL('../../frontend/strings.js', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(js);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/strings.js em falta' } }); }
  }
  if (readStatic(req.method) && url.pathname === '/pages.css') {
    try {
      const css = await readFile(new URL('../../frontend/pages.css', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(css);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/pages.css em falta' } }); }
  }
  // robots.txt. A /tabela não aparece aqui: é escondida pelo cabeçalho
  // x-robots-tag (um Disallow aqui anunciava-a).
  if (readStatic(req.method) && url.pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
    return res.end('User-agent: *\nDisallow: /v1/\n');
  }
  // PWA (app instalável): manifest, service worker e ícones.
  if (readStatic(req.method) && (url.pathname === '/manifest.webmanifest' || url.pathname === '/manifest.json')) {
    try {
      const m = await readFile(new URL('../../frontend/manifest.webmanifest', import.meta.url));
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(m);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/manifest.webmanifest em falta' } }); }
  }
  if (readStatic(req.method) && (url.pathname === '/sw.js' || url.pathname === '/service-worker.js')) {
    try {
      const sw = await readFile(new URL('../../frontend/sw.js', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'service-worker-allowed': '/' });
      return res.end(sw);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/sw.js em falta' } }); }
  }
  if (readStatic(req.method) && url.pathname === '/tz.js') {
    try {
      const js = await readFile(new URL('../../frontend/tz.js', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(js);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/tz.js em falta' } }); }
  }
  if (readStatic(req.method) && url.pathname === '/pwa.js') {
    try {
      const js = await readFile(new URL('../../frontend/pwa.js', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(js);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/pwa.js em falta' } }); }
  }
  for (const icon of ['icon-192.png', 'icon-512.png', 'icon-180.png']) {
    if (readStatic(req.method) && url.pathname === '/' + icon) {
      try {
        const img = await readFile(new URL(`../../frontend/${icon}`, import.meta.url));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400, immutable', 'x-content-type-options': 'nosniff' });
        return res.end(img);
      } catch { return json(res, 404, { error: { code: 'no_frontend', message: `frontend/${icon} em falta` } }); }
    }
  }
  // Página OMIE (vê OMIE_ROUTES). O cabeçalho Host diz por que domínio veio.
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const onOmieHost = host === OMIE_HOST;
  if (readStatic(req.method) && (onOmieHost && url.pathname === '/' || Object.hasOwn(OMIE_ROUTES, url.pathname))) {
    const file = OMIE_ROUTES[url.pathname] || 'omie.html';
    const lang = negotiateLang(req.headers['accept-language']);
    try {
      const html = (await readFile(new URL(`../../frontend/${file}`, import.meta.url), 'utf8'))
        .replace('<html lang="pt-PT">', `<html lang="${lang === 'en' ? 'en' : 'pt-PT'}">`)
        .replace(LANG_MARK, `window.__LANG__=${JSON.stringify(lang)}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Language, Host' });
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: `frontend/${file} em falta` } }); }
  }
  if (readStatic(req.method) && Object.hasOwn(INFO_ROUTES, url.pathname)) {
    // Páginas de INFO_ROUTES, com a língua negociada.
    const lang = negotiateLang(req.headers['accept-language']);
    try {
      const html = (await readFile(new URL(`../../frontend/${INFO_ROUTES[url.pathname]}`, import.meta.url), 'utf8'))
        .replace('<html lang="pt-PT">', `<html lang="${lang === 'en' ? 'en' : 'pt-PT'}">`)
        .replace(LANG_MARK, `window.__LANG__=${JSON.stringify(lang)}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Language', ...(url.pathname === '/tabela' ? { 'x-robots-tag': 'noindex, nofollow' } : {}) });
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: `frontend/${INFO_ROUTES[url.pathname]} em falta` } }); }
  }
  if (readStatic(req.method) && Object.hasOwn(UI_ROUTES, url.pathname)) {
    // Assistente ou simulador (vê UI_ROUTES). `/` só lê o cookie; as rotas
    // explícitas gravam-no.
    const forced = UI_ROUTES[url.pathname]; // null = respeitar o cookie
    const ui = forced || uiFromCookie(req);
    const lang = negotiateLang(req.headers['accept-language']);
    try {
      const html = (await readFile(new URL(`../../frontend/${UI[ui].file}`, import.meta.url), 'utf8'))
        .replace('<html lang="pt-PT">', `<html lang="${lang === 'en' ? 'en' : 'pt-PT'}">`)
        .replace(LANG_MARK, `window.__LANG__=${JSON.stringify(lang)}`);
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Language, Cookie' };
      if (forced) headers['set-cookie'] = uiCookie(req, forced);
      res.writeHead(200, headers);
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: `frontend/${UI[ui].file} em falta` } }); }
  }
  // ---- API ----
  // Método errado: 405, com o cabeçalho `allow` a dizer o certo.
  const allowed = METHODS[url.pathname];
  if (allowed && req.method !== allowed && !(allowed === 'GET' && req.method === 'HEAD')) {
    res.writeHead(405, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', allow: allowed });
    return res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: `${req.method} em ${url.pathname}; usar ${allowed}` } }));
  }
  if (req.method === 'POST' && url.pathname === '/v1/session') {
    // Emite um token de sessão web. É a única rota da API sem auth, por isso
    // tem o seu próprio rate limit, mais apertado.
    const sessRl = rateBucket(`sess:${clientIp(req)}`, RATE_SESSION);
    if (!sessRl.allowed) return rateLimited(res, sessRl, RATE_SESSION);
    if (WEAK_IN_PROD) {
      return json(res, 503, { error: { code: 'no_secret', message: 'JWT_SECRET em falta: export JWT_SECRET=<openssl rand -hex 32>' } });
    }
    const token = signJwt({ kind: 'WEB_SESSION', sid: Math.random().toString(36).slice(2) }, SECRET);
    return json(res, 200, { token, expires_in: 86400 });
  }
  const a = await auth(req);
  if (!a.ok) return json(res, 401, { error: { code: 'unauthorized', message: 'falta Authorization (Bearer ou X-API-Key)' } });

  // Rate limit, depois da auth: por chave (API key) ou por IP (sessão web).
  const rlLimit = a.payload.kind === 'THIRD_PARTY' && a.payload.rate_limit != null ? Number(a.payload.rate_limit) : RATE_DEFAULT;
  const rlKey = `${a.payload.kind === 'THIRD_PARTY' ? 'key' : 'ip'}:${a.payload.kind === 'THIRD_PARTY' ? a.payload.key : clientIp(req)}`;
  const rl = rateBucket(rlKey, rlLimit);
  const headers = rlHeaders(rl, rlLimit);
  if (!rl.allowed) return rateLimited(res, rl, rlLimit);

  if (url.pathname === '/v1/health') return json(res, 200, { ok: true, as: a.payload.kind, time: new Date().toISOString() }, headers);
  if (url.pathname === '/v1/cemes') return json(res, 200, { data: await query('SELECT * FROM ceme ORDER BY name') }, headers);
  if (url.pathname === '/v1/tariffs') {
    const rows = await allTariffs();
    const enriched = await Promise.all(rows.map(async t => ({ ...t, version: await get('SELECT * FROM tariff_version WHERE id = $1', [t.vid]) })));
    return json(res, 200, { data: enriched }, headers);
  }
  if (url.pathname === '/v1/tar') {
    return json(res, 200, { data: await query('SELECT * FROM tar WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)', [today()]) }, headers);
  }
  if (url.pathname === '/v1/tabela') {
    // Dados da página /tabela: os tarifários em vigor com os preços, sem
    // cálculo nenhum.
    const out = [];
    for (const t of await allTariffs()) {
      if (t.vid == null) continue; // sem versão em vigor (ex.: campanha acabada)
      const cp = await comps(t.vid);
      // Preços próprios das ilhas, à parte: { MAD: { prices, split }, … }.
      // Só aparece para quem cobra diferente lá.
      const regRows = await query(
        `SELECT region, period, energy_eur_kwh, activation_eur, support_eur, iec_eur_kwh,
                energy_only_eur_kwh, tar_eur_kwh
         FROM price_component_region WHERE tariff_version_id = $1`, [t.vid]);
      const regionPrices = {};
      for (const region of [...new Set(regRows.map(r => r.region))].sort()) {
        const rp = compRows(regRows.filter(r => r.region === region), t.vid);
        regionPrices[region] = { prices: rp.price, split: rp.split };
      }
      out.push({
        ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
        schedule: t.schedule, cycle: t.cycle, green: t.green, bundle: t.bundle,
        popular: t.popular, access: t.access,
        prices: cp.price, activation: cp.act, iec: cp.iec, split: cp.split,
        ...(Object.keys(regionPrices).length ? { regionPrices } : {}),
      });
    }
    const ver = await get(
      'SELECT MAX(valid_from) AS d FROM tariff_version WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)', [today()]);
    return json(res, 200, { at: ver?.d ?? null, data: out }, headers);
  }
  if (url.pathname === '/v1/omie/daily' && req.method === 'GET') {
    const nDays = Number(url.searchParams.get('days') || 60);
    const days = Number.isFinite(nDays) ? Math.min(120, Math.max(7, Math.trunc(nDays))) : 60;
    getDaily(days).then(
      d => json(res, 200, d, headers),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `séries indisponíveis: ${e.message}` } }, headers));
    return;
  }
  if (url.pathname === '/v1/omie/futures' && req.method === 'GET') {
    getFutures().then(
      d => json(res, 200, d, headers),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `futuros indisponíveis: ${e.message}` } }, headers));
    return;
  }
  if (url.pathname === '/v1/omie/stats' && req.method === 'GET') {
    getStats().then(
      d => json(res, 200, d, headers),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `estatísticas indisponíveis: ${e.message}` } }, headers));
    return;
  }
  if (url.pathname === '/v1/indexed/quarters' && req.method === 'GET') {
    // Os 96 quartos de hora de um dia com o preço de um indexado e, se
    // vier `fixed`, quem ganha em cada quarto contra esse fixo.
    // Parâmetros: tariff, region, date (dia de Lisboa), fixed, tz (fuso em
    // que se mostram as horas).
    const tid = url.searchParams.get('tariff'), region = url.searchParams.get('region') || 'CONT';
    const tz = validTz(url.searchParams.get('tz'));
    if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } }, headers);
    const t = (await query('SELECT * FROM tariff WHERE id = $1', [tid || ''])).find(x => x.kind === 'INDEXED')
      || (await query("SELECT * FROM tariff WHERE kind = 'INDEXED' ORDER BY id LIMIT 1"))[0];
    if (!t) return json(res, 404, { error: { code: 'no_indexed', message: 'sem tarifário indexado' } }, headers);
    // A versão em vigor hoje (ou, se ainda nenhuma começou, a próxima).
    const ver = await get(
      `SELECT * FROM tariff_version WHERE tariff_id = $1
        AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)
        ORDER BY valid_from DESC LIMIT 1`, [t.id, today()]
    ) || await get(
      `SELECT * FROM tariff_version WHERE tariff_id = $1 AND valid_from > $2
        ORDER BY valid_from ASC LIMIT 1`, [t.id, today()]
    );
    if (!ver) return json(res, 404, { error: { code: 'no_indexed_version', message: 'sem versão em vigor do tarifário indexado' } }, headers);

    // O fixo escolhido no comparador, cotado na mesma região.
    const fixId = url.searchParams.get('fixed');
    let fixPrice = null, fixInfo = null;
    if (fixId) {
      const ft = await get('SELECT * FROM tariff WHERE id = $1', [fixId]);
      if (ft) {
        const fv = await get(
          `SELECT id FROM tariff_version v WHERE v.tariff_id = $1
           AND v.valid_from <= $2 AND (v.valid_to IS NULL OR v.valid_to > $2)
           ORDER BY valid_from DESC LIMIT 1`,
          [ft.id, today()]
        );
        // Sem versão em vigor ou sem preços, fica sem fixo (a página esconde
        // as colunas de comparação).
        const fp = fv ? (await comps(fv.id, region)).price : null;
        if (fp && Object.keys(fp).length) {
          fixPrice = fp;
          const fc = await get('SELECT name FROM ceme WHERE id = $1', [ft.ceme_id]);
          fixInfo = { id: ft.id, name: ft.name, ceme: fc?.name || ft.ceme_id, voltage: ft.voltage, schedule: ft.schedule, cycle: ft.cycle };
        }
      }
    }

    const finish = (q) => {
      try {
        // O período de cada quarto, calculado à parte para o indexado e
        // para o fixo (os ciclos deles podem ser diferentes).
        const withP = q.rows.map(r => {
          const at = new Date(r.utc);
          const per = periodForRegion({ region, schedule: t.schedule, cycle: t.cycle, at });
          const fixPer = fixInfo
            ? periodForRegion({ region, schedule: fixInfo.schedule, cycle: fixInfo.cycle, at })
            : null;
          return {
            start: fmtTime(r.utc, tz), end: fmtTime(new Date(at.getTime() + 15 * 60000).toISOString(), tz),
            period: per, fixPeriod: fixPer, omieMwh: r.pt, utc: r.utc, src: r.src, est: !!r.est,
          };
        });
        Promise.all(withP.map(async (item) => {
          // Preço do indexado neste quarto, com a TAR da região e as perdas
          // do próprio quarto.
          const tarEurKwh = await tarFor(region, t.voltage, item.period, q.date);
          if (tarEurKwh == null) throw new Error(`sem TAR ${region}/${t.voltage}/${item.period} em ${q.date}`);
          const vm = vmeta(t.id);
          item.loss = lossAt(t.voltage, item.utc) ?? vm.loss;
          const { price } = indexedPrice({ omieEurKwh: item.omieMwh / 1000, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh, loss: item.loss, formula: vm.formula });
          item.price = Math.round(price * 10000) / 10000;
        })).then(() => {
          // Quem ganha em cada quarto (engine/compare.js).
          const comp = compareWithFixed(withP, fixPrice);
          const ranked = [...comp].sort((x, y) => x.price - y.price);
          // Os 8 quartos mais baratos, identificados pelo instante (em Outubro
          // há duas "01:00").
          const cheap = new Set(ranked.slice(0, 8).map(x => x.utc));
          const vm2 = vmeta(t.id);
          json(res, 200, {
            date: q.date, tariff: t.id, name: t.name, region, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh,
            // Média das perdas dos quartos (cada quarto usa a sua).
            loss: withP.every(x => x.loss != null) && withP.length ? withP.reduce((a, x) => a + x.loss, 0) / withP.length : (vm2.loss ?? LOSS_PLACEHOLDER[t.voltage]), source: SOURCE_LABEL,
            // estimated: o dia todo é estimativa; estimatedFrom: a hora a partir
            // da qual passa a ser (tipicamente 23:00, vê docs/03).
            estimated: q.rows.length > 0 && q.rows.every(r => r.est),
            estimatedFrom: q.rows.some(r => r.est) && !q.rows.every(r => r.est) ? withP.find(x => x.est).start : null,
            days: q.days, fixed: fixInfo,
            warning: REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF',
            wins: tallyWinners(comp),
            quarters: comp.map(x => ({ ...x, cheap: cheap.has(x.utc) }))
          }, headers);
        }).catch(e => json(res, 400, { error: { code: 'quote_failed', message: e.message } }, headers));
      } catch (e) { json(res, 400, { error: { code: 'quote_failed', message: e.message } }, headers); }
    };
    getQuarters(quarterDay(url.searchParams.get('date'))).then(finish, e => json(res, 502, { error: { code: 'omie_unavailable', message: e.message } }, headers));
    return;
  }
  if (url.pathname === '/v1/simulate' && req.method === 'POST') {
    let body = '', tooBig = false;
    req.on('data', c => {
      // Acima de MAX_BODY pára de guardar e responde 413 no fim.
      if (tooBig) return;
      if (body.length + c.length > MAX_BODY) { tooBig = true; body = ''; return; }
      body += c;
    });
    req.on('end', async () => {
      if (tooBig) return json(res, 413, { error: { code: 'payload_too_large', message: `corpo > ${MAX_BODY} bytes` } }, headers);
      try {
        // Valida tudo o que vem no corpo antes de usar (vê docs/04 para o
        // formato do pedido).
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: { code: 'bad_request', message: 'corpo JSON inválido' } }, headers); }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return json(res, 400, { error: { code: 'bad_request', message: 'corpo deve ser um objecto JSON' } }, headers);
        }
        const { kwh = 40, at, region = 'CONT', omie = 0.20, omieVazio, omieFora, omieCycles, useSpot } = parsed;
        if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } }, headers);
        if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh <= 0 || kwh > 1000) {
          return json(res, 400, { error: { code: 'bad_kwh', message: 'kwh deve ser um número maior que 0 e até 1000' } }, headers);
        }
        let now;
        if (at != null) {
          now = new Date(at);
          if (Number.isNaN(now.getTime())) return json(res, 400, { error: { code: 'bad_at', message: 'at deve ser uma data ISO válida' } }, headers);
        } else now = new Date();
        const omieVals = [['omie', omie], ['omieVazio', omieVazio], ['omieFora', omieFora]];
        if (omieCycles != null) {
          if (typeof omieCycles !== 'object' || Array.isArray(omieCycles)
            || Object.keys(omieCycles).some(c => c !== 'DIARIO' && c !== 'SEMANAL')) {
            return json(res, 400, { error: { code: 'bad_omie', message: 'omieCycles: { DIARIO?, SEMANAL? } com { vazio, fora } em €/kWh' } }, headers);
          }
          for (const [c, v] of Object.entries(omieCycles)) {
            if (typeof v !== 'object' || v === null) return json(res, 400, { error: { code: 'bad_omie', message: `omieCycles.${c} deve ser { vazio, fora }` } }, headers);
            omieVals.push([`omieCycles.${c}.vazio`, v.vazio], [`omieCycles.${c}.fora`, v.fora]);
          }
        }
        for (const [nome, v] of omieVals) {
          if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
            return json(res, 400, { error: { code: 'bad_omie', message: `${nome} deve ser um número (€/kWh) positivo` } }, headers);
          }
        }
        // O dia do carregamento na região escolhe a versão e a TAR em vigor.
        const day = civilDay(now, REGIONS[region].tz);
        const tariffs = await allTariffs(day);
        // useSpot: usa o OMIE do quarto de hora do carregamento nos
        // indexados. Se não houver, ficam as médias.
        let spot = null;
        if (useSpot === true) {
          try {
            const qs = await getQuarters(civilDay(now));
            const r = qs.rows.find(x => { const t0 = Date.parse(x.utc); return t0 <= now.getTime() && now.getTime() < t0 + 15 * 60000; });
            if (r && Number.isFinite(r.pt)) spot = { omieKwh: r.pt / 1000, utc: r.utc, loss: null };
          } catch (e) { console.warn('[ceme-v2] simulate: sem OMIE do quarto, a usar médias:', e.message); }
        }
        // Cota cada tarifário. Se um falhar (dados errados, falta de TAR),
        // fica de fora com um aviso no log e os outros seguem ("quarentena").
        // Correm 8 de cada vez: cada cotação faz várias queries, e 8 fica
        // abaixo das 10 ligações do pool para sobrar para outros pedidos.
        const CONCURRENCY = 8;
        const results = new Array(tariffs.length);
        let next = 0;
        const worker = async () => {
          while (true) {
            const i = next++;
            if (i >= tariffs.length) return;
            const t = tariffs[i];
            try {
              results[i] = await quoteOne(t, { at: now, day, kwh, region, omie, omieVazio, omieFora, omieCycles, spot: spot && { ...spot, loss: lossAt(t.voltage, now) } });
            } catch (e) {
              console.warn(`[ceme-v2] tarifário em quarentena: ${t.id}: ${e.message}`);
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, tariffs.length) }, worker)
        );
        // Do mais barato para o mais caro.
        const data = results.filter(Boolean);
        data.sort((x, y) => x.totalEur - y.totalEur);
        const avg = data.length ? data.reduce((s, q) => s + q.totalEur, 0) / data.length : 0;
        json(res, 200, { at: now.toISOString(), kwh, region, omieRef: spot ? spot.omieKwh : omie, omieSpot: spot ? { utc: spot.utc, eurKwh: spot.omieKwh } : null, avg: Math.round(avg * 100) / 100, data }, headers);
      } catch (e) { json(res, 400, { error: { code: 'quote_failed', message: e.message } }, headers); }
    });
    return;
  }
  json(res, 404, { error: { code: 'not_found', message: url.pathname } }, headers);
}

// Qualquer erro não apanhado num pedido vira um 500, em vez de derrubar o
// processo inteiro.
const server = http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) {
    console.error('[ceme-v2] erro no pedido:', e);
    if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: 'erro interno' } });
    else res.end();
  }
});
process.on('unhandledRejection', (e) => console.error('[ceme-v2] rejeição não tratada:', e));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[ceme-v2] porta ${PORT} ocupada — outro servidor já corre aí.`);
    console.error(`  kill $(lsof -ti tcp:${PORT})  ou  PORT=<outra> node src/server.js`);
    process.exit(1);
  }
  console.error('[ceme-v2] erro no servidor:', e);
});
server.listen(PORT, () => console.log(`ceme-v2 http://localhost:${PORT}/ db=${USE_PG ? 'postgresql' : 'sqlite'}`));
