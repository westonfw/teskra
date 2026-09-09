# ADR-0004：Handoff / Artifact 走文件契约，不解析 stdout

- 日期：2026-09-09
- 状态：Accepted

## 背景

TASK-051 要求 WorkerHandoff「可从 Agent output 生成」，
但 plan §49 又明确说「第一版不要过度解析」，二者矛盾。

从 PTY 的原始字节流里 parse 结构化 JSON 极其脆弱：

- ANSI 转义序列、光标移动、进度条重绘会切碎 JSON
- Agent 可能把 JSON 折行、加代码围栏、加解释性文字
- TUI 型 Agent（Codex 交互模式）根本不会把结果打到 stdout

## 决策

**Handoff 和结构化 Artifact 通过文件系统交付，不从 stdout 解析。**

### 契约

Teskra 在启动 Agent 时，通过 Prompt Template 注入一段明确指令，
并在环境变量里给出输出路径：

```text
TESKRA_RUN_ID=<runId>
TESKRA_HANDOFF_PATH=<worktree>/.teskra/handoff/<runId>.json
TESKRA_ARTIFACT_DIR=<worktree>/.teskra/artifacts/<runId>/
```

Agent 完成后写入 `TESKRA_HANDOFF_PATH`，Schema 见 plan §125。

### Teskra 侧处理

```text
Agent 进程 exit
  ↓
读取 TESKRA_HANDOFF_PATH
  ├─ 存在且通过 Zod 校验 → 结构化 Handoff
  ├─ 存在但校验失败      → 保留 raw 文件，Handoff = degraded，记 warning
  └─ 不存在              → Handoff = null，回退到 terminal.log 摘要
```

**任何情况下都不阻塞 Run 完成**，也不因为 parse 失败丢弃 raw output。
`events.jsonl` 和 `terminal.log` 始终是完整的真相来源。

### stdout 的用途

stdout 只用于两件事：

1. 原样送给 xterm.js（Terminal View）
2. 轻量启发式识别高价值事件（`command` / `error` / `waiting`），
   用于 Activity View 和审计打标。**允许漏、不允许错误地当成权威结果。**

### `.gitignore`

`<repo>/.teskra/handoff/` 和 `<repo>/.teskra/artifacts/` 是运行期产物，
必须写入 `.gitignore`，否则会污染 Agent 的 diff。
WorktreeManager 在创建 worktree 后负责确保这一点
（写入 `.git/info/exclude`，而不是修改用户的 `.gitignore`）。

## 影响

- TASK-051 重写：Handoff 来源改为文件契约。
- 新增 TASK-079：Prompt Template 外置与变量注入（plan §102）。
- TASK-050 ArtifactStore 增加「从 TESKRA_ARTIFACT_DIR 收集」的入口。
- `AgentStartRequest` 增加 `handoffPath` / `artifactDir` 字段。
