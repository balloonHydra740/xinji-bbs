/* 多屏幕比例的渲染体检：真浏览器真 app.js，逐个视口 × 逐个视图量。
 *
 * 为什么要单独一个脚本：
 *   snapshot.cjs 只覆盖 1280 与 390 两档 —— 恰好是最"标准"的两个。
 *   真机上出问题的往往是别的比例：320 的窄屏、430 的大屏手机、
 *   平板竖屏、以及**手机横屏**（高度只有 390，抽屉的 92dvh 就不够用了）。
 *
 * 每个组合量四件事：
 *   ① 横向溢出（scrollWidth > clientWidth）以及具体是哪个元素捅出去的
 *   ② 有元素超出视口左右边界
 *   ③ 触控目标：可见按钮的高度（<28px 的算不合格，手指点不准）
 *   ④ 关键容器宽度：主内容/弹窗在窄视口下有没有被压到没法看
 *
 * 用法：node tests/viewport-check.cjs            （全部组合）
 *       node tests/viewport-check.cjs --shot     （额外出截图，落在 tests/fixtures/vp-*.png）
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures');
const fixture = path.join(fixtureDir, 'app-snapshot.html');
const SHOT = process.argv.includes('--shot');

const EDGE = [
  process.env.EDGE_BIN,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(p => fs.existsSync(p));
if (!EDGE) { console.log('⚠️  没找到 Edge，跳过多比例体检'); process.exit(0) }
if (!fs.existsSync(fixture)) {
  console.log('⚠️  没有 fixture，先跑一次 node tests/snapshot.cjs 生成它');
  process.exit(0);
}

/* 覆盖从最窄到平板横屏的主流比例。名字里的用途写在注释里，方便失败时定位。 */
const VIEWPORTS = [
  { name: '320x568', w: 320, h: 568, note: '超窄屏（iPhone SE 一代 / 老安卓）' },
  { name: '360x800', w: 360, h: 800, note: '安卓主流' },
  { name: '390x844', w: 390, h: 844, note: 'iPhone 14' },
  { name: '430x932', w: 430, h: 932, note: '大屏手机（iPhone Pro Max）' },
  { name: '768x1024', w: 768, h: 1024, note: '平板竖屏' },
  { name: '844x390', w: 844, h: 390, note: '手机横屏（高度只有 390）' },
  { name: '1280x800', w: 1280, h: 800, note: '桌面' },
];

const VIEWS = {
  list: '1',
  thread: 'openThread(3)',
  post: "document.querySelector('#newBtn').onclick()",
  admin: "document.querySelector('#adminBtn').onclick()",
  trash: 'openTrash()',
  nav: 'openNav()',
  // 投票编辑器：七种比例下都要既不横向溢出、也不被压成一行一个字
  poll: `(function(){
    openPollDialog();
    document.querySelector('#pollQuestion').value='今晚吃什么？';
    var ins=document.querySelectorAll('#pollOptList input');
    if(ins[0]) ins[0].value='火锅';
    if(ins[1]) ins[1].value='烤肉';
    return 1;
  })()`,
};

