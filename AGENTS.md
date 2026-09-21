# AGENTS.md

> 本文件面向 AI 编码 Agent。阅读者对本项目一无所知。
> 项目主文档语言为中文，代码标识符与 API 使用英文。

## 项目概述

**Teskra — Multi-Agent Coding Workbench**，一句话定位：**Orchestrate your coding agents.**

Teskra 是一个 **Windows-first、Task-first、Agent-first** 的桌面端多 Agent 编码工作台（Electron 应用），
用于在同一个 GUI 内统一调度 Codex CLI、Claude Code 等 Coding Agent，并提供 Workspace、
PTY Terminal、Git Worktree 隔离、Review、Crash Recovery 与 Workflow 编排能力。

**当前仓库状态：TASK-001~093 的功能主体均已实现并有测试覆盖。** npm workspaces
monorepo（`apps/desktop` + `packages/contracts` + `packages/shared`），Electron +
React + TypeScript + electron-vite 可构建可打包；main 进程约 60 个模块（Agent /
Process / Terminal / Workspace / Git / Workflow / Permission / Memory / Recovery /
DB 等）齐备，Vitest 单测 1100+ 用例，Playwright E2E 已接入 CI（暂非门禁）。

**不要把本仓库当成空骨架**：新增功能前先读对应模块的现有实现与测试，不要重建已有能力。

已知的待修问题（含 4 项阻塞级）见 `docs/code-review-2026-09-12.md`，
动相关模块前请先读该文档对应条目。

设计文档在 `docs/` 下：

```text
docs/
├─ teskra-implementation-plan-v2.md   # 总体实现方案（V2）
├─ teskra-tasks.md                    # TASK 编号与验收标准的唯一权威（TASK-001~093）
├─ code-review-2026-09-12.md          # 全量 Code Review 结论与待修项清单
├─ release.md                         # 签名与发布流程
└─ decisions/                         # ADR（架构决策记录）
   ├─ 0001-v2-supersedes-v1-definitions.md
   ├─ 0002-permission-system-policy-and-audit.md
   ├─ 0003-data-directory-and-paths.md
   ├─ 0004-handoff-file-contract.md
   ├─ 0005-config-layers-and-runtime-facade.md
   ├─ 0006-workflow-run-task-optional.md
   ├─ 0007-persist-agent-run-mode.md
   ├─ 0008-criteria-set-task-nullable.md
   ├─ 0009-account-profile-is-a-full-cli-home.md
   ├─ 0010-rate-limit-is-a-failure-reason-not-a-run-status.md
   └─ 0011-workflow-references-profile-aliases.md
```

## 文档权威性（实现任何功能前必读）

文档内部存在演进冲突，权威顺序固定为：

```text
docs/teskra-tasks.md        = TASK 编号与验收标准的唯一权威
plan §114–§164（V2 章节）    = 生效的架构定义
plan §1–§113（V1 章节）      = 凡与 V2 冲突，以 V2 为准（ADR-0001）
plan §139.1                 = 数据库 Schema 的唯一权威
docs/decisions/             = 已裁决的架构问题
```

- plan 中标注 `[SUPERSEDED]` 的章节保留仅作演进记录，**不得作为实现依据**。
- 实现时 plan 与 tasks 冲突，以 `teskra-tasks.md` 为准；tasks 未覆盖的细节才回查 plan V2 章节。
- 发现架构问题时先记录到 `docs/decisions/`，不要无边界扩张 Scope。

已裁决的关键架构约束（详见各 ADR）：

1. **Permission 无法做执行前拦截**（ADR-0002）。Teskra 是 PTY 宿主而非系统调用网关，
   权限体系 = 策略下发（翻译成各 Agent CLI 自己的审批机制）+ 环境级隔离 + 事后审计。
2. **Handoff 走文件契约，不解析 stdout**（ADR-0004）。通过 `TESKRA_HANDOFF_PATH` /
   `TESKRA_ARTIFACT_DIR` 环境变量传递路径，Agent 写文件，Zod 校验，失败不阻塞 Run。
