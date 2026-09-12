-- 011: agent_runs.pid_identity — pid 身份令牌（进程启动时间），供 Reconciliation
-- 在 terminate 前校验「这个 pid 还是不是当初那个 Agent 进程」，防止 pid 回绕/复用
-- 后误杀无关进程。与 pid 一样不是真相，仅用于 reconciliation。
ALTER TABLE agent_runs ADD COLUMN pid_identity TEXT;
