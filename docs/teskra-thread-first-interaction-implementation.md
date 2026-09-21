# Teskra 线程优先交互实施方案

> Milestone 26（TASK-134～140）。本文是设计说明与「为什么这么定」；
> TASK 编号、优先级、依赖与验收标准的**唯一权威**在 `docs/teskra-tasks.md`
> Milestone 26，§14 只是带设计理由的副本（`npm run check:task-docs` 校验两者一致）。
> 本 Milestone **没有新的 migration**，不新增 ADR；它建立在 ADR-0004 / 0012 / 0013 / 0014 之上。

---

## 1. 背景

Teskra 当前的交互是**表单在前、对话在后**：

- Task 页先建 Task，再在启动卡片里选 Agent、填 prompt、选账号、点 Start，然后在 xterm 里
  和 CLI 自己的 TUI 对话。Run 的 `prompt` 和结果是两个孤立字段，Teskra 没有「对话」这个对象。
- Workflow 弹窗要求填 implementer、reviewers、test command 三项，或者提前手写仓库里的 YAML。

对照两类工具：

- **Multica**：Issue 是线程，指派给 agent 触发一次 Run；之后每条 @mention 评论再触发一次 Run，
  并续用上一次的 session；另有不建 Issue 的 chat 面板。**对话是工作单元，配置是默认值。**
- **Claude Code / Codex / Cursor**：对话是主对象，配置靠默认值与斜杠命令。

Teskra 要借鉴的不是「用聊天替代配置」，而是**把 Run 序列呈现为线程、把配置降级为默认值和
指令**。这几乎不需要新的运行时能力：resume（TASK-042）、Continuation（TASK-107）、
`run.prompt`、Handoff `summary`、Milestone 25 的 `assistant_text` 观测（ADR-0013）与
`progress` / `question` 事件（ADR-0012）已经把线程需要的每一块都准备好了。

---

## 2. 产品目标

1. **零配置启动。** 一个输入框、一个发送键就能在当前 Workspace 跑起来；Agent、账号、
   模式、worktree 全部有可解释的默认值，高级项折叠。
2. **从消息建 Task。** 不必先填表；首行成标题，Task-first 架构不变，只是入口反过来。
3. **对话式续聊。** 同一 Task 下连续发送消息 = 连续的 Run，续用 CLI 自己的 session；
   Agent 的回复、进度、提问按时间线呈现。
4. **配置可以打在消息里。** `/agent`、`/account`、`/workflow`、`@<agent>` 等指令映射到
   现有请求，IPC 契约不变。
5. **Workflow 一键启动。** 三个字段全部可选，默认值来自 AgentRegistry 与仓库 YAML。

---

## 3. 非目标与边界

- **Teskra 不与 CLI 的 TUI 对话。** 线程模式只走 `mode: 'exec'`；interactive 模式保留 xterm
  作为逃生口，二者在 UI 上并列而不是互相伪装。不解析 TUI 输出（ADR-0004）。
- **不做 stdin 协议。** 一轮 = 一个进程；`question` 的答案作为下一轮的消息，不回灌到
  运行中的进程（ADR-0012 的口子在这里闭环）。
- **不引入新表。** 线程是 Run / Handoff / 观测 / 进度 / Decision 的**投影**（read model），
  不是第二份真相。
- **不放松 ADR-0002。** exec 模式没有审批提示：Claude `--print` 下权限被拒只报告不询问。
  因此线程模式的默认组合是 **worktree 隔离 + `safe-auto`**；`attended + manual` 只能从
  终端启动，线程输入框对该组合直接拒绝并给出解释。
- **不做自然语言路由。** `/agent` 是显式指令；「让模型猜该用哪个 Agent」不在范围内。
- **不改 Workflow 定义格式。** YAML 仍是可重复流水线的载体；本 Milestone 只改启动器。

---

## 4. 现状盘点（写方案前核实过的事实）

