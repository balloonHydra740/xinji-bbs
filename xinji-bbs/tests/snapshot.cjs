/* 真实渲染快照 + 溢出体检：用无头浏览器把**真正的 app.js** 跑起来，逐屏截图与测量。
 *
 * 为什么要它：
 *   · panel-check 只跑逻辑、contrast-check 用的是手写骨架，两者都看不到
 *     「真页面长什么样」；
 *   · 更关键的是 `--window-size` 在 Windows 上会被系统最小窗口宽度钳到 504px，
 *     根本模拟不出手机。所以这里走 CDP（DevTools 协议）用
 *     Emulation.setDeviceMetricsOverride 精确指定视口 —— 390px 就是 390px。
 *     （Node 22 自带 WebSocket，不需要任何依赖。）
 *
 * 除了出图，每个视图 × 每个宽度都会额外测一遍横向溢出：
 * 「手机上看着太挤」的典型表现就是 scrollWidth > clientWidth，
 * 以前只能靠肉眼在真机上发现，现在提交前就能拦住。
 *
 * 用法：node tests/snapshot.cjs                 （全部视图，桌面 + 手机）
 *       node tests/snapshot.cjs --view=admin     （只做其中一个）
 *       node tests/snapshot.cjs --keep           （保留 fixture，方便手工打开看）
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures');
const fixture = path.join(fixtureDir, 'app-snapshot.html');

const EDGE = [
  process.env.EDGE_BIN,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(p => fs.existsSync(p));
if (!EDGE) {
  console.log('⚠️  没找到 Edge，跳过渲染快照（可用 EDGE_BIN 指定浏览器路径）');
  process.exit(0);
}

/* ---------- 1. 从 index.html 抽 body，路径改成相对 public/ ---------- */
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const head = indexHtml.slice(indexHtml.indexOf('<head>') + 6, indexHtml.indexOf('</head>'));
const body = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>'));

const bodyRel = body
  .replace(/href="\/style\.css"/, 'href="../../public/style.css"')
  .replace(/<script src="\/vendor\/qrcode\.min\.js"><\/script>/, '')   // 2FA 弹窗会自动降级
  .replace(/src="\/md\.js"/, 'src="../../public/md.js"')
  .replace(/src="\/app\.js"/, 'src="../../public/app.js"');

