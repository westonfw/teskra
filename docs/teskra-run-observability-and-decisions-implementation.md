# Teskra Run 可观测性与人工决策收件箱实施方案

> Milestone 25（TASK-119～133）。本文是设计说明与「为什么这么定」；
> TASK 编号、优先级、依赖与验收标准的**唯一权威**在 `docs/teskra-tasks.md`
> Milestone 25，§16 只是带设计理由的副本（`npm run check:task-docs` 校验两者一致）。
> 相关裁决：ADR-0012 / ADR-0013 / ADR-0014。数据库 Schema 权威在 plan §139.1。

---

## 1. 背景与借鉴来源

2026-09-21 对 [multica-ai/multica](https://github.com/multica-ai/multica) 做了一次对照分析。
Multica 是团队级、Server 中心、Issue-first 的「managed agents」平台（Go 后端 +
PostgreSQL + Next.js + Electron + 本机 daemon，支持 26 种 agent CLI）。它与 Teskra
的定位差异是根本性的：Teskra 是单机、Desktop 内嵌 Runtime、Task-first。因此
Go 服务端、多租户 RBAC、Squads、IM 集成、移动端**一概不搬**。

但 Multica 在「daemon 如何跑一个 agent 并把过程讲清楚」这一层，有一组设计正好
对应 Teskra 已有模块的缺口，或对应 `docs/code-review-2026-09-21.md` 里的待修项：

| Multica 的做法 | Teskra 现状 | 本方案落点 |
|---|---|---|
| `dispatched` 超过 5 分钟未 `running` 即判失败；2 小时无输出的 idle watchdog | TASK-085 只是纯观察函数（`packages/shared`），主进程没有任何定时器，`preparing` 无超时 | §5 RunWatchdogService |
| `waiting_local_directory` 是可见状态 | 同目录无隔离写冲突在 `start()` 直接拒绝，在 `advanceQueue()` 静默停在 `queued` | §5.3 `queued_reason` |
| 瞬时故障自动重试 2 次；agent 自身返回的错误不重试 | 无自动重试；Continuation（TASK-107）是纯手动 | §5.4 窄化的自动重试 |
| Claude 走 `--output-format stream-json`、Codex 走 JSON 事件流，执行日志可回放每次 tool call | PTY 原始字节 + `auditCommandPatterns` 正则启发式；`AgentDefinition` 没有协议族字段 | §6 结构化观测流 |
| 按小时聚合 input / output / cache token 与美元成本 | 代码里没有任何 usage 统计 | §7 Usage 计量 |
| Agent 通过 `multica-cli` + `SKILL.md` 反向评论、报 blocker、请求澄清；有 lint 保证文档与 CLI 不漂移 | Handoff 是单向终态文件（ADR-0004） | §8 进度文件契约 |
| 只在需要人拍板时进 Inbox，不逐步刷屏 | 人工介入点分散：shell 确认（纯内存、无超时）、merge 阻塞只是错误字符串、`parseStatus: degraded` 没有任何渲染层读取 | §9 Decision Inbox |
| 安全模型文档直白：run 拥有 daemon OS 用户全部权限 | ADR-0002 立场一致，但只有 ADR 和横幅，没有用户可读文档 | §10 安全说明 + Doctor 检查 |
| GC 回收 `node_modules` / `.next` / `.turbo` 类产物 | RetentionService 三类，不碰 worktree 里的构建产物 | §11 Retention 扩展 |
| Autopilot 按 cron 触发 | WorkflowEngine 只有手动触发；UI 退出即停（plan §72） | §19 明确推迟到 daemon 拆分 |

**License 约束**：Multica 是 Apache-2.0 加附加条款。按 AGENTS.md 红线，本方案**只借鉴
行为与设计**，所有命名、Domain Model、代码均为 Teskra 自己的实现；不得复制其源码。

---

## 2. 产品目标

1. **一个 Run 在任何阶段卡住，Teskra 都能在有限时间内察觉并给用户一个动作。**
   `preparing` 有超时；长时间静默有看门狗；看门狗默认「问人」而不是「杀进程」。
2. **exec 模式的 Run 能回放它做了什么、花了多少。** tool call 级的 Activity 视图；
   按 Run / Workspace / 账号聚合的 token 用量；限额分类（ADR-0010）从「事后判断」
   前进到「有数据可预警」。
3. **Agent 在运行中就能把进度和阻塞讲出来，而不是等退出。** 仍走文件契约，不解析 stdout。
4. **所有需要人拍板的事情进同一个收件箱。** 持久化、可超时、可审计、重启不丢；
   Dashboard 的「等你处理」只读这一个来源。
5. **把「Teskra 不是安全边界」写成用户能读到的文档，并让 Doctor 提示可达凭据。**

---

## 3. 非目标与边界

- **不引入 daemon / server / 远程 runtime。** UI 退出即停的模型不变（plan §72）。
  Autopilot（定时触发）与 daemon 拆分一起做，见 §19。
- **不新增 `AgentRunStatus` 取值**（ADR-0010 的理由继续成立）。`preparing` 超时、
  静默、等待目录、重试都用已有状态 + 附加列 / 事件表达。
- **不违反 ADR-0004。** 结构化观测流只用于观测、计量与审计证据，**不**作为 Handoff 来源，
  **不**驱动 Run 状态迁移，**不**单独触发终止（ADR-0013）。Handoff 与进度文件仍走文件契约。
- **不做全协议族（ACP / JSON-RPC）接入。** 本 Milestone 只声明协议族字段并落地两种
  NDJSON 流（Claude `stream-json`、Codex `exec --json`）；Kimi 与 Fake 声明 `none`。
- **不做「always allow」。** 收件箱里的 shell 确认与 P1-6 结论一致：批准一次只执行一次。
- **不自行估算美元成本。** 只记录 provider 在流里报告的 `cost`；没报告就存 NULL，
  UI 显示「未知」而不是按公开价目表推算（价目会变，估算会误导限额判断）。
- **不在 `attended` 模式改变「同目录写冲突直接拒绝」的硬限制**（TASK-084）。
  `queued_reason` 只解释 orchestrated / 队列路径里的等待原因。

---

## 4. 现状盘点（写方案前核实过的事实）

- `AgentRunStatus` 12 个取值（contracts `agent.ts:22-37`）；`interrupted` 为 reconciliation 专用。
- `preparing → running` 在 `agent-manager.ts` `launchInner()`：`adapter.start()` 前后各有一次
  终态重检（P0-3 已修，commit `bbb6a40`）；`failAndStop` 对「`preparing` 且无 `processId`
  且 `inFlightLaunches` 含该 run」返回可重试 `CONFLICT`；`failStopInFlights` 做并发去重（P1-1 已修）。
- 并发限制（TASK-084）全部在 `agent-manager.ts`：`hasCapacity`（per-profile / global /
  workspace / agent）；`unisolatedWriteConflict` 在 `start()` 直接拒绝、在 `advanceQueue()`
  让候选停在 `queued`；`worktreeRunConflict` 同理。
- 看门狗（TASK-085）= `packages/shared` 的 `inspectRunWatchdog()` 纯函数；主进程只在
  Recovery Center 扫描时调用；唯一的 ticker 是渲染层 1 秒时钟。**主进程没有周期任务。**
- Run 目录（`paths.ts` `RUN_FILE_NAMES`）：`run.json` / `events.jsonl` / `terminal.log` /
  `handoff.json` / `diff.patch` / `artifacts/`；`events.jsonl` 先写、SQLite `agent_events`
  后写，`seq` 对齐行号。
- PTY 是唯一 spawn 机制；`mode: 'exec'` 只改 CLI 参数（`prompt.headlessArgs`），
  Claude `['--print']`、Codex `['exec']`、Kimi `['--prompt']`。
- `AgentDefinition` 没有输出协议字段；`auditCommandPatterns` 是显式 best-effort 的正则。
- Handoff 契约：`TESKRA_HANDOFF_PATH` / `TESKRA_ARTIFACT_DIR` / `TESKRA_RUN_ID` 由
  `cli-agent-adapter.ts` 作为系统层最后写入；`handoff-collector.ts` 产出 `ok | degraded | missing`。
  **渲染层没有任何代码读取 `parseStatus`**（`handoff.get` 通道存在但无调用方）。
- Shell 确认（`workflows/shell-confirmation.ts`）：纯内存 `Map`，无超时；`listPending` 与
  渲染层挂载时回拉已做（87f2dcb）；批准记入 step result；**重启后挂起项随进程消失**。
- Merge preflight 只在 `merge()` 内部隐式执行；可覆盖的 blocker 以 `MERGE_BLOCKED` 错误
  字符串形式到达用户，没有结构化的「force 合并」决策入口。
- Dashboard「等你处理」= `task.status === 'needs_review'` + `workflow.listRuns({status:'needs_user_review'})`，
  不含 shell 确认、静默 Run、degraded handoff。
- Doctor 11 项检查，全部只读；没有「可达凭据」类检查。
- RetentionService 三类（`merged-worktree` / `run-logs` / `discarded-run`），`ownsRunDir`
  守卫只保护 `<home>/runs`。
- Config 组：`logging / concurrency / watchdog / environment / agents / review / retention`；
  `watchdog` 只有 `stalledThresholdMs`（默认 10 分钟）。

---

## 5. Run 生命周期硬化

### 5.1 RunWatchdogService（主进程定时器）

新增 `apps/desktop/src/main/agents/run-watchdog-service.ts`，由 composition root 启动，
`dispose()` 时停止。它是**主进程第一个周期任务**，因此要遵守：

- 单实例、tick 间隔 `WATCHDOG_TICK_MS = 15_000`；tick 内不 `await` 慢操作超过一次，
  上一 tick 未完成则跳过本 tick（不排队）。
- 只读 `runs.listActive()` + `inspectRunWatchdog()`（复用 TASK-085 纯函数，不写第二份判定）。
- 所有动作走 AgentManager 已有入口：`failAndStop()` / `cancel()`；**Watchdog 自己不碰进程**。
- 不 import `electron`。

### 5.2 `preparing` 超时

- 配置 `watchdog.preparingTimeoutMs`，默认 `300_000`（5 分钟，与 Multica dispatch 超时同量级）。
- 判定：`status === 'preparing'` 且 `now - updatedAt >= preparingTimeoutMs`。
  `created` 不计（尚未进入 launch）；`queued` 不计（等待是合法的）。
- 动作：调用 `failAndStop(runId, { kind: 'process-crash', retryable: true, evidence: 'preparing timed out after <n>s' })`。
  `failAndStop` 对仍在 `inFlightLaunches` 的 run 返回 `CONFLICT`：Watchdog 记 WARN、
  下一 tick 再试；连续 3 次 `CONFLICT` 后升级为 `agent.stalled` 事件（§5.5），不再强杀。
  这样不会重现 P0-3 的「启动进行中被写成 failed」。
- 持久事件：`agent.failed` 的 payload 里带 classification（已有路径），另追加
  `agent.watchdog` 事件 `{ check: 'preparing_timeout', silentForMs }`。

### 5.3 静默看门狗（idle）

- 配置 `watchdog.idleTimeoutMs`，默认 `7_200_000`（2 小时）；`0` = 关闭。
  与既有 `stalledThresholdMs`（10 分钟，仅 UI 提示）分层：前者是「动作阈值」，后者是「提示阈值」。
- 配置 `watchdog.idleAction: 'ask' | 'stop'`，默认 `'ask'`。
- 判定：`inspectRunWatchdog(run, now, idleTimeoutMs).possiblyStalled`
  （即 `running / waiting_* / reviewing` 且静默 ≥ 阈值）。`lastOutputAt` 由 PTY 输出、
  §8 的进度事件、§6 的观测事件三者共同刷新——Agent 只要在写进度文件就不算静默。
- `'ask'`：打开一条 Decision（§9，kind `stalled_run`，选项 `keep_waiting` / `stop`），
  同一 run 只允许一条 open；用户选 `keep_waiting` 后把该 run 的下一次判定基线推到「现在」
  （存 `agent_runs.last_input_at`，语义正好是「用户最后一次干预」）。
- `'stop'`：`failAndStop(runId, { kind: 'unknown', retryable: true, evidence: 'idle for <n> min' })`。
- 事件：`agent.stalled { runId, silentForMs, action }`（新增到 `WorkbenchEvents`）。

**为什么默认问人而不是杀**：ADR-0010 §4 已经确立「弱信号不得单独终止」。静默本身是弱信号
（交互式 Agent 等待用户输入、长测试无输出都会静默）。Multica 是无人值守的 daemon 才默认杀。

### 5.4 窄化的自动重试

- 配置 `retry.transientAttempts`，整数 `0..3`，默认 `1`。
- **仅**当以下条件全部成立时触发：
  1. Run 终态为 `failed` 且 `failureClassification.kind === 'network'` 且 `retryable === true`；
  2. `handoff.parseStatus !== 'ok'`（Agent 已经写出有效 Handoff 的失败不重试，那是 Agent 自己的结论）；
  3. 沿 `retry_of_run_id` 链回溯的尝试次数 < `transientAttempts`；
  4. Run 不属于 Workflow 步骤（Workflow 的重试由 Iterate primitive 管）。
- 实现复用 TASK-107 的 Continuation 机制：源 Run 已退出后创建目标 Run，同 worktree、
  同 Profile、`providerSession` 存在则走 `resume`，否则新 session；目标 Run 写
  `retry_of_run_id = <source>`。**不**新增第二套「重新拉起进程」的代码。
- `rate-limited` / `authentication-*` / `permission` / `unknown` 一律不自动重试
  （对应 Multica「agent 自身错误不重试」）。

### 5.5 `queued_reason`

- `agent_runs` 增加可空列 `queued_reason`（migration 017），取值
  `capacity | directory_busy | worktree_busy | fifo`。
- `start()` 决定入队时写入原因；`advanceQueue()` 每次跳过候选时更新原因（值变化才写）；
  离开 `queued` 时置 NULL。
- 渲染层 Run 列表对 `queued` 显示原因标签，取代现在的裸「queued」。
- 不改 `attended` 模式 `start()` 的直接拒绝。

---

## 6. 结构化观测流

### 6.1 协议族声明（AgentDefinition）

`agentDefinitionSchema` 增加：

```ts
output: z.strictObject({
  structured: z.enum(['none', 'claude-stream-json', 'codex-exec-json']),
  /** 仅在 mode === 'exec' 且启用结构化流时追加到 headlessArgs 之后。 */
  structuredArgs: z.array(z.string()).optional(),
}).optional()   // 缺省视为 { structured: 'none' }
```

| Agent | `structured` | `structuredArgs` | 备注 |
|---|---|---|---|
| claude | `claude-stream-json` | `['--output-format', 'stream-json', '--verbose']` | `--print` 下 `stream-json` 必须带 `--verbose` |
| codex | `codex-exec-json` | `['--json']` | 追加在 `exec` 子命令之后、prompt 之前 |
| kimi | `none` | — | |
| fake | `none`（另有 `TESKRA_FAKE_SCENARIO` 场景 `structured-stream`） | — | 用于 Parser 的端到端测试 |

**只对 `mode: 'exec'` 生效。** interactive 模式的 TUI 输出仍原样进 xterm。
配置 `observability.structuredStream: boolean`（默认 `true`）可整体关闭；关闭后
exec 模式行为与现在完全一致。

`structured !== 'none'` 只是「能力声明」，不是「已验证」：Parser 对任何无法解析的行
一律忽略并计数，见 §6.2。

### 6.2 StructuredOutputParser

位置 `apps/desktop/src/main/agents/observation/`：

```text
line-splitter.ts          去 \r、按 \n 切行、保留不完整尾行；单行 > 64 KiB 丢弃并计数
claude-stream-json.ts     归一化 Claude stream-json → AgentObservation
codex-exec-json.ts        归一化 Codex exec --json → AgentObservation
observation-recorder.ts   持久化 + 事件 + usage 汇总 + session 捕获
```

归一化后的 `AgentObservation`（contracts `agent-observation.ts`）：

```ts
kind: 'session' | 'assistant_text' | 'tool_call' | 'tool_result' | 'usage' | 'error' | 'result'
// session:      { sessionId }
// assistant_text: { text }                          // 截断到 8 KiB
// tool_call:    { toolName, input }                 // input 序列化后截断到 4 KiB；command 类工具另提 `command`
// tool_result:  { toolName?, ok, output }           // 截断到 4 KiB
// usage:        { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsdMicros?, model? }
// error:        { message, code? }
// result:       { ok, durationMs?, turns? }
```

规则：

- 只对 `structured !== 'none'` 且 `mode === 'exec'` 的 Run 挂 Parser；数据源是
  AgentManager 已经收到的 `process.output` chunk（在批处理之前），不新开通道。
- 每条观测先 `redactSecrets` 再持久化为 `agent.observation` 事件（`events.jsonl` +
  `agent_events`，同 seq 机制），并 `emit('agent.observation')`。
- **未知 `type` / JSON 解析失败 → 忽略并计数**，run 结束时把计数写进 `agent.observation_summary`
  事件；解析失败率不影响 Run 结果。
- 各协议的 fixture 必须来自真实 CLI 输出（记录 CLI 版本），与 Codex 0.154.0 备注同样的做法。
- `tool_call` 若命中命令类工具（Claude `Bash`、Codex `command_execution`），同时追加
  `agent.command` 事件——**结构化来源优先于 `auditCommandPatterns` 正则**，同一 Run 内
  两者不重复记录（有结构化流时关闭正则匹配）。

### 6.3 允许与禁止的用途（ADR-0013）

允许：Activity 视图、`agent.command` 审计、usage 计量、`providerSession` 缺失时补写
session id（元数据）、作为 ADR-0010 §4 所说的「结构化错误」证据供 FailureClassifier 使用。

禁止：驱动 Run 状态迁移；单独触发终止；作为 Handoff / ReviewFinding 的来源；
替代 `terminal.log`（原始字节仍完整落盘，`readOutput` 不变）。

---

## 7. Usage 计量

- 表 `agent_run_usage`（migration 018，见 §12.2）：每 Run 一行，`usage` 观测到达时累加
  （Claude 一次 `result` 一行；Codex 每个 `turn.completed` 一次）。
- 聚合走 Repository（`usageRepository.summarize({ workspaceId?, accountProfileId?, agentType?, since })`），
  与 `agent_runs` join 取维度；**不**冗余 workspace / profile 列。
- IPC `usage.summary` / `usage.getByRun`。
- UI：Run 详情头部（tokens / cost 或「未知」）；账号卡片（TASK-108 已有限额历史处）追加
  最近 24 小时 / 7 天用量；Dashboard 新增 `usage` 卡片（本周 tokens、按 agent 分组）。
- `cost_usd_micros` 为 NULL 时 UI 显示「未报告」，不显示 0。
- 用量不作为限额判定的输入（那是 ADR-0010 的 classifier 的事），只做展示与趋势。

---

## 8. Agent 进度文件契约（ADR-0012）

### 8.1 契约

在 ADR-0004 的三个环境变量之外增加：

```text
TESKRA_PROGRESS_PATH=<dataRoot>/runs/<runId>/progress.jsonl
```

Agent **追加写**（append-only），每行一个 JSON 对象：

```ts
agentProgressEventSchema = z.strictObject({
  kind: z.enum(['progress', 'blocker', 'question', 'note']),
  message: z.string().min(1).max(2000),
  percent: z.number().int().min(0).max(100).optional(),
  at: z.string().datetime().optional(),      // 缺省取 Teskra 读到该行的时间
  data: z.record(z.string(), z.unknown()).optional(),   // 序列化后 ≤ 4 KiB
})
```

- `progress` / `note`：只展示。
- `blocker`：Agent 无法继续，需要人。→ Decision（§9，kind `agent_blocker`，选项
  `acknowledge` / `stop`）；Run 状态**不变**（仍 `running`），Agent 自己决定是等待还是退出。
- `question`：Agent 想要澄清但可以继续。→ Decision（kind `agent_blocker`，`severity: 'info'`）；
  第一版不把答案回传给进程（回传需要 stdin 协议，超出本 Milestone），答案记入 Decision
  resolution 并在下一次 Continuation 的 `{{previousHandoff}}` 里带上。

### 8.2 Teskra 侧 follower

`apps/desktop/src/main/agents/progress-follower.ts`：

- Run 进入 `running` 时开始，终态后做最后一次 drain 再停止。
- **轮询而不是 `fs.watch`**：间隔 1 秒；WSL 跨边界（9p / drvfs）上 `fs.watch` 不可靠，
  轮询在 1 秒粒度下代价可忽略。
- 记录已读 offset，只读新增字节；不完整尾行保留到下一轮。
- 每行 Zod 校验；失败行跳过并计数（每 Run 只 WARN 一次）；单行 > 8 KiB 跳过；
  文件 > 4 MiB 停止跟随并记 `agent.progress_summary { truncated: true }`。
- 通过的行 → `redactSecrets` → `agent.progress` 事件（持久 + 广播），并刷新 `lastOutputAt`。
- 文件不存在是常态（Agent 没写），不是错误；`RunLogStore.initialize()` **不**预创建它，
  以便区分「没写」与「写了空文件」。
- Retention：`progress.jsonl` 归入 `runLogFiles()`，与 `events.jsonl` / `terminal.log` 同策略回收。

### 8.3 Prompt 与文档一致性

- `resources/prompts/*.md` 的 Handoff 段落之后增加「Progress (optional)」段，说明
  `{{env.TESKRA_PROGRESS_PATH}}` 与四种 `kind`；`buildVariables` 增加该变量。
- 新增 `resources/prompts/teskra-agent-protocol.md`：给 Agent 读的完整协议说明
  （环境变量、Handoff schema 摘要、进度事件 schema、什么不会被读取）。Dispatch 时通过
  `{{protocol}}` 变量内联进 prompt（受 ContextBuilder 预算约束，放在 memory 之后）。
- **一致性测试**（对应 Multica 的 SKILL.md lint）：`prompt-protocol-consistency.test.ts`
  断言 `cli-agent-adapter.ts` 注入的每个 `TESKRA_*` 变量名都出现在协议文档里，且协议
  文档里的 `kind` 枚举与 `agentProgressEventSchema` 一致——文档漂移直接让单测失败。

---

## 9. Decision Inbox（ADR-0014）

### 9.1 领域模型

```ts
PendingDecision {
  id, workspaceId,
  kind: 'shell_confirmation' | 'agent_blocker' | 'stalled_run' | 'merge_blocked' | 'rate_limit' | 'handoff_degraded',
  status: 'open' | 'resolved' | 'expired' | 'cancelled',
  runId?, workflowRunId?, workflowStepId?, worktreeId?,
  dedupeKey,                       // `${kind}:${sourceId}`；同 key 只允许一条 open
  severity: 'info' | 'warning' | 'blocking',
  title, detail,                   // detail 按 kind 的 Zod 判别联合（命令 + cwd / blocker 文本 / 静默时长 / preflight blockers …）
  options: DecisionOption[],       // { id, label, danger?: boolean }
  resolution?: { optionId, decidedBy: 'user' | 'timeout' | 'system', decidedAt, note? },
  expiresAt?, createdAt, resolvedAt?
}
```

`DecisionService`（`apps/desktop/src/main/decisions/decision-service.ts`）：

- `open(input)`：按 `dedupeKey` 幂等（已有 open 行则返回它，不重复发事件）；写库；`emit('decision.opened')`。
- `resolve(id, optionId, decidedBy)`：CAS 更新 `status = 'open' → 'resolved'`；再由**来源模块**
  执行动作（Service 不知道怎么合并、怎么停 Run）。来源模块通过 `onResolved(kind, handler)` 订阅。
- `expire()`：由 RunWatchdogService 的 tick 驱动（复用同一个定时器，不再开第二个）；
  `expiresAt <= now` 的 open 行 → `expired`，并按 kind 的默认动作处理
  （shell 确认 = 拒绝；stalled_run = 继续等待；agent_blocker = 无动作）。
- `cancelBySource(runId | workflowRunId)`：来源终结时把其 open 行置 `cancelled`。
- 启动 reconciliation：所有 `shell_confirmation` open 行 → `expired`（进程重启后步骤的
  内存 promise 已不存在，不能再批准），并写审计。

### 9.2 来源接入

| kind | 来源 | 选项 | 解决动作 |
|---|---|---|---|
| `shell_confirmation` | `shell-confirmation.ts`（改为以 Repository 为后备存储，内存 Map 只保留 settle fn） | `approve` / `reject` | settle promise；批准仍记入 step result（已有） |
| `agent_blocker` | §8 progress follower（`blocker` / `question`） | `acknowledge` / `stop` | `stop` → `cancel(runId)` |
| `stalled_run` | §5.3 Watchdog | `keep_waiting` / `stop` | `keep_waiting` → 更新 `last_input_at`；`stop` → `failAndStop` |
| `merge_blocked` | `merge-service.ts` 遇到**仅含可覆盖 blocker** 时（硬 blocker 仍直接报错） | `force_merge`（danger）/ `cancel` | `force_merge` → `merge({ force: true })` |
| `rate_limit` | `settleFailedStop` / `stopExited` 分类为 `rate-limited` 时 | `continue_with_account` / `retry` / `wait` | 与 TASK-108 的 Alert 同一套动作，Alert 保留 |
| `handoff_degraded` | `handoff-collector.ts` 产出 `degraded` 时 | `open_raw` / `dismiss` | 打开 `rawPath` 所在目录 |

超时配置 `decisions.shellConfirmationTimeoutMs`、`decisions.stalledRunTimeoutMs`
（整数 ≥ 0，默认 `0` = 不超时）。P1-6 的「可选超时拒绝」由此落地。

### 9.3 UI

- 新页面「Inbox」（导航常驻，带 open 计数角标）；按 severity 分组；每项展示来源上下文
  （Run / Workflow / Worktree 链接）与选项按钮；`danger` 选项二次确认。
- 现有 `ShellConfirmationHost` Modal 保留（阻塞型确认仍需要模态），但数据源改为
  `decision.list({ kind: 'shell_confirmation', status: 'open' })`。
- Dashboard `waitingForYou` 改为 `decision.list({ status: 'open' })` + 原有 `needs_review`
  Task 合并；`recentFailures` 卡片对 `rate_limit` 项直接给「继续」入口。
- 桌面通知：`severity === 'blocking'` 的 Decision 打开时发一次 Electron `Notification`
  （只在 RendererEventBridge 所在层，Runtime 不 import electron）；可在 Settings 关闭。

---

## 10. 安全模型文档与 Doctor 检查

### 10.1 `docs/security-model.md`

面向用户，与 Multica 同等坦率地写清：

1. Run 以 Teskra 进程所属 OS 用户的全部权限执行；worktree 是**便利隔离**而非安全边界；
   `full-auto` 意味着审批被 CLI 自动通过；Teskra 无法做执行前拦截（ADR-0002）。
2. 凡 Teskra 进程环境里可达的凭据（`process.env`、`~/.ssh`、各 CLI 的登录态、Workspace env）
   都应视为 Run 可读；Credential Store 只保证**落盘加密**，注入后即为明文。
3. 推荐的真正边界：专用 Windows 用户 / WSL distro、按用途的 deploy key、只给 Agent
   账号最小权限的 token。
4. Teskra 实际做了什么：per-Run 目录、per-Profile CLI Home（ADR-0009）、`.git/info/exclude`
   纵深防御、日志脱敏、shell 步骤一次一批。

### 10.2 Doctor 新增检查 `credential-exposure`（warning，只读）

- 枚举 Teskra 自身 `process.env` 与当前 Workspace 的 `env` 中 `looksLikeSecretKey()` 命中的**键名**
  （不读值，不打印值），列出「这些变量会被 Run 继承」。
- 当前 Workspace 存在 `approvalMode === 'full-auto'` 且 `worktreeId === undefined` 的活动 Run 时提示。
- 检查项 `detail` 里链接到 `docs/security-model.md`。

---

## 11. Retention 扩展：worktree 构建产物回收

- 新类别 `worktree-artifacts`：对 worktree 内命中 `retention.worktreeArtifactPatterns`
  （默认 `['node_modules', '.next', '.turbo']`，仅匹配顶层与一级子目录名，不做 glob）的目录，
  当 worktree 满足以下条件时删除：状态 ∈ `{ merged, discarded, archived }`，**或**
  状态为 `ready` / `dirty` 且无非终态 Run 且 `updatedAt` 早于 `retention.worktreeArtifactIdleDays`（默认 7）天。
- 守卫：目标路径经 `realpath` 后必须位于该 worktree 路径之下（`ownsWorktreePath`，与
  `ownsRunDir` 同构，符号链接逃逸一律跳过并审计）；`conflict` 状态永不处理。
- `plan()` 预览列出每项的估算大小（`du` 级别，超时 10 秒则显示「未知」）；`run()` 逐项可中断。
- 不删除仓库主工作区里的任何东西。

---

## 12. 数据库设计

三个 migration，均为纯 `CREATE TABLE` / `ADD COLUMN`，不需要表重建，不设 `foreignKeysOff`。
以下 DDL 同步进 plan §139.1。

### 12.1 `017_agent_run_queue_and_retry.sql`（TASK-120 / TASK-121）

```sql
ALTER TABLE agent_runs
  ADD COLUMN queued_reason TEXT
  CHECK (queued_reason IS NULL OR queued_reason IN ('capacity', 'directory_busy', 'worktree_busy', 'fifo'));

ALTER TABLE agent_runs
  ADD COLUMN retry_of_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_agent_runs_retry_of ON agent_runs(retry_of_run_id);
```

### 12.2 `018_agent_run_usage.sql`（TASK-124）

```sql
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
```

聚合维度（workspace / agent / account profile）通过 join `agent_runs` 获得。

### 12.3 `019_pending_decisions.sql`（TASK-128）

```sql
CREATE TABLE pending_decisions (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'shell_confirmation', 'agent_blocker', 'stalled_run',
                     'merge_blocked', 'rate_limit', 'handoff_degraded')),
  status           TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'expired', 'cancelled')),
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  run_id           TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,      -- 审计行不随 Run 删除
  workflow_run_id  TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
  worktree_id      TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  dedupe_key       TEXT NOT NULL,
  title            TEXT NOT NULL,
  detail_json      TEXT NOT NULL,
  options_json     TEXT NOT NULL,
  resolution_json  TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);
CREATE UNIQUE INDEX idx_pending_decisions_open_dedupe
  ON pending_decisions(dedupe_key) WHERE status = 'open';
CREATE INDEX idx_pending_decisions_workspace_open
  ON pending_decisions(workspace_id, created_at DESC) WHERE status = 'open';
CREATE INDEX idx_pending_decisions_run ON pending_decisions(run_id);
```

partial unique index 是 `open()` 幂等的并发守卫（与 M24 §48.1「INSERT 作并发守卫」同一手法）。

---

## 13. Contracts / IPC / Events

新增 contracts 文件：`agent-observation.ts`、`agent-progress.ts`、`usage.ts`、`decision.ts`。

`AgentDefinition`：`output` 字段（§6.1）。`AgentRun`：`queuedReason?`、`retryOfRunId?`。
`teskraConfigSchema` 新增 / 扩展组：

```ts
watchdog:      { stalledThresholdMs, preparingTimeoutMs, idleTimeoutMs, idleAction }
retry:         { transientAttempts }
observability: { structuredStream }
decisions:     { shellConfirmationTimeoutMs, stalledRunTimeoutMs, desktopNotifications }
retention:     { ..., worktreeArtifactPatterns, worktreeArtifactIdleDays }
```

IPC（沿用 `teskra:<domain>:<verb>`）：

```text
teskra:decision:list            { workspaceId?, kind?, status? }
teskra:decision:resolve         { id, optionId, note? }
teskra:usage:summary            { workspaceId?, accountProfileId?, agentType?, since }
teskra:usage:get-by-run         { runId }
teskra:agent:list-observations  { runId, afterSeq?, limit? }
teskra:agent:list-progress      { runId, afterSeq?, limit? }
```

`workflowShellConfirmation` / `workflowListPendingShellConfirmations` 保留为兼容别名，
内部转到 decision 通道；一个 Milestone 后移除。

Events：`agent.observation`、`agent.progress`、`agent.stalled`、`agent.watchdog`、
`decision.opened`、`decision.resolved`（含 `expired` / `cancelled`，以 `status` 区分）、
`usage.updated`。`workflow.shell_confirmation_required` 保留并同时发出（兼容）。

所有请求 `strictObject`；所有回复 `IpcResult<T>`。

---

## 14. UI

- Run 详情：`Activity` Tab（观测事件时间线，tool call 折叠展示 input / result）、`Progress`
  Tab（进度事件 + 百分比）、头部 usage 摘要；exec 且有结构化流的 Run 默认落在 Activity，
  `Terminal` Tab 仍显示原始 JSONL。
- Run 列表：`queued` 显示原因；`stalled` 徽标（沿用 `stalledThresholdMs` 提示阈值）。
- Inbox 页面 + 导航角标；Dashboard `waitingForYou` / `usage` 卡片。
- Settings → General：watchdog 三项、retry、observability、decisions 超时与通知开关。
- 所有文案走 i18n（沿用 `errorMessage.*` / `settings.*` 键空间）。

---

## 15. 测试策略

- **Watchdog**：假时钟；`preparing` 超时命中 `failAndStop`；`inFlightLaunches` 期间返回
  `CONFLICT` 不写 failed；连续 3 次升级为 `agent.stalled`；`idleAction` 两种分支；
  tick 重入被跳过。
- **Parser**：每协议 ≥ 3 份真实 CLI 输出 fixture（含 `\r\n`、半行切割、混入非 JSON 行、
  超长行）；未知 type 计数不抛；secret 在持久化前被掩码；结构化 `Bash` 调用产生
  `agent.command` 且正则路径被关闭（不重复）。
- **Usage**：累加语义；`cost` 缺失存 NULL；聚合 join 正确按 profile / agent 分组。
- **Progress follower**：轮询 offset 正确、半行保留、坏行计数、8 KiB / 4 MiB 上限、
  `blocker` 生成 Decision 且幂等、`lastOutputAt` 被刷新、终态后 drain。
- **协议文档一致性**：注入的 `TESKRA_*` 变量集合 == 文档提及集合；`kind` 枚举一致。
- **DecisionService**：`dedupeKey` 并发 `open()` 只有一行（真并发测试，同 M24 §48.1）；
  `resolve` CAS 只成功一次；`expire` 按 kind 默认动作；启动 reconciliation 把 shell
  确认置 `expired` 并写审计；`cancelBySource`。
- **Shell 确认迁移**：现有 `shell-confirmation.test.ts` 全部保留通过；新增「重启后不再
  可批准」用例。
- **Merge blocked**：仅可覆盖 blocker → Decision；硬 blocker → 直接 `MERGE_BLOCKED`；
  `force_merge` 走 `merge({ force: true })`。
- **Doctor**：`credential-exposure` 只输出键名，断言输出里不含任何值；`[Windows 验证]`
  在 Windows 主机上 `process.env` 大小写不敏感情况下不重复列出。
- **Retention**：符号链接逃逸被跳过并审计；`conflict` worktree 永不处理；有活动 Run 的
  worktree 不处理；`plan()` 不写。
- Repository：内存 SQLite；三个 migration 每条 CHECK / partial index 各有一个「让它失败」的测试。
- E2E（软件渲染）：Fake Agent `structured-stream` 场景 → Activity 视图出现 tool call；
  Fake Agent 写 `blocker` → Inbox 出现条目 → 选 `stop` → Run `cancelled`。

---

## 16. 任务拆分

> 与 `docs/teskra-tasks.md` Milestone 25 逐项对应；改动请先改 tasks，再同步此处。

### TASK-119 — RunWatchdogService：preparing 超时与静默看门狗

**优先级：P0**

**依赖：TASK-085, TASK-107**

理由：这是主进程第一个周期任务，后续 Decision 过期（TASK-128）复用同一个 tick。
`preparing` 超时是对 P0-3 修复的补完——修复保证不会「写错」，超时保证不会「永远等」。

### TASK-120 — 持久化 queued_reason 并在 UI 展示

**优先级：P2**

**依赖：TASK-084**

理由：借鉴 Multica `waiting_local_directory` 的可见性，但不加状态（ADR-0010）。

### TASK-121 — 瞬时故障自动重试（仅 network）

**优先级：P2**

**依赖：TASK-105, TASK-107, TASK-119**

理由：复用 Continuation，避免第二套拉起代码；范围刻意只到 `network`。

### TASK-122 — AgentDefinition 输出协议族声明

**优先级：P1**

**依赖：TASK-022, TASK-025**

理由：协议族是「声明」，不是「实现」；Kimi / Fake 声明 `none` 即可。

### TASK-123 — StructuredOutputParser 与观测事件

**优先级：P1**

**依赖：TASK-122, TASK-031, TASK-039**

理由：ADR-0013 的落地点；结构化 `agent.command` 取代正则。

### TASK-124 — Usage 计量与聚合

**优先级：P1**

**依赖：TASK-123, TASK-006**

### TASK-125 — Activity / Progress 视图

**优先级：P2**

**依赖：TASK-123, TASK-126, TASK-030**

### TASK-126 — Progress 文件契约与 follower

**优先级：P1**

**依赖：TASK-051, TASK-078, TASK-039**

理由：ADR-0012；轮询而非 `fs.watch`（WSL 边界）。

### TASK-127 — Agent 协议说明与文档一致性测试

**优先级：P1**

**依赖：TASK-126, TASK-079**

理由：对应 Multica 的 SKILL.md lint——文档漂移让单测失败。

### TASK-128 — PendingDecision 领域模型、Repository 与 Migration

**优先级：P0**

**依赖：TASK-007, TASK-090, TASK-119**

理由：ADR-0014；过期由 TASK-119 的 tick 驱动。

### TASK-129 — Shell 确认迁移到 Decision Inbox

**优先级：P0**

**依赖：TASK-128, TASK-058**

理由：P1-6 的剩余项（超时、重启语义）在这里收口。

### TASK-130 — 其它决策来源接入

**优先级：P1**

**依赖：TASK-128, TASK-119, TASK-126, TASK-045, TASK-108**

### TASK-131 — Inbox UI 与 Dashboard 接入

**优先级：P1**

**依赖：TASK-128, TASK-071, TASK-092**

### TASK-132 — 安全模型文档与 Doctor 凭据暴露检查

**优先级：P1**

**依赖：TASK-041, TASK-088**

### TASK-133 — Retention 回收 worktree 构建产物

**优先级：P2**

**依赖：TASK-069, TASK-044**

---

## 17. 推荐实施顺序

```text
Phase A  TASK-119                       主进程 tick + preparing 超时 + idle（先只做 'stop' 与事件）
Phase B  TASK-128 → TASK-129 → TASK-131 Decision Inbox 骨架、shell 确认迁移、UI
         TASK-130                        接入 stalled_run（补上 'ask'）、merge_blocked、rate_limit、handoff_degraded
Phase C  TASK-126 → TASK-127            进度契约 + 协议文档 + 一致性测试；接入 agent_blocker
Phase D  TASK-122 → TASK-123 → TASK-124 协议族声明、Parser、Usage
         TASK-125                        Activity / Progress 视图
Phase E  TASK-132, TASK-133, TASK-120, TASK-121（独立小项，可穿插）
```

约束：**TASK-119 必须先于 TASK-128**（tick 归属）；**TASK-129 必须在 TASK-131 之前**
（Modal 数据源先切换，再做 Inbox 页面）；TASK-121 最后做（依赖分类与 Watchdog 都稳定）。

---

## 18. 完成定义

除 `teskra-tasks.md` §30 的通用 DoD 外：

- 三个 migration 与 plan §139.1 逐列一致，每条约束有「让它失败」的测试。
- `check:task-docs` 对 Milestone 25 通过。
- 协议文档一致性测试纳入 `test:unit`。
- `[Windows 验证]` 项（Doctor 凭据检查的大小写、Fake Agent 结构化流 E2E）在 Windows 11
  主机实测并记入 Milestone 25 验证记录；未验证的显式列出，不勾选。

---

## 19. 后续（不在本 Milestone）

- **Autopilot / 定时触发 Workflow**：需要 UI 退出后仍在运行的宿主，与 plan §73「拆 Agent
  Daemon」一起做。届时 Multica 的 daemon 参数可作参考：心跳 15 秒、离线判定 ≤ 3 分钟、
  WebSocket 唤醒 + 30 秒轮询兜底、每 daemon 20 / 每 agent 6 并发、批量 claim。
- **`question` 答案回传给进程**：需要 stdin 协议或 CLI 侧的 MCP 通道。
- **ACP / JSON-RPC 协议族**：`output.structured` 已为其预留枚举位。
- **Skills / Playbook 沉淀**：Workspace Memory 已覆盖；Multica 的 skills 在评测中被指出
  容易随仓库过期，暂不做。

---

## 20. 参考来源与 License 约束

- [multica-ai/multica](https://github.com/multica-ai/multica) — Apache-2.0 加附加条款；**仅行为参考**。
- [Multica Docs: Runs](https://multica.ai/docs/tasks)、[Daemon and runtimes](https://multica.ai/docs/daemon-runtimes)、
  [Security model](https://multica.ai/docs/security-model)、[CLI_AND_DAEMON.md](https://github.com/multica-ai/multica/blob/main/CLI_AND_DAEMON.md)。
- [multica-ai/multica-cli](https://github.com/multica-ai/multica-cli) — SKILL.md 与 lint 的做法。
- 本仓库：ADR-0002 / 0004 / 0010、`docs/code-review-2026-09-21.md` P1-6、TASK-084 / 085 / 107。
