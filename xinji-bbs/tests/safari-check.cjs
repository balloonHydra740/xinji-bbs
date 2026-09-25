/* WebKit（Safari / iOS）兼容性静态检查。
 *
 * 为什么需要它：
 *   项目只在本机能起 Chromium（Edge）测，Safari 上那堆「要前缀」「要大版本」的东西
 *   靠肉眼根本看不出来 —— 而且**失效方式特别安静**：
 *     · backdrop-filter 少了 -webkit- 前缀 ⇒ 只是没有毛玻璃，页面照样能用；
 *     · color-mix 不支持 ⇒ 整条 border 简写被丢掉，元素变成「没边框」；
 *     · body{overflow:hidden} 在 iOS 上不吃 ⇒ 抽屉里滚到底整页跟着动。
 *   这些都不会报错，只会「看着怪怪的」，所以让脚本盯着。
 *
 * 原则：能靠「先写纯色、再写新语法」解决的，一律要求同属性兜底
 *       （不支持的浏览器丢掉后一条、留下前一条），而不是指望 @supports 记得写全。
 *
 * 用法：node tests/safari-check.cjs
 */
const fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..');
const R = f => path.join(root, 'public', f);
const css = fs.readFileSync(R('style.css'), 'utf8');
const html = fs.readFileSync(R('index.html'), 'utf8');
const js = fs.readFileSync(R('app.js'), 'utf8') + fs.readFileSync(R('md.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  -> ' + e : '')); };

/* 拆成「选择器 + 声明列表」。@media 内层规则会被拆成独立块（丢了 media 上下文），
   但下面几条规则只看「同一块内有没有退路」，够用。
   注释必须**先**剥掉：注释里写了大括号（比如「body 的 overflow:hidden」这类说明）
   会把按大括号切块的正则带偏。 */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
function blocks(src) {
  const out = [];
  strip(src).replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
    out.push({
      sel: sel.trim(),
      decls: body.split(';').map(s => s.trim()).filter(Boolean),
    });
    return '';
  });
  return out;
}
const B = blocks(css);
const cssCode = strip(css);   // 规则里要「看代码」而不是「看注释」时用这份
const has = (s, re) => re.test(s);
const findBlock = sel => B.find(b => b.sel.replace(/\s+/g, '') === sel.replace(/\s+/g, ''));
/* 收集某属性里用到「新语法」的声明：
   同一属性只要在它前面还写过一条纯色版，不支持的浏览器就会留着前一条 —— 这就是兜底。 */
function collect(prop, need) {
  const miss = [], info = [];
  for (const b of B) {
    for (const d of b.decls) {
      const m = d.match(/^([a-z-]+)\s*:/i);
      if (!m || m[1] !== prop || !need.test(d)) continue;
      // 悬停 / 焦点这类装饰态：丢掉只是「没有高亮」，不判失败，只列出来
      const line = b.sel + ' {' + d + '}';
      if (/:(hover|focus|focus-visible|active)/.test(b.sel)) { info.push(line); continue }
      const idx = b.decls.indexOf(d);
      // border 简写也算 border-color 的退路（简写里本来就带颜色）
      const pat = prop === 'border-color' ? '^border(-color)?\\s*:' : '^' + prop + '\\s*:';
      const before = b.decls.slice(0, idx).filter(x => new RegExp(pat, 'i').test(x));
      const okFallback = before.some(x => !need.test(x));
      (okFallback ? [] : miss).push(line);
    }
  }
  return { miss, info };
}

console.log('\n--- WebKit（Safari / iOS）兼容性 ---');

/* 1. backdrop-filter：Safari 一路都要 -webkit- 前缀（无前缀要 Safari 18 才有） */
{
  const used = B.filter(b => b.decls.some(d => /(^|[^-])backdrop-filter\s*:/.test(d)));
  const bad = used.filter(b => !b.decls.some(d => /-webkit-backdrop-filter\s*:/.test(d)));
  ok('S1 每处 backdrop-filter 都带 -webkit- 前缀', used.length > 0 && bad.length === 0,
    bad.map(b => b.sel).join(' | '));
}

/* 2. appearance:none：标准属性 Safari 15.4 才认，之前只认 -webkit-appearance */
{
  const used = B.filter(b => b.decls.some(d => /(^|[^-])appearance\s*:\s*none/.test(d)));
  const bad = used.filter(b => !b.decls.some(d => /-webkit-appearance\s*:\s*none/.test(d)));
  ok('S2 每处 appearance:none 都带 -webkit-appearance', used.length > 0 && bad.length === 0,
    bad.map(b => b.sel).join(' | '));
}

