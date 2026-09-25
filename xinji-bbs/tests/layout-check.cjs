/* 布局回归：按钮不许被挤成两行
 *
 * 起因：管理面板里「删除」竖成了「删 / 除」、「删除板块」断成「删除板 / 块」。
 *
 * 根因是中文在 flex 里的一个坑：flex item 的自动最小尺寸是 min-content，
 * 而中文没有词边界，min-content 宽度 = **一个汉字**宽。于是按钮可以被灵活地
 * 压到只剩一个字宽，文字随之折行 —— 换英文（"Delete" 不可断开）就不会这样。
 * 修法是给按钮 white-space:nowrap 并 flex:0 0 auto，把收缩的活儿交给文字那一栏。
 *
 * 这个测试在不同容器宽度下渲染真实的管理中心结构，逐个数：
 *   · 每个按钮内部的文字占几行（用 Range 的 client rects 按 top 归组，比量高度准）
 *   · 有没有被压到比内容还窄（scrollWidth > clientWidth）
 *   · 行 / 卡片有没有横向溢出
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'admin-rows.html');

const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!EDGE) {
  console.log('⚠️  没找到 Edge，跳过布局检查（可用 EDGE_BIN 环境变量指定浏览器路径）');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbbs-layout-'));
const url = 'file:///' + fixture.replace(/\\/g, '/');
const dom = execFileSync(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--user-data-dir=' + tmp, '--virtual-time-budget=4000', '--window-size=1200,4000',
  '--dump-dom', url
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

const m = dom.match(/<script id="__layout" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) { console.error('❌ 没拿到布局报告（fixture 没能渲染？）'); process.exit(1); }
const report = JSON.parse(m[1]);

const bad = report.items.filter(i => !i.pass);
const buttons = report.items.filter(i => i.kind === 'button');
const aligns = report.items.filter(i => i.kind === 'align');
const actLines = report.items.filter(i => i.kind === 'actline');
const widths = [...new Set(report.items.map(i => i.width))];

console.log(`布局检查：${widths.length} 档容器宽度（${widths.join(' / ')}），共 ${report.total} 项`);

// 每个宽度都挑最窄的那个按钮打出来，方便肉眼扫一眼
for (const w of widths) {
  const bs = buttons.filter(b => b.width === w);
  const narrow = bs.reduce((a, b) => (b.w < a.w ? b : a));
  const al = aligns.filter(a => a.width === w)[0];
  const alines = actLines.filter(a => a.width === w);
  const broken = alines.filter(a => !a.pass).length;
  console.log(`  ${String(w).padStart(6)}  按钮 ${String(bs.length).padStart(2)} 个  ` +
    `最窄「${narrow.text}」${narrow.w}px，${narrow.lines} 行  ${narrow.pass ? '✅' : '❌'}` +
    `   | 按钮组不折行 ${broken ? `❌ ${broken} 组折了` : '✅'}   | 右对齐 ${al ? (al.pass ? '✅' : `❌ 有 ${al.lines} 种`) : '—'}`);
}

if (process.argv.includes('--shot')) {
  const shot = path.join(__dirname, 'fixtures', 'admin-rows-preview.png');
  execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + tmp, '--window-size=880,4200',
    '--virtual-time-budget=3000', '--screenshot=' + shot, url
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  console.log('📸 截图：' + shot);
}

if (bad.length) {
  console.log(`\n❌ ${bad.length} 项不合格：`);
  for (const i of bad.slice(0, 20)) {
    if (i.kind === 'button') {
      console.log(`   ${i.width} 按钮「${i.text}」${i.lines} 行${i.squashed ? '、内容被压窄' : ''}`);
    } else if (i.kind === 'actline') {
      console.log(`   ${i.width} 按钮组「${i.text}」被左边那栏挤得折了 ${i.lines} 行（名字一长按钮就散架）`);
    } else if (i.kind === 'align') {
      console.log(`   ${i.width} 同一行上的按钮组出现了 ${i.lines} 种右边缘（用户名长短不该影响按钮位置）`);
    } else {
      console.log(`   ${i.width} ${i.kind}「${i.text}」横向溢出`);
    }
  }
  process.exitCode = 1;
} else {
  console.log('\n✅ 所有宽度下按钮都是单行、按钮组不散架且右对齐，没有任何溢出');
}
