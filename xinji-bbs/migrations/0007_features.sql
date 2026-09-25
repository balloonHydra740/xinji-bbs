-- 0007 社区功能：楼中楼、编辑痕迹、用户资料（头像 / 签名档）
-- 无损原则：只做加法，新列一律带 DEFAULT，老数据自动补齐。
--
-- ⚠️ 顺序很重要：这些列和表**不能**在 widenRoleConstraint 之前加。
--    widen 会用写死的建表语句重建 users / posts，靠 `INSERT INTO posts SELECT * FROM snap_posts`
--    回填 —— 那时 posts 若已多出新列，snap 与重建表列数不等，整批回滚。
--    同理 post_edits 引用 users，先建出来会让 widen 的 `DROP TABLE users` 被外键拒绝。
--    所以它们统一由 src/index.js 的 ensureFeatures() 在 widen **之后**补齐（本文件仅作离线迁移记录）。

-- 用户资料：头像（'emoji:🐱' 或 'att:<附件id>'）与签名档
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';

-- 楼中楼：reply_to 指向同一主题内的另一条回复；被回复的那条被删时置空，而不是连坐删楼
ALTER TABLE posts ADD COLUMN reply_to INTEGER REFERENCES posts(id) ON DELETE SET NULL;
-- 编辑痕迹：正文改写过就记时间
ALTER TABLE posts ADD COLUMN edited_at TEXT;
ALTER TABLE threads ADD COLUMN edited_at TEXT;

-- 编辑历史。只记正文改动（before → after），谁改的一并记录，便于事后追溯。
CREATE TABLE IF NOT EXISTS post_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK(target_type IN ('thread','post')),
  target_id INTEGER NOT NULL,
  editor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  before_body TEXT NOT NULL DEFAULT '',
  after_body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_post_edits_target ON post_edits(target_type, target_id, id);
CREATE INDEX IF NOT EXISTS idx_post_edits_editor ON post_edits(editor_id);