/* 3. dvh/svh/lvh：Safari 15.4+；必须先用 vh 写一遍，否则老版本拿不到 max-height */
{
  const { miss } = collect('max-height', /[dsl]vh/);
  const { miss: missH } = collect('height', /[dsl]vh/);
  ok('S3 dvh/lvh/svh 都有 vh 兜底', miss.length === 0 && missH.length === 0,
    [...miss, ...missH].join(' | '));
}

/* 4. color-mix：Safari 16.2+。丢掉整条声明最伤的是边框/阴影直接消失 */
{
  const r1 = collect('border', /color-mix\(/), r2 = collect('background', /color-mix\(/),
    r3 = collect('box-shadow', /color-mix\(/), r4 = collect('border-color', /color-mix\(/);
  const miss = [...r1.miss, ...r2.miss, ...r3.miss, ...r4.miss];
  const info = [...r1.info, ...r2.info, ...r3.info, ...r4.info];
  ok('S4 color-mix 的边框/背景/阴影都有纯色兜底', miss.length === 0, miss.join(' | '));
  if (info.length) console.log(`  INFO  悬停/焦点态用了 color-mix ${info.length} 处（丢掉只是没高亮，可接受）`);
}

/* 5. SVG 上的 transform-box：WebKit 对 SVG 子元素的 CSS transform 一路有 bug
     （绕错中心点、过渡不跑）。图标请改用普通行内块 + 绝对定位。 */
ok('S5 没有给 SVG 用 transform-box（WebKit 上会绕错中心）', !has(cssCode, /transform-box\s*:/));

/* 6. iOS 默认给可点元素盖一层灰色高亮 */
ok('S6 有 -webkit-tap-highlight-color（iOS 点击高亮）', has(css, /-webkit-tap-highlight-color/));

/* 7. toast 用 popover 进顶层图层；不支持的 Safari 要能退回 .show 类 */
ok('S7 popover 有非顶层降级（CSS .show + JS 有守卫）',
  has(html, /popover="manual"/) && has(css, /#toast\.show/) && has(js, /showPopover\s*&&/));

/* 8. type=search 在 iOS 上有整套原生样式，不接管就跟旁边按钮不像一套 */
ok('S8 input[type=search] 接管了 appearance',
  !has(html, /type="search"/) || has(css, /input\[type=search\][^{]*\{[^}]*appearance\s*:\s*none/));

/* 9. env(safe-area-inset-*) 只有 viewport-fit=cover 才有值 */
ok('S9 用了安全区内边距就配了 viewport-fit=cover',
  !has(css, /env\(safe-area-inset/) || has(html, /viewport-fit=cover/));

/* 10. Safari 上来得晚的 JS API —— 用了就得自己加 polyfill */
{
  const late = ['structuredClone', 'Object.hasOwn', 'replaceAll', 'URL.canParse', 'Object.groupBy',
    'findLast', 'toSorted', 'withResolvers'];
  const hit = late.filter(k => js.includes(k));
  ok('S10 JS 里没有 Safari 缺席的现代 API', hit.length === 0, hit.join(' / '));
}

/* 11. 锁背景滚动：iOS 不吃 body{overflow:hidden}，必须 position:fixed（配合 top 补偿） */
{
  const b = findBlock('body.navOpen');
  ok('S11 锁滚动用 position:fixed（iOS 只认这个）', !!b && b.decls.some(d => /position\s*:\s*fixed/.test(d)),
    b ? b.decls.join(' ') : '缺少 body.navOpen');
}

/* 12. 浮层里的滚动容器：iOS 橡皮筋会带着整页一起滚 */
{
  const b = findBlock('.navDrawerBody');
  ok('S12 抽屉滚动区带 overscroll-behavior（掐断滚动链）',
    !!b && b.decls.some(d => /overscroll-behavior\s*:/.test(d)), b ? b.decls.join(' ') : '缺少 .navDrawerBody');
}

/* 13. 滚动条槽位：锁滚动时别让桌面端内容横跳 */
ok('S13 html 上留了 scrollbar-gutter（锁滚动不横跳）', has(css, /scrollbar-gutter\s*:\s*stable/));

console.log(`\n=== WebKit 兼容性检查: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
