# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CEME v2: a simulator for the **energy part** of an EV charge on the Portuguese Mobi.E network (CEME tariff incl. TAR + IEC + VAT + EGME; the charge point's OPC fee is out of scope). Code, comments, docs and commit messages are in **European Portuguese**, with pre-reform spelling ("actual", "activação") — match it.

## Commands

All from `backend/` (Node 24, no build step; the only dependency is `pg`):

```sh
npm ci
npm test                                   # node --test test/*.test.js
node --test test/golden.test.js            # one file
node --test --test-name-pattern="ROUNDUP" test/golden.test.js   # one test
npm start                                  # http://localhost:3001/  (npm run dev = --watch)
node tools/cores.mjs                       # colour-palette measurement for the OMIE page
node tools/api-key.mjs list                # third-party API keys (needs DATABASE_APP_URL or DATABASE_URL; docs/04)
```

There's no linter or formatter config. Without `DATABASE_URL` the DB is SQLite (`backend/data/ceme.db`, gitignored; `rm -rf backend/data` + restart rebuilds it from the seed). `omie-tz.test.js` fetches the real TF file (or uses `backend/data/` cache) and skips if offline.

## Architecture

- **One process serves everything**: `backend/src/server.js` (plain `node:http`) runs `boot.js`, then routes health → `http/pages.js` (HTML pages and static JS/CSS/PWA files from a `STATIC` map) → `http/api.js` (`ROUTES` map; all `/v1/*` need a Bearer JWT from `POST /v1/session` or an `X-API-Key`, see `http/auth.js`). Unknown paths fall into auth → 401. HTML pages get the negotiated language injected by replacing the `window.__LANG__=null` marker, and their text pre-rendered by running the page's own script in a fake `document` (`http/prerender.js`; elements it fills need an `id` and must be empty in the file). They also get the security headers in `PAGE_SECURITY` (`http/pages.js`): the CSP only allows same-origin scripts and styles, so a CDN needs an entry there (`server.test.js` checks).
- **Two DB dialects, one SQL style** (`backend/src/db.js`): Postgres in prod when `DATABASE_URL` is set, `node:sqlite` otherwise (`db/sqlite.js`, also used by tests via `test/seeded-db.js`). Write `$1…` placeholders (translated to `?` for SQLite by occurrence) and `ON CONFLICT … DO UPDATE … EXCLUDED`. Writes go through `run()`, multi-statement SQL through `exec()`. Every schema change goes to **both** `db/schema.sql` and `db/schema.postgres.sql`; column additions to existing tables also go to `ADDED_COLUMNS` in `db/migrate.js`. Seed data lives only in `db/seed-data.js` (tariffs as named objects); `db/seed.js` writes it with the same SQL for both dialects, as convergent upserts on every boot. TAR lives in `db/tar.js` (one entry per `valid_from`, upserted on boot).
- **Boot order** (`boot.js`): schema → `migrateAddedColumns` → env API key sync → `syncTar` → seed → `rebuildDerived`. In prod the first two run outside the process (`db/migrate-cli.js`, owner role) and boot only verifies them (`CEME_SCHEMA_EXTERNAL=1`); the API role has DML only, so a new table must also go in `db/grants.postgres.sql` (`infra.md`).
- **Pricing** (`backend/src/tariffs.js`): `loadPricing(region)` loads versions, prices, brand colours and TAR in a few queries per request; `quoteOne` is synchronous on top of it. Don't add per-tariff queries.
- **Engine** (`backend/src/engine/`): pure functions. `quoteFixed` (fixed tariffs: final price already includes TAR; ROUNDUP per component, returns `parts` that sum to the total), `indexedPrice` (OMIE-indexed; two formulas selected by `VERSIONS[id].formula`), `periodForRegion` (vazio/fora by region timezone and cycle), `compareWithFixed`.
- **OMIE pipeline** (`backend/src/omie/`): omie.es (primary price, conditional GET) + Tiago Felícia files (period classification, gaps, FPB D futures), reconciled **by UTC instant** in `omie_spot`. No cron by decision — any OMIE read calls `ensureFresh`, which refreshes in the background under a DB lock in `omie_meta`. `stats.js` builds the `/omie` page payload (stored in `omie_meta`).
- **Frontend** (`frontend/`): vanilla HTML/JS, no build. `index.html` (full simulator) and `assistente.html` (wizard) share `strings.js` (all PT/EN text, namespaced per page; `strings.test.js` checks key/placeholder parity and dead keys) and `tz.js` (region wall-clock ↔ instant); every page that calls the API does it through `api.js` (web session shared in the tab, one retry on 401, server message on errors). Smoke tests evaluate the pages' last `<script>` in a `vm` context — new shared scripts must also be loaded there.

## Time is the main bug source

- Keys are UTC instants (`ts_utc`). `day_lisbon`/`min_lisbon` are Lisbon civil day/minutes. The OMIE *market* day is Madrid's (starts 23:00 Lisbon the day before) — tomorrow's Lisbon day has only 92 quarters until the next market day is published (`complete` in `/v1/omie/daily`).
- Shared date code is in `backend/src/time.js` (`zonedParts` with cached `Intl` formatters, `euDstDays`/`euDstRange`, day numbers, `dmyToIso`); reuse it instead of new `Intl.DateTimeFormat`/`Date.UTC` helpers.
- "Today" = `civilDay()` (`omie/convert.js`), never `CURRENT_DATE` or `toISOString().slice(0,10)`. Tariff versions and TAR are picked by the charge's civil day in the region's timezone.
- Period rules and user-entered times use the **region's** timezone (`REGIONS[region].tz`), never the browser's.
- DST: EU switch at 01:00 UTC; in Lisbon 01:00–02:00 is skipped in March and repeated in October (92/100-quarter days). Distinguish repeated hours by instant, not `HH:MM` labels. Test DST edges when touching time code (`tz.test.js`, `omie-ingest.test.js`, `omie-stats.test.js`).

## Conventions

- Docs must not rot: don't copy prices, counts, test totals or golden values into docs/README — point to the file or test that owns them (`golden.test.js`, `TARIFFS`/`VERSIONS` in `seed-data.js`, `TAR` in `db/tar.js`).
- Docs and comments describe what the service does now and what is planned; no history ("used to", "the old bug", dated decisions). History lives in git. Docs are written casually, in the second person ("tu"), for a newcomer with basic programming knowledge.
- Golden anchors in `golden.test.js` change only when a published price changes, and are re-frozen by running the engine, never by hand.
- Tariff verification against CEME websites: follow `.opencode/commands/ceme-check.md` and the cookbook `.memories/ceme-tarifas-verificacao.md` (values change only with explicit approval; backup DB first).
- `CEME_READONLY=1` must never write (guarded in `db.js` `run()`/`exec()`); `CEME_SKIP_SEED=1` skips the seed (previews: `docs/preview-envs.md`).
- Deploy is the Zerops webhook on push to `main` (no Zerops credential in GitHub); CI only runs `npm test` (`.github/workflows/ci.yml`). Infra is documented only in `infra.md`.
- Third-party data (ERSE sheet dumps, OMIE files) never goes into the repo; `backend/seed/` and `backend/data/` are gitignored.

Deeper references: `docs/00` (glossary of EV/energy terms, start here if the domain is new), `docs/02` (engine), `docs/03` (OMIE ingestion), `docs/04` (API/auth), `docs/06` (roadmap — only open work), `docs/07` (islands), `docs/08` (SQLite/Postgres), `docs/09` (OMIE stats page).
