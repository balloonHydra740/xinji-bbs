-- 0011 投票
-- 无损原则：只做加法 —— 新建三张表，老数据一行不动（没有投票的内容就是「没有投票」）。
--
-- ⚠️ 顺序很重要：和 0007 / 0008 / 0009 / 0010 一样，这些**不能**在 widenRoleConstraint 之前建。
--    poll_votes 引用了 users，提前建起来会让 widen 的 `DROP TABLE users` 被外键拒绝，
--    整批回滚之后角色约束就永远放宽不了（likes 踩过同一个坑）。
--    所以它们统一由 src/index.js 的 ensurePolls() 在 widen **之后**补齐
--    （本文件仅作离线迁移记录）。

-- ============ 投票本体 ============
-- 一条内容（主题 / 回复）最多挂一个投票：唯一索引兜底，
-- 并发提交两个也只有一行生效，不会冒出两张并列的投票卡。
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK(target_type IN ('thread','post')),
  target_id INTEGER NOT NULL,             -- 挂在 threads.id 还是 posts.id，由 target_type 决定
  question TEXT NOT NULL DEFAULT '',
  multi INTEGER NOT NULL DEFAULT 0,       -- 0 单选 / 1 多选（多选时一人仍只能投一次）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_target ON polls(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_polls_created ON polls(created_at);

-- ============ 选项 ============
-- pos 只是排序用的序号，不是 id —— 恢复快照时要按原 id 写回，票才不会挂错项。
CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, pos);

-- ============ 票 ============
-- 一张选票（ballot）= 一个账号对一个投票的**一次**投票。
-- 「一人一次」的唯一可靠兜底就是 poll_ballots 上这条唯一索引：
-- 并发点两下、网络重试发两次，第二次会在插入选票时撞上它，只留下一次。
--
-- ⚠️ 为什么不直接把 user_id 放在票上、靠 UNIQUE(poll_id,user_id) 兜底：
--    那样一个账号在这个投票里**永远只能有一行**，多选就成了不可能
--    （选两个选项 = 两行 = 直接撞唯一索引，第二项默默丢掉）。
--    所以拆成「选票」+「选票上的勾选项」两层：
--      选票保证一人一次；勾选项可以是多个。
CREATE TABLE IF NOT EXISTS poll_ballots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_ballots_one ON poll_ballots(poll_id, user_id);
CREATE INDEX IF NOT EXISTS idx_poll_ballots_poll ON poll_ballots(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_ballots_user ON poll_ballots(user_id);

-- 选票上勾了哪几个选项。票数一律**现算**，不存冗余计数字段 ——
-- 存了就得处处维护它和选票的一致性，而这类数字一旦对不上，
-- 用户看到的是「明明投了却显示 0 票」。
CREATE TABLE IF NOT EXISTS poll_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ballot_id INTEGER NOT NULL REFERENCES poll_ballots(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_ballot ON poll_votes(ballot_id, option_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(option_id);
