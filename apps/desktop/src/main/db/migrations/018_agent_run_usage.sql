-- 018_agent_run_usage — 每 Run 一行的用量累计（plan §139.1 / 设计文档 §12.2，TASK-124）
-- usage 观测到达时累加（Claude 一次 result；Codex 每个 turn.completed）。
-- cost_usd_micros 只在 provider 报告时写；NULL = 未报告，不自行估价。
-- 聚合维度（workspace / agent / account profile）通过 join agent_runs 获得，不冗余存列。

CREATE TABLE agent_run_usage (
  run_id             TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  source             TEXT NOT NULL,               -- 'claude-stream-json' | 'codex-exec-json'
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros    INTEGER,                     -- provider 报告才写；NULL = 未报告，不自行估价
  turns              INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0 AND cache_write_tokens >= 0)
);
CREATE INDEX idx_agent_run_usage_updated ON agent_run_usage(updated_at DESC);
