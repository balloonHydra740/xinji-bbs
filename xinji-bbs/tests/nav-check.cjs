/* 导航抽屉的真实交互回归。
 *
 * 为什么单开一个文件：
 *   panel-check 用的是最小 DOM 桩 —— 它能验「点了会挂上 open 类」，
 *   但验不了「真浏览器里点遮罩能不能关掉」「滑入动画有没有真的跑」
 *   「汉堡三条线有没有收成 ×」这些只有真实排版/过渡才成立的事。
 *   snapshot 出的是静态截图，也照不到交互。
 *
 * 做法：复用 snapshot 生成的 fixture（同一份 app.js / style.css + fetch 桩），
 * 走 CDP 在无头 Edge 里真点一遍。Node 22 自带 WebSocket，不需要任何依赖。
 *
 * 用法：node tests/nav-check.cjs      （先跑一次 snapshot.cjs 生成 fixture）
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'app-snapshot.html');

/* fixture 是 snapshot.cjs 生成出来的。如果源文件比它新，先重新生成一次 ——
   否则改了 index.html / app.js 却拿着旧页面来点，会点出一片假绿。
   （这条路径真实踩过：改了 HTML 忘记重跑快照。） */
const SRC = ['public/index.html', 'public/app.js', 'public/style.css', 'public/md.js']
  .map(f => path.join(root, f));
const stale = !fs.existsSync(fixture) ||
  SRC.some(f => fs.existsSync(f) && fs.statSync(f).mtimeMs > fs.statSync(fixture).mtimeMs);
if (stale) {
  console.log('· 源文件比 fixture 新，先重新生成快照…');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'snapshot.cjs'), '--view=list'], { stdio: 'ignore' });
  } catch (e) { /* 生成失败就交给下面的存在性检查报错 */ }
}
if (!fs.existsSync(fixture)) {
  console.log('⚠️  fixture 生成失败，跳过抽屉交互检查');
  process.exit(0);
}

const EDGE = [
  process.env.EDGE_BIN,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(p => fs.existsSync(p));
if (!EDGE) {
  console.log('⚠️  没找到 Edge，跳过抽屉交互检查（可用 EDGE_BIN 指定浏览器路径）');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

function launch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbbs-nav-'));
  return new Promise((resolve, reject) => {
    const proc = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--remote-debugging-port=0', '--user-data-dir=' + tmp, 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = d => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[\w-]+/);
      if (m) { proc.stderr.off('data', onData); resolve({ proc, port: Number(m[1]) }); }
    };
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('启动浏览器超时')), 20000);
  });
}

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej });
  let id = 0;
  const waiters = new Map();
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id) }
  };
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id;
    waiters.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 抽屉滑入/滑出是 .42s，动画中途量位置会量到中间值 —— 一律等满再断言
const SETTLE = 620;

