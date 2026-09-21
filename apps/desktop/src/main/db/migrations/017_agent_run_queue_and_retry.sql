-- 017_agent_run_queue_and_retry — 排队原因与重试链（TASK-120 / TASK-121，
-- 设计文档 §12.1，plan §139.1）。纯 ADD COLUMN，不需要表重建，不设
-- foreignKeysOff。不新增 AgentRunStatus 取值（ADR-0010）：等待原因与
-- 重试关系都是 queued / failed 的附加信息。

ALTER TABLE agent_runs
  ADD COLUMN queued_reason TEXT
  CHECK (queued_reason IS NULL OR queued_reason IN ('capacity', 'directory_busy', 'worktree_busy', 'fifo'));

ALTER TABLE agent_runs
  ADD COLUMN retry_of_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_agent_runs_retry_of ON agent_runs(retry_of_run_id);
