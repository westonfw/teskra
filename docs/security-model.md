# Teskra 安全模型

> 面向用户的直白说明：Teskra 能保护什么、不能保护什么，以及如何把真正的边界建在对的地方。
> 架构层面的裁决见 `docs/decisions/0002-permission-system-policy-and-audit.md`（ADR-0002）。

## 1. Run 拥有你的全部权限

每个 Agent Run 都是 Teskra 通过 PTY 启动的普通子进程，它以 **Teskra 进程所属 OS 用户的
全部权限**执行。请务必理解以下四点：

- **Worktree 是便利隔离，不是安全边界。** Git worktree 防止多个 Agent 互相覆盖文件、
  让改动可以独立 Review 与合并，但它不阻止 Agent 读写 worktree 之外的任何路径——
  你的主工作区、主目录、其它项目，Run 都能访问。
- **`full-auto` 意味着审批被 CLI 自动通过。** 该模式下 Agent CLI 不再逐条询问，
  命令直接执行。请只在你信任任务内容、且已建好环境级边界时使用。
- **Teskra 无法做执行前拦截（ADR-0002）。** Teskra 是 PTY 宿主而非系统调用网关：
  Agent CLI 自己在 PTY 内 fork 子进程执行 shell 命令，当 `rm -rf` 出现在输出流里时，
  命令早已执行完毕。Teskra 的权限体系 = 策略下发（翻译成各 CLI 自己的审批机制）+
  环境级隔离 + 事后审计，**不包括**在执行前拦截命令。
- **审计是 best-effort 的。** 命令识别基于输出流的启发式匹配，审计表为空
  不等于没有执行过命令。

## 2. 凡 Teskra 进程环境可达的凭据，都应视为 Run 可读

Run 继承 Teskra 主进程的环境。以下凭据对任何 Run 都是明文可读的：

- `process.env` 里的环境变量（API key、token 等）；
- Workspace 配置中注入的 `env`（包括从 Credential Store 取出的条目）；
- `~/.ssh` 下的私钥、git 凭据助手缓存的凭据；
- 各 Agent CLI 的登录态（CLI 配置目录里的会话 / token 文件）。

**Credential Store 只保证落盘加密。** 密钥注入到 Run 的环境之后即为明文，
Agent 可以读取并外传。它能防止的是"凭据明文躺在你磁盘上的配置文件里"，
不能防止"被启动的 Agent 读到凭据"。

Doctor 的 `credential-exposure` 检查（只读）会列出当前会被 Run 继承的、
名字看起来像密钥的环境变量**键名**（绝不读取或显示值），帮助你盘点暴露面。

## 3. 推荐的真正边界

想要硬边界，就把它建在 OS / 凭据层面，而不是指望 Workbench：

- **专用 Windows 用户或专用 WSL distro** 跑高风险 Run，让 OS 的权限模型兜底；
- **按用途的 deploy key**：给 Agent 用的仓库另配只读或单仓库的 deploy key，
  而不是复用你的个人 SSH key；
- **最小权限 token**：只授予 Agent 账号完成任务所需的最小 scope，
  用完即吊销；不要把全权限个人 token 放进环境变量。

## 4. Teskra 实际做了什么

在"无法执行前拦截"的前提下，Teskra 提供的缓解措施：

- **per-Run 目录**：Handoff / Artifact 等运行期产物写在 `<dataRoot>/runs/<runId>/` 下，
  不落在仓库里（ADR-0004）；
- **per-Profile CLI Home**（ADR-0009）：多账号通过独立的 CLI 配置根隔离
  （`CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `KIMI_CODE_HOME`），「账号即环境」，
  不同订阅账号的登录态互不串扰；
- **`.git/info/exclude` 纵深防御**：WorktreeManager 把 `<repo>/.teskra/handoff/` 与
  `<repo>/.teskra/artifacts/` 写入 `.git/info/exclude`，降低运行期产物被误提交的概率；
- **日志脱敏**：`sk-` / `ghp_` / `*_TOKEN` 等 secret 不会出现在日志里（有单测断言）；
- **shell 步骤一次一批**：Workflow 的 shell 步骤按批确认执行，不逐条伪装成交互审批；
- **orchestrated 强制隔离**：`orchestrated` 模式的 Run 没有 worktree 时拒绝启动；
  `attended` 模式直接改主工作区时 UI 有常驻横幅提醒（ADR-0002）。

这些措施降低事故概率与爆炸半径，但不改变第 1、2 节的事实：
**Run 的权限上限就是你的权限上限。**
