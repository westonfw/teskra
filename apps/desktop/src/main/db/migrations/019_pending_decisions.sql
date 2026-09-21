CREATE TABLE pending_decisions (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'shell_confirmation', 'agent_blocker', 'stalled_run',
                     'merge_blocked', 'rate_limit', 'handoff_degraded')),
  status           TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'expired', 'cancelled')),
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  run_id           TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  workflow_run_id  TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
  worktree_id      TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  dedupe_key       TEXT NOT NULL,
  title            TEXT NOT NULL,
  detail_json      TEXT NOT NULL,
  options_json     TEXT NOT NULL,
  resolution_json  TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);
CREATE UNIQUE INDEX idx_pending_decisions_open_dedupe
  ON pending_decisions(dedupe_key) WHERE status = 'open';
CREATE INDEX idx_pending_decisions_workspace_open
  ON pending_decisions(workspace_id, created_at DESC) WHERE status = 'open';
CREATE INDEX idx_pending_decisions_run ON pending_decisions(run_id);
