# Teskra 全量 Code Review — 2026-09-12

- 范围：`apps/desktop`（main / preload / renderer）、`packages/contracts`、`packages/shared`、`scripts/`、`tools/`、`.github/`、`docs/`
- 规模：生产代码约 39k 行（TS/TSX），测试约 28k 行
- 基线状态（本次实测）：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `npm run lint` | ✅ 通过 |
| `npm run test:unit` | ✅ 131 文件 / 1183 用例全绿（6.7s） |
| `npm run format:check` | ❌ **71 个文件不符合 Prettier**（且 CI 未执行该脚本） |

---

## 0. 总体结论

**工程质量在同类项目里属于上游水平**：架构边界不是靠约定而是靠 ESLint 规则真正锁死的，错误模型执行得很彻底，生产代码零 `any` / 零 `@ts-ignore`，测试密度和"为什么这么做"的注释质量都很高。

**但存在一类系统性问题：功能在 Linux 开发机上闭环，在 Windows + WSL2（项目自称的首要目标平台）上并未闭环。** 最集中的表现是 Agent 运行期契约（handoff / artifacts / 权限投射）在 WSL workspace 下拿不到数据，而 `wsl-paths.ts` 这套现成的路径换算模块在整个生产代码里没有任何引用——说明这块从设计到接线断了一截，且因为 CI 的 Windows job 只跑单测（不跑 E2E、也没有 WSL 环境），断裂没有被任何自动化发现。

按优先级：

| 级别 | 数量 | 摘要 |
| --- | --- | --- |
| P0 阻塞 | 4 | WSL 运行期契约失效、子进程泄漏、仓库内容 → 任意代码执行、IPC 永不返回 |
| P1 重要 | 11 | 输出热路径性能、权限 scope 失效、审计实际无效、文档与实现不符、错误信息未国际化 |
| P2 改进 | 20 | 资源释放、类型/Lint 严格度、发布通道、文档卫生 |

---

## 1. 做得好的地方（先说，因为这些是不该在重构中弄丢的）

1. **架构边界是可执行的，不是文档里的口号。** `eslint.config.mjs` 用 `no-restricted-imports` / `no-restricted-syntax` 把「Renderer 不得碰 Node 内置」「只有 CommandRunner 能 import `child_process`」「只有 ProcessManager 能 import `node-pty`」「Runtime 层不得 import `electron`」「不得手拼 `.teskra` 字面量」「不得散落 `process.platform`」全部变成 lint error，并对每个授权模块单独开豁免块。这是我见过把 AGENTS.md 规则落到工具链最彻底的做法之一。

2. **统一错误模型执行到位。** `InternalAppError` 刻意不放进 `contracts`（因此结构上无法跨 IPC），`PublicAppError` 类型层面就没有 `detail` / `cause` 字段，`toPublicError()` 是唯一转换出口并负责写日志。IPC router 对**请求和响应都做 Zod 校验**，facade 抛异常也会被兜成 `UNKNOWN` 而非崩溃。

3. **测试纪律。** 1183 个用例全绿，全仓库只有一处条件 `skip`（符号链接不支持时）。`runtime/coverage-guard.test.ts` 更进一步：强制每个 Runtime 模块至少被一个测试文件 import，豁免必须显式登记在 `EXEMPT` 集合里并写明理由。

4. **安全基线双保险。** 源码级 `src/security/baseline.test.ts`（断言 `contextIsolation/nodeIntegration/sandbox`、preload 只 import 白名单、renderer 无 Node 内置）+ 构建产物级 `scripts/assert-security-baseline.mjs`（断言打包后的 preload 自包含、renderer bundle 无 `require`、生产 HTML 带 CSP meta）。两层覆盖了"源码对但打包错"这个常见盲区。

5. **路径穿越防护做到位。** `artifact-store.ts:89-163` 先做字面量检查（拒绝绝对路径、两种分隔符的 `..`），再用 `realpathSync` 比对真实路径——明确处理了"Agent 在自己的 artifact 目录里放一个指向外部的符号链接"这个场景。

6. **Credential Store 的防御细节。** `Object.create(null)` 做无原型记录防止继承成员冒充密文；cipher 不可用时 `set` 显式返回 `CAPABILITY_NOT_AVAILABLE` 而不是静默降级成明文；原子写 + `mode 0600`。

7. **Git 破坏性操作的边界很克制。** `discard` 必须显式 `confirm: true`；未合并分支**永不**删除（`merge-base --is-ancestor` 校验 + 只用 `branch -d` 不用 `-D`）；merge 冲突现场（MERGE_HEAD + 冲突标记 + worktree + 分支）完整保留，代码里从不调用 `git merge --abort`；AutoCommit 会断言 worktree cwd ≠ 仓库 cwd，拒绝在主工作区提交。

8. **注释写的是"为什么"。** 例如 `e2e/fixtures.ts` 里软件渲染的决策附了完整事故背景（连续强杀二十多个 Electron 实例把 Windows 显卡驱动打到 DXGKRNL 看门狗转储 + 0x7E 蓝屏）。这种注释在 6 个月后价值极高。

9. **i18n 完整。** en-US / zh-CN 各 440 键，双向零缺失。

---

## 2. P0 — 阻塞项

### P0-1 WSL-on-Windows 下 Agent 运行期契约整体失效

项目定位是 Windows-first + WSL2，但 WSL workspace 的 Agent Run 拿不到 Teskra 传给它的任何东西。三个独立缺陷叠加：

**(a) 环境变量不穿透 WSL 边界。** `process-manager.ts:215` 把 env 设在 `wsl.exe` 这个 Windows 进程上：

```ts
env: { ...process.env, ...request.env },
```

Windows 环境变量要进入 WSL 内的 Linux 进程，必须通过 `WSLENV` 声明。**全仓库搜不到 `WSLENV`**。结果是 `cli-agent-adapter.ts:74-76` 精心构造的：

```ts
TESKRA_HANDOFF_PATH / TESKRA_ARTIFACT_DIR / TESKRA_RUN_ID
```

以及 workspace env、从 Credential Store 解密出来的 secret，全部在边界上丢失。

**(b) 路径形态是宿主侧的。** `agent-manager.ts:639 / 668 / 842` 用 `deps.paths.runFiles(runId)`，拿到的是宿主 `~/.teskra`——在 Windows 上就是 `C:\Users\<u>\.teskra\runs\<id>\handoff.json`，交给 WSL 内的进程无法使用。

对比之下 `worktree-manager.ts:210` 是**正确**的：

```ts
runtime.resolveCwd(`${runtime.resolveDataRoot()}/worktrees/${workspaceId}/${runId}`)
```

