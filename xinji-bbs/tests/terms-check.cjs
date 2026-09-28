/* 用户协议（0012）—— 后端（真实 SQL）+ 前端（最小 DOM 桩）一起验
 *
 * 后端部分：node:sqlite 建真库（外键 ON）模拟 D1，直接调 Worker 代码。
 *           「必须同意才能用」的语义只有跑真 SQL 才算验过：
 *           requireUser 里那道 need_terms 是按 users.terms_version 现算的。
 * 前端部分：最小 DOM 桩 + 拦截 fetch，不引入 jsdom（沿用 poll-check / reaction-check 的路子）。
 *
 * 运行：node tests/terms-check.cjs
 */
const fs = require('fs'), url = require('url'), path = require('path'), vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..') + '/';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

/* ---------------- D1 mock（与 e2e 同一套语义：延迟编译 + batch 是事务 + 外键 ON）---------------- */
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
  return async (p, o = {}) => {
    const h = { 'content-type': 'application/json', ...(o.headers || {}) };
    if (!h['cf-connecting-ip']) h['cf-connecting-ip'] = `203.0.113.${(seq++ % 250) + 1}`;
    if (cookie) h['Cookie'] = cookie;
    const req = new Request('http://localhost' + p, { method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined, headers: h });
    const res = await env.__worker.fetch(req, env, {});
    const sc = res.headers.get('set-cookie');
    if (sc) { const m = sc.match(/bbs_session=([^;]*)/); cookie = (m && m[1]) ? 'bbs_session=' + m[1] : ''; }
    let data = null; try { data = await res.json() } catch (e) { }
    return { status: res.status, data };
  };
};

const worker = async () => (await import(url.pathToFileURL(root + 'src/index.js').href)).default;

