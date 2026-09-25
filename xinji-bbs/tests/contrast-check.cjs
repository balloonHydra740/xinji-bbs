/* 配色可读性审计（WCAG 2.1 对比度）
 *
 * 做法：
 *   1. 把 public/index.html 里所有 <dialog> 原样抽出来，拼上一个覆盖全部组件的
 *      骨架页（tests/fixtures/ui-kit.html）—— 保证测的是真实 DOM 结构，不是抄一遍；
 *   2. 用无头 Edge 渲染，页面内 audit.js 遍历真实文本节点、逐层合成背景色，
 *      算出每个前景/背景组合的对比度；
 *   3. 拿回报告，正文 <4.5:1 / 大文本 <3:1 判为不达标。
 *
 * 2026-09 起：**逐套配色、深浅两档**各审计一遍。
 * 以前只测默认浅色，于是新加配色时谁也没发现某一套在深色下是糊的。
 * 现在 data-palette / data-theme 直接写在 <html> 上，跑满 6×2 组。
 *
 * 用法： node tests/contrast-check.cjs            （审计）
 *        node tests/contrast-check.cjs --all      （列出全部组合）
 *        node tests/contrast-check.cjs --shot     （额外出全组件截图与账户设置截图）
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures');
const fixture = path.join(fixtureDir, 'ui-kit.html');
// 无头浏览器只用来「真实渲染一遍」，不引入任何 npm 依赖。
// 找不到 Edge 就跳过而不是报错 —— 配色审计是锦上添花，不该挡住其它测试。
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!EDGE) {
  console.log('⚠️  没找到 Edge，跳过配色审计（可用 EDGE_BIN 环境变量指定浏览器路径）');
  process.exit(0);
}

const PALETTES = ['violet', 'ocean', 'mint', 'sunset', 'rose', 'slate'];
const MODES = ['light', 'dark'];

/* ---------- 1. 骨架页 ---------- */
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const dialogs = [...indexHtml.matchAll(/<dialog[\s\S]*?<\/dialog>/g)].map(m => m[0]);

