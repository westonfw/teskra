# Teskra — Multi-Agent Coding Workbench 详细实现方案 V2

> **V2 更新时间：2026-09-09**
>
> 本版在 V1 基础上加入 GitHub 现有项目的架构借鉴与许可证边界，并根据实际开源实现补强：
>
> - Agent Registry / Provider 抽象
> - Windows + WSL2 + Electron/PTTY 的实际工程方案
> - Runtime State Reconciliation
> - Git Worktree 生命周期与故障恢复
> - Acceptance Criteria 驱动的 Implement → Review → Fix 循环
> - Reviewer 隔离与最小权限
> - Worker → Orchestrator 结构化 Handoff
> - 多 Agent 并行 Review Panel
> - Worktree / Run 垃圾回收
> - Crash / Restart 后的 Doctor & Resume
> - 开源许可证与“可以借鉴什么、不要直接复制什么”

## Teskra 命名约定

本项目正式名称为 **Teskra**。

```text
产品名：Teskra
仓库名：teskra
CLI：teskra
全局数据目录：~/.teskra/
项目级配置目录：.teskra/
全局配置：~/.teskra/config.json
工作区配置：<repo>/.teskra/config.json
Workflow 定义：<repo>/.teskra/workflows/*.yaml
本地数据库：~/.teskra/db/teskra.sqlite
```

> 配置分两层（§151），不是单个文件。格式按「谁写这个文件」决定：
> `config.json` 会被 Settings UI 回写，用 JSON；
> Workflow 定义纯手写、UI 不回写，用 YAML（§153）。

推荐对外描述：

> **Teskra — Multi-Agent Coding Workbench**

推荐一句话定位：

> **Orchestrate your coding agents.**

Teskra 的核心定位不是传统 IDE，而是 **Windows-first、Task-first、Agent-first 的多 Agent Coding Workbench**，用于统一调度 Codex、Claude Code 等 Coding Agent，并提供 Workspace、PTY、Git Worktree、Review、Recovery 与 Workflow 能力。

---

## 0. 阅读须知与勘误（2026-09-09 Review 后追加）

> **本文档是在 V1 方案上追加 V2 章节写成的。§1–§113 属于 V1，§114–§164 属于 V2。**
> **凡两者冲突，一律以 V2 为准**（见 `docs/decisions/0001-v2-supersedes-v1-definitions.md`）。

已被取代的 V1 章节，原文保留但**不得作为实现依据**，均已就地加 `[SUPERSEDED]` 标注：

| V1 章节 | 内容 | 生效版本 |
|---|---|---|
| §7.1 | Workspace 环境 enum | §116.1 `WorkspaceRuntimeRef` |
| §27 | Artifact type 列表 | 已就地修订，与 TASK-050 对齐 |
| §28 | Task 状态机 | §138 |
| §32 / §33 | 扁平 `WorkflowStep` | §116.3 / §153 `WorkflowNode` |
| §36 / §39 | Worktree 目录与命名 | ADR-0003 |
| §41–§44 | Permission 执行前拦截 | ADR-0002（改为策略下发 + 审计） |
| §45 | `.workspace-ai/` 目录 | §152 `.teskra/` |
| §88 / §89 / §90 | 早期任务编号草稿 | `teskra-tasks.md` |

**唯一的 TASK 编号权威是 `docs/teskra-tasks.md`。**
§88/§89/§90 中的编号是早期草稿，与 `teskra-tasks.md` 撞号但含义不同，已改写为不带 `TASK-` 前缀。

### 已知的架构约束（Review 结论）

1. **Permission 无法做执行前拦截。** Teskra 是 PTY 宿主，不是 Agent 的系统调用网关。
   见 ADR-0002。
2. **Handoff 走文件契约，不解析 stdout。** 见 ADR-0004。
3. **数据根目录统一为 `~/.teskra/`**，不使用 `app.getPath("userData")`。见 ADR-0003。
4. **`better-sqlite3` 与 `node-pty` 同为 native module**，两者都需要按 Electron ABI rebuild。
5. **`sandbox: true` 下 preload 不能 `require` 任意 Node 模块**，
   contracts / zod 若在 preload 使用必须打进 preload bundle。
6. **`wsl.exe --cd` 需要 WSL 0.51+（Windows 10 build 21354+）**，
   低版本需回退为 `wsl.exe -d <distro> bash -lc 'cd <path> && exec bash'`。
7. **AgentDeck 为 Elastic-2.0**，禁止复制其源码，只做行为参考（见 §115、DoD）。

---

> 目标：实现一个 Windows 桌面端 AI Coding Workbench，在同一 GUI 内统一管理 Codex、Claude Code 等 CLI Agent，支持 Windows / WSL 工作区、Terminal、Git、Diff、Task、Multi-Agent 协作、权限控制和长期记忆。
>
> 推荐技术栈：Electron + React + TypeScript + Vite + Ant Design + Zustand + node-pty + SQLite + simple-git

---

## 1. 项目目标

本项目不是单纯做一个“Codex/Claude Code 的 GUI 外壳”，而是构建一个统一的 AI Coding 工作台。

第一阶段解决：

- 在同一个桌面客户端中打开项目。
- 同时运行多个 Coding Agent。
- 支持 Codex CLI、Claude Code CLI。
- 支持 Windows、PowerShell、WSL。
- 支持独立 Terminal。
- 保持各 Agent Session。
- 统一显示 Agent 输出、状态、命令、文件修改和 Git Diff。

第二阶段进一步解决：

- Task 驱动，而不是单纯 Chat 驱动。
- 一个 Task 可以分配给多个 Agent。
- 多 Agent 并行执行。
- 通过 Git Worktree 隔离工作目录。
- Agent 之间通过结构化 Artifact 协作。
- 支持 Implement → Review → Fix → Test 工作流。
- 支持权限审批。
- 支持 Workspace Memory。

最终形态：

```text
用户
 │
 ▼
Task
 │
 ▼
Orchestrator
 │
 ├───────────────┬────────────────┐
 ▼               ▼                ▼
Codex          Claude          Other Agent
Implement      Review          Test / Research
 │               │                │
 └───────────────┴────────────────┘
                 │
                 ▼
             Artifacts
                 │
                 ▼
         Review / Merge / Result
```

---

# 2. 非目标

第一版不要做以下内容：

- 不做完整 IDE。
- 不实现自己的代码编辑器。
- 不实现完整 Git GUI。
- 不自行实现 LLM 推理协议。
- 不替代 Codex / Claude Code 自带的 Tool Calling。
- 不一开始接 Milvus。
- 不一开始做云同步。
- 不一开始做团队协作。
- 不一开始实现复杂 Agent-to-Agent 自由对话。

核心原则：

> 第一版重点做 Agent Runtime、Session、Task、Workspace、PTY、Git Worktree 和统一事件模型。

---

# 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                     Electron Renderer                       │
│                                                             │
│ React + TypeScript + Ant Design + Zustand                   │
│                                                             │
│ ┌───────────┐ ┌──────────┐ ┌────────────┐ ┌─────────────┐ │
│ │ Workspace │ │ Task     │ │ Agent Runs │ │ Diff / Git  │ │
│ └───────────┘ └──────────┘ └────────────┘ └─────────────┘ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ xterm.js Terminal                                       │ │
│ └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │
                         IPC / preload
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                     Electron Main                           │
│                                                             │
│ WorkspaceManager                                            │
│ TaskManager                                                 │
│ AgentManager                                                │
│ ProcessManager                                              │
│ TerminalManager                                             │
│ GitManager                                                  │
│ WorktreeManager                                             │
│ PermissionManager                                           │
│ MemoryManager                                               │
│ EventBus                                                    │
│ Database                                                    │
└──────────────┬────────────────────┬─────────────────────────┘
               │                    │
        ┌──────▼──────┐      ┌──────▼────────┐
        │ node-pty    │      │ SQLite        │
        └──────┬──────┘      └───────────────┘
               │
   ┌───────────┼───────────────┐
   ▼           ▼               ▼
 Codex       Claude          Shell
 CLI         Code CLI        PowerShell / WSL
```

---

# 4. 技术选型

## 4.1 桌面框架

采用：

```text
Electron
```

原因：

- Windows 支持成熟。
- Node.js 进程管理方便。
- node-pty 生态成熟。
- React UI 直接复用。
- 文件系统、Git、Shell、WSL 集成简单。
- 后续支持 macOS / Linux 成本较低。

第一版不建议：

```text
Tauri
```

主要原因不是 Tauri 不好，而是本项目重度依赖：

- PTY
- CLI
- 进程管理
- Shell
- WSL
- Node 工具链

Electron + Node.js 的工程成本明显更低。

---

# 5. 推荐技术栈

```text
Desktop:
Electron

Frontend:
React
TypeScript
Vite
Ant Design
Zustand

Terminal:
xterm.js
node-pty

Backend runtime:
Electron Main
Node.js
TypeScript

Database:
SQLite
better-sqlite3

Git:
simple-git
必要时直接调用 git CLI

Validation:
zod

Logging:
pino

IPC:
Electron contextBridge + ipcMain/ipcRenderer

Testing:
Vitest
Playwright
```

建议包：

```json
{
  "dependencies": {
    "@ant-design/icons": "...",
    "@xterm/xterm": "...",
    "@xterm/addon-fit": "...",
    "antd": "...",
    "better-sqlite3": "...",
    "electron": "...",
    "node-pty": "...",
    "pino": "...",
    "react": "...",
    "react-dom": "...",
    "simple-git": "...",
    "uuid": "...",
    "zod": "...",
    "zustand": "..."
  }
}
```

---

# 6. 项目目录结构

推荐 Monorepo，但第一版不需要 Nx/Turborepo。

```text
teskra/
├─ apps/
│  └─ desktop/
│     ├─ src/
│     │  ├─ main/
│     │  │  ├─ index.ts
│     │  │  ├─ bootstrap.ts
│     │  │  │
│     │  │  ├─ agents/
│     │  │  │  ├─ AgentManager.ts
│     │  │  │  ├─ types.ts
│     │  │  │  ├─ adapters/
│     │  │  │  │  ├─ CodexAdapter.ts
│     │  │  │  │  ├─ ClaudeAdapter.ts
│     │  │  │  │  └─ BaseCliAgent.ts
│     │  │  │  └─ parsers/
│     │  │  │
│     │  │  ├─ process/
│     │  │  │  ├─ ProcessManager.ts
│     │  │  │  ├─ PtyProcess.ts
│     │  │  │  └─ ShellResolver.ts
│     │  │  │
│     │  │  ├─ terminal/
│     │  │  │  └─ TerminalManager.ts
│     │  │  │
│     │  │  ├─ workspace/
│     │  │  │  ├─ WorkspaceManager.ts
│     │  │  │  ├─ WorkspaceResolver.ts
│     │  │  │  └─ WslResolver.ts
│     │  │  │
│     │  │  ├─ git/
│     │  │  │  ├─ GitManager.ts
│     │  │  │  ├─ WorktreeManager.ts
│     │  │  │  └─ DiffService.ts
│     │  │  │
│     │  │  ├─ tasks/
│     │  │  │  ├─ TaskManager.ts
│     │  │  │  ├─ Orchestrator.ts
│     │  │  │  └─ WorkflowEngine.ts
│     │  │  │
│     │  │  ├─ permissions/
│     │  │  │  ├─ PermissionManager.ts
│     │  │  │  └─ CommandClassifier.ts
│     │  │  │
│     │  │  ├─ memory/
│     │  │  │  ├─ MemoryManager.ts
│     │  │  │  └─ ContextBuilder.ts
│     │  │  │
│     │  │  ├─ db/
│     │  │  │  ├─ Database.ts
│     │  │  │  ├─ migrations/
│     │  │  │  └─ repositories/
│     │  │  │
│     │  │  ├─ ipc/
│     │  │  │  ├─ registerIpc.ts
│     │  │  │  ├─ workspaceIpc.ts
│     │  │  │  ├─ agentIpc.ts
│     │  │  │  ├─ terminalIpc.ts
│     │  │  │  ├─ taskIpc.ts
│     │  │  │  └─ gitIpc.ts
│     │  │  │
│     │  │  ├─ events/
│     │  │  │  ├─ EventBus.ts
│     │  │  │  └─ events.ts
│     │  │  │
│     │  │  └─ security/
│     │  │
│     │  ├─ preload/
│     │  │  └─ index.ts
│     │  │
│     │  └─ renderer/
│     │     ├─ App.tsx
│     │     ├─ pages/
│     │     ├─ components/
│     │     ├─ stores/
│     │     ├─ hooks/
│     │     ├─ services/
│     │     └─ types/
│     │
│     └─ package.json
│
├─ packages/
│  ├─ contracts/
│  └─ shared/
│
├─ docs/
│  ├─ architecture.md
│  ├─ agent-protocol.md
│  ├─ ipc.md
│  └─ security.md
│
└─ package.json
```

---

# 7. 核心领域模型

## 7.1 Workspace

> **[SUPERSEDED]** 本节的 `WorkspaceEnvironment` 扁平 enum 已被 **§116.1 的 `WorkspaceRuntimeRef`** 取代。
> 下方代码保留作为演进记录，实现请以 §116.1 为准。
> 注意：数据库 `workspaces` 表仍使用扁平列（`environment` / `wsl_distro` / `host` / `container_id`），
> 由 Repository 层映射成 `WorkspaceRuntimeRef`，见 §23。

Workspace 不能只保存 path。

```ts
// [SUPERSEDED] 见 §116.1 RuntimeKind / WorkspaceRuntimeRef
export type WorkspaceEnvironment =
  | "windows"
  | "wsl"
  | "ssh";

export interface Workspace {
  id: string;
  name: string;

  environment: WorkspaceEnvironment;

  path: string;

  wslDistro?: string;

  gitRoot?: string;

  createdAt: string;
  updatedAt: string;
}
```

示例：

```json
{
  "id": "ws_cargorate",
  "name": "CargoRate",
  "environment": "wsl",
  "path": "/home/weston/projects/cargorate",
  "wslDistro": "Ubuntu-22.04"
}
```

---

# 8. Windows / WSL 运行模型

ShellResolver：

```ts
interface ShellExecutionContext {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}
```

Windows：

```text
powershell.exe
```

WSL：

```text
wsl.exe -d Ubuntu-22.04 --cd /home/user/project bash
```

不要：

```text
Windows path
→ 自动字符串替换
→ /mnt/c
```

应该统一交给 WorkspaceResolver。

接口：

```ts
interface WorkspaceRuntime {
  resolveCommand(
    command: string,
    args: string[]
  ): ShellExecutionContext;
}
```

实现：

```text
WindowsRuntime
WslRuntime
Future:
SshRuntime
DockerRuntime
```

---

# 9. ProcessManager

所有 CLI 进程必须统一由 ProcessManager 管理。

不要在各 Adapter 内直接：

```ts
pty.spawn(...)
```

正确：

```text
CodexAdapter
     │
     ▼
ProcessManager
     │
     ▼
node-pty
```

接口：

```ts
interface ProcessStartRequest {
  id: string;

