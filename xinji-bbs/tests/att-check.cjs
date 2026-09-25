/* 附件（图片/音视频）的渲染与加载失败处理 —— 前端校验
 *
 * 关注的不是「能显示」，而是**显示不出来的时候会发生什么**：
 *   ① 标签与属性对不对（onerror 必须挂上；内联事件只能调到全局函数）
 *   ② 失败后的动作：图片自动重试一次 → 再失败给可点的提示
 *   ③ 音视频不自动重试（文件大），改成插一条可点的提示
 *   ④ 手工点重试要能绕开缓存真的重来
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

// 一个够用的元素桩：属性、data-*、classList、父节点插入/移除
function mkEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), id: '', className: '', textContent: '', innerHTML: '',
    src: '', alt: '', type: '', parentNode: null, dataset: {}, children: [],
    classList: mkClassList(), style: {}, _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'src') this.src = String(v) },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : (this[k] != null ? String(this[k]) : null) },
    addEventListener() { }, removeEventListener() { }, focus() { }, scrollIntoView() { },
    matches() { return false }, showPopover() { }, hidePopover() { }, querySelector() { return null },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c },
    load() { this._loaded = (this._loaded || 0) + 1 },
  };
  return el;
}

function makeEnv() {
  const els = new Map();
  const get = (sel) => { if (!els.has(sel)) els.set(sel, mkEl('div')); return els.get(sel) };
  const document = {
    documentElement: { _a: {}, setAttribute(k, v) { this._a[k] = v }, getAttribute(k) { return this._a[k] } },
    body: mkEl('body'),
    querySelector: get, querySelectorAll: () => [],
    createElement: (t) => mkEl(t || 'div'),
  };
  const calls = [];
  const sandbox = {
    document,
    navigator: { clipboard: { writeText: async () => { } } },
    confirm: () => true, prompt: () => 'x',
    setTimeout: () => 0, clearTimeout: () => { }, scrollTo: () => { },
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    URLSearchParams, location: { reload() { } }, console, Error, Date,
    XMLHttpRequest: class { constructor() { this.upload = {} } open() { } setRequestHeader() { } send() { } },
    fetch: async (url, opt) => {
      calls.push({ url, opt });
      let body = {};
      if (url.endsWith('/status')) body = { setupNeeded: false, user: null, uploadEnabled: false, maxUploadMb: 0, maxAvatarMb: 0 };
      else if (url.includes('/boards')) body = { boards: [], unboarded: 0 };
      else if (url.includes('/api/threads')) body = { items: [], total: 0, page: 1, pages: 1, limit: 20 };
      else body = { ok: true };
      return { ok: true, status: 200, json: async () => body };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mdJs, sandbox);
  vm.runInContext(js, sandbox);
  return { sandbox, get, calls };
}

(async () => {
  const env = makeEnv();

  console.log('\n--- 附件标签 ---');
  {
    const img = env.sandbox.mediaHtml('7', { 7: { mime: 'image/png', w: 1200, h: 800 } }, true);
    ok('A1 图片带原始地址（重试要用它拼）', img.includes('data-src="/api/files/7"'));
    ok('A2 图片带 mime（失败时用来判断是不是 HEIC）', img.includes('data-mime="image/png"'));
    ok('A3 图片挂了 onerror', img.includes('onerror="attFail(this)"'));
    ok('A4 图片点是点重试、不穿透给卡片', /onclick="event\.stopPropagation\(\);attClick\(this\)"/.test(img));
    ok('A5 仍然保留宽高与比例（防塌陷/防压扁）', img.includes('width="1200"') && img.includes('aspect-ratio:1200/800'));
    ok('A6 仍然懒加载', img.includes('loading="lazy"'));

    const vd = env.sandbox.mediaHtml('8', { 8: { mime: 'video/mp4', w: 1280, h: 720 } }, true);
    ok('A7 视频挂 onerror 与 data-src', vd.includes('onerror="attFail(this)"') && vd.includes('data-src="/api/files/8"'));
    ok('A8 视频保留 playsinline（iOS 不全屏）', vd.includes('playsinline'));
    const au = env.sandbox.mediaHtml('9', { 9: { mime: 'audio/mpeg' } }, true);
    ok('A9 音频挂 onerror', au.includes('onerror="attFail(this)"'));

    const gone = env.sandbox.mediaHtml('99', {}, true);
    ok('A10 附件记录不存在时给文字提示而不是破图', gone.includes('已不存在'));
  }

  console.log('\n--- 加载失败：图片 ---');
  {
    // 内联 onerror 只能调到全局函数 —— 必须是函数声明（挂到全局），不能是 const 箭头
    ok('B1 attFail 是全局可调的函数（内联事件要靠它）', typeof env.sandbox.attFail === 'function');
    ok('B2 attRetry / attClick 也挂在全局', typeof env.sandbox.attRetry === 'function' && typeof env.sandbox.attClick === 'function');

    const img = mkEl('img');
    img.dataset.src = '/api/files/7';
    img.dataset.mime = 'image/png';
    img.src = '/api/files/7';
    img.classList.add('loading');

    env.sandbox.attFail(img);
    ok('B3 第一次失败：先自动重试一次（带 r=1 绕缓存）', img.src === '/api/files/7?r=1', img.src);
    ok('B4 自动重试时不显示破图样式', !img.classList.contains('broken'));
    ok('B5 自动重试时也不提示', !img.dataset.fail);

    env.sandbox.attFail(img);          // 第二次还是失败
    ok('B6 再失败才落成破图', img.classList.contains('broken') && img.dataset.fail === '1');
    ok('B7 破图有可读提示（靠 alt 显示）', img.alt.includes('点一下重试'), img.alt);
    ok('B8 重试过之后不再无限自动重试', img.src === '/api/files/7?r=1');
  }
  {
    const img = mkEl('img');
    img.dataset.src = '/api/files/10';
    img.dataset.mime = 'image/heic';
    img.src = '/api/files/10';
    env.sandbox.attFail(img);
    env.sandbox.attFail(img);
    ok('B9 HEIC 失败时提示具体原因（不是笼统的「加载失败」）', img.alt.includes('HEIC'), img.alt);
  }
  {
    const img = mkEl('img');
    img.dataset.src = '/api/files/11';
    img.dataset.mime = 'image/png';
    img.src = '/api/files/11?r=1';
    env.sandbox.attFail(img);
    env.sandbox.attFail(img);
    // 手动点一下：要能重来（带新的时间戳），并且清掉失败态
    env.sandbox.attClick(img);
    ok('C1 点破图会真的重试', /\?r=\d{10,}/.test(img.src), img.src);
    ok('C2 重试时清掉破图样式与失败标记', !img.classList.contains('broken') && img.dataset.fail === '');
    ok('C3 没失败过的图被点到不会乱重载', (() => {
      const g = mkEl('img'); g.src = '/api/files/12'; g.dataset.src = '/api/files/12';
      env.sandbox.attClick(g); return g.src === '/api/files/12';
    })());
  }

  console.log('\n--- 加载失败：音视频 ---');
  {
    const vd = mkEl('video');
    vd.dataset.src = '/api/files/8';
    const wrap = mkEl('div');
    wrap.insertBefore(vd, null);
    env.sandbox.attFail(vd);
    ok('D1 音视频不做自动重试（文件大，重试太贵）', vd.src === '' && vd.dataset.retry === undefined);
    ok('D2 直接落成破图态', vd.classList.contains('broken') && vd.dataset.fail === '1');
    const tip = wrap.children.find(c => c.className === 'attFailTip');
    ok('D3 插了一条可点的提示（破图框对 video 没意义）', !!tip && tip.textContent.includes('重试'), tip && tip.textContent);
    ok('D4 点击提示会重试并移除提示', (() => {
      tip.onclick({ stopPropagation() { } });
      const gone = !wrap.children.includes(tip);
      return gone && /r=\d{10,}/.test(vd.src) && vd._loaded > 0;
    })(), 'src=' + vd.src + ' load=' + vd._loaded);
    // 再失败一次不应该堆第二条提示
    env.sandbox.attFail(vd); env.sandbox.attFail(vd);
    ok('D5 不会重复插入多条提示', wrap.children.filter(c => c.className === 'attFailTip').length <= 1,
      String(wrap.children.filter(c => c.className === 'attFailTip').length));
  }

  console.log('\n=== 附件校验: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})();
