# ADR-0007：Criteria Set 可脱离 Task（task_id 可空）

- 日期：2026-09-12
- 状态：Accepted

## 背景

plan §139.1 的 Schema 在删除 Task 的场景下自相矛盾：

- `acceptance_criteria_sets.task_id` = `TEXT NOT NULL ... ON DELETE CASCADE`：
  删 Task 时级联删除其所有 Criteria 版本；
- `agent_runs.task_id` / `workflow_runs.task_id` = `ON DELETE SET NULL`：
  删 Task 时 Run 保留审计（孤儿 Run 由 Doctor 识别）；
- `agent_runs.criteria_set_id` / `workflow_runs.criteria_set_id` /
  `review_panels.criteria_set_id` = `ON DELETE RESTRICT`：
  「Run 必须能追溯当时的验收契约」，被引用的 Criteria 版本不允许删。

三者叠加的后果：只要 Task 下有任何 Run 锚定过 Criteria 版本，
`DELETE FROM tasks` 必然触发 `FOREIGN KEY constraint failed`——
删 Task 保留审计的设计根本无法工作（Windows 实机验证时复现）。

## 决策

`acceptance_criteria_sets.task_id` 改为**可空**，删除行为从 `CASCADE` 改为
`SET NULL`，与 ADR-0006 对 `workflow_runs.task_id` 的处理完全对齐：

- Task 被删除时：其 Criteria 版本保留为孤儿（`task_id` 置空），
  锚定它们的 Run / WorkflowRun 的 `criteria_set_id` 不受影响，
  验收契约的追溯链完整；
- 不被任何审计行引用的孤儿版本是垃圾，由 `TaskRepository.delete`
  在同一事务内回收（引用检查覆盖 `agent_runs` / `workflow_runs` /
  `review_panels` 的 `criteria_set_id`，以及经 `acceptance_criteria`
  被 `review_findings.criterion_id` 引用的情况）。

实现为 migration `010_criteria_set_task_nullable.sql`（重建表，
复用 007 引入的 `foreignKeysOff` 机制）。

## 后果

- `docs/teskra-implementation-plan-v2.md` §139.1 中
  `acceptance_criteria_sets.task_id TEXT NOT NULL ... ON DELETE CASCADE`
  被本 ADR 覆盖（DDL 片段已同步标注）。
- contracts 的 `AcceptanceCriteriaSet.taskId` 变为可选；
  消费方（criteria-manager 的 run↔set 一致性校验等）对孤儿 set
  按「taskId 不匹配」处理，行为不变。
- `idx_criteria_sets_task_version` 唯一索引中 `task_id IS NULL` 的
  孤儿行互不相等（SQLite NULL 语义），不会冲突。