即 worktree 走 runtime 数据根（ADR-0003），run 目录却走宿主数据根。**同一套数据根概念存在两条不一致的实现路径。**

**(c) 权限投射文件同样受影响。** `permission-projection.ts:138` 把 `permission-settings.json` 写到宿主 run 目录，再由 `claude-adapter` 以 `--settings <宿主路径>` 传给 WSL 内的 Claude Code。

**佐证：`apps/desktop/src/main/workspace/wsl-paths.ts`（82 行，含 `windowsPathToWsl` / `wslPathToWindows` / `wslPathToUnc` / `uncPathToWsl` 四个函数和完整单测）在整个生产代码中零引用**——只有它自己的测试文件 import 它。该模块的存在恰好证明这层换算被设计过但从未接线。

**后果：** ADR-0004 的 handoff 文件契约在目标平台上永远走 `parse_status: 'missing'` 分支，退化成读 `terminal.log` 尾部 2000 字；TASK-050 的 artifacts 扫描永远为空；Claude Code 的权限策略文件加载失败。**这三项都是 README 的卖点。**

**建议：** 在 `AgentStartRequest` 构造处引入 runtime 感知的路径解析（复用 `resolveDataRoot()` + `wsl-paths.ts`），并在 `ProcessManager.start` 为 WSL runtime 注入 `WSLENV=TESKRA_HANDOFF_PATH/p:TESKRA_ARTIFACT_DIR/p:TESKRA_RUN_ID`（`/p` 触发路径自动换算）或改为 WSL 侧路径直传。修完必须补一条 `[Windows 验证]` 的实机用例。

---

### P0-2 退出应用不终止 Agent / Terminal 子进程，重启后也不回收

- `terminal-manager.ts:31` 的接口注释直说：`Unsubscribes from the shared EventBus; it does not kill active terminals.`
- `agent-manager.ts:1045` 的 `dispose()` 只做退订 + 清 Map（`activeAdapters` / `pendingRuns` / `cancelRequested`），不调用任何 `stop()`。
- `ProcessManager` **根本没有 `dispose()`**。
- `main/index.ts` 的 `before-quit` 只调 `runtime.dispose()`，而 `compose.ts` 的 `dispose()` 依次调上述几个"不杀进程"的方法后直接 `database.close()`。

重启侧同样不回收：`reconciliation-service.ts` 只读 `deps.processes.list()`——那是**进程内**注册表，新进程启动时必然为空——然后把 run 标成 `interrupted`。它从不按 `run.pid` 探测宿主上是否还有活着的进程，也不尝试终止它们。

**后果：** 关掉 Teskra 之后 `codex` / `claude` 仍在运行、仍在往 worktree 写文件；下次启动时 Teskra 认为这些 run 已中断，用户点"恢复"会在**同一个 worktree 上并行起第二个 agent**，双写冲突且无任何提示。

**建议：** `ProcessManager` 增加 `disposeAll(policy)` 走完整的 interrupt → terminate → kill 阶梯；`compose.dispose()` 改为 async 并在关库前 await；Reconciliation 增加按 pid 的存活探测（Windows `tasklist`，POSIX `process.kill(pid, 0)`），发现幸存进程时要么接管要么终止，不要静默改状态。

---

### P0-3 仓库内容可导致本机任意代码执行（缺少 Workspace Trust 闸门）

**主路径：repo-local workflow 的 shell 节点。**

`definition-loader.ts` 从 `<repo>/.teskra/workflows/` 读定义；`full-workflow-service.ts:145` 会用仓库里 id 为 `full` 的定义**覆盖内置默认全流程**；`shell-step-executor.ts:113-131` 直接把节点的 `command` 交给 CommandRunner 执行：

```ts
const argv = splitCommandLine(node.command)
const request: CommandRequest = { command: argv[0], args: argv.slice(1), cwd: context.cwd, ... }
```

`splitCommandLine` 不起 shell（好），但**可执行文件本身由仓库作者指定**。用户 clone 一个仓库、在 Teskra 里打开、点"跑全流程"——就执行了仓库作者写的命令。这与 VS Code `tasks.json` 同类，区别是 **VS Code 有 Workspace Trust，Teskra 没有任何信任闸门**。

**次路径（当前不可利用，但是个定时炸弹）：** `packages/contracts/src/config.ts:105-113` 的 `teskraConfigLayerSchema` 允许 workspace 层（即可提交的 `<repo>/.teskra/config.json`）携带 `agents.executableOverrides`——把 Agent 可执行文件指向任意路径。目前唯一的挡板是 `agent-detector.ts:89` 恰好调用了不带 workspaceId 的 `config.resolve()`：

```ts
const resolved = deps.config.resolve()   // 不传 workspaceId ⇒ workspace 层不加载
```

这是"碰巧安全"。schema 层没有任何 global-only 约束，`stripSecrets` 也只过滤"像密钥"的值。任何人把这里改成 `resolve({ workspaceId })`（一个非常自然的"支持按 workspace 配置 Agent 路径"需求）就把它变成 RCE。

**第三路径：** `<repo>/.teskra/prompts/*.md` 覆盖内置 prompt，是 prompt injection 面（有 secret 扫描，但没有内容可信度概念）。

**建议（按性价比排序）：**
1. `ConfigService` 对 workspace 层做 group allowlist——`agents` 组必须 global-only，加载时剥离并告警（复用现有的 `stripSecrets` 告警机制）。这条最便宜，先做。
2. 引入 workspace 首次打开的信任确认；未信任的仓库不加载 repo-local workflows / prompts / config。
3. 执行 repo 定义的 shell 步骤前，把完整命令行展示给用户确认一次（至少首次）。

---

### P0-4 Workflow 挂起步骤让 IPC 调用永不返回

`workflow-engine.ts` 中 `checkpoint` / `criteria-gate` / `review-panel` 三类节点会 park 在 `running` 等待外部 `resolveStep`（`SUSPENDED_NODE_TYPES`）。`start()` 的 Promise 在此期间**不会 settle**（这是刻意设计，注释写了）。

但 `compose.ts:737-741` 把这个 Promise 直接返给 IPC handler：

```ts
startRun: (request) => workflowEngine.start(request.runId, { ... }),
```

`ipcRenderer.invoke` 没有超时机制，所以渲染进程那侧的 Promise 会**永远挂着**，对应的 UI loading 状态卡死，直到应用退出。

**建议：** `startRun` 立即返回 run 快照（`getRun`），让 pass 的推进完全通过 `workflow.run_updated` / `workflow.step_updated` 事件驱动；或者给挂起步骤加超时并在超时后返回一个可观测的中间态。

