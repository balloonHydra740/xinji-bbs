/* 突变测试：把这次新加的断言背后的「修复」逐个撤掉，确认对应用例真的变红。
 * 没变红 = 那条断言其实什么都没测。
 * 用法：node tests/_mutate-anon.cjs      （自动备份 → 改 → 跑 → 还原）
 * 不进 npm test，也不进开源包（文件名以 _ 开头，打包脚本会排除 tests/_*）。
 */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = path.join(__dirname, '..') + '/';
const NODE = process.execPath;

const MUTATIONS = [
  {
    name: '匿名 / 输出层不再抹平 author_id',
    file: 'src/index.js',
    from: `return { ...row, username: ANON_NAME, avatar: ANON_AVATAR, bio: '', role: null, author_id: 0, anon: 1 };`,
    to: `return { ...row, username: ANON_NAME, avatar: ANON_AVATAR, bio: '', role: null, anon: 1 };`,
    expect: /A5d|A6b|A7b/,
  },
  {
    name: '匿名 / 头像不再用空白哨兵',
    file: 'src/index.js',
    from: `return { ...row, username: ANON_NAME, avatar: ANON_AVATAR, bio: '', role: null, author_id: 0, anon: 1 };`,
    to: `return { ...row, username: ANON_NAME, bio: '', role: null, author_id: 0, anon: 1 };`,
    expect: /A5c|A6b|A7b/,
  },
  {
    name: '匿名 / 发帖时不换 author_id（记回真人头上）',
    file: 'src/index.js',
    from: `.bind(title,anon?anonId:u.id,body,boardId,sensitive,quote?quote.ref:null,quote?quote.snapshot:null,anon).run();`,
    to: `.bind(title,u.id,body,boardId,sensitive,quote?quote.ref:null,quote?quote.snapshot:null,anon).run();`,
    expect: /A3b|A3c|A12/,
  },
  {
    name: '匿名 / 前端不再渲染空白头像',
    file: 'public/app.js',
    from: `  if (av === ANON_AVATAR) return \`<span class="\${c} avaAnon" aria-hidden="true"></span>\`;`,
    to: `  if (false) return '';`,
    expect: /F1|F2d/,
  },
  {
    name: '匿名 / 前端又给匿名作者生成主页链接',
    file: 'public/app.js',
    from: `  if (!id) return \`<span class="avaLink avaAnonLink">\${inner}</span>\`;`,
    to: `  if (!id) return \`<span class="avaLink" onclick="event.stopPropagation();openUser(\${id})">\${inner}</span>\`;`,
    expect: /F2b|F3 /,
  },
  {
    name: '投票 / 列表摘要不再跟着敏感帖一起糊',
    file: 'public/app.js',
    from: `  return \`<div class="pollMini\${locked?' blurLock':''}">\${ICO_POLL}`,
    to: `  return \`<div class="pollMini">\${ICO_POLL}`,
    expect: /G1 /,
  },
  {
    name: '投票 / 后端不再拦锁定主题的票',
    file: 'src/index.js',
    from: `    if(!isAdmin(u) && await pollTargetLocked(env, p.target_type, p.target_id))
      return json({error:'该主题已锁定，投票已结束'},403);`,
    to: `    if(false) return json({error:'x'},403);`,
    expect: /H2 |H5/,
  },
  {
    name: '投票 / 换帖不清多选勾选状态',
    file: 'public/app.js',
    from: `  pollPicks.clear();\n  rememberQuote('thread',t);`,
    to: `  rememberQuote('thread',t);`,
    expect: /G4b/,
  },
  {
    name: '投票 / 游客又看到「去投票」',
    file: 'public/app.js',
    from: `  const go=!me?(ended?'投票已结束':'登录后投票'):(p.voted?'看结果':(ended?'查看结果':'去投票'));`,
    to: `  const go=(p.voted?'看结果':'去投票');`,
    expect: /G2 /,
  },
  {
    name: '投票 / 投票被丢弃时不再提示',
    file: 'public/app.js',
    from: `toast(wantPoll&&!(d&&d.poll)?'已回复，但投票没挂上：需要一句问题和至少 2 个不同的选项':(anon?'匿名回复已发布':'回复已发布'));`,
    to: `toast('回复已发布');`,
    expect: /F7 /,
  },
  {
    name: '匿名 / 注册又能抢「匿名用户」这个名字',
    file: 'src/index.js',
    from: `    if(username===ANON_NAME) return json({error:'该用户名为系统保留，请换一个'},400);\n    // 注：此处**刻意不加**注册限流。`,
    to: `    // 注：此处**刻意不加**注册限流。`,
    expect: /A13 /,
  },
  {
    name: '匿名 / 用户主页不再排除匿名内容',
    file: 'src/index.js',
    from: `    const notAnonT = \` AND t.is_anon=0\`;\n    const notAnonP = \` AND p.is_anon=0\`;`,
    to: `    const notAnonT = '';\n    const notAnonP = '';`,
    expect: /A12d/,
  },
  {
    name: '匿名 / 用户主页统计不再排除匿名内容',
    file: 'src/index.js',
    from: `        (SELECT COUNT(*) FROM threads WHERE author_id=? AND is_anon=0) threads,\n        (SELECT COUNT(*) FROM posts WHERE author_id=? AND is_anon=0) replies,`,
    to: `        (SELECT COUNT(*) FROM threads WHERE author_id=?) threads,\n        (SELECT COUNT(*) FROM posts WHERE author_id=?) replies,`,
    expect: /A12e/,
  },
];

let bad = 0;
for (const m of MUTATIONS) {
  const p = root + m.file;
  const orig = fs.readFileSync(p, 'utf8');
  if (!orig.includes(m.from)) {
    console.log(`  SKIP  ${m.name}  -> 源码里找不到待改片段（改过源码后要同步这里）`);
    bad++; continue;
  }
  fs.writeFileSync(p, orig.replace(m.from, m.to));
  let out = '';
  try { out = execFileSync(NODE, [root + 'tests/anon-check.cjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  fs.writeFileSync(p, orig);

  const failed = [...out.matchAll(/^\s+FAIL\s+(.+)$/gm)].map(x => x[1]);
  const hit = failed.some(f => m.expect.test(f));
  if (hit) console.log(`  ✅ 变红  ${m.name}  -> ${failed.filter(f => m.expect.test(f)).join(' / ')}`);
  else { console.log(`  ❌ 没变红 ${m.name}  -> 期望匹配 ${m.expect}，实际失败: ${failed.join(' | ') || '（没有失败项）'}`); bad++; }
}
console.log(`\n${bad ? '❌ 有 ' + bad + ' 处突变没被抓住' : '✅ 全部突变都被新的断言抓住了'}`);
if (bad) process.exitCode = 1;
