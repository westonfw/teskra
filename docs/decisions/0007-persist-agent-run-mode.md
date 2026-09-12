# ADR-0007：AgentRun 持久化启动模式（`agent_runs.mode`）

- 日期：2026-09-12
- 状态：Accepted

## 背景

AgentRun 的启动模式（`interactive` | `exec`）决定 CLI 跑完一轮后是否退出：
`exec`（headless）跑完即退出，`interactive` 回到提示符等待输入。
而 resume（TASK-042）在 ADR-0007 之前**硬编码 `interactive`**，因为 run 记录
（plan §139.1 `agent_runs`）没有保存启动模式。

后果：workflow 产生的 exec run 一旦被中断（崩溃/重启），从 Recovery Center
resume 后会以 interactive 重启——codex 干完活回到提示符，进程永不退出，
run 永远 `running`，`agent.completed` 不触发，auto-commit 与 criteria 评分
全部停摆（与 workflow 用 interactive 启动 agent 的卡死同源）。

## 裁决

1. `agent_runs` 新增可空列 `mode TEXT`（migration `009_agent_run_mode`），
   `agentRunSchema` 同步增加可选字段。§139.1 是 schema 权威，本 ADR 记录该
   增量（不改变任何既有列语义；`mode` 只在 create 时写入，永不更新）。
2. `AgentManager.start` 在创建 run 记录时持久化解析后的 mode
   （`request.mode ?? 'interactive'`）。
3. `AgentManager.resume` 按持久化的 mode 重启：
   `run.mode === 'exec' && definition.capabilities.headless ? 'exec' : 'interactive'`。
   009 之前的存量行（`mode` 为 NULL）和不支持 headless 的 CLI 保持
   旧行为（interactive），不产生启动失败。
4. 不做 `waiting_for_user` 检测（解析 TUI 输出违反 ADR-0004 的不解析
   stdout 原则；需要机器可读信号，超出本裁决范围）。

## 影响

- workflow 产生的 run（引擎恒以 exec 启动）中断后 resume 回到 exec，
  跑完自动 completed，auto-commit / handoff / criteria 链路恢复。
- attended 的 interactive run resume 行为不变。
- Repository / contracts / IPC 投影增加可选 `mode` 字段，向后兼容。