---

## 3. P1 — 重要

### P1-1 Agent 输出热路径过重（每 32ms 两次 fsync + 两次 SQLite 写 + 全量 manifest 重写）

`agent-manager.ts:257-272` 的 batcher 回调，每个 32ms 批次要做：

| 步骤 | 代价 |
| --- | --- |
| `runLogs.appendTerminal` | `openSync` + `fstatSync` + `writeSync` + **`fsyncSync`** + `closeSync` |
| `appendEvent` → `runLogs.appendEvent` | 同上，再来一次 |
| `agentEvents.append` | SQLite INSERT（每次重新 `prepare()`） |
| `runs.update(lastOutputAt)` | SQLite UPDATE |
| `persistRunManifest` | `run.json` **全量重写** + rename |
| `events.emit('agent.output')` | 序列化 + IPC 广播到所有窗口 |

`run-log-store.ts:62-79` 的 `appendAndFlush` 每次都 `fsyncSync`。4 个并发 run（默认 `maxGlobalRuns: 4`）≈ **每秒 250 次 fsync**，在 Windows 上尤其昂贵。这直接影响核心体验（Agent 流式输出时的终端响应）。

另外 `run-log-store.ts:102-114` 的 `countAndValidateEvents` 会**读取并逐行 JSON.parse 整个 `events.jsonl`**——`initialize` 时必调，`appendEvent` 在 `nextSequences` 无缓存时（如 resume 后）也会调。长 run 的 events 文件到十万行时这是一次 O(n) 全量解析。

**建议：** 持有长驻文件句柄批量追加，`fsync` 降频（例如每秒一次或仅在状态转换点）；manifest 只在生命周期转换时重写，不跟着输出走；缓存 prepared statement。

### P1-2 终端输出在渲染进程被二次缓冲，每 chunk 拷贝 2MB

xterm 已经通过 `terminal-session-binding.ts:60-62` 增量 `write()` 了。但 `terminal-store.ts:49-51` 另外维护一份 2MB 历史字符串：

```ts
function appendHistory(history, id, data) {
  const value = `${history[id] ?? ''}${data}`
  return { ...history, [id]: value.slice(-MAX_HISTORY_CHARS) }   // MAX = 2_000_000
}
```

每个输出 chunk 都做一次「全量字符串拼接 + slice 出新的 2MB 字符串 + 整个 history 对象浅拷贝 + zustand 触发订阅者重渲染」。

**更糟的是终端输出没有 batching**：Agent 输出有 32ms 的 `AgentOutputBatcher`，但 `TerminalManager` 是把 `process.output` 逐块原样转发成 `terminal.output` 的。跑一次 `npm install` 就能产生每秒数百个 chunk → 每秒数百 MB 的字符串分配，UI 必然卡顿。

**建议：** 终端输出也走 batcher；history 改成环形 chunk 数组（只在需要 `initialData` 时 join），不要每次重建大字符串。

### P1-3 `permission_rules.scope` 写入但从不生效

`permission-repository.ts` 正确持久化了 `scope`（`once` / `session` / `persistent`），但 `listApplicableRules`（:240-253）的 WHERE 条件里**没有 scope**，`permission-manager.ts` 的 `resolveProfile` 也不按 scope 过滤。

结果：用户通过 Settings 建一条 `scope: 'once'` 的规则，它会像 `persistent` 一样永久生效。**UI 承诺的语义和实际行为相反**——这在权限系统里是需要认真对待的。

（注：`recordDecision` 的 session/once 决策走的是内存 `sessionDecisions`，那条路径是对的；问题只在直接 `createRule` 的路径。）

**建议：** 要么在 `listApplicableRules` 过滤掉非 persistent 的行，要么 `createRule` 拒绝非 persistent 的 scope 并把它们导向 `recordDecision`。

### P1-4 权限审计对实际出货的两个 Agent 基本无效

`command-extraction.ts:36-41` 只识别 **shell 提示符行**：

```ts
const PROMPT_PREFIX = '(?:\\[[^\\]\\r\\n]{0,60}\\])*[\\w.@%:~/()-]{0,60}'
const PROMPT_MARKER = '[$#❯›]'
```

但 Teskra 出货的两个 Agent（Codex CLI、Claude Code）都渲染**自己的 TUI**，执行命令时显示的是 `● Bash(npm test)` 之类的自定义格式，不是 bash 提示符行。这个正则匹配不到。

叠加第二个问题：提取是**逐 chunk** 的（`permission-manager.ts:198-200` 订阅 `agent.output`），而 batcher 会在 32ms 边界切断输出——一行命令被切成两块时，要求完整行匹配的 `^...$` 就丢了。没有跨 chunk 的行缓冲。

ADR-0002 把"事后审计"列为权限体系的三大支柱之一（策略下发 + 环境隔离 + 事后审计）。**实测这根柱子目前是空的**——`permission_audit` 表在真实使用中大概率没有几行。

**建议：** 为每个内置 Agent 增加各自 TUI 格式的提取规则（可以做成 `AgentDefinition` 的一个字段，保持"不硬编码 agent 名"的原则）；提取器加跨 chunk 行缓冲。如果短期做不到，应在 UI / ADR 里如实说明审计覆盖范围，不要让用户以为有完整审计。

### P1-5 `DiffService.get()` 对每个变更文件串行起 2~3 个 git 进程

`diff-service.ts:38-59` 对 status 返回的每个 entry：未跟踪文件 1 次 `untrackedDiff`，已跟踪文件 2 次（staged + unstaged，虽然用了 `Promise.all` 但仍是 2 个进程）。500 个变更文件 ≈ 1000+ 次 git spawn，每次最多 15s 超时；而且所有 patch 全文拼进一个 `DiffResult` 一次性过 IPC（可能几十 MB）。

**建议：** 用一次 `git diff --numstat` + 按需懒加载单文件 patch；列表页不需要 patch 正文。

### P1-6 `readOutput()` 把整个 run 的输出从 SQLite 重建成单个字符串

`agent-manager.ts:428-442` 读出该 run 全部 `agent.output` 事件并 `.join('')`。`agent.getOutput` IPC 和 resume 上下文构造都走它。长 run 会产生几百 MB 的字符串拼接并整个过 IPC（resume 那边只取最后 6000 字，却先构造了全量）。

**建议：** 分页 / 按尾部 N 字节读取；resume 直接从 `terminal.log` 尾部读，不要经 SQLite 重建。

### P1-7 `retention-service` 递归删除 `runDir` 没有归属校验

`retention-service.ts:446`：

