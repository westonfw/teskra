# Teskra — TASKS.md

> 基于 `teskra-implementation-plan-v2.md`
>
> 目标：将整体方案拆成可以由 Codex / Claude Code 逐条执行的工程任务。
>
> 推荐执行方式：
>
> - 默认由 Codex 负责实现。
> - Claude Code 优先用于架构 Review、安全 Review、Diff Review。
> - 每个 Task 尽量保持 0.5～2 天内可完成。
> - 每完成一个 Task 都应提交独立 Git Commit。
> - 不允许跨 Task 顺手做大量未定义功能。
> - 如果实现过程中发现架构问题，应先记录到 `docs/decisions/`，不要无边界扩张 Scope。

---

## ⚠️ 复选框状态说明（2026-09-12 追加）

**本文件里的 `- [ ]` 验收复选框从未被维护过，不能当作进度信号读。**
截至 2026-09-12，全文 484 个复选框**全部未勾选**，而 TASK-001~093 的功能主体
其实都已实现并有测试覆盖（main 进程约 60 个模块、1100+ 单测用例）。

因此：

- **不要**因为某个 Task 未勾选就认为它没做——先去代码和测试里确认。
- 判断某个 Task 是否落地，以**代码 + 测试 + git history** 为准，本文件只是
  「TASK 编号与验收标准」的权威，不是「完成状态」的权威。
- 已知未完成/有缺陷的部分，见 `docs/code-review-2026-09-12.md`（含 4 项阻塞级）。

要么后续按 Task 逐条核验并回填勾选，要么把复选框改成纯列表——
在此之前请按上面的方式读这份文件。

---

## 文档权威性（2026-09-09 Review 后追加）

```text
本文件           = TASK 编号与验收标准的唯一权威
plan §114–§164   = V2 架构定义（生效）
plan §1–§113     = V1 架构定义（凡与 V2 冲突，以 V2 为准）
plan §139.1      = 数据库 Schema 的唯一权威
docs/decisions/  = 已裁决的架构问题
```

已裁决的关键事项，实现前必读：

| ADR | 内容 |
|---|---|
| [0001](decisions/0001-v2-supersedes-v1-definitions.md) | V2 段落覆盖 V1 段落 |
| [0002](decisions/0002-permission-system-policy-and-audit.md) | Permission 改为策略下发 + 审计，**不做执行前拦截** |
| [0003](decisions/0003-data-directory-and-paths.md) | 数据根目录统一 `~/.teskra/`，worktree 位置与命名 |
| [0004](decisions/0004-handoff-file-contract.md) | Handoff 走文件契约，**不解析 stdout** |
| [0005](decisions/0005-config-layers-and-runtime-facade.md) | 补齐 14 个缺失 Task（TASK-077~090） |
| [0006](decisions/0006-workflow-run-task-optional.md) | WorkflowRun 独立于 Task（`workflow_runs.task_id` 可空） |
| [0007](decisions/0007-persist-agent-run-mode.md) | AgentRun 持久化启动模式（`agent_runs.mode`），resume 复用原模式 |
| [0008](decisions/0008-criteria-set-task-nullable.md) | Criteria Set 可脱离 Task（`acceptance_criteria_sets.task_id` 可空） |

> ADR-0007 与 ADR-0008 曾一度都写作 0007，已按落地时间先后重排
> （0007 对应 migration 009，0008 对应 migration 010）。旧文档里的「ADR-0007：
> Criteria Set 可脱离 Task」指的是现在的 ADR-0008。

> plan §88/§89/§90 曾有一套**撞号但含义不同**的 TASK-001~035 编号，已在 Review 中移除编号。
> 若看到不在本文件中的 TASK 编号，以本文件为准。

---

## Teskra 项目命名

```text
产品名：Teskra
仓库名：teskra
CLI：teskra
全局数据目录：~/.teskra/
项目配置目录：.teskra/
全局配置：~/.teskra/config.json
工作区配置：<repo>/.teskra/config.json
Workflow 定义：<repo>/.teskra/workflows/*.{yaml,yml,json}
数据库：~/.teskra/db/teskra.sqlite
```

> 配置分两层（TASK-080），不是单个文件。
> `config.json` 会被 Settings UI 回写故用 JSON；Workflow 定义纯手写。
>
> **解析实现（2026-09-12 更新）**：`definition-loader.ts` 接受三种扩展名，按扩展名
> 分派解析——`.yaml` / `.yml` 走 `yaml` 包（YAML 1.2，完整 block 语法可用），
> `.json` 走 `JSON.parse`（保持既有解析行为与错误信息不变）。内容为 JSON 的
> `.yaml` 文件同样可加载（JSON 是 YAML 1.2 子集）。

产品定位：

> **Teskra — Multi-Agent Coding Workbench**

一句话描述：

> **Orchestrate your coding agents.**

---

# 0. 全局开发约束

所有任务默认遵守以下规则。

## 技术栈

```text
Electron
React
TypeScript
Vite / electron-vite
Ant Design
Zustand

node-pty
xterm.js

better-sqlite3
simple-git
zod
pino

Vitest
Playwright
```

## 工具链基线（强制固定）

```text
Node            22 LTS（package.json engines 强制，CI 与本机一致）
包管理           npm workspaces（不用 pnpm/yarn，与 TASK-001 验收的 `npm install` 一致）
lockfile         package-lock.json 必须提交；CI 用 `npm ci` 而非 `npm install`
Electron         与 node-pty / better-sqlite3 均有预编译产物的版本，锁定 minor
electron-vite    锁定 minor
默认分支          main
```

约束：

- `package.json` 必须声明 `"engines": { "node": ">=22 <23" }` 并开启 `engine-strict`。
- Electron 升级是**独立的 Task**，不允许在其它 Task 里顺手升——
  两个 native module 的 ABI 会跟着变。
- 根 `package.json` 声明 workspaces，子包不各自安装依赖。

## 错误模型（强制统一）

文档中大量验收标准写「返回结构化错误」，但**没有定义什么叫结构化错误**。
统一定义放在 `packages/contracts`（TASK-003），在 Typed IPC 之前必须就绪：

**类型层面就杜绝泄漏**，而不是靠"记得不要传"这种约定：

```ts
type ErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "WSL_NOT_AVAILABLE"
  | "AGENT_NOT_INSTALLED"
  | "CAPABILITY_NOT_AVAILABLE"
  | "COMMAND_TIMEOUT"
  | "MERGE_BLOCKED"
  | "VALIDATION_FAILED"
  | "UNKNOWN"
  | ...;

/** 只在 Main 进程内流转，绝不跨 IPC */
interface InternalAppError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  detail?: string;          // 路径、命令行、stderr —— 仅进日志
  cause?: unknown;          // 原始异常 —— 仅进日志
}

/** 唯一允许跨 IPC 的错误形态 */
interface PublicAppError {
  code: ErrorCode;
  message: string;          // 面向用户，可直接展示
  retryable: boolean;
}

/** IPC 统一信封，结构上不可能携带 detail / cause */
type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicAppError };

/** 唯一的转换出口，转换时写日志 */
declare function toPublicError(e: InternalAppError): PublicAppError;
```

规则：

- IPC **永不**跨进程抛异常，一律返回 `IpcResult`。
- `PublicAppError` **结构上就没有** `detail` / `cause` 字段——
  不是"规定不要传"，是传不了。
- `toPublicError` 是唯一转换出口，在转换时把 `detail` / `cause` 写入日志
  （带 correlationId，便于用户报错时对上号）。
- 每个 `ErrorCode` 在 UI 侧有对应的展示与建议操作。
- 未分类错误一律 `UNKNOWN` + 记日志，**不允许**吞掉。

## 核心边界

必须保持：

```text
Renderer
  ↓ Typed IPC
Preload
  ↓
Electron Main
  ↓
Teskra Runtime
```

Renderer 禁止直接访问：

```text
fs
child_process
node-pty
sqlite
git
shell
```

## Runtime 原则

所有交互式进程：

```text
Agent CLI
Terminal
Interactive Shell
```

必须经过：

```text
ProcessManager
```

所有一次性命令：

```text
git status
git diff
codex --version
claude --version
wsl --status
```

必须经过：

```text
CommandRunner
```

禁止各模块自己直接调用：

```ts
spawn()
exec()
pty.spawn()
```

## License 边界（强制）

参考项目的许可证不同，**代码复制边界必须遵守**：

```text
AgentDeck   Elastic-2.0   仅行为参考，禁止复制源码
Claude Squad AGPL-3.0     仅交互参考，禁止复制源码
Maverick    MIT           可借鉴实现模式，保留自己的命名与 Domain Model
crew-mcp    MIT           同上
agents      MIT           同上
```

任何 Task 的实现都不得包含从 Elastic-2.0 / AGPL-3.0 项目复制的代码片段。
借鉴方式见 plan §161：**观察行为 → 写成我们的测试 → 自己实现**。

## 开发平台

```text
目标平台   Windows 11 + WSL2（Windows-first）
开发环境   允许在 WSL2 / Linux 上开发
```

因此：

- 平台相关代码**必须**走 `WorkspaceRuntime` 抽象，不得写 `process.platform` 散落判断。
- `node-pty` / `better-sqlite3` 的 Windows ABI、`wsl.exe` 调用路径，
  在 Linux 开发机上**无法验证**，相关 Task 的验收必须在 Windows 侧复核，
  验收标准中标注 `[Windows 验证]`。

## 提交规范

推荐：

```text
feat(workspace): add workspace persistence
feat(agent): add codex adapter
fix(runtime): reconcile stale runs
test(worktree): cover merge conflict preservation
```

---

# Milestone 1 — Project Bootstrap

目标：

> 建立稳定的 Electron + React + TypeScript 工程骨架以及 Main / Preload / Renderer / Shared 边界。

---

## TASK-001 — 初始化 Electron + React + TypeScript 项目

**优先级：P0**

**依赖：无**

**建议 Agent：Codex**

### 目标

创建可运行的桌面应用工程。

### 实施内容

建立：

```text
apps/desktop/
packages/contracts/
packages/shared/
docs/
```

Electron 分层（`apps/desktop/` 内）：

```text
src/main
src/preload
src/renderer
```

> 注意：**不要**在 `apps/desktop/src/` 下再建 `shared/`。
> 跨进程共享的类型一律放 `packages/contracts/`（TASK-003），
> 跨进程共享的纯函数放 `packages/shared/`。
> 否则会出现"两个 shared"，边界很快就烂了（plan §96）。

配置：

```text
TypeScript
ESLint
Prettier
Vitest
```

### 验收标准

- [ ] 应用名称显示为 `Teskra`。
- [ ] package / repository naming 使用 `teskra`。
- [ ] `npm install` 成功。
- [ ] `npm run dev` 可启动 Electron。
- [ ] Renderer 成功显示 React 页面。
- [ ] TypeScript 无错误。
- [ ] Main、Preload、Renderer 目录边界明确。
- [ ] `apps/desktop/src/` 下不存在 `shared/` 目录。
- [ ] `engines.node` 已声明并生效（用错误版本时 install 报错）。
- [ ] `package-lock.json` 已提交，`npm ci` 可复现安装。
- [ ] Electron / electron-vite 版本已锁定 minor。
- [ ] 默认分支为 `main`。
- [ ] Git 仓库已初始化，首次提交完成。

---

## TASK-002 — 配置 Electron 安全基线

**优先级：P0**

**依赖：TASK-001**

**建议 Agent：Codex + Claude Review**

### 实施内容

BrowserWindow：

