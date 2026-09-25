/* 投票 —— 后端（真实 SQL）+ 前端（最小 DOM 桩）一起验
 *
 * 后端部分：用 Node 内置 node:sqlite 建真实库（外键 ON）模拟 D1，直接调 Worker 代码，
 *           「一人一次」靠唯一索引兜底，所以必须跑真实 SQL 才算验过。
 * 前端部分：沿用 reaction-check 的路子，最小 DOM 桩 + 拦截 fetch，不引入 jsdom。
 *
 * 运行：node tests/poll-check.cjs
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
    if (!h['cf-connecting-ip'] && p === '/api/register') h['cf-connecting-ip'] = `198.51.100.${(seq++ % 250) + 1}`;
    if (cookie) h['Cookie'] = cookie;
    const req = new Request('http://localhost' + p, { method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined, headers: h });
    const res = await env.__worker.fetch(req, env, {});
    const sc = res.headers.get('set-cookie');
    if (sc) { const m = sc.match(/bbs_session=([^;]*)/); cookie = (m && m[1]) ? 'bbs_session=' + m[1] : ''; }
    let data = null; try { data = await res.json() } catch (e) { }
    return { status: res.status, data };
  };
};

const POLL = { question: '今晚吃什么？', options: ['火锅', '烤肉', '沙拉'], multi: 0 };

async function backend() {
  console.log('\n--- 后端：投票的建 / 投 / 改 / 删（真实 SQL，外键 ON）---');
  const worker = (await import(url.pathToFileURL(root + 'src/index.js').href)).default;
  const db = newDb(['0001_init.sql', '0002_account_features.sql']);
  const env = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) }, __worker: worker };

  const root_ = mkCaller(env);
  ok('B0 初始化管理员', (await root_('/api/setup', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } })).status === 200);
  await root_('/api/login', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });

  const mkUser = async (name) => {
    const c = mkCaller(env);
    await c('/api/register', { method: 'POST', body: { username: name, password: 'userpass123' } });
    await c('/api/login', { method: 'POST', body: { username: name, password: 'userpass123' } });
    return c;
  };
  const u1 = await mkUser('alice'), u2 = await mkUser('bob'), u3 = await mkUser('cindy'), u4 = await mkUser('dan');
  const guest = mkCaller(env);
  const uidOf = (name) => db.prepare(`SELECT id FROM users WHERE username=?`).get(name).id;

  // ---- 建 ----
  let r = await u1('/api/threads', { method: 'POST', body: { title: '投票帖', body: '来投一个', poll: POLL } });
  const tid = r.data && r.data.id;
  ok('B1 发帖时带投票(200)', r.status === 200 && !!tid, JSON.stringify(r.data));
  ok('B1b 响应里带回 poll 标记', r.data && r.data.poll === 1);

  r = await u1('/api/threads/' + tid);
  const poll = r.data && r.data.thread && r.data.thread.poll;
  ok('B2 详情里能取到投票', r.status === 200 && poll && poll.id > 0, JSON.stringify(r.data && r.data.thread && r.data.thread.poll));
  ok('B2b 三个选项都在', poll && poll.options && poll.options.length === 3, JSON.stringify(poll && poll.options));
  ok('B2c 初始没人投票', poll && Number(poll.total) === 0 && !poll.voted);
  const oid = poll.options[0].id, oid2 = poll.options[1].id, pid = poll.id;

  // ---- 投 ----
  r = await u1('/api/poll/vote', { method: 'POST', body: { poll: pid, options: [oid] } });
  ok('B3 投票成功', r.status === 200 && r.data.voted === 1, JSON.stringify(r.data));
  ok('B3b 参与人数 1', r.data.poll && Number(r.data.poll.total) === 1);
  ok('B3c 自己那一票被记下', r.data.poll && r.data.poll.mine && r.data.poll.mine[0] === oid);

  r = await u1('/api/poll/vote', { method: 'POST', body: { poll: pid, options: [oid2] } });
  ok('B4 同一账号再投被拒(409)', r.status === 409, 'status=' + r.status);
  ok('B4b 拒绝时说了人话', /只有一票|已经投过/.test(String(r.data && r.data.error)), JSON.stringify(r.data));

  /* 并发两下：接口层的「先查一次」已经会挡住第二个，但真正要保证的是**数据库**这一层 ——
     绕过应用逻辑直接插第二张选票也必须失败，否则并发窗口里一人能投两次。 */
  r = await u3('/api/poll/vote', { method: 'POST', body: { poll: pid, options: [oid] } });
  ok('B5 第三个人投票成功', r.status === 200, JSON.stringify(r.data));
  let dupErr = null;
  try {
    db.prepare(`INSERT INTO poll_ballots(poll_id,user_id) VALUES(?,?)`).run(pid, uidOf('cindy'));
  } catch (e) { dupErr = e }
  const nb = db.prepare(`SELECT COUNT(*) n FROM poll_ballots WHERE poll_id=? AND user_id=?`).get(pid, uidOf('cindy'));
  ok('B5b 同一账号的第二张选票被数据库拦下（一人一次的唯一索引）',
    !!dupErr && Number(nb.n) === 1, 'err=' + (dupErr && dupErr.message) + ' n=' + nb.n);

  r = await u2('/api/poll/vote', { method: 'POST', body: { poll: pid, options: [oid2] } });
  ok('B6 第二个人能投', r.status === 200 && r.data.poll.total === 3, JSON.stringify(r.data.poll && r.data.poll.total));

  // ---- 参数校验（用一个还没投过票的账号，免得先被「已投过」挡下）----
  r = await u4('/api/poll/vote', { method: 'POST', body: { poll: pid, options: [999999] } });
  ok('B7 不属于这个投票的选项(400)', r.status === 400, 'status=' + r.status + ' ' + JSON.stringify(r.data));
  r = await u4('/api/poll/vote', { method: 'POST', body: { poll: 424242, options: [oid] } });
  ok('B8 不存在的投票(404)', r.status === 404, 'status=' + r.status);
  r = await guest('/api/poll/vote', { method: 'POST', body: { poll: pid, options: [oid] } });
  ok('B9 游客投票(401)', r.status === 401, 'status=' + r.status);
  r = await u4('/api/poll/vote', { method: 'POST', body: { poll: pid, options: [] } });
  ok('B9b 不选就投(400)', r.status === 400, 'status=' + r.status + ' ' + JSON.stringify(r.data));

  // ---- 已发出内容补投票 / 改 / 移除 ----
  r = await u1('/api/poll', { method: 'POST', body: { target: 'thread', id: tid, poll: { question: '换一组', options: ['A', 'B'] } } });
  ok('B10 有人投过票后作者不能改(403)', r.status === 403, 'status=' + r.status + ' ' + JSON.stringify(r.data));
  r = await root_('/api/poll', { method: 'POST', body: { target: 'thread', id: tid, poll: { question: '换一组', options: ['A', 'B'] } } });
  ok('B10b 站主可以改(200)（改完票数归零是预期：选项换了）', r.status === 200, JSON.stringify(r.data));

  r = await u3('/api/poll', { method: 'POST', body: { target: 'thread', id: tid, poll: POLL } });
  ok('B11 非作者不能挂投票(403)', r.status === 403, 'status=' + r.status);

  // ---- 回复挂投票 ----
  r = await u2('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '我也来一个', poll: { question: '明天呢', options: ['面', '饭'] } } });
  ok('B12 回复里也能挂投票(200)', r.status === 200 && r.data.poll === 1, JSON.stringify(r.data));
  r = await u1('/api/threads/' + tid);
  const pp = (r.data.posts || []).map(p => p.poll).filter(Boolean);
  ok('B12b 详情里回复的投票也在', pp.length === 1 && pp[0].question === '明天呢', JSON.stringify(pp));

  r = await u2('/api/threads/' + tid + '/posts', { method: 'POST', body: { body: '', poll: { question: '只投票不说话', options: ['好', '不好'] } } });
  ok('B13 只挂投票的回复也能发（正文可以为空）', r.status === 200, JSON.stringify(r.data));
  r = await u1('/api/threads', { method: 'POST', body: { title: '只投票的主题', body: '', poll: POLL } });
  ok('B14 只挂投票的主题也能发（正文可以为空）', r.status === 200, JSON.stringify(r.data));
  const tid2 = r.data.id;
  r = await u1('/api/threads/' + tid2, { method: 'PATCH', body: { title: '只投票的主题（改标题）' } });
  ok('B14b 只挂投票的主题能改标题（不被逼着补正文）', r.status === 200, JSON.stringify(r.data));

  // ---- 不合规格的投票：丢弃，内容照发 ----
  r = await u1('/api/threads', { method: 'POST', body: { title: '投票不合规', body: '正文还在', poll: { question: '只有一个选项', options: ['独苗'] } } });
  ok('B15 选项不足时投票被丢弃、帖照发', r.status === 200 && r.data.poll === 0, JSON.stringify(r.data));
  r = await u1('/api/threads', { method: 'POST', body: { title: '空投票', body: '正文还在' } });
  ok('B15b 没传投票时不会凭空造一个', r.status === 200 && r.data.poll === 0);

  // ---- 多选 ----
  r = await u1('/api/threads', { method: 'POST', body: { title: '多选投票', body: 'x', poll: { question: '带哪些', options: ['相机', '水', '地图'], multi: 1 } } });
  const tid3 = r.data.id;
  r = await u1('/api/threads/' + tid3);
  const mp = r.data.thread.poll;
  ok('B16 多选投票建立', mp && mp.multi === 1, JSON.stringify(mp));
  r = await u1('/api/poll/vote', { method: 'POST', body: { poll: mp.id, options: [mp.options[0].id, mp.options[1].id] } });
  ok('B16b 多选一次投两项(200)', r.status === 200, JSON.stringify(r.data));
  ok('B16c 参与人数仍然是 1', r.data.poll && r.data.poll.total === 1, 'total=' + (r.data.poll && r.data.poll.total));
  ok('B16d 两个选项各一票', r.data.poll && r.data.poll.options[0].n === 1 && r.data.poll.options[1].n === 1,
    JSON.stringify(r.data.poll && r.data.poll.options));
  r = await u2('/api/poll/vote', { method: 'POST', body: { poll: mp.id, options: [mp.options[0].id, mp.options[0].id] } });
  ok('B16e 重复选项去重后仍只算一票', r.status === 200 && r.data.poll.options[0].n === 2, JSON.stringify(r.data.poll.options[0]));

  // ---- 锁定 / 保护 ----
  await root_('/api/admin/moderate', { method: 'POST', body: { type: 'lock', id: tid2 } });
  r = await u1('/api/poll/remove', { method: 'POST', body: { target: 'thread', id: tid2 } });
  ok('B17 锁定的主题里不能再动投票(403)', r.status === 403, 'status=' + r.status);

  /* ---- 删除：不留孤儿，恢复要把票也带回来 ----
     单独开一帖投满票再删：B10b 那一帖的投票被站主换过，票数已经归零，用它验不出东西。 */
  r = await u1('/api/threads', { method: 'POST', body: { title: '回收测试帖', body: 'x', poll: POLL } });
  const tid4 = r.data.id;
  r = await u1('/api/threads/' + tid4);
  const before = r.data.thread.poll;
  await u1('/api/poll/vote', { method: 'POST', body: { poll: before.id, options: [before.options[0].id] } });
  await u2('/api/poll/vote', { method: 'POST', body: { poll: before.id, options: [before.options[1].id] } });
  r = await u1('/api/threads/' + tid4);
  const votesBefore = Number(r.data.thread.poll.total || 0);
  ok('B18 投票已经有两票', votesBefore === 2, 'total=' + votesBefore);

  r = await root_('/api/threads/' + tid4, { method: 'DELETE' });
  ok('B18b 删主题(200)', r.status === 200, JSON.stringify(r.data));
  const orphan = db.prepare(`SELECT COUNT(*) n FROM polls WHERE target_type='thread' AND target_id=?`).get(tid4);
  ok('B18c 投票没有变成孤儿（跟着一起走了）', Number(orphan.n) === 0, 'n=' + orphan.n);
  r = await u4('/api/poll/vote', { method: 'POST', body: { poll: before.id, options: [before.options[0].id] } });
  ok('B18d 内容没了之后不能再投(404)', r.status === 404, 'status=' + r.status);

  const trashId = (await root_('/api/trash')).data.items.find(x => x.kind === 'thread' && x.target_id === tid4).id;
  r = await root_('/api/trash/restore', { method: 'POST', body: { id: trashId } });
  ok('B19 恢复主题(200)', r.status === 200, JSON.stringify(r.data));
  r = await u1('/api/threads/' + tid4);
  const after = r.data && r.data.thread && r.data.thread.poll;
  ok('B19b 投票跟着恢复了', !!after && after.id === before.id, JSON.stringify(after));
  ok('B19c 票数也回来了', after && Number(after.total) === votesBefore, 'total=' + (after && after.total) + ' 期望 ' + votesBefore);
  ok('B19d 我投过的那一项还在', after && after.voted === 1 && after.mine[0] === before.options[0].id, JSON.stringify(after && after.mine));
  ok('B19e 别人投的那一项也在', after && after.options[1].n === 1, JSON.stringify(after && after.options));

  // ---- 结构 ----
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_poll_ballots_one'`).get();
  ok('B20 「一人一次」唯一索引存在', !!idx);
  const uv = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_poll_ballots_one'`).get();
  ok('B20c 唯一索引建在 (poll_id,user_id) 上', uv && /poll_id,\s*user_id/.test(uv.sql), uv && uv.sql);
  const cols = db.prepare(`PRAGMA table_info(polls)`).all().map(c => c.name);
  ok('B20b polls 表结构完整', ['id', 'target_type', 'target_id', 'question', 'multi', 'created_at'].every(c => cols.includes(c)), cols.join(','));
}