  command: string;
  args: string[];

  cwd: string;

  env?: Record<string, string>;

  cols?: number;
  rows?: number;

  workspaceId?: string;
  agentRunId?: string;
}
```

返回：

```ts
interface ManagedProcess {
  id: string;
  pid: number;

  write(data: string): void;

  resize(cols: number, rows: number): void;

  kill(signal?: string): void;
}
```

ProcessManager 负责：

- 创建。
- stdin 写入。
- stdout 捕获。
- resize。
- kill。
- crash recovery。
- process registry。
- PID 记录。
- exit event。

---

# 10. node-pty

Agent CLI 和 Terminal 都统一使用 node-pty。

示例：

```ts
import * as pty from "node-pty";

const shell = pty.spawn(
  "powershell.exe",
  [],
  {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: "C:\\projects\\demo",
    env: process.env
  }
);

shell.onData(data => {
  eventBus.emit("process.output", {
    processId,
    data
  });
});
```

WSL：

```ts
pty.spawn(
  "wsl.exe",
  [
    "-d",
    "Ubuntu-22.04",
    "--cd",
    "/home/user/project",
    "bash"
  ],
  options
);
```

---

# 11. TerminalManager

Terminal 与 Agent Run 必须分开。

```text
TerminalSession
≠
AgentRun
```

TerminalSession：

```ts
interface TerminalSession {
  id: string;

  workspaceId: string;

  shell:
    | "powershell"
    | "cmd"
    | "wsl"
    | "bash";

  processId: string;

  title: string;

  createdAt: string;
}
```

这样 UI 中：

```text
Terminal
├─ PowerShell
├─ WSL
├─ dotnet
└─ Docker
```

Agent 进程则是另一套 Session。

---

# 12. Agent Adapter

这是系统最重要的抽象之一。

统一接口：

```ts
export interface CodingAgentAdapter {
  readonly type: string;
  readonly displayName: string;

  detect(): Promise<AgentDetectionResult>;

  start(
    request: AgentStartRequest
  ): Promise<AgentProcessHandle>;

  send(
    runId: string,
    input: AgentInput
  ): Promise<void>;

  cancel(
    runId: string
  ): Promise<void>;

  resume?(
    request: AgentResumeRequest
  ): Promise<AgentProcessHandle>;
}
```

---

# 13. AgentStartRequest

```ts
interface AgentStartRequest {
  runId: string;

  workspace: Workspace;

  task?: Task;

  prompt?: string;

  model?: string;

  mode?:
    | "interactive"
    | "exec";

  approvalMode?:
    | "read-only"
    | "manual"
    | "safe-auto"
    | "full-auto";

  worktreePath?: string;

  // 见 ADR-0004：Handoff / Artifact 走文件契约
  handoffPath?: string;
  artifactDir?: string;

  environment?: Record<string, string>;
}
```

`approvalMode` 说明：

```text
read-only    Reviewer 默认值，配合 §126 的环境级隔离使用
manual       每个写操作都要 Agent CLI 自己弹审批（若 CLI 支持）
safe-auto    workspace 内自动，网络/系统操作需审批
full-auto    仅在 disposable worktree 内允许
```

> 注意：`approvalMode` 是**下发给 Agent CLI 的策略**，不是 Teskra 的执行拦截点。
> 见 `docs/decisions/0002-permission-system-policy-and-audit.md`。

---

# 14. CodexAdapter

不要让 UI 知道 Codex CLI 参数。

UI：

```ts
// 全局对象名统一为 window.teskra（见 §20）
// 参数名统一为 agentType（见 §21）
window.teskra.agent.start({
  workspaceId,
  agentType: "codex",
  taskId
});
```

CodexAdapter 内部才知道：

```text
codex
codex exec
codex resume
...
```

示例：

```ts
export class CodexAdapter implements CodingAgentAdapter {
  readonly type = "codex";
  readonly displayName = "Codex";

  constructor(
    private processManager: ProcessManager
  ) {}

  async detect() {
    // codex --version
  }

  async start(req: AgentStartRequest) {
    const command = "codex";

    const args = this.buildArgs(req);

    return this.processManager.start({
      id: req.runId,
      command,
      args,
      cwd: req.worktreePath ?? req.workspace.path
    });
  }

  private buildArgs(req: AgentStartRequest) {
    const args: string[] = [];

    if (req.mode === "exec" && req.prompt) {
      args.push("exec", req.prompt);
    }

    return args;
  }
}
```

---

# 15. ClaudeAdapter

同样：

```ts
export class ClaudeAdapter
  implements CodingAgentAdapter {

  readonly type = "claude";
  readonly displayName = "Claude Code";

  ...
}
```

以后：

```text
GeminiCliAdapter
OpenCodeAdapter
AiderAdapter
CustomShellAgentAdapter
```

都不用修改 Task 和 UI。

---

# 16. AgentManager

AgentManager 不负责具体 CLI 参数。

它负责：

```text
Agent Registry
Agent Run Lifecycle
Session Mapping
State Management
Event Translation
```

接口：

```ts
interface AgentManager {
  startAgent(
    request: StartAgentCommand
  ): Promise<AgentRun>;

  stopAgent(
    runId: string
  ): Promise<void>;

  sendInput(
    runId: string,
    input: string
  ): Promise<void>;

  getRun(
    runId: string
  ): AgentRun | undefined;
}
```

---

# 17. Agent Run 状态机

状态：

```text
Created
  ↓
Queued
  ↓
Preparing
  ↓
Running
  ├── WaitingForUser
  ├── WaitingForPermission
  ├── WaitingForAgent
  ↓
Reviewing
  ↓
Completed

异常:
Failed
Cancelled
```

类型：

```ts
type AgentRunStatus =
  | "created"
  | "queued"
  | "preparing"
  | "running"
  | "waiting_for_user"
  | "waiting_for_permission"
  | "waiting_for_agent"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
```

`interrupted` 是 **reconciliation 专用的终态之一**：
DB 记录为 `running` 但进程实际已消失时由 ReconciliationService 写入（§127、§71）。
它与 `failed` 的区别是——`interrupted` 可以 Resume（§130），`failed` 不能。

---

# 18. Event Bus

系统内部不要直接互相引用 UI。

使用 EventBus。

事件：

```text
workspace.opened

terminal.created
terminal.output
terminal.closed

agent.created
agent.started
agent.output
agent.command
agent.waiting
agent.completed
agent.failed

task.created
task.updated

git.changed
git.diff.updated

permission.requested
permission.resolved
```

TypeScript：

```ts
export interface WorkbenchEvents {
  "agent.started": {
    runId: string;
  };

  "agent.output": {
    runId: string;
    data: string;
  };

  "agent.completed": {
    runId: string;
    exitCode: number;
  };
}
```

---

# 19. Renderer Event Bridge

Electron Main：

```text
EventBus
   ↓
webContents.send
   ↓
preload
   ↓
Renderer
   ↓
Zustand Store
```

Renderer 不直接关心 Main 内部对象。

---

# 20. IPC 设计

不要暴露：

```ts
ipcRenderer
```

给 Renderer。

使用 preload。

**全局对象名统一为 `teskra`**，命名空间为单数形式，与 §158 的 RuntimeFacade 对齐：

```ts
contextBridge.exposeInMainWorld(
  "teskra",
  {
    workspace: {...},
    terminal: {...},
    agent: {...},
    task: {...},
    git: {...},
    runtime: {...}
  }
);
```

Renderer：

```ts
await window.teskra.agent.start({
  workspaceId: "ws_cargorate",
  agentType: "codex",
  taskId: "task-1001"
});
```

> `sandbox: true` 时 preload 无法 `require` 任意 Node 模块，
> 因此 preload 用到的 contracts / zod 必须打进 preload bundle（见 §0 勘误第 5 条）。

---

# 21. IPC Contract

所有 IPC 请求必须：

```text
shared contract
+
zod validate
```

示例：

```ts
const StartAgentSchema = z.object({
  workspaceId: z.string().min(1),

  // 不要硬编码 z.enum(["codex","claude"])。
  // Agent 列表来自 AgentRegistry（§116.2），
  // 否则 TASK-022「加第三个 Agent 不改核心逻辑」无法满足，
  // 且 E2E 用的 Fake Agent 会被 schema 拒绝。
  agentType: z.string().min(1),

  taskId: z.string().optional()
});
```

校验分两层：

```text
Zod  → 结构与基本类型
Registry → agentType 是否已注册（运行时查表，返回结构化错误）
```

IPC Main：

```ts
ipcMain.handle(
  "agent:start",
  async (_, raw) => {
    const req =
      StartAgentSchema.parse(raw);

    return agentManager.startAgent(req);
  }
);
```

---

# 22. SQLite 数据模型

> **注意**：§23–§27 只给出了 7 张表的**简化示意**，缺少 V2 引入的全部实体
> （AcceptanceCriteria / WorkflowRun / ReviewPanel / Worktree / Handoff …），
> 且 `agent_runs` 缺少 `workflow_run_id`、`provider_session`、`role` 等必需列。
> **完整、可直接写 migration 的 schema 见 §139.1**，那里才是权威定义。

建议使用 SQLite。

原因：

- Desktop 本地数据。
- 事务简单。
- 无额外服务。
- 可以长期保存 Session。
- 后期可加 FTS5。

---

# 23. Workspace 表

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  environment TEXT NOT NULL,
  path TEXT NOT NULL,
  wsl_distro TEXT,
  git_root TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

# 24. Task 表

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT,

  status TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

# 25. Agent Run 表

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,

  task_id TEXT,
  workspace_id TEXT NOT NULL,

  agent_type TEXT NOT NULL,
  model TEXT,

  status TEXT NOT NULL,

  process_id TEXT,
  worktree_path TEXT,

  started_at TEXT,
  finished_at TEXT,

  exit_code INTEGER,

  created_at TEXT NOT NULL
);
```

---

# 26. Agent Message / Event 表

不要只存聊天消息。

建议存 Event：

```sql
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  run_id TEXT NOT NULL,

  event_type TEXT NOT NULL,

  payload_json TEXT NOT NULL,

  created_at TEXT NOT NULL
);
```

例如：

```json
{
  "event_type": "command",
  "payload": {
    "command": "dotnet test",
    "cwd": "/project"
  }
}
```

---

# 27. Artifact 表

多 Agent 协作一定要有 Artifact。

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,

  task_id TEXT NOT NULL,
  run_id TEXT,

  type TEXT NOT NULL,

  name TEXT NOT NULL,

  content TEXT,

  file_path TEXT,

  metadata_json TEXT,

  created_at TEXT NOT NULL
);
```

type（与 TASK-050 对齐，这是唯一权威列表）：

```text
plan
implementation
review
test-result
diff
decision
handoff
```

说明：

- 原列表中的 `summary` 并入 `handoff`（Handoff 本身就带 summary 字段）。
- 原列表中的 `file` / `patch` 并入 `diff`，通过 `metadata_json.kind` 区分。
- Artifact 的**内容来源**见 ADR-0004：结构化产物由 Agent 写入 `TESKRA_ARTIFACT_DIR`，
  不从 stdout 解析。

---

# 28. Task 模型

> **[SUPERSEDED]** 本节的 5 态 `status` 已被 **§138 的 8 态 `TaskStatus`** 取代。
> 实现请以 §138 为准，本节仅保留 `Task` 的字段结构。

```ts
interface Task {
  id: string;
  workspaceId: string;

  title: string;
  description: string;

  // [SUPERSEDED] 见 §138 TaskStatus
  // status: "todo" | "running" | "review" | "done" | "failed";
  status: TaskStatus;

  createdAt: string;
  updatedAt: string;
}
```

---

# 29. 第一版 Task 运行方式

```text
Task
 │
 ▼
选择 Agent
 │
 ▼
Start Agent
 │
 ▼
Agent Run
 │
 ▼
Result
```

例如：

```text
Task:
实现 Rate History API

Agent:
Codex

Workspace:
CargoRate
```

这已经比单纯 Chat Session 高一个层级。

---

# 30. Multi-Agent Orchestrator

V0.3 再实现。

核心原则：

> Orchestrator 管理任务，不管理具体 shell 细节。

接口：

```ts
interface TaskOrchestrator {
  execute(
    taskId: string,
    workflowId: string
  ): Promise<void>;
}
```

---

# 31. Workflow

建议使用显式 DAG，不要第一版让 LLM 自己无限动态拆任务。

示例：

```text
Implement
   ↓
Review
   ↓
Fix
   ↓
Test
```

定义：

```ts
interface WorkflowDefinition {
  id: string;
  name: string;

  steps: WorkflowStep[];
}
```

---

# 32. WorkflowStep

> **[SUPERSEDED]** 本节的扁平 `WorkflowStep` 已被
> **§116.3 / §153 的 discriminated union `WorkflowNode`** 取代（见 TASK-055）。
> 下方结构只对应新模型中的 `AgentWorkflowNode` 一种，无法表达 shell / checkpoint /
> condition / criteria-gate / review-panel 节点。
>
> 另外 `isolation` 的取值也已扩展，见 §126 `ReviewIsolation`。

```ts
// [SUPERSEDED] 见 §116.3 WorkflowNode
interface WorkflowStep {
  id: string;

  agent: string;

  role:
    | "planner"
    | "implementer"
    | "reviewer"
    | "tester";

  dependsOn?: string[];

  promptTemplate: string;

  isolation:
    | "shared"
    | "worktree";
}
```

---

# 33. Workflow 示例

> **[SUPERSEDED]** 本示例使用旧的扁平 `WorkflowStep`，且存在一个**安全错误**：
> `review` 步骤写成 `"isolation": "shared"`（可写共享目录），
> 这直接违反 §103 / §126「Reviewer 默认只读」。
> 正确的 Workflow 示例见 **§153（YAML）**，Reviewer 的隔离取值必须是
> `shared-readonly` / `worktree-readonly` / `disposable-snapshot` 之一。

```json
// [SUPERSEDED] 请勿据此实现，见 §153
{
  "id": "implement-review-test",
  "name": "Implement Review Test",
  "steps": [
    {
      "id": "implement",
      "agent": "codex",
      "role": "implementer",
      "isolation": "worktree"
    },
    {
      "id": "review",
      "agent": "claude",
      "role": "reviewer",
      "dependsOn": [
        "implement"
      ],
      "isolation": "shared"
    },
    {
      "id": "fix",
      "agent": "codex",
      "role": "implementer",
      "dependsOn": [
        "review"
      ],
      "isolation": "worktree"
    },
    {
      "id": "test",
      "agent": "codex",
      "role": "tester",
      "dependsOn": [
        "fix"
      ],
      "isolation": "worktree"
    }
  ]
}
```

---

# 34. 不推荐 Agent 自由互聊

不推荐：

```text
Codex
→ Claude
→ Codex
→ Claude
→ ...
```

原因：

- Context 爆炸。
- 无法审计。
- 难暂停。
- 难恢复。
- Agent 容易偏离任务。
- 成本不可控。

推荐：

```text
Agent
  ↓
Artifact
  ↓
Orchestrator
  ↓
