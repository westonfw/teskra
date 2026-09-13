-- 012_agent_account_profiles — 账号 Profile 表（plan §139.1，TASK-095，ADR-0009）
-- 多订阅账号与 Agent Profile 管理（Milestone 24，设计文档 §8）。
-- 纯 CREATE TABLE，不需要表重建，不设 foreignKeysOff。

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