// 静态骨架：照着 app.js 里 list() / openThread() / openUser() / 管理中心 拼出来的真实结构。
// 新加组件时记得同步这里，否则它会悄无声息地漏出审计范围。
const BODY = `
<div class="bg"></div>
<header>
  <div class="hLeft">
    <button class="iconBtn navBtn" type="button" aria-expanded="true" title="导航菜单" aria-label="打开导航菜单">
      <span class="navIco" aria-hidden="true"><i></i><i></i><i></i></span>
    </button>
    <div class="brand"><span class="logo">星</span><span class="brandText"><b>星铃</b><small>一个自由的讨论社区</small></span></div>
  </div>
  <div class="navActions">
    <button class="primary">＋ 发帖</button>
    <button class="userBtn" type="button"><span class="ava avaMini avaText">荣</span><b id="me">荣荣</b><span class="caret">▾</span></button>
  </div>
</header>
<main>
  <section class="hero">
    <div>
      <span class="pill">自由讨论 · BBS</span>
      <h1>说点什么，留下你的痕迹。</h1>
      <p>这里是一个自由的讨论社区。可以发帖、回复，也可以带上图片和视频。</p>
    </div>
    <div class="stats"><b>12</b><small>个主题</small></div>
  </section>

  <!-- 板块收进菜单后，列表区只剩「当前板块 + 搜索」这一行 -->
  <section class="boardBar">
    <div class="filterRow">
      <button class="chip pickChip" type="button"><span class="pickK">板块</span><b>一个名字比较长的板块</b><span class="caret">▾</span></button>
      <form class="searchRow">
        <input type="search" placeholder="搜索标题、正文或作者…">
        <button class="mini primary" type="submit">搜索</button>
        <button class="mini" type="button">清除</button>
      </form>
    </div>
  </section>

  <div class="threadList">
    <article class="thread">
      <div class="threadTop"><span class="tag">置顶</span><span class="tag mute">已锁</span><span class="tag warn">已封禁</span><span class="tag board">技术</span></div>
      <h3>关于配色的一点想法</h3>
      <p>红底上再写红字，看着就像在雾里看花。文字和背景之间得有足够的亮度差，读起来才不费劲。</p>
      <div class="thumbs"><img class="thumb" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" alt=""><span class="thumbVideo">🎬 视频</span><span class="thumbVideo">已失效</span></div>
      <div class="meta"><span class="ava avaMini avaText">荣</span><span class="linkName">荣荣</span><span>2026年9月20日 18:46</span><span>3 回复</span></div>
      <!-- 投票：列表里只给一句摘要 -->
      <div class="pollMini"><svg class="pollIco" viewBox="0 0 24 24"><path d="M4 20.5h4.2V11H4z"/></svg><b>今晚吃什么？</b><span class="muted">3 人参与 · 单选</span><span class="pollMiniGo">去投票 →</span></div>
      <!-- 点赞 / 转帖：图标 + 计数。这里两种状态都要进审计（已赞是浅粉底 + 深红字） -->
      <div class="reactRow">
        <button class="act act-like on" type="button"><svg class="actIco" viewBox="0 0 24 24"><path d="M12 20.6C6.4 17.1 3 13.8 3 10.1 3 7.2 5.2 5.1 8 5.1z"/></svg><span class="actN">12</span></button>
        <button class="act act-repost" type="button"><svg class="actIco" viewBox="0 0 24 24"><path d="M17 2.5 20.5 6 17 9.5"/></svg><span class="actN">3</span></button>
      </div>
    </article>
    <article class="thread">
      <div class="threadTop"><span class="tag board">闲聊</span></div>
      <h3>周末都在做什么</h3>
      <p>泡了杯茶，随手翻了翻旧相册。</p>
      <div class="meta"><span>小铃</span><span>2026年9月19日 09:12</span><span>0 回复</span></div>
    </article>
  </div>

  <div class="view">
    <span class="back">← 返回主题列表</span>
    <article class="post first">
      <div class="postHead">
        <span class="avaLink"><span class="ava avaText">荣</span></span>
        <div class="postWho"><b class="linkName">荣荣</b><small>2026年9月20日 18:46 · <span class="tag board">技术</span> · <span class="edited">已编辑</span></small><span class="sig">一句签名档</span></div>
      </div>
      <h1>关于配色的一点想法</h1>
      <p class="shieldNote">这条内容已由站主保护：原作者不再能修改或删除它。</p>
      <span class="tag board shieldTag">已保护</span>
      <!-- 引用卡：转帖 / 引用别人的内容时挂出来的那一张 -->
      <div class="quoteCard">
        <div class="qHead"><span class="ava avaMini avaText">铃</span><b>小铃</b><small>2026年9月19日 09:12</small><span class="tag warn">不易展示</span></div>
        <b class="qTitle">被转的那条主题</b>
        <span class="qText">引用卡上的摘要压在浅底上，字小一档，是最容易掉到门槛下的那一处。</span>
      </div>
      <div class="postBody">正文段落，用来测正文与卡片背景的对比度。
<span class="attMissing">［附件 #99 已不存在］</span>
<button class="attFailTip" type="button">附件加载失败 · 点这里重试</button></div>
      <img class="att broken" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" alt="附件">
      <!-- 投票卡：未投（可点选项）、已投（结果条 + 我投的那项高亮）两种形态都要进审计 -->
      <div class="pollCard">
        <div class="pollHead"><svg class="pollIco" viewBox="0 0 24 24"><path d="M4 20.5h4.2V11H4z"/></svg><b>今晚吃什么？</b><span class="tag mute">多选</span></div>
        <div class="pollOpts">
          <button class="pollOpt on" type="button"><span class="pollMark"></span><span class="pollOptTxt">火锅</span></button>
          <button class="pollOpt" type="button"><span class="pollMark"></span><span class="pollOptTxt">烤肉</span></button>
        </div>
        <div class="pollRes mine">
          <span class="pollResTop"><span class="pollResLabel"><span class="pollTick">✓</span>火锅</span><span class="pollResNum">2 票 · 67%</span></span>
          <span class="pollBar"><i style="width:67%"></i></span>
        </div>
        <div class="pollRes">
          <span class="pollResTop"><span class="pollResLabel">烤肉</span><span class="pollResNum">1 票 · 33%</span></span>
          <span class="pollBar"><i style="width:33%"></i></span>
        </div>
        <button class="mini primary pollSubmit" type="button">投票</button>
        <div class="pollFoot muted">共 3 人参与 · 已投票，谢谢你的这一票</div>
      </div>
      <div class="pollChip">
        <span class="pollChipHead"><svg class="pollIco" viewBox="0 0 24 24"><path d="M4 20.5h4.2V11H4z"/></svg><b>今晚吃什么？</b><span class="tag mute">多选</span></span>
        <span class="muted">2 个选项 · 每人一票</span>
        <span class="chipActs"><button class="mini" type="button">编辑</button><button class="mini danger" type="button">移除</button></span>
      </div>
      <div class="moveRow"><span class="muted">板块</span><select><option>未分类</option><option selected>技术</option></select><button class="mini">移动到该板块</button></div>
      <div class="postActions"><button class="mini danger">删除主题</button></div>
    </article>
    <div class="replies">
      <article class="post">
        <div class="postHead"><span class="avaLink"><span class="ava avaText">铃</span></span><div class="postWho"><b class="linkName">小铃</b><small>#1 · 2026年9月20日 19:02 · 管理员</small></div></div>
        <div class="quoteBar"><i>回复 荣荣：</i>红底上再写红字…</div>
        <div class="postBody">说的是。深浅拉开之后，视线落点也清楚多了。</div>
        <div class="reactRow">
          <button class="act act-like" type="button"><svg class="actIco" viewBox="0 0 24 24"><path d="M12 20.6C6.4 17.1 3 13.8 3 10.1 3 7.2 5.2 5.1 8 5.1z"/></svg><span class="actN">1</span></button>
          <button class="act act-repost" type="button"><svg class="actIco" viewBox="0 0 24 24"><path d="M17 2.5 20.5 6 17 9.5"/></svg><span class="actN">0</span></button>
          <button class="act act-quote" type="button"><svg class="actIco" viewBox="0 0 24 24"><path d="M9.6 6.4C6.6 7.9 5 10.3 5 13.4z"/></svg><span class="actTxt">引用</span></button>
        </div>
        <div class="postActions"><button class="mini">回复</button><button class="mini danger">删除</button></div>
      </article>
      <article class="post nested" style="--depth:1">
        <div class="replyTo">正在回复 #1 <button class="mini" type="button">取消</button></div>
        <div class="postBody">补上媒体与禁用态。视频、音频、加载中、加载失败四种都要能看清占位样式。</div>
        <video class="att" controls></video>
        <audio class="att audio" controls></audio>
        <img class="att loading" alt="附件">
      </article>
    </div>
    <form class="replyBox">
      <textarea placeholder="写下回复……"></textarea>
      <div class="mdBar">
        <button class="mdBtn" type="button"><b>加粗</b></button>
        <button class="mdBtn" type="button"><i>斜体</i></button>
        <button class="mdBtn on" type="button"><s>删除线</s></button>
        <button class="mdBtn" type="button">标题</button>
        <button class="mdBtn" type="button"><code>代码</code></button>
        <button class="mdBtn act" type="button">预览</button>
      </div>
      <input type="file" class="fileHidden">
      <div class="progress"><i style="width:40%"></i></div>
      <div class="upRow"><span class="upTip muted">正在上传 2/3 · 46%</span><button class="mini" type="button">取消</button></div>
      <div class="upRow"><span class="upTip muted">正在保存到存储…（2/3）</span><button class="mini" type="button">取消</button></div>
      <textarea placeholder="这条主题已被锁定，无法回复" disabled></textarea>
      <input placeholder="禁用的输入框也要读得出占位文字" disabled>
      <div class="rowActions end"><span class="muted">已恢复上次未发送的草稿</span><button class="primary">回复</button></div>
    </form>
    <form class="replyBox collapsed">
      <button class="replyOpen" type="button">写下回复……</button>
      <textarea placeholder="写下回复……"></textarea>
      <button class="primary">回复</button>
    </form>
  </div>

  <div class="empty">还没有主题。成为第一个留下文字的人吧 ✨</div>
  <div class="mdPreview postBody">预览区正文</div>
  <div class="fieldHint"><span>点上面的按钮就能加格式，不用背 Markdown</span><span>最多 10,000 字</span></div>
  <!-- 投票编辑器（弹窗里的选项行是 JS 画的，静态骨架这里补一份） -->
  <div class="pollEdit">
    <div class="pollEditHead"><span>选项</span><span class="muted">2 / 10</span></div>
    <div class="pollOptRow"><span class="pollOptNo">1</span><input placeholder="选项 1" value="火锅"><button class="mini danger pollDel" type="button">×</button></div>
    <div class="pollOptRow"><span class="pollOptNo">2</span><input placeholder="选项 2" value="烤肉"><button class="mini danger pollDel" type="button">×</button></div>
    <button class="mini" type="button">＋ 添加一个选项</button>
  </div>

  <!-- 管理员视角：注销卡会被挂上 is-locked，配色要退成中性，不能继续喊红色 -->
  <section class="setCard danger is-locked">
    <h3>注销账号</h3>
    <p class="muted">管理员不允许注销账户</p>
  </section>

  <!-- 胁迫模式横幅 + 回收站的一行：这两块都是新增的，别漏出审计范围 -->
  <div class="shieldBanner">
    <b>该账号已进入保护状态</b>
    <span>TA 已输入保护密码（或由站主手动启动），账号暂时停用。所有内容都完整保留、一条未删。</span>
    <small class="muted">触发时间：2026年9月23日 05:30</small>
  </div>
  <div class="row t-thread">
    <span class="rowText">
      <span class="trashTags"><span class="tag">主题</span><span class="tag mute">自己删的</span></span>
      <div class="trashTitle">一篇被删掉的主题标题</div>
      <span class="muted">rongrong 的内容 · 由 rongrong 移除 · 2026年9月23日 04:10</span>
    </span>
    <span class="rowActions"><button class="mini primary" type="button">恢复</button><span class="muted trashNo">需站主恢复</span></span>
  </div>
  <p class="muted" id="duressState">✅ 已设置。用它登录会让账号进入保护状态：内容完整保留、账号停用，需要站主手动恢复。</p>

  <!-- 外观设置：配色选择器 + 深浅三档 -->
  <section class="setCard">
    <h3>外观</h3>
    <p class="muted">配色只保存在这台设备上，换设备不会跟着走。</p>
    <div class="palettePicker">
      <button class="palOpt on" type="button" style="--sw:#4f46e5"><span class="palDots"><i style="background:#6d5dfc"></i><i style="background:#4f46e5"></i><i style="background:#e9e6ff"></i></span>星铃紫</button>
      <button class="palOpt" type="button" style="--sw:#1d4ed8"><span class="palDots"><i style="background:#2563eb"></i><i style="background:#1d4ed8"></i><i style="background:#dfe9ff"></i></span>深海蓝</button>
    </div>
    <div class="segRow">
      <button class="segBtn on" type="button">浅色</button>
      <button class="segBtn" type="button">深色</button>
      <button class="segBtn" type="button">跟随系统</button>
    </div>
  </section>

  <!-- 深色底上的强调件：二维码区、密钥行、上传进度条 -->
  <section class="setCard">
    <h3>两步验证 (2FA)</h3>
    <div class="qrWrap"><span class="muted">二维码占位</span></div>
    <div class="secretRow"><code>JBSWY3DPEHPK3PXP</code><button class="mini" type="button">复制</button></div>
    <div class="progress"><i style="width:64%"></i></div>
  </section>

  <div class="admin">
    <div class="adminCard full">
      <div class="adminHead"><h3>用户</h3><span class="muted">匹配 2 / 5</span></div>
      <div class="searchRow adminSearch">
        <input type="search" placeholder="搜索用户名、角色或状态…">
        <button class="mini" type="button">清除</button>
      </div>
      <p class="adminNote">点头像或用户名可以直接打开 TA 的主页。</p>
      <div class="row anim-in">
        <span class="rowMain">
          <span class="avaLink"><span class="ava avaText">荣</span></span>
          <span class="uName"><b class="linkName">荣荣</b><span class="uTags"><span class="tag">管理员</span><span class="tag mute">我自己</span></span></span>
        </span>
        <span class="rowActions"></span>
      </div>
      <div class="row anim-in" style="animation-delay:35ms">
        <span class="rowMain">
          <span class="avaLink"><span class="ava avaText">铃</span></span>
          <span class="uName"><b class="linkName">一个名字特别特别长的普通用户</b><span class="uTags"><span class="tag mute">普通用户</span><span class="tag warn">已封禁</span><span class="tag mute">2FA</span></span></span>
        </span>
        <span class="rowActions"><button class="mini">设为子管理员</button><button class="mini">关闭2FA</button><button class="mini">改密</button><button class="mini">解封</button><button class="mini danger">删号</button></span>
      </div>
    </div>
    <div class="adminCard">
      <h3>主题管理</h3>
      <p class="adminNote">点标题打开主题；右侧按钮直接作用于这一条。</p>
      <div class="row"><span class="rowMain"><span class="rowText"><span class="tag">置顶</span><span class="tag mute">已锁</span><span class="linkName">一个被置顶又锁定的主题标题</span></span></span><span class="rowActions"><button class="mini">置顶</button><button class="mini">锁定</button><button class="mini danger">删帖</button></span></div>
    </div>
    <div class="adminCard">
      <h3>最近内容</h3>
      <div class="row"><span class="rowText"><span class="linkName">一个主题</span> · <span class="muted">荣荣：一段比较长的正文摘要，用来撑一下宽度</span></span><span class="rowActions"><button class="mini danger">删除</button></span></div>
    </div>
  </div>

  <p class="switch">还没有账号？<a href="#">立即注册</a></p>
  <p class="hint">配合 <span class="muted">两步验证</span> 使用更安全</p>
</main>

<!-- 导航抽屉（左上角菜单）：板块行、计数徽标、选中态、外观三档 -->
<aside class="navDrawer open" role="dialog" aria-label="站内导航">
  <div class="navDrawerHead">
    <span class="navDrawerTitle">导航</span>
    <button class="x" type="button" aria-label="关闭导航">×</button>
  </div>
  <div class="navDrawerBody">
    <section class="navSec">
      <h4 class="navSecT">板块</h4>
      <div class="navList">
        <button class="navItem on" type="button"><span class="navTick"></span><span class="navName">全部</span></button>
        <button class="navItem" type="button"><span class="navTick"></span><span class="navName">未分类</span><span class="navN">2</span></button>
        <button class="navItem" type="button"><span class="navTick"></span><span class="navName">一个名字比较长的板块</span><span class="navN">17</span></button>
      </div>
      <button class="mini navAdd" type="button">＋ 新建板块</button>
    </section>
    <section class="navSec">
      <h4 class="navSecT">外观</h4>
      <div class="segRow">
        <button class="segBtn on" type="button">浅色</button>
        <button class="segBtn" type="button">深色</button>
        <button class="segBtn" type="button">跟随系统</button>
      </div>
    </section>
  </div>
</aside>

<div id="toast" class="show">已发布</div>
${dialogs.join('\n')}
`;

