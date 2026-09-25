-- 0008 不易展示内容（隐藏限制帖）
-- 无损原则：只做加法，新列一律带 DEFAULT，老数据自动补齐。
--
-- ⚠️ 顺序很重要：和 0007 一样，这三列**不能**在 widenRoleConstraint 之前加。
--    widen 会用写死的建表语句重建 users / threads / posts，靠
--    `INSERT INTO posts SELECT * FROM snap_posts` 回填 —— 那时 posts 若已多出
--    sensitive 列，snap 与重建表列数不等，整批回滚。
--    所以它们统一由 src/index.js 的 ensureSensitive() 在 widen **之后**补齐
--    （本文件仅作离线迁移记录）。

-- 内容标记：1 = 不易展示（剧透 / 公共场合不宜），开了模糊的用户要先滑动确认才看得到
ALTER TABLE threads ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts   ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;

-- 个人偏好：要不要把上面这类内容先模糊掉。默认 1（先盖住），
-- 用户可在「账户设置 → 内容限制」里关掉。
ALTER TABLE users ADD COLUMN sensitive_filter INTEGER NOT NULL DEFAULT 1;