- `startAgentRunRequestSchema`（contracts `agent.ts`）：`workspaceId` / `agentType` 必填，
  `taskId` / `accountProfileId` / `executionProfileId` / `role` / `model` / `mode` /
  `approvalMode` / `executionMode` / `worktreeId` / `prompt` / `environment` 可选。
- Task 页启动卡片（`tasks/task-page.tsx`）固定发 `executionMode: 'attended'`、
  `approvalMode: 'manual'`，用户必须选 Agent；没有 `mode` 选择（默认 interactive）。
- `startReviewRunRequestSchema` 已能按 `taskId` 解析目标 worktree 并以 reviewer 角色启动（TASK-052）。
- `AgentRoutingProfile`（`routing.priority` / `useWhen` / `strengths` / `costClass`）只用于
  Agent Picker 排序与展示，**没有自动选择器**（TASK-089 验收项只到「排序」）。
- 默认账号：`AccountProfileManager.getDefault(agentId)` 读 `config.agents.defaultAccountProfiles`（TASK-101）。
- Workflow 启动：`fullWorkflowStartRequestSchema` 的 `implementer` / `reviewers` / `testCommand`
  在契约层已是可选，默认来自 `AgentRegistry.defaults.role` 与 `DEFAULT_FULL_TEST_COMMAND`；
  **弹窗仍把三项当必填展示**。
- Continuation（TASK-107）：`continueAgentRunRequestSchema` 的 `reason` 枚举为
  `rate-limit | agent-failure | manual-switch`；目标 Run 在源进程确认退出后创建，同 worktree，
  `providerSession` 存在则 resume；`buildContinuationPrompt` 会带上一轮 Handoff 与输出尾部。
- `createTaskRequestSchema`：`title` 1～`IPC_NAME_MAX`，`description` 可选；
  Task 状态 `draft | ready | running | needs_review | blocked | completed | failed | cancelled`。
- 导航：home / workspace / tasks / runs / git / terminal / doctor / recovery / settings。

---

## 5. 交互模型：线程 = Task 下的 Run 序列

```text
Task
 ├─ Turn 1   user: "把登录页改成 OAuth"            → AgentRun#1 (exec, worktree W, session S)
 │           agent: assistant_text… / progress… / handoff.summary
 ├─ Turn 2   user: "测试也要补"                    → AgentRun#2 (resume S, worktree W)
 │           agent: question "用 vitest 还是 jest？" → Decision(agent_blocker, info)
 ├─ Turn 3   user 在线程里回答 "vitest"             → AgentRun#3 (resume S)
 ├─ system   @claude review                        → ReviewRun (reviewer, worktree-readonly)
 └─ system   /workflow full                        → WorkflowRun（折叠为一个卡片，展开看步骤）
```

- **线程项（ThreadItem）** 是投影，来源固定为五种：`user_message`（`run.prompt` + `createdAt`）、
  `agent_reply`（`assistant_text` 观测拼接 + Handoff `summary`）、`agent_progress`（ADR-0012）、
  `decision`（ADR-0014，open / resolved 都显示）、`system`（Review / Workflow / 状态变化）。
- **一轮 = 一个 Run。** 用户发消息就是 `start` 或 `continue`；没有「正在打字」态，
  Run 的状态就是这轮的状态。
- **线程与终端并列。** exec Run 的 Terminal Tab 仍显示原始输出；interactive Run 在线程里
  只显示一条「在终端中运行」的系统项并链接过去。

---

## 6. 默认选择（DefaultSelectionService）

新增 `apps/desktop/src/main/agents/default-selection-service.ts`，IPC
`teskra:agent:resolve-defaults { workspaceId, role? }` → `ResolvedRunDefaults`：

```ts
{
  agentType,            // 见下
  accountProfileId?,    // AccountProfileManager.getDefault(agentType)
  executionProfileId?,  // config.agents.defaultExecutionProfiles[agentType]
  mode: 'exec',
  executionMode: 'orchestrated',
  approvalMode: 'safe-auto',
  isolation: 'worktree',
  reasons: string[],    // 每个字段为什么选了这个值（i18n key + 参数），UI 展示
}
```

