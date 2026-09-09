# ADR-0002：Permission System 改为「策略下发 + 事后审计」

- 日期：2026-09-09
- 状态：Accepted
- 取代：plan §41–§44 的原始设计

## 背景

原方案（plan §41–§44、TASK-064~066）假设 Teskra 可以在 Agent 执行命令**之前**
拦截命令、弹出审批框、根据用户选择放行或拒绝。

这在当前架构下**不可能实现**：

```text
Codex / Claude CLI
  └─ 自己在 PTY 内 fork 子进程执行 shell 命令
        └─ Teskra 只能看到 PTY 的 stdout 字节流
```

Teskra 是 PTY 的**宿主**，不是 Agent 的**系统调用网关**。
当 `rm -rf` 的字符出现在输出流里时，命令早已执行完毕。
TASK-065 原验收标准「高风险命令默认不静默执行」在纯 PTY 包装下无法满足。

唯一能真正拦截的是 Agent CLI 自己的审批机制。

## 决策

PermissionManager 的职责重新定义为三层，**不包含执行拦截**：

### 1. 策略下发（Policy Projection）

Teskra 维护统一的权限策略模型，在启动 Agent 时**翻译成各 CLI 自己的机制**：

```text
TeskraPermissionProfile
  ├─→ Claude Code：settings.json permissions / hooks(PreToolUse)
  ├─→ Codex：approval mode + sandbox 参数
  └─→ 未来 Agent：由 AgentDefinition 声明如何映射
```

`AgentDefinition` 增加 `permissionMapping` 能力声明。
无法映射的 Agent 标记为 `permissionEnforcement: "none"`，UI 必须显式提示。

### 2. 环境级隔离（Environment Enforcement）

真正的硬边界由运行环境提供，而不是靠策略文件：

- Reviewer → `disposable-snapshot` worktree（ADR 见 plan §126）
- **Orchestrated Agent → 只在 worktree 内运行，主工作区不可写**
- 危险操作的最终防线是 Merge Preflight，不是执行前审批

#### 适用范围（2026-09-09 修订）

原文写「所有 Agent 只在 worktree 内运行」，但 Worktree 到 Phase E 才实现，
真实 Codex / Claude 在 Phase B 就接入——**这条约束与开发顺序直接冲突**。

按 Run 的**驱动方式**区分，而不是一刀切：

| 模式 | 出现阶段 | 隔离要求 |
|---|---|---|
| **Attended**：用户手动选 Agent、手动点启动、全程盯着 Terminal | Phase B（MVP-1） | 允许直接在主工作区运行，但 UI 必须有醒目警告 |
| **Orchestrated**：Workflow / Dispatch / Review Panel / Iterate 自动调度 | Phase E 起 | **强制** worktree 隔离，无例外 |

理由：Attended 模式在能力上不超过用户今天直接开两个终端跑 CLI，
风险由用户实时承担；引入 Workbench 并没有放大风险。
而 Orchestrated 模式下无人盯屏、多 Agent 并发写同一目录，
没有 worktree 隔离必然互相覆盖。

**硬性要求**：

- `AgentRun` 增加 `executionMode: "attended" | "orchestrated"` 字段。
- `orchestrated` 且 `worktree_id IS NULL` 时，AgentManager **必须拒绝启动**
  （不是警告，是拒绝）。Phase E 之前 Workflow 尚未实现，该分支不会被触发。
- `attended` 模式在 Agent Run 面板与 Terminal 顶部显示常驻横幅：
  「直接修改主工作区，未做隔离」。
- Phase E 完成后，`attended` 模式增加「在隔离 worktree 中运行」选项，
  并逐步改为默认值。

#### 无隔离并发的硬限制

仅有 `executionMode` 还不够：Phase B 允许多 Agent 同时运行，
若两个都是无 worktree 的**可写** Agent，仍会互相覆盖文件。

因此增加与 worktree 状态耦合的并发规则，**优先级高于**
`ConcurrencyPolicy`（plan §147）的数值配置：

```text
同一 Workspace 内：

  无 worktree + 可写（attended write）   最多 1 个
  无 worktree + 只读（review/analysis）  可并行，不计入上述名额
  有 worktree                            按 ConcurrencyPolicy 正常并发
```

即 `maxRunsPerWorkspace = 3` 不会放行 3 个无隔离写 Agent——
第二个可写 attended run 会被拒绝，并提示
「已有 Agent 正在直接修改此工作区，请先停止它，或等 Worktree 支持就绪」。

「可写 / 只读」由 `AgentStartRequest.approvalMode` 判定：
`read-only` 视为只读，其余一律视为可写。
无法确定时**保守按可写处理**。


### 3. 事后审计（Audit）

CommandClassifier 保留，但用途改为：

- 从 PTY 输出流识别已执行命令 → 打风险标签 → 写审计日志
- UI 在 Run 详情里高亮 `DESTRUCTIVE` / `NETWORK_WRITE` 命令
- Doctor / Recovery Center 可基于审计记录提示"这个 Run 执行过 git push"

**明确不做**：假装能拦截。UI 上不出现会误导用户的「Allow Once / Deny」弹窗，
除非该 Agent 的 `permissionEnforcement` 是 `native`（即 CLI 自身支持回调审批，
例如 Claude Code 的 permission-prompt-tool）。

## 影响

- TASK-064 保留（分类器仍需要，用途改为审计打标）。
- TASK-065 重写为 PermissionProfile + 策略投影 + 审计存储。
- TASK-066 重写：只在 `permissionEnforcement: "native"` 时提供交互审批 UI；
  其余情况提供审计视图。
- 新增 TASK-077：Agent 权限能力声明与策略投影。
- Milestone 19 的目标从"Workbench 自己拥有上层安全策略"
  改为"Workbench 统一管理各 Agent 的权限策略并留存审计"。

## 备注

如果未来要做真正的执行拦截，可行路径是：
让 Agent 运行在 Teskra 提供的受限 shell / 容器 / seccomp 沙箱里，
即 Teskra 成为 Agent 的执行环境提供方。这属于 V2 之后的范围。
