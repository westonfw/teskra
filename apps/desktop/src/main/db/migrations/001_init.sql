-- 001_init — 基础实体（plan §139.1，TASK-090）
-- schema_migrations 由 migration 机制内置创建（migrate.ts），不在本文件。
-- 时间列一律 TEXT，存 ISO-8601 UTC；所有 *_json 列存 JSON 字符串，
-- 由 Repository 层负责序列化与 Zod 校验。

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