```ts
rmSync(run.data.runDir, { recursive: true, force: true })
```

`runDir` 来自 DB 列 `agent_runs.run_dir`。若该值因迁移、手工改库、或曾用不同 `TESKRA_HOME` 创建而指向别处，这里会无提示递归删除。

**建议：** 删除前断言 `resolve(runDir)` 位于 `resolve(paths.home(), 'runs')` 之下，否则跳过并记审计条目。同类检查也适用于 `executeRunLogs` 的文件删除。

### P1-8 文档说 workflow 是 YAML，实现只能解析 JSON

`AGENTS.md` 和 ADR-0005 明确写「`<repo>/.teskra/workflows/*.yaml`（YAML，纯手写）」。但 `definition-loader.ts:76-87` 只有：

```ts
json = JSON.parse(raw)
```

代码注释诚实说明了原因（不想引入 YAML 依赖，JSON 是 YAML 1.2 子集），**但面向用户的文档没有任何说明**。任何人按文档手写一份真正的 YAML block 语法，都会得到 "is not parseable"。

**建议：** 二选一——引入 `yaml` 依赖（这是个独立小 Task），或者把文档和文件扩展名统一改成 JSON。当前状态是最坏的：文档承诺 A，实现提供 B。

### P1-9 Main 进程返回的错误信息全是硬编码英文

UI 有完整的 440 键中英字典，但 `PublicAppError.message` 一律是英文字面量（`Workspace "X" was not found.` 等），`app-error-alert.tsx:28` 直接把它渲染成 Alert 的 message。中文用户看到的是「英文标题 + 中文建议」的混搭。

**建议：** `PublicAppError` 增加 `messageKey` + `params`，`message` 降级为 fallback；渲染侧优先用 key 查字典。

### P1-10 Electron 导航/窗口硬化缺失

`renderer-event-bridge.ts` 创建 BrowserWindow 时设置了 `contextIsolation/nodeIntegration/sandbox`（✅），但缺少 Electron 安全清单的其余标准项：

- 没有 `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`
- 没有 `will-navigate` 拦截（防止渲染进程被导航到外部 URL）
- 没有 `will-attach-webview` 处理

CSP + sandbox 已经挡掉了大部分利用路径，但这些是零成本的纵深防御，且 `test:security` 目前也没有断言它们。

### P1-11 格式化门禁缺失

`npm run format:check` 当前 **71 个文件不通过**，涉及 renderer stores、contracts、shared 等。脚本存在但 `ci.yml` 不执行它（只跑 typecheck / lint / test:unit / build / security baseline）。

**建议：** 先 `npm run format` 全量修一次，再把 `format:check` 加进 CI 的必过步骤。

---

## 4. P2 — 改进项

### 资源与生命周期

| # | 问题 | 位置 |
| --- | --- | --- |
| P2-1 | `retentionService` / `dispatchService` / `iterationController` / `fullWorkflow` 没有 dispose，事件订阅在关闭时不释放 | `runtime/compose.ts:942-955` |
| P2-2 | `workflowEngine.dispose()` 里 `void engine.cancel(runId)` 不 await，紧接着就 `database.close()`——cancel 的后续写会打到已关闭连接（被 `execute()` 吞成错误日志） | `workflow-engine.ts:745-748` + `compose.ts:953` |
| P2-3 | `auditedCommands` Map 按 runId 无界增长，只在 `dispose()` 清 | `permission-manager.ts:134` |
| P2-4 | `run-log-store` 的 `nextSequences` Map 同样只增不减 | `run-log-store.ts:118` |
| P2-5 | `workspaceManager.remove(id)` 不清理 Credential Store 里 `workspace/<id>/*` 的条目；`divertEnvSecrets` 中途失败会留下半写入的 secret | `workspace-manager.ts:133-164, 246` |
| P2-6 | `command-runner` 的 maxBuffer 溢出路径：`settle` 幂等但 `killProcessTree` 不幂等，后续 chunk 会重复触发（Windows 上重复 spawn `taskkill`） | `command-runner.ts:251-265` |
| P2-7 | `paths.worktreeRoot()` 是死代码（worktree-manager 自己用 `resolveDataRoot()` 拼路径） | `paths.ts:183-188` |

### 类型与工具链严格度

- **P2-8 `tsconfig.base.json` 只开了 `strict`。** 代码风格其实已经在按 `exactOptionalPropertyTypes`（满屏 `...(x === undefined ? {} : { x })`）和 `noUncheckedIndexedAccess`（`records[index] as string`、`sorted[sorted.length - 1]`）写了。**开启这两项几乎零迁移成本，却能把一批"目前靠约定"的不变量变成编译期保证。**
- **P2-9 ESLint 没开 type-aware 规则集**（只有 `tseslint.configs.recommended`）。缺失的 `no-floating-promises` / `no-misused-promises` / `await-thenable` / `require-await` 正好是这个代码库的高危区——到处是 `void p.then(...)`、async 事件回调、`Promise` 返回值被忽略。建议至少加 `recommendedTypeChecked`。
- **P2-10 `packages/shared` 缺边界防护。** `contracts` 有 `no-node-builtins.test.ts` + ESLint 专用块，`shared` 两者都没有——而 `security/baseline.test.ts:73` 已经把 `@teskra/shared` 放进了 preload 的 import 白名单。应补齐对称的约束。

### 测试与 UI

- **P2-11 React 组件层零单测。** 25+ 个 `.tsx` 没有任何单测（stores 和纯函数的覆盖率很高，这是有意的分层设计，可以接受）；但 E2E job 是 `continue-on-error`，所以 UI 回归当前没有任何合并门禁拦得住。建议在 E2E 稳定后提升为门禁，这是 `ci.yml` 注释里已经写明的计划。
- **P2-12 整棵 React 树没有 ErrorBoundary。** 任何渲染异常直接白屏，`main.tsx` 也只有一个 root 挂载。

### 发布与打包

- **P2-13 没有发布/更新通道。** `electron-builder.yml` 的 `publish: null`；`release.yml` 只把产物上传成 GitHub Actions artifact，不创建 Release；没有 autoUpdater。**安全补丁无法触达已安装的用户。**
- **P2-14 `nsis` 配置自相矛盾：** `oneClick: true` 与 `allowToChangeInstallationDirectory: true` 互斥（后者要求 `oneClick: false`），当前后者被静默忽略。
- **P2-15 `RELEASE_NOTES.md` 模板固定输出 `## 已知问题\n- TODO`**，会原样进发布包（`scripts/release.mjs:163-165`）。
- **P2-16 版本号四处硬编码：** `preload/index.ts:27` 的 `appVersion: '0.1.0'`、`compose.ts:842` 的 `options.appVersion ?? '0.1.0'`、两个 `package.json`。发布脚本通过 `-c.extraMetadata.version` 注入，**preload 里那份必然过期**（`window.teskra.appVersion` 会永远是 0.1.0）。

