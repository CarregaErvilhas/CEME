// Servidor (Node.js em produção via pg; SQLite em dev/test).
// Serve a web em / e a API em /v1/* (tudo com auth). O hardening da main
// está re-aplicado sobre a migração assíncrona: nosniff, rate limiting,
// 405 por método, cap do corpo (413), validação de input, guarda da secret
// de dev, auth de X-API-Key por hash e quarentena por tarifário.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
// Secret "de dev" conhecida manteria o servidor a arrancar sem configuração —
// mas no deploy real é a porta para fabricar WEB_SESSION à vontade. O meio
// termo: o server arranca sempre (dev/CI não rebenta), mas se a secret em
// uso for a de dev e o processo pareça produção (`NODE_ENV=production`), o
// /v1/session recusa-se a emitir bilhete (503) — o site não fica seguro
// por omissão só porque o aviso do log ninguém o leu.
const DEV_FALLBACK = 'dev-only-change-me';
const SECRET = process.env.JWT_SECRET || DEV_FALLBACK;
const WEAK_SECRET = SECRET === DEV_FALLBACK;
// Com a secret de dev em produção nem se emite (/v1/session) nem se aceita
// Bearer: a secret é pública, qualquer um fabricava um token que não expira.
const WEAK_IN_PROD = WEAK_SECRET && process.env.NODE_ENV === 'production';
if (WEAK_SECRET) console.warn('[ceme-v2] AVISO: JWT_SECRET não definida — a secret de dev "dev-only-change-me" está em uso. Qualquer pessoa pode fabricar sessões.',
  'Com NODE_ENV=production, POST /v1/session devolve 503 em vez de emitir tokens.',
  'Em publicação: export JWT_SECRET=<openssl rand -hex 32>.');
// Directórios resolvidos a partir do ficheiro, não do cwd: `npm start` corre
// da pasta backend/, mas arrancar `node ceme-v2/backend/src/server.js` da raiz
// do repo criava `./data` no sítio errado (cache OMIE vazia → 502).
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(BACKEND_DIR, 'data');

// Flags de bootstrap (opcionais, para previews/snapshots/readonly):
//   CEME_READONLY=1     -> não escreve nada na BD: o bootstrap salta
//                         schema/seed/tar/api_key, o OMIE não ingere nem grava
//                         derivados (calcula-os em memória), e `run()` recusa
//                         qualquer escrita que escape (db.js). Usar com a BD de
//                         outro ambiente ou com um snapshot já restaurado.
//   CEME_SKIP_SEED=1    -> salta o seed (upsert massivo), mas corre schema +
//                         tar + api_key. Útil com snapshot restaurado, para não
//                         sobrescrever edições manuais da produção.
const SKIP_SEED = READONLY || process.env.CEME_SKIP_SEED === '1';
const SKIP_SCHEMA = READONLY;
const SKIP_TAR = READONLY;
const SKIP_API_KEY = READONLY;

if (READONLY) console.warn('[ceme-v2] modo READONLY: bootstrap de escrita desactivado.');

// Migrações que o CREATE TABLE IF NOT EXISTS não cobre (as tabelas do OMIE
// passaram a ser indexadas pelo instante UTC). Correm antes do schema.
if (!SKIP_SCHEMA) {
  const notes = await migrateOmieTables();
  for (const n of notes) console.warn(`[ceme-v2] migração: ${n}`);
}

// Schema executado uma vez no arranque (idempotente). Em modo readonly as
// tabelas já existem (snapshot ou BD de produção) — saltar evita erros de
// permissão (CREATE TABLE exige privilégio CREATE no schema).
if (!SKIP_SCHEMA) {
  const schemaFile = USE_PG
    ? new URL('./db/schema.postgres.sql', import.meta.url)
    : new URL('./db/schema.sql', import.meta.url);
  const schemaSql = await readFile(schemaFile, 'utf8');
  await run(schemaSql);
}

// Colunas novas em tabelas que já existem: o `CREATE TABLE IF NOT EXISTS`
// não as acrescenta, e sem isto o seed vai à vida contra a forma antiga da
// BD de produção. Corre DEPOIS do schema (numa BD nova, a tabela já nasce
// com as colunas) e ANTES do seed (que é quem as usa).
if (!SKIP_SCHEMA) {
  const notes = await migrateAddedColumns();
  for (const n of notes) console.warn(`[ceme-v2] migração: ${n}`);
}

// API key para terceiros: o valor claro é provido pela env (CEME_API_KEY) e
// NUNCA fica na BD — só o sha256. A env é a fonte de verdade da linha
// `env-key`, nos dois sentidos:
//   - com a env: upsert do hash (trocar a chave invalida a antiga) e
//     `revoked_at` limpo (voltar a pôr a env reactiva-a);
//   - sem a env: a linha é revogada. A BD persiste (Postgres), por isso tirar
//     a env sem isto deixava a chave antiga a funcionar para sempre.
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

