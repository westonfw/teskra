-- 009_agent_run_mode — ADR-0007: persist the launch mode ('interactive' | 'exec')
-- so resume can relaunch with the run's original mode instead of always
-- 'interactive'. Nullable: rows predating this migration have no recorded mode
-- and resume falls back to 'interactive' (the pre-009 behavior).
ALTER TABLE agent_runs ADD COLUMN mode TEXT;