### 细节 bug

- **P2-17** `retention-service.ts:409` 的审计信息用 `file.split('/').pop()` 取 basename，硬编码 POSIX 分隔符——在目标平台 Windows 上拿到的是整条路径。
- **P2-18** `matchCommandPattern` 的"词边界"依赖用户写成 `rm *`（带空格）；写成 `rm*` 会命中 `rmdir`，与 `permission-manager.ts:56-60` 的注释描述不符。
- **P2-19** `config-service.ts:87-101` 的 `deepMerge` 会把 JSON 里的 `__proto__` 键交给 `result[key] = ...` 赋值。经核查**不构成全局原型污染**（`deepMerge` 返回新对象，不改 `Object.prototype`），但依赖了非显而易见的推理。建议显式跳过 `__proto__` / `constructor` / `prototype`，把安全性变成一眼可见的。
- **P2-20** contracts 里所有 `z.string()` 都没有 `.max()` 上限，`cols`/`rows` 只有 `.int().positive()` 没有上界。渲染进程是唯一调用方，所以不是攻击面，但一个 UI bug 传入 `cols: 1e9` 会直接打到 `pty.resize`。

---

## 5. 文档一致性问题（单列，因为这个项目的文档是给 AI Agent 读的）

> **状态：本节已于 2026-09-12 全部处理**（只改文档与注释引用，未改任何代码逻辑）。
> 下面保留原始发现，并在每条后标注实际做法。

1. **`AGENTS.md` 的项目状态严重过期。** 开头写「**当前仓库状态：工程骨架已建立（TASK-001 完成）**」，实际是约 39k 行生产代码、93 个 TASK 基本完成的完整应用。这是每个 AI 编码 Agent 读的第一份文件，会直接导致错误的上下文假设。
   → **已修复**：改写为实际状态，并加了「不要把本仓库当成空骨架」的明确提示 + 指向本文档的待修项入口。

2. **`docs/teskra-tasks.md` 的 484 个验收复选框全部未勾选**（`- [x]` 计数为 0）。而 AGENTS.md 的 Definition of Done 要求「验收标准全过」。任务追踪与现实完全脱节。
   → **部分处理**：未代为勾选（无法逐条核验 484 项验收标准，在唯一权威文件里伪造完成状态比现状更糟）。改为在文件顶部加了显著的「复选框状态说明」，讲明复选框未维护、不可当进度信号读、判断落地与否以代码+测试+git history 为准。**逐条回填或改成纯列表，需要项目方决定。**

3. **ADR 编号冲突：** `docs/decisions/0007-criteria-set-task-nullable.md` 与 `docs/decisions/0007-persist-agent-run-mode.md` **同为 0007**，日期同为 2026-09-12，一份中文一份英文，头部格式也不一致（`- 状态：Accepted` vs `## 状态`）。`AGENTS.md` 的 ADR 清单只列了前者。
   → **已修复**：按落地时间先后定序——`persist-agent-run-mode`（12:12，migration 009）保留 **0007**，`criteria-set-task-nullable`（16:38，migration 010）改为 **0008**（`git mv`）。这样 ADR 编号与 migration 编号顺序也对齐了。0007 的头部统一成其余 ADR 的模板（`- 日期：` / `- 状态：`）。指向 criteria-set 的 11 处 `ADR-0007` 引用（plan、SQL、contracts、repository、manager、测试注释）已逐行改为 `ADR-0008`；指向 launch-mode 的 9 处保持 0007 不变。AGENTS.md 与 tasks 文档的 ADR 清单补齐 0006/0007/0008，并留了旧编号的对照说明。

4. **`AGENTS.md` 技术栈写了 `simple-git`**，实际未安装该依赖，所有 git 操作走 `CommandRunner` + git CLI。
   → **已修复**：改为 `git CLI（经 CommandRunner 调用；未引入 simple-git）`。

5. **ADR-0004 说 handoff / artifacts 在 `<repo>/.teskra/`**（`worktree-manager.ts:68` 的 `.git/info/exclude` 条目也是按这个写的），但实现把它们放在 `~/.teskra/runs/<runId>/`。因此那两条 exclude 条目实际上排除了一个从不存在的目录。
   → **已修复**：ADR-0004 加了 2026-09-12 修订段，写明实际路径由 `paths.runFiles()` 解析为 `<dataRoot>/runs/<runId>/`，并说明契约本身不变、exclude 条目降级为纵深防御。AGENTS.md 的对应条目同步。**注意该修订段同时点明了 `<dataRoot>` 与 `resolveDataRoot()` 在 WSL 下不等价，指回本文档 P0-1——这是文档修复无法覆盖的代码缺陷。**

6. **workflow YAML**：见 P1-8。
   → **已修复（文档侧）**：AGENTS.md 与 tasks 文档都写明「接受 `.yaml`/`.yml`/`.json` 扩展名，但只用 `JSON.parse`，真正的 YAML block 语法会被拒绝」。**引入 `yaml` 依赖仍是待办**（P1-8 保持开启）。

---

## 6. 建议的处理顺序

**第一批（阻塞发布）**
1. P0-1 WSL 运行期契约（需要配套的 Windows 实机验证）
2. P0-2 退出时终止子进程 + 重启时按 pid 回收
3. P0-3(1) ConfigService 对 workspace 层做 group allowlist（最便宜的那一半）
4. P0-4 `startRun` 改为立即返回

**第二批（发布前应修）**
5. P1-3 permission scope 语义（承诺与行为相反）
6. P1-11 + P2-8 + P2-9 工具链收紧（format 门禁、TS 两项严格选项、type-aware lint）——一次性投入，长期收益
7. P1-8 引入 `yaml` 解析依赖（文档侧已说明现状，代码侧仍待办）
8. P1-7 删除路径归属校验

> ~~文档一致性（第 5 节）~~ —— 已于 2026-09-12 处理完毕，详见第 5 节各条的「已修复」标注。
> 唯一遗留：`teskra-tasks.md` 的 484 个复选框是否逐条回填，需项目方决定。

**第三批（体验与性能）**
9. P1-1 + P1-2 输出热路径（Agent fsync 降频 + 终端 batching + 去掉二次缓冲）
10. P1-5 + P1-6 大 payload 分页
11. P1-4 审计提取规则（或如实收窄 ADR-0002 的承诺）
12. P1-9 错误信息国际化
13. P0-3(2)(3) Workspace Trust 完整方案

