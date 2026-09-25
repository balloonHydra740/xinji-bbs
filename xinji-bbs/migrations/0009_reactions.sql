-- 0009 点赞与转帖（引用）
-- 无损原则：只做加法 —— 新建 likes 表 + 给 threads / posts 各加两个可空列，
-- 老数据一行不动（没有引用的内容 quote_ref 为 NULL，前端按「不是转帖」处理）。
--
-- ⚠️ 顺序很重要：和 0007 / 0008 一样，这些**不能**在 widenRoleConstraint 之前加。
--    widen 会用写死的建表语句重建 users / threads / posts，靠 `INSERT … SELECT * FROM snap_*`
--    回填 —— 那时若 threads / posts 已多出 quote_* 列，列数不等会整批回滚；
--    likes 又引用 users，先建出来会让 widen 的 `DROP TABLE users` 被外键拒绝。
--    所以它们统一由 src/index.js 的 ensureReactions() 在 widen **之后**补齐
--    （本文件仅作离线迁移记录）。

CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK(target_type IN ('thread','post')),
  target_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 一人一次：唯一索引是唯一可靠的兜底（并发点两下也只有一行生效）
CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_one ON likes(target_type,target_id,user_id);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type,target_id);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);

-- 引用 / 转帖：quote_ref 形如 'thread:12' 或 'post:34'。
-- 刻意**不加外键**：原内容被删之后引用卡要照常显示（只多一句「原内容已删除」），
-- 加外键会让删帖连带把别人的引用卡整块抹掉。快照保证内容删了也读得到作者与摘要。
ALTER TABLE threads ADD COLUMN quote_ref TEXT;
ALTER TABLE threads ADD COLUMN quote_snapshot TEXT;
ALTER TABLE posts ADD COLUMN quote_ref TEXT;
ALTER TABLE posts ADD COLUMN quote_snapshot TEXT;

CREATE INDEX IF NOT EXISTS idx_threads_quote ON threads(quote_ref);
CREATE INDEX IF NOT EXISTS idx_posts_quote ON posts(quote_ref);
