-- 005_permissions —（plan §139.1，TASK-090）

CREATE TABLE permission_rules (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL = 全局规则
  agent_type      TEXT,               -- NULL = 适用所有 Agent
  command_pattern TEXT NOT NULL,
  risk_level      TEXT,               -- 命中的风险等级，可为 NULL
  action          TEXT NOT NULL,      -- allow | deny | ask | audit
  scope           TEXT NOT NULL,      -- once | session | persistent
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_permission_rules_ws ON permission_rules(workspace_id, agent_type);

CREATE TABLE permission_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  command         TEXT NOT NULL,
  cwd             TEXT,
  risk_level      TEXT NOT NULL,
  matched_rule_id TEXT REFERENCES permission_rules(id) ON DELETE SET NULL,
  detected_at     TEXT NOT NULL,      -- 从输出流识别到的时间（事后，非执行前）
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_permission_audit_run ON permission_audit(run_id, risk_level);
