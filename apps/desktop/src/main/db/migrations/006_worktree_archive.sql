-- 006_worktree_archive — TASK-047 Archive 语义：只影响历史显示，不改 git 状态。
-- archived_at 为展示层标记；worktree list 默认过滤，includeArchived 可见。

ALTER TABLE worktrees ADD COLUMN archived_at TEXT;
CREATE INDEX idx_worktrees_workspace_archived ON worktrees(workspace_id, archived_at);