Next Agent
```

---

# 35. Agent Artifact Protocol

例如 Implement Agent 输出：

```json
{
  "type": "implementation_result",
  "summary": "Implemented rate history API",
  "filesChanged": [
    "RateHistoryService.cs",
    "RateHistoryController.cs"
  ],
  "tests": [
    "dotnet test"
  ],
  "notes": [
    "Database migration required"
  ]
}
```

Reviewer：

```json
{
  "type": "review_result",
  "status": "changes_requested",
  "findings": [
    {
      "severity": "high",
      "file": "RateHistoryService.cs",
      "line": 128,
      "message": "Potential N+1 query"
    }
  ]
}
```

---

# 36. Git Worktree

多 Agent 并行修改代码必须隔离。

> **[SUPERSEDED]** 原方案把 worktree 放在 repo 同级的 `../.agent-worktrees/`，
> 会污染用户项目的父目录，且父目录未必可写。
> 且原文把 **worktree 目录名** 和 **branch 名** 混为一谈，二者是不同的东西。
> 生效方案见 `docs/decisions/0003-data-directory-and-paths.md`。

目录：

```text
~/.teskra/worktrees/
└─ <workspaceId>/
   ├─ RUN-0001/
   ├─ RUN-0002/
   └─ RUN-0003/
```

命令：

```bash
git worktree add \
  ~/.teskra/worktrees/ws_cargorate/RUN-0001 \
  -b agent/task-1001/codex/RUN-0001
```

WSL workspace 的 worktree 必须落在**同一个 WSL 文件系统内**
（跨 `\\wsl$` 做 git worktree 有性能与权限问题），
路径由 `WorkspaceRuntime.resolveDataRoot()` 决定，不是 Windows 侧路径。

---

# 37. WorktreeManager

接口：

```ts
interface WorktreeManager {
  create(
    request: CreateWorktreeRequest
  ): Promise<Worktree>;

  remove(
    id: string
  ): Promise<void>;

  list(
    workspaceId: string
  ): Promise<Worktree[]>;

  diff(
    id: string
  ): Promise<string>;
}
```

---

# 38. Worktree 生命周期

```text
Task Run Start
   ↓
Create branch
   ↓
Create worktree
   ↓
Run Agent
   ↓
Run tests
   ↓
Generate diff
   ↓
Review
   ↓
Merge / Cherry-pick
   ↓
Remove worktree
```

---

# 39. Worktree 命名

区分三个不同的命名，不要混用（见 ADR-0003）：

```text
Branch 名：       agent/<taskId>/<agentId>/<runId>
Worktree 目录：   ~/.teskra/worktrees/<workspaceId>/<runId>/
Commit 前缀：     agent(<agentId>): <taskId> <summary>
```

例如：

```text
branch    agent/TASK-103/codex/RUN-003
worktree  ~/.teskra/worktrees/ws_cargorate/RUN-003
commit    agent(codex): TASK-103 implement rate history api
```

目录层级已经包含 `workspaceId`，因此目录名只需要 `runId` 即可唯一。

---

# 40. Git Diff

DiffService：

```ts
interface DiffResult {
  files: DiffFile[];
}

interface DiffFile {
  path: string;

  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed";

  additions: number;
  deletions: number;

  patch: string;
}
```

UI 可以用 Monaco Diff Editor。

注意：

> Monaco 可以只用于 Diff，不需要把整个产品做成 IDE。

---

# 41. Permission System

> **[SUPERSEDED]** 本节及 §42–§44 原本假设 Teskra 可以在命令执行**之前**拦截并弹审批。
> **这在当前架构下不可能实现**：Codex / Claude 在自己的 PTY 内 fork 子进程执行命令，
> Teskra 只能看到 stdout 字节流——看到时命令已经执行完毕。
> Teskra 是 PTY 的**宿主**，不是 Agent 的**系统调用网关**。
>
> 生效方案见 `docs/decisions/0002-permission-system-policy-and-audit.md`：
> **策略下发 + 环境级隔离 + 事后审计**，三层职责，不含执行拦截。

Agent 的 Shell 权限必须统一控制，但控制点不在 Teskra 的进程边界上。

三层实际生效的机制：

```text
1. 策略下发  Teskra 的统一策略 → 翻译成各 CLI 自己的机制
              ├─ Claude Code：settings.json permissions / PreToolUse hook
              ├─ Codex：approval mode + sandbox 参数
              └─ 无法映射的 Agent → permissionEnforcement: "none"，UI 必须提示

2. 环境隔离  真正的硬边界（这一层才是可靠的）
              ├─ Agent 只在 worktree 内运行，主工作区不可写
              ├─ Reviewer 用 disposable-snapshot（§126）
              └─ 最终防线是 Merge Preflight（§133），不是执行前审批

3. 事后审计  CommandClassifier 从输出流识别已执行命令 → 打风险标签 → 审计日志
              └─ UI 高亮 DESTRUCTIVE / NETWORK_WRITE，Doctor 可据此提示
```

**明确不做**：假装能拦截。
UI 上不出现会误导用户的「Allow Once / Deny」弹窗，
除非该 Agent 的 `permissionEnforcement` 为 `native`
（即 CLI 自身支持回调式审批，例如 Claude Code 的 permission-prompt-tool）。

---

# 42. Command Risk Level

建议：

```text
READ_ONLY
WORKSPACE_WRITE
SYSTEM_WRITE
NETWORK_WRITE
DESTRUCTIVE
```

示例：

READ_ONLY：

```text
git status
git diff
ls
cat
find
grep
dotnet test
```

WORKSPACE_WRITE：

```text
npm install
dotnet restore
git add
文件修改
```

NETWORK_WRITE：

```text
git push
npm publish
docker push
```

DESTRUCTIVE：

```text
rm -rf
git reset --hard
docker system prune
DROP TABLE
```

---

# 43. CommandClassifier

> 用途已改为**审计打标**（见 §41 / ADR-0002），不是执行前的放行判定。
> 分类器本身的规则设计不变，仍然需要。

第一版使用规则，不要 LLM 判断。

```ts
interface CommandRisk {
  level: RiskLevel;
  reasons: string[];
}
```

例如：

```ts
if (
  command.includes("git push")
) {
  return {
    level: "NETWORK_WRITE",
    reasons: [
      "Pushes changes to remote repository"
    ]
  };
}
```

后期再加：

```text
Rule Engine
+
LLM Risk Review
```

---

# 44. Permission Rule

> **[SUPERSEDED]** `Allow Once / Allow For Session` 这类**交互式**动作
> 只有在 `permissionEnforcement: "native"` 的 Agent 上才有意义。
> 对其余 Agent，规则的作用是**生成下发给 CLI 的策略文件**，不是运行时放行。

规则动作：

```text
allow          写入下发策略的 allow 列表
deny           写入下发策略的 deny 列表
ask            仅 native enforcement 的 Agent 生效，其余降级为 audit
audit          不干预执行，仅在审计日志中标记
```

数据库（schema 全量定义见 TASK-090）：

```sql
CREATE TABLE permission_rules (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT,               -- NULL = 全局规则
  agent_type     TEXT,               -- NULL = 适用所有 Agent
  command_pattern TEXT NOT NULL,
  risk_level     TEXT,               -- 命中的风险等级，可为 NULL
  action         TEXT NOT NULL,      -- allow | deny | ask | audit
  scope          TEXT NOT NULL,      -- once | session | persistent
  created_at     TEXT NOT NULL
);

CREATE TABLE permission_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  command       TEXT NOT NULL,
  cwd           TEXT,
  risk_level    TEXT NOT NULL,
  matched_rule_id TEXT,
  detected_at   TEXT NOT NULL,       -- 从输出流识别到的时间（事后）
  created_at    TEXT NOT NULL
);
```

注意 `permission_audit.detected_at` 语义是**识别到**而非**执行前**，
不要在 UI 上把它呈现为"已阻止"。

---

# 45. Workspace Memory

第一版不需要向量数据库。

> **[SUPERSEDED]** 目录名 `.workspace-ai/` 是改名前的遗留，
> 已统一为 `.teskra/memory/`（见命名约定与 §152）。

建议：

```text
<repo>/.teskra/memory/
├─ architecture.md
├─ conventions.md
├─ commands.md
├─ decisions.md
└─ known-issues.md
```

系统内部也保存数据库版 Memory。

---

# 46. Memory 类型

```text
architecture
convention
decision
command
known_issue
preference
summary
```

数据库：

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,

  type TEXT NOT NULL,

  content TEXT NOT NULL,

  source TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

# 47. ContextBuilder

Agent 启动时生成：

```text
Task
+
Workspace Instructions
+
Relevant Memory
+
Workflow Role
+
Artifact from previous step
```

不要把全部历史都塞进去。

---

# 48. Session Persistence

系统重启后：

```text
历史 Task
历史 Agent Runs
历史 Output
历史 Diff
历史 Artifact
```

都能恢复查看。

但正在运行的 PTY 一般不能真正跨 Electron 重启恢复。

所以应用启动时：

```text
status = running
但 PID 不存在
```

则标记：

```text
interrupted
```

---

# 49. Agent Output 解析

第一版不要过度解析。

保留：

```text
raw terminal stream
```

另外识别少量高价值事件：

```text
command
file_change
permission
completion
error
```

Raw stream 永远保留，避免 parser 错误导致信息丢失。

---

# 50. ANSI / Terminal

xterm.js 原生显示 ANSI。

Renderer：

```ts
terminal.write(data);
```

不要尝试把所有 terminal stdout 转成 React HTML。

---

# 51. UI 页面规划

主窗口：

```text
┌────────────────────────────────────────────────────────────┐
│ Project / Branch / Environment                  Settings   │
├─────────────┬──────────────────────────┬───────────────────┤
│ Workspace   │ Task / Agent            │ Runs / Changes    │
│             │                          │                   │
│ Files       │ Chat                     │ Codex             │
│ Tasks       │ Plan                     │ Claude            │
│ Git         │ Result                   │ Test              │
│ Memory      │                          │                   │
├─────────────┴──────────────────────────┴───────────────────┤
│ Terminal                                                   │
└────────────────────────────────────────────────────────────┘
```

---

# 52. 左侧导航

```text
Workspace

Tasks

Git

Memory

Settings
```

不要一开始实现 VS Code 那么多导航。

---

# 53. Task 页面

```text
Task
────────────────────

Title:
Add Rate History API

Status:
Running

Plan:
✓ Analyze schema
✓ Implement service
→ Implement API
○ Tests

Runs:
● Codex     Implementer
● Claude    Reviewer
○ Codex     Tester

Changes:
3 files
+128
-18
```

---

# 54. Agent Run 页面

Tab：

```text
Activity
Terminal
Files
Commands
Artifacts
Logs
```

Activity 是结构化展示。

Terminal 是原始 stdout。

---

# 55. Agent 状态显示

```text
● Running
◐ Waiting
○ Queued
✓ Completed
× Failed
```

UI 应重点显示：

- 当前动作。
- 已运行时间。
- 工作目录。
- Agent。
- Model。
- Git branch。
- Changed files。
- 等待什么。

---

# 56. Settings

至少：

```text
Agents
 ├─ Codex path
 ├─ Claude path
 └─ Default agent

Environment
 ├─ Default shell
 ├─ WSL distro
 └─ Environment variables

Permissions

Worktrees

Memory

Appearance
```

---

# 57. Agent Detection

启动时检查：

```text
codex --version
claude --version
git --version
wsl --status
```

结果：

```ts
interface AgentDetectionResult {
  installed: boolean;

  executable?: string;

  version?: string;

  error?: string;
}
```

---

# 58. CLI 路径解析

Windows PATH 有时 Electron 拿不到用户完整 shell PATH。

建议：

1. `process.env.PATH`
2. `where.exe codex`
3. `where.exe claude`
4. 用户 Settings 自定义路径

WSL：

```bash
which codex
which claude
```

分别检测。

---

# 59. Windows 与 WSL Agent

必须允许分别配置：

```text
Codex:
Windows: C:\...\codex.exe
WSL: /usr/local/bin/codex

Claude:
Windows: ...
WSL: /home/user/.local/bin/claude
```

因为用户可能：

```text
Codex 装 Windows
Claude 装 WSL
```

---

# 60. 环境变量

Workspace 允许：

```json
{
  "env": {
    "DOTNET_ENVIRONMENT": "Development"
  }
}
```

Sensitive env 不要明文放 Workspace JSON。

第一版可以：

```text
OS Credential Store
```

Electron 可以考虑 keytar 或系统 Credential API。

---

# 61. Orchestrator 第一版策略

不要一开始让一个 LLM 决定所有 Workflow。

先支持预定义 Workflow。

例如：

```text
Single Agent
Implement + Review
Implement + Review + Fix
Implement + Test
Plan + Implement + Review + Test
```

用户选择即可。

---

# 62. Workflow Engine

Workflow Engine 负责：

```text
Dependency
State
Retry
Artifact Passing
Cancellation
```

伪代码：

```ts
while (hasRunnableStep()) {
  const steps = getRunnableSteps();

  await Promise.all(
    steps.map(runStep)
  );
}
```

这样天然支持 DAG 并行。

---

# 63. 并行示例

```text
            Plan
             │
      ┌──────┴──────┐
      ▼             ▼
   Backend        Frontend
   Codex          Claude
      │             │
      └──────┬──────┘
             ▼
           Review
             │
             ▼
            Test
```

---

# 64. Retry

每个 WorkflowStep：

```ts
interface RetryPolicy {
  maxAttempts: number;
}
```

不要无限 retry。

默认：

```text
maxAttempts = 1
```

失败后由用户决定是否 Retry。

---

# 65. Cancel

Cancel Task：

```text
Cancel workflow
↓
Stop queued steps
↓
Interrupt running PTY
↓
Mark runs cancelled
↓
Keep worktree
```

不要自动删除 worktree。

用户可能需要查看现场。

---

# 66. Merge 策略

第一版不要自动 merge 到主分支。

建议：

```text
Agent 完成
↓
生成 Diff
↓
用户 Review
↓
Apply
```

Apply 可以：

```text
Cherry-pick commit
```

或：

```text
Merge agent branch
```

---

# 67. Agent Commit

建议 Agent Run 完成后自动生成一个本地 commit，但默认不要 push。

格式：

```text
agent(codex): TASK-103 implement rate history api
```

这样：

```text
Review
Cherry-pick
Rollback
```

都更容易。

---

# 68. Security

Electron 必须：

```ts
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload
  }
});
```

Renderer 永远不直接拿：

```text
fs
child_process
shell
sqlite
```

---

# 69. IPC Security

不要：

```ts
ipcMain.handle("exec", (_, command) => {
  exec(command);
});
```

这种接口等于 RCE。

正确：

```text
agent.start
terminal.create
terminal.write
git.status
workspace.open
```

每个 IPC 都是领域操作。

---

# 70. 日志

使用：

```text
pino
```

日志分：

```text
application.log
agent.log
process.log
ipc.log
```

不要记录：

```text
API Key
Token
完整 Secret Env
```

---

# 71. Crash Recovery

启动时：

1. 加载数据库。
2. 检查未完成 AgentRun。
3. 检查对应 PID。
4. 若 PID 不存在：

```text
status = interrupted
```

5. 保留 worktree。

---

# 72. 应用退出

如果 Agent 正在运行：

```text
There are 2 agents running.

