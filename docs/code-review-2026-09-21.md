# Teskra Milestone 24 Code Review — 2026-09-21

- 范围：Milestone 24「多订阅账号与 Agent Profile」（TASK-094～118），即 `941bc6e..04f152f` 共 25 个 commit、162 个文件、约 2.2 万行
- 对照依据：`docs/teskra-tasks.md` Milestone 24（验收标准唯一权威）、`docs/teskra-multi-account-subscription-implementation.md`（设计说明）、ADR-0009 / 0010 / 0011、plan §139.1（Schema）
- 基线状态（本次实测，Windows 11 主机）：

| 检查                      | 结果                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`       | ✅ 通过（desktop / contracts / shared）                                                                                                                                                                    |
| `npm run lint`            | ✅ 通过                                                                                                                                                                                                    |
| `npm run format:check`    | ✅ 通过                                                                                                                                                                                                    |
| `npm run check:task-docs` | ✅ Milestone 24 与设计文档 §59 一致                                                                                                                                                                        |
| `npm run test:unit`       | ⚠️ 181 文件 / 1939 用例通过，**1 失败**：`process/host-processes.test.ts:40` 用 `hostPlatform: 'linux'` 读 `/proc/<pid>/stat`，在 Windows 上必然得到 `null`。属环境依赖，文件最后改动早于本 Milestone，与本功能无关 |

---

## 0. 总体结论

**实现质量高，与设计文档的贴合度是逐字级的。** 三个 migration 与 plan §139.1 逐列一致且每条约束都有「让它失败」的测试；§13.1/§13.2 的分层防御（节点 env → alias manager → AgentManager → Profile env 最后写）、§19.5 的 survivor 判定复用、§48.2 的 runtime-aware 所有权校验（WSL 内 `realpath -m` / `mkdir -p --` / `rm -rf --` 走 argv 数组、建前建后各校验一次）、§10.5 的 Codex resume 漂移检查，全部按设计落地并有测试。IPC 23 个新 channel 在 contracts / preload / router / facade 四处完全一致，请求全部 `strictObject`。

**但有三处已核实的阻塞级缺陷，都属于「能力存在但在真实路径上失效」，任一条都会破坏 §66「不串号」的承诺：**

| 级别    | 数量 | 摘要                                                                                                                                                   |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0 阻塞 | 3    | Windows 保留 env key 大小写绕过（实机复现）、仓库 workflow 的 alias 字段从未到达引擎、`failAndStop` 在 `preparing` 窗口泄漏进程并双写 worktree           |
| P1 重要 | 11   | 并发幂等、文本分类误标 limited、limited 无 `limitedUntil` 永不恢复、resume 已禁用 Profile、WSL 未知 home 建出字面量 `~` 目录、shell 确认无超时/重投递/审计、两处 UI 偏离规范等 |
| P2 改进 | 16   | 守卫不对称、路径规范化、重复代码、测试缺口、错误码                                                                                                     |
| 流程    | 2    | 155 个验收项全部未勾选；`[Windows 验证]` 项无记录                                                                                                      |

---

## 1. 做得好的地方（重构时不要弄丢）

1. **Schema 与约束是「可证伪」的。** 012/013/014 的 DDL 与 plan §139.1 逐列一致；partial unique index、两个 CHECK、复合 PK、FK `NO ACTION`、弱引用，每一条都有一个让它触发失败的测试（`account-profile-migrations.test.ts`、`schema.test.ts`）。场景 G（删 Profile 后历史 Run 存活）有专门测试。
2. **创建顺序严格按 §48.1：** 纯路径解析 → INSERT（唯一索引作并发守卫）→ mkdir → 失败补偿删除，且有真正的并发创建测试。`paths.ts` 把「解析」与「创建目录」拆开，让 Manager 可以先 INSERT。
3. **§17.0 在主路径上被真正遵守：** `process.exited` 只在 `status === 'failed'` 时分类；`classifyOutput` 没有生产调用方；`quota-mention.json` 负向场景证明运行中文本匹配不改任何状态。evidence 先脱敏再截断到 512，Zod 契约层再限一次。
4. **一套 survivor 判定被 reconciliation 与 continuation 共用**（`process/survivor.ts`），§19.5「not found ≠ 进程已死」没有写第二份 pid-identity 逻辑。`failStopIntents` 预登记干净地解决了 ADR-0010 §6「Teskra 主动停的 Run 一律变 cancelled」的问题。
5. **历史身份恢复彻底：** snapshot 优先、行已删则用 snapshot 合成、两者都没有 configHome 时显式报错，每个分支有测试；Codex Profile Run 禁用 `--last` 并做漂移检查。
6. **§24.1 端到端成立：** 渲染层只提交 `{ profileId }`，router 测试证明多带一个 `command` 字段会被拒；登录终端复用既有 xterm binding，卸载时取消（含 start 尚未返回的竞态）。
7. **§48.1 在契约层结构化：** managed 创建拒绝 `configHome`，update 请求根本没有该字段，而不是靠 UI 纪律。
8. **信任门单点决策**（`workspace/trust.ts`），config / prompts / workflows / review panel 一致复用，每次跳过都有 security 日志；migration 015 让存量行默认 `restricted`。
9. **i18n 完整：** en-US / zh-CN 各 682 键，零缺失；渲染层零 Node 内置引用。

---

## 2. P0 — 阻塞项

### P0-1 Windows 下保留 env key 可被大小写绕过（已实机复现）

§13.2 要求 `workspace.env` / `request.environment` / Workflow env 里出现 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 必须拒绝。实现按精确大小写比较：

- `apps/desktop/src/main/agents/accounts/reserved-env-keys.ts:27-28`：`new Set(reservedKeys)` + `reserved.has(key)`，`codex_home` 不会被拒。
- 同文件 15-17 行的注释断言「Windows 上 node-pty 把 Profile 自己的写法最后写入，所以必赢」。这个断言不成立：`cli-agent-adapter.ts:86-98` 的对象展开只对**同大小写** key 去重，`codex_home`（来自 workspace.env，先插入）与 `CODEX_HOME`（来自 profileEnvironment，后插入）会一起进入 env 对象；`process-manager.ts:295-298` 再展开进 node-pty；node-pty 的 Windows 实现按插入顺序序列化 env block，不去重，Windows 的环境变量查找不区分大小写且取第一个匹配。

**实机验证**（本机，`ELECTRON_RUN_AS_NODE=1` + 仓库内的 node-pty，`cmd /c echo %CODEX_HOME%`）：

```text
env = { ...base, codex_home: 'SMUGGLED', CODEX_HOME: 'PROFILE' }  →  CODEX_HOME=SMUGGLED
env = { ...base, CODEX_HOME: 'PROFILE', codex_home: 'SMUGGLED' }  →  CODEX_HOME=PROFILE
```

即在 windows runtime 上，一份 untrusted workspace 配置写 `codex_home` 就能把 Run 指向另一个账号的 Home，两道防线（拒绝 + Profile 最后写）同时失效。`profile-alias-manager.ts:252-259` 的第三道 workflow 检查有同样缺口。现有测试（`agent-manager-account-profiles.test.ts:417/435/450`、`account-profile-security.test.ts:285`）只用了精确大小写的 key。

**修法：**

1. `assertNoReservedEnvKeys` 两侧统一 `toUpperCase()` 后比较（Linux/WSL 拒绝 `codex_home` 无害）。
2. `processEnvironment` 在展开 `profileEnvironment` 之前，删除任何与其 key 大小写不敏感冲突的既有 key。
3. 新增测试：windows runtime 上 workspace.env / request.environment / workflow 节点 env 携带 `codex_home` 均被拒；并标 `[Windows 验证]`。

### P0-2 仓库 workflow 的 `accountProfile` / `profile` / `env` 从未到达执行引擎

TASK-111 / ADR-0011 的核心是仓库里的 `full.yaml` 能写 `accountProfile: work`。实际链路：

- `full-workflow-service.ts:176-187` 读取 repo-local `full` 覆盖后调用 `extractFullWorkflowConfig`。
- `default-workflow.ts:180-216`：`extractFullWorkflowConfig` 只返回 `{ implementer, reviewers, testCommand }`；`buildDefaultFullWorkflowDefinition`（78-96 行）重建的 agent 节点只有 `agent` / `role` / `runOn`。
- 另外两处建 Run 的地方（`dispatch-service.ts:305-312`、`iteration-controller.ts:325-326`）用的都是内置定义；`workflowRunStartRequestSchema` 只收 `runId`；渲染层没有任何地方调用 `workflow.loadDefinition` / `listDefinitions`（grep `apps/desktop/src/renderer/src` 为空）。

结果：definition-loader 正确解析并保留了 alias 字段（`compose.test.ts:663-716` 断言的正是这一点），但在进入引擎之前就被丢掉，Run 以 per-agent 默认账号（或 legacy 环境）启动，**没有任何报错**。这正是 §37.1 / ADR-0011 §4 禁止的静默回退。`workflow-engine.ts:325-357` 与 `profile-alias-manager.ts` 的解析逻辑本身正确，但只被手工构造的定义测试过。同理，§13.2 对「Workflow 声明的 env」的拒绝对真实仓库内容也不生效。

**修法：** 让 `FullWorkflowConfig` 携带 implementer / reviewer 节点的 `accountProfile` / `profile` / `env` 并透传到 `buildDefaultFullWorkflowDefinition`；或在 `extractFullWorkflowConfig` 发现覆盖里带了无法承载的字段时返回 `VALIDATION_FAILED`。补一条集成测试：仓库 `full.yaml` 写 `accountProfile: work` → `AgentManager.start` 收到绑定的 `accountProfileId`；未绑定 → Run 拒绝启动。

### P0-3 `failAndStop` 在 `preparing` 窗口把行写成 failed，进程泄漏且续跑 Run 同写一个 worktree

- `agent-manager.ts:641-651`：`launch()` 在 `await adapter.start(request)` 期间行是 `preparing`，`processId` / `pid` 要到 686-693 行才写入。
- `agent-manager.ts:1848-1916`：此时调用 `failAndStop`，`run.processId === undefined` 跳过 `stop()`；`terminateSurvivorProcess()` 因 `run.pid === undefined` 立即返回 `'none'`（`survivor.ts:150`）；`settleFailedStop` 把行写 failed、从 `activeAdapters` 删除；`continueWithProfile` 随即在同一 worktree 上 `start()` 目标 Run。
- `adapter.start` 返回后，`launch()` 在 652-656 行发现行已终态就直接 return，**不取消刚拉起的进程**（对比 704-707 行 `running` 写库失败时会 `adapter.cancel`）；之后的 `process.exited` 因 `!activeAdapters.has` 被忽略（1033 行）。

结果：两个 Agent 进程写同一棵 worktree，正是 §19.3 / TASK-107「source 进程确认退出后才创建 target Run」禁止的情形；泄漏的进程要到应用退出才被回收。

**修法：** (a) `launch()` 在 `adapter.start` 返回后若行已终态，先停掉刚起的进程再返回（镜像 704-707 行）；(b) `failAndStop` 把「`created` / `preparing` 且无 `processId`」视为启动进行中：等待 launch promise 或返回可重试的 `CONFLICT`。补测试：`adapter.start` 延迟返回期间调用 `failAndStop`。

---

## 3. P1 — 重要

### P1-1 并发 `failAndStop` 不幂等（§19.4）

`agent-manager.ts:1915` survivor 分支用 1824 行读到的 `run` 快照调 `settleFailedStop`，中间经过了 `stop()` 与 identity 探测两次 `await`；`settleFailedStop`（601-627）不重读。双击「Continue with another account」或 UI 的 failAndStop 与 continueWithProfile 重叠时，两次调用都能通过 1831 行的早退，第二次会再写一次 failed、再追加一条 `agent.failed` 持久事件、再发一次 `agent.failed`（→ 两次 `projectRunOutcome`、重复的 `agent.rate_limited` 审计行）。`stopped.ok` 分支（1873-1879）有重读，survivor 分支没有；`cancel()` 有 in-flight map（`adapterlessCancels`），failAndStop 没有。测试只覆盖串行幂等（`agent-continuation.test.ts:504`）。

**修法：** survivor 分支落库前重读；加一个与 `adapterlessCancels` 同构的 per-run in-flight promise map。

### P1-2 流程 B 用运行中的纯文本分类，并据此把 Profile 标为 limited

`agent-manager.ts:1928-1931` 对仍在运行的 source Run 调用 `classifier.classify({ outputTail })`，无退出上下文；结果持久化为 source 的 `failureClassification`，驱动 `reason`（1953-1957）、`agent.rate_limited` 审计（543-560）和 §18 投射到 `limited`。`ContinueAgentRunRequest`（`contracts/agent-continuation.ts:50-55`）没有 `reason` 字段，用户对一个尾部输出恰好提到「rate limit」的 Run 做普通手动换号（`quota-mention.json` 的情形），源 Profile 会被标 limited。§17.0 允许人来确认「切换」，不是让人替正则确认「这真是限额」。`agent-continuation.test.ts:802` 只断言 `failureClassification` 存在，不断言 kind。

**修法：** 请求带 `reason`；流程 B 仅在 `reason === 'rate-limit'` 时跑文本分类器，否则登记 `{ kind: 'unknown', retryable: true }`（或专门的 manual-switch 标记），让投射的 default 分支（不改状态）生效。

### P1-3 没有 `limitedUntil` 的 `limited` 永不降级，且被切换列表永久排除

- `account-profile-status-service.ts:79-85` `isLimitedExpired` 要求 `limitedUntil` 存在。
- `failure-classifier.ts:97-98` 只解析 ISO 形式的 `resets at <iso>` / `try again at <iso>`；「resets in 3 hours」「resets at 11pm」等常见 CLI 措辞产生无 `limitedUntil` 的 limited；186-189 行还会静默保留旧的 `limitedUntil`。
- 渲染层 `continuation-candidates.ts:41-45` 对无 `limitedUntil` 的 limited 返回 `false`。

只有一次成功 Run（167-179）或手动改状态能清除，而成功 Run 无法从切换 UI 发起（该 Profile 不在列表里）；普通启动又不按状态门控，前后不一致。`failure-classifier.ts:92-96` 注释称「缺 resetAt 不会困住 Profile，§18.0 会降级到 unknown」，与实际行为矛盾。§18.0 本身只定义了「`limitedUntil` 存在且 <= now」的情况，这是一个设计缺口被实现原样继承。

**修法：** `resetAt` 缺失时写一个保守的默认 `limitedUntil`（如 now + 1h，或按 provider 定），或在 `isLimitedExpired` 里对 `lastFailureAt` 超过 N 小时的 limited 视为过期；同步修改设计文档 §18.0。

### P1-4 resume 已禁用 Profile 的 Run 未被拒绝（§65 场景 G）

`runtime-identity.ts:19-24, 77-96` 明确「disabled 甚至已删除的行不阻止恢复」；`agent-manager.ts:1541-1566` 不检查 `enabled`；`profile-aware-recovery.test.ts:369` 断言 disabled Profile 可以 resume。而 start 路径的 resolver 对 disabled 返回 `ACCOUNT_PROFILE_DISABLED`（`account-profile-runtime-resolver.ts:98, 136`），start 与 resume 语义不一致。§38「不回退到默认 Profile」满足；§65 G「对该 Run 的 resume 被明确拒绝，并提示改用 Continuation」与 §10.5 不满足。crash reconciliation（→ `interrupted`）不受影响，这里指用户主动 resume。

另：resume 还缺 start 有的两项检查（`agent-manager.ts:1459-1700`）——不复查 `workspace.env` 的保留 key（start 在 1186-1200 做）；不做 `isRuntimeCompatible(snapshot.runtime, workspace.runtime)`，workspace 从 windows 切到 wsl 后会把 `C:\...` 的 `CODEX_HOME` 注入 WSL 进程，CLI 静默回退到 `~/.codex`。

**修法：** resume 时行存在且 `enabled === false` → `ACCOUNT_PROFILE_DISABLED` 并提示 Continuation（保留「行已删除用 snapshot」路径）；复用 start 的保留 key 检查；runtime 不匹配返回 `ACCOUNT_PROFILE_INCOMPATIBLE`。

### P1-5 WSL distro home 未知时先在错误位置建目录、缓存坏 root，再报笼统错误

`workspace/runtime.ts:363-374`：`wslInfo.homeDirs` 没有该 distro 时 `resolveDataRoot()` 回退到 `~/.teskra`，`resolveAgentProfileHome()` 得到 `~/.teskra/agent-profiles/<agent>/<slug>`。`account-profile-manager.ts:642-653` 在 `validateDraft`（656）**之前**调用 `ensureTrustedRoot`（646；实现 323-357），它经 `wsl.exe --exec`（`runtime.ts:388`）或单引号 `bash -lc`（395-397）执行 `test -e ~/.teskra/agent-profiles` 与 `mkdir -p -- ~/.teskra/agent-profiles`，两种方式 `~` 都不会被 shell 展开——于是在 wsl.exe 的 cwd（映射的 `/mnt/c/...`）下建出一个字面量 `~` 目录，其 `realpath -m` 被缓存进 `trustedRoots` 直到进程结束（356），之后 `configHomeSchema` 才拒绝 `~` 前缀并给出「The account profile is invalid.」。违反 §5.3（WSL 的 `~` 展开应在创建时通过 distro 查询完成一次）与 §48.2 (a0)（root 必须来自可信来源）。`runtime.test.ts:323` 只断言了 `~` 回退本身，没有覆盖这条分支。

**修法：** `createManaged` 在任何 fs 副作用前，若 `resolveAgentProfilesRoot()` 不是绝对路径则以结构化错误快速失败（如 `WSL_DISTRO_NOT_FOUND`「distro home 未知，请重新检测 WSL」）；或按需经 CommandRunner 查询 distro 的 `$HOME`；绝不缓存非绝对 root。

### P1-6 Shell 步骤确认无超时、无重投递、无持久审计

`workflows/shell-confirmation.ts:84-86` 在内存 promise 上永久等待。渲染层 `shell-confirmation-host.tsx:26-36` 只在挂载时订阅；窗口重载/关闭时挂起的事件丢失，没有 `listPending` 通道，步骤一直 `running` 直到用户取消 Run；`recovery/` 对挂起步骤无处理。决策只写 pino `security.log`（67-75, 98），同意没有记入 step result 或审计表（ADR-0002「事后审计」）；拒绝有记入（`shell-step-executor.ts:150-156`）。

做对的部分：答复前不会 spawn（`shell-step-executor.ts:129-158`，缺服务则拒绝）；cancel 会 settle 挂起项（203）；UI 展示完整命令 + cwd，没有「always allow」。

**修法：** 渲染层（重新）订阅时重发挂起确认，或暴露 `workflow.listPendingShellConfirmations`；把同意决策（stepId、command、cwd、decidedAt）记入 step result / 审计仓储；可选加超时拒绝。

### P1-7 `requireConfirmation` 是定义数据而非来源标记，loader 不强制打标

`contracts/workflow.ts:112-121` 把 `requireConfirmation?: boolean` 加进 shell 节点 schema；`definition-loader.ts:93-122` 原样返回校验后的定义。只有 `full-workflow-service.ts:238-266` 对来自仓库覆盖的 `testCommand` 打标。今天这是唯一可执行的仓库 shell 路径（见 P0-2），所以 TASK-118「repo 定义的 shell 步骤执行前展示完整命令行确认」成立；但 `workflow.loadDefinition` 是公开 facade 方法（`compose.ts:910-924`），未来任何消费者都会继承「仓库作者自己决定要不要确认」的门。

**修法：** loader 对来自 `<repo>/.teskra/workflows/` 的每个 shell 节点强制 `requireConfirmation: true`（或从文件 schema 删掉该字段、在加载对象上打标）。测试：仓库 YAML 写 `requireConfirmation: false` 仍加载为 `true`。

### P1-8 从卡片菜单禁用默认账号没有 §47.2(1) 的提示

`settings/sections/accounts-settings.tsx:246-259`「Disable」菜单项直接 `disableProfile()` + `loadSettings()`，无确认。§47.2(1)：「UI 上必须明确提示『已同时清除默认账号』，不能悄悄做」。Remove 弹窗有 `accounts.remove.defaultWarning`（370-372），作为 §47.1 主路径的 Disable 没有，也没有对应 i18n 键。**修法：** `isDefault` 时走同一个确认弹窗，复用 defaultWarning 文案。

### P1-9 只有一个非默认 Profile 时启动界面无法选择它

`accounts/account-select.tsx:30-34` 在 `candidates.length <= 1` 时返回 `null`。§37.1 说新 Profile 生效的方式是「显式设为默认或在启动时选择」；当唯一一个启用的 Profile 不是默认时，启动表单（`agent-catalog-page.tsx:259`、`task-page.tsx:346`）什么都不显示，Run 静默走 legacy 宿主环境。§25 只说选择器「可以默认折叠」，不是移除。它确实没有自动选中（值保持 `undefined`），§37.1 核心规则成立。**修法：** 仅当唯一候选就是默认时折叠；否则始终渲染并带 auto 选项。

### P1-10 「Auto (default account)」在无默认时实际是宿主 CLI 环境

`i18n/en-US.ts:789`，`account-select.tsx:46` 使用。没有 per-agent 默认时，「auto」意味着不投射 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`，§25 / §50.1 要求这种情况显式可见。**修法：** 用已有的 `defaultId`（36 行）渲染「Auto · <默认名>」与「Host CLI account (no profile)」两种文案。

