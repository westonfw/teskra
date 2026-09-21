# Teskra 多订阅账号与 Agent Profile 管理实施方案

> 文档状态：Accepted — 已同步至权威文档（见 §59.0）  
> 目标版本：Teskra v0.x  
> 适用仓库：`westonfw/teskra`  
> 任务编号：从现有 `TASK-093` 之后继续，使用 `TASK-094+`

---

## 1. 背景

Teskra 当前已经具备以下核心能力：

- Windows-first Electron 桌面应用
- React Renderer + Electron Main + Typed IPC
- `AgentManager`
- `ProcessManager`
- Codex / Claude Code Adapter
- PTY Terminal
- Task / AgentRun
- Git Worktree 隔离
- Workflow Engine
- Review / Criteria Gate
- Crash Recovery
- Permission / Audit
- Credential Store
- Handoff 文件协议

当前 Agent 模型主要回答：

```text
“这次 Run 使用 Codex 还是 Claude Code？”
```

下一阶段需要进一步回答：

```text
“这次 Codex Run 使用哪个 Codex 账号/订阅？”
“同一个 Codex 能否同时挂多个独立账号？”
“一个账号额度不足后，是否可以切换到另一个账号继续 Task？”
“多个 Agent 并行时，如何明确每个 Agent 使用的订阅身份？”
```

因此需要将目前的：

```text
Agent = Codex / Claude
```

扩展为：

```text
AgentDefinition
    +
AccountProfile
    +
ExecutionProfile
    +
AgentRun
```

目标不是实现“无限账号轮换绕过服务限制”，而是建立一个正规的：

> **Multi-account / Multi-subscription Agent Profile Manager**

用于管理用户合法拥有的多个工作、个人、API 或其他授权身份。

---

### 1.1 术语：CC Switch

本文多处以 **CC Switch** 作为对照。它是一个第三方的 Claude Code / Codex
供应商与账号切换工具（`farion1231/cc-switch`，Tauri 桌面应用），核心做法是：
把多个 Provider / 账号配置保存在本地，切换时整体改写 CLI 的配置文件
（`~/.claude/settings.json`、`~/.codex/config.toml`），并可选地起一个本地
网关做协议转换与路由。

引用它只是为了借鉴「多 Profile 抽象 + 配置投射」的产品形态；
其配置整体覆盖、OAuth 代理与本地网关的做法本文明确不采用，
理由见 §32、§36、§62。

---

## 2. 产品目标

### 2.1 核心目标

Teskra 应支持：

```text
Codex
├─ Personal
├─ Work
└─ API

Claude Code
├─ Personal
├─ Work
└─ API
```

用户创建 Task 或启动 Agent Run 时，可以明确选择：

```text
Agent: Codex
Account: Personal
```

或者：

```text
Agent: Codex
Account: Work
```

未来 Workflow / Delegation 也可以明确指定：

```yaml
agent: codex
accountProfile: codex-work
```

---

### 2.2 目标体验

例如用户拥有：

```text
Codex Personal
Codex Work
Claude Personal
Claude Work
```

在 Teskra 中看到：

```text
Agents

Codex
  ● Personal        Ready
  ● Work            Ready

Claude Code
  ● Personal        Limited · reset 03:12
  ● Work            Ready
```

当前 Task：

```text
TASK-218
└─ Codex Personal
```

当 `Codex Personal` 达到使用限制：

```text
Codex Personal has reached its usage limit.

Continue with:

[ Codex Work ]
[ Claude Work ]
[ API Profile ]
[ Wait for reset ]
```

用户选择：

```text
Codex Work
```

Teskra 创建新的 `AgentRun`：

```text
Run A
Codex Personal
    ↓
rate limited
    ↓
Handoff / Context Snapshot
    ↓
Run B
Codex Work
```

而不是尝试在同一个已经运行的 CLI Session 内偷偷替换账号。

---

## 3. 非目标与安全边界

### 3.1 第一阶段不做

第一阶段明确不实现：

- 自动轮询所有个人订阅（A 用完 → B → C → D）
- 后台偷偷切换 OAuth Token
- 复用 / 复制 `auth.json`
- 解析、导出或自行刷新 OAuth refresh token
- Codex OAuth Reverse Proxy
- Claude OAuth Reverse Proxy
- 模拟官方私有 OAuth API
- 绕过官方 CLI 的认证生命周期

---

### 3.2 原则

Teskra 管理：

```text
“使用哪个独立账号环境”
```

官方 CLI 管理：

```text
“这个账号如何登录”
“OAuth Token 如何刷新”
“凭据如何存储”
```

即：

```text
Teskra
   ↓
Profile Environment
   ↓
Official CLI
   ↓
Official Authentication
```

而不是：

```text
Teskra
   ↓
拿 OAuth Token
   ↓
直接调用私有 Backend
```

---

### 3.3 自动切换边界

允许：

```text
Manual Profile Switch                 ✅
One-click Continue with Another       ✅
用户显式配置的 API Provider Fallback  ✅
Workflow 显式指定不同 Profile         ✅
多个合法 Profile 并行运行             ✅
```

默认不做：

```text
Silent Personal Subscription Rotation ⚠️
Round-robin Subscription Pool         ⚠️
为了规避单账号限额自动无限切换         ⚠️
```

后续即便提供自动策略，也应要求用户显式启用，并始终保留：

- 可见的 Profile
- 可见的切换事件
- Audit Log
- Usage / Limit 状态
- 明确的暂停和取消能力

---

## 4. 核心领域模型

### 4.1 AgentDefinition

`AgentDefinition` 描述“Agent 是什么”。

当前 `createDefaultAgentRegistry()`（`apps/desktop/src/main/agents/agent-registry.ts`）
实际注册的是：

```text
codex
claude
kimi
fake   （仅 development）
```

**本方案沿用现有 `AgentDefinition`，不改其结构。** 现有形状见
`apps/desktop/src/main/agents/definitions/codex.ts`，字段为
`executable` / `prompt` / `detection` / `defaults` /
`permissionEnforcement` / `auditCommandPatterns` / `routing`，
capabilities 为 `interactive` / `headless` / `resume` /
`readOnlyMode` / `modelSelection`。

注意它**没有** `adapterId` 字段——Adapter 由 Composition Root 按
`definition.id` 装配，不在定义里声明。

### 4.2 不要新增 `capabilities.subscriptionProfiles`

一个 Agent 是否支持多账号，等价于「是否注册了对应的
`AgentAccountProfileAdapter`」（§10.4）。用 Adapter 注册表判断即可。

新增一个布尔位的代价是：`agentDefinitionSchema` 是严格校验的
（registry 在 `register()` 里 `safeParse`），改它要同步改 contracts +
全部 4 个 definition 文件，而且这个布尔会和实际有没有 Adapter 实现漂移。

### 4.3 每个 Agent 的账号隔离机制

| Agent | 隔离机制 | 第一阶段 |
| --- | --- | --- |
| `codex` | `CODEX_HOME` | 支持（§10） |
| `claude` | `CLAUDE_CONFIG_DIR` | 支持（§11） |
| `kimi` | 待确认是否有等价的 config dir 环境变量 | **不支持多账号**，只走 legacy fallback（§50.1 / §52） |
| `fake` | 无（仅 env / worktree 隔离） | 供测试用，见 §56.3 |

`kimi` 在落地 TASK-098 之前必须先确认其 CLI 是否提供可隔离的配置目录；
确认不了就保持「单账号 + legacy fallback」（即不建 Profile、不投射任何
config dir 环境变量），不要猜一个环境变量。

### 4.4 Profile 不是新的 AgentDefinition

```text
Codex Personal
Codex Work
```

不是两个 `AgentDefinition`。它们都属于：

```text
AgentDefinition = codex
```

### 4.5 命名约定（落地前必须统一）

仓库里「Agent 种类」这个概念有两个既有名字，**不要在实现时混用**：

| 场景 | 既有名字 | 出处 |
| --- | --- | --- |
| 探测 / 健康检查请求 | `agentId` | `agentDetectionRequestSchema` |
| 持久化的 Run | `agentType` / 列 `agent_type` | `agentRunSchema`、migration `002_runs.sql` |

规则：

- 本方案**新增**的账号 / 执行 Profile 类型与表，统一用 `agentId` /
  `agent_id`，语义等于 `AgentDefinition.id`。
- 凡是**改动既有** `agentRunSchema` / `startAgentRunRequestSchema` 的地方，
  一律写 `agentType`——这两个 schema 是 `z.strictObject`，写错字段名会直接
  校验失败。

---

## 5. AccountProfile

### 5.1 定义

新增：

```ts
export type AccountProfileStatus =
  | "ready"
  | "login-required"
  | "limited"
  | "expired"
  | "unknown";

export type AccountAuthType =
  | "subscription"
  | "api-key"
  | "external";

export interface AgentAccountProfile {
  id: string;

  agentId: string;

  name: string;
  description?: string;

  authType: AccountAuthType;

  /**
   * 复用既有 WorkspaceRuntimeRef（含 kind 与 distro），不要自造
   * "windows" | "wsl" 二元枚举——否则 distro 不一致
   * （Ubuntu-22.04 的 Profile 跑在 Debian workspace 上）检测不出来。
   */
  runtime: WorkspaceRuntimeRef;

  /**
   * CLI 独立 Home / Config Root。不直接保存 OAuth token。
   *
   * 存「目标 runtime 内的规范化绝对路径」，见 §5.3。
   * Windows Profile → 绝对 Windows 路径；WSL Profile → 绝对 POSIX 路径。
   * 禁止持久化 ~、环境变量引用和相对路径。
   */
  configHome?: string;

  /**
   * 该 Profile 允许的并发 Run 数；undefined = 不限（§46）。
   * managed profile 创建时写入 1。
   * 取值必须是正整数（>= 1）——0 或负数会让该 Profile 的 Run 永久排队。
   */
  maxConcurrentRuns?: number;

  status: AccountProfileStatus;

  limitedUntil?: string;

  lastUsedAt?: string;
  lastSuccessfulAt?: string;
  lastFailureAt?: string;

  createdAt: string;
  updatedAt: string;

  /**
   * 管理状态的唯一真相。status 只描述「认证/额度可用性」，
   * 不再有 "disabled" 取值——否则会出现 enabled=true + status=disabled
   * 这种无法解释的组合（§47 的 soft disable 走这个字段）。
   */
  enabled: boolean;
}
```

---

### 5.2 示例

```json
{
  "id": "acct_codex_personal",
  "agentId": "codex",
  "name": "Codex Personal",
  "authType": "subscription",
  "runtime": { "kind": "wsl", "distro": "Ubuntu-22.04" },
  "configHome": "/home/weston/.teskra/agent-profiles/codex/personal",
  "status": "ready",
  "enabled": true
}
```

另一个：

```json
{
  "id": "acct_codex_work",
  "agentId": "codex",
  "name": "Codex Work",
  "authType": "subscription",
  "runtime": { "kind": "wsl", "distro": "Ubuntu-22.04" },
  "configHome": "/home/weston/.teskra/agent-profiles/codex/work",
  "status": "ready",
  "enabled": true
}
```

---

### 5.3 configHome 的路径语义（唯一规则）

这条规则必须先定死，否则 §9 / §10.1 / §56.1 会各写一套，
而错误的表现是**静默使用错误的账号**，不报任何错。

规则：

```text
数据库里的 configHome =
  该 Profile 的目标 runtime 内的、规范化的、绝对的路径
```

- `runtime.kind === "windows"` → 绝对 Windows 路径，如
  `C:\Users\weston\.teskra\agent-profiles\codex\personal`
- `runtime.kind === "wsl"` → 绝对 POSIX 路径，如
  `/home/weston/.teskra/agent-profiles/codex/personal`

**禁止持久化**：

- `~` —— 环境变量的值里 `~` 不会被 shell 展开，
  当前 `resolveRuntimePath()` 也不展开它；存 `~/...` 的结果是 CLI 拿到
  一个字面量为 `~` 的目录名
- `$HOME` / `%USERPROFILE%` 等环境变量引用
- 任何相对路径

`~` 只允许出现在**给用户看的 UI 文案**里，落库前必须展开。
展开在创建 Profile 时完成一次（对 WSL Profile 通过目标 distro 查询其
home，见 §48.1），之后这个值就是不可再解释的字面路径。

#### 推论：configHome 不参与 resolveRuntimePath

`handoffPath` / `artifactDir` / `permissionConfigPath` 需要翻译，
是因为它们是 **host 侧**产物（run 目录在 host data root），
WSL 里的进程必须经 `/mnt/c/…` 才能够到。

`configHome` 不是这种情况——它按上面的规则**本来就已经是目标 runtime
内的路径**。所以投射时**直接使用，不要调用 `resolveRuntimePath`**。

（这一点修正了本文早期版本的写法：之前要求对 configHome 做
`C:\… → /mnt/c/…` 转换，那会把一个 WSL Profile 的
`/home/x/...` 原样穿过去、或把 Windows Profile 翻成 WSL 视角——
两种都会让 CLI 落回默认 `~/.codex`。）

`resolveSpawnEnv` 仍然会把 `CODEX_HOME` 追加进 `WSLENV` 且不带 `/p`，
而不带 `/p` 正是因为值已经是 runtime-native 的——两边对得上。

---

## 6. ExecutionProfile

`AccountProfile` 只表示身份。一次 Agent 执行还涉及 model、reasoning、
permissions、tools、skills、MCP、env 等维度。

### 6.1 第一版只收窄到现有可解析的字段

原稿的 `permissionProfileId` / `toolProfileId` / `skillProfileId` /
`envProfileId` **在仓库里没有对应实体**：

- Permission 目前是按 workspace / agent / role 的规则**合并生成**
  `TeskraPermissionProfile`（`agent.ts` 里它是内联对象，不是可引用的行），
  不存在可以拿来当外键的 Permission Profile ID
- contracts 里**完全没有** `toolProfile` / `skillProfile` / `envProfile` /
  MCP 相关类型
- TASK-109 / 110 也没有创建这四类实体的任务

引用四个不存在的 ID 会让 TASK-110 的 Resolve 无从实现。第一版收窄为：

```ts
export interface AgentExecutionProfile {
  id: string;

  name: string;

  agentId: string;

  accountProfileId?: string;

  /** 既有 AgentRun.model / StartAgentRunRequest.model */
  model?: string;

  /** 新增的自由字符串，由各 Adapter 自行解释 */
  reasoningEffort?: string;

  /** 既有 approvalModeSchema，投射走既有 permission-projection */
  approvalMode?: ApprovalMode;

  createdAt: string;
  updatedAt: string;
}
```

### 6.2 想加回那四个 ID 需要什么

不是不能加，是得按完整代价立项——每一类都要
contracts + 表 + Repository + Manager + IPC + 任务依赖：

| 字段 | 前置工作 |
| --- | --- |
| `permissionProfileId` | 先把 Permission 从「合并生成」改成「可命名、可持久化的实体」 |
| `toolProfileId` / MCP | 仓库当前没有任何 MCP 支持，需要独立立项 |
| `skillProfileId` | 同上 |
| `envProfileId` | 需先有 env profile 实体；注意与 §13.2 保留 key 的交互 |

在这些实体落地之前，§33 的四层分层图是**目标态**，不是第一版形态。

关系：

```text
AgentDefinition
      │
      ├── AccountProfile
      │
      └── ExecutionProfile
```

ExecutionProfile 示例：

```text
Codex Personal High

Agent:
  codex

Account:
  Codex Personal

Model:
  default / GPT-5.x

Reasoning:
  high

ApprovalMode:
  safe-auto
```

