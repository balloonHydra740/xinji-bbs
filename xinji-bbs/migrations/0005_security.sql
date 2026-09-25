-- 0005 安全加固：速率限制表
-- 约定：只做加法，绝不改动已有表/列；NOT NULL 一律带 DEFAULT。

-- 记录各类「失败计数 + 封禁到期时间」。
-- 之所以要落库而不是放内存：Workers 每个 isolate 的内存互不相通，
-- 用内存计数会被轻松绕过（换一个边缘节点就重新计数）。
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_until ON rate_limits(until);
