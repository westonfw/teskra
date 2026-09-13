# ADR-0011：Workflow 引用 Profile alias，不引用 Profile id

- 日期：2026-09-13
- 状态：Accepted

## 背景

多账号方案让 Workflow 节点可以指定用哪个账号 / 哪套执行配置跑：

```yaml
type: agent
agent: codex
accountProfile: work
```

Workflow 定义是**提交进仓库**的（含 repo-local workflow）。
而 `AgentAccountProfile.id` 与 `AgentExecutionProfile.id` 都是**机器本地**
生成的，`name` 又可改、可重名。两者写进仓库都不可移植：同事 clone 之后
本地根本没有那个 id，解析要么失败，要么误匹配到别人的账号——
后者正是本方案反复要避免的「静默串号」。

## 裁决

1. Workflow 中出现的 `accountProfile:` 与 `profile:` 一律是 **alias**，
   由每台机器自己绑定到本地 Profile。**不接受 Profile id**，
   哪怕是白名单里的 id 也不接受。
2. 绑定关系存在本地库的 `profile_aliases` 表
   （plan §139.1 / migration 012），主键 `(agent_id, kind, alias)`：
   - `agent_id` 进主键：`work` 在 codex 与 claude 下可指向不同账号
   - `kind ∈ {account, execution}`：同一个 `work` 可同时是两种 alias，
     且两张 Profile 表的 id 命名空间不能假定不重叠，
     因此 kind 必须显式传递，不能由 profileId 反推
3. 绑定时校验 `profileId` 存在于 `kind` 对应的表，
   且 `profile.agentId` 与请求的 `agentId` 相符。
4. **未绑定的 alias 报错并提示用户绑定，不回退到默认账号。**
5. 绑定关系不入仓库；`profile_aliases` 不设 FK 到两张 Profile 表——
   Profile 被删后 alias 应变成「未绑定」并在解析时报错，
   而不是被级联删掉、让用户以为自己从没绑过。
6. `DefinitionLoader` 只取 alias 字符串，真正解析在 Runtime Service。

## 影响

- repo-local workflow 无法点名另一台机器上的具体账号（§55 的安全前提）。
- 需要一处绑定 UI（Settings → Agents → Aliases）与三个 IPC channel
  （`teskra:account:alias:list / bind / unbind`）。
- alias 的全部实现（Repository + IPC + UI）归 TASK-111，
  不拆到 TASK-102——否则会出现「Phase C 暴露了 IPC，Phase E 才有仓储」。