/* ---------- 2. fetch 桩：字段必须给全，缺一个就会渲染成错误页 ---------- */
const MOCK = `
<script>
var THREADS=[
  {id:3,title:'关于配色的一点想法',body:'红底上再写红字，看着就像在雾里看花。\\n文字和背景之间得有足够的亮度差。\\n\\n[img:1]',author_id:1,username:'rongrong',avatar:'emoji:🐱',pinned:1,locked:0,protected:1,board_name:'技术',created_at:'2026-09-20 10:00:00',updated_at:'2026-09-20 18:46:00',replies:3,att:{1:{mime:'image/png',w:1200,h:800}}},
  {id:4,title:'一个被置顶又锁定的主题标题，写长一点看看挤不挤',body:'不存在的正文',author_id:2,username:'tearsvow',avatar:'',pinned:1,locked:1,board_name:'闲聊',created_at:'2026-09-19 09:12:00',updated_at:'2026-09-19 09:12:00',replies:0,att:{}},
  // 带投票的一条：列表里只显示一句摘要（「3 人参与 · 单选」）
  {id:5,title:'快放假了！！！',body:'要去山里住几天',author_id:3,username:'别想妄图窥探神',avatar:'emoji:🦊',pinned:0,locked:0,board_name:'',created_at:'2026-09-18 20:00:00',updated_at:'2026-09-18 20:00:00',replies:1,att:{},quote_ref:'thread:3',likes:26,liked:1,reposts:4,poll:{id:21,question:'放假去哪儿玩比较好呢？',multi:0,total:3,voted:0,mine:[],options:[{id:71,label:'山里',n:2},{id:72,label:'海边',n:1}]}},
  {id:6,title:'Reading',body:'在读《设计中的设计》',author_id:4,username:'mj',avatar:'',pinned:0,locked:0,board_name:'技术',created_at:'2026-09-17 20:00:00',updated_at:'2026-09-17 20:00:00',replies:0,att:{},likes:0,liked:0,reposts:0},
  // ↓ 专门用来盯「长网址顶破布局」：假数据一直太乖（清一色中文，中文会自动换行），
  //   于是真机上一条含 58 字符网址的帖子就把 grid 列撑到 477px、整页横向溢出。
  //   这条数据就是那次的复现样本，别删。
  {id:7,title:'标题里塞超长网址 https://zh.wikipedia.org/wiki/Wikipedia:%E9%A6%96%E9%A1%B5 会不会顶破',body:'正文也有一个很长的网址：https://zh.wikipedia.org/wiki/Wikipedia:%E9%A6%96%E9%A1%B5\\n\\n还有一串没空格的英文 SupercalifragilisticexpialidociousABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',author_id:2,username:'tearsvow',avatar:'',pinned:0,locked:0,board_name:'闲聊',created_at:'2026-09-16 20:00:00',updated_at:'2026-09-16 20:00:00',replies:0,att:{},likes:0,liked:0,reposts:0}
];
// 回收站里的几类条目：主题 / 回复 / 账号
var TRASH_ITEMS=[
  {id:3,kind:'thread',target_id:3,parent_id:null,author_id:1,author_name:'rongrong',title:'一篇被删掉的长标题主题，用来看看回收站里的换行',excerpt:'正文摘要',item_count:5,deleted_by_name:'rongrong',by_owner:1,was_protected:1,deleted_at:'2026-09-22 20:10:00',can_restore:1,can_purge:1},
  {id:2,kind:'post',target_id:11,parent_id:3,author_id:2,author_name:'tearsvow',title:'',excerpt:'这条是管理员移除的，作者自己不能恢复',item_count:1,deleted_by_name:'rongrong',by_owner:0,was_protected:0,deleted_at:'2026-09-22 19:40:00',can_restore:1,can_purge:1},
  {id:1,kind:'user',target_id:9,parent_id:null,author_id:9,author_name:'ooo',title:'ooo',excerpt:'3 个主题 · 12 条回复 · 4 个附件',item_count:16,deleted_by_name:'rongrong',by_owner:0,was_protected:0,deleted_at:'2026-09-21 09:00:00',can_restore:1,can_purge:1}
];
var ME={id:1,username:'rongrong',role:'admin',bio:'在做一个安静的小论坛',avatar:'emoji:🐱',created_at:'2026-09-13 04:00:00',banned:0,totp_enabled:0,can_mod:1,can_admin:1,duress_set:1};
var THREAD_DETAIL={
  // 一条「已投票」的投票：显示结果条与百分比
  thread:{id:3,title:'关于配色的一点想法',body:'红底上再写红字，看着就像在雾里看花。\\n\\n## 两个办法\\n\\n- 拉开**亮度差**\\n- 别用满饱和色块\\n\\n> 文字和背景之间得有足够的亮度差，读起来才不费劲。\\n\\n[img:1]',author_id:1,username:'rongrong',avatar:'emoji:🐱',bio:'在做一个安静的小论坛',created_at:'2026-09-20 10:00:00',updated_at:'2026-09-20 18:46:00',locked:0,board_id:7,board_name:'技术',edited_at:'2026-09-20 18:46:00',likes:12,liked:1,reposts:3,protected:1,quote_ref:null,quote_snapshot:null,poll:{id:20,question:'这套配色你们更常用哪一种？（选项写长一点，看看手机上会不会挤）',multi:0,total:7,voted:1,mine:[61],options:[{id:61,label:'星铃紫（默认的那套）',n:4},{id:62,label:'深海蓝',n:2},{id:63,label:'薄荷青',n:1}]}},
  posts:[
    {id:11,author_id:2,username:'tearsvow',avatar:'',bio:'',body:'说的是。深浅拉开之后，视线落点也清楚多了。',created_at:'2026-09-20 19:02:00',reply_to:null,role:'user',likes:2,liked:0,reposts:0,protected:1,quote_ref:null,quote_snapshot:null},
    // 一条「还没投票 + 多选」的投票：选项是可点的，不显示票数
    {id:12,author_id:1,username:'rongrong',avatar:'emoji:🐱',bio:'在做一个安静的小论坛',body:'补上媒体与禁用态。视频、音频、加载骨架、破图占位四种都要能看清。',created_at:'2026-09-20 19:10:00',reply_to:11,role:'admin',edited_at:'2026-09-20 19:30:00',likes:0,liked:0,reposts:1,quote_ref:null,quote_snapshot:null,poll:{id:22,question:'下面这些你平时会用到哪些？',multi:1,total:0,voted:0,mine:[],options:[{id:81,label:'图片',n:0},{id:82,label:'视频',n:0},{id:83,label:'音频',n:0}]}},
    // 一条带引用卡的回复：顺便看看引用卡在楼中楼里的排版
    {id:13,author_id:4,username:'mj',avatar:'',bio:'',body:'同感 ✨',created_at:'2026-09-20 19:20:00',reply_to:12,role:'user',likes:1,liked:1,reposts:0,quote_ref:'post:11',quote_snapshot:JSON.stringify({t:'post',id:11,tid:3,user:'tearsvow',excerpt:'说的是。深浅拉开之后，视线落点也清楚多了。',at:'2026-09-20 19:02:00',sensitive:0})}
  ],
  att:{1:{mime:'image/png',w:1200,h:800}}
};
var USERS=[
  {id:1,username:'rongrong',role:'admin',banned:0,totp_enabled:0,avatar:'emoji:🐱',duress_state:0,duress_set:1},
  {id:2,username:'tearsvow',role:'user',banned:0,totp_enabled:0,avatar:'',duress_state:1,duress_set:1},
  {id:3,username:'别想妄图窥探神',role:'user',banned:0,totp_enabled:1,avatar:'emoji:🦊',duress_state:0,duress_set:1},
  {id:4,username:'全世界最有实力的人一个名字能有多长',role:'moderator',banned:0,totp_enabled:0,avatar:'emoji:🐼',duress_state:0,duress_set:0},
  {id:5,username:'ooo',role:'user',banned:1,totp_enabled:0,avatar:'emoji:🐧',duress_state:0,duress_set:0}
];
var BOARDS=[{id:7,name:'技术',threads:2,description:'折腾与折腾之间的空档',creator:'rongrong'},{id:8,name:'闲聊',threads:1,creator:'tearsvow'},{id:9,name:'摄影',threads:0}];

window.fetch=async function(url){
  var body={};
  if(url.indexOf('/api/status')>=0) body={setupNeeded:false,user:ME,uploadEnabled:true,maxUploadMb:30,maxAvatarMb:2};
  else if(url.indexOf('/api/boards')>=0) body={boards:BOARDS,unboarded:1};
  else if(/\\/api\\/threads\\/\\d+$/.test(url)) body=THREAD_DETAIL;
  else if(url.indexOf('/api/threads')>=0) body={items:THREADS,total:4,page:1,pages:1,limit:20};
  else if(/\\/api\\/users\\/\\d+/.test(url)) body={user:{id:2,username:'tearsvow',role:'user',bio:'',avatar:'',created_at:'2026-09-14 04:00:00',banned:0,duress_state:1,duress_at:'2026-09-22 21:30:00'},stats:{threads:2,replies:7,likes:23},
    threads:[{id:4,title:'一个被置顶又锁定的主题标题',created_at:'2026-09-19 09:12:00',board_name:'闲聊'}],
    posts:[{id:11,body:'说的是。深浅拉开之后，视线落点也清楚多了。',created_at:'2026-09-20 19:02:00',thread_id:3,thread_title:'关于配色的一点想法'}]};
  else if(url.indexOf('/api/admin/users')>=0) body=USERS;
  else if(url.indexOf('/api/admin/posts')>=0) body=[{id:11,body:'说的是。深浅拉开之后，视线落点也清楚多了，这段摘要写得长一点以便看出省略效果',created_at:'2026-09-20 19:02:00',thread_id:3,title:'关于配色的一点想法',username:'tearsvow'}];
  else if(url.indexOf('/api/trash')>=0) body={items:TRASH_ITEMS,total:TRASH_ITEMS.length,page:1,pages:1,limit:20,admin:1};
  else if(url.indexOf('/api/admin/storage')>=0) body={config:{type:'webdav',enabled:true,webdav:{baseUrl:'https://dav.example.com/dav',username:'rong',hasPassword:true}},attachments:{count:42,bytes:18350080},armed:{at:Date.now(),count:42}};
  else if(url.indexOf('/api/admin/upload-limit')>=0) body={uploadMb:30,avatarMb:2,platformMaxMb:100};
  else if(/\\/api\\/threads\\/3\\/edits/.test(url)) body={edits:[]};
  else body={ok:true};
  return {ok:true,status:200,json:async function(){return body}};
};
</script>
`;

