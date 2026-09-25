/* 跨引擎 / 跨设备的兼容性体检（Chromium · WebKit · Gecko · 触屏）
 *
 * 和 safari-check 的分工：
 *   safari-check 盯的是 WebKit 特有的那几个坑（transform-box、锁滚动、前缀…）；
 *   这里盯的是「写的时候不觉得有问题、换个内核/换台设备就翻车」的一类：
 *
 *   ① 触屏 hover 粘滞 —— iOS/Android 会把 :hover 粘到下一次点击，
 *      点过的卡片一直抬着、关闭按钮一直歪着，看着像布局坏了；
 *   ② color-mix 没有纯色退路 —— 它要 Safari 16.2+，不支持时整条声明被丢掉；
 *   ③ dvh 没有 vh 兜底；
 *   ④ 需要 -webkit- 前缀的属性漏了前缀（Safari 一路都要）；
 *   ⑤ 用了某个引擎缺席的 JS API（requestIdleCallback 在 Safari 压根没有）；
 *   ⑥ popover 这类新 API 没做特性判断就直接调。
 *
 * 用法：node tests/compat-check.cjs
 */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..') + '/';
const css = fs.readFileSync(root + 'public/style.css', 'utf8');
const js = fs.readFileSync(root + 'public/app.js', 'utf8');
const html = fs.readFileSync(root + 'public/index.html', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

// 去掉注释，避免注释里的示例代码被当成真代码
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ---- ① 触屏 hover 粘滞 ---- */
console.log('\n--- 触屏：hover 粘滞 ---');
{
  // 所有带位移/缩放/旋转/阴影的 hover 规则
  const re = /([^{}\n][^{}]*?:hover[^{}]*?)\{([^{}]*)\}/g;
  let m; const movers = [];
  while ((m = re.exec(cssCode))) {
    const sel = m[1].trim().split('\n').pop().trim();
    if (/transform\s*:|box-shadow\s*:/.test(m[2])) movers.push({ sel, body: m[2] });
  }
  // 只看「基础规则」里的（reduced-motion / hover:none 里的复位不算）
  const resetBlock = (cssCode.match(/@media\(hover:none\)\{([\s\S]*?)\n\}/) || ['', ''])[1];
  const reducedBlock = (cssCode.match(/@media\(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/) || ['', ''])[1];
  const base = movers.filter(x => !/transform\s*:\s*none/.test(x.body));

  const inReset = sel => {
    // 复位块里按逗号分隔一个个选择器比对
    return resetBlock.split('}').some(rule => {
      const head = rule.split('{')[0] || '';
      return head.split(',').map(s => s.trim()).includes(sel);
    });
  };
  const missing = base.filter(x => !inReset(x.sel) && !resetBlock.includes(x.sel)).map(x => x.sel);
  ok('A1 带位移的 hover 规则都做了触屏复位', missing.length === 0,
    missing.length ? '漏了：' + missing.join('、') : `共 ${base.length} 条`);

  // 反向：复位块里写的选择器必须真实存在（写错类名会静默失效）
  const heads = resetBlock.split('{')[0];
  const listed = (heads ? heads : '');
  const allHoverSels = new Set(movers.map(x => x.sel));
  const ghosts = listed.split(',').map(s => s.trim()).filter(Boolean).filter(s => !allHoverSels.has(s));
  ok('A2 复位块里没有写错的选择器（写错等于白写）', ghosts.length === 0, ghosts.join('、'));
  ok('A3：复位的是位移，不是颜色（按下反馈要留着）',
    /transform:none/.test(resetBlock) && !/background:none/.test(resetBlock));
  /* 复位块是后写的，会把更前面的 :active 反馈一起压住 ——
     触屏上「按下」只有 :active 这一个出口，丢了这个反馈，按钮就完全没手感了。 */
  ok('A4 复位之后把 :active 的按下反馈还回去了', /:active[^{}]*\{[^}]*transform/.test(resetBlock),
    resetBlock.includes(':active') ? '' : '复位块里没有任何 :active 规则');
  void reducedBlock;
}

/* ---- ② color-mix 的纯色退路 ---- */
console.log('\n--- color-mix 退路 ---');
{
  const lines = cssCode.split('\n');
  const bad = [];
  lines.forEach((line, i) => {
    const m = line.match(/(^|[\s;{])([a-z-]+)\s*:\s*[^;]*color-mix\(/);
    if (!m) return;
    const prop = m[2];
    // 同属性在这个文件里更早出现过、且不含 color-mix 的声明
    const earlier = lines.slice(0, i).some(l => new RegExp(`(^|[\\s;{])${prop}\\s*:[^;]*;`).test(l) && !l.includes('color-mix('));
    // 或者同一行里前面还有一段同属性的纯色声明
    const sameLine = new RegExp(`(^|[\\s;{])${prop}\\s*:[^;]*;[^;]*color-mix\\(`).test(line);
    if (!earlier && !sameLine) bad.push(`第 ${i + 1} 行 ${prop}`);
  });
  ok('B1 每处 color-mix 都有纯色退路', bad.length === 0, bad.join(' | '));
}

/* ---- ③ dvh 的 vh 兜底 ---- */
console.log('\n--- 视口单位兜底 ---');
{
  const lines = cssCode.split('\n');
  const bad = [];
  const newUnit = /(dvh|svh|lvh)\b/;
  lines.forEach((line, i) => {
    if (!newUnit.test(line)) return;
    const decls = line.split(';').map(s => s.trim()).filter(Boolean);
    decls.forEach((d, k) => {
      if (!newUnit.test(d)) return;
      const prop = (d.match(/([a-z-]+)\s*:/) || [])[1];
      if (!prop) return;
      // 兜底可以在同一条规则的前一条声明里，也可以在紧邻的几行里
      const sameRule = decls.slice(0, k).some(x => x.startsWith(prop + ':') && /\d+vh\b/.test(x));
      const prevLine = lines.slice(Math.max(0, i - 3), i).some(l => l.trim().startsWith(prop + ':') && /\d+vh\b/.test(l));
      if (!sameRule && !prevLine) bad.push(`第 ${i + 1} 行 ${prop}`);
    });
  });
  ok('C1 dvh/svh 都在前面留了 vh 兜底（同行或上一行都算）', bad.length === 0, bad.join(' | '));
}

/* ---- ④ 必需 -webkit- 前缀的属性 ---- */
console.log('\n--- WebKit 前缀 ---');
{
  const NEED = ['backdrop-filter', 'appearance', 'line-clamp', 'user-select', 'text-size-adjust', 'tap-highlight-color'];
  const missing = [];
  for (const p of NEED) {
    // 找出所有「裸用」的位置：属性前不是 -webkit-
    const re = new RegExp(`(^|[;{\\s])${p}\\s*:`, 'g');
    let m;
    while ((m = re.exec(cssCode))) {
      const start = m.index + m[1].length;
      const before = cssCode.slice(0, start);
      const prefixed = new RegExp(`-webkit-${p}\\s*:`).test(cssCode.slice(Math.max(0, start - 200), start + 200));
      if (!prefixed) missing.push(p + '@' + (before.split('\n').length));
    }
  }
  ok('D1 带前缀的属性都有 -webkit- 版本', missing.length === 0, missing.slice(0, 5).join(' | '));
  ok('D2 前缀和无前缀两条都写（不是靠 @supports 赌）',
    /-webkit-backdrop-filter/.test(cssCode) && /(?<!-webkit-)backdrop-filter/.test(cssCode));
}

/* ---- ⑤ 引擎缺席的 JS API ---- */
console.log('\n--- JS API 可用性 ---');
{
  // Safari 至今没有 / 或只有部分内核有的
  const BANNED = [
    ['requestIdleCallback', 'Safari 至今不支持'],
    ['scrollIntoViewIfNeeded', '只有 WebKit 的非标准 API'],
    ['document.all', '过时且行为不一致'],
    ['navigator.userAgentData', '只有 Chromium'],
    ['HTMLInputElement.prototype.showPicker', 'Safari 16 之前没有'],
  ];
  const hits = BANNED.filter(([api]) => new RegExp(`[.\\s(]${api.replace('.', '\\.')}\\b`).test(jsCode)).map(([a, why]) => `${a}（${why}）`);
  ok('E1 没有用任何单一内核才有的 API', hits.length === 0, hits.join('、'));

  // popover / showPopover：必须包在 try 或做特性判断
  const popCalls = [...jsCode.matchAll(/showPopover\(/g)];
  const guarded = popCalls.every(m => {
    const around = jsCode.slice(Math.max(0, m.index - 220), m.index + 40);
    return /typeof\s+\w+\.showPopover|\.showPopover\s*&&|try\s*\{/.test(around);
  });
  ok('E2 showPopover 有特性判断或 try（Firefox 125 之前没有）', popCalls.length === 0 || guarded,
    popCalls.length + ' 处调用');

  // dialog 的 showModal 同样（Safari 15.4 之前没有 dialog）
  const modalCalls = [...jsCode.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)\.showModal\(\)/g)];
  ok('E3 showModal 都作用在 <dialog> 元素上（写成普通 div 会抛错）', modalCalls.length > 0,
    '共 ' + modalCalls.length + ' 处');
  /* 这些弹窗 id 必须真的在 HTML 里 —— 调一个不存在的 dialog 会直接把这段逻辑打断，
     而且错在运行时、很难看出来。 */
  const definedIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const ghostDialogs = modalCalls.map(m => m[1]).filter(id => !definedIds.has(id));
  ok('E4 showModal 的目标 id 都在 index.html 里', ghostDialogs.length === 0, ghostDialogs.join('、'));
  ok('E5 没有在不确定存在的元素上直接调 showModal',
    !/\$\([^)]*\)\.showModal\(\)/.test(jsCode.replace(/\$\('#[A-Za-z0-9_-]+'\)\.showModal\(\)/g, '')),
    '除 #id 形式外还有别的调用方式');

  // :popover-open 只在支持 popover 的浏览器里出现，要包 try
  ok('E5 popover 状态查询包了 try（不支持时 matches() 会抛）',
    !/matches\(':popover-open'\)/.test(jsCode) || /try\s*\{[^}]*popover-open/.test(jsCode));
}

/* ---- ⑥ 其他跨引擎细节 ---- */
console.log('\n--- 其他 ---');
{
  ok('F1 scrollbar-gutter 只在宽屏生效（Safari 不支持，别影响移动端）',
    !/scrollbar-gutter/.test(cssCode) || /@media\(min-width:900px\)\{[^}]*scrollbar-gutter/.test(cssCode.replace(/\n/g, '')));
  ok('F2 scroll-behavior 用 smooth 时尊重「减少动态效果」',
    !/scroll-behavior:smooth/.test(cssCode) || /prefers-reduced-motion/.test(cssCode));
  ok('F3 没有用 :has()（Safari 15.4 之前没有，且容易踩性能坑）', !/:has\(/.test(cssCode));
  ok('F4 没有用 @container / view-transition 这类更新查询', !/@container|view-transition/.test(cssCode));
  ok('F5 index.html 没有被引擎过滤掉的私有标签', !/<-webkit|<\?xml|<marquee|<bgsound/i.test(html));
  ok('F6 触屏点击高亮已收（-webkit-tap-highlight-color）', /-webkit-tap-highlight-color/.test(cssCode));
  ok('F7 输入框字号 ≥16px（iOS 聚焦时会自动放大页面，否则布局会"跳一下"）', (() => {
    // 找出 input/textarea 的字号设置；只要不是明显小于 16px 就行
    const m = cssCode.match(/(?:input|textarea|select)[^{}]*\{[^}]*font-size\s*:\s*(?:var\(--fs-[a-z]+\)|(\d+)px)/);
    if (!m) return true;
    if (m[1]) return Number(m[1]) >= 16;
    // 用变量的话，看变量值
    const root = cssCode.match(/--fs-md\s*:\s*(\d+)px/);
    return !root || Number(root[1]) >= 16;
  })());
}

/* ---- ⑦ 长内容不许顶破布局 ---- */
console.log('\n--- 长内容与布局韧性 ---');
{
  /* 真机上出过一次：列表里一条帖子的正文含 58 字符的维基网址（中文自动换行，
     纯 ASCII 不会），grid 的 auto 列被 min-content 撑到 477px，
     于是**所有卡片**一起变宽、整页横向溢出、文字跑到屏幕外。
     两个教训各留一条断言。 */
  const gridRules = [...cssCode.matchAll(/([^{}]+)\{([^{}]*display:grid[^{}]*)\}/g)]
    .map(m => ({ sel: m[1].trim().split('\n').pop().trim(), body: m[2] }));
  const riskyGrid = gridRules.filter(r =>
    !/grid-template-columns/.test(r.body) && !/grid-auto-columns/.test(r.body) && !/place-items|grid-auto-flow/.test(r.body));
  ok('G1 单列 grid 都写了 grid-template-columns:minmax(0,1fr)', riskyGrid.length === 0,
    riskyGrid.map(r => r.sel).join('、') + (riskyGrid.length ? '（auto 列会被超长内容撑破）' : ''));

  // 会装「用户文本 / 远端返回文本」的容器必须能断行
  // 投票里的问题、选项、结果标签、说明全是用户写的字，一并纳入
  const NEEDS_WRAP = ['.thread p', '.postBody', '.muted,.hint', '.toastMsg', '.meta', '.trashTitle', '.qText',
    '.pollHead b', '.pollOptTxt', '.pollResLabel', '.pollFoot', '.pollMini b', '.pollChipHead b'];
  const noWrap = NEEDS_WRAP.filter(sel => {
    // 精确到「类名后面紧跟 { 或 ,」——否则 .postBody 会匹配到 .postBody .att 那一条，
    // .muted,.hint 这种多选择器写法又会匹配不到
    const first = sel.split(',')[0];
    const re = new RegExp('(?:^|\\})\\s*' + first.replace(/\./g, '\\.') + '(?:\\s*,[^{}]*)?\\{([^{}]*)\\}', 'm');
    const m = cssCode.match(re);
    return !m || !/overflow-wrap|word-break/.test(m[1]);
  });
  ok('G2 装用户文本的容器都有断行策略（长网址顶不出去）', noWrap.length === 0, noWrap.join('、'));

  ok('G3 标题允许任意断行（h1-h4）', /h1,h2,h3,h4\{[^}]*overflow-wrap:anywhere/.test(cssCode));
}

console.log('\n=== 跨引擎兼容性体检: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