（示例只列第一阶段真实存在的字段，见 §6.1。
Permissions / Tools / Skills 是 §33.1 的目标态，不在本期。）

---

## 7. AgentRun 修改

当前 `AgentRun` 必须记录实际使用的 Profile。

增加：

`agentRunSchema` 是 `z.strictObject`，字段名必须与既有列对齐——
Agent 种类在 Run 上叫 `agentType`（列 `agent_type`），不是 `agentId`（§4.5）。

```ts
interface AgentRun {
  // existing fields...

  agentType: string;   // 既有字段，仅在此列出以标明对应关系

  accountProfileId?: string;

  executionProfileId?: string;

  /**
   * Run 启动时 Profile 的快照。
   * 防止后来用户修改 Profile 后无法审计历史 Run。
   */
  profileSnapshot?: AgentRunProfileSnapshot;
}
```

快照：

```ts
export interface AgentRunProfileSnapshot {
  accountProfileId?: string;
  accountProfileName?: string;

  executionProfileId?: string;
  executionProfileName?: string;

  runtime?: WorkspaceRuntimeRef;

  configHome?: string;

  model?: string;
  reasoningEffort?: string;
}
```

不要只保存 FK。

原因：

```text
Profile 今天叫 Personal
明天改成 Personal-2

历史 Run 仍然应该知道：
当时启动时使用的是哪个实际配置。
```

---

## 8. 数据库设计

既有 migration 的命名是 `NNN_name.sql`（当前最新为
`011_agent_run_pid_identity.sql`），并且必须在 `db/migrations.ts` 里注册
`{ version, name, sql }`。`migrate.ts` 对「DB 版本高于代码已知的最高版本」
是**硬错误**，所以版本号只能递增、不能回填。

因此新增：

```text
migrations/
├─ 012_agent_account_profiles.sql      账号 Profile 表 + account_events
├─ 013_agent_run_account_profile.sql   agent_runs 的四个新列（同一个文件）
└─ 014_agent_execution_profiles.sql    执行 Profile 表（Phase E 才需要）
```

顺序是强制的：012 必须早于 013，否则 013 里对
`agent_account_profiles` 的任何引用都会失败。

`agent_runs` 的四个新列合并进同一个 migration——现有风格是「一个语义变更
一个文件」，不是「一列一个文件」。

012 / 013 都是纯 `CREATE TABLE` / `ADD COLUMN`，不需要表重建，
因此不设 `foreignKeysOff`。

---

### 8.1 agent_account_profiles

```sql
CREATE TABLE agent_account_profiles (
    id TEXT PRIMARY KEY,

    agent_id TEXT NOT NULL,

    name TEXT NOT NULL,
    description TEXT,

    auth_type TEXT NOT NULL,

    -- WorkspaceRuntimeRef 拍平成两列（§5.1）
    runtime_kind TEXT NOT NULL
        CHECK (runtime_kind IN ('windows', 'wsl')),
    -- runtime_kind='wsl' 时必填（§7 的跨对象约束）；
    -- 统一小写存储，用于唯一键（distro 名大小写不敏感）
    wsl_distro TEXT
        CHECK ((runtime_kind = 'wsl') = (wsl_distro IS NOT NULL)),

    config_home TEXT,

    status TEXT NOT NULL DEFAULT 'unknown',

    limited_until TEXT,

    -- §46：NULL = 不限；managed profile 创建时写 1
    max_concurrent_runs INTEGER
        CHECK (max_concurrent_runs IS NULL OR max_concurrent_runs >= 1),

    last_used_at TEXT,
    last_successful_at TEXT,
    last_failure_at TEXT,

    enabled INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_account_profiles_agent
ON agent_account_profiles(agent_id);

CREATE INDEX idx_agent_account_profiles_status
ON agent_account_profiles(status);

-- §48.1：configHome 必须唯一，但唯一性是 **per-runtime** 的。
-- 两个不同 distro 里各有一个 /home/u/.teskra/agent-profiles/codex/work
-- 是两个不同文件系统里的不同目录，不能判为冲突。
-- 因此唯一键包含规范化后的 runtime identity。
CREATE UNIQUE INDEX idx_agent_account_profiles_home
ON agent_account_profiles(runtime_kind, IFNULL(wsl_distro, ''), config_home)
WHERE config_home IS NOT NULL;
```

`config_home IS NULL` 的行不参与约束。第一阶段没有任何路径会产生
NULL 行（§50.1），这条豁免是给将来留的余量。

`wsl_distro` 入库前统一小写，否则 `Ubuntu-22.04` 与 `ubuntu-22.04`
在 SQLite 的 `BINARY` 排序下是两行，而它们指的是同一个发行版。

---

### 8.1.1 account_events

§41 的审计事件**在现有表里没有落脚点**：`permission_audit` 和
`agent_events` 的 `run_id` 都是 `NOT NULL REFERENCES agent_runs(id)`，
而 `account.created` / `account.login_started` 不属于任何 Run。

不要把 `agent_events.run_id` 改成 nullable——那会破坏它现有的
`ON DELETE CASCADE` 语义和 `(run_id, seq)` 唯一索引。新增一张表：

```sql
CREATE TABLE account_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,

    -- 事件本身不依附于 Run；run_id 仅在与 Run 相关时填写，且不设 FK 级联删除
    profile_id   TEXT,
    run_id       TEXT,

    event_type   TEXT NOT NULL,   -- account.created / agent.account_switched / ...
    payload_json TEXT NOT NULL,

    created_at   TEXT NOT NULL
);

CREATE INDEX idx_account_events_profile
ON account_events(profile_id, created_at);

CREATE INDEX idx_account_events_type
ON account_events(event_type, created_at);
```

`profile_id` 刻意不设 FK：Profile 被硬删除后，审计记录必须留下。

---

### 8.1.2 profile_aliases

§53.1 的 workflow alias 绑定。alias 是**写进仓库**的稳定名字，
profileId 是**机器本地**的，这张表是两者之间唯一的映射：

```sql
CREATE TABLE profile_aliases (
    agent_id   TEXT NOT NULL,

    -- workflow 里写的名字，如 "work"
    alias      TEXT NOT NULL,

    -- 二选一：account / execution，对应 §53.1 的两种引用
    kind       TEXT NOT NULL
        CHECK (kind IN ('account', 'execution')),
    profile_id TEXT NOT NULL,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    PRIMARY KEY (agent_id, kind, alias)
);
```

不设 FK 到两张 Profile 表：Profile 被删后 alias 应当变成
「未绑定」并在解析时报错（§53.1），而不是被级联删掉、
让用户以为自己从没绑过。

`agent_id` 进主键是因为 `work` 这个 alias 在 codex 和 claude 下
可以指向不同账号。

---

### 8.2 agent_execution_profiles

```sql
CREATE TABLE agent_execution_profiles (
    id TEXT PRIMARY KEY,

    name TEXT NOT NULL,

    agent_id TEXT NOT NULL,

    account_profile_id TEXT,

    model TEXT,
    reasoning_effort TEXT,
    approval_mode TEXT,

    -- 不设 permission_profile_id / tool_profile_id / skill_profile_id /
    -- env_profile_id：这四类实体在仓库里不存在（§6.1）。
    -- 要加回来先看 §6.2 的前置工作。

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(account_profile_id)
      REFERENCES agent_account_profiles(id)
);
```

---

### 8.3 agent_runs

增加（同一个 migration `013_agent_run_account_profile.sql`）：

```sql
ALTER TABLE agent_runs ADD COLUMN account_profile_id TEXT;
ALTER TABLE agent_runs ADD COLUMN execution_profile_id TEXT;
ALTER TABLE agent_runs ADD COLUMN profile_snapshot_json TEXT;

-- §17.2：限额/认证失败的分类结果。不新增 Run status，
-- 失败的 Run 仍然是 status = 'failed'，原因存在这一列里。
ALTER TABLE agent_runs ADD COLUMN failure_classification_json TEXT;
```

**前三列刻意不设外键。** 理由与 `worktrees.run_id` 相同（见
`002_runs.sql` 的注释）：这里要的是审计留痕，而
`ON DELETE SET NULL` 会在删 Profile 时抹掉历史 Run 的身份，
`ON DELETE RESTRICT` 又会让 §47 的「软禁用优先」变成「永远删不掉」。
真相由 `profile_snapshot_json` 承载，`account_profile_id` 只是弱引用。

---

## 9. Profile 文件目录

建议统一（下面用 `~` 只是为了可读，**落库的是展开后的绝对路径**，见 §5.3）：

```text
<home>/.teskra/
└─ agent-profiles/
   ├─ codex/
   │  ├─ personal/
   │  ├─ work/
   │  └─ api/
   │
   └─ claude/
      ├─ personal/
      └─ work/
```

每个 runtime 有自己的 root，**不是同一个逻辑目录的两种写法**：

```text
Windows Profile   C:\Users\<user>\.teskra\agent-profiles\...
WSL Profile       /home/<user>/.teskra/agent-profiles/...
```

两者都以各自的绝对形态入库（§5.3）。

### 9.1 唯一的路径公式

创建与所有权校验必须用**同一条公式**，否则会出现「建在 A、校验 B」：

```text
profileHome(profile) =
    <dataRoot(profile.runtime)> / agent-profiles / <agentId> / <slug>
```

- `dataRoot` 对 `windows` 来自 host 侧 `TeskraPaths`
- `dataRoot` 对 `wsl` 来自 `WorkspaceRuntime.resolveDataRoot()`（TASK-010）

注意 **runtime 不是路径里的一段**。它决定用哪个 `dataRoot`，
而不是在 `agent-profiles` 后面再拼一层——两个 runtime 的 root 本来就
在不同的文件系统里，再加一层只会让路径与实际位置对不上。

因此 `agent-profiles root` 是 **per-runtime** 的，§48.2 的所有权判断
必须按 Profile 自己的 runtime 取对应的 root——拿 Windows root 去判断
一个 WSL Profile 永远不会通过。

### 9.2 路径解析必须进 paths 模块

`apps/desktop/src/main/paths.ts` 是持久路径的唯一来源，
且有 ESLint `no-restricted-syntax` 规则禁止任何模块自己拼 `.teskra`
字面量。Profile Home 不是例外。

所以要在 `TeskraPaths` 上扩展，而不是让
`AccountProfileManager` 手工 `join()`：

既有 `TeskraPaths` 的方法大多是「按需创建」的，但 §48.1 要求
**先插库再建目录**。所以 Profile Home 这两件事必须拆开：

```ts
interface TeskraPaths {
  // ...

  /** 纯解析，不碰文件系统 —— 供插库前计算 config_home */
  resolveAgentProfileHome(agentId: string, slug: string): IpcResult<string>

  /** 创建目录（插库成功之后才调用） */
  createAgentProfileHome(absolutePath: string): IpcResult<void>
}
```

顺序因此是：

```text
resolveAgentProfileHome()   纯计算
    ↓
INSERT（唯一索引挡并发）
    ↓
createAgentProfileHome()
    ↓
失败 → 删除刚插入的行并报错（补偿）
```

WSL 侧的对应解析由 `WorkspaceRuntime` 提供同形的两个方法。
两侧都返回绝对路径，直接满足 §5.3。

`paths` 体系继续负责 **host 侧产物**（run 目录、handoff、artifacts）的
转换；Profile Home 只用它做解析，不参与 runtime 路径翻译（§5.3）。

---

## 10. Codex Profile 实现

### 10.1 核心策略

Codex Profile 使用独立：

```text
CODEX_HOME
```

每个 Profile 完全拥有自己的 Codex Home。

例如：

```text
~/.teskra/agent-profiles/codex/personal
~/.teskra/agent-profiles/codex/work
```

启动时投射：

```text
CODEX_HOME=<profile-home>
```

#### 注意：WSL 下这不是一句 shell 前缀

`CODEX_HOME=… codex` 这种写法只在同一个 POSIX shell 内成立。
WSL-on-Windows 运行时里，Teskra 启动的是 `wsl.exe`，环境变量设在
**Windows 宿主进程**上，不进 `WSLENV` 就根本过不了边界——
见 `apps/desktop/src/main/workspace/runtime.ts` 的 `resolveSpawnEnv`。

现有实现的约定是：**WSLENV 里不带 `/p` 标志，因为值在写进 env 之前就
已经是目标运行时的路径形态**（纯 passthrough）。

`configHome` 按 §5.3 存的就是 runtime-native 的绝对路径，天然满足这个
前提。所以投射只有两步：

1. 直接取 `profile.configHome` 写进 `launch.env`——
   **不要**调用 `resolveRuntimePath`。它是给 host 侧产物
   （`handoffPath` / `artifactDir` / `permissionConfigPath`）用的，
   对 configHome 调用只会把已经正确的路径改坏。
2. `resolveSpawnEnv` 会自动把 `CODEX_HOME` 追加进 `WSLENV`
   （不带 `/p`）——这一步不需要 Profile 代码做任何事，
   但**必须有测试守住**，因为漏了它 env 根本过不了 WSL 边界。

漏掉任何一步的表现都是「Profile 看起来生效了，实际 Codex 仍然读默认
`~/.codex`」——而且不报错。§56.1 的断言必须逐条对应。

---

### 10.2 创建 Profile

流程：

```text
Add Account
    ↓
选择 Codex
    ↓
名称：Personal
    ↓
选择 Runtime
    ↓
创建独立 CODEX_HOME
    ↓
启动官方 codex login
    ↓
用户完成官方登录
    ↓
Teskra detect
    ↓
Profile = ready
```

---

### 10.3 不复制认证文件

禁止：

```text
Profile A/auth.json
     ↓ copy
Profile B/auth.json
```

也不要：

```text
读取 refresh token
复制 refresh token
自行 refresh OAuth
```

每个 Profile 应分别执行官方：

```text
codex login
```

---

### 10.4 Codex Adapter 改造

当前：

```text
CodexAdapter
   ↓
CliAgentAdapter
   ↓
ProcessManager
```

保持不变。

新增 Profile 环境投射：

```text
CodexAdapter
   ↓
AccountProfileResolver
   ↓
build env
   ↓
CODEX_HOME=...
   ↓
ProcessManager
```

建议不要把 Profile 查询逻辑塞进 `CodexAdapter`。

新增：

```ts
interface AccountProfileRuntimeProjection {
  env: Record<string, string>;
  cwd?: string;
  executable?: string;
  args?: string[];
}

interface AgentAccountProfileAdapter {
  agentId: string;

  createProfile(...): Promise<AgentAccountProfile>;

  buildRuntimeProjection(
    profile: AgentAccountProfile,
    context: WorkspaceRuntimeContext
  ): Promise<AccountProfileRuntimeProjection>;

  detectStatus(
    profile: AgentAccountProfile
  ): Promise<AccountProfileDetection>;

  buildLoginCommand(
    profile: AgentAccountProfile
  ): Promise<CommandDescriptor>;
}
```

Codex 实现：

```text
CodexAccountProfileAdapter
```

---

### 10.5 Profile 与 Codex session resume

Codex 的会话存在 `CODEX_HOME` 下，现有 `codex-adapter.ts` 的 resume 走
`codex resume <sessionId>`，没有 sessionId 时回退 `codex resume --last`。

引入 per-profile `CODEX_HOME` 后有两个后果：

1. **换 Profile 后 native resume 必然失败。** 不要让 CLI 去报一个含糊的
   错——resume 前先比对 `run.profileSnapshot.configHome` 与当前解析出的
   Profile，不一致就直接拒绝并提示走 Continuation（§39）。