/* ---------- 2b. 线上真实数据（可选）----------
   假数据都太「乖」了：清一色中文、没有长 URL、没有代码块 ——
   真机上把人撑到屏幕外的那种内容它一条都造不出来。
   同目录下放着 .live-threads.json / .live-t4.json 时（用 curl 从线上拉的），
   就用真数据渲染一遍。 */
let MOCK_LIVE = null;
{
  const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) } catch (e) { return null } };
  const LT = readJson('.live-threads.json'), LD = readJson('.live-t4.json'), LB = readJson('.live-boards.json');
  if (LT && LT.items && LT.items.length) {
    MOCK_LIVE = MOCK
      .replace(/var THREADS=\[[\s\S]*?\n\];/, 'var THREADS=' + JSON.stringify(LT.items) + ';')
      .replace(/var THREAD_DETAIL=\{[\s\S]*?\n\};/, LD ? 'var THREAD_DETAIL=' + JSON.stringify(LD) + ';' : 'var THREAD_DETAIL=null;')
      .replace(/var BOARDS=\[[\s\S]*?\n\];/, LB && LB.boards ? 'var BOARDS=' + JSON.stringify(LB.boards) + ';' : 'var BOARDS=[];');
    console.log('⚑ 检测到线上真实数据，改用真数据渲染（' + LT.items.length + ' 条主题）');
  }
}

