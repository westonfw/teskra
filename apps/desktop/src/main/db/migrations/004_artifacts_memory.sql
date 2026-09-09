-- 004_artifacts_memory —（plan §139.1，TASK-090）

CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,          -- plan|implementation|review|test-result|diff|decision|handoff
  name          TEXT NOT NULL,
  content       TEXT,                   -- 小内容内联
  file_path     TEXT,                   -- 大内容落 run_dir/artifacts/
  metadata_json TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_artifacts_task_type ON artifacts(task_id, type);

CREATE TABLE handoffs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,          -- implementation|review|test|analysis|blocker
  -- ADR-0004：parse 失败时 payload_json 为 NULL，raw_path 仍保留
  payload_json  TEXT,
  raw_path      TEXT,
  parse_status  TEXT NOT NULL,          -- ok|degraded|missing
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_handoffs_run ON handoffs(run_id);

CREATE TABLE memories (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,           -- architecture|convention|decision|command|known_issue|preference|summary
  content      TEXT NOT NULL,
  source       TEXT,                    -- manual|file:<path>|run:<runId>
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_memories_workspace_type ON memories(workspace_id, type);
