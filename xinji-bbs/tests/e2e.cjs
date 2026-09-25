/* 星铃 BBS 回归测试（无需 wrangler / 无需联网）
 * 用 Node 内置 node:sqlite 建真实库（含外键约束）模拟 D1，直接调用 Worker 代码。
 * 运行：npm test   （需 Node 22+，依赖内置的 node:sqlite）
 */
const fs = require('fs'), url = require('url'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..') + '/';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

// D1 数据库 mock：保留真实 SQL 语义与外键约束
// 注意：外键故意保持 ON，与线上 D1 一致 —— D1 **不允许关闭外键**，
// 所以任何「关外键 + DROP 被引用的表」的写法在这里同样会失败，
// 本地就能提前暴露线上才会炸的问题（2026-09-15 踩过）。
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    // 关键：**延迟编译**。D1 的 prepare() 只是在客户端记录 SQL，真正编译发生在
    // 服务端执行的那一刻；而 node:sqlite 的 db.prepare() 会立刻向 SQLite 编译并校验
    // （例如 CREATE TABLE 撞上已存在的表会当场抛错）。
    // 若在此处就编译，batch 里「先 DROP users 再 CREATE users」这种合法序列会被误判为
    // 「table users already exists」。所以这里只存 SQL，等 run/get/all 时再编译。
    let stmt = null;
    let args = [];
    const compile = () => (stmt || (stmt = this.db.prepare(sql)));
    const api = {
      __sql: sql,               // 供 batch() 使用
      __args: () => args,
      bind(...a) { args = a; return api; },
      async first() { const r = compile().get(...args); return r === undefined ? null : r; },
      async all() { return { results: compile().all(...args), success: true, meta: {} }; },
      async run() {
        const r = compile().run(...args);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) } };
      }
    };
    return api;
  }
  // D1 的 batch()：批内是**一个事务**，任何一条失败则整体回滚。
  // 用 BEGIN/COMMIT/ROLLBACK 忠实复刻，避免「本地逐条成功、线上整批回滚」的差异。
  // 注意每条语句在这里才 prepare（延迟编译），保证 DROP 先于 CREATE 生效。
  async batch(stmts) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const s of stmts) {
        const r = this.db.prepare(s.__sql).run(...(s.__args ? s.__args() : []));
        out.push({ success: true, meta: { last_row_id: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) } });
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) { }
      console.error('[mock batch] 第 ' + (out.length + 1) + ' 条失败:', e.message);
      throw e;
    }
    return out;
  }
}

const newDb = (files) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  for (const f of files) db.exec(fs.readFileSync(root + 'migrations/' + f, 'utf8'));
  return db;
};