```ts
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Preload 使用：

```text
contextBridge
```

暴露的全局对象名固定为 **`teskra`**（plan §20，不要用 `workbench`）。

禁止 Renderer 直接引用 Node API。

> **`sandbox: true` 的隐藏约束**：sandboxed preload 只能使用
> `electron`（`contextBridge` / `ipcRenderer`）等少数内置模块，
> **不能 `require` 任意 npm 包**。
> 因此 preload 若要用 contracts / zod，必须由 electron-vite 打进 preload bundle
> （`build.rollupOptions.external` 里不要排除它们）。
> 这一条会直接影响 TASK-003 的落地方式。

### 验收标准

- [ ] Renderer 中 `require` 不可用。
- [ ] Renderer 中 `process` 不暴露 Node 能力。
- [ ] Preload 只暴露明确 API。
- [ ] DevTools 中无法通过全局对象访问 `fs`。
- [ ] preload 打包产物自包含，`sandbox: true` 下能正常加载。
- [ ] 全局对象名为 `window.teskra`。
- [ ] Claude 完成一次安全 Review。

---

## TASK-003 — 建立 shared contracts 包

**优先级：P0**

**依赖：TASK-001**

### 目标

Main 与 Renderer 只共享 Contract，不共享实现。

### 实施内容

创建：

```text
packages/contracts/
├─ workspace.ts     WorkspaceRuntimeRef（plan §116.1）
├─ agent.ts         AgentDefinition / AgentRunStatus（含 interrupted）/ AgentStartRequest
├─ terminal.ts
├─ task.ts          TaskStatus 八态（plan §138）
├─ git.ts           DiffResult / DiffFile
├─ event.ts         WorkbenchEvents
├─ error.ts         ErrorCode / PublicAppError / IpcResult（见 §0 错误模型）
│                   注意：InternalAppError 属于 Main 侧，**不放 contracts**
└─ ipc.ts           IPC channel 名与 request/response schema
```

引入：

```text
zod
```

约束：

- `agentType` 一律为 `z.string()`，**不得写死 `z.enum(["codex","claude"])`**
  （plan §21；否则 TASK-022 的 Fake Agent 验收无法通过）。
- 枚举取值以 plan §139.1 的 schema 注释为准，两处必须一致。

### 验收标准

- [ ] Main / Renderer / Preload 都能 import contracts。
- [ ] Renderer 不允许 import `src/main/*`。
- [ ] 每个 IPC request 至少有 Zod Schema。
- [ ] 添加 compile-time boundary check（ESLint `no-restricted-imports` 或 dependency-cruiser）。
- [ ] contracts 包不含任何 Node 内置模块引用（preload 要能打包它）。
- [ ] `AgentRunStatus` 含 `interrupted`，`TaskStatus` 为八态。
- [ ] `ErrorCode` / `PublicAppError` / `IpcResult` 已定义（§0 错误模型）。
- [ ] `PublicAppError` 结构上不含 `detail` / `cause`（用类型测试断言）。
- [ ] `InternalAppError` 不在 contracts 中导出，Renderer 无法 import 到它。
- [ ] `WorkerHandoff` 的 Zod Schema 已定义（TASK-083 / TASK-051 都依赖它）。
- [ ] 所有枚举取值与 plan §139.1 的 schema 注释一致（可用测试断言）。

---

## TASK-004 — 建立统一日志系统

**优先级：P1**

**依赖：TASK-001, TASK-078**

### 实施内容

使用：

```text
pino
```

日志分类：

```text
app
runtime
agent
process
ipc
git
```

实现脱敏。

日志目录（见 ADR-0003）：

```text
~/.teskra/logs/
```

### 验收标准

- [ ] 日志输出到 `~/.teskra/logs/`（通过 TASK-078 的 paths 模块解析）。
- [ ] 日志包含 timestamp、level、scope。
- [ ] API Key / token / secret env 不被记录。
- [ ] 脱敏有单元测试（构造含 `sk-` / `ghp_` / `*_TOKEN` 的对象，断言不出现在输出中）。
- [ ] 提供「日志目录路径」的 Facade 能力；
      Settings 中的入口由 TASK-093 挂载（本 Task 不实现 UI）。

---

## TASK-078 — 实现 paths 模块

**优先级：P0**

**依赖：TASK-001**

> 新增 Task（ADR-0003 / ADR-0005）。原文档中数据目录出现 `~/.teskra/`、
> `<app-data>/`、`../.agent-worktrees/` 三套写法，且 Electron 的
> `app.getPath("userData")` 在 Windows 上是 `%APPDATA%\Teskra`，**不等于** `~/.teskra`。
> 必须先有一个集中的路径解析模块，否则后面每个持久化 Task 都会各拼各的。

### 实施内容

```ts
interface TeskraPaths {
  home(): string;          // TESKRA_HOME ?? os.homedir()/.teskra
  db(): string;            // <home>/db/teskra.sqlite
  logs(): string;          // <home>/logs
  runDir(runId): string;   // <home>/runs/<runId>
  worktreeRoot(workspaceId): string;
  config(): string;        // <home>/config.json
}
```

规则：

- 数据根统一 `~/.teskra/`，**禁止**使用 `app.getPath("userData")` 作为数据根。
- 支持环境变量 `TESKRA_HOME` 覆盖（测试与多实例必需）。
- 目录不存在时按需创建，创建失败返回结构化错误。
- WSL workspace 的数据根由 `WorkspaceRuntime.resolveDataRoot()`（TASK-010）另行给出，
  本模块只负责 Windows/宿主侧。

### 验收标准

- [ ] 所有路径只从本模块获取，代码中无手工 `path.join(os.homedir(), ".teskra")`。
- [ ] `TESKRA_HOME` 覆盖生效，有单元测试。
- [ ] 目录自动创建，权限错误返回结构化错误。
- [ ] Windows / Linux 下路径分隔符均正确。

---

## TASK-091 — 建立 Windows CI 基线

**优先级：P0**

**依赖：TASK-001**

> 新增 Task（Review 结论）。原文档最早的 CI 出现在 TASK-076（E2E，Phase G）。
> 但这是 **Windows-first 且含两个 native module** 的项目，
> 等到最后才建 Windows CI，意味着 ABI / rebuild / 打包问题会在最不该出现的时候集中爆发。

### 提供方与落点

```text
GitHub Actions
.github/workflows/ci.yml
```

（若后续改用 GitLab CI，配置落点为 `.gitlab-ci.yml`，
矩阵语义等价，本 Task 的验收标准不变。）

### 范围（刻意做小）

**不是** E2E（那是 TASK-076），也**不含** native module
（此时 better-sqlite3 / node-pty 都还没安装）：

```yaml
matrix:
  os: [windows-latest, ubuntu-latest]
steps:
  - npm ci                    # 非 npm install
  - npm run typecheck
  - npm run lint
  - npm run test:unit
  - npm run build
```

Windows 是**必过**门禁，Ubuntu 只做快速反馈（允许失败不阻塞，
因为部分能力在 Linux 上本就不可用）。

### native module 的 CI 验证归属

> 修正：原验收标准要求「native module rebuild 在 CI 中实际执行」，
> 但本 Task 依赖只有 TASK-001，那时两个 native module 都还没进依赖树，
> **该验收项无法满足**。现拆给引入它们的 Task：

```text
TASK-005  引入 better-sqlite3 → 由该 Task 向 CI 增加 require smoke
TASK-013  引入 node-pty       → 由该 Task 向 CI 增加 require smoke
TASK-072  electron-builder    → 由该 Task 增加打包产物 smoke
```

每个 Task 负责把自己引入的 native module 加进 CI，
本 Task 只提供**可扩展的 CI 骨架**。

### 验收标准

- [ ] `.github/workflows/ci.yml` 存在，push 与 PR 均触发。
- [ ] windows-latest 上 `npm ci` + typecheck + lint + test + build 通过。
- [ ] 使用 `npm ci`，不使用 `npm install`（保证 lockfile 有效）。
- [ ] Node 版本从 `package.json` 的 `engines` 读取，不在 workflow 里另写一份。
- [ ] CI 运行时间在 10 分钟内（超过就拆分，否则没人会等）。
- [ ] Windows job 失败即阻塞合并。
- [ ] workflow 结构允许后续 Task 追加 smoke step，不需要重写。

---

# Milestone 2 — Persistence

目标：

> 建立 SQLite 和 Repository 层，为 Workspace / Task / AgentRun 持久化打基础。

---

## TASK-005 — 集成 SQLite

**优先级：P0**

**依赖：TASK-001, TASK-078**

### 实施内容

使用：

```text
better-sqlite3
```

数据库路径（见 ADR-0003，**不是** `app.getPath("userData")`）：

```text
~/.teskra/db/teskra.sqlite
```

必须设置的 PRAGMA：

```sql
PRAGMA foreign_keys = ON;   -- better-sqlite3 默认关闭
PRAGMA journal_mode = WAL;  -- 否则 Agent 高频写 event 会阻塞 UI 查询
PRAGMA busy_timeout = 5000;
```

> **`better-sqlite3` 与 `node-pty` 一样是 native module**，
> 同样需要按 Electron ABI rebuild（`@electron/rebuild`）。
> 这一点原文档只在 TASK-013 提了 node-pty，很容易漏。
> 建议在本 Task 就把 `postinstall: electron-rebuild` 配好，TASK-013 复用。

### 验收标准

- [ ] 应用启动自动打开数据库。
- [ ] 应用退出正确关闭数据库。
- [ ] 数据库错误不会直接导致 Renderer 崩溃。
- [ ] `foreign_keys` / `journal_mode=WAL` 已生效（用 PRAGMA 查询断言）。
- [ ] `better-sqlite3` 在 Electron 主进程中可正常加载（ABI 匹配）。
- [ ] 有基础 DB smoke test。
- [ ] **向 TASK-091 的 CI 增加 `better-sqlite3` require smoke step**
      （rebuild 后可 require 并执行一条 SQL）。
- [ ] `[Windows 验证]` Windows 上 rebuild 后可加载。

---

## TASK-006 — 实现数据库 Migration 系统

**优先级：P0**

**依赖：TASK-005**

### 实施内容

建立：

```text
migrations/
├─ 001_init.sql
├─ 002_runs.sql
├─ 003_criteria_review.sql
├─ 004_artifacts_memory.sql
└─ 005_permissions.sql
```

> **SQL 内容见 plan §139.1**，那是唯一权威定义。
> 不要照抄 plan §23–§27 的简化示意表（缺列、缺索引、缺外键）。
> 本 Task 只负责 migration **机制**；表结构的落地由 TASK-090 完成。

保存 schema version 到 `schema_migrations` 表。

### 验收标准

- [ ] 空数据库能升级到最新版本。
- [ ] 已有数据库不会重复执行 migration。
- [ ] 每个 migration 在单个事务内执行，失败会回滚。
- [ ] 版本号回退（DB 版本 > 代码版本）时给出明确错误，不静默继续。
- [ ] 测试覆盖至少 2 个 schema version。

---

## TASK-090 — 落地完整数据库 Schema

**优先级：P0**

**依赖：TASK-006**

> 新增 Task（ADR-0005）。原文档只在 plan §23–§27 给了 7 张表的**简化示意**，
> V2 引入的 AcceptanceCriteria / WorkflowRun / ReviewPanel / Worktree / Handoff
> 等实体**完全没有 schema**，`agent_runs` 也缺 `workflow_run_id` /
> `provider_session` / `role` / `criteria_set_id` / `last_output_at` 等必需列。
> TASK-006 只建立 migration 机制，本 Task 负责表结构本身。

### 实施内容

按 **plan §139.1** 落地 5 个 migration 文件：

```text
001_init.sql              schema_migrations / workspaces / tasks
002_runs.sql              worktrees / workflow_runs / workflow_steps /
                          agent_runs / agent_events
003_criteria_review.sql   acceptance_criteria_sets / acceptance_criteria /
                          review_panels / review_panel_members /
                          review_findings / criterion_scores
004_artifacts_memory.sql  artifacts / handoffs / memories
005_permissions.sql       permission_rules / permission_audit
```

### 验收标准

- [ ] 5 个 migration 全部可在空库上执行成功。
- [ ] 表结构与 plan §139.1 完全一致（列名、类型、约束、索引）。
- [ ] contracts 中的枚举取值与 schema 注释一致（TaskStatus 八态、
      AgentRunStatus 含 interrupted、WorktreeState 八态、Artifact type 七种）。
- [ ] 外键在 `PRAGMA foreign_keys = ON` 下全部有效，级联删除行为有测试。
- [ ] `agent_events` 的 `(run_id, seq)` 唯一约束生效。
- [ ] 有一个 seed 脚本能造出「1 Workspace / 1 Task / 1 WorkflowRun / 2 AgentRun /
      1 ReviewPanel」的完整关系图，用于后续 UI 开发。

---

## TASK-007 — 建立 Repository 抽象

**优先级：P1**

**依赖：TASK-006, TASK-090**

> 依赖修正：Repository 映射的是**表结构**，不是 migration 机制。
> 只依赖 TASK-006 会导致 Repository 无表可映射。

### 实施内容

建立：

```text
WorkspaceRepository
TaskRepository
AgentRunRepository
AgentEventRepository
ArtifactRepository
WorktreeRepository
WorkflowRunRepository
CriteriaRepository
ReviewRepository
HandoffRepository
MemoryRepository
PermissionRepository
```

> 后 7 个可以先只建空壳 + 类型，实体表由 TASK-090 建好后再填实现。
> 但**接口必须在这里定下来**，否则 Manager 层会绕过 Repository 直接写 SQL。

Repository 负责：

```text
行 ↔ Domain 对象映射（含 *_json 列的序列化与 Zod 校验）
WorkspaceRuntimeRef 的展平 / 还原
时间列统一 ISO-8601 UTC
```

### 验收标准

- [ ] Manager 层不直接写 SQL。
- [ ] Repository 有单元测试（用内存 SQLite）。
- [ ] CRUD 行为稳定。
- [ ] 时间统一使用 ISO UTC，有测试断言格式。
- [ ] `*_json` 列读出时经过 Zod 校验，损坏数据返回结构化错误而不是抛裸异常。

---

# Milestone 3 — Workspace Runtime

目标：

> Windows 和 WSL 成为一级 Runtime，而不是到处做路径字符串转换。

---

## TASK-008 — 实现 Workspace Domain Model

**优先级：P0**

**依赖：TASK-003, TASK-007**

### 实施内容

使用 plan §116.1 的 `WorkspaceRuntimeRef`，**不是** §7.1 的扁平 enum：

```ts
type RuntimeKind = "windows" | "wsl" | "ssh" | "container";

interface WorkspaceRuntimeRef {
  kind: RuntimeKind;
  distro?: string;
  host?: string;
  containerId?: string;
}
```

第一版实现：

```text
windows
wsl
```

预留（类型存在，运行时拒绝）：

```text
ssh
container
```

DB 侧展平为 `runtime_kind` / `wsl_distro` / `ssh_host` / `container_id`（plan §139.1），
由 Repository 负责映射。

### 验收标准

- [ ] Workspace 可持久化。
- [ ] 支持 Windows 路径。
- [ ] 支持 WSL Linux 路径。
- [ ] Workspace 记录 distro。
- [ ] 选择未实现的 `ssh` / `container` 时返回结构化错误，不崩溃。
- [ ] Recent Workspaces 可读取。

---

## TASK-009 — 实现 WorkspaceManager

**优先级：P0**

**依赖：TASK-008**

### 实施内容

提供：

```text
create
open
remove
listRecent
validate
```

### 验收标准

- [ ] 打开目录后生成 Workspace。
- [ ] 不存在目录返回结构化错误。
- [ ] 重复打开同路径不会创建重复 Workspace。
- [ ] UI 可列出最近项目。

---

## TASK-010 — 实现 WorkspaceRuntime 抽象

**优先级：P0**

**依赖：TASK-008**

### 实施内容

接口：

```text
WindowsRuntime
WslRuntime
```

提供：

```text
resolveCommand
resolveCwd
resolveDataRoot     ← 见 ADR-0003：WSL worktree 必须落在 WSL 文件系统内
validate
```

> `wsl.exe --cd <path>` 需要 **WSL 0.51+（Windows 10 build 21354+）**。
> 低版本必须回退为：
>
> ```text
> wsl.exe -d <distro> bash -lc 'cd <path> && exec bash'
> ```
>
> WslRuntime 需在 validate 阶段探测 WSL 版本并选择策略。

### 验收标准

- [ ] Agent / Git / Terminal 不直接判断 WSL，代码中无散落的 `process.platform`。
- [ ] Windows Runtime 能正确生成 Windows 命令上下文。
- [ ] WSL Runtime 能正确生成 `wsl.exe -d ...` 上下文。
- [ ] `--cd` 不可用时能回退到 `bash -lc 'cd ... && exec bash'`。
- [ ] `resolveDataRoot()` 对 WSL 返回 WSL 侧路径，不是 `C:\Users\...`。
- [ ] 对路径转换有单元测试。

---

## TASK-011 — WSL 检测与 Distro 管理

**优先级：P0**

**依赖：TASK-010, TASK-012**

> 依赖修正：本 Task 要执行 `wsl --status` 等一次性命令，
> 按全局约束必须走 CommandRunner（TASK-012），
> 因此 **TASK-012 必须先于 TASK-011 完成**。原文档的 Phase A 顺序把 011 排在 012 之前，是错的。

### 实施内容

检测：

```text
wsl --status
wsl --list --quiet
wsl --version        （判断是否支持 --cd）
```

> `wsl --list --quiet` 的输出是 **UTF-16LE**，直接按 UTF-8 解码会得到夹杂 `\0` 的乱码。
> CommandRunner 需要支持指定输出编码。

### 验收标准

- [ ] 能列出可用 distro。
- [ ] 能识别默认 distro。
- [ ] 正确处理 `wsl --list` 的 UTF-16LE 输出。
- [ ] 能判断 WSL 是否支持 `--cd`。
- [ ] WSL 未安装时返回结构化错误，应用仍可正常启动（只是 WSL workspace 不可用）。
- [ ] distro 不存在时给明确错误。
- [ ] 提供「列出 distro / 读写默认 distro」的 Facade 能力；
      Settings 表单由本 Task 挂载到 TASK-093 的 Environment 分区。
- [ ] `[Windows 验证]`

---

## TASK-080 — 实现 Config Layers

**优先级：P0**

**依赖：TASK-078, TASK-009**

> 新增 Task（plan §151 / §152 有设计但无对应 Task，ADR-0005）。
> 配置读取如果不在早期集中，后面每个 Manager 都会各读各的，很难再收回来。

### 分层（plan §151）

```text
Built-in defaults
  ↓ 覆盖
Global config      ~/.teskra/config.json
  ↓ 覆盖
Workspace config   <repo>/.teskra/config.json    （可提交，团队共享）
  ↓ 覆盖
Task / Run override
```

### 实施内容

- 每层用 Zod 校验，非法字段给出**指明层级与字段路径**的错误。
- 深合并语义明确：对象递归合并，数组整体替换。
- 提供 `resolve(workspaceId?, runId?)` 返回最终生效配置及**每个字段来自哪一层**
  （Settings UI 需要展示"此项来自 workspace 配置"）。
- `<repo>/.teskra/config.json` 是可提交文件，**禁止**出现敏感值，加载时校验并告警。

### 验收标准

- [ ] 四层覆盖顺序正确，有单元测试。
- [ ] 能报告每个生效字段的来源层级。
- [ ] 非法配置返回结构化错误，不使应用启动失败（降级到上一层）。
- [ ] repo-local 配置中出现疑似 secret 时告警且不加载该字段。
- [ ] 各 Manager 通过注入的 config 读取，代码中无直接读文件。

---

# Milestone 4 — Process Runtime

目标：

> 建立唯一 PTY Authority。

---

## TASK-012 — 实现 CommandRunner

**优先级：P0**

**依赖：TASK-010**

### 实施内容

负责一次性命令：

```text
git status
git diff
where codex
which claude
```

支持：

```text
timeout       必填，无默认放行（plan §150）
AbortSignal
stdout
stderr
exitCode
encoding      utf8 | utf16le（wsl --list 需要）
maxBuffer
```

> timeout 必须**真正 kill 子进程**，不能只 `Promise.race`。
> 后者会留下 orphan process（plan §150）。

### 验收标准

- [ ] timeout 后真实终止子进程（断言 PID 已消失，不只是 Promise reject）。
- [ ] `timeoutMs` 为必填参数，缺失时类型层面报错。
- [ ] 支持 Windows Runtime。
- [ ] 支持 WSL Runtime。
- [ ] 支持 utf16le 输出解码。
- [ ] 不残留 orphan process。
- [ ] 单元测试覆盖 success / timeout / non-zero exit / abort。

---

## TASK-013 — 集成 node-pty

**优先级：P0**

**依赖：TASK-001**

### 实施内容

安装：

```text
node-pty
@electron/rebuild
```

解决 Windows Electron ABI（rebuild 机制在 TASK-005 已建立，此处复用并加入 node-pty）。

打包时 native module 必须 unpack：

```text
electron-builder: asarUnpack = ["**/node_modules/node-pty/**", "**/node_modules/better-sqlite3/**"]
```

### 验收标准

- [ ] Dev 环境可创建 PTY。
- [ ] Production build 可创建 PTY。
- [ ] node-pty 与 better-sqlite3 的 rebuild 自动执行。
- [ ] **向 TASK-091 的 CI 增加 `node-pty` require smoke step**
      （rebuild 后可 require 并 spawn 一个立即退出的进程）。
- [ ] CI/本机 clean install 可通过。
- [ ] `[Windows 验证]` Windows 下 ConPTY 正常工作。

---

## TASK-014 — 实现 ProcessManager

**优先级：P0**

**依赖：TASK-013, TASK-010**

### 实施内容

唯一负责：

```text
spawn
write
resize
interrupt
terminate
kill
```

维护：

```text
process registry
```

### 验收标准

- [ ] 可以同时管理 3 个 PTY。
- [ ] Process ID 唯一。
- [ ] stdout/data 通过 EventBus 输出。
- [ ] exit 后自动移出 active registry。
- [ ] Adapter 不允许直接 `pty.spawn()`。

---

## TASK-015 — 实现 Process Kill Escalation

**优先级：P1**

**依赖：TASK-014**

### 实施内容

停止流程：

```text
Ctrl+C
→ graceful terminate
→ force kill
```

### 验收标准

- [ ] 正常 shell 可 Ctrl+C 停止。
- [ ] 卡死进程最终可以 force kill。
- [ ] 每一步都有 timeout。
- [ ] process exit 只发送一次。

---

## TASK-016 — 实现 EventBus

**优先级：P0**

**依赖：TASK-003**

### 实施内容

支持 typed event：

```text
process.started
process.output
process.exited
agent.started
agent.output
...
```

### 验收标准

- [ ] Event payload 有 TypeScript 类型。
- [ ] 支持 subscribe/unsubscribe。
- [ ] 不直接依赖 BrowserWindow。
- [ ] 单元测试覆盖事件传播。

---

# Milestone 5 — Terminal

目标：

> 实现可靠的 PowerShell / WSL Terminal。

---

## TASK-017 — 实现 TerminalManager

**优先级：P0**

**依赖：TASK-014, TASK-016**

### 实施内容

TerminalSession 与 AgentRun 分离。

支持：

```text
create
write
resize
close
```

### 验收标准

- [ ] 支持 PowerShell。
- [ ] 支持 WSL bash。
- [ ] 同时打开多个 Terminal。
- [ ] 关闭一个 Terminal 不影响其它 PTY。

---

## TASK-018 — 集成 xterm.js

**优先级：P0**

**依赖：TASK-017, TASK-020, TASK-021**

> 依赖修正：xterm.js 在 Renderer 侧，创建 PTY / 读输出必须经过 IPC 与 Event Bridge。
> 原依赖只有 TASK-017（主进程侧），Renderer 无法调用。

### 实施内容

Renderer：

```text
xterm.js
fit addon
```

### 验收标准

- [ ] ANSI 正常显示。
- [ ] 输入正常。
- [ ] Ctrl+C 正常。
- [ ] resize 正常。
- [ ] `top` / `vim` 等 TTY 程序可正常运行。

---

## TASK-019 — Terminal Keep-Alive

**优先级：P1**

**依赖：TASK-018**

### 目标

Tab 切换不能销毁真实 Terminal。

### 验收标准

- [ ] 切换 Tab 后进程继续运行。
- [ ] 返回 Tab 时历史画面仍可见。
- [ ] React unmount 不会误杀 PTY。
- [ ] 长任务在隐藏状态保持运行。

---

## TASK-082 — 实现 TerminalRenderer 抽象

**优先级：P2**

**依赖：TASK-018**

> 新增 Task（plan §119 有设计但无对应 Task，ADR-0005）。

### 目标

不让 `import { Terminal } from "@xterm/xterm"` 散落在各个 UI 页面。

### 实施内容

```ts
interface TerminalRenderer {
  mount(el: HTMLElement, options: TerminalOptions): TerminalInstance;
}

class TerminalRegistry {
  get(name?: string): TerminalRenderer;   // 默认 "xterm"
}
```

第一版只实现 `XtermTerminalRenderer`。
预留 `ReadonlyLogRenderer`（用于已完成 Run 的历史输出，不需要交互）。

### 验收标准

- [ ] UI 组件不直接 import `@xterm/xterm`。
- [ ] 换 renderer 实现不需要修改页面代码。
- [ ] `ReadonlyLogRenderer` 至少有接口占位。

---

# Milestone 6 — Typed IPC

目标：

> 所有 Renderer → Main 操作走领域化、安全的 IPC。

---

## TASK-081 — 实现 TeskraRuntime Facade 骨架与 Composition Root

**优先级：P0**

**依赖：TASK-009, TASK-016, TASK-017, TASK-080**

> 新增 Task（plan §118 有设计但无对应 Task，ADR-0005）。
>
> **修订 1**：原 Task 一次性列出 `createTask` / `startRun` / `applyRun` /
> `discardRun`，内部依赖 AgentManager / GitManager / WorktreeManager /
> PermissionManager——这些到 Phase B~E 才存在，**在 A3 阶段根本无法实现**。
> 现拆为「骨架先行 + 能力增量接入」。
>
> **修订 2**：本 Task 要求 `terminal` port 可用，因此必须依赖
> **TASK-017（TerminalManager）** 与 **TASK-009（WorkspaceManager）**——
> port 要有实现才谈得上可用。原依赖遗漏，Phase 顺序也把 017 排在了后面。

### 本 Task 的范围（A3 可完成）

只做三件事：

**1. Composition Root**

集中构造所有 Manager 并注入依赖，单一装配点：

```text
src/main/runtime/compose.ts
  → 读 Config（TASK-080）
  → 构造 EventBus / paths / Database / Repositories
  → 构造已存在的 Manager
  → 返回 TeskraRuntime 实例
```

**2. Facade 接口与端口定义**

`TeskraRuntime` 按**能力域**切分，每个域是一个独立 port，
后续 Task 只往对应 port 上加方法，不改 Facade 结构：

```ts
interface TeskraRuntime {
  workspace: WorkspacePort;   // 本 Task 实现
  terminal:  TerminalPort;    // 本 Task 实现
  system:    SystemPort;      // 本 Task 实现（版本、路径、健康度）

  task?:     TaskPort;        // Phase C 接入
  agent?:    AgentPort;       // Phase B 接入
  git?:      GitPort;         // Phase C 接入
  worktree?: WorktreePort;    // Phase E 接入
  workflow?: WorkflowPort;    // Phase F 接入
}
```

未接入的 port 为 `undefined`，IPC 层遇到未注册能力返回结构化错误
`CAPABILITY_NOT_AVAILABLE`，**不是崩溃**。

**3. 硬约束落地**

Runtime 及其下所有 Manager **不得 import `electron`**（plan §117）。
Electron 相关只允许出现在 `RendererEventBridge`（TASK-021）。
用 ESLint `no-restricted-imports` 强制。

### 后续增量接入规则（写进各 Task，不在本 Task 完成）

```text
TASK-028  AgentManager   → 接入 agent port
TASK-032  TaskManager    → 接入 task port
TASK-035  GitManager     → 接入 git port
TASK-043  WorktreeManager→ 接入 worktree port
TASK-057  WorkflowEngine → 接入 workflow port
```

每个 Task 接入自己的 port 时，**必须同时**补 contracts 类型与 IPC 路由，
不允许绕过 Facade 直接加 IPC handler。

### 验收标准

- [ ] 存在唯一 Composition Root，Manager 不在别处自行 new。
- [ ] `workspace` / `terminal` / `system` 三个 port 可用。
- [ ] 未接入的 port 访问时返回 `CAPABILITY_NOT_AVAILABLE`，不抛裸异常、不崩溃。
- [ ] `src/main/runtime/` 及各 Manager 中无 `electron` import（ESLint 规则生效）。
- [ ] Facade 可在纯 Node 环境（无 Electron）下被单元测试实例化。
- [ ] 每个已实现的 Facade 方法有对应的 contracts 类型。

---

## TASK-020 — 实现 Typed IPC Router

**优先级：P0**

**依赖：TASK-003, TASK-016, TASK-081**

### 实施内容

API：

```text
workspace.*
terminal.*
agent.*
task.*
git.*
runtime.*
```

### 验收标准

- [ ] 每个 request 经过 Zod validate。
- [ ] 每个 response 有稳定类型。
- [ ] 不存在通用 `exec(command)` IPC。
- [ ] Preload API 有完整 TypeScript declaration。

---

## TASK-021 — 实现 Renderer Event Bridge

**优先级：P0**

**依赖：TASK-016, TASK-020**

### 实施内容

```text
EventBus
→ webContents.send
→ preload
→ Renderer
```

### 验收标准

- [ ] Renderer 可以订阅 process output。
- [ ] 关闭页面时 listener 正确释放。
- [ ] 不发生重复订阅。
- [ ] BrowserWindow 逻辑只存在 bridge 层。

---

## TASK-092 — 实现 App Shell 与 Workspace UI

**优先级：P0**

**依赖：TASK-019, TASK-020, TASK-021, TASK-093**

> 依赖修正：验收标准里有「页面切换不销毁 Terminal（与 TASK-019 联合验证）」，
> 因此必须依赖 TASK-019；导航中的 Settings 入口依赖 TASK-093 的框架。

> 新增 Task（Review 结论）。原文档**没有任何 App Shell / Workspace UI Task**，
> 但 TASK-009 的「UI 可列出最近项目」、TASK-034 的 Task 页面等
> 都默认它已经存在。

### 范围

```text
应用外壳     左侧导航（Workspace / Tasks / Runs / Git / Terminal / Settings）
             顶部栏（当前 Workspace / Branch / Environment）
Workspace UI 打开目录、最近项目列表、Workspace 切换
路由         页面切换不销毁 Terminal（配合 TASK-019）
状态         按域拆分 Zustand store（plan §97，禁止单个 useAppStore）
错误展示     统一消费 AppError（§0 错误模型），按 ErrorCode 给建议操作
```

第一版导航只做 plan §52 列出的几项，不要照搬 VS Code。

### 验收标准

- [ ] 可打开 Windows 目录与 WSL 目录并生成 Workspace。
- [ ] 最近项目列表可用，重复打开同路径不产生重复项。
- [ ] 页面切换不销毁 Terminal（与 TASK-019 联合验证）。
- [ ] Zustand store 按域拆分，不存在单一 `useAppStore`。
- [ ] `AppError` 有统一展示组件，`detail` 字段不出现在 UI 上。
- [ ] 无 Workspace 时有明确空状态，不是白屏。

---

## TASK-093 — 实现 Settings UI 框架

**优先级：P0**

**依赖：TASK-080, TASK-020, TASK-021**

> 新增 Task（Review 结论）。原文档有 **6 个后端 Task 把 Settings 操作
> 写进了自己的验收标准**（TASK-004 打开日志目录、TASK-011 选择 distro、
> TASK-023 覆盖 Agent 路径、TASK-024 Agent 健康度、TASK-065 权限规则、
> TASK-089 Routing），但没有 Settings UI 的归属 Task。
>
> **修订**：原排在 Phase G，但 TASK-004 / 011 / 023 都在 Phase A~B 就需要它，
> 且原 Task 要求敏感字段走更晚的 TASK-088（Credential Store）——
> 两处都是跨 Phase 的 DoD 倒置。现**提前到 A3**，且只做框架与非敏感配置。

### 本 Task 范围（刻意做小）

```text
Settings 页面框架 + 分区注册机制
Config Layers 读写（TASK-080）
每项配置显示来源层级（全局 / 工作区 / 默认值）
Advanced 分区：打开日志目录、打开数据目录
```

**不含**任何敏感字段，**不含**后续分区的具体表单。

### 分区增量挂载

各分区由引入该能力的 Task 自己挂载，不由本 Task 预先实现：

```text
TASK-011  → Environment 分区（WSL distro 选择）
TASK-023  → Agents 分区（路径覆盖）
TASK-024  → Agents 分区（健康度展示）
TASK-065  → Permissions 分区（规则 CRUD + 审计视图）
TASK-088  → 敏感字段支持（Credential Store 就绪后才允许输入 secret）
TASK-089  → Agents 分区（Routing）
TASK-069  → Worktrees 分区（Retention 策略）
TASK-067  → Memory 分区
```

**在 TASK-088 完成之前，Settings 不接受任何敏感字段输入**——
输入框直接不渲染，并提示「需要 Credential Store 支持」。
这样不会出现"先明文存了以后再迁移"的历史包袱。

### 验收标准

- [ ] 分区注册机制可用，后续 Task 挂载自己的表单无需改本 Task 代码。
- [ ] 配置修改可选择写入全局层或工作区层。
- [ ] 每项配置显示来源层级。
- [ ] 「打开日志目录」「打开数据目录」可用
      （TASK-004 的「可从 Settings 打开日志目录」由此满足）。
- [ ] TASK-088 未完成时，敏感字段输入不可用且有明确说明。
- [ ] 页面在无 Workspace 时也能打开（全局配置不依赖 Workspace）。

---

# Milestone 7 — Agent Registry & Detection

目标：

> UI、Settings、Workflow 不再硬编码 Codex / Claude。

---

## TASK-022 — 实现 Agent Registry

**优先级：P0**

**依赖：TASK-003**

### 实施内容

定义：

```text
AgentDefinition
Capabilities
Executable
Detection
Defaults
RoutingProfile
```

内置：

```text
Codex
Claude Code
```

### 验收标准

- [ ] UI 从 Registry 生成 Agent 列表。
- [ ] Settings 从 Registry 生成 Agent 配置。
- [ ] AgentManager 不硬编码 Agent 名称。
- [ ] 添加第三个 Fake Agent 不需要修改核心逻辑。

---

## TASK-083 — 实现 Fake Agent

**优先级：P0**

**依赖：TASK-003, TASK-022**

> 依赖修正：本 Task 的验收要求「产出的 handoff 通过 Zod 校验」，
> 因此需要 Handoff Schema。**Schema 归属 contracts（TASK-003）**，
> TASK-051 只负责读取/降级逻辑，不负责定义 Schema。

> 新增 Task（ADR-0005）。原文档中 TASK-022 / TASK-025 / TASK-076 **三处**
> 都依赖 Fake Agent，但没有任何 Task 定义它，验收标准无从落地。

### 目标

提供一个**行为可预测、不消耗真实额度**的 Agent，用于测试与 CI。

### 实施内容

一个随仓库分发的 Node 脚本 `tools/fake-agent.js`，通过 scenario 文件驱动：

```text
--scenario success        输出若干行 → 写 handoff → exit 0
--scenario fail           输出错误 → exit 1
--scenario hang           输出后不退出（测 watchdog / kill escalation）
--scenario slow-output    高频输出 10MB（测 TASK-031 批处理）
--scenario needs-input    等待 stdin 输入后才继续（测交互）
--scenario dirty-worktree 修改文件但不 commit
--scenario bad-handoff    写出不合法 JSON（测 ADR-0004 的 degraded 分支）
```

注册为 `AgentDefinition`，`id = "fake"`，`permissionEnforcement = "none"`。

**仅在 dev / test 环境注册**，production build 中不出现在 Agent 列表里。

### 验收标准

- [ ] Fake Agent 出现在 Registry 中，UI 可选择（dev 环境）。
- [ ] 加入 Fake Agent **未修改** AgentManager / IPC schema / UI 的任何核心逻辑
      （这是 TASK-022 验收标准的实际检验方式）。
- [ ] 上述 7 个 scenario 全部可用。
- [ ] `--scenario success` 产出的 handoff 通过 Zod 校验。
- [ ] production build 中不注册 Fake Agent。
- [ ] E2E（TASK-076）使用它，不消耗真实 Codex / Claude 额度。

---

## TASK-023 — Agent 可执行文件检测

**优先级：P0**

**依赖：TASK-012, TASK-022**

### 实施内容

Windows：

```text
where.exe
```

WSL：

```text
which
```

并执行：

```text
--version
```

### 验收标准

- [ ] 检测 Codex。
- [ ] 检测 Claude。
- [ ] 返回 executable path / version。
- [ ] 提供「读写 Agent 路径覆盖」的 Facade 能力；
      Settings 表单由本 Task 挂载到 TASK-093 的 Agents 分区。
- [ ] 检测结果有缓存。

---

## TASK-024 — 实现 AgentHealth

**优先级：P1**

**依赖：TASK-023**

### 实施内容

状态：

```text
installed
authenticated?
available
rateLimited?
quota?
checkedAt
```

Quota 必须是 optional。

### 验收标准

- [ ] Agent 未安装时 UI 可明确显示。
- [ ] Health check 失败不影响其他 Agent。
- [ ] 不把非官方 quota 解析作为核心依赖。
- [ ] 后续可扩展 agent routing。

---

# Milestone 8 — Agent Runtime

目标：

> Codex / Claude 在统一 Agent API 下运行。

---

## TASK-025 — 实现 CodingAgentAdapter 接口

**优先级：P0**

**依赖：TASK-022, TASK-014**

### 实施内容

接口至少支持：

```text
detect
start
send
cancel
resume?
```

### 验收标准

- [ ] Adapter 不直接依赖 Renderer。
- [ ] Adapter 不直接调用 node-pty。
- [ ] Adapter 所有进程通过 ProcessManager。
- [ ] FakeAgentAdapter 测试通过。

---

## TASK-026 — 实现 CodexAdapter

**优先级：P0**

**依赖：TASK-025**

### 实施内容

支持：

```text
interactive
exec/headless（能力允许时）
resume capability（能力允许时）
```

CLI 参数封装在 Adapter 内。

### 验收标准

- [ ] 可从 UI 启动 Codex。
- [ ] 可向 Codex 发送输入。
- [ ] 可停止 Codex。
- [ ] Windows / WSL 至少一种完整跑通。
- [ ] UI 不知道 Codex CLI 参数细节。

---

## TASK-027 — 实现 ClaudeAdapter

**优先级：P0**

**依赖：TASK-025**

### 实施内容

> 原文档缺本节，格式与其它 Task 不一致，此处补齐。

支持：

```text
interactive
headless（-p / --print，能力允许时）
resume capability（--resume / --continue，能力允许时）
read-only 权限策略下发（见 ADR-0002）
```

CLI 参数封装在 Adapter 内，UI 不感知。

Adapter 需声明自己的 `AgentDefinition`（plan §116.2），
包括 `capabilities.resume`、`capabilities.readOnlyMode`、`permissionEnforcement`。

> 各 Agent CLI 的具体参数会随版本变化，**不要写死在多处**。
> 参数拼装只允许出现在 Adapter 的 `buildArgs()` 内。

### 验收标准

- [ ] 可从 UI 启动 Claude Code。
- [ ] 可发送输入。
- [ ] 可停止。
- [ ] Session 信息可保存（若 CLI 能提供）。
- [ ] 与 CodexAdapter 使用同一上层 Contract。

---

## TASK-028 — 实现 AgentManager

**优先级：P0**

**依赖：TASK-026, TASK-027, TASK-007**

### 实施内容

负责：

```text
Agent Registry lookup
AgentRun lifecycle
Process binding
Event translation
Persistence
```

### 执行模式（ADR-0002）

```ts
executionMode: "attended" | "orchestrated"
```

- `attended`：用户手动启动，允许无 worktree（Phase B 的唯一模式）。
- `orchestrated`：Workflow 自动调度，**必须**有 worktree。

AgentManager 在启动时校验：`orchestrated` 且 `worktree_id` 为空 → **拒绝启动**，
返回结构化错误。这是硬性拒绝，不是警告。

### 验收标准

- [ ] Codex / Claude 可以同时运行。
- [ ] AgentRun 独立状态。
- [ ] `executionMode` 落库，Phase B 阶段一律为 `attended`。
- [ ] `orchestrated` + 无 worktree 时拒绝启动（有单元测试）。
- [ ] exit code 正确保存。
- [ ] process crash 更新 run 状态。
- [ ] UI 可以查询 active runs。

---

## TASK-084 — 实现并发限制

**优先级：P1**

**依赖：TASK-028**

> 新增 Task（plan §147 有设计但无对应 Task，ADR-0005）。

### 实施内容

```ts
interface ConcurrencyPolicy {
  maxGlobalRuns: number;       // 默认 4
  maxRunsPerWorkspace: number; // 默认 3
  maxRunsPerAgent: number;     // 默认 2
}
```

超限时 Run 进入 `queued`，而不是直接失败。
队列必须持久化，App 重启后由 Reconciliation 决定是否继续排队。

### 无隔离并发的硬限制（优先级高于上述数值）

Phase B 的 Agent 没有 worktree，两个可写 Agent 并发会互相覆盖文件。
因此增加与隔离状态耦合的规则，**先于** `ConcurrencyPolicy` 判定：

```text
同一 Workspace 内：

  无 worktree + 可写    最多 1 个       ← 第二个直接拒绝，不排队
  无 worktree + 只读    可并行，不占名额
  有 worktree           按 ConcurrencyPolicy 正常并发
```

可写 / 只读由 `approvalMode` 判定：`read-only` 为只读，其余为可写；
无法确定时**保守按可写处理**。

被拒绝时给出可操作的错误，而不是干等：
「已有 Agent 正在直接修改此工作区，请先停止它」。

### 验收标准

- [ ] 三个上限都生效，可通过 Config Layers（TASK-080）调整。
- [ ] 超限 Run 状态为 `queued`，不是 `failed`。
- [ ] **第二个无 worktree 的可写 attended run 被拒绝**（不是排队），
      错误信息指出正在占用的 run。
- [ ] 无 worktree 的只读 run 可与可写 run 并行。
- [ ] 有 worktree 时不受该限制，按数值策略并发。
- [ ] 前一个 Run 结束后队列自动推进。
- [ ] Cancel 一个 queued Run 不影响其它排队项。
- [ ] 不产生死锁（有测试：填满配额后全部 cancel，断言队列清空）。

---

# Milestone 9 — Agent Run UI

目标：

> 能够实际作为日常双 Agent GUI 使用。

---

## TASK-029 — 实现 Agent Runs 面板

**优先级：P0**

**依赖：TASK-028, TASK-021**

### 实施内容

展示：

```text
Agent
Status
Elapsed
Workspace
Model
Current activity
```

### 验收标准

- [ ] 同时显示多个 Run。
- [ ] Running / Completed / Failed 状态实时更新。
- [ ] `attended` 模式（无 worktree）的 Run 显示常驻警告横幅
      「直接修改主工作区，未做隔离」。
- [ ] 可进入 Run 详情。
- [ ] 可 Cancel。

---

## TASK-030 — 实现 Agent Run Terminal

**优先级：P0**

**依赖：TASK-018, TASK-028**

### 验收标准

- [ ] Codex raw PTY 输出完整可见。
- [ ] Claude raw PTY 输出完整可见。
- [ ] Agent Terminal 与普通 Terminal 不混淆。
- [ ] 切换 Run 不杀进程。

---

## TASK-031 — Agent Output 批处理与性能优化

**优先级：P1**

**依赖：TASK-030**

### 实施内容

避免：

```text
每字符 React setState
```

使用：

```text
chunk buffer
16~50ms batch
```

### 验收标准

- [ ] 高频输出时 UI 不明显卡顿。
- [ ] 10MB 级日志不导致界面冻结。
- [ ] DB 不逐字符写入。

---

# Milestone 10 — Tasks

目标：

> 产品从 Session-first 升级到 Task-first。

---

## TASK-032 — 实现 Task Domain & CRUD

**优先级：P0**

**依赖：TASK-007, TASK-020**

### 实施内容

状态：

```text
draft
ready
running
needs_review
blocked
completed
failed
cancelled
```

### 验收标准

- [ ] 创建 Task。
- [ ] 编辑 Task。
- [ ] 删除/归档 Task。
- [ ] Task 与 Workspace 绑定。
- [ ] Task 可关联多个 AgentRun。

---

## TASK-033 — 实现 Task → Agent Run

**优先级：P0**

**依赖：TASK-028, TASK-032**

### 验收标准

用户可以：

```text
Create Task
→ Select Codex
→ Start
→ Watch Run
→ See Result
```

- [ ] Run 自动关联 Task。
- [ ] Task 状态随 Run 更新。
- [ ] 历史 Run 可查看。

---

## TASK-034 — 实现 Task 页面

**优先级：P0**

**依赖：TASK-032, TASK-033**

### 实施内容

显示：

```text
Description
Status
Runs
Changes
Artifacts
Activity
```

### 验收标准

- [ ] 一个 Task 多个 Run 可清晰展示。
- [ ] 当前 active run 可进入。
- [ ] completed run 可查看历史输出。

---

# Milestone 11 — Git Integration

目标：

> Agent 修改后，用户能够立即看到代码变化。

---

## TASK-035 — 实现 GitManager

**优先级：P0**

**依赖：TASK-012, TASK-010**

### 实施内容

支持：

```text
status
branch
diff
log
commit
```

### 验收标准

- [ ] Windows repo 工作。
- [ ] WSL repo 工作。
- [ ] Git 错误转为结构化错误。
- [ ] 不直接在 Renderer 运行 git。

---

## TASK-036 — 实现 DiffService

**优先级：P0**

**依赖：TASK-035**

### 实施内容

输出：

```text
files
status
additions
deletions
patch
```

### 验收标准

- [ ] 新增文件识别。
- [ ] 修改文件识别。
- [ ] 删除文件识别。
- [ ] rename 可正确处理或明确降级。

---

## TASK-037 — 实现 Changes UI

**优先级：P0**

**依赖：TASK-036**

### 实施内容

显示：

```text
3 files changed
+128
-18
```

支持文件 Diff。

### 验收标准

- [ ] Agent 修改后自动刷新。
- [ ] 不扫描 node_modules。
- [ ] Diff UI 可处理大文件基本场景。
- [ ] 可从 Changes 打开对应文件路径。

---

## TASK-086 — 实现 Git 状态刷新策略

**优先级：P1**

**依赖：TASK-035, TASK-037**

> 新增 Task（plan §99 有设计但无对应 Task）。
> TASK-037 的验收标准写了「Agent 修改后自动刷新」，但**没有定义刷新机制**，
> 不定义就会有人去 watch 整个 workspace（包括 node_modules）。

### 实施内容

刷新触发源（plan §99）：

```text
agent output event  → debounce 1~2s → git status
Run 状态变更        → 立即刷新
用户手动刷新        → 立即
窗口重新获得焦点     → 节流刷新
```

**不使用**文件系统监听作为第一版方案。
如确需 chokidar，必须显式忽略 `node_modules` / `.git` / `dist` / `.teskra`，
且只监听 workspace root。

`git status` 调用必须：

- 走 CommandRunner，带 timeout
- 同一 workspace 的并发调用合并为一次（in-flight dedup）

### 验收标准

- [ ] Agent 高频输出时 `git status` 调用频率被 debounce 限制（有测试断言调用次数）。
- [ ] 不扫描 `node_modules`。
- [ ] 并发刷新请求被合并。
- [ ] 大仓库（>10k 文件）下 UI 不卡顿。
- [ ] `git status` 超时不影响 Run 本身。

---

# Milestone 12 — Run Persistence & Recovery

目标：

> 应用关闭、崩溃、WSL 重启后不会“状态全乱”。

---

## TASK-038 — 持久化 Agent Events

**优先级：P0**

**依赖：TASK-028, TASK-007**

### 实施内容

保存：

```text
agent.started
agent.output chunks
command
error
completed
```

### 验收标准

- [ ] 应用重启后能查看历史 Run。
- [ ] Output 采用批量写入。
- [ ] 不因单条 event 写 DB 导致性能问题。

---

## TASK-039 — 建立 Run Directory + JSONL Log

**优先级：P1**

**依赖：TASK-038**

### 实施内容

目录（见 ADR-0003）：

```text
~/.teskra/runs/<runId>/
├─ run.json
├─ events.jsonl
├─ terminal.log
├─ handoff.json
├─ diff.patch
└─ artifacts/
```

写入顺序（plan §137）：

```text
关键 Runtime Event
  → 先 append events.jsonl（durable）
  → 再 batch 入 SQLite（可查询）
```

`events.jsonl` 的行号即 `agent_events.seq`，两者必须对齐。

### 验收标准

- [ ] 每个 Run 独立目录。
- [ ] JSONL append-only，行号与 `agent_events.seq` 一致。
- [ ] SQLite 不可用时 raw log 仍保留。
- [ ] Secret 不写入日志（复用 TASK-004 的脱敏）。
- [ ] 进程崩溃后 events.jsonl 不出现半行 JSON（按行 flush）。

---

## TASK-040 — 实现 ReconciliationService

**优先级：P0**

**依赖：TASK-028, TASK-035**

### 目标

数据库不是 Runtime 真相源。

### 实施内容

综合：

```text
DB state
Process registry
PID
Worktree
Git
```

### 验收标准

- [ ] DB=running + process dead → interrupted。
- [ ] missing workspace 被识别。
- [ ] broken worktree 被识别。
- [ ] reconciliation 可重复执行且幂等。

---

## TASK-085 — 实现 Process Watchdog

**优先级：P1**

**依赖：TASK-014, TASK-040**

> 新增 Task（plan §148 有设计但无对应 Task，ADR-0005）。

### 实施内容

每个 Agent Process 记录：

```text
startedAt
lastOutputAt
lastInputAt
```

检测「长期无输出」时，**不自动认定死亡**，只在 UI 标记：

```text
Possibly stalled (no output for 12m)
```

并提供：

```text
Interrupt / Send input / Restart / 查看 Terminal
```

阈值可配（TASK-080），默认 10 分钟。

### 验收标准

- [ ] `last_output_at` 持久化到 `agent_runs`（plan §139.1 已有该列）。
- [ ] 长时间无输出的 Run 在 UI 标记为 possibly stalled。
- [ ] **不会**自动 kill 疑似卡住的进程（等待用户输入是正常状态）。
- [ ] 阈值可配置。
- [ ] Fake Agent 的 `hang` scenario 能触发该标记（有测试）。

---

## TASK-041 — 实现 DoctorService

**优先级：P0**

**依赖：TASK-023, TASK-040**

### 检查

```text
Git
WSL
Distro
Codex
Claude
Workspace
Worktree
Run
Branch
Conflict
```

### 验收标准

- [ ] 可输出系统健康报告。
- [ ] 每个问题有 severity。
- [ ] 可识别 stale running run。
- [ ] UI 有 Doctor 页面或入口。

---

## TASK-042 — 实现 Resume Run

**优先级：P0**

**依赖：TASK-040, TASK-041**

### 实施内容

恢复：

```text
workspace
branch
worktree
provider session（如果支持）
context summary
```

### 验收标准

- [ ] interrupted run 可恢复。
- [ ] 原 PID 不存在时不假装恢复原进程。
- [ ] provider 支持原生 resume 时使用。
- [ ] 不支持时创建新 session 并注入上下文。

---

# Milestone 13 — Git Worktree

目标：

> 多 Agent 可以真正同时工作而不互相覆盖文件。

---

## TASK-043 — 实现 WorktreeManager

**优先级：P0**

**依赖：TASK-035**

### 实施内容

支持：

```text
create
list
validate
remove
```

命名与位置（见 ADR-0003，三者不要混用）：

```text
Branch 名：      agent/<taskId>/<agentId>/<runId>
Worktree 目录：  <runtime.dataRoot>/worktrees/<workspaceId>/<runId>/
Commit 前缀：    agent(<agentId>): <taskId> <summary>
```

> **不要**放在 repo 同级的 `../.agent-worktrees/`（plan §36 旧写法）。
> WSL workspace 的 worktree 必须落在 WSL 文件系统内，
> 路径由 `WorkspaceRuntime.resolveDataRoot()`（TASK-010）给出。

创建 worktree 后必须写入 `.git/info/exclude`（**不是**用户的 `.gitignore`）：

```text
.teskra/handoff/
.teskra/artifacts/
```

否则 Agent 产出的 handoff 文件会污染 diff（见 ADR-0004）。

### 验收标准

- [ ] 创建独立 branch。
- [ ] 创建独立 worktree，位置符合 ADR-0003。
- [ ] `.git/info/exclude` 已排除运行期产物目录。
- [ ] Codex 可在 worktree 内运行。
- [ ] Claude 可在另一个 worktree 内运行。
- [ ] 两者互不影响。
- [ ] WSL workspace 的 worktree 落在 WSL 文件系统内。

---

## TASK-087 — 实现 Agent 自动 Commit

**优先级：P1**

**依赖：TASK-043, TASK-035**

> 新增 Task（plan §67 有设计但无对应 Task，ADR-0005）。

### 目标

Agent Run 完成后在其 worktree 内自动生成一个本地 commit，**默认不 push**。

### 实施内容

格式（ADR-0003）：

```text
agent(codex): TASK-103 implement rate history api
```

commit body 附 Handoff summary 与 runId，便于 bisect 与回溯。

规则：

- 仅在 worktree 内 commit，**永不**在主工作区 commit。
- 无变更时跳过，不产生空 commit。
- **永不自动 push**（`NETWORK_WRITE`，必须用户显式操作）。
- commit 失败不使 Run 失败，记 warning 并保留未提交变更。

### 验收标准

- [ ] Run 完成后 worktree 内产生 commit。
- [ ] 主工作区永远不会被 commit（有测试）。
- [ ] 无变更时不产生空 commit。
- [ ] 无任何自动 push 路径。
- [ ] commit message 含 agentId / taskId / runId。
- [ ] commit 失败时 Run 仍标记完成，变更不丢失。

---

## TASK-044 — Worktree Lifecycle State

**优先级：P0**

**依赖：TASK-043, TASK-007**

### 状态

```text
creating
ready
dirty
conflict
merged
discarded
missing
orphaned
```

### 验收标准

- [ ] 状态可持久化。
- [ ] 实际 git 状态会覆盖 stale DB。
- [ ] missing worktree 可被 doctor 识别。

---

## TASK-045 — Worktree Merge Preflight

**优先级：P0**

**依赖：TASK-043, TASK-036**

### 检查

> 补齐 plan §133 中原本遗漏的两项（base branch、acceptance criteria）。

```text
main checkout clean
agent worktree clean / already committed
branch exists
base branch is expected one
no ongoing merge / rebase / cherry-pick
worktree healthy
required tests passed
acceptance criteria passed      ← 条件式，见下
```

### 关于 Acceptance Criteria 检查

Criteria 在 **Phase F**（TASK-048）才实现，本 Task 在 **Phase E**。
因此该检查项设计为**条件式**，而不是硬依赖：

```text
Task 无 confirmed criteria set  → 该检查项返回 skipped，不阻塞 merge
Task 有 confirmed criteria set  → 存在 required 且未 pass 的项即 blocker
```

Phase E 阶段该分支恒为 `skipped`；Phase F 完成后自动生效，**无需回头改代码**。
Preflight 结果中必须**显式列出** `skipped` 的检查项，
不能让用户误以为 criteria 已通过。

### 验收标准

- [ ] 主工作区 dirty 时拒绝 Merge。
- [ ] Agent branch 不存在时拒绝。
- [ ] base branch 不符预期时拒绝。
- [ ] 存在未完成的 merge/rebase 时拒绝。
- [ ] Task 无 criteria set 时，该检查返回 `skipped` 而非 `pass`，且在结果中可见。
- [ ] Task 有 criteria set 且 required 项未通过时拒绝（Phase F 后验证）。
- [ ] 返回结构化 blocker（每项含 code / message / 可否 override）。
- [ ] 不自动破坏现场。

---

## TASK-046 — Merge Conflict Preservation

**优先级：P0**

**依赖：TASK-045**

### 验收标准

发生 conflict 时：

- [ ] 不删除 worktree。
- [ ] 不删除 branch。
- [ ] 不清空 diff。
- [ ] Run/Task 标记为 conflict / needs review。
- [ ] UI 能给出后续处理入口。

---

## TASK-047 — Cancel / Discard / Archive / Cleanup 分离

**优先级：P1**

**依赖：TASK-044**

### 验收标准

- [ ] Cancel 只停止进程。
- [ ] Discard 明确丢弃修改，需要确认。
- [ ] Archive 只影响历史显示。
- [ ] Cleanup 仅清理安全资源。
- [ ] 未合并 branch 默认不删除。

---

# Milestone 14 — Acceptance Criteria

目标：

> Task 有明确验收合同，而不是“Agent 说做完就是做完”。

---

## TASK-048 — 实现 AcceptanceCriteria Domain

**优先级：P0**

**依赖：TASK-032, TASK-007**

### 实施内容

支持：

```text
version
criterion
category
required
status
```

### 验收标准

- [ ] 一个 Task 可有多版 Criteria。
- [ ] 旧版本可 supersede。
- [ ] Criteria 可在 UI 编辑。
- [ ] Run 绑定 Criteria version。

---

## TASK-049 — 实现 Criteria UI

**优先级：P1**

**依赖：TASK-048**

### 验收标准

用户可：

```text
Add
Edit
Remove
Confirm
```

Criterion。

- [ ] Confirm 后产生 immutable version。
- [ ] 后续修改创建新 version。

---

# Milestone 15 — Artifact & Handoff

目标：

> Agent 不自由互聊，而是通过结构化结果协作。

---

## TASK-050 — 实现 ArtifactStore

**优先级：P0**

**依赖：TASK-007, TASK-032**

### 类型

```text
plan
implementation
review
test-result
diff
decision
handoff
```

### 验收标准

- [ ] Artifact 与 Task / Run 关联。
- [ ] 支持 text / file path / metadata。
- [ ] UI 可查看 Artifact。

---

## TASK-079 — 实现 Prompt Template 外置

**优先级：P1**

**依赖：TASK-080**

> 新增 Task（plan §102 有设计但无对应 Task，ADR-0005）。
> TASK-051 的 Handoff 文件契约依赖它注入路径变量。

### 实施内容

模板外置，不写死在代码里：

```text
内置：  resources/prompts/{plan,implement,review,fix,test}.md
覆盖：  <repo>/.teskra/prompts/*.md   （团队可提交共享）
```

可注入变量：

```text
{{task.title}} {{task.description}}
{{criteria}}                    Acceptance Criteria 列表
{{role}}
{{memory}}                      Workspace Memory（经 ContextBuilder 裁剪）
{{previousHandoff}}
{{env.TESKRA_HANDOFF_PATH}}     ADR-0004
{{env.TESKRA_ARTIFACT_DIR}}
```

模板中必须包含「完成后写入 handoff 文件」的明确指令（ADR-0004 的前提）。

### 验收标准

- [ ] 5 个内置模板存在且可渲染。
- [ ] repo-local 模板可覆盖内置模板。
- [ ] 未知变量渲染失败时给出明确错误，不静默留下 `{{...}}`。
- [ ] 渲染结果可通过 Facade 方法取回并在测试中断言
      （UI 预览由更晚的 TASK-068 提供，本 Task 只保证可取回，不依赖它）。
- [ ] Prompt 中不注入任何 secret。

---

## TASK-051 — 实现 WorkerHandoff Protocol

**优先级：P0**

**依赖：TASK-050, TASK-079**

### 字段

```text
runId
type            implementation | review | test | analysis | blocker
summary
filesChanged
commandsRun
tests
findings
blockers
suggestedNextAction
```

### 传输机制（见 ADR-0004）

**通过文件交付，不解析 stdout。**

原文档写「可从 Agent output 生成」，与 plan §49「不要过度解析」矛盾；
且从含 ANSI 转义、进度条重绘的 PTY 流里 parse JSON 极其脆弱，TUI 型 Agent 更是根本不打到 stdout。

启动 Agent 时注入：

```text
TESKRA_RUN_ID=<runId>
TESKRA_HANDOFF_PATH=<worktree>/.teskra/handoff/<runId>.json
TESKRA_ARTIFACT_DIR=<worktree>/.teskra/artifacts/<runId>/
```

Prompt Template（TASK-079）中说明写入要求。

进程退出后：

```text
读取 TESKRA_HANDOFF_PATH
├─ 存在且 Zod 通过 → parse_status = ok
├─ 存在但校验失败   → parse_status = degraded，保留 raw_path，记 warning
└─ 不存在          → parse_status = missing，回退到 terminal.log 摘要
```

**任何情况都不阻塞 Run 完成**，也不因 parse 失败丢弃 raw output。

### 验收标准

- [ ] Handoff 有 Zod Schema。
- [ ] Handoff 从 `TESKRA_HANDOFF_PATH` 文件读取，代码中无 stdout JSON 解析。
- [ ] 三种 `parse_status` 都有测试覆盖。
- [ ] Parser 失败时保留 raw 文件，Run 仍标记完成。
- [ ] handoff / artifacts 目录已被 `.git/info/exclude` 排除，不出现在 diff 中。
- [ ] 下一 Agent 可接收 Handoff Context。

---

# Milestone 16 — Review System

目标：

> Claude / Codex 可以作为独立 Reviewer。

---

## TASK-052 — 实现 Reviewer Role

**优先级：P0**

**依赖：TASK-051, TASK-043**

### 实施内容

Review isolation：

```text
shared-readonly
worktree-readonly
disposable-snapshot
```

### 验收标准

- [ ] Reviewer 默认不能污染 implement worktree。
- [ ] 无法强制只读的 CLI 使用 disposable snapshot。
- [ ] Review 结束后 snapshot 可安全清理。

---

## TASK-053 — 实现 ReviewFinding

**优先级：P0**

**依赖：TASK-052**

### 支持

```text
critical
high
medium
low
file
line
criterionId
evidence
```

### 验收标准

- [ ] Review 输出可解析为 Finding。
- [ ] Finding 可关联文件和 Criterion。
- [ ] UI 可展示 Findings。

---

## TASK-054 — 实现 Criteria Review Result

**优先级：P0**

**依赖：TASK-048, TASK-053**

### 验收标准

每个 Criterion 返回：

```text
pass
fail
unknown
evidence
```

- [ ] Required Criterion fail → overall fail。
- [ ] Unknown 不自动算 pass。
- [ ] Review result 可持久化。

---

# Milestone 17 — Workflow Engine

目标：

> 从“用户手动启动多个 Agent”升级到明确的自动执行流程。

---

## TASK-055 — 实现 WorkflowDefinition

**优先级：P0**

**依赖：TASK-003**

### Node 类型

```text
agent
shell
checkpoint
condition
criteria-gate
review-panel
```

### DAG 必须无环

`dependsOn` 图**严格无环**，检测到环即拒绝加载，无例外。

Iterate（Implement → Review → Fix → Review）**不是图内的环**，
而是同一个无环 DAG 被执行多轮，循环由 WorkflowEngine 外层的
IterationController 控制（见 plan §153「Iterate 与 DAG 的关系」）。

### 每轮节点激活（runOn）

`AgentWorkflowNode` 增加：

```ts
runOn?: "first" | "subsequent" | "always";   // 默认 "always"
```

用于区分「第 1 轮跑 implement，第 2 轮起跑 fix」，
详见 plan §153「每轮的节点激活规则」。

### 验收标准

- [ ] 使用 discriminated union。
- [ ] JSON/YAML 可加载。
- [ ] Zod validation。
- [ ] `runOn` 已定义，默认值为 `always`。
- [ ] 每轮过滤后子图仍连通到终止节点，否则加载时拒绝。
- [ ] 含环的定义被拒绝，错误信息指出环上的节点。
- [ ] 条件边的 `on` 取值与上游节点类型做交叉校验（plan §153）。
- [ ] 引用不存在节点的 `dependsOn` 被拒绝。

---

## TASK-056 — 实现 WorkflowRun

**优先级：P0**

**依赖：TASK-055, TASK-007**

### 验收标准

- [ ] WorkflowRun 独立于 Task。
- [ ] 可记录 step 状态。
- [ ] 可记录 iteration。
- [ ] App 重启后可恢复 Workflow 状态。

---

## TASK-057 — 实现 WorkflowEngine 基础 DAG

**优先级：P0**

**依赖：TASK-056, TASK-028**

### 支持

```text
dependsOn
sequential
parallel
cancel
failure
```

### 验收标准

- [ ] 无依赖步骤可并行运行。
- [ ] 依赖失败时后续步骤按策略跳过（`skipped` 沿 DAG 传播）。
- [ ] 未激活的条件边使下游进入 `skipped`，而非永久 pending。
- [ ] Cancel 能停止 queued/running steps。
- [ ] 引擎本身**不实现循环**——多轮由 TASK-062 的 IterationController 驱动，
      每轮调用一次本引擎执行一个无环 DAG。
- [ ] 每轮开始时按 `runOn` 过滤节点，被过滤节点视为 `skipped` 且**出边照常激活**
      （否则第 2 轮的 test 会因等 implement 而永久阻塞——需有测试覆盖）。
- [ ] 不产生无限调度（有测试：构造菱形依赖 + 全 skip 分支，断言能终止）。

---

## TASK-058 — 实现 Shell Workflow Step

**优先级：P1**

**依赖：TASK-057, TASK-012**

### 验收标准

可执行：

```text
dotnet test
npm test
git status
```

- [ ] 有 timeout。
- [ ] exitCode 成为 step result。
- [ ] Output 保存为 Artifact。

---

# Milestone 18 — Multi-Agent Orchestrator

目标：

> 实现第一条真正有价值的 Multi-Agent 工作流。

---

## TASK-059 — 实现 Dispatch Primitive

**优先级：P0**

**依赖：TASK-057**

### 工作流

```text
Task
→ One Agent
→ Handoff
```

### 验收标准

- [ ] 可指定 Agent。
- [ ] 可指定 Worktree Isolation。
- [ ] 完成后生成 Handoff。

---

## TASK-060 — 实现 Review Panel

**优先级：P0**

**依赖：TASK-054, TASK-057**

### 工作流

```text
Diff
├→ Claude Review
├→ Codex Review
└→ Future Reviewer
```

### 验收标准

- [ ] Reviewer 互相看不到对方结果。
- [ ] Review 可以并行。
- [ ] 每个 Reviewer 生成独立结果。
- [ ] Panel 生成 Aggregate。

---

## TASK-061 — 实现 Review Aggregator

**优先级：P0**

**依赖：TASK-060**

### Policy

```text
critical → block
high → block
medium → configurable
```

### 验收标准

- [ ] 不是简单多数投票。
- [ ] 1 个 critical finding 即可阻止通过。
- [ ] disagreement 被保留。
- [ ] Aggregate 可被 UI 查看。

---

## TASK-062 — 实现 Iterate Primitive

**优先级：P0**

**依赖：TASK-059, TASK-060, TASK-061**

### 流程

```text
Implement
→ Review
→ Fail?
→ Fix
→ Review
```

### Safety Cap（plan §124）

原 Task 只有 `maxRounds`，缺 `maxTotalRounds`，
会导致「用户改了 Criteria → 计数清零 → 实际无限循环」。两个上限都必须实现：

```ts
interface IterationPolicy {
  maxRoundsPerCriteriaVersion: number;  // 默认 3
  maxTotalRounds: number;               // 默认 8，跨 Criteria 版本累计
}
```

计数持久化在 `workflow_runs.current_iteration` / `total_iterations`（plan §139.1）。

### 验收标准

- [ ] 支持 `maxRoundsPerCriteriaVersion`，默认 3。
- [ ] 支持 `maxTotalRounds`，默认 8，**跨 Criteria 版本累计不清零**。
- [ ] 任一上限触发时：`WorkflowRun.status = needs_user_review`
      **且** `Task.status = needs_review`（两个实体两个状态，见 plan §124）。
- [ ] 计数在 App 重启后仍然正确（持久化，不是内存计数）。
- [ ] 每一轮保留独立 Run/Artifact。
- [ ] 有测试：构造永远 fail 的 Reviewer，断言最终停止且轮数 = 上限。

---

## TASK-063 — 实现默认 Full Workflow

**优先级：P0**

**依赖：TASK-062, TASK-058**

### 默认流程

```text
Acceptance Criteria
↓
Create Worktree
↓
Codex Implement
↓
Build/Test
↓
Claude Review
↓
Criteria Gate
├─ PASS → User Review
└─ FAIL → Codex Fix → Test → Review
```

### 验收标准

- [ ] 可从 Task 页面一键启动。
- [ ] 每一步有 UI 状态。
- [ ] 失败不会自动无限循环。
- [ ] 最终展示 Diff + Criteria Result。

---

# Milestone 19 — Permission System

目标：

> Workbench 统一管理各 Agent 的权限策略，并留存完整审计。

> **重要：本 Milestone 已按 ADR-0002 重写。**
>
> 原设计假设 Teskra 可以在命令执行**之前**拦截并弹审批。**这做不到**——
> Codex / Claude 在自己的 PTY 内 fork 子进程执行命令，Teskra 只能看到 stdout 字节流，
> 看到时命令已经执行完毕。Teskra 是 PTY 的**宿主**，不是 Agent 的**系统调用网关**。
>
> 三层实际生效的机制：**策略下发 → 环境隔离 → 事后审计**。

---

## TASK-077 — 实现 Agent 权限能力声明与策略投影

**优先级：P1**

**依赖：TASK-022, TASK-025**

### 目标

把 Teskra 的统一权限策略，翻译成各 Agent CLI 自己的机制。

### 实施内容

`AgentDefinition`（TASK-022）增加：

```ts
permissionEnforcement:
  | "native"    // CLI 支持回调式审批（如 Claude Code permission-prompt-tool）
  | "config"    // CLI 支持策略文件 / 启动参数（如 approval mode + sandbox）
  | "none";     // 无法约束，只能靠环境隔离

permissionMapping?: {
  buildConfig?(profile: TeskraPermissionProfile): AgentPermissionConfig;
  buildArgs?(profile: TeskraPermissionProfile): string[];
};
```

投影目标：

```text
Claude Code  →  settings.json permissions / PreToolUse hook
Codex        →  approval mode + sandbox 参数
Fake Agent   →  none
```

### 验收标准

- [ ] 每个内置 Agent 声明了 `permissionEnforcement`。
- [ ] `config` 型 Agent 启动前生成对应策略配置。
- [ ] `none` 型 Agent 启动时 UI 明确提示「该 Agent 的权限无法由 Teskra 约束，
      仅依赖 worktree 隔离」。
- [ ] 投影逻辑有单元测试（给定 profile，断言生成的配置/参数）。
- [ ] 不生成任何声称能拦截但实际无效的配置。

---

## TASK-064 — 实现 CommandClassifier

**优先级：P1**

**依赖：TASK-012**

> 用途已改为**审计打标**，不是执行前的放行判定。分类规则本身不变。

### 风险等级

```text
READ_ONLY
WORKSPACE_WRITE
SYSTEM_WRITE
NETWORK_WRITE
DESTRUCTIVE
```

### 验收标准

- [ ] `git status` → READ_ONLY。
- [ ] `git push` → NETWORK_WRITE。
- [ ] `git reset --hard` → DESTRUCTIVE。
- [ ] `rm -rf` / `docker system prune` → DESTRUCTIVE。
- [ ] 第一版规则驱动，不使用 LLM 猜测。
- [ ] 无法识别的命令返回 `UNKNOWN`，**不默认降级为 READ_ONLY**。
- [ ] 规则表可测试、可扩展，不散落在业务代码里。

---

## TASK-065 — 实现 PermissionManager（策略 + 审计）

**优先级：P1**

**依赖：TASK-064, TASK-007, TASK-077**

### 职责

```text
1. 维护 TeskraPermissionProfile（按 Workspace / Agent / Role）
2. 启动 Agent 前，经 TASK-077 投影为 CLI 侧策略
3. 从 PTY 输出流识别已执行命令 → 打风险标签 → 写 permission_audit
```

### 规则动作（见 plan §44 修订版）

```text
allow    写入下发策略的 allow 列表
deny     写入下发策略的 deny 列表
ask      仅 permissionEnforcement = native 时生效，其余自动降级为 audit
audit    不干预执行，仅记录
```

### 验收标准

- [ ] `permission_rules` / `permission_audit` 可持久化（schema 见 plan §139.1）。
- [ ] 规则可按 Workspace / Agent 生效，支持全局默认。
- [ ] `ask` 在非 native Agent 上自动降级为 `audit`，并在 UI 说明原因。
- [ ] 审计记录含 runId / command / cwd / risk / 识别时间。
- [ ] 审计字段名与语义不误导：`detected_at` 表示**识别到**，不是**阻止于**。
- [ ] 代码中不存在任何声称"执行前拦截"的路径。

---

## TASK-066 — 实现 Permission UI

**优先级：P1**

**依赖：TASK-065**

### 两种形态

**A. 审批 UI —— 仅 `permissionEnforcement: "native"` 的 Agent**

显示：

```text
Agent / Command / CWD / Risk / Reason
```

按钮：

```text
Allow Once
Allow Session
Always Allow
Deny
```

**B. 审计视图 —— 其余所有 Agent**

Run 详情页的 Commands tab 中，按风险等级高亮已执行命令，
`DESTRUCTIVE` / `NETWORK_WRITE` 置顶提示。

### 验收标准

- [ ] `native` Agent 显示审批 UI，用户选择能真正影响执行。
- [ ] 非 `native` Agent **不显示**审批按钮（避免误导用户以为拦截生效）。
- [ ] 非 `native` Agent 显示审计视图，高风险命令有明显视觉标记。
- [ ] Settings 中可查看每个 Agent 的 `permissionEnforcement` 及其含义说明。
- [ ] Permission 规则可在 Settings 中 CRUD。
- [ ] 审计日志可按 Run / Workspace / 风险等级筛选。

---

## TASK-088 — 实现 Credential Store

**优先级：P2**

**依赖：TASK-009, TASK-080**

### 目标

敏感环境变量不明文存 SQLite / workspace 配置（plan §60）。

### 实施内容

```text
Windows   → DPAPI / Credential Manager（Electron safeStorage）
WSL/Linux → Electron safeStorage（后端可能是 kwallet/gnome-keyring）
不可用时  → 明确降级，UI 提示"该环境无法安全存储，敏感变量不会被持久化"
```

Workspace 的 `env_json` 只存**非敏感**变量，敏感值存 key 引用。

### 验收标准

- [ ] 敏感 env 不出现在 `workspaces.env_json` 中。
- [ ] 敏感 env 不出现在日志、审计、Run Directory 中。
- [ ] `safeStorage.isEncryptionAvailable()` 为 false 时明确降级而非静默明文写入。
- [ ] `.teskra/config.json`（可提交）中禁止出现敏感值，有校验。

---

# Milestone 20 — Memory

目标：

> 建立轻量 Workspace Memory，不先上向量数据库。

---

## TASK-067 — 实现 Workspace Memory

**优先级：P2**

**依赖：TASK-007, TASK-009**

### 类型

> 补 `preference`（plan §46 有，原 Task 遗漏），与 §139.1 的 schema 对齐。

```text
architecture
convention
decision
command
known_issue
preference
summary
```

### 验收标准

- [ ] Memory 与 Workspace 绑定。
- [ ] 可以手工 CRUD。
- [ ] 可读取 `<repo>/.teskra/memory/`（**不是** `.workspace-ai/`）。
- [ ] 类型枚举与 plan §139.1 的 `memories.type` 一致。
- [ ] 不存敏感 token。

---

## TASK-068 — 实现 ContextBuilder

**优先级：P2**

**依赖：TASK-067, TASK-051**

### 输入

```text
Task
Role
Acceptance Criteria
Workspace Memory
Previous Handoff
```

### 验收标准

- [ ] 不把全部历史无脑注入。
- [ ] Context 可预览。
- [ ] Context 有大小限制。
- [ ] Agent Adapter 只接收最终 Context。

---

# Milestone 21 — Reliability & Maintenance

目标：

> 系统长期运行后仍然可维护。

---

## TASK-069 — 实现 RetentionService

**优先级：P2**

**依赖：TASK-039, TASK-044**

### 支持

```text
merged worktree retention
run logs retention
discarded run cleanup
```

### 验收标准

- [ ] 有 dry-run。
- [ ] 未合并 branch 永不自动删除。
- [ ] GC 可取消。
- [ ] 所有删除操作可审计。

---

## TASK-070 — 实现 Recovery Center

**优先级：P1**

**依赖：TASK-041, TASK-042**

### 显示

```text
Interrupted Runs
Broken Worktrees
Dirty Worktrees
Conflicts
Stale Processes
```

### 验收标准

- [ ] Home 页面可进入。
- [ ] 每个问题有建议操作。
- [ ] Resume / Repair / Inspect 分离。

---

## TASK-089 — 实现 Agent Routing Profile

**优先级：P2**

**依赖：TASK-022, TASK-024**

> 新增 Task（plan §144 有设计、TASK-022 只声明了字段，但无实现 Task，ADR-0005）。

### 实施内容

```ts
interface AgentRoutingProfile {
  agentId: string;
  useWhen?: string;
  strengths?: AgentStrength[];   // implementation | review | architecture | ...
  costClass?: "low" | "medium" | "high";
  priority?: number;
}
```

第一版：

- 用户手动选择 Agent，Routing Profile 只用于**排序与推荐提示**。
- Agent 不可用 / rateLimited 时，UI 建议备选 Agent，**不自动切换**。

> plan §145 的结论：Quota 是 Routing Signal，不是核心依赖。
> **不得**依赖非官方的配额解析来决定 Runtime 是否工作。

### 验收标准

- [ ] Agent Picker 按 role 与 routing profile 排序。
- [ ] 不可用 Agent 有明确标记与备选建议。
- [ ] **不自动切换 Agent**（第一版）。
- [ ] quota 解析失败不影响 Agent 可用性判定。

---

## TASK-071 — 实现 Home Dashboard

**优先级：P2**

**依赖：TASK-032, TASK-070**

### 展示

```text
Active Tasks
Waiting For You
Interrupted Runs
Merge Ready
Agent Availability
Recent Failures
```

### 验收标准

- [ ] 数据来自真实 Runtime/DB。
- [ ] 不阻塞启动。
- [ ] 可直接跳转到对应 Task/Run。

---

# Milestone 22 — Packaging

目标：

> Windows 用户无需 Microsoft Store 即可安装。

---

## TASK-072 — 配置 electron-builder

**优先级：P1**

**依赖：Phase A1~A3 + Phase B 完成（即 MVP-1）**

### 输出

```text
NSIS installer
portable exe
```

### 验收标准

- [ ] Clean Windows 机器可安装。
- [ ] node-pty native module 正常加载。
- [ ] 安装包不依赖 Microsoft Store。
- [ ] 卸载不删除用户项目文件。

---

## TASK-073 — Windows 签名与发布流程

**优先级：P2**

**依赖：TASK-072**

### 实施内容

建立：

```text
build
sign
package
checksum
release notes
```

### 验收标准

- [ ] Release artifact 可复现。
- [ ] 版本号自动注入。
- [ ] 安装包生成 SHA256。
- [ ] 文档记录签名流程。

---

# Milestone 23 — Test Strategy

---

## TASK-074 — Runtime 单元测试套件

**优先级：P0**

**依赖：TASK-014, TASK-028, TASK-040**

### 必须覆盖

```text
ProcessManager
CommandRunner
WorkspaceRuntime
AgentManager
Reconciliation
paths（TASK-078）
Config Layers（TASK-080）
Repository 层（TASK-007）
Migration（TASK-006 / TASK-090）
```

> 本 Task 不是一次性完成的。每个 Runtime 模块的测试应随该模块的 Task 一起交付，
> 本 Task 在 **Phase D 末尾**汇总检查覆盖面并补齐缺口。
>
> **WorktreeManager / MergePreflight 不在本 Task 范围内**——
> 它们属于 Phase E，由 **TASK-075（Worktree Safety Reference Tests）** 覆盖。
> 原依赖里写了 TASK-043 会造成 Phase D 依赖 Phase E 的倒置。

### 验收标准

- [ ] 至少覆盖关键 happy path。
- [ ] timeout 有测试。
- [ ] crash 有测试。
- [ ] stale DB state 有测试。

---

## TASK-075 — Worktree Safety Reference Tests

**优先级：P0**

**依赖：TASK-046**

### 必须覆盖

```text
dirty main blocks merge
unmerged branch survives cleanup
merge conflict preserves worktree
missing worktree becomes broken
cleanup is idempotent
```

### 验收标准

- [ ] 每个场景自动化。
- [ ] 不依赖人工验证。
- [ ] 临时 git repo 测试执行后自动清理。

---

## TASK-076 — Electron E2E Tests

**优先级：P1**

**依赖：TASK-018, TASK-030, TASK-034, TASK-037, TASK-083**

> 依赖修正：原依赖漏了 Terminal（018/030）与 Fake Agent（083），
> 而验收标准里三者都要用到。

### 使用

```text
Playwright（_electron API）
```

覆盖：

```text
Open Workspace
Create Terminal
Create Task
Start Fake Agent（TASK-083）
View Diff
```

### CI 环境要求

```text
主 CI：windows-latest（这是 Windows-first 产品，主路径必须在 Windows 上验证）
辅 CI：ubuntu-latest + xvfb（可选，用于快速反馈）
```

测试必须用独立的 `TESKRA_HOME`（TASK-078）指向临时目录，
禁止污染开发者本机的 `~/.teskra/`。

### 验收标准

- [ ] CI 可执行，主 CI 在 windows-latest 上。
- [ ] 每个测试用例使用独立的 `TESKRA_HOME` 临时目录，结束后清理。
- [ ] Fake Agent 不消耗真实 Codex/Claude 额度。
- [ ] 测试不依赖本机已安装 Codex/Claude。
- [ ] 至少覆盖主路径。

---

# Milestone 24 — Multi-Account & Agent Profiles

多订阅账号与 Agent Profile 管理。设计说明与「为什么这么定」见
`docs/teskra-multi-account-subscription-implementation.md`（下称「设计文档」），
本 Milestone 是 TASK-094～118 编号、优先级、依赖与验收标准的**唯一权威**
（设计文档 §59 只是带设计理由的副本）。相关裁决：ADR-0009 / ADR-0010 / ADR-0011。

**数据库 Schema 权威在 plan §139.1**（`docs/teskra-implementation-plan-v2.md`）。
本 Milestone 涉及的 `012_agent_account_profiles.sql`（`agent_account_profiles` /
`account_events` / `profile_aliases`）、`013_agent_run_account_profile.sql`
（`agent_runs` 四列）、`014_agent_execution_profiles.sql` 三个 migration 的
表结构以设计文档 §8 为准，已同步进 plan §139.1。

一致性校验：改 Task 集合 / 优先级 / 依赖时先改本文档，再跑
`npm run check:task-docs`（`scripts/check-task-docs.mjs`）核对设计文档 §59 是否同步。

推荐实施顺序（Phase A～F）见设计文档 §60；要点：**TASK-112 必须与 TASK-100 同批做**
（否则 crash recovery 会用当前默认 Profile 恢复历史 Run），
**TASK-118 必须排在 TASK-111 之前**（先装锁再开门）。

---

## TASK-094 — Account Profile Contracts

**优先级：P0**

**依赖：TASK-003**

### 实施内容

```text
AgentAccountProfile
AccountProfileStatus
AccountAuthType
AgentRuntimeIdentity
Zod schemas
```

### 验收标准

- [ ] Main / Renderer 共用 contracts。
- [ ] 无重复类型。
- [ ] typecheck 通过。
- [ ] `configHome` 的 Zod 校验拒绝 `~` 开头、含环境变量引用、非绝对的路径（设计文档 §5.3）。
- [ ] `runtime.kind` 第一阶段只接受 `windows` / `wsl`。
- [ ] `runtime.kind === "wsl"` 时 `distro` 必填——不允许留空去跟随以后可能变化的默认 distro。

---

## TASK-095 — Account Profile Database Migration

**优先级：P0**

**依赖：TASK-006, TASK-094**

### 实施内容

新增 migration `012` 与 `013`（设计文档 §8）：

```text
012  agent_account_profiles（含 max_concurrent_runs）
012  account_events
012  profile_aliases
013  agent_runs.account_profile_id
013  agent_runs.execution_profile_id
013  agent_runs.profile_snapshot_json
013  agent_runs.failure_classification_json
```

`014_agent_execution_profiles.sql` **不属于本 Task**，由 TASK-110 负责。

### 验收标准

- [ ] 老数据库自动升级。
- [ ] 历史 Run 不丢失。
- [ ] migration 可重复验证。
- [ ] `migrations.ts` 已注册，且 012 排在 013 之前。
- [ ] `foreign_key_check` 通过。
- [ ] `config_home` 部分唯一索引生效（NULL 可重复，非 NULL 不可重复）。
- [ ] `max_concurrent_runs` 的 `CHECK` 生效。
- [ ] `profile_aliases` 的 `(agent_id, kind, alias)` 主键生效。

---

## TASK-096 — AccountProfileRepository

**优先级：P0**

**依赖：TASK-007, TASK-095**

### 实施内容

```text
list
get
create
update
disable
setStatus
```

### 验收标准

- [ ] 单元测试。
- [ ] 不在 Manager 写 SQL。

---

## TASK-097 — AccountProfileManager

**优先级：P0**

**依赖：TASK-022, TASK-078, TASK-096**

### 实施内容

```text
CRUD
default resolve
status
runtime projection
login descriptor
```

### 验收标准

- [ ] Manager 不依赖 Renderer。
- [ ] Typed EventBus。
- [ ] Adapter 可插拔。
- [ ] create 拒绝 `authType: "api-key"`（第一阶段不做，设计文档 §35）——在 IPC/Manager 层拒绝，不能只靠 UI 隐藏入口。
- [ ] create 拒绝未注册的 `agentId`。
- [ ] managed Profile 的 `configHome` 由 Manager 生成，update 不接受该字段（设计文档 §48.1）。
- [ ] slug 重复时报错并要求改名，不自动加后缀；slug 入库前 `toLowerCase()`（Windows 路径大小写不敏感）。
- [ ] 并发创建同 slug 时只有一个成功——先插库再建目录，靠 `config_home` 唯一索引挡住，不留孤儿目录。
- [ ] `maxConcurrentRuns` 只接受 `undefined` 或 `>= 1` 的整数。
- [ ] `remove` 是 soft disable，不执行 DELETE（设计文档 §47.1）。
- [ ] 禁用默认 Profile 时同时清除 `defaultAccountProfileId`（设计文档 §47.2）。
- [ ] 有非终态 Run 时拒绝禁用。
- [ ] `enable` 时 Home 不存在 → 重建并置 `login-required`。
- [ ] Resolver 遇到 disabled 的默认 Profile 报错，不回退 legacy。

---

## TASK-098 — Codex Account Profile Adapter

**优先级：P0**

**依赖：TASK-023, TASK-097**

### 实施内容

```text
CODEX_HOME
login command
detect
runtime env
```

### 验收标准

- [ ] 两个 Profile 可独立启动。
- [ ] 不复制认证文件。
- [ ] Windows / WSL 测试覆盖。

---

## TASK-099 — Claude Account Profile Adapter

**优先级：P0**

**依赖：TASK-023, TASK-097**

### 实施内容

```text
CLAUDE_CONFIG_DIR
login command
detect
runtime env
```

### 验收标准

- [ ] 两个 Profile 可独立启动。
- [ ] Windows / WSL 测试覆盖。

---

## TASK-100 — AgentManager Profile Integration

**优先级：P0**

**依赖：TASK-098, TASK-099**

### 实施内容

```text
StartAgentRunRequest.accountProfileId
Runtime resolve
Run snapshot
```

> **范围边界**：只接入 `accountProfileId`。`executionProfileId` 的接收与校验归
> TASK-110——ExecutionProfile 的 contracts / 表 / Manager 要到 TASK-109/110 才存在，
> Phase B 无法校验它。字段与列由 TASK-094/095 先行准备，本 Task 不读。

### 验收标准

- [ ] legacy start 仍工作。
- [ ] 显式 Profile 正确。
- [ ] Profile env 进入 ProcessManager。
- [ ] 跨对象约束（每条都要有失败用例，否则错的 Profile id 会一路走到错的 Adapter）：
  - [ ] `accountProfile.agentId === request.agentType`，否则报错。
  - [ ] 传入 `executionProfileId` 时返回「尚未支持」的结构化错误，不静默忽略（TASK-110 之前的临时行为）。
  - [ ] 显式指定的 Profile 不存在 / `enabled === false` / runtime 不兼容时一律报错，不静默降级到默认或 legacy（设计文档 §37.1）。
  - [ ] 以上每种失败都返回可区分的错误码，不是笼统的 VALIDATION_FAILED。

---

## TASK-101 — Default Account Profile

**优先级：P1**

**依赖：TASK-080, TASK-097**

### 实施内容

```text
per-agent default account
```

### 验收标准

- [ ] Codex / Claude 分别有默认 Profile。
- [ ] 默认变更不影响历史 Run。

---

## TASK-102 — Account Profile IPC

**优先级：P0**

**依赖：TASK-097, TASK-098, TASK-099**

登录 IPC 是通用账号登录，TASK-104 要求 Codex 与 Claude 都能走完，
因此两个 Adapter 的 `buildLoginCommand()` 都必须就位。

### 实施内容

```text
teskra:account:list
teskra:account:get
teskra:account:create
teskra:account:update
teskra:account:remove
teskra:account:detect
teskra:account:disable
teskra:account:enable
teskra:account:set-default

teskra:account:login:start / write / resize / cancel

events: account.login.output / account.login.exited
```

alias 相关的 channel **不在本 Task**——它们和 `ProfileAliasRepository` 一起属于
TASK-111，否则会出现「Phase C 暴露了 IPC，Phase E 才有仓储」的空实现。

### 验收标准

- [ ] 所有请求 Zod 校验。
- [ ] IPC 返回 `IpcResult<T>`。
- [ ] `login:start` 立即返回 `AccountLoginSession`，不等 OAuth 完成。
- [ ] Renderer 只提交 `profileId` / `sessionId`，argv 与 env 全部在 Main 侧生成。
- [ ] 同一 profileId 重复 `login:start` 返回既有 sessionId，不起第二个进程。
- [ ] `login:cancel` 停止进程，且 Profile 状态保持登录前的值。
- [ ] 会话超时后自动清理（Main 侧自管，不依赖 Renderer 发 cancel）。
- [ ] 应用退出时登录会话随 `disposeAll()` 一起停止，不留孤儿进程。

---

## TASK-103 — Account Management UI

**优先级：P1**

**依赖：TASK-093, TASK-102**

### 实施内容

页面：

```text
Settings → Agents → Accounts
```

### 验收标准

- [ ] List。
- [ ] Status。
- [ ] Add。
- [ ] Login。
- [ ] Default。
- [ ] Disable。

---

## TASK-104 — Add Account Wizard

**优先级：P1**

**依赖：TASK-103**

### 实施内容

```text
Agent
Name
Runtime
Config Home（只读展示，由 Teskra 生成）
Login
Verify
```

### 验收标准

- [ ] Codex。
- [ ] Claude。
- [ ] WSL（必须选定具体 distro）。
- [ ] Windows。
- [ ] Config Home 为只读：managed Profile 不允许用户填写或编辑（设计文档 §48.1）。
- [ ] 只提交 slug，路径由 Main 侧生成。

---

## TASK-105 — Agent Failure Classification

**优先级：P1**

**依赖：TASK-100**

### 实施内容

```text
AgentFailureClassifier
Codex classifier
Claude classifier
```

### 验收标准

- [ ] rate-limit / auth / network / unknown 四类分类正确。
- [ ] Fake Agent tests。
- [ ] 分类结果写入 `agent_runs.failure_classification_json`，Run 状态仍为 `failed`（不新增状态，ADR-0010 / 设计文档 §17.2）。
- [ ] `evidence` 已脱敏且截断到 512 字符（设计文档 §17.3）。
- [ ] 重启后能从库里读回 `kind` 与 `resetAt`。

---

## TASK-106 — Account Status Projection

**优先级：P1**

**依赖：TASK-097, TASK-105**

### 实施内容

当 Run 失败：

```text
rate limit → Profile limited
auth → login-required / expired
successful Run → ready
```

### 验收标准

- [ ] 状态事件。
- [ ] persisted。
- [ ] restart 后保留。
- [ ] `limitedUntil <= now` 的恢复有明确触发者（设计文档 §18.0）：读取状态时惰性降级为 `unknown` 并清空 `limitedUntil`；应用启动与 Settings → Accounts 打开时各批量清扫一次。
- [ ] 降级目标是 `unknown` 而非 `ready`。
- [ ] 不引入常驻定时器。

---

## TASK-107 — Cross-profile Continuation

**优先级：P1**

**依赖：TASK-100, TASK-106**

### 实施内容

```text
ContinueAgentRunRequest
ContinuationBuilder
```

### 验收标准

- [ ] 新 Run。
- [ ] 同 Task。
- [ ] 同 Worktree。
- [ ] 新 Profile。
- [ ] Handoff/Context 继承。
- [ ] 原子性（设计文档 §19.3）：source process 已确认退出、source Run 已落终态，之后才创建 target Run。
- [ ] 新增不变式：同一 worktree 上不允许存在两个非终态 Run（现有 `unisolatedWriteConflict()` 对带 worktree 的 Run 直接放行，拦不住这种情况）。
- [ ] source process 超时未退出时，Continuation 整体失败并报错。

---

## TASK-108 — Rate Limit Switch UI

**优先级：P1**

**依赖：TASK-103, TASK-107**

### 实施内容

```text
Continue with another account
```

### 验收标准

- [ ] 只列 runtime 兼容且当前可用（ready / unknown）的 Profile。
- [ ] `limitedUntil` 已过期的 Profile 必须重新出现在列表里（经 TASK-106 的惰性降级），不能因为状态还写着 limited 就被永久排除。
- [ ] 显示同 Agent Profile。
- [ ] 可选跨 Agent continuation。

---

## TASK-109 — Execution Profile Contracts

**优先级：P1**

**依赖：TASK-094**

### 实施内容

```text
AgentExecutionProfile
```

字段（与设计文档 §6.1 / §8.2 完全一致，三处必须同形）：

```text
id
name
agentId
accountProfileId
model
reasoningEffort
approvalMode
createdAt
updatedAt
```

### 验收标准

- [ ] 字段与设计文档 §6.1 / §8.2 同形。
- [ ] 不包含 permission / tools / skills / env 的 Profile ID——这四类实体在仓库里不存在（设计文档 §6.1），要加回来见设计文档 §6.2。

---

## TASK-110 — ExecutionProfile Repository / Manager

**优先级：P1**

**依赖：TASK-095, TASK-100, TASK-109**

### 实施内容

包含 migration `014_agent_execution_profiles.sql`（TASK-095 不含），
以及 AgentManager 对 `executionProfileId` 的接入（TASK-100 不含）。

### 验收标准

- [ ] migration 014 已注册并可重复验证。
- [ ] CRUD。
- [ ] Default。
- [ ] Resolve（只解析设计文档 §6.1 收窄后的字段；不引用 tool / skill / env / permission Profile ID——它们没有对应实体）。
- [ ] Snapshot。
- [ ] `executionProfile.agentId === request.agentType`，否则报错。
- [ ] `executionProfile.accountProfileId` 指向的 Profile 其 `agentId` 相同。
- [ ] 同时传 `accountProfileId` 与 `executionProfileId` 时，account 维度以显式的 `accountProfileId` 为准（设计文档 §14），其余字段仍整体取自 ExecutionProfile。

---

## TASK-111 — Workflow Profile Support

**优先级：P1**

**依赖：TASK-100, TASK-110, TASK-118**

TASK-118 完成之前本 Task 不可开工——设计文档 §55 的 repo-local workflow
安全语义完全依赖它。

支持 alias 引用（ADR-0011 / 设计文档 §53.1；仓库里出现的都是 alias，不是 id）：

```yaml
agent: codex
accountProfile: work
```

以及：

```yaml
profile: high-work
```

### 实施内容

alias 的全部内容都在本 Task（含 IPC；TASK-102 只做账号本身的 channel）：

```text
ProfileAliasRepository（list / bind / unbind / resolve）
teskra:account:alias:list / bind / unbind
Settings → Agents → Aliases 绑定 UI
DefinitionLoader 只取 alias 字符串，解析在 Runtime Service
```

### 验收标准

- [ ] 未绑定的 alias → 报错并提示绑定，不回退到默认账号。
- [ ] 绑定指向的 Profile 已删除 / disabled → 同样报错。
- [ ] `accountProfile` 与 `profile` 两种 alias 各自解析正确（`kind` 区分）。
- [ ] repo 里写 Profile id 被拒绝（设计文档 §55）。
- [ ] 同名 alias 在不同 agentId 下互不干扰。
- [ ] 同名 alias 在不同 `kind` 下互不干扰（`work` 可同时是两种）。
- [ ] bind 校验 profileId 存在于 kind 对应的表，且 `profile.agentId` 相符。

---

## TASK-112 — Profile-aware Recovery

**优先级：P0**

**依赖：TASK-042, TASK-100**

> 必须与 TASK-100 同批做：100 一旦让 Run 带上 Profile 身份，Recovery 就必须
> 同步改为读历史 `profileSnapshot`，否则每一次 crash recovery 都会串号
> （设计文档 §60 Phase B）。

### 验收标准

- [ ] Recovery 使用历史 Runtime Identity。
- [ ] 不使用当前默认账号。

---

## TASK-113 — External / Legacy Profile Migration

**优先级：P1**

**依赖：TASK-098, TASK-099, TASK-101**

不创建任何 virtual default Profile（设计文档 §50）。

### 验收标准

- [ ] 升级后行为与升级前逐字节一致（不投射任何 config dir 环境变量）。
- [ ] Settings → Accounts 首次展示引导文案。
- [ ] External Profile 的导入路径（用户显式动作，按具体 runtime 逐个创建）。
- [ ] 无需重新登录。

---

## TASK-114 — Account Profile Security Tests

**优先级：P0**

**依赖：TASK-098, TASK-099, TASK-100, TASK-118**

其中「untrusted workspace 自动执行受限」一条在 TASK-118 完成前无法验收；
其余安全测试不受影响，可以先做。

### 必须覆盖

```text
path ownership
secret isolation
external path delete guard
renderer isolation
WSL env isolation
```

### 验收标准

- [ ] 上述五类场景各有自动化测试。
- [ ] untrusted workspace 自动执行受限（依赖 TASK-118）。

---

## TASK-115 — Account Profile E2E

**优先级：P1**

**依赖：TASK-107, TASK-108**

### 验收标准

- [ ] Fake Agent 场景可跑通：A Ready → A Limited → B Ready → A → B Continue。
- [ ] 每个测试用例使用独立的 `TESKRA_HOME` 临时目录，结束后清理。

---

## TASK-116 — Account Event Repository

**优先级：P1**

**依赖：TASK-095**

设计文档 §41 的审计事件写进 `account_events`，需要对应的仓储与查询。

### 实施内容

```text
AccountEventRepository（append / listByProfile / listByType）
AccountProfileManager 与 AgentManager 的事件写入点
```

### 验收标准

- [ ] 不在 Manager 里写 SQL。
- [ ] 账号生命周期事件（created / login\_\* / status_changed）不依赖 Run 存在。
- [ ] `agent.account_switched` 能关联 source / target Run。
- [ ] 单元测试。

---

## TASK-117 — Per-profile 并发限制

**优先级：P1**

**依赖：TASK-084, TASK-100**

设计文档 §46.3 的三步落地。没有它，设计文档 §65 场景 H 无法验收——
字段存在但没有任何代码读它。

### 实施内容

```text
hasCapacity() 的 candidate 增加 accountProfileId
按 profile.maxConcurrentRuns 计数并限流
超限进入既有 queued 路径
```

### 验收标准

- [ ] managed profile 默认 `maxConcurrentRuns = 1` 时，第二个 Run 排队。
- [ ] legacy fallback（没有 `accountProfileId`、也没有 Profile 记录）不受 per-profile 限制，仅受 `maxRunsPerAgent` 约束。
- [ ] 不新造等待机制，复用既有排队调度。
- [ ] `0` 与负数在 Zod 与 SQL `CHECK` 两层都被拒绝（写进去会让该 Profile 的 Run 永久排队）。

---

## TASK-118 — Workspace Trust

**优先级：P0**

**依赖：TASK-009, TASK-110**

本 Task 由设计文档 §43 拉起，但它本身是独立的安全能力，关闭的是
code-review 的 P0-3「仓库内容可导致本机任意代码执行」
（P0-3(1) workspace 层 `agents` 组剥离已完成，见 `docs/code-review-2026-09-12.md`；
本 Task 覆盖剩余的 (2) Workspace Trust 闸门与 (3) shell 步骤执行前确认）。

它不阻塞 Phase A～D，但必须排在 TASK-111 之前——111 让 repo 里的 workflow
能指定账号，118 是「repo 内容能不能被信任」的闸门，反过来排等于先开门再装锁。

依赖 TASK-110 的原因是 migration 版本连续性，不是功能耦合：本 Task 注册 015，
而 014 属于 TASK-110。`migrate.ts` 以 `MAX(version)` 判断当前版本并跳过所有
更小的版本，先应用 015 的开发库会永久跳过 012～014。

### 实施内容

闸门要覆盖三条路径，只挡 shell workflow 是不够的：

```text
workspace 层配置的 agents 组一律剥离并告警（与信任级别无关；已完成，需回归覆盖）
Restricted 下不加载 repo-local workflows / prompts / config
repo 定义的 shell 步骤执行前展示完整命令行确认
```

信任级别最少支持：

```text
Trusted
Restricted
```

Restricted 下：

```text
repo-local shell workflow 禁止
repo-local executable override 禁止
自动 delegation 禁止
敏感 env 投射受限
```

### 验收标准

- [ ] workspace 层配置的 `agents` 组一律剥离并告警（与信任级别无关）。
- [ ] Restricted 下不加载 repo-local workflows / prompts / config（含 `<repo>/.teskra/config.json` 的 `agents.executableOverrides` 与 `<repo>/.teskra/prompts/` 两条路径）。
- [ ] repo 定义的 shell 步骤执行前展示完整命令行确认。
- [ ] Trusted / Restricted 两级可用，信任级别可持久化。
- [ ] untrusted workspace 不能通过 repo-local workflow 自动执行 shell、自动配置 Agent runtime、自动启动 Delegation。
- [ ] migration 015 已注册，且在 014（TASK-110）之后应用。

---

# 24. 建议的实际执行顺序

如果准备真正开始开发，不需要严格按 Task 编号全部线性执行。

> **2026-09-09 Review 后重排。** 原顺序存在两个问题：
>
> 1. **5 个 Task 从未出现在任何 Phase 中**：TASK-004、**TASK-007**、TASK-015、
>    TASK-019、TASK-024。其中 TASK-007（Repository）是 TASK-008 / TASK-032 的
>    显式依赖，Phase A 直接断链。
> 2. **依赖倒置**：原 Phase A 把 TASK-020/021（Typed IPC）排在 TASK-017/018
>    （Terminal UI）之后，但 Renderer 必须先有 IPC 才能创建 PTY；
>    TASK-011（WSL 检测）排在 TASK-012（CommandRunner）之前，但检测本身要走 CommandRunner。
>
> 下面的顺序已按依赖图重排，并纳入新增的 TASK-077~090。

---

## Phase A1 — 工程骨架与持久化

```text
001  Electron + React + TS 骨架
002  Electron 安全基线
003  contracts 包（含 AppError / IpcResult / Handoff Schema）
078  paths 模块              ← 新增，所有持久化的前提
091  Windows CI 基线         ← 新增，不能等到 Phase G
004  日志系统
005  SQLite
006  Migration 机制
090  完整 Schema             ← 新增
007  Repository 抽象         ← 原顺序遗漏
```

完成后：

> 有一个安全的 Electron 壳 + 可用的持久化层。

---

## Phase A2 — Workspace 与进程运行时

```text
008  Workspace Domain
009  WorkspaceManager
010  WorkspaceRuntime 抽象
080  Config Layers           ← 新增，晚了配置读取就散了
012  CommandRunner           ← 必须早于 011
011  WSL 检测与 Distro
013  node-pty
014  ProcessManager
015  Kill Escalation         ← 原顺序遗漏
016  EventBus
```

完成后：

> 唯一 PTY Authority 就位，Windows / WSL 命令可靠执行。

---

## Phase A3 — Runtime Facade、IPC 与 Terminal

```text
017  TerminalManager                 ← 必须早于 081：Facade 的 terminal port 要有实现
081  Facade 骨架 + Composition Root
020  Typed IPC Router
021  Renderer Event Bridge
093  Settings UI 框架                ← 从 Phase G 提前：多个早期 Task 需要它
018  xterm.js                        ← Renderer 侧，需要 IPC 就绪
019  Terminal Keep-Alive             ← 原顺序遗漏
092  App Shell + Workspace UI        ← 验收要联合 019，必须在其后
082  TerminalRenderer 抽象           ← 新增（P2，可延后）
```

完成后：

> 已经有一个支持 Windows / WSL Terminal 的 Electron Workbench。

---

## Phase B — 双 Agent GUI

```text
022  Agent Registry
083  Fake Agent              ← 新增，022/025/076 都依赖它
023  Agent 检测
024  AgentHealth             ← 原顺序遗漏
025  CodingAgentAdapter 接口
026  CodexAdapter
027  ClaudeAdapter
028  AgentManager
084  并发限制                ← 新增
029  Agent Runs 面板
030  Agent Run Terminal
031  输出批处理与性能
```

完成后：

> 可以在一个 GUI 内同时使用 Codex 和 Claude。这是第一个真正值得日常使用的版本。

> **隔离说明（ADR-0002 修订）**：本阶段 Worktree（Phase E）尚未实现，
> Agent 直接在主工作区运行。这是 **attended 模式**——用户手动启动、全程盯屏，
> 风险等同于今天直接开两个终端跑 CLI。
>
> 但 UI **必须**有常驻警告横幅，且 `AgentRun.executionMode` 必须落库为 `attended`。
> Phase E 之前不得实现任何自动调度（Workflow / Dispatch / Iterate），
> 因为 orchestrated 模式无隔离必然互相覆盖文件。

---

## Phase C — Task + Git

```text
032  Task Domain & CRUD
033  Task → Agent Run
034  Task 页面
035  GitManager
036  DiffService
037  Changes UI
086  Git 状态刷新策略        ← 新增
038  持久化 Agent Events
```

完成后：

> 从"两个 Terminal"升级成 Task-based Coding Workbench。

---

## Phase D — Reliability

```text
039  Run Directory + JSONL
040  ReconciliationService
085  Process Watchdog        ← 新增
041  DoctorService
042  Resume Run
074  Runtime 单元测试套件
```

完成后：

> 软件重启、异常、CLI 崩溃后的状态可信。

**这一阶段优先级高于 Visual Workflow。**

---

## Phase E — Worktree

```text
043  WorktreeManager
087  Agent 自动 Commit       ← 新增
044  Worktree Lifecycle State
045  Merge Preflight
046  Merge Conflict Preservation
047  Cancel/Discard/Archive/Cleanup 分离
075  Worktree Safety Reference Tests
```

完成后：

> Codex 与 Claude 可以真正并行修改同一个 Repo。

---

## Phase F — Multi-Agent

```text
048  AcceptanceCriteria Domain
049  Criteria UI
050  ArtifactStore
079  Prompt Template 外置    ← 新增，051 依赖它
051  WorkerHandoff Protocol
052  Reviewer Role
053  ReviewFinding
054  Criteria Review Result
055  WorkflowDefinition
056  WorkflowRun
057  WorkflowEngine DAG
058  Shell Workflow Step
059  Dispatch Primitive
060  Review Panel
061  Review Aggregator
062  Iterate Primitive
063  默认 Full Workflow
```

完成后：

> 实现 Codex Implement → Claude Review → Codex Fix → Test。

---

## Phase G — Productization

```text
064  CommandClassifier
077  Agent 权限策略投影      ← 新增
065  PermissionManager
066  Permission UI
088  Credential Store        ← 新增
067  Workspace Memory
068  ContextBuilder
069  RetentionService
070  Recovery Center
089  Agent Routing Profile   ← 新增
071  Home Dashboard
072  electron-builder
073  Windows 签名与发布
076  Electron E2E Tests
```

---

## 依赖检查

Phase 顺序满足以下约束（实现前可用脚本自动校验）：

```text
078 < 005            paths 早于 DB
006 < 090 < 007      migration 机制 → schema → repository
007 < 008            repository 早于 domain
012 < 011            CommandRunner 早于 WSL 检测
010 < 012            runtime 抽象早于 CommandRunner
013 < 014            node-pty 早于 ProcessManager
016 < 081 < 020      EventBus → Facade → IPC
020 < 017            IPC 早于 TerminalManager
022 < 083            registry 早于 Fake Agent
080 < 079            config 早于 prompt template
079 < 051            prompt template 早于 handoff
043 < 087            worktree 早于 auto-commit
064 < 077 < 065      classifier → 策略投影 → manager
081 < 020            Facade 骨架早于 IPC
020 < 092            IPC 早于 App Shell
006 < 090 < 007      schema 早于 repository
003 < 083            Handoff Schema 早于 Fake Agent
017 < 081            TerminalManager 早于 Facade（terminal port 要有实现）
020 < 018            IPC 早于 xterm.js（Renderer 侧需要 IPC）
080 < 093            Config Layers 早于 Settings UI 框架
093 < 092            Settings 框架早于 App Shell（导航需要 Settings 入口）
019 < 092            Keep-Alive 早于 App Shell（092 验收要联合 019）
```

> 093（Settings UI 框架）已提前到 Phase A3——
> TASK-004 / 011 / 023 在 Phase A~B 就需要它，各分区由后续 Task 增量挂载。

---

# 25. MVP 定义

> **口径统一**：MVP 一律按 **Phase** 定义，不再用「TASK-xxx ~ TASK-yyy」的连续区间。
> 新增的 TASK-077~090 穿插在各 Phase 中，连续区间的写法已经失效。
> 原文的 MVP-0 声称覆盖 TASK-001~021，但 Phase A 里并没有 004/007/015/019，两处口径不一致。

## MVP-0

```text
Electron
+
React
+
Windows/WSL Terminal
```

对应完成：**Phase A1 + A2 + A3**（其中 TASK-082 为 P2，可延后）。

---

## MVP-1

```text
Codex
+
Claude
+
Agent Sessions
```

对应：**Phase B**。

这是第一个可以替代「分别开两个命令行窗口」的版本。

> **MVP-1 是 attended 模式**：Agent 直接修改主工作区，无 worktree 隔离，
> UI 有常驻警告。这一限制到 Phase E 才解除。见 ADR-0002「适用范围」。

---

## MVP-2

```text
Task
+
Git Diff
+
Persistence
+
Recovery
```

对应：**Phase C + Phase D**。

这是第一个适合长期日常使用的版本。

---

## V1

```text
Git Worktree
+
Acceptance Criteria
+
Artifacts
+
Review
+
Workflow
+
Iterate
```

对应：**Phase E + Phase F**。

做到这里：

> 产品才真正变成 Multi-Agent Coding Workbench，而不是 CLI GUI。

---

# 26. 第一条推荐 Multi-Agent 验收场景

V1 完成时，必须跑通下面完整场景：

```text
1. 打开一个 WSL Git Repo

2. 创建 Task：
   Add health check endpoint

3. 创建 Acceptance Criteria：
   - GET /health returns 200
   - Existing tests remain passing
   - No unnecessary DB access

4. Workbench 创建 isolated worktree

5. Codex Implement

6. 自动执行：
   dotnet test

7. Claude 独立 Review

8. Criteria Evaluation

9. 如果 FAIL：
   Codex Fix

10. 再次 test + review

11. PASS 后显示：
    files changed
    diff
    tests
    criteria
    review findings

12. 用户点击 Merge

13. Merge Preflight

14. Merge 成功

15. 清理 worktree

16. Task = completed
```

整个流程中：

- [ ] Codex 与 Claude 不共享可写工作目录。
- [ ] Reviewer 无法污染实现分支。
- [ ] Merge conflict 不销毁现场。
- [ ] App 中途重启后可以恢复到合理状态。
- [ ] Agent 失败不会造成无限循环。
- [ ] 未通过 Acceptance Criteria 不能自动标 Completed。

---

# 27. Codex 执行单个 Task 的推荐 Prompt

可以把下面模板交给 Codex：

```text
Implement TASK-XXX from docs/TASKS.md.

Requirements:

1. Read the task and all listed dependencies.
2. Read relevant architecture sections in
   docs/teskra-implementation-plan-v2.md.
3. Do not expand scope beyond the task unless required for correctness.
4. Follow the existing architecture boundaries.
5. Add or update tests for the implemented behavior.
6. Run the relevant tests/build before finishing.
7. Do not silently bypass failing tests.
8. Summarize:
   - files changed
   - implementation decisions
   - commands/tests run
   - remaining limitations
9. Do not start the next TASK.
```

---

# 28. Claude Review 单个 Task 的推荐 Prompt

```text
Review the implementation of TASK-XXX.

Focus on:

1. Whether every acceptance criterion in TASKS.md is satisfied.
2. Architecture boundary violations.
3. Electron security issues.
4. Process lifecycle / orphan process risks.
5. Windows / WSL edge cases.
6. Git / worktree destructive behavior.
7. Missing tests.
8. Error handling and recovery.
9. Race conditions and stale runtime state.

Do not modify files.

Return:

- PASS / CHANGES_REQUESTED
- findings grouped by severity
- file and line references where possible
- missing acceptance criteria
- recommended fixes
```

---

# 29. Commit 策略

建议：

```text
一个 TASK
=
一个或少量独立 commit
```

不要：

```text
TASK-012
TASK-013
TASK-014
TASK-015

全部堆在一个巨大 commit
```

后续 Agent Review、回滚、bisect 都会更困难。

---

# 30. Definition of Done

任何 Task 只有同时满足以下条件才能标记 Done：

- [ ] 实现完成。
- [ ] Acceptance Criteria 全部满足。
- [ ] TypeScript build 通过。
- [ ] 相关测试通过。
- [ ] 没有明显 lint error。
- [ ] 没有残留调试代码。
- [ ] 没有偷偷扩大 Scope。
- [ ] 文档需要更新时已经更新。
- [ ] Git diff 已 Review。
- [ ] Commit 已创建。

架构边界（每个 Task 都适用，建议用 ESLint 规则自动化）：

- [ ] Renderer 未直接引用 `fs` / `child_process` / `node-pty` / `sqlite` / `git`。
- [ ] Runtime 层未 import `electron`（`BrowserWindow` 只允许出现在 RendererEventBridge）。
- [ ] 未绕过 ProcessManager 直接 `pty.spawn()`。
- [ ] 未绕过 CommandRunner 直接 `spawn()` / `exec()`。
- [ ] 未硬编码 Agent 名称（一律走 AgentRegistry）。
- [ ] 未手工拼接数据目录路径（一律走 TASK-078 的 paths 模块）。
- [ ] 未散落 `process.platform` 判断（一律走 WorkspaceRuntime）。

License（见 §0 全局约束）：

- [ ] 未复制 Elastic-2.0（AgentDeck）或 AGPL-3.0（Claude Squad）项目的源码。
- [ ] 借鉴自 MIT 项目的实现模式已用自己的命名与 Domain Model 重写。

平台：

- [ ] 标注 `[Windows 验证]` 的验收项已在 Windows + WSL2 实际验证；
      若当前在 Linux 开发机上无法验证，必须在 Task 完成说明中显式列出未验证项，
      **不得直接勾选**。

---

# 31. 当前最推荐从哪里开始

如果今天正式开项目，第一批直接交给 Codex：

```text
TASK-001  Electron + React + TS 骨架
TASK-091  Windows CI 基线      ← 越早越好，后面每个 native module 都靠它把关
TASK-002  安全基线
TASK-003  contracts 包（含 PublicAppError / IpcResult / Handoff Schema）
TASK-078  paths 模块
TASK-004  日志系统
```

第二批（持久化，此时 plan §139.1 的 schema 已就绪）：

```text
TASK-005  SQLite
TASK-006  Migration 机制
TASK-090  完整 Schema
TASK-007  Repository 抽象
```

第三批（Workspace + 进程）：

```text
TASK-008  Workspace Domain
TASK-009  WorkspaceManager
TASK-010  WorkspaceRuntime
TASK-080  Config Layers
TASK-012  CommandRunner
TASK-011  WSL 检测
```

第四批（PTY 与事件）：

```text
TASK-013  node-pty
TASK-014  ProcessManager
TASK-015  Kill Escalation
TASK-016  EventBus
```

第五批（Terminal + Facade + IPC）：

```text
TASK-017  TerminalManager        ← 必须早于 081
TASK-081  Facade 骨架 + Composition Root
TASK-020  Typed IPC Router
TASK-021  Renderer Event Bridge
TASK-093  Settings UI 框架
TASK-018  xterm.js
TASK-019  Terminal Keep-Alive
TASK-092  App Shell + Workspace UI
```

做到这里再开始接 Codex / Claude（Phase B）。

不要一开始就让 Agent 去实现：

```text
Workflow
Review Panel
Memory
Permission
```

因为它们都依赖底层 Runtime 正确。
Permission 尤其如此——它的设计已经在 ADR-0002 中被推翻过一次，
在真正接完 Codex / Claude、看清各 CLI 的实际权限机制之前不要动。

---

# 32. 最终目标

项目不应该最终变成：

```text
一个漂亮的多终端 GUI
```

而应该形成：

```text
Task
  ↓
Acceptance Criteria
  ↓
Orchestrator
  ↓
Isolated Agent Runs
  ↓
Artifacts
  ↓
Independent Review
  ↓
Tests
  ↓
Safe Merge
  ↓
Recoverable History
```

真正的核心价值是：

> **让 Codex、Claude 等 Coding Agent 可以可靠地并行工作、相互复核，并且整个执行过程可观察、可恢复、可审计、可安全合并。**
