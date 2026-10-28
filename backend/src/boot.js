// O arranque: prepara a BD antes de o servidor aceitar pedidos. Corre uma
// vez, a partir de server.js.
//
// A ordem importa:
//   1. o schema do dialecto em uso (seguro de repetir);
//   2. colunas novas em tabelas que já existiam (antes do seed, que as usa;
//      vê db/migrate.js). Com CEME_SCHEMA_EXTERNAL=1, 1 e 2 não correm aqui:
//      só se confirma que estão feitos;
//   3. a chave da API de terceiros (CEME_API_KEY);
//   4. a TAR (db/tar.js);
//   5. o seed (CEMEs, tarifários, preços);
//   6. os resumos do OMIE, recalculados a partir do que já está na BD.
//
// Variáveis de ambiente opcionais (úteis em previews, docs/preview-envs.md):
//   CEME_READONLY=1  não escreve nada na BD: salta tudo isto menos a leitura,
//                    o OMIE não actualiza, e db.js recusa qualquer escrita.
//                    Para ligares a uma BD que não é tua.
//   CEME_SKIP_SEED=1 corre tudo menos o seed, para não pisar dados copiados
//                    de outro ambiente.
import { query, run, READONLY, USE_PG } from './db.js';
import { hashKey } from './auth/tokens.js';
import { RATE_DEFAULT } from './http/ratelimit.js';
import { rebuildDerived } from './omie/pipeline.js';
import { applySchema, schemaProblems } from './db/migrate.js';
import { syncTar } from './db/tar.js';
import { seed } from './db/seed.js';

// CEME_SCHEMA_EXTERNAL=1: o schema e as migrações correm fora do processo, com
// outra role (db/migrate-cli.js); o arranque só confirma que estão feitos e
// fala com a BD sem DDL. Vê infra.md, «Privilégios da base de dados».
const SCHEMA_EXTERNAL = process.env.CEME_SCHEMA_EXTERNAL === '1';

const log = (...a) => console.warn('[ceme-v2]', ...a);

export async function boot() {
  const skipSeed = READONLY || process.env.CEME_SKIP_SEED === '1';
  if (READONLY) log('modo READONLY: bootstrap de escrita desactivado.');

  if (!READONLY) {
    if (SCHEMA_EXTERNAL) {
      // Sem URL cairia num SQLite vazio e "passava" a verificação à mesma.
      if (!USE_PG) throw new Error('CEME_SCHEMA_EXTERNAL=1 pede PostgreSQL (DATABASE_APP_URL/DATABASE_URL em falta)');
      const em_falta = await schemaProblems();
      if (em_falta.length) {
        throw new Error(`schema em falta (${em_falta.join(', ')}): corre db/migrate-cli.js com a role dona (infra.md)`);
      }
    } else {
      for (const n of await applySchema()) log(`migração: ${n}`);
    }
    await syncEnvApiKey();
    await syncTar();
  }

  if (!skipSeed) {
    await seed({ query, run });
  } else {
    log('seed saltado (CEME_SKIP_SEED/CEME_READONLY).');
  }

  if (!READONLY) {
    try { await rebuildDerived(); console.log('[ceme-v2] derivados recalculados no arranque'); }
    catch (e) { log('rebuildDerived falhou:', e.message); }
  }
}

// A API key de terceiros vem da variável CEME_API_KEY; na BD fica só o hash
// (linha 'env-key'). A variável manda:
//   - definida: grava o hash e reactiva a chave (trocar o valor invalida a
//     antiga);
//   - ausente: revoga a chave que estiver na BD.
// CEME_API_KEY_RATE_LIMIT (pedidos por minuto) manda no limite dessa chave;
// sem ela, fica o RATE_DEFAULT.
async function syncEnvApiKey() {
  const key = process.env.CEME_API_KEY;
  if (!key) {
    await run(`UPDATE api_key SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'env-key' AND revoked_at IS NULL`);
    return;
  }
  const raw = process.env.CEME_API_KEY_RATE_LIMIT;
  let limit = RATE_DEFAULT;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) limit = n;
    else log(`CEME_API_KEY_RATE_LIMIT inválido (${raw}); a usar ${RATE_DEFAULT}/min`);
  }
  await run(`INSERT INTO api_client (id, name, kind, rate_limit) VALUES ('env-key', 'chave da env', 'THIRD_PARTY', $1)
    ON CONFLICT (id) DO UPDATE SET rate_limit = $1`, [limit]);
  await run(`INSERT INTO api_key (id, client_id, hash, prefix) VALUES ('env-key', 'env-key', $1, $2)
    ON CONFLICT (id) DO UPDATE SET hash = $1, prefix = $2, revoked_at = NULL`,
    [hashKey(key), key.slice(0, 8)]);
}