2. **`--last` 在多 Profile 下是危险的。** 它取的是「那个 Profile Home 里
   最后一个 session」，很可能属于另一个 Run。一旦某 Agent 启用了多
   Profile，就禁用 `--last` 回退路径，只接受显式 sessionId。

---

## 11. Claude Code Profile 实现

Claude Code 使用独立配置目录：

```text
CLAUDE_CONFIG_DIR
```

建议：

```text
~/.teskra/agent-profiles/claude/personal
~/.teskra/agent-profiles/claude/work
```

启动：

```text
CLAUDE_CONFIG_DIR=<profile-home> claude
```

---

### 11.1 注意事项

`CLAUDE_CONFIG_DIR` 承载的不只是凭据——settings、session、plugins、
skills 都在里面。所以按 Profile 隔离它，等于把这些一并按账号隔离了，
见 §33.1 的取舍。

Claude Profile 的隔离也不要假设为绝对 Sandbox。

项目级：

```text
CLAUDE.md
.claude/
project settings
```

仍可能参与配置加载。

因此：

```text
AccountProfile
```

只负责：

```text
账号 / 用户级 CLI 配置身份隔离
```

不负责替代：

```text
Workspace project config
```

---

## 12. 新增 AccountProfileManager

不要继续扩大 `AgentManager`。

新增：

```text
apps/desktop/src/main/agents/accounts/

AccountProfileManager.ts
AccountProfileRepository.ts
AccountProfileStatusService.ts
AccountProfileRuntimeResolver.ts

adapters/
  CodexAccountProfileAdapter.ts
  ClaudeAccountProfileAdapter.ts
```

职责：

```text
AccountProfileManager
├─ create
├─ update
├─ delete
├─ enable / disable
├─ list
├─ get
├─ login
├─ detect
├─ markLimited
├─ markReady
└─ resolveRuntime
```

---

## 13. AgentManager 接入

当前启动大致：

```text
AgentManager.start(request)
      ↓
AgentAdapter.start(...)
```

改成：

```text
AgentManager.start(request)
      ↓
resolve accountProfile
      ↓
AccountProfileManager.resolveRuntime()
      ↓
merge runtime env
      ↓
AgentAdapter.start(...)
```

注意合并顺序。

目标分层：

```text
Base Runtime Env
      ↓
Workspace Env
      ↓
Account Profile Env
      ↓
Execution Profile Env
      ↓
Run-specific Env
      ↓
System-owned TESKRA_* Env
```

### 13.1 映射到现有的三个槽位

现有 `processEnvironment`（`cli-agent-adapter.ts`）实际只有三层可写，
顺序是：

```text
workspace.env  →  request.environment  →  launch.env  →  TESKRA_*
```

最后一层（`TESKRA_HANDOFF_PATH` / `TESKRA_ARTIFACT_DIR` /
`TESKRA_RUN_ID`）已经是最后写入的，防覆盖这点现状就是对的，不用改。

上面六层要落到这三个槽位：

| 目标层 | 落到 | 说明 |
| --- | --- | --- |
| Workspace Env | `workspace.env` | 不变 |
| Execution Profile Env / Run-specific Env | `request.environment` | 由 AgentManager 解析后合并 |
| **Account Profile Env** | `launch.env` | 必须走 Adapter 的 launch，才能排在 `request.environment` 之后 |

`CODEX_HOME` / `CLAUDE_CONFIG_DIR` 只能从 `launch.env` 出。
放进 `request.environment` 会被 Adapter 的 `launch.env` 顶掉，
放进 `workspace.env` 则会被上面两层都顶掉。

### 13.2 保留 key 拒绝列表（安全）

现状下 `workspace.env` 可以设**任意**变量。这意味着一份 workspace 配置
（尤其是 §43 所说的 untrusted workspace）只要设一个 `CODEX_HOME`，
就能顶掉 Profile 身份、把 Run 指向另一个账号的 Home——
而且表面上一切正常。

因此：

- 每个 `AgentAccountProfileAdapter` 声明自己拥有的 env key
  （codex → `CODEX_HOME`，claude → `CLAUDE_CONFIG_DIR`）。
- 这些 key 汇总成保留列表。`workspace.env`、`request.environment`、
  Workflow 声明的 env 中若出现保留 key，一律**拒绝并记录**，
  不是静默丢弃。
- Profile env 永远最后写（§13.1），即便拒绝逻辑有漏网也覆盖得回来。

对应的安全测试见 §58。

---

## 14. StartAgentRunRequest 修改

建议：

既有 `startAgentRunRequestSchema` 是 `z.strictObject`，Agent 种类字段名为
`agentType`（§4.5）；本方案只**新增**两个可选字段：

```ts
export interface StartAgentRunRequest {
  // existing — 字段名照抄现有 schema，不要改名
  workspaceId: string;
  agentType: string;
  taskId?: string;
  prompt?: string;

  // 新增
  accountProfileId?: string;
  executionProfileId?: string;

  // ...
}
```

校验：

```text
executionProfile.agentId
必须等于
request.agentType
```

如果 executionProfile 已经声明：

```text
accountProfileId
```

而请求又额外传了：

```text
accountProfileId
```

必须定义优先级。

建议：

```text
Run explicit override
    >
ExecutionProfile.account
    >
Agent default account
```

但所有 override 必须记录到 Run Snapshot。

---

## 15. 默认 Profile

每个 Agent 可以有：

```text
defaultAccountProfileId
```

例如：

```text
Codex
Default: Personal

Claude
Default: Work
```

建议保存到 Settings，而不是直接塞到 AgentDefinition。

例如：

```ts
interface AgentUserPreferences {
  agentId: string;

  defaultAccountProfileId?: string;

  defaultExecutionProfileId?: string;
}
```

---

## 16. Profile Status

定义：

```text
ready
login-required
limited
expired
unknown
```

`disabled` **不是 status**——管理状态的唯一真相是
`AgentAccountProfile.enabled`（§5.1）。两处都保留会产生
`enabled = true` + `status = "disabled"` 这种无法解释的组合，
而 §47 的「Remove Profile 实际是 soft disable」走的正是 `enabled`。

UI 上把 `enabled === false` 显示成 Disabled 即可，
它是一个展示态，不是状态机里的节点。

状态机：

```text
                 login
login-required ──────────→ ready
                             │
                             │ rate limit
                             ▼
                          limited
                             │
                             │ reset / successful probe
                             ▼
                           ready

ready ── auth failure ──→ expired
expired ── login ───────→ ready
```

---

## 17. Rate Limit Detection

第一版不主动调用未公开 quota API。

使用：

```text
Agent 实际 stderr / structured error / exit reason
```

识别：

```text
rate limit
usage limit
quota exceeded
resets at
login required
authentication expired
```

### 17.0 文本匹配不能单独触发终止

现有 PTY 只有一条统一的 `process.output` 数据流
（`terminal.onData` → `deps.events.emit('process.output', …)`），
**不区分 stdout / stderr**。也就是说扫描到的「文本」可能来自：

- Agent 自己复述用户的话
- `cat` 出来的仓库文件内容
- 一段正在被 review 的 diff

如果匹配到 `quota exceeded` 就把 Run 杀掉，上面三种都会误伤，
而且失败原因会被错误地记成限额。

规则：**纯 PTY 文本匹配只能作为「弱信号」，不能单独触发终止。**
要终止，必须同时满足下列之一：

```text
a. 进程已经以非零码退出（此时分类的是退出原因，不涉及杀进程）
b. Agent 提供了结构化事件 / 结构化错误输出（如 codex exec 的 JSON 事件）
c. 匹配发生在严格的 provider 状态边界上
   （例如输出末尾的独立一行，且该行不在任何工具输出块内）
```

第一版建议只做 (a) 与 (b)：让 Run 自然退出后再分类，
不主动杀进程。这样 §19.3 的 `failAndStop` 只在**用户显式点
「Continue with another account」**时才会被调用——
由人来确认那确实是限额，而不是由正则来赌。

弱信号仍然有用：可以在 UI 上提示「看起来触发了限额」，
但不改 Run 状态、不杀进程。

---

### 17.1 不要散落正则

新增：

```text
AgentFailureClassifier
```

接口：

```ts
export type AgentFailureKind =
  | "rate-limited"
  | "authentication-required"
  | "authentication-expired"
  | "network"
  | "permission"
  | "process-crash"
  | "unknown";

export interface AgentFailureClassification {
  kind: AgentFailureKind;

  resetAt?: string;

  retryable: boolean;

  /** 脱敏后的短证据，见 §17.2。 */
  evidence?: string;
}
```

### 17.2 分类结果必须落库

原稿在 §19.2 写了 `Run status: blocked / rate-limited`——
但现有 `AGENT_RUN_STATUSES` **没有这两个取值**
（created / queued / preparing / running / waiting_for_user /
waiting_for_permission / waiting_for_agent / reviewing / completed /
failed / cancelled / interrupted）。

不要为限额新增状态：它不是一个新的生命周期阶段，而是失败的**原因**。
状态机越宽，recovery 和 UI 要处理的组合就越多。

采用：

```text
status = failed
+ agent_runs.failure_classification_json
```

migration `013_agent_run_account_profile.sql` 里一并加列：

```sql
ALTER TABLE agent_runs ADD COLUMN failure_classification_json TEXT;
```

`agentRunSchema` 增加：

```ts
failureClassification?: AgentFailureClassification;
```

不落库的后果很具体：应用重启后无法判断「哪个 Run 是因为限额失败的」，
§26 的「Continue with another account」入口和 §65 场景 C 都恢复不出来，
`resetAt` 也没了。

### 17.3 evidence 的脱敏与长度

`evidence` 来自 Agent 的原始输出，可能带路径、token 片段、仓库内容。

- 截断到 512 字符。这是**为 evidence 单独定的安全上限**，
  不是复用既有限制——contracts 的 `IPC_TEXT_MAX` 是 64 KiB，
  按它存等于把整段输出塞进审计记录
- 先过既有的 secret 掩码逻辑，再入库
- 只保留匹配到的那一行及其分类依据，不要存整段 stderr
- Renderer 侧按普通文本渲染，不解释其中的控制字符

每个 Agent Adapter 提供：

```ts
class CodexFailureClassifier
class ClaudeFailureClassifier
```

而不是：

```text
AgentManager 里 if stdout.includes(...)
```

---

## 18. Profile Health

增加轻量健康模型：

```ts
interface AccountProfileHealth {
  profileId: string;

  status: AccountProfileStatus;

  lastCheckedAt?: string;

  lastSuccessfulRunAt?: string;

  lastFailureAt?: string;

  consecutiveFailures: number;

  limitedUntil?: string;
}
```

第一阶段不需要复杂 Circuit Breaker，只需要
Ready / Limited / Login Required / Expired / Unknown 五个状态。

### 18.0 Limited 到期后谁来恢复

状态机里 `limited → ready` 的触发写的是「reset / successful probe」，
但**得有人去触发**。没有触发者的话，`limitedUntil` 过了以后 Profile
仍然停在 `limited`，被 §37 的候选过滤和 §26 的切换列表一直排除——
表现是「额度早就恢复了，但 Teskra 说这个账号不可用」。

采用**惰性判定 + 轻量清扫**，不引入常驻定时器：

```text
惰性（主路径）
  任何一次读取 Profile 状态时（list / selector / 切换列表）：
    limitedUntil 存在且 <= now
      → 视为 stale，当场把 status 降级为 unknown 并清空 limitedUntil
      → 该 Profile 重新进入候选，下一次实际启动 Run 即是探测
    limitedUntil 缺失（limited 但无到期时间）
      → lastFailureAt + 默认窗口（1 小时）<= now 时同样视为 stale 并降级
      → lastFailureAt 也缺失时立即降级（unknown 只表示「可以再试」，永远安全）

轻量清扫（辅助）
  应用启动时与 Settings → Accounts 打开时各扫一次，
  把所有到期（含上述默认窗口规则判定到期）的 limited 行批量降级
```

**写入侧兜底（limited 但无 limitedUntil 的预防）：** §18 投射把一次失败
分类为 rate-limited 时，如果 CLI 没有给出可解析的 resetAt
（"resets in 3 hours" / "reset at 11pm" 等模糊措辞不做猜测——猜错的
limitedUntil 比没有更糟），写入 `limitedUntil = lastFailureAt + 1 小时`
的保守默认值，而不是保留旧值或留空。否则没有 `limitedUntil` 的
`limited` 行永远无法被上面的惰性规则命中，Profile 会被 §37 候选过滤和
§26 切换列表永久排除，只能靠手动改状态恢复。默认窗口常量为
`ACCOUNT_LIMITED_DEFAULT_DURATION_MS`（contracts），Main 侧
（`isLimitedExpired` / 投射）与 Renderer 侧（continuation 候选过滤）
共用同一份语义，两处判定结果一致。

降级到 `unknown` 而不是直接 `ready`：额度是否真的恢复了，
只有官方 CLI 说了算。`unknown` 表示「可以再试」，
而 `ready` 是一个我们无权代为断言的结论。

真正的 `ready` 由 §17 的成功 Run 或一次显式 detect 写入。

### 18.1 与既有 AgentHealth 的关系（必须先定清楚）

仓库里已经有一套健康模型，别造第二套并行的：

- `agent-health-manager.ts` 产出 `AgentHealth`，只有
  `agentId` + `runtime` 两个维度。
- `agent-detector.ts` 的探测结果缓存 key 也是 `(agentId, runtime)`。

两者职责划分：

| | 回答的问题 | 维度 |
| --- | --- | --- |
| `AgentHealth`（既有） | **CLI 装没装、版本多少** | `(agentId, runtime)` |
| `AccountProfileHealth`（新增） | **这个账号能不能用**（登录 / 限额） | `(profileId)` |

CLI 是否安装与账号无关，所以 `AgentHealth` **不需要**加 profile 维度，
探测缓存键保持不变。

但 Profile 的 `detectStatus`（§10.4）要在带 Profile env 的前提下探测，
因此它不复用 detector 的缓存——由 `AccountProfileStatusService` 自己
按 `profileId` 缓存。UI 上两者叠加显示：CLI 不可用时不再去问账号状态。

---

## 19. 切换账号的核心流程

### 19.1 不在原 Run 中硬切

错误：

```text
Run #1
Codex Account A

额度用完
↓
偷偷替换 CODEX_HOME
↓
继续复用 Run #1
```

这会破坏：

- Session identity
- Audit
- Recovery
- Reproducibility
- Credential ownership

---

### 19.2 正确流程

```text
Run #1
Codex Personal
      │
      │ rate limited（从输出识别，见 §17）
      ▼
停止 source process 并等待其退出
      │
      ▼
Run #1 落入终态 failed
+ failureClassification（见 §17.2）
      │
      ▼
预留 / 独占 worktree
      │
      ▼
Create Continuation Context
      │
      ├─ original task
      ├─ acceptance criteria
      ├─ changed files
      ├─ git diff
      ├─ handoff
      ├─ last output summary
      └─ remaining work
      │
      ▼
User chooses Codex Work
      │
      ▼
Run #2
Codex Work
```

### 19.3 Continuation 必须是原子的

限额是从**运行中的输出**识别出来的——识别到的那一刻，
交互式 CLI 往往**还没有退出**（它可能正在等用户按键、或自行重试）。

如果这时直接建 Run #2 并复用同一个 worktree，就会有两个 Agent 进程
同时写同一棵工作树。而现有的冲突检测拦不住这种情况：
`unisolatedWriteConflict()` 在 `worktreeId !== undefined` 时**直接返回
undefined**——它防的是「多个 Run 共写 workspace 根目录」，
不是「多个 Run 共写同一个 worktree」。

Continuation 有两条流程，**前置条件不同，不要混成一条**：

