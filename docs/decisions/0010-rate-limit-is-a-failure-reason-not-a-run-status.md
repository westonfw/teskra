# ADR-0010：限额是失败原因，不是 Run 状态

- 日期：2026-09-13
- 状态：Accepted

## 背景

多账号方案需要识别「这个 Run 是因为订阅额度用尽而失败的」，
以便向用户提供「换一个账号继续」的入口（Continuation）。

实施方案早期写的是给 Run 引入 `blocked` / `rate-limited` 两个新状态。
但 plan §17 的 `AgentRunStatus` 是一个已经相当宽的状态机
（created / queued / preparing / running / waiting_for_user /
waiting_for_permission / waiting_for_agent / reviewing / completed /
failed / cancelled / interrupted），每加一个取值，
Recovery、UI、并发计数、Workflow 引擎都要多处理一组组合。

而限额并不是一个新的生命周期阶段——Run 确实已经结束了，
只是结束的**原因**需要被记住。

## 裁决

1. **不为限额新增 Run status。** 限额失败的 Run 状态仍是 `failed`。
2. 原因落在 `agent_runs.failure_classification_json`
   （migration 013），`agentRunSchema` 增加可选
   `failureClassification?: AgentFailureClassification`
   （`kind` / `resetAt` / `retryable` / `evidence`）。
3. 分类由每个 Adapter 自己的 `AgentFailureClassifier` 产出，
   不在 AgentManager 里散落 `stdout.includes(...)`。
4. **纯 PTY 文本匹配不得单独触发终止。** 现有 `process.output` 是不区分
   stdout / stderr 的单一数据流，命中的 "quota exceeded" 可能来自 Agent
   复述、`cat` 出来的文件或正在 review 的 diff。要终止必须同时具备：
   进程已非零退出，或 Agent 提供了结构化事件 / 结构化错误。
   第一版只做这两种——让 Run 自然退出后再分类，不主动杀进程。
   弱信号可用于 UI 提示，但不改 Run 状态。
5. `evidence` 截断到 **512 字符**，先过 secret 掩码再入库。这是为 evidence
   单独定的安全上限，不是复用 `IPC_TEXT_MAX`（后者是 64 KiB，
   按它存等于把整段输出塞进审计记录）。
6. Teskra 主动停止并标记失败的路径必须走一个单一入口
   `failAndStop(runId, classification)`。不能走普通 cancel——
   现有 `process.exited` 处理按 `cancelRequested` 判定，
   凡主动停的 Run 一律写 `cancelled`，分类信息会丢失。

## 影响

- 重启后仍可判断哪个 Run 因限额失败，`resetAt` 不丢，
  「Continue with another account」入口可从库中恢复。
- Recovery / 并发计数 / Workflow 引擎无需处理新状态。
- `AccountProfile.status = 'limited'` 与 Run 的 `failed` 是两层信息：
  前者是账号当前可用性，后者是某次执行的结果。