const FLAT = `
/* ---- fixture 专用：把 dialog 摊平成静态块，方便一次性截图与审计 ---- */
dialog{position:static;display:block;margin:16px 20px;width:auto;max-width:640px;box-shadow:none;border:1px solid var(--line);max-height:none}
dialog::backdrop{display:none}
dialog>.dlgBody{max-height:none;overflow:visible}
#toast{transform:translate(-50%,0)}

/* 导航抽屉平时是 fixed 浮层、靠 .open 滑入；在 fixture 里让它回到文档流，
   否则它会盖住左边一整条，截出来的图看不清其它组件。
   （.open 的 transform:none 要显式写上，不然还是会被推开到屏幕外） */
.navDrawer{position:static;transform:none;visibility:visible;width:auto;max-width:420px;margin:16px 20px;box-shadow:none;border:1px solid var(--line);border-radius:var(--r-lg)}
.navDrawerBody{overflow:visible}
.navMask{display:none}

/* 关键：无头渲染里动画会停在 0%（.hero>div 这类入场动画的首帧就是 opacity:0），
   getComputedStyle 于是把每个元素都算成全透明，整页配色都测成 1:1。
   审计要的是「动画跑完之后的稳定态」，所以这里直接关掉动画与过渡。
   注意只关动画，不动静态的 opacity 声明（比如 #toast 的 opacity:0 是真实状态）。 */
*,*::before,*::after{animation:none!important;transition:none!important}
`;

