/* 校验前端引用的元素 ID 与 index.html 是否一一对应。
 * 改完 UI 后跑这个，避免出现 $('...') 拿到 null 的运行时错误。
 */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..') + '/';

const html = fs.readFileSync(root + 'public/index.html', 'utf8');
const js = fs.readFileSync(root + 'public/app.js', 'utf8');

// index.html 里定义的全部 id
const defined = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

// app.js 里通过 $('#xxx') / getElementById 引用的 id
const used = new Set();
for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) used.add(m[1]);

// onclick="dialogId.close()" 这类隐式 id 引用
for (const m of html.matchAll(/onclick="([A-Za-z0-9_-]+)\.close\(\)"/g)) used.add(m[1]);

// app.js 用 innerHTML 动态渲染出来的 id（不在静态 HTML 里，属正常）
const dynamic = new Set([...js.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));

const missing = [...used].filter(id => !defined.has(id) && !dynamic.has(id)).sort();

console.log('index.html 定义 id :', defined.size);
console.log('app.js   引用 id   :', used.size);
if (missing.length) {
  console.log('\n❌ app.js 引用了 HTML 中不存在的 id:');
  for (const id of missing) console.log('   - ' + id);
  process.exitCode = 1;
} else {
  console.log('\n✅ 所有引用的 id 都存在');
}

// 反向检查：HTML 里的 id 有没有被误写成重复
const all = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const dup = all.filter((v, i) => all.indexOf(v) !== i);
if (dup.length) { console.log('\n❌ 重复的 id:', [...new Set(dup)]); process.exitCode = 1; }
else console.log('✅ 没有重复 id');

/* 静态 HTML 里的按钮必须有人管。
   「id 存在」只说明拿得到元素，「点了有反应」是另一回事 ——
   回收站的菜单项曾经就是这样：按钮写好了、显隐也接了，唯独忘了绑 onclick，
   于是按钮看得见、点下去毫无反应。这里把每个静态按钮 id 和 app.js 里的绑定对一遍。 */
{
  const menuBlock = (html.match(/<div id="userMenu"[\s\S]*?<\/div>/) || [''])[0];
  const ids = [...menuBlock.matchAll(/<button[^>]*\sid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
  const unbound = ids.filter(id =>
    !new RegExp(`\\$\\('#${id}'\\)\\.onclick`).test(js) &&
    !new RegExp(`\\$\\('#${id}'\\)\\??\\.addEventListener`).test(js) &&
    !new RegExp(`getElementById\\('${id}'\\)\\.onclick`).test(js));
  if (!ids.length) { console.log('❌ 没找到用户菜单（选择器变了？）'); process.exitCode = 1; }
  else if (unbound.length) {
    console.log('\n❌ 用户菜单里这些按钮没有任何点击绑定（点了不会有反应）:', unbound.join(', '));
    process.exitCode = 1;
  } else console.log(`✅ 用户菜单 ${ids.length} 个按钮都绑了点击`);
}

// 检查是否还有第三方 CDN 引用（广告拦截误报的根因）
const cdn = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
if (cdn.length) { console.log('\n❌ 仍存在第三方外链资源:'); cdn.forEach(u => console.log('   - ' + u)); process.exitCode = 1; }
else console.log('✅ 没有任何第三方外链资源（无 CDN 依赖）');

// 确认二维码库是同源加载
if (/<script src="\/vendor\/qrcode\.min\.js"><\/script>/.test(html)) console.log('✅ 二维码库已改为同源加载');
else { console.log('❌ 未找到同源二维码库引用'); process.exitCode = 1; }

// 必须有内联 favicon：否则浏览器会去请求 /favicon.ico 拿到 404，
// 而这个 4xx 会被 Cloudflare 的 NEL 策略上报到 a.nel.cloudflare.com（跨站 → 被当成追踪器）
if (/<link rel="icon" href="data:/.test(html)) console.log('✅ 已内联 favicon（不会产生 /favicon.ico 404）');
else { console.log('❌ 缺少内联 favicon，会触发 NEL 跨站上报'); process.exitCode = 1; }

// 提示条必须能压住弹窗。
// <dialog> 打开时它和 ::backdrop 整个进 top layer，那里面 z-index 是无效的，
// 所以「在弹窗里操作失败」的提示曾经会被弹窗盖住 —— 看起来就是"不在同一图层"。
// 解法是给 toast 挂 popover，让它自己也进 top layer。
if (/<div id="toast"[^>]*popover="manual"/.test(html)) console.log('✅ toast 走 popover（顶层图层，不会被弹窗盖住）');
else { console.log('❌ toast 缺少 popover="manual"，弹窗里的错误提示会被遮住'); process.exitCode = 1; }

// 配色方案：app.js 里的清单与 style.css 里的 data-palette 必须一一对应。
// 两边各写一份就一定会漏，所以让脚本盯着自洽（和 EXT_BY_MIME / sniffType 同一个套路）。
const css = fs.readFileSync(root + 'public/style.css', 'utf8');
const inCss = [...css.matchAll(/\[data-palette="([a-z0-9_-]+)"\]/g)].map(m => m[1]);
const inJs = [...js.matchAll(/\{id:'([a-z0-9_-]+)',\s*name:'[^']+',\s*c:\[/g)].map(m => m[1]);
const missCss = inJs.filter(id => !inCss.includes(id));
const missJs = inCss.filter(id => !inJs.includes(id));
if (!inJs.length) { console.log('❌ app.js 里找不到配色清单 PALETTES'); process.exitCode = 1; }
else if (missCss.length || missJs.length) {
  console.log('❌ 配色清单两边不一致：');
  if (missCss.length) console.log('   style.css 缺少：' + missCss.join(', '));
  if (missJs.length) console.log('   app.js 缺少：' + missJs.join(', '));
  process.exitCode = 1;
} else console.log(`✅ ${inJs.length} 套配色在 JS 与 CSS 中一致（${inJs.join(' / ')}）`);

// 深色模式不能靠「只有浅色测得过」蒙混：每套配色都必须给出深色版本
const missingDark = inJs.filter(id => {
  const block = css.slice(css.indexOf(`[data-palette="${id}"]`));
  return !/--p-accent-d:/.test(block.slice(0, 700));
});
if (missingDark.length) { console.log('❌ 这些配色缺少深色版本 --p-accent-d：' + missingDark.join(', ')); process.exitCode = 1; }
else console.log('✅ 每套配色都带深色版本');
// _headers：静态资源不经 Worker，响应头只能写在这里。
// Nel max_age=0 用来顶掉 Cloudflare 自动加的 NEL 上报策略。
let hdr = '';
try { hdr = fs.readFileSync(root + 'public/_headers', 'utf8'); } catch (e) { /* 下面统一报错 */ }
if (!hdr) console.log('❌ 缺少 public/_headers');
else {
  if (/^\s*Nel:\s*\{[^}]*"max_age"\s*:\s*0/smi.test(hdr)) console.log('✅ _headers 已关闭 Cloudflare NEL 上报');
  else { console.log('❌ _headers 未关闭 NEL 上报（需要 Nel: {"report_to":"cf-nel","max_age":0}）'); process.exitCode = 1; }
  if (/content-security-policy:/i.test(hdr)) console.log('✅ _headers 带 CSP（只允许同源资源）');
  else { console.log('❌ _headers 缺少 CSP'); process.exitCode = 1; }
}