[Keep running not supported]
[Stop and Exit]
[Cancel]
```

第一版 Electron 退出就停止所有 PTY。

后期如果需要真正后台运行，可以拆：

```text
Workbench UI
+
Agent Daemon
```

但不要第一版做。

---

# 73. 将来拆 Agent Daemon

未来如果希望：

```text
UI 退出
Agent 继续运行
```

架构可以升级为：

```text
Electron Renderer
      │
      ▼
Electron Main
      │
      ▼
Local Agent Daemon
      │
      ├─ Codex
      ├─ Claude
      └─ Git
```

Daemon 可以独立 Node.js service。

第一版不需要。

---

# 74. Search / Memory 后期升级

当 Memory 多起来：

第一阶段：

```text
SQLite
```

第二阶段：

```text
SQLite FTS5
```

第三阶段：

```text
Embedding
+
Vector DB
```

因为代码 Agent 的高价值 Memory 往往是：

```text
architecture
conventions
decisions
known issues
```

数量并不会非常大。

---

# 75. 项目文件检索

第一版不要自己做完整 RAG。

Agent CLI 本身已经能：

```text
grep
ripgrep
find
git
```

Workbench 只负责保存：

```text
Workspace Memory
Task Context
Artifacts
```

后期再做 Context Retrieval。

---

# 76. 推荐的开发顺序

## Milestone 1：Electron Shell

完成：

```text
Electron
React
Ant Design
Preload
IPC
```

验收：

- 应用能启动。
- Renderer 无 Node 权限。
- IPC 工作。

---

# 77. Milestone 2：Workspace

完成：

```text
Open Folder
Workspace DB
Windows / WSL
Recent Workspaces
```

验收：

```text
可以打开：
C:\project

也可以打开：
/home/user/project
via WSL
```

---

# 78. Milestone 3：Terminal

完成：

```text
node-pty
xterm.js
PowerShell
WSL
resize
Ctrl+C
```

验收：

```text
dotnet build
npm run dev
git status
top
```

可以正常工作。

---

# 79. Milestone 4：Agent Runtime

完成：

```text
AgentAdapter
AgentManager
CodexAdapter
ClaudeAdapter
AgentRun DB
```

验收：

```text
Start Codex
Start Claude
同时运行
分别关闭
分别输入
```

---

# 80. Milestone 5：Task

完成：

```text
Task CRUD
Task → Agent Run
Task History
```

验收：

用户可以：

```text
创建 Task
选择 Codex
启动
看到 Result
```

---

# 81. Milestone 6：Git

完成：

```text
Git status
Diff
Changed files
Commit
```

验收：

Agent 修改文件后 UI 自动显示：

```text
3 changed files
+120
-17
```

---

# 82. Milestone 7：Worktree

完成：

```text
Create worktree
Run Agent in worktree
Diff
Cleanup
```

验收：

Codex / Claude 同时修改同一 Repository 时互不影响。

---

# 83. Milestone 8：Workflow

完成：

```text
WorkflowDefinition
WorkflowEngine
Dependency
Artifact
```

第一个 Workflow：

```text
Codex Implement
↓
Claude Review
↓
Codex Fix
↓
Test
```

---

# 84. Milestone 9：Permissions

完成：

```text
Command risk
Approval UI
Rules
Audit log
```

---

# 85. Milestone 10：Memory

完成：

```text
Workspace Memory
ContextBuilder
Task Summary
```

---

# 86. 第一版产品范围

建议 V0.1 只做：

```text
Workspace
Terminal
Codex
Claude
Session
Task
Git Diff
```

不要做：

```text
Multi-Agent automatic orchestration
Memory RAG
Cloud
Plugins
Remote SSH
Docker Agent
```

---

# 87. 第一版页面

只需要：

```text
Home
Workspace
Task
Settings
```

Workspace 内：

```text
Task
Agents
Changes
Terminal
```

---

# 88. 推荐开发任务拆分（早期草稿）

> **[SUPERSEDED]** 本节及 §89 / §90 是任务拆分的**早期草稿**。
> 它们原本使用 `TASK-001`…`TASK-035` 编号，与 `docs/teskra-tasks.md` 的编号
> **撞号但含义完全不同**（例如这里的 003 是 SQLite，TASKS.md 的 TASK-003 是 contracts 包）。
> 把两份文档一起交给 Agent 会导致读错任务。
>
> 编号已在下方移除。**唯一的 TASK 编号权威是 `docs/teskra-tasks.md`。**

第一阶段的功能顺序（仅作阅读参考，不是任务编号）：

```text
Electron + Vite + React
Preload IPC
SQLite
Workspace
node-pty
xterm.js
ProcessManager
AgentAdapter
CodexAdapter
ClaudeAdapter
AgentRun UI
Task
Git Status
Diff Viewer
Session Persistence
```

做到这里就已经是可用产品。对应 `teskra-tasks.md` 的 Phase A + Phase B + Phase C。

---

# 89. V0.2（早期草稿）

> **[SUPERSEDED]** 同 §88，编号已移除。

```text
WorktreeManager
Agent branch
Artifact
Workflow engine
Implement → Review
Implement → Review → Fix
Test step
Permission system
```

对应 `teskra-tasks.md` 的 Phase E + Phase F。

---

# 90. V0.3（早期草稿）

> **[SUPERSEDED]** 同 §88，编号已移除。

```text
Workspace Memory
Context Builder
Task Summary
Search history
SQLite FTS
Agent templates
```

对应 `teskra-tasks.md` 的 Phase G。

---

# 91. 关键技术风险

## node-pty 编译

Windows Electron 下 node-pty 是 native addon。

注意：

```text
Electron ABI
Node ABI
node-pty native binary
```

需要在 build 时 rebuild。

建议：

```text
electron-rebuild
```

或者使用对应 Electron builder 配置。

---

# 92. Windows MSIX / Installer

开发阶段：

```text
electron-builder
```

可以输出：

```text
NSIS .exe
portable
MSIX
```

如果你希望做“独立安装包”，建议：

```text
NSIS installer
```

这样不依赖 Microsoft Store。

---

# 93. 自动更新

第一版可以不做。

后期：

```text
electron-updater
+
GitHub Releases
```

或者自己的 update server。

---

# 94. Database Migration

不要在启动时直接：

```sql
CREATE TABLE IF NOT EXISTS ...
```

到处散落。

统一：

```text
migrations/
001-init.sql
002-artifacts.sql
003-memory.sql
```

保存：

```text
schema_version
```

---

# 95. Type Sharing

建议 packages/contracts：

```text
packages/contracts/
├─ agent.ts
├─ workspace.ts
├─ task.ts
├─ git.ts
├─ events.ts
└─ ipc.ts
```

Main 和 Renderer 共用类型。

---

# 96. 不要共享 Main Implementation

Renderer 可以 import：

```text
contracts
```

不能 import：

```text
main/AgentManager
main/ProcessManager
```

否则边界会慢慢烂掉。

---

# 97. Store 设计

Zustand：

```text
useWorkspaceStore
useTaskStore
useAgentStore
useTerminalStore
useGitStore
```

不要一个巨大的：

```text
useAppStore
```

---

# 98. 事件数据流

例如 Codex 输出：

```text
Codex CLI
↓
node-pty
↓
ProcessManager
↓
AgentManager
↓
EventBus
↓
Electron IPC
↓
Zustand
↓
React
```

所有实时数据都走同一路径。

---

# 99. 文件修改检测

不要第一版监控整个磁盘。

只监控：

```text
workspace root
```

可以使用：

```text
chokidar
```

但 Git 项目更简单的方法是：

```text
agent output event
→ debounce
→ git status
```

例如每 1~2 秒刷新一次 Git status，而不是监听所有 node_modules。

---

# 100. 性能策略

Agent 输出可能非常多。

不要：

```text
每个字符
→ setState
→ React render
```

应该：

```text
PTY chunks
↓
buffer
↓
16~50ms batch
↓
xterm
```

数据库也不要逐字符保存。

建议：

```text
1 秒
或
4KB
```

批量写 event log。

---

# 101. Task Context

任务执行时：

```text
Task Description
+
Role Prompt
+
Workspace Memory
+
Previous Artifacts
```

示例：

```text
Role:
You are the implementation agent.

Task:
Implement Rate History API.

Workspace conventions:
- .NET 8
- EF Core
- Use AsNoTracking for read queries.

Previous artifact:
Architecture plan ...
```

---

# 102. Prompt Template

不要把 Prompt 写死在代码里。

```text
resources/prompts/
├─ implement.md
├─ review.md
├─ fix.md
├─ test.md
└─ plan.md
```

以后用户可以覆盖。

---

# 103. Reviewer 权限

Review Agent 默认：

```text
read-only
```

不要默认允许修改文件。

例如：

```text
Claude Reviewer
approvalMode = read-only        （见 §13，该值已加入枚举）
isolation    = disposable-snapshot（见 §126）
```

Fix Agent：

```text
approvalMode = safe-auto
isolation    = worktree
```

这比所有 Agent 都 full-auto 安全很多。

> 但要记住 §126 的结论：**只读边界靠环境隔离保证，不靠 approvalMode 这个提示**。
> `approvalMode` 只是下发给 CLI 的建议值，CLI 是否遵守不在 Teskra 控制范围内。

---

# 104. 建议的默认 Workflow

## Fast

```text
Codex Implement
```

## Safe

```text
Codex Implement
↓
Claude Review
```

## Full

```text
Plan
↓
Codex Implement
↓
Claude Review
↓
Codex Fix
↓
Test
```

---

# 105. 多 Agent 的价值

项目最终解决的不是：

```text
一个 Agent 没额度
换另一个 Agent
```

虽然这个需求也能满足。

真正价值是：

```text
Agent specialization
+
parallel work
+
review
+
task orchestration
+
session persistence
```

例如：

```text
Codex:
实现

Claude:
Review

Gemini:
文档 / Research

Local Model:
代码索引 / 低成本任务
```

---

# 106. 和 VS Code / Cursor 的定位区别

不要和 VS Code 正面竞争编辑器。

产品定位建议：

```text
VS Code / Cursor
=
Human-first IDE

AI Workbench
=
Agent-first task execution
```

用户依然可以：

```text
Open in VS Code
Open in Cursor
```

Workbench 负责：

```text
Task
Agent
Workflow
Review
Memory
```

---

# 107. Open in VS Code

Workspace 页面可以提供：

```text
Open in VS Code
Open in Cursor
Open Terminal
Open Explorer
```

执行：

Windows workspace：

```bash
code <windows-path>
```

WSL workspace（**从 Windows 侧启动，不要用 `wsl -- code`**）：

```bash
code --remote wsl+Ubuntu-22.04 /home/user/project
```

> `wsl -d Ubuntu -- code /path` 依赖 WSL 内已安装 VS Code Server 的包装脚本，
> 在干净环境下会失败，且无法把窗口正确挂到 Windows 侧。
> `--remote wsl+<distro>` 是官方支持的写法。

Cursor 同理（`cursor --remote wsl+<distro> <path>`）。
若对应命令不在 PATH，UI 必须降级为「打开所在目录」并给出明确提示，
不要静默失败。

---

# 108. 最终推荐架构

```text
┌─────────────────────────────────────────┐
│             React Renderer              │
│                                         │
│ Workspace / Task / Agent / Git / UI     │
└────────────────────┬────────────────────┘
                     │
                   IPC
                     │
┌────────────────────▼────────────────────┐
│              Electron Main              │
│                                         │
│ AgentManager                            │
│ TaskManager                             │
│ WorkflowEngine                          │
│ WorkspaceManager                        │
│ ProcessManager                          │
│ TerminalManager                         │
│ GitManager                              │
│ WorktreeManager                         │
│ PermissionManager                       │
│ MemoryManager                           │
│ EventBus                                │
│ SQLite                                  │
└─────────────┬───────────────┬───────────┘
              │               │
          node-pty            Git
              │
   ┌──────────┼───────────────┐
   ▼          ▼               ▼
 Codex      Claude            Shell
              │
        Windows / WSL
```

---

# 109. 最重要的设计原则

整个项目建议坚持以下几条：

1. **Agent CLI 与 UI 解耦。**
2. **所有 Agent 必须经过统一 Adapter。**
3. **所有进程必须经过 ProcessManager。**
4. **Windows / WSL 是 Workspace 属性，不是字符串路径技巧。**
5. **Terminal 与 AgentRun 分离。**
6. **多 Agent 通过 Artifact 协作，不自由聊天。**
7. **并行写代码必须使用 Git Worktree。**
8. **Reviewer 默认只读。**
9. **高风险操作必须 Permission Gate。**
10. **保留 Raw PTY Output，不完全依赖 Parser。**
11. **Task 是一级对象，Chat 只是交互方式。**
12. **第一版先做好 Runtime，不先做复杂智能。**

---

# 110. 推荐 MVP

真正值得第一阶段实现的最小版本：

```text
Electron
+
React
+
Workspace
+
Windows / WSL
+
node-pty
+
xterm.js
+
CodexAdapter
+
ClaudeAdapter
+
Agent Session
+
Task
+
Git Status / Diff
+
SQLite
```

达到这里之后，产品已经可以每天自己使用。

然后第二阶段再增加：

```text
Git Worktree
+
Workflow Engine
+
Implement / Review / Fix
+
Permission
+
Artifact
```

第三阶段：

```text
Workspace Memory
+
Task Summary
+
FTS
+
More Agents
+
Remote Environment
```

---

# 111. 建议第一条可执行开发路线

从工程实施角度，建议按下面顺序直接开始：

```text
1. 初始化 Electron + React + TS + Vite
2. 建 preload 和类型安全 IPC
3. 集成 SQLite
4. 实现 WorkspaceManager
5. 实现 Windows / WSL Runtime
6. 实现 ProcessManager
7. 集成 node-pty
8. 集成 xterm.js
9. 实现 AgentAdapter
10. 接 Codex
11. 接 Claude Code
12. 实现 Agent Session UI
13. 实现 Task
14. 集成 Git
15. 实现 Diff
16. 保存历史
17. 实现 Git Worktree
18. 实现 Workflow Engine
19. 实现 Permission
20. 实现 Workspace Memory
```

这个顺序可以保证每一步都有可运行结果，不需要等到最后才看到产品。

---

# 112. MVP 完成标准

MVP 可以定义为：

> 用户可以打开 Windows 或 WSL 项目，在同一个桌面客户端里启动 Codex 和 Claude Code，两个 Agent 都保持独立 Session，可以实时查看 Terminal 输出、任务状态和 Git Diff，应用重启后仍能看到历史 Task 和 Run。

满足这个标准，就已经具备继续开发 Multi-Agent Orchestrator 的基础。

---

# 113. V1 完成标准

V1：

> 用户创建一个 Task，选择预定义 Workflow。系统自动建立 Git Worktree，调用 Codex 实现代码，再调用 Claude Review，根据 Review 再调用 Codex 修复，执行测试，并最终把 Diff 和结果交给用户确认。

理想工作流：

```text
Create Task
   ↓
