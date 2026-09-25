-- 0010 回收站 / 内容保护 / 胁迫密码
-- 无损原则：只做加法 —— 新建 trash 表 + 给 threads / posts 加 protected 列 +
-- 给 users 加 duress_* 列，老数据一行不动（没有保护的内容 protected=0，和以前一样）。
--
-- ⚠️ 顺序很重要：和 0007 / 0008 / 0009 一样，这些**不能**在 widenRoleConstraint 之前加。
--    widen 会用写死的建表语句重建 users / threads / posts，靠 `INSERT … SELECT * FROM snap_*`
--    回填 —— 那时若三张表已多出新列，列数不等会整批回滚。
--    所以它们统一由 src/index.js 的 ensureModeration() 在 widen **之后**补齐
--    （本文件仅作离线迁移记录）。

-- ============ 回收站 ============
-- 删除不再「一删就没」：先把整行快照写进来，再从活跃表删掉。
-- 只存一条对象一行（主题的回复各占一行、靠 parent_id 挂回主题），
-- 不把整个主题打包成一条 —— D1 单行 2 MB 上限，一个热门长帖的 JSON 就能顶破。
-- 恢复成功即把这一行删掉：回收站里永远只有「还没恢复的」，不需要额外状态列。
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('thread','post','user')),
  target_id INTEGER NOT NULL,             -- 原记录 id，恢复时按原 id 写回（引用卡才不会指空）
  parent_id INTEGER,                      -- post 所属主题；thread / user 为 NULL
  author_id INTEGER,
  author_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',          -- 正文原文（附件清理要扫这里的 [img:n]）
  payload TEXT NOT NULL DEFAULT '{}',     -- 完整字段快照（含敏感标记、置顶、保护、时间…）
  item_count INTEGER NOT NULL DEFAULT 1,  -- 这条记录连带收了几行（删账号时用得上）
  deleted_by INTEGER,
  deleted_by_name TEXT NOT NULL DEFAULT '',
  -- 1 = 作者自己删的。只有这种情况作者能自行恢复 ——
  -- 管理员删掉的内容放开让作者一键恢复，等于治理动作可以被单方面推翻。
  by_owner INTEGER NOT NULL DEFAULT 0,
  was_protected INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trash_author ON trash(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_trash_parent ON trash(parent_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash(deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_trash_kind ON trash(kind, target_id);

-- ============ 内容保护 ============
-- 站主可以把一条主题 / 回复「保护」下来：之后**除了站主谁都动不了它** ——
-- 作者不能改也不能删（所有权临时交给站主），子管理员的治理动作同样被挡住。
ALTER TABLE threads ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN protected_at TEXT;
ALTER TABLE posts ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN protected_at TEXT;

-- ============ 胁迫密码 ============
-- duress_hash：胁迫密码自己的哈希（与真密码同算法，但独立一列）。
-- duress_state=1 表示账号处在保护状态：内容一条不删、账号暂时停用、
-- 只有站主能手动恢复。duress_by 记「谁触发的」：self（本人输了胁迫密码）/ admin（站主手动启动）。
ALTER TABLE users ADD COLUMN duress_hash TEXT;
ALTER TABLE users ADD COLUMN duress_state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN duress_at TEXT;
ALTER TABLE users ADD COLUMN duress_by TEXT;
