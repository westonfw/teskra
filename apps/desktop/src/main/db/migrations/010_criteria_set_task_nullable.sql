-- 010_criteria_set_task_nullable — ADR-0007
-- plan §139.1 的自相矛盾：acceptance_criteria_sets.task_id 是 CASCADE，但
-- agent_runs / workflow_runs 的 criteria_set_id 是 RESTRICT 且这两张表在
-- 删 Task 时保留审计（task_id SET NULL）。只要 Task 下有任何 Run 锚定了
-- Criteria 版本，删除就必然触发 FOREIGN KEY constraint failed。
-- 按 ADR-0006（007_workflow_run_task_optional）的先例：task_id 改为可空、
-- ON DELETE SET NULL，被 Run 引用的 Criteria 版本随审计一起保留为孤儿，
-- 未被任何 Run / Panel / Finding 引用的孤儿由 TaskRepository.delete 回收。
-- SQLite 不能 ALTER COLUMN，按官方推荐流程重建表；本 migration 以
-- foreignKeysOff 运行（否则 DROP TABLE 的隐式 DELETE 会级联清空
-- acceptance_criteria 并被 agent_runs 的 RESTRICT 阻断），事务内以
-- foreign_key_check 兜底。

CREATE TABLE acceptance_criteria_sets_new (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL,           -- draft|confirmed|superseded
  confirmed_at TEXT,
  created_at   TEXT NOT NULL
);

INSERT INTO acceptance_criteria_sets_new (id, task_id, version, status, confirmed_at, created_at)
SELECT id, task_id, version, status, confirmed_at, created_at
FROM acceptance_criteria_sets;

DROP TABLE acceptance_criteria_sets;
ALTER TABLE acceptance_criteria_sets_new RENAME TO acceptance_criteria_sets;

-- task_id 为 NULL 的孤儿行在 SQLite 唯一索引中互不相等，不会冲突。
CREATE UNIQUE INDEX idx_criteria_sets_task_version
  ON acceptance_criteria_sets(task_id, version);