**A · 普通 Continuation**（source Run 已经自己结束，最常见）

```text
1. 确认 source Run 处于终态，且其进程确已退出（见 §19.5）
2. 独占 / 预留目标 worktree
3. 创建 target Run
```

这条不调用 `failAndStop`，也不改 source Run 的状态——
它可能是 `failed`（含限额）、`completed` 或 `cancelled`，都照常继续。

**B · fail-and-continue**（source Run 仍在跑，用户主动中断并换账号）

```text
1. failAndStop(sourceRunId, classification)
2. 确认 stop 成功返回（进程已退出）
3. 独占 / 预留目标 worktree
4. 创建 target Run
```

只有 B 会写 `failed + classification`。
原稿把两条合成一条，于是出现「第 2 步要求必须是 failed + classification，
幂等表却允许 completed / cancelled 原样通过」的自相矛盾——
那是因为它们本来就是两条流程。

第 1 步**不能走普通 cancel**：现有 AgentManager 在 `process.exited` 里
按 `cancelRequested` 判定状态，凡是 Teskra 主动停的 Run 一律写
`cancelled`。那样限额信息就丢了，§26 的「Continue with another account」
和 §65 场景 C 都恢复不出来。

需要新增一个单一的状态转换入口：

```ts
failAndStop(runId: string, classification: AgentFailureClassification)
```

它在停止进程之前先登记「这个 Run 的终态是 failed + 这个 classification」，
使 `process.exited` 的处理分支不再把它当作普通 cancel。

### 19.4 failAndStop 必须是幂等的

**最常见的路径是进程已经自己退出了。** §17.0 的结论就是第一版不主动
杀进程：Agent 以非零码退出 → 分类 → Run 落 failed →
用户这时才点「Continue with another account」。

而 ProcessManager 在 `onExit` 里会把条目从 `active` 中删除
（`active.delete(request.id)`），所以事后再对它调 `stop()`
会得到 **not found**。如果 Continuation 无条件调用 stop 并把错误
当成失败，那条最正常的路径反而永远走不通。

`failAndStop` 只在流程 B 里调用，按 Run 当前状态分两种情况：

| source Run 状态 | 行为 |
| --- | --- |
| 已是 `failed` 且已有 classification | 直接返回成功，不调 stop（重复点击 / 重试） |
| 非终态（`running` 等） | 登记终态意图 → 调 `stop()` → 按下面判定 |

其它终态（`completed` / `cancelled` / `interrupted`）**不该走到这里**——
那是流程 A 的情况。`failAndStop` 对它们返回错误，由调用方改走 A。

调 `stop()` 时按它的真实契约判定：
**成功返回即代表进程已退出**（内部 interrupt → terminate → kill 逐级
`await`，返回值里给出 `stage`）。三级都超时后返回 `COMMAND_TIMEOUT`，
此时进程仍然活着 → 中止 Continuation 并报错。

### 19.5 `not found` 不等于进程已死

有一个陷阱：DB 里 Run 仍是非终态，但 `stop()` 返回 **not found**。

这**不能**直接当作「进程已退出」然后去复用 worktree。
`active` map 是**进程内**的——应用重启后它是空的，而库里那条
`running` 的 Run 还在。此时 not found 只说明「本进程没在管它」，
完全可能有一个上次会话遗留的 Agent 进程仍在写那棵 worktree。

正确做法是复用既有的 reconciliation 能力：

```text
stop() 返回 not found
    ↓
取 run.pid + run.pidIdentity（migration 011）
    ↓
探测该 pid 是否存在、且 identity 是否匹配
    ↓
匹配 → 进程还活着：按 reconciliation 的既有路径终止它，
        终止不了就中止 Continuation
不匹配 / 不存在 → 确认已死，可以继续
```

`pidIdentity` 正是为这件事存在的（防 pid 回绕误杀），
Continuation 直接复用同一套判定，不要另写一份。

第 3 步需要 worktree 层提供预留语义，否则 1→4 之间仍有窗口。
第一版可以用「同一 worktree 上不允许存在两个非终态 Run」这条不变式
在 AgentManager 里守住——**这条不变式现在不存在，需要新增**
（见 TASK-107 验收）。

---

## 20. Continuation / Handoff

可以复用 Teskra 现有 Handoff 体系。

新增：

```ts
interface AgentContinuation {
  sourceRunId: string;

  reason:
    | "rate-limit"
    | "manual-switch"
    | "agent-failure"
    | "delegation";

  taskId?: string;

  workspaceId: string;

  worktreeId?: string;

  summary: string;

  changedFiles?: string[];

  artifactIds?: string[];

  acceptanceCriteria?: unknown[];

  previousAgentId: string;

  previousAccountProfileId?: string;
}
```

然后由 ContextBuilder 将它转成下一 Agent Run Prompt。

---

## 21. Worktree 策略

账号切换时：

```text
不要创建新的 Worktree
```

默认应：

```text
Run #1
Codex Personal
  │
  └─ Worktree W1

Run #2
Codex Work
  │
  └─ 继续 Worktree W1
```

因为这是：

```text
同一个 Task 的 continuation
```

而不是：

```text
另一个并行 Worker
```

必须明确区分：

### Continuation

```text
相同 Task
相同 Worktree
不同 AgentRun
可能不同 AccountProfile
```

### Delegation

```text
父子 AgentRun
可使用独立 Worktree
可使用不同 Agent / AccountProfile
```

---

## 22. UI：Settings / Agents

建议新增：

```text
Settings
└─ Agents
   ├─ Codex
   │  └─ Accounts
   │
   └─ Claude Code
      └─ Accounts
```

Codex：

```text
Codex Accounts

┌────────────────────────────────────┐
│ Personal                           │
│ ● Ready                            │
│ Runtime: WSL / Ubuntu-22.04        │
│ Last used: 12 min ago              │
│                                    │
│ [Use as Default] [Open] [...]      │
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ Work                               │
│ ● Ready                            │
│ Runtime: WSL / Ubuntu-22.04        │
│ Last used: Yesterday               │
│                                    │
│ [Use as Default] [Open] [...]      │
└────────────────────────────────────┘

[ + Add Account ]
```

---

## 23. Add Account Wizard

步骤：

```text
Step 1
Select Agent

Codex
Claude Code


Step 2
Profile Name

Personal


Step 3
Runtime

Windows
WSL

Distro:
Ubuntu-22.04


Step 4
Create Isolated Environment

CODEX_HOME
or
CLAUDE_CONFIG_DIR


Step 5
Sign In

[ Open Login Terminal ]


Step 6
Verify

✓ CLI detected
✓ Authentication available


[ Finish ]
```

---

## 24. Login Terminal

不要在后台隐藏执行整个 OAuth。应该打开一个受 Teskra 管理的、
用户能看到完整官方登录过程的终端视图：

```text
Login: Codex Personal

> codex login          （CODEX_HOME 由 Teskra 注入，不显示在命令行里）
```

### 24.1 不要复用现有 Terminal API，也不要拼命令文本

现有 `createTerminalRequestSchema` 是 `z.strictObject`，只接受
`workspaceId` / `shell` / `title` / `cols` / `rows`——
**没有 command，也没有 env**。

于是很容易想到一个捷径：开一个普通终端，再用
`teskra:terminal:write` 把 `CODEX_HOME=... codex login` 这行文本
喂进去。**不要这么做**，两个原因：

1. **跨 shell 不兼容。** `VAR=x cmd` 是 POSIX 语法；用户的默认 shell
   可能是 PowerShell（要 `$env:VAR=...`）或 cmd（要 `set VAR=...`）。
   同一份文本在三种 shell 里行为不同。
2. **命令注入面。** Profile 名、distro、`configHome` 都会被拼进这行文本。
   写进 shell 的字符串是会被解释的——一个含 `; ` 或反引号的
   Profile 名就变成了任意命令执行。

正确做法：新增一条**结构化的登录通道**，把 argv 与 env 作为数据传下去，
由 ProcessManager 直接 spawn（与 Agent 启动同一条路径）。

命令与环境由 Main 侧的 `buildLoginCommand()`（§10.4）产出
`CommandDescriptor { executable, args: string[], env }`，
**全程不经过 shell 字符串拼接**。Renderer 只提交 profileId。

这也顺带满足 §55：repo-local workflow 永远碰不到登录命令。

### 24.2 登录视图必须是可交互的会话，不是只读输出

官方登录流程要键盘输入：选择登录方式、确认、device-code 流程里
粘贴或回车。所以登录视图**不能是只读的**，
`account:login` 也**不能等整个 OAuth 完成才返回**——
那会让 IPC 挂住几十秒到几分钟。

`login.start` 立即返回一个会话句柄：

```ts
interface AccountLoginSession {
  sessionId: string;
  profileId: string;
  startedAt: string;
}
```

配套通道（与既有 Terminal 的形状一致，但参数是 profileId 而非命令）：

```text
teskra:account:login:start     → AccountLoginSession
teskra:account:login:write     （sessionId, data）
teskra:account:login:resize    （sessionId, cols, rows）
teskra:account:login:cancel    （sessionId）

events:
  account.login.output   （sessionId, data）
  account.login.exited   （sessionId, exitCode）
```

还要定义清楚这几件事，否则会留下孤儿进程：

- **重复登录互斥**：同一 profileId 同时只允许一个登录会话；
  第二次 start 返回既有 sessionId 而不是再起一个进程
- **attach 租约**：去重命中既有会话时该会话的 attach 计数 +1（新会话从 1
  开始）；`cancel` 只释放一个租约，**最后一个租约释放才真正杀 PTY**——
  React StrictMode 双挂载 / 快速重挂载时，先卸载的挂载不会杀掉另一挂载
  仍在使用的会话。进程自然退出不受租约数影响，立即 settle；
  Main 侧超时在租约 >0 时仍强制停止（窗口重载导致租约搁浅时的兜底）
- **窗口关闭**：Renderer 侧关闭视图 → 必须发 `cancel`；
  Main 侧不依赖 Renderer，自己也要有超时清理
- **应用退出**：登录会话随 `disposeAll()` 一起停止
- **cancel 语义**：停止进程，Profile 状态保持登录前的值，不写 `expired`

`exited` 之后才 `Detect`，再更新 `Profile.status`。

登录完成后：

```text
Detect
```

再更新：

```text
Profile.status
```

---

## 25. Agent Start UI

当前选择 Agent：

```text
Agent
[ Codex v ]
```

扩展成：

```text
Agent
[ Codex v ]

Account
[ Personal v ]

Profile
[ Codex High v ]
```

如果只有一个 Account：

```text
可以默认折叠 Account 选择
```

避免 UI 变复杂。

---

## 26. Rate Limit UI

当某 Run 被识别为：

```text
rate-limited
```

在 AgentRun 卡片显示：

```text
Codex · Personal

⚠ Usage limit reached

Reset:
03:12

[ Continue with another account ]
[ Retry ]
[ Wait ]
```

点击：

```text
Continue with another account
```

弹出：

```text
Continue TASK-218 with

● Codex Work
● Claude Work
● Codex API

Reuse current worktree:
✓

Carry handoff:
✓
```

---

## 27. Dashboard

Home 可以增加：

```text
Agent Accounts

Codex
Personal      Limited · 03:12
Work          Ready

Claude
Personal      Ready
Work          Login required
```

同时继续遵循 Teskra Dashboard 原则：

```text
显示用户需要处理的状态
```

而不是做纯统计。

---

## 28. IPC

既有 channel 名是 `teskra:<domain>:<action>` 字面量，集中在
`packages/contracts/src/ipc.ts` 的 `IPC_CHANNELS`，再由 `channel()` 包上
请求 / 响应 schema。不存在 `accounts.list` 这种点号风格。

新增一个 channel 要同时改**四处**，缺一个就跑不通：

1. `IPC_CHANNELS` 加字面量
2. `channel(...)` 定义（含 Zod 请求 schema 与响应 schema）
3. `ipc/router.ts` 里挂 `runtime.account.*`
4. Runtime facade（`runtime/facade.ts` / `compose.ts`）暴露对应方法

新增领域 channel：

```text
teskra:account:list
teskra:account:get
teskra:account:create
teskra:account:update
teskra:account:remove
teskra:account:detect
teskra:account:set-default
teskra:account:enable
teskra:account:disable
```

登录不是一次请求，而是一个交互式会话（§24.2），所以它是**四个 channel
加两个事件**，不是单个 `teskra:account:login`：

```text
teskra:account:login:start     （profileId）      → AccountLoginSession
teskra:account:login:write     （sessionId, data）
teskra:account:login:resize    （sessionId, cols, rows）
teskra:account:login:cancel    （sessionId）
```

事件（走既有 EventBus → Renderer 订阅路径，与 §42 一起注册）：

```text
account.login.output    （sessionId, data）
account.login.exited    （sessionId, exitCode）
```

Workflow alias 的绑定（§53.1）也需要自己的 channel：

```text
teskra:account:alias:list      （agentId?）
teskra:account:alias:bind      （agentId, kind, alias, profileId）
teskra:account:alias:unbind    （agentId, kind, alias）
```

`kind` 不能省：主键是 `(agent_id, kind, alias)`，同一个 `work`
可以既是 account alias 又是 execution alias。而且两张 Profile 表的
id 命名空间**不能假定不重叠**——靠 profileId 反推 kind 是不可靠的。

bind 必须校验：

```text
profileId 存在于 kind 对应的表
profile.agentId === 请求里的 agentId
```

否则会绑出一个「codex 的 alias 指向 claude 的 Profile」，
而这个错误要到 workflow 真正跑起来才暴露。

既有 `teskra:agent:start` 的请求 schema 增加：

```text
accountProfileId
executionProfileId
```

Continuation 新增：

```text
teskra:agent:continue-with-profile
```

请求：

```ts
interface ContinueAgentRunRequest {
  sourceRunId: string;

  targetAgentId: string;

  targetAccountProfileId?: string;

  targetExecutionProfileId?: string;
}
```

---

## 29. Renderer API

建议：

```text
src/renderer/services/
  accountProfiles.ts
```

或者沿用当前 API / IPC 层风格。

不要 Renderer import Main implementation。

只共享：

```text
packages/contracts
```

---

## 30. Contracts

建议新增：

```text
packages/contracts/src/
├─ agent-account.ts
├─ agent-execution-profile.ts
├─ agent-continuation.ts
└─ agent-failure.ts
```

所有 IPC 输入继续使用 Zod。

例如：

```ts
export const AgentAccountProfileIdSchema =
  z.string().min(1);

export const StartAgentRunSchema =
  z.object({
    // 既有字段名是 agentType，不是 agentId（§4.5）
    agentType: z.string().min(1),
    accountProfileId: z.string().min(1).optional(),
    executionProfileId: z.string().min(1).optional(),
    // ...
  });
```

---

## 31. Repository

新增：

```text
AccountProfileRepository
ExecutionProfileRepository
```

不要在：

```text
AccountProfileManager
```

直接写 SQL。

继续沿用现有：

```text
Manager / Service
    ↓
Repository
    ↓
SQLite
```

---

## 32. 配置所有权

这里借鉴 CC Switch，但不要重复它的完整配置覆盖问题。

Teskra 不应该认为：

```text
~/.codex/config.toml
```

整个文件都属于 Teskra。

应该定义：

```text
Field Ownership
```

例如：

```text
Codex-owned
  desktop
  feature flags
  future unknown config

AccountProfile-owned
  CODEX_HOME boundary

ExecutionProfile-owned
  Teskra明确管理的 model/reasoning overrides

MCP-owned
  mcp_servers

User-owned
  unknown fields
```