`agentType` 的选择顺序（全部可解释，写进 `reasons`）：

1. `config.agents.defaultAgent`（新增配置键，global / workspace 层可写）；
2. 当前 Workspace 最近一次成功 Run 使用的 Agent；
3. 按 `role`（缺省 `implementer`）匹配 `defaults.role` 的已安装、健康（AgentHealth 非
   `unavailable` / `rate-limited`）Agent 中 `routing.priority` 最高者；
4. 任意已安装 Agent 中 `routing.priority` 最高者；
5. 无 → `VALIDATION_FAILED`，UI 引导去 Settings → Agents。

同一服务给 Workflow 启动器提供 implementer（role `implementer`）与 reviewers（role `reviewer`
的全部健康 Agent，去掉 implementer）。

---

## 7. 消息指令

在 `packages/shared` 增加纯函数 `parseMessageDirectives(text)`（无 IO，可单测）：

```text
/agent <id>                     → agentType
/account <alias|id>             → accountProfileId（alias 经 ProfileAliasManager 解析，ADR-0011）
/mode attended|isolated         → executionMode（attended = 无 worktree；isolated = orchestrated + worktree）
/approval read-only|manual|safe-auto|full-auto
/model <name>
/workflow full [--test "<cmd>"] → 启动默认 Full Workflow（TASK-063）而不是单个 Run
@<agentId> <text>               → 以 reviewer 角色对本 Task 最近一次有 worktree 的 Run 启动 Review（TASK-052）
```

规则：

- 指令只允许出现在消息**开头的连续行**；剩余文本是 prompt。
- 未知指令、非法取值 → 不启动，返回带位置的解析错误（`VALIDATION_FAILED`，i18n）。
- `attended` + `manual` 在线程输入框被拒绝并解释（§3）；用户可点「在终端中启动」走原路径。
- 指令解析结果只是对 `ResolvedRunDefaults` 的覆盖，最终仍组装成现有的
  `StartAgentRunRequest` / `StartReviewRunRequest` / `FullWorkflowStartRequest`。
- 输入框提供 `/` 与 `@` 的自动补全（来自 AgentRegistry 与账号列表），不做自由文本猜测。

---

## 8. 线程投影（ThreadProjection）

`apps/desktop/src/main/tasks/thread-projection.ts`，IPC
`teskra:task:thread { taskId, afterCursor?, limit? }` → `{ items: ThreadItem[], nextCursor? }`。

- 数据源：`agent_runs`（按 `created_at`）、`handoffs`、`agent_events`（`agent.observation`
  的 `assistant_text`、`agent.progress`）、`pending_decisions`、`workflow_runs`。
- `agent_reply` 的正文 = 该 Run 所有 `assistant_text` 观测按 seq 拼接（上限 32 KiB，超出截断并标记）；
  没有结构化流的 Run 用 Handoff `summary`；两者都没有用 `terminal.log` 尾部 2000 字符
  （复用 handoff-collector 的 fallback 规则，并标记 `source: 'terminal'`）。
- 游标 = `(createdAt, id)`，稳定分页；增量更新靠渲染层订阅 `agent.*` / `decision.*` /
  `workflow.run_updated` 后按 Run id 局部刷新，不整页重拉。
- 投影是只读的，不写任何表；Repository 提供按 Task 的批量读取，Manager 不写 SQL。

---

## 9. 续聊语义与安全约束

发送消息时（`teskra:task:send-message { taskId, text }`，Main 侧统一处理指令与默认值）：

