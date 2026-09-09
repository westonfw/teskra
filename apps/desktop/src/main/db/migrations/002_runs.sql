-- 002_runs — Run / Event / Worktree（plan §139.1，TASK-090）

CREATE TABLE worktrees (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT,                   -- 不设 FK：与 agent_runs.worktree_id 会构成循环引用
  branch        TEXT NOT NULL,
  base_branch   TEXT NOT NULL,
  path          TEXT NOT NULL,
  -- §132 WorktreeState
  state         TEXT NOT NULL,          -- creating|ready|dirty|conflict|merged|discarded|missing|orphaned
  isolation     TEXT NOT NULL,          -- worktree|shared-readonly|worktree-readonly|disposable-snapshot
  merged_at     TEXT,
  discarded_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_worktrees_workspace_state ON worktrees(workspace_id, state);
-- 冗余的反向指针（权威方向是 agent_runs.worktree_id），仅建索引，不设 FK（§139.1 循环引用处理）
CREATE INDEX idx_worktrees_run ON worktrees(run_id);

CREATE TABLE workflow_runs (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_definition_id TEXT NOT NULL,
  definition_json        TEXT NOT NULL, -- 启动时的定义快照，防止定义变更影响历史
  status                 TEXT NOT NULL, -- created|running|waiting|needs_user_review|completed|failed|cancelled
  current_iteration      INTEGER NOT NULL DEFAULT 0,
  total_iterations       INTEGER NOT NULL DEFAULT 0,
  criteria_set_id        TEXT REFERENCES acceptance_criteria_sets(id) ON DELETE RESTRICT,
  created_at             TEXT NOT NULL,
  completed_at           TEXT
);
CREATE INDEX idx_workflow_runs_task ON workflow_runs(task_id, status);

CREATE TABLE workflow_steps (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         TEXT NOT NULL,        -- 对应 WorkflowNode.id
  node_type       TEXT NOT NULL,        -- agent|shell|checkpoint|condition|criteria-gate|review-panel
  status          TEXT NOT NULL,        -- pending|running|completed|failed|skipped|cancelled
  iteration       INTEGER NOT NULL DEFAULT 0,
  attempt         INTEGER NOT NULL DEFAULT 1,
  depends_on_json TEXT,
  result_json     TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_workflow_steps_run ON workflow_steps(workflow_run_id, status);

CREATE TABLE agent_runs (
  id                TEXT PRIMARY KEY,
  task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,  -- 非 CASCADE：保留审计
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_run_id   TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_step_id  TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,

  agent_type        TEXT NOT NULL,      -- AgentDefinition.id，不是硬编码枚举
  role              TEXT,               -- planner|implementer|reviewer|tester|fixer
  model             TEXT,
  approval_mode     TEXT,               -- read-only|manual|safe-auto|full-auto

  -- §17 AgentRunStatus（含 interrupted）
  status            TEXT NOT NULL,

  process_id        TEXT,               -- 运行期 ProcessManager id，重启后无意义
  pid               INTEGER,            -- 仅用于 reconciliation 判活，不是真相
  worktree_id       TEXT REFERENCES worktrees(id) ON DELETE SET NULL,

  execution_mode    TEXT NOT NULL,      -- attended | orchestrated（ADR-0002）
  criteria_set_id   TEXT REFERENCES acceptance_criteria_sets(id) ON DELETE RESTRICT,
  provider_session_json TEXT,           -- §131 ProviderSessionRef

  run_dir           TEXT NOT NULL,      -- ~/.teskra/runs/<runId>
  prompt            TEXT,

  started_at        TEXT,
  finished_at       TEXT,
  last_output_at    TEXT,               -- §148 Watchdog
  last_input_at     TEXT,
  exit_code         INTEGER,
  error_json        TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_agent_runs_task     ON agent_runs(task_id, created_at DESC);
CREATE INDEX idx_agent_runs_active   ON agent_runs(status) WHERE status IN ('running','preparing','queued');
CREATE INDEX idx_agent_runs_workflow ON agent_runs(workflow_run_id);

CREATE TABLE agent_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,         -- 与 events.jsonl 的行号对齐
  event_type  TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_agent_events_run_seq ON agent_events(run_id, seq);