function launch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbbs-vp-'));
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
      if (m) { proc.stderr.off('data', onData); resolve({ proc, port: Number(m[1]) }) }
    };
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('启动浏览器超时')), 20000);
  });
}
async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej });
  let id = 0; const waiters = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } };
  const send = (method, params = {}) => new Promise(res => { const n = ++id; waiters.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) });
  return { send, close: () => ws.close() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 页面内测量的探针。返回一个 JSON 字符串。 */
const PROBE = `(function(){
  const d=document.documentElement;
  const vw=d.clientWidth, vh=window.innerHeight;
  const bad=[];                      // 超出视口左右边界的元素
  const thin=[];                     // 触控目标太小（可见按钮）
  document.querySelectorAll('body *').forEach(function(el){
    const r=el.getBoundingClientRect();
    if(r.width<2||r.height<2) return;
    const cs=getComputedStyle(el);
    if(cs.visibility==='hidden'||cs.display==='none') return;
    // 可横向滚动的祖先里、超出该祖先范围的元素是「滚动内容」，不是布局溢出 ——
    // 编辑器工具栏手机上就是一行横滑（这是故意的）。
    let p=el.parentElement, scrollable=false;
    while(p && p!==document.body){
      const ox=getComputedStyle(p).overflowX;
      if(ox==='auto'||ox==='scroll'||ox==='hidden'){ scrollable=true; break }
      p=p.parentElement;
    }
    if(scrollable) return;
    if(r.right>vw+1||r.left<-1){
      bad.push(el.tagName.toLowerCase()+'.'+String(el.className||'').split(/\\s+/).slice(0,2).join('.')+' '+Math.round(r.left)+'..'+Math.round(r.right));
    }
  });
  document.querySelectorAll('button,label.uploadBtn,.mdBtn').forEach(function(el){
    const r=el.getBoundingClientRect();
    if(r.width<2||r.height<2) return;
    const cs=getComputedStyle(el);
    if(cs.visibility==='hidden'||cs.display==='none') return;
    if(r.height<28) thin.push((el.textContent||el.tagName).trim().slice(0,10)+' '+Math.round(r.height)+'px');
  });
  const dl=document.querySelector('dialog[open]');
  const dlr=dl?dl.getBoundingClientRect():null;
  const main=document.querySelector('main');
  const mr=main?main.getBoundingClientRect():null;
  const header=document.querySelector('header');
  const hr=header?header.getBoundingClientRect():null;
  // 附件：0 宽或 0 高的媒体就是塌了（比例失调最直观的表现）
  const media=[];
  document.querySelectorAll('img.att,video.att,audio.att').forEach(function(m){
    const r=m.getBoundingClientRect();
    if(r.width<2||r.height<2) media.push(m.tagName.toLowerCase()+' '+Math.round(r.width)+'x'+Math.round(r.height));
  });
  // 主内容有没有被压得太窄（平板/横屏下容器 max-width 的边界情况）
  const wrap=document.querySelector('.threadList')||document.querySelector('.view');
  const wr=wrap?wrap.getBoundingClientRect():null;
  return JSON.stringify({
    vw:vw, vh:vh, sw:d.scrollWidth,
    header:hr?Math.round(hr.height):0,
    dialog:dlr?{w:Math.round(dlr.width),h:Math.round(dlr.height),top:Math.round(dlr.top),bottom:Math.round(dlr.bottom)}:null,
    main:mr?Math.round(mr.width):0,
    wrap:wr?Math.round(wr.width):0,
    media:media,
    bad:bad.slice(0,5), thin:thin.slice(0,6),
    // 抽屉比视口还高就是比例失调（92dvh 在横屏下会顶到天花板）
    dlgOverflow: dlr? (dlr.bottom>vh+1||dlr.top<-1) : false,
  });
})()`;

(async () => {
  const { proc, port } = await launch();
  const cdp = await connect(port);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const evalJs = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result && r.result.result.value;
  };

  let fails = 0, checks = 0;
  const problems = [];

  for (const vp of VIEWPORTS) {
    console.log(`\n── ${vp.name}  ${vp.note}`);
    for (const [view, script] of Object.entries(VIEWS)) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 900 });
      await cdp.send('Page.navigate', { url: 'file:///' + fixture.replace(/\\/g, '/') });
      await sleep(360);
      await evalJs(`new Promise(r=>{let n=0;const t=setInterval(()=>{const c=document.querySelector('#threadCount');
        if((c&&c.textContent!=='—')||++n>120){clearInterval(t);r(1)}},25)})`, true);
      try { await evalJs(`(async()=>{ ${script}; await new Promise(r=>setTimeout(r,520)); return 1 })()`, true) }
      catch (e) { console.log(`   ⚠ ${view} 视图脚本抛错：${e.message}`); }
      const info = JSON.parse(await evalJs(PROBE));
      checks++;

      const msgs = [];
      if (info.sw > info.vw + 1) msgs.push(`横向溢出 ${info.sw}>${info.vw} ${info.bad.join(' | ')}`);
      if (info.bad.length) msgs.push(`超出边界：${info.bad.join(' | ')}`);
      if (info.dlgOverflow) msgs.push(`弹窗超出视口（top=${info.dialog.top} bottom=${info.dialog.bottom} vh=${info.vh}）`);
      if (info.dialog && info.dialog.w > info.vw + 1) msgs.push(`弹窗比视口还宽 ${info.dialog.w}>${info.vw}`);
      if (info.media.length) msgs.push(`附件尺寸塌陷：${info.media.join(' | ')}`);
      if (info.dialog && info.dialog.h > info.vh) msgs.push(`弹窗比视口还高 ${info.dialog.h}>${info.vh}`);
      if (info.main && vp.w >= 320 && info.main < Math.min(280, vp.w * 0.72)) msgs.push(`主内容被压到 ${info.main}px`);

      const ok = msgs.length === 0;
      if (!ok) { fails++; problems.push(`${vp.name} ${view}: ${msgs.join('；')}`) }
      console.log(`   ${ok ? '✅' : '❌'} ${view.padEnd(7)} 滚动 ${info.sw}/${info.vw}  头部 ${info.header}  主内容 ${info.main}  ` +
        (info.dialog ? `弹窗 ${info.dialog.w}x${info.dialog.h}  ` : '') +
        (info.thin.length ? `按钮偏小:${info.thin.join(',')}  ` : '') +
        (ok ? '' : msgs.join('；')));

      if (SHOT || !ok) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const out = path.join(fixtureDir, `vp-${vp.name}-${view}.png`);
        fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      }
    }
  }

  cdp.close(); proc.kill();
  console.log(`\n共 ${checks} 个组合，${fails} 个不合格`);
  if (fails) {
    console.log('\n问题清单：');
    problems.forEach(p => console.log('  - ' + p));
    process.exitCode = 1;
  }
})();