1. 解析指令 → 覆盖默认值 → 若为 `/workflow` 或 `@mention` 走对应入口。
2. 否则找该 Task **最近一次** `mode === 'exec'` 的 Run：
   - 若它已终态、`providerSession` 存在、worktree 仍 `ready` / `dirty` 且未被其它非终态 Run 占用、
     且新消息没有改变 Agent / 账号 / 模式 → **续聊**：`continueWithProfile` 的新 reason
     `user-message`，目标 Run 同 worktree、resume session，`buildContinuationPrompt` 的
     `userMessage` 段放用户文本（新增参数，放在 Handoff 上下文之后）。
   - 若它仍在运行 → 拒绝（`CONFLICT`，「等这一轮结束」），UI 把消息留在输入框；
     不做排队（排队会让用户误以为消息已送达）。
   - 否则 → **新一轮**：普通 `start`，worktree 由 FullWorkflowService 同款逻辑预建。
3. `question` Decision 的解决：用户在线程或 Inbox 里回答 → 回答文本作为下一条消息按第 2 步处理；
   Decision `resolution.note` 存回答。

安全约束：

- 线程模式强制 `mode: 'exec'`；`approvalMode` 缺省 `safe-auto`；`attended` 必须显式 `/mode attended`
  且不允许 `manual`。
- `continueAgentRunRequestSchema.reason` 增加 `user-message`；流程 B（源仍在运行）对该 reason
  直接拒绝，不跑分类器（延续 P1-2 的原则）。
- 每条用户消息受 `IPC_TEXT_MAX` 约束；指令区受 `IPC_NAME_MAX`。

---

## 10. Workflow 启动器

- 弹窗改为两态：默认态只显示「用 <implementer> 实现，<reviewers> 审查，测试命令 <cmd>」一句话
  摘要与「启动」；「修改」展开原三项。摘要来源 = §6 的服务 + 仓库 `full.yaml`（Trusted 才读）。
- `/workflow full` 与弹窗走同一条 `FullWorkflowStartRequest`。
- 启动后线程里出现一个 `system` 项（Workflow 卡片），展开显示步骤状态；shell 确认与
  Criteria Gate 的等待通过 Decision 项出现在同一线程里。

---

## 11. Contracts / IPC / Events

新增 contracts：`thread.ts`（`ThreadItem` 判别联合、`taskThreadRequestSchema`、
`sendTaskMessageRequestSchema`）、`run-defaults.ts`（`ResolvedRunDefaults`）、
`message-directives.ts`（指令解析结果类型；解析函数在 `packages/shared`）。

```text
teskra:agent:resolve-defaults   { workspaceId, role? }                → ResolvedRunDefaults
teskra:task:thread              { taskId, afterCursor?, limit? }      → { items, nextCursor? }
teskra:task:send-message        { taskId?, workspaceId, text }        → { taskId, kind: 'run'|'review'|'workflow', id }
                                 （taskId 缺省时从首行建 Task）
```

配置：`agents.defaultAgent?: string | null`（global / workspace）。
`continueAgentRunRequestSchema.reason` 增加 `'user-message'`。
事件：不新增；线程增量更新复用 `agent.created / started / completed / failed / cancelled /
observation / progress`、`decision.opened / resolved`、`workflow.run_updated`。

---

## 12. UI

- **Task 页**：默认视图改为 Thread；底部常驻输入框（`/`、`@` 自动补全，Shift+Enter 换行）；
  输入框上方一行灰字显示当前默认值（「codex · 工作账号 · isolated · safe-auto」）并可点开修改；
  原「启动卡片」与 Runs 列表移到 `Runs` Tab；Terminal 仍可从任一 Run 打开。
- **Tasks 列表页**：顶部一个输入框「描述你要做的事…」，发送即建 Task 并进入线程。
- **Runs 页**：保留，Run 卡片增加「在线程中查看」。
- **Workflow 弹窗**：两态（§10）。
- 空状态：没有可用 Agent 时输入框禁用并给出「去 Settings 安装/检测」链接。
- 所有文案 i18n。

---

## 13. 测试策略

- `parseMessageDirectives`：指令表全覆盖、位置错误、未知指令、引号内含空格的 `--test`、
  `@` 与 `/` 混用、只有指令没有正文。