3. **数据根目录统一 `~/.teskra/`**（ADR-0003），不使用 `app.getPath("userData")`；
   支持 `TESKRA_HOME` 环境变量覆盖；worktree 放 `~/.teskra/worktrees/<workspaceId>/<runId>/`。
4. **`better-sqlite3` 与 `node-pty` 都是 native module**，均需按 Electron ABI rebuild。
5. **`sandbox: true` 下 preload 不能 `require` 任意 npm 包**，contracts / zod 必须打进 preload bundle。
6. **配置分两层**（ADR-0005）：`config.json`（JSON，Settings UI 回写）与
   `<repo>/.teskra/workflows/`（纯手写的 Workflow 定义）。不存在 `teskra.yaml`。
   `definition-loader.ts` 接受 `.yaml` / `.yml` / `.json` 扩展名，按扩展名分派解析：
   `.yaml` / `.yml` 走 `yaml` 包（YAML 1.2，支持完整 block 语法），`.json` 继续走
   `JSON.parse`（保持既有解析行为与错误信息不变）。
7. **ADR-0007 与 ADR-0008 曾撞号**（均一度写作 0007），已按时间先后重排：
   0007 = AgentRun 持久化启动模式（migration 009），
   0008 = Criteria Set 可脱离 Task（migration 010）。引用时注意别沿用旧编号。
8. **AccountProfile = 完整 CLI Home**（ADR-0009，Milestone 24 / TASK-094~118）。
   多订阅账号通过独立的 CLI 配置根隔离（Codex 用 `CODEX_HOME`，Claude 用
   `CLAUDE_CONFIG_DIR`，Kimi 用 `KIMI_CODE_HOME`），「账号即环境」；
   `AgentExecutionProfile` 不引用
   tool / skill / permission / env 四类 Profile ID（这些实体不存在）。
   另：限额是失败原因而非 Run 状态（ADR-0010，分类结果存
   `agent_runs.failure_classification_json`）；Workflow 里引用的是机器间可移植的
   Profile alias 而非本地 Profile id（ADR-0011）。

## 技术栈与工具链基线（计划，强制固定）

```text
桌面框架   Electron
前端       React + TypeScript + Vite/electron-vite + Ant Design + Zustand
终端       xterm.js + node-pty
数据库     SQLite (better-sqlite3)
Git        git CLI（经 CommandRunner 调用；未引入 simple-git）
校验       zod
日志       pino
IPC        Electron contextBridge + ipcMain/ipcRenderer
测试       Vitest（单元）+ Playwright（E2E）
```

工具链基线：

- **Node 22 LTS**：`package.json` 必须声明 `"engines": { "node": ">=22 <23" }` 并开启 `engine-strict`。
- **包管理：npm workspaces**（不用 pnpm/yarn）；`package-lock.json` 必须提交，CI 用 `npm ci`。
- Electron / electron-vite 锁定 minor；Electron 升级是独立 Task，不允许顺手升（native module ABI 会变）。
- 默认分支 `main`；目标平台 Windows 11 + WSL2（Windows-first），允许在 WSL2/Linux 上开发。

## 构建与测试命令

> 以下命令均已可用。开发前请切到 Node 22
> （仓库含 `.nvmrc`，`nvm use` 即可；`engine-strict` 会拒绝其它版本）：

```bash
npm ci                # 安装（CI 与本机一致，不用 npm install）
npm run dev           # 启动 Electron 开发模式
npm run typecheck     # TypeScript 检查
npm run lint          # ESLint
npm run format        # Prettier 写入
npm run format:check  # Prettier 检查（CI 必过门禁，提交前先跑 npm run format）
npm run test:unit     # Vitest 单元测试
npm run test:e2e      # 构建 + Playwright Electron E2E（TASK-076，apps/desktop/e2e/）
npm run test:security # 构建 + Electron 安全基线断言（TASK-002，scripts/assert-security-baseline.mjs）
npm run build         # 构建
npm run dist          # 构建 + electron-builder 打包（TASK-072；apps/desktop/electron-builder.yml）
                      # Windows 产出 NSIS installer + portable exe；--dir 快速验证见 apps/desktop 的 pack 脚本
npm run release       # 发布编排（TASK-073，scripts/release.mjs）：build → sign（需 CSC_LINK/
                      # CSC_KEY_PASSWORD，缺失则警告并产出未签名产物）→ package → checksum →
                      # release notes；完整流程见 docs/release.md，CI 见 .github/workflows/release.yml
```

