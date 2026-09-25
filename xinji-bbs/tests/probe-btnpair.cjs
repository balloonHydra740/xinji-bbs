// 探针：复现「上传图片 / 清除」按钮错位。真实 style.css + fixture DOM，量 btnPair 内每个元素的几何。
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIXTURE = 'file:///' + path.resolve(__dirname, 'fixtures', 'ui-kit.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, 'shot-btnpair.png');

function launch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  return new Promise((resolve, reject) => {
    const proc = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--remote-debugging-port=0', '--user-data-dir=' + tmp, 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = d => {
      buf += d;
      const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[\w-]+/);
      if (m) { proc.stderr.off('data', onData); resolve({ proc, port: +m[1] }); }
    };
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('浏览器启动超时')), 20000);
  });
}

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej });
  let id = 0; const waiters = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } };
  const send = (method, params = {}) => new Promise(res => { const n = ++id; waiters.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) });
  return { send, close: () => ws.close() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { proc, port } = await launch();
  const cdp = await connect(port);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 1400, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: FIXTURE });
  await sleep(600);
  const evalRaw = async expr => (await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }));
  const evalJs = async expr => {
    const r = await evalRaw(expr);
    if (r.exceptionDetails) { console.error('EVAL ERR', JSON.stringify(r.exceptionDetails).slice(0, 800)); return null; }
    return r.result.result ? r.result.result.value : r.result.value;
  };

  console.log('sanity', await evalJs('1+1'));
  const info = await evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.btnPair')).map(function(pair){
      var pr = pair.getBoundingClientRect();
      var cs = getComputedStyle(pair);
      return { pairX: Math.round(pr.x), pairY: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height),
               display: cs.display, flexWrap: cs.flexWrap, alignItems: cs.alignItems,
               kids: Array.from(pair.children).map(function(el){
                 var r = el.getBoundingClientRect();
                 var s = getComputedStyle(el);
                 return { tag: el.tagName, cls: el.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                          display: s.display, pos: s.position, fs: s.fontSize, lh: s.lineHeight, mt: s.marginTop, mb: s.marginBottom };
               }) };
    }), null, 1)`);
  console.log(info);

  // 截一张个人资料卡局部图：把 dialog 滚到可见后拍视口
  await evalJs(`(function(){document.documentElement.style.scrollBehavior='auto';
    var el=document.querySelector('#avaPicker'); if(el) el.scrollIntoView({block:'center'}); return 1})()`);
  await sleep(200);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('shot ->', OUT);
  cdp.close(); proc.kill();
})().catch(e => { console.error(e); process.exit(1); });