### P1-11 续跑关联只存在于 best-effort 审计表

`agent-manager.ts:2024-2060` 的 `agent.continuation_created` / `agent.account_switched` 经 `appendAccountEvent`（405-416，失败只记日志）。`agent_runs` 没有关联列，`agent_events` 没有对应持久事件（目标 Run 的 `agent.created`（1383）只带 agentType / executionMode）。§41「`agent.account_switched` 能关联 source / target Run」靠审计表满足，但 append 失败即丢失，UI 也无法从 Run 本身推导。**修法：** 至少经 `appendEvent` 在目标 Run 上追加 `agent.continued`（payload `{ sourceRunId, reason, previousAccountProfileId }`）；理想是加 `continuation_of_run_id` 列（需先改 plan §139.1）。

---

## 4. P2 — 改进项

### 安全守卫不对称

- **P2-1** host-native `deleteManagedHome`（`account-profile-manager.ts:486`）用 `isWithinRoot`，相等时返回 true（169-173）；WSL 分支多了 `|| canonical.data === trustedRoot`（510）。若 managed 行的 `configHome` 等于 root（DB 被改 / 未来 bug），`rmSync(home, { recursive: true })`（494）会清空所有账号凭据。两个分支都不校验 §9.1 的深度（`<root>/<agentId>/<slug>`）。另有 `realpathSync` 到 `rmSync` 之间的小 TOCTOU。
- **P2-2** external Profile 的 `configHome` 原样存储（`account-profile-manager.ts:558-615`）：Windows 上 `C:\Users\x\.codex` 与 `c:\users\x\.codex\` 是两行、一个 home，绕过唯一索引；POSIX 路径可配给 windows runtime，反之亦然。渲染层 `isValidConfigHomePath`（`account-view-model.ts:95-99`）同样不按 runtime 校验。应按 runtime kind 规范化并拒绝形态不符的路径。
- **P2-3** `remove(deleteHome)`（`account-profile-manager.ts:965-1016`）先删 home（986）再 `setDefault(null)`（1004）与 `disable`（1010）；后两步失败会留下 enabled + ready 但无 home 的 Profile。应把唯一不可逆的删 home 放最后。
- **P2-4** 仓储层 `UpdateAccountProfileInput.configHome`（`account-profile-repository.ts:82, 277`）仍允许改写；Manager 与 IPC schema 都挡住了，但 DB 层面无守卫，且该路径的 UNIQUE 冲突会以 `UNKNOWN` 而非 `CONFLICT` 浮出。应删掉该字段。
- **P2-5** `paths.createAgentProfileHome()`（`paths.ts:234-237`）是对任意绝对路径的 `mkdir -p`，纵深防御应拒绝不在 `agentProfilesRoot()` 之下的路径。
- **P2-6** repo-local `.teskra/memory/*.md` 未过信任门（`memory/memory-manager.ts:164-224` 直接读 `workspace.data.path`），内容经 context builder 进入 prompt，是 untrusted clone 的 prompt-injection 面。TASK-118 验收未列，但 §43 原则适用；应与 prompts 一样走 `trustedRepoRoot`。
- **P2-7** `account-profile-security.test.ts` 的「renderer isolation」是对 preload 源码文本的静态断言，可审计但脆弱。

### 状态机与错误码

- **P2-8** Profile status 有三个写入者（`account-profile-manager.ts:207-221` 与 `account-profile-status-service.ts:94-119` 是两份相同的 `emitStatusChanged`；`update()` 767-790 可写任意状态），§16 状态机没有任何地方强制。建议 status service 提供唯一 `transition()`。
- **P2-9** start 不拒绝 `login-required` / `expired` 的 Profile（`account-profile-runtime-resolver.ts:184-255` 只按存在 / agentId / enabled / runtime 过滤）；设计 §47.2(3) 要求 §37 候选过滤把 `login-required` 视为不可用。可加 `ACCOUNT_PROFILE_NOT_READY`（`limited` 留给 §18/§26 流程）。
- **P2-10** 错误码不一致：Manager `notFound` 返回 `VALIDATION_FAILED`（`account-profile-manager.ts:535-541`），resolver 与登录服务用 `ACCOUNT_PROFILE_NOT_FOUND`；`failStopError`（`agent-manager.ts:227-233`）用 `UNKNOWN`，渲染层无法区分「被续跑取代」与真实失败；alias 未绑定与「写了 id」共用 `VALIDATION_FAILED`（`profile-alias-manager.ts:137-169`），且「是 id」的判定只靠本地行查找，外机 id 落入「未绑定」分支（仍是 fail-closed）。建议 `PROFILE_ALIAS_UNBOUND` 等专用码。
- **P2-11** alias 在节点 dispatch 时才解析（`workflow-engine.ts:325-357`），多节点 DAG 中前面节点已产生副作用后才因后面节点未绑定而失败。建议在 `createRun` / `engine.begin()` 预校验所有 agent 节点。P0-2 修复前此项不可达。
- **P2-12** 流程 A 对 legacy（无 `pidIdentity`）终态行仍做 probe-then-kill（`agent-manager.ts:1935-1950` → `survivor.ts:169-181`），迁移 011 前的 Run 若 pid 被复用会误杀无关进程。`exitCode !== undefined` 或终态行缺 `pidIdentity` 时应跳过探测。

### 登录与适配器

- **P2-13** Claude 登录命令忽略 executable override 与 defaultArgs（`claude-account-profile-adapter.ts:341-351` 返回裸 `CLAUDE_AGENT.executable.command`，Codex 用 `deps.resolveExecutable?.(profile)`；`compose.ts:399-401` 没给 Claude 接 `resolveExecutable`）。登录 PTY 以 `cwd = configHome`（`account-login-service.ts:361`）启动，Claude Code 会把账号 Home 当项目目录写 `.claude/`。登录服务也不拒绝 `enabled === false` 的 Profile（284-312）。
- **P2-14** Codex / Claude account adapter 约 60 行重复（`detectStatus` 的 host-native `existsSync` vs WSL `test -f/-e` 探测、`createRuntime` seam、`missingConfigHome`；`codex-account-profile-adapter.ts:110-143` vs `claude-account-profile-adapter.ts:264-306`）。抽一个 `probeRuntimeFileExists(runtime, path, commands)` 到基类，让「只查存在、绝不读内容」（§10.3）只有一处。
- **P2-15** 登录终端相关渲染组件零测试：`login-terminal-view.tsx`、`account-login-transport.ts`、`add-account-wizard.tsx`、`rate-limit-alert.tsx`、`continue-with-account-modal.tsx`；E2E 有意绕过向导与登录终端。§24.2 的交互保证（输入、resize、卸载取消、退出码传递）只靠读代码。窗口重载后登录会话存活但无输出回放（`account-login-service.ts:230-235` 只转发实时输出）。
- **P2-16** 其他：`agent-run-repository.ts` 013 四列的 `create` / `update(null)` 与 `listByAccountProfile` 无仓储级测试（后者是 §47 禁用前「有活跃 Run？」的门）；`AgentRuntimeIdentity`（`contracts/agent-account.ts:148-156`）无生产消费者；`accountProfileRuntimeRequestSchema` 与 `agentAccountProfileSchema` 的 runtime 细化逻辑复制；slug 规则在 contracts（大小写不敏感）与 Manager（仅小写）各一份；`account_events` 按 `id DESC` 排序而索引在 `created_at`、`limit` 未校验；`rate-limit-alert.tsx:95-113` 对 external Profile 也显示「Re-login」（可复用 `accountLoginAvailable()`）；`external-account-modal.tsx:36-40` 跨次打开保留旧表单；向导校验步把「CLI 已检测」与「认证可用」合并显示且把原始枚举拼进文案；Settings → Accounts 打开时 `account.list` 被调 2～3 次且 alias store 持有一份陈旧的 Profile 副本；图标按钮缺 `aria-label`；`ConfigWarning.kind` 是自由字符串而非枚举；E2E 选择器绑定 en-US 文案。

---

## 5. 流程与文档

1. **`docs/teskra-tasks.md` Milestone 24 的 155 个验收复选框全部未勾选**，与实现状态不符。§30 DoD 要求验收全过后勾选。
2. **`[Windows 验证]` 项没有记录。** WSL 隔离（TASK-098 / 099）目前只有单测覆盖，没有 Windows + WSL2 实机验证记录；P0-1 是本次在 Windows 实机上发现的，说明这类项确实需要实机跑。
3. 设计文档 §18.0 没有定义「limited 但无 `limitedUntil`」的恢复规则（见 P1-3），修实现时应同步补文档。
4. `host-processes.test.ts` 的 POSIX 用例在 Windows 主机上必然失败，建议按 `process.platform` 条件 skip 或改为 mock `/proc` 读取，否则 Windows 开发机上 `test:unit` 永远是红的。

---

## 6. 建议的处理顺序

1. **P0-1**（半天）：大小写折叠 + 冲突 key 删除 + Windows 测试。修法简单、影响面最大。
2. **P0-3 + P1-1**（半天到一天）：`launch()` 终态后取消进程；`failAndStop` 处理 `preparing` 与并发。两者在同一函数簇里，一起改。
3. **P0-2 + P1-7 + P2-11**（一天）：alias 字段透传到 `FullWorkflowConfig`；loader 强制打标；run 创建时预校验 alias。
4. **P1-2 / P1-3 / P1-4**（一天）：续跑请求带 reason；limited 默认到期；resume 与 start 对齐。
5. **P1-5 / P1-6**（一天）：WSL root 快速失败；shell 确认重投递与审计。
6. **P1-8 ～ P1-11 UI 项**（半天）。
7. P2 按模块顺手处理；勾选验收项并补 `[Windows 验证]` 记录。

---

## 附：本次 review 的覆盖方式

- 全量阅读 `941bc6e..04f152f` 的 diff，按五个切片对照验收标准逐项核对：域模型与持久化；运行时隔离 / Manager / 适配器；失败分类 / 续跑 / 恢复 / 审计；IPC / 渲染层 / E2E；Workflow alias / Workspace Trust / 安全测试。
- 每个切片输出验收矩阵（复选框 → 状态 → file:line 证据），本文只收录偏差项；矩阵中未列出的验收项均已核对为完成。
- 三条 P0 与 P1-1 / P1-3 由第二人独立复核代码；P0-1 在 Windows 11 主机上用 Electron node 模式 + 仓库内 node-pty 实机复现。
- 未做：Windows + WSL2 实机端到端；E2E 套件（软件渲染，本次未运行）；性能。
