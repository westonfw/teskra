-- 007_workflow_run_task_optional — TASK-056 / ADR-0006
-- WorkflowRun 独立于 Task：task_id 改为可空，ON DELETE CASCADE → SET NULL
-- （与 agent_runs.task_id 的审计保留语义对齐）。SQLite 不能 ALTER COLUMN，
-- 按官方推荐流程重建表；本 migration 以 foreignKeysOff 运行
-- （否则 DROP TABLE 的隐式 DELETE 会级联清空 workflow_steps / 置空 agent_runs），
-- 事务内以 foreign_key_check 兜底。

CREATE TABLE workflow_runs_new (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  workflow_definition_id TEXT NOT NULL,
  definition_json        TEXT NOT NULL, -- 启动时的定义快照，防止定义变更影响历史
  status                 TEXT NOT NULL, -- created|running|waiting|needs_user_review|completed|failed|cancelled
  current_iteration      INTEGER NOT NULL DEFAULT 0,
  total_iterations       INTEGER NOT NULL DEFAULT 0,
  criteria_set_id        TEXT REFERENCES acceptance_criteria_sets(id) ON DELETE RESTRICT,
  created_at             TEXT NOT NULL,
  completed_at           TEXT
);

INSERT INTO workflow_runs_new (id, task_id, workflow_definition_id, definition_json, status, current_iteration, total_iterations, criteria_set_id, created_at, completed_at)
SELECT id, task_id, workflow_definition_id, definition_json, status, current_iteration, total_iterations, criteria_set_id, created_at, completed_at
FROM workflow_runs;

DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;

CREATE INDEX idx_workflow_runs_task ON workflow_runs(task_id, status);
