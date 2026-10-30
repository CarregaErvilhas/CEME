// Gerir as API keys de terceiros sem escrever SQL à mão.
//
//   node backend/tools/api-key.mjs list
//   node backend/tools/api-key.mjs create <cliente> [--limit 60] [--name "Nome"]
//   node backend/tools/api-key.mjs rotate <cliente>
//   node backend/tools/api-key.mjs revoke <cliente|id-da-chave>
//   node backend/tools/api-key.mjs limit <cliente> <pedidos-por-minuto>
//
// Liga à BD pela DATABASE_APP_URL ou DATABASE_URL (a de produção só chega
// pela VPN do Zerops; infra.md). Sem nenhuma recusa-se a correr, em vez de
// cair no SQLite local e criar uma chave que o servidor nunca vê; --local
// força o SQLite (dev).
//
// create e rotate copiam a chave nova para o clipboard (pbcopy) e mostram só
// o prefixo; sem pbcopy, ou com --print, escrevem-na no stdout. Depois
// testam-na contra <--base>/v1/health (por defeito o site de produção;
// --no-check salta o teste). A lógica está em src/auth/apikeys.js.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { runtimeUrl } from '../src/db/url.js';

const { values: opt, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: 'string', default: '60' },
    name: { type: 'string' },
    base: { type: 'string', default: 'https://ceme.ocarroeletrico.com' },
    print: { type: 'boolean', default: false },
    'no-check': { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
  },
});

const USAGE = 'uso: api-key.mjs list | create <cliente> [--limit N] [--name X] | rotate <cliente> | revoke <cliente|id> | limit <cliente> <N>';
const die = (msg) => { console.error(msg); process.exit(1); };

if (!cmd) die(USAGE);
if (!runtimeUrl(process.env) && !opt.local) {
  die('sem DATABASE_APP_URL nem DATABASE_URL: isto ia escrever no SQLite local. Exporta a URL da BD (ou usa --local).');
}

// Só agora: importar db.js abre a ligação.
const db = await import('../src/db.js');
const keys = await import('../src/auth/apikeys.js');

// Entrega a chave: clipboard se der, stdout se não.
function deliver({ id, key, prefix }) {
  const copied = !opt.print && spawnSync('pbcopy', { input: key }).status === 0;
  if (copied) console.log(`chave ${id} (prefixo ${prefix}) copiada para o clipboard. Guarda-a já: na BD só fica o hash.`);
  else console.log(`chave ${id}: ${key}\nGuarda-a já: na BD só fica o hash.`);
}

async function check(key) {
  if (opt['no-check']) return;
  const url = `${opt.base.replace(/\/$/, '')}/v1/health`;
  try {
    const r = await fetch(url, { headers: { 'X-API-Key': key } });
    const body = r.ok ? '' : ` ${(await r.text()).slice(0, 200)}`;
    console.log(`teste ${url}: ${r.status}, limite ${r.headers.get('x-ratelimit-limit') ?? '?'}/min${body}`);
    if (!r.ok) process.exitCode = 2;
  } catch (e) {
    console.log(`teste ${url} falhou: ${e.message}`);
    process.exitCode = 2;
  }
}

try {
  switch (cmd) {
    case 'list': {
      const rows = await keys.list(db);
      console.table(rows.map(r => ({ ...r, revoked_at: r.revoked_at ?? '', expires_at: r.expires_at ?? '' })));
      break;
    }
    case 'create': {
      if (!args[0]) die(USAGE);
      const k = await keys.createClient(db, args[0], { limit: opt.limit, name: opt.name });
      deliver(k);
      await check(k.key);
      break;
    }
    case 'rotate': {
      if (!args[0]) die(USAGE);
      const k = await keys.rotateKey(db, args[0]);
      deliver(k);
      await check(k.key);
      console.log(`as chaves antigas de ${args[0]} continuam activas; revoga-as quando o cliente tiver trocado.`);
      break;
    }
    case 'revoke': {
      if (!args[0]) die(USAGE);
      const n = await keys.revoke(db, args[0]);
      console.log(n ? `${n} chave(s) revogada(s).` : `nada a revogar em ${args[0]}.`);
      break;
    }
    case 'limit': {
      if (!args[0] || !args[1]) die(USAGE);
      const n = await keys.setLimit(db, args[0], args[1]);
      console.log(`${args[0]}: ${n} pedidos/min (vale já, sem reiniciar).`);
      break;
    }
    default:
      die(USAGE);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
