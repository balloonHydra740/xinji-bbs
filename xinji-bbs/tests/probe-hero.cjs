// 探针：hero 跟随板块。在 snapshot 生成的真页面上跑 pickBoard('7')，断言 hero 文案变化。
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIXTURE = 'file:///' + path.resolve(__dirname, 'fixtures', 'app-snapshot.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, 'shot-hero-board.png');

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
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: FIXTURE });
  await sleep(700);
  const evalJs = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { console.error('EVAL ERR', JSON.stringify(r.exceptionDetails).slice(0, 500)); return null; }
    return r.result.result ? r.result.result.value : r.result.value;
  };
  const heroOf = label => evalJs(`(function(){
    var p=document.querySelector('#heroPill'), t=document.querySelector('#heroTitle'), d=document.querySelector('#heroDesc');
    return '${label}: ' + p.textContent + ' | ' + t.textContent + ' | ' + d.textContent;
  })()`);

  console.log(await heroOf('初始(all) '));
  await evalJs(`pickBoard('7')`);   // 「技术」，带描述
  await sleep(500);
  console.log(await heroOf('板块7    '));
  await evalJs(`pickBoard('9')`);   // 「摄影」，无描述
  await sleep(500);
  console.log(await heroOf('板块9    '));
  await evalJs(`pickBoard('none')`);// 未分类
  await sleep(500);
  console.log(await heroOf('未分类  '));
  await evalJs(`pickBoard('all')`); // 回到全部
  await sleep(500);
  console.log(await heroOf('回all    '));

  await evalJs(`pickBoard('7');1`);
  await sleep(500);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('shot ->', OUT);
  cdp.close(); proc.kill();
})().catch(e => { console.error(e); process.exit(1); });