Plan
   ↓
Create Worktree
   ↓
Codex Implement
   ↓
Claude Review
   ↓
Codex Fix
   ↓
Run Tests
   ↓
Show Diff
   ↓
User Approve
   ↓
Merge
```

如果做到这一层，这个项目就已经不再是“CLI GUI”，而是真正的 Multi-Agent Coding Workbench。

---

# 114. V2：GitHub 参考项目与借鉴矩阵

截至 2026-09-09，本方案重点参考以下项目。

| 项目 | 技术形态 | License | 主要价值 | 本项目建议 |
|---|---|---|---|---|
| [Wintersta7e/agentdeck](https://github.com/Wintersta7e/agentdeck) | Electron + React + WSL2 + node-pty | Elastic-2.0 | Windows/WSL 桌面端、PTY、Agent Registry、Workflow UI、Worktree | **行为和架构参考为主，不建议直接大段复制** |
| [Justmalhar/maverick](https://github.com/Justmalhar/maverick) | Tauri + React + Rust + Bun sidecar | MIT | ProcessManager、WorktreeManager、SQLite、Terminal Provider、边界设计 | **适合代码级研究和抽象借鉴** |
| [chasenstark/crew-mcp](https://github.com/chasenstark/crew-mcp) | Node.js MCP Orchestrator | MIT | Dispatch、Panel、Acceptance Criteria、Iterate、结构化 Worker Handoff | **重点借鉴 Orchestrator** |
| [joaovictor3g/agents](https://github.com/joaovictor3g/agents) | Go + tmux + git worktree | MIT | Worktree 安全、resume、doctor、status reconciliation、merge guards | **重点借鉴生命周期和恢复逻辑** |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | Go + tmux + git worktree TUI | AGPL-3.0 | Session 管理、并行 Agent、Diff/Checkout UX | **参考交互和行为，谨慎复制代码** |

本项目不需要“选一个项目 Fork 后改造”，更合适的是：

```text
我们的产品
│
├─ AgentDeck
│   └─ Windows/WSL + Electron 行为基准
│
├─ Maverick
│   └─ Runtime / Manager / Provider 架构
│
├─ crew-mcp
│   └─ Multi-Agent Orchestrator
│
├─ agents
│   └─ Worktree Lifecycle / Doctor / Recovery
│
└─ Claude Squad
    └─ Session UX / Multi-session mental model
```

---

# 115. 为什么不建议直接 Fork AgentDeck

AgentDeck 和本方案的技术目标高度重合：

```text
Windows 10/11
+
WSL2
+
Electron
+
React
+
TypeScript
+
node-pty
+
xterm.js
+
Zustand
+
Git Worktree
+
Visual Workflow
+
Codex / Claude Code / Gemini / Aider ...
```

它的目录边界也非常适合参考：

```text
src/
├─ main/
├─ preload/
├─ renderer/
└─ shared/
```

其中：

```text
main
=
PTY
IPC
Workflow Engine
WSL
Git
Persistence

preload
=
contextBridge

renderer
=
React UI

shared
=
Agent Registry
Domain Types
Workflow Types
Validation
```

这与本项目的推荐架构基本一致。

但 AgentDeck 使用：

```text
Elastic License 2.0
```

因此：

### 可以借鉴

- Main / Renderer / Preload 分层思想
- node-pty 只放 Main Process
- WSL-native 路径模型
- Agent Registry
- Workflow Node 类型
- Keep / Discard 的 Git Review UX
- split terminal 交互
- session history 产品设计
- plan-limit / activity UI 的产品思路

### 不建议

- 大量复制源码后直接作为商业产品基础
- 把其实现整体 Fork 后重新包装
- 未来如果计划 SaaS / hosted service，更应该保持 clean-room implementation

推荐方式：

> 看它解决了什么问题、边界如何划分，然后按照我们自己的 Domain Model 和 Contract 重新实现。

---

# 116. AgentDeck 最值得借鉴的 5 个实现思想

## 116.1 WSL Native

AgentDeck 的核心设计不是：

```text
Windows App
+
偶尔调用 WSL
```

而是：

```text
Windows Electron UI
        │
        ▼
      wsl.exe
        │
        ▼
WSL Workspace Runtime
├─ git
├─ codex
├─ claude
├─ shell
└─ filesystem semantics
```

这对本项目非常重要。

因此建议把：

```ts
Workspace.environment
```

从原来的简单 enum，升级为：

```ts
export type RuntimeKind =
  | "windows"
  | "wsl"
  | "ssh"
  | "container";

export interface WorkspaceRuntimeRef {
  kind: RuntimeKind;

  distro?: string;
  host?: string;
  containerId?: string;
}
```

所有 Agent、Git、PTY、路径解析都必须经过：

```text
WorkspaceRuntime
```

而不是各模块自己判断：

```ts
if (isWsl) ...
```

---

## 116.2 Agent Single Registry

AgentDeck 用单一 Registry 驱动 Agent 元数据和能力。

本项目升级后的定义建议：

```ts
export interface AgentDefinition {
  id: string;
  name: string;

  executable: AgentExecutableDefinition;

  capabilities: {
    interactive: boolean;
    headless: boolean;
    resume: boolean;
    readOnlyMode: boolean;
    modelSelection: boolean;
  };

  prompt: {
    interactiveArgs?: string[];
    headlessArgs?: string[];
  };

  detection: {
    versionArgs: string[];
  };

  defaults: {
    role?: AgentRole;
    permissionProfile?: string;
  };
}
```

然后：

```text
UI Agent Picker
Workflow Node
Agent Detection
Settings
Task Routing
```

全部读同一个 Registry。

不要在五个地方各维护：

```text
Codex
Claude
Gemini
```

列表。

---

## 116.3 Workflow Node 使用 discriminated union

推荐：

```ts
type WorkflowNode =
  | AgentWorkflowNode
  | ShellWorkflowNode
  | CheckpointWorkflowNode
  | ConditionWorkflowNode
  | ReviewWorkflowNode;
```

例如：

```ts
interface AgentWorkflowNode {
  type: "agent";

  id: string;
  agentId: string;
  role: AgentRole;
}
```

这样：

```ts
switch (node.type) {
  case "agent":
  case "shell":
  case "checkpoint":
  case "condition":
  case "review":
}
```

TypeScript 可以做 exhaustive check。

新增 Node 时编译器能帮助发现遗漏。

---

## 116.4 PTY keep-alive

一个很容易踩的 UI 坑：

```text
切换 Tab
→ React unmount
→ terminal instance 被销毁
```

正确策略：

```text
Terminal Session 生命周期
≠
React Tab 生命周期
```

PTY 由 Main Process 持有。

Renderer 的 Terminal View：

```text
隐藏
≠
销毁
```

对于活跃 Terminal，可以：

```css
display: none;
```

而不是 unmount 整个 terminal session。

---

## 116.5 原始 PTY + 结构化 Activity 双轨

不要尝试把 Codex / Claude 的所有输出完全 parse 成结构化 UI。

应该始终保留：

```text
Raw PTY stream
```

同时解析高价值事件：

```text
reading
writing
running command
waiting
error
completed
```

UI：

```text
Activity View
+
Terminal View
```

两者并存。

---

# 117. Maverick：重点借鉴 Runtime Architecture

Maverick 虽然是 Tauri，不是 Electron，但它的业务层边界非常值得借鉴。

它的架构大致是：

```text
React
  │
  ▼
Tauri IPC
  │
  ▼
Rust
  │
  ▼
JSON-RPC / stdio
  │
  ▼
Bun Sidecar
  │
  ├─ ProcessManager
  ├─ WorktreeManager
  ├─ SQLiteStore
  ├─ ConfigLoader
  ├─ SkillsEngine
  ├─ GitModule
  └─ MCPManager
```

核心思想：

> UI shell 不应该承担 Agent Runtime 业务逻辑。

本项目第一版仍然采用 Electron Main 直接承载 Runtime：

```text
React
  │
IPC
  │
Electron Main
  │
Runtime Services
```

但是接口要设计成未来可以拆：

```text
Electron Main
   ↓
Local Agent Daemon
```

因此所有 Manager 不应该依赖 Electron UI 对象。

错误：

```ts
class AgentManager {
  constructor(
    private mainWindow: BrowserWindow
  ) {}
}
```

正确：

```ts
class AgentManager {
  constructor(
    private eventBus: EventBus,
    private processManager: ProcessManager,
    private repository: AgentRunRepository
  ) {}
}
```

Electron-specific bridge 单独负责：

```text
EventBus
↓
RendererEventBridge
↓
webContents.send
```

这样以后拆 daemon 不需要重写 AgentManager。

---

# 118. 增加 Runtime Facade

V2 建议增加：

```text
RuntimeFacade
```

Renderer 不应该直接知道：

```text
ProcessManager
WorktreeManager
AgentManager
```

逻辑关系。

统一：

```ts
interface TeskraRuntime {
  createTask(...): Promise<Task>;

  startRun(...): Promise<AgentRun>;

  cancelRun(...): Promise<void>;

  resumeRun(...): Promise<AgentRun>;

  applyRun(...): Promise<void>;

  discardRun(...): Promise<void>;
}
```

内部：

```text
TeskraRuntime
├─ AgentManager
├─ ProcessManager
├─ WorktreeManager
├─ GitManager
├─ PermissionManager
└─ Database
```

好处：

- IPC surface 更小。
- 测试容易。
- UI 与实现解耦。
- 后期 daemon 化容易。

---

# 119. TerminalProvider 抽象

Maverick 的 Terminal Provider 思路值得直接借鉴。

不要：

```tsx
import { Terminal } from "@xterm/xterm";
```

散落在各 UI 页面。

增加：

```ts
export interface TerminalRenderer {
  mount(
    element: HTMLElement,
    options: TerminalOptions
  ): TerminalInstance;
}
```

Registry：

```ts
class TerminalRegistry {
  get(name = "xterm"): TerminalRenderer;
}
```

第一版：

```text
XtermTerminalRenderer
```

未来：

```text
WebTerminalRenderer
NativeTerminalRenderer
ReadonlyLogRenderer
```

UI 无需修改。

---

# 120. 一个重要教训：PTY 必须只有一个 Authority

多层桌面架构非常容易出现：

```text
Electron Main 有一个 PTY Registry

Sidecar 又有一个 Process Registry

UI 不知道自己连的是哪一个
```

V2 明确规定：

> 所有交互式 Terminal / Agent CLI 只能由一个 PTY Authority 管理。

本项目第一版：

```text
PTY Authority
=
Electron Main / ProcessManager
```

唯一允许：

```text
spawn
write
resize
interrupt
kill
```

其它 Manager 只能调用 ProcessManager。

禁止：

```ts
CodexAdapter -> nodePty.spawn()

TerminalManager -> nodePty.spawn()

WorkflowEngine -> childProcess.spawn()
```

正确：

```text
CodexAdapter ─┐
ClaudeAdapter ├─→ ProcessManager → node-pty
TerminalManager┘
```

非交互短命令：

```text
git status
git diff
which codex
```

可以另走：

```text
CommandRunner
```

但必须明确：

```text
PTY Process
≠
One-shot Command
```

---

# 121. crew-mcp：重新设计 Orchestrator

crew-mcp 最值得借鉴的是它没有把“多个 Agent”理解为同时开多个窗口，而是：

```text
Captain / Orchestrator
        │
        ├─ Dispatch
        ├─ Panel
        └─ Iterate
```

因此 V2 把 Workflow 分成三种基本 Primitive。

## 121.1 Dispatch

```text
Task
↓
One Agent
↓
One isolated run
↓
Artifact
```

用途：

- 实现一个明确功能。
- 单独分析问题。
- 写测试。
- 文档任务。

---

## 121.2 Panel

```text
            Diff
             │
      ┌──────┼──────┐
      ▼      ▼      ▼
   Claude  Codex  Gemini
      │      │      │
      └──────┼──────┘
             ▼
       ReviewAggregate
```

每个 Reviewer **独立完整 Review**。

不要：

```text
Claude 看 Codex 的 review
再补充
```

否则失去独立判断价值。

---

## 121.3 Iterate

```text
Acceptance Criteria
        ↓
Implementation
        ↓
Review Panel
        ↓
Criteria Evaluation
       / \
    PASS FAIL
     │    │
     ▼    ▼
  Finish  Fix
           │
           └──→ Review
```

这应该成为 V1 后最重要的 Workflow。

---

# 122. Acceptance Criteria 成为一级对象

V1 只有：

```text
Task
```

V2 增加：

```ts
interface AcceptanceCriteriaSet {
  id: string;
  taskId: string;

  version: number;

  status:
    | "draft"
    | "confirmed"
    | "superseded";

  criteria: AcceptanceCriterion[];
}
```

Criterion：

```ts
interface AcceptanceCriterion {
  id: string;

  description: string;

  category?:
    | "functional"
    | "test"
    | "performance"
    | "security"
    | "compatibility"
    | "quality";

  required: boolean;
}
```

示例：

```json
{
  "criteria": [
    {
      "id": "AC-1",
      "description": "Rate History API returns historical rate points for a route",
      "category": "functional",
      "required": true
    },
    {
      "id": "AC-2",
      "description": "Existing API contracts remain backward compatible",
      "category": "compatibility",
      "required": true
    },
    {
      "id": "AC-3",
      "description": "All affected unit tests pass",
      "category": "test",
      "required": true
    }
  ]
}
```

---

# 123. Criteria Review Result

Reviewer 返回：

```ts
interface CriteriaReviewResult {
  runId: string;
  criteriaSetId: string;

  verdict:
    | "pass"
    | "fail";

  scores: CriterionScore[];

  findings: ReviewFinding[];
}
```

CriterionScore：

```ts
interface CriterionScore {
  criterionId: string;

  result:
    | "pass"
    | "fail"
    | "unknown";

  evidence: string[];
}
```

这比：

```text
"看起来不错"
```

可靠得多。

---

# 124. Iterate 必须有 Safety Cap

禁止无限：

```text
Implement
Review
Fix
Review
Fix
...
```

建议默认：

```ts
interface IterationPolicy {
  maxRoundsPerCriteriaVersion: 3;
  maxTotalRounds: 8;
}
```

超出后（**注意这是两个不同实体上的两个状态，不要混淆**）：

```text
WorkflowRun.status = needs_user_review    （§140，专有终止态）
Task.status        = needs_review         （§138 八态之一）
```

命名不同是刻意的：`Task.needs_review` 泛指"等人看"，
可能来自 Iterate 超限，也可能来自 Review Panel 结论或用户手动标记；
`WorkflowRun.needs_user_review` 特指"自动迭代已达上限、引擎主动停手"。
UI 需要区分这两种情形，因此不合并为同一个名字。

并把：

- 当前 Diff
- 未通过 Criteria
- Reviewer findings
- 已尝试轮数

交给用户。

---

# 125. Worker Handoff Protocol

Agent 之间不自由聊天。

增加：

```ts
interface WorkerHandoff {
  runId: string;