任何配置修改：

```text
Patch owned fields only
```

不要：

```text
读整个文件
↓
存 Snapshot
↓
下次整个覆盖
```

### 32.1 权限投射产物不属于 Profile Home

现有权限投射（`agents/permissions/permission-projection.ts`）：

- Claude → 把 settings 文档写进 **run 目录**
  （`<runDir>/permission-settings.json`），再用 `--settings <path>` 指过去
- Codex → 纯 `--sandbox` / `--ask-for-approval` 启动参数，不落盘

两者都**不受** `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 影响，这是好事，
要在实现时守住：**权限投射产物永远写 run 目录，绝不写 Profile Home。**

写进 Profile Home 会让并发跑在同一 Profile 上的两个 Run 互相污染权限配置，
而且这种污染是跨 Run 持久的。

---

## 33. Account Profile 与 MCP / Skills 的关系

### 33.1 先承认一个事实：CLI Home 不只是认证

隔离整个 CLI Home 的副作用比「换个账号」大得多：

| | 同时承载 |
| --- | --- |
| `CODEX_HOME` | 用户配置（`config.toml`，含 MCP server 声明）、会话历史、认证 |
| `CLAUDE_CONFIG_DIR` | settings、凭据、session、plugins、skills |

也就是说：**只要按 §10 / §11 隔离整个 Home，MCP、Skills 和用户配置
就会连带被账号隔离**，这是官方 CLI 的加载行为决定的，不是设计选择。

因此下面那张「多个账号共享同一组 Tool / Skill 配置」的分层图
**是目标态，不是第一阶段能达到的形态**。

### 33.2 第一阶段的取舍

第一阶段明确选择：

```text
AccountProfile = 完整 CLI Home
```

即：**账号即环境**。新建一个 Profile 就是一套全新的 CLI 配置，
用户需要在每个 Profile 里各自配置 MCP / Skills。

代价写在明处：

- 用户配置 MCP 要配 N 遍
- 一个 Profile 里装的 skill 在另一个 Profile 里看不到

要达到分层图描述的形态，需要补一层**可重复生成的配置 overlay /
projection 机制**：Teskra 持有 Tool / Skill Profile 的规范模型，
在每次 Run 启动前把它**投射**（patch owned fields，见 §32）进目标
Profile Home 的配置文件。这与 §32 的字段所有权是同一套机制，
但需要独立立项——不在 TASK-094～115 范围内。

在那之前，§6.1 的 ExecutionProfile 不引用 Tool / Skill Profile。

### 33.3 目标态分层

AccountProfile 概念上不应该包含 MCP。

错误：

```text
Codex Personal
├─ login
├─ MCP
├─ skills
├─ model
└─ permissions
```

正确：

```text
AccountProfile
=
Authentication Identity

ExecutionProfile
=
Runtime Policy

ToolProfile
=
MCP / Tools

SkillProfile
=
Skills
```

组合：

```text
AgentRun
│
├─ AgentDefinition
├─ AccountProfile
├─ ExecutionProfile
├─ ToolProfile
└─ SkillProfile
```

这样以后多个账号可以共享同一组 Tool / Skill 配置——
**前提是先有 §33.2 说的 overlay 机制**，否则这张图只是方向。

---

## 34. Credential Store

OAuth subscription Profile：

```text
不要把 OAuth token 复制进 Teskra Credential Store。
```

由官方 CLI Profile Home 管理。

API Profile：

```text
可以继续使用 Teskra safeStorage Credential Store。
```

例如：

```ts
AgentAccountProfile {
  authType: "api-key"
}
```

只保存：

```text
credentialRef
```

不要数据库明文保存：

```text
sk-...
```

---

## 35. API Profile

**第一阶段不做。** `authType: "api-key"` 保留在枚举里（换成别的值
以后要做数据迁移），但：

- 初始 schema / 表**不含** `credentialRef` / `endpoint`
- §2.1 产品目标树与 §22 / §26 的 UI 里出现的 `API`
  一律是**示意**，第一期不实现对应入口
- 相关任务不在 TASK-094～115 内

要做的时候按下面的形状加，并补 contracts / 表 / IPC / 任务。

未来支持：

```text
Codex API
Claude API
```

可增加：

```ts
interface AgentAccountProfile {
  // ...

  credentialRef?: string;

  endpoint?: string;
}
```

但 API Profile 仍然应该优先通过：

```text
官方 CLI 支持的 env/config
```

投射，而不是 Teskra 自己变成 LLM API Client。

---

## 36. 不做 Local LLM Proxy

这一阶段明确不实现：

```text
localhost:xxxx
    ↓
Anthropic → OpenAI protocol translation
    ↓
Provider routing
    ↓
Failover gateway
```

这是 CC Switch / LiteLLM / new-api 类型问题。

Teskra 当前核心仍然是：

```text
Coding Agent Orchestration
```

不是：

```text
LLM Gateway
```

---

## 37. Profile Selector 策略

定义：

Profile 绑定了 runtime（§5.1），而 Run 跑在 workspace 的 runtime 上，
两者不一定兼容。因此 selector 必须接收 workspace runtime：

```ts
interface AccountProfileSelector {
  resolve(
    agentId: string,
    workspaceRuntime: WorkspaceRuntimeRef,
    explicitProfileId?: string
  ): Promise<AgentAccountProfile | undefined>;
}
```

第一阶段规则：

```text
0. 先按 runtime 兼容性过滤候选
   （kind 必须相同；wsl 还要求 distro 相同——
    managed WSL Profile 的 distro 必填，不存在「未指定」的情况）
1. Run explicit accountProfileId
2. ExecutionProfile.accountProfileId
3. runtime-compatible 的 Agent default account
4. 都没有 → legacy CLI default environment（§52）
```

### 37.1 不要「只有一个 ready Profile 就自动选它」

原稿有一条「唯一一个 ready Profile 则自动选择」。**删掉它**，
因为它和 §52 的兼容性承诺直接冲突：

```text
今天： { agentType: "codex" }  → 用户默认的 ~/.codex 账号
用户创建了第一个 managed Profile
明天： { agentType: "codex" }  → 静默切到那个新 Profile
```

用户只是「加了一个账号」，既有的 Task、Workflow 和测试就换了身份跑，
而且没有任何提示。这正是 §66 说的「串号」。

规则：**没有显式指定、也没有设默认，就走 legacy 环境**——
不要根据候选数量去猜。想让新 Profile 生效，用户显式设为默认
（§15）或在启动时选择即可。

第 0 步不可省。三种典型不兼容：

- WSL Profile 用在 Windows workspace（反之亦然）
- `Ubuntu-22.04` 的 Profile 用在 `Debian` workspace
- 默认 Profile 恰好是另一个 runtime 的

前两种如果不过滤，表现是 CLI 读不到 Home 而静默退回默认账号。

**显式指定但不兼容时报错，不要静默降级**——用户点名了 Codex Work
却跑在 Personal 上，是最坏的一种失败。

不要第一版实现：

```text
最少使用
随机
Round Robin
余额最多
```

---

## 38. 状态恢复

Teskra Crash Recovery 启动时：

```text
恢复 AgentRun
```

必须使用历史 Run：

```text
accountProfileId
profileSnapshot
```

不能用：

```text
当前 Agent 默认 Profile
```

例如：

```text
昨天 Run 使用 Codex Work
今天默认 Profile 改成 Personal
```

Resume 仍然必须：

```text
Codex Work
```

除非用户显式：

```text
Continue with different account
```

---

## 39. Resume 语义

区分：

### Native Resume

```text
同 Agent
同 AccountProfile
同 CLI Session
```

允许：

```text
adapter.resume()
```

### Cross-profile Continuation

```text
同 Agent
不同 AccountProfile
```

不应该尝试：

```text
native resume
```

应该：

```text
Context / Handoff continuation
```

### Cross-agent Continuation

```text
Codex
   ↓
Claude
```

同样：

```text
Context / Handoff continuation
```

---

## 40. Runtime Identity

建议定义：

```ts
export interface AgentRuntimeIdentity {
  agentId: string;

  accountProfileId?: string;

  executionProfileId?: string;

  /** 与 AccountProfile.runtime 同型（§5.1），不要退化成二元枚举。 */
  runtime: WorkspaceRuntimeRef;

  configHome?: string;
}
```

所有：

```text
start
resume
recover
continue
delegate
```

都明确携带 Runtime Identity。

---

## 41. Audit

这些事件写入 §8.1.1 新增的 `account_events` 表。

**不能复用现有两张表**：`permission_audit` 与 `agent_events` 的 `run_id`
都是 `NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE`，
而下面前五个事件不属于任何 Run。

增加事件：

```text
account.created
account.updated
account.login_started
account.login_verified
account.status_changed

agent.profile_selected
agent.rate_limited
agent.continuation_created
agent.account_switched
```

后四个虽然有 `run_id`，但同样写 `account_events`——
把账号生命周期的审计放在一张表里，查起来才是完整的。

例如：

```json
{
  "event": "agent.account_switched",
  "taskId": "TASK-218",
  "sourceRunId": "run_001",
  "targetRunId": "run_002",
  "from": "acct_codex_personal",
  "to": "acct_codex_work",
  "reason": "rate-limit"
}
```

---

## 42. EventBus

新增 typed events：

```ts
type AccountEvents = {
  "account.created": ...
  "account.updated": ...
  "account.status_changed": ...
  "account.login_required": ...
  "account.limited": ...
}
```

Renderer 继续通过现有 EventBus / IPC 订阅状态更新。

---

## 43. Workspace Trust

Workspace Trust 是仓库**已知未完成**的项（见
`docs/code-review-2026-09-12.md`），而本方案的 §55 与 §58 都直接依赖它的
安全语义。

因此不要写成「建议先完成」——它是 **TASK-111（Workflow Profile Support）
与 TASK-114（Security Tests）的硬依赖**，已在 `docs/teskra-tasks.md`
分配正式编号 **TASK-118**（Milestone 24），并按 code-review P0-3 的
三条建议展开为可实施任务：workspace 层 `agents` 组剥离、
Restricted 下不加载 repo-local workflows / prompts / config、
repo 定义的 shell 步骤执行前展示完整命令行确认。

只挡 shell workflow 是不够的——`<repo>/.teskra/config.json` 的
`agents.executableOverrides` 与 `<repo>/.teskra/prompts/` 是另外两条路径。

在它完成之前：

```text
TASK-111 不可开工
TASK-114 的「untrusted workspace 自动执行受限」一条无法验收
```

但它**不阻塞 Phase A～D**（TASK-094～110 与 112 / 116 / 117）。

原因：

未来 Account Profile + Delegation 会增加自动执行能力。

必须保证：

```text
untrusted workspace
```

不能通过 repo-local workflow：

```text
自动执行 shell
自动配置 Agent runtime
自动启动 Delegation
```

建议最少支持：

```text
Trusted
Restricted
```

Restricted：

```text
repo-local shell workflow 禁止
repo-local executable override 禁止
自动 delegation 禁止
敏感 env 投射受限
```

---

## 44. Delegation 兼容设计

虽然本实施阶段不一定同时实现 Delegation，但数据模型必须提前兼容。

未来：

```ts
delegate_task({
  agent: "codex",
  accountProfileId: "acct_codex_work"
})
```

因此 AgentRun 应预留：

```text
parentRunId
rootRunId
delegationId
depth
```

Account Profile 不要等 Delegation 做完后再加。

---

## 45. 同 Agent 多实例

完成 AccountProfile 后：

```text
Codex Personal
Codex Work
Codex Other
```

可以同时运行：

```text
TASK A
Codex Personal

TASK B
Codex Work

TASK C
Codex Other
```

前提：

```text
每个 Run 独立 Process
每个 Profile 独立 Config Home
每个 Task 独立 Worktree
```

这和当前 Teskra 架构天然兼容。

---

## 46. 并发限制

并发限制**已经存在**（TASK-084），形状是
`packages/contracts/src/config.ts` 的 `concurrencyConfigSchema`：

```ts
concurrency: {
  maxGlobalRuns: 4,
  maxRunsPerWorkspace: 3,
  maxRunsPerAgent: 2,
}
```

不要另造一个 `ConcurrencyPolicy`——字段名对不上，而且会丢掉
`maxRunsPerWorkspace` 这一维。全局配置**保持不变**。

### 46.1 限制放在 Profile 上，不是放在全局配置里

per-profile 的上限**只有一个来源**：`AccountProfile.maxConcurrentRuns`
（§5.1 的字段）。不要同时再加一个全局的
`concurrency.maxRunsPerAccountProfile`——两个真相会立刻打架
（全局默认「不限」vs Profile 默认 1，谁赢没法解释）。

选 Profile 字段的理由：这个限制本来就是 per-Profile 的属性
（取决于该 Profile 有没有独立的 `configHome`），不是一条全局策略。

取值规则：

| Profile | `maxConcurrentRuns` | 效果 |
| --- | --- | --- |
| managed（有独立 `configHome`） | 创建时写入 `1`，用户可改 | 同一 Home 上不并发 |
| legacy fallback（**根本没有 Profile**，§50.1） | 不适用 | 不限，沿用 `maxRunsPerAgent` |

第二行不是一种 Profile，而是「没有 Profile」这个状态本身——
没有记录自然就没有 per-profile 上限，存量用户的并发行为因此不变。

**有效值：`undefined` 或 `>= 1` 的整数。** Zod schema、SQL `CHECK`、
TASK-117 验收三处都要挡住 `0` 和负数——写进去的后果是该 Profile 的
Run 永远排队，而且表现为「点了没反应」，很难查。

存量用户走的是第二行，所以**并发行为保持不变**——
如果反过来把默认 1 加在全局配置上，§50 / §52 自动创建的 default profile
会让每个人的 per-agent 并发从 2 静默掉到 1，那是一次面向存量用户的回归。

### 46.2 为什么需要这个限制

§45 宣传的「同 Agent 多实例」讲的是**不同 Profile**。但**同一个 Profile
被多个 Run 并发使用是默认就会发生的事**——两个 codex 进程共享同一个
`CODEX_HOME`，同时写 `sessions/` 与 config，官方 CLI 并没有承诺过并发安全。

### 46.3 落地位置

光有字段不够，现有 `hasCapacity()` 只按
`workspaceId` / `agentType` 计数，完全不知道 Profile 的存在。需要：

```text
1. agent_account_profiles 表加列 max_concurrent_runs INTEGER
2. hasCapacity() 的 candidate 增加 accountProfileId，
   并对 runs.filter(run => run.accountProfileId === candidate.accountProfileId)
   计数与 profile.maxConcurrentRuns 比较
3. 超限时进入既有的 queued 状态，由既有排队路径调度
   （不要新造一套等待机制）