- DefaultSelectionService：五级回退各一测；健康状态过滤；`reasons` 与选择一致。
- ThreadProjection：五类来源各一测；分页游标稳定；`assistant_text` 拼接与 32 KiB 截断；
  无结构化流时回退 `summary` 再回退 `terminal.log`；只读（用只读连接跑一遍断言无写）。
- 续聊：续用 session 的四个条件各有反例；源 Run 运行中返回 `CONFLICT` 且不创建行；
  `attended + manual` 被拒；`user-message` 在流程 B 被拒且不跑分类器；`question` 回答成为下一轮消息。
- Workflow 启动器：无输入时用默认值启动；仓库 YAML 覆盖只在 Trusted 生效。
- E2E（软件渲染，Fake Agent）：在 Tasks 页输入两行文本发送 → Task 创建、线程出现用户消息与
  回复；再发一条 → 第二个 Run 以 resume 启动；`/workflow full` → Workflow 卡片出现。

---

## 14. 任务拆分

> 与 `docs/teskra-tasks.md` Milestone 26 逐项对应；改动请先改 tasks，再同步此处。

### TASK-134 — DefaultSelectionService：可解释的运行默认值

**优先级：P0**

**依赖：TASK-089, TASK-101, TASK-024**

理由：零配置启动的前提；Workflow 启动器与线程输入框共用。

### TASK-135 — 快速启动 UI 与从消息建 Task

**优先级：P0**

**依赖：TASK-134, TASK-034, TASK-092**

理由：不依赖 Milestone 25，先交付「一个输入框就能跑」。

### TASK-136 — 消息指令解析与映射

**优先级：P1**

**依赖：TASK-135, TASK-052, TASK-063, TASK-111**

理由：把配置从表单挪进输入框；解析是 `packages/shared` 纯函数。

### TASK-137 — Workflow 启动器默认值与两态弹窗

**优先级：P1**

**依赖：TASK-134, TASK-063, TASK-118**

### TASK-138 — ThreadProjection：Task 线程只读投影

**优先级：P0**

**依赖：TASK-123, TASK-126, TASK-128, TASK-032, TASK-051**

理由：线程是投影不是新表；依赖 Milestone 25 的观测、进度与 Decision。

### TASK-139 — 线程续聊：user-message Continuation

**优先级：P0**

**依赖：TASK-138, TASK-107, TASK-042, TASK-130**

理由：一轮 = 一个 Run；复用 Continuation，不做 stdin 协议。

### TASK-140 — 线程 UI 与 E2E

**优先级：P1**

**依赖：TASK-138, TASK-139, TASK-136, TASK-125**

---

## 15. 推荐实施顺序

```text
Phase 1（可在 Milestone 25 之前或并行）
  TASK-134 → TASK-135 → TASK-136
  TASK-137（独立）
Phase 2（Milestone 25 的 TASK-123 / 126 / 128 / 130 完成后）
  TASK-138 → TASK-139 → TASK-140
```

约束：**TASK-136 在 TASK-135 之后**（先有输入框再有指令）；**TASK-139 在 TASK-138 之后**
（先能看见线程再能续聊）。

---

## 16. 完成定义

除 `teskra-tasks.md` §30 的通用 DoD 外：

- `check:task-docs` 对 Milestone 26 通过。
- 从 Tasks 页只输入文本即可完成「建 Task → 首轮 Run → 续聊 → Review」全流程（E2E 覆盖）。
- 线程模式下不存在任何 `attended + manual` 的启动路径（有测试断言）。
- 所有默认值都能在 UI 里看到「为什么」。

---

## 17. 后续（不在本 Milestone）

- **`question` 答案回灌运行中的进程**：需要 CLI 侧 stdin / MCP 通道，暂不做。
- **自然语言路由**（由模型决定用哪个 Agent / 是否开 Workflow）：等 DefaultSelectionService
  的规则版稳定后再评估。
- **跨 Task 的 Workspace 级 chat 面板**：Multica 的「不建 Issue 也能聊」已由「从消息建 Task」覆盖，
  真正的 Task-less 会话待需求明确。
