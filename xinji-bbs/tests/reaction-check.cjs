/* 点赞 / 转帖 / 引用 —— 前端校验
 * 沿用 sensitive-check 的路子：最小 DOM 桩 + 拦截 fetch，不引入 jsdom。
 * 三件事分开验：
 *   ① 渲染 —— 赞 / 转帖按钮与计数、已赞状态、引用卡、转帖角标、游客该看到什么
 *   ② 交互 —— 点赞真的打到 /api/like、转帖与回复的请求体里带上了 quote
 *   ③ 限制内容 —— 引用卡遇到「不易展示」的原内容必须连标题带摘要一起收掉
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

function makeEnv({ me, thread, posts, threads, likeRes }) {
  const els = new Map();
  const mk = (id) => ({
    id, textContent: '', innerHTML: '', value: '', checked: false,
    classList: mkClassList(), attrs: {}, style: {}, dataset: {}, files: [],
    parentElement: null, offsetWidth: 0, title: '',
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
  const qr = get('#qr'); qr.parentElement = mk('#qrWrap');

  const document = {
    documentElement: { _a: {}, setAttribute(k, v) { this._a[k] = v }, getAttribute(k) { return this._a[k] } },
    body: mk('body'),
    querySelector: (sel) => get(sel),
    querySelectorAll: () => [],
    createElement: () => mk('tmp'),
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
      let body = {};
      if (url.endsWith('/status')) body = { setupNeeded: false, user: me, uploadEnabled: false, maxUploadMb: 0, maxAvatarMb: 0 };
      else if (url.includes('/api/like')) body = likeRes || { ok: true, liked: 1, count: 7 };
      else if (url.includes('/boards')) body = { boards: [{ id: 7, name: '闲聊', threads: 2 }], unboarded: 0 };
      else if (/\/api\/threads\/\d+\/posts/.test(url)) body = { ok: true };
      else if (/\/api\/threads\/\d+$/.test(url)) body = thread;
      else if (/\/api\/threads\?/.test(url)) body = threads;
      else if (/\/api\/threads$/.test(url)) body = { ok: true, id: 99 };
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

// 假按钮：toggleLike 真正会碰的那几个成员
function mkBtn(liked) {
  const n = { textContent: '3', classList: mkClassList(), _s: new Set() };
  return {
    dataset: {}, title: '', offsetWidth: 0, classList: mkClassList(liked ? ['on'] : []),
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    querySelector: (s) => (s === '.actN' ? n : null),
    _n: n,
  };
}

const THREAD = (over) => Object.assign({
  thread: {
    id: 3, title: '一个主题', body: '正文正文', author_id: 1, username: 'kate', avatar: null, bio: '',
    created_at: '2026-09-23 10:00:00', locked: 0, board_id: 7, board_name: '闲聊', sensitive: 0,
    likes: 5, liked: 1, reposts: 2, quote_ref: null, quote_snapshot: null,
  },
  posts: [{
    id: 11, author_id: 2, username: 'bob', body: '我也觉得', created_at: '2026-09-23 10:01:00',
    reply_to: null, role: 'user', sensitive: 0, likes: 1, liked: 0, reposts: 0,
    quote_ref: null, quote_snapshot: null,
  }],
  att: {},
}, over || {});

const LIST = (over) => ({
  items: [Object.assign({
    id: 3, title: '一个主题', body: '正文', pinned: 0, locked: 0, author_id: 1, username: 'kate',
    avatar: null, updated_at: '2026-09-23 10:00:00', replies: 1, sensitive: 0,
    likes: 5, liked: 1, reposts: 2, quote_ref: null,
  }, over || {})],
  total: 1, page: 1, pages: 1, limit: 20,
});

const USER = { id: 9, username: 'ann', role: 'user', totp_enabled: 0, avatar: null, bio: '', can_mod: 0, can_admin: 0, sensitive_filter: 1 };
const MOD = { ...USER, id: 5, username: 'dave', role: 'moderator', can_mod: 1 };

const boot = async (opts) => {
  const env = makeEnv(opts);
  vm.runInContext(js, env.sandbox);
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  return env;
};
const bodyOf = (env, pred) => { const c = env.apiCalls.filter(pred).pop(); return c ? JSON.parse(c.opt.body) : null };

(async () => {
  // ---------- ① 渲染 ----------
  console.log('\n--- 点赞 / 转帖：渲染 ---');
  {
    const env = await boot({ me: USER, thread: THREAD(), posts: [], threads: LIST() });
    const h = env.app.innerHTML;
    ok('L1 列表项有赞按钮', /class="act act-like/.test(h) && /toggleLike\('thread',3/.test(h));
    ok('L2 列表项有转帖按钮', /class="act act-repost/.test(h) && /openRepost\('thread',3/.test(h));
    ok('L3 赞按钮带计数', /<span class="actN">5<\/span>/.test(h), h.slice(0, 0));
    ok('L4 已赞是高亮态', /act act-like on/.test(h) && /aria-pressed="true"/.test(h));
    ok('L5 转帖计数也显示', /openRepost\('thread',3[\s\S]*?<span class="actN">2<\/span>/.test(h), h.slice(0, 0));
    ok('L6 列表点赞不会连带打开主题（stopPropagation）', /onclick="event\.stopPropagation\(\);toggleLike/.test(h));
  }
  {
    const env = await boot({ me: USER, thread: THREAD(), posts: [], threads: LIST({ quote_ref: 'thread:1' }) });
    ok('L7 转帖来的主题在列表里带「转帖」角标', env.app.innerHTML.includes('tag mute">转帖'));
  }
  {
    const env = await boot({ me: USER, thread: THREAD(), posts: [], threads: LIST() });
    await env.sandbox.openThread(3);
    const h = env.app.innerHTML;
    ok('T1 详情首帖有互动行', /<div class="reactRow">/.test(h));
    ok('T2 首帖可赞 / 可转 / 可引用', /toggleLike\('thread',3/.test(h) && /openRepost\('thread',3/.test(h) && /startQuote\('thread',3\)/.test(h));
    ok('T3 回复也能赞与引用', /toggleLike\('post',11/.test(h) && /startQuote\('post',11\)/.test(h));
    ok('T4 回复的转帖按钮也在', /openRepost\('post',11/.test(h));
  }
  {
    // 游客：看得到数，但点下去只会提示登录，不该打请求
    // （游客的 liked 由后端一律给 0，所以这里也按 0 喂进去）
    const env = await boot({ me: null, thread: THREAD(), posts: [], threads: LIST({ liked: 0 }) });
    const h = env.app.innerHTML;
    ok('G1 游客也能看到赞与计数', /class="act act-like"/.test(h) && /<span class="actN">5<\/span>/.test(h));
    await env.sandbox.toggleLike('thread', 3, mkBtn(false));
    ok('G2 游客点赞只提示、不发请求', env.get('#toast').innerHTML.includes('登录'), env.get('#toast').innerHTML);
    await env.sandbox.openThread(3);
    ok('G3 游客看不到「引用」按钮', !/startQuote\(/.test(env.app.innerHTML));
    ok('G4 游客看不到回复的互动行', !/class="reactRow"/.test(env.app.innerHTML));
  }

  // ---------- ② 交互接线 ----------
  console.log('\n--- 点赞 / 转帖：接线 ---');
  {
    const env = await boot({ me: USER, thread: THREAD(), posts: [], threads: LIST() });
    const btn = mkBtn(false);
    await env.sandbox.toggleLike('thread', 3, btn);
    const c = env.apiCalls.filter(x => x.url === '/api/like').pop();
    ok('A1 点赞打到 /api/like', !!c && JSON.parse(c.opt.body).target === 'thread' && JSON.parse(c.opt.body).id === 3, JSON.stringify(c && c.opt.body));
    ok('A2 数字换成服务端返回的那个', btn._n.textContent === 7, String(btn._n.textContent));
    ok('A3 按钮切到已赞态', btn.classList.contains('on') && btn.attrs['aria-pressed'] === 'true');
    ok('A4 赞的那一瞬间有反馈动画', btn.classList.contains('burst') && btn._n.classList.contains('up'));
  }
  {
    // 连点两下：第二下在请求回来之前就被挡掉，不会把计数点乱
    const env = await boot({ me: USER, thread: THREAD(), posts: [], threads: LIST() });
    const btn = mkBtn(false);
    btn.dataset.busy = '1';
    await env.sandbox.toggleLike('thread', 3, btn);
    ok('A5 请求没回来时不接受第二次点击', env.apiCalls.filter(x => x.url === '/api/like').length === 0);
  }
  {
    const env = await boot({ me: USER, thread: THREAD(), posts: [], threads: LIST() });
    await env.sandbox.openRepost('thread', 3);
    ok('R1 转帖弹窗打开了', env.get('#repostDialog')._opened === true);
    ok('R2 弹窗里有原帖预览', env.get('#repostPreview').innerHTML.includes('quoteCard'));
    ok('R3 预览里带原作者', env.get('#repostPreview').innerHTML.includes('kate'));
    ok('R4 标题留空的提示说清了默认值', env.get('#repostHint').textContent.includes('直接转'));
    env.get('#repostSensitive').checked = true;
    await env.get('#repostForm').onsubmit({ preventDefault() { } });
    const b = bodyOf(env, c => c.url === '/api/threads');
    ok('R5 转帖请求体带 quote', b && b.quote && b.quote.type === 'thread' && b.quote.id === 3, JSON.stringify(b));
    ok('R6 转帖也能标记不易展示', b && b.sensitive === 1, JSON.stringify(b));
    ok('R7 标题留空时自动补「转帖：原标题」', b && b.title === '转帖：一个主题', JSON.stringify(b && b.title));
  }
  {
    // 原内容本身带限制标记时，转帖弹窗默认跟着勾上 —— 别让剧透从引用卡里漏出去
    const env = await boot({ me: USER, thread: THREAD(), posts: [], threads: LIST({ sensitive: 1 }) });
    await env.sandbox.openRepost('thread', 3);
    ok('R8 转限制帖时默认勾上不易展示', env.get('#repostSensitive').checked === true);
    ok('R9 并把原因写在提示里', env.get('#repostHint').textContent.includes('不易展示'), env.get('#repostHint').textContent);
  }
  {
    const env = await boot({ me: USER, thread: THREAD(), posts: [], threads: LIST() });
    await env.sandbox.openThread(3);
    await env.sandbox.startQuote('post', 11);
    ok('Q1 引用条显示出来了', env.get('#quoteBar').classList.contains('hidden') === false);
    ok('Q2 引用条说明引用的是谁', env.get('#quoteBar').innerHTML.includes('bob'), env.get('#quoteBar').innerHTML);
    await env.sandbox.cancelQuote();
    ok('Q3 可以取消引用', env.get('#quoteBar').classList.contains('hidden') === true);
    await env.sandbox.startQuote('thread', 3);
    await env.get('#replyForm')._l.submit({ preventDefault() { } });
    const b = bodyOf(env, c => /\/posts$/.test(c.url));
    ok('Q4 回复请求体带上了 quote', b && b.quote && b.quote.type === 'thread' && b.quote.id === 3, JSON.stringify(b));
  }

  // ---------- ③ 引用卡与限制内容 ----------
  console.log('\n--- 引用卡 ---');
  const snap = (o) => JSON.stringify(Object.assign({ t: 'thread', id: 1, user: 'kate', title: '原标题', excerpt: '凶手是管家', at: '2026-09-23 09:00:00', sensitive: 0 }, o || {}));
  {
    const env = await boot({
      me: USER, threads: LIST(),
      thread: THREAD({ thread: Object.assign(THREAD().thread, { quote_ref: 'thread:1', quote_snapshot: snap() }) }),
      posts: [],
    });
    await env.sandbox.openThread(3);
    const h = env.app.innerHTML;
    ok('C1 转帖内容渲染出引用卡', h.includes('class="quoteCard"'));
    ok('C2 引用卡带原作者与标题', h.includes('kate') && h.includes('原标题'));
    ok('C3 引用卡带摘要', h.includes('凶手是管家'));
    ok('C4 点引用卡跳回原帖', /class="quoteCard" onclick="openThread\(1\)"/.test(h));
  }
  {
    // 原内容被标记为「不易展示」：摘要连标题一起收掉，引用不能成为绕开限制的后门
    const env = await boot({
      me: USER, threads: LIST(),
      thread: THREAD({ thread: Object.assign(THREAD().thread, { quote_ref: 'thread:1', quote_snapshot: snap({ sensitive: 1 }) }) }),
      posts: [],
    });
    await env.sandbox.openThread(3);
    const h = env.app.innerHTML;
    ok('C5 限制内容的引用卡不显示摘要', !h.includes('凶手是管家'), h.slice(0, 0));
    ok('C6 并说明内容已隐藏', h.includes('内容已隐藏'));
    ok('C7 但仍标出原作者', h.includes('kate'));
  }
  {
    const env = await boot({
      me: { ...USER, sensitive_filter: 0 }, threads: LIST(),
      thread: THREAD({ thread: Object.assign(THREAD().thread, { quote_ref: 'thread:1', quote_snapshot: snap({ sensitive: 1 }) }) }),
      posts: [],
    });
    await env.sandbox.openThread(3);
    ok('C8 关掉模糊的人能看到引用内容', env.app.innerHTML.includes('凶手是管家'));
  }
  {
    // 回复里的引用卡：跳的是它所在的主题，不是回复 id（回复没法单独打开）
    const env = await boot({
      me: USER, threads: LIST(),
      thread: THREAD({ posts: [Object.assign(THREAD().posts[0], { quote_ref: 'post:8', quote_snapshot: snap({ t: 'post', id: 8, tid: 42, title: '' }) })] }),
      posts: [],
    });
    await env.sandbox.openThread(3);
    ok('C9 回复的引用卡跳到所在主题', /class="quoteCard" onclick="openThread\(42\)"/.test(env.app.innerHTML), env.app.innerHTML.slice(0, 0));
  }
  {
    // 快照坏了（比如手工改过库）也不能把整页渲染带崩
    const env = await boot({
      me: USER, threads: LIST(),
      thread: THREAD({ thread: Object.assign(THREAD().thread, { quote_ref: 'thread:1', quote_snapshot: '{坏掉的 json' }) }),
      posts: [],
    });
    let crashed = false;
    try { await env.sandbox.openThread(3) } catch (e) { crashed = true }
    ok('C10 快照解析失败也不崩', !crashed && env.app.innerHTML.includes('一个主题'));
  }

  // ---------- ④ 主题打不开时不能白屏 ----------
  {
    const env = makeEnv({ me: USER, thread: THREAD(), posts: [], threads: LIST() });
    env.sandbox.fetch = async (url) => {
      if (/\/api\/threads\/\d+$/.test(url)) return { ok: false, status: 404, json: async () => ({ error: '主题不存在' }) };
      return { ok: true, status: 200, json: async () => ({ items: [], total: 0, page: 1, pages: 1, limit: 20, boards: [] }) };
    };
    vm.runInContext(js, env.sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    let crashed = false;
    try { await env.sandbox.openThread(999) } catch (e) { crashed = true }
    ok('E1 打开不存在的主题会提示而不是白屏', !crashed && env.get('#toast').innerHTML.includes('主题不存在'), env.get('#toast').innerHTML);
  }

  console.log('\n=== 点赞 / 转帖校验: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})();