// TAR da mobilidade eléctrica 2026 (ERSE, Diretiva n.º 1/2026, art. 23.º).
// É UMA tabela para o Continente, a RAA e a RAM ("Tarifas de Acesso às Redes
// da Mobilidade Elétrica em Portugal continental, RAA e RAM", no livro de
// tarifas da ERSE) — os valores são os mesmos nas três regiões, mas cada uma
// tem as suas linhas: a TAR procura-se sempre pela região do carregamento, e
// uma região sem linha é um erro, não um zero. O que a ERSE publica à parte
// para as ilhas é a TE/Com (energia + comercialização da EDA/EEM ao CEME),
// que não é TAR e não entra aqui.
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

// Seed — depende do backend ativo. Saltado em modo readonly ou com snapshot.
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
// Reaplica a lógica actual aos dados já guardados (ex.: mudança de agrupamento
// por dia de mercado), sem depender de uma ingestion completa ao arranque.
// (Em readonly não se grava: as estatísticas calculam-se em memória no
// primeiro pedido.)
if (!READONLY) {
  try { await rebuildDerived(); console.log('[ceme-v2] derivados recalculados no arranque'); }
  catch (e) { console.warn('[ceme-v2] rebuildDerived falhou:', e.message); }
}

function vmeta(tid) {
  const v = VERSIONS[tid] || {};
  const loss = (v.loss != null) ? v.loss : null;
  return { loss, formula: v.formula || 'standard' };
}

// A hora de relógio que se mostra ao utilizador é a do fuso DELE (o browser
// manda o seu). O backend guarda tudo em UTC — o fuso só aparece aqui, na
// fronteira da apresentação. Sem fuso válido, UTC.
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

// O dia pedido (dia civil de Lisboa, que é o dia dos quartos do OMIE) ou
// hoje em Lisboa. Não o dia UTC: entre as 00:00 e as 01:00 de Verão o dia
// UTC ainda é ontem, e o comparador abria no dia errado.
function quarterDay(date) {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return civilDay();
}

// "Hoje", para as validades (tarifários e TAR): o dia civil em Portugal.
// Nunca `CURRENT_DATE` da BD — é o dia UTC (o pool do pg corre em UTC), e
// uma campanha que acaba a 30/09 ficava em vigor até à 01:00 de 01/10.
const today = () => civilDay();

const json = (res, code, obj, extraHeaders = {}) => {
  // nosniff: sem isto, um JSON reflectido podia ser interpretado como
  // text/html em browsers antigos — resposta barata para um ataque real.
  res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(obj));
};

// Endereços de loopback, para o readinessCheck. O Zerops chama de dentro do
// container; `::ffff:127.0.0.1` aparece quando o servidor escuta em :: (dual
// stack) e o cliente vem de 127.0.0.1.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopback = req => LOOPBACK.has(req.socket?.remoteAddress || '');

// SELECT 1 com prazo e com cache. O health check do Zerops dá 5 s ao
// pedido: o timeout de ligação do pg (5 s) deixaria a resposta em cima da
// hora, e um check que nunca passa é pior do que nenhum. O cache de 5 s
// limita o custo a uma query por intervalo, venha o check de onde vier.
// Resolve (nunca rejeita) para não deixar uma rejeição tardia a crashar o
// processo.
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