E2E 一律以软件渲染启动 Electron（`apps/desktop/e2e/fixtures.ts` 的 `launchApp` /
`launchSwitches`，即 `--disable-gpu` 等开关）：整套 E2E 会连续启动并强杀二十多个
Electron 实例，开硬件加速时每个实例都要经 ANGLE 建/拆 D3D11 设备，强杀进程树又会在
GPU 进程仍持有设备资源时把它干掉——在 Windows 上曾把显卡驱动打到 DXGKRNL 看门狗
转储 + 0x7E 蓝屏，整台机器随测试一起挂掉。E2E 只断言 DOM，不需要 GPU；`npm run dev`
和发布产物不受影响。确需验证 GPU 行为时用 `TESKRA_E2E_GPU=1` 单独开启。

CI（GitHub Actions，`.github/workflows/ci.yml`，TASK-091）：matrix 为
`windows-latest`（必过门禁，失败阻塞合并）+ `ubuntu-latest`（快速反馈，允许失败），
执行 `npm ci` + typecheck + lint + format:check + test:unit + build + 安全基线断言，Node 版本从 `engines` 读取。
另有独立的 `e2e` job（TASK-076，windows-latest + ubuntu-latest/xvfb，`continue-on-error`，
待 Windows 实机验证后才提升为合并门禁）。

## 代码组织（Monorepo 结构，TASK-001 已建立骨架）

不用 Nx/Turborepo。npm workspaces 布局：

```text
teskra/
├─ apps/desktop/           # Electron 应用
│  └─ src/
│     ├─ main/             # Electron 主进程：agents/ process/ terminal/ workspace/
│     │                    #   git/ tasks/ workflows/ permissions/ memory/ db/ ipc/ events/ security/
│     ├─ preload/          # contextBridge，暴露全局对象 window.teskra
│     └─ renderer/         # React UI：pages/ components/ stores/ hooks/ services/ types/
├─ packages/contracts/     # 跨进程共享类型 + Zod Schema（唯一 allowed shared types 位置）
├─ packages/shared/        # 跨进程共享纯函数
└─ docs/
```

主进程核心模块划分：AgentManager（Registry/Run 生命周期）、ProcessManager（唯一 PTY
Authority）、TerminalManager（Terminal Session ≠ Agent Run）、WorkspaceManager /
WorkspaceRuntime（Windows/WSL 运行时抽象）、GitManager / WorktreeManager、TaskManager /
Orchestrator / WorkflowEngine、PermissionManager、MemoryManager、EventBus、Database。

## 核心架构边界（每个 Task 都适用）

- 分层固定为 `Renderer → Preload → Electron Main → Teskra Runtime`；跨进程共享类型一律放
  `packages/contracts/`，**禁止**在 `apps/desktop/src/` 下再建 `shared/`。
- **Renderer 禁止直接访问** `fs` / `child_process` / `node-pty` / `sqlite` / `git` / `shell`。
- **所有交互式进程必须经 ProcessManager**，所有一次性命令（`git status`、`codex --version`
  等）必须经 CommandRunner；任何模块禁止自己调 `spawn()` / `exec()` / `pty.spawn()`。
