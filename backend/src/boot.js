// O arranque: prepara a BD antes de o servidor aceitar pedidos. Corre uma
// vez, a partir de server.js.
//
// A ordem importa:
//   1. o schema do dialecto em uso (seguro de repetir);
//   2. colunas novas em tabelas que já existiam (antes do seed, que as usa;
//      vê db/migrate.js);
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
import { readFile } from 'node:fs/promises';
import { query, run, exec, READONLY, USE_PG } from './db.js';
import { hashKey } from './auth/tokens.js';
import { rebuildDerived } from './omie/pipeline.js';
import { migrateAddedColumns } from './db/migrate.js';
import { syncTar } from './db/tar.js';
import { seed } from './db/seed.js';

const log = (...a) => console.warn('[ceme-v2]', ...a);

export async function boot() {
  const skipSeed = READONLY || process.env.CEME_SKIP_SEED === '1';
  if (READONLY) log('modo READONLY: bootstrap de escrita desactivado.');

  if (!READONLY) {
    const schemaFile = new URL(USE_PG ? './db/schema.postgres.sql' : './db/schema.sql', import.meta.url);
    await exec(await readFile(schemaFile, 'utf8'));
    for (const n of await migrateAddedColumns()) log(`migração: ${n}`);
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
async function syncEnvApiKey() {
  const key = process.env.CEME_API_KEY;
  if (!key) {
    await run(`UPDATE api_key SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'env-key' AND revoked_at IS NULL`);
    return;
  }
  await run(`INSERT INTO api_client (id, name, kind) VALUES ('env-key', 'chave da env', 'THIRD_PARTY')
    ON CONFLICT (id) DO NOTHING`);
  await run(`INSERT INTO api_key (id, client_id, hash, prefix) VALUES ('env-key', 'env-key', $1, $2)
    ON CONFLICT (id) DO UPDATE SET hash = $1, prefix = $2, revoked_at = NULL`,
    [hashKey(key), key.slice(0, 8)]);
}
