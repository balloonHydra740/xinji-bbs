/* 匿名发布（0013）—— 后端（真实 SQL）+ 前端（最小 DOM 桩）一起验
 *
 * 「库里也查不出是谁发的」是这一版的硬要求，所以后端必须跑真实 SQL：
 * 断言的是**作者列**指向系统账号、而不是某个真实用户 —— 光看接口输出「匿名用户」
 * 是验不出这个的（接口把名字伪装一下也能过）。
 *
 * 运行：node tests/anon-check.cjs
 */
const fs = require('fs'), url = require('url'), path = require('path'), vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..') + '/';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

const ANON = '匿名用户';

/* ---------------- D1 mock（与 e2e 同一套语义）---------------- */
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    let stmt = null, args = [];
    const compile = () => (stmt || (stmt = this.db.prepare(sql)));
    const api = {
      __sql: sql, __args: () => args,
      bind(...a) { args = a; return api },
      async first() { const r = compile().get(...args); return r === undefined ? null : r },
      async all() { return { results: compile().all(...args), success: true, meta: {} } },
      async run() {
        const r = compile().run(...args);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) } };
      }
    };
    return api;
  }
  async batch(stmts) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const s of stmts) {
        const r = this.db.prepare(s.__sql).run(...(s.__args ? s.__args() : []));
        out.push({ success: true, meta: { last_row_id: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) } });
      }
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK') } catch (_) { } throw e; }
    return out;
  }
}
const newDb = (files) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  for (const f of files) db.exec(fs.readFileSync(root + 'migrations/' + f, 'utf8'));
  return db;
};
const mkCaller = (env) => {
  let cookie = '', seq = 0;
  const termsVersion = () => {
    try {
      const row = env.DB.db.prepare(`SELECT value FROM settings WHERE key='terms_version'`).get();
      const n = Number(row && row.value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    } catch (e) { return 1; }
  };
  return async (p, o = {}) => {
    const h = { 'content-type': 'application/json', ...(o.headers || {}) };
    if (!h['cf-connecting-ip'] && p === '/api/register') h['cf-connecting-ip'] = `203.0.113.${(seq++ % 250) + 1}`;
    if (p === '/api/register' && o.body && typeof o.body === 'object' && !('terms_version' in o.body)) {
      o = { ...o, body: { ...o.body, terms_version: termsVersion() } };
    }
    if (cookie) h['Cookie'] = cookie;
    const req = new Request('http://localhost' + p, { method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined, headers: h });
    const res = await env.__worker.fetch(req, env, {});
    const sc = res.headers.get('set-cookie');
    if (sc) { const m = sc.match(/bbs_session=([^;]*)/); cookie = (m && m[1]) ? 'bbs_session=' + m[1] : ''; }
    let data = null; try { data = await res.json() } catch (e) { }
    return { status: res.status, data };
  };
};

/* ================================================================
   后端
   ================================================================ */
async function backend() {
  console.log('\n--- 后端：匿名发帖 / 回复 / 归属 / 权限（真实 SQL，外键 ON）---');
  const worker = (await import(url.pathToFileURL(root + 'src/index.js').href)).default;
  const db = newDb(['0001_init.sql', '0002_account_features.sql', '0013_anon.sql']);
  const env = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) }, __worker: worker };

  const root_ = mkCaller(env);
  ok('A0 初始化管理员', (await root_('/api/setup', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } })).status === 200);
  await root_('/api/login', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });

  const mkUser = async (name) => {
    const c = mkCaller(env);
    await c('/api/register', { method: 'POST', body: { username: name, password: 'userpass123' } });
    await c('/api/login', { method: 'POST', body: { username: name, password: 'userpass123' } });
    return c;
  };
  const alice = await mkUser('alice'), bob = await mkUser('bob');
  const guest = mkCaller(env);
  const uidOf = (n) => db.prepare(`SELECT id FROM users WHERE username=?`).get(n).id;
  const aliceId = uidOf('alice'), bobId = uidOf('bob');

  ok('A1 匿名账号一开始并不存在（懒建，不白占一个 id）',
    db.prepare(`SELECT COUNT(*) c FROM users WHERE username=?`).get(ANON).c === 0);
  ok('A1b 普通用户的 id 没有被系统账号顶掉', aliceId > 0 && bobId === aliceId + 1, `alice=${aliceId} bob=${bobId}`);
  ok('A1c is_anon 列已随迁移建好',
    db.prepare(`PRAGMA table_info(threads)`).all().map(c => c.name).includes('is_anon'));

  // ---- 匿名发帖 ----
  let r = await alice('/api/threads', { method: 'POST', body: { title: '一条匿名帖', body: '正文正文', anon: 1 } });
  const tid = r.data && r.data.id;
  ok('A2 匿名发帖成功(200)', r.status === 200 && !!tid, JSON.stringify(r.data));
  ok('A2b 响应回 anon:1', r.data && Number(r.data.anon) === 1, JSON.stringify(r.data));

  const row = db.prepare(`SELECT author_id,is_anon FROM threads WHERE id=?`).get(tid);
  const anonId = uidOf(ANON);
  ok('A3 threads.is_anon 落库为 1', Number(row.is_anon) === 1);
  ok('A3b 作者列指向系统账号，不是发帖人', Number(row.author_id) === Number(anonId) && Number(row.author_id) !== Number(aliceId),
    `author_id=${row.author_id} anon=${anonId} alice=${aliceId}`);
  ok('A3c 全表没有任何一列把这条帖子和 alice 关联起来',
    db.prepare(`SELECT COUNT(*) c FROM threads WHERE id=? AND author_id=?`).get(tid, aliceId).c === 0);

  // ---- 系统账号本身 ----
  const anonRow = db.prepare(`SELECT username,role,password_hash,banned FROM users WHERE id=?`).get(anonId);
  ok('A4 系统账号叫「匿名用户」且是普通角色', anonRow.username === ANON && anonRow.role === 'user');
  ok('A4b 密码哈希是真的哈希（不是明文、也不是常见口令）',
    String(anonRow.password_hash).length > 20 && !/^(匿名用户|password|anonymous)/i.test(String(anonRow.password_hash)));
  r = await mkCaller(env)('/api/login', { method: 'POST', body: { username: ANON, password: '' } });
  ok('A4c 匿名账号登不进去（空密码 401）', r.status === 401, 'status=' + r.status);
  r = await mkCaller(env)('/api/login', { method: 'POST', body: { username: ANON, password: ANON } });
  ok('A4d 拿用户名当密码也登不进去', r.status === 401, 'status=' + r.status);

  // ---- 输出层 ----
  r = await guest('/api/threads?limit=20');
  let item = (r.data.items || []).find(t => t.id === tid);
  ok('A5 列表里能拿到这条', !!item);
  ok('A5b 列表显示「匿名用户」', item && item.username === ANON, item && item.username);
  ok('A5c 列表头像是空白哨兵', item && item.avatar === 'anon:', item && item.avatar);
  ok('A5d 列表 author_id 下发 0（前端不生成主页链接）', item && Number(item.author_id) === 0, item && item.author_id);

  r = await guest('/api/threads/' + tid);
  ok('A6 详情显示「匿名用户」', r.status === 200 && r.data.thread.username === ANON, r.data && r.data.thread && r.data.thread.username);
  ok('A6b 详情头像空白 + author_id=0', r.data.thread.avatar === 'anon:' && Number(r.data.thread.author_id) === 0);
  ok('A6c 详情不含作者的真实 bio/role', !r.data.thread.bio && !r.data.thread.role, JSON.stringify({ bio: r.data.thread.bio, role: r.data.thread.role }));

  // ---- 匿名回复 ----
  r = await bob('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '匿名回一句', anon: 1 } });
  ok('A7 匿名回复成功', r.status === 200 && Number(r.data.anon) === 1, JSON.stringify(r.data));
  r = await guest('/api/threads/' + tid);
  const ap = (r.data.posts || [])[0];
  ok('A7b 回复也显示匿名用户 / 空白头像 / author_id=0',
    ap && ap.username === ANON && ap.avatar === 'anon:' && Number(ap.author_id) === 0,
    JSON.stringify(ap && { u: ap.username, a: ap.avatar, id: ap.author_id }));
  const apRow = db.prepare(`SELECT author_id,is_anon FROM posts WHERE thread_id=?`).get(tid);
  ok('A7c 回复的作者列也是系统账号', Number(apRow.author_id) === Number(anonId) && Number(apRow.is_anon) === 1);

  // ---- 被引用 / 转帖时不露馅 ----
  r = await bob('/api/threads', { method: 'POST', body: { title: '转一下', body: '看看', quote: { type: 'thread', id: tid } } });
  ok('A8 匿名帖能被转帖', r.status === 200, JSON.stringify(r.data));
  const q = JSON.parse(db.prepare(`SELECT quote_snapshot FROM threads WHERE id=?`).get(r.data.id).quote_snapshot);
  ok('A8b 引用快照里的作者是「匿名用户」', q.user === ANON, q.user);
  ok('A8c 引用快照带 anon 标记（前端据此换空白头像）', Number(q.anon) === 1);
  ok('A8d 引用快照里绝不出现真实用户名', !JSON.stringify(q).includes('alice'));

  // ---- 权限：匿名内容没人能当作者 ----
  r = await alice('/api/threads/' + tid, { method: 'PATCH', body: { title: '我要改' } });
  ok('A9 发帖人自己也编辑不了匿名帖(403)', r.status === 403, 'status=' + r.status);
  ok('A9b 给的是说得清的理由', /匿名/.test(String(r.data && r.data.error)), JSON.stringify(r.data));
  r = await alice('/api/threads/' + tid, { method: 'DELETE' });
  ok('A9c 发帖人自己也删不掉匿名帖(403)', r.status === 403, 'status=' + r.status);

  const pid = db.prepare(`SELECT id FROM posts WHERE thread_id=?`).get(tid).id;
  r = await bob('/api/posts/' + pid, { method: 'PATCH', body: { body: '改一改' } });
  ok('A9d 匿名回复也编辑不了(403)', r.status === 403, 'status=' + r.status);
  r = await bob('/api/posts/' + pid, { method: 'DELETE' });
  ok('A9e 匿名回复也删不掉(403)', r.status === 403, 'status=' + r.status);

  // ---- 治理：站主能删 ----
  r = await root_('/api/threads/' + tid, { method: 'DELETE' });
  ok('A10 站主能删匿名帖', r.status === 200 && !!r.data.trashId, JSON.stringify(r.data));
  const tr = db.prepare(`SELECT author_name,payload FROM trash WHERE kind='thread' AND target_id=?`).get(tid);
  ok('A10b 回收站里也记「匿名用户」', tr && tr.author_name === ANON, tr && tr.author_name);
  ok('A10c 回收站条目里查不到真实作者', tr && !String(tr.payload).includes('alice'));

  // ---- 恢复之后还是匿名的 ----
  r = await root_('/api/trash/restore', { method: 'POST', body: { id: r.data.trashId } });
  ok('A11 站主能把匿名帖恢复回来', r.status === 200, JSON.stringify(r.data));
  const back = db.prepare(`SELECT author_id,is_anon FROM threads WHERE id=?`).get(tid);
  ok('A11b 恢复后仍然挂在系统账号上', Number(back.author_id) === Number(anonId) && Number(back.is_anon) === 1);
  r = await guest('/api/threads/' + tid);
  ok('A11c 恢复后接口输出仍是匿名', r.status === 200 && r.data.thread.username === ANON && Number(r.data.thread.author_id) === 0);

  // ---- 用户主页 / 统计 ----
  r = await guest('/api/users/' + aliceId);
  ok('A12 发帖人主页里没有那条匿名帖', r.status === 200 && !(r.data.threads || []).some(t => t.id === tid),
    JSON.stringify((r.data.threads || []).map(t => t.id)));
  ok('A12b 统计数字里也不含匿名内容', Number(r.data.stats.threads) === 0, JSON.stringify(r.data.stats));
  r = await guest('/api/users/' + anonId);
  ok('A12c 系统账号没有主页(404)', r.status === 404, 'status=' + r.status);

  /* 防御性断言：万一库里出现一条「is_anon=1、作者列却记着真人」的行
     （历史脏数据，或者将来把匿名换成「保留作者 + 输出抹平」的实现），
     主页与统计也必须把它挡在外面 —— 否则「他主页里凭空多出一条帖」就是一次身份泄露。
     直接写 SQL 造这样一行，是因为走接口根本造不出来（接口永远把匿名写到系统账号上）。 */
  db.prepare(`INSERT INTO threads(title,author_id,body,is_anon) VALUES('假装匿名的帖',?, 'x', 1)`).run(aliceId);
  r = await guest('/api/users/' + aliceId);
  ok('A12d 就算库里出现「记着真人的匿名行」，主页也不会列出来',
    !(r.data.threads || []).some(t => t.title === '假装匿名的帖'),
    JSON.stringify((r.data.threads || []).map(t => t.title)));
  ok('A12e 统计数字同样不把它算进去', Number(r.data.stats.threads) === 0, JSON.stringify(r.data.stats));
  r = await guest('/api/threads?limit=50');
  ok('A12f 但它在列表里仍然是匿名的（作者列已被输出层抹平）',
    (r.data.items || []).some(t => t.title === '假装匿名的帖' && t.username === ANON && Number(t.author_id) === 0));
  db.prepare(`DELETE FROM threads WHERE title='假装匿名的帖'`).run();

  // ---- 保留用户名 ----
  r = await mkCaller(env)('/api/register', { method: 'POST', body: { username: ANON, password: 'whatever123' } });
  ok('A13 注册不能用「匿名用户」', r.status === 400 && /保留/.test(String(r.data.error)), JSON.stringify(r.data));
  r = await alice('/api/account/username', { method: 'POST', body: { username: ANON } });
  ok('A13b 改名也不能撞过去', r.status === 400 || r.status === 401, 'status=' + r.status);

  // ---- 管理端不把系统账号当人 ----
  r = await root_('/api/admin/users');
  ok('A14 管理端用户列表里没有「匿名用户」', r.status === 200 && !r.data.some(u => u.username === ANON));
  r = await root_('/api/admin/terms');
  ok('A14b 协议统计里也没有「匿名用户」', r.status === 200 && !(r.data.pending || []).some(u => u.username === ANON),
    JSON.stringify((r.data.pending || []).map(u => u.username)));
  r = await root_('/api/admin/posts');
  const adminPost = (r.data || []).find(p => p.id === pid);
  ok('A14c 管理端最近内容里也显示匿名', adminPost && adminPost.username === ANON && Number(adminPost.author_id) === 0,
    JSON.stringify(adminPost && { u: adminPost.username, id: adminPost.author_id }));

  // ---- 匿名 + 其他功能共存 ----
  r = await bob('/api/like', { method: 'POST', body: { target: 'thread', id: tid } });
  ok('A15 匿名帖照样能点赞', r.status === 200 && r.data.count === 1, JSON.stringify(r.data));
  r = await bob('/api/poll', { method: 'POST', body: { target: 'thread', id: tid, poll: { question: 'q', options: ['a', 'b'] } } });
  ok('A15b 匿名帖的投票只有站主能挂（子管理员/普通用户 403）', r.status === 403, 'status=' + r.status);
  r = await root_('/api/poll', { method: 'POST', body: { target: 'thread', id: tid, poll: { question: '匿名帖也能投票吗？', options: ['能', '不能'] } } });
  ok('A15c 站主可以给匿名帖挂投票', r.status === 200, JSON.stringify(r.data));

  // ---- 非匿名帖不受影响 ----
  r = await alice('/api/threads', { method: 'POST', body: { title: '一条普通帖', body: '正文' } });
  const tid2 = r.data.id;
  const normal = db.prepare(`SELECT author_id,is_anon FROM threads WHERE id=?`).get(tid2);
  ok('A16 不勾匿名时作者就是本人', Number(normal.author_id) === Number(aliceId) && Number(normal.is_anon) === 0);
  r = await guest('/api/threads/' + tid2);
  ok('A16b 普通帖正常显示用户名与头像字段', r.data.thread.username === 'alice' && r.data.thread.avatar !== 'anon:');

  // ---- 结构 ----
  ok('A17 两个新列都带默认值（老库补齐后行为不变）',
    db.prepare(`PRAGMA table_info(threads)`).all().some(c => c.name === 'is_anon' && String(c.dflt_value) === '0'));
}

