# ADR-0001：V2 段落覆盖 V1 段落

- 日期：2026-09-09
- 状态：Accepted

## 背景

`teskra-implementation-plan-v2.md` 是在 V1 方案上"追加"V2 章节写成的，
V1 段落（§1–§113）中的部分定义在 V2 段落（§114–§164）中已被重新设计，
但旧定义没有被删除或标注，导致同一概念存在两套互相冲突的定义。

Review 中确认的冲突：

| 概念 | V1（过时） | V2（生效） |
|---|---|---|
| Task 状态 | §28 `todo/running/review/done/failed` | §138 八态 |
| Workspace 环境 | §7.1 `environment: "windows"\|"wsl"\|"ssh"` | §116.1 `WorkspaceRuntimeRef` |
| Workflow 步骤 | §32 扁平 `WorkflowStep` | §116.3 / §153 `WorkflowNode` discriminated union |
| Reviewer 隔离 | §32 `isolation: "shared"\|"worktree"` | §126 `ReviewIsolation` 三态 |
| Artifact type | §27 含 `summary/file/patch` | §27（已修订）含 `implementation/handoff` |
| Memory 目录 | §45 `.workspace-ai/` | §152 `.teskra/` |
| 数据目录 | 散见 `<app-data>/` | §136 `~/.teskra/` |
| Task 编号 | §88/§89/§90 自成一套 TASK-001~035 | `teskra-tasks.md` 的 TASK-001~090 |

## 决策

**一律以 V2 段落为准。**

1. 所有 V1 侧的过时定义，在原位置加 `> **[SUPERSEDED]**` 标注并指向生效章节，
   不删除（保留演进痕迹），但**不得作为实现依据**。
2. `teskra-tasks.md` 是唯一的 TASK 编号权威。
   §88/§89/§90 的编号已改写为不带 `TASK-` 前缀的历史草稿，避免 Agent 读错。
3. 实现时如果 plan 与 tasks 冲突，以 `teskra-tasks.md` 为准；
   tasks 未覆盖的细节才回查 plan 的 V2 章节。

## 影响

- Milestone 1–2 不受影响。
- Milestone 3 起的 domain model 直接按 V2 定义实现。