```

这三步没有对应任务，见 TASK-117。对应验收场景见 §65 场景 H。

---

## 47. 删除 Profile

删除前检查：

```text
Active Runs?
Recoverable Runs?
Default Profile?
Historical References?
```

不要删除历史 Run FK。

### 47.1 第一阶段只做 soft disable

`agent_execution_profiles.account_profile_id` 是 **RESTRICT** 外键
（§8.2）。只要有任何一个 ExecutionProfile 引用了这个账号，
硬删除就会被数据库直接拒绝——而 §65 场景 G 又声称硬删除后历史记录
仍可用。两者不能同时成立。

结论：**第一阶段不提供硬删除。** `remove` / `delete` 在 IPC 与 UI 上
统一是 soft disable（`enabled = false`）。

理由不只是外键：Profile 是历史 Run 的身份来源，硬删除除了省一行数据
没有任何收益，而 `profileSnapshot` 也不是万能的——它只存了启动时的
快照，不存后来的状态变化。

要在以后加硬删除，必须先定义**引用解除策略**，而且不能是静默
`SET NULL`：那会让一个引用过该账号的 ExecutionProfile 悄悄变成
「用默认账号」，正是 §37.1 说的串号。可选做法是删除前列出所有引用者
并要求用户逐个改绑。

`account_events` 则相反——它不设 FK，就是为了在将来真有硬删除时
仍然留下审计（§8.1.1）。

soft disable 的语义：

UI：

```text
Remove Profile
```

实际：

```text
enabled = false
```

Profile Home 删除必须单独确认：

```text
[ ] Also delete local CLI profile data
```

默认不删除。

### 47.2 禁用、默认 Profile、删 Home 三者的组合语义

这三件事可以任意组合，必须逐一定义——留空的地方最后都会变成静默回退，
而静默回退就是串号（§37.1）。

**(1) 禁用一个正被设为默认的 Profile**

```text
禁用时同时清除该 agent 的 defaultAccountProfileId
```

不采用「拒绝禁用」——那会让用户卡在「想停用它，又必须先挑一个替代」的
死角。也不采用「保留默认指向一个 disabled Profile」——那是个无法解释的
状态。UI 上必须明确提示「已同时清除默认账号」，不能悄悄做。

**(2) Resolver 遇到 disabled 的默认 Profile**

如果 (1) 执行到位，这个状态不该出现。但库可以被外部改动，
所以 Resolver 仍要有确定行为：

```text
显式指定 disabled Profile  → 报错（§7 跨对象约束已定义）
默认指向 disabled Profile  → 报错，并提示重新设置默认
```

**不回退 legacy**。回退等于用户以为在用 Work，实际跑在默认账号上。

**(3) Home 已删除后重新 enable**

```text
enable 时检查 configHome 是否存在
    ↓
不存在 → 重建目录（§9.2 的 createAgentProfileHome）
         并把 status 置为 login-required
    ↓
用户重新走 §24 的登录流程
```

采用「重建 + login-required」而不是「禁止启用」：
Profile 记录本身还有价值（历史 Run 引用它、alias 可能绑着它），
把它变成一个不可恢复的僵尸行没有好处。

status 必须置 `login-required` 而**不是** `unknown`——
`unknown` 会让 §37 的候选过滤把它当成可能可用，
于是第一个 Run 才发现登录没了。

**(4) 禁用时有活跃 Run**

沿用 §47 开头的检查：有非终态 Run 时拒绝禁用，
提示用户先取消或等待。禁用不应该顺带杀掉正在跑的 Run。

---

## 48. Profile Home 删除安全

禁止删除：

```text
~/
~/.codex
~/.claude
任意非 Teskra-owned 目录
```

必须有 Path Ownership Guard：

```text
configHome
必须位于
Teskra agent-profiles root
```

才允许自动删除。

否则只删除 DB Profile。

### 48.1 Managed Profile 的 configHome 不可由用户编辑

最简单的修法是把攻击面去掉：**managed profile（`authType` 为
`subscription` / `api-key`）的 `configHome` 由 Teskra 按
`<agent-profiles root>/<agentId>/<slug>` 生成，UI 不提供编辑入口，
IPC 也不接受该字段的更新。**

用户能控制的只有 `<slug>`，且受 `^[a-z0-9][a-z0-9-]{0,31}$` 约束。
完整公式见 §9.1。

`authType: "external"`（§49）是唯一能指定既有目录的入口，
而它本来就禁止 Teskra 删除其 Home。

#### configHome 必须唯一

光有生成公式不够：两个同 runtime、同 agentId、同 slug 的 Profile
会**共享同一个认证目录**，账号隔离当场失效——而且看不出来，
两个 Profile 在 UI 上是分开的。

三道防线，缺一不可：

1. **数据库唯一索引**（012）：见 §8.1 的
   `idx_agent_account_profiles_home`。唯一键是
   `(runtime_kind, wsl_distro, config_home)` 而不是只有 `config_home`——
   唯一性是 per-runtime 的（§9.1）。

2. **Manager 侧原子创建**：先插库（唯一索引把并发挡住）再建目录。
   反过来做会在冲突时留下孤儿目录。

   这要求路径 API **能在不创建目录的前提下解析**，见 §9.2。
   `mkdir` 失败时必须补偿：删掉刚插入的行并向用户报错，
   不要留下一条指向不存在目录的 Profile——那会让后续每次启动都失败，
   而 UI 上看起来一切正常。

3. **slug 冲突的行为要定义**：重名直接**报错并要求用户改名**，
   不要自动加后缀。自动 `work-2` 会让用户以为自己选中的是 `work`。

Windows 侧还要注意**大小写不敏感**：`Work` 和 `work` 在 NTFS 上是同一个
目录，但在 SQLite 的默认 `BINARY` 排序下是两行。所以 slug 校验正则只允
许小写（上面已经是），并在入库前统一 `toLowerCase()`。

### 48.2 所有权校验算法（create / update / delete 三处共用）

原稿写的「先 realpath 再判断」有两个无法执行的地方，必须先解决：

**(a0) root 自己也还不存在。**
「最近的已存在祖先必须位于 agent-profiles root 之内」这条规则，
在第一次创建 Profile 时会把 root 自己拒掉——那时 root 还没建。

所以分两段：先**建立可信 root**，再校验其子目录。

```text
该 runtime 的 dataRoot   ← 可信来源，不接受用户输入
（windows: TeskraPaths / wsl: WorkspaceRuntime.resolveDataRoot()）
    ↓
<dataRoot>/agent-profiles          ← 与 §9.1 同一条公式
    ↓
不存在 → 直接创建（这一步不需要所有权校验，路径完全由 Teskra 决定）
存在   → realpath + 必须是目录 + 不是 symlink/reparse point
    ↓
得到 trustedRoot（此后所有判断都拿它比较）
```

`trustedRoot` 每次进程启动解析一次并缓存，不要每次创建 Profile 重算。
如果 realpath 后发现它已被替换成 symlink，直接拒绝所有 Profile 写操作
并报错——这是被动过手脚的信号，不要自动修复。

**(a) 新目录还不存在，realpath 会直接失败。**
所以（在 `trustedRoot` 之下）校验的对象是**最近的已存在祖先**：

```text
从目标路径逐级向上，找到第一个已存在的祖先
    ↓
对该祖先做 realpath（解析 symlink / Windows reparse point）
    ↓
规范化，判断它是否位于该 runtime 的 agent-profiles root 之内
    ↓
不在 → 拒绝
在   → 创建目录
    ↓
创建后对最终路径再做一次 realpath 校验
```

创建后必须**再校验一次**：从「检查祖先」到「创建完成」之间存在竞态，
攻击者可以在这个窗口里把中间某一级换成 symlink。

只做字符串前缀比较等于没做——`<root>/../../Windows` 在字符串上
也是「以 root 开头」的。

**(b) Windows 主进程不能把 `/home/...` 当本机路径处理。**
`node:fs` 对一个 WSL Profile 的 `/home/weston/...` 只会解释成
Windows 当前盘符下的 `\home\weston\...`——校验和创建都会作用在
错误的位置。

因此 Profile Home 的 **stat / realpath / mkdir / rm 必须是
runtime-aware 的**：

| Profile runtime | 执行方式 |
| --- | --- |
| `windows` | 直接 `node:fs` |
| `wsl`（host-native，即 Linux 开发机） | 直接 `node:fs` |
| `wsl`（WSL-on-Windows） | 经 `WorkspaceRuntime` / CommandRunner 在 distro 内执行（`realpath`、`mkdir -p`、`rm -rf`），或走已校验过的 `\\wsl.localhost\<distro>\…` UNC 映射 |

走 distro 内执行时参数必须以 argv 数组传递，不要拼 shell 字符串。

补充两条：

- `authType: "external"` 的 Profile 其 `configHome` 天然在 root 之外，
  「删除本地数据」选项应当**直接不可用**，而不是靠守卫兜底。
- 已有 Run 引用过的 Profile，`configHome` 不可改动（§48.1 已经禁止编辑）；
  确需更换目录时按新建 Profile 处理，否则历史 Run 的 snapshot 会与现状对不上。

---

## 49. 导入已有账号

未来可以支持：

```text
Import Existing CLI Environment
```

例如：

```text
Default Codex
~/.codex
```

但不要：

```text
复制 ~/.codex
```

第一版建议做：

```text
External Profile
```

```ts
authType: "external"
configHome: "C:\Users\weston\.codex"   // 或 WSL Profile 的 /home/weston/.codex
```

注意 §5.3 的规则对 external Profile 同样适用：**入库的是展开后的绝对
路径**。UI 上可以显示成 `~/.codex`，但 `~` 不能落库——
环境变量值里的 `~` 不会被展开。

并标注：

```text
Managed externally
```

此 Profile：

```text
Teskra 不允许删除 Home
Teskra 不修改登录状态
```

---

## 50. 不创建「默认 Profile」记录

早期版本打算在升级时自动建两条 `Codex Default` / `Claude Default`
记录（`configHome = undefined`，含义是「用 CLI 默认 HOME」）。
**放弃这个做法。**

原因是它和 §5.1 的 runtime 模型对不上：每条 Profile 必须有
`runtime_kind`，WSL 还必须有 `distro`。而「CLI 默认 HOME」在
Windows、Ubuntu-22.04、Debian 上是**三个不同的目录**——
一条记录代表不了它们，而默认 Profile 又是 per-agent 的，
没有地方放这三份。

强行创建的结果只会是：随便挑一个 runtime 写进去，然后在另一个 runtime
上悄悄指向错误的 Home。这正是本文反复要避免的静默串号。

### 50.1 改用「没有 Profile」这个状态本身

兼容性由 §52 的 legacy fallback 承担，不需要任何记录：

```text
没有指定 accountProfileId
    ↓
没有设默认 Profile
    ↓
不投射任何 CODEX_HOME / CLAUDE_CONFIG_DIR
    ↓
CLI 用它自己的默认 HOME —— 与今天完全一致
```

「不投射」比「投射一个值为『默认』的 Profile」更简单也更安全：
没有记录就没有 runtime 不匹配的可能。

推论：

- `agent_account_profiles.config_home` 允许 NULL，但**第一阶段没有任何
  路径会产生 NULL 行**。这一列的可空性是给将来留的余量。
- §46 的 per-profile 并发限制对 legacy 路径天然不适用——
  没有 Profile 就没有 `maxConcurrentRuns`，仍然只受 `maxRunsPerAgent` 约束。

### 50.2 想把既有环境纳入管理，用 External Profile

用户如果希望在 UI 里看到并管理自己原有的 `~/.codex`，
走 §49 的 External Profile，**针对具体 runtime 逐个创建**：

```ts
authType: "external"
runtime:  { kind: "wsl", distro: "Ubuntu-22.04" }
configHome: "/home/weston/.codex"
```

这是用户显式动作，不是升级时自动发生的。
Teskra 不删除这类 Profile 的 Home，也不修改其登录状态。

---

## 51. Migration Strategy

升级数据库后：

```text
只建表，不写任何 Profile 记录
```

不强制用户重新登录，也不替用户猜他有几个 runtime。
升级后的行为与升级前**逐字节一致**——因为没有任何 env 被投射。

首次进入 Settings → Agents → Accounts 时展示一条引导：
「你当前在用 CLI 的默认账号。要挂多个账号，请添加 Profile。」

---

## 52. Backward Compatibility

现有：

```ts
// teskra:agent:start
{ workspaceId, agentType: "codex" }
```

仍应工作。

Resolver：

```text
没有 accountProfileId
      ↓
有 runtime-compatible 的 default profile → 用它
      ↓
没有 default
      ↓
使用 legacy CLI default environment
```

避免一次性破坏所有测试和 Workflow。

**「没有 default」这一支不会因为用户创建了 Profile 而改变行为**——
创建 Profile 不等于设为默认（§37.1）。这是这条兼容承诺的全部要点：
存量调用方的身份只有在用户**显式**改默认时才会变。

---

## 53. Workflow 扩展

现有：

```yaml
type: agent
agent: codex
```

继续有效。

新增：

```yaml
type: agent
agent: codex
accountProfile: codex-work
```

或者：

```yaml
type: agent
profile: codex-high-work
```

推荐 `profile` 优先用于完整 ExecutionProfile。

### 53.1 Workflow 里引用的是 alias，不是 Profile id

`AccountProfile` 只有**机器本地**的 `id`（`acct_codex_work`）和一个
可改、可能重名的 `name`。两者都不能直接写进提交到仓库的 workflow：

```text
同事 clone 了仓库
→ workflow 写着 accountProfile: codex-work
→ 他本地根本没有这个 id / 这个名字
→ 要么解析失败，要么误匹配到别人的账号
```

因此 workflow 里出现的是 **alias**，由每台机器自己绑定：

```yaml
# 仓库里的 workflow —— 只出现 alias
type: agent
agent: codex
accountProfile: work
```

```text
机器本地绑定（Settings，不入仓库）
  agentId=codex  alias="work"  →  accountProfileId=acct_codex_work
```

绑定表见 §8.1.2 的 `profile_aliases`。

**`profile:` 字段同样是 alias，不是 ExecutionProfile 的 id。**
理由完全相同——`codex-high-work` 也是机器本地的。两者共用一张表，
用 `kind` 区分：

```yaml
type: agent
agent: codex
accountProfile: work          # kind = 'account'
```

```yaml
type: agent
profile: high-work            # kind = 'execution'
```

未绑定的 alias 必须**报错并提示用户绑定**，不要回退到默认账号——
回退就是 §37.1 说的串号。

绑定入口在 Settings（§22 的 Accounts 页面加一个 Aliases 区），
IPC 见 §28 的 `teskra:account:alias:*`。绑定关系**不入仓库**。

repo-local workflow 只能引用 alias，这一条与 §55 一致。

**review-panel 节点不携带 alias 字段——这是显式设计，不是静默回退。**
`review-panel` 节点的 schema 只有 `agents`（AgentRegistry id 列表），
没有 `accountProfile` / `profile` / `env`：评审是多人并行、互相隔离的
只读环节，每个 reviewer 始终使用该 agent 的 per-agent 默认账号
（§37 的 selector 规则 3；未设默认则走 legacy 环境，规则 4）。
想让某个 reviewer 用指定账号，就在 Settings 里把那个账号设为该 agent
的默认账号——而不是在 workflow 里逐节点点名。这与 §37.1 同一条原则：
账号切换必须来自用户的显式动作，绝不来自「刚好写了 / 没写某个字段」。
因此 Full Workflow 的仓库覆盖（`<repo>/.teskra/workflows/full.yaml`）
只能约束 implementer / fixer 两个 agent 节点的 alias；即使启动弹窗
显式指定了 implementer 与 reviewers，覆盖里的 alias / env / testCommand
仍然照常合并加载（agent 身份以请求为准），不存在「显式指定就跳过
整个仓库覆盖」的路径。

---

## 54. Workflow Profile Resolve

优先级（与 §14 同一条规则，方向必须一致）：

```text
node.accountProfile          ← 更具体的显式指定优先
    ↓
node.executionProfile 里的 account
    ↓
workflow defaults
    ↓
