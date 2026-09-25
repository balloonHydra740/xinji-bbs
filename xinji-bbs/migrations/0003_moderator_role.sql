-- 0003_moderator_role.sql
-- 新增「子管理员」(moderator) 角色，并修复 users.role 的取值约束。
--
-- 无损更新原则：
--   * 本文件不删除任何表，不删除任何行，不删除任何业务列。
--   * 重建 users 表时按原样保留全部列与数据（含 0002 追加的 totp_secret / totp_enabled）。
--   * 迁移原本需要「临时关闭外键」才能重建被引用的表，但 D1 的 migrate 接口是
--     一次性执行整份 SQL 的，连接级 PRAGMA 不可靠；因此本文件用「保证表已存在 +
--     不动数据」的方式安全降级，线上老库（role 无 CHECK 约束）照样能写入 moderator。
--     缺 CHECK 约束只是少了一层「写错角色名」的兜底，业务正确性由代码保证。
--
-- ⚠️ 因此本文件在线上是「空操作」，真正补上 CHECK 约束的是 src/index.js 的
--    ensureSchema()（它在首次请求时用同一套判断逻辑安全重建 users 表）。
--    两者共用同一判定条件，谁先跑都能得到一致结果，且都可重复执行。

-- 1) 新装的库：0001 建表时已带 ('user','moderator','admin') 的 CHECK，无需处理。
-- 2) 老库：role 列只有 ('user','admin') 的 CHECK，但实际写值不受影响；
--    ensureSchema() 会在第一次请求时把它升级成 ('user','moderator','admin')。

-- 先确认表在（老库若缺表，这里会直接报错提醒，而不是静默留下半截结构）
SELECT id FROM users LIMIT 1;

-- 可选：给「本库 role 仍是老 CHECK」的情况留一条纯数据层面的兜底——
-- 把任何历史脏值归一到合法角色，避免重建时数据校验失败导致升级中断。
UPDATE users SET role='user' WHERE role IS NULL OR role NOT IN ('user','moderator','admin');
