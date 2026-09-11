# ADR-0006：WorkflowRun 独立于 Task（task_id 可空）

- 日期：2026-09-11
- 状态：Accepted

## 背景

plan §139.1 的 `workflow_runs.task_id` 定义为
`TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE`，
即 WorkflowRun 必须挂在某个 Task 下、并随 Task 删除。

TASK-056（`docs/teskra-tasks.md`，权威顺序高于 plan）的验收标准要求：

> WorkflowRun 独立于 Task（可不属于任何 Task）。

两者直接冲突：NOT NULL + CASCADE 的 `task_id` 无法实现「不属于任何 Task」。

## 决策

`workflow_runs.task_id` 改为**可空**，删除行为从 `CASCADE` 改为 `SET NULL`——
与 `agent_runs.task_id`（§139.1 line 5280，「非 CASCADE：保留审计」）完全对齐：

- `task_id IS NULL`：独立运行的 WorkflowRun（不挂在任何 Task 下）。
- Task 被删除时：WorkflowRun 保留，`task_id` 置空，执行历史/审计不丢。

实现为 migration `007_workflow_run_task_optional.sql`（SQLite 不支持
ALTER COLUMN，按官方推荐流程重建表：关 FK → 建新表 → 拷贝 → 换名 →
`foreign_key_check`）。migrate 机制因此获得 `foreignKeysOff` 选项。

## 后果

- `docs/teskra-implementation-plan-v2.md` §139.1 line 5251 的
  `task_id TEXT NOT NULL ... ON DELETE CASCADE` 被本 ADR 覆盖；
  `schema.test.ts` 的 workflow_runs 断言已同步更新。
- `definition_json` 快照的内容由 TASK-055 的 `WorkflowDefinition` Zod
  schema 校验——启动时校验通过的定义才能写入，重启恢复时读回的
  definition 一定可解释。
