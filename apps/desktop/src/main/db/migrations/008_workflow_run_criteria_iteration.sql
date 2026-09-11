-- 008_workflow_run_criteria_iteration — TASK-062 Iterate Safety Cap（plan §124）
-- 双计数持久化：current_iteration 跨 Criteria 版本累计不清零；
-- criteria_iteration 锚定当前 confirmed criteria set（criteria_set_id），
-- 版本变化时由 IterationController 清零。两者都在 DB，重启后判定不变。

ALTER TABLE workflow_runs ADD COLUMN criteria_iteration INTEGER NOT NULL DEFAULT 0;
