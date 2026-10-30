-- Schema da BD em SQLite (dev e testes). A versão para produção é
-- schema.postgres.sql: as duas têm de ter sempre as mesmas tabelas e
-- colunas. Corre em cada arranque; `IF NOT EXISTS` torna-o seguro de repetir.
-- Para colunas novas em tabelas que já existem, vê db/migrate.js.

PRAGMA journal_mode = WAL;

-- Os comercializadores (CEME = Comercializador de Electricidade para a
-- Mobilidade Eléctrica): as empresas que te vendem a energia quando
-- carregas o carro num posto público, através do cartão ou da app delas.
CREATE TABLE IF NOT EXISTS ceme (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, brand_color TEXT,
  website TEXT, email TEXT, phone TEXT, whatsapp TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
);

-- Contactos internos de cada CEME. Sem seed: os dados ficam só na BD.
-- A API não lê esta tabela (ver CEME_PUBLIC_COLS em http/api.js).
CREATE TABLE IF NOT EXISTS ceme_contact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ceme_id TEXT NOT NULL REFERENCES ceme(id),
  name TEXT, role TEXT, email TEXT, phone TEXT, whatsapp TEXT, notes TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
);

-- Os tarifários de cada CEME.
--   kind:     FIXED (preço fixo) ou INDEXED (segue o preço do OMIE);
--   voltage:  BT (baixa tensão), MT (média tensão) ou BT_MT (os dois);
--   schedule: SIMPLES (um preço) ou BI_HORARIA (vazio / fora de vazio);
--   cycle:    DIARIO, SEMANAL ou SIMPLES (que horas são vazio, ver regions.js);
--   green, bundle, popular: etiquetas para os filtros (energia verde, preço
--             com condições, mais usado);
--   regions:  lista separada por vírgulas (CONT,MAD,AZO) onde o tarifário é
--             vendido. É só informação: o simulador cota-o em qualquer região.
--   legacy_id: o número do tarifário na folha de cálculo original (vê
--             LEGACY_IDS em db/seed-data.js); NULL se não tiver.
--   new_customers: 1 se só o pode ter quem adere ao CEME (um cliente que
--             já o era não pode).
--   audience: quem o pode ter, quando não é qualquer pessoa (vê
--             `audience` em TARIFFS); NULL = qualquer pessoa.
CREATE TABLE IF NOT EXISTS tariff (
  id TEXT PRIMARY KEY, ceme_id TEXT NOT NULL REFERENCES ceme(id),
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('FIXED','INDEXED')),
  voltage TEXT NOT NULL CHECK (voltage IN ('BT','MT','BT_MT')),
  schedule TEXT NOT NULL CHECK (schedule IN ('SIMPLES','BI_HORARIA')),
  cycle TEXT NOT NULL CHECK (cycle IN ('DIARIO','SEMANAL','SIMPLES')),
  green INTEGER DEFAULT 0, access TEXT, bundle INTEGER DEFAULT 0,
  popular INTEGER DEFAULT 0, source_url TEXT,
  regions TEXT NOT NULL DEFAULT 'CONT',
  legacy_id INTEGER,
  new_customers INTEGER DEFAULT 0,
  audience TEXT
);

-- Versões de um tarifário no tempo. A versão em vigor num dia é a que tem
-- valid_from <= dia e (valid_to vazio ou dia < valid_to). Uma campanha
-- (campaign = 1) é uma versão com fim marcado.
--   k_index_eur_mwh, cgs_eur_mwh: as margens dos indexados (vê
--     engine/indexed.js). Atenção: apesar do nome, os valores estão em €/kWh.
--   omie_aggregation: SPLIT_VAZIO_FORA (média do OMIE por período) ou UNICA.
--   notes: um código (ex.: AC_DC_FLAT) que o frontend traduz.
-- A chave única (tariff_id, valid_from) é o alvo do upsert do seed.
CREATE TABLE IF NOT EXISTS tariff_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tariff_id TEXT NOT NULL REFERENCES tariff(id),
  valid_from TEXT NOT NULL, valid_to TEXT, campaign INTEGER DEFAULT 0,
  status TEXT DEFAULT 'DRAFT', origin TEXT,
  k_index_eur_mwh REAL, cgs_eur_mwh REAL,
  omie_aggregation TEXT DEFAULT 'SPLIT_VAZIO_FORA',
  notes TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (tariff_id, valid_from)
);