async function selfHeal() {
  console.log('\n--- 后端：老库自愈（只应用 0001，投票表由 ensurePolls 补）---');
  const worker = (await import(url.pathToFileURL(root + 'src/index.js').href)).default;
  const db = newDb(['0001_init.sql']);
  const env = { DB: new D1(db), ASSETS: { fetch: async () => new Response('nf', { status: 404 }) }, __worker: worker };
  const c = mkCaller(env);
  await c('/api/setup', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });
  await c('/api/login', { method: 'POST', body: { username: 'root', password: 'rootpass12345' } });
  let r = await c('/api/threads', { method: 'POST', body: { title: '老库投票', body: 'x', poll: POLL } });
  ok('C1 老库也能建带投票的帖', r.status === 200, JSON.stringify(r.data));
  r = await c('/api/threads/' + r.data.id);
  ok('C2 老库也能取回投票', !!(r.data.thread && r.data.thread.poll), JSON.stringify(r.data.thread && r.data.thread.poll));
  r = await c('/api/poll/vote', { method: 'POST', body: { poll: r.data.thread.poll.id, options: [r.data.thread.poll.options[0].id] } });
  ok('C3 老库也能投票', r.status === 200, JSON.stringify(r.data));
}

/* ---------------- 前端 ---------------- */
const mkClassList = () => ({
  _s: new Set(),
  add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
  toggle(c, on) { on ? this._s.add(c) : this._s.delete(c) },
  contains(c) { return this._s.has(c) },
});
function makeEnv({ me, thread, threads, voteRes }) {
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
      else if (/\/api\/threads\/\d+\/posts/.test(u)) body = { ok: true };
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
  // 顶层 let 不会挂到 globalThis 上，读写内部状态只能靠再跑一段脚本
  const run = (code) => vm.runInContext(code, sandbox);
  // 正常运行时 me 是 init() 从 /status 里填的；这里直接注入，省得每个用例都先跑一遍 init
  if (me) run('me = ' + JSON.stringify(me));
  return { sandbox, app, get, apiCalls, els, run };
}