  type:
    | "implementation"
    | "review"
    | "test"
    | "analysis"
    | "blocker";

  summary: string;

  filesChanged?: string[];

  commandsRun?: CommandEvidence[];

  tests?: TestEvidence[];

  findings?: ReviewFinding[];

  blockers?: string[];

  suggestedNextAction?: string;
}
```

例如：

```json
{
  "type": "implementation",
  "summary": "Implemented rate-history endpoint and service.",
  "filesChanged": [
    "RateHistoryController.cs",
    "RateHistoryService.cs"
  ],
  "commandsRun": [
    {
      "command": "dotnet test",
      "exitCode": 0
    }
  ],
  "suggestedNextAction": "Run independent code review."
}
```

Orchestrator 接收 Handoff 后决定下一步。

---

# 126. Reviewer 权限进一步收紧

V1：

```text
Reviewer = read-only
```

V2 要区分：

```text
Advisory Read-only
Enforced Read-only
Disposable Snapshot
```

定义：

```ts
type ReviewIsolation =
  | "shared-readonly"
  | "worktree-readonly"
  | "disposable-snapshot";
```

如果某 Agent CLI 无法可靠限制写权限：

```text
不要相信 Prompt：
"请不要修改文件"
```

而应该：

```text
创建 disposable snapshot worktree
↓
允许它运行
↓
Review 完成
↓
丢弃整个 snapshot
```

也就是说：

> 安全边界应该由运行环境提供，而不是靠模型服从 Prompt。

---

# 127. agents 项目：Runtime State Reconciliation

这是 V2 一个重要升级。

数据库中保存：

```text
AgentRun.status = running
```

不能代表它真的还在运行。

真实状态必须综合：

```text
Database
+
Process Registry
+
PID
+
Worktree filesystem
+
Git state
```

设计：

```ts
interface RuntimeHealth {
  process:
    | "alive"
    | "dead"
    | "unknown";

  worktree:
    | "healthy"
    | "missing"
    | "dirty"
    | "broken";

  git:
    | "clean"
    | "dirty"
    | "conflict"
    | "detached";

  effectiveStatus: AgentRunStatus;
}
```

每次：

```text
App Startup

Agent List

Task Resume

Doctor
```

都执行 reconciliation。

---

# 128. 不持久化“易过期事实”

一个非常好的原则：

> Persist identity and intent; derive liveness.

可以持久化：

```text
run id
workspace
branch
worktree path
agent type
task
prompt
provider session id
```

不要把：

```text
process is alive
PTY is healthy
worktree exists
```

仅仅存在数据库里就当真。

这些应该实时检查。

---

# 129. 增加 Doctor

V2 建议增加：

```text
Teskra Doctor
```

检查：

```text
Git installed
WSL available
Configured distro exists
Codex installed
Claude installed
Workspace exists
Git repository healthy
Agent worktree exists
Branch exists
PTY orphan
Run marked running but process gone
Merge conflict
Detached HEAD
Stale worktree
```

接口：

```ts
interface DoctorIssue {
  code: string;

  severity:
    | "info"
    | "warning"
    | "error";

  scope:
    | "system"
    | "workspace"
    | "run";

  message: string;

  fix?: DoctorFix;
}
```

UI：

```text
System Health

✓ Git
✓ WSL Ubuntu-22.04
✓ Codex
✓ Claude

! TASK-103 Codex
  Process no longer exists
  [Resume]

! task-099-review
  Worktree missing
  [Repair]
```

---

# 130. Resume 不等于恢复原进程

应用重启后 PTY 通常已经消失。

Resume 应理解为：

```text
恢复 Run 的工作环境
```

而不是：

```text
神奇地恢复 PID
```

流程：

```text
load AgentRun
↓
validate branch
↓
validate / recreate worktree
↓
resolve provider
↓
尝试 provider-native session resume
↓
否则启动新 Agent Session
↓
注入 Run Summary / Handoff
```

AgentAdapter 增加：

```ts
interface AgentResumeCapability {
  canResumeConversation: boolean;

  buildResumeCommand?(
    session: ProviderSessionRef
  ): CommandSpec;
}
```

---

# 131. Provider Session Ref

增加：

```ts
interface ProviderSessionRef {
  provider: string;

  sessionId?: string;

  threadId?: string;

  metadata?: Record<string, unknown>;
}
```

AgentRun：

```ts
providerSession?: ProviderSessionRef;
```

以后 Codex、Claude 如果暴露自己的 Resume Session 能力，就可以用。

Workbench 不应该假设：

```text
每种 CLI 都用相同 resume flag
```

---

# 132. Worktree 生命周期升级

V2 Worktree state：

```ts
type WorktreeState =
  | "creating"
  | "ready"
  | "dirty"
  | "conflict"
  | "merged"
  | "discarded"
  | "missing"
  | "orphaned";
```

完整生命周期：

```text
Allocate
↓
Create Branch
↓
Create Worktree
↓
Verify
↓
Run Agent
↓
Dirty
↓
Commit / Diff
↓
Review
↓
 ┌───────────────┐
 ▼               ▼
Merge          Discard
 │               │
 ▼               ▼
Cleanup        Cleanup
```

任何异常：

```text
保留 branch
保留 worktree
记录 state
```

不要自动毁现场。

---

# 133. Merge Preflight

借鉴 `agents` 的安全模型。

Merge 前必须：

```text
Main checkout clean?
Agent worktree clean/committed?
Already merging?
Branch exists?
Base branch expected?
Tests required and passed?
Acceptance criteria passed?
```

返回：

```ts
interface MergePreflightResult {
  allowed: boolean;

  blockers: MergeBlocker[];
}
```

如果 conflict：

```text
merge conflict
↓
不 teardown
↓
不删 worktree
↓
不删 branch
↓
status = conflict
```

用户解决后再继续。

---

# 134. Delete / Discard 语义分离

不要只有：

```text
deleteRun()
```

需要：

```text
Cancel
Discard
Archive
Cleanup
```

含义：

### Cancel

停止运行，但保留代码。

### Discard

明确丢弃本 Run 的 worktree 变更。

### Archive

保存历史，但不再显示在 Active。

### Cleanup

清理确认安全的物理资源。

接口不要混在一起。

---

# 135. Worktree Garbage Collection

长期使用后：

```text
~/.teskra/worktrees/
~/.teskra/runs/
```

会不断增长（路径见 ADR-0003）。

加入 GC：

```ts
interface RetentionPolicy {
  mergedWorktreeDays: number;
  discardedRunDays: number;
  completedRunLogsDays: number;
}
```

默认例如：

```text
merged worktree: 1 day
discarded worktree: immediate after confirmation
run logs: 30 days
branches: never auto-delete if unmerged
```

GC 必须：

```text
dry-run
```

支持用户预览。

---

# 136. Run Directory

建议每个 Run 有自己的 durable directory：

```text
~/.teskra/
├─ db/
│  └─ teskra.sqlite
│
├─ runs/
│  └─ RUN-xxxx/
│     ├─ run.json
│     ├─ terminal.log
│     ├─ events.jsonl
│     ├─ handoff.json
│     ├─ diff.patch
│     └─ artifacts/
│
└─ worktrees/
```

即便 SQLite 损坏，Run 仍有部分可恢复信息。

---

# 137. SQLite + Append-only Event Log

V1 用 SQLite 保存 Agent Events。

V2 推荐：

```text
SQLite
+
events.jsonl
```

用途不同：

```text
SQLite
=
查询 / UI / index

JSONL
=
durable raw event log
```

关键 Runtime Event 先：

```text
append JSONL
```

再 batch 入 SQLite。

这样 Crash 时损失更小。

---

# 138. Task 状态与 Run 状态分离

不要：

```text
Task.status = AgentRun.status
```

一个 Task 可以有：

```text
Codex Implement
Claude Review
Codex Fix
Test Run
```

因此：

```ts
type TaskStatus =
  | "draft"
  | "ready"
  | "running"
  | "needs_review"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
```

而 AgentRun 有自己的状态机。

---

# 139. 推荐 V2 数据关系

```text
Workspace
   │
   ├─ Task
   │   │
   │   ├─ AcceptanceCriteriaSet
   │   │
   │   ├─ WorkflowRun
   │   │   │
   │   │   ├─ AgentRun
   │   │   ├─ AgentRun
   │   │   └─ ShellRun
   │   │
   │   └─ Artifact
   │
   ├─ Memory
   └─ PermissionRule
```

---


# 139.1 完整数据库 Schema（权威定义）

> §23–§27 的表结构是早期简化示意。**实现 migration 请以本节为准**（对应 TASK-090）。
> 时间列一律 `TEXT`，存 ISO-8601 UTC（`2026-09-09T12:34:56.789Z`）。
> 所有 `*_json` 列存 JSON 字符串，由 Repository 层负责序列化与 Zod 校验。

## 001_init.sql — 基础实体

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- WorkspaceRuntimeRef 展平存储（§116.1）
  runtime_kind  TEXT NOT NULL,          -- windows | wsl | ssh | container
  wsl_distro    TEXT,
  ssh_host      TEXT,
  container_id  TEXT,
  path          TEXT NOT NULL,
  git_root      TEXT,
  default_branch TEXT,
  env_json      TEXT,                   -- 非敏感环境变量；敏感值走 Credential Store
  last_opened_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_workspaces_runtime_path
  ON workspaces(runtime_kind, IFNULL(wsl_distro,''), path);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  -- §138 TaskStatus 八态
  status       TEXT NOT NULL,           -- draft|ready|running|needs_review|blocked|completed|failed|cancelled
  archived_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_tasks_workspace_status ON tasks(workspace_id, status);
```

## 002_runs.sql — Run / Event / Worktree

```sql
CREATE TABLE worktrees (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT,                   -- 不设 FK：与 agent_runs.worktree_id 会构成循环引用
  branch        TEXT NOT NULL,
  base_branch   TEXT NOT NULL,
  path          TEXT NOT NULL,
  -- §132 WorktreeState
  state         TEXT NOT NULL,          -- creating|ready|dirty|conflict|merged|discarded|missing|orphaned
  isolation     TEXT NOT NULL,          -- worktree|shared-readonly|worktree-readonly|disposable-snapshot
  merged_at     TEXT,
  discarded_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_worktrees_workspace_state ON worktrees(workspace_id, state);

CREATE TABLE workflow_runs (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_definition_id TEXT NOT NULL,
  definition_json        TEXT NOT NULL, -- 启动时的定义快照，防止定义变更影响历史
  status                 TEXT NOT NULL, -- created|running|waiting|needs_user_review|completed|failed|cancelled
  current_iteration      INTEGER NOT NULL DEFAULT 0,
  total_iterations       INTEGER NOT NULL DEFAULT 0,
  criteria_set_id        TEXT REFERENCES acceptance_criteria_sets(id) ON DELETE RESTRICT,
  created_at             TEXT NOT NULL,
  completed_at           TEXT
);
CREATE INDEX idx_workflow_runs_task ON workflow_runs(task_id, status);

CREATE TABLE workflow_steps (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         TEXT NOT NULL,        -- 对应 WorkflowNode.id
  node_type       TEXT NOT NULL,        -- agent|shell|checkpoint|condition|criteria-gate|review-panel
  status          TEXT NOT NULL,        -- pending|running|completed|failed|skipped|cancelled
  iteration       INTEGER NOT NULL DEFAULT 0,
  attempt         INTEGER NOT NULL DEFAULT 1,
  depends_on_json TEXT,
  result_json     TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_workflow_steps_run ON workflow_steps(workflow_run_id, status);

CREATE TABLE agent_runs (
  id                TEXT PRIMARY KEY,
  task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,  -- 非 CASCADE：保留审计
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_run_id   TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_step_id  TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,

  agent_type        TEXT NOT NULL,      -- AgentDefinition.id，不是硬编码枚举
  role              TEXT,               -- planner|implementer|reviewer|tester|fixer
  model             TEXT,
  approval_mode     TEXT,               -- read-only|manual|safe-auto|full-auto

  -- §17 AgentRunStatus（含 interrupted）
  status            TEXT NOT NULL,

  process_id        TEXT,               -- 运行期 ProcessManager id，重启后无意义
  pid               INTEGER,            -- 仅用于 reconciliation 判活，不是真相
  worktree_id       TEXT REFERENCES worktrees(id) ON DELETE SET NULL,

  execution_mode    TEXT NOT NULL,      -- attended | orchestrated（ADR-0002）
  criteria_set_id   TEXT REFERENCES acceptance_criteria_sets(id) ON DELETE RESTRICT,
  provider_session_json TEXT,           -- §131 ProviderSessionRef

  run_dir           TEXT NOT NULL,      -- ~/.teskra/runs/<runId>
  prompt            TEXT,

  started_at        TEXT,
  finished_at       TEXT,
  last_output_at    TEXT,               -- §148 Watchdog
  last_input_at     TEXT,
  exit_code         INTEGER,
  error_json        TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_agent_runs_task     ON agent_runs(task_id, created_at DESC);
CREATE INDEX idx_agent_runs_active   ON agent_runs(status) WHERE status IN ('running','preparing','queued');
CREATE INDEX idx_agent_runs_workflow ON agent_runs(workflow_run_id);

CREATE TABLE agent_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,         -- 与 events.jsonl 的行号对齐
  event_type  TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_agent_events_run_seq ON agent_events(run_id, seq);
```

## 003_criteria_review.sql — 验收契约与 Review

```sql
CREATE TABLE acceptance_criteria_sets (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,  -- ADR-0008：被 Run 锚定的版本随审计保留为孤儿（原为 NOT NULL CASCADE）
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL,           -- draft|confirmed|superseded
  confirmed_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_criteria_sets_task_version
  ON acceptance_criteria_sets(task_id, version);

CREATE TABLE acceptance_criteria (
  id              TEXT PRIMARY KEY,
  criteria_set_id TEXT NOT NULL REFERENCES acceptance_criteria_sets(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  description     TEXT NOT NULL,
  category        TEXT,                 -- functional|test|performance|security|compatibility|quality
  required        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_criteria_set ON acceptance_criteria(criteria_set_id, ordinal);

CREATE TABLE review_panels (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_run_id    TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  target_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  criteria_set_id    TEXT REFERENCES acceptance_criteria_sets(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL,     -- running|completed|failed
  consensus          TEXT,              -- approve|changes_requested|mixed
  aggregate_json     TEXT,              -- ReviewAggregate（含 disagreements）
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);

CREATE TABLE review_panel_members (
  id        TEXT PRIMARY KEY,
  panel_id  TEXT NOT NULL REFERENCES review_panels(id) ON DELETE CASCADE,
  run_id    TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_id  TEXT NOT NULL,
  verdict   TEXT,                       -- approve|changes_requested|unable_to_review
  created_at TEXT NOT NULL
);

CREATE TABLE review_findings (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  panel_id     TEXT REFERENCES review_panels(id) ON DELETE CASCADE,
  severity     TEXT NOT NULL,           -- critical|high|medium|low
  title        TEXT NOT NULL,
  description  TEXT,
  file         TEXT,
  line         INTEGER,
  criterion_id TEXT REFERENCES acceptance_criteria(id),
  evidence_json TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_findings_panel_severity ON review_findings(panel_id, severity);

CREATE TABLE criterion_scores (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL REFERENCES acceptance_criteria(id) ON DELETE CASCADE,
  result       TEXT NOT NULL,           -- pass|fail|unknown
  evidence_json TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_scores_run_criterion ON criterion_scores(run_id, criterion_id);
```