-- Os preços de cada versão, uma linha por período (VAZIO, FORA_VAZIO ou
-- UNICO). Estes são os preços do Continente, e valem em qualquer região
-- que não tenha linha própria em `price_component_region`.
--   energy_eur_kwh: o €/kWh FINAL que o CEME publica, já com a TAR.
--   energy_only_eur_kwh + tar_eur_kwh: o mesmo preço partido em energia e
--     TAR, só quando o CEME publica a separação (senão ficam NULL).
--   activation_eur: taxa por carregamento; support_eur: apoio por
--     carregamento; iec_eur_kwh: imposto especial sobre a electricidade.
CREATE TABLE IF NOT EXISTS price_component (
  tariff_version_id INTEGER NOT NULL REFERENCES tariff_version(id),
  period TEXT NOT NULL CHECK (period IN ('VAZIO','FORA_VAZIO','UNICO')),
  energy_eur_kwh REAL, activation_eur REAL DEFAULT 0,
  support_eur REAL DEFAULT 0, iec_eur_kwh REAL DEFAULT 0,
  energy_only_eur_kwh REAL, tar_eur_kwh REAL,
  PRIMARY KEY (tariff_version_id, period)
);

-- Preços próprios das ilhas (MAD, AZO), para quando o CEME cobra diferente
-- lá. Mesmas colunas que `price_component`; uma linha aqui substitui a do
-- Continente para essa região e período.
CREATE TABLE IF NOT EXISTS price_component_region (
  tariff_version_id INTEGER NOT NULL REFERENCES tariff_version(id),
  region TEXT NOT NULL CHECK (region IN ('MAD','AZO')),
  period TEXT NOT NULL CHECK (period IN ('VAZIO','FORA_VAZIO','UNICO')),
  energy_eur_kwh REAL, activation_eur REAL DEFAULT 0,
  support_eur REAL DEFAULT 0, iec_eur_kwh REAL DEFAULT 0,
  energy_only_eur_kwh REAL, tar_eur_kwh REAL,
  PRIMARY KEY (tariff_version_id, region, period)
);

-- Promoções de um CEME, quase sempre numa rede de postos (ex.: a Luzigás dá
-- −0,12 €/kWh na energia nos postos Powerdot; a miio one dá −45 % na taxa do
-- OPC nos mesmos postos). O simulador não sabe em que posto carregas, por
-- isso devolve as promoções de cada tarifário e quem sabe o posto (o ohmigo)
-- escolhe as da rede certa. Vê PROMOS em db/seed-data.js.
--   tariff_ids: lista separada por vírgulas; NULL = todos os do CEME;
--   network:    o nome da rede (Powerdot, EDP…), não um id do NAP; NULL =
--               qualquer posto MOBI.E;
--   target:     ENERGIA: eur_kwh a menos no preço final do CEME (energia +
--                 TAR), antes de IEC, EGME e IVA;
--               OPC: pct a menos na taxa do operador do posto (que o
--                 simulador não cota);
--               FINAL: o carregamento todo (CEME, OPC, taxas e IVA) a
--                 eur_kwh por kWh;
--               KWH_GRATIS: os primeiros free_kwh de cada mês civil sem
--                 energia nem TAR a pagar;
--   starts_on, ends_on: o primeiro e o último dia, inclusive;
--   new_customers: só para quem adere durante a promoção; max_hours: quanto
--               tempo dura o desconto depois da adesão, se tiver limite;
--   regions:    onde vale (CONT,MAD,AZO).
CREATE TABLE IF NOT EXISTS promo (
  id TEXT PRIMARY KEY, ceme_id TEXT NOT NULL REFERENCES ceme(id),
  name TEXT NOT NULL, tariff_ids TEXT, network TEXT,
  target TEXT NOT NULL CHECK (target IN ('ENERGIA','OPC','FINAL','KWH_GRATIS')),
  eur_kwh REAL, pct REAL, free_kwh REAL,
  starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
  new_customers INTEGER DEFAULT 0, max_hours INTEGER,
  regions TEXT NOT NULL DEFAULT 'CONT',
  source_url TEXT NOT NULL, checked_on TEXT NOT NULL,
  CHECK ((target IN ('ENERGIA','FINAL') AND eur_kwh > 0 AND pct IS NULL AND free_kwh IS NULL)
      OR (target = 'OPC' AND pct > 0 AND pct <= 100 AND eur_kwh IS NULL AND free_kwh IS NULL)
      OR (target = 'KWH_GRATIS' AND free_kwh > 0 AND eur_kwh IS NULL AND pct IS NULL))
);

