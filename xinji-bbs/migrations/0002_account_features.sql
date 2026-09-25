-- 0002_account_features.sql
-- 账户管理（改密码 / 改用户名 / 注销账号）与两步验证（2FA/TOTP）支持
--
-- 无损更新原则：本文件只做「加法」，不修改或删除 0001 中已有的任何表结构，
-- 所有新增列都带 DEFAULT，线上已有数据会自动补默认值，不会丢失。
-- 已应用过的迁移不会被重复执行（由 D1 的 d1_migrations 表保证）。

-- 用户表：两步验证密钥与开关
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;

-- 登录过程中的 2FA 待验证票据（5 分钟有效，用后即焚）
CREATE TABLE IF NOT EXISTS pending_2fa (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_2fa_expires ON pending_2fa(expires_at);

-- 便于查询某用户是否已有待验证票据（防止堆积）
CREATE INDEX IF NOT EXISTS idx_pending_2fa_user ON pending_2fa(user_id);
