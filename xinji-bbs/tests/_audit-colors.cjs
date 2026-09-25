/* 临时审计脚本：把 style.css / index.html / app.js 里的「前景色 + 背景色」
   配对算 WCAG 对比度，列出所有不达标的组合。
   用法： node tests/_audit-colors.cjs */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

/* ---------- 颜色工具 ---------- */
function parse(c, bg) {           // 返回 {r,g,b,a}
  c = String(c).trim();
  let m;
  if ((m = c.match(/^#([0-9a-f]{3})$/i)))
    return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  if ((m = c.match(/^#([0-9a-f]{6})$/i))) {
    const n = parseInt(m[1], 16);
    return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: 1 };
  }
  if ((m = c.match(/^#([0-9a-f]{8})$/i))) {
    const n = parseInt(m[1], 16);
    return { r: n >> 24 & 255, g: n >> 16 & 255, b: n >> 8 & 255, a: (n & 255) / 255 };
  }
  if ((m = c.match(/rgba?\(([^)]+)\)/i))) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
function over(fg, bg) {           // fg 以 alpha 叠加在 bg 上
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}
const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
function ratio(fgs, bgs) {
  let fg = parse(fgs), bg = parse(bgs);
  if (!fg || !bg) return null;
  if (fg.a < 1) fg = over(fg, bg);
  if (bg.a < 1) bg = over(bg, { r: 255, g: 255, b: 255, a: 1 });
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ---------- 变量表（跟 :root 保持一致） ---------- */
const V = {
  '--bg': '#f5f7fb', '--card': 'rgba(255,255,255,.86)', '--text': '#172033',
  '--muted': '#5b6478', '--line': '#e5e9f1', '--accent': '#6d5dfc',
  '--accent2': '#4f46e5', '--white': '#fff', '--cardSolid': '#ffffff',
  '--danger': '#b3251f', '--danger-hi': '#c0292a', '--danger-lo': '#9c1a18',
};
const R = (f, b) => { const v = ratio(f, b); return v == null ? null : v; };

/* ---------- 需要审计的「前景 / 背景」组合 ----------
   背景为 null 时表示继承自页面底色 --bg 上的卡片色。 */
const CASES = [
  // 基础文字
  ['body 正文', V['--text'], V['--bg'], 4.5],
  ['卡片正文 .post/.thread', V['--text'], V['--cardSolid'], 4.5],
  ['.hero p 副标题', V['--muted'], V['--bg'], 4.5],
  ['.author 作者行', V['--muted'], V['--cardSolid'], 4.5],
  ['.thread p 摘要', V['--muted'], V['--cardSolid'], 4.5],
  ['.meta 元信息(12px)', '#8992a5', V['--cardSolid'], 4.5],
  ['.stats small', V['--muted'], V['--cardSolid'], 4.5],
  ['.brand small(11px)', V['--muted'], '#f5f7fb', 4.5],
  ['.muted / .hint 提示', V['--muted'], V['--cardSolid'], 4.5],
  ['.setCard .muted 说明', V['--muted'], '#fcfdff', 4.5],
  ['.pill 标签', V['--accent2'], V['--bg'], 4.5],
  ['.switch 附属文字', V['--muted'], V['--white'], 4.5],
  ['.switch a 链接', V['--accent2'], V['--white'], 4.5],
  ['.back 返回', V['--muted'], V['--bg'], 4.5],
  ['.empty 空态', V['--muted'], V['--cardSolid'], 4.5],
  ['.attMissing', V['--muted'], V['--cardSolid'], 4.5],
  // 按钮
  ['.primary 按钮', '#fff', V['--text'], 4.5],
  ['.primary:hover', '#fff', '#29334a', 4.5],
  ['.ghost 按钮', V['--text'], V['--white'], 4.5],
  ['.mini 按钮(12px)', V['--text'], V['--white'], 4.5],
  ['.x 关闭按钮', V['--text'], '#f2f4f8', 4.5],
  ['.danger 按钮(白字)', '#fff', V['--danger'], 4.5],
  ['.danger:hover 按钮', '#fff', V['--danger-lo'], 4.5],
  ['.mini.danger 按钮', V['--danger'], V['--white'], 4.5],
  // 危险区卡片（截图里的那块）：红底 + 白字，按钮反色成白底红字
  ['危险卡片标题(渐变亮端)', '#fff', V['--danger-hi'], 4.5],
  ['危险卡片说明(白 93%)', 'rgba(255,255,255,.93)', V['--danger-hi'], 4.5],
  ['危险卡片 label', '#fff', V['--danger-lo'], 4.5],
  ['危险卡片按钮(白底红字)', V['--danger'], '#fff', 4.5],
  ['危险卡片按钮 hover', V['--danger-lo'], '#ffedec', 4.5],
  ['危险卡片 placeholder', '#6b7280', '#ffffff', 4.5],
  ['危险卡片禁用态说明', V['--muted'], '#eef1f7', 4.5],
  ['危险卡片禁用态标题', V['--text'], '#eef1f7', 4.5],
  ['attachRow 说明', V['--muted'], V['--cardSolid'], 4.5],
  ['输入框 placeholder', V['--muted'], '#fafbfe', 4.5],
  ['focus 边框(非文本 3:1)', V['--accent'], '#fafbfe', 3],
  ['.att.broken 边框(非文本 3:1)', '#e2908c', '#fff1f1', 3],
  ['.progress 填充(非文本 3:1)', V['--accent2'], '#e7eaf3', 3],
  // 板块 / 标签
  ['.chip 未选中', V['--text'], V['--cardSolid'], 4.5],
  ['.chip.on 选中', '#fff', V['--text'], 4.5],
  ['.chip.on 计数', '#c3cade', V['--text'], 4.5],
  ['.chip.add 新建', V['--accent2'], V['--white'], 4.5],
  ['.tag 普通标签', '#5747dc', '#eeecff', 4.5],
  ['.tag.board 板块标签', V['--accent2'], '#eef0ff', 4.5],
  ['.thumbVideo 计数', V['--muted'], '#f2f4f8', 4.5],
  // 表单 / 弹窗
  ['input 输入文字', V['--text'], '#fafbfe', 4.5],
  ['input placeholder', V['--muted'], '#fafbfe', 4.5],
  ['label 标签', V['--text'], V['--white'], 4.5],
  ['.secretRow code', V['--text'], '#f2f4f8', 4.5],
  ['dialog 正文', V['--text'], V['--white'], 4.5],
  // toast
  ['#toast', '#fff', '#171b2d', 4.5],
  ['.stats b 数字', V['--text'], V['--cardSolid'], 4.5],
];

console.log('\n=== 对比度审计（WCAG AA 普通文本阈值 4.5:1）===\n');
const bad = [];
for (const [name, fg, bg, need] of CASES) {
  const v = R(fg, bg);
  if (v == null) { console.log(`  ？ ${name}  —— 颜色无法解析 (${fg} on ${bg})`); continue; }
  const ok = v >= need;
  if (!ok) bad.push([name, fg, bg, v]);
  console.log(`${ok ? '✅' : '❌'} ${v.toFixed(2).padStart(5)}:1  ${name.padEnd(24)} ${String(fg).padEnd(22)} on ${bg}`);
}
console.log(`\n合计 ${CASES.length} 组，其中不达标 ${bad.length} 组。\n`);
if (bad.length) {
  console.log('--- 需要重新设计 ---');
  for (const [n, f, b, v] of bad) console.log(`  · ${n}  ${v.toFixed(2)}:1  (${f} on ${b})`);
}