// Rate limiting: janela fixa, em memória — suficiente para um nó
// único (em produção, um limitador à frente do server). Sessão web conta
// por IP; terceiros contam pela chave de API. O mapa é podado
// preguiçosamente e tem teto: sem isso, uma enxurrada de IPs distintos
// cresce memória sem limite — DoS do próprio limitador.
const RATE_WINDOW_MS = 60_000;
const RATE_DEFAULT = 60;        // requisições/minuto de API web (Bearer)
const RATE_SESSION = 10;        // /v1/session por IP por minuto (pré-auth!)
const RATE_MAX_BUCKETS = 10_000;
const buckets = new Map();      // chave -> { count, resetAt }
function rateBucket(key, limit) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    if (buckets.size >= RATE_MAX_BUCKETS) {
      // poda: largar o que já expirou; se ainda estiver cheio, largar o mais antigo
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

// Atrás do proxy (Cloudflare + L7 do Zerops) o peer TCP é sempre o proxy e o
// limitador dava UM orçamento global a todos os clientes. CEME_TRUST_PROXY=N
// diz quantos saltos de confiança há à frente do processo: o IP do cliente é
// a N-ésima entrada a contar da DIREITA de X-Forwarded-For (as da esquerda
// são forjáveis). Por omissão (0) usa-se o peer, como antes.
const TRUST_PROXY = Math.max(0, parseInt(process.env.CEME_TRUST_PROXY || '0', 10) || 0);
const clientIp = (req) => {
  if (TRUST_PROXY > 0) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const ip = hops[hops.length - TRUST_PROXY];
    if (ip) return ip;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
};

async function auth(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    if (WEAK_IN_PROD) return { ok: false, error: 'no_secret' };
    return verifyJwt(h.slice(7), SECRET);
  }
  const k = req.headers['x-api-key'];
  if (k) {
    // Valida contra o hash em BD (revogada/expirada exclui). Antes aceitava
    // qualquer string — o endpoint estava, na prática, sem auth de terceiros.
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

// A versão é a que está em vigor no dia pedido. Para um dia sem versão
// conhecida (anterior à primeira captura) usa-se a de hoje: o seed não tem
// histórico de preços antes da folha, e uma lista vazia sem erro é pior do
// que o preço actual.
async function allTariffs(day = today()) {
  // Simulam-se TODOS os tarifários para a região escolhida (com o IVA
  // e os ciclos dessa região). A disponibilidade comercial (`regions`) é
  // mostrada como informação, não como filtro.
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

async function comps(vid, region = 'CONT') {
  let rows = await query('SELECT * FROM price_component WHERE tariff_version_id = $1', [vid]);
  // Linhas de região POR CIMA das de omissão (Continente): só existem onde o
  // CEME cobra diferente nas ilhas (price_component_region). Vão DEPOIS das
  // de omissão — preço e decomposição usam "a última vence", logo a ilha
  // sobrepõe ao Continente e um período sem linha própria cai no preço CONT.
  if (region && region !== 'CONT') {
    const reg = await query('SELECT * FROM price_component_region WHERE tariff_version_id = $1 AND region = $2', [vid, region]);
    rows = [...rows, ...reg];
  }
  return compRows(rows, vid);
}

// O formato { price, split } a partir das linhas JÁ MESCLADAS de uma versão
// (Continente + região, só região, ou só Continente). Usado pelo comps() e
// pelo /v1/tabela (que precisa do mesmo formato por ilha, sem o merge POR
// CIMA — as linhas de região são mostradas À PARTE, nunca misturadas).
function compRows(rows, vid) {
  let out;
  try { out = pickComponents(rows); }
  catch (e) { throw new Error(`${e.message} na versão ${vid}`); }
  // A decomposição energia + TAR, quando a folha a tinha (o CEME publicava a
  // energia separada). Onde não há, fica null — o preço final é o que o
  // CEME publica, e não se inventa a parte da energia.
  const split = {};
  for (const r of rows) {
    split[r.period] = (r.energy_only_eur_kwh == null || r.tar_eur_kwh == null)
      ? null
      : { energy: r.energy_only_eur_kwh, tar: r.tar_eur_kwh };
  }
  out.split = split;
  return out;
}

// EGME: o `activation` da resposta é o que o CEME publica (sem substituição
// silenciosa — ver seed.js). O valor legal em vigor fica como contexto no
// lado do cliente: quando o publicado ainda é o de 2025 (acima do legal),
// `activation_stale` assinala — actualizar é tarefa de nova captura da folha,
// não de derivar valores no código a cada mudança de regulamento.
// `activation_stale` só marca quem ainda publica o valor legal ANTERIOR
// (EGME_PREVIOUS). Valores próprios acima do legal (packs, taxas do próprio
// CEME) são legítimos e não são "desactualizados".
const EGME_LEGAL = 0.1088; // €/carregamento, Regul. ERSE 7/2026 (em vigor 2026-01-01)
const EGME_PREVIOUS = 0.1572; // o valor legal de 2025
const egmeFlags = (act) => ({ egme_legal: EGME_LEGAL, activation_stale: Math.abs(act - EGME_PREVIOUS) < 1e-9 });

// A TAR em vigor num dia para (região, tensão, período) — ou null, se não a
// temos. A TAR é o acesso à rede: o valor regulado pela ERSE, o mesmo para
// todos os comercializadores. Não se inventa TAR nenhuma: um dia anterior à
// primeira TAR conhecida usa a mais antiga que há (como os tarifários).
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
    // A decomposição vem dos componentes (a folha): só a há para os
    // tarifários em que o CEME publicava a energia à parte. Nos outros o
    // preço é o final, tal como o CEME o publica.
    return { ...meta, activation: act, iec, prices: price, split, avail: t.regions, ...egmeFlags(act), ...q };
  }
  // INDEXED: PE por período com o OMIE de referência do pedido.
  // Nas ilhas usa-se a ref. continental com aviso (MIBEL não cobre as ilhas).
  const here = REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF';
  // A TAR é a da região do carregamento (a rede é a da ilha); só o OMIE é
  // continental. Sem TAR não há preço: rebenta e o tarifário vai para a
  // quarentena, em vez de sair um preço sem rede.
  const tarOf = async (per) => {
    const tar = await tarFor(region, t.voltage, per, day);
    if (tar == null) throw new Error(`sem TAR ${region}/${t.voltage}/${per} em ${day}`);
    return tar;
  };
  const vm = vmeta(t.id);
  // Perdas(h): média do perfil E-REDES do dia nos quartos de cada período —
  // o mesmo conjunto de quartos de que vêm as médias do OMIE. Sem perfil
  // (ano não carregado) cai nas perdas da versão / média anual.
  const lossPer = lossByPeriod(t.voltage, at, d => periodForRegion({ region, schedule: t.schedule, cycle: t.cycle, at: d }), `${region}|${t.schedule}|${t.cycle}`);
  // SPLIT_VAZIO_FORA: o OMIE de cada período é a média desse período NO
  // CICLO DO TARIFÁRIO — o vazio do ciclo semanal (LuziGas) não é o do diário
  // (MEO, Ynerluz): ao sábado e ao domingo as horas são outras. Com
  // `omieCycles` (o que a web manda) cada um usa o seu; sem ele, o par
  // omieVazio/omieFora vale para todos (é um override explícito).
  // UNICA: um só OMIE para os dois períodos.
  const agg = ver.omie_aggregation || 'SPLIT_VAZIO_FORA';
  const cyc = (omieCycles && omieCycles[t.cycle]) || {};
  const pair = { vazio: cyc.vazio ?? omieVazio, fora: cyc.fora ?? omieFora };
  const omieForPeriod = (per) => {
    if (agg === 'SPLIT_VAZIO_FORA') return (per === 'VAZIO' ? (pair.vazio ?? omie) : (pair.fora ?? omie));
    return omie;
  };
  // `spot`: o OMIE (e as perdas) do quarto de hora do carregamento — o que o
  // CEME cobra de facto nesse instante. Quando há, substitui as médias por
  // período (que só servem de referência para um carregamento sem hora).
  const spotKwh = spot?.omieKwh ?? null;
  const out = {};
  // Nos indexados a energia e a TAR estão SEPARADAS por construção: o preço
  // é (OMIE + K + CGS) × (1 + perdas) + TAR. Logo a decomposição é exacta
  // — não é aritmética nossa, é a fórmula.
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
  // Guarda: indexado com ciclo SIMPLES só tem preço UNICO — o motor só sabe
  // preços por período (VAZIO/FORA_VAZIO). Não há tarifário assim no seed,
  // mas um futuro seed sem esta guarda fazia o quoteFixed rebentar com
  // "sem preço final para UNICO" em cada simulação. Aproximação honesta:
  // usa o preço fora-vazio da energia (sem TAR — o UNICO real teria a
  // TAR simples do período, ignorada aqui) — melhor do que 500.
  if (t.schedule === 'SIMPLES' && out.UNICO == null) {
    out.UNICO = out.FORA_VAZIO ?? out.VAZIO ?? 0;
  }
  const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price: out, activation: act, support: sup, iec, region, split: splitIdx });
  return { ...meta, activation: act, iec, prices: out, split: splitIdx, estimated: false, omieRef, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh, loss: spot?.loss ?? lossPer?.[q.period] ?? vm.loss ?? LOSS_PLACEHOLDER[t.voltage], omieSpot: spotKwh != null, lossByPeriod: lossPer, formula: vm.formula, warning: here, avail: t.regions, ...egmeFlags(act), ...q };
}