(async () => {
  const { proc, port } = await launch();
  const cdp = await connect(port);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result && r.result.result.value;
  };

  await cdp.send('Page.navigate', { url: 'file:///' + fixture.replace(/\\/g, '/') });
  await sleep(400);
  await evalJs(`new Promise(r=>{let n=0;const t=setInterval(()=>{
    const c=document.querySelector('#threadCount');
    if((c&&c.textContent!=='—')||++n>120){clearInterval(t);r(1)}},25)})`, true);

  // 量一次抽屉的「真实几何 + 计算样式」，所有断言都基于它
  const probe = () => evalJs(`(function(){
    const d=document.querySelector('#navDrawer');
    const m=document.querySelector('#navMask');
    const b=document.querySelector('#navBtn');
    const r=d?d.getBoundingClientRect():null;
    const cs=d?getComputedStyle(d):null;
    const line=document.querySelector('#navBtn .navIco i');
    return JSON.stringify({
      open:!!(d&&d.classList.contains('open')),
      left:r?Math.round(r.left):null, w:r?Math.round(r.width):null,
      vis:cs?cs.visibility:'', maskVis:m?getComputedStyle(m).opacity:'',
      aria:d?d.getAttribute('aria-hidden'):null,
      exp:b?b.getAttribute('aria-expanded'):null,
      scrollLock:document.body.classList.contains('navOpen'),
      bodyTop:document.body.style.top||'',
      lineTf:line?getComputedStyle(line).transform:'',
      items:document.querySelectorAll('#navBody .navItem').length,
      segs:document.querySelectorAll('#navThemeSeg .segBtn').length,
      pick:(document.querySelector('#boardBar .pickChip b')||{}).textContent,
      vw:document.documentElement.clientWidth,
      sw:document.documentElement.scrollWidth
    })})()`).then(JSON.parse);

  console.log('\n--- 抽屉初始态 ---');
  let s = await probe();
  ok('D1 初始是收起的（滑出屏幕 + 被 visibility 藏住）', !s.open && s.left < 0 && s.vis === 'hidden', JSON.stringify(s));
  ok('D2 初始 aria-hidden=true / aria-expanded=false', s.aria === 'true' && s.exp === 'false', s.aria + '/' + s.exp);
  ok('D3 抽屉里有板块条目与深浅三档', s.items >= 3 && s.segs === 3, s.items + ' 条 / ' + s.segs + ' 档');

  console.log('\n--- 点左上角菜单按钮 ---');
  await evalJs(`document.querySelector('#navBtn').click()`);
  await sleep(SETTLE);
  s = await probe();
  ok('D4 抽屉滑到位（left=0，动画真的跑完了）', s.open && s.left === 0, 'left=' + s.left);
  ok('D5 遮罩跟着显示', Number(s.maskVis) > 0.9, s.maskVis);
  ok('D6 aria 同步（图标按钮靠它变形）', s.aria === 'false' && s.exp === 'true', s.aria + '/' + s.exp);
  ok('D7 打开时锁住背景滚动', s.scrollLock === true);
  ok('D8 汉堡三条线收成 ×（line 真的有 transform）', s.lineTf && s.lineTf !== 'none', s.lineTf);
  ok('D9 抽屉完全在屏内，没有把页面撑出横向滚动',
    s.left >= 0 && s.left + s.w <= s.vw && s.sw <= s.vw + 1, `left=${s.left} w=${s.w} sw=${s.sw}/${s.vw}`);

  console.log('\n--- Esc 关闭 ---');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(SETTLE);
  s = await probe();
  ok('D10 按 Esc 收起，且解开滚动锁', !s.open && s.vis === 'hidden' && !s.scrollLock, JSON.stringify(s));
  ok('D11 汉堡变回三条线', s.lineTf === 'none' || !s.lineTf, s.lineTf);

  console.log('\n--- 点遮罩关闭 ---');
  await evalJs(`document.querySelector('#navBtn').click()`);
  await sleep(SETTLE);
  await evalJs(`document.querySelector('#navMask').click()`);
  await sleep(SETTLE);
  s = await probe();
  ok('D12 点遮罩能收起（不用非得点 ×）', !s.open && s.vis === 'hidden', JSON.stringify(s));

  console.log('\n--- 列表行的「板块 ▾」打开同一个抽屉 ---');
  await evalJs(`document.querySelector('#boardBar .pickChip').click()`);
  await sleep(SETTLE);
  s = await probe();
  ok('D13 列表行的按钮打开的也是这个抽屉', s.open && s.left === 0, JSON.stringify(s));

  console.log('\n--- 锁滚动：iOS 不吃 body{overflow:hidden}，要 position:fixed ---');
  // 上一段结束时抽屉还开着，这里必须先关掉 —— 否则再点菜单是「关闭」而不是「打开」
  await evalJs(`closeNav()`);
  await sleep(SETTLE);
  // 滚到页面中段：关掉抽屉后必须还在这里，跳回顶部比「背景跟着滚」更烦
  await evalJs(`window.scrollTo(0, Math.round(document.documentElement.scrollHeight/2))`);
  await sleep(200);
  const before = await evalJs('Math.round(window.scrollY)');
  const scrollable = await evalJs('document.documentElement.scrollHeight > window.innerHeight + 50');
  await evalJs(`document.querySelector('#navBtn').click()`);
  await sleep(SETTLE);
  s = await probe();
  ok('D17 打开时背景被锁住（body 挂 navOpen）', s.scrollLock === true, String(s.scrollLock));
  // 页面不够高时 scrollY 就是 0，top 会是 "0px" —— 所以只要求它被写成了 px 值
  ok('D18 body 被钉住（top 写成了滚动量的负值）', /^-?\d+px$/.test(s.bodyTop), s.bodyTop);
  await evalJs(`document.querySelector('#navMask').click()`);
  await sleep(SETTLE);
  const after = await evalJs('Math.round(window.scrollY)');
  s = await probe();
  ok('D19 关闭后解锁，滚动位置不丢（不会跳回顶部）',
    !s.scrollLock && s.bodyTop === '' && Math.abs(after - before) <= 2,
    `${before} → ${after}` + (scrollable ? '' : '（这页不够高，只验了还原不出错）'));

  console.log('\n--- 选板块：自动收起 + 名字同步 ---');
  const picked = await evalJs(`(function(){
    const b=[].slice.call(document.querySelectorAll('#navBody .navItem')).find(function(x){return x.textContent.indexOf('未分类')>=0});
    if(!b) return 'noitem';
    b.click(); return 'clicked';
  })()`);
  await sleep(SETTLE + 300);
  s = await probe();
  ok('D14 抽屉里点得到「未分类」', picked === 'clicked', picked);
  ok('D15 选完自动收起', !s.open && !s.scrollLock, JSON.stringify(s));
  ok('D16 列表行那颗按钮同步成当前板块名', s.pick === '未分类', s.pick);

  cdp.close();
  proc.kill();
  if (fail) { console.log(`\n❌ 抽屉交互检查：${pass} passed, ${fail} failed`); process.exitCode = 1 }
  else console.log(`\n✅ 抽屉交互全部通过（${pass} 项）`);
})().catch(e => { console.error('抽屉交互检查失败：' + e.message); process.exit(1) });