function buildPage(palette, mode) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-palette="${palette}" data-theme="${mode}">
<head>
<meta charset="utf-8">
<title>星铃 BBS · UI 配色快照 ${palette}/${mode}</title>
<link rel="stylesheet" href="../../public/style.css">
<style>${FLAT}</style>
</head>
<body>${BODY}
<script src="audit.js"></script>
</body>
</html>
`;
}

// 让 fixture 里的 emoji 头像在深色下也走真实样式
fs.mkdirSync(fixtureDir, { recursive: true });

/* ---------- 2. 无头 Edge 渲染 + 抓报告 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbbs-contrast-'));
const url = 'file:///' + fixture.replace(/\\/g, '/');

function runEdge(extra, target) {
  return execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + tmp,
    '--virtual-time-budget=3000',
    ...extra, target || url
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function audit(palette, mode) {
  fs.writeFileSync(fixture, buildPage(palette, mode));
  const dom = runEdge(['--dump-dom']);
  const m = dom.match(/<script id="__report" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) { console.error(`❌ ${palette}/${mode} 没拿到审计报告（fixture 没能渲染？）`); process.exit(1); }
  return JSON.parse(m[1]);
}

/* ---------- 3. 截图（只拍默认那套，方便肉眼核对） ---------- */
if (process.argv.includes('--shot')) {
  fs.writeFileSync(fixture, buildPage('violet', 'light'));
  const shot = path.join(fixtureDir, 'ui-kit-preview.png');
  runEdge(['--screenshot=' + shot, '--window-size=760,4800']);
  console.log('📸 全组件截图：' + shot);

  // 手机宽度来一张：这一版重点改了移动端，值得单独留档
  const shotMobile = path.join(fixtureDir, 'ui-kit-mobile.png');
  runEdge(['--screenshot=' + shotMobile, '--window-size=390,2600']);
  console.log('📸 手机宽度截图：' + shotMobile);

  // 单独把「账户设置」弹窗拍一张：危险区就是用户最常吐槽的那一块，
  // 单独出图方便直接肉眼核对，不必在长图里找。
  const settings = dialogs.find(d => /id="settingsDialog"/.test(d));
  if (settings) {
    const page2 = `<!DOCTYPE html><html lang="zh-CN" data-palette="violet"><head><meta charset="utf-8">