// Negociação de idioma a partir do cabeçalho Accept-Language. Só há PT e EN:
// se o browser pedir explicitamente inglês, servimos inglês; qualquer outra
// coisa (es, fr, de, it, ou header ausente) fica em português, porque o
// público-alvo é português. O cliente pode sobrepor via localStorage.
// O marcador que cada página traz para o servidor lhe injectar a língua. Com
// espaços opcionais: o /tabela escrevia `window.__LANG__ = null` e o replace
// literal nunca acertava (a página ignorava o Accept-Language sem ninguém dar
// por isso).
const LANG_MARK = /window\.__LANG__\s*=\s*null/;

function negotiateLang(header) {
  if (!header) return 'pt';
  const tags = String(header).split(',')
    .map(s => { const [tag, ...params] = s.trim().split(';'); const q = params.find(p => /^\s*q=/.test(p)); return { tag: tag.trim().toLowerCase(), q: q ? parseFloat(q.split('=')[1]) || 0 : 1 }; })
    .filter(t => t.tag && t.q > 0).sort((a, b) => b.q - a.q);
  return tags[0] && tags[0].tag.startsWith('en') ? 'en' : 'pt';
}

// Duas interfaces para a mesma API: o assistente passo-a-passo (três
// perguntas, por omissão) e o simulador completo. O assistente é a porta de
// entrada; o utilizador troca no link de cada página, e a escolha fica num
// cookie que este servidor lê para responder à página certa em `GET /`.
const UI = {
  assistente: { file: 'assistente.html' },
  completo: { file: 'index.html' },
};
// `null` = respeitar o cookie (a rota `/`); um valor = gravar essa escolha.
const UI_ROUTES = { '/': null, '/index.html': null, '/assistente': 'assistente', '/simulador': 'completo' };
const UI_COOKIE = 'ceme_ui';
const UI_COOKIE_MAX_AGE = 31536000; // 1 ano