/* 老库自愈：只应用 0001，is_anon 由 ensureAnon 补 */
async function selfHeal() {
  console.log('\n--- 后端：老库自愈（只应用 0001）---');
  const worker = (await import(url.pathToFileURL(root + 'src/index.js').href)).default;
  const db = newDb(['0001_init.sql']);
  const env = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) }, __worker: worker };
  const c = mkCaller(env);
  await c('/api/setup', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });
  await c('/api/login', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });

  ok('B1 自检会补出 threads.is_anon', db.prepare(`PRAGMA table_info(threads)`).all().map(x => x.name).includes('is_anon'));
  ok('B2 自检会补出 posts.is_anon', db.prepare(`PRAGMA table_info(posts)`).all().map(x => x.name).includes('is_anon'));

  const usersBefore = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  await c('/api/status');
  ok('B3 只跑一次结构自检不会多出系统账号（懒建）',
    db.prepare(`SELECT COUNT(*) c FROM users`).get().c === usersBefore, 'before=' + usersBefore);

  let r = await c('/api/threads', { method: 'POST', body: { title: '老库匿名', body: 'x', anon: 1 } });
  ok('B4 老库也能匿名发帖', r.status === 200 && Number(r.data.anon) === 1, JSON.stringify(r.data));
  r = await c('/api/threads/' + r.data.id);
  ok('B5 老库读回来也是匿名', r.data.thread.username === ANON && Number(r.data.thread.author_id) === 0,
    JSON.stringify({ u: r.data.thread.username, id: r.data.thread.author_id }));
  ok('B6 匿名账号此时才被建出来', db.prepare(`SELECT COUNT(*) c FROM users WHERE username=?`).get(ANON).c === 1);
}

