# ADR-0003：数据目录与路径约定

- 日期：2026-09-09
- 状态：Accepted

## 背景

文档中出现三套互相冲突的路径写法：

- 命名约定：全局数据目录 `~/.teskra/`
- TASK-005 / TASK-039：`<app-data>/db/teskra.sqlite`、`<app-data>/runs/`
- plan §136：`~/.teskra/db/`、`~/.teskra/runs/`、`~/.teskra/worktrees/`
- plan §36：worktree 在 `../.agent-worktrees/`（repo 同级）

Electron 的 `app.getPath("userData")` 在 Windows 上是 `%APPDATA%\Teskra`，
**不等于** `~/.teskra`。两者混用会导致 Doctor 找不到文件、Run Directory 丢失。

另外 §36 把 worktree **目录名**（`task-1001-codex`）和 §39 的 **branch 名**
（`agent/<task>/<agent>/<run>`）混为一谈，二者是不同的东西。

## 决策

### 全局数据根目录

统一使用 `~/.teskra/`，通过一个 `paths.ts` 模块集中解析，**禁止各模块自行拼接**：

```text
~/.teskra/
├─ config.json          # 全局配置（ADR-0005 Config Layers）
├─ db/
│  └─ teskra.sqlite
├─ logs/
│  ├─ app.log
│  ├─ runtime.log
│  └─ ...
├─ runs/
│  └─ <runId>/
│     ├─ run.json
│     ├─ events.jsonl
│     ├─ terminal.log
│     ├─ handoff.json
│     ├─ diff.patch
│     └─ artifacts/
└─ worktrees/
   └─ <workspaceId>/
      └─ <runId>/
```

- Windows：`~` 解析为 `os.homedir()`（即 `C:\Users\<name>`），得到 `C:\Users\<name>\.teskra`。
- 不使用 `app.getPath("userData")` 作为数据根，只在需要 Electron 缓存/GPU 目录时使用。
- 允许通过环境变量 `TESKRA_HOME` 覆盖（测试与多实例需要）。

### Worktree 位置

Worktree **不放在 repo 同级目录**（`../.agent-worktrees/` 会污染用户的项目父目录，
且在 WSL / Windows 混合场景下父目录可能不可写）。

统一放在 `~/.teskra/worktrees/<workspaceId>/<runId>/`。

对于 WSL workspace，worktree 必须落在**同一个 WSL 文件系统内**
（`\\wsl$` 跨文件系统的 git worktree 会有性能与权限问题），
因此 WSL runtime 的 worktree 根为 WSL 侧的 `~/.teskra/worktrees/`，
由 `WorkspaceRuntime.resolveDataRoot()` 决定，而不是 Windows 侧路径。

### 命名区分

```text
Branch 名：  agent/<taskId>/<agentId>/<runId>
Worktree 目录名： <runId>            （目录层级已含 workspaceId）
Commit 前缀：agent(<agentId>): <taskId> <summary>
```

### Repo 内配置目录

`.teskra/`（可提交），见 plan §152：

```text
<repo>/.teskra/
├─ config.json
├─ prompts/
├─ workflows/
├─ memory/
└─ handoff/        # 运行期产物，必须在 .gitignore 中排除
```

`.workspace-ai/`（plan §45）作废。

### 配置文件名与格式

命名约定块原本写「默认配置文件：`teskra.yaml`」，但该名称在**全文没有任何设计章节使用**，
是改名过程中留下的残片；§151 / §152 实际用的一直是 `config.json`。
且命名约定写的是**单个**配置文件，与 §151 的**两层**结构对不上。

决策：**保留 `config.json`，删除 `teskra.yaml`。**

格式按「谁写这个文件」决定，而不是全局统一：

| 文件 | 格式 | 理由 |
|---|---|---|
| `~/.teskra/config.json` | JSON | Settings UI 会回写，YAML 回写会摧毁注释与格式 |
| `<repo>/.teskra/config.json` | JSON | 需与全局层同构才能 deep merge |
| `<repo>/.teskra/workflows/*.yaml` | YAML | 纯手写、UI 不回写，DAG 需要注释与可读性（§153） |

因此配置路径上**不引入 YAML 解析依赖**；YAML 只在加载 Workflow 定义时使用。

## 影响

- 新增 TASK-078：实现 `paths` 模块与 `TESKRA_HOME` 覆盖。
- TASK-005 / TASK-039 / TASK-043 的路径描述全部改写。
- `WorkspaceRuntime` 接口增加 `resolveDataRoot()`。