agent defaults
```

§14 定的是「Run explicit override > ExecutionProfile.account >
Agent default」。原稿这里把 `node.executionProfile` 排在
`node.accountProfile` 前面，两处方向相反——同一个 workflow 节点同时写了
两者时，Runtime 会做出与 §14 相反的选择。

统一规则一句话：**越具体、越显式的账号指定越优先。**
`node.accountProfile` 就是这个节点上最显式的账号指定，
所以它压过 `node.executionProfile` 里顺带带来的 account。

注意这只针对 **account** 这一个维度。ExecutionProfile 的其余字段
（model / reasoning / approvalMode）仍然整体生效——
`node.accountProfile` 只覆盖其中的 account。

DefinitionLoader 只解析 ID / alias（§53.1）。

真正 Resolve 在 Runtime Service。

---

## 55. Repo-local Workflow 安全

禁止 repo workflow 声明：

```text
credentialRef
```

或者直接：

```text
apiKey
OAuth token
```

repo-local workflow 只能引用 **alias**（§53.1）：

```text
accountProfile: work
profile: high-work
```

**不接受 Profile id**——哪怕是「允许的 ID」也不行。id 是机器本地的，
写进仓库既不可移植，又让一份 repo 能够点名另一台机器上的具体账号。
alias 的解析完全由本机绑定表决定，仓库无法影响解析结果。

而且未信任 Workspace 下不能自动使用敏感 AccountProfile。

---

## 56. 测试策略

### Unit

必须覆盖：

```text
AccountProfileManager
AccountProfileRepository
AccountProfileSelector
AgentFailureClassifier
AccountProfileRuntimeResolver
ContinuationBuilder
```

---

### 56.1 Codex Profile

测试：

```text
不同 Profile 生成不同 CODEX_HOME
Profile env 不泄漏到另一个 Profile
Run Snapshot 正确
默认 Profile Resolve 正确
runtime 不兼容的 Profile 被过滤 / 显式指定时报错
```

WSL 这条不能只写「env 传递正确」，要逐条对应 §5.3 / §10.1：

```text
1. 入库的 configHome 是 runtime-native 绝对路径
   （WSL Profile 存 /home/... 而不是 C:\... 或 ~/...）
2. 含 ~ / 环境变量 / 相对路径的 configHome 在写入时被拒绝
3. 投射时 configHome 原样进入 env，未被 resolveRuntimePath 改写
4. CODEX_HOME 出现在 WSLENV 声明里，且不带 /p 标志
```

只断言「env 里有 CODEX_HOME」会漏掉 2–4——
而漏掉它们的表现是静默退回默认账号，没有任何报错。

---

### 56.2 Claude Profile

测试：

```text
不同 Profile 生成不同 CLAUDE_CONFIG_DIR
WSL env 传递正确
Profile status detect
legacy fallback（无 Profile，不投射 config dir）
```

---

### 56.3 Rate Limit

使用 Fake Agent：

```text
fake-codex-rate-limit
fake-claude-rate-limit
```

不要 CI 消耗真实额度。

验证：

```text
Run   → failed + failureClassification.kind = "rate-limited"
        （不新增 Run status，§17.2）
        resetAt 已解析并落库
Profile → limited + limitedUntil
Continuation suggestion 出现
重启进程后仍能从库里读回上述两者
```

另加一组**负例**（§17.0）：

```text
Agent 输出里出现 "quota exceeded" 但进程仍在正常运行
  → Run 不被终止
  → Profile 状态不变
  → 至多出现弱信号提示
```

---

### 56.4 Continuation

场景：

```text
Run A
↓
rate limited
↓
Continue with B
```

验证：

```text
新 Run ID
同 Task
同 Worktree
不同 accountProfileId
Handoff 被带入
历史 Run 保留
```

---

### 56.5 Recovery

场景：

```text
Run A / Codex Work
App crash
默认 Profile 改成 Personal
App restart
```

恢复必须仍然：

```text
Codex Work
```

---

## 57. E2E

Playwright Electron E2E：

```text
Add fake account profile
Set default
Start Fake Agent
Simulate limit
Continue with another profile
Verify Run history
Verify worktree reused
```

---

## 58. Security Tests

增加：

```text
Profile A secret/config 不注入 Profile B
configHome path traversal blocked（create / update / delete 三条路径都覆盖）
symlink 指向 root 之外时被拒绝
external profile home 不允许删除
renderer 无法读取 credential content
repo workflow 不能传 credentialRef
untrusted workspace 自动执行受限
```

以及 §13.2 的保留 key（这条现在没有任何防线）：

```text
workspace.env 设 CODEX_HOME 被拒绝并记录
request.environment 设 CLAUDE_CONFIG_DIR 被拒绝并记录
workflow node env 设保留 key 被拒绝
即便绕过拒绝，Profile env 仍然最后写入并覆盖
```

最后一条是纵深防御：前三条是策略，第四条是 §13.1 的顺序保证。

---

## 59. 任务拆分

### 59.0 这些任务必须先进权威文档

仓库的文档权威规则（`docs/teskra-tasks.md` 的「文档权威性」一节）是：

```text
docs/teskra-tasks.md  = TASK 编号与验收标准的唯一权威
plan §139.1           = 数据库 Schema 的唯一权威
docs/decisions/       = 已裁决的架构问题
```

因此本文的内容**已经同步进权威文档**，本节记录同步结果：

| 内容 | 落到哪里 | 状态 |
| --- | --- | --- |
| TASK-094～118（含依赖与验收） | `docs/teskra-tasks.md` → Milestone 24 | 已写入 |
| `agent_account_profiles` / `account_events` / `profile_aliases` | plan §139.1 → `012_agent_account_profiles.sql` | 已写入 |
| `agent_runs` 的四个新列 | plan §139.1 → `013_agent_run_account_profile.sql` | 已写入 |
| `agent_execution_profiles` | plan §139.1 → `014_agent_execution_profiles.sql` | 已写入 |
| 「AccountProfile = 完整 CLI Home」（§33.2） | `docs/decisions/0009-account-profile-is-a-full-cli-home.md` | 已裁决 |
| 「限额是失败原因，不是 Run 状态」（§17.2） | `docs/decisions/0010-rate-limit-is-a-failure-reason-not-a-run-status.md` | 已裁决 |
| 「Workflow 引用 alias 而非 id」（§53.1） | `docs/decisions/0011-workflow-references-profile-aliases.md` | 已裁决 |
| Workspace Trust 正式编号 | `docs/teskra-tasks.md` → **TASK-118** | 已分配 |

**本文档从此是设计说明，不是任务与 Schema 的权威。**
两者若出现分歧，以 `teskra-tasks.md` 与 plan §139.1 为准；
本文只解释「为什么这样定」。

下面的任务清单保留在本文，是为了让设计理由与验收标准挨在一起阅读；
排期、勾选与状态一律以 `teskra-tasks.md` 为准。

---

以下任务接现有 `TASK-093`。

每个 Task 带 **优先级**、**依赖**和验收要点。依赖不是装饰——
Phase D 的 105–108 全部强依赖 097 / 100，TASK-118 因 migration 版本
连续性而依赖 110，不写出来排期会排错。

**优先级与依赖是从权威文档抄来的副本。** 权威在
`docs/teskra-tasks.md`（Milestone 24）；本节保留它们只是为了让
「为什么这么定」和「排在哪里」能一起读。

两处曾在多轮修订中漂移过（TASK-100、TASK-117、TASK-118 都出过不一致），
因此加了校验：

```text
npm run check:task-docs
```

它比对两份文档的 Task 集合、优先级与依赖，不一致就退出非零。
**改依赖时先改 `teskra-tasks.md`，再跑这个脚本同步/核对本节。**

关于优先级：原稿把 13 个任务都标成 P0，等于没有优先级。这里按
「不做就不能用」重新划线：

- **P0**：没有它整个功能跑不起来，或会**损坏既有行为**
  （094–100、102、112、114）
- **P1**：产品体验的关键部分，但缺了仍然可用
  （101、103–111、113、115、116、117）

特别地，**112（Profile-aware Recovery）是 P0 且必须与 100 同批做**。
它原本被排在最后的 Phase F，但只要 100 落地而 112 没落地，
第一次 crash recovery 就会用当前默认 Profile 去恢复历史 Run——
即 §66 自己列的「Recovery 不串号」当场破功。

---

### TASK-094 — Account Profile Contracts

**优先级：P0**

**依赖：TASK-003**

实现：

```text
AgentAccountProfile
AccountProfileStatus
AccountAuthType
AgentRuntimeIdentity
Zod schemas
```

验收：

- Main / Renderer 共用 contracts
- 无重复类型
- typecheck 通过
- `configHome` 的 Zod 校验拒绝 `~` 开头、含环境变量引用、非绝对的路径（§5.3）
- `runtime.kind` 第一阶段只接受 `windows` / `wsl`
- `runtime.kind === "wsl"` 时 `distro` 必填——不允许留空去跟随
  以后可能变化的默认 distro

---

### TASK-095 — Account Profile Database Migration

**优先级：P0**

**依赖：TASK-006, TASK-094**

新增 migration `012` 与 `013`（§8）：

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

验收：

- 老数据库自动升级
- 历史 Run 不丢失
- migration 可重复验证
- `migrations.ts` 已注册，且 012 排在 013 之前
- `foreign_key_check` 通过
- `config_home` 部分唯一索引生效（NULL 可重复，非 NULL 不可重复）
- `max_concurrent_runs` 的 `CHECK` 生效
- `profile_aliases` 的 `(agent_id, kind, alias)` 主键生效

---

### TASK-096 — AccountProfileRepository

**优先级：P0**

**依赖：TASK-007, TASK-095**

实现：

```text
list
get
create
update
disable
setStatus
```

验收：

- 单元测试
- 不在 Manager 写 SQL

---

### TASK-097 — AccountProfileManager

**优先级：P0**

**依赖：TASK-022, TASK-078, TASK-096**

实现：

```text
CRUD
default resolve
status
runtime projection
login descriptor
```

验收：

- Manager 不依赖 Renderer
- Typed EventBus
- Adapter 可插拔
- create 拒绝 `authType: "api-key"`（第一阶段不做，§35）——
  在 IPC/Manager 层拒绝，**不能只靠 UI 隐藏入口**
- create 拒绝未注册的 `agentId`
- managed Profile 的 `configHome` 由 Manager 生成，
  update 不接受该字段（§48.1）
- slug 重复时报错并要求改名，**不自动加后缀**；
  slug 入库前 `toLowerCase()`（Windows 路径大小写不敏感）
- 并发创建同 slug 时只有一个成功——先插库再建目录，
  靠 `config_home` 唯一索引挡住，不留孤儿目录
- `maxConcurrentRuns` 只接受 `undefined` 或 `>= 1` 的整数
- `remove` 是 soft disable，不执行 DELETE（§47.1）
- 禁用默认 Profile 时同时清除 `defaultAccountProfileId`（§47.2）
- 有非终态 Run 时拒绝禁用
- `enable` 时 Home 不存在 → 重建并置 `login-required`
- Resolver 遇到 disabled 的默认 Profile 报错，**不回退 legacy**

---

### TASK-098 — Codex Account Profile Adapter

**优先级：P0**

**依赖：TASK-023, TASK-097**

实现：

```text
CODEX_HOME
login command
detect
runtime env
```

验收：

- 两个 Profile 可独立启动
- 不复制认证文件
- Windows / WSL 测试覆盖

---

### TASK-099 — Claude Account Profile Adapter

**优先级：P0**

**依赖：TASK-023, TASK-097**

实现：

```text
CLAUDE_CONFIG_DIR
login command
detect
runtime env
```

验收：

- 两个 Profile 可独立启动
- Windows / WSL 测试覆盖

---

### TASK-100 — AgentManager Profile Integration

**优先级：P0**

**依赖：TASK-098, TASK-099**

实现：

```text
StartAgentRunRequest.accountProfileId
Runtime resolve
Run snapshot
```

> **范围边界**：只接入 `accountProfileId`。`executionProfileId` 的接收与
> 校验归 TASK-110——ExecutionProfile 的 contracts / 表 / Manager 要到
> TASK-109/110 才存在，Phase B 无法校验它。字段与列由 TASK-094/095
> 先行准备，本 Task 不读。

验收：

- legacy start 仍工作
- 显式 Profile 正确
- Profile env 进入 ProcessManager

跨对象约束（每条都要有失败用例，否则错的 Profile id 会一路走到错的
Adapter）：

- `accountProfile.agentId === request.agentType`，否则报错
- 传入 `executionProfileId` 时返回「尚未支持」的结构化错误，
  不静默忽略（TASK-110 之前的临时行为）
- 显式指定的 Profile **不存在 / `enabled === false` / runtime 不兼容**
  时一律报错，不静默降级到默认或 legacy（§37.1）
- 以上每种失败都返回可区分的错误码，不是笼统的 VALIDATION_FAILED

---

### TASK-101 — Default Account Profile

**优先级：P1**

**依赖：TASK-080, TASK-097**

实现：

```text
per-agent default account
```

验收：

- Codex / Claude 分别有默认 Profile
- 默认变更不影响历史 Run

---

### TASK-102 — Account Profile IPC

**优先级：P0**

**依赖：TASK-097, TASK-098, TASK-099**

登录 IPC 是通用账号登录，TASK-104 要求 Codex 与 Claude 都能走完，
因此两个 Adapter 的 `buildLoginCommand()` 都必须就位。

实现：

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

alias 相关的 channel **不在本 Task**——它们和
`ProfileAliasRepository` 一起属于 TASK-111，否则会出现
「Phase C 暴露了 IPC，Phase E 才有仓储」的空实现。

验收：

- 所有请求 Zod 校验
- IPC 返回 `IpcResult<T>`
- `login:start` **立即返回** `AccountLoginSession`，不等 OAuth 完成
- Renderer 只提交 `profileId` / `sessionId`，argv 与 env 全部在 Main 侧生成
- 同一 profileId 重复 `login:start` 返回既有 sessionId，不起第二个进程
- `login:cancel` 停止进程，且 Profile 状态保持登录前的值
- 会话超时后自动清理（Main 侧自管，不依赖 Renderer 发 cancel）
- 应用退出时登录会话随 `disposeAll()` 一起停止，不留孤儿进程

---

### TASK-103 — Account Management UI

**优先级：P1**

**依赖：TASK-093, TASK-102**

页面：

```text
Settings → Agents → Accounts
```

验收：

- List
- Status
- Add
- Login
- Default
- Disable

---

### TASK-104 — Add Account Wizard

**优先级：P1**

**依赖：TASK-103**

实现：

```text
Agent
Name
Runtime
Config Home（只读展示，由 Teskra 生成）
Login
Verify
```

验收：

- Codex
- Claude
- WSL（必须选定具体 distro）
- Windows
- Config Home 为**只读**：managed Profile 不允许用户填写或编辑（§48.1）
- 只提交 slug，路径由 Main 侧生成

---

### TASK-105 — Agent Failure Classification

**优先级：P1**

**依赖：TASK-100**

实现：

```text
AgentFailureClassifier
Codex classifier
Claude classifier
```

验收：

- rate-limit
- auth
- network
- unknown
- Fake Agent tests
- 分类结果写入 `agent_runs.failure_classification_json`，
  Run 状态仍为 `failed`（不新增状态，§17.2）
- `evidence` 已脱敏且截断到 512 字符（§17.3）
- 重启后能从库里读回 `kind` 与 `resetAt`

---

### TASK-106 — Account Status Projection

**优先级：P1**

**依赖：TASK-097, TASK-105**

当 Run 失败：

```text
rate limit → Profile limited
auth → login-required / expired
successful Run → ready
```

验收：

- 状态事件
- persisted
- restart 后保留
- **`limitedUntil <= now` 的恢复有明确触发者**（§18.0）：
  读取状态时惰性降级为 `unknown` 并清空 `limitedUntil`；
  应用启动与 Settings → Accounts 打开时各批量清扫一次
- 降级目标是 `unknown` 而非 `ready`
- 不引入常驻定时器

---

### TASK-107 — Cross-profile Continuation

**优先级：P1**

**依赖：TASK-100, TASK-106**

实现：

```text
ContinueAgentRunRequest
ContinuationBuilder
```

验收：

- 新 Run
- 同 Task
- 同 Worktree
- 新 Profile
- Handoff/Context 继承
- **原子性（§19.3）**：source process 已确认退出、source Run 已落终态，
  之后才创建 target Run
- 新增不变式：同一 worktree 上不允许存在两个非终态 Run
  （现有 `unisolatedWriteConflict()` 对带 worktree 的 Run 直接放行，
  拦不住这种情况）
- source process 超时未退出时，Continuation 整体失败并报错

---

### TASK-108 — Rate Limit Switch UI

**优先级：P1**

**依赖：TASK-103, TASK-107**

实现：

```text
Continue with another account
```

验收：

- 只列 runtime 兼容且当前可用（ready / unknown）的 Profile
- `limitedUntil` 已过期的 Profile **必须重新出现在列表里**
  （经 TASK-106 的惰性降级），不能因为状态还写着 limited 就被永久排除
- 显示同 Agent Profile
- 可选跨 Agent continuation

---

### TASK-109 — Execution Profile Contracts

**优先级：P1**

**依赖：TASK-094**

实现：

```text
AgentExecutionProfile
```

字段（与 §6.1 / §8.2 完全一致，三处必须同形）：

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

**不包含** permission / tools / skills / env 的 Profile ID——
这四类实体在仓库里不存在（§6.1），要加回来见 §6.2。

---

### TASK-110 — ExecutionProfile Repository / Manager

**优先级：P1**

**依赖：TASK-095, TASK-100, TASK-109**

包含 migration `014_agent_execution_profiles.sql`（TASK-095 不含），
以及 **AgentManager 对 `executionProfileId` 的接入**（TASK-100 不含）。

验收：

- migration 014 已注册并可重复验证
- CRUD
- Default
- Resolve（只解析 §6.1 收窄后的字段；不引用 tool / skill / env / permission
  Profile ID——它们没有对应实体）
- Snapshot
- `executionProfile.agentId === request.agentType`，否则报错
- `executionProfile.accountProfileId` 指向的 Profile 其 `agentId` 相同
- 同时传 `accountProfileId` 与 `executionProfileId` 时，account 维度以显式的
  `accountProfileId` 为准（§14），其余字段仍整体取自 ExecutionProfile

---

### TASK-118 — Workspace Trust

**优先级：P0**

**依赖：TASK-009, TASK-110**

本 Task 由本方案 §43 拉起，但它本身是独立的安全能力，关闭的是
code-review 的 P0-3「仓库内容可导致本机任意代码执行」。

它**不阻塞 Phase A～D**，但必须排在 TASK-111 之前——
111 让 repo 里的 workflow 能指定账号，118 是「repo 内容能不能被信任」的
闸门，反过来排等于先开门再装锁。

依赖 TASK-110 的原因是 **migration 版本连续性**，不是功能耦合：
本 Task 注册 015，而 014 属于 TASK-110。`migrate.ts` 以 `MAX(version)`
判断当前版本并跳过所有更小的版本，先应用 015 的开发库会永久跳过 012～014。

闸门要覆盖三条路径，只挡 shell workflow 是不够的：

```text
workspace 层配置的 agents 组一律剥离并告警（与信任级别无关）
Restricted 下不加载 repo-local workflows / prompts / config
repo 定义的 shell 步骤执行前展示完整命令行确认
```

验收要点见 `docs/teskra-tasks.md`。

---

### TASK-111 — Workflow Profile Support

**优先级：P1**

**依赖：TASK-100, TASK-110, TASK-118**

TASK-118 完成之前本 Task 不可开工——§55 的 repo-local workflow
安全语义完全依赖它。

支持 alias 引用（§53.1；仓库里出现的都是 alias，不是 id）：

```yaml
agent: codex
accountProfile: work
```

以及：

```yaml
profile: high-work
```

实现（alias 的**全部**内容都在本 Task，含 IPC；
TASK-102 只做账号本身的 channel）：

```text
ProfileAliasRepository（list / bind / unbind / resolve）
teskra:account:alias:list / bind / unbind
Settings → Agents → Aliases 绑定 UI
DefinitionLoader 只取 alias 字符串，解析在 Runtime Service
```

验收：

- 未绑定的 alias → 报错并提示绑定，**不回退到默认账号**
- 绑定指向的 Profile 已删除 / disabled → 同样报错
- `accountProfile` 与 `profile` 两种 alias 各自解析正确（`kind` 区分）
- repo 里写 Profile id 被拒绝（§55）
- 同名 alias 在不同 agentId 下互不干扰
- 同名 alias 在不同 `kind` 下互不干扰（`work` 可同时是两种）
- bind 校验 profileId 存在于 kind 对应的表，且 `profile.agentId` 相符

---

### TASK-112 — Profile-aware Recovery

**优先级：P0**

**依赖：TASK-042, TASK-100**

验收：

```text
Recovery 使用历史 Runtime Identity
不使用当前默认账号
```

---

### TASK-113 — External / Legacy Profile Migration

**优先级：P1**

**依赖：TASK-098, TASK-099, TASK-101**

**不创建任何 virtual default Profile**（§50）。本 Task 只负责：

```text
升级后行为与升级前逐字节一致（不投射任何 config dir 环境变量）
Settings → Accounts 首次展示引导文案
External Profile 的导入路径（用户显式动作，按具体 runtime 逐个创建）
```

无需重新登录。

---

### TASK-114 — Account Profile Security Tests

**优先级：P0**

**依赖：TASK-098, TASK-099, TASK-100, TASK-118**

其中「untrusted workspace 自动执行受限」一条在 TASK-118 完成前
**无法验收**；其余安全测试不受影响，可以先做。

覆盖：

```text
path ownership
secret isolation
external path delete guard
renderer isolation
WSL env isolation
```

---

### TASK-115 — Account Profile E2E

**优先级：P1**

**依赖：TASK-107, TASK-108**

Fake Agent：

```text
A Ready
A Limited
B Ready
A → B Continue
```

---

### TASK-116 — Account Event Repository

**优先级：P1**

**依赖：TASK-095**

§41 的审计事件写进 `account_events`，需要对应的仓储与查询——
原稿只定义了事件名，没有任何任务负责写入和读取。

实现：

```text
AccountEventRepository（append / listByProfile / listByType）
AccountProfileManager 与 AgentManager 的事件写入点
```

验收：

- 不在 Manager 里写 SQL
- 账号生命周期事件（created / login_* / status_changed）不依赖 Run 存在
- `agent.account_switched` 能关联 source / target Run
- 单元测试

---

### TASK-117 — Per-profile 并发限制

**优先级：P1**

**依赖：TASK-084, TASK-100**

§46.3 的三步落地。没有它，§65 场景 H 无法验收——
字段存在但没有任何代码读它。

实现：

```text
hasCapacity() 的 candidate 增加 accountProfileId
按 profile.maxConcurrentRuns 计数并限流
超限进入既有 queued 路径
```

验收：

- managed profile 默认 `maxConcurrentRuns = 1` 时，第二个 Run 排队
- legacy fallback（没有 `accountProfileId`、也没有 Profile 记录）
  不受 per-profile 限制，仅受 `maxRunsPerAgent` 约束
- 不新造等待机制，复用既有排队调度
- `0` 与负数在 Zod 与 SQL `CHECK` 两层都被拒绝
  （写进去会让该 Profile 的 Run 永久排队）

---

## 60. 推荐实施顺序

### Phase A — Domain

```text
094
095
096
097
```

完成：

```text
Account Profile 成为正式领域对象
```

---

### Phase B — CLI Isolation

```text
098
099
100
112   ← 从 Phase F 提前
117   ← per-profile 并发，紧跟 100
101
```

完成：

```text
同一个 Codex / Claude
可以使用多个独立 CLI Profile
```

这是第一阶段最重要的里程碑。

112 必须跟在 100 后面立刻做：100 一旦让 Run 带上 Profile 身份，
Recovery 就必须同步改为读历史 `profileSnapshot`，否则中间这段时间里
每一次 crash recovery 都会串号。

---

### Phase C — UI

```text
102
103
104
```

完成：

```text
用户可以通过 GUI
创建 / 登录 / 管理多个账号
```

---

### Phase D — Limit Handling

```text
105
106
107
108
116   ← 审计事件仓储
```

完成：

```text
账号额度不足
→ Teskra 识别
→ 用户一键用另一个 Profile 继续
```

这就是本需求的核心产品闭环。

---

### Phase E — Execution Profiles

```text
109
110
118   ← Workspace Trust，必须排在 111 之前
111
```

顺序是 **110 → 118 → 111**：TASK-111 让 repo 里的 workflow 能指定账号，
而 TASK-118 是「repo 内容能不能被信任」的闸门。反过来排等于先开门再装锁。

TASK-118 不阻塞 Phase A～D。

完成：

```text
Account + Model + Reasoning + ApprovalMode
统一成为可复用 Profile
```

Tools / Skills / MCP **不在本阶段**——对应实体不存在（§6.1），
要做需要先有 §33.2 说的配置 overlay 机制，独立立项。

---

### Phase F — Production Hardening

```text
113
114
115
```

完成：

```text
Migration
Security
E2E
```

（Recovery / 112 已在 Phase B 完成。）

---

## 61. 与 Delegation 的最终组合

Account Profile 完成后，再做：

```text
DelegationService
```

未来：

```text
User
  ↓
