# ADR-0013：结构化输出流只用于观测，不用于控制

- 日期：2026-09-21
- 状态：Accepted
- 相关：ADR-0004（不解析 stdout）、ADR-0010（限额是失败原因）

## 背景

Claude Code 在 `--print` 下支持 `--output-format stream-json`，Codex 在 `exec` 下支持
`--json`，两者都在 stdout 上输出 NDJSON 事件流（session、assistant 消息、tool call /
result、usage、result）。Multica 正是靠解析这类流做出「回放每次 tool call」的执行日志
和按 Run 的 token / 成本统计。

Teskra 目前只有 PTY 原始字节与 `auditCommandPatterns` 正则启发式，没有 usage 统计。
但 ADR-0004 明确「不解析 stdout」，其理由（ANSI、折行、TUI）对 **interactive** 模式
完全成立，对 **exec 模式下 CLI 明确声明为机器可读的 NDJSON 流** 则不成立。

## 裁决

1. **`AgentDefinition` 声明输出协议族**：`output.structured: 'none' | 'claude-stream-json' | 'codex-exec-json'`
   与对应的 `structuredArgs`。缺省 `none`。声明只表示「Teskra 知道怎么解析」，
   不表示「一定能解析」。

2. **只在 `mode === 'exec'` 且 `observability.structuredStream` 开启时解析。**
   interactive 模式的行为不变；关闭配置后 exec 模式行为与现在完全一致。

3. **解析结果是观测（`AgentObservation`），允许的用途仅限：**
   - Activity 视图（tool call 时间线）；
   - `agent.command` 审计（结构化来源优先于正则，同一 Run 内二者不重复）；
   - usage 计量（`agent_run_usage`）；
   - `providerSession` 缺失时补写 session id（元数据）；
   - 作为 ADR-0010 §4 允许的「结构化错误」证据供 FailureClassifier 使用。

4. **禁止的用途：**
   - 驱动 `AgentRunStatus` 迁移；
   - 单独触发终止（仍需进程退出或 ADR-0010 §4 的组合条件）；
   - 作为 Handoff / ReviewFinding / CriterionScore 的来源（ADR-0004 不变）；
   - 替代 `terminal.log`——原始字节仍完整落盘，`readOutput` 语义不变。

5. **解析失败是常态而非错误。** 未知 `type`、非 JSON 行、超长行（> 64 KiB）一律忽略并计数，
   Run 结束时写一条 `agent.observation_summary`；解析失败率不影响 Run 结果。
   每种协议的测试 fixture 必须来自真实 CLI 输出并记录版本。

6. **不自行估算成本。** 只记录流里 provider 报告的 `cost`；缺失存 NULL，UI 显示「未报告」。

## 与 ADR-0004 的关系

ADR-0004 的「不解析 stdout」针对的是把 stdout 当作**权威结果**（Handoff）。本 ADR
把 exec 模式的 NDJSON 流当作**观测信号**：允许漏、允许错，不允许它决定任何事。
两者并存：Handoff 仍只来自文件。

## 影响

- 新增 `agents/observation/`（line splitter、两个协议归一化器、recorder）。
- `agent_events` 新增事件类型 `agent.observation` / `agent.observation_summary`。
- exec 模式的 Terminal 视图会看到原始 JSONL；Run 详情默认落在 Activity Tab。
- 新增 `observability` 配置组。