/* 老库升级：带着历史数据升级，老内容必须还是老样子 */
async function upgrade() {
  console.log('\n--- 后端：带数据升级（老内容不该变成匿名）---');
  const worker = (await import(url.pathToFileURL(root + 'src/index.js').href)).default;
  const db = newDb(['0001_init.sql', '0002_account_features.sql']);
  const env = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) }, __worker: worker };
  const c = mkCaller(env);
  await c('/api/setup', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });
  await c('/api/login', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });
  const r = await c('/api/threads', { method: 'POST', body: { title: '升级前就有的帖', body: 'x' } });
  const tid = r.data.id;

  const d = await c('/api/threads/' + tid);
  ok('C1 老帖 is_anon 默认 0', Number(db.prepare(`SELECT is_anon FROM threads WHERE id=?`).get(tid).is_anon) === 0);
  ok('C2 老帖仍然显示真实作者', d.data.thread.username === 'root' && Number(d.data.thread.author_id) > 0,
    JSON.stringify({ u: d.data.thread.username, id: d.data.thread.author_id }));
}

/* ================================================================
   前端
   ================================================================ */
const mkClassList = () => ({
  _s: new Set(),
  add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
  toggle(c, on) { on ? this._s.add(c) : this._s.delete(c) },
  contains(c) { return this._s.has(c) },
});
function makeEnv({ me, thread, threads, voteRes, postRes }) {
  const els = new Map();
  const mk = (id) => ({
    id, textContent: '', innerHTML: '', outerHTML: '', value: '', checked: false,
    classList: mkClassList(), attrs: {}, style: {}, dataset: {}, files: [],
    parentElement: null, offsetWidth: 0, title: '', disabled: false,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    showModal() { this._opened = true }, close() { this._opened = false }, reset() { },
    addEventListener(t, f) { (this._l = this._l || {})[t] = f },
    removeEventListener() { }, focus() { }, scrollIntoView() { },
    matches() { return false }, showPopover() { }, hidePopover() { },
    querySelector() { return null },
  });
  const get = (sel) => { if (!els.has(sel)) els.set(sel, mk(sel)); return els.get(sel) };
  const app = get('#app');
  const document = {
    documentElement: { _a: {}, setAttribute(k, v) { this._a[k] = v }, getAttribute(k) { return this._a[k] } },
    body: mk('body'),
    querySelector: (sel) => get(sel),
    querySelectorAll: () => [],
    getElementById: (id) => get('#' + id),
    createElement: () => mk('tmp'),
  };
  const store = new Map();
  const apiCalls = [];
  const sandbox = {
    document,
    navigator: { clipboard: { writeText: async () => { } } },
    confirm: () => true, prompt: () => 'x',
    setTimeout: (f) => { try { f && f() } catch (e) { } return 0 }, clearTimeout: () => { }, scrollTo: () => { },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
      removeItem: k => { store.delete(k) },
    },
    matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    URLSearchParams, location: { reload() { } }, console, Error,
    XMLHttpRequest: class { constructor() { this.upload = {} } open() { } setRequestHeader() { } send() { } },
    fetch: async (u, opt) => {
      apiCalls.push({ url: u, opt });
      let body = {};
      if (u.endsWith('/status')) body = { setupNeeded: false, user: me, uploadEnabled: false, maxUploadMb: 0, maxAvatarMb: 0 };
      else if (u.includes('/poll/vote')) body = voteRes || { ok: true, voted: 1, poll: (me && me._pollAfter) || null };
      else if (u.includes('/boards')) body = { boards: [], unboarded: 0 };
      else if (/\/api\/threads\/\d+\/posts/.test(u)) body = postRes || { ok: true, anon: 0 };
      else if (/\/api\/threads\/\d+$/.test(u)) body = thread;
      else if (/\/api\/threads\?/.test(u)) body = threads;
      else body = { ok: true, user: me };
      return { ok: true, status: 200, json: async () => body };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(root + 'public/md.js', 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(root + 'public/app.js', 'utf8'), sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  if (me) run('me = ' + JSON.stringify(me));
  return { sandbox, app, get, apiCalls, els, run };
}

async function frontend() {
  console.log('\n--- 前端：匿名渲染与提交 ---');
  const ME = { id: 1, username: '荣荣', sensitive_filter: 1, can_mod: 0, can_admin: 0 };
  const ANON_ROW = { id: 9, title: '匿名帖', body: '正文', author_id: 0, username: ANON, avatar: 'anon:',
    anon: 1, sensitive: 0, protected: 0, locked: 0, likes: 0, liked: 0, reposts: 0, poll: null, replies: 0, updated_at: '2026-09-20 10:00:00' };
  const mkTh = (extra) => ({ thread: { id: 9, title: '匿名帖', body: '正文', author_id: 0, username: ANON, avatar: 'anon:',
    anon: 1, sensitive: 0, protected: 0, locked: 0, likes: 0, liked: 0, reposts: 0, poll: null, ...extra }, posts: [], att: {} });

  // ① 空白头像
  {
    const env = makeEnv({ me: ME });
    const h = env.run(`avatarHtml({username:'匿名用户',avatar:'anon:'},'ava')`);
    ok('F1 匿名头像渲染成空白圆（没有首字、没有 img）',
      /class="ava avaAnon"/.test(h) && !/匿/.test(h) && !/<img/.test(h), h);
    const h2 = env.run(`avatarHtml({username:'荣荣',avatar:''},'ava')`);
    ok('F1b 普通用户仍然走首字头像', /avaText/.test(h2) && /荣/.test(h2), h2);
    const h3 = env.run(`avatarHtml({username:'匿名用户'},'ava')`);
    ok('F1c 没有哨兵时不会误判成匿名', /avaText/.test(h3), h3);
  }

  // ② 列表：名字不可点、头像不可点
  {
    const env = makeEnv({ me: ME, threads: { items: [ANON_ROW], total: 1, page: 1, pages: 1 } });
    await env.sandbox.list();
    const h = env.app.innerHTML;
    ok('F2 列表里匿名作者名渲染出来了', h.includes(ANON), h.slice(0, 160));
    ok('F2b 列表里没有指向 openUser 的作者链接', !/openUser\(0\)/.test(h), h.slice(0, 200));
    ok('F2c 匿名名带 anonName 类（不可点样式）', /anonName/.test(h));
    ok('F2d 列表头像走空白哨兵', /avaAnon/.test(h));
  }

  // ③ 详情：作者名不可点 + 不渲染编辑按钮
  {
    const env = makeEnv({ me: ME, thread: mkTh() });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    ok('F3 详情里没有 openUser(0)', !/openUser\(0\)/.test(h), h.slice(0, 200));
    ok('F3b 详情里没有「编辑」按钮（匿名不可编辑）', !/editThread\(9\)/.test(h));
    ok('F3c 详情里没有「＋ 投票」按钮（匿名帖只有站主能挂投票）', !/openPollDialog\('thread',9,9\)/.test(h));
  }
  {
    const AMD = { ...ME, id: 1, can_admin: 1, can_mod: 1 };
    const env = makeEnv({ me: AMD, thread: mkTh() });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    ok('F3d 站主对匿名帖仍能看到投票入口（治理留路）', /openPollDialog\('thread',9,9\)/.test(h));
    ok('F3e 站主也看不到「编辑」（匿名发出去就改不了）', !/editThread\(9\)/.test(h));
  }

  // ④ openUser(0) 不发请求
  {
    const env = makeEnv({ me: ME });
    env.apiCalls.length = 0;                 // app.js 启动时会自己拉一次 /api/status，先清掉
    await env.sandbox.openUser(0);
    ok('F4 openUser(0) 直接忽略，不产生请求', env.apiCalls.length === 0, JSON.stringify(env.apiCalls.map(c => c.url)));
  }

  // ⑤ 提交带 anon
  {
    const env = makeEnv({ me: ME });
    env.get('#postAnon').checked = true;
    await env.get('#postForm').onsubmit({ preventDefault() { } });
    const call = env.apiCalls.find(c => /\/api\/threads$/.test(c.url) && c.opt && c.opt.method === 'POST');
    const body = call && JSON.parse(call.opt.body);
    ok('F5 发帖请求带 anon:1', call && body && Number(body.anon) === 1, call && call.opt.body);
  }
  {
    const env = makeEnv({ me: ME });
    env.get('#postAnon').checked = false;
    await env.get('#postForm').onsubmit({ preventDefault() { } });
    const call = env.apiCalls.find(c => /\/api\/threads$/.test(c.url));
    ok('F5b 不勾时不传匿名', call && Number(JSON.parse(call.opt.body).anon) === 0, call && call.opt.body);
  }

  // ⑥ 回复带 anon
  {
    const env = makeEnv({ me: ME, thread: mkTh() });
    await env.sandbox.openThread(9);
    env.get('#replyAnon').checked = true;
    env.get('#replyBody').value = '匿名回一句';
    const fn = env.get('#replyForm')._l && env.get('#replyForm')._l.submit;
    await fn({ preventDefault() { } });
    const call = env.apiCalls.find(c => /\/threads\/9\/posts/.test(c.url));
    const body = call && JSON.parse(call.opt.body);
    ok('F6 回复请求带 anon:1', call && body && Number(body.anon) === 1, call && call.opt.body);
  }

  // ⑦ 投票的静默丢弃要出声
  {
    const env = makeEnv({ me: ME, thread: mkTh(), postRes: { ok: true, anon: 0, poll: 0 } });
    await env.sandbox.openThread(9);
    env.run(`curPollDraft={question:'Q',options:['a','b'],multi:0}`);
    env.get('#replyBody').value = '带投票的回复';
    const fn = env.get('#replyForm')._l && env.get('#replyForm')._l.submit;
    await fn({ preventDefault() { } });
    const t = env.get('#toast');
    ok('F7 投票被后端丢弃时会提示（不再静默）', /投票没挂上/.test(String(t.innerHTML) + String(t.textContent)),
      String(t.innerHTML) + '|' + String(t.textContent));
  }

  // ⑧ 引用卡：匿名也空白头像
  {
    const env = makeEnv({ me: ME });
    const h = env.run(`quoteCard({t:'thread',id:3,user:'匿名用户',anon:1,title:'标题',excerpt:'摘要'})`);
    ok('F8 引用卡上匿名作者是空白头像', /avaAnon/.test(h) && !/<img/.test(h), h);
    ok('F8b 引用卡带 anonName 样式', /class="anonName"/.test(h), h);
    const h2 = env.run(`quoteCard({t:'thread',id:3,user:'荣荣',title:'标题',excerpt:'摘要'})`);
    ok('F8c 普通引用卡仍然是首字头像', !/avaAnon/.test(h2) && /avaText/.test(h2), h2);
  }
}

/* ---------------- 投票修复的回归（跟着匿名一起验，免得漏掉）---------------- */
async function pollFixes() {
  console.log('\n--- 前端：投票那几处修复 ---');
  const ME = { id: 1, username: '荣荣', sensitive_filter: 1, can_mod: 0, can_admin: 0 };
  const openPoll = { id: 6, question: '凶手是不是他？', multi: 0, total: 0, voted: 0, mine: [],
    options: [{ id: 41, label: '是', n: 0 }, { id: 42, label: '不是', n: 0 }] };
  const votedPoll = { id: 7, question: '今晚吃什么？', multi: 0, total: 3, voted: 1, mine: [51],
    options: [{ id: 51, label: '火锅', n: 2 }, { id: 52, label: '烤肉', n: 1 }] };

  // ① 敏感列表里的投票摘要必须一起糊掉
  {
    const env = makeEnv({ me: ME, threads: { items: [{ id: 9, title: '剧透帖', body: '正文', author_id: 0, username: ANON, avatar: 'anon:',
      anon: 1, sensitive: 1, protected: 0, locked: 0, likes: 0, liked: 0, reposts: 0, replies: 0,
      updated_at: '2026-09-20 10:00:00', poll: openPoll }], total: 1, page: 1, pages: 1 } });
    await env.sandbox.list();
    const h = env.app.innerHTML;
    ok('G1 敏感帖列表里的投票摘要带 blurLock（以前是明文漏出来的）', /class="pollMini blurLock"/.test(h), h.slice(0, 400));
  }
  {
    const env = makeEnv({ me: ME, threads: { items: [{ id: 9, title: '普通帖', body: '正文', author_id: 1, username: 'a', avatar: '',
      sensitive: 0, protected: 0, locked: 0, likes: 0, liked: 0, reposts: 0, replies: 0,
      updated_at: '2026-09-20 10:00:00', poll: openPoll }], total: 1, page: 1, pages: 1 } });
    await env.sandbox.list();
    ok('G1b 普通帖的投票摘要不糊', !/pollMini blurLock/.test(env.app.innerHTML));
  }

  // ② 游客不该被写着「去投票」
  {
    const env = makeEnv({ me: null, threads: { items: [{ id: 9, title: '普通帖', body: '正文', author_id: 1, username: 'a', avatar: '',
      sensitive: 0, protected: 0, locked: 0, likes: 0, liked: 0, reposts: 0, replies: 0,
      updated_at: '2026-09-20 10:00:00', poll: openPoll }], total: 1, page: 1, pages: 1 } });
    await env.sandbox.list();
    ok('G2 游客看到的是「登录后投票」而不是「去投票」', /登录后投票/.test(env.app.innerHTML) && !/去投票/.test(env.app.innerHTML),
      env.app.innerHTML.slice(0, 400));
  }

  // ③ 锁定的主题：投票已结束，只给结果
  {
    const env = makeEnv({ me: ME });
    const h = env.run(`pollCardHtml(${JSON.stringify(openPoll)}, true)`);
    ok('G3 锁定主题的投票卡不给投票按钮', !/pollOpt"/.test(h) && !/togglePollPick|votePoll/.test(h), h.slice(0, 300));
    ok('G3b 锁定主题的投票卡直接给结果条', /pollRes/.test(h) && /投票已结束/.test(h), h.slice(0, 300));
  }
  {
    const env = makeEnv({ me: ME });
    const h = env.run(`pollCardHtml(${JSON.stringify(openPoll)}, false)`);
    ok('G3c 没锁定就照常给投票按钮', /votePoll/.test(h));
  }

  // ④ 换帖要清掉多选勾选状态
  {
    const env = makeEnv({ me: ME, thread: { thread: { id: 9, title: 't', body: 'b', author_id: 1, username: 'a', avatar: '',
      sensitive: 0, protected: 0, locked: 0, likes: 0, liked: 0, reposts: 0, poll: null }, posts: [], att: {} } });
    env.run(`pollPicksOf(6).add(41)`);
    ok('G4 勾选状态先塞进去', env.run(`pollPicksOf(6).size`) === 1);
    await env.sandbox.openThread(9);
    ok('G4b 打开主题会清空多选勾选（否则会提交看不见的旧选择）', env.run(`pollPicksOf(6).size`) === 0);
  }

  // ⑤ 已投票仍然显示结果
  {
    const env = makeEnv({ me: ME });
    const h = env.run(`pollCardHtml(${JSON.stringify(votedPoll)}, false)`);
    ok('G5 投过的投票照常显示结果与票数', /2 票/.test(h) && /已投票/.test(h), h.slice(0, 300));
  }
}

/* ---------------- 后端：投票修复 ---------------- */
async function pollBackendFixes() {
  console.log('\n--- 后端：锁定主题不再收新票 ---');
  const worker = (await import(url.pathToFileURL(root + 'src/index.js').href)).default;
  const db = newDb(['0001_init.sql', '0002_account_features.sql', '0013_anon.sql']);
  const env = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) }, __worker: worker };
  const rootC = mkCaller(env);
  await rootC('/api/setup', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });
  await rootC('/api/login', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });
  const mk = async (n) => { const c = mkCaller(env); await c('/api/register', { method: 'POST', body: { username: n, password: 'userpass123' } }); await c('/api/login', { method: 'POST', body: { username: n, password: 'userpass123' } }); return c };
  const a = await mk('alice'), b = await mk('bob');

  let r = await a('/api/threads', { method: 'POST', body: { title: '会被锁的帖', body: 'x', poll: { question: 'q', options: ['x', 'y'], multi: 0 } } });
  const tid = r.data.id;
  r = await b('/api/threads/' + tid);
  const poll = r.data.thread.poll;
  ok('H1 锁之前能投票', (await a('/api/poll/vote', { method: 'POST', body: { poll: poll.id, options: [poll.options[0].id] } })).status === 200);

  await rootC('/api/admin/moderate', { method: 'POST', body: { type: 'lock', id: tid } });
  r = await b('/api/poll/vote', { method: 'POST', body: { poll: poll.id, options: [poll.options[0].id] } });
  ok('H2 锁定后不能再投票(403)', r.status === 403, 'status=' + r.status);
  ok('H2b 理由说得清', /锁定/.test(String(r.data && r.data.error)), JSON.stringify(r.data));

  // 站主仍可投（治理动作要留一条路，和回复接口的判法一致）
  r = await rootC('/api/poll/vote', { method: 'POST', body: { poll: poll.id, options: [poll.options[0].id] } });
  ok('H3 站主在锁定主题里仍能投票', r.status === 200, JSON.stringify(r.data));

  // 回复里挂的投票也一样
  r = await a('/api/threads', { method: 'POST', body: { title: '另一个帖', body: 'x' } });
  const tid2 = r.data.id;
  r = await a('/api/threads/' + tid2 + '/posts', { method: 'POST', body: { body: '带投票的回复', poll: { question: 'q2', options: ['p', 'q'], multi: 0 } } });
  ok('H4 回复里能挂投票', r.status === 200 && Number(r.data.poll) === 1, JSON.stringify(r.data));
  r = await a('/api/threads/' + tid2);
  const pPoll = r.data.posts[0].poll;
  await rootC('/api/admin/moderate', { method: 'POST', body: { type: 'lock', id: tid2 } });
  r = await b('/api/poll/vote', { method: 'POST', body: { poll: pPoll.id, options: [pPoll.options[0].id] } });
  ok('H5 锁定主题里回复挂的投票也投不了(403)', r.status === 403, 'status=' + r.status);

  // 投票选项不足时后端确实静默丢弃（前端负责提示），响应里的 poll 标记是 0
  r = await a('/api/threads', { method: 'POST', body: { title: '投票不合规', body: 'x', poll: { question: 'q', options: ['只有一个'], multi: 0 } } });
  ok('H6 只有一个选项的投票被丢弃，但帖子照发', r.status === 200 && Number(r.data.poll) === 0, JSON.stringify(r.data));
}

(async () => {
  await backend();
  await selfHeal();
  await upgrade();
  await frontend();
  await pollFixes();
  await pollBackendFixes();
  console.log(`\n=== 匿名发布 / 投票修复校验: ${pass} passed, ${fail} failed ===`);
  if (fail) process.exitCode = 1;
})();