/* ---------- 3. 视图驱动 ---------- */
const VIEWS = {
  list:     '1',
  thread:   'openThread(3)',
  user:     'openUser(2)',
  admin:    "document.querySelector('#adminBtn').onclick()",
  post:     "document.querySelector('#newBtn').onclick()",
  settings: "document.querySelector('#settingsBtn').onclick()",
  store:    'openStore()',
  // 转帖弹窗：引用卡预览 + 评论框 + 「不易展示」勾选，全在一屏里
  repost:   "openRepost('thread',3)",
  // 回收站：条目带类型角标、谁删的、恢复 / 彻底删除
  trash:    'openTrash()',
  // 账户设置里的「胁迫密码」卡：它在设置弹窗的折叠线以下，要滚到它那一屏才看得到
  duress:   `(function(){
    document.querySelector('#settingsBtn').onclick();
    var c=document.querySelector('#duressCard');
    if(c&&c.scrollIntoView) c.scrollIntoView({block:'center'});
    return 1;
  })()`,
  // 投票编辑器：问题 + 选项行（序号 / 输入框 / 删除）+ 多选开关。手机上是底部抽屉。
  poll:     `(function(){
    openPollDialog();
    document.querySelector('#pollQuestion').value='今晚吃什么？';
    var list=document.querySelector('#pollOptList');
    var ins=list?list.querySelectorAll('input'):[];
    if(ins[0]) ins[0].value='火锅';
    if(ins[1]) ins[1].value='烤肉';
    return 1;
  })()`,
  menu:     "document.querySelector('#userBtn').onclick()",   // 顶栏用户下拉（退出登录那颗按钮就在里面）
  // 左上角导航抽屉：板块 + 外观都收在这里，得亲眼看一眼滑出后的排版
  nav:      'openNav()',
  // 上传中的状态只能手动摆出来：真跑一次上传需要外部存储，截图里看不到。
  // 这个视图专门用来核对进度条 + 「正在上传 2/3 · 46%」那行字。
  upload:   `(function(){
    document.querySelector('#newBtn').onclick();
    var p=document.querySelector('#postDialog .progress');
    if(p){ p.classList.remove('hidden'); var b=p.querySelector('i'); if(b) b.style.width='46%' }
    var r=document.querySelector('#postDialog .upRow');
    if(r){ r.classList.remove('hidden'); var t=r.querySelector('.upTip'); if(t) t.textContent='正在上传 2/3 · 46%' }
    return 1;
  })()`,
};
// 打开弹窗的那些视图：手机上应该变成底部抽屉
const DIALOG_VIEWS = new Set(['post', 'settings', 'store', 'repost', 'trash', 'duress', 'poll']);
// 详情类视图：手机上应该把首页的 hero / 板块栏收起来，让正文尽早出现
const DETAIL_VIEWS = new Set(['thread', 'user', 'admin']);

