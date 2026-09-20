-- Clone Studio 数据库 schema
-- 单机单用户 SQLite。元数据在这里，媒体与 Hypit 工程文件在数据根目录，库里只存路径（Spec 6.3）。
-- 时间戳统一存 ISO 8601 UTC 字符串，金额统一存美元浮点。

-- ── 单例配置（REQ-008）。凭据不在这里，在 secrets.json。 ──────────────────
CREATE TABLE IF NOT EXISTS settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  hypit_root              TEXT,
  data_root               TEXT,
  per_item_limit_usd      REAL    NOT NULL DEFAULT 1.5,
  batch_limit_usd         REAL    NOT NULL DEFAULT 15.0,
  agent_timeout_minutes   INTEGER NOT NULL DEFAULT 45,
  agent_budget_usd        REAL    NOT NULL DEFAULT 5.0,
  agent_concurrency       INTEGER NOT NULL DEFAULT 2,
  render_concurrency      INTEGER NOT NULL DEFAULT 1,
  render_workers          INTEGER NOT NULL DEFAULT 4,
  reference_max_seconds   INTEGER NOT NULL DEFAULT 180,
  batch_max_items         INTEGER NOT NULL DEFAULT 20,
  codex_provider_enabled  INTEGER NOT NULL DEFAULT 0,
  -- 凭据验证时间。key 一改就清空：只"配置了"不等于"能用"（AC-023）
  tokendance_verified_at  TEXT,
  hypihub_verified_at     TEXT,
  updated_at              TEXT    NOT NULL
);

-- ── 客户 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_name ON clients (name);

-- ── 模板：一条参考视频及其复刻模板 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS templates (
  id                    TEXT NOT NULL PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  language              TEXT,
  default_video_channel TEXT,
  source_kind           TEXT CHECK (source_kind IN ('file', 'url')),
  source_url            TEXT,
  source_path           TEXT,
  workspace_path        TEXT,
  note                  TEXT,
  status                TEXT NOT NULL DEFAULT 'importing'
                          CHECK (status IN ('importing','cloning','awaiting_review','approved','failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_client_name ON templates (client_id, name);
CREATE INDEX IF NOT EXISTS idx_templates_client ON templates (client_id);

-- ── 批次：一次批量提交 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS batches (
  id              TEXT PRIMARY KEY,
  template_id     TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  note            TEXT,
  target_language TEXT,
  budget_usd      REAL NOT NULL DEFAULT 0,
  spent_usd       REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_template ON batches (template_id);

-- ── 出片单位：复刻片或变体 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS productions (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('replica', 'variant')),
  batch_id    TEXT REFERENCES batches (id) ON DELETE SET NULL,
  brief       TEXT,
  name        TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  run_path    TEXT,
  status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','agent_running','awaiting_quota','asset_review',
                                  'awaiting_cost_confirm','building','done','failed',
                                  'tripped','interrupted','cancelled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_productions_template ON productions (template_id);
CREATE INDEX IF NOT EXISTS idx_productions_batch ON productions (batch_id);
CREATE INDEX IF NOT EXISTS idx_productions_status ON productions (status);

-- ── Agent 会话。owner 是 template（复刻）或 production（变体）。 ─────────
-- profile_name / model_id 是快照：档案删除后历史仍要看得出当时用的什么。
CREATE TABLE IF NOT EXISTS agent_jobs (
  id               TEXT PRIMARY KEY,
  owner_kind       TEXT NOT NULL CHECK (owner_kind IN ('template', 'production')),
  owner_id         TEXT NOT NULL,
  session_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','awaiting_quota','tripped',
                                       'interrupted','done','failed','cancelled')),
  started_at       TEXT,
  ended_at         TEXT,
  cost_usd         REAL NOT NULL DEFAULT 0,
  -- 花费一律是估算：SDK 自称 "An estimate, not a billing statement"（Spec REQ-009）
  cost_is_estimate INTEGER NOT NULL DEFAULT 1,
  stop_reason      TEXT,
  profile_name     TEXT,
  model_id         TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_owner ON agent_jobs (owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs (status);

-- ── Agent 流式消息全量。抽屉刷新后靠 seq 重放。 ────────────────────────
CREATE TABLE IF NOT EXISTS agent_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT    NOT NULL REFERENCES agent_jobs (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT,
  type       TEXT,
  payload    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_job_seq ON agent_messages (job_id, seq);

-- ── 每次 hypit build。actual_usd 恒为空：hypit 拿不到实际花费（Spec REQ-006）。 ──
CREATE TABLE IF NOT EXISTS builds (
  id             TEXT PRIMARY KEY,
  production_id  TEXT NOT NULL REFERENCES productions (id) ON DELETE CASCADE,
  video_channel  TEXT,
  video_model    TEXT,
  hypit_build_id TEXT,
  estimate_usd   REAL,
  actual_usd     REAL,
  receipt_id     TEXT,
  receipt_url    TEXT,
  status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','done','failed','cancelled')),
  error_code     TEXT,
  error_message  TEXT,
  output_path    TEXT,
  started_at     TEXT,
  ended_at       TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builds_production ON builds (production_id);

-- ── 变体条目素材 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assets (
  id               TEXT PRIMARY KEY,
  production_id    TEXT NOT NULL REFERENCES productions (id) ON DELETE CASCADE,
  label            TEXT,
  file_path        TEXT,
  source_url       TEXT,
  replaced_by_user INTEGER NOT NULL DEFAULT 0,
  is_gap           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_production ON assets (production_id);

-- ── Phase 2：每次 hypit CLI 调用的留痕，排障用 ─────────────────────────
CREATE TABLE IF NOT EXISTS hypit_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_kind TEXT,
  subject_id   TEXT,
  command      TEXT NOT NULL,
  args         TEXT,
  cwd          TEXT,
  exit_code    INTEGER,
  stdout_json  TEXT,
  stderr_text  TEXT,
  duration_ms  INTEGER,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hypit_calls_subject ON hypit_calls (subject_kind, subject_id);

-- ── Phase 10：Agent 模型档案。token 存 secrets.json，绝不入库。 ─────────
CREATE TABLE IF NOT EXISTS model_profiles (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('subscription','anthropic','compatible')),
  base_url            TEXT,
  model_id            TEXT,
  fast_model_id       TEXT,
  supports_vision     INTEGER NOT NULL DEFAULT 0,
  supports_web_search INTEGER NOT NULL DEFAULT 0,
  price_in            REAL,
  price_out           REAL,
  verified_at         TEXT,
  is_default          INTEGER NOT NULL DEFAULT 0,
  builtin             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_profiles_name ON model_profiles (name);

-- ── Phase 12：生视频通道。凭据存 secrets.json。 ────────────────────────
CREATE TABLE IF NOT EXISTS video_channels (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('tokendance','minimax_cloud','minimax_comfyui','jimeng_cli')),
  enabled     INTEGER NOT NULL DEFAULT 0,
  config      TEXT,
  verified_at TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- ── 迁移记录 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
