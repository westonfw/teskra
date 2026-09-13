# ADR-0009：AccountProfile 即完整 CLI Home

- 日期：2026-09-13
- 状态：Accepted

## 背景

多订阅账号支持（TASK-094～117）需要让同一个 Agent CLI 以多个独立身份运行。
唯一不越过官方认证边界的做法，是给每个 Profile 一份独立的 CLI 配置根：
Codex 用 `CODEX_HOME`，Claude Code 用 `CLAUDE_CONFIG_DIR`。

问题在于这两个目录承载的**不只是认证**：

- `CODEX_HOME`：用户配置（`config.toml`，含 MCP server 声明）、会话历史、认证
- `CLAUDE_CONFIG_DIR`：settings、凭据、session、plugins、skills

因此「隔离账号」在官方 CLI 的加载行为下必然等于「隔离整套 CLI 配置」。
这与实施方案早期设想的分层
（AccountProfile = 认证身份，ToolProfile = MCP，SkillProfile = Skills，
多个账号共享同一组 Tool / Skill 配置）直接冲突——那套分层要成立，
必须另有一层能把 Teskra 侧的规范模型投射进每个 Profile Home。

## 裁决

1. 第一阶段明确采用 **AccountProfile = 完整 CLI Home**，即「账号即环境」。
   新建 Profile 就是一套全新的 CLI 配置。
2. 代价写在明处，不掩盖：用户需要在每个 Profile 里各自配置 MCP / Skills；
   一个 Profile 里装的 skill 在另一个 Profile 里不可见。
3. `AgentExecutionProfile` 因此**不引用** `toolProfileId` / `skillProfileId` /
   `permissionProfileId` / `envProfileId`——这四类实体在 V2 中不存在
   （Permission 目前是按 workspace / agent / role 合并生成的内联对象，
   没有可引用的行；MCP / Skills 在仓库里没有任何模型）。
   第一版字段收窄为 `accountProfileId` / `model` / `reasoningEffort` /
   `approvalMode`。
4. 「多账号共享 Tool / Skill 配置」保留为目标态。达成它需要一层
   **可重复生成的配置 overlay / projection**：Teskra 持有规范模型，
   每次 Run 启动前 patch 进目标 Profile Home 的配置文件
   （与 §32 的字段所有权同一套机制）。该机制需要独立立项，
   不在 TASK-094～117 范围内。

## 影响

- `agent_execution_profiles`（plan §139.1 / migration 014）不含那四列。
- 权限投射产物继续写 run 目录（`<runDir>/permission-settings.json`），
  **绝不写 Profile Home**——否则并发跑在同一 Profile 上的两个 Run 会互相
  污染权限配置，且污染跨 Run 持久。
- Profile Home 是完整 CLI 环境，意味着同一 Profile 并发跑多个 Run 会让两个
  CLI 进程同时写同一份 config / sessions，而官方 CLI 未承诺并发安全。
  因此 managed Profile 的 `max_concurrent_runs` 默认为 1（见 TASK-117）。
