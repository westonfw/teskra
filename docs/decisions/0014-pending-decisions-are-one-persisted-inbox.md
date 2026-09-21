# ADR-0014：所有需要人拍板的事项进同一个持久化收件箱

- 日期：2026-09-21
- 状态：Accepted
- 相关：ADR-0002（策略下发 + 审计）、code-review-2026-09-21 P1-6

## 背景

Teskra 里「需要人决定」的时刻散落在多个模块，各自用不同的机制：

| 时刻 | 现状 |
|---|---|
| Workflow shell 步骤确认 | 纯内存 `Map` + promise，无超时，重启后消失，只有 step result 里的审计 |
| Merge preflight 可覆盖 blocker | 以 `MERGE_BLOCKED` 错误字符串返回，用户要自己猜「加 force」 |
| 限额切换账号 | Run 卡片上的 Alert（TASK-108） |
| Handoff 校验失败（`degraded`） | 只有日志与 DB 行，渲染层没有任何读取 |
| Run 长时间静默 | Recovery Center 的 `stale_process` 提示，无动作 |
| Agent 报告阻塞 | 不存在（ADR-0012 引入） |

Multica 的 Inbox 原则是「只在需要决定时通知，不逐步刷屏」。Teskra 的 Dashboard
「等你处理」卡片只读 Task / Workflow 的 `needs_review`，覆盖不到上述任何一项。

## 裁决

1. **统一实体 `PendingDecision`**，持久化到 `pending_decisions`（migration 019）：
   `kind` / `status` / `severity` / 来源引用（run / workflow run / step / worktree）/
   `dedupeKey` / `title` / `detail`（按 kind 的判别联合）/ `options` / `resolution` / `expiresAt`。

2. **幂等与并发靠数据库。** `dedupeKey` 上的 partial unique index（`WHERE status = 'open'`）
   保证同一来源只有一条 open；`resolve` 用 CAS（`status = 'open'` 才更新）保证只成功一次。

3. **DecisionService 不执行动作。** 它只负责开、关、过期、取消与广播；
   动作由来源模块通过 `onResolved(kind, handler)` 订阅执行（合并、停 Run、settle promise）。
   这样 Service 不依赖 Git / AgentManager，也不会成为第二个「什么都知道」的模块。

4. **过期由 RunWatchdogService 的 tick 驱动。** 主进程只有一个周期任务。过期时按 kind
   的默认动作处理：shell 确认 = 拒绝；静默 Run = 继续等待；Agent 阻塞 = 无动作。
   超时默认 `0`（不超时），可配置。

5. **重启语义明确。** 启动 reconciliation 把所有 open 的 `shell_confirmation` 置 `expired`
   并写审计——进程重启后步骤的内存 promise 已不存在，不能再批准。其它 kind 的 open 行
   保留（它们的来源状态在 DB 里）。

6. **来源引用用 `ON DELETE SET NULL`，不 CASCADE。** 决策记录是 ADR-0002 事后审计的一部分，
   Run 被 Retention 删除后记录仍应存在。Workspace 删除才级联。

7. **没有「always allow」。** 与 P1-6 的结论一致，shell 确认批准一次只执行一次；
   Decision 的 `options` 里不允许出现记住选择的选项。

## 影响

- `workflows/shell-confirmation.ts` 改为以 Repository 为后备存储，内存只保留 settle 函数；
  既有 IPC 通道保留为兼容别名一个 Milestone。
- 新增 Inbox 页面与导航角标；Dashboard `waitingForYou` 改读 Decision。
- `merge-service.ts` 对「仅可覆盖 blocker」的情形改为开 Decision 而不是直接报错；
  硬 blocker 仍直接 `MERGE_BLOCKED`。
- 桌面通知只在 RendererEventBridge 层发出（Runtime 不 import electron）。
