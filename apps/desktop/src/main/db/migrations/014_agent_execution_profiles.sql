-- 014_agent_execution_profiles — 执行 Profile 表（plan §139.1，TASK-110）
-- 多订阅账号与 Agent Profile 管理（Milestone 24，设计文档 §8.2）。
-- 纯 CREATE TABLE，不需要表重建，不设 foreignKeysOff。

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
