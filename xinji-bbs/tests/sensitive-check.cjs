/* 不易展示内容（隐藏限制帖）前端校验
 * 两件事分开验：
 *   ① 渲染 —— 谁该看到遮罩、谁该看到「设为限制」按钮、勾选框有没有真的进请求体
 *   ② 滑动确认 —— 半路松手必须弹回，滑到底才揭示（这是这一版唯一"新交互"，必须测到）
 * 沿用 panel-check 的路子：最小 DOM 桩 + 拦截 fetch，不引入 jsdom。
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..') + '/';
const js = fs.readFileSync(root + 'public/app.js', 'utf8');
const mdJs = fs.readFileSync(root + 'public/md.js', 'utf8');
const html = fs.readFileSync(root + 'public/index.html', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

const mkClassList = () => ({
  _s: new Set(),
  add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
  toggle(c, on) { on ? this._s.add(c) : this._s.delete(c) },
  contains(c) { return this._s.has(c) },
});

function makeEnv({ me, thread, posts, threads, covers = [] }) {
  const els = new Map();
  const mk = (id) => ({
    id, textContent: '', innerHTML: '', value: '', checked: false,
    classList: mkClassList(), attrs: {}, style: {}, dataset: {}, files: [],
    parentElement: null,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    showModal() { this._opened = true }, close() { this._opened = false }, reset() { },
    // 回复框是用 addEventListener('submit') 挂的（它被 innerHTML 重建，只能这样绑），
    // 桩里得把监听器记下来，测试才能手动派发
    addEventListener(t, f) { (this._l = this._l || {})[t] = f },
    removeEventListener() { }, focus() { }, scrollIntoView() { },
    matches() { return false }, showPopover() { }, hidePopover() { },
  });
  const get = (sel) => { if (!els.has(sel)) els.set(sel, mk(sel)); return els.get(sel); };
  const app = get('#app');
  const qr = get('#qr'); qr.parentElement = mk('#qrWrap');

  const document = {
    documentElement: { _a: {}, setAttribute(k, v) { this._a[k] = v }, getAttribute(k) { return this._a[k] } },
    body: mk('body'),
    querySelector: (sel) => get(sel),
    // 只有遮罩那个选择器要返回真东西；其余一律空数组（app.js 都有 :not()/长度守卫）
    querySelectorAll: (sel) => (/\.coverWrap/.test(sel) ? covers.filter(c => !c.classList.contains('isBound')) : []),
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
      else if (url.includes('/boards')) body = { boards: [{ id: 7, name: '闲聊', threads: 2 }], unboarded: 0 };
      else if (/\/threads\/\d+$/.test(url)) body = thread;
      else if (url.includes('/threads')) body = threads;
      else if (url.includes('/admin/users')) body = [];
      else if (url.includes('/admin/posts')) body = posts;
      // 个人资料：把提交上去的偏好回显出来，前端靠它更新本地 me
      else if (url.includes('/account/profile')) {
        const b = JSON.parse((opt && opt.body) || '{}');
        body = { ok: true, user: { ...me, ...(b.sensitiveFilter != null ? { sensitive_filter: b.sensitiveFilter } : {}) } };
      }
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

// 假遮罩：把 initSensitive 真正会碰的那几个节点都桩出来，
// knob 记录监听器，测试里手动派发 pointer 事件还原一次真实拖拽。
function fakeCover(trackW = 300, knobW = 36) {
  const knob = {
    offsetWidth: knobW, style: {}, _l: {},
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f) },
    setPointerCapture() { },
  };
  const track = { clientWidth: trackW };
  const fill = { style: {} };
  const wrap = {
    clientWidth: trackW + 40, classList: mkClassList(),
    querySelector(s) { return s === '.scKnob' ? knob : s === '.scTrack' ? track : s === '.scFill' ? fill : null },
  };
  const fire = (t, x) => (knob._l[t] || []).forEach(f => f({ clientX: x, preventDefault() { }, pointerId: 1 }));
  return { wrap, knob, fill, fire };
}

(async () => {
  // ---------- ① 渲染 ----------
  console.log('\n--- 不易展示内容：渲染 ---');
  const T = (over) => Object.assign({
    thread: { id: 3, title: '一个主题', body: '凶手是管家', author_id: 1, username: 'kate', avatar: null, bio: '', created_at: '2026-09-21 10:00:00', locked: 0, board_id: 7, board_name: '闲聊', sensitive: 1 },
    posts: [{ id: 11, author_id: 2, username: 'bob', body: '我也觉得', created_at: '2026-09-21 10:01:00', reply_to: null, role: 'user', sensitive: 1 }],
    att: {},
  }, over || {});
  const LIST = (over) => ({
    items: [Object.assign({ id: 3, title: '一个主题', body: '凶手是管家', pinned: 0, locked: 0, author_id: 1, username: 'kate', avatar: null, updated_at: '2026-09-21 10:00:00', replies: 0, sensitive: 1 }, over || {})],
    total: 1, page: 1, pages: 1, limit: 20,
  });
  const USER_ON = { id: 9, username: 'ann', role: 'user', totp_enabled: 0, avatar: null, bio: '', can_mod: 0, can_admin: 0, sensitive_filter: 1 };
  const USER_OFF = { ...USER_ON, sensitive_filter: 0 };
  const MOD = { id: 5, username: 'dave', role: 'moderator', totp_enabled: 0, can_mod: 1, can_admin: 0, sensitive_filter: 1 };

  const open = async (opts) => {
    const env = makeEnv(opts);
    vm.runInContext(js, env.sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await env.sandbox.openThread(3);
    return env;
  };

  {
    const { app } = await open({ me: USER_ON, thread: T(), posts: [], threads: LIST() });
    const h = app.innerHTML;
    ok('R1 开了模糊：正文盖了遮罩', h.includes('class="coverWrap"'), h.slice(0, 0));
    ok('R2 遮罩里带滑动条', h.includes('class="scTrack"') && h.includes('class="scKnob"'));
    ok('R3 遮罩说明了原因', h.includes('被标记为不易展示'));
    ok('R4 正文照常渲染在遮罩底下（揭示时不用再取数据）', h.includes('凶手是管家'));
    ok('R5 回复也盖了遮罩', (h.match(/class="coverWrap"/g) || []).length === 2, '实际 ' + (h.match(/class="coverWrap"/g) || []).length + ' 层');
    ok('R6 普通用户看不到治理按钮', !h.includes('设为限制'));
  }
  {
    const { app } = await open({ me: USER_OFF, thread: T(), posts: [], threads: LIST() });
    const h = app.innerHTML;
    ok('R7 关掉模糊：不盖遮罩', !h.includes('coverWrap'));
    ok('R8 关掉模糊：正文照常显示', h.includes('凶手是管家'));
  }
  {
    // 游客没有偏好可存，默认按「先盖住」处理 —— 公共场合那次误看没法撤回
    const { app } = await open({ me: null, thread: T(), posts: [], threads: LIST() });
    ok('R9 游客默认也盖住', app.innerHTML.includes('class="coverWrap"'));
  }
  {
    const { app } = await open({ me: MOD, thread: T(), posts: [], threads: LIST() });
    const h = app.innerHTML;
    ok('R10 子管理员看得到「取消限制」', h.includes('>取消限制</button>'), h.slice(0, 0));
    ok('R11 子管理员能改别人的回复', /toggleSensitive\('post',11,3\)/.test(h));
  }
  {
    const { app } = await open({ me: MOD, thread: T({ thread: { id: 3, title: '未标记', body: '正文', author_id: 1, username: 'kate', created_at: '2026-09-21 10:00:00', locked: 0, sensitive: 0 } }), posts: [], threads: LIST() });
    ok('R12 未标记的帖子上按钮是「设为限制」', app.innerHTML.includes('>设为限制</button>'));
  }

  // ---------- 列表 ----------
  {
    const env = makeEnv({ me: USER_ON, thread: T(), posts: [], threads: LIST() });
    vm.runInContext(js, env.sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    const h = env.app.innerHTML;
    ok('L1 列表给限制帖打角标', h.includes('tag warn">不易展示'));
    ok('L2 列表预览被模糊', h.includes('blurLock'));
    ok('L3 列表提示要滑动确认', h.includes('滑动确认后可读'));
    await env.sandbox.list();
    const off = makeEnv({ me: USER_OFF, thread: T(), posts: [], threads: LIST() });
    vm.runInContext(js, off.sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    const h2 = off.app.innerHTML;
    ok('L4 关掉模糊后列表不再模糊', !h2.includes('blurLock'));
    ok('L5 但角标仍在（标记是内容属性，不是显示偏好）', h2.includes('tag warn">不易展示'));
  }

  // ---------- 勾选框真的进了请求体 ----------
  console.log('\n--- 不易展示内容：勾选框接线 ---');
  {
    const env = makeEnv({ me: USER_ON, thread: T(), posts: [], threads: LIST() });
    vm.runInContext(js, env.sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    const bodyOf = (pred) => { const c = env.apiCalls.filter(pred).pop(); return c ? JSON.parse(c.opt.body) : null };

    env.get('#postSensitive').checked = true;
    await env.get('#postForm').onsubmit({ preventDefault() { } });
    ok('C1 发帖勾选会写进请求体', bodyOf(c => c.url === '/api/threads')?.sensitive === 1, JSON.stringify(bodyOf(c => c.url === '/api/threads')));

    await env.sandbox.openThread(3);
    env.get('#replySensitive').checked = true;
    await env.get('#replyForm')._l.submit({ preventDefault() { } });
    ok('C2 回复勾选会写进请求体', bodyOf(c => /\/posts$/.test(c.url))?.sensitive === 1, JSON.stringify(bodyOf(c => /\/posts$/.test(c.url))));

    await env.sandbox.editPost(11, 3);
    ok('C3 编辑框回显当前标记', env.get('#editSensitive').checked === true);
    env.get('#editSensitive').checked = false;
    await env.sandbox.submitEdit();
    ok('C4 编辑时撤标记会写进请求体', bodyOf(c => /\/api\/posts\/\d+$/.test(c.url))?.sensitive === 0, JSON.stringify(bodyOf(c => /\/api\/posts\/\d+$/.test(c.url))));

    await env.sandbox.saveSensitiveFilter(false);
    ok('C5 设置里关掉会立刻存', bodyOf(c => c.url === '/api/account/profile')?.sensitiveFilter === 0);
    // 存完要立刻重画：不然用户关了开关还得手动刷新才见效
    ok('C6 关掉后当前列表立刻不再模糊', !env.app.innerHTML.includes('blurLock'), env.app.innerHTML.slice(0, 0));
  }

  // ---------- ② 滑动确认 ----------
  console.log('\n--- 不易展示内容：滑动确认 ---');
  {
    const c1 = fakeCover();
    const env = makeEnv({ me: USER_ON, thread: T(), posts: [], threads: LIST(), covers: [c1.wrap] });
    vm.runInContext(js, env.sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    env.sandbox.initSensitive();
    ok('S1 遮罩被绑定过（打上 isBound）', c1.wrap.classList.contains('isBound'));

    // 半路松手：不揭示，且滑块弹回原位
    c1.fire('pointerdown', 0);
    c1.fire('pointermove', 128);
    c1.fire('pointerup', 128);
    ok('S2 滑一半松手不会揭示', !c1.wrap.classList.contains('revealed'));
    ok('S3 半路松手滑块弹回原位', c1.knob.style.transform === 'translateX(0px)', c1.knob.style.transform);
    ok('S4 弹回时给过渡类（动画不是硬跳）', c1.wrap.classList.contains('scBack'));

    // 滑到底：揭示
    c1.fire('pointerdown', 0);
    c1.fire('pointermove', 256);
    ok('S5 滑到尽头滑块变色提示可松手', c1.wrap.classList.contains('scArmed'), 'x=' + c1.knob.style.transform);
    c1.fire('pointerup', 256);
    ok('S6 滑到底才揭示', c1.wrap.classList.contains('revealed'));
    ok('S7 进度条跟着滑块走', c1.fill.style.width === '292px', c1.fill.style.width);
  }
  {
    // 行程按轨道宽度算：轨道比遮罩窄，滑过头也不会跑出轨道
    const c2 = fakeCover(200, 36);
    const env = makeEnv({ me: USER_ON, thread: T(), posts: [], threads: LIST(), covers: [c2.wrap] });
    vm.runInContext(js, env.sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    env.sandbox.initSensitive();
    c2.fire('pointerdown', 0);
    c2.fire('pointermove', 900);                      // 远超轨道宽度
    ok('S8 滑过头也不会超出轨道', c2.knob.style.transform === 'translateX(156px)', c2.knob.style.transform);
    c2.fire('pointerup', 900);
    ok('S9 超出部分按到底处理', c2.wrap.classList.contains('revealed'));
  }
  {
    // 键盘 / 读屏：聚焦滑块后按回车直接揭示
    const c3 = fakeCover();
    const env = makeEnv({ me: USER_ON, thread: T(), posts: [], threads: LIST(), covers: [c3.wrap] });
    vm.runInContext(js, env.sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    env.sandbox.initSensitive();
    (c3.knob._l['keydown'] || []).forEach(f => f({ key: 'Enter', preventDefault() { } }));
    ok('S10 键盘按回车也能揭示（读屏可用）', c3.wrap.classList.contains('revealed'));
    ok('S11 没滑就按回车：不经过拖拽流程也能揭示', (c3.knob._l['pointermove'] || []).length > 0);
  }

  // ---------- HTML 里那几个开关确实存在 ----------
  console.log('\n--- 不易展示内容：DOM 入口 ---');
  ok('H1 发帖框有勾选框', /id="postSensitive"/.test(html));
  ok('H2 编辑框有勾选框', /id="editSensitive"/.test(html));
  ok('H3 设置里有内容限制开关', /id="sensitiveFilter"/.test(html) && html.includes('内容限制'));
  ok('H4 开关改完即存（没有多余的保存步骤）', /id="sensitiveFilter"[^>]*onchange="saveSensitiveFilter/.test(html));

  console.log('\n=== 不易展示内容校验: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})();