**第四批**
14. P2 其余项、P2-13 发布通道

---

## 附：本次 review 的覆盖方式

逐文件阅读了 `apps/desktop/src/main/` 全部 60+ 个生产模块、`preload/`、`renderer/` 的入口与 stores/terminal/i18n、`packages/contracts` 与 `packages/shared` 的关键 schema、`scripts/` 全部、`.github/workflows/` 全部、`eslint.config.mjs` 与全部 tsconfig、`electron-builder.yml` / `electron.vite.config.ts`、以及 `AGENTS.md` / `README.md` / `docs/decisions/`。并实际执行了 typecheck / lint / test:unit / format:check 四项基线。

未覆盖：Windows + WSL2 实机行为（本次在 WSL2/Linux 上进行，P0-1、P0-2 的具体表现需要实机确认）、Playwright E2E 实跑、`docs/teskra-implementation-plan-v2.md` 的逐节比对。

---

## 7. 修复状态（2026-09-12，第二批）

> 本节标注代码侧修复结果。除注明「未做」的条目外，其余均已实现并补测试；
> 修复后基线：`typecheck` / `lint`（含 type-aware 规则）/ `format:check` /
> `test:unit`（139 文件 1300+ 用例）/ `build` / `test:security` 全绿。

**P0 — 已修复**

- **P0-1 已修复（代码侧）**：`workspace/runtime.ts` 新增 `resolveRuntimePath()`（复用
  `wsl-paths.ts` 做 `C:\…` → `/mnt/c/…` 换算）与 `resolveSpawnEnv()`（WSL runtime 自动生成
  `WSLENV` 声明并与宿主合并）；`ProcessManager.start` 统一走 `resolveSpawnEnv`，Agent /
  Terminal 的 env 全部穿透 WSL 边界；`cli-agent-adapter` 在启动边界对 handoff / artifact /
  `--settings` 路径做 runtime 换算。run 目录保持在宿主数据根（宿主侧 RunLogStore /
  HandoffCollector / ArtifactStore / Retention 路径不变），采用文档建议中「WSL 侧路径直传」
  的等价选项。**[Windows 验证] 待办**：WSLENV 穿透、handoff `parse_status: 'ok'`、
  Claude `--settings /mnt/c/…` 实机确认。
- **P0-2 已修复**：`ProcessManager.disposeAll()` 走 interrupt → terminate → kill 阶梯；
  `AgentManager.dispose()` / `TerminalManager.dispose()` 改为先停进程；`compose.dispose()`
  async 化并在关库前 await 全部清理；`before-quit` await dispose。新增
  `process/host-processes.ts`（POSIX `kill(pid, 0)` / Windows `tasklist`·`taskkill`，经
  CommandRunner），Reconciliation 按 pid 探测：幸存进程终止后标 interrupted、终止失败则
  不改状态（杜绝 resume 双写）。**[Windows 验证] 待办**：tasklist/taskkill 分支与退出无残留。
- **P0-3 部分修复**：(1) 已完成——ConfigService 加载/写入 workspace 层时剥离 global-only
  组（`agents`），复用 stripSecrets 告警机制，即使将来 `resolve({ workspaceId })` 也无法生效。
  **(2) Workspace Trust 闸门与 (3) shell 步骤执行前确认未做**（属独立 Task）。
- **P0-4 已修复**：`workflowEngine.begin()` 同步校验后立即返回 run 快照，IPC `startRun`
  不再 await 整轮 pass，推进完全走 `workflow.run_updated` / `workflow.step_updated` 事件。

**P1 — 全部已修复**

- P1-1：run-log-store 重写（长驻句柄、fsync 每文件 1s 节流 + 生命周期转换点强制、
  manifest 不随输出批次重写、events.jsonl 增量校验、prepared statement 缓存）。
- P1-2：终端输出主进程侧 32ms 合批；renderer history 改环形 chunk 数组，仅回放时 join。
- P1-3：`permission_rules` 表收窄为纯 persistent 存储——`listApplicableRules` 过滤、
  `createRule`/`updateRule` 拒绝非 persistent 并导向 `recordDecision`，遗留行惰性化。
- P1-4：审计提取改为有状态行缓冲（跨 chunk 拼接）；各 Agent TUI 格式做成
  `AgentDefinition.auditCommandPatterns`（Claude `⏺ Bash(...)`、Codex `exec` 行）；Codex
  交互式全屏 TUI 为明示缺口，已写入 ADR-0002 修订与 Settings 文案。
- P1-5：变更列表 = status + 2 次批量 numstat（常数 3 次 spawn），patch 经新 IPC
  `git.filePatch` 按选中文件懒加载。
- P1-6：`readOutput` 改从 terminal.log 尾部按字节读（`tailBytes` 可选参数，向后兼容），
  仅日志被 GC 后回退 SQLite 重建。
- P1-7：retention 删除前断言 runDir 位于 `paths.home()/runs` 之下（realpath 防符号链接
  逃逸），越界跳过并记审计/日志。
- P1-8：引入 `yaml@2.9.1`，按扩展名分派解析（`.yaml`/`.yml` 走 YAML 1.2，`.json` 走
  JSON.parse）；AGENTS.md / tasks 文档已同步。
- P1-9：`PublicAppError` 增加 `messageKey` + `params`（`message` 降级为 fallback），覆盖
  workspace / agent / terminal / git / workflow / recovery 高频路径 36 个 key（en/zh 双向），
  并有测试强制 Main 侧每个 messageKey 必须存在于字典。
- P1-10：`setWindowOpenHandler(deny)` / `will-navigate` 策略拦截 / `will-attach-webview`
  拒绝，源码级与产物级（assert-security-baseline）双层断言。
- P1-11：全量 `npm run format` 已执行，`format:check` 加入 CI 必过步骤。

**P2 — 已修复 18 项，未做 2 项**

