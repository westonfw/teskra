# ADR-0005：Config Layers 与 Runtime Facade 纳入施工范围

- 日期：2026-09-09
- 状态：Accepted

## 背景

plan 中明确写了但 `teskra-tasks.md` 完全没有对应 Task 的模块：

- §118 RuntimeFacade / TeskraRuntime
- §119 TerminalProvider 抽象
- §147 ConcurrencyPolicy
- §148 Process Watchdog
- §151 Config Layers
- §102 Prompt Template 外置
- §67 Agent 自动 commit
- §99 git status debounce 刷新
- §60 敏感 env 的 Credential Store
- §144 Agent Routing（TASK-022 只声明了字段，无实现任务）

其中 RuntimeFacade 和 Config Layers 属于**架构性**的，
如果等到后期再加，会导致 IPC surface 已经长满散装接口、配置读取散落各处，改造成本很高。

## 决策

### 必须前置（进 Milestone 6 之前）

| 模块 | 新 Task | 理由 |
|---|---|---|
| `paths` 模块 | TASK-078 | 所有持久化的前提，见 ADR-0003 |
| Config Layers | TASK-080 | 每个 Manager 都要读配置，晚了就散了 |
| RuntimeFacade | TASK-081 | 决定 IPC surface 形状，晚了 IPC 要重做 |

### 可以后置但必须有 Task

| 模块 | 新 Task | 归属 Milestone |
|---|---|---|
| TerminalProvider 抽象 | TASK-082 | 5（Terminal） |
| Fake Agent | TASK-083 | 7（Agent Registry） |
| ConcurrencyPolicy | TASK-084 | 8（Agent Runtime） |
| Process Watchdog | TASK-085 | 12（Recovery） |
| git status debounce 刷新 | TASK-086 | 11（Git） |
| Agent 自动 commit | TASK-087 | 13（Worktree） |
| Prompt Template 外置 | TASK-079 | 15（Artifact & Handoff） |
| Credential Store | TASK-088 | 19（Permission） |
| Agent 权限策略投影 | TASK-077 | 19（Permission），见 ADR-0002 |
| Agent Routing | TASK-089 | 21（Reliability） |
| DB Schema 全量定义 | TASK-090 | 2（Persistence） |

### 编号策略

**不重排已有 TASK 编号**（会破坏所有交叉引用）。
新任务一律从 TASK-077 起编号，物理位置插入对应 Milestone，
因此 Milestone 内编号不连续。这是刻意的。

## 影响

- `teskra-tasks.md` 新增 14 个 Task。
- Phase A~G 执行顺序表需要同步更新。
