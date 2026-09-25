/* 回收站 / 内容保护 / 胁迫密码 —— 前端校验
 * 沿用 reaction-check 的路子：最小 DOM 桩 + 拦截 fetch，不引入 jsdom。
 * 四块：
 *   ① 回收站 —— 入口、渲染、恢复 / 彻底删除、删除后的「撤销」
 *   ② 内容保护 —— 角标、作者按钮该收起来、站主的保护按钮
 *   ③ 胁迫密码 —— 设置卡（含管理员禁用）、登录命中后的表现、主页横幅、管理端按钮
 *   ④ 接线 —— 请求体里到底带没带对东西
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..') + '/';
const js = fs.readFileSync(root + 'public/app.js', 'utf8');
const mdJs = fs.readFileSync(root + 'public/md.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

const mkClassList = () => ({
  _s: new Set(),
  add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
  toggle(c, on) { on ? this._s.add(c) : this._s.delete(c) },
  contains(c) { return this._s.has(c) },
});
const mkEl = (id) => ({
  id, textContent: '', innerHTML: '', value: '', checked: false,
  classList: mkClassList(), attrs: {}, style: {}, dataset: {}, files: [],
  parentElement: null, offsetWidth: 0, title: '', open: false,
  setAttribute(k, v) { this.attrs[k] = String(v) },
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
  showModal() { this.open = true; this._opened = true }, close() { this.open = false; this._opened = false }, reset() { },
  addEventListener(t, f) { (this._l = this._l || {})[t] = f },
  removeEventListener() { }, focus() { }, scrollIntoView() { },
  matches() { return false }, showPopover() { }, hidePopover() { },
  querySelector() { return null },
});

function makeEnv(opts) {
  const { me, thread, threads, trash, adminUsers, user } = opts;
  const els = new Map();
  const get = (sel) => { if (!els.has(sel)) els.set(sel, mkEl(sel)); return els.get(sel) };
  const app = get('#app');
  const qr = get('#qr'); qr.parentElement = mkEl('#qrWrap');

  const document = {
    documentElement: { _a: {}, setAttribute(k, v) { this._a[k] = v }, getAttribute(k) { return this._a[k] } },
    body: mkEl('body'),
    querySelector: (sel) => get(sel),
    querySelectorAll: () => [],
    createElement: () => mkEl('tmp'),
  };
  const store = new Map();
  const apiCalls = [];
  const sandbox = {
    document,
    navigator: { clipboard: { writeText: async () => { } } },
    confirm: () => true, prompt: () => 'x',
    setTimeout: () => 0, clearTimeout: () => { }, scrollTo: () => { },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
      removeItem: k => { store.delete(k) },
    },
    matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    URLSearchParams, location: { reload() { } }, console, Error,
    XMLHttpRequest: class { constructor() { this.upload = {} } open() { } setRequestHeader() { } send() { } },
    fetch: async (url, opt) => {
      apiCalls.push({ url, opt });
      const sent = opt && opt.body ? JSON.parse(opt.body) : null;
      let body = {};
      if (url.endsWith('/status')) body = { setupNeeded: false, user: me, uploadEnabled: false, maxUploadMb: 0, maxAvatarMb: 0 };
      // 登录：opts.login 决定后端怎么回（正常 / 胁迫密码命中 / 2FA）
      else if (url.endsWith('/api/login')) body = opts.login || { ok: true, user: me };
      else if (url.includes('/api/trash/restore')) body = { ok: true, restored: 1, kind: sent && sent.id === 99 ? 'user' : 'thread' };
      else if (url.includes('/api/admin/trash-purge')) body = { ok: true, purged: 1 };
      else if (url.includes('/api/trash')) body = trash || { items: [], total: 0, page: 1, pages: 1, limit: 20, admin: 0 };
      else if (url.includes('/api/admin/protect')) body = { ok: true, protected: 1 };
      else if (url.includes('/api/admin/duress')) body = { ok: true, duress: 1 };
      else if (url.includes('/api/account/duress')) body = { ok: true, duress_set: sent && sent.duress ? 1 : 0 };
      else if (url.includes('/api/account/profile')) body = { ok: true, user: me };
      else if (url.includes('/boards')) body = { boards: [{ id: 7, name: '闲聊', threads: 2 }], unboarded: 0 };
      else if (/\/api\/users\/\d+/.test(url)) body = user || { user: { id: 2, username: 'pat', role: 'user', bio: '', avatar: '', created_at: '2026-09-20 10:00:00', banned: 0, duress_state: 0 }, stats: { threads: 1, replies: 0, likes: 0 }, threads: [], posts: [] };
      else if (url.includes('/api/admin/users')) body = adminUsers || [];
      else if (url.includes('/api/admin/posts')) body = [];
      else if (/\/api\/threads\/\d+\/posts/.test(url)) body = { ok: true };
      else if (/\/api\/threads\/\d+$/.test(url) && opt && opt.method === 'DELETE') body = { ok: true, trashed: true, trashId: 56, items: 2 };
      else if (/\/api\/threads\/\d+$/.test(url)) body = thread || { thread: {}, posts: [], att: {} };
      else if (/\/api\/threads\?/.test(url)) body = threads || { items: [], total: 0, page: 1, pages: 1, limit: 20 };
      else if (/\/api\/threads$/.test(url)) body = { ok: true, id: 99 };
      else if (/\/api\/posts\/\d+$/.test(url)) body = { ok: true, trashed: true, trashId: 55 };
      else body = { ok: true, user: me };
      return { ok: true, status: 200, json: async () => body };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mdJs, sandbox);
  return { sandbox, app, get, apiCalls };
}
const boot = async (opts) => {
  const env = makeEnv(opts);
  vm.runInContext(js, env.sandbox);
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  return env;
};
const bodyOf = (env, pred) => { const c = env.apiCalls.filter(pred).pop(); return c ? JSON.parse(c.opt.body) : null };

const USER = { id: 9, username: 'ann', role: 'user', totp_enabled: 0, avatar: null, bio: '', can_mod: 0, can_admin: 0, sensitive_filter: 1, duress_set: 0 };
const ADMIN = { ...USER, id: 1, username: 'boss', role: 'admin', can_mod: 1, can_admin: 1 };
const LIST = (over) => ({ items: [Object.assign({ id: 3, title: '一个主题', body: '正文', pinned: 0, locked: 0, author_id: 9, username: 'ann', avatar: null, updated_at: '2026-09-23 10:00:00', replies: 1, sensitive: 0, protected: 0, likes: 0, liked: 0, reposts: 0, quote_ref: null }, over || {})], total: 1, page: 1, pages: 1, limit: 20 });
// 两个参数分开：第一个改 thread 本身，第二个改整个响应（posts / att）。
// 合在一起的话 THREAD({posts:[…]}) 会把 posts 塞进 thread 里面，
// 于是「回复」那条永远渲染不出来 —— 断言会假绿。
const THREAD = (tOver, over) => Object.assign({
  thread: Object.assign({ id: 3, title: '一个主题', body: '正文', author_id: 9, username: 'ann', avatar: null, bio: '', created_at: '2026-09-23 10:00:00', locked: 0, board_id: 7, board_name: '闲聊', sensitive: 0, protected: 0, likes: 0, liked: 0, reposts: 0, quote_ref: null, quote_snapshot: null }, tOver || {}),
  posts: [],
  att: {},
}, over || {});
const POST = (over) => Object.assign({ id: 11, author_id: 9, username: 'ann', body: '我的回复', created_at: '2026-09-23 10:01:00', reply_to: null, role: 'user', sensitive: 0, protected: 0, likes: 0, liked: 0, reposts: 0, quote_ref: null, quote_snapshot: null }, over || {});
const TRASH = (items, admin) => ({ items, total: items.length, page: 1, pages: 1, limit: 20, admin: admin ? 1 : 0 });
const TROW = (over) => Object.assign({ id: 1, kind: 'thread', target_id: 3, author_id: 9, author_name: 'ann', title: '我手滑删的帖', excerpt: '正文', item_count: 2, deleted_by_name: 'ann', by_owner: 1, was_protected: 0, deleted_at: '2026-09-23 14:00:00', can_restore: 1, can_purge: 0 }, over || {});

(async () => {
  // ---------- ① 回收站 ----------
  console.log('\n--- 回收站：渲染 ---');
  {
    const env = await boot({ me: USER, trash: TRASH([TROW(), TROW({ id: 2, kind: 'post', title: '', excerpt: 'bob 的回复', author_name: 'bob', by_owner: 0, can_restore: 0 }), TROW({ id: 99, kind: 'user', title: 'ken', excerpt: '2 个主题 · 3 条回复', author_name: 'ken', by_owner: 0, can_restore: 0 })]) });
    ok('T1 登录后菜单里有回收站入口', !env.get('#trashBtn').classList.contains('hidden'));
    // 光"看得见"不算数：曾经按钮在、显隐也对，就是忘了绑 onclick，点了毫无反应。
    // 这里真的点一下。
    await env.get('#trashBtn').onclick();
    ok('T1b 点菜单里的回收站真的能打开', env.get('#trashDialog').open === true && env.apiCalls.some(x => x.url.includes('/api/trash')),
      'open=' + env.get('#trashDialog').open);
    env.get('#trashDialog').close();
    await env.sandbox.openTrash();
    ok('T2 弹窗打开了', env.get('#trashDialog').open === true);
    const h = env.get('#trashList').innerHTML;
    ok('T3 列出了条目', h.includes('我手滑删的帖') && h.includes('bob 的回复'));
    ok('T4 主题/回复/账号三种类型都有角标', h.includes('>主题<') && h.includes('>回复<') && h.includes('>账号<'));
    ok('T5 标出是自己删的还是管理员移除的', h.includes('自己删的') && h.includes('管理员移除'));
    ok('T6 能恢复的给「恢复」按钮', h.includes('onclick="restoreTrash(1)"'));
    ok('T7 不能恢复的写明「需站主恢复」', h.includes('需站主恢复'));
    ok('T8 普通用户看不到「彻底删除」', !h.includes('purgeTrash'));
    ok('T9 普通用户看不到清空按钮', env.get('#trashTools').classList.contains('hidden'));
    ok('T10 主题条目说明连带了几条回复', h.includes('连带 1 条回复'));
    ok('T11 提示文案说的是「自己删的能自己恢复」', env.get('#trashHint').textContent.includes('自己删掉的可以自己恢复'));
  }
  {
    const env = await boot({ me: ADMIN, trash: TRASH([TROW({ can_purge: 1, by_owner: 0 })], true) });
    await env.sandbox.openTrash();
    const h = env.get('#trashList').innerHTML;
    ok('T12 站主看得到「彻底删除」', h.includes('purgeTrash(1)'));
    ok('T13 站主看得到清空按钮', !env.get('#trashTools').classList.contains('hidden'));
    ok('T14 站主的提示文案不同', env.get('#trashHint').textContent.includes('站主'));
  }
  {
    const env = await boot({ me: USER, trash: TRASH([]) });
    await env.sandbox.openTrash();
    ok('T15 空回收站有明确提示', env.get('#trashList').innerHTML.includes('回收站是空的'));
  }

  console.log('\n--- 回收站：交互 ---');
  {
    const env = await boot({ me: USER, trash: TRASH([TROW(), TROW({ id: 2, title: '另一个主题', author_name: 'zzz' })]) });
    await env.sandbox.openTrash();
    await env.sandbox.restoreTrash(1);
    const c = env.apiCalls.filter(x => x.url.includes('/trash/restore')).pop();
    ok('T16 恢复打到 /api/trash/restore', !!c && JSON.parse(c.opt.body).id === 1, JSON.stringify(c && c.opt.body));
    ok('T17 恢复后给提示', env.get('#toast').innerHTML.includes('已恢复'), env.get('#toast').innerHTML);
    // 搜索过滤
    env.get('#trashSearch').value = '另一个';
    env.sandbox.filterTrash();
    ok('T18 搜索能过滤条目', !env.get('#trashList').innerHTML.includes('我手滑删的帖') && env.get('#trashList').innerHTML.includes('另一个主题'));
    env.sandbox.clearTrashSearch();
    ok('T19 清除搜索后恢复全部', env.get('#trashList').innerHTML.includes('我手滑删的帖'));
    // 彻底删除（管理端接口）
    await env.sandbox.purgeTrash(2);
    ok('T20 彻底删除打到 /api/admin/trash-purge', env.apiCalls.some(x => x.url.includes('/admin/trash-purge') && JSON.parse(x.opt.body).id === 2));
    await env.get('#trashPurgeAll').onclick();
    ok('T21 清空回收站带 all:1', env.apiCalls.some(x => x.url.includes('/admin/trash-purge') && JSON.parse(x.opt.body).all === 1));
  }
  {
    // 删除之后的「撤销」：这才是不用跑去回收站翻的那颗后悔药
    const env = await boot({ me: USER, threads: LIST(), thread: THREAD({}, { posts: [POST()] }) });
    await env.sandbox.openThread(3);
    await env.sandbox.delPost(11, 3);
    const t = env.get('#toast');
    ok('T22 删除后的提示带「撤销」按钮', t.innerHTML.includes('toastAct') && t.innerHTML.includes('撤销'), t.innerHTML);
    ok('T23 提示里说明了会进回收站', t.innerHTML.includes('回收站'), t.innerHTML);
    ok('T25 带按钮的提示会开启指针事件（否则点不到）', t.classList.contains('hasAct'));
    // 点那颗按钮（桩里 querySelector 返回 null，所以直接走同一个入口）
    await env.sandbox.restoreTrash(55);
    ok('T24 撤销走的就是恢复接口', env.apiCalls.some(x => x.url.includes('/trash/restore') && JSON.parse(x.opt.body).id === 55));
    ok('T24b 撤销之后提示条收起了动作态', !t.classList.contains('hasAct'));
  }
  {
    const env = await boot({ me: USER, threads: LIST(), thread: THREAD() });
    await env.sandbox.openThread(3);
    await env.sandbox.delThread(3);
    ok('T26 删主题走的是 DELETE', !!env.apiCalls.find(x => x.url === '/api/threads/3' && x.opt.method === 'DELETE'));
    ok('T27 主题删除的提示也带撤销', env.get('#toast').innerHTML.includes('撤销'), env.get('#toast').innerHTML);
  }

  // ---------- ② 内容保护 ----------
  console.log('\n--- 内容保护 ---');
  {
    const env = await boot({ me: USER, thread: THREAD({ protected: 1 }), threads: LIST({ protected: 1 }) });
    const listHtml = env.app.innerHTML;
    ok('P1 列表给受保护的主题打角标', listHtml.includes('shieldTag') && listHtml.includes('已保护'));
    await env.sandbox.openThread(3);
    const h = env.app.innerHTML;
    ok('P2 详情页说明「已由站主保护」', h.includes('shieldNote') && h.includes('原作者不再能修改或删除'));
    ok('P3 作者自己看不到「编辑 / 删除主题」', !h.includes('editThread(3)') && !h.includes('delThread(3)'));
    ok('P4 普通用户看不到保护按钮', !h.includes("toggleProtect('thread'"));
  }
  {
    const env = await boot({ me: ADMIN, thread: THREAD({ protected: 1 }), threads: LIST({ protected: 1 }) });
    await env.sandbox.openThread(3);
    const h = env.app.innerHTML;
    ok('P5 站主在受保护内容上看到「取消保护」', h.includes("toggleProtect('thread',3,3)") && h.includes('取消保护'));
    ok('P6 站主自己仍然能编辑', h.includes('editThread(3)'));
  }
  {
    const env = await boot({ me: ADMIN, thread: THREAD(), threads: LIST() });
    await env.sandbox.openThread(3);
    ok('P7 未保护时站主看到「保护此主题」', env.app.innerHTML.includes('保护此主题'));
  }
  {
    // 受保护的回复：作者那排按钮不渲染；文字上也要标出来
    const env = await boot({ me: USER, threads: LIST(), thread: THREAD({}, { posts: [POST({ protected: 1 })] }) });
    await env.sandbox.openThread(3);
    const h = env.app.innerHTML;
    ok('P8 受保护的回复不给作者编辑/删除', !h.includes('editPost(11,3)') && !h.includes('delPost(11,3)'), h.slice(0, 0));
    ok('P9 但回复本身标着「已保护」', h.includes('shieldTag') && h.includes('我的回复'));
  }
  {
    // 反面对照：没被保护的回复，作者照样能编辑删除（否则 P8 可能是假绿）
    const env = await boot({ me: USER, threads: LIST(), thread: THREAD({}, { posts: [POST()] }) });
    await env.sandbox.openThread(3);
    const h = env.app.innerHTML;
    ok('P9b 未保护的回复照常有编辑/删除', h.includes('editPost(11,3)') && h.includes('delPost(11,3)'));
  }
  {
    const env = await boot({ me: ADMIN });
    await env.sandbox.toggleProtect('thread', 3, 3);
    const c = env.apiCalls.filter(x => x.url.includes('/admin/protect')).pop();
    ok('P10 保护请求体正确', !!c && JSON.parse(c.opt.body).target === 'thread' && JSON.parse(c.opt.body).id === 3, JSON.stringify(c && c.opt.body));
    ok('P11 提示说明了保护的含义', env.get('#toast').innerHTML.includes('不能再修改或删除'));
  }

  // ---------- ③ 胁迫密码 ----------
  console.log('\n--- 胁迫密码：设置卡 ---');
  {
    const env = await boot({ me: USER });
    env.get('#settingsBtn').onclick();
    ok('S1 普通用户看得到设置表单', !env.get('#duressForm').classList.contains('hidden'));
    ok('S2 未设置时文案是「还没有设置」', env.get('#duressState').textContent.includes('还没有设置'));
    ok('S3 未设置时不显示「清除」', env.get('#duressClearBtn').classList.contains('hidden'));
    ok('S4 卡片没有禁用样式', !env.get('#duressCard').classList.contains('is-locked'));
  }
  {
    const env = await boot({ me: { ...USER, duress_set: 1 } });
    env.get('#settingsBtn').onclick();
    ok('S5 已设置时显示状态', env.get('#duressState').textContent.includes('已设置'));
    ok('S6 已设置时出现「清除」', !env.get('#duressClearBtn').classList.contains('hidden'));
  }
  {
    const env = await boot({ me: ADMIN });
    env.get('#settingsBtn').onclick();
    ok('S7 管理员的表单被收起来', env.get('#duressForm').classList.contains('hidden'));
    ok('S8 并说明为什么（不是默默消失）', env.get('#duressState').textContent.includes('管理员不能设置'), env.get('#duressState').textContent);
    ok('S9 卡片挂上禁用样式', env.get('#duressCard').classList.contains('is-locked'));
  }
  {
    const env = await boot({ me: { ...USER, totp_enabled: 1 } });
    env.get('#settingsBtn').onclick();
    ok('S10 开了 2FA 就显示验证码输入框', !env.get('#duressCodeWrap').classList.contains('hidden'));
  }
  {
    const env = await boot({ me: USER });
    env.get('#duressPass').value = 'mypassword';
    env.get('#duressInput').value = 'duress12345';
    await env.get('#duressForm').onsubmit({ preventDefault() { } });
    const b = bodyOf(env, x => x.url.includes('/account/duress'));
    ok('S11 设置请求体带 password 与 duress', !!b && b.password === 'mypassword' && b.duress === 'duress12345', JSON.stringify(b));
    ok('S12 保存后卡片状态跟着变（不用重新拉 /status）', env.get('#duressState').textContent.includes('已设置'), env.get('#duressState').textContent);
    ok('S13 保存成功有提示', env.get('#toast').innerHTML.includes('已保存'), env.get('#toast').innerHTML);
    // 清除：要先填当前密码
    env.get('#duressPass').value = '';
    await env.sandbox.clearDuress();
    ok('S14 没填密码时提示先填', env.get('#toast').innerHTML.includes('当前密码'), env.get('#toast').innerHTML);
    env.get('#duressPass').value = 'mypassword';
    await env.sandbox.clearDuress();
    const b2 = bodyOf(env, x => x.url.includes('/account/duress') && JSON.parse(x.opt.body).duress === '');
    ok('S15 清除发送空 duress', !!b2 && b2.password === 'mypassword', JSON.stringify(b2));
  }

  console.log('\n--- 胁迫密码：登录命中 ---');
  {
    const env = await boot({ me: null, login: { duress: true, username: 'sam' } });
    env.get('#authUser').value = 'sam';
    env.get('#authPass').value = 'duress12345';
    await env.get('#authForm').onsubmit({ preventDefault() { } });
    ok('S16 登录框关掉了', env.get('#authDialog').open === false);
    ok('S17 没有把自己当成登录成功（顶栏仍是游客）', env.get('#me').textContent === '游客');
    ok('S18 弹出保护状态说明', env.get('#duressNotice').open === true);
    ok('S19 密码框被清空（不留明文在输入框里）', env.get('#authPass').value === '');
  }
  {
    // 真密码 + 已处于保护状态：后端回 403，前端只 toast，不该弹说明
    const env = await boot({ me: null, login: { __err: 1 } });
    env.sandbox.fetch = async (url, opt) => {
      if (url.endsWith('/api/login')) return { ok: false, status: 403, json: async () => ({ error: '该账号处于保护状态，需要站主手动恢复后才可登录' }) };
      return { ok: true, status: 200, json: async () => ({ setupNeeded: false, user: null, uploadEnabled: false, boards: [], unboarded: 0, items: [], total: 0, page: 1, pages: 1, limit: 20 }) };
    };
    env.get('#authUser').value = 'sam'; env.get('#authPass').value = 'realpass123';
    await env.get('#authForm').onsubmit({ preventDefault() { } });
    ok('S20 保护状态的账号登录被拒并提示', env.get('#toast').innerHTML.includes('保护状态'), env.get('#toast').innerHTML);
    ok('S21 这种拒绝不弹保护说明框', env.get('#duressNotice').open === false);
  }
  {
    const env = await boot({ me: ADMIN, user: { user: { id: 5, username: 'sam', role: 'user', bio: '', avatar: '', created_at: '2026-09-20 10:00:00', banned: 0, duress_state: 1, duress_at: '2026-09-23 12:00:00' }, stats: { threads: 1, replies: 0, likes: 0 }, threads: [], posts: [] } });
    await env.sandbox.openUser(5);
    const h = env.app.innerHTML;
    ok('S22 主页显示「保护中」', h.includes('保护中'));
    ok('S23 主页横幅说明内容没被删', h.includes('shieldBanner') && h.includes('一条未删'), h.slice(0, 0));
    ok('S24 横幅给出触发时间', h.includes('触发时间'));
  }
  {
    const env = await boot({ me: ADMIN, user: { user: { id: 5, username: 'sam', role: 'user', bio: '', avatar: '', created_at: '2026-09-20 10:00:00', banned: 0, duress_state: 0 }, stats: { threads: 1, replies: 0, likes: 0 }, threads: [], posts: [] } });
    await env.sandbox.openUser(5);
    ok('S25 正常账号没有横幅', !env.app.innerHTML.includes('shieldBanner'));
  }
  {
    const env = await boot({ me: ADMIN, adminUsers: [{ id: 5, username: 'sam', role: 'user', banned: 0, totp_enabled: 0, avatar: '', duress_state: 1, duress_set: 1 }, { id: 6, username: 'pat', role: 'user', banned: 0, totp_enabled: 0, avatar: '', duress_state: 0, duress_set: 0 }] });
    await env.get('#adminBtn').onclick();
    // 首屏那份用户列表是拼在 app.innerHTML 里的（#adminUserList 只有搜索重画时才用）
    const h = env.app.innerHTML;
    ok('S26 管理端标出「保护中」', h.includes('保护中'));
    ok('S27 并标出「有保护密码」', h.includes('有保护密码'), h.slice(0, 0));
    ok('S28 保护中的用户给「解除保护」', h.includes('adminDuress(5,0)'));
    ok('S29 正常的用户给「启动保护」', h.includes('adminDuress(6,1)'));
    await env.sandbox.adminDuress(5, 0);
    const b = bodyOf(env, x => x.url.includes('/admin/duress'));
    ok('S30 解除保护的请求体正确', !!b && b.id === 5 && b.value === 0, JSON.stringify(b));
    ok('S31 管理端有回收站入口', env.app.innerHTML.includes('openTrash()'));
  }

  console.log('\n=== 回收站 / 保护 / 胁迫校验: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})();