-- TAR (Tarifas de Acesso às Redes): o que se paga pelo uso da rede eléctrica,
-- fixado todos os anos pela ERSE (o regulador). €/kWh por região, tensão e
-- período, com validade.
CREATE TABLE IF NOT EXISTS tar (
  valid_from TEXT NOT NULL, valid_to TEXT, region TEXT NOT NULL DEFAULT 'CONT',
  voltage TEXT NOT NULL,
  period TEXT NOT NULL, price_eur_kwh REAL NOT NULL,
  PRIMARY KEY (valid_from, region, voltage, period)
);

-- Os preços do OMIE, um por quarto de hora (96 por dia; 92 ou 100 nos dias
-- de mudança de hora). O OMIE é o mercado grossista ibérico de electricidade.
--
-- A chave é o INSTANTE em UTC (ts_utc), nunca a hora local: no dia em que a
-- hora atrasa, a 01:00–02:00 de Lisboa acontece duas vezes, e só o instante
-- as distingue.
--   day_lisbon, min_lisbon: o dia e os minutos desde a meia-noite em Lisboa,
--     para agrupar por dia e mostrar horas;
--   price_pt_eur_mwh / price_es_eur_mwh: preço em Portugal / Espanha (€/MWh);
--   bd, bs: período (V = vazio, F = fora de vazio) no ciclo diário e semanal;
--   source: 'OMIE_ES' (ficheiro oficial) ou 'TF' (dados.tiagofelicia.pt).
--     As duas fontes podem ter o mesmo instante; ao ler, ganha a oficial;
--   flags: avisos de validação (ex.: preço fora da gama esperada).
CREATE TABLE IF NOT EXISTS omie_spot (
  ts_utc TEXT NOT NULL, day_lisbon TEXT NOT NULL, min_lisbon INTEGER NOT NULL,
  price_pt_eur_mwh REAL NOT NULL, price_es_eur_mwh REAL,
  bd TEXT, bs TEXT,
  source TEXT NOT NULL, flags TEXT, ingested_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (ts_utc, source)
);
CREATE INDEX IF NOT EXISTS omie_spot_day ON omie_spot(day_lisbon);

-- Resumo diário calculado a partir de omie_spot: média, mínimo e máximo, e
-- as médias de vazio (v) e fora de vazio (f) nos ciclos diário (bd) e
-- semanal (bs). É o que GET /v1/omie/daily devolve.
CREATE TABLE IF NOT EXISTS omie_daily (
  date TEXT PRIMARY KEY, avg_pt REAL, min_pt REAL, max_pt REAL,
  bd_v REAL, bd_f REAL, bs_v REAL, bs_f REAL, quarters INTEGER, source TEXT
);

-- Pares chave/valor com o estado da ingestão do OMIE: quando foi a última
-- actualização, o ETag do ficheiro oficial (para não o voltar a descarregar
-- se não mudou), as estatísticas já calculadas e o lock entre réplicas.
CREATE TABLE IF NOT EXISTS omie_meta (
  key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
);

-- Por usar (vê docs/06): sugestões de correcção enviadas pela comunidade.
CREATE TABLE IF NOT EXISTS suggestion (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tariff_id TEXT,
  payload_json TEXT NOT NULL, status TEXT DEFAULT 'PENDING',
  submitted_by_session TEXT, reviewed_by TEXT, review_note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Clientes da API (apps de terceiros). rate_limit = pedidos por minuto.
CREATE TABLE IF NOT EXISTS api_client (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL, ceme_id TEXT, rate_limit INTEGER DEFAULT 60
);

-- As API keys de cada cliente. Só o hash sha256 da chave fica guardado.
CREATE TABLE IF NOT EXISTS api_key (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES api_client(id),
  hash TEXT NOT NULL, prefix TEXT NOT NULL,
  revoked_at TEXT, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_key_hash ON api_key(hash);

-- Por usar (vê docs/06): registo de alterações.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT (datetime('now')),
  actor TEXT, action TEXT, detail TEXT
);
