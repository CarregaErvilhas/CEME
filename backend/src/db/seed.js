// Grava os dados de arranque (seed-data.js) na BD: CEME, tarifários, versões
// e preços.
//
// Corre em cada arranque do servidor e é CONVERGENTE: insere o que falta e
// actualiza o que mudou (upsert com ON CONFLICT … DO UPDATE). Correr duas
// vezes dá o mesmo resultado que correr uma.
//
// O mesmo código serve SQLite e PostgreSQL: recebe `db` com as funções
// `query` e `run` de db.js (ou de sqliteApi(), nos testes) e escreve SQL que
// os dois percebem.
import {
  CEMES, TARIFFS, SPLITS, REGION_SPLITS, regionFinal, NOTES, VERSIONS,
  CAMPAIGN_END, PRICES_VERIFIED_ON, IEC, PROMOS, LEGACY_IDS,
} from './seed-data.js';
import { shiftDays } from '../time.js';

// As colunas de preço, iguais em price_component e price_component_region.
const PRICE_COLS = ['energy_eur_kwh', 'activation_eur', 'support_eur', 'iec_eur_kwh', 'energy_only_eur_kwh', 'tar_eur_kwh'];
const updateAll = (cols) => cols.map(c => `${c} = EXCLUDED.${c}`).join(', ');

