-- 0004 站点附件与外部存储
-- 约定：只做加法，绝不改动、删除已有表或列；NOT NULL 列必须带 DEFAULT，
--       让已存在数据的老库能自动补齐而不报错。

-- 站点运行时设置。存 WebDAV / R2 的连接信息、功能开关等。
-- 之所以用表而不是 wrangler.jsonc：站主要能在管理界面「随时更换接口」，
-- 不能每次改配置都重新部署一遍 Worker。
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
);

-- 附件元数据。二进制本体存放在外部存储（WebDAV / R2），库里只留索引信息，
-- 这样 D1 不会因为图片视频而迅速膨胀，也不会受单行 2 MB 的限制。
-- 说明：此处只对 users 建外键，刻意不让 attachments 外键 threads / posts。
--       因为「发新帖」的流程是先传附件、后建楼，且关闭存储时要能独立清理，
--       绑死外键会让级联方向变得难以控制。
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  original_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_id);
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);
