-- Schema MVP (SQLite, node:sqlite). Migravel para Postgres/D1 via Drizzle.
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS ceme (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, brand_color TEXT,
  website TEXT, email TEXT, phone TEXT, whatsapp TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tariff (
  id TEXT PRIMARY KEY, ceme_id TEXT NOT NULL REFERENCES ceme(id),
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('FIXED','INDEXED')),
  voltage TEXT NOT NULL CHECK (voltage IN ('BT','MT','BT_MT')),
  schedule TEXT NOT NULL CHECK (schedule IN ('SIMPLES','BI_HORARIA')),
  cycle TEXT NOT NULL CHECK (cycle IN ('DIARIO','SEMANAL','SIMPLES')),
  green INTEGER DEFAULT 0, access TEXT, bundle INTEGER DEFAULT 0,
  popular INTEGER DEFAULT 0, source_url TEXT,
  regions TEXT NOT NULL DEFAULT 'CONT' -- CSV: CONT,MAD,AZO onde o tarifário existe
);

CREATE TABLE IF NOT EXISTS tariff_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tariff_id TEXT NOT NULL REFERENCES tariff(id),
  valid_from TEXT NOT NULL, valid_to TEXT, campaign INTEGER DEFAULT 0,
  status TEXT DEFAULT 'DRAFT', origin TEXT,
  k_index_eur_mwh REAL, cgs_eur_mwh REAL,
  omie_aggregation TEXT DEFAULT 'SPLIT_VAZIO_FORA',
  notes TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_component (
  tariff_version_id INTEGER NOT NULL REFERENCES tariff_version(id),
  period TEXT NOT NULL CHECK (period IN ('VAZIO','FORA_VAZIO','UNICO')),
  energy_eur_kwh REAL, activation_eur REAL DEFAULT 0,
  support_eur REAL DEFAULT 0, iec_eur_kwh REAL DEFAULT 0,
  PRIMARY KEY (tariff_version_id, period)
);

CREATE TABLE IF NOT EXISTS tar (
  valid_from TEXT NOT NULL, valid_to TEXT, region TEXT NOT NULL DEFAULT 'CONT',
  voltage TEXT NOT NULL,
  period TEXT NOT NULL, price_eur_kwh REAL NOT NULL,
  PRIMARY KEY (valid_from, region, voltage, period)
);

CREATE TABLE IF NOT EXISTS omie_spot (
  ts_lisbon TEXT PRIMARY KEY, market_day TEXT, market_period INTEGER,
  price_pt_eur_mwh REAL NOT NULL, price_es_eur_mwh REAL,
  source TEXT NOT NULL, flags TEXT, ingested_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS omie_daily (
  date TEXT PRIMARY KEY, avg_pt REAL, avg_vazio_pt REAL,
  avg_fora_vazio_pt REAL, min_pt REAL, max_pt REAL, source TEXT
);

CREATE TABLE IF NOT EXISTS loss_profile (
  year INTEGER NOT NULL, ts_lisbon TEXT NOT NULL, voltage TEXT NOT NULL,
  factor REAL NOT NULL, PRIMARY KEY (year, ts_lisbon, voltage)
);

CREATE TABLE IF NOT EXISTS suggestion (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tariff_id TEXT,
  payload_json TEXT NOT NULL, status TEXT DEFAULT 'PENDING',
  submitted_by_session TEXT, reviewed_by TEXT, review_note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_client (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL, ceme_id TEXT, rate_limit INTEGER DEFAULT 60
);

CREATE TABLE IF NOT EXISTS api_key (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES api_client(id),
  hash TEXT NOT NULL, prefix TEXT NOT NULL,
  revoked_at TEXT, expires_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT (datetime('now')),
  actor TEXT, action TEXT, detail TEXT
);