## 004_artifacts_memory.sql

```sql
CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,          -- plan|implementation|review|test-result|diff|decision|handoff
  name          TEXT NOT NULL,
  content       TEXT,                   -- 小内容内联
  file_path     TEXT,                   -- 大内容落 run_dir/artifacts/
  metadata_json TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_artifacts_task_type ON artifacts(task_id, type);

CREATE TABLE handoffs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,          -- implementation|review|test|analysis|blocker
  -- ADR-0004：parse 失败时 payload_json 为 NULL，raw_path 仍保留
  payload_json  TEXT,
  raw_path      TEXT,
  parse_status  TEXT NOT NULL,          -- ok|degraded|missing
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_handoffs_run ON handoffs(run_id);

CREATE TABLE memories (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,           -- architecture|convention|decision|command|known_issue|preference|summary
  content      TEXT NOT NULL,
  source       TEXT,                    -- manual|file:<path>|run:<runId>
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_memories_workspace_type ON memories(workspace_id, type);
```

## 005_permissions.sql

```sql
CREATE TABLE permission_rules (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL = 全局规则
  agent_type      TEXT,               -- NULL = 适用所有 Agent
  command_pattern TEXT NOT NULL,
  risk_level      TEXT,               -- 命中的风险等级，可为 NULL
  action          TEXT NOT NULL,      -- allow | deny | ask | audit
  scope           TEXT NOT NULL,      -- once | session | persistent
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_permission_rules_ws ON permission_rules(workspace_id, agent_type);

CREATE TABLE permission_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  command         TEXT NOT NULL,
  cwd             TEXT,
  risk_level      TEXT NOT NULL,
  matched_rule_id TEXT REFERENCES permission_rules(id) ON DELETE SET NULL,
  detected_at     TEXT NOT NULL,      -- 从输出流识别到的时间（事后，非执行前）
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_permission_audit_run ON permission_audit(run_id, risk_level);
```

## 012_agent_account_profiles.sql — 账号 Profile（TASK-095）

> 2026-09-13 追加：多订阅账号与 Agent Profile 管理（Milestone 24，
> `docs/teskra-multi-account-subscription-implementation.md` §8，ADR-0009）。
> 012 / 013 都是纯 `CREATE TABLE` / `ADD COLUMN`，不需要表重建，不设
> `foreignKeysOff`。顺序强制：012 必须早于 013。

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

-- 审计事件（§41）：account.created / account.login_started 等不属于任何
-- Run，而 permission_audit / agent_events 的 run_id 都是 NOT NULL，
-- 因此新增一张表。profile_id 刻意不设 FK：Profile 被硬删除后审计记录必须留下。
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

-- workflow alias 绑定（§53.1，ADR-0011）：alias 是写进仓库的稳定名字，
-- profileId 是机器本地的，这张表是两者之间唯一的映射。
-- 不设 FK 到两张 Profile 表：Profile 被删后 alias 应变成「未绑定」并在
-- 解析时报错，而不是被级联删掉。
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

注：上文 `§5.1` / `§7` / `§41` / `§46` / `§48.1` / `§53.1` 均指
`docs/teskra-multi-account-subscription-implementation.md` 的章节号。
`config_home IS NULL` 的行不参与唯一约束；第一阶段没有任何路径会产生
NULL 行，这条豁免是给将来留的余量。`wsl_distro` 入库前统一小写。

## 013_agent_run_account_profile.sql — agent_runs 四列（TASK-095）

`agent_runs` 的四个新列合并进同一个 migration——现有风格是「一个语义变更
一个文件」，不是「一列一个文件」。

```sql
ALTER TABLE agent_runs ADD COLUMN account_profile_id TEXT;
ALTER TABLE agent_runs ADD COLUMN execution_profile_id TEXT;
ALTER TABLE agent_runs ADD COLUMN profile_snapshot_json TEXT;

-- §17.2（ADR-0010）：限额/认证失败的分类结果。不新增 Run status，
-- 失败的 Run 仍然是 status = 'failed'，原因存在这一列里。
ALTER TABLE agent_runs ADD COLUMN failure_classification_json TEXT;
```

**前三列刻意不设外键。** 理由与 `worktrees.run_id` 相同（见 `002_runs.sql`
的注释）：这里要的是审计留痕，而 `ON DELETE SET NULL` 会在删 Profile 时
抹掉历史 Run 的身份，`ON DELETE RESTRICT` 又会让「软禁用优先」（设计文档
§47）变成「永远删不掉」。真相由 `profile_snapshot_json` 承载，
`account_profile_id` 只是弱引用。

## 014_agent_execution_profiles.sql — 执行 Profile（TASK-110）

Phase E 才需要，由 TASK-110 注册（TASK-095 只含 012 / 013）。

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
    -- env_profile_id：这四类实体在仓库里不存在（设计文档 §6.1）。
    -- 要加回来先看设计文档 §6.2 的前置工作。

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(account_profile_id)
      REFERENCES agent_account_profiles(id)
);
```

## 015_workspace_trust.sql — Workspace Trust 级别（TASK-118）

设计文档 §43。纯 `ADD COLUMN`，不需要表重建，不设 `foreignKeysOff`。

```sql
ALTER TABLE workspaces
  ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'restricted'
  CHECK (trust_level IN ('trusted', 'restricted'));
```

`'trusted'` 才加载 repo-local workflows / prompts / config / memory；存量行默认
`'restricted'`（显式信任才放行，与 VS Code Workspace Trust 一致）。

## 016_external_config_home_normalize — external config_home 存量归一（数据迁移）

纯数据迁移，无 DDL 变更（SQL 步骤为占位注释，工作在迁移事务内的 `run` 钩子中完成）。
背景见 code-review-2026-09-21 §11（P2-2 不追溯）：`normalizeExternalConfigHome` 只作用于
新建行，存量 windows external 行保留混合大小写 / 尾斜杠原始输入，可绕过 per-runtime
`config_home` 唯一索引。迁移把 `runtime_kind = 'windows' AND auth_type = 'external'` 的行按
Manager 同款规则归一（`normalizeWindowsConfigHome`，单点实现在
`agents/accounts/external-config-home.ts`）；归一后撞唯一索引时按 `created_at, id`
先建行胜出，后建行保持原字节存储并记 WARN，迁移不得因存量数据崩溃。

## 外键与删除策略（全表汇总）

原文有 4 处关联缺少显式 FK 与删除策略，此处补齐：

| 列 | 引用 | 删除策略 | 理由 |
|---|---|---|---|
| `worktrees.run_id` | *（不设 FK）* | — | 与 `agent_runs.worktree_id` 会构成**循环外键**，见下方说明 |
| `workflow_runs.criteria_set_id` | `acceptance_criteria_sets(id)` | `ON DELETE RESTRICT` | 已有 WorkflowRun 引用的 Criteria 版本不允许删，只能 supersede |
| `agent_runs.criteria_set_id` | `acceptance_criteria_sets(id)` | `ON DELETE RESTRICT` | 同上，Run 必须能追溯当时的验收契约 |
| `review_panels.target_artifact_id` | `artifacts(id)` | `ON DELETE RESTRICT` | Review 结论必须能追溯被 Review 的产物 |

补充说明：

- `agent_runs.worktree_id` → `worktrees(id) ON DELETE SET NULL`：
  worktree 被 GC 清理后 Run 历史仍可查看。
- `agent_runs.task_id` → `ON DELETE SET NULL`（**不是** CASCADE）：
  删 Task 不应销毁 Run 的审计记录；孤儿 Run 由 Doctor 识别。
- `worktrees` / `agent_runs` 的 `workspace_id` → `ON DELETE CASCADE`：
  移除 Workspace 即移除其全部派生数据，这是用户的显式意图。
- **未合并的 branch 永不因为任何 FK 级联而被删除**——数据库删行不等于删 git 分支，
  git 侧的清理只能由 RetentionService（TASK-069）在 dry-run 确认后执行。

### 循环引用的处理

`worktrees.run_id` ↔ `agent_runs.worktree_id` 是双向关联。

> **更正**：上一版这里写「两边都设 FK 会导致插入顺序无解」，**这个说法不准确**。
> 两列都可空时完全可以分阶段插入——先插 worktree（`run_id = NULL`），
> 再插 agent_run（`worktree_id` 指向它），最后 UPDATE 回填 `run_id`。
> SQLite 也支持 `DEFERRABLE INITIALLY DEFERRED`。
>
> 保持单向 FK 的**真实理由**是别的：双向 FK 意味着同一个关系存了两份，
> 任何写入路径都必须记得同时维护两边，漏一处就产生静默不一致，
> 而数据库本身无法约束"这两列必须互指"。这是一致性负担，不是不可能实现。

处理方式：

```text
agent_runs.worktree_id  → 设 FK（ON DELETE SET NULL）    ← 权威方向
worktrees.run_id        → 不设 FK，仅建索引              ← 冗余的反向指针
```

`worktrees.run_id` 是为了「从 worktree 反查 Run」的查询便利保留的冗余列，
一致性由 WorktreeRepository 在同一事务内维护，并由 Doctor（TASK-041）
检查两边是否对得上（对不上即 `orphaned`）。

```sql
CREATE INDEX idx_worktrees_run ON worktrees(run_id);
```

### 跨 migration 的前向引用

跨 migration 的前向引用共有两处：

```text
002 → 003   workflow_runs.criteria_set_id  → acceptance_criteria_sets
002 → 003   agent_runs.criteria_set_id     → acceptance_criteria_sets
003 → 004   review_panels.target_artifact_id → artifacts
```

（第三处 `review_panels.target_artifact_id` 上一版遗漏，此处补上。）

SQLite 在 DDL 阶段**不校验** FK 目标表是否存在，只在 DML 时校验，
因此只要 003 在任何数据写入之前执行完毕即可。但为避免脆弱性：

- Migration 必须**严格按序号执行且不可跳过**（TASK-006 已有此要求）。
- TASK-090 的验收需包含：在**全部** migration 执行完毕后，
  运行 `PRAGMA foreign_key_check` 返回空结果。

## 索引与外键说明

- 必须开启 `PRAGMA foreign_keys = ON`（better-sqlite3 默认关闭）。
- 必须开启 `PRAGMA journal_mode = WAL`，否则 Agent 高频写 event 会阻塞 UI 查询。
- `agent_events` 是写入热点，只建 `(run_id, seq)` 唯一索引，不要再加多余索引。
- 所有 `ON DELETE RESTRICT` 的违反必须转成结构化错误呈现给用户，
  不能让 SQLite 的裸异常冒到 UI。

---

# 140. WorkflowRun

新增：

```ts
interface WorkflowRun {
  id: string;
  taskId: string;

  workflowDefinitionId: string;

  status:
    | "created"
    | "running"
    | "waiting"
    | "needs_user_review"
    | "completed"
    | "failed"
    | "cancelled";

  currentIteration: number;
  totalIterations: number;

  createdAt: string;
  completedAt?: string;
}
```

否则以后多个 AgentRun 很难知道属于哪一轮 Workflow。

---

# 141. Review Panel 数据模型

```ts
interface ReviewPanel {
  id: string;

  taskId: string;
  targetArtifactId: string;

  reviewers: ReviewPanelMember[];

  status:
    | "running"
    | "completed"
    | "failed";
}
```

```ts
interface ReviewPanelMember {
  runId: string;
  agentId: string;

  verdict?:
    | "approve"
    | "changes_requested"
    | "unable_to_review";
}
```

Aggregate：

```ts
interface ReviewAggregate {
  panelId: string;

  consensus:
    | "approve"
    | "changes_requested"
    | "mixed";

  commonFindings: ReviewFinding[];

  disagreements: ReviewDisagreement[];
}
```

---

# 142. Review 不应该只靠多数投票

例如：

```text
Claude: PASS
Codex: PASS
Gemini: FAIL — SQL injection
```

不能：

```text
2:1
=> PASS
```

严重问题需要 severity policy：

```ts
interface ReviewPolicy {
  blockOnCritical: true;
  blockOnHigh: true;
  majorityForMedium?: boolean;
}
```

---

# 143. Evidence First

Reviewer 的每个 Finding 应尽可能带：

```text
file
line
criterion
command
test result
diff hunk
```

定义：

```ts
interface ReviewFinding {
  id: string;

  severity:
    | "critical"
    | "high"
    | "medium"
    | "low";

  title: string;
  description: string;

  file?: string;
  line?: number;

  criterionId?: string;

  evidence?: string[];
}
```

---

# 144. Agent Routing

crew-mcp 的另一个好思路是：

```text
Agent 不只是 name
还要描述 strength / useWhen
```

增加：

```ts
interface AgentRoutingProfile {
  agentId: string;

  useWhen?: string;

  strengths?: AgentStrength[];

  costClass?:
    | "low"
    | "medium"
    | "high";

  priority?: number;
}
```

例如：

```json
{
  "agentId": "codex",
  "strengths": [
    "implementation",
    "refactoring",
    "autonomous-loop"
  ]
}
```

```json
{
  "agentId": "claude",
  "strengths": [
    "review",
    "architecture",
    "long-context"
  ]
}
```

第一版用户手动选。

以后 Orchestrator 自动 Routing。

---

# 145. Quota / Availability 也应该进入 Agent Health

因为多 Agent 的一个现实价值就是：

```text
某个 Agent 到限额
→ 自动换另一个
```

因此：

```ts
interface AgentHealth {
  installed: boolean;
  authenticated?: boolean;

  available: boolean;

  rateLimited?: boolean;

  quota?: {
    kind: string;
    remaining?: number;
    resetAt?: string;
  };

  checkedAt: string;
}
```

但是：

> 不依赖非官方、不稳定的配额解析来决定核心 Runtime 是否工作。

Quota 是 Routing Signal，不是核心依赖。

---

# 146. Agent Health Probe

```text
detect executable
↓
version
↓
optional auth health
↓
optional quota
```

缓存：

```text
1~5 minutes
```

不要每次 UI render 都：

```text
codex --version
claude --version
```

---

# 147. 并发限制

多 Agent 并不是越多越好。

配置：

```ts
interface ConcurrencyPolicy {
  maxGlobalRuns: number;
  maxRunsPerWorkspace: number;
  maxRunsPerAgent: number;
}
```

默认可以：

```text
global = 4
workspace = 3
same agent = 2
```

如果机器资源不足，再降。

---

# 148. Process Watchdog

所有 Agent Process 应有：

```text
heartbeat / activity timestamp
```

记录：

```ts
lastOutputAt
startedAt
lastInputAt
```

检测：

```text
长期无输出
```

不要自动认定死掉，但 UI 可以：

```text
Possibly stalled
```

并提供：

```text
Interrupt
Send input
Restart
```

---

# 149. Process Kill Escalation

Stop Agent：

```text
Ctrl+C
↓
wait
↓
graceful terminate
↓
wait
↓
force kill
```

不要第一步直接：

```text
taskkill /F
```

ProcessManager：

```ts
interface KillPolicy {
  interruptTimeoutMs: number;
  terminateTimeoutMs: number;
}
```

---

# 150. 一次性 Command 也要有 timeout

以下命令：

```text
git status
gh pr view
codex --version
claude --version
```

都可能卡死。

CommandRunner：

```ts
interface CommandRequest {
  command: string;
  args: string[];

