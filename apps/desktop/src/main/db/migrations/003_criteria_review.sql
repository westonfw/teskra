-- 003_criteria_review — 验收契约与 Review（plan §139.1，TASK-090）

CREATE TABLE acceptance_criteria_sets (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL,           -- draft|confirmed|superseded
  confirmed_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_criteria_sets_task_version
  ON acceptance_criteria_sets(task_id, version);

CREATE TABLE acceptance_criteria (
  id              TEXT PRIMARY KEY,
  criteria_set_id TEXT NOT NULL REFERENCES acceptance_criteria_sets(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  description     TEXT NOT NULL,
  category        TEXT,                 -- functional|test|performance|security|compatibility|quality
  required        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_criteria_set ON acceptance_criteria(criteria_set_id, ordinal);

CREATE TABLE review_panels (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_run_id    TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  target_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  criteria_set_id    TEXT REFERENCES acceptance_criteria_sets(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL,     -- running|completed|failed
  consensus          TEXT,              -- approve|changes_requested|mixed
  aggregate_json     TEXT,              -- ReviewAggregate（含 disagreements）
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);

CREATE TABLE review_panel_members (
  id        TEXT PRIMARY KEY,
  panel_id  TEXT NOT NULL REFERENCES review_panels(id) ON DELETE CASCADE,
  run_id    TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_id  TEXT NOT NULL,
  verdict   TEXT,                       -- approve|changes_requested|unable_to_review
  created_at TEXT NOT NULL
);

CREATE TABLE review_findings (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  panel_id     TEXT REFERENCES review_panels(id) ON DELETE CASCADE,
  severity     TEXT NOT NULL,           -- critical|high|medium|low
  title        TEXT NOT NULL,
  description  TEXT,
  file         TEXT,
  line         INTEGER,
  criterion_id TEXT REFERENCES acceptance_criteria(id),
  evidence_json TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_findings_panel_severity ON review_findings(panel_id, severity);

CREATE TABLE criterion_scores (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL REFERENCES acceptance_criteria(id) ON DELETE CASCADE,
  result       TEXT NOT NULL,           -- pass|fail|unknown
  evidence_json TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_scores_run_criterion ON criterion_scores(run_id, criterion_id);