// fetch 桩必须插在 app.js **之前** —— app.js 一加载完就调 init()，
// 放在它后面第一次请求还是打到真 fetch 上，直接 Failed to fetch。
const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>${head}
<link rel="stylesheet" href="../../public/style.css">
</head>
<body>${bodyRel.replace(
  '<script src="../../public/app.js"></script>',
  (MOCK_LIVE || MOCK) + '<script src="../../public/app.js"></script>'
)}
</body>
</html>
`;

fs.mkdirSync(fixtureDir, { recursive: true });
fs.writeFileSync(fixture, page);

/* ---------- 4. CDP 客户端 ---------- */
function launch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbbs-snap-'));
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

(async () => {
  const only = (process.argv.find(a => a.startsWith('--view=')) || '').slice(7);
  const views = only ? [only] : Object.keys(VIEWS);
  // --dark：深色模式也要亲眼看一遍 —— 新组件只在浅色下截过图，
  // 深色下“看不见”的问题（对比度、描边、阴影）只有真渲染才能发现。
  const DARK = process.argv.includes('--dark');
  const { proc, port } = await launch();
  const cdp = await connect(port);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evalJs = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result && r.result.result.value;
  };

  const LAYOUTS = [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 780 },
  ];

  let fails = 0;
  for (const v of views) {
    for (const L of LAYOUTS) {
      const isMobile = L.name === 'mobile';
      // 只给手机档单独建立文件，桌面档复用同一个名字（方便 diff）
      const out = path.join(fixtureDir, `shot-${v}${DARK ? '-dark' : ''}${isMobile ? '-mobile' : ''}.png`);

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: L.width, height: L.height, deviceScaleFactor: 1, mobile: false,
      });
      await cdp.send('Page.navigate', { url: 'file:///' + fixture.replace(/\\/g, '/') });
      await sleep(400);   // 等导航落地
      // init() 是异步的：等 #threadCount 不再是占位符
      const WAIT_INIT = `new Promise(r=>{let n=0;const t=setInterval(()=>{
        const c=document.querySelector('#threadCount');
        if((c&&c.textContent!=='—')||++n>120){clearInterval(t);r(1)}},25)})`;
      await evalJs(WAIT_INIT, true);
      if (DARK) {
        // 先把偏好写进 localStorage 再整页重载：首屏内联脚本在样式生效前
        // 就把 data-theme 写好了，不会闪一下浅色。
        await evalJs(`try{localStorage.setItem('bbs_theme','dark')}catch(e){}`);
        await cdp.send('Page.navigate', { url: 'file:///' + fixture.replace(/\\/g, '/') });
        await sleep(400);
        await evalJs(WAIT_INIT, true);
      }
      // 切到目标视图，并给它自己的异步请求留点时间。
      // 顺手把 /api/files/* 的图换成占位 SVG —— fixture 里没有真文件，
      // 不换的话每张图都是破图，截图根本看不出真实排版。
      const SWAP = `document.querySelectorAll('img[src^="/api/files/"]').forEach(function(im){
        im.src='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#cdd6e4"/><text x="600" y="420" font-size="56" text-anchor="middle" fill="#5a6478" font-family="sans-serif">示例图片</text></svg>');
        im.classList.remove('loading'); im.classList.remove('broken');
        if(!im.getAttribute('width')){ im.setAttribute('width','1200'); im.setAttribute('height','800') }
      });`;
      await evalJs(`(async()=>{ ${VIEWS[v]}; await new Promise(r=>setTimeout(r,350)); ${SWAP} return 1 })()`, true);

      const probe = await evalJs(`(function(){
        const d=document.documentElement;
        const err=document.querySelector('#app .empty.anim-in');
        const bad=[];
        document.querySelectorAll('body *').forEach(function(el){
          const r=el.getBoundingClientRect();
          if(r.width<2||r.height<2) return;
          // 关着的导航抽屉停在屏幕外（translateX(-102%)），它的 left 天然是负的。
          // 这不是溢出 —— 已经用 visibility:hidden 藏起来了，直接跳过。
          if(getComputedStyle(el).visibility==='hidden') return;
          if(r.right>d.clientWidth+1||r.left<-1){
            bad.push(el.tagName.toLowerCase()+'.'+String(el.className||'').split(/\\s+/).slice(0,2).join('.')+' '+
              Math.round(r.left)+'..'+Math.round(r.right));
          }
        });
        // Markdown 工具栏是 init() 里填的，忘了调用就会静默留一条空条 —— 专门盯一下
        const mb=document.querySelector('#postMdBar');
        // 工具栏按钮上必须是中文（新手看得懂），不是 B / I / S 这类符号
        var faces=[];
        if(mb) Array.prototype.forEach.call(mb.querySelectorAll('button,label'), function(b){
          faces.push(String(b.textContent||'').trim());
        });
        // 手机上的弹窗应该是底部抽屉：占满宽度 + 下方两角是直角
        const dl=document.querySelector('dialog[open]');
        let sheet='';
        if(dl){ const r=dl.getBoundingClientRect(), cs=getComputedStyle(dl);
          sheet=(Math.round(r.width)>=d.clientWidth-1 && cs.borderBottomLeftRadius==='0px' &&
                 cs.borderBottomRightRadius==='0px')?'sheet':'dialog'; }
        // 详情类视图在手机上要把首页装饰收起来
        const hero=document.querySelector('.hero');
        const heroHidden = !hero || getComputedStyle(hero).display==='none';
        // 手机上回复框默认折叠（展开要占掉半屏）
        const rf=document.querySelector('#replyForm');
        const collapsed = !!(rf && rf.classList.contains('collapsed'));
        // 【上传入口统一】回复框里只能有**一个**能触发上传的东西。
        // 它现在是个 <label for>（浏览器原生触发），所以按钮和 label 一起数。
        let ups=-1;
        if(rf) ups=Array.prototype.filter.call(rf.querySelectorAll('button,label'),
          function(b){ return String(b.textContent||'').indexOf('图片') >= 0 }).length;
        // 管理中心必须有用户搜索框
        const adminSearch=!!document.querySelector('#adminUserSearch')
          || document.documentElement.getAttribute('data-view') !== 'admin';
        /* 手机抽屉里吸底的主按钮，下方不能露出正文。
           sticky 的偏移基准是内容盒，差一点就会从按钮底下漏出半截字 ——
           这种事肉眼很容易放过，但 elementFromPoint 一测就现形：
           伪元素不参与命中测试，它返回宿主按钮，所以「命中按钮」= 盖住了。
           只在内容确实超出（按钮真的吸住）时才判。 */
        let sticky='none';
        (function(){
          const f=document.querySelector('dialog[open] .dlgBody');
          if(!f) return;
          const btn=f.querySelector(':scope > .primary.wide:last-of-type');
          if(!btn) return;
          if(f.scrollHeight<=f.clientHeight+2){ sticky='skip'; return }
          const b=btn.getBoundingClientRect();
          const y=Math.round(b.bottom)+2;
          if(y>=window.innerHeight){ sticky='skip'; return }
          const hit=document.elementFromPoint(Math.round(b.left+b.width/2),y);
          sticky=(hit===btn)?'ok':('泄漏 '+(hit?hit.tagName+'.'+String(hit.className||'').slice(0,14):'null'));
        })();
        // 导航抽屉：打开后必须真的在屏幕内、且里面装着板块条目与深浅三档
        const drawer=document.querySelector('#navDrawer');
        const drawerOpen=!!(drawer && drawer.classList.contains('open'));
        const drawerRect=drawer?drawer.getBoundingClientRect():null;
        const navN=drawer?drawer.querySelectorAll('.navItem').length:0;
        const navSeg=drawer?drawer.querySelectorAll('#navThemeSeg .segBtn').length:0;
        const navOnScreen=!!(drawerRect && drawerRect.left>=-1 && drawerRect.width>=180);
        return JSON.stringify({vw:d.clientWidth,sw:d.scrollWidth,
          err:(err&&/加载失败/.test(err.textContent))?err.textContent.slice(0,60):'',
          mdbar: mb?mb.children.length:-1, sheet:sheet, heroHidden:heroHidden,
          collapsed:collapsed, hasReply:!!rf, ups:ups, adminSearch:adminSearch, sticky:sticky,
          drawerOpen:drawerOpen, navN:navN, navSeg:navSeg, navOnScreen:navOnScreen,
          faces:faces.slice(0,13), bad:bad.slice(0,6)});
      })()`);
      const info = JSON.parse(probe);
      const overflow = info.sw > info.vw + 1;
      const noBar = info.mdbar <= 0;
      // 手机档开弹窗的视图，必须是底部抽屉
      const badSheet = isMobile && DIALOG_VIEWS.has(v) && info.sheet === 'dialog';
      // 手机档的详情视图不该再让 hero 占掉首屏
      const badHero = isMobile && DETAIL_VIEWS.has(v) && !info.heroHidden;
      // 手机档看帖时回复框应该折叠着；宽屏则应该直接展开
      const badReply = info.hasReply && (isMobile ? !info.collapsed : info.collapsed);
      // 回复框里的上传入口只能有一个
      const badUps = info.hasReply && info.ups !== 1;
      const badAdminSearch = !info.adminSearch;
      // 抽屉视图：必须真的打开了、在屏幕内，且板块条目与三档都在
      const badDrawer = v === 'nav' && !(info.drawerOpen && info.navOnScreen && info.navN >= 3 && info.navSeg === 3);
      // 反过来：其它视图里抽屉必须是关着的（别把浮层忘在页面上）
      const badStrayDrawer = v !== 'nav' && info.drawerOpen;
      // 吸底主按钮下方漏出正文（只在按钮真的吸住时才判）
      const badSticky = typeof info.sticky === 'string' && info.sticky.indexOf('泄漏') === 0;
      // 工具栏按钮要写中文
      const cn = ['加粗', '斜体', '删除线', '标题', '引用', '代码', '代码块', '链接', '列表', '编号', '分隔线', '图片', '预览'];
      const badFace = !cn.every(t => info.faces.some(f => f.indexOf(t) >= 0));
      const ok = !overflow && !info.err && !noBar && !badSheet && !badHero && !badReply && !badFace && !badUps && !badAdminSearch && !badDrawer && !badStrayDrawer && !badSticky;
      if (!ok) fails++;

      // 手机档只拍视口：手机本来就是「一屏一屏」看的，整页长图反而看不出真实观感。
      // 另外 position:sticky 的元素在 captureBeyondViewport 的整页图里会被钉在视口底部，
      // 在长图里看着像跑到了页面开头 —— 那是截图方式的锅，不是布局的锅。
      const shot = await cdp.send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: !isMobile });
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));

      console.log(`  ${ok ? '✅' : '❌'} ${String(L.width).padStart(4)}px  ${v.padEnd(8)} ` +
        `scrollWidth ${info.sw}/${info.vw}  工具栏 ${info.mdbar} 项` +
        (isMobile && DIALOG_VIEWS.has(v) ? `  ${info.sheet === 'sheet' ? '底部抽屉' : '普通弹窗'}` : '') +
        (info.hasReply ? (info.collapsed ? '  回复框折叠' : '  回复框展开') + `  上传入口 ${info.ups} 个` : '') +
        (info.err ? `  ⚠ 渲染成错误页：${info.err}` : '') +
        (overflow ? `  ⚠ 横向溢出：${info.bad.join(' | ')}` : '') +
        (noBar ? '  ⚠ Markdown 工具栏没被填上（renderMdBars 漏调了？）' : '') +
        (badFace ? `  ⚠ 工具栏按钮不是中文标签：${JSON.stringify(info.faces)}` : '') +
        (badUps ? `  ⚠ 回复框里的上传入口不是 1 个：${info.ups}` : '') +
        (badAdminSearch ? '  ⚠ 管理中心没有用户搜索框' : '') +
        (badSheet ? '  ⚠ 手机端弹窗没变成底部抽屉' : '') +
        (badHero ? '  ⚠ 手机端详情页仍被 hero 占着首屏' : '') +
        (badReply ? '  ⚠ 回复框折叠状态不对' : '') +
        (badDrawer ? `  ⚠ 导航抽屉状态不对：open=${info.drawerOpen} 在屏内=${info.navOnScreen} 板块条目=${info.navN} 深浅档=${info.navSeg}` : '') +
        (badStrayDrawer ? '  ⚠ 抽屉没关，浮层留在页面上' : '') +
        (badSticky ? `  ⚠ 吸底按钮下方漏出内容（${info.sticky}）` : '') +
        (info.sticky === 'ok' ? '  吸底按钮已盖严' : '') +
        `  → ${path.relative(root, out)}`);
      // 手机上带回复框的视图，再补一张滚到底的图 ——
      // 回复框在页面末尾，首屏截图根本看不到它，而它正是最容易被吐槽「太大」的地方。
      if (isMobile && info.hasReply) {
        await evalJs('(function(){window.scrollTo(0,document.body.scrollHeight);return 1})()');
        await sleep(200);
        const s2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const out2 = path.join(fixtureDir, `shot-${v}-bottom.png`);
        fs.writeFileSync(out2, Buffer.from(s2.result.data, 'base64'));
        console.log(`        ↳ 滚到底：${path.relative(root, out2)}（${info.collapsed ? '折叠条' : '完整编辑器'}）`);
      }
    }
  }

  cdp.close();
  proc.kill();
  if (!process.argv.includes('--keep')) { /* fixture 本身留着当调试入口 */ }
  if (fails) { console.log(`\n❌ ${fails} 个视图/宽度不合格`); process.exitCode = 1; }
  else console.log('\n✅ 全部视图渲染正常、没有横向溢出（截图在 tests/fixtures/shot-*.png）');
})().catch(e => { console.error('快照失败：' + e.message); process.exit(1) });