- 平台相关代码必须走 `WorkspaceRuntime` 抽象，禁止散落的 `process.platform` 判断。
- 所有路径必须从 TASK-078 的 paths 模块获取，禁止手工拼接 `~/.teskra`。
- Agent 名称一律走 AgentRegistry，不得硬编码；`agentType` 用 `z.string()`，不得写死 enum。
- Runtime 层不得 import `electron`（`BrowserWindow` 只允许出现在 RendererEventBridge）。
- Manager 层不直接写 SQL，一律走 Repository。
- Electron 安全基线：`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`。

## 统一错误模型（强制）

定义在 `packages/contracts/error.ts`（TASK-003），Typed IPC 之前必须就绪：

- IPC **永不**跨进程抛异常，一律返回 `IpcResult<T> = { ok: true; data } | { ok: false; error: PublicAppError }`。
- `InternalAppError`（含 `detail` / `cause`）只在 Main 进程内流转，**不放 contracts**；
  `PublicAppError` 结构上就没有 `detail` / `cause` 字段（类型层面杜绝泄漏）。
- `toPublicError()` 是唯一转换出口，转换时把 detail/cause 写入日志（带 correlationId）。
- 未分类错误一律 `UNKNOWN` + 记日志，不允许吞掉。

## 测试策略

- 单元测试用 **Vitest**；E2E 用 **Playwright**（TASK-076，Phase G）。
- Repository 用内存 SQLite 测试；`foreign_keys` / WAL 等 PRAGMA 用断言验证。
- TASK-075 是 Worktree Safety Reference Tests（借鉴外部项目行为时：观察行为 → 写成测试 → 自己实现）。
- 标注 `[Windows 验证]` 的验收项必须在 Windows + WSL2 实际验证；在 Linux 开发机上无法验证时，
  必须在 Task 完成说明中**显式列出未验证项，不得直接勾选**。
- `wsl --list --quiet` 输出是 UTF-16LE，CommandRunner 需支持指定输出编码。

## 开发工作流约定

- 任务粒度：每个 TASK 0.5～2 天可完成；**一个 TASK = 一个或少量独立 commit**，不堆巨大 commit。
- 不允许跨 Task 顺手做未定义功能。
- 默认由 Codex 负责实现，Claude Code 用于架构/安全/Diff Review（见 `teskra-tasks.md` §27/§28 的推荐 Prompt）。
- Commit message 采用 Conventional Commits，例如
  `feat(workspace): add workspace persistence`、`fix(runtime): reconcile stale runs`。
- 执行顺序：按 `teskra-tasks.md` §24 的 Phase A1 → A2 → A3 → B → … → G，不要一开始就做
  Workflow / Review Panel / Memory / Permission（它们依赖底层 Runtime 正确）。
- Definition of Done 见 `teskra-tasks.md` §30：验收标准全过、build/test/lint 通过、
  diff 已 Review、无 scope 扩张、commit 已创建。

## 安全与许可证边界

- **License 红线**：AgentDeck（Elastic-2.0）与 Claude Squad（AGPL-3.0）**仅行为参考，禁止复制源码**；
  Maverick / crew-mcp / agents（MIT）可借鉴实现模式，但须用自己的命名与 Domain Model 重写。
- 日志必须脱敏：`sk-` / `ghp_` / `*_TOKEN` 等 secret 不得出现在输出（有单测断言）。
- `<repo>/.teskra/config.json` 可提交，禁止出现敏感值，加载时校验并告警；
  敏感 env 走 Credential Store（TASK-088）。
- Handoff / Artifact 等运行期产物实际写在 `<dataRoot>/runs/<runId>/` 下
  （由 `paths.runFiles()` 解析，见 ADR-0004 的 2026-09-12 修订），不落在仓库里。
  WorktreeManager 仍会把 `<repo>/.teskra/handoff/` 与 `<repo>/.teskra/artifacts/`
  写入 `.git/info/exclude` 作为纵深防御（不修改用户的 `.gitignore`）。
- `orchestrated` 模式的 AgentRun 没有 worktree 时**必须拒绝启动**；`attended` 模式
  UI 必须有「直接修改主工作区，未做隔离」常驻横幅（ADR-0002）。
