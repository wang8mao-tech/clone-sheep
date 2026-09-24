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
  -- 本机实测 1 worker 稳定、2 起渲染进程 ACCESS_VIOLATION（Phase 0 / 已知风险），默认 1
  render_workers          INTEGER NOT NULL DEFAULT 1,
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

-- ── 费率表（REQ-006 估价来源）：hypit 不出数，Clone Studio 自维护「能力 → 单价」，设置页可编辑 ──
CREATE TABLE IF NOT EXISTS pricing_rates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  capability  TEXT NOT NULL,
  -- 只对某个 Endpoint 生效；空表示这个能力走哪个 Endpoint 都用它
  endpoint    TEXT,
  unit        TEXT NOT NULL CHECK (unit IN ('request', 'second')),
  usd         REAL NOT NULL CHECK (usd >= 0),
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rates_key ON pricing_rates (capability, IFNULL(endpoint, ''));

-- ── 估价与闸门结论（REQ-006）：每次 plan 一条，绑到出片单位 ──────────────
CREATE TABLE IF NOT EXISTS estimates (
  id             TEXT PRIMARY KEY,
  production_id  TEXT NOT NULL REFERENCES productions (id) ON DELETE CASCADE,
  plan_json      TEXT,
  pricing_json   TEXT,
  -- ok：算出了明细（total 可能为空 = 拿不到）；blocked：未解析请求 / preflight 没过，不出片
  kind           TEXT NOT NULL CHECK (kind IN ('ok', 'blocked')),
  total_usd      REAL,
  lines_json     TEXT NOT NULL,
  reason         TEXT,
  -- auto：限额内自动放行；confirm：等人确认；blocked：不出片
  decision       TEXT NOT NULL CHECK (decision IN ('auto', 'confirm', 'blocked')),
  reasons_json   TEXT NOT NULL,
  confirmed_at   TEXT,
  error_text     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_estimates_production ON estimates (production_id, created_at);

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
  -- 任务提示原文：重跑按它从头来（Task 5.2）
  prompt           TEXT,
  -- 等待额度时的自动续跑时间（订阅限流给的重置时间），供界面显示
  resume_at        TEXT,
  -- 本次运行这一段的起点（只在「运行中」有意义）
  run_started_at   TEXT,
  -- 本次运行在此之前已经跑掉的毫秒数。抽屉的「用时」=
  -- run_elapsed_ms + (运行中 ? now - run_started_at : 0)——等额度、排队都不计时
  run_elapsed_ms   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT
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

-- ── 复刻完成判据的验证结果（REQ-004）：Agent 说做完了，宿主自己再核一遍 ─────────
-- missing_json：缺的文件名数组；check_json：hypit check --json 的原样输出；error_text：check 没跑成时的原文
CREATE TABLE IF NOT EXISTS clone_verdicts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id  TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  job_id       TEXT NOT NULL,
  -- 核的是任务哪一次完成：判据不过、继续后同一个任务会再完成一次，那一次要有自己的结论
  job_ended_at TEXT,
  ok           INTEGER NOT NULL,
  missing_json TEXT NOT NULL,
  check_json   TEXT,
  error_text   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clone_verdicts_template ON clone_verdicts (template_id, id);
-- (job_id, job_ended_at) 的索引建在 migrate.ts 第 6 步：schema.sql 先于迁移执行，老表还没这一列时在这里建会直接报错

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
  -- 失败时记下的机器状态（可用内存）与最后一条进度，排查偶发渲染失败用（已知风险）
  context_json   TEXT,
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

-- ── Phase 4：证据准备的逐步状态（REQ-002）。 ──────────────────────────
-- 一个模板一套四步，刷新页面靠它恢复清单，所以必须落库而不是只存在内存里。
CREATE TABLE IF NOT EXISTS evidence_steps (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  step          TEXT NOT NULL
                  CHECK (step IN ('fetch','probe','transcribe','tiles')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','done','failed','timeout')),
  started_at    TEXT,
  ended_at      TEXT,
  duration_ms   INTEGER,
  -- 失败时原样存 hypit.cli-error@1 的 code 与 message，界面不改写（REQ-002 规则）
  error_code    TEXT,
  error_message TEXT,
  -- 原始 stdout/stderr。BAD_OUTPUT 与 TIMEOUT 这两条支路的 message 是我们自己
  -- 编的，唯一的线索全在这里，不存就真成了「吞错」（REQ-002 MUST）
  error_raw     TEXT,
  -- 该步的结构化产出：probe 的时长分辨率、tiles 的产出清单等
  detail        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_steps_template_step
  ON evidence_steps (template_id, step);

-- ── 迁移记录 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
