-- 0006：讨论板块
--
-- 板���由所有人使用与创建，但**只有管理员能删除**；
-- 主题可以同时属于「某个板块」或「不属于任何板块」（board_id 为 NULL，前端显示为「未分类」）。
--
-- 只做加法：新建 boards 表 + 给 threads 加一个可空的 board_id，
-- 不删不改任何已有列，老数据一行不动（老主题自动落在「未分类」）。

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_boards_name ON boards(name);

-- board_id 允许 NULL（未分类）；板块被删除时，其下的主题自动回到「未分类」，
-- 而不是连带被删掉 —— 删一个板块不应该毁掉别人的帖子。
ALTER TABLE threads ADD COLUMN board_id INTEGER REFERENCES boards(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_threads_board ON threads(board_id);