export async function seed(db) {
  for (const c of CEMES) {
    await db.run(`INSERT INTO ceme (id, name, brand_color, website) VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET ${updateAll(['name', 'brand_color', 'website'])}`,
      [c.id, c.name, c.brand, c.website]);
  }

  // Sem `url` próprio, o tarifário aponta para o website do CEME.
  const websites = Object.fromEntries(CEMES.map(c => [c.id, c.website]));
  for (const t of TARIFFS) {
    const name = t.name + (t.est && t.kind === 'FIXED' ? ' ~' : '');
    await db.run(`INSERT INTO tariff
      (id, ceme_id, name, kind, voltage, schedule, cycle, green, access, popular, bundle, regions, source_url, legacy_id, new_customers)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (id) DO UPDATE SET ${updateAll(['ceme_id', 'name', 'kind', 'voltage', 'schedule', 'cycle', 'green', 'access', 'popular', 'bundle', 'regions', 'source_url', 'legacy_id', 'new_customers'])}`,
      [t.id, t.ceme, name, t.kind, t.voltage, t.schedule, t.cycle, t.green ? 1 : 0, t.access, t.popular ? 1 : 0, t.bundle ? 1 : 0, t.regions ?? 'CONT', t.url ?? websites[t.ceme], LEGACY_IDS[t.id] ?? null, t.newCustomers ? 1 : 0]);

    // Uma versão por tarifário, a começar em PRICES_VERIFIED_ON. `valid_to`
    // não entra no UPDATE: se alguém fechou uma versão à mão, o seed não a
    // reabre. Uma campanha (`from`/`to`, inclusive) começa no seu `from` e
    // fecha no dia a seguir ao `to`, porque `valid_to` é exclusivo. `omie_aggregation` é SPLIT_VAZIO_FORA em todos, porque os
    // indexados do seed são todos bi-horários (vê docs/02).
    const v = VERSIONS[t.id] || {};
    const from = t.from ?? PRICES_VERIFIED_ON;
    await db.run(`INSERT INTO tariff_version
      (tariff_id, valid_from, valid_to, campaign, status, origin, k_index_eur_mwh, cgs_eur_mwh, omie_aggregation, notes)
      VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, 'SPLIT_VAZIO_FORA', $8)
      ON CONFLICT (tariff_id, valid_from) DO UPDATE SET ${updateAll(['status', 'origin', 'k_index_eur_mwh', 'cgs_eur_mwh', 'omie_aggregation', 'notes'])}`,
      [t.id, from, t.to ? shiftDays(t.to, 1) : null, t.to ? 1 : 0, `SEED_${PRICES_VERIFIED_ON}`, v.k ?? null, v.cgs ?? null, NOTES[t.id] ?? null]);
    const [{ id: vid }] = await db.query('SELECT id FROM tariff_version WHERE tariff_id = $1 AND valid_from = $2', [t.id, from]);

    // Os preços do Continente, um por período. A activação, o apoio e o IEC
    // são do tarifário e repetem-se em cada linha (vê db/components.js). Nos
    // indexados o €/kWh calcula-se na hora, por isso há só uma linha VAZIO
    // sem preço, para guardar esses três.
    const fees = [t.act, t.support ?? 0, t.iec ?? IEC];
    const split = SPLITS[t.id] || {};
    const periods = t.prices ? Object.entries(t.prices) : [['VAZIO', null]];
    for (const [period, price] of periods) {
      const sp = split[period];
      await db.run(`INSERT INTO price_component (tariff_version_id, period, ${PRICE_COLS.join(', ')})
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (tariff_version_id, period) DO UPDATE SET ${updateAll(PRICE_COLS)}`,
        [vid, period, price, ...fees, sp?.energy ?? null, sp?.tar ?? null]);
    }

    // Preços próprios das ilhas (só onde há REGION_SPLITS), com a mesma
    // activação, apoio e IEC do Continente.
    for (const [region, perSplit] of Object.entries(REGION_SPLITS[t.id] || {})) {
      for (const [period, s] of Object.entries(perSplit)) {
        await db.run(`INSERT INTO price_component_region (tariff_version_id, region, period, ${PRICE_COLS.join(', ')})
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (tariff_version_id, region, period) DO UPDATE SET ${updateAll(PRICE_COLS)}`,
          [vid, region, period, regionFinal(s.energy, s.tar), ...fees, s.energy, s.tar]);
      }
    }
  }

  // As promoções (vê PROMOS). Só upserts: uma promoção que acabou fica na
  // BD, e o `ends_on` tira-a do simulador.
  const PROMO_COLS = ['ceme_id', 'name', 'tariff_ids', 'network', 'target', 'eur_kwh', 'pct', 'free_kwh', 'starts_on', 'ends_on', 'new_customers', 'max_hours', 'regions', 'source_url', 'checked_on'];
  for (const p of PROMOS) {
    await db.run(`INSERT INTO promo (id, ${PROMO_COLS.join(', ')})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (id) DO UPDATE SET ${updateAll(PROMO_COLS)}`,
      [p.id, p.ceme, p.name, p.tariffs?.join(',') ?? null, p.network ?? null, p.target, p.eurKwh ?? null, p.pct ?? null, p.freeKwh ?? null,
        p.from, p.to, p.newCustomers ? 1 : 0, p.maxHours ?? null, p.regions ?? 'CONT', p.url, p.checked]);
  }

  // Campanhas que acabaram. Corre depois do upsert, por isso voltar a correr
  // o seed nunca reabre uma campanha fechada.
  for (const [id, end] of Object.entries(CAMPAIGN_END)) {
    await db.run(`UPDATE tariff_version SET valid_to = $1, campaign = 1, status = 'EXPIRED' WHERE tariff_id = $2`, [end, id]);
  }
}

// `node src/db/seed.js` corre o schema e o seed à mão contra a BD de db.js
// (SQLite em ./data/ceme.db ou DB_PATH; PostgreSQL se houver DATABASE_URL).
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const { readFile } = await import('node:fs/promises');
  const db = await import('../db.js');
  await db.exec(await readFile(new URL(db.USE_PG ? './schema.postgres.sql' : './schema.sql', import.meta.url), 'utf8'));
  const { migrateAddedColumns } = await import('./migrate.js');
  for (const n of await migrateAddedColumns()) console.warn(`migração: ${n}`);
  await seed(db);
  const count = async (table) => (await db.get(`SELECT COUNT(*) AS c FROM ${table}`)).c;
  console.log('seed ok:', await count('tariff'), 'tarifários,', await count('ceme'), 'CEME');
  await db.close();
}