- 已修复：P2-1（四服务补 dispose）、P2-2（engine.dispose await cancel）、P2-3/P2-4（按
  runId 清理 Map）、P2-5（credential 清理 + divert 回滚）、P2-6（kill 幂等）、P2-7（删除
  死代码 `paths.worktreeRoot()`——语义不等价，worktree 需 runtime 侧根）、P2-8（开启
  `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`，修 196 处）、P2-9（type-aware
  lint：四条 Promise 核心规则全开，修 3 处 floating-promises 真 bug 等；
  `unbound-method` 全仓库关闭、测试文件关闭 unsafe 系列，理由见 eslint.config.mjs 注释）、
  P2-10（shared 补 ESLint 块 + no-node-builtins 测试）、P2-12（ErrorBoundary + i18n）、
  P2-14（保留 oneClick，删 allowToChangeInstallationDirectory，理由在 yml 注释）、
  P2-15（release notes 为空省略「已知问题」节，新增 `--known-issues` flag）、
  P2-16（版本单一来源：`__TESKRA_APP_VERSION__` define 注入 main/preload，release 链路对齐）、
  P2-17（`path.basename`）、P2-18（`rm*` 不再命中 `rmdir`）、P2-19（deepMerge 显式跳过
  `__proto__`/`constructor`/`prototype`）、P2-20（IPC 入参 schema 加长度/维度上限，
  存储 schema 不动）。
- **未做**：P2-11（E2E 提升为合并门禁——需 Windows 实机验证后由项目方决定）、
  P2-13（发布/更新通道——独立 Task，涉及 autoUpdater 与 Release 流程设计）。

**遗留 follow-up**（修复过程中发现，超出原文档条目）

1. `dispatch-service.ts` 渲染 prompt 时仍把宿主形态 handoff/artifact 路径写进 prompt 文本
   （env 契约已修复，prompt 字面路径在 WSL 下与 env 不一致）。
2. P0-1 / P0-2 的 Windows + WSL2 实机验证项（见上），本机 Linux 无法完成。

## 8. 第三轮 Review 修复状态（2026-09-12）

> 本轮 5 项（2 P0 + 3 P1）已修复并补测试；3 项 P2 按评估延后，记录在案。

**已修复**

1. **刷新后 diff 面板永久空白**（changes-page）：refresh 清空 patches 缓存但保留
   selectedPath，effect 依赖不变不再拉取。现将「该 path 的 patch 是否已缓存」纳入
   依赖（`selectedPatch` 门控），loadPatch 自身的双重去重保证多触发安全。
2. **按 pid 杀进程缺身份校验**（reconciliation）：新增 migration 011
   `agent_runs.pid_identity`（进程启动时间令牌：Linux `/proc/<pid>/stat` field 22、
   macOS `ps -o lstart=`、Windows PowerShell `Get-Process .StartTime`，经
   `HostProcessControl.identity()` 在启动时捕获）；reconciliation terminate 前比对，
   令牌不匹配/进程已消失一律按已死处理（`none`），不再 terminate；无令牌的遗留行
   回退原 probe-only 行为。**[Windows 验证] 待办**：PowerShell 分支仅有 stub 单测。
3. **未跟踪文件 numstat 无并发上限**（diff-service）：`--untracked-files=all` 下每个
   未跟踪文件 fork 一个 git 进程。新增 `mapWithConcurrency` 闸（上限 8），测试断言
   并发峰值受限。
4. **dispose 取消集合与等待集合不一致**（dispatch / full-workflow /
   iteration-controller）：三个服务统一加 `disposing` 标志——dispose() 先同步置位再
   做取消快照；尚在准备阶段（卡在 worktree 创建、尚未进入取消集合）的执行在
   WorkflowRun 创建前检查标志并中止（dispatch / full-workflow 丢弃 worktree 返回
   shutting-down 错误，iteration-controller 直接拒绝新 iterate），消除 before-quit
   卡死窗口。各有竞态回归测试。
5. **flushAll 时序窗口**（agent-manager）：`outputBatcher.flushAll()` 从 cancel 之前
   挪到退订（stopOutput/stopCommand/stopExited）之后、`runLogs.disposeAll()` 之前——
   订阅是 batcher 唯一推送源，退订后不再有 32ms 定时器能在日志句柄关闭后触发。
   测试断言 cancel 过程中产生的输出最终落盘。

**延后（P2，未修）**

6. `retention-service.ts` ownsRunDir 用 realpath 过的 root 对比未 realpath 的 target，
   data root 为符号链接时会漏删自己的 run 目录。
7. `run-log-store.ts` tail 读取只剥一个 U+FFFD，截断点落在 3/4 字节序列中间时会
   残留 2~3 个替换字符。
8. `permission-manager.ts` 尾部 `*` 单词边界判定会打断 `npm run test*` 这类 token
   中间的前缀匹配（仅影响审计日志的规则归因，放行逻辑不经此函数）。

## 9. 第四轮 Review 修复状态（2026-09-12）

> 针对第三轮修复本身的复审。3 项已修复并补测试；3 项延后，记录在案。

**已修复**

1. **identity 的 await 重开终态窗口**（agent-manager）：`launch()` 在
   `isTerminal(afterStart)` 守卫与 `runs.update({status:'running'})` 之间插入的
   `await identity()`（macOS/Windows 要 spawn ps/PowerShell，是真实事件循环让出）
   重开了进程在守卫后退出、run 被写回 running 的窗口。await 之后重做一次终态
   检查（`afterIdentity`），命中直接返回终态 run。测试模拟 identity 挂起期间
   process.exited 先到，断言 run 保持 failed。
2. **identity 失败没回退 probe**（reconciliation）：带 token 的 run 把 identity()
   当成唯一存活判据，读取失败（spawn 超时、PowerShell 不可用）被当作已死——活着
   的幸存 Agent 不被 terminate，run 标 interrupted 后可 resume → worktree 双写。
   现 `!identity.ok` 降级到 legacy probe() 分支（probe 活着则按降级校验 terminate，
   probe 死了才按已死处理）。identity 返回 null / 令牌不匹配仍按已死处理不变。
3. **面板空白只修了一半**（changes-page + git-store）：门控换 selectedPatch 只覆盖
   「refresh 清缓存」；「在途 fetch 被 generation 检查作废」与「IPC !ok 只 set
   error」两条路径下 selectedPatch 恒为 undefined、effect 不再触发。修复：
   (a) store 暴露 `refreshCount`（每次完成 refresh 与清缓存同一个 set 内递增），
   纳入 effect 依赖，下个 refresh 周期自动重试未缓存的 patch；(b) loadPatch 在
   finally 中发现 generation 已过期时在最新 generation 下自发重发（re-issue），
   不依赖 effect 再次触发。两条路径各有 store 级测试。

**延后（可下轮处理）**

4. Windows `identity()` 把「stdout 为空」一律映射成 null（进程已消失）；但
   Get-Process 成功、StartTime 因权限读不到时同样 exit 0 + 空 stdout，活进程被
   判死。应让脚本在「进程存在但 StartTime 不可读」时输出可区分标记。
5. diff-service 未跟踪文件总数仍无上限：2 万个 `??` 条目 = 2 万次 git spawn 且
   每次 refresh 重来。可比照 renderer 的 500 条上限加数量闸，超出记 0/0。
