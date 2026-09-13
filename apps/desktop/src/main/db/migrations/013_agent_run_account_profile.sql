-- 013_agent_run_account_profile — agent_runs 的四个新列（plan §139.1，TASK-095）
-- 一个语义变更一个文件；纯 ADD COLUMN，不设 foreignKeysOff。

ALTER TABLE agent_runs ADD COLUMN account_profile_id TEXT;
ALTER TABLE agent_runs ADD COLUMN execution_profile_id TEXT;
ALTER TABLE agent_runs ADD COLUMN profile_snapshot_json TEXT;

-- §17.2（ADR-0010）：限额/认证失败的分类结果。不新增 Run status，
-- 失败的 Run 仍然是 status = 'failed'，原因存在这一列里。
ALTER TABLE agent_runs ADD COLUMN failure_classification_json TEXT;

-- 前三列刻意不设外键：这里要的是审计留痕，ON DELETE SET NULL 会在删
-- Profile 时抹掉历史 Run 的身份，ON DELETE RESTRICT 又会让「软禁用优先」
-- （设计文档 §47）变成「永远删不掉」。真相由 profile_snapshot_json 承载，
-- account_profile_id 只是弱引用。
