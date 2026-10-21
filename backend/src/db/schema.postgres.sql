-- Schema MVP (PostgreSQL). Migracao do schema.sql (SQLite, node:sqlite).
-- Diferenças chave:
--   - INTEGER PRIMARY KEY AUTOINCREMENT  -> SERIAL PRIMARY KEY
--   - datetime('now')                    -> now()
--   - PRAGMA journal_mode = WAL          -> removido (nao existe no Postgres)
--   - INSERT OR IGNORE                   -> INSERT ... ON CONFLICT (id) DO NOTHING (no seed)

CREATE TABLE IF NOT EXISTS ceme (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, brand_color TEXT,
  website TEXT, email TEXT, phone TEXT, whatsapp TEXT,
  created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tariff (
  id TEXT PRIMARY KEY, ceme_id TEXT NOT NULL REFERENCES ceme(id),
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('FIXED','INDEXED')),
  voltage TEXT NOT NULL CHECK (voltage IN ('BT','MT','BT_MT')),
  schedule TEXT NOT NULL CHECK (schedule IN ('SIMPLES','BI_HORARIA')),
  cycle TEXT NOT NULL CHECK (cycle IN ('DIARIO','SEMANAL','SIMPLES')),
  green INTEGER DEFAULT 0, access TEXT, bundle INTEGER DEFAULT 0,
  popular INTEGER DEFAULT 0, source_url TEXT,
  regions TEXT NOT NULL DEFAULT 'CONT' -- CSV: CONT,MAD,AZO onde o tarifario existe
);

CREATE TABLE IF NOT EXISTS tariff_version (
  id SERIAL PRIMARY KEY, tariff_id TEXT NOT NULL REFERENCES tariff(id),
  valid_from DATE NOT NULL, valid_to DATE, campaign INTEGER DEFAULT 0,
  status TEXT DEFAULT 'DRAFT', origin TEXT,
  k_index_eur_mwh REAL, cgs_eur_mwh REAL,
  omie_aggregation TEXT DEFAULT 'SPLIT_VAZIO_FORA',
  notes TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT now(),
  -- Uma versão por data de vigência: garante o alvo do
  -- `ON CONFLICT (tariff_id, valid_from)` do seed idempotente
  -- (à paridade do mesmo alvo no seed postgres).
  UNIQUE (tariff_id, valid_from)
);

CREATE TABLE IF NOT EXISTS price_component (
  tariff_version_id INTEGER NOT NULL REFERENCES tariff_version(id),
  period TEXT NOT NULL CHECK (period IN ('VAZIO','FORA_VAZIO','UNICO')),
  energy_eur_kwh REAL, activation_eur REAL DEFAULT 0,
  support_eur REAL DEFAULT 0, iec_eur_kwh REAL DEFAULT 0,
  PRIMARY KEY (tariff_version_id, period)
);

CREATE TABLE IF NOT EXISTS tar (
  valid_from DATE NOT NULL, valid_to DATE, region TEXT NOT NULL DEFAULT 'CONT',
  voltage TEXT NOT NULL, period TEXT NOT NULL, price_eur_kwh REAL NOT NULL,
  PRIMARY KEY (valid_from, region, voltage, period)
);

-- Os quartos-horários do OMIE, um por linha, indexados pelo INSTANTE (UTC).
--
-- A chave é o instante, nunca a hora local: a hora repetida da mudança de
-- hora de Outono daria duas linhas com a mesma hora de relógio, e a chave
-- tem de as distinguir. Em UTC não há duplicados — o instante é único.
--
-- `source` diz de onde veio o preço: 'OMIE_ES' (o ficheiro oficial) ou 'TF'
-- (o Tiago Felícia, que traz também a classificação do período horário).
CREATE TABLE IF NOT EXISTS omie_spot (
  ts_utc TIMESTAMPTZ NOT NULL, day_utc DATE NOT NULL, min_utc INTEGER NOT NULL,
  price_pt_eur_mwh REAL NOT NULL, price_es_eur_mwh REAL,
  bd TEXT, bs TEXT,
  source TEXT NOT NULL, flags TEXT, ingested_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ts_utc, source)
);
CREATE INDEX IF NOT EXISTS omie_spot_day ON omie_spot(day_utc);

-- Os agregados diários (as médias por ciclo horário), materializados a
-- partir das linhas de cima.
CREATE TABLE IF NOT EXISTS omie_daily (
  date DATE PRIMARY KEY, avg_pt REAL, min_pt REAL, max_pt REAL,
  bd_v REAL, bd_f REAL, bs_v REAL, bs_f REAL, quarters INTEGER, source TEXT
);

-- Estado da ingestão: quando foi o último refresh, o ETag do ficheiro
-- oficial (para o pedido condicional) e o payload das estatísticas.
CREATE TABLE IF NOT EXISTS omie_meta (
  key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loss_profile (
  year INTEGER NOT NULL, ts_lisbon TIMESTAMP NOT NULL, voltage TEXT NOT NULL,
  factor REAL NOT NULL, PRIMARY KEY (year, ts_lisbon, voltage)
);

CREATE TABLE IF NOT EXISTS suggestion (
  id SERIAL PRIMARY KEY, tariff_id TEXT,
  payload_json TEXT NOT NULL, status TEXT DEFAULT 'PENDING',
  submitted_by_session TEXT, reviewed_by TEXT, review_note TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_client (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL, ceme_id TEXT, rate_limit INTEGER DEFAULT 60
);

CREATE TABLE IF NOT EXISTS api_key (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES api_client(id),
  hash TEXT NOT NULL, prefix TEXT NOT NULL,
  revoked_at TIMESTAMP, expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY, at TIMESTAMP DEFAULT now(),
  actor TEXT, action TEXT, detail TEXT
);