// Páginas institucionais do site (Sobre, Contactos). São as mesmas para toda
// a gente — a escolha do cookie é só da interface (assistente vs simulador),
// por isso aqui não há cookie para ler nem para gravar. O English existe
// porque metade dos nossos utilizadores escreve em inglês: `/sobre` e
// `/about` são a mesma página.
const INFO_ROUTES = {
  '/sobre': 'about.html', '/about': 'about.html',
  '/contactos': 'contact.html', '/contact': 'contact.html',
  '/api': 'api.html',
  // Subpágina sem links (rota subterrânea): a tabela em bruto dos
  // tarifários em vigor, directa da BD.
  '/tabela': 'tabela.html',
};

// Página das estatísticas OMIE (omie.cocofree.dev, e /omie no site
// principal). É uma página à parte — vive dos dados OMIE e não do motor de
// simulação — mas partilha o servidor e a API. O domínio próprio aponta
// para a raiz: quem abre omie.cocofree.dev quer a tabela, não o simulador.
const OMIE_ROUTES = { '/omie': 'omie.html', '/omie.html': 'omie.html' };
const OMIE_HOST = 'omie.cocofree.dev';

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
// Valor ausente ou desconhecido cai no assistente: é a interface que um
// visitante novo vê, e um cookie editado à mão não pode dar 500.
const uiFromCookie = req => (readCookie(req, UI_COOKIE) === 'completo' ? 'completo' : 'assistente');
// Cookie de preferência de UI, não de sessão: nada aqui autentica, e o JS
// não precisa de o ler. `Secure` só quando o pedido chegou por https (em dev
// é http, e um cookie Secure seria descartado).
function uiCookie(req, ui) {
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${UI_COOKIE}=${ui}; Path=/; Max-Age=${UI_COOKIE_MAX_AGE}; SameSite=Lax${https ? '; Secure' : ''}`;
}

// Um método por endpoint: leitura para os /v1/* de dados, POST para os
// dois que aceitam corpo. 405 antes de gastar auth.
const METHODS = {
  '/v1/health': 'GET', '/v1/cemes': 'GET', '/v1/tariffs': 'GET', '/v1/tar': 'GET',
  '/v1/tabela': 'GET',
  '/v1/omie/daily': 'GET', '/v1/omie/futures': 'GET', '/v1/omie/stats': 'GET',
  '/v1/indexed/quarters': 'GET',
  '/v1/session': 'POST', '/v1/simulate': 'POST',
};
const MAX_BODY = 64 * 1024; // 64 KB — corpos raquíticos; pedir mais é abuso

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return json(res, 400, { error: { code: 'bad_request', message: 'alvo do pedido inválido' } }); }
  // Web sem auth (ficheiros estáticos); a API continua toda com auth.
  // HEAD é aceito (só read-only, corpo vazio) — sem isto, HEAD / dava 401.
  const readStatic = method => method === 'GET' || method === 'HEAD';
  // Liveness e readiness para o Zerops (`run.healthCheck` e
  // `deploy.readinessCheck` em zerops.yml). São as únicas rotas sem auth:
  // o balancer tem de as alcançar de dentro do container.
  //
  // `/healthz` (liveness) só diz que o processo está vivo — não toca na BD.
  // `/readyz` (readiness) acrescenta um SELECT 1: é a que decide se o
  // container novo pode receber tráfego. A verificação da BD é o que
  // separa as duas: se a BD cai, o healthCheck não pode desligar o pod do
  // balancer (com um só pod isso era o site inteiro a dar 502), mas o
  // readinessCheck tem de reprovar o pod novo.
  if (readStatic(req.method) && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, up: Math.round(process.uptime()) });
  }
  if (readStatic(req.method) && url.pathname === '/readyz') {
    // O readinessCheck do Zerops corre de dentro do container (127.0.0.1) —
    // é aí que a BD é consultada. De fora não se toca na BD: o check é
    // interno e um `SELECT 1` por pedido seria um caminho grátis para
    // esgotar o pool. E, fora do loopback, a resposta é 200 com
    // `db: unknown` em vez de 403 — assim um probe que venha de outro
    // sítio nunca chumba um deploy (um check que dá `false` por engano é
    // pior que a falta dele).
    if (!isLoopback(req)) return json(res, 200, { ok: true, db: 'unknown' });
    const alive = await dbAlive();
    if (!alive) {
      return json(res, 503, { ok: false, db: 'down', error: { code: 'db_unavailable', message: 'a BD não respondeu' } });
    }
    return json(res, 200, { ok: true, db: 'up' });
  }
  if (readStatic(req.method) && url.pathname === '/strings.js') {
    // Dicionário partilhado pelas duas interfaces: um só ficheiro para os dois
    // sites, por isso não pode ficar preso em cache depois de um deploy.
    try {
      const js = await readFile(new URL('../../frontend/strings.js', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(js);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/strings.js em falta' } }); }
  }
  if (readStatic(req.method) && url.pathname === '/pages.css') {
    // Estilo das páginas Sobre/Contactos (frontend/pages.css). Vive fora
    // porque as duas páginas são irmãs e não vale a pena duplicar o CSS.
    try {
      const css = await readFile(new URL('../../frontend/pages.css', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(css);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/pages.css em falta' } }); }
  }
  // robots.txt: sem auth. A /tabela é só para debug — fora dos motores de busca.
  if (readStatic(req.method) && url.pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
    return res.end('User-agent: *\nDisallow: /tabela\nDisallow: /v1/\n');
  }
  // PWA: manifest, service worker e gatilho de instalação. Servidos sem auth,
  // como os outros ficheiros estáticos (strings.js, pages.css).
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
    // Horas de relógio por região (simulador + assistente). no-store, como o
    // strings.js: é código partilhado e não pode ficar preso numa versão velha.
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
  // Página OMIE. No domínio próprio (omie.cocofree.dev) é o que aparece na
  // raiz; no site principal vive em /omie. O servidor até agora só olhava
  // para o path — com dois domínios a servir a mesma app é o Host que
  // decide o que é a raiz.
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
    // Sobre e Contactos: HTML estático com a mesma negociação de língua das
    // interfaces (o cabeçalho Accept-Language decide, a bandeira decide
    // depois). Sem cookie — estas páginas não são uma "interface" a escolher.
    const lang = negotiateLang(req.headers['accept-language']);
    try {
      const html = (await readFile(new URL(`../../frontend/${INFO_ROUTES[url.pathname]}`, import.meta.url), 'utf8'))
        .replace('<html lang="pt-PT">', `<html lang="${lang === 'en' ? 'en' : 'pt-PT'}">`)
        .replace(LANG_MARK, `window.__LANG__=${JSON.stringify(lang)}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Language' });
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: `frontend/${INFO_ROUTES[url.pathname]} em falta` } }); }
  }
  if (readStatic(req.method) && Object.hasOwn(UI_ROUTES, url.pathname)) {
    // A escolha da interface vive num cookie que o servidor lê: `GET /` já
    // responde com a página certa (sem redirect nem flash). Só os caminhos
    // explícitos gravam a escolha; `/` nunca escreve, para a primeira visita
    // ficar sempre no assistente.
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
  // Um método por pathname: os handlers de leitura respondiam 200 a
  // PUT/DELETE (não faziam nada, mas fingiam que sim). 405 com `allow`.
  const allowed = METHODS[url.pathname];
  if (allowed && req.method !== allowed && !(allowed === 'GET' && req.method === 'HEAD')) {
    res.writeHead(405, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', allow: allowed });
    return res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: `${req.method} em ${url.pathname}; usar ${allowed}` } }));
  }
  if (req.method === 'POST' && url.pathname === '/v1/session') {
    // /v1/session corre ANTES da auth: sem aqui um teto, um martelo pode
    // assinar JWTs sem fim (custo de CPU) e fabricar sessões à vazia.
    const sessRl = rateBucket(`sess:${clientIp(req)}`, RATE_SESSION);
    if (!sessRl.allowed) return rateLimited(res, sessRl, RATE_SESSION);
    // Com a secret de dev em produção, proteger o bilhete: 503 em vez de
    // emitir tokens fabricáveis. Em dev/CI a secret segue a ser aceitável.
    if (WEAK_IN_PROD) {
      return json(res, 503, { error: { code: 'no_secret', message: 'JWT_SECRET em falta: export JWT_SECRET=<openssl rand -hex 32>' } });
    }
    const token = signJwt({ kind: 'WEB_SESSION', sid: Math.random().toString(36).slice(2) }, SECRET);
    return json(res, 200, { token, expires_in: 86400 });
  }
  const a = await auth(req);
  if (!a.ok) return json(res, 401, { error: { code: 'unauthorized', message: 'falta Authorization (Bearer ou X-API-Key)' } });

  // Rate limit depois da auth (401 não dá orçamento). Por IP para a sessão
  // web anonima; pela chave para terceiros. /v1/session tem o dele (acima).
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
    // Página /tabela: o espelho da folha. Os mesmos allTariffs + comps da
    // API (e a mesma janela de validade — o que expirou não sai). Reaproveito
    // tal como estão: se um tarifário com componente divergente rebentar
    // aqui, é o mesmo sinal que o simulador já dava — não há silêncio.
    const out = [];
    for (const t of await allTariffs()) {
      if (t.vid == null) continue; // sem versão em vigência (ex.: campanha expirada)
      const cp = await comps(t.vid);
      // Ilhas: os preços À PARTE por região, para os CEMEs que cobram
      // diferente nas ilhas (price_component_region) — ex.: a Enable, energia
      // 0,15 vs 0,12 €. No MESMO formato price/split de cima, um mapa
      // região → { prices, split }. Onde o CEME não diverge, NÃO há chave: o
      // tarifário cota-se com o preço do Continente em qualquer região (não
      // se inventa preço insular), e o /tabela não mostra linha nenhuma.
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
    // As estatísticas mensais: agregados por mês e por ciclo horário, mais
    // as células de referência. Vêm da BD (calculadas na ingestion).
    getStats().then(
      d => json(res, 200, d, headers),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `estatísticas indisponíveis: ${e.message}` } }, headers));
    return;
  }
  if (url.pathname === '/v1/indexed/quarters' && req.method === 'GET') {
    const tid = url.searchParams.get('tariff'), region = url.searchParams.get('region') || 'CONT';
    const tz = validTz(url.searchParams.get('tz'));
    if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } }, headers);
    const t = (await query('SELECT * FROM tariff WHERE id = $1', [tid || ''])).find(x => x.kind === 'INDEXED')
      || (await query("SELECT * FROM tariff WHERE kind = 'INDEXED' ORDER BY id LIMIT 1"))[0];
    if (!t) return json(res, 404, { error: { code: 'no_indexed', message: 'sem tarifário indexado' } }, headers);
    // A versão em vigor hoje; se ainda nenhuma começou, a primeira que vier
    // (como allTariffs/tarFor). Uma versão já fechada nunca fixa o preço.
    const ver = await get(
      `SELECT * FROM tariff_version WHERE tariff_id = $1
        AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)
        ORDER BY valid_from DESC LIMIT 1`, [t.id, today()]
    ) || await get(
      `SELECT * FROM tariff_version WHERE tariff_id = $1 AND valid_from > $2
        ORDER BY valid_from ASC LIMIT 1`, [t.id, today()]
    );
    if (!ver) return json(res, 404, { error: { code: 'no_indexed_version', message: 'sem versão em vigor do tarifário indexado' } }, headers);

    // Fixo de referencia: o que o cliente escolheu no comparador. Sem ele nao
    // ha com quem comparar — o endpoint so sabe quanto o INDEXADO custa.
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
        // Fixo sem versão em vigor, ou sem preços de energia (ex. só EGME),
        // não dá comparação: fica null — a UI trata como "sem fixo" e esconde
        // colunas, em vez de mostrar uma referência vazia com nome.
        // Preços por região: o fixo é cotado na MESMA região que os quartos
        // (a ilha sobrepõe ao Continente quando há linhas de região).
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
        // Cada tarifario e' cotado no SEU periodo, no SEU instante: um
        // indexado DIARIO e um fixo SEMANAL nao partilham as fronteiras.
        // (Usar o periodo do indexado para cotar o fixo dava um preco
        // fixo errado — o fixo mudava de preco as 22:00, que e' a
        // fronteira do ciclo diario, e nao a do semanal.)
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
          // A TAR em vigor no dia dos quartos, na região pedida (a coluna pode
          // levar versões futuras). Sem TAR não se cota: o quarto fica sem
          // preço em vez de sair um preço sem rede.
          const tarEurKwh = await tarFor(region, t.voltage, item.period, q.date);
          if (tarEurKwh == null) throw new Error(`sem TAR ${region}/${t.voltage}/${item.period} em ${q.date}`);
          const vm = vmeta(t.id);
          item.loss = lossAt(t.voltage, item.utc) ?? vm.loss;
          const { price } = indexedPrice({ omieEurKwh: item.omieMwh / 1000, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh, loss: item.loss, formula: vm.formula });
          item.price = Math.round(price * 10000) / 10000;
        })).then(() => {
          // quem ganha, quarto a quarto — logica em engine/compare.js
          const comp = compareWithFixed(withP, fixPrice);
          const ranked = [...comp].sort((x, y) => x.price - y.price);
          // Pelo instante, não pela hora de relógio: no dia da mudança de hora
          // de Outubro há dois quartos "01:00" e o rótulo não os distingue.
          const cheap = new Set(ranked.slice(0, 8).map(x => x.utc));
          const vm2 = vmeta(t.id);
          json(res, 200, {
            date: q.date, tariff: t.id, name: t.name, region, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh,
            // média das perdas dos quartos do dia (cada quarto usa a sua)
            loss: withP.every(x => x.loss != null) && withP.length ? withP.reduce((a, x) => a + x.loss, 0) / withP.length : (vm2.loss ?? LOSS_PLACEHOLDER[t.voltage]), source: SOURCE_LABEL,
            // estimado = o dia todo; parcial = so a cauda (o dia de mercado da OMIE
            // acaba as 23:00 de Lisboa, o resto do dia vem do OMIP)
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
      // Cap de 64 KB: sem isto um POST de 48 MB crescia a String e rebentava
      // no JSON.parse — memória à solta em cada conexão. O cap guarda a
      // decisão para o `end` (linha em branco, sem parse) e responde 413.
      if (tooBig) return;                       // já decidido: não voltar a encher o buffer
      if (body.length + c.length > MAX_BODY) { tooBig = true; body = ''; return; }
      body += c;
    });
    req.on('end', async () => {
      if (tooBig) return json(res, 413, { error: { code: 'payload_too_large', message: `corpo > ${MAX_BODY} bytes` } }, headers);
      try {
        // Corpo de terceiros/anónimos é input hostil: JSON malformado, kwh
        // string, `at` carne para new Date, omie o que vier. Sem validação,
        // o erro apanhado aqui vai com message crua para o cliente e valores
        // tolos (omie negativo, kwh 1e300) produziam preços absurdos.
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
        // O dia civil do carregamento, no relógio da região: é por ele que se
        // escolhe a versão do tarifário e a TAR em vigor (um carregamento
        // amanhã, depois de uma mudança de preço, usa o preço de amanhã).
        const day = civilDay(now, REGIONS[region].tz);
        const tariffs = await allTariffs(day);
        // useSpot: cota os indexados ao OMIE do quarto de hora do carregamento
        // (e às perdas desse quarto). Sem quarto disponível (dia sem dados,
        // OMIE em baixo) cai nas médias por período, sem rebentar o pedido.
        let spot = null;
        if (useSpot === true) {
          try {
            const qs = await getQuarters(civilDay(now));
            const r = qs.rows.find(x => { const t0 = Date.parse(x.utc); return t0 <= now.getTime() && now.getTime() < t0 + 15 * 60000; });
            if (r && Number.isFinite(r.pt)) spot = { omieKwh: r.pt / 1000, utc: r.utc, loss: null };
          } catch (e) { console.warn('[ceme-v2] simulate: sem OMIE do quarto, a usar médias:', e.message); }
        }
        // Isolamento por tarifário: um seed com um único período divergente
        // não pode derrubar os 128 — quarentena em vez de 400 (princípio do
        // docs/03). O tarifário a mais sai fora do ranking; a lista mantém
        // os restantes.
        //
        // Em paralelo com concorrência limitada: cada quoteOne faz várias
        // queries, e em pg cada uma é um round-trip pela rede. Em série, 128
        // tarifários x ~4 queries ficavam ~500 round-trips encadeados e o
        // pool (max 10) nunca era aproveitado. O limite fica abaixo do pool
        // para não ocupar todas as ligações e deixar pedidos concorrentes à
        // espera; 8 mantém folga e ainda paraleliza.
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
              // com identidade, para quem lê os logs/BD saber o que foi posto de lado
              console.warn(`[ceme-v2] tarifário em quarentena: ${t.id}: ${e.message}`);
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, tariffs.length) }, worker)
        );
        // Ordem de resultados independente da ordem de conclusão; a lista de
        // saída tem de continuar determinística.
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

// Fronteira de erro: o node:http ignora a promessa que o listener devolve, por
// isso uma rejeição (BD em baixo, dados inesperados) seria `unhandledRejection`
// e o Node terminava o processo — o site todo por um pedido. Responde 500.
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