Codex Lead / Personal
  │
  ├─ delegate
  ▼
Codex Worker / Work
  │
  └─ delegate
     ▼
Claude Reviewer / Personal
```

每一个 AgentRun 都明确：

```text
Agent
Account
Execution Profile
Worktree
Parent Run
```

这样真正形成：

```text
Agent Team
```

而不是一堆匿名 Terminal。

---

## 62. 与 CC Switch 的借鉴关系

建议借鉴：

```text
Provider/Profile 抽象
多账号 UI
统一 Registry
不同 CLI 的 Config Adapter
Session Adapter
SQLite SSOT
Status / Health 模型
```

不要直接照搬：

```text
OAuth Reverse Proxy
私有 OAuth API
完整配置文件 Snapshot 覆盖
Local LLM Gateway
个人订阅静默 Round Robin
```

---

## 63. Teskra 的产品边界

CC Switch 更像：

```text
Agent Environment Control Plane
```

Teskra 更应该是：

```text
Coding Work Control Plane
```

因此 Account Profile 功能的定位应该是：

```text
Teskra 为 Agent Runtime
提供可选择的执行身份
```

而不是让 Teskra 变成：

```text
OAuth / LLM Gateway 产品
```

---

## 64. 最终目标架构

```text
┌─────────────────────────────────────────────┐
│                 Teskra UI                   │
│                                             │
│ Task / Agent / Account / Review / Recovery  │
└────────────────────┬────────────────────────┘
                     │
                 Typed IPC
                     │
┌────────────────────▼────────────────────────┐
│              Orchestration                  │
│                                             │
│ WorkflowEngine                              │
│ DelegationService (future)                  │
│ ContinuationService                         │
└────────────────────┬────────────────────────┘
                     │
┌────────────────────▼────────────────────────┐
│               Agent Runtime                 │
│                                             │
│ AgentManager                                │
│ AccountProfileManager                       │
│ ExecutionProfileManager                     │
│ ProcessManager                              │
│ WorktreeManager                             │
│ Recovery                                    │
└────────────────────┬────────────────────────┘
                     │
          Coding Agent Adapter
          /                 \
       Codex               Claude
         │                    │
   Account Adapter       Account Adapter
         │                    │
    CODEX_HOME        CLAUDE_CONFIG_DIR
         │                    │
   Official Auth        Official Auth
```

---

## 65. 最终验收场景

整个功能完成后，必须通过以下真实用户流程。

### 场景 A

```text
Add Codex Personal
→ Login
→ Start Task
→ Success
```

---

### 场景 B

```text
Add Codex Personal
Add Codex Work

同时启动：
TASK-A → Personal
TASK-B → Work

两个 Run 相互独立
```

---

### 场景 C

```text
TASK-A
→ Codex Personal
→ usage limit reached
→ Profile 变为 Limited
→ UI 提示
→ Continue with Codex Work
→ 新 AgentRun
→ 同 Worktree
→ Context/Handoff 保留
→ Task 继续
```

---

### 场景 D

```text
Codex Work Run
→ Teskra crash
→ restart
→ Recovery
→ 仍然使用 Codex Work
```

---

### 场景 E

```text
默认 Profile:
Personal → Work

历史 Run:
仍显示 Personal
```

---

### 场景 F

```text
Workflow:

Implement:
  Codex Personal

Review:
  Claude Work

Fix:
  Codex Work
```

三者均正确执行并可审计。

---

### 场景 G — Profile 被禁用 / 删除后的历史 Run

```text
Codex Personal 跑完若干 Run
→ 用户 Remove Profile（实际 enabled = false）
→ 历史 Run 仍显示 "Codex Personal"（来自 profileSnapshot）
→ 对该 Run 的 resume 被明确拒绝，并提示改用 Continuation
→ 新建 Run 的账号下拉里不再出现该 Profile
```

注意第一阶段**没有硬删除**（§47.1）：`Remove Profile` 一律是
`enabled = false`，所以这条场景验的就是 soft disable 后的行为。

`agent_runs.account_profile_id` 无 FK（§8.3）、snapshot 仍在——
这是为将来真有硬删除时留的余量，不是本期要验的路径。

---

### 场景 H — 同一 Profile 的并发

```text
同一个 Codex Work Profile
→ 同时发起 TASK-A 与 TASK-B
```

预期（见 §46.2）：

```text
managed profile（有独立 configHome）
  → 第二个 Run 排队等待，不并发写同一个 CODEX_HOME

legacy fallback（无 Profile）
  → 行为与今天一致，受 maxRunsPerAgent 约束
```

这条场景是 §45「同 Agent 多实例」的反面，必须一起验收——
否则很容易把「不同 Profile 可并行」误读成「同一 Profile 也可并行」。

---

## 66. 完成定义

本功能不能以「UI 能保存两个账号」作为完成。

真正完成标准是：

```text
多个 Profile
    ↓
真正独立 Runtime
    ↓
真正独立认证环境
    ↓
AgentRun 记录身份
    ↓
Rate Limit 可识别
    ↓
可安全 Continuation
    ↓
Recovery 不串号
    ↓
Workflow 可指定 Profile
```

达到这个程度后，Teskra 才真正具备：

> **Multi-Agent + Multi-Account + Multi-Subscription Runtime**

并为后续：

```text
Lead Agent
    ↓
Delegation
    ↓
不同 Agent / 不同账号 Worker
```

提供稳定基础。

---

## 67. 参考实现来源与约束

本方案基于 Teskra 当前架构：

- `Electron Main → Teskra Runtime`
- `AgentManager`
- `ProcessManager`
- `CodingAgentAdapter`
- `WorktreeManager`
- `WorkflowEngine`
- `Typed IPC`
- `SQLite`
- `Handoff`
- `Crash Recovery`

并参考 CC Switch 的：

- 多 Provider / 多 Profile 管理思路
- Canonical Model → CLI-specific Adapter
- SQLite SSOT
- MCP / Session Adapter 思路
- 状态与配置投射机制

实现时始终遵守：

```text
官方 CLI 负责 Authentication
Teskra 负责 Runtime Identity / Orchestration
```

这是本功能最重要的架构边界。