async function frontend() {
  console.log('\n--- 前端：渲染与交互 ---');
  const ME = { id: 1, username: '荣荣', sensitive_filter: 1, can_mod: 0, can_admin: 0 };
  const pollVoted = { id: 5, question: '今晚吃什么？', multi: 0, total: 3, voted: 1, mine: [31],
    options: [{ id: 31, label: '火锅', n: 2 }, { id: 32, label: '烤肉', n: 1 }] };
  const pollOpen = { id: 6, question: '明天呢？', multi: 0, total: 0, voted: 0, mine: [],
    options: [{ id: 41, label: '面', n: 0 }, { id: 42, label: '饭', n: 0 }] };
  const pollMulti = { id: 7, question: '带哪些？', multi: 1, total: 0, voted: 0, mine: [],
    options: [{ id: 51, label: '相机', n: 0 }, { id: 52, label: '水', n: 0 }] };

  const mkThread = (p) => ({ thread: { id: 9, title: '投票帖', body: '正文', author_id: 1, username: '荣荣', sensitive: 0, protected: 0, locked: 0, likes: 0, liked: 0, reposts: 0, poll: p }, posts: [], att: {} });
  const submit = (env, sel, kind) => {
    const el = env.get(sel);
    const fn = kind === 'on' ? el.onsubmit : (el._l && el._l.submit);
    return fn ? fn({ preventDefault() { } }) : null;
  };

  // ① 未投票：选项可点、不显示票数
  {
    const env = makeEnv({ me: ME, thread: mkThread(pollOpen) });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    ok('F1 详情里渲染出投票卡', /class="pollCard"/.test(h) && /明天呢/.test(h), h.slice(0, 120));
    ok('F2 未投票时选项是按钮', /class="pollOpt"/.test(h));
    ok('F3 未投票时不显示票数（数字不会带着人走）', !/\d+ 票/.test(h), (h.match(/\d+ 票/g) || []).join(','));
    ok('F4 未投票时说明「每个人只有一票」', /只有一票/.test(h));
  }
  // ② 已投票：结果条 + 百分比 + 我投的那项
  {
    const env = makeEnv({ me: ME, thread: mkThread(pollVoted) });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    ok('F5 已投票显示结果条', /class="pollBar"/.test(h));
    ok('F6 百分比算对了（2/3 → 67%）', /width:67%/.test(h), (h.match(/width:\d+%/g) || []).join(','));
    ok('F7 我投的那一项被标出来', /pollRes mine/.test(h) && /pollTick/.test(h));
    ok('F8 已投票不再渲染可点选项', !/class="pollOpt"/.test(h));
    ok('F9 已投票时说明人数', /共 3 人参与/.test(h));
  }
  // ③ 游客：看结果 + 提示登录（游客视角下服务端下发的 voted 恒为 0）
  {
    const env = makeEnv({ me: null, thread: mkThread({ ...pollVoted, voted: 0, mine: [] }) });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    ok('F10 游客看到结果', /class="pollBar"/.test(h));
    ok('F11 游客被提示登录', /登录后才能投票/.test(h));
  }
  // ④ 列表只给摘要
  {
    const env = makeEnv({ me: ME, threads: { items: [{ id: 9, title: '投票帖', body: 'x', username: '荣荣', author_id: 1, updated_at: '2026-09-24 10:00:00', likes: 0, liked: 0, reposts: 0, replies: 0, poll: pollVoted }], total: 1, page: 1, pages: 1, limit: 20 } });
    await env.sandbox.list();
    const h = env.app.innerHTML;
    ok('F12 列表里是投票摘要', /class="pollMini"/.test(h) && /3 人参与/.test(h), h.slice(h.indexOf('pollMini') - 40, h.indexOf('pollMini') + 200));
    ok('F12b 列表里不铺开选项', !/class="pollOpt"/.test(h));
    ok('F12c 投过票的显示「看结果」', /看结果/.test(h));
  }
  // ⑤ 投票真的打到接口，并且只重画这一张卡
  {
    const after = { id: 6, question: '明天呢？', multi: 0, total: 1, voted: 1, mine: [41],
      options: [{ id: 41, label: '面', n: 1 }, { id: 42, label: '饭', n: 0 }] };
    const env = makeEnv({ me: ME, thread: mkThread(pollOpen), voteRes: { ok: true, voted: 1, poll: after } });
    await env.sandbox.openThread(9);
    env.apiCalls.length = 0;
    await env.sandbox.votePoll(6, 41);
    const call = env.apiCalls.find(c => c.url === '/api/poll/vote');
    ok('F13 点选项打到 /api/poll/vote', !!call, JSON.stringify(env.apiCalls.map(c => c.url)));
    ok('F13b 请求体里带上了选项', call && JSON.parse(call.opt.body).options[0] === 41, call && call.opt.body);
    ok('F13c 投票后原地重画这一张卡（不整屏重画）', /pollBar/.test(env.get('#pollCard-6').outerHTML || ''), (env.get('#pollCard-6').outerHTML || '').slice(0, 80));
    ok('F13d 重画后我投的那项被标出来', /pollRes mine/.test(env.get('#pollCard-6').outerHTML || ''));
  }
  // ⑥ 一人一次的提示要传到人嘴里
  {
    const env = makeEnv({ me: ME, thread: mkThread(pollOpen) });
    await env.sandbox.openThread(9);
    const orig = env.sandbox.fetch;
    env.sandbox.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: '你已经投过票了，每人只有一票哦' }) });
    await env.sandbox.votePoll(6, 41);
    env.sandbox.fetch = orig;
    ok('F14 一人一次的提示原样显示', /只有一票|已经投过/.test(env.get('#toast').innerHTML || ''), env.get('#toast').innerHTML);
  }
  // ⑦ 编辑器：增删选项、校验
  {
    const env = makeEnv({ me: ME, thread: mkThread(null) });
    env.sandbox.openPollDialog();
    ok('F15 打开编辑器时给两个空选项', (env.get('#pollOptList').innerHTML.match(/pollOptRow/g) || []).length === 2,
      env.get('#pollOptList').innerHTML);
    ok('F15b 选项计数显示 2 / 10', /2 \/ 10/.test(String(env.get('#pollOptCount').textContent || '')), env.get('#pollOptCount').textContent);
    env.sandbox.addPollOption();
    ok('F16 能加选项', (env.get('#pollOptList').innerHTML.match(/pollOptRow/g) || []).length === 3);
    env.sandbox.removePollOpt(0);
    ok('F16b 能删选项', (env.get('#pollOptList').innerHTML.match(/pollOptRow/g) || []).length === 2);
    env.sandbox.removePollOpt(0); env.sandbox.removePollOpt(0);
    ok('F16c 永远留两个空位（删不空）', (env.get('#pollOptList').innerHTML.match(/pollOptRow/g) || []).length === 2);
    // 选项不足：要有提示，而且**不能**静默保存
    env.get('#pollQuestion').value = '只有问题没选项';
    env.run("curPoll.options=['独苗','']");
    await submit(env, '#pollForm', 'on');
    ok('F17 选项不足时提示且不通过', /至少.*2 个选项/.test(env.get('#toast').innerHTML || ''), env.get('#toast').innerHTML);
    ok('F17b 选项不足时不会留下草稿', !env.run('curPollDraft'));
    // 问题为空同理
    env.get('#pollQuestion').value = '   ';
    env.run("curPoll.options=['好','不好']");
    await submit(env, '#pollForm', 'on');
    ok('F17c 没写问题时提示且不通过', /投票的问题/.test(env.get('#toast').innerHTML || ''), env.get('#toast').innerHTML);
  }
  // ⑧ 草稿条 + 提交带 poll
  {
    const env = makeEnv({ me: ME, thread: mkThread(null) });
    env.sandbox.openPollDialog();
    env.get('#pollQuestion').value = '今晚吃什么？';
    env.sandbox.onPollOpt(0, '火锅'); env.sandbox.onPollOpt(1, '烤肉');
    await submit(env, '#pollForm', 'on');
    ok('F18 保存后草稿条出现在发帖框', /pollChip/.test(env.get('#postPollChip').innerHTML || ''), env.get('#postPollChip').innerHTML);
    ok('F18b 草稿条上有「移除」', /clearPollDraft/.test(env.get('#postPollChip').innerHTML || ''));
    ok('F18c 有草稿时「＋插入投票」按钮收起', env.get('#postPollBtn').classList.contains('hidden'));
    ok('F18d 空白选项被丢掉', JSON.stringify(env.run('curPollDraft.options')) === '["火锅","烤肉"]', JSON.stringify(env.run('curPollDraft.options')));

    env.apiCalls.length = 0;
    env.get('#postTitle').value = '标题'; env.get('#postBody').value = '正文';
    await submit(env, '#postForm', 'on');
    const call = env.apiCalls.find(c => c.url === '/api/threads');
    const body = call ? JSON.parse(call.opt.body) : {};
    ok('F19 发帖时把投票一起提交', !!body.poll && body.poll.options.length === 2, JSON.stringify(body.poll));
    ok('F19b 提交后草稿清空', (env.get('#postPollChip').innerHTML || '') === '');
  }
  // ⑨ 回复框提交也带 poll
  {
    const env = makeEnv({ me: ME, thread: mkThread(null) });
    await env.sandbox.openThread(9);
    env.sandbox.openPollDialog();
    env.get('#pollQuestion').value = '明天呢？';
    env.sandbox.onPollOpt(0, '面'); env.sandbox.onPollOpt(1, '饭');
    await submit(env, '#pollForm', 'on');
    ok('F20 回复框里也显示草稿条', /pollChip/.test(env.get('#replyPollChip').innerHTML || ''));
    env.apiCalls.length = 0;
    await submit(env, '#replyForm', 'add');
    const call = env.apiCalls.find(c => /\/api\/threads\/9\/posts/.test(c.url));
    const body = call ? JSON.parse(call.opt.body) : {};
    ok('F20b 回复时把投票一起提交', !!body.poll && body.poll.question === '明天呢？', JSON.stringify(body.poll));
    ok('F20c 发完回复草稿清空', !env.run('curPollDraft'));
  }
  // ⑩ 敏感内容：投票跟着正文一起被遮住
  {
    const t = mkThread(pollOpen); t.thread.sensitive = 1;
    const env = makeEnv({ me: ME, thread: t });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    const i = h.indexOf('coverWrap');
    const wrap = i < 0 ? '' : h.slice(i, i + 1500);
    ok('F21 不易展示的内容里，投票一起被遮住（限制标记不能形同虚设）', !!i && /pollCard/.test(wrap), wrap.slice(0, 160));
  }
  // ⑪ 多选：可勾选 + 有「投票」按钮
  {
    const env = makeEnv({ me: ME, thread: mkThread(pollMulti) });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    ok('F22 多选时选项是 togglePollPick', /togglePollPick/.test(h));
    ok('F22b 多选时多一颗「投票」按钮', /submitPoll/.test(h));
    ok('F22c 角标写明多选', /多选/.test(h));
    // 勾两项 → 提交时两个选项都送出去
    env.apiCalls.length = 0;
    const btn = { classList: mkClassList(), setAttribute() { } };
    env.sandbox.togglePollPick(7, 51, btn);
    env.sandbox.togglePollPick(7, 52, btn);
    await env.sandbox.submitPoll(7);
    const call = env.apiCalls.find(c => c.url === '/api/poll/vote');
    const picks = call ? JSON.parse(call.opt.body).options : [];
    ok('F22d 勾中的两项一起提交', picks.length === 2 && picks.includes(51) && picks.includes(52), JSON.stringify(picks));
    // 一个都不勾就点「投票」要有提示
    env.apiCalls.length = 0;
    env.run('pollPicks.clear()');
    await env.sandbox.submitPoll(7);
    ok('F22e 一个都没勾时提示而不是发空请求', !env.apiCalls.some(c => c.url === '/api/poll/vote') && /选一个/.test(env.get('#toast').innerHTML || ''), env.get('#toast').innerHTML);
  }
  // ⑫ 游客不该看到「＋ 投票」这类按钮
  {
    const env = makeEnv({ me: null, thread: mkThread(null) });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    ok('F23 游客看不到投票按钮也看不到投票编辑器入口', !/openPollDialog/.test(h));
  }
  // ⑬ 已经挂了投票的内容不再重复给「＋ 投票」
  {
    const env = makeEnv({ me: ME, thread: mkThread(pollOpen) });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    ok('F24 已有投票时给的是「移除投票」而不是「＋ 投票」', /removePoll/.test(h) && !/openPollDialog\('thread/.test(h), h.slice(h.indexOf('postActions'), h.indexOf('postActions') + 200));
  }
  // ⑭ 投票里全是用户写的字：问题和选项都必须转义，一个标签都不许漏进去
  {
    const nasty = { id: 8, question: '<img src=x onerror=alert(1)>今晚吃啥', multi: 0, total: 1, voted: 1, mine: [61],
      options: [{ id: 61, label: '<script>alert(2)</script>火锅', n: 1 }] };
    const env = makeEnv({ me: ME, thread: mkThread(nasty) });
    await env.sandbox.openThread(9);
    const h = env.app.innerHTML;
    // 注意：转义后的文本里仍然会有 "onerror=" 这几个**字**（那是安全的纯文本），
    // 所以判据是「没有真的标签」，不是「搜不到某个词」。
    ok('F25 投票里的用户内容被转义', !/<script>/.test(h) && !/<img src=x/.test(h) && /&lt;script&gt;/.test(h),
      h.slice(h.indexOf('pollCard'), h.indexOf('pollCard') + 320));
  }
}

(async () => {
  await backend();
  await selfHeal();
  await frontend();
  console.log(`\n=== 投票校验: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