<link rel="stylesheet" href="../../public/style.css"><style>${FLAT}
body{background:#fff;margin:0;font-family:system-ui,sans-serif;color:#16203a}
dialog{margin:0 auto;max-width:480px;border:0}
</style></head><body>${settings}</body></html>`;
    const p2 = path.join(fixtureDir, 'settings-preview.html');
    fs.writeFileSync(p2, page2);
    const shot2 = path.join(fixtureDir, 'settings-preview.png');
    runEdge(['--screenshot=' + shot2, '--window-size=560,1800'],
      'file:///' + p2.replace(/\\/g, '/'));
    console.log('📸 账户设置截图：' + shot2);
  }
}

/* ---------- 4. 判定 ---------- */
let total = 0, failed = 0, warned = 0;
const worst = [];
const badAll = [];

for (const palette of PALETTES) {
  for (const mode of MODES) {
    const report = audit(palette, mode);
    const bad = report.items.filter(i => !i.pass);
    const warn = report.items.filter(i => i.pass && i.ratio < i.need + 0.6);
    total += report.total; failed += bad.length; warned += warn.length;
    badAll.push(...bad.map(i => ({ ...i, palette, mode })));
    worst.push(...report.items.slice(0, 1).map(i => ({ ...i, palette, mode })));
    console.log(`  ${bad.length ? '❌' : '✅'} ${palette.padEnd(7)} ${mode.padEnd(5)} ${String(report.total).padStart(3)} 组` +
      (bad.length ? ` · ${bad.length} 组不达标` : ' · 全部达标'));
  }
}
console.log(`\n共审计 ${total} 组「前景/背景」配色，阈值 正文 4.5:1 / 大文本 3:1`);

console.log(process.argv.includes('--all') ? '\n每套配色最差的一组：' : '\n每套配色最差的一组（升序）：');
for (const i of worst.sort((a, b) => a.ratio - b.ratio)) {
  console.log(`  ${i.pass ? '✅' : '❌'} ${String(i.ratio).padStart(6)}:1  (需 ${i.need})  ${i.palette}/${i.mode}  ${i.sel}`);
  if (process.argv.includes('--all')) console.log(`         原色 ${i.fg} → 实测前景 ${i.fgFlat} / 背景 ${i.bg}   ${i.size}px ${i.weight}  「${i.text}」`);
}

if (badAll.length) {
  console.log(`\n❌ ${badAll.length} 组不达标：`);
  for (const i of badAll.slice(0, 40)) console.log(`   ${i.palette}/${i.mode}  ${i.ratio}:1 < ${i.need}  ${i.sel}  「${i.text}」`);
  if (badAll.length > 40) console.log(`   …（还有 ${badAll.length - 40} 组）`);
  process.exitCode = 1;
} else {
  console.log('\n✅ 全部达标（WCAG AA）');
}
if (warned) console.log(`\n提示：${warned} 组擦边通过（余量 < 0.6）`);