async function main() {
  const worker = (await import(url.pathToFileURL(root + 'src/index.js').href)).default;

  // 从源码提取 TOTP 实现，用于生成测试验证码
  const src = fs.readFileSync(root + 'src/index.js', 'utf8');
  const consts = ['TOTP_PERIOD', 'TOTP_DIGITS', 'TOTP_WINDOW'].map(n => (src.match(new RegExp('const ' + n + ' = \\d+;')) || [''])[0]).join('\n');
  const block = src.slice(src.indexOf('/* ---------------- TOTP'), src.indexOf('/* ---------------- 会话与鉴权'));
  const totp = new Function('crypto', consts + '\n' + block + '\nreturn {totpAt};')(require('crypto').webcrypto);

  const mkCaller = (env) => {
    let cookie = '', seq = 0;
    return async (p, o = {}) => {
      const h = { 'content-type': 'application/json', ...(o.headers || {}) };
      // 本地 Request 没有真实的 cf-connecting-ip，所有请求会落进同一个限流 key
      // 互相干扰。注册时给一个递增的假出口 IP，模拟「不同访客各自注册」。
      if (!h['cf-connecting-ip'] && p === '/api/register') h['cf-connecting-ip'] = `203.0.113.${(seq++ % 250) + 1}`;
      if (cookie) h['Cookie'] = cookie;
      // 上传接口要的是**文件裸字节**，不能走 JSON.stringify（会把 Uint8Array 变成对象字面量）
      const isRaw = o.body instanceof Uint8Array || o.body instanceof ArrayBuffer;
      const req = new Request('http://localhost' + p, { method: o.method || 'GET', body: isRaw ? o.body : (o.body ? JSON.stringify(o.body) : undefined), headers: h });
      const res = await worker.fetch(req, env, {});
      const sc = res.headers.get('set-cookie');
      if (sc) { const mm = sc.match(/bbs_session=([^;]*)/); cookie = (mm && mm[1]) ? 'bbs_session=' + mm[1] : ''; }
      let data = null; try { data = await res.json(); } catch (e) { }
      // headers 一并带出来：胁迫密码触发时「有没有下发会话」只能从 set-cookie 上看
      return { status: res.status, data, headers: res.headers };
    };
  };

  // 借用 Worker 内部的 PBKDF2 实现，给「老库」造真实的密码哈希
  const pwBlock = src.slice(src.indexOf('async function passwordHash'), src.indexOf('/* ---------------- TOTP'));
  const passwordHashFor = new Function('crypto', 'b64', 'unb64', 'encoder',
    'const PASSWORD_ITERATIONS = 10000;' + pwBlock + 'return passwordHash;'
  )(require('crypto').webcrypto, (u8) => Buffer.from(u8).toString('base64'),
    (s) => new Uint8Array(Buffer.from(s, 'base64')), new TextEncoder());

  // ============ A. Schema 自愈：老库（未应用 0002）不应全线 500 ============
  console.log('\n--- A. 老数据库自愈（未应用 0002 迁移）---');
  {
    const env = { DB: new D1(newDb(['0001_init.sql'])), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const call = mkCaller(env);
    let r = await call('/api/setup', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
    ok('A1 初始化管理员', r.status === 200);
    r = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
    ok('A2 管理员登录成功', r.status === 200, 'status=' + r.status);
    r = await call('/api/status');
    ok('A3 /api/status 正常返回登录用户', r.status === 200 && r.data.user && r.data.user.username === 'admin', JSON.stringify(r.data));
    r = await call('/api/threads', { method: 'POST', body: { title: '测试帖', body: '内容' } });
    ok('A4 老库也能正常发帖(200)', r.status === 200, 'status=' + r.status);
    r = await call('/api/threads/' + (r.data.id || 1) + '/posts', { method: 'POST', body: { body: '回复' } });
    ok('A5 老库也能正常跟帖(200)', r.status === 200, 'status=' + r.status);
    r = await call('/api/admin/users');
    ok('A6 管理端可取用户列表(200)', r.status === 200, 'status=' + r.status);
    // 管理中心那一行要显示真实头像，少了 avatar 前端只能退化成「用户名首字」色块 ——
    // 曾经就是这样，用户看到的是「管理中心不正常显示头像」。
    ok('A6b 用户列表带 avatar 字段', Array.isArray(r.data) && r.data.length > 0 && 'avatar' in r.data[0],
      JSON.stringify(Object.keys(r.data[0] || {})));
    ok('A7 缺失的列已被自动补齐', env.DB.db.prepare('PRAGMA table_info(users)').all().map(c => c.name).includes('totp_enabled'));
  }

  // ============ B. 完整业务流程（已应用全部迁移）============
  console.log('\n--- B. 完整业务流程 ---');
  const db = newDb(['0001_init.sql', '0002_account_features.sql']);
  const env = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
  const call = mkCaller(env);
  let r;

  r = await call('/api/status');
  ok('B1 初始 setupNeeded=true', r.data && r.data.setupNeeded === true);
  r = await call('/api/setup', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
  ok('B2 创建管理员', r.status === 200);
  r = await call('/api/setup', { method: 'POST', body: { username: 'admin2', password: 'admin12345' } });
  ok('B3 重复初始化被拒(409)', r.status === 409);
  r = await call('/api/register', { method: 'POST', body: { username: 'alice', password: 'alicepass1' } });
  ok('B4 注册成功', r.status === 200);
  r = await call('/api/register', { method: 'POST', body: { username: 'alice', password: 'alicepass1' } });
  ok('B5 重名注册被拒(409)', r.status === 409);
  r = await call('/api/login', { method: 'POST', body: { username: 'alice', password: 'wrongpass' } });
  ok('B6 错误密码登录失败(401)', r.status === 401);
  r = await call('/api/login', { method: 'POST', body: { username: 'alice', password: 'alicepass1' } });
  ok('B7 登录成功', r.status === 200 && r.data.ok);
  r = await call('/api/threads', { method: 'POST', body: { title: '第一帖', body: '内容内容' } });
  ok('B8 发帖成功', r.status === 200 && !!r.data.id);
  const tid = r.data.id;
  r = await call('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '我的回复' } });
  ok('B9 回复成功', r.status === 200);
  r = await call('/api/threads/' + tid);
  ok('B10 详情含 1 条回复', r.status === 200 && r.data.posts.length === 1);
  const pid = r.data.posts[0].id;

  r = await call('/api/account/username', { method: 'POST', body: { username: 'alice3', password: 'wrong' } });
  ok('B11 错误密码无法改用户名(401)', r.status === 401);
  r = await call('/api/account/username', { method: 'POST', body: { username: 'alice2', password: 'alicepass1' } });
  ok('B12 改用户名成功', r.status === 200 && r.data.user.username === 'alice2');
  r = await call('/api/account/password', { method: 'POST', body: { password: 'alicepass1', newPassword: 'newalicepass' } });
  ok('B13 改密码成功', r.status === 200);
  await call('/api/logout', { method: 'POST' });
  r = await call('/api/login', { method: 'POST', body: { username: 'alice2', password: 'alicepass1' } });
  ok('B14 旧密码失效(401)', r.status === 401);
  r = await call('/api/login', { method: 'POST', body: { username: 'alice2', password: 'newalicepass' } });
  ok('B15 新密码可登录', r.status === 200);

  r = await call('/api/2fa/setup', { method: 'POST' });
  ok('B16 2FA 返回合法 secret 与 URI', r.status === 200 && /^[A-Z2-7]{32}$/.test(r.data.secret) && r.data.uri.startsWith('otpauth://totp/'));
  const secret = r.data.secret;
  r = await call('/api/2fa/enable', { method: 'POST', body: { secret, code: '000000', password: 'newalicepass' } });
  ok('B17 错误验证码无法开启 2FA(400)', r.status === 400);
  r = await call('/api/2fa/enable', { method: 'POST', body: { secret, code: await totp.totpAt(secret, Date.now()), password: 'newalicepass' } });
  ok('B18 正确验证码开启 2FA', r.status === 200);
  await call('/api/logout', { method: 'POST' });
  r = await call('/api/login', { method: 'POST', body: { username: 'alice2', password: 'newalicepass' } });
  ok('B19 开启 2FA 后登录返回 need2fa', r.status === 200 && r.data.need2fa === true && !!r.data.pending);
  const pending = r.data.pending;
  r = await call('/api/2fa/verify', { method: 'POST', body: { pending, code: '000000' } });
  ok('B20 2FA 错误码被拒(401)', r.status === 401);
  r = await call('/api/2fa/verify', { method: 'POST', body: { pending, code: await totp.totpAt(secret, Date.now()) } });
  ok('B21 2FA 正确码完成登录', r.status === 200 && r.data.user.totp_enabled === 1);
  r = await call('/api/account/password', { method: 'POST', body: { password: 'newalicepass', newPassword: 'anotherpass1' } });
  ok('B22 已开2FA缺验证码被拒(401)', r.status === 401);
  r = await call('/api/account/password', { method: 'POST', body: { password: 'newalicepass', newPassword: 'anotherpass1', code: await totp.totpAt(secret, Date.now()) } });
  ok('B23 带验证码改密码成功', r.status === 200);

  await call('/api/logout', { method: 'POST' });
  await call('/api/register', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } });
  r = await call('/api/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } });
  const bobId = r.data.user.id;
  r = await call('/api/threads/' + tid, { method: 'DELETE' });
  ok('B24 他人无法删别人主题(403)', r.status === 403);
  r = await call('/api/threads', { method: 'POST', body: { title: 'bob的帖', body: '内容' } });
  const btid = r.data.id;
  r = await call('/api/threads/' + btid, { method: 'DELETE' });
  ok('B25 作者可删自己主题', r.status === 200);
  r = await call('/api/threads/' + btid);
  ok('B26 删除后主题不存在(404)', r.status === 404);

  await call('/api/logout', { method: 'POST' });
  r = await call('/api/login', { method: 'POST', body: { username: 'alice2', password: 'anotherpass1' } });
  await call('/api/2fa/verify', { method: 'POST', body: { pending: r.data.pending, code: await totp.totpAt(secret, Date.now()) } });
  r = await call('/api/posts/' + pid, { method: 'DELETE' });
  ok('B27 作者可删自己回复', r.status === 200);

  await call('/api/logout', { method: 'POST' });
  r = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
  ok('B28 管理员登录', r.status === 200 && r.data.user.role === 'admin');
  const adminId = r.data.user.id;
  r = await call('/api/admin/set-password', { method: 'POST', body: { id: adminId, newPassword: 'whatever123' } });
  ok('B29 管理员不能重置管理员密码(403)', r.status === 403, JSON.stringify(r.data));
  r = await call('/api/admin/set-password', { method: 'POST', body: { id: bobId, newPassword: 'bobnewpass1' } });
  ok('B30 管理员重置普通用户密码', r.status === 200);
  await call('/api/logout', { method: 'POST' });
  r = await call('/api/login', { method: 'POST', body: { username: 'bob', password: 'bobnewpass1' } });
  ok('B31 bob 可用新密码登录', r.status === 200);

  await call('/api/logout', { method: 'POST' });
  await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
  r = await call('/api/account/delete', { method: 'POST', body: { password: 'admin12345', confirm: 'admin' } });
  ok('B32 管理员不允许注销自己的账号(403)', r.status === 403, 'status=' + r.status);
  await call('/api/logout', { method: 'POST' });
  await call('/api/login', { method: 'POST', body: { username: 'bob', password: 'bobnewpass1' } });
  r = await call('/api/account/delete', { method: 'POST', body: { password: 'bobnewpass1', confirm: 'wrongname' } });
  ok('B33 确认名不匹配无法注销(400)', r.status === 400);
  r = await call('/api/account/delete', { method: 'POST', body: { password: 'bobnewpass1', confirm: 'bob' } });
  ok('B34 注销账号成功(外键级联无报错)', r.status === 200);
  ok('B35 用户记录已删除', !db.prepare('SELECT * FROM users WHERE username=?').get('bob'));
  ok('B36 该用户会话已清除', db.prepare('SELECT * FROM sessions WHERE user_id=?').all(bobId).length === 0);

  // ============ C. 角色体系：子管理员 / 管理员删号 / 关闭他人 2FA ============
  console.log('\n--- C. 角色体系与管理员越权防护 ---');
  const envC = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
  const callC = mkCaller(envC);

  // admin 重新登录（前面注销测试把会话清掉了）
  r = await callC('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
  ok('C1 管理员登录', r.status === 200 && r.data.user.can_admin === 1 && r.data.user.can_mod === 1, JSON.stringify(r.data));
  const admin2Id = r.data.user.id;
  r = await callC('/api/admin/users');
  ok('C2 用户列表含 role 字段', r.status === 200 && r.data.every(u => 'role' in u));

  // 造两个普通用户 carol / dave
  await callC('/api/logout', { method: 'POST' });
  await callC('/api/register', { method: 'POST', body: { username: 'carol', password: 'carolpass1' } });
  await callC('/api/register', { method: 'POST', body: { username: 'dave', password: 'davepass1' } });
  const carolId = db.prepare('SELECT id FROM users WHERE username=?').get('carol').id;
  const daveId = db.prepare('SELECT id FROM users WHERE username=?').get('dave').id;

  // carol 发帖 + 回复，供后面治理测试
  r = await callC('/api/login', { method: 'POST', body: { username: 'carol', password: 'carolpass1' } });
  r = await callC('/api/threads', { method: 'POST', body: { title: 'carol的主题', body: '内容' } });
  const cTid = r.data.id;
  await callC('/api/threads/' + cTid + '/posts', { method: 'POST', body: { body: 'carol的回复' } });
  const cTid2 = (await callC('/api/threads', { method: 'POST', body: { title: 'carol的主题2', body: '内容2' } })).data.id;

  // 普通用户不能用任何管理接口
  r = await callC('/api/admin/moderate', { method: 'POST', body: { type: 'pin', id: cTid } });
  ok('C3 普通用户无法置顶(403)', r.status === 403, 'status=' + r.status);
  r = await callC('/api/admin/set-role', { method: 'POST', body: { id: daveId, role: 'moderator' } });
  ok('C4 普通用户无法任命子管理员(403)', r.status === 403);

  // 普通用户也不能碰管理员专属的删号接口
  r = await callC('/api/admin/delete-user', { method: 'POST', body: { id: daveId } });
  ok('C4b 普通用户无法删号(403)', r.status === 403, 'status=' + r.status);
  ok('C4c 目标用户未被删除', !!db.prepare('SELECT id FROM users WHERE id=?').get(daveId));

  // --- 管理员任命 dave 为子管理员 ---
  await callC('/api/logout', { method: 'POST' });
  await callC('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
  r = await callC('/api/admin/set-role', { method: 'POST', body: { id: daveId, role: 'moderator' } });
  ok('C5 管理员任命子管理员成功', r.status === 200, JSON.stringify(r.data));
  ok('C6 数据库中角色已更新', db.prepare('SELECT role FROM users WHERE id=?').get(daveId).role === 'moderator');
  r = await callC('/api/admin/set-role', { method: 'POST', body: { id: carolId, role: 'admin' } });
  ok('C7 不能通过 set-role 造管理员(403)', r.status === 403, JSON.stringify(r.data));
  r = await callC('/api/admin/set-role', { method: 'POST', body: { id: daveId, role: 'superuser' } });
  ok('C8 非法角色值被拒(400)', r.status === 400);

  // --- 子管理员 dave 的权限边界 ---
  await callC('/api/logout', { method: 'POST' });
  r = await callC('/api/login', { method: 'POST', body: { username: 'dave', password: 'davepass1' } });
  ok('C9 子管理员登录返回 can_mod=1/can_admin=0', r.status === 200 && r.data.user.can_mod === 1 && r.data.user.can_admin === 0, JSON.stringify(r.data));

  r = await callC('/api/admin/moderate', { method: 'POST', body: { type: 'pin', id: cTid } });
  ok('C10 子管理员可置顶(200)', r.status === 200, 'status=' + r.status);
  r = await callC('/api/admin/moderate', { method: 'POST', body: { type: 'lock', id: cTid } });
  ok('C11 子管理员可锁定(200)', r.status === 200);
  r = await callC('/api/admin/moderate', { method: 'POST', body: { type: 'deletePost', id: db.prepare('SELECT id FROM posts WHERE thread_id=?').get(cTid).id } });
  ok('C12 子管理员可删回复(200)', r.status === 200);
  r = await callC('/api/admin/moderate', { method: 'POST', body: { type: 'deleteThread', id: cTid2 } });
  ok('C13 子管理员可删主题(200)', r.status === 200);
  ok('C14 删主题时其下回复一并清除', db.prepare('SELECT COUNT(*) c FROM posts WHERE thread_id=?').get(cTid2).c === 0);

  r = await callC('/api/admin/moderate', { method: 'POST', body: { type: 'ban', id: carolId } });
  ok('C15 子管理员不能封禁用户(403)', r.status === 403, 'status=' + r.status);
  ok('C16 封禁确实未生效', db.prepare('SELECT banned FROM users WHERE id=?').get(carolId).banned === 0);
  r = await callC('/api/admin/users');
  ok('C17 子管理员不能读取用户列表(403)', r.status === 403);
  r = await callC('/api/admin/posts');
  ok('C18 子管理员不能读取内容总表(403)', r.status === 403);
  r = await callC('/api/admin/set-password', { method: 'POST', body: { id: carolId, newPassword: 'hacked12345' } });
  ok('C19 子管理员不能重置他人密码(403)', r.status === 403);
  r = await callC('/api/admin/set-role', { method: 'POST', body: { id: carolId, role: 'moderator' } });
  ok('C20 子管理员不能任命子管理员(403)', r.status === 403);
  r = await callC('/api/admin/delete-user', { method: 'POST', body: { id: carolId } });
  ok('C21 子管理员不能删号(403)', r.status === 403);
  r = await callC('/api/admin/disable-2fa', { method: 'POST', body: { id: carolId } });
  ok('C22 子管理员不能关闭他人 2FA(403)', r.status === 403);
  r = await callC('/api/admin/unknown-action', { method: 'POST', body: {} });
  ok('C23 子管理员访问未知管理接口(403)', r.status === 403);

  // --- 管理员关闭他人 2FA ---
  await callC('/api/logout', { method: 'POST' });
  await callC('/api/login', { method: 'POST', body: { username: 'carol', password: 'carolpass1' } });
  const cSetup = await callC('/api/2fa/setup', { method: 'POST' });
  const cSecret = cSetup.data.secret;
  r = await callC('/api/2fa/enable', { method: 'POST', body: { secret: cSecret, code: await totp.totpAt(cSecret, Date.now()), password: 'carolpass1' } });
  ok('C24 carol 开启 2FA', r.status === 200);

  await callC('/api/logout', { method: 'POST' });
  await callC('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
  r = await callC('/api/admin/disable-2fa', { method: 'POST', body: { id: carolId } });
  ok('C25 管理员可关闭他人 2FA', r.status === 200, JSON.stringify(r.data));
  ok('C26 carol 的 2FA 已在库中关闭', db.prepare('SELECT totp_enabled FROM users WHERE id=?').get(carolId).totp_enabled === 0);
  r = await callC('/api/admin/disable-2fa', { method: 'POST', body: { id: carolId } });
  ok('C27 重复关闭提示未开启(400)', r.status === 400);
  r = await callC('/api/admin/disable-2fa', { method: 'POST', body: { id: admin2Id } });
  ok('C28 不能关闭管理员自己的 2FA(403)', r.status === 403);

  // --- 管理员直接删号 ---
  r = await callC('/api/admin/delete-user', { method: 'POST', body: { id: admin2Id } });
  ok('C29 管理员不能删自己(403)', r.status === 403, JSON.stringify(r.data));
  const carolThreads = db.prepare('SELECT COUNT(*) c FROM threads WHERE author_id=?').get(carolId).c;
  r = await callC('/api/admin/delete-user', { method: 'POST', body: { id: carolId } });
  ok('C30 管理员删号成功', r.status === 200, JSON.stringify(r.data));
  ok('C31 用户记录已删除', !db.prepare('SELECT id FROM users WHERE id=?').get(carolId));
  ok('C32 其主题一并删除', carolThreads > 0 && db.prepare('SELECT COUNT(*) c FROM threads WHERE author_id=?').get(carolId).c === 0);
  ok('C33 其会话一并清除', db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=?').get(carolId).c === 0);
  ok('C34 其待验证票据一并清除', db.prepare('SELECT COUNT(*) c FROM pending_2fa WHERE user_id=?').get(carolId).c === 0);
  r = await callC('/api/admin/delete-user', { method: 'POST', body: { id: carolId } });
  ok('C35 删不存在的用户(404)', r.status === 404);

  // --- 撤销子管理员 ---
  r = await callC('/api/admin/set-role', { method: 'POST', body: { id: daveId, role: 'user' } });
  ok('C36 管理员可撤销子管理员', r.status === 200);
  ok('C37 角色已回落为 user', db.prepare('SELECT role FROM users WHERE id=?').get(daveId).role === 'user');
  await callC('/api/logout', { method: 'POST' });
  await callC('/api/login', { method: 'POST', body: { username: 'dave', password: 'davepass1' } });
  r = await callC('/api/admin/moderate', { method: 'POST', body: { type: 'pin', id: cTid } });
  ok('C38 被撤销后不再有治理权限(403)', r.status === 403);

  // ============ D. 缺陷回归：封禁复检 / 未知 API 的 JSON 错误 ============
  console.log('\n--- D. 缺陷回归 ---');
  const envD = { DB: new D1(db), ASSETS: { fetch: async () => new Response('<html>nf</html>', { status: 404, headers: { 'content-type': 'text/html' } }) } };
  const callD = mkCaller(envD);

  // 未知 /api 路径必须返回 JSON，而不是静态资源的 HTML
  r = await callD('/api/definitely/not/a/route');
  ok('D1 未知 API 返回 404', r.status === 404, 'status=' + r.status);
  ok('D2 未知 API 返回 JSON 错误体', r.data && typeof r.data.error === 'string', JSON.stringify(r.data));

  // 封禁后，旧的 2FA 票据在 5 分钟窗口内也必须失效
  await callD('/api/logout', { method: 'POST' });
  await callD('/api/register', { method: 'POST', body: { username: 'erin', password: 'erinpass12' } });
  const erinId = db.prepare('SELECT id FROM users WHERE username=?').get('erin').id;
  await callD('/api/login', { method: 'POST', body: { username: 'erin', password: 'erinpass12' } });
  const eSetup = await callD('/api/2fa/setup', { method: 'POST' });
  await callD('/api/2fa/enable', { method: 'POST', body: { secret: eSetup.data.secret, code: await totp.totpAt(eSetup.data.secret, Date.now()), password: 'erinpass12' } });
  await callD('/api/logout', { method: 'POST' });
  r = await callD('/api/login', { method: 'POST', body: { username: 'erin', password: 'erinpass12' } });
  ok('D3 封禁前拿到 2FA 票据', r.status === 200 && r.data.need2fa === true);
  const erinPending = r.data.pending;

  // 管理员在票据有效期内把 erin 封禁
  await callD('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
  r = await callD('/api/admin/moderate', { method: 'POST', body: { type: 'ban', id: erinId } });
  ok('D4 管理员封禁 erin', r.status === 200);
  await callD('/api/logout', { method: 'POST' });

  r = await callD('/api/2fa/verify', { method: 'POST', body: { pending: erinPending, code: await totp.totpAt(eSetup.data.secret, Date.now()) } });
  ok('D5 已封禁账号不能用旧票据完成 2FA(403)', r.status === 403, 'status=' + r.status + ' ' + JSON.stringify(r.data));
  ok('D6 未签发新会话', db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=?').get(erinId).c === 0);

  // 封禁用户直接密码登录同样被拦
  r = await callD('/api/login', { method: 'POST', body: { username: 'erin', password: 'erinpass12' } });
  ok('D7 已封禁账号无法密码登录(403)', r.status === 403);

  // 发帖接口：正文按 10000 截断，不会 500（原「内容过长」分支是死代码）
  await callD('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
  r = await callD('/api/threads', { method: 'POST', body: { title: '超长正文', body: 'x'.repeat(20000) } });
  ok('D8 超长正文按 10000 截断而非报错', r.status === 200, 'status=' + r.status);
  ok('D9 截断长度正确', db.prepare('SELECT body FROM threads WHERE id=?').get(r.data.id).body.length === 10000);

  // ============ E. 无损升级：有数据的老库（0001+0002）升到 0003 ============
  console.log('\n--- E. 有数据的老库无损升级 ---');
  {
    // 造一个「线上老库」：只有 0001 + 0002，且已有真实用户/主题/回复/会话/2FA。
    // 刻意去掉 users 的内联 UNIQUE 约束（早期版本的建表差异），用来验证：
    //   1) 重建 users 表放宽 role 约束时，数据一行不丢；
    //   2) ensureSchema 会补上 username 唯一性，让「重名注册」继续被拦住。
    const old = newDb([]);
    old.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
        banned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author_id INTEGER NOT NULL REFERENCES users(id),
        body TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE pending_2fa (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const adminPw = await passwordHashFor('admin12345');
    const vivianPw = await passwordHashFor('vivianpass1');
    old.prepare(`INSERT INTO users(id,username,password_hash,role,banned,totp_secret,totp_enabled) VALUES(1,'admin',?,'admin',0,NULL,0)`).run(adminPw);
    old.prepare(`INSERT INTO users(id,username,password_hash,role) VALUES(2,'vivian',?,'user')`).run(vivianPw);
    old.prepare(`INSERT INTO users(id,username,password_hash,role) VALUES(3,'walt',?,'user')`).run(vivianPw);
    old.prepare(`INSERT INTO threads(id,title,author_id,body) VALUES(1,'老主题',2,'老正文')`).run();
    old.prepare(`INSERT INTO posts(id,thread_id,author_id,body) VALUES(1,1,3,'老回复')`).run();
    old.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('th1',2,${Date.now() + 1e6})`).run();
    old.prepare(`INSERT INTO pending_2fa(token_hash,user_id,expires_at) VALUES('ph1',3,${Date.now() + 1e6})`).run();

    const usersBefore = old.prepare('SELECT COUNT(*) c FROM users').get().c;
    const threadsBefore = old.prepare('SELECT COUNT(*) c FROM threads').get().c;
    const postsBefore = old.prepare('SELECT COUNT(*) c FROM posts').get().c;

    const envE = { DB: new D1(old), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const callE = mkCaller(envE);

    // 首次请求触发结构自检（等价于线上部署新代码后的第一个请求）
    r = await callE('/api/status');
    ok('E1 升级后 /api/status 正常', r.status === 200 && r.data.setupNeeded === false, JSON.stringify(r.data));

    ok('E2 users 行数未变', old.prepare('SELECT COUNT(*) c FROM users').get().c === usersBefore);
    ok('E3 threads 行数未变', old.prepare('SELECT COUNT(*) c FROM threads').get().c === threadsBefore);
    ok('E4 posts 行数未变', old.prepare('SELECT COUNT(*) c FROM posts').get().c === postsBefore);
    ok('E5 老用户数据完整', old.prepare('SELECT username,role FROM users WHERE id=2').get().username === 'vivian');
    ok('E6 会话未丢失', old.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=2').get().c === 1);
    ok('E7 待验证票据未丢失', old.prepare('SELECT COUNT(*) c FROM pending_2fa WHERE user_id=3').get().c === 1);
    ok('E8 外键声明仍然存在（未丢约束）', old.prepare('PRAGMA foreign_key_list(posts)').all().length > 0);

    // 升级后可正常任命子管理员（用真实密码哈希，验证升级没破坏认证）
    r = await callE('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } });
    ok('E9 老库管理员可用原密码登录（密码哈希未被改写）', r.status === 200, 'status=' + r.status + ' ' + JSON.stringify(r.data));
    r = await callE('/api/admin/set-role', { method: 'POST', body: { id: 2, role: 'moderator' } });
    ok('E10 升级后可任命子管理员', r.status === 200, JSON.stringify(r.data));
    ok('E11 角色确实写入', old.prepare('SELECT role FROM users WHERE id=2').get().role === 'moderator');
    r = await callE('/api/admin/moderate', { method: 'POST', body: { type: 'pin', id: 1 } });
    ok('E12 老库升级后子管理员可置顶', r.status === 200);
    ok('E13 老主题置顶标记已写入', old.prepare('SELECT pinned FROM threads WHERE id=1').get().pinned === 1);

    // 升级补上了 username 唯一性，重名注册必须被拦住
    await callE('/api/logout', { method: 'POST' });
    r = await callE('/api/register', { method: 'POST', body: { username: 'vivian', password: 'whatever12' } });
    ok('E13b 升级后用户名唯一性已生效', r.status === 409, 'status=' + r.status);

    // 重复请求 = 重复执行自检，必须幂等
    r = await callE('/api/status');
    ok('E14 自检可重复执行（幂等）', r.status === 200 && old.prepare('SELECT COUNT(*) c FROM users').get().c === usersBefore);
  }

  // ============ F. 附件存储：ZIP 往返 + 清除门禁 ============
  console.log('\n--- F. 附件存储 ---');
  {
    // Worker 没导出这些内部工具，测试就照 TOTP 的老办法：从源码里整段取出来跑
    const zipBlock = src.slice(src.indexOf('/* ---- CRC32'), src.indexOf('/* ---- 站点设置读写'));
    const zipMod = new Function('encoder','TextDecoder','DecompressionStream','Blob','Response','ReadableStream',
      zipBlock + '\nreturn { crc32, zipEntries, zipStream, parseZipBytes };'
    )(new TextEncoder(), TextDecoder, DecompressionStream, Blob, Response, ReadableStream);
    const { crc32, zipEntries, zipStream, parseZipBytes } = zipMod;

    const enc = new TextEncoder();
    ok('F1 CRC32 同输入结果稳定', crc32(enc.encode('hello')) === crc32(enc.encode('hello')));
    ok('F2 CRC32 不同输入结果不同', crc32(enc.encode('hello')) !== crc32(enc.encode('world')));

    // 手写 ZIP 最容易在偏移/长度上翻车，所以必须做一次完整的「写进去再读出来」
    const mk = (name, s) => ({ name, bytes: enc.encode(s) });
    const stream = zipStream(zipEntries([mk('files/1-照片.png','图片'), mk('files/2-note.txt','hello world'), mk('manifest.json','{"a":1}')]));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    const parsed = parseZipBytes(buf);
    const byName = Object.fromEntries(parsed.map(f => [f.name, f]));
    ok('F3 ZIP 条目数一致', parsed.length === 3, '实际 ' + parsed.length);
    ok('F4 ZIP 中文文件名往返正确', !!byName['files/1-照片.png']);
    ok('F5 ZIP 内容往返正确', new TextDecoder().decode(byName['files/2-note.txt'].bytes) === 'hello world');
    const manBytes = enc.encode('{"a":1}');
    ok('F6 ZIP 记录的 CRC 与重算一致', crc32(manBytes) === byName['manifest.json'].crc);
    ok('F7 ZIP 记录的大小正确', byName['manifest.json'].size === manBytes.length);
  }

  {
    // 清除是不可逆操作，门禁必须拦得住：没备份 → 拦；备份后又有新附件 → 拦
    const db2 = newDb(['0001_init.sql','0002_account_features.sql','0004_files.sql']);
    const env2 = { DB: new D1(db2), ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
    const call2 = mkCaller(env2);

    let r = await call2('/api/setup', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });
    ok('F8 初始化管理员', r.status === 200, JSON.stringify(r.data));
    r = await call2('/api/login', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });
    ok('F9 管理员登录', r.status === 200);

    await call2('/api/logout', { method:'POST' });
    await call2('/api/register', { method:'POST', body:{ username:'picman', password:'picpass123' } });
    r = await call2('/api/login', { method:'POST', body:{ username:'picman', password:'picpass123' } });
    ok('F10 普通用户登录', r.status === 200);
    const uid = r.data.user.id;
    r = await call2('/api/threads', { method:'POST', body:{ title:'带图主题', body:'看看这张 [img:1]' } });
    ok('F11 发布带图主题', r.status === 200, JSON.stringify(r.data));
    // 直接插一条附件记录（本例没配存储，远端删除会被安全跳过，正好只验证本地逻辑）
    db2.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size) VALUES(1,?,?,?,?)`)
       .run(uid, 'attachments/x/y.png', 'image/png', 123);

    await call2('/api/logout', { method:'POST' });
    await call2('/api/login', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });

    r = await call2('/api/admin/storage-purge', { method:'POST', body:{ confirm:'DELETE' } });
    ok('F12 未确认备份时禁止清除', r.status === 403, 'status=' + r.status);
    r = await call2('/api/threads');
    ok('F13 被拒后主题仍在', (r.data?.items || []).length === 1);

    r = await call2('/api/admin/storage-confirm', { method:'POST', body:{} });
    ok('F14 记录备份确认', r.status === 200 && r.data.count === 1, JSON.stringify(r.data));

    // 备份之后又冒出新附件 → 手里的备份不完整，必须重新导出
    db2.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size) VALUES(2,?,?,?,?)`)
       .run(uid, 'attachments/x/z.png', 'image/png', 1);
    r = await call2('/api/admin/storage-purge', { method:'POST', body:{ confirm:'DELETE' } });
    ok('F15 备份后新增附件则拒绝清除', r.status === 409, 'status=' + r.status);

    db2.prepare(`DELETE FROM attachments WHERE id=2`).run();
    r = await call2('/api/admin/storage-purge', { method:'POST', body:{ confirm:'DELETE' } });
    ok('F16 确认后可清除', r.status === 200, JSON.stringify(r.data));
    ok('F17 报告显示清除了带图主题', r.data.removedThreads === 1, JSON.stringify(r.data));
    r = await call2('/api/threads');
    ok('F18 带图主题确实已删除', (r.data?.items || []).length === 0);
    const cnt = db2.prepare(`SELECT COUNT(*) n FROM attachments`).get().n;
    ok('F19 附件记录已清空', cnt === 0, 'count=' + cnt);
  }

  // ============ G. 安全加固 ============
  console.log('\n--- G. 安全加固 ---');
  {
    const db3 = newDb(['0001_init.sql','0002_account_features.sql','0004_files.sql','0005_security.sql']);
    const env3 = { DB: new D1(db3), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const call3 = mkCaller(env3);

    // 初始化必须只能成功一次 —— 原先「先查后插」在并发下会造出两名管理员
    let r = await call3('/api/setup', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });
    ok('G1 首次初始化成功', r.status === 200, JSON.stringify(r.data));
    r = await call3('/api/setup', { method:'POST', body:{ username:'boss2', password:'bosspass12345' } });
    ok('G2 重复初始化被拒(409)', r.status === 409, 'status=' + r.status);
    const adminCount = db3.prepare(`SELECT COUNT(*) n FROM users WHERE role='admin'`).get().n;
    ok('G3 管理员始终只有一个', adminCount === 1, 'count=' + adminCount);

    // 登录暴力破解：连错到上限后必须被挡住
    let got429 = false, tries = 0;
    for (let i = 0; i < 12; i++) {
      r = await call3('/api/login', { method:'POST', body:{ username:'boss', password:'definitely-wrong' } });
      tries++;
      if (r.status === 429) { got429 = true; break; }
    }
    ok('G4 登录连错会被限流', got429, tries + ' 次后触发');

    // 敏感操作（改密码）验密失败同样要限流
    await call3('/api/register', { method:'POST', body:{ username:'guard', password:'guardpass12' } });
    r = await call3('/api/login', { method:'POST', body:{ username:'guard', password:'guardpass12' } });
    ok('G5 新用户登录成功', r.status === 200, 'status=' + r.status);
    let s429 = false, sTries = 0;
    for (let i = 0; i < 8; i++) {
      r = await call3('/api/account/password', { method:'POST', body:{ password:'wrong', newPassword:'newpass123' } });
      sTries++;
      if (r.status === 429) { s429 = true; break; }
    }
    ok('G6 敏感操作验密连错会被限流', s429, sTries + ' 次后触发');
  }

  // ============ H. 讨论板块 ============
  console.log('\n--- H. 讨论板块 ---');
  {
    // H1/H2：老库（0001 而已）自愈后，板块结构也必须就位 ——
    // ensureSchema 里 boards 是「先补 → 重建 users → 再补一次」，
    // 少补一次这条路线上的板块功能就会静默失效（E10/E11 踩过）。
    {
      const envOld = { DB: new D1(newDb(['0001_init.sql'])), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
      const cOld = mkCaller(envOld);
      await cOld('/api/status');
      const tables = envOld.DB.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
      ok('H1 老库自愈后创建了 boards 表', tables.includes('boards'), tables.join(','));
      const cols = envOld.DB.db.prepare(`PRAGMA table_info(threads)`).all().map(c => c.name);
      ok('H2 老库自愈后 threads 有 board_id 列', cols.includes('board_id'), cols.join(','));
    }

    const db4 = newDb(['0001_init.sql','0002_account_features.sql','0004_files.sql','0005_security.sql','0006_boards.sql']);
    const env4 = { DB: new D1(db4), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const call = mkCaller(env4);

    let r = await call('/api/setup', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });
    ok('H3 初始化管理员', r.status === 200);
    await call('/api/register', { method:'POST', body:{ username:'kate', password:'katepass123' } });
    r = await call('/api/login', { method:'POST', body:{ username:'kate', password:'katepass123' } });

    // 未登录不能建板块
    await call('/api/logout', { method:'POST' });
    r = await call('/api/boards', { method:'POST', body:{ name:'闲聊' } });
    ok('H4 未登录创建板块被拒(401)', r.status === 401, 'status=' + r.status);
    ok('H5 板块列表是公开的(200)', (await call('/api/boards')).status === 200);

    // 普通用户可以建板块
    await call('/api/login', { method:'POST', body:{ username:'kate', password:'katepass123' } });
    r = await call('/api/boards', { method:'POST', body:{ name:'闲聊', description:'随便聊点什么' } });
    ok('H6 普通用户可创建板块', r.status === 200 && !!r.data.id, JSON.stringify(r.data));
    const bid = r.data.id;
    r = await call('/api/boards', { method:'POST', body:{ name:'闲聊' } });
    ok('H7 重名板块被拒(409)', r.status === 409, 'status=' + r.status);
    r = await call('/api/boards', { method:'POST', body:{ name:'a' } });
    ok('H8 名称过短被拒(400)', r.status === 400, 'status=' + r.status);
    r = await call('/api/boards', { method:'POST', body:{ name:'数码' } });
    const bid2 = r.data.id;

    // 发帖可以指定板块；乱填 boardId 不应让发帖失败
    r = await call('/api/threads', { method:'POST', body:{ title:'数码贴', body:'内容', boardId:bid2 } });
    const t2 = r.data.id;
    ok('H9 指定板块发帖成功', r.status === 200);
    r = await call('/api/threads', { method:'POST', body:{ title:'乱填板块', body:'内容', boardId:99999 } });
    const t3 = r.data.id;
    ok('H10 板块不存在时也能发帖（落到未分类）', r.status === 200);
    ok('H11 该帖确实没有板块',
      db4.prepare(`SELECT board_id FROM threads WHERE id=?`).get(t3).board_id === null);

    // 按板块过滤
    r = await call('/api/threads?board=' + bid2);
    ok('H12 按板块过滤只返回该板块的帖', (r.data?.items||[]).length === 1 && r.data.items[0].id === t2, JSON.stringify((r.data?.items||[]).map(x=>x.id)));
    ok('H13 列表里带上了板块名', r.data.items[0].board_name === '数码', JSON.stringify(r.data.items[0].board_name));
    r = await call('/api/threads?board=none');
    ok('H14 ?board=none 只返回未分类', (r.data?.items||[]).length === 1 && r.data.items[0].id === t3, JSON.stringify((r.data?.items||[]).map(x=>x.id)));
    r = await call('/api/boards');
    ok('H15 板块列表带帖子计数', r.data.boards.find(b=>b.id===bid2).threads === 1, JSON.stringify(r.data));
    ok('H16 板块列表统计未分类数量', r.data.unboarded === 1, JSON.stringify(r.data.unboarded));

    // 删除权限：普通用户/子管理员都不行
    r = await call('/api/boards/' + bid, { method:'DELETE' });
    ok('H17 普通用户不能删板块(403)', r.status === 403, 'status=' + r.status);
    await call('/api/logout', { method:'POST' });
    await call('/api/login', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });
    r = await call('/api/admin/set-role', { method:'POST', body:{ id: db4.prepare(`SELECT id FROM users WHERE username='kate'`).get().id, role:'moderator' } });
    ok('H18 管理员任命子管理员成功', r.status === 200);
    await call('/api/logout', { method:'POST' });
    await call('/api/login', { method:'POST', body:{ username:'kate', password:'katepass123' } });
    r = await call('/api/boards/' + bid, { method:'DELETE' });
    ok('H19 子管理员也不能删板块(403)', r.status === 403, 'status=' + r.status);

    // 子管理员可以移动主题（可逆的轻操作），但不能建/删板块之外的管理员动作
    r = await call('/api/admin/moderate', { method:'POST', body:{ type:'moveThread', id:t3, boardId:bid2 } });
    ok('H20 子管理员可移动主题到板块', r.status === 200, 'status=' + r.status);
    ok('H21 主题归属已改变',
      db4.prepare(`SELECT board_id FROM threads WHERE id=?`).get(t3).board_id === bid2);
    r = await call('/api/admin/moderate', { method:'POST', body:{ type:'moveThread', id:t3, boardId:0 } });
    ok('H22 可以移回未分类', r.status === 200 &&
      db4.prepare(`SELECT board_id FROM threads WHERE id=?`).get(t3).board_id === null);
    r = await call('/api/admin/moderate', { method:'POST', body:{ type:'moveThread', id:t3, boardId:99999 } });
    ok('H23 移到不存在的板块被拒(404)', r.status === 404, 'status=' + r.status);

    // 普通用户不能移动别人的帖子
    await call('/api/logout', { method:'POST' });
    await call('/api/register', { method:'POST', body:{ username:'nobody', password:'nobodypass1' } });
    await call('/api/login', { method:'POST', body:{ username:'nobody', password:'nobodypass1' } });
    r = await call('/api/admin/moderate', { method:'POST', body:{ type:'moveThread', id:t2, boardId:bid } });
    ok('H24 普通用户不能移动主题(403)', r.status === 403, 'status=' + r.status);

    // 管理员删除板块：帖子不删，回到未分类
    await call('/api/logout', { method:'POST' });
    await call('/api/login', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });
    const before = db4.prepare(`SELECT COUNT(*) n FROM threads`).get().n;
    r = await call('/api/boards/' + bid2, { method:'DELETE' });
    ok('H25 管理员可删板块', r.status === 200 && r.data.moved === 1, JSON.stringify(r.data));
    ok('H26 删板块不会删掉帖子', db4.prepare(`SELECT COUNT(*) n FROM threads`).get().n === before);
    ok('H27 原板块下的帖回到未分类',
      db4.prepare(`SELECT board_id FROM threads WHERE id=?`).get(t2).board_id === null);
    r = await call('/api/boards/' + bid2, { method:'DELETE' });
    ok('H28 删不存在的板块(404)', r.status === 404, 'status=' + r.status);
  }

  // ============ J. 搜索与分页 ============
  console.log('\n--- J. 搜索与分页 ---');
  {
    const db5 = newDb(['0001_init.sql','0002_account_features.sql','0004_files.sql','0005_security.sql','0006_boards.sql']);
    const env5 = { DB: new D1(db5), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const call = mkCaller(env5);
    await call('/api/setup', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });
    await call('/api/login', { method:'POST', body:{ username:'boss', password:'bosspass12345' } });

    // 造 25 条帖：编号同时写进标题和正文，方便精确核对命中
    const ids = [];
    for (let i = 1; i <= 25; i++) {
      const rr = await call('/api/threads', { method:'POST', body:{ title:`贴子${i}`, body:`正文${i} 关键词猫` } });
      ids.push(rr.data.id);
    }
    ok('J1 造出 25 条主题', ids.length === 25 && ids.every(Boolean), JSON.stringify(ids.slice(0,3)));

    let r = await call('/api/threads');
    ok('J2 默认每页 20 条', r.data.items.length === 20, JSON.stringify(r.data.items.length));
    ok('J3 total 是筛选后的总数而非本页条数', r.data.total === 25, JSON.stringify(r.data.total));
    ok('J4 页数按总数算', r.data.pages === 2 && r.data.page === 1, JSON.stringify({page:r.data.page,pages:r.data.pages}));

    const p1 = r.data.items.map(t=>t.id);
    r = await call('/api/threads?page=2');
    const p2 = r.data.items.map(t=>t.id);
    ok('J5 第二页是剩下的 5 条', p2.length === 5, JSON.stringify(p2.length));
    ok('J6 翻页不重不漏', new Set([...p1,...p2]).size === 25, JSON.stringify({u:new Set([...p1,...p2]).size}));

    // 页码越界：夹到边界，而不是甩一个空列表给人
    r = await call('/api/threads?page=999');
    ok('J7 页码越界夹到最后一页', r.data.page === 2 && r.data.items.length === 5, JSON.stringify({page:r.data.page,n:r.data.items.length}));
    ok('J8 page=0 夹到第一页', (await call('/api/threads?page=0')).data.page === 1);
    ok('J9 非法页码退化成 1', (await call('/api/threads?page=abc')).data.page === 1);

    r = await call('/api/threads?limit=999');
    ok('J10 limit 封顶 50', r.data.limit === 50, JSON.stringify(r.data.limit));
    r = await call('/api/threads?limit=3');
    ok('J11 自定义 limit 生效', r.data.items.length === 3 && r.data.pages === 9, JSON.stringify({n:r.data.items.length,pages:r.data.pages}));

    // 搜索：标题 / 正文 / 作者名
    r = await call('/api/threads?q=' + encodeURIComponent('贴子7'));
    ok('J12 按标题搜索命中唯一一条', r.data.items.length === 1 && r.data.items[0].title === '贴子7', JSON.stringify(r.data.items.map(t=>t.title)));
    r = await call('/api/threads?q=' + encodeURIComponent('正文13'));
    ok('J13 按正文搜索命中', r.data.items.length === 1 && r.data.items[0].title === '贴子13', JSON.stringify(r.data.items.map(t=>t.title)));
    r = await call('/api/threads?q=' + encodeURIComponent('boss'));
    ok('J14 可按作者名搜索', r.data.total === 25, JSON.stringify(r.data.total));
    r = await call('/api/threads?q=' + encodeURIComponent('不存在的词'));
    ok('J15 搜不到时是空列表且 page=1/pages=1', r.data.items.length === 0 && r.data.page === 1 && r.data.pages === 1, JSON.stringify(r.data));

    // LIKE 通配符必须转义，否则搜「%」会变成全表匹配
    const rp = await call('/api/threads', { method:'POST', body:{ title:'折扣50%', body:'半价' } });
    r = await call('/api/threads?q=' + encodeURIComponent('%'));
    ok('J16 % 不当通配符', r.data.total === 1 && r.data.items[0].id === rp.data.id, JSON.stringify({total:r.data.total}));
    r = await call('/api/threads?q=' + encodeURIComponent('50%'));
    ok('J17 含 % 的子串仍能搜到', r.data.total === 1, JSON.stringify(r.data.total));
    r = await call('/api/threads?q=_');
    ok('J18 _ 不当单字通配符', r.data.total === 0, JSON.stringify(r.data.total));

    // 搜索与板块是叠加关系
    const bid = (await call('/api/boards', { method:'POST', body:{ name:'摄影' } })).data.id;
    const rc = await call('/api/threads', { method:'POST', body:{ title:'相机贴', body:'正文相机', boardId:bid } });
    r = await call('/api/threads?q=' + encodeURIComponent('相机') + '&board=' + bid);
    ok('J19 板块内搜索命中', r.data.total === 1 && r.data.items[0].id === rc.data.id, JSON.stringify(r.data.total));
    r = await call('/api/threads?q=' + encodeURIComponent('相机') + '&board=none');
    ok('J20 别的板块搜不到', r.data.total === 0, JSON.stringify(r.data.total));

    // 超长关键词截断而不是报错
    r = await call('/api/threads?q=' + encodeURIComponent('x'.repeat(200)));
    ok('J21 超长关键词被截断且不报错', r.status === 200 && r.data.q.length === 60, JSON.stringify({s:r.status,len:r.data.q.length}));

    // 置顶帖必须落在第一页最前，翻页时不会消失
    await call('/api/admin/moderate', { method:'POST', body:{ type:'pin', id:ids[24] } });
    r = await call('/api/threads?page=1');
    ok('J22 置顶帖排在第一页最前', r.data.items[0].id === ids[24], JSON.stringify(r.data.items[0].id));
  }

  // ============ K. 楼中楼 / 编辑痕迹 / 用户主页 ============
  console.log('\n--- K. 楼中楼 / 编辑痕迹 / 用户主页 ---');
  {
    // 刻意**不带** 0007：验证 ensureSchema 能自己把新列补出来（线上库不会重跑迁移）
    const dbk = newDb(['0001_init.sql','0002_account_features.sql','0004_files.sql','0005_security.sql','0006_boards.sql']);
    const envk = { DB: new D1(dbk), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const A = mkCaller(envk), B = mkCaller(envk);
    await A('/api/setup', { method:'POST', body:{ username:'anna', password:'annapass12345' } });
    await A('/api/register', { method:'POST', body:{ username:'ben', password:'benpass12345' } });
    await A('/api/login', { method:'POST', body:{ username:'anna', password:'annapass12345' } });
    await B('/api/login', { method:'POST', body:{ username:'ben', password:'benpass12345' } });

    const tid = (await A('/api/threads', { method:'POST', body:{ title:'主帖', body:'正文' } })).data.id;
    await A('/api/threads/'+tid+'/posts', { method:'POST', body:{ body:'一楼' } });
    let r = await A('/api/threads/'+tid);
    const p1 = r.data.posts[0].id;

    // --- 楼中楼 ---
    r = await B('/api/threads/'+tid+'/posts', { method:'POST', body:{ body:'回一楼', replyTo:p1 } });
    ok('K1 回复可指定 replyTo', r.status === 200 && r.data.replyTo === p1, JSON.stringify(r.data));
    r = await A('/api/threads/'+tid);
    ok('K2 reply_to 落库正确', r.data.posts[1].reply_to === p1, JSON.stringify(r.data.posts[1].reply_to));

    // 跨主题引用必须被丢弃（不能把别的楼的回复挂进来）
    const tid2 = (await A('/api/threads', { method:'POST', body:{ title:'另一帖', body:'正文' } })).data.id;
    r = await A('/api/threads/'+tid2+'/posts', { method:'POST', body:{ body:'乱指', replyTo:p1 } });
    ok('K3 跨主题 replyTo 被丢弃', r.status === 200 && !r.data.replyTo, JSON.stringify(r.data));

    // 父楼被删，子楼保留但退回顶层（ON DELETE SET NULL）
    const p2 = (await A('/api/threads/'+tid)).data.posts[1].id;
    await A('/api/admin/moderate', { method:'POST', body:{ type:'deletePost', id:p1 } });
    ok('K4 父楼删除后子楼仍在', dbk.prepare(`SELECT COUNT(*) n FROM posts WHERE id=?`).get(p2).n === 1);
    ok('K5 子楼的 reply_to 被置空',
      dbk.prepare(`SELECT reply_to FROM posts WHERE id=?`).get(p2).reply_to === null);

    // --- 编辑 ---
    await A('/api/threads/'+tid+'/posts', { method:'POST', body:{ body:'我要改这句' } });
    const p3 = (await A('/api/threads/'+tid)).data.posts.find(x=>x.body==='我要改这句').id;
    r = await A('/api/posts/'+p3, { method:'PATCH', body:{ body:'改好了' } });
    ok('K6 作者可编辑自己的回复', r.status === 200 && r.data.changed === true, JSON.stringify(r.data));
    ok('K7 正文已更新且记下 edited_at',
      dbk.prepare(`SELECT body,edited_at FROM posts WHERE id=?`).get(p3).body === '改好了' &&
      !!dbk.prepare(`SELECT edited_at FROM posts WHERE id=?`).get(p3).edited_at);
    r = await B('/api/posts/'+p3, { method:'PATCH', body:{ body:'别人乱改' } });
    ok('K8 非作者编辑被拒(403)', r.status === 403, 'status=' + r.status);
    r = await A('/api/posts/'+p3, { method:'PATCH', body:{ body:'' } });
    ok('K9 编辑成空正文被拒(400)', r.status === 400, 'status=' + r.status);
    r = await A('/api/posts/'+p3, { method:'PATCH', body:{ body:'改好了' } });
    ok('K10 内容没变则不算改动', r.status === 200 && r.data.changed === false, JSON.stringify(r.data));

    // --- 编辑痕迹 ---
    r = await A('/api/posts/'+p3+'/edits');
    ok('K11 作者可看编辑记录', r.status === 200 && r.data.edits.length === 1, JSON.stringify(r.data.edits.length));
    ok('K12 记录里含改前改后', r.data.edits[0].before_body === '我要改这句' && r.data.edits[0].after_body === '改好了', JSON.stringify(r.data.edits[0]));
    r = await B('/api/posts/'+p3+'/edits');
    ok('K13 他人不能看编辑记录(403)', r.status === 403, 'status=' + r.status);

    // 主题编辑：标题 + 正文
    r = await A('/api/threads/'+tid, { method:'PATCH', body:{ title:'主帖（改）', body:'正文改过' } });
    ok('K14 作者可编辑主题', r.status === 200 && r.data.changed === true, JSON.stringify(r.data));
    ok('K15 主题标题与正文都更新了',
      dbk.prepare(`SELECT title,body,edited_at FROM threads WHERE id=?`).get(tid).title === '主帖（改）' &&
      !!dbk.prepare(`SELECT edited_at FROM threads WHERE id=?`).get(tid).edited_at);
    r = await B('/api/threads/'+tid, { method:'PATCH', body:{ body:'乱改' } });
    ok('K16 非作者不能编辑主题(403)', r.status === 403, 'status=' + r.status);
    r = await A('/api/threads/'+tid+'/edits');
    ok('K17 主题编辑记录可查', r.status === 200 && r.data.edits.length === 1, JSON.stringify(r.data.edits.length));

    // 锁定的主题：作者本人（非管理员）改不了，管理员仍可代改
    await B('/api/threads/'+tid+'/posts', { method:'POST', body:{ body:'ben 的回复' } });
    const pBen = (await A('/api/threads/'+tid)).data.posts.find(x => x.body === 'ben 的回复').id;
    await A('/api/admin/moderate', { method:'POST', body:{ type:'lock', id:tid } });
    r = await B('/api/posts/'+pBen, { method:'PATCH', body:{ body:'锁了还想改' } });
    ok('K18 锁定后作者本人也改不了(403)', r.status === 403, 'status=' + r.status);
    r = await A('/api/posts/'+pBen, { method:'PATCH', body:{ body:'管理员代改' } });
    ok('K19 管理员仍可编辑锁定主题里的回复', r.status === 200, 'status=' + r.status);
    // 子管理员编辑自己的回复（未锁定的帖子）应该照常放行。
    // 注意顺序：set-role 会让该用户的所有会话失效，所以先发帖、再提权、最后重新登录。
    await B('/api/threads/'+tid2+'/posts', { method:'POST', body:{ body:'ben 在另一帖' } });
    const pBen2 = (await A('/api/threads/'+tid2)).data.posts.find(x => x.body === 'ben 在另一帖').id;
    const benId = dbk.prepare(`SELECT id FROM users WHERE username='ben'`).get().id;
    await A('/api/admin/set-role', { method:'POST', body:{ id:benId, role:'moderator' } });
    const M = mkCaller(envk);
    await M('/api/login', { method:'POST', body:{ username:'ben', password:'benpass12345' } });
    r = await M('/api/posts/'+pBen2, { method:'PATCH', body:{ body:'ben 自己改' } });
    ok('K19b 子管理员可编辑自己的回复', r.status === 200, 'status=' + r.status);

    // --- 用户主页 ---
    r = await B('/api/users/' + dbk.prepare(`SELECT id FROM users WHERE username='anna'`).get().id);
    ok('K20 用户主页是公开的', r.status === 200, 'status=' + r.status);
    ok('K21 主页含统计与最近内容', r.data.stats.threads === 2 && Array.isArray(r.data.threads) && Array.isArray(r.data.posts), JSON.stringify(r.data.stats));
    ok('K22 主页不含敏感字段', !('password_hash' in r.data.user) && !('totp_secret' in r.data.user), JSON.stringify(Object.keys(r.data.user)));
    r = await B('/api/users/99999');
    ok('K23 不存在的用户(404)', r.status === 404, 'status=' + r.status);

    // --- 头像与签名档 ---
    r = await A('/api/account/profile', { method:'POST', body:{ avatar:'emoji:🐱', bio:'一只猫' } });
    ok('K24 可设置 emoji 头像与签名', r.status === 200 && r.data.user.avatar === 'emoji:🐱' && r.data.user.bio === '一只猫', JSON.stringify(r.data.user));
    r = await A('/api/account/profile', { method:'POST', body:{ avatar:'emoji:' + 'x'.repeat(40) } });
    ok('K25 过长/畸形头像被拒(400)', r.status === 400, 'status=' + r.status);
    r = await A('/api/account/profile', { method:'POST', body:{ avatar:'att:99999' } });
    ok('K26 用别人的或不存在的附件当头像(400)', r.status === 400, 'status=' + r.status);
    // 非图片附件不能当头像
    const annaId = dbk.prepare(`SELECT id FROM users WHERE username='anna'`).get().id;
    dbk.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size) VALUES(91,?,?,?,?)`).run(annaId,'k/txt.png','text/plain',10);
    r = await A('/api/account/profile', { method:'POST', body:{ avatar:'att:91' } });
    ok('K27 非图片附件不能当头像(400)', r.status === 400, 'status=' + r.status);
    dbk.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size) VALUES(92,?,?,?,?)`).run(annaId,'k/p.png','image/png',10);
    r = await A('/api/account/profile', { method:'POST', body:{ avatar:'att:92' } });
    ok('K28 自己上传的图片可以当头像', r.status === 200 && r.data.user.avatar === 'att:92', JSON.stringify(r.data.user));
    r = await A('/api/account/profile', { method:'POST', body:{ bio:'x'.repeat(300) } });
    ok('K29 过长签名被截断到 140', r.data.user.bio.length === 140, JSON.stringify(r.data.user.bio.length));
    r = await A('/api/status');
    ok('K30 /api/status 带上头像与签名', r.data.user.avatar === 'att:92' && r.data.user.bio.length === 140, JSON.stringify(r.data.user.avatar));
    // 列表与详情都要带作者头像，否则前端画不出头像
    r = await B('/api/threads');
    ok('K31 列表带作者头像', 'avatar' in (r.data.items[0] || {}), JSON.stringify(Object.keys(r.data.items[0] || {})));
    r = await B('/api/threads/'+tid2);
    ok('K32 详情带作者头像与签名', 'avatar' in r.data.thread && 'bio' in r.data.thread, JSON.stringify(Object.keys(r.data.thread)));

    // --- 主页内搜索：只在这个人的内容里找 ---
    const anna = dbk.prepare(`SELECT id FROM users WHERE username='anna'`).get().id;
    r = await B('/api/users/'+anna+'?q=' + encodeURIComponent('另一帖'));
    ok('K33 主页搜索命中该用户的主题', r.data.threads.length === 1 && r.data.threads[0].title === '另一帖', JSON.stringify(r.data.threads.map(t=>t.title)));
    ok('K34 主页搜索不越界到别人家的帖', r.data.threads.every(t => t.title === '另一帖'), JSON.stringify(r.data.threads.map(t=>t.title)));
    r = await B('/api/users/'+anna+'?q=' + encodeURIComponent('改好'));
    ok('K35 回复内容也能搜到', r.data.posts.length === 1 && r.data.posts[0].body === '改好了', JSON.stringify(r.data.posts.map(p=>p.body)));
    ok('K36 统计仍是全量，不跟着关键词缩水', r.data.stats.threads === 2, JSON.stringify(r.data.stats));
    r = await B('/api/users/'+anna+'?q=' + encodeURIComponent('%'));
    ok('K37 主页搜索里的 % 不当通配符', r.data.threads.length === 0 && r.data.posts.length === 0, JSON.stringify({t:r.data.threads.length,p:r.data.posts.length}));
    ok('K38 关键词原样回显', (await B('/api/users/'+anna+'?q=zzz')).data.q === 'zzz');
  }

  // ============ L. 附件分目录存储 / 头像上传 ============
  console.log('\n--- L. 分目录存储与头像上传 ---');
  {
    const bytesOf = (...parts) => {
      const out = [];
      for (const p of parts) {
        if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0) & 0xff);
        else if (Array.isArray(p)) out.push(...p);
      }
      return new Uint8Array(out);
    };
    const PNG = bytesOf([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], [0, 0, 0, 13], 'IHDR');
    const WAV = bytesOf('RIFF', [0, 0, 0, 0], 'WAVE');
    const MP4 = bytesOf([0, 0, 0, 24], 'ftyp', 'isom', 'avc1');

    const dbL = newDb(['0001_init.sql','0002_account_features.sql','0004_files.sql','0005_security.sql','0006_boards.sql']);
    const putKeys = [];
    // 用假的 R2 bucket 顶替真实存储：只记录写进来的 key，不碰网络
    const envL = {
      DB: new D1(dbL), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) },
      BUCKET: { async put(k) { putKeys.push(k) }, async get() { return null }, async delete() {} },
    };
    dbL.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('storage_config',?,datetime('now'))`)
       .run(JSON.stringify({ type:'r2', enabled:true, r2:{ binding:'BUCKET' } }));
    const C = mkCaller(envL);
    await C('/api/setup', { method:'POST', body:{ username:'zoe', password:'zoepass12345' } });
    await C('/api/login', { method:'POST', body:{ username:'zoe', password:'zoepass12345' } });

    // 按类型分目录
    let r = await C('/api/upload', { method:'POST', body:PNG });
    ok('L1 图片上传成功', r.status === 200 && !!r.data.id, JSON.stringify(r.data));
    ok('L2 图片落在 images/', putKeys[0].startsWith('images/'), putKeys[0]);
    r = await C('/api/upload', { method:'POST', body:WAV });
    ok('L3 音频落在 audios/', r.status === 200 && putKeys[1].startsWith('audios/'), putKeys[1]);
    r = await C('/api/upload', { method:'POST', body:MP4 });
    ok('L4 视频落在 videos/', r.status === 200 && putKeys[2].startsWith('videos/'), putKeys[2]);
    ok('L5 路径仍按日期分层', /^(images|audios|videos)\/\d{4}\/\d{2}\/\d{2}\//.test(putKeys[0]), putKeys[0]);

    // 头像：独立目录 + 只能是图片
    r = await C('/api/upload?kind=avatar', { method:'POST', body:PNG });
    ok('L6 头像落在 avatars/', r.status === 200 && putKeys[3].startsWith('avatars/'), putKeys[3]);
    const avId = r.data.id;
    r = await C('/api/upload?kind=avatar', { method:'POST', body:WAV });
    ok('L7 头像只能是图片(400)', r.status === 400, 'status=' + r.status);
    // 2 MB 上限：头像不需要那么大
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set(PNG, 0);
    r = await C('/api/upload?kind=avatar', { method:'POST', body:big });
    ok('L8 头像超过 2 MB 被拒(413)', r.status === 413, 'status=' + r.status);
    r = await C('/api/upload', { method:'POST', body:big });
    ok('L9 同样大小当作普通附件仍可上传', r.status === 200, 'status=' + r.status);

    // 头像附件归本人所有，可以设成头像
    r = await C('/api/account/profile', { method:'POST', body:{ avatar:'att:' + avId } });
    ok('L10 上传的图可以设为头像', r.status === 200 && r.data.user.avatar === 'att:' + avId, JSON.stringify(r.data.user));

    // 正在当头像的附件不能被「清理孤儿」带走（头像不被任何帖子引用）
    dbL.prepare(`UPDATE attachments SET created_at=datetime('now','-2 days') WHERE id=?`).run(avId);
    r = await C('/api/admin/storage-sweep', { method:'POST', body:{} });
    ok('L11 清理孤儿不会删掉正在用的头像', dbL.prepare(`SELECT COUNT(*) n FROM attachments WHERE id=?`).get(avId).n === 1, JSON.stringify(r.data));
    // 传了却没保存的头像照常回收
    r = await C('/api/upload?kind=avatar', { method:'POST', body:PNG });
    const stray = r.data.id;
    dbL.prepare(`UPDATE attachments SET created_at=datetime('now','-2 days') WHERE id=?`).run(stray);
    r = await C('/api/admin/storage-sweep', { method:'POST', body:{} });
    ok('L12 没保存的头像照常回收', dbL.prepare(`SELECT COUNT(*) n FROM attachments WHERE id=?`).get(stray).n === 0, JSON.stringify(r.data));
  }

  // ============ I. 附件类型嗅探：音频要认得全，图片视频不能误判 ============
  console.log('\n--- I. 附件类型嗅探 ---');
  {
    // 照 F 组的老办法：Worker 不导出内部工具，就从源码里整段取出来跑
    const block = src.slice(src.indexOf('const EXT_BY_MIME'), src.indexOf('// 大数组不能用'));
    const { EXT_BY_MIME, sniffType } = new Function(block + '\nreturn { EXT_BY_MIME, sniffType };')();

    // 造「刚好能被认出来」的最小样本：真实文件头 + 必要的容器/轨道标识
    const b = (...parts) => new Uint8Array([].concat(...parts.map(
      p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p)));
    const ftyp = (brand, extra = '') => b([0, 0, 0, 24], 'ftyp', brand, extra);

    const cases = [
      ['JPEG',          b([0xFF, 0xD8, 0xFF, 0xE0]),                  'image/jpeg'],
      ['PNG',           b([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), 'image/png'],
      ['GIF',           b('GIF89a'),                                   'image/gif'],
      ['WebP',          b('RIFF', [0, 0, 0, 0], 'WEBP'),               'image/webp'],
      ['WAV',           b('RIFF', [0, 0, 0, 0], 'WAVE'),               'audio/wav'],
      ['MP3(ID3 标签)', b('ID3', [3, 0, 0, 0]),                        'audio/mpeg'],
      ['MP3(裸帧)',     b([0xFF, 0xFB, 0x90, 0x00]),                   'audio/mpeg'],
      ['AAC(ADTS)',     b([0xFF, 0xF1, 0x50, 0x80]),                   'audio/aac'],
      ['FLAC',          b('fLaC'),                                     'audio/flac'],
      ['Ogg',           b('OggS', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),     'audio/ogg'],
      ['Opus',          b('OggS', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'OpusHead'), 'audio/opus'],
      ['AIFF',          b('FORM', [0, 0, 0, 0], 'AIFF'),               'audio/aiff'],
      ['AMR',           b('#!AMR\n'),                                  'audio/amr'],
      ['MIDI',          b('MThd', [0, 0, 0, 6]),                       'audio/midi'],
      ['MP4(有视频轨)', ftyp('isom', 'avc1'),                          'video/mp4'],
      ['M4A(纯音频)',   ftyp('M4A ', 'mp4a'),                          'audio/mp4'],
      ['MOV',           ftyp('qt  '),                                  'video/quicktime'],
      ['AVIF',          ftyp('avif'),                                  'image/avif'],
      ['HEIC',          ftyp('heic'),                                  'image/heic'],
      ['WebM(视频)',    b([0x1A, 0x45, 0xDF, 0xA3], [0, 0, 0, 0], 'V_VP9'),  'video/webm'],
      ['WebM(纯音频)',  b([0x1A, 0x45, 0xDF, 0xA3], [0, 0, 0, 0], 'A_OPUS'), 'audio/webm'],
      ['随机字节',      b([0, 1, 2, 3, 4, 5, 6, 7]),                   null],
      ['纯文本',        b('hello world, this is not media'),           null]
    ];
    for (const [name, bytes, want] of cases) {
      const got = sniffType(bytes);
      ok(`I ${name} → ${want ?? '不支持'}`, got === want, '实际 ' + got);
    }

    // 白名单自洽：任一条缺扩展名，存进 WebDAV 的文件就会没有后缀
    const noExt = Object.entries(EXT_BY_MIME).filter(([, e]) => !e).map(([m]) => m);
    ok('I 每种类型都有扩展名', noExt.length === 0, JSON.stringify(noExt));
    // 能探出来的类型必须都在白名单里，否则上传会被自己的白名单拦掉
    const unknown = [...new Set(cases.map(c => c[2]).filter(Boolean))].filter(m => !EXT_BY_MIME[m]);
    ok('I 探测结果都在白名单内', unknown.length === 0, JSON.stringify(unknown));
    // 音频类必须能被前端认成 <audio>（渲染分支靠这个前缀判断）
    const audios = Object.keys(EXT_BY_MIME).filter(m => m.startsWith('audio/'));
    ok('I 至少覆盖 10 种音频', audios.length >= 10, '实际 ' + audios.length);
  }

  // ============ M. 不易展示内容（隐藏限制帖）============
  console.log('\n--- M. 不易展示内容 ---');
  {
    // 刻意**不带** 0008：验证 ensureSchema 能自己把新列补出来（线上库不会重跑迁移）
    const dbm = newDb(['0001_init.sql','0002_account_features.sql','0004_files.sql','0005_security.sql','0006_boards.sql','0007_features.sql']);
    const envm = { DB: new D1(dbm), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const A = mkCaller(envm), B = mkCaller(envm), C = mkCaller(envm);
    await A('/api/setup', { method:'POST', body:{ username:'mia', password:'miapass12345' } });
    await A('/api/register', { method:'POST', body:{ username:'neo', password:'neopass12345' } });
    await A('/api/register', { method:'POST', body:{ username:'kit', password:'kitpass12345' } });   // 全程普通用户，用来验权限
    await A('/api/login', { method:'POST', body:{ username:'mia', password:'miapass12345' } });
    await B('/api/login', { method:'POST', body:{ username:'neo', password:'neopass12345' } });
    await C('/api/login', { method:'POST', body:{ username:'kit', password:'kitpass12345' } });

    const colNames = t => dbm.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    ok('M1 老库补出 threads.sensitive', colNames('threads').includes('sensitive'), JSON.stringify(colNames('threads')));
    ok('M2 老库补出 posts.sensitive', colNames('posts').includes('sensitive'));
    ok('M3 老库补出 users.sensitive_filter', colNames('users').includes('sensitive_filter'));

    // --- 发布时自己声明 ---
    let r = await A('/api/threads', { method:'POST', body:{ title:'剧透帖', body:'凶手是管家', sensitive:1 } });
    const tid = r.data.id;
    ok('M4 发帖可标记为不易展示', r.status===200 && r.data.sensitive===1, JSON.stringify(r.data));
    ok('M5 标记真的落库', dbm.prepare(`SELECT sensitive FROM threads WHERE id=?`).get(tid).sensitive===1);
    const plain = (await A('/api/threads', { method:'POST', body:{ title:'普通帖', body:'今天天气不错' } })).data.id;
    ok('M6 不传时默认不限制', dbm.prepare(`SELECT sensitive FROM threads WHERE id=?`).get(plain).sensitive===0);
    // 乱传的布尔值一律归 0：写进 INTEGER 列的只能是 0/1，NULL 会让 `WHERE sensitive=0` 永远筛不到
    r = await A('/api/threads', { method:'POST', body:{ title:'乱传', body:'x', sensitive:'yes' } });
    ok('M7 非法布尔值归 0', dbm.prepare(`SELECT sensitive FROM threads WHERE id=?`).get(r.data.id).sensitive===0, JSON.stringify(r.data));

    r = await A('/api/threads?limit=50');
    ok('M8 列表带上 sensitive 字段', r.data.items.find(x=>x.id===tid)?.sensitive===1, JSON.stringify(r.data.items.map(x=>x.sensitive)));
    ok('M9 详情带上 sensitive 字段', (await A('/api/threads/'+tid)).data.thread.sensitive===1);

    r = await A('/api/threads/'+tid+'/posts', { method:'POST', body:{ body:'我也觉得', sensitive:1 } });
    ok('M10 回复也能标记', r.status===200 && r.data.sensitive===1, JSON.stringify(r.data));
    const pid = (await A('/api/threads/'+tid)).data.posts[0].id;
    ok('M11 回复标记落库', dbm.prepare(`SELECT sensitive FROM posts WHERE id=?`).get(pid).sensitive===1);

    // --- 作者事后改标记 ---
    r = await A('/api/threads/'+plain, { method:'PATCH', body:{ sensitive:1 } });
    ok('M12 作者可给自己主题加限制', r.status===200 && r.data.changed===true && r.data.sensitive===1, JSON.stringify(r.data));
    ok('M13 只改标记不留编辑痕迹', dbm.prepare(`SELECT COUNT(*) n FROM post_edits WHERE target_type='thread' AND target_id=?`).get(plain).n===0);
    ok('M14 只改标记不算「已编辑」', !dbm.prepare(`SELECT edited_at FROM threads WHERE id=?`).get(plain).edited_at);
    ok('M15 标记没变则不算改动', (await A('/api/threads/'+plain, { method:'PATCH', body:{ sensitive:1 } })).data.changed===false);
    r = await B('/api/threads/'+plain, { method:'PATCH', body:{ sensitive:0 } });
    ok('M16 非作者改不了别人的主题(403)', r.status===403, 'status='+r.status);
    r = await A('/api/posts/'+pid, { method:'PATCH', body:{ sensitive:0 } });
    ok('M17 作者可给回复撤掉限制', r.status===200 && r.data.sensitive===0, JSON.stringify(r.data));
    r = await B('/api/posts/'+pid, { method:'PATCH', body:{ sensitive:1 } });
    ok('M18 非作者改不了别人的回复(403)', r.status===403, 'status='+r.status);

    // --- 子管理员替别人补标（MOD_ACTIONS 白名单里要有 sensitive）---
    const neoId = dbm.prepare(`SELECT id FROM users WHERE username='neo'`).get().id;
    await A('/api/admin/set-role', { method:'POST', body:{ id:neoId, role:'moderator' } });
    const M = mkCaller(envm);                       // set-role 会作废会话，子管理员要重新登录
    await M('/api/login', { method:'POST', body:{ username:'neo', password:'neopass12345' } });
    r = await M('/api/admin/moderate', { method:'POST', body:{ type:'sensitive', id:plain, target:'thread', value:0 } });
    ok('M19 子管理员可改别人的主题标记', r.status===200 && r.data.sensitive===0, JSON.stringify(r.data));
    r = await M('/api/admin/moderate', { method:'POST', body:{ type:'sensitive', id:pid, target:'post', value:1 } });
    ok('M20 子管理员可改别人的回复标记', r.status===200 && r.data.sensitive===1, JSON.stringify(r.data));
    ok('M21 不给 value 时翻转', (await M('/api/admin/moderate', { method:'POST', body:{ type:'sensitive', id:pid, target:'post' } })).data.sensitive===0);
    ok('M22 目标不存在(404)', (await M('/api/admin/moderate', { method:'POST', body:{ type:'sensitive', id:99999, target:'thread' } })).status===404);
    // 普通用户连治理接口都不该进得去（401 是没登录，403 才是「权限不够」）
    ok('M23 普通用户调治理接口(403)', (await C('/api/admin/moderate', { method:'POST', body:{ type:'sensitive', id:plain, target:'thread' } })).status===403);

    // --- 看的人那颗开关 ---
    ok('M24 status 带回 sensitive_filter', (await A('/api/status')).data.user?.sensitive_filter===1);
    const miaId = dbm.prepare(`SELECT id FROM users WHERE username='mia'`).get().id;
    r = await A('/api/account/profile', { method:'POST', body:{ sensitiveFilter:0 } });
    ok('M25 可关闭模糊', r.status===200 && r.data.user.sensitive_filter===0, JSON.stringify(r.data.user));
    ok('M26 偏好落库', dbm.prepare(`SELECT sensitive_filter FROM users WHERE id=?`).get(miaId).sensitive_filter===0);
    ok('M27 关掉后 status 也跟着变', (await A('/api/status')).data.user.sensitive_filter===0);
    r = await A('/api/account/profile', { method:'POST', body:{ bio:'改个签名' } });
    ok('M28 只改资料不会把偏好冲掉', r.data.user.sensitive_filter===0 && r.data.user.bio==='改个签名', JSON.stringify(r.data.user));
    ok('M29 新用户默认开启模糊', dbm.prepare(`SELECT sensitive_filter FROM users WHERE username='kit'`).get().sensitive_filter===1);
  }

  // ============ N. 点赞与转帖（引用）============
  console.log('\n--- N. 点赞与转帖 ---');
  {
    const dbn = newDb(['0001_init.sql', '0002_account_features.sql']);
    const envn = { DB: new D1(dbn), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const A = mkCaller(envn), B = mkCaller(envn), G = mkCaller(envn);   // G 全程不登录（游客）
    await A('/api/setup', { method: 'POST', body: { username: 'mia', password: 'miapass12345' } });
    await A('/api/register', { method: 'POST', body: { username: 'neo', password: 'neopass12345' } });
    await A('/api/login', { method: 'POST', body: { username: 'mia', password: 'miapass12345' } });
    await B('/api/login', { method: 'POST', body: { username: 'neo', password: 'neopass12345' } });

    const colNames = t => dbn.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    ok('N1 老库补出 likes 表', dbn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='likes'`).all().length === 1);
    ok('N2 老库补出 threads.quote_ref', colNames('threads').includes('quote_ref'));
    ok('N3 老库补出 posts.quote_snapshot', colNames('posts').includes('quote_snapshot'));

    const tid = (await A('/api/threads', { method: 'POST', body: { title: '被点赞的帖', body: '正文正文' } })).data.id;
    await A('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '一条回复' } });
    const pid = (await A('/api/threads/' + tid)).data.posts[0].id;

    // --- 点赞 ---
    let r = await A('/api/like', { method: 'POST', body: { target: 'thread', id: tid } });
    ok('N4 点赞成功并回 1', r.status === 200 && r.data.liked === 1 && r.data.count === 1, JSON.stringify(r.data));
    r = await A('/api/like', { method: 'POST', body: { target: 'thread', id: tid } });
    ok('N5 再点一次是撤销', r.data.liked === 0 && r.data.count === 0, JSON.stringify(r.data));
    await A('/api/like', { method: 'POST', body: { target: 'thread', id: tid } });
    await B('/api/like', { method: 'POST', body: { target: 'thread', id: tid } });
    ok('N6 两人各点一次 = 2', (await A('/api/like', { method: 'POST', body: { target: 'thread', id: tid } })).data.count === 1
      || dbn.prepare(`SELECT COUNT(*) n FROM likes WHERE target_type='thread' AND target_id=?`).get(tid).n === 2);
    // 上一行把 A 的赞撤掉了，补回来，后面还要用
    await A('/api/like', { method: 'POST', body: { target: 'thread', id: tid } });
    ok('N7 一人一次（唯一索引兜底）', dbn.prepare(`SELECT COUNT(*) n FROM likes WHERE target_type='thread' AND target_id=? AND user_id=1`).get(tid).n === 1);
    ok('N8 未登录点赞(401)', (await G('/api/like', { method: 'POST', body: { target: 'thread', id: tid } })).status === 401);
    ok('N9 点不存在的内容(404)', (await A('/api/like', { method: 'POST', body: { target: 'thread', id: 99999 } })).status === 404);
    ok('N10 回复也能赞', (await A('/api/like', { method: 'POST', body: { target: 'post', id: pid } })).data.count === 1);

    r = await A('/api/threads?limit=50');
    const it = r.data.items.find(x => x.id === tid);
    ok('N11 列表带 likes / liked / reposts', it.likes === 2 && it.liked === 1 && it.reposts === 0, JSON.stringify(it && { likes: it.likes, liked: it.liked, reposts: it.reposts }));
    const det = (await A('/api/threads/' + tid)).data;
    ok('N12 详情主题带点赞数', det.thread.likes === 2 && det.thread.liked === 1, JSON.stringify({ likes: det.thread.likes, liked: det.thread.liked }));
    ok('N13 详情回复带点赞数', det.posts[0].likes === 1 && det.posts[0].liked === 1);
    // 游客没有登录态：只看得到数，liked 一律 0（不能报 500）
    const gDet = (await G('/api/threads/' + tid)).data;
    ok('N14 游客看详情也能拿到计数', gDet.thread.likes === 2 && gDet.thread.liked === 0);

    // --- 转帖（引用别人的主题新发一条）---
    r = await B('/api/threads', { method: 'POST', body: { title: '转一下', body: '我觉得这个说得对', quote: { type: 'thread', id: tid } } });
    const rid = r.data.id;
    ok('N15 转帖成功', r.status === 200 && !!rid && r.data.quote === 'thread:' + tid, JSON.stringify(r.data));
    ok('N16 quote_ref 落库', dbn.prepare(`SELECT quote_ref FROM threads WHERE id=?`).get(rid).quote_ref === 'thread:' + tid);
    const snap = JSON.parse(dbn.prepare(`SELECT quote_snapshot FROM threads WHERE id=?`).get(rid).quote_snapshot);
    ok('N17 快照记了原作者与摘要', snap.user === 'mia' && snap.title === '被点赞的帖' && !!snap.excerpt, JSON.stringify(snap));
    ok('N18 原帖转帖数 +1', (await A('/api/threads?limit=50')).data.items.find(x => x.id === tid).reposts === 1);
    ok('N19 详情里原帖转帖数也是 1', (await A('/api/threads/' + tid)).data.thread.reposts === 1);

    // 只挂引用卡、不写评论：正文可以留空
    r = await B('/api/threads', { method: 'POST', body: { title: '直接转', body: '', quote: { type: 'thread', id: tid } } });
    ok('N20 转帖正文可留空（只挂引用卡）', r.status === 200 && !!r.data.id, JSON.stringify(r.data));
    ok('N21 空正文不算「标题和正文不能为空」', dbn.prepare(`SELECT body FROM threads WHERE id=?`).get(r.data.id).body === '');
    // 但不带引用时正文不能空
    ok('N22 没有引用时空正文仍被挡(400)', (await B('/api/threads', { method: 'POST', body: { title: '空正文', body: '' } })).status === 400);

    // --- 评论里引用（回复挂引用卡，不计转帖数）---
    r = await B('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '引用一下', quote: { type: 'post', id: pid } } });
    ok('N23 回复可带引用', r.status === 200 && r.data.quote === 'post:' + pid, JSON.stringify(r.data));
    const qRef = dbn.prepare(`SELECT quote_ref FROM posts ORDER BY id DESC LIMIT 1`).get().quote_ref;
    ok('N24 回复的引用落库', qRef === 'post:' + pid, String(qRef));
    ok('N25 回复里的引用不算转帖', (await A('/api/threads/' + tid)).data.thread.reposts === 2);   // 上面转了两条主题

    // 引用不存在的东西：静默丢弃，帖子照发（引用只是附加信息）
    r = await B('/api/threads', { method: 'POST', body: { title: '引用了空气', body: '内容', quote: { type: 'thread', id: 99999 } } });
    ok('N26 引用不存在时照常发帖', r.status === 200 && r.data.quote === null, JSON.stringify(r.data));

    // --- 转帖也带「不易展示」---
    await A('/api/threads/' + tid, { method: 'PATCH', body: { sensitive: 1 } });
    r = await B('/api/threads', { method: 'POST', body: { title: '转个限制帖', body: '', sensitive: 1, quote: { type: 'thread', id: tid } } });
    ok('N27 转帖可标记为不易展示', r.status === 200 && r.data.sensitive === 1, JSON.stringify(r.data));
    const snap2 = JSON.parse(dbn.prepare(`SELECT quote_snapshot FROM threads WHERE id=?`).get(r.data.id).quote_snapshot);
    ok('N28 快照记下原帖的限制标记（引用卡要跟着模糊）', snap2.sensitive === 1, JSON.stringify(snap2));

    // --- 用户主页：获赞数 ---
    const miaId = dbn.prepare(`SELECT id FROM users WHERE username='mia'`).get().id;
    r = await A('/api/users/' + miaId);
    ok('N29 主页带获赞数', r.data.stats.likes === 3, JSON.stringify(r.data.stats));   // 主题 2 + 回复 1

    // --- 删内容时把赞一起清掉（likes.target_id 没有外键，只能手动）---
    await A('/api/threads/' + tid, { method: 'DELETE' });
    ok('N30 删主题后赞不留孤儿', dbn.prepare(`SELECT COUNT(*) n FROM likes WHERE target_type='thread' AND target_id=?`).get(tid).n === 0);
    ok('N31 连带清掉楼里回复的赞', dbn.prepare(`SELECT COUNT(*) n FROM likes WHERE target_type='post' AND target_id=?`).get(pid).n === 0);
  }

  // ============ O. 回收站 / 内容保护 / 胁迫密码 ============
  console.log('\n--- O. 回收站 ---');
  {
    const dbo = newDb(['0001_init.sql', '0002_account_features.sql', '0004_files.sql']);
    const envo = { DB: new D1(dbo), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const A = mkCaller(envo);        // 站主
    await A('/api/setup', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/login', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    const uid = (un) => dbo.prepare(`SELECT id FROM users WHERE username=?`).get(un).id;
    const reg = async (un, pw) => { await A('/api/register', { method: 'POST', body: { username: un, password: pw } }); const c = mkCaller(envo); await c('/api/login', { method: 'POST', body: { username: un, password: pw } }); return c };

    ok('O1 老库补出 trash 表', dbo.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='trash'`).all().length === 1);
    ok('O2 老库补出 threads.protected', dbo.prepare(`PRAGMA table_info(threads)`).all().map(c => c.name).includes('protected'));
    ok('O3 老库补出 users.duress_state', dbo.prepare(`PRAGMA table_info(users)`).all().map(c => c.name).includes('duress_state'));

    // --- 自己删的，自己能捞回来 ---
    const P = await reg('pat', 'patpass12345');
    let r = await P('/api/threads', { method: 'POST', body: { title: '我手滑删了', body: '正文在此' } });
    const tid = r.data.id;
    await P('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '别人的回复' } });
    const pid = (await P('/api/threads/' + tid)).data.posts[0].id;
    // 别人的回复：让第二个用户来写，验证删主题时连别人的回复一起收进回收站
    const B = await reg('bob', 'bobpass12345');
    await B('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: 'bob 的回复' } });

    r = await P('/api/threads/' + tid, { method: 'DELETE' });
    ok('O4 删主题返回可撤销的 trashId', r.status === 200 && r.data.trashed === true && !!r.data.trashId, JSON.stringify(r.data));
    ok('O5 主题进回收站（主题 1 条 + 回复各 1 条）', dbo.prepare(`SELECT COUNT(*) n FROM trash`).get().n === 3,
      'count=' + dbo.prepare(`SELECT COUNT(*) n FROM trash`).get().n);
    ok('O6 主题快照存了标题与作者', dbo.prepare(`SELECT title,author_name,by_owner FROM trash WHERE kind='thread'`).get().title === '我手滑删了');
    ok('O7 活跃表里确实没了', dbo.prepare(`SELECT COUNT(*) n FROM threads WHERE id=?`).get(tid).n === 0);

    r = await P('/api/trash');
    const mine = r.data.items;
    ok('O8 作者在回收站看得到自己的条目', mine.length === 2 && mine.every(x => x.can_restore === 1),
      JSON.stringify(mine.map(x => [x.kind, x.can_restore])));
    // 别人的回复不在「我」的回收站里 —— 那是 bob 的东西，bob 自己看得到
    const bobTrash = await (await B('/api/trash'));
    ok('O9 被连带的别人的回复进的是对方自己的回收站',
      bobTrash.data.items.length === 1 && bobTrash.data.items[0].author_name === 'bob'
      && bobTrash.data.items[0].can_restore === 0,
      JSON.stringify(bobTrash.data.items.map(x => [x.author_name, x.can_restore])));

    r = await P('/api/trash/restore', { method: 'POST', body: { id: mine.find(x => x.kind === 'thread').id } });
    // 恢复主题是把整个楼一起放回来：1 条主题 + 主题下所有回复（含 bob 那条）
    ok('O10 作者能一键恢复自己的主题', r.status === 200 && r.data.restored === 3, JSON.stringify(r.data));
    const back = await P('/api/threads/' + tid);
    ok('O11 恢复后原 id 不变、回复都在', back.status === 200 && back.data.posts.length === 2,
      'status=' + back.status + ' posts=' + (back.data.posts || []).length);
    ok('O12 恢复后回收站里不留痕迹', dbo.prepare(`SELECT COUNT(*) n FROM trash`).get().n === 0);
    ok('O13 回复的 id 也没变', dbo.prepare(`SELECT COUNT(*) n FROM posts WHERE id=?`).get(pid).n === 1);
    ok('O13b 连带别人的回复一起回来了', dbo.prepare(`SELECT COUNT(*) n FROM posts WHERE thread_id=?`).get(tid).n === 2);

    // --- 管理员删的，作者不能自己捞（治理动作不该被单方面推翻）---
    r = await A('/api/admin/moderate', { method: 'POST', body: { type: 'deleteThread', id: tid } });
    ok('O14 管理员删帖也进回收站', r.status === 200 && !!r.data.trashId, JSON.stringify(r.data));
    r = await P('/api/trash');
    const row = r.data.items[0];
    ok('O15 作者看得到但恢复按钮是关的', row.can_restore === 0 && row.by_owner === 0, JSON.stringify(row));
    ok('O16 作者强行恢复被拒(403)', (await P('/api/trash/restore', { method: 'POST', body: { id: row.id } })).status === 403);
    ok('O17 站主恢复成功', (await A('/api/trash/restore', { method: 'POST', body: { id: row.id } })).status === 200);
    ok('O18 内容真的回来了', (await P('/api/threads/' + tid)).status === 200);

    // --- 楼中楼：父回复先被单独删掉时，子回复恢复后 reply_to 置空而不是整条失败 ---
    const rp = (await A('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '父回复' } }));
    const parentId = dbo.prepare(`SELECT id FROM posts WHERE thread_id=? ORDER BY id DESC LIMIT 1`).get(tid).id;
    await A('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '子回复', replyTo: parentId } });
    const childId = dbo.prepare(`SELECT id FROM posts WHERE reply_to=?`).get(parentId).id;
    await A('/api/posts/' + parentId, { method: 'DELETE' });            // 父回复进回收站
    const childTrash = await A('/api/trash');
    const childRow = childTrash.data.items.find(x => x.target_id === childId);
    ok('O19 子回复没被连坐删除', !!childRow || dbo.prepare(`SELECT COUNT(*) n FROM posts WHERE id=?`).get(childId).n === 1);
    r = await A('/api/posts/' + childId, { method: 'DELETE' });
    r = await A('/api/trash');
    const cRow = r.data.items.find(x => x.target_id === childId);
    await A('/api/trash/restore', { method: 'POST', body: { id: dbo.prepare(`SELECT id FROM trash WHERE kind='post' AND target_id=?`).get(parentId).id } });
    r = await A('/api/trash/restore', { method: 'POST', body: { id: cRow.id } });
    ok('O20 父回复不在时子回复照样能恢复', r.status === 200, JSON.stringify(r.data));
    ok('O21 这时 reply_to 被置空（不会挂在一个不存在的楼上）',
      dbo.prepare(`SELECT reply_to FROM posts WHERE id=?`).get(childId).reply_to === null);

    // --- 彻底删除 ---
    r = await A('/api/threads/' + tid, { method: 'DELETE' });
    const purgeId = r.data.trashId;
    ok('O22 彻底删除成功', (await A('/api/admin/trash-purge', { method: 'POST', body: { id: purgeId } })).status === 200);
    ok('O23 彻底删除后无法恢复(404)', (await A('/api/trash/restore', { method: 'POST', body: { id: purgeId } })).status === 404);
    ok('O24 普通用户不能用彻底删除(403)', (await P('/api/admin/trash-purge', { method: 'POST', body: { id: 1 } })).status === 403);
    ok('O25 未登录看不了回收站(401)', (await mkCaller(envo)('/api/trash')).status === 401);

    // --- 清理孤儿附件时要认回收站里的引用（否则「恢复」回来全是破图）---
    const patId = uid('pat');
    const old = '2026-09-01 00:00:00';
    dbo.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size,created_at) VALUES(901,?,?,?,?,?)`).run(patId, 'images/old/a.png', 'image/png', 10, old);
    dbo.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size,created_at) VALUES(902,?,?,?,?,?)`).run(patId, 'images/old/b.png', 'image/png', 10, old);
    const T2 = (await A('/api/threads', { method: 'POST', body: { title: '带图帖', body: '看图 [img:901]' } })).data.id;
    await A('/api/threads/' + T2, { method: 'DELETE' });                 // 901 只在回收站里被引用
    r = await A('/api/admin/storage-sweep', { method: 'POST', body: {} });
    ok('O26 回收站里引用着的附件不会被当孤儿清掉',
      dbo.prepare(`SELECT COUNT(*) n FROM attachments WHERE id=901`).get().n === 1, JSON.stringify(r.data));
    ok('O27 真孤儿（没人引用）照常清掉',
      dbo.prepare(`SELECT COUNT(*) n FROM attachments WHERE id=902`).get().n === 0);
  }

  console.log('\n--- O. 删号与恢复 ---');
  {
    const dbp = newDb(['0001_init.sql', '0002_account_features.sql']);
    const envp = { DB: new D1(dbp), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const A = mkCaller(envp);
    await A('/api/setup', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/login', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/register', { method: 'POST', body: { username: 'ken', password: 'kenpass12345' } });
    const K = mkCaller(envp);
    await K('/api/login', { method: 'POST', body: { username: 'ken', password: 'kenpass12345' } });
    const kid = dbp.prepare(`SELECT id FROM users WHERE username='ken'`).get().id;
    const ktid = (await K('/api/threads', { method: 'POST', body: { title: 'ken 的帖', body: '正文' } })).data.id;
    await K('/api/threads/' + ktid + '/posts', { method: 'POST', body: { body: 'ken 自己的回复' } });

    let r = await A('/api/admin/delete-user', { method: 'POST', body: { id: kid } });
    ok('P1 删号进回收站', r.status === 200 && r.data.trashed === true, JSON.stringify(r.data));
    ok('P2 账号真的没了', (await A('/api/users/' + kid)).status === 404);
    ok('P3 回收站里有账号记录', dbp.prepare(`SELECT COUNT(*) n FROM trash WHERE kind='user'`).get().n === 1);
    ok('P4 账号快照带着密码哈希（恢复后才能登录）', /pbkdf2\$/.test(JSON.parse(dbp.prepare(`SELECT payload FROM trash WHERE kind='user'`).get().payload).user.password_hash));
    ok('P5 内容也各自留了记录', dbp.prepare(`SELECT COUNT(*) n FROM trash WHERE kind IN ('thread','post')`).get().n === 2);

    const urow = dbp.prepare(`SELECT id FROM trash WHERE kind='user'`).get().id;
    r = await A('/api/trash/restore', { method: 'POST', body: { id: urow } });
    ok('P6 站主恢复账号', r.status === 200 && r.data.kind === 'user', JSON.stringify(r.data));
    ok('P7 用户名与 id 都还原了', dbp.prepare(`SELECT username FROM users WHERE id=?`).get(kid).username === 'ken');
    ok('P8 密码仍然有效（能用原密码登录）', (await mkCaller(envp)('/api/login', { method: 'POST', body: { username: 'ken', password: 'kenpass12345' } })).status === 200);
    ok('P9 内容也回来了', (await A('/api/threads/' + ktid)).status === 200);
    ok('P10 回收站里清干净了', dbp.prepare(`SELECT COUNT(*) n FROM trash`).get().n === 0);

    // 用户名被占用时：加后缀也要把人救回来，不能因为重名就拒绝恢复
    await A('/api/admin/delete-user', { method: 'POST', body: { id: kid } });
    await A('/api/register', { method: 'POST', body: { username: 'ken', password: 'otherpass123' } });
    const urow2 = dbp.prepare(`SELECT id FROM trash WHERE kind='user'`).get().id;
    r = await A('/api/trash/restore', { method: 'POST', body: { id: urow2 } });
    ok('P11 用户名被占用时加后缀恢复', r.status === 200 && /^ken-restored/.test(dbp.prepare(`SELECT username FROM users WHERE id=?`).get(kid).username),
      String(dbp.prepare(`SELECT username FROM users WHERE id=?`).get(kid).username));
  }

  console.log('\n--- O. 内容保护 ---');
  {
    const dbq = newDb(['0001_init.sql', '0002_account_features.sql']);
    const envq = { DB: new D1(dbq), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const A = mkCaller(envq);
    await A('/api/setup', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/login', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/register', { method: 'POST', body: { username: 'eve', password: 'evepass12345' } });
    await A('/api/register', { method: 'POST', body: { username: 'mod', password: 'modpass12345' } });
    const E = mkCaller(envq);
    await E('/api/login', { method: 'POST', body: { username: 'eve', password: 'evepass12345' } });
    const tid = (await E('/api/threads', { method: 'POST', body: { title: '会被保护的主题', body: '正文' } })).data.id;
    await E('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '一条回复' } });
    const pid = (await E('/api/threads/' + tid)).data.posts[0].id;

    let r = await A('/api/admin/protect', { method: 'POST', body: { target: 'thread', id: tid } });
    ok('Q1 站主能保护主题', r.status === 200 && r.data.protected === 1, JSON.stringify(r.data));
    ok('Q2 protected 落库', dbq.prepare(`SELECT protected,protected_at FROM threads WHERE id=?`).get(tid).protected === 1);
    ok('Q3 列表带上 protected', (await A('/api/threads')).data.items.find(x => x.id === tid).protected === 1);
    ok('Q4 详情带上 protected', (await A('/api/threads/' + tid)).data.thread.protected === 1);

    r = await E('/api/threads/' + tid, { method: 'PATCH', body: { body: '我要改' } });
    ok('Q5 原作者改不了被保护的主题(403)', r.status === 403, 'status=' + r.status);
    r = await E('/api/threads/' + tid, { method: 'DELETE' });
    ok('Q6 原作者删不掉被保护的主题(403)', r.status === 403, 'status=' + r.status);
    r = await A('/api/admin/moderate', { method: 'POST', body: { type: 'pin', id: tid } });
    ok('Q7 站主自己不受限制（能置顶）', r.status === 200, JSON.stringify(r.data));

    // 子管理员：即便在白名单里的动作，也动不了受保护的内容
    const modId = dbq.prepare(`SELECT id FROM users WHERE username='mod'`).get().id;
    await A('/api/admin/set-role', { method: 'POST', body: { id: modId, role: 'moderator' } });
    const M = mkCaller(envq);
    await M('/api/login', { method: 'POST', body: { username: 'mod', password: 'modpass12345' } });
    ok('Q8 子管理员不能删被保护的主题(403)', (await M('/api/admin/moderate', { method: 'POST', body: { type: 'deleteThread', id: tid } })).status === 403);
    ok('Q9 子管理员不能锁定被保护的主题(403)', (await M('/api/admin/moderate', { method: 'POST', body: { type: 'lock', id: tid } })).status === 403);
    ok('Q10 子管理员不能标记被保护的主题(403)', (await M('/api/admin/moderate', { method: 'POST', body: { type: 'sensitive', id: tid, target: 'thread' } })).status === 403);
    ok('Q11 子管理员照样能治理普通内容', (await M('/api/admin/moderate', { method: 'POST', body: { type: 'pin', id: (await E('/api/threads', { method: 'POST', body: { title: '普通帖', body: 'x' } })).data.id } })).status === 200);

    r = await A('/api/admin/protect', { method: 'POST', body: { target: 'post', id: pid } });
    ok('Q12 站主能保护回复', r.status === 200 && dbq.prepare(`SELECT protected FROM posts WHERE id=?`).get(pid).protected === 1);
    ok('Q13 原作者改不了被保护的回复(403)', (await E('/api/posts/' + pid, { method: 'PATCH', body: { body: '改' } })).status === 403);
    ok('Q14 原作者删不掉被保护的回复(403)', (await E('/api/posts/' + pid, { method: 'DELETE' })).status === 403);

    r = await A('/api/admin/protect', { method: 'POST', body: { target: 'thread', id: tid, value: 0 } });
    ok('Q15 站主能取消保护', r.status === 200 && r.data.protected === 0);
    ok('Q16 交还之后作者又能改了', (await E('/api/threads/' + tid, { method: 'PATCH', body: { body: '现在可以改了' } })).status === 200);
    ok('Q17 非管理员调保护接口(403)', (await E('/api/admin/protect', { method: 'POST', body: { target: 'thread', id: tid } })).status === 403);

    // 受保护的主题被站主删掉：进回收站，并标出「当时是受保护的」
    await A('/api/admin/protect', { method: 'POST', body: { target: 'thread', id: tid } });
    r = await A('/api/threads/' + tid, { method: 'DELETE' });
    ok('Q18 站主能删掉受保护的主题', r.status === 200, JSON.stringify(r.data));
    ok('Q19 回收站记着它当时是受保护的',
      dbq.prepare(`SELECT was_protected FROM trash WHERE kind='thread' AND target_id=?`).get(tid).was_protected === 1);
  }

  console.log('\n--- O. 胁迫密码 ---');
  {
    const dbr = newDb(['0001_init.sql', '0002_account_features.sql']);
    const envr = { DB: new D1(dbr), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const A = mkCaller(envr);
    await A('/api/setup', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/login', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/register', { method: 'POST', body: { username: 'sam', password: 'sampass12345' } });
    const S = mkCaller(envr);
    await S('/api/login', { method: 'POST', body: { username: 'sam', password: 'sampass12345' } });
    const sid = dbr.prepare(`SELECT id FROM users WHERE username='sam'`).get().id;
    await S('/api/threads', { method: 'POST', body: { title: '我的帖', body: '内容' } });

    ok('R1 初始没有胁迫密码', (await S('/api/status')).data.user.duress_set === 0);
    let r = await S('/api/account/duress', { method: 'POST', body: { password: 'wrongpass', duress: 'duress12345' } });
    ok('R2 设置时必须验证当前密码(401)', r.status === 401);
    r = await S('/api/account/duress', { method: 'POST', body: { password: 'sampass12345', duress: 'short' } });
    ok('R3 太短的胁迫密码被拒(400)', r.status === 400);
    r = await S('/api/account/duress', { method: 'POST', body: { password: 'sampass12345', duress: 'sampass12345' } });
    ok('R4 不能和登录密码相同(400)', r.status === 400, JSON.stringify(r.data));
    r = await S('/api/account/duress', { method: 'POST', body: { password: 'sampass12345', duress: 'duress12345' } });
    ok('R5 设置成功', r.status === 200 && r.data.duress_set === 1, JSON.stringify(r.data));
    ok('R6 哈希独立存储', /pbkdf2\$/.test(dbr.prepare(`SELECT duress_hash FROM users WHERE id=?`).get(sid).duress_hash));
    ok('R7 status 里带 duress_set（设置页要显示状态）', (await S('/api/status')).data.user.duress_set === 1);

    // 用胁迫密码登录 → 账号进入保护状态，而且**不下发任何会话**
    const S2 = mkCaller(envr);
    r = await S2('/api/login', { method: 'POST', body: { username: 'sam', password: 'duress12345' } });
    ok('R8 胁迫密码返回 duress 标记', r.status === 200 && r.data.duress === true, JSON.stringify(r.data));
    ok('R9 没有下发会话（账号确实登不进去）', !r.headers.get('set-cookie'), String(r.headers.get('set-cookie')));
    ok('R10 账号被标记为保护状态', dbr.prepare(`SELECT duress_state,duress_by FROM users WHERE id=?`).get(sid).duress_state === 1);
    ok('R11 记下了是本人触发的', dbr.prepare(`SELECT duress_by FROM users WHERE id=?`).get(sid).duress_by === 'self');
    ok('R12 内容一条都没删', dbr.prepare(`SELECT COUNT(*) n FROM threads WHERE author_id=?`).get(sid).n === 1);
    ok('R13 触发后连老会话也作废', (await S('/api/status')).data.user === null);

    const S3 = mkCaller(envr);
    r = await S3('/api/login', { method: 'POST', body: { username: 'sam', password: 'sampass12345' } });
    ok('R14 真密码也进不去了(403)', r.status === 403, 'status=' + r.status + ' ' + JSON.stringify(r.data));
    const S4 = mkCaller(envr);
    r = await S4('/api/login', { method: 'POST', body: { username: 'sam', password: 'duress12345' } });
    // 再输一次胁迫密码：仍然是「保护状态」那段回复 —— 一致的表现才不会被看出破绽，
    // 关键是**依然不下发会话**，账号实际进不去（下面那条断言才是重点）
    ok('R15 再用胁迫密码登录仍不给会话', r.status === 200 && r.data.duress === true && !r.headers.get('set-cookie'),
      'status=' + r.status + ' cookie=' + String(r.headers.get('set-cookie')));
    ok('R15b 因此这个「登录成功」什么也做不了', (await S4('/api/status')).data.user === null);
    ok('R16 主页标出「保护中」', (await A('/api/users/' + sid)).data.user.duress_state === 1);
    ok('R17 管理端列表也能看到', (await A('/api/admin/users')).data.find(x => x.id === sid).duress_state === 1);

    // 管理员不给设
    r = await A('/api/account/duress', { method: 'POST', body: { password: 'bosspass12345', duress: 'adminduress1' } });
    ok('R18 管理员不能设置胁迫密码(403)', r.status === 403, JSON.stringify(r.data));

    // 站主手动启动 / 解除
    r = await A('/api/admin/duress', { method: 'POST', body: { id: sid, value: 0 } });
    ok('R19 站主解除保护', r.status === 200 && r.data.duress === 0);
    const S5 = mkCaller(envr);
    r = await S5('/api/login', { method: 'POST', body: { username: 'sam', password: 'sampass12345' } });
    ok('R20 解除后能正常登录', r.status === 200, 'status=' + r.status);
    ok('R21 胁迫密码仍然保留着（下次还能用）', dbr.prepare(`SELECT duress_hash FROM users WHERE id=?`).get(sid).duress_hash != null);

    r = await A('/api/admin/duress', { method: 'POST', body: { id: sid, value: 1 } });
    ok('R22 站主能手动把账号置入保护状态', r.status === 200 && dbr.prepare(`SELECT duress_by FROM users WHERE id=?`).get(sid).duress_by === 'admin');
    ok('R23 手动启动也是所有设备立刻下线', (await S5('/api/status')).data.user === null);
    const bossId = dbr.prepare(`SELECT id FROM users WHERE username='boss'`).get().id;
    ok('R24 管理员账号不能被置入保护状态(403)', (await A('/api/admin/duress', { method: 'POST', body: { id: bossId, value: 1 } })).status === 403);
    await A('/api/register', { method: 'POST', body: { username: 'rex', password: 'rexpass12345' } });
    const X = mkCaller(envr);
    await X('/api/login', { method: 'POST', body: { username: 'rex', password: 'rexpass12345' } });
    ok('R25 普通用户调不了胁迫接口(403)', (await X('/api/admin/duress', { method: 'POST', body: { id: sid, value: 1 } })).status === 403);
    ok('R25b 未登录调胁迫接口(401)', (await mkCaller(envr)('/api/admin/duress', { method: 'POST', body: { id: sid, value: 1 } })).status === 401);

    // 清除胁迫密码
    const S6 = mkCaller(envr);
    await A('/api/admin/duress', { method: 'POST', body: { id: sid, value: 0 } });
    await S6('/api/login', { method: 'POST', body: { username: 'sam', password: 'sampass12345' } });
    r = await S6('/api/account/duress', { method: 'POST', body: { password: 'sampass12345', duress: '' } });
    ok('R26 能清除胁迫密码', r.status === 200 && r.data.duress_set === 0);
    const S7 = mkCaller(envr);
    r = await S7('/api/login', { method: 'POST', body: { username: 'sam', password: 'duress12345' } });
    ok('R27 清除之后旧胁迫密码失效(401)', r.status === 401, 'status=' + r.status);
  }

  // ============ S. 附件读取：MIME 兜底、Content-Length、Range 回退 ============
  console.log('\n--- S. 附件读取 ---');
  {
    const dbs = newDb(['0001_init.sql', '0002_account_features.sql', '0004_files.sql']);
    const envs = { DB: new D1(dbs), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const A = mkCaller(envs);
    await A('/api/setup', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/login', { method: 'POST', body: { username: 'boss', password: 'bosspass12345' } });
    await A('/api/admin/storage-config', { method: 'POST', body: { type: 'webdav', enabled: true, baseUrl: 'https://dav.test/dav', username: 'u', password: 'p' } });
    const uid = 1;
    // 四条附件：
    //   ① 老数据没存 mime（靠扩展名兜底）+ 远端第一次 502（靠重试救回）
    //   ② 存了 webp + 远端回 206 却不给 Content-Range（靠回退全量救回）
    //   ③ 无扩展名、远端一直 403（软失败：重试一次后仍失败）
    //   ④ 远端一直 401（硬失败：不该重试）
    dbs.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size) VALUES(1,?,?,?,?)`).run(uid, 'images/2026/01/01/a.png', '', 11);
    dbs.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size) VALUES(2,?,?,?,?)`).run(uid, 'images/2026/01/01/b.bin', 'image/webp', 12);
    dbs.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size) VALUES(3,?,?,?,?)`).run(uid, 'blob/abc123', '', 13);
    dbs.prepare(`INSERT INTO attachments(id,owner_id,storage_key,mime,size) VALUES(4,?,?,?,?)`).run(uid, 'images/2026/01/01/bad.png', 'image/png', 14);

    const realFetch = globalThis.fetch;
    let seen = [], hits = new Map();
    // 远端桩：默认只回 octet-stream（网盘就是这么干的）
    globalThis.fetch = async (url, opt) => {
      const u = String(url), h = (opt && opt.headers) || {};
      const range = h['Range'] || h['range'] || null;
      seen.push({ url: u, range });
      const n = (hits.get(u) || 0) + 1; hits.set(u, n);
      const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      if (u.includes('bad.png')) return new Response(bytes, { status: 401, headers: { 'content-type': 'text/plain' } });
      if (u.includes('abc123')) return new Response(bytes, { status: 403, headers: { 'content-type': 'text/plain' } });
      if (u.includes('a.png') && n === 1) return new Response(bytes, { status: 502, headers: { 'content-type': 'text/plain' } });
      if (range) {
        // b.bin 故意只回 206 不给 Content-Range：最阴的一种残缺响应
        if (u.includes('b.bin')) return new Response(bytes, { status: 206, headers: { 'content-type': 'application/octet-stream' } });
        return new Response(bytes, { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-7/20', 'content-length': '8' } });
      }
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '8' } });
    };
    try {
      seen = [];
      let r = await A('/api/files/1');
      ok('S1 远端第一次 502 时自动重试并成功', r.status === 200 && seen.filter(s => s.url.includes('a.png')).length === 2,
        'status=' + r.status + ' 请求数=' + seen.filter(s => s.url.includes('a.png')).length);
      ok('S2 老附件没存 mime 时按扩展名兜底（否则 nosniff 下打不开）', r.headers.get('content-type') === 'image/png', String(r.headers.get('content-type')));
      ok('S3 库里的 mime 优先于存储服务给的 octet-stream', (await A('/api/files/2')).headers.get('content-type') === 'image/webp');
      ok('S4 都推断不出时才退回 octet-stream', (await A('/api/files/3')).status === 502);
      ok('S5 响应带上 content-length（音视频靠它算时长与拖拽）', r.headers.get('content-length') === '8', String(r.headers.get('content-length')));
      ok('S6 声明支持 Range', r.headers.get('accept-ranges') === 'bytes');

      seen = [];
      await A('/api/files/4');
      ok('S7 硬失败（401）不浪费重试', seen.filter(s => s.url.includes('bad.png')).length === 1,
        String(seen.filter(s => s.url.includes('bad.png')).length));

      seen = [];
      r = await A('/api/files/1', { headers: { Range: 'bytes=0-7' } });
      ok('S8 Range 请求透传给存储', seen.some(s => s.range === 'bytes=0-7'), JSON.stringify(seen));
      ok('S9 分片响应回 206 + content-range', r.status === 206 && !!r.headers.get('content-range'), r.status + ' ' + String(r.headers.get('content-range')));

      seen = [];
      r = await A('/api/files/2', { headers: { Range: 'bytes=0-7' } });
      ok('S10 206 缺 Content-Range 时回退全量', r.status === 200 && !r.headers.get('content-range'), r.status + ' ' + String(r.headers.get('content-range')));
      ok('S11 回退时确实重新发了一次不带 Range 的请求', seen.filter(s => s.url.includes('b.bin')).length === 2, JSON.stringify(seen.map(s => s.range)));

      ok('S12 附件记录不存在(404)', (await A('/api/files/999')).status === 404);

      // 附件体检：站主用它找出「打不开的那几个」
      r = await A('/api/admin/storage-check', { method: 'POST', body: { limit: 40 } });
      const badIds = (r.data.bad || []).map(b => b.id);
      ok('S13 体检能查出读不出来的附件', r.status === 200 && badIds.includes(3) && badIds.includes(4), JSON.stringify(r.data.bad));
      ok('S14 体检报出总数与已检查数', r.data.total === 4 && r.data.checked === 4 && r.data.next === null, JSON.stringify({ t: r.data.total, c: r.data.checked }));
      ok('S15 分页接口：查两个就只查两个', (await A('/api/admin/storage-check', { method: 'POST', body: { limit: 2, offset: 0 } })).data.checked === 2);
      ok('S16 普通用户不能体检(403)', (await (async () => {
        await A('/api/register', { method: 'POST', body: { username: 'peek', password: 'peekpass12345' } });
        const P = mkCaller(envs); await P('/api/login', { method: 'POST', body: { username: 'peek', password: 'peekpass12345' } });
        return P('/api/admin/storage-check', { method: 'POST', body: {} });
      })()).status === 403);
      // 坏附件要能告诉站主「它出现在哪个帖子」，否则拿到一串 id 也不知道该改哪儿
      const tWith3 = (await A('/api/threads', { method: 'POST', body: { title: '引用了坏附件的帖', body: '看图 [img:3]' } })).data.id;
      r = await A('/api/admin/storage-check', { method: 'POST', body: { limit: 40 } });
      const b3 = (r.data.bad || []).find(b => b.id === 3);
      ok('S19 坏附件带出引用了它的主题', !!b3 && b3.used_in.threads.some(t => t.id === tWith3),
        JSON.stringify(b3 && b3.used_in));
      ok('S20 没人引用的坏附件也说得清', (() => {
        const b4 = (r.data.bad || []).find(b => b.id === 4);
        return !!b4 && b4.used_in.threads.length === 0 && b4.used_in.posts.length === 0;
      })());
    } finally { globalThis.fetch = realFetch }

    await A('/api/admin/storage-config', { method: 'POST', body: { type: 'none', enabled: false } });
    ok('S17 存储关掉后读附件(404)', (await A('/api/files/1')).status === 404);
    ok('S18 存储关掉后体检给明确提示(400)', (await A('/api/admin/storage-check', { method: 'POST', body: {} })).status === 400);
  }

  console.log('\n=== 回归测试: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