/* ---------------- 后端 ---------------- */
async function backend() {
  console.log('\n--- 后端：协议门槛 / 版本升级（真实 SQL，外键 ON）---');
  const w = await worker();
  // 带上 0012 迁移一起跑：迁移本身能被 SQLite 执行 + ensureTerms 再补一遍（幂等）
  const db = newDb(['0001_init.sql', '0002_account_features.sql', '0012_terms.sql']);
  const env = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) }, __worker: w };
  const root_ = mkCaller(env);

  ok('B0 初始化管理员', (await root_('/api/setup', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } })).status === 200);
  await root_('/api/login', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });

  const mkUser = async (name, termsVersion) => {
    const c = mkCaller(env);
    const body = { username: name, password: 'userpass123' };
    if (termsVersion !== undefined) body.terms_version = termsVersion;
    await c('/api/register', { method: 'POST', body });
    await c('/api/login', { method: 'POST', body: { username: name, password: 'userpass123' } });
    return c;
  };
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');
  const guest = mkCaller(env);
  const uidOf = (name) => db.prepare(`SELECT id FROM users WHERE username=?`).get(name).id;
  const termsVersionOf = (name) => db.prepare(`SELECT terms_version FROM users WHERE username=?`).get(name).terms_version;
  const post = (c, title) => c('/api/threads', { method: 'POST', body: { title, body: '正文' } });

  // ---- 默认状态：一版都没签 ----
  let r = await alice('/api/status');
  ok('B1 /api/status 下发协议状态（版本 + 是否已同意）',
    r.data && r.data.terms && r.data.terms.version === 1 && r.data.terms.agreed === false,
    JSON.stringify(r.data && r.data.terms));
  ok('B1b status 里 publicUser 带 terms_version / terms_at',
    r.data.user && r.data.user.terms_version === 0 && 'terms_at' in r.data.user);

  r = await post(alice, '没签协议就想发帖');
  ok('B2 没签协议：发帖 403 且带 need_terms 标记', r.status === 403 && r.data.need_terms === true && r.data.terms_version === 1, JSON.stringify(r.data));

  r = await alice('/api/trash');
  ok('B2b 需要登录的其它接口同样被拦住', r.status === 403 && r.data.need_terms === true, JSON.stringify(r.data));

  r = await guest('/api/terms');
  ok('B3 未登录能读到协议正文', r.status === 200 && typeof r.data.text === 'string' && r.data.text.length > 500 && r.data.version === 1);
  ok('B3b 默认正文写明了「用户发布的内容由用户负责」', /全部由你本人负责/.test(r.data.text) && /不预先审查/.test(r.data.text));

  r = await guest('/api/terms/agree', { method: 'POST', body: { version: 1 } });
  ok('B4 未登录不能同意（401）', r.status === 401, JSON.stringify(r.data));

  r = await alice('/api/terms/agree', { method: 'POST', body: {} });
  ok('B5 不同意「当前版本」的版本号传错 → 409（不能替人签没看过的条款）',
    r.status === 409 && r.data.need_terms === true, JSON.stringify(r.data));

  r = await alice('/api/terms/agree', { method: 'POST', body: { version: 1 } });
  ok('B6 同意当前版本 → 200 并写库', r.status === 200 && r.data.version === 1 && termsVersionOf('alice') === 1, JSON.stringify(r.data));
  ok('B6b 同意时间落库', !!db.prepare(`SELECT terms_at FROM users WHERE username='alice'`).get().terms_at);

  ok('B7 同意之后就能发帖了', (await post(alice, '签完就能发')).status === 200);

  r = await alice('/api/status');
  ok('B7b status 里的 agreed 翻成 true', r.data.terms.agreed === true);

  // ---- 站主豁免 ----
  r = await post(root_, '站主不发帖也要能用');
  ok('B8 站主豁免：没签也能发帖（否则改完协议把自己锁在门外）', r.status === 200, JSON.stringify(r.data));

  // ---- 站主改协议：全员重新过一遍 ----
  const newText = '# 新协议\n\n1. 这是改过之后的正文。\n2. 请重新确认。';
  r = await root_('/api/admin/terms', { method: 'POST', body: { text: newText, bump: 1 } });
  ok('B9 站主保存协议：版本 +1', r.status === 200 && r.data.version === 2 && r.data.bumped === true, JSON.stringify(r.data));

  r = await alice('/api/status');
  ok('B10 升级后已签过的用户重新变成「未同意」', r.data.terms.version === 2 && r.data.terms.agreed === false);
  r = await post(alice, '协议更新后又被拦');
  ok('B10b 升级后发帖再次 403 need_terms', r.status === 403 && r.data.need_terms === true && r.data.terms_version === 2, JSON.stringify(r.data));
  ok('B10c 库里的 terms_version 还是老版本（没被偷偷改）', termsVersionOf('alice') === 1);

  r = await alice('/api/terms/agree', { method: 'POST', body: { version: 1 } });
  ok('B11 拿旧版本号去同意 → 409（必须看新的那份）', r.status === 409 && r.data.terms_version === 2, JSON.stringify(r.data));
  r = await alice('/api/terms/agree', { method: 'POST', body: { version: 2 } });
  ok('B11b 用新版本号同意 → 200', r.status === 200 && termsVersionOf('alice') === 2);
  ok('B11c 又恢复可用', (await post(alice, '重新签完')).status === 200);

  r = await alice('/api/terms');
  ok('B12 正文确实换成新的了', r.data.text === newText);
  ok('B12b 正文更新后 updated_at 有值', !!r.data.updated_at);

  // ---- 「只改文字不要求重新确认」----
  r = await root_('/api/admin/terms', { method: 'POST', body: { text: newText + '\n\n3. 补一条错别字修正。', bump: 0 } });
  ok('B13 勾掉「要求重新确认」→ 版本不动', r.status === 200 && r.data.version === 2 && r.data.bumped === false && r.data.changed === true, JSON.stringify(r.data));
  r = await alice('/api/status');
  ok('B13b 已经签过的人不会被打断', r.data.terms.agreed === true);
  ok('B13c 但正文是真的改了', (await alice('/api/terms')).data.text.includes('错别字修正'));

  r = await root_('/api/admin/terms', { method: 'POST', body: { text: newText + '\n\n3. 补一条错别字修正。', bump: 1 } });
  ok('B14 正文没变化时，即使勾着「重新确认」也不升版本（连点两下不该全站多弹一次）',
    r.status === 200 && r.data.version === 2 && r.data.changed === false, JSON.stringify(r.data));

  // ---- 管理端统计 ----
  r = await root_('/api/admin/terms');
  ok('B15 站主能看到协议正文 / 版本 / 默认文案', r.status === 200 && r.data.text.length > 0 && r.data.version === 2 && r.data.default_text.length > 500 && r.data.customized === true);
  ok('B15b 同意情况统计：bob 还没签', r.data.stats.total === 3 && r.data.stats.agreed === 2 && r.data.stats.pending === 1, JSON.stringify(r.data.stats));
  ok('B15c 未确认名单里有 bob', r.data.pending.length === 1 && r.data.pending[0].username === 'bob');

  // ---- 子管理员不许改协议 ----
  await root_('/api/admin/set-role', { method: 'POST', body: { id: uidOf('bob'), role: 'moderator' } });
  await bob('/api/login', { method: 'POST', body: { username: 'bob', password: 'userpass123' } });
  r = await bob('/api/terms/agree', { method: 'POST', body: { version: 2 } });
  ok('B16 子管理员自己也要签协议', r.status === 200);
  r = await bob('/api/admin/terms', { method: 'GET' });
  ok('B17 子管理员读协议管理页 → 403（只有站主能改）', r.status === 403, JSON.stringify(r.data));
  r = await bob('/api/admin/terms', { method: 'POST', body: { text: '我要改协议', bump: 1 } });
  ok('B17b 子管理员改协议 → 403', r.status === 403);
  ok('B17c 版本没被改掉', (await root_('/api/admin/terms')).data.version === 2);

  // ---- 参数校验 ----
  r = await root_('/api/admin/terms', { method: 'POST', body: { text: '   ', bump: 1 } });
  ok('B18 空正文 → 400', r.status === 400);
  r = await root_('/api/admin/terms', { method: 'POST', body: { text: 'x'.repeat(20001), bump: 1 } });
  ok('B19 超长正文 → 400', r.status === 400);

  // ---- 注册时带上已同意版本 ----
  const cindy = mkCaller(env);
  await cindy('/api/register', { method: 'POST', body: { username: 'cindy', password: 'userpass123', terms_version: 2 } });
  await cindy('/api/login', { method: 'POST', body: { username: 'cindy', password: 'userpass123' } });
  ok('B20 注册时带着「已同意的当前版本」→ 直接记进账号', termsVersionOf('cindy') === 2);
  ok('B20b 于是注册完不用再签一次', (await post(cindy, 'cindy 的第一帖')).status === 200);

  const dan = mkCaller(env);
  await dan('/api/register', { method: 'POST', body: { username: 'dan', password: 'userpass123', terms_version: 1 } });
  await dan('/api/login', { method: 'POST', body: { username: 'dan', password: 'userpass123' } });
  ok('B21 注册时带的是过期版本 → 记为 0，登录后照样被拦', termsVersionOf('dan') === 0);
  ok('B21b dan 发帖 403 need_terms', (await post(dan, 'dan 的帖子')).status === 403);

  // ---- 封禁 / 保护状态优先于协议 ----
  await root_('/api/admin/moderate', { method: 'POST', body: { type: 'ban', id: uidOf('dan') } });
  r = await dan('/api/terms/agree', { method: 'POST', body: { version: 2 } });
  ok('B22 被封禁的账号连「同意协议」都点不动（报的是封禁，不是协议）', r.status === 403 && /封禁/.test(r.data.error), JSON.stringify(r.data));

  // ---- 老库自愈：没有 0012 迁移，靠 ensureSchema 补列 ----
  const db2 = newDb(['0001_init.sql', '0002_account_features.sql']);
  const env2 = { DB: new D1(db2), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) }, __worker: w };
  ok('B23 老库（没有 0012）里 users 还没有 terms_version 列',
    !db2.prepare(`PRAGMA table_info(users)`).all().some(c => c.name === 'terms_version'));
  const old = mkCaller(env2);
  r = await old('/api/status');
  ok('B24 但 first request 的自检会把列补上，接口不 500', r.status === 200 && r.data.terms.version === 1);
  ok('B24b 列真的补上了', db2.prepare(`PRAGMA table_info(users)`).all().some(c => c.name === 'terms_version'));
}