  cwd?: string;

  timeoutMs: number;

  signal?: AbortSignal;
}
```

timeout 必须实际：

```text
kill child process
```

而不是只：

```ts
Promise.race(...)
```

后者可能留下 orphan process。

---

# 151. Config Layers

建议借鉴成熟 CLI：

```text
Built-in defaults
↓
Global config
↓
Workspace config
↓
Task / Run override
```

例如：

```text
~/.teskra/config.json

<repo>/.teskra/config.json
```

Merge：

```text
global
+
workspace
+
runtime override
```

---

# 152. Repo-local 配置

建议允许提交：

```text
.teskra/
├─ config.json
├─ prompts/
├─ workflows/
└─ memory/
```

例如团队可以共享：

```text
review rules
build commands
test commands
agent roles
```

但不要提交：

```text
API Key
个人 Token
个人 Agent Session ID
```

---

# 153. Workflow 定义建议用 JSON/YAML

例如：

```yaml
id: full-review

steps:
  - id: implement
    type: agent
    role: implementer
    agent: codex
    isolation: worktree

  - id: review
    type: review-panel
    dependsOn: [implement]
    agents:
      - claude
      - codex

  - id: gate
    type: criteria-gate
    dependsOn: [review]

  - id: fix
    type: agent
    role: fixer
    dependsOn:
      - node: gate
        on: fail          # 条件边：只在 gate 判定 fail 时激活
    agent: codex

  - id: test
    type: shell
    command: dotnet test
    dependsOn:
      - node: fix
    timeoutMs: 600000
```

内部加载后用 Zod validate。

### dependsOn 的两种写法

```text
dependsOn: [implement]                     无条件依赖（简写）
dependsOn: [{ node: gate, on: fail }]      条件边
```

`on` 的取值由**上游节点类型**决定，必须在 Zod schema 里做交叉校验：

```text
criteria-gate  → pass | fail
condition      → true | false
agent / shell  → success | failure
review-panel   → approve | changes_requested
```

### 调度语义（TASK-057 必须实现）

- 一个节点可运行的条件是：**所有** `dependsOn` 边都已激活。
- 未被激活的条件边使其下游节点进入 `skipped`，而不是永久 pending。
- `skipped` 会沿 DAG 向下传播，直到某个节点还有其它已激活的入边。
### Iterate 与 DAG 的关系（裁决）

上一版这里说「循环边不允许在 DAG 校验阶段拒绝」，
与 TASK-055 的「非法 DAG 被拒绝」直接冲突。**现裁决如下**：

> **图内严格无环。Iterate 是 DAG 外层的受控循环，不是图内的边。**

即：

```text
WorkflowEngine
└─ IterationController          ← 循环在这一层
   └─ 每一轮执行一次完整 DAG    ← 图本身严格无环
```

具体规则：

- `WorkflowDefinition` 的 `dependsOn` 图**必须无环**，检测到环即拒绝加载
  （TASK-055 的验收标准成立，无例外）。
- 「Implement → Review → Fix → Review」不是图中的环，
  而是**同一个 DAG 被执行了多轮**：第 N 轮的 `fix` 节点消费第 N-1 轮的 review 结果。
- 轮次由 `IterationPolicy`（§124）控制，计数落在
  `workflow_runs.current_iteration` / `total_iterations`。
- 每轮的 step 记录通过 `workflow_steps.iteration` 区分，
  因此同一 `node_id` 会有多行——这是预期的。

选择这个方案而不是「图内 iteration edge」的理由：

- 图内循环需要额外定义"何时退出"的语义，与 `IterationPolicy` 职责重叠。
- 无环 DAG 的校验、拓扑排序、并行调度都是标准算法，不需要特例。
- Iterate 的轮次上限本来就是**运行期**策略（可配置、可被用户中断），
  放进**定义期**的图结构里是错的层次。

### 每轮的节点激活规则

「每轮执行同一个 DAG」还不够明确——第 1 轮要跑 `implement`，
第 2 轮应该跑 `fix` 而不是重新 `implement`。规则如下：

`AgentWorkflowNode` 增加 `runOn` 声明该节点在哪些轮次参与：

```ts
runOn?: "first" | "subsequent" | "always";   // 默认 "always"
```

默认工作流的声明：

```text
implement   runOn: "first"        只在第 1 轮
fix         runOn: "subsequent"   第 2 轮起
build/test  runOn: "always"       每轮都跑
review      runOn: "always"
gate        runOn: "always"
```

引擎在每轮开始时先按 `runOn` 过滤节点，
被过滤掉的节点视为 `skipped`（不是 pending），其出边照常激活——
否则第 2 轮的 `test` 会因为等 `implement` 而永远阻塞。

约束：

- 每轮过滤后的子图必须**仍然连通到至少一个终止节点**，
  否则该工作流定义非法，加载时拒绝。
- `runOn: "subsequent"` 的节点在第 1 轮被跳过，
  其下游若无其它已激活入边，也一并 skip——这是预期行为。
- 上一轮的产物通过 Artifact / Handoff 传递给本轮，
  引擎不隐式共享内存状态。

---

# 154. UI 增加 Run Recovery Center

Home 页面：

```text
Recovery

2 interrupted runs

TASK-103
Codex
worktree healthy
branch healthy
[Resume]

TASK-91
Claude
worktree missing
branch exists
[Repair]
```

这个对桌面工具日常使用非常重要。

---

# 155. Home Dashboard 不要只做“漂亮统计”

真正有价值的 Dashboard：

```text
Active Tasks

Waiting For You

Interrupted Runs

Dirty Worktrees

Merge-ready Tasks

Rate-limited Agents

Recent Failures
```

比：

```text
今天用了 128 分钟 AI
```

更重要。

---

# 156. V2 推荐产品定位

看过现有项目后，本项目不要变成另一个：

```text
AgentDeck Clone
```

而应该强调：

```text
Windows-first Multi-Agent Coding Control Plane
```

核心区别：

```text
AgentDeck
偏：
Terminal + Workflow Desktop

Claude Squad
偏：
Session Manager

crew-mcp
偏：
CLI Orchestrator

我们的产品
偏：
Task + Runtime + Review + Recovery + Desktop UX
```

---

# 157. 推荐 V2 架构

```text
┌─────────────────────────────────────────────────┐
│                 React Renderer                  │
│                                                 │
│ Home / Tasks / Runs / Git / Review / Terminal   │
└──────────────────────┬──────────────────────────┘
                       │
                    Typed IPC
                       │
┌──────────────────────▼──────────────────────────┐
│                  Electron Main                  │
│                                                 │
│ TeskraRuntime                                │
│                                                 │
│ ├─ WorkspaceManager                             │
│ ├─ TaskManager                                  │
│ ├─ WorkflowEngine                               │
│ ├─ Orchestrator                                 │
│ ├─ AgentManager                                 │
│ ├─ AgentRegistry                                │
│ ├─ ProcessManager        ← PTY Authority         │
│ ├─ CommandRunner                                │
│ ├─ GitManager                                   │
│ ├─ WorktreeManager                              │
│ ├─ ReviewManager                                │
│ ├─ CriteriaManager                              │
│ ├─ PermissionManager                            │
│ ├─ MemoryManager                                │
│ ├─ HealthManager / Doctor                       │
│ ├─ ReconciliationService                        │
│ ├─ RetentionService                             │
│ ├─ EventBus                                     │
│ └─ SQLite                                       │
└─────────────┬──────────────────────┬────────────┘
              │                      │
           node-pty              CommandRunner
              │                      │
      ┌───────┼──────────┐      git / gh / detect
      ▼       ▼          ▼
    Codex   Claude       Shell
              │
       Windows / WSL
```

---

# 158. 新增模块目录

V2 建议目录增加：

```text
src/main/
├─ runtime/
│  ├─ TeskraRuntime.ts
│  └─ RuntimeFacade.ts
│
├─ reconciliation/
│  ├─ ReconciliationService.ts
│  └─ RuntimeHealth.ts
│
├─ health/
│  ├─ HealthManager.ts
│  └─ DoctorService.ts
│
├─ review/
│  ├─ ReviewManager.ts
│  ├─ ReviewPanel.ts
│  └─ ReviewAggregator.ts
│
├─ criteria/
│  ├─ CriteriaManager.ts
│  └─ CriteriaEvaluator.ts
│
├─ retention/
│  └─ RetentionService.ts
│
├─ command/
│  └─ CommandRunner.ts
│
└─ handoff/
   ├─ HandoffStore.ts
   └─ HandoffParser.ts
```

---

# 159. V2 MVP 重新划分

经过开源项目对比后，建议把 MVP 稍微调整。

## MVP-A：Single Agent Workbench

```text
Electron
React
Typed IPC
Workspace
Windows / WSL
PTY
Codex / Claude
Terminal
Git Diff
SQLite
```

完成后已经可以日常使用。

---

## MVP-B：Reliable Runtime

必须紧接着完成：

```text
AgentRun persistence
Reconciliation
Doctor
Resume
Worktree
Merge guards
Crash recovery
```

这部分的重要性高于“漂亮 Workflow Editor”。

---

## V1：Multi-Agent

```text
Task
Acceptance Criteria
Dispatch
Review Panel
Iterate
Artifact / Handoff
Permission
```

---

## V1.5：Visual Workflow

最后再：

```text
React Flow
Branch
Condition
Loop
Checkpoint
```

原因：

> Workflow UI 很显眼，但 Runtime Reliability 才是这个产品长期是否好用的基础。

---

# 160. 开源借鉴优先级

如果真正开始写代码，我建议按下面顺序研究源码。

## 第一优先级：AgentDeck

目的：

```text
Windows + WSL2
Electron + node-pty
preload / IPC
Terminal cache
Agent Registry
```

只研究和验证行为，不以它作为代码底座。

Repo：

https://github.com/Wintersta7e/agentdeck

---

## 第二优先级：Maverick

目的：

```text
ProcessManager
WorktreeManager
SQLiteStore
Provider
Runtime boundary
```

Repo：

https://github.com/Justmalhar/maverick

重点目录：

```text
sidecar/process-manager.ts
sidecar/worktree-manager.ts
sidecar/sqlite-store.ts
sidecar/git-module.ts
sidecar/mcp-manager.ts
src/lib/
```

MIT，可以更放心地借鉴实现模式，但仍建议保留自己的命名和 Domain Model。

---

## 第三优先级：crew-mcp

目的：

```text
Dispatch
Panel
Iterate
Acceptance Criteria
Worker Handoff
Merge confirmation
Run retention
```

Repo：

https://github.com/chasenstark/crew-mcp

重点不要看 UI，而是看：

```text
run lifecycle
worktree allocation
criteria contract
continue_run
review panel
structured messaging
```

---

## 第四优先级：agents

目的：

```text
status
resume
doctor
delete
merge
worktree lifecycle
reconciliation
```

Repo：

https://github.com/joaovictor3g/agents

这个项目虽然体量小，但它的：

```text
dirty worktree guard
unmerged branch guard
conflict preservation
idempotent cleanup
live-state reconciliation
```

非常适合直接转化成我们的单元测试规范。

---

## 第五优先级：Claude Squad

目的：

```text
Multi-session UX
attach / detach
diff review
checkout / resume
```

Repo：

https://github.com/smtg-ai/claude-squad

License：

```text
AGPL-3.0
```

因此主要看交互与状态模型，不建议直接复制大量实现。

---

# 161. 建议建立 Reference Tests

与其复制代码，更推荐：

```text
观察成熟项目行为
↓
写成我们的测试
↓
自己实现
```

例如：

```ts
describe("merge safety", () => {
  it("refuses merge when main checkout is dirty");
  it("refuses destructive cleanup for unmerged branch");
  it("preserves worktree when merge conflicts");
});
```

```ts
describe("runtime reconciliation", () => {
  it("marks persisted running run as interrupted when process is gone");
  it("marks missing worktree as broken");
  it("does not trust stale database liveness");
});
```

这样既能借鉴成熟经验，也能保持实现独立。

---

# 162. 最重要的 V2 工程原则

在 V1 的原则之上再增加：

13. **数据库不是 Runtime 真相源；运行状态必须 reconciliation。**
14. **交互式进程只有一个 PTY Authority。**
15. **Reviewer 的只读边界靠环境隔离，不靠 Prompt。**
16. **Acceptance Criteria 是 Task Contract。**
17. **Agent Handoff 结构化，不让 Agent 无限互聊。**
18. **Workflow 循环必须有 Safety Cap。**
19. **Merge conflict 时保留完整现场。**
20. **Cancel、Discard、Archive、Cleanup 是不同操作。**
21. **Worktree 和 Run 必须有 Retention / GC。**
22. **所有外部进程 timeout 都必须真正 kill child。**
23. **Runtime 业务层不直接依赖 Electron BrowserWindow。**
24. **先把 Runtime Reliability 做好，再做复杂 Workflow UI。**

---

# 163. 最推荐的第一个真正 Multi-Agent 流程

V2 推荐第一条自动 Workflow 不做很复杂：

```text
User Task
   ↓
Generate / Confirm Acceptance Criteria
   ↓
Create isolated worktree
   ↓
Codex Implement
   ↓
Run build/test
   ↓
Claude Independent Review
   ↓
Criteria Evaluation
   │
   ├─ PASS
   │    ↓
   │  Show Diff
   │    ↓
   │  User Approve
   │    ↓
   │  Merge
   │
   └─ FAIL
        ↓
     Codex Fix
        ↓
     Run tests
        ↓
     Claude Review
        ↓
   max 3 rounds
```

这是一个足够简单、但已经明显优于单 Agent CLI 的流程。

---

# 164. V2 最终建议

如果现在正式开始项目：

**不要首先做 Workflow Designer。**

第一阶段应该完成：

```text
Electron
+
React
+
Windows / WSL Runtime
+
node-pty
+
Agent Registry
+
Codex / Claude
+
Task
+
Git Worktree
+
Diff
+
Persistence
+
Reconciliation
+
Doctor / Resume
```

做到这里以后，系统已经是一个可靠的：

```text
Multi-Agent Session Workbench
```

然后才加：

```text
Acceptance Criteria
+
Review Panel
+
Iterate
+
Visual Workflow
```

这个顺序比先做一个看起来很酷的 Multi-Agent DAG 编辑器更稳，也更容易真正成为日常开发工具。

