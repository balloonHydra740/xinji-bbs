/* 管理面板渲染校验：用最小 DOM 桩跑 app.js 的渲染分支，
 * 确认不同角色（管理员 / 子管理员）看到的按钮组合符合权限设计。
 * 不引入 jsdom，只桩出 app.js 真正用到的那几个 DOM 接口。
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..') + '/';
const js = fs.readFileSync(root + 'public/app.js', 'utf8');
// app.js 依赖 md.js（Markdown 渲染），沙箱里也得先跑一遍，否则 renderBody 会 ReferenceError
const mdJs = fs.readFileSync(root + 'public/md.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

// ---- 极简 DOM 桩 ----
// 上传改用了 XMLHttpRequest（fetch 没有上传进度事件），沙箱里补一个最简实现
class FakeXHR {
  constructor(){ this.upload = {}; this.status = 0; this.responseText = ''; }
  open(m, u){ this.method = m; this.url = u; }
  setRequestHeader(){}
  send(){
    this.status = 200;
    this.responseText = JSON.stringify({ ok: true, id: 42 });
    if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
    if (this.onload) this.onload();
  }
}

// 主题详情：二楼的 reply_to 指向一楼，用来验证楼中楼真的渲染出了引用条。
// 定义在 makeEnv 之前 —— fetch 拦截是在 makeEnv 内部闭包的，放外面它拿不到。
const threadDetail = {
  thread: { id: 3, title: '一个主题', body: '正文', author_id: 1, username: 'kate', avatar: 'emoji:🐱', bio: '一句签名', created_at: '2026-09-21 10:00:00', updated_at: '2026-09-21 10:00:00', locked: 0, board_id: 7, board_name: '闲聊' },
  posts: [
    { id: 11, author_id: 2, username: 'bob', body: '#1 的正文', created_at: '2026-09-21 10:01:00', reply_to: null, role: 'user' },
    { id: 12, author_id: 1, username: 'kate', body: '回复 bob', created_at: '2026-09-21 10:02:00', reply_to: 11, role: 'admin' },
  ],
  att: {},
};

const userProfile = {
  user: { id: 1, username: 'kate', role: 'user', bio: '一句签名', avatar: 'emoji:🐱', created_at: '2026-09-13 04:00:00', banned: 0 },
  stats: { threads: 2, replies: 3 },
  threads: [{ id: 3, title: '一个主题', created_at: '2026-09-21 10:00:00', board_name: '闲聊' }],
  posts: [{ id: 11, body: '一条回复', created_at: '2026-09-21 10:01:00', thread_id: 3, thread_title: '一个主题' }],
  q: '',
};

function makeEnv({ me, users, posts, threads, narrow }) {
  const els = new Map();
  const mk = (id) => ({
    id, textContent: '', innerHTML: '', value: '',
    classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    parentElement: null,
    // aria-* 会被 setAttr 写进来（抽屉的开合状态就是靠它读的）
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    // 锁滚动会把 scrollY 写进 body.style.top
    style: {},
    showModal() { this._opened = true }, close() { this._opened = false }, reset() { },
    addEventListener() { }, removeEventListener() { }, focus() { }, scrollIntoView() { },
    files: [],
  });
  const get = (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); };
  const app = get('app');
  app.parentElement = null;
  // 二维码容器需要有个父节点
  const qr = get('qr');
  const qrWrap = mk('qrWrap'); qr.parentElement = qrWrap;

  // 主题 / 配色会被写进 <html> 的 data-* 属性，桩里得有个 documentElement
  const rootEl = { _a: {}, setAttribute(k, v) { this._a[k] = v }, getAttribute(k) { return this._a[k] } };

  const document = {
    documentElement: rootEl,
    body: mk('body'),
    querySelector: (sel) => get(sel.replace('#', '')),
    querySelectorAll: () => [],
    createElement: () => mk('tmp'),
  };

  // localStorage 桩：草稿、主题、配色都靠它，补上之后这些路径才真的被跑到
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: k => { store.delete(k) },
  };

  const toasts = [];
  const apiCalls = [];
  const sandbox = {
    document,
    window: {},
    navigator: { clipboard: { writeText: async () => { } } },
    confirm: () => true,
    prompt: () => 'x',
    setTimeout: () => 0,
    clearTimeout: () => { },
    scrollTo: () => { },
    localStorage,
    // 窄屏分支（回复框默认折叠）靠它触发。narrow=true 时只让 max-width 的查询命中，
    // prefers-color-scheme 仍然是「不匹配」，主题测试的结果不受影响。
    matchMedia: (q) => ({ media: q, matches: !!narrow && /max-width/.test(q), addEventListener() { }, removeEventListener() { } }),
    // 列表接口现在用 URLSearchParams 拼查询串（浏览器原生有，桩里得补上）
    URLSearchParams,
    location: { reload() { } },
    console,
    XMLHttpRequest: FakeXHR,
    // 拦截网络层：只记调用，返回桩数据
    fetch: async (url, opt) => {
      apiCalls.push({ url, opt });
      let body = {};
      // maxUploadMb/maxAvatarMb 一并给：doUpload 的本地大小拦截读的就是它（L1）
      if (url.endsWith('/status')) body = { setupNeeded: false, user: me, uploadEnabled: true, maxUploadMb: 85, maxAvatarMb: 20 };
      else if (url.includes('/boards')) body = { boards: [{ id: 7, name: '闲聊', threads: 2, creator: 'kate' }, { id: 8, name: '数码', threads: 0 }], unboarded: 1 };
      else if (/\/users\/\d+$/.test(url)) body = userProfile;   // 用户主页
      else if (/\/threads\/\d+\/edits$/.test(url)) body = { edits: [] };
      else if (/\/threads\/\d+$/.test(url)) body = threadDetail;   // 详情页
      else if (url.includes('/threads')) body = threads;
      else if (url.endsWith('/admin/users')) body = users;
      else if (url.endsWith('/admin/posts')) body = posts;
      else if (url.endsWith('/upload')) body = { ok: true, id: 42 };
      // 上传上限：GET 回一个「站主以为生效了」的旧值 85，POST 回夹过之后的 100。
      // 这两个数不一样才验得出「保存后当前标签页有没有同步」（L1-L3）。
      else if (url.includes('/admin/upload-limit')) body = (opt && opt.method === 'POST')
        ? { ok: true, uploadMb: 100, avatarMb: 20, platformMaxMb: 100, clamped: false }
        : { uploadMb: 85, avatarMb: 20, platformMaxMb: 100 };
      else body = { ok: true };
      return { ok: true, status: 200, json: async () => body };
    },
    Error,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mdJs, sandbox);
  return { sandbox, app, get, apiCalls, toasts };
}

// app.js 末尾会立刻调用 init()，它 await 了 fetch。
// 我们先跑一次让 me/状态就位，再手动触发管理面板渲染。
(async () => {
  console.log('\n--- 管理面板角色渲染 ---');

  const adminMe = { id: 1, username: 'admin', role: 'admin', totp_enabled: 0, can_mod: 1, can_admin: 1 };
  const modMe = { id: 5, username: 'dave', role: 'moderator', totp_enabled: 0, can_mod: 1, can_admin: 0 };
  const userMe = { id: 6, username: 'carol', role: 'user', totp_enabled: 0, can_mod: 0, can_admin: 0 };

  const users = [
    { id: 1, username: 'admin', role: 'admin', banned: 0, totp_enabled: 0 },
    { id: 5, username: 'dave', role: 'moderator', banned: 0, totp_enabled: 0 },
    { id: 6, username: 'carol', role: 'user', banned: 0, totp_enabled: 1 },
    { id: 7, username: 'bob', role: 'user', banned: 1, totp_enabled: 0 },
  ];
  const posts = [{ id: 11, username: 'carol', body: '一条回复' }];
  // 主题列表接口返回的是 {items,total,page,pages,limit} 而不是裸数组（分页需要 total）
  // 字段要齐：列表渲染要读 updated_at / username / replies，缺一个就会在 init() 里抛错，
  // 错误页还会把随后渲染的管理中心盖掉（异步竞态），表现为一大片 unrelated 的 FAIL。
  const threads = {
    items: [{ id: 3, title: '一个主题', pinned: 0, locked: 0, board_name: '闲聊', username: 'kate', updated_at: '2026-09-21 10:00:00', replies: 0, body: '正文' }],
    total: 1, page: 1, pages: 1, limit: 20
  };

  // --- 管理员视角 ---
  {
    const { sandbox, app, get, apiCalls } = makeEnv({ me: adminMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.document.querySelector('#adminBtn').onclick();
    const html = app.innerHTML;
    if (process.env.DUMP) console.log('\n' + html.replace(/></g, '>\n<') + '\n');
    ok('A2 管理员能看到"设为子管理员"按钮', html.includes('设为子管理员'));
    ok('A3 管理员能看到"撤销子管理员"按钮', html.includes('撤销子管理员'));
    ok('A4 管理员能看到"删号"按钮', html.includes('删号'));
    ok('A5 管理员能看到"关闭2FA"按钮（仅对已开启者）', html.includes('关闭2FA'));
    ok('A6 管理员能看到"封禁/解封"按钮', html.includes('封禁') || html.includes('解封'));
    ok('A7 管理员能看到内容总表卡片', html.includes('最近内容'));
    ok('A8 管理员能看到主题治理卡片', html.includes('主题管理'));
    ok('A9 遮罩提示管理员拥有全部权限', html.includes('全部权限'), html.slice(0, 0));
    ok('A10 管理员拉取了用户与内容接口', apiCalls.some(c => c.url.endsWith('/admin/users')) && apiCalls.some(c => c.url.endsWith('/admin/posts')));
    // 只统计真正的 <button>，避免把弹窗文案里的同名文字算进来
    const btnCount = (label) => (html.match(new RegExp('<button[^>]*>' + label + '</button>', 'g')) || []).length;
    // 4 个用户：admin(自己，管理员)、dave(moderator)、carol、bob(已封禁)
    //   admin  → 自己，不给任何治理按钮
    //   dave   → 子管理员，可被管理员改密/封禁/删号（后端只挡 admin）
    //   carol  → 普通用户 + 已开 2FA → 多一个「关闭2FA」
    //   bob    → 普通用户 + 已封禁   → 封禁位显示「解封」
    ok('A11 管理员自己那一行的操作区为空', (() => {
      const i = html.indexOf('>admin</b>');
      if (i < 0) return false;
      const seg = html.slice(i, html.indexOf('</div>', i));
      return /<span class="rowActions"><\/span>/.test(seg);
    })(), '');
    // 名单里的名字/头像必须能点进主页 —— 这是这一版专门补上的
    ok('A11b 用户名可点击进入主页', /<b class="linkName" onclick="openUser\(6\)">carol<\/b>/.test(html));
    ok('A11c 头像也可点击进入主页', /<span class="avaLink" onclick="openUser\(6\)">/.test(html));
    ok('A11d 主题标题可点击进入主题', /<span class="linkName" onclick="openThread\(3\)">/.test(html));
    ok('A18 删号按钮只出现在非管理员、非自己的行上', btnCount('删号') === 3, '实际 ' + btnCount('删号') + ' 个');
    ok('A12 封禁/解封按钮只出现在非管理员、非自己的行上', btnCount('封禁') + btnCount('解封') === 3,
      '实际 ' + (btnCount('封禁') + btnCount('解封')) + ' 个');
    ok('A13 改密按钮只出现在非管理员、非自己的行上', btnCount('改密') === 3, '实际 ' + btnCount('改密') + ' 个');
    // carol 开了 2FA 且不是管理员 → 应有且仅有 1 个关闭2FA按钮
    ok('A14 只对已开2FA的非管理员渲染关闭按钮', btnCount('关闭2FA') === 1, '实际 ' + btnCount('关闭2FA') + ' 个');
    // 角色标签用中文，不暴露英文枚举
    ok('A15 角色以中文标签展示', html.includes('子管理员') && html.includes('普通用户'));
    // 已封禁用户在按钮上显示「解封」而不是「封禁」
    ok('A16 已封禁用户的按钮显示为解封', btnCount('解封') === 1, '实际 ' + btnCount('解封') + ' 个');
    // 子管理员那行必须带中文角色标签，管理员才能一眼看出不是普通用户
    ok('A17 子管理员行标注了角色', (() => {
      const i = html.indexOf('>dave</b>');
      if (i < 0) return false;
      const seg = html.slice(i, html.indexOf('</div>', i));
      return /<span class="tag[^"]*">子管理员<\/span>/.test(seg);
    })(), '');
  }

  // --- 子管理员视角 ---
  {
    const { sandbox, app, apiCalls } = makeEnv({ me: modMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.document.querySelector('#adminBtn').onclick();
    const html = app.innerHTML;
    ok('B1 子管理员看到主题治理卡片', html.includes('主题管理'));
    ok('B2 子管理员看到置顶/锁定/删帖', html.includes('置顶') && html.includes('锁定') && html.includes('删帖'));
    ok('B3 子管理员看不到用户列表卡片', !html.includes('设为子管理员'));
    ok('B4 子管理员看不到删号按钮', !html.includes('删号'));
    ok('B5 子管理员看不到关闭2FA按钮', !html.includes('关闭2FA'));
    ok('B6 子管理员看不到封禁按钮', !html.includes('解封') && !html.includes('>封禁<'));
    ok('B7 子管理员看到权限说明', html.includes('子管理员'));
    ok('B8 子管理员不请求管理员专属接口', !apiCalls.some(c => c.url.endsWith('/admin/users')) && !apiCalls.some(c => c.url.endsWith('/admin/posts')), JSON.stringify(apiCalls.map(c => c.url)));
    ok('B9 子管理员可请求主题列表', apiCalls.some(c => c.url.includes('/threads?')));
  }

  // --- 设置弹窗：注销区的角色差异 ---
  // 需求：管理员滑到「注销账号」那一栏时，要**直接看到「管理员不允许注销账户」**，
  // 而不是整块消失（那样用户会以为是页面出问题）。普通用户则保持原文案 + 可提交表单。
  {
    const { sandbox, get } = makeEnv({ me: adminMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.document.querySelector('#settingsBtn').onclick();
    ok('C1 管理员：注销区仍然可见（不是整块隐藏）', !get('delZone').classList.contains('hidden'));
    ok('C2 管理员：注销表单被收起', get('delForm').classList.contains('hidden'));
    ok('C3 管理员：直接显示「管理员不允许注销账户」', get('delNotice').textContent === '管理员不允许注销账户',
      JSON.stringify(get('delNotice').textContent));
  }
  {
    const { sandbox, get } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.document.querySelector('#settingsBtn').onclick();
    ok('C4 普通用户：注销表单可用', !get('delForm').classList.contains('hidden'));
    ok('C5 普通用户：提示的是「会进回收站」而不是「永久删除」',
      get('delNotice').textContent.includes('回收站') && !get('delNotice').textContent.includes('不允许注销'),
      JSON.stringify(get('delNotice').textContent));
  }

  // --- D. 回归：上传函数不能自引用递归 ---
  // 曾经的写法是：顶层 `async function uploadInto(...)`，再用
  // `window.uploadInto = (a,b)=>uploadInto(...)` 去包装。
  // 浏览器里普通脚本的顶层函数声明本身就是 window 的同名属性，
  // 那句赋值等于把标识符换成了包装函数，而包装函数内部又引用 uploadInto
  // —— 自己调自己，点「上传」直接栈溢出。这条断言就是防止再写回去。
  {
    const { sandbox } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

    const fakeInput = { files: [{ name: 'a.png', arrayBuffer: async () => new ArrayBuffer(4) }] };
    const realQS = sandbox.document.querySelector;
    sandbox.document.querySelector = (sel) => (sel === '#probeFile' ? fakeInput : realQS(sel));

    let err = null;
    await new Promise(res => {
      try { Promise.resolve(sandbox.window.uploadInto('#probeFile', '#probeBody')).then(res, e => { err = e; res(); }); }
      catch (e) { err = e; res(); }
    });
    ok('D1 上传函数不会自引用爆栈', !err, err ? err.message : '');
    const ta = realQS('#probeBody');
    ok('D2 上传后把 [img:id] 写进了正文', /\[img:42\]/.test(ta.value || ''), JSON.stringify(ta.value));
  }

  // --- E. 正文渲染：视频必须用 <video>，塞进 <img> 只会得到破图 ---
  {
    const { sandbox } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

    const att = { 1: { mime:'image/jpeg', w:800, h:600 }, 4: { mime:'video/mp4', w:1280, h:720 } };
    const out = sandbox.renderBody('看图 [img:1] 和视频 [img:4]', att);
    ok('E1 图片渲染成 img 并带尺寸（用于提前占位）',
      /<img[^>]+src="\/api\/files\/1"[^>]*width="800"[^>]*height="600"/.test(out), out.slice(0, 120));
    ok('E2 视频渲染成 video 而不是 img', /<video[^>]+src="\/api\/files\/4"/.test(out) && !/<img[^>]+files\/4/.test(out));
    ok('E3 视频带 controls 与 playsinline', /controls/.test(out) && /playsinline/.test(out));
    ok('E4 附件已不存在时给出文字提示而非破图',
      /attMissing/.test(sandbox.renderBody('[img:99]', { 1: { mime:'image/png' } })));
    ok('E5 正文里的脚本仍然被转义',
      !/<script/.test(sandbox.renderBody('<script>alert(1)</script>[img:1]', att)));

    /* 【踩过的坑】[img:n] 之前是靠把正文里的占位符写成 "IMG0" 再替换回来的，
       于是**用户自己写的字**只要长得像占位符就会被吃掉 ——
       帖子里写「IMG0012.jpg」这种相机文件名（很常见）会凭空变成一张附件、
       或者一个「附件不存在」的提示。占位符必须用用户打不出来的哨兵字符。 */
    const literal = sandbox.renderBody('这是文件名 IMG0 和 IMG0012.jpg', att);
    ok('E6 正文里的 IMG0 这种字面文本不会被当成占位符',
      literal.includes('IMG0') && literal.includes('IMG0012') && !/attMissing|<img/.test(literal), literal.slice(0, 160));
    const literal2 = sandbox.renderBody('IMG0 文件 [img:1]', att);
    ok('E6b 同一条正文里既有 IMG0 又有真附件时，两者各自成立',
      /<img[^>]+files\/1/.test(literal2) && /IMG0/.test(literal2), literal2.slice(0, 200));
    // 反过来：正文里真写了一个哨兵字符，也必须只当普通文字（不能骗出一张附件来）
    const forged = sandbox.renderBody('假占位 \u0001IMG0\u0001 到此为止', att);
    ok('E7 伪造的哨兵字符骗不出附件', !/<img/.test(forged) && !/attMissing/.test(forged), forged.slice(0, 160));
  }

  // --- F. 板块栏与图片比例 ---
  {
    const { sandbox, app, get } = makeEnv({ me: adminMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

    const bar = get('boardBar').innerHTML;
    const nav = get('navBody').innerHTML;
    // 板块不再横排：列表区只有「当前板块 + 搜索」两件控件
    ok('F1 列表工具行只留一颗当前板块按钮（不再是一排胶囊）',
      /class="chip pickChip"/.test(bar) && !/class="chips"/.test(bar), bar.slice(0, 120));
    ok('F2 当前板块按钮显示的是「全部」', /<b>全部<\/b>/.test(bar), bar.slice(0, 140));
    ok('F3 抽屉里渲染出全部板块与计数',
      /navItem[^>]*>[\s\S]*?全部/.test(nav) && nav.includes('未分类') && nav.includes('闲聊') &&
      /<span class="navN">2<\/span>/.test(nav), nav.slice(0, 100));
    ok('F4 登录后才出现「新建板块」', nav.includes('新建板块'));
    ok('F5 搜索框仍在列表工具行里', /id="searchInput"/.test(bar));
    ok('F6 板块栏不再隐藏', !get('boardBar').classList.contains('hidden'));

    // 管理员能看到板块管理卡片；子管理员不能
    await sandbox.document.querySelector('#adminBtn').onclick();
    const adminHtml = app.innerHTML;
    ok('F7 管理员看到板块管理卡片', adminHtml.includes('板块管理'));
    ok('F8 管理员看到删除板块按钮', /<button[^>]*>删除板块<\/button>/.test(adminHtml));
    ok('F9 板块卡片显示了板块名与创建者', adminHtml.includes('闲聊') && adminHtml.includes('由 kate 创建'));
  }
  {
    const { sandbox, app } = makeEnv({ me: modMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.document.querySelector('#adminBtn').onclick();
    const modHtml = app.innerHTML;
    ok('F10 子管理员看不到板块管理卡片', !modHtml.includes('板块管理'));
    ok('F11 子管理员看不到删除板块按钮', !/删除板块/.test(modHtml));
  }
  {
    const { sandbox } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

    const att = { 1: { mime:'image/jpeg', w:1080, h:1080 } };   // 正方形：过去会被压扁的那类
    // 列表预览：正文里不再塞大图，改成独立的小缩略图
    const plain = sandbox.renderBody('看图 [img:1] 就是这样', att, true);
    ok('F16 列表预览把 [img:id] 从正文里剥掉', !/\[img:1\]/.test(plain) && !/<img/.test(plain), plain);
    const thumbs = sandbox.previewThumbs('看图 [img:1]', att);
    ok('F17 列表预览改用缩略图容器', /class="thumbs"/.test(thumbs) && /class="thumb"/.test(thumbs), thumbs);
    ok('F18 缩略图不出现在正文里', /class="thumbs"/.test(thumbs) && !/class="att/.test(thumbs));

    // 详情页：正方形必须带上 aspect-ratio，这样任何一边被约束时浏览器都能反推另一边
    const full = sandbox.renderBody('看图 [img:1]', att);
    ok('F19 图片带上 aspect-ratio（正方形不会被压扁）', /aspect-ratio:1080\/1080/.test(full), full.slice(0, 200));
    ok('F20 图片仍带 width/height 用于提前占位', /width="1080"/.test(full) && /height="1080"/.test(full));
  }

  // --- G. Markdown / 头像 / 楼中楼 ---
  console.log('\n--- Markdown 与社区组件 ---');
  {
    const { sandbox } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    const md = sandbox.MD;

    ok('G1 标题', md.toHtml('## 小标题').includes('<h2>小标题</h2>'), md.toHtml('## 小标题'));
    ok('G2 粗体与行内代码', md.toHtml('**粗** 和 `code`').includes('<strong>粗</strong>') && md.toHtml('`a`').includes('<code>a</code>'));
    // 围栏里的星号不能被当成强调
    ok('G3 代码块内容不被强调规则破坏', md.toHtml('```\na*b\n```').includes('a*b'), md.toHtml('```\na*b\n```'));
    ok('G4 引用块', md.toHtml('> 引用一句').includes('<blockquote>'));
    ok('G5 无序与有序列表', md.toHtml('- a\n- b').includes('<ul>') && md.toHtml('1. a').includes('<ol>'));
    ok('G6 表格', md.toHtml('| a | b |\n| --- | --- |\n| 1 | 2 |').includes('<table>'));
    // 安全：伪协议链接降级成纯文字，脚本标签被转义
    ok('G7 javascript: 链接被降级', !/href=/.test(md.toHtml('[点我](javascript:alert(1))')), md.toHtml('[点我](javascript:alert(1))'));
    ok('G8 正文里的脚本被转义', !/<script/i.test(sandbox.renderBody('<script>alert(1)</script>', {})));
    ok('G9 裸链接自动成链', md.toHtml('看 https://a.com').includes('<a href="https://a.com"'));
    ok('G10 plain 模式剥掉标记', md.plain('# 标题 **粗**') === '标题 粗', JSON.stringify(md.plain('# 标题 **粗**')));
    const withImg = sandbox.renderBody('看图 [img:1]', { 1: { mime:'image/png', w:10, h:10 } });
    ok('G11 Markdown 之后附件仍能渲染', /<img class="att/.test(withImg), withImg.slice(0, 120));

    // 头像三种形态
    ok('G12 emoji 头像', /🐱/.test(sandbox.avatarHtml({ avatar:'emoji:🐱' })));
    ok('G13 上传图头像', /\/api\/files\/5/.test(sandbox.avatarHtml({ avatar:'att:5' })));
    ok('G14 没头像时用首字', /avaText/.test(sandbox.avatarHtml({ username:'anna' })) && /A/.test(sandbox.avatarHtml({ username:'anna' })));

    // 楼中楼：树要搭对，且不能因为互相引用而死循环
    const tree = sandbox.buildReplyTree([{ id:1, reply_to:null }, { id:2, reply_to:1 }, { id:3, reply_to:99 }]);
    ok('G15 回复挂到父楼下', tree.length === 2 && tree[0].kids.length === 1, JSON.stringify(tree.map(t => [t.p.id, t.kids.length])));
    ok('G16 指向不存在父楼时退为顶层', tree[1].p.id === 3);
    const cyc = sandbox.buildReplyTree([{ id:1, reply_to:2 }, { id:2, reply_to:1 }]);
    ok('G17 互相引用不会死循环', cyc.length === 2 && cyc.every(n => n.kids.length === 0), JSON.stringify(cyc.map(t => t.p.id)));

    // 草稿：存不了时（隐私模式）不能连打字都崩
    ok('G18 草稿读写不抛异常', (() => { try { sandbox.draftSet('x','y'); sandbox.draftClear('x'); return true } catch(e) { return false } })());
  }

  // --- H. 主题详情页渲染（楼中楼 / 头像 / 编辑按钮）---
  console.log('\n--- 主题详情页渲染 ---');
  {
    const { sandbox, app } = makeEnv({ me: adminMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.openThread(3);
    const html = app.innerHTML;
    ok('H1 详情页渲染成功（不是错误页）', !/加载失败/.test(html), html.slice(0, 120));
    ok('H2 楼中楼渲染出引用条', /class="quoteBar"/.test(html) && /回复 bob/.test(html), html.match(/quoteBar[\s\S]{0,80}/)?.[0] || '');
    // 类名顺序会变（现在是 post anim-in nested），只认「有 nested 这个类」
    ok('H3 子回复带缩进', /class="post[^"]*\bnested\b/.test(html), (html.match(/class="post[^"]*"/) || [])[0] || '');
    ok('H4 头像与签名档都渲染了', /avaEmoji/.test(html) && /一句签名/.test(html));
    ok('H5 作者本人看到编辑按钮', /<button[^>]*>编辑<\/button>/.test(html));
    ok('H6 游客不该看到的引用条里不含未转义内容', !/<script/i.test(html));
    // 楼层号：二楼应显示 #2
    ok('H7 楼层号按顺序编号', /#1 /.test(html) && /#2 /.test(html));
  }
  {
    // 用户主页：点头像/用户名进得来，且能在他自己的内容里搜
    const { sandbox, app, apiCalls } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.openUser(1);
    const html = app.innerHTML;
    ok('H8 主页渲染成功（不是错误页）', !/加载失败/.test(html), html.slice(0, 100));
    ok('H9 显示大头像与签名', /avaBig/.test(html) && /一句签名/.test(html));
    ok('H10 显示发帖 / 回复统计', /2 个主题/.test(html) && /3 条回复/.test(html));
    ok('H11 列出他发过的主题', /一个主题/.test(html) && /闲聊/.test(html));
    ok('H12 列出他跟过的帖', /回复在「/.test(html) && /一条回复/.test(html));
    ok('H13 主页自带搜索框', /id="userSearchInput"/.test(html) && /发过的帖子里搜索/.test(html));
    // 搜索只重画两块列表，输入框本身不能被冲掉
    // 模拟在框里敲了字再触发（词条没变时前端会跳过请求，所以必须先设值）
    sandbox.document.querySelector('#userSearchInput').value = '猫';
    await sandbox.doUserSearch(1);
    ok('H14 搜索走的是带 q 的接口', apiCalls.some(c => /\/users\/1\?q=/.test(c.url)), JSON.stringify(apiCalls.map(c => c.url)));
    ok('H15 搜索不清空页面（输入框还在）', /id="userSearchInput"/.test(app.innerHTML), app.innerHTML.slice(0, 60));
  }

  // --- J. Markdown 工具栏 / 配色方案 / 图层 ---
  console.log('\n--- Markdown 工具栏与配色方案 ---');
  {
    const { sandbox } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

    const bar = sandbox.mdBarHtml('#x', '#f', '#p');
    ok('J1 工具栏按钮齐全（粗体/斜体/删除线/标题/引用/代码/列表/链接/分隔线）',
      ['加粗', '斜体', '删除线', '标题', '引用', '行内代码', '代码块', '链接', '无序列表', '有序列表', '分隔线']
        .every(t => bar.includes(`aria-label="${t}"`)), bar.slice(0, 120));
    // 每个按钮都要阻止默认行为，否则点一下 textarea 就失焦、选区被清空
    const btns = (bar.match(/<button[^>]*>/g) || []);
    ok('J2 每个按钮都阻止了默认行为（保住选区）',
      btns.length > 0 && btns.every(b => b.includes('onmousedown="event.preventDefault()"')), btns.length + ' 个按钮');
    // 上传控件必须是 <label for>（浏览器原生触发），不是 JS 调 .click() 的按钮 ——
    // 部分移动浏览器会判成「非用户手势」而静默失效
    ok('J3 有附件输入时才有上传控件，且是 label for',
      /<label[^>]*class="mdBtn upBtn"[^>]*for="f"[^>]*>＋ 图片\/视频\/音频<\/label>/.test(bar) &&
      !sandbox.mdBarHtml('#x', '', '').includes('图片'));
    // 按钮上必须是中文而不是 B / I / S / </> 这类符号 —— 新手第一眼要看得懂。
    // 先剥掉内部的 <b>/<i>/<code> 再比对文字，否则会被标签干扰；label 也算一份。
    const faces = [...bar.matchAll(/<(?:button|label)[^>]*>([\s\S]*?)<\/(?:button|label)>/g)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());
    ok('J3b 按钮上写的是中文（不是纯符号）',
      ['加粗', '斜体', '删除线', '标题', '引用', '代码', '代码块', '链接', '列表', '编号', '分隔线', '图片', '预览']
        .every(t => faces.some(f => f.includes(t))), JSON.stringify(faces));
    // 悬停提示里补 Markdown 语法，写惯的人也不用猜
    ok('J3c 悬停提示带语法示例', bar.includes('**文字**') && bar.includes('[文字](网址)'));
    ok('J3d 提示里的 > < 被转义（否则属性会被提前截断）', bar.includes('&gt; 引用') && !/title="[^"]*>/.test(bar));

    // 纯函数 mdApply：返回 [要插入的文本, 选区起点, 选区终点]
    // （真正的拼接由 mdAct 完成，这里只测「插什么 + 选哪儿」）
    const [t1, a1, b1] = sandbox.mdApply('你好世界', 2, 4, 'b');
    ok('J4 加粗包住选中文本', t1 === '**世界**', t1);
    ok('J5 加粗后仍选中原文（方便连续加格式）', a1 === 2 && b1 === 4, a1 + ',' + b1);
    const [t2] = sandbox.mdApply('', 0, 0, 'b');
    ok('J6 没选中时插入占位文字', t2 === '**粗体**', t2);
    const [t3] = sandbox.mdApply('标题', 0, 2, 'h');
    ok('J7 标题是行前缀', t3 === '## 标题', t3);
    const [t4] = sandbox.mdApply('a\nb\nc', 0, 5, 'ul');
    ok('J8 多行逐行加前缀', t4 === '- a\n- b\n- c', JSON.stringify(t4));
    const [t5, a5, b5] = sandbox.mdApply('点我', 0, 2, 'link');
    ok('J9 链接生成 [文字](url) 并选中 url 部分', t5 === '[点我](https://)' && a5 === 1 && b5 === 3, t5);

    // 配色方案：id 必须合法（会被写进 data-palette，样式表要认得出）
    const ids = sandbox.PALETTES.map(p => p.id);
    ok('J10 提供 6 套配色方案', ids.length === 6, ids.join(','));
    ok('J11 每套配色都有中文名与三个色标',
      sandbox.PALETTES.every(p => p.name && Array.isArray(p.c) && p.c.length === 3));
    ok('J12 深浅三档齐全', sandbox.THEME_MODES.map(m => m.id).join(',') === 'light,dark,auto');

    // 写进 <html> 的属性：样式表靠它选配色
    ok('J13 默认配色写进了 data-palette', sandbox.document.documentElement.getAttribute('data-palette') === 'violet',
      String(sandbox.document.documentElement.getAttribute('data-palette')));
    ok('J14 默认深浅写进了 data-theme',
      ['light', 'dark'].includes(sandbox.document.documentElement.getAttribute('data-theme')),
      String(sandbox.document.documentElement.getAttribute('data-theme')));
    sandbox.setPalette('mint');
    ok('J15 切配色立即生效并持久化',
      sandbox.document.documentElement.getAttribute('data-palette') === 'mint' && sandbox.localStorage.getItem('bbs_palette') === 'mint',
      String(sandbox.localStorage.getItem('bbs_palette')));
    sandbox.setThemeMode('dark');
    ok('J16 切深浅立即生效并持久化',
      sandbox.document.documentElement.getAttribute('data-theme') === 'dark' && sandbox.localStorage.getItem('bbs_theme') === 'dark');
    sandbox.setThemeMode('light');
    ok('J17 显式浅色不会被系统深色覆盖',
      sandbox.document.documentElement.getAttribute('data-theme') === 'light');
  }

  // --- K. 管理中心结构：每一行都要有操作区，按钮才不会各自为政 ---
  console.log('\n--- 管理中心结构 ---');
  {
    const { sandbox, app } = makeEnv({ me: adminMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.document.querySelector('#adminBtn').onclick();
    const html = app.innerHTML;
    // 4 个用户 + 1 个主题 + 2 个板块 + 1 条内容 = 8 行，每行都该有自己的操作区
    ok('K1 每一行都有独立的操作区', (html.match(/<span class="rowActions">/g) || []).length === 8,
      String((html.match(/<span class="rowActions">/g) || []).length));
    // 用户名不能再用「点整块」的方式进主页，必须是可点的名字本身
    ok('K2 用户行不再把角色写成裸文本', !/<b>admin<\/b> · 管理员/.test(html));
    ok('K3 角色以标签形式呈现', /<span class="tag[^"]*">管理员<\/span>/.test(html));
    ok('K4 已封禁用户有独立标签', /<span class="tag warn">已封禁<\/span>/.test(html));
    ok('K5 管理员自己那行标注了「我自己」', /<span class="tag mute">我自己<\/span>/.test(html));
    ok('K6 版块名可点击回首页筛选', /<span class="linkName" onclick="pickBoard\('7'\)">闲聊<\/span>/.test(html));

    // 用户搜索：本地过滤，只重画列表那一块（重画整页会把输入框和光标一起冲掉）
    ok('K7 用户卡片带搜索框', /id="adminUserSearch"/.test(html) && /id="adminUserList"/.test(html));
    sandbox.document.querySelector('#adminUserSearch').value = 'carol';
    sandbox.filterAdminUsers();
    const hit = sandbox.document.querySelector('#adminUserList').innerHTML;
    ok('K8 按用户名搜索能命中', hit.includes('carol') && !hit.includes('dave') && !hit.includes('<b>admin</b>'),
      (hit.match(/class="linkName"[^>]*>([^<]+)</g) || []).join(','));
    ok('K9 搜索时显示匹配数量',
      sandbox.document.querySelector('#adminUserCount').textContent === '匹配 1 / 4',
      JSON.stringify(sandbox.document.querySelector('#adminUserCount').textContent));
    sandbox.document.querySelector('#adminUserSearch').value = '子管理员';
    sandbox.filterAdminUsers();
    ok('K10 也能按角色搜', sandbox.document.querySelector('#adminUserList').innerHTML.includes('dave'));
    sandbox.document.querySelector('#adminUserSearch').value = '查无此人';
    sandbox.filterAdminUsers();
    ok('K11 搜不到时给出提示',
      /没有匹配的用户/.test(sandbox.document.querySelector('#adminUserList').innerHTML));
    sandbox.clearAdminUserSearch();
    const all = sandbox.document.querySelector('#adminUserList').innerHTML;
    ok('K12 清除后恢复完整名单', ['admin', 'dave', 'carol', 'bob'].every(u => all.includes('>' + u + '</b>')) &&
      sandbox.document.querySelector('#adminUserCount').textContent === '',
      JSON.stringify(sandbox.document.querySelector('#adminUserCount').textContent));
  }

  // --- L. 静态页面的图层与结构 ---
  console.log('\n--- 页面结构 ---');
  {
    const html = fs.readFileSync(root + 'public/index.html', 'utf8');
    // toast 必须挂 popover：<dialog> 打开时整块在 top layer，普通 z-index 打不过它，
    // 于是「弹窗里报错」的提示会被弹窗盖住 —— 这就是「错误提示不在同一个图层」。
    ok('L1 toast 带 popover（保证在弹窗之上）', /<div id="toast"[^>]*popover/.test(html));
    ok('L2 toast 是 manual 模式（不抢焦点、不自动关）', /<div id="toast"[^>]*popover="manual"/.test(html));
    ok('L3 头部改为用户下拉菜单', /id="userMenu"/.test(html) && /id="userBtn"/.test(html));
    ok('L4 管理/设置/退出都收在菜单里且保留原 id',
      ['adminBtn', 'settingsBtn', 'logoutBtn', 'profileBtn'].every(id => html.includes(`id="${id}"`)));
    ok('L5 设置面板有外观分区', /id="palettePicker"/.test(html) && /id="themeSeg"/.test(html));
    ok('L6 发帖与编辑都带 Markdown 工具栏', /data-ta="#postBody"/.test(html) && /data-ta="#editBody"/.test(html));
    // 头像是「上传图片 / 清除」两颗同尺寸按钮，不再解释存到哪个目录
    ok('L7 头像说明文字已删除', !/avatars\//.test(html) && !/当前头像显示在这里/.test(html));
    ok('L8 头像两颗按钮成对且靠 btnPair 统尺寸', /class="btnPair"[\s\S]{0,300}id="avaClearWrap"/.test(html));
    // 弹窗正文统一容器：以前靠 dialog>div:not(.dialogHead) 猜，容易误伤
    const dlgBodies = (html.match(/class="dlgBody/g) || []).length;
    const dialogs = (html.match(/<dialog /g) || []).length;
    ok('L9 每个弹窗都有 .dlgBody 正文容器', dlgBodies === dialogs, dlgBodies + ' / ' + dialogs);
    // 导航抽屉：常驻 DOM（靠类切换才能做进出场动画），关闭态必须 aria-hidden，
    // 否则键盘 Tab 会走到滑出屏幕的那些按钮上
    ok('L10 抽屉常驻 DOM 且默认 aria-hidden', /<aside id="navDrawer"[^>]*aria-hidden="true"/.test(html) && /<aside id="navDrawer"[^>]*role="dialog"/.test(html));
    ok('L11 左上角有菜单按钮（打开抽屉的固定入口）', /id="navBtn"[^>]*aria-haspopup="dialog"/.test(html));
    ok('L12 顶栏不再留深浅「盲翻」按钮（已换成抽屉里的三档）', !/id="themeBtn"/.test(html));
  }

  // --- N. 导航抽屉（左上角菜单）---
  // 板块从「一排横着的胶囊」收进抽屉之后，要看的是：抽屉能不能正常开合、
  // 里面板块与外观齐不齐、选中态跟不跟着 curBoard 走、选完是否自动收起。
  console.log('\n--- 导航抽屉 ---');
  {
    const { sandbox, get, apiCalls } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

    const drawer = get('navDrawer'), mask = get('navMask'), btn = get('navBtn');
    ok('N1 抽屉默认关闭（不用 display:none，否则没法做动画）',
      !drawer.classList.contains('open') && !mask.classList.contains('open'));
    sandbox.openNav(); sandbox.closeNav();
    ok('N2 关闭后标 aria-hidden（滑出屏幕的按钮不该被 Tab 到）',
      drawer.attrs['aria-hidden'] === 'true', drawer.attrs['aria-hidden']);

    sandbox.toggleNav();
    ok('N3 打开后抽屉与遮罩一起挂上 open',
      drawer.classList.contains('open') && mask.classList.contains('open'));
    ok('N4 菜单按钮同步 aria-expanded（汉堡线条靠它收成 ×）',
      btn.attrs['aria-expanded'] === 'true', btn.attrs['aria-expanded']);
    ok('N5 抽屉里带深浅三档', /id="navThemeSeg"/.test(get('navBody').innerHTML));

    sandbox.toggleNav();
    ok('N6 再点一次收起，aria-expanded 归位',
      !drawer.classList.contains('open') && btn.attrs['aria-expanded'] === 'false');

    // 抽屉里点板块：必须自动收起（否则要连点两次才看得到内容），并带 board 参数重拉列表
    sandbox.openNav();
    apiCalls.length = 0;
    await sandbox.pickBoard('8');
    ok('N7 选完板块抽屉自动收起', !drawer.classList.contains('open'));
    ok('N8 带着新板块重新拉列表',
      apiCalls.some(c => /\/threads\?.*board=8/.test(c.url)), JSON.stringify(apiCalls.map(c => c.url)));

    sandbox.openNav();
    ok('N9 选中态跟着 curBoard 走（on + aria-current 落在数码上）',
      /class="navItem on"[^>]*aria-current="true"[^>]*>[\s\S]*?<span class="navName">数码<\/span>/.test(get('navBody').innerHTML),
      get('navBody').innerHTML.slice(0, 320));
    ok('N10 列表工具行的板块名同步成当前板块', /<b>数码<\/b>/.test(get('boardBar').innerHTML));

    sandbox.openBoardDialog();
    ok('N11 新建板块先收起抽屉（两层浮层不叠着）', !drawer.classList.contains('open'));
    ok('N12 并打开创建板块弹窗', get('boardDialog')._opened === true);

    ok('N13 列表行的板块按钮打开的是同一个抽屉',
      /class="chip pickChip" onclick="toggleNav\(event\)"/.test(get('boardBar').innerHTML));

    // 锁滚动：iOS Safari 不吃 body{overflow:hidden}，必须靠 position:fixed + 记滚动位置。
    // 注意取的是 document.body —— get('body') 是另一个同 id 的桩，跟它不是同一个对象。
    const body = sandbox.document.body;
    sandbox.openNav();
    ok('N16 打开时锁住背景滚动', body.classList.contains('navOpen'));
    // 桩里没有 window.scrollY ⇒ 记下来的是 0，所以只要求它被写成了 px 值
    ok('N17 记下了当前滚动位置（body.top 写成 px）', /^-?\d+px$/.test(body.style.top || ''), body.style.top);
    sandbox.closeNav();
    ok('N18 关闭后解锁并把 top 清空（不还原会跳回顶部）',
      !body.classList.contains('navOpen') && body.style.top === '', JSON.stringify(body.style.top));
  }
  {
    // 游客：能看板块、不能建板块
    const { sandbox, get } = makeEnv({ me: null, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    ok('N14 游客的抽屉里没有「新建板块」', !get('navBody').innerHTML.includes('新建板块'));
    ok('N15 游客也能看到板块列表（先浏览、后登录）',
      get('navBody').innerHTML.includes('未分类') && get('navBody').innerHTML.includes('闲聊'));
  }

  // --- M. 手机端行为（窄屏分支）---
  // 「手机上看太挤」这一类问题的修法，一半在 CSS，一半在渲染时就决定好的
  // （比如回复框默认折叠）。所以这里用 matchMedia 桩把窄屏分支真的跑一遍。
  console.log('\n--- 手机端行为 ---');
  {
    const { sandbox, app } = makeEnv({ me: adminMe, users, posts, threads, narrow: true });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    const dv = () => sandbox.document.documentElement.getAttribute('data-view');
    ok('M1 首屏处于列表视图', dv() === 'list', String(dv()));
    await sandbox.openThread(3);
    ok('M2 进入主题后标记为 thread（手机端据此收起首页装饰）', dv() === 'thread', String(dv()));
    ok('M3 窄屏下回复框默认折叠',
      /<form class="replyBox collapsed" id="replyForm">/.test(app.innerHTML) && /class="replyOpen"/.test(app.innerHTML),
      (app.innerHTML.match(/<form class="replyBox[^>]*>/) || [])[0] || '没找到回复表单');
    ok('M4 折叠时 textarea 仍在 DOM 里（展开即可用）', /id="replyBody"/.test(app.innerHTML));
    ok('M5 折叠状态下折叠条是中文提示',
      /class="replyOpen"[^>]*>写下回复……/.test(app.innerHTML));
    sandbox.startReply(3, 12);
    ok('M6 点某一楼的「回复」会自动展开',
      !sandbox.document.querySelector('#replyForm').classList.contains('collapsed'));
    await sandbox.openUser(1);
    ok('M7 进入用户主页后标记为 user', dv() === 'user', String(dv()));
    await sandbox.document.querySelector('#adminBtn').onclick();
    ok('M8 进入管理中心后标记为 admin', dv() === 'admin', String(dv()));
    await sandbox.list();
    ok('M9 返回列表后标记回 list', dv() === 'list', String(dv()));
  }
  {
    const { sandbox, app } = makeEnv({ me: userMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    await sandbox.openThread(3);
    ok('M10 宽屏下回复框默认展开（不折叠）',
      /<form class="replyBox" id="replyForm">/.test(app.innerHTML),
      (app.innerHTML.match(/<form class="replyBox[^>]*>/) || [])[0] || '');
  }

  // 上传上限改了要立刻生效 —— maxUploadMb 只在 init() 里从 /api/status 读过一次，
  // 若 saveUploadLimit 不回写它，站主把 85 调到 100 后同一个标签页照样按 85 拦人，
  // 表现成「我明明改大了，还是传不上去」，而且刷新一下又好了（极难自查）。
  console.log('\n--- 上传上限同步（L1-L3）---');
  {
    const { sandbox, get } = makeEnv({ me: adminMe, users, posts, threads });
    vm.runInContext(js, sandbox);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    // toast 现在用 innerHTML 渲染（要支持「撤销」按钮），桩里的 textContent 不会跟着更新
    const toastText = () => get('toast').innerHTML;
    const input = get('postFile');
    const big = { name: 'x.flac', size: 90 * 1024 * 1024, type: 'audio/flac' };

    input.files = [big];
    await sandbox.doUpload(input, '#postBody');
    ok('L1 上限 85 MB 时 90 MB 的文件在本地就被拦下',
      /超过 85 MB 的上限/.test(toastText()), toastText());

    await sandbox.openStore();
    ok('L2 面板里读到的就是当前上限', get('limitUpload').value === '85', get('limitUpload').value);

    get('limitUpload').value = '100';
    await sandbox.saveUploadLimit();
    input.files = [big];
    await sandbox.doUpload(input, '#postBody');
    ok('L3 改完上限当前页立即放行，不用刷新',
      !/超过 \d+ MB 的上限/.test(toastText()), toastText());
  }

  console.log('\n=== 管理面板校验: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})();
