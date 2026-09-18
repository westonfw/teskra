-- 015_workspace_trust — Workspace Trust 级别（TASK-118，设计文档 §43，
-- code-review P0-3）。
-- workspaces 增加 trust_level：'trusted' 才加载 repo-local
-- workflows / prompts / config；默认 'restricted'（显式信任才放行，
-- 与 VS Code Workspace Trust 一致）。纯 ADD COLUMN，不需要表重建，
-- 不设 foreignKeysOff。

ALTER TABLE workspaces
  ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'restricted'
  CHECK (trust_level IN ('trusted', 'restricted'));