6. Linux identity token 用 /proc/<pid>/stat field 22（自 boot 起的时钟滴答），不含
   boot 标识，未真正覆盖「重启后 pid 复用」；macOS/Windows 用绝对时间，三平台语义
   不一致。拼上 /proc/sys/kernel/random/boot_id 即可对齐。

## 10. 第五轮 Review 修复状态（2026-09-12）

> 对第四轮修复的复审（含对第四轮第 2 项建议本身的纠正）。4 项全部修复并补测试。

1. **identity 失败回退 probe = 恢复任意杀进程**（reconciliation，纠正第四轮的
   错误建议）：identity() 失败在 Windows（PowerShell 被策略禁用）/macOS（启动期
   ps 超时）上是系统性的，回退 probe 会让每个 run 都走「探活即杀」，pid 复用时
   taskkill /T /F 端掉无关进程树。正确的第三态是「未知」：identity 读不出来时
   run 保持 active（survivingRunIds），不杀、不标 interrupted、不会被 resume，
   等人工处理；legacy（无 token）行继续走 probe 不变。docblock 已同步改写。
2. **重发用全局 generation 串工作区**（git-store）：refreshGeneration 是闭包内
   单计数器，任何工作区的 refresh 都会 bump；旧工作区在途 loadPatch 的重发会把
   diff 写进只按 path 建键的 patches，切工作区后面板安静显示另一个工作区的
   diff。修复：patches 一律按 `${workspaceId} ${path}` 建键（与 patchInFlight
   一致），changes-page 三处查找同步改造。
3. **重发无上限、不校验选中**（git-store）：refresh 节奏快过一次 fetch 时重发会
   自我维持且离开页面也停不掉。现重发限一次（patchRetried 记录，成功后释放），
   且仅当 `selectedPath === path` 时才重发。
4. **失败的 patch 让错误关不掉**（changes-page/git-store）：refreshCount 依赖使
   持续失败的 filePatch 每个 refresh 周期重试并覆盖 clearError()。现失败 path 进
   patchFailedPaths 标记、不再自动重试；显式 selectFile（用户重新点击）或一次
   成功 fetch 会解除标记。

## 11. 第六轮 Review 修复状态（2026-09-12）

1. **'alive' 的 run 是无出口僵尸**（agent-manager）：reconciliation 留下的 active
   run 在本实例没有 adapter 绑定——cancel() 返回 PROCESS_NOT_FOUND、resume() 只接
   interrupted、并发额度与 attended 写冲突永久占用。现 cancel() 对「非终态且无
   adapter 绑定」的 run 直接落 cancelled（终态、不可 resume，不引入双写），释放
   并发槽；terminate 失败留下的老 'alive' 分支同路修复。原
   `errorMessage.agentRunNoActiveProcess` 文案已无用，字典同步删除。
2. **失败标记漏 workspace 维度**（git-store）：patchFailedPaths 按裸 path 建键，
   workspace A 拉失败后同仓 worktree 的 workspace B 同名文件被误伤（不发 IPC、
   面板长期空白）。标记改为 `${workspaceId} ${path}` 建键。
3. **「显式重选可重试」在 UI 上做不到**（git-store/changes-page）：裸 Set 清除不
   触发订阅，重复点击同一文件 selectedPath 不变、effect 永不重跑。失败标记移入
   store state（`patchFailures: Record<string, true>`），selectFile 清除是状态
   变更；changes-page 把当前 patch 的失败标志纳入 effect 依赖，清除后 effect
   自然重跑。changes-page 注释同步更新。

## 12. 第七轮 Review 修复状态（2026-09-12）

> 针对第六轮 cancel() 新分支的复审，两项均已修复并补测试。

1. **释放并发槽却没推进队列**：新分支漏调 `scheduleQueueAdvance()`（queued 分支
   有）。僵尸 run 在本实例没有进程，process.exited 永远不会补这一脚，queued 的
   后续 run 会卡到用户手动操作别的 run。已在 synchronizeTaskStatus 后补上；测试
   用 maxGlobalRuns=1 + adapterless active run 验证取消后队列推进。
2. **落终态前没有任何终止尝试**：reconciliation 留 'alive' 的 run 被 cancel 落
   cancelled 后退出 listActive()，unisolatedWriteConflict 就看不见它，用户可立即
   在同一非隔离工作区再起 attended run——若上一实例的 agent 进程其实还活着，就是
   P0-2 要防的双写。hostProcesses 依赖放宽为 `Pick<..., 'identity' | 'terminate'>`，
   落终态前做一次带身份校验的 best-effort 终止：identity 读得出且与
   run.pidIdentity 相符才 terminate，读不出/不匹配跳过（不乱杀）；终止成败都照常
   落 cancelled（兑现用户取消意图）。测试覆盖：令牌相符 → terminate 被调；读取
   失败/令牌不匹配 → 不 terminate 但仍落 cancelled。

## 13. 第八轮 Review 修复状态（2026-09-12）

1. **落终态前的 await 打破分支原子性**（agent-manager）：adapterless cancel 分支
   从 isTerminal 检查到写 cancelled 原本全程同步，两次 cancel 被事件循环天然串行
   化；中间插入 `await identity()`（macOS/Windows spawn ps/PowerShell，上限 5s）
   后，第二次 cancel 同样过守卫、同样 park，两边都会走完整 settle——agent.cancelled
   durable 事件、handoff collect + review ingest（无幂等保护）、closeRunLogs、
   emit 全部双份。修法与 launch 一致：await 之后重做一次终态检查（afterIdentity
   守卫），只有一方进入 settle。测试：两个并发 cancel 都 park 在 identity 上，
   释放后断言两者均返回 cancelled 但 agent.cancelled 只 emit 一次。

## 14. 第九轮 Review 修复状态（2026-09-12）

1. **重复的 terminate() 没被消掉**（agent-manager）：第八轮的事后守卫放在
   identity/terminate 块之后，并发的两个 cancel 仍会各调一次 terminate(pid)——
   第一次 terminate 成功让 OS 回收 pid 后，第二次可能落在刚复用该 pid 的无关新
   进程上（Windows 复用更激进）。改为**在 await 之前认领**：新增
   `adapterlessCancels` in-flight map，第二个调用者直接 await 第一个的同一个
   Promise；settle 主体抽成 `settleAdapterlessCancel`（每 run 至多执行一次），
   第八轮加的事后终态守卫随之撤掉。测试更新为认领语义：并发两个 cancel 共享
   一次执行——identity / terminate / agent.cancelled 各恰好一次，两者拿到同一
   cancelled 结果。
