# ADR-0012：Agent 运行中的进度与阻塞走追加式文件契约

- 日期：2026-09-21
- 状态：Accepted
- 扩展：ADR-0004（Handoff 文件契约）

## 背景

ADR-0004 确立了「Handoff 走文件、不解析 stdout」，但 Handoff 是**终态**产物：
Agent 退出后 Teskra 才读。运行中 Agent 想说「我卡在 X」「需要澄清 Y」「完成了 60%」，
目前只能打进 PTY 输出，Teskra 无法区分这是给人看的叙述还是给系统的信号。

Multica 的做法是给 Agent 一个反向 CLI（评论、报 blocker、改状态）。Teskra 没有 server，
也不想给 Agent 一个能改 Run 状态的写入口——那会绕开 ADR-0002 的审计边界。

## 裁决

1. **新增一个追加式进度文件**，路径由 `paths.runFiles(runId)` 解析，通过环境变量交给 Agent：

   ```text
   TESKRA_PROGRESS_PATH=<dataRoot>/runs/<runId>/progress.jsonl
   ```

   Agent 每行追加一个 JSON 对象，Schema 为 contracts 的 `agentProgressEventSchema`
   （`kind: progress | blocker | question | note`，`message`，可选 `percent` / `at` / `data`）。

2. **Teskra 只读、只观测。** 进度事件：
   - 刷新 `lastOutputAt`（Agent 在写进度就不算静默）；
   - 持久化为 `agent.progress` 事件（`events.jsonl` + `agent_events`）并广播；
   - `blocker` / `question` 生成一条 PendingDecision（ADR-0014）。
   - **不改变 Run 状态**，不终止进程，不作为 Handoff 或 ReviewFinding 的来源。

3. **读取方式是轮询，不是 `fs.watch`。** Windows + WSL2 跨边界文件系统上 `fs.watch`
   不可靠；1 秒轮询、只读新增字节的成本可忽略。

4. **失败不阻塞。** 坏行跳过并计数；单行 > 8 KiB 跳过；文件 > 4 MiB 停止跟随并记录；
   文件不存在是常态而非错误。持久化前先过 `redactSecrets`。

5. **文档与实现绑定。** Agent 读的协议说明（`resources/prompts/teskra-agent-protocol.md`）
   必须与 `cli-agent-adapter.ts` 实际注入的 `TESKRA_*` 变量集合、与 `agentProgressEventSchema`
   的 `kind` 枚举一致，由单测断言；文档漂移让 `test:unit` 失败。

## 不做的事

- 不做 Agent → Teskra 的命令通道（改状态、评论、触发别的 Run）。
- 第一版不把 `question` 的答案回传给进程；答案记入 Decision resolution，
  在下一次 Continuation 的 `{{previousHandoff}}` 中带上。

## 影响

- `AgentStartRequest` 增加 `progressPath`；`RunPaths` 增加 `progress`；
  `runLogFiles()` 纳入 `progress.jsonl`（RetentionService 同策略回收）。
- Prompt 模板增加「Progress (optional)」段与 `{{env.TESKRA_PROGRESS_PATH}}` 变量。
- Fake Agent 增加写进度文件的场景，供 E2E 使用。