/* ---------------- 前端 ---------------- */
const mkClassList = () => ({
  _s: new Set(),
  add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
  toggle(c, on) { on ? this._s.add(c) : this._s.delete(c) },
  contains(c) { return this._s.has(c) },
});
function makeEnv({ me, terms, text, agreeRes, adminRes }) {
  const els = new Map();
  const mk = (id) => ({
    id, textContent: '', innerHTML: '', outerHTML: '', value: '', checked: false, disabled: false,
    classList: mkClassList(), attrs: {}, style: {}, dataset: {}, files: [],
    parentElement: null, offsetWidth: 0, title: '',
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    showModal() { this._opened = true }, close() { this._opened = false }, reset() { },
    addEventListener(t, f) { (this._l = this._l || {})[t] = f },
    removeEventListener() { }, focus() { }, scrollIntoView() { }, onclick: null,
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
  const loc = { _replaced: null, reload() { }, replace(u) { this._replaced = u } };
  const sandbox = {
    document,
    navigator: { clipboard: { writeText: async () => { } } },
    confirm: () => true,
    setTimeout: (f, ms) => setTimeout(() => { try { f && f() } catch (e) { } }, Math.min(Number(ms) || 0, 5)), clearTimeout: (t) => clearTimeout(t), scrollTo: () => { },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
      removeItem: k => { store.delete(k) },
    },
    matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    URLSearchParams, location: loc, console, Error,
    XMLHttpRequest: class { constructor() { this.upload = {} } open() { } setRequestHeader() { } send() { } },
    fetch: async (u, opt) => {
      if (process.env.TERMS_TRACE) console.log('   [fetch]', u);
      apiCalls.push({ url: u, opt, body: opt && opt.body ? JSON.parse(opt.body) : null });
      let status = 200;
      let body = { ok: true };
      if (u.endsWith('/terms')) body = { version: terms.version, text, updated_at: '2026-09-25 06:00:00', agreed: false };
      else if (u.endsWith('/terms/agree')) { const a = agreeRes || { ok: true, version: terms.version }; status = a.status || 200; body = a.body || a; }
      else if (u.endsWith('/admin/terms')) body = adminRes || { ok: true };
      else if (u.endsWith('/status')) body = { setupNeeded: false, user: me ? JSON.parse(JSON.stringify(me)) : null, uploadEnabled: false, maxUploadMb: 0, maxAvatarMb: 0, terms };
      else if (u.includes('/boards')) body = { boards: [], unboarded: 0 };
      else if (/\/api\/threads\?/.test(u)) body = { items: [], total: 0, page: 1, pages: 1, limit: 20 };
      else body = { ok: true, user: me || null };
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(root + 'public/md.js', 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(root + 'public/app.js', 'utf8'), sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  /* app.js 一加载完就会自己调 init()（这是真实行为，测试也得认）。
     init() 会打 /api/status，并把 vm 里的 me 覆盖成服务端返回的那份 ——
     所以「注入 me」必须等它跑完，否则刚注入就被冲掉（这是踩过的坑，
     症状很怪：断言看起来在测 A，其实读到的是 status 里那个对象）。 */
  const ready = (async () => {
    await new Promise(r => setTimeout(r, 25));
    if (me) run('me = ' + JSON.stringify(me));
    run('termsCache = null');     // init 可能已经顺手拉过协议正文，清掉重来
  })();
  return { sandbox, app, get, apiCalls, els, run, store, loc, ready };
}

async function frontend_() {
  console.log('\n--- 前端：协议墙的判断 / 同意 / 拒绝 / 渲染 ---');
  const ME = { id: 1, username: '荣荣', sensitive_filter: 1, can_mod: 0, can_admin: 0, terms_version: 1, terms_at: null };
  const EVIL = '# 标题\n<script>alert(1)</script>\n[点我](javascript:alert(2))';

  // vm 里的微任务只能在「当前 tick 结束」时推进 —— 跨 realm 的 Promise 要给它一个机会
  const tick = () => new Promise(r => setImmediate(r));

  // ① 该不该弹：登录用户听服务端的
  {
    const need = makeEnv({ me: ME, terms: { version: 1, agreed: false }, text: '正文' });
    await need.ready;
    ok('F1 登录用户：服务端说没签 → 要弹', need.run('termsNeed({terms:{version:1,agreed:false}})') === true);
    ok('F1b 登录用户：服务端说签过 → 不弹（哪怕本地没记录）',
      need.run('termsNeed({terms:{version:1,agreed:true}})') === false);
  }
  // ② 游客：本地版本说了算
  {
    const env = makeEnv({ me: null, terms: { version: 3, agreed: false }, text: '正文' });
    await env.ready;
    env.run(`lsSet('bbs_terms_ok','2')`);
    ok('F2 游客本地记的是旧版本 → 要弹', env.run('termsNeed({terms:{version:3,agreed:false}})') === true);
    env.run(`lsSet('bbs_terms_ok','3')`);
    ok('F2b 游客本地记的正是当前版本 → 不弹', env.run('termsNeed({terms:{version:3,agreed:false}})') === false);
    ok('F2c 没有 terms 字段时一律不弹（宁可不弹也不要卡住整站）', env.run('termsNeed({})') === false);
  }
  // ③ 游客同意 → 记本地 + 关掉墙（墙是 init() 自己立的，走真实路径）
  {
    const env = makeEnv({ me: null, terms: { version: 3, agreed: false }, text: '正文' });
    await env.ready;
    ok('F3 游客一进来就被挡住（init 自己立墙，不等任何点击）', env.get('#termsDialog')._opened === true && env.run('termsWallOn') === true);
    env.run('curTermsVersion = 3');
    await env.run('agreeTerms()');
    ok('F3a 游客点同意：不需要发请求', !env.apiCalls.some(c => c.url.includes('/terms/agree')));
    ok('F3b 本地记下当前版本', env.store.get('bbs_terms_ok') === '3');
    ok('F3c 墙被关掉', env.get('#termsDialog')._opened === false);
    ok('F3d 等在那儿的 Promise 已被放行、状态复位', env.run('termsWallOn') === false && env.run('termsResolve') === null);
  }
  // ④ 登录用户同意 → 提交版本号
  {
    const env = makeEnv({ me: ME, terms: { version: 4, agreed: false }, text: '正文' });
    await env.ready;
    ok('F4 墙被打开（showModal）', env.get('#termsDialog')._opened === true);
    env.run('curTermsVersion = 4');
    await env.run('agreeTerms()');
    const call = env.apiCalls.find(c => c.url.includes('/terms/agree'));
    ok('F4b 提交的正是看到的那个版本号', !!call && call.body && call.body.version === 4, JSON.stringify(call && call.body));
    ok('F4c 提交成功后墙关闭', env.get('#termsDialog')._opened === false);
    ok('F4d 同意了就不写游客的那份 localStorage', !env.store.has('bbs_terms_ok'));
    ok('F4e 内存里的 me.terms_version 跟着更新', env.run('me.terms_version') === 4);
    // 桩把 user 深拷贝给 vm，所以宿主那个 ME 不该被改 —— 否则后面的用例会读到被污染的值
    ok('F4f 用例之间不串味（宿主侧的 ME 没被改）', ME.terms_version === 1, String(ME.terms_version));
  }
  // ⑤ 提交失败（版本被站主改过）→ 不关门，重新拉新正文
  {
    const env = makeEnv({ me: ME, terms: { version: 5, agreed: false }, text: '正文', agreeRes: { status: 409, body: { error: '协议刚刚更新过，请重新阅读后再确认', need_terms: true, terms_version: 6 } } });
    await env.ready;
    env.run('curTermsVersion = 5');
    await env.run('agreeTerms()');
    ok('F5 版本对不上被 409：`墙不关闭，人得重看一遍', env.get('#termsDialog')._opened === true);
    ok('F5b 重新拉了一次正文（缓存作废）', env.apiCalls.filter(c => c.url.endsWith('/api/terms')).length >= 2);
  }
  // ⑥ 不同意 → 直接离开
  {
    const env = makeEnv({ me: ME, terms: { version: 1, agreed: false }, text: '正文' });
    await env.ready;
    env.run('declineTerms()');
    ok('F6 点「不同意」→ 跳去 about:blank（离开本站）', env.loc._replaced === 'about:blank', String(env.loc._replaced));
  }
  // ⑦ 正文渲染一定要转义（协议是站主写的，但也不该直插 HTML）
  {
    const env = makeEnv({ me: ME, terms: { version: 1, agreed: false }, text: EVIL });
    await env.ready;
    env.run(`fillTermsBody('#x', ${JSON.stringify(EVIL)})`);
    const html = env.get('#x').innerHTML;
    ok('F7 正文里的 <script> 被转义掉', !/<script/i.test(html) && /&lt;script&gt;/.test(html), html.slice(0, 120));
    ok('F7b javascript: 伪协议链接降级成纯文字', !/href="javascript:/i.test(html));
    ok('F7c 正常 Markdown 照样解析（# 标题）', /<h1>/.test(html));
  }
  // ⑧ api() 撞上 need_terms 会自己把墙顶上来
  {
    const env = makeEnv({ me: ME, terms: { version: 2, agreed: false }, text: '正文' });
    await env.ready;
    ok('F8 __openTermsWall 已挂到 window 上', typeof env.sandbox.__openTermsWall === 'function');
    // 先假装已经签完把墙放下来（清掉防抖标志），再验证它会被顶回来
    env.run('finishTermsWall()');
    ok('F8b 放下来之后是复位状态', env.run('termsWallOn') === false && env.get('#termsDialog')._opened === false);
    env.run('window.__openTermsWall()');
    await new Promise(r => setTimeout(r, 10));
    ok('F8c 再收到 need_terms 时墙会被重新顶起来', env.get('#termsDialog')._opened === true);
    // 已经在墙上时不能重复立墙（否则会覆盖掉等待中的 Promise，同意按钮就失效了）
    const before = env.apiCalls.length;
    env.run('window.__openTermsWall()');
    await new Promise(r => setTimeout(r, 10));
    ok('F8d 墙已经立着时不重复立（防止把等待中的 Promise 冲掉）', env.apiCalls.length === before);
  }
  // ⑨ 站主保存协议：bump 语义
  {
    const env = makeEnv({ me: { ...ME, can_admin: 1, role: 'admin' }, terms: { version: 2, agreed: true }, text: '正文', adminRes: { ok: true, version: 3, bumped: true, changed: true } });
    await env.ready;
    env.get('#termsText').value = '新的正文';
    env.get('#termsBump').checked = true;
    await env.run('saveTerms()');
    const call = env.apiCalls.find(c => c.url.endsWith('/admin/terms'));
    ok('F9 保存协议时带上 bump', !!call && call.body && call.body.bump === 1 && call.body.text === '新的正文', JSON.stringify(call && call.body));

    const env2 = makeEnv({ me: { ...ME, can_admin: 1, role: 'admin' }, terms: { version: 2, agreed: true }, text: '正文', adminRes: { ok: true, version: 2, bumped: false, changed: true } });
    await env2.ready;
    env2.get('#termsText').value = '只改错别字';
    env2.get('#termsBump').checked = false;
    await env2.run('saveTerms()');
    const call2 = env2.apiCalls.find(c => c.url.endsWith('/admin/terms'));
    ok('F9b 取消勾选时 bump=0（不打断已签的人）', !!call2 && call2.body.bump === 0, JSON.stringify(call2 && call2.body));
  }
  // ⑩ 空正文不发请求
  {
    const env = makeEnv({ me: { ...ME, can_admin: 1, role: 'admin' }, terms: { version: 1, agreed: true }, text: '正文' });
    await env.ready;
    env.get('#termsText').value = '   ';
    await env.run('saveTerms()');
    ok('F10 空正文不发请求，只给一句提示', !env.apiCalls.some(c => c.url.endsWith('/admin/terms')));
  }
  // ⑪ 账户设置里的状态行
  {
    const env = makeEnv({ me: { ...ME, terms_version: 1 }, terms: { version: 7, agreed: true }, text: '正文' });
    await env.ready;
    await env.run('fillTermsCard()');
    const s = env.get('#termsState').textContent;
    ok('F11 设置页显示「当前版本 + 我签到了哪一版」', /v7/.test(s) && /已同意到 v1/.test(s), s);
  }
}

(async () => {
  await backend();
  await frontend_();
  console.log('\n=== 用户协议体检: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})();
