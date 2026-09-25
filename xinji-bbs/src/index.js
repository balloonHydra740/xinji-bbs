const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
const text = (s) => String(s ?? '').trim();
const encoder = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
async function sha256(s){ return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)))); }

const PASSWORD_ITERATIONS = 10000;
const SESSION_TTL = 1000*60*60*24*14;   // 会话有效期 14 天
const PENDING_2FA_TTL = 1000*60*5;      // 2FA 待验证票据 5 分钟
const MAX_2FA_ATTEMPTS = 5;             // 单张票据最多尝试 5 次
const TOTP_PERIOD = 30;                 // TOTP 时间步长（秒）
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;                  // 允许前后各 1 个时间窗口的时钟漂移
const ISSUER = '星铃BBS';

/* ---------------- 角色 ---------------- */
// user：普通用户；moderator：子管理员（仅内容治理）；admin：管理员（全权）
const ROLE_USER = 'user';
const ROLE_MOD = 'moderator';
const ROLE_ADMIN = 'admin';
const ROLES = [ROLE_USER, ROLE_MOD, ROLE_ADMIN];
const ROLE_LABEL = { [ROLE_USER]:'普通用户', [ROLE_MOD]:'子管理员', [ROLE_ADMIN]:'管理员' };
// 子管理员被允许的治理动作白名单（绝不包含封禁/改密/删号/任命等管理员专属能力）
// moveThread：把主题挪进某个板块，等同于「整理归类」，是可逆的轻量操作，
// 因此并入内容治理；创建与删除板块则严格属于管理员。
// 子管理员白名单：多出来的 'sensitive' 是「把别人的帖子标记/取消标记为不易展示」——
// 和置顶、锁帖一样属于内容治理，且完全可逆，所以一并交给子管理员。
const MOD_ACTIONS = new Set([ 'deletePost', 'deleteThread', 'pin', 'lock', 'moveThread', 'sensitive' ]);
const isMod = (u) => !!u && (u.role === ROLE_MOD || u.role === ROLE_ADMIN);
const isAdmin = (u) => !!u && u.role === ROLE_ADMIN;

async function passwordHash(password, saltB64, iterations = PASSWORD_ITERATIONS) {
  const salt = saltB64
    ? unb64(saltB64)
    : crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    key,
    256
  );

  return `pbkdf2$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const [kind, iterations, salt, hash] = stored.split('$');

  if (kind !== 'pbkdf2') return false;

  const got = (
    await passwordHash(password, salt, Number(iterations))
  ).split('$')[3];

  const a = unb64(got);
  const b = unb64(hash);

  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

/* ---------------- TOTP（RFC 6238）---------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/[\s=]/g, '');
  const out = [];
  let bits = 0, value = 0;
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

// 时间安全的字符串比较
function safeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// HOTP（RFC 4226）：counter 为 64 位大端整数
async function hotp(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const binary =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);

  return String(binary % 1000000).padStart(TOTP_DIGITS, '0');
}

async function totpAt(secretB32, atMs) {
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD);
  return hotp(base32Decode(secretB32), counter);
}

async function verifyTotp(secretB32, code, window = TOTP_WINDOW) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== TOTP_DIGITS || !secretB32) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    if (safeEqualStr(await totpAt(secretB32, now + i * TOTP_PERIOD * 1000), c)) return true;
  }
  return false;
}

function totpUri(username, secretB32) {
  const label = encodeURIComponent(`${ISSUER}:${username}`);
  const issuer = encodeURIComponent(ISSUER);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

/* ---------------- 会话与鉴权 ---------------- */
function cookie(name, value, maxAge){ return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`; }
function getCookie(req,name){ const c=req.headers.get('Cookie')||''; const m=c.match(new RegExp('(?:^|;\\s*)'+name.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')+'=([^;]+)')); return m?.[1]||null; }

async function createSession(env, userId, ttl = SESSION_TTL) {
  const token = randomToken();
  const th = await sha256(token);
  await env.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)`).bind(th, userId, Date.now()+ttl).run();
  return token;
}

async function destroyUserSessions(env, userId) {
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(userId).run();
  await env.DB.prepare(`DELETE FROM pending_2fa WHERE user_id=?`).bind(userId).run();
}

async function currentUser(req,env){
  const token=getCookie(req,'bbs_session'); if(!token) return null;
  const th=await sha256(token);
  // avatar / bio 也一并取出：设置页要回显、publicUser 要输出，取不到就会「保存成功却显示空白」
  // duress_hash / duress_state：设置页要显示「有没有设过胁迫密码」，
  // 而且处在保护状态的账号不该还能拿着旧会话继续用。
  const row=await env.DB.prepare(`SELECT u.id,u.username,u.role,u.banned,u.totp_enabled,u.avatar,u.bio,u.sensitive_filter,u.duress_hash,u.duress_state FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).bind(th,Date.now()).first();
  if(!row) return null; if(row.banned) return {...row,banned:1}; return row;
}

function cleanUsername(v){return text(v).replace(/[^\p{L}\p{N}_-]/gu,'').slice(0,24)}
function cleanTitle(v){return text(v).replace(/\s+/g,' ').slice(0,100)}
function cleanBody(v){return text(v).replace(/\r\n/g,'\n').slice(0,10000)}

/* 编辑痕迹：把「改前 → 改后」落进 post_edits。
   写失败不能连带把编辑本身搞砸 —— 历史是附加价值，正文改动才是用户要的结果。 */
async function recordEdit(env, type, id, editorId, before, after){
  try{
    await env.DB.prepare(`INSERT INTO post_edits(target_type,target_id,editor_id,before_body,after_body) VALUES(?,?,?,?,?)`)
      .bind(type,id,editorId,String(before||''),String(after||'')).run();
  }catch(e){ console.error('recordEdit failed:', e); }
}
function originOK(req){ const origin=req.headers.get('Origin'); return !origin || origin===new URL(req.url).origin; }

async function requireUser(req,env){
  const u=await currentUser(req,env);
  if(!u) throw json({error:'请先登录'},401);
  if(u.banned) throw json({error:'账号已被封禁'},403);
  // 保护状态：触发时已经作废了全部会话，这里再拦一道 ——
  // 万一有并发请求带着旧 cookie 挤进来，也不该还能读能写。
  if(u.duress_state) throw json({error:'该账号处于保护状态，需要站主手动恢复'},403);
  return u;
}
// 需要「管理员」权限（全权）
async function requireAdmin(req,env){ const u=await requireUser(req,env); if(!isAdmin(u)) throw json({error:'需要管理员权限'},403); return u; }
// 需要「子管理员」及以上权限（可做内容治理）
async function requireMod(req,env){ const u=await requireUser(req,env); if(!isMod(u)) throw json({error:'需要子管理员权限'},403); return u; }

// 敏感操作确认：必须提供当前密码；若已开启 2FA，还需 6 位验证码
async function confirmSensitive(env, u, body) {
  // 改密/改名/注销这些都要验当前密码，同样是猜密码的入口，必须限流。
  // 验错不清除计数，验对才清。
  const sKey = `sens:${u.id}`;
  const g = await rlHit(env, sKey, RL.sensitive.limit, RL.sensitive.windowMs);
  if (!g.ok) throw json({error:rlMessage(g)},429);

  const full = await env.DB.prepare(`SELECT password_hash,totp_secret,totp_enabled FROM users WHERE id=?`).bind(u.id).first();
  if (!full) throw json({error:'账号不存在'},404);
  if (!(await verifyPassword(String(body.password||''), full.password_hash))) {
    throw json({error:'当前密码不正确'},401);
  }
  if (full.totp_enabled && !(await verifyTotp(full.totp_secret, body.code))) {
    throw json({error:'两步验证码不正确'},401);
  }
  await rlClear(env, sKey);
  return full;
}

/* 注：删号时**不再**调用「删远端附件」那一步（原来的 purgeUserAttachments 因此删掉了）。
   从 0010 起，删号只是把整包移入回收站，随时可能被恢复 ——
   远端文件一旦清掉，「恢复」回来的就只剩一堆破图。
   真正要腾空间时，站主在回收站里点「彻底删除」，那一步才会连远端一起清
   （见 purgeTrashRow：附件清单存在 trash.payload 里，因为 attachments 行已被外键级联删掉了）。 */

function publicUser(u){
  return {
    id:u.id, username:u.username, role:u.role, totp_enabled:u.totp_enabled?1:0,
    // 头像 / 签名档：列表和详情页都要显示，塞进 /api/status 让前端一次拿到自己的
    avatar: u.avatar||null, bio: u.bio||'',
    // 是否对「不易展示」的内容先模糊。自己那一档偏好，前端靠它决定要不要盖遮罩。
    // 列缺失时（老库还没补齐）按 1 处理：宁可多盖一次，也不要把剧透直接糊到人脸上。
    sensitive_filter: (u.sensitive_filter==null||u.sensitive_filter)?1:0,
    // 有没有设过胁迫密码（设置页要显示状态；哈希本身绝不下发）
    duress_set: u.duress_hash?1:0,
    can_mod: isMod(u)?1:0,          // 可做内容治理（删置顶、锁定、删帖、删回复）
    can_admin: isAdmin(u)?1:0,      // 拥有管理员全权
  };
}

// 布尔字段一律从这里过：前端可能传 true / 1 / '1' / 'on'，也可能压根不传。
// 统一成 0/1 再入库，绝不把 undefined 写进 INTEGER 列（SQLite 会存成 NULL，
// 之后 `WHERE sensitive=0` 就永远筛不到这一行）。
const toFlag = (v) => (v===true||v===1||v==='1'||v==='true'||v==='on')?1:0;

/* ---------------- 点赞与转帖（0009）----------------
   两件事刻意分开存：
     · 点赞 likes —— 一条内容被谁点过，一人一次，可撤销（唯一索引兜底）；
     · 转帖 / 引用 quote_ref —— 把别人的内容挂在自己这条下面（X 的引用转帖）。
       引用只记 ref + **快照**，不建外键：原内容被删之后引用卡照样能显示，
       只是多一句「原内容已删除」，不会整块消失，也不会留下一个点了 404 的死链。

   转帖计数只算**主题**（threads）引用了它：回复里引用别人的帖子属于楼内讨论，
   不产生新的传播，算进「转帖」会让这个数字变得讲不清楚。 */

const QUOTE_EXCERPT = 90;
// 正文 → 引用卡上的一行摘要：剥掉 Markdown 标记与附件占位符，压平空白。
// 服务端自己算，不信前端传 —— 快照是要存进库里给别人看的。
function plainExcerpt(s, n){
  let t = String(s || '').replace(/\[img:\d+\]/g, ' ');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1');
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/(\*\*|__|\*|_|~~)/g, '');
  t = t.replace(/^\s*[-+][ \t]+/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 把前端传来的 {type,id} 变成可入库的 ref + 快照；目标不存在就返回 null（发帖照常成功）
async function buildQuote(env, q){
  if (!q) return null;
  const type = String(q.type) === 'post' ? 'post' : 'thread';
  const id = Number(q.id) || 0;
  if (id <= 0) return null;
  if (type === 'thread') {
    const row = await env.DB.prepare(
      `SELECT t.id,t.title,t.body,t.created_at,t.sensitive,u.username
         FROM threads t JOIN users u ON u.id=t.author_id WHERE t.id=?`).bind(id).first();
    if (!row) return null;
    return {
      ref: 'thread:' + id,
      snapshot: JSON.stringify({
        t:'thread', id, user:row.username, title:row.title,
        excerpt: plainExcerpt(row.body, QUOTE_EXCERPT), at:row.created_at,
        sensitive: row.sensitive ? 1 : 0
      })
    };
  }
  const row = await env.DB.prepare(
    `SELECT p.id,p.thread_id,p.body,p.created_at,p.sensitive,u.username
       FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?`).bind(id).first();
  if (!row) return null;
  return {
    ref: 'post:' + id,
    snapshot: JSON.stringify({
      t:'post', id, tid:row.thread_id, user:row.username,
      excerpt: plainExcerpt(row.body, QUOTE_EXCERPT), at:row.created_at,
      sensitive: row.sensitive ? 1 : 0
    })
  };
}

// 一批内容的点赞数与「我赞过没」。两条查询搞定，不逐条 N+1。
// uid 为 0（游客）时只出数、不出 liked。
async function reactionMap(env, type, ids, uid){
  const map = new Map(ids.map(id => [id, { likes:0, liked:0 }]));
  if (!ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT target_id id, COUNT(*) n FROM likes WHERE target_type=? AND target_id IN (${ph}) GROUP BY target_id`
  ).bind(type, ...ids).all()).results;
  for (const r of rows) { const e = map.get(r.id); if (e) e.likes = Number(r.n || 0); }
  if (uid) {
    const mine = (await env.DB.prepare(
      `SELECT target_id id FROM likes WHERE target_type=? AND user_id=? AND target_id IN (${ph})`
    ).bind(type, uid, ...ids).all()).results;
    for (const r of mine) { const e = map.get(r.id); if (e) e.liked = 1; }
  }
  return map;
}

// 删内容时顺手清掉挂在它上面的赞。
// likes.target_id 没有外键（同一列要指向两张表，做不到），不清就会留下永远读不到的行。
async function purgeLikes(env, type, ids){
  const list = (Array.isArray(ids) ? ids : [ids]).filter(n => Number(n) > 0);
  if (!list.length) return;
  const ph = list.map(() => '?').join(',');
  try { await env.DB.prepare(`DELETE FROM likes WHERE target_type=? AND target_id IN (${ph})`).bind(type, ...list).run(); } catch (e) { }
}

// 某个附件被哪些内容引用了。体检报出坏附件时，站主要知道该去改哪个帖子 ——
// 只给一个「附件 #30 读不出来」等于把球踢回给他。
async function findAttUsage(env, id){
  const like='%[img:'+Number(id)+']%';
  try{
    const t=(await env.DB.prepare(`SELECT id,title FROM threads WHERE body LIKE ? LIMIT 3`).bind(like).all()).results;
    const p=(await env.DB.prepare(`SELECT p.id,p.thread_id,t.title FROM posts p JOIN threads t ON t.id=p.thread_id WHERE p.body LIKE ? LIMIT 3`).bind(like).all()).results;
    return {
      threads: t.map(r=>({ id:r.id, title:r.title })),
      posts: p.map(r=>({ id:r.id, thread_id:r.thread_id, title:r.title }))
    };
  }catch(e){ return { threads:[], posts:[] } }
}

/* ---------------- 投票（0011）----------------
   一条内容最多挂一个投票 —— polls(target_type,target_id) 上的唯一索引兜底，
   并发提交两个也只有一行生效，不会冒出两张并列的投票卡。

   一人一次：靠 **poll_ballots(poll_id,user_id)** 的唯一索引。
   「先查有没有投过再插」有并发窗口，只有数据库这条约束才是真的兜底。
   ⚠️ 票拆成两层是有原因的：如果把 user_id 直接放在「勾选项」那张表上、
      用 UNIQUE(poll_id,user_id) 兜底，那一个人在这个投票里就只能有一行 ——
      多选就成了不可能（勾两个选项 = 两行 = 第二项被唯一索引默默吃掉）。
      所以：选票（ballots）表示「这个人投过一次了」，勾选项（votes）表示「投了哪几项」。
   票数一律**现算**，不存冗余计数字段 —— 存了就得处处维护它和票的一致性，
   而这类数字一旦对不上，用户看到的是「明明投了却显示 0 票」。 */

const POLL_MAX_OPTIONS = 10;    // 选项上限：再多手机上就成了一屏滚不完的列表
const POLL_MAX_Q = 120;         // 问题
const POLL_MAX_OPT = 80;        // 单个选项

function cleanPollText(v, n){ return text(v).replace(/[\r\n\t]/g,' ').replace(/\s+/g,' ').slice(0,n); }

/* 前端传来的 poll → 可入库的形状；不合格返回 null（投票只是附加物，
   它不合格不该连累整条内容发不出去 —— 跟 quote 的处理保持一致）。 */
function normalizePoll(p){
  if(!p || typeof p !== 'object') return null;
  const question = cleanPollText(p.question, POLL_MAX_Q);
  const raw = Array.isArray(p.options) ? p.options : [];
  // 去重：两个一模一样的选项会让「投哪个」变得没有意义
  const seen = new Set(), options = [];
  for(const o of raw){
    const s = cleanPollText(typeof o === 'string' ? o : (o && o.label), POLL_MAX_OPT);
    if(!s || seen.has(s)) continue;
    seen.add(s); options.push(s);
    if(options.length >= POLL_MAX_OPTIONS) break;
  }
  if(!question || options.length < 2) return null;      // 只有一个选项不叫投票
  return { question, options, multi: toFlag(p.multi) };
}

// 建投票 + 选项。返回 polls.id
async function attachPoll(env, type, id, poll){
  if(!poll) return null;
  try{
    const r = await env.DB.prepare(`INSERT INTO polls(target_type,target_id,question,multi) VALUES(?,?,?,?)`)
      .bind(type, id, poll.question, poll.multi).run();
    const pid = Number(r?.meta?.last_row_id || 0);
    if(!pid) return null;
    for(let i=0;i<poll.options.length;i++){
      await env.DB.prepare(`INSERT INTO poll_options(poll_id,label,pos) VALUES(?,?,?)`).bind(pid, poll.options[i], i).run();
    }
    return pid;
  }catch(e){ console.error('attachPoll failed:', e); return null; }
}

// 删投票。票与选项靠外键级联，不需要自己逐条清。
async function deletePoll(env, type, id){
  try{
    const row = await env.DB.prepare(`SELECT id FROM polls WHERE target_type=? AND target_id=?`).bind(type,id).first();
    if(!row) return 0;
    await env.DB.prepare(`DELETE FROM polls WHERE id=?`).bind(row.id).run();
    return 1;
  }catch(e){ return 0 }
}

// 这个投票已经有人投过了吗
async function pollHasVotes(env, pollId){
  try{
    const r = await env.DB.prepare(`SELECT COUNT(*) n FROM poll_ballots WHERE poll_id=?`).bind(pollId).first();
    return Number(r?.n || 0) > 0;
  }catch(e){ return false }
}

// 目标内容还在不在（内容被删/被回收之后不该还能继续投）
async function pollTargetAlive(env, type, id){
  const tbl = type === 'post' ? 'posts' : 'threads';
  try{
    const r = await env.DB.prepare(`SELECT id FROM ${tbl} WHERE id=?`).bind(id).first();
    return !!r;
  }catch(e){ return false }
}

/* 一批内容的投票数据。四条查询搞定，不逐条 N+1。
   total = 参与**人数**（多选时一个人占多行票，所以按 DISTINCT user_id 算）。 */
async function pollMap(env, type, ids, uid){
  const map = new Map();
  const list = (ids || []).filter(n => Number(n) > 0);
  if(!list.length) return map;
  try{
    const ph = list.map(()=>'?').join(',');
    const rows = (await env.DB.prepare(
      `SELECT id,target_id,question,multi FROM polls WHERE target_type=? AND target_id IN (${ph})`
    ).bind(type, ...list).all()).results;
    if(!rows.length) return map;
    const pids = rows.map(r => r.id);
    const oph = pids.map(()=>'?').join(',');
    const opts = (await env.DB.prepare(
      `SELECT id,poll_id,label,pos FROM poll_options WHERE poll_id IN (${oph}) ORDER BY poll_id,pos,id`
    ).bind(...pids).all()).results;
    // 票数按「勾选项」统计，人数按「选票」统计 —— 多选时一个人占多行票、只占一张选票
    const counts = (await env.DB.prepare(
      `SELECT b.poll_id poll_id, v.option_id option_id, COUNT(*) n
         FROM poll_votes v JOIN poll_ballots b ON b.id=v.ballot_id
        WHERE b.poll_id IN (${oph}) GROUP BY b.poll_id, v.option_id`
    ).bind(...pids).all()).results;
    const totals = (await env.DB.prepare(
      `SELECT poll_id, COUNT(*) n FROM poll_ballots WHERE poll_id IN (${oph}) GROUP BY poll_id`
    ).bind(...pids).all()).results;
    const mine = uid ? (await env.DB.prepare(
      `SELECT b.poll_id poll_id, v.option_id option_id
         FROM poll_votes v JOIN poll_ballots b ON b.id=v.ballot_id
        WHERE b.user_id=? AND b.poll_id IN (${oph})`
    ).bind(uid, ...pids).all()).results : [];

    const byPoll = new Map();
    for(const r of rows){
      byPoll.set(r.id, {
        id:r.id, question:r.question, multi:r.multi?1:0,
        total:0, voted:0, mine:[],
        options: opts.filter(o => o.poll_id === r.id).map(o => ({ id:o.id, label:o.label, n:0 }))
      });
    }
    for(const c of counts){
      const p = byPoll.get(c.poll_id); if(!p) continue;
      const o = p.options.find(x => x.id === c.option_id);
      if(o) o.n = Number(c.n || 0);
    }
    for(const t of totals){ const p = byPoll.get(t.poll_id); if(p) p.total = Number(t.n || 0); }
    for(const m of mine){
      const p = byPoll.get(m.poll_id); if(!p) continue;
      p.voted = 1; p.mine.push(m.option_id);
    }
    for(const r of rows) map.set(r.target_id, byPoll.get(r.id));
  }catch(e){ console.error('pollMap failed:', e); }
  return map;
}

/* 投票快照（进回收站用）：定义 + 全部票。
   恢复时按**原 id** 写回 —— 前端渲染的投票卡、以及别人已经投过的票都挂在那些 id 上，
   id 一变，「恢复」回来的就是一个空投票。 */
async function pollSnapshot(env, type, id){
  try{
    const p = await env.DB.prepare(`SELECT id,question,multi,created_at FROM polls WHERE target_type=? AND target_id=?`).bind(type,id).first();
    if(!p) return null;
    const opts = (await env.DB.prepare(`SELECT id,label,pos FROM poll_options WHERE poll_id=? ORDER BY pos,id`).bind(p.id).all()).results;
    const ballots = (await env.DB.prepare(`SELECT id,user_id,created_at FROM poll_ballots WHERE poll_id=? ORDER BY id`).bind(p.id).all()).results;
    const votes = (await env.DB.prepare(
      `SELECT v.ballot_id ballot_id, v.option_id option_id FROM poll_votes v
         JOIN poll_ballots b ON b.id=v.ballot_id WHERE b.poll_id=? ORDER BY v.id`).bind(p.id).all()).results;
    return {
      id:p.id, question:p.question, multi:p.multi?1:0, created_at:p.created_at,
      options: opts.map(o=>({id:o.id,label:o.label,pos:o.pos})),
      ballots: ballots.map(b=>({
        id:b.id, user_id:b.user_id, created_at:b.created_at,
        options: votes.filter(v => v.ballot_id === b.id).map(v => v.option_id)
      }))
    };
  }catch(e){ return null }
}

// 还原快照。用户已被注销的票插不进去（外键），单条跳过即可 —— 少几票好过整条恢复失败。
async function restorePollSnapshot(env, type, id, snap){
  if(!snap || !snap.id) return;
  try{
    const has = await env.DB.prepare(`SELECT id FROM polls WHERE target_type=? AND target_id=?`).bind(type,id).first();
    if(has) return;                                   // 已经有一个了就不覆盖
    await env.DB.prepare(
      `INSERT INTO polls(id,target_type,target_id,question,multi,created_at) VALUES(?,?,?,?,?,COALESCE(?,datetime('now')))`
    ).bind(snap.id, type, id, snap.question||'', snap.multi?1:0, snap.created_at||null).run();
    for(const o of (snap.options||[])){
      try{ await env.DB.prepare(`INSERT INTO poll_options(id,poll_id,label,pos) VALUES(?,?,?,?)`)
        .bind(o.id, snap.id, o.label||'', Number(o.pos)||0).run(); }catch(e){}
    }
    // 选票按原 id 写回；勾选项挂在选票上，用户已注销的那些插不进去（外键），跳过即可 ——
    // 少几票好过整条恢复失败。
    for(const b of (snap.ballots||[])){
      try{
        await env.DB.prepare(
          `INSERT INTO poll_ballots(id,poll_id,user_id,created_at) VALUES(?,?,?,COALESCE(?,datetime('now')))`
        ).bind(b.id, snap.id, b.user_id, b.created_at||null).run();
        for(const oid of (b.options||[])){
          try{ await env.DB.prepare(`INSERT INTO poll_votes(ballot_id,option_id) VALUES(?,?)`).bind(b.id, oid).run(); }catch(e){}
        }
      }catch(e){}
    }
  }catch(e){ console.error('restorePollSnapshot failed:', e); }
}

/* ---------------- 回收站（0010）----------------
   所有删除都改成「先快照、再删」：
     · 整行数据（含 id）存进 trash，恢复时按**原 id** 写回 ——
       id 一变，别人的引用卡（quote_ref）就指向空气了；
     · threads / posts 都是 AUTOINCREMENT，id 只增不复用，所以原 id 一定是空的；
     · 主题的回复各占一条 trash 记录、靠 parent_id 挂回主题 ——
       把整个主题打包成一条 JSON 会顶破 D1 单行 2 MB 的上限。
   谁能恢复：admin 全部；作者本人只能恢复**自己删的**（by_owner=1）。
   管理员删掉的东西放开让作者一键恢复，等于治理动作可以被单方面推翻。 */

function snapRow(row){ try{ return JSON.stringify(row || {}) }catch(e){ return '{}' } }

async function pushTrash(env, rec){
  // 同一对象只留最新一条：恢复后又删，旧记录已经没有意义
  try{ await env.DB.prepare(`DELETE FROM trash WHERE kind=? AND target_id=?`).bind(rec.kind, rec.target_id).run(); }catch(e){}
  const r=await env.DB.prepare(
    `INSERT INTO trash(kind,target_id,parent_id,author_id,author_name,title,excerpt,body,payload,item_count,deleted_by,deleted_by_name,by_owner,was_protected)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(rec.kind, rec.target_id, rec.parent_id ?? null, rec.author_id ?? null, rec.author_name || '',
    rec.title || '', rec.excerpt || '', rec.body || '', rec.payload || '{}', rec.item_count || 1,
    rec.deleted_by ?? null, rec.deleted_by_name || '', rec.by_owner ? 1 : 0, rec.was_protected ? 1 : 0).run();
  // 返回 id：前端删除后要拿它做「撤销」（直接调 /api/trash/restore）
  return r?.meta?.last_row_id ?? null;
}

// 一条回复（含楼中楼里的那层）→ 一条 trash 记录。返回 trash 行 id。
async function trashPost(env, id, actor, parentId){
  const p = await env.DB.prepare(`SELECT p.*,u.username author_name FROM posts p LEFT JOIN users u ON u.id=p.author_id WHERE p.id=?`).bind(id).first();
  if(!p) return null;
  // ⚠️ author_name 是 JOIN 出来的别名，**不属于 posts 表**。
  //    快照会原样写回原表，混进这个字段就会报 "table posts has no column named author_name"。
  const { author_name, ...rest } = p;
  /* 投票跟着一起进快照：内容删了之后 polls 行是要清掉的（不然就是永远读不到的孤儿），
     不先存一份，恢复回来的帖子就只剩正文、投票凭空消失 —— 那这个后悔药是残的。
     `_poll` 这个键**不属于 posts 表**，reinsertRow 前必须摘掉（见 restorePostRow）。 */
  const poll = await pollSnapshot(env, 'post', p.id);
  const snap = poll ? { ...rest, _poll: poll } : rest;
  // 快照存好了才清：恢复时按原 id 写回，别人投过的票也一并回来
  await deletePoll(env, 'post', p.id);
  return await pushTrash(env, {
    kind:'post', target_id:p.id, parent_id: parentId ?? p.thread_id,
    author_id:p.author_id, author_name:author_name || '',
    excerpt: plainExcerpt(p.body, 90), body: p.body, payload: snapRow(snap),
    deleted_by: actor?.id, deleted_by_name: actor?.username || '',
    by_owner: (actor && actor.id === p.author_id) ? 1 : 0,
    was_protected: p.protected ? 1 : 0
  });
}

// 主题 + 它下面**所有**回复 → 一批 trash 记录。返回 {id, items}（id 是主题那条的）
async function trashThread(env, id, actor){
  const t = await env.DB.prepare(`SELECT t.*,u.username author_name FROM threads t LEFT JOIN users u ON u.id=t.author_id WHERE t.id=?`).bind(id).first();
  if(!t) return { id:null, items:0 };
  const { author_name, ...tRest } = t;                 // 同上：别名不能进快照
  const posts = (await env.DB.prepare(`SELECT id FROM posts WHERE thread_id=?`).bind(id).all()).results;
  for(const p of posts) await trashPost(env, p.id, actor, id);
  const tPoll = await pollSnapshot(env, 'thread', t.id);   // 同上：投票先快照再清
  const snap = tPoll ? { ...tRest, _poll: tPoll } : tRest;
  await deletePoll(env, 'thread', t.id);
  const tid = await pushTrash(env, {
    kind:'thread', target_id:t.id, parent_id:null,
    author_id:t.author_id, author_name:author_name || '',
    title:t.title, excerpt: plainExcerpt(t.body, 90), body:t.body, payload: snapRow(snap),
    item_count: posts.length + 1,
    deleted_by: actor?.id, deleted_by_name: actor?.username || '',
    by_owner: (actor && actor.id === t.author_id) ? 1 : 0,
    was_protected: t.protected ? 1 : 0
  });
  return { id:tid, items: posts.length + 1 };
}

/* 账号：用户行 + TA 全部主题 / 回复 + 附件清单。
   ⚠️ 附件只存**元数据**，远端文件不删 —— 删了远端就再也恢复不回来了。
   真要腾空间，走「彻底删除」，那一步才会连远端一起清。 */
async function trashUser(env, userId, actor){
  const u = await env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(userId).first();
  if(!u) return 0;
  const threads = (await env.DB.prepare(`SELECT id FROM threads WHERE author_id=?`).bind(userId).all()).results;
  for(const t of threads) await trashThread(env, t.id, actor);
  const posts = (await env.DB.prepare(`SELECT id FROM posts WHERE author_id=?`).bind(userId).all()).results;
  for(const p of posts) await trashPost(env, p.id, actor, null);
  const atts = (await env.DB.prepare(`SELECT * FROM attachments WHERE owner_id=?`).bind(userId).all()).results;
  const tid = await pushTrash(env, {
    kind:'user', target_id:u.id, parent_id:null, author_id:u.id, author_name:u.username,
    title:u.username,
    excerpt:`${threads.length} 个主题 · ${posts.length} 条回复 · ${atts.length} 个附件`,
    payload: JSON.stringify({ user:u, attachments:atts }),
    item_count: threads.length + posts.length + 1,
    deleted_by: actor?.id, deleted_by_name: actor?.username || '', by_owner:0, was_protected:0
  });
  return { id:tid, items: threads.length + posts.length + 1 };
}

// 把一行快照写回原表。列名从快照的 key 里取（都是我们自己写进去的），
// 这样将来给表加列也不必回来改这里。表名只可能来自下面几个常量，不经过用户输入。
async function reinsertRow(env, table, row){
  const cols = Object.keys(row || {}).filter(k => /^[a-z_]+$/.test(k));
  if(!cols.length) throw new Error('快照是空的，无法恢复');
  const ph = cols.map(() => '?').join(',');
  await env.DB.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${ph})`).bind(...cols.map(c => row[c])).run();
}

// 恢复一条回复。父主题不在就只能作罢 —— 外键会直接拒绝，
// 与其抛一个看不懂的约束错误，不如提前说清楚该先恢复谁。
async function restorePostRow(env, row){
  const p = JSON.parse(row.payload || '{}');
  if(!p.id) throw new Error('快照损坏，无法恢复');
  // _poll 是投票快照，不是 posts 的列 —— 摘出来给 restorePollSnapshot，绝不能进 INSERT
  const poll = p._poll || null; delete p._poll;
  const t = await env.DB.prepare(`SELECT id FROM threads WHERE id=?`).bind(p.thread_id).first();
  if(!t) throw new Error('它所属的主题还没恢复，请先把那个主题恢复回来');
  // 楼中楼：被回复的那条若已不在（单独删了还没恢复），把 reply_to 置空而不是整条恢复失败
  if(p.reply_to){
    const parent = await env.DB.prepare(`SELECT id FROM posts WHERE id=?`).bind(p.reply_to).first();
    if(!parent) p.reply_to = null;
  }
  await reinsertRow(env, 'posts', p);
  await restorePollSnapshot(env, 'post', p.id, poll);
}

// 恢复主题：写回主题本身，再把挂在它下面的回复（含别人的）一起放回去
async function restoreThreadRow(env, row){
  const t = JSON.parse(row.payload || '{}');
  if(!t.id) throw new Error('快照损坏，无法恢复');
  const poll = t._poll || null; delete t._poll;        // 同上：投票快照不能进 INSERT
  await reinsertRow(env, 'threads', t);
  await restorePollSnapshot(env, 'thread', t.id, poll);
  const kids = (await env.DB.prepare(`SELECT * FROM trash WHERE kind='post' AND parent_id=? ORDER BY target_id`).bind(t.id).all()).results;
  let n = 1;
  for(const k of kids){
    try{ await restorePostRow(env, k); n++; }catch(e){ /* 单条失败不拖垮整体 */ }
    try{ await env.DB.prepare(`DELETE FROM trash WHERE id=?`).bind(k.id).run(); }catch(e){}
  }
  return n;
}

// 恢复账号：重建用户行 → 附件索引 → 内容（主题连带回复、以及在别人主题下的回复）
async function restoreUserRow(env, row){
  const data = JSON.parse(row.payload || '{}');
  const u = data.user || {};
  if(!u.id) throw new Error('快照损坏，无法恢复');
  // 用户名可能已经被别人占了 —— 加后缀而不是拒绝恢复（内容比名字重要）
  const taken = await env.DB.prepare(`SELECT id FROM users WHERE username=?`).bind(u.username).first();
  if(taken) u.username = (String(u.username) + '-restored').slice(0, 24);
  await reinsertRow(env, 'users', u);
  for(const a of (data.attachments || [])){ try{ await reinsertRow(env, 'attachments', a) }catch(e){} }
  // 先恢复 TA 的主题（顺带把主题下的回复也放回去），再处理剩下的零散回复
  const threads = (await env.DB.prepare(`SELECT * FROM trash WHERE kind='thread' AND author_id=? ORDER BY target_id`).bind(u.id).all()).results;
  let n = 1;
  for(const t of threads){
    try{ n += await restoreThreadRow(env, t); }catch(e){ /* 单条失败不拖垮整体 */ }
    try{ await env.DB.prepare(`DELETE FROM trash WHERE id=?`).bind(t.id).run(); }catch(e){}
  }
  const posts = (await env.DB.prepare(`SELECT * FROM trash WHERE kind='post' AND author_id=? ORDER BY target_id`).bind(u.id).all()).results;
  for(const p of posts){
    try{ await restorePostRow(env, p); n++; }catch(e){}
    try{ await env.DB.prepare(`DELETE FROM trash WHERE id=?`).bind(p.id).run(); }catch(e){}
  }
  return n;
}

/* 彻底删除：回收站里唯一的不可逆动作，也是唯一会去动远端文件的地方。
   账号条目若已经被恢复过（users 表里又有这行了），就不动远端 ——
   那已经不是「废弃数据」，是活着的用户的东西。 */
async function purgeTrashRow(env, row){
  if(row.kind === 'user'){
    const alive = await env.DB.prepare(`SELECT id FROM users WHERE id=?`).bind(row.target_id).first();
    if(!alive){
      let data = {}; try{ data = JSON.parse(row.payload || '{}') }catch(e){}
      const cfg = await storageConfig(env);
      for(const a of (data.attachments || [])){
        try{ await storeDelete(env, cfg, a.storage_key) }catch(e){}
      }
      try{ await env.DB.prepare(`DELETE FROM attachments WHERE owner_id=?`).bind(row.target_id).run(); }catch(e){}
    }
  }
  await env.DB.prepare(`DELETE FROM trash WHERE id=?`).bind(row.id).run();
}

// 谁能把这条从回收站放回去。由后端算好交给前端，前端别自己判。
function canRestoreTrash(u, row){
  if(!u || !row) return false;
  if(isAdmin(u)) return true;                       // 站主：全部
  if(row.author_id !== u.id) return false;          // 别人的内容轮不到你
  if(row.kind === 'user') return false;             // 账号恢复只有站主能做（人都没了，没法验身份）
  return !!row.by_owner;                            // 自己删的才叫后悔药
}

// 一批内容被转（被主题引用）的次数
async function repostMap(env, type, ids){
  const map = new Map(ids.map(id => [id, 0]));
  if (!ids.length) return map;
  const refs = ids.map(id => type + ':' + id);
  const ph = refs.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT quote_ref ref, COUNT(*) n FROM threads WHERE quote_ref IN (${ph}) GROUP BY quote_ref`
  ).bind(...refs).all()).results;
  for (const r of rows) {
    const m = /:((\d+))$/.exec(String(r.ref || ''));
    if (!m) continue;
    const id = Number(m[1]);
    if (map.has(id)) map.set(id, Number(r.n || 0));
  }
  return map;
}

/* ---------------- 速率限制 ----------------
   为什么必须落库而不是放内存：Workers 的每个 isolate 内存互不相通，
   用内存计数的话，请求换一个边缘节点就重新从 0 开始，等于没限。 */
// 只保留「防猜密码」这一类。**注册与上传刻意不限流**（荣荣 拍板）：
// 论坛要保持开放，按 IP 限注册会误伤共用出口 IP 的真实访客；
// 上传若真被滥用，用管理面板的「清理孤儿附件」回收即可，不必拦着正常人。
const RL = {
  loginUser:  { limit: 8,  windowMs: 10*60*1000 },   // 同一用户名：10 分钟内 8 次失败
  loginIP:    { limit: 20, windowMs: 10*60*1000 },   // 同一 IP：10 分钟内 20 次失败
  sensitive:  { limit: 5,  windowMs: 10*60*1000 },   // 敏感操作验密失败
};

// Cloudflare 会把真实访客 IP 放在 cf-connecting-ip 里
function clientIP(req){
  const h = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  return String(h).split(',')[0].trim();
}

// 命中上限返回 {ok:false, retry:剩余秒}；否则计数 +1 并返回 {ok:true}
async function rlHit(env, key, limit, windowMs){
  const now = Date.now();
  try{
    const row = await env.DB.prepare(`SELECT count, until FROM rate_limits WHERE key=?`).bind(key).first();
    if (row && row.until > now) {
      if (row.count >= limit) return { ok:false, retry: Math.ceil((row.until - now)/1000) };
      await env.DB.prepare(`UPDATE rate_limits SET count=count+1, updated_at=datetime('now') WHERE key=?`).bind(key).run();
      return { ok:true };
    }
    await env.DB.prepare(
      `INSERT INTO rate_limits(key,count,until,updated_at) VALUES(?,?,?,datetime('now'))
       ON CONFLICT(key) DO UPDATE SET count=1, until=excluded.until, updated_at=datetime('now')`
    ).bind(key, 1, now + windowMs).run();
    return { ok:true };
  }catch(e){ return { ok:true }; }   // 限流表出问题时宁可放行，也不能把正常用户锁死
}

// 成功后把计数清掉，别让正常的重试也被累积计入
async function rlClear(env, keys){
  for (const k of [].concat(keys)) {
    try { await env.DB.prepare(`DELETE FROM rate_limits WHERE key=?`).bind(k).run(); } catch(e){}
  }
}

const rlMessage = (g) => `尝试过于频繁，请在 ${Math.max(1, Math.ceil((g.retry||0)/60))} 分钟后再试`;

/* 顺手清掉过期数据：会话、2FA 票据、限流计数。
   挂在登录这类低频动作上，开销可以忽略，却能让这几张表不再无限膨胀。 */
async function sweepExpired(env){
  const now = Date.now();
  try { await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now).run(); } catch(e){}
  try { await env.DB.prepare(`DELETE FROM pending_2fa WHERE expires_at < ?`).bind(now).run(); } catch(e){}
  try { await env.DB.prepare(`DELETE FROM rate_limits WHERE until < ?`).bind(now).run(); } catch(e){}
}

/* ---------------- 数据库结构自检（幂等，防「忘记跑迁移」导致全线 500）----------------
   若线上库尚未应用 0002 迁移，查询 totp_enabled 会因列不存在而报错，
   导致所有需要登录态的接口（发帖/跟帖/管理端）直接 500。
   这里在首次请求时自动补齐所需列与表；已存在则静默跳过，因此可安全重复执行。

   0003 起还需要把 users.role 的 CHECK 从 ('user','admin') 放宽到
   ('user','moderator','admin')，SQLite 不支持修改约束，只能重建表。
   重建被外键引用的表需要 PRAGMA foreign_keys=OFF，而 D1 的 batch 走事务、
   事务内该 PRAGMA 是空操作；因此这里刻意不用 batch，改成「逐条等待完成」
   的默认 autocommit 模式，让关闭外键真正生效。全程不丢任何数据。 */
// 自检标记按「env.DB 这个实例」来记，而不是用一个模块级布尔量。
// 原因：模块级布尔只能保证「每个 isolate 跑一次」；一旦同一个 isolate 里换了库
// （本地测试、或将来接入多个 D1 binding），新库就再也不会自检，结构变更会被静默跳过。
// 用 WeakSet 挂在实际的 DB 对象上，作用域正确，且 env 回收时标记自动消失。
const schemaCheckedDbs = new WeakSet();
const USERS_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','moderator','admin')),
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0`;

// users 表当前的 role 约束是否已支持 moderator？
// 直接读线上 users 表的建表语句来判断，一行数据都不碰，也不依赖任何写入副作用。
//   老库 → ... CHECK(role IN ('user','admin'))            → false
//   新库 → ... CHECK(role IN ('user','moderator','admin')) → true
//
// 两个踩过的坑，这里刻意规避：
//  1) 不能用 `UPDATE users SET role='x' WHERE 1=0` 来探——SQLite 在 0 行命中时会
//     直接跳过 CHECK 求值，老库也会被误判成「已支持」。
//  2) 不能建「同结构模板表」再试插——模板表是自己新建的，永远带新约束，
//     测的是模板而不是线上那张表，同样永远返回 true。
async function roleConstraintOK(env) {
  const row = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).first();
  if (!row || !row.sql) return false;
  const ddl = String(row.sql).replace(/\s+/g, ' ').toLowerCase();
  // 没有 role 的 CHECK 约束（更早的老库）：roles 随便写，视为已支持
  const m = ddl.match(/check\s*\(\s*role\s+in\s*\(([^)]*)\)\s*\)/);
  if (!m) return true;
  return m[1].includes(`'${ROLE_MOD}'`);
}

/* 重建 users 表以放宽 role 约束。保留全部行与列，可安全重复执行。

   【为什么不能用「关外键 + DROP 老表 + RENAME 新表」这个 SQLite 标准姿势】
   线上实测（2026-09-15）踩到的硬事实，记下来免得后人再踩：
     1) D1 **不允许关闭外键**。`PRAGMA foreign_keys=OFF` 在 D1 里是空操作——
        既使在单条语句内设置，也影响不到后续语句（D1 每条 .prepare() 可能走不同连接，
        PRAGMA 是连接级状态，不跨语句保持）。
     2) 因此只要 threads/posts/sessions/pending_2fa 里还有数据指向 users，
        `DROP TABLE users` 必然抛 FOREIGN KEY constraint failed。
     3) `ALTER TABLE ... RENAME TO` 也不是出路：SQLite 3.25+ 会把**子表的外键定义
        一起改写**指向新名字（实测 legacy_alter_table=ON 在 D1 里同样失效），
        于是子表会一直吊在改名后的旧表上，越改越歪。
     4) D1 的 `execute --file` / `batch()` 是**批处理事务**：只要有一条失败就整批回滚，
        不会留下中间态。（这反而是好事，见下。）

   【最终方案：动 users 之前，先把引用它的子表整体重建一遍】
   顺序很关键，必须「叶子 → 根」删、「根 → 叶子」建：
     删：posts → sessions → pending_2fa → threads → users   （先删没人引用的）
     建：users → threads → posts → sessions → pending_2fa   （父表先就位）
   先删子表，users 才不再被任何外键引用，`DROP TABLE users` 才合法。
   数据不能丢，所以第一步先把各表整表快照到 snap_* 临时表（无约束，纯数据），
   重建完再从快照回填，最后清掉快照。

   全程塞进一个 `env.DB.batch()`：D1 保证批内原子性，中途任何一步失败都整体回滚，
   绝不会出现「users 没了但子表还在」这种更糟的中间态。 */
async function widenRoleConstraint(env) {
  if (await roleConstraintOK(env)) return;              // 新库 / 已升级过，直接跳过

  // 0004 之前的库没有 attachments。这里只读一次 sqlite_master 拿到「真实存在的表」，
  // 让「已有附件的库」和「还没附件的老库」都能走同一套重建流程，互不干扰。
  const names = new Set((await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'`
  ).all()).results.map(r => r.name));

  const SNAP = {
    users:'snap_users', threads:'snap_threads', posts:'snap_posts',
    sessions:'snap_sessions', pending_2fa:'snap_pending_2fa', attachments:'snap_attachments',
    boards:'snap_boards'
  };
  const tables = Object.keys(SNAP).filter(t => names.has(t));
  const stmts = [];

  // ① 快照：CREATE TABLE snap_x AS SELECT * FROM x —— 不带任何约束，纯粹的数据副本
  for (const t of tables) {
    stmts.push(env.DB.prepare(`DROP TABLE IF EXISTS ${SNAP[t]}`));
    stmts.push(env.DB.prepare(`CREATE TABLE ${SNAP[t]} AS SELECT * FROM ${t}`));
  }
  // ② 按「叶子 → 根」删除，此时每张表都不再被引用。
  //    attachments 引用了 users，必须排在 posts 之前删掉，否则 DROP 会被外键拒绝。
  //    boards 夹在中间：threads 引用了它（所以必须排在 threads 之后），
  //    它又引用了 users（所以必须排在 users 之前）—— 顺序错了就是外键报错。
  for (const t of ['attachments','posts','pending_2fa','sessions','threads','boards','users']) {
    if (!names.has(t)) continue;
    stmts.push(env.DB.prepare(`DROP TABLE IF EXISTS ${t}`));
  }
  // ③ 按「根 → 叶子」重建；只有 users 换了新的 role 约束，其余原样恢复
  stmts.push(env.DB.prepare(`CREATE TABLE users(${USERS_COLUMNS})`));
  //    boards 引用 users，必须在 users 之后、threads 之前建（boards 是 threads 的父表）
  if (names.has('boards')) stmts.push(env.DB.prepare(`CREATE TABLE boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`));
  stmts.push(env.DB.prepare(`CREATE TABLE threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))` +
      // boards 不存在时绝不能写 REFERENCES boards(id)：外键指向不存在的表会直接
      // 报 "no such table: main.boards"。这种情况交给后面的 ensureBoards 用 ALTER 补。
      (names.has('boards') ? `, board_id INTEGER REFERENCES boards(id) ON DELETE SET NULL` : '') + `
    )`));
  stmts.push(env.DB.prepare(`CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`));
  stmts.push(env.DB.prepare(`CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )`));
  stmts.push(env.DB.prepare(`CREATE TABLE pending_2fa (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`));
  if (names.has('attachments')) stmts.push(env.DB.prepare(`CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      original_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`));
  // ④ 从快照回填。老库可能缺 totp_* 列，按实际列名拼 SELECT，缺失的补默认值。
  const cols = (await env.DB.prepare(`PRAGMA table_info(${SNAP.users})`).all()).results.map(c => c.name);
  const pick = (name, fallback) => cols.includes(name) ? name : fallback;
  const usersSel = ['id','username','password_hash','role','banned','created_at',
    pick('totp_secret', `NULL AS totp_secret`),
    pick('totp_enabled', `0 AS totp_enabled`)].join(',');
  stmts.push(env.DB.prepare(`INSERT INTO users(id,username,password_hash,role,banned,created_at,totp_secret,totp_enabled)
                             SELECT ${usersSel} FROM ${SNAP.users}`));
  if (names.has('boards')) stmts.push(env.DB.prepare(`INSERT INTO boards SELECT * FROM ${SNAP.boards}`));
  // 快照里可能没有 board_id（0006 之前的库），而重建出来的 threads 已经带这一列，
  // 所以必须**写死列名**再 INSERT，`SELECT *` 会因列数不等直接报错。
  // 注意要在这时（建表语句真正执行之前）读**原表**的列名：snap_* 表要等 batch
  // 跑起来才存在，现在 PRAGMA 它只会得到空结果。
  const tCols = (await env.DB.prepare(`PRAGMA table_info(threads)`).all()).results.map(c => c.name).join(',');
  stmts.push(env.DB.prepare(`INSERT INTO threads(${tCols}) SELECT ${tCols} FROM ${SNAP.threads}`));
  stmts.push(env.DB.prepare(`INSERT INTO posts SELECT * FROM ${SNAP.posts}`));
  stmts.push(env.DB.prepare(`INSERT INTO sessions SELECT * FROM ${SNAP.sessions}`));
  stmts.push(env.DB.prepare(`INSERT INTO pending_2fa SELECT * FROM ${SNAP.pending_2fa}`));
  if (names.has('attachments')) stmts.push(env.DB.prepare(`INSERT INTO attachments SELECT * FROM ${SNAP.attachments}`));
  // ⑤ 重建索引（0001 / 0004 建过的那些）
  stmts.push(env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`));
  if (names.has('boards')) stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_boards_name ON boards(name)`));
  stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_threads_sort ON threads(pinned DESC, updated_at DESC)`));
  if (names.has('boards')) stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_threads_board ON threads(board_id)`));
  stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id)`));
  stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`));
  stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_2fa_expires ON pending_2fa(expires_at)`));
  stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_2fa_user ON pending_2fa(user_id)`));
  if (names.has('attachments')) {
    stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_id)`));
    stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at)`));
  }
  // ⑥ 清理快照
  for (const t of tables) stmts.push(env.DB.prepare(`DROP TABLE IF EXISTS ${SNAP[t]}`));

  await env.DB.batch(stmts);   // 原子执行：要么全部生效，要么整体回滚
}

async function ensureSchema(env) {
  const key = env.DB;
  if (key && typeof key === 'object') {
    if (schemaCheckedDbs.has(key)) return;
    schemaCheckedDbs.add(key);
  }
  const ddl = [
    `ALTER TABLE users ADD COLUMN totp_secret TEXT`,
    `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS pending_2fa (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pending_2fa_expires ON pending_2fa(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_pending_2fa_user ON pending_2fa(user_id)`,
    // ---- 0004：站点设置与附件 ----
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      original_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at)`,
    // ---- 0005：速率限制 ----
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      until INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rate_limits_until ON rate_limits(until)`
  ];
  for (const sql of ddl) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 列/表已存在，忽略 */ }
  }
  // 先把历史脏角色归一，再重建表（顺序不能反：带着脏数据重建会撞上 CHECK）
  try { await env.DB.prepare(`UPDATE users SET role='user' WHERE role IS NULL OR role NOT IN ('user','moderator','admin')`).run(); } catch (e) { }
  try { await widenRoleConstraint(env); } catch (e) { console.error('widenRoleConstraint failed:', e); }
  // 板块结构放在 widen **之后**补：widen 会按写死的建表语句重建 users/threads，
  // 若此时已存在 boards（它引用 users），`DROP TABLE users` 会被外键拒绝，整批回滚、
  // 角色约束就永远放宽不了（E10/E11 踩过）。放在后面则天然避开这个死结。
  await ensureBoards(env);
  // 0007 同理：posts / users 的新列与 post_edits 都要等 widen 重建完再补，
  // 否则要么列数对不上、要么外键把 DROP 挡住。
  await ensureFeatures(env);
  // 0008 同样等 widen 之后补：posts / threads 的新列插在 widen 之前会让
  // `INSERT INTO posts SELECT * FROM snap_posts` 因列数不等整批回滚。
  await ensureSensitive(env);
  // 0009 点赞 / 引用：同样只能排在 widen 之后（理由见函数上方注释）
  await ensureReactions(env);
  // 0010 回收站 / 保护 / 胁迫密码：同上
  await ensureModeration(env);
  // 0011 投票：poll_votes 引用 users，同样只能排在 widen 之后
  await ensurePolls(env);

  await createRoleGuards(env);
}

/* 0008：不易展示（剧透 / 公共场合不宜）标记。
      threads.sensitive / posts.sensitive —— 内容被标记为「不易展示」
      users.sensitive_filter              —— 该用户是否要先把这类内容模糊掉
   三个列都带 DEFAULT，老库自动补齐；放在 widen 之后（理由见 migrations/0008_sensitive.sql）。 */
async function ensureSensitive(env) {
  const ddl = [
    `ALTER TABLE threads ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE posts ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN sensitive_filter INTEGER NOT NULL DEFAULT 1`
  ];
  for (const sql of ddl) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在，忽略 */ }
  }
}

/* 0009：点赞与转帖（引用）。
   likes 引用 users、quote_* 长在 threads / posts 上，两点都要求它排在 widen **之后**
   （理由同 0007 / 0008：带着新列重建表会因列数不等整批回滚，
    提前建 likes 又会让 widen 的 DROP TABLE users 被外键拒绝）。 */
async function ensureReactions(env) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK(target_type IN ('thread','post')),
      target_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // 一人一次：唯一索引是唯一可靠的兜底 —— 并发点两下也只有一行生效
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_one ON likes(target_type,target_id,user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type,target_id)`,
    `CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id)`,
    `ALTER TABLE threads ADD COLUMN quote_ref TEXT`,
    `ALTER TABLE threads ADD COLUMN quote_snapshot TEXT`,
    `ALTER TABLE posts ADD COLUMN quote_ref TEXT`,
    `ALTER TABLE posts ADD COLUMN quote_snapshot TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_threads_quote ON threads(quote_ref)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_quote ON posts(quote_ref)`
  ];
  for (const sql of ddl) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在，忽略 */ }
  }
}

/* 0010：回收站 / 内容保护 / 胁迫密码。
   同样只能排在 widen **之后**（threads / posts / users 三张表都动到了）。 */
async function ensureModeration(env) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS trash (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('thread','post','user')),
      target_id INTEGER NOT NULL,
      parent_id INTEGER,
      author_id INTEGER,
      author_name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      item_count INTEGER NOT NULL DEFAULT 1,
      deleted_by INTEGER,
      deleted_by_name TEXT NOT NULL DEFAULT '',
      by_owner INTEGER NOT NULL DEFAULT 0,
      was_protected INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_trash_author ON trash(author_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_trash_parent ON trash(parent_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash(deleted_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_trash_kind ON trash(kind, target_id)`,
    `ALTER TABLE threads ADD COLUMN protected INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE threads ADD COLUMN protected_at TEXT`,
    `ALTER TABLE posts ADD COLUMN protected INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE posts ADD COLUMN protected_at TEXT`,
    `ALTER TABLE users ADD COLUMN duress_hash TEXT`,
    `ALTER TABLE users ADD COLUMN duress_state INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN duress_at TEXT`,
    `ALTER TABLE users ADD COLUMN duress_by TEXT`
  ];
  for (const sql of ddl) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在，忽略 */ }
  }
}

/* 0011：投票。
   三张表都不改建任何老表，但 poll_votes 引用 users ——
   排在 widen **之后**是硬要求（提前建会让 widen 的 DROP TABLE users 被外键拒绝）。 */
async function ensurePolls(env) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK(target_type IN ('thread','post')),
      target_id INTEGER NOT NULL,
      question TEXT NOT NULL DEFAULT '',
      multi INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_target ON polls(target_type, target_id)`,
    `CREATE INDEX IF NOT EXISTS idx_polls_created ON polls(created_at)`,
    `CREATE TABLE IF NOT EXISTS poll_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      pos INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, pos)`,
    // 选票：一个账号对一个投票的**一次**投票（唯一索引 = 一人一次的兜底）
    `CREATE TABLE IF NOT EXISTS poll_ballots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_ballots_one ON poll_ballots(poll_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_poll_ballots_poll ON poll_ballots(poll_id)`,
    `CREATE INDEX IF NOT EXISTS idx_poll_ballots_user ON poll_ballots(user_id)`,
    // 勾选项：挂在选票下面，多选时一个选票有多个勾选项
    `CREATE TABLE IF NOT EXISTS poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ballot_id INTEGER NOT NULL REFERENCES poll_ballots(id) ON DELETE CASCADE,
      option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_ballot ON poll_votes(ballot_id, option_id)`,
    `CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(option_id)`
  ];
  for (const sql of ddl) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在，忽略 */ }
  }
}

/* 0007：楼中楼、编辑痕迹、用户资料。
   放在 widen 之后（理由见 migrations/0007_features.sql 顶部注释）。 */
async function ensureFeatures(env) {
  const ddl = [
    `ALTER TABLE users ADD COLUMN avatar TEXT`,
    `ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE posts ADD COLUMN reply_to INTEGER REFERENCES posts(id) ON DELETE SET NULL`,
    `ALTER TABLE posts ADD COLUMN edited_at TEXT`,
    `ALTER TABLE threads ADD COLUMN edited_at TEXT`,
    `CREATE TABLE IF NOT EXISTS post_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK(target_type IN ('thread','post')),
      target_id INTEGER NOT NULL,
      editor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      before_body TEXT NOT NULL DEFAULT '',
      after_body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_post_edits_target ON post_edits(target_type, target_id, id)`,
    `CREATE INDEX IF NOT EXISTS idx_post_edits_editor ON post_edits(editor_id)`
  ];
  for (const sql of ddl) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在，忽略 */ }
  }
}

/* 0006：讨论板块。单独拆出来是因为要执行两次（见上）。 */
async function ensureBoards(env) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_boards_name ON boards(name)`,
    `ALTER TABLE threads ADD COLUMN board_id INTEGER REFERENCES boards(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_threads_board ON threads(board_id)`
  ];
  for (const sql of ddl) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 表/列已存在，忽略 */ }
  }
}

// 板块名字：保留中英文、数字、下划线与常见标点，压缩空白后截断
function cleanBoardName(v){ return text(v).replace(/[\r\n\t]/g,' ').replace(/\s+/g,' ').slice(0,24); }
function cleanBoardDesc(v){ return text(v).replace(/[\r\n\t]/g,' ').replace(/\s+/g,' ').slice(0,200); }

/* 0003 之后仍需补齐的角色约束（老库由重建表搞定，这里主要服务「0002 之后新建的空库」）。
   SQLite 不允许 ADD CONSTRAINT，除重建表之外的另一条路是触发器。
   下面两个触发器等价于 CHECK(role IN (...))；用 WHEN … 而非直接调用 RAISE(...)，兼容性更好。 */
async function createRoleGuards(env) {
  const guards = [
    `CREATE TRIGGER IF NOT EXISTS trg_users_role_insert BEFORE INSERT ON users
       WHEN NEW.role IS NULL OR NEW.role NOT IN ('user','moderator','admin')
       BEGIN SELECT RAISE(ABORT, 'invalid role'); END`,
    `CREATE TRIGGER IF NOT EXISTS trg_users_role_update BEFORE UPDATE OF role ON users
       WHEN NEW.role IS NULL OR NEW.role NOT IN ('user','moderator','admin')
       BEGIN SELECT RAISE(ABORT, 'invalid role'); END`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
  ];
  for (const sql of guards) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* ignore */ }
  }
}

/* ---------------- 附件存储（0004）----------------
   二进制本体一律放外部存储，D1 只留索引。这样 D1 不会因为图片视频迅速膨胀，
   也不会撞单行 2 MB 的上限。 */

// 单文件上限 30 MB。原来定 20 MB 是按图片/短视频估的，
// 音频进来之后不够用：WAV 一分钟就 10 MB 上下，无损 FLAC 更大。
// 默认上限只是「出厂值」，管理员可以在管理面板里改，也可以改成 0 = 不限制。
const DEFAULT_UPLOAD_MB = 30;
const DEFAULT_AVATAR_MB = 2;   // 头像单独卡一道：它最终只显示成 66px 的圆
// Workers 请求体的硬上限（平台层面，代码拦不住）：超过它请求根本到不了 Worker。
// 面板里允许填更大的数，但要提示站主这是平台给的墙，不是本站的限制。
const PLATFORM_MAX_MB = 100;

/* 读取当前生效的上传上限（字节）。放在库里而不是写死在代码里：
   站主要能随时调，不能每次改个数都重新部署一遍。

   ⚠️ 一定要再夹到 PLATFORM_MAX_MB。曾经这里直接返回库里的值，
   有人把上限填成 4000 MB —— 于是前端放行了一个几百 MB 的文件，
   客户端吭哧吭哧把字节发完，而请求体早就在 Cloudflare 边缘被挡掉了，
   **Worker 根本没被调用，也就没有任何响应可以回**。
   表现就是「进度条走到头然后一直卡着」。夹住之后最多 100 MB，
   超了能在 Worker 里立刻回一个明确的 413。 */
async function uploadLimitBytes(env, kind) {
  const key = kind === 'avatar' ? 'avatar_limit_mb' : 'upload_limit_mb';
  const def = kind === 'avatar' ? DEFAULT_AVATAR_MB : DEFAULT_UPLOAD_MB;
  const raw = await getSetting(env, key);
  const mb = raw === null || raw === '' ? def : Number(raw);
  const cap = PLATFORM_MAX_MB * 1024 * 1024;
  if (!Number.isFinite(mb) || mb < 0) return Math.min(def, PLATFORM_MAX_MB) * 1024 * 1024;
  if (mb <= 0) return cap;                                        // 「不限制」也就是平台的墙
  return Math.min(mb, PLATFORM_MAX_MB) * 1024 * 1024;
}
const MAX_IMPORT_BYTES = 60 * 1024 * 1024;   // 还原包上限（受 Workers 128 MB 内存约束）
// 允许的类型一律以**魔法字节探测结果**为准，不信任浏览器上报的 Content-Type
// （后者随便伪造，而且同一个扩展名在不同系统上报出来的值还不统一）
const EXT_BY_MIME = {
  // 图片
  'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif',
  'image/avif':'avif', 'image/heic':'heic',
  // 视频
  'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov',
  // 音频：容器比视频还杂，扩展名一律取最常见的那个
  'audio/mpeg':'mp3',   // MP3（ID3 标签或裸 MPEG 帧）
  'audio/mp4':'m4a',    // M4A / AAC 装在 MP4 容器里
  'audio/aac':'aac',    // 裸 ADTS AAC 流
  'audio/wav':'wav', 'audio/ogg':'ogg', 'audio/opus':'opus',
  'audio/flac':'flac', 'audio/webm':'weba', 'audio/aiff':'aiff',
  'audio/amr':'amr', 'audio/midi':'mid'
};

const HEAD_SCAN = 65536;   // 容器头里的轨道信息都在前 64 KB，没必要扫全文件

/* 扩展名 → MIME 的反查表，只用来给**老附件**兜底。
   为什么需要：X-Content-Type-Options:nosniff 之下，浏览器只肯把
   声明成 image/* 的响应当图片渲染。而 WebDAV 服务器（尤其网盘）
   经常对图片也回 application/octet-stream —— 于是「有的附件就是打不开」，
   偏偏是最早那批没存下 mime 的文件。 */
const MIME_BY_EXT = (() => {
  const m = {};
  for (const [mime, ext] of Object.entries(EXT_BY_MIME)) if (!m[ext]) m[ext] = mime;
  // 补几个常见的别名（上传路径不会产出这些扩展名，但手工放进网盘的文件可能长这样）
  Object.assign(m, {
    jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heic',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
    weba: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff', amr: 'audio/amr', mid: 'audio/midi',
  });
  return m;
})();

// 附件该用哪个 Content-Type：入库时按魔法字节判定的最可信，
// 其次是存储服务给的，最后按存储路径的扩展名猜 —— 猜错了至少是「能显示」而不是「打不开」。
function fileMime(row, got) {
  const clean = v => { const s = String(v || '').trim(); return (s && s !== 'application/octet-stream') ? s : '' };
  const fromRow = clean(row && row.mime);
  if (fromRow) return fromRow;
  const fromStore = clean(got && got.mime);
  if (fromStore) return fromStore;
  const key = String((row && row.storage_key) || '');
  const ext = key.includes('.') ? key.split('.').pop().toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// 在字节流里找一段 ASCII。只扫前 limit 个字节。
function findBytes(u8, ascii, limit) {
  const n = ascii.length, lim = Math.min(u8.length, limit);
  for (let i = 0; i + n <= lim; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) { if (u8[i + j] !== ascii.charCodeAt(j)) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}

/* 魔法字节探测。顺序有讲究：
   · 越「专」的越靠前 —— RIFF 只是个外壳，得先看第 8 字节起的 form type 才知道是 WEBP 还是 WAVE；
   · 越「泛」的越靠后 —— MP3 的帧同步只看两个字节，放最后才不会把别人误认成音频。 */
function sniffType(u8) {
  const tag = (o, n) => String.fromCharCode(...u8.slice(o, o + n));
  const has = (s) => findBytes(u8, s, HEAD_SCAN);

  if (u8.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'image/jpeg';
  if (u8.length >= 8 && tag(0, 4) === '\x89PNG') return 'image/png';
  if (u8.length >= 6 && tag(0, 3) === 'GIF') return 'image/gif';
  if (u8.length >= 4 && tag(0, 4) === 'fLaC') return 'audio/flac';
  if (u8.length >= 4 && tag(0, 4) === 'OggS') return has('OpusHead') ? 'audio/opus' : 'audio/ogg';
  if (u8.length >= 12 && tag(0, 4) === 'FORM' && (tag(8, 4) === 'AIFF' || tag(8, 4) === 'AIFC')) return 'audio/aiff';
  if (u8.length >= 5 && tag(0, 5) === '#!AMR') return 'audio/amr';
  if (u8.length >= 4 && tag(0, 4) === 'MThd') return 'audio/midi';

  // RIFF 家族：前 4 字节都一样，靠 form type 区分图片还是音频
  if (u8.length >= 12 && tag(0, 4) === 'RIFF') {
    const form = tag(8, 4);
    if (form === 'WEBP') return 'image/webp';
    if (form === 'WAVE') return 'audio/wav';
  }

  if (u8.length >= 3 && tag(0, 3) === 'ID3') return 'audio/mpeg';
  // ADTS AAC 与 MPEG 音频都以 0xFF 开头，靠第二个字节区分：
  //   AAC 要求 (b1 & 0xF6) === 0xF0（0xF1 / 0xF9），MP3 则只需 (b1 & 0xE0) === 0xE0
  if (u8.length >= 2 && u8[0] === 0xFF && (u8[1] & 0xF6) === 0xF0) return 'audio/aac';
  if (u8.length >= 2 && u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0) return 'audio/mpeg';

  // ISO-BMFF（ftyp box）：mp4 / m4a / mov / avif / heic 共用同一个盒子
  if (u8.length >= 12 && tag(4, 4) === 'ftyp') {
    const brand = tag(8, 4);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1'].includes(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    // stsd 里的 codec fourcc 是明文的：找得到视频编码才是视频，只有 mp4a 就是纯音频
    if (has('avc1') || has('hvc1') || has('hev1') || has('av01') || has('vp09')) return 'video/mp4';
    if (brand === 'M4A ' || has('mp4a')) return 'audio/mp4';
    return 'video/mp4';
  }

  // Matroska / WebM：容器头完全一样，纯音频的 WebM 必须认出来，
  // 否则前端会把它渲染成 <video>，用户只看到一块黑屏、以为上传坏了
  if (u8.length >= 4 && u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) {
    if (has('V_VP8') || has('V_VP9') || has('V_AV1')) return 'video/webm';
    if (has('A_OPUS') || has('A_VORBIS')) return 'audio/webm';
    return 'video/webm';
  }
  return null;
}

// 大数组不能用 `String.fromCharCode(...u8)` 展开，会爆调用栈；分块拼接。
function b64Bytes(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

/* ---- CRC32（ZIP 必需，查表法，尽量省 CPU）---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---- ZIP 流式组装 ----
   Workers 只有 128 MB 内存，绝不能把整个压缩包攒在内存里。
   ZIP 的格式天生支持流式：local header → 数据 → …… → central directory → EOCD。
   于是我们「边拉附件边吐字节」，内存占用只跟**单个文件**大小有关，
   附件总量再多也不会爆。这里用 store 模式（不二次压缩），
   因为图片/视频本身已是压缩过的编码，再压收益极小却要烧大量 CPU。 */
function zipLocalHeader(nameBytes, crc, size) {
  const buf = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);          // version needed
  v.setUint16(6, 0, true);           // flags
  v.setUint16(8, 0, true);           // method: store
  v.setUint16(10, 0, true);          // DOS time
  v.setUint16(12, 0x21, true);       // DOS date: 1980-01-01
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true);
  v.setUint32(22, size, true);
  v.setUint16(26, nameBytes.length, true);
  v.setUint16(28, 0, true);
  buf.set(nameBytes, 30);
  return buf;
}
function zipCentralEntry(nameBytes, crc, size, offset) {
  const buf = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(8, 0, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, 0, true);
  v.setUint16(14, 0x21, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, nameBytes.length, true);
  v.setUint16(30, 0, true);
  v.setUint16(32, 0, true);
  v.setUint16(34, 0, true);
  v.setUint16(36, 0, true);
  v.setUint32(38, 0, true);
  v.setUint32(42, offset, true);
  buf.set(nameBytes, 46);
  return buf;
}
function zipEndRecord(count, cdSize, cdOffset) {
  const buf = new Uint8Array(22);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return buf;
}
// entries: 迭代产出 { name, bytes }
async function* zipEntries(entries) {
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const bytes = e.bytes;
    const crc = crc32(bytes), size = bytes.length;
    central.push({ nameBytes, crc, size, offset });
    const lh = zipLocalHeader(nameBytes, crc, size);
    yield lh;
    yield bytes;
    offset += lh.length + size;
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const c of central) {
    const entry = zipCentralEntry(c.nameBytes, c.crc, c.size, c.offset);
    cdSize += entry.length;
    yield entry;
  }
  yield zipEndRecord(central.length, cdSize, cdOffset);
}
function zipStream(gen) {
  return new ReadableStream({
    async pull(ctrl) {
      try {
        const { value, done } = await gen.next();
        if (done) ctrl.close(); else ctrl.enqueue(value);
      } catch (e) { ctrl.error(e); }
    }
  });
}

/* ---- ZIP 解析（还原导入用）----
   整体读入到一个 ArrayBuffer 后随机定位，因此受内存约束，才有上面的 MAX_IMPORT_BYTES。 */
function parseZipBytes(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  const from = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const total = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let n = 0; n < total; n++) {
    if (ptr + 46 > u8.length || dv.getUint32(ptr, true) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const method = dv.getUint16(ptr + 10, true);
    const crc = dv.getUint32(ptr + 16, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const size = dv.getUint32(ptr + 24, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const lhOffset = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(u8.subarray(ptr + 46, ptr + 46 + nameLen));
    const ldNameLen = dv.getUint16(lhOffset + 26, true);
    const ldExtraLen = dv.getUint16(lhOffset + 28, true);
    const start = lhOffset + 30 + ldNameLen + ldExtraLen;
    files.push({ name, bytes: u8.subarray(start, start + compSize), method, crc, size });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
async function inflateZipEntry(f) {
  if (f.method === 0) return f.bytes;                 // store
  if (f.method !== 8) throw new Error(`不支持的压缩方式: ${f.method}`);
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([f.bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---- 站点设置读写 ---- */
async function getSetting(env, k) {
  const r = await env.DB.prepare(`SELECT value FROM settings WHERE key=?`).bind(k).first();
  return r ? r.value : null;
}
async function setSetting(env, k, v, who) {
  await env.DB.prepare(
    `INSERT INTO settings(key,value,updated_at,updated_by) VALUES(?,?,datetime('now'),?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now'), updated_by=excluded.updated_by`
  ).bind(k, String(v), who ?? null).run();
}

/* ---- 存储凭证加密 ----
   WebDAV 密码不能明文躺在库里，否则库一泄露网盘就跟着沦陷。
   做法：首次用到时自动生成一个随机 master key 存进 settings，用它做 AES-GCM 加密。
   零配置（不用站主手工配 secret），又比明文安全一个量级。
   诚实的边界：能读到 D1 内容的人理论上也能解密 —— 但那种场景本来就已全盘失守。 */
async function masterKey(env) {
  let raw = await getSetting(env, '_storage_master_key');
  if (!raw) {
    raw = b64Bytes(crypto.getRandomValues(new Uint8Array(32)));
    await setSetting(env, '_storage_master_key', raw);
  }
  return crypto.subtle.importKey('raw', unb64(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function sealSecret(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await masterKey(env);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plain)));
  return b64Bytes(iv) + '.' + b64Bytes(ct);
}
async function revealSecret(env, sealed) {
  if (!sealed) return '';
  const [ivB, ctB] = String(sealed).split('.');
  if (!ivB || !ctB) return '';
  try {
    const key = await masterKey(env);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) }, key, unb64(ctB));
    return new TextDecoder().decode(pt);
  } catch (e) { return ''; }
}

/* ---- 存储配置 ----
   存 settings 而不是 wrangler.jsonc：站主要能在管理界面随时换接口，
   总不能每改一次配置就重新部署一遍 Worker。 */
const DEFAULT_STORAGE = { type: 'none', enabled: false };
async function rawStorageConfig(env) {
  const raw = await getSetting(env, 'storage_config');
  if (!raw) return { ...DEFAULT_STORAGE };
  try { return { ...DEFAULT_STORAGE, ...JSON.parse(raw) }; } catch (e) { return { ...DEFAULT_STORAGE }; }
}
// 拿到「带明文密码」的完整配置，仅供服务端内部支用，绝不返回给浏览器
async function storageConfig(env) {
  const cfg = await rawStorageConfig(env);
  if (cfg.type === 'webdav' && cfg.webdav) {
    cfg.webdav = { ...cfg.webdav, password: await revealSecret(env, cfg.webdav.password_sealed) };
    delete cfg.webdav.password_sealed;
  }
  return cfg;
}
// 脱敏后给前端展示：密码只告诉「有没有」，不吐明文
function publicStorageConfig(cfg) {
  const pub = { type: cfg.type, enabled: !!cfg.enabled, updated_at: cfg.updated_at || null };
  if (cfg.type === 'webdav') {
    pub.webdav = {
      baseUrl: cfg.webdav?.baseUrl || '',
      username: cfg.webdav?.username || '',
      hasPassword: !!(cfg.webdav?.password_sealed || cfg.webdav?.password)
    };
  }
  if (cfg.type === 'r2') pub.r2 = { binding: cfg.r2?.binding || 'BUCKET' };
  return pub;
}

/* 给网盘请求加超时。
   Cloudflare 的 fetch 没有超时参数，不加的话：网盘不响应时 Worker 会一直挂着，
   前端只能看着「正在保存到存储…」干等 —— 用户描述的就是这个。
   实测 Worker 访问国内网盘（123 云盘）单次要 3~13 秒，比直连慢一两个数量级，
   所以超时必须给足，但要**有**。 */
const DAV_TIMEOUT_MS = 25000;
// 写要慢得多：实测往 123 云盘写一个 2 MB 的文件要 15~18 秒。
// 超时给太短会「明明在传却被我们掐掉」，然后又去重试，反而更容易撞 423。
// 60 秒 × 最多 3 次 = 180 秒，正好压在客户端 240 秒的超时以内。
const DAV_PUT_TIMEOUT_MS = 60000;
async function davFetch(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || DAV_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}
function davErr(e, what) {
  const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
  if (timedOut)
    return new Error(`${what}超时（单次 ${Math.round((what === '写入存储' ? DAV_PUT_TIMEOUT_MS : DAV_TIMEOUT_MS) / 1000)} 秒无响应）。多是网盘限速或被占用，可在「附件存储设置 → 测试连接」复核响应耗时`);
  return new Error(`${what}失败：${e && e.message ? e.message : '网络错误'}`);
}

/* ---- WebDAV 会话爱好者 ---- */
// 把 HTTP 状态码翻译成人话，方便站主自己在界面上诊断连接问题
function davHint(status) {
  if (status === 401) return '（账号或密码不正确）';
  if (status === 403) return '（账号没有写入权限，或网盘限制了第三方客户端）';
  if (status === 404) return '（地址或路径不存在，检查 WebDAV 地址是否要带子路径）';
  if (status === 405) return '（该地址不允许此操作，确认填的是 WebDAV 入口而不是网页版地址）';
  if (status === 507) return '（网盘空间已满）';
  // 实测 123 云盘对「同一路径正在写入」会返回 423：并发写同一个文件名时，
  // 第一个 201、其余全是 423。所以重试绝不能拿同一个 key 再发一次。
  if (status === 423) return '（该文件正被另一次上传占用，换个文件名重试即可）';
  return '';
}
function davAuth(user, pass) {
  return 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`)));
}
function davJoin(base, key) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(key || '').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return b + '/' + p;
}
// 逐级 MKCOL 把父目录建出来；已存在（405）忽略。
// Nextcloud 等服务器不支持 PUT 时自动建父目录，这一步不能省。
async function davMkcolParents(cfg, key) {
  const parts = String(key).replace(/^\/+/, '').split('/');
  parts.pop();                                   // 去掉文件名本身
  let acc = String(cfg.baseUrl || '').replace(/\/+$/, '');
  for (const seg of parts) {
    acc += '/' + encodeURIComponent(seg);
    try {
      await davFetch(acc, { method: 'MKCOL', headers: { 'Authorization': davAuth(cfg.username, cfg.password) } }, 12000);
    } catch (e) { /* 已存在或无权建，交给后续 PUT 的报错来体现 */ }
  }
}

/* ---- 统一的 put / get / del / test ---- */
// 换一个文件名（插一段随机后缀），用于 423 / 网络失败后的重试。
// 123 云盘对「同一路径正在写入」返回 423 —— 拿同一个 key 重试只会一直 423。
function bumpKey(key) {
  return String(key).replace(/(\.[^.\/]*)?$/, (m) => `-${randomToken().slice(0, 6)}${m || ''}`);
}

/* 写文件，返回**实际使用的** key。
   R2 一次就成；WebDAV 这边要对付两件事：
     · 父目录不存在（实测 123 云盘返回 404，个别服务器用 409）→ 逐级 MKCOL 再试；
     · 423 Locked（该路径正被占用）→ **必须换文件名**重试，不能原样再来一遍。
   重试上限 3 次，退避 0.4/0.8 秒。 */
async function storePut(env, cfg, key, bytes, mime) {
  if (cfg.type === 'r2') {
    const b = env[cfg.r2?.binding || 'BUCKET'];
    if (!b) throw new Error(`未绑定 R2 bucket（env.${cfg.r2?.binding || 'BUCKET'} 不存在）`);
    await b.put(key, bytes, { httpMetadata: { contentType: mime || 'application/octet-stream' } });
    return key;
  }
  if (cfg.type !== 'webdav') throw new Error('尚未配置外部存储');
  const head = { 'Authorization': davAuth(cfg.webdav.username, cfg.webdav.password), 'Content-Type': mime || 'application/octet-stream' };
  let use = key, lastErr = null;
  for (let i = 0; i < 3; i++) {
    const url = davJoin(cfg.webdav.baseUrl, use);
    const sig = `写入存储`;
    try {
      let res = await davFetch(url, { method: 'PUT', headers: head, body: bytes }, DAV_PUT_TIMEOUT_MS);
      if (res.status === 409 || res.status === 404) {
        await davMkcolParents(cfg.webdav, use);
        res = await davFetch(url, { method: 'PUT', headers: head, body: bytes }, DAV_PUT_TIMEOUT_MS);
      }
      if (res.ok) return use;
      if (res.status === 423 && i < 2) {
        use = bumpKey(use);                                   // 换个名字，避开锁
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
        continue;
      }
      throw new Error(`${sig}失败：HTTP ${res.status}${davHint(res.status)}`);
    } catch (e) {
      lastErr = e;
      if (/失败：HTTP/.test(e.message)) throw e;               // 已经带了明确状态码，直接抛
      if (i === 2) break;
      use = bumpKey(use);
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw davErr(lastErr, '写入存储');
}
// 解析 `Range: bytes=start-end`，三种写法都要照顾：
//   bytes=0-1023 / bytes=1024-（到末尾）/ bytes=-500（最后 500 字节）
function parseRange(header, size){
  const m = /bytes=(\d*)-(\d*)/.exec(String(header || ''));
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end   = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) { const len = end; start = Math.max(0, size - len); end = size - 1; }
  else if (end === null || end >= size) end = size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { offset: start, length: end - start + 1 };
}

async function storeGet(env, cfg, key, rangeHeader) {
  if (cfg.type === 'r2') {
    const b = env[cfg.r2?.binding || 'BUCKET'];
    if (!b) throw new Error('未绑定 R2 bucket');
    const head = await b.get(key);                 // R2 的 get 不会立刻下载 body，先拿 size 是安全的
    if (!head) return null;
    const size = head.size;
    const r = rangeHeader ? parseRange(rangeHeader, size) : null;
    // 之前这里没处理 range，却对外宣称 Accept-Ranges: bytes，
    // 视频拖动时会拿到全量 200 而不是 206。现在按 range 真正取分片。
    const obj = r ? await b.get(key, { range: r }) : head;
    return {
      body: obj.body,
      size: r ? r.length : size,
      mime: head.httpMetadata?.contentType || 'application/octet-stream',
      etag: head.etag,
      status: r ? 206 : 200,
      contentRange: r ? `bytes ${r.offset}-${r.offset + r.length - 1}/${size}` : null,
      full: obj
    };
  }
  if (cfg.type !== 'webdav') throw new Error('尚未配置外部存储');
  const head = { 'Authorization': davAuth(cfg.webdav.username, cfg.webdav.password) };
  if (rangeHeader) head['Range'] = rangeHeader;
  // 只给「连上并拿到响应头」这一段限时；拿到之后 body 是流式吐给客户端的，
  // finally 里已经清掉计时器，不会把正在传输的响应掐断。
  const res = await davFetch(davJoin(cfg.webdav.baseUrl, key), { method: 'GET', headers: head });
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 206) throw new Error(`读取存储失败：HTTP ${res.status}`);
  /* 服务端回了 206 却没给 Content-Range：拿它当全量用会得到一段「残缺文件」
     （视频放一半断掉、图片只显示上半截）。退回一次不带 Range 的请求 ——
     宁可不能拖拽，也不能把半段内容当完整文件交出去。 */
  if (rangeHeader && res.status === 206 && !res.headers.get('Content-Range')) {
    try { res.body && res.body.cancel && await res.body.cancel() } catch (e) { }
    return await storeGet(env, cfg, key, null);
  }
  return {
    body: res.body,
    size: Number(res.headers.get('Content-Length') || 0),
    mime: res.headers.get('Content-Type') || 'application/octet-stream',
    etag: res.headers.get('ETag'),
    acceptRanges: res.headers.get('Accept-Ranges'),
    status: res.status,
    contentRange: res.headers.get('Content-Range'),
    full: res
  };
}
async function storeDelete(env, cfg, key) {
  if (cfg.type === 'r2') {
    const b = env[cfg.r2?.binding || 'BUCKET'];
    if (b) await b.delete(key);
    return;
  }
  if (cfg.type !== 'webdav') return;
  try {
    await davFetch(davJoin(cfg.webdav.baseUrl, key), {
      method: 'DELETE', headers: { 'Authorization': davAuth(cfg.webdav.username, cfg.webdav.password) }
    }, 12000);
  } catch (e) { /* 远端删除失败不应拖垮本地清理 */ }
}
// 连通性自检：建一个探针文件、读回来、再删掉
async function storeTest(cfg, env) {
  if (cfg.type === 'r2') {
    const b = env[cfg.r2?.binding || 'BUCKET'];
    if (!b) throw new Error(`未绑定 R2 bucket（env.${cfg.r2?.binding || 'BUCKET'} 不存在）`);
    const probe = `.probe-${Date.now()}`;
    await b.put(probe, new Uint8Array([1]), {});
    await b.delete(probe);
    return { ok: true, detail: 'R2 读写正常' };
  }
  if (cfg.type !== 'webdav') throw new Error('尚未选择存储类型');
  if (!cfg.webdav?.baseUrl) throw new Error('请填写 WebDAV 地址');
  const probeKey = `.probe-${Date.now()}.txt`;
  const url = davJoin(cfg.webdav.baseUrl, probeKey);
  const auth = { 'Authorization': davAuth(cfg.webdav.username, cfg.webdav.password) };
  // 每一步都记时：网盘从服务器这边访问慢到什么程度，是排查上传卡死的关键信息
  const t0 = Date.now();
  let put, putMs = 0;
  try {
    put = await davFetch(url, { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body: new Uint8Array([1]) });
    putMs = Date.now() - t0;
  } catch (e) { throw davErr(e, '写入') }
  if (put.status === 409 || put.status === 404) {
    await davMkcolParents(cfg.webdav, probeKey);
    const t1 = Date.now();
    try {
      const again = await davFetch(url, { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body: new Uint8Array([1]) });
      putMs = Date.now() - t1;
      if (!again.ok) throw new Error(`写入失败：HTTP ${again.status}${davHint(again.status)}`);
    } catch (e) { throw e.message && /写入失败/.test(e.message) ? e : davErr(e, '写入') }
  } else if (!put.ok) {
    throw new Error(`写入失败：HTTP ${put.status}${davHint(put.status)}`);
  }
  const t2 = Date.now();
  let got;
  try { got = await davFetch(url, { method: 'GET', headers: auth }) } catch (e) { throw davErr(e, '读取') }
  const getMs = Date.now() - t2;
  try { await davFetch(url, { method: 'DELETE', headers: auth }, 12000) } catch (e) { /* 删不掉不影响结论 */ }
  if (!got.ok) throw new Error(`写入成功但读取失败：HTTP ${got.status}${davHint(got.status)}`);
  // 慢到这种程度要明确讲出来：写一个 1 字节文件都要好几秒的网盘，
  // 稍大一点的附件必然卡到超时。
  const slow = putMs > 3000 || getMs > 3000;
  return {
    ok: true,
    detail: `WebDAV 读写删除均正常（写 ${putMs} ms / 读 ${getMs} ms）` +
      (slow ? '。⚠️ 响应偏慢，从服务器访问该网盘可能被限速，稍大的附件容易超时；建议改用 Cloudflare R2。' : '')
  };
}

/* 远端路径：按类型分目录（images/ videos/ audios/ avatars/）。
 * 为什么可行、也为什么不牵动老数据：
 *   · storePut 遇到 409/404 会自动逐级 MKCOL 建父目录再重试 —— 新目录不需要预先手动建；
 *   · 每个附件的 storage_key 都记在库里，读写删一律按 key 定位，
 *     所以改路径只影响「新上传的」，老文件继续躺在旧路径下照样能取。
 *   · 头像单独放 avatars/，是为了让「清理孤儿附件」能一眼把它排除掉
 *     （头像不被任何帖子引用，按老规则是会被当成孤儿删掉的）。
 */
function newStorageKey(ext, kind, mime) {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  let dir = 'others';
  if (kind === 'avatar') dir = 'avatars';
  else if (/^image\//.test(mime || '')) dir = 'images';
  else if (/^video\//.test(mime || '')) dir = 'videos';
  else if (/^audio\//.test(mime || '')) dir = 'audios';
  return `${dir}/${ymd}/${randomToken().slice(0, 20)}.${ext}`;
}

/* 从一批正文里收集 [img:n] 引用，查出这些附件的类型与尺寸一并返回。
   前端必须靠 mime 才知道该渲染成 <img> 还是 <video>（视频塞进 img 只会得到破图），
   靠 width/height 才能在图片加载完之前就把空间预留好，避免页面跳一下。 */
async function attachmentIndex(env, texts) {
  const ids = new Set();
  for (const t of texts) {
    const re = /\[img:(\d+)\]/g;
    let m;
    while ((m = re.exec(t || ''))) ids.add(Number(m[1]));
  }
  if (!ids.size) return {};
  const list = [...ids];
  const ph = list.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT id,mime,width,height FROM attachments WHERE id IN (${ph})`
  ).bind(...list).all()).results;
  const map = {};
  for (const r of rows) map[r.id] = { mime: r.mime, w: r.width, h: r.height };
  return map;
}

/* ---------------- 路由 ---------------- */
async function route(req,env){
  if(!originOK(req)) return json({error:'bad origin'},403);
  const url=new URL(req.url), path=url.pathname, method=req.method;

  if(path==='/api/status'&&method==='GET'){
    const admin=await env.DB.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).first();
    const u=await currentUser(req,env);
    // 是否开放附件上传，交给前端决定要不要显示上传按钮 ——
    // 没配置存储时按钮压根不该出现，而不是等用户点了才报错。
    let uploadEnabled=false;
    try{ const c=await rawStorageConfig(env); uploadEnabled=!!(c.enabled && c.type && c.type!=='none'); }catch(e){ }
    // 顺带把上限告诉前端：选完文件立刻能判断大小是否超限，
    // 不必等把几十 MB 发上去再被拒（那种情况下客户端会看起来像卡死）。
    let maxUploadMb=0, maxAvatarMb=0;
    if(uploadEnabled){
      try{
        maxUploadMb=Math.round(await uploadLimitBytes(env,'')/1024/1024);
        maxAvatarMb=Math.round(await uploadLimitBytes(env,'avatar')/1024/1024);
      }catch(e){ }
    }
    return json({setupNeeded:!admin, user:u?publicUser(u):null, uploadEnabled, maxUploadMb, maxAvatarMb});
  }

  if(path==='/api/setup'&&method==='POST'){
    const b=await req.json(); const username=cleanUsername(b.username), password=String(b.password||'');
    if(username.length<3||password.length<10) return json({error:'管理员用户名至少3位，密码至少10位'},400);
    const ph=await passwordHash(password);
    // 关键：把「检查是否已初始化」和「插入」合成**一条**语句。
    // 原先是先 SELECT 再 INSERT，两个请求并发时会双双通过检查，造出两名管理员，
    // 整个权限模型就此失效。SQLite 的 INSERT…SELECT…WHERE NOT EXISTS 是原子的。
    const r=await env.DB.prepare(
      `INSERT INTO users(username,password_hash,role)
       SELECT ?,?,'admin' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`
    ).bind(username,ph).run();
    if(!(r?.meta?.changes)) return json({error:'管理员已经初始化'},409);
    return json({ok:true});
  }

  if(path==='/api/register'&&method==='POST'){
    const b=await req.json(); const username=cleanUsername(b.username), password=String(b.password||'');
    if(username.length<3||password.length<8) return json({error:'用户名至少3位，密码至少8位'},400);
    if(!/^[\p{L}\p{N}_-]+$/u.test(username)) return json({error:'用户名包含不支持的字符'},400);
    // 注：此处**刻意不加**注册限流。荣荣 确认论坛要保持开放，
    // 按 IP 限流会误伤共用出口 IP 的真实访客（同一屋檐下几个人一起注册就被挡了）。
    try{const ph=await passwordHash(password); await env.DB.prepare(`INSERT INTO users(username,password_hash) VALUES(?,?)`).bind(username,ph).run(); return json({ok:true});}
    catch(e){return json({error:'用户名已存在'},409)}
  }

  if(path==='/api/login'&&method==='POST'){
    const b=await req.json(), username=cleanUsername(b.username), password=String(b.password||'');
    const ip=clientIP(req);
    const uKey=`login:u:${username}`, ipKey=`login:ip:${ip}`;
    // 双维度限流：只按用户名挡不住「同一个密码试遍所有账号」，
    // 只按 IP 又会误伤共用出口 IP 的一家人，所以两个都设上限。
    const g1=await rlHit(env,uKey,RL.loginUser.limit,RL.loginUser.windowMs);
    const g2=await rlHit(env,ipKey,RL.loginIP.limit,RL.loginIP.windowMs);
    if(!g1.ok||!g2.ok) return json({error:rlMessage({retry:Math.max(g1.retry||0,g2.retry||0)})},429);
    await sweepExpired(env);          // 登录是低频动作，顺手清理一次过期数据
    const u=await env.DB.prepare(`SELECT * FROM users WHERE username=?`).bind(username).first();
    if(!u) return json({error:'用户名或密码错误'},401);

    /* 胁迫密码：必须在真密码之前判出来。
       命中的表现是「账号进入保护状态」—— 一条内容都不删、账号从此登不进去，
       只有站主能手动恢复。所以这里**不下发任何会话**：
       返回 200 + duress 只是为了把状态告诉前端，好让它显示一段说明，
       而不是「登录成功」。之后无论输真密码还是胁迫密码，都会被下面那道状态检查挡住。 */
    const okReal=await verifyPassword(password,u.password_hash);
    if(!okReal && u.duress_hash && await verifyPassword(password,u.duress_hash)){
      await rlClear(env,[uKey,ipKey]);
      // 已经在保护状态里就别重复写了（时间戳要保留第一次触发的）
      if(!u.duress_state){
        await env.DB.prepare(`UPDATE users SET duress_state=1,duress_at=datetime('now'),duress_by='self' WHERE id=?`).bind(u.id).run();
      }
      // 正在被胁迫的人，可能手里还有别的设备的登录态 —— 一并作废
      await destroyUserSessions(env,u.id);
      return json({duress:true, username:u.username});
    }
    if(!okReal) return json({error:'用户名或密码错误'},401);
    if(u.banned) return json({error:'账号已被封禁'},403);
    // 保护状态：内容留着，人进不来（胁迫密码与真密码一视同仁）
    if(u.duress_state) return json({error:'该账号处于保护状态，需要站主手动恢复后才可登录'},403);
    await rlClear(env,[uKey,ipKey]);  // 密码对了就把失败计数抹掉

    // 已开启 2FA：不下发正式会话，先给一张短期待验证票据
    if(u.totp_enabled){
      const pending = randomToken();
      const pth = await sha256(pending);
      await env.DB.prepare(`INSERT INTO pending_2fa(token_hash,user_id,expires_at) VALUES(?,?,?)`)
        .bind(pth, u.id, Date.now()+PENDING_2FA_TTL).run();
      return json({need2fa:true, pending});
    }

    const token=await createSession(env,u.id);
    return json({ok:true,user:publicUser(u)},200,{'set-cookie':cookie('bbs_session',token,SESSION_TTL/1000)});
  }

  // 完成 2FA 登录
  if(path==='/api/2fa/verify'&&method==='POST'){
    const b=await req.json();
    const pending=String(b.pending||''), code=String(b.code||'');
    if(!pending) return json({error:'缺少验证票据'},400);
    const pth=await sha256(pending);
    const row=await env.DB.prepare(`SELECT * FROM pending_2fa WHERE token_hash=?`).bind(pth).first();
    if(!row) return json({error:'验证已失效，请重新登录'},401);
    if(row.expires_at < Date.now()){
      await env.DB.prepare(`DELETE FROM pending_2fa WHERE token_hash=?`).bind(pth).run();
      return json({error:'验证已超时，请重新登录'},401);
    }
    if(row.attempts >= MAX_2FA_ATTEMPTS){
      await env.DB.prepare(`DELETE FROM pending_2fa WHERE token_hash=?`).bind(pth).run();
      return json({error:'尝试次数过多，请重新登录'},429);
    }
    const u=await env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(row.user_id).first();
    // 复查账号状态：密码那一步通过之后账号仍可能被封禁，必须在签发会话前再拦一次
    if(!u){ await env.DB.prepare(`DELETE FROM pending_2fa WHERE token_hash=?`).bind(pth).run(); return json({error:'账号不存在'},401); }
    if(u.banned){ await env.DB.prepare(`DELETE FROM pending_2fa WHERE token_hash=?`).bind(pth).run(); return json({error:'账号已被封禁'},403); }
    if(!u.totp_enabled || !(await verifyTotp(u.totp_secret, code))){
      await env.DB.prepare(`UPDATE pending_2fa SET attempts=attempts+1 WHERE token_hash=?`).bind(pth).run();
      return json({error:'验证码不正确'},401);
    }
    await env.DB.prepare(`DELETE FROM pending_2fa WHERE token_hash=?`).bind(pth).run();
    const token=await createSession(env,u.id);
    return json({ok:true,user:publicUser(u)},200,{'set-cookie':cookie('bbs_session',token,SESSION_TTL/1000)});
  }

  if(path==='/api/logout'&&method==='POST'){
    const token=getCookie(req,'bbs_session'); if(token) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash=?`).bind(await sha256(token)).run();
    return json({ok:true},200,{'set-cookie':cookie('bbs_session','',0)});
  }

  /* ---- 2FA 绑定 / 关闭（需登录）---- */
  if(path==='/api/2fa/setup'&&method==='POST'){
    const u=await requireUser(req,env);
    if(u.totp_enabled) return json({error:'已开启两步验证，如需重新绑定请先关闭'},400);
    const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    return json({secret, uri: totpUri(u.username, secret)});
  }

  if(path==='/api/2fa/enable'&&method==='POST'){
    const u=await requireUser(req,env);
    const b=await req.json();
    const secret=String(b.secret||'').toUpperCase().replace(/[^A-Z2-7]/g,'');
    if(secret.length<16) return json({error:'密钥无效，请重新获取'},400);
    await confirmSensitive(env, u, b);            // 验密码（+已开启时的验证码）
    if(!(await verifyTotp(secret, b.code))) return json({error:'验证码不正确，请检查设备时间是否同步'},400);
    await env.DB.prepare(`UPDATE users SET totp_secret=?, totp_enabled=1 WHERE id=?`).bind(secret,u.id).run();
    return json({ok:true});
  }

  if(path==='/api/2fa/disable'&&method==='POST'){
    const u=await requireUser(req,env);
    const b=await req.json();
    await confirmSensitive(env, u, b);            // 验密码 + 当前验证码
    await env.DB.prepare(`UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?`).bind(u.id).run();
    return json({ok:true});
  }

  /* ---- 账户自助 ---- */
  if(path==='/api/account/password'&&method==='POST'){
    const u=await requireUser(req,env);
    const b=await req.json();
    const newP=String(b.newPassword||'');
    if(newP.length<8) return json({error:'新密码至少 8 位'},400);
    if(newP.length>200) return json({error:'新密码过长'},400);
    await confirmSensitive(env, u, b);
    const ph=await passwordHash(newP);
    await env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=?`).bind(ph,u.id).run();
    // 让该用户在其它设备上的会话全部失效，并为当前设备签发新会话
    await destroyUserSessions(env,u.id);
    const token=await createSession(env,u.id);
    return json({ok:true},200,{'set-cookie':cookie('bbs_session',token,SESSION_TTL/1000)});
  }

  if(path==='/api/account/username'&&method==='POST'){
    const u=await requireUser(req,env);
    const b=await req.json();
    const name=cleanUsername(b.username);
    if(name.length<3) return json({error:'用户名至少 3 位'},400);
    if(!/^[\p{L}\p{N}_-]+$/u.test(name)) return json({error:'用户名包含不支持的字符'},400);
    if(name===u.username) return json({error:'新用户名与当前相同'},400);
    await confirmSensitive(env, u, b);
    try{
      await env.DB.prepare(`UPDATE users SET username=? WHERE id=?`).bind(name,u.id).run();
    }catch(e){ return json({error:'该用户名已被占用'},409); }
    return json({ok:true,user:{...publicUser(u),username:name}});
  }

  // 个人资料：头像 + 签名档。敏感程度远低于改密改号，不需要验密码。
  if(path==='/api/account/profile'&&method==='POST'){
    const u=await requireUser(req,env);
    const b=await req.json();
    let avatar=null;
    if(b.avatar!=null){
      const av=text(b.avatar).slice(0,64);
      if(!av) avatar=null;                                  // 传空串 = 清除头像
      else if(/^emoji:.{1,16}$/u.test(av)) avatar=av;       // 内置表情，形如 emoji:🐱
      else if(/^att:\d+$/.test(av)){
        // 头像必须是自己上传的那张，不能拿别人的附件 id 顶上
        const id=Number(av.slice(4));
        const a=await env.DB.prepare(`SELECT id,mime FROM attachments WHERE id=? AND owner_id=?`).bind(id,u.id).first();
        if(!a) return json({error:'头像图片不存在或不属于你'},400);
        if(!/^image\//.test(a.mime||'')) return json({error:'头像必须是图片'},400);
        avatar='att:'+id;
      }
      else return json({error:'头像格式不支持'},400);
    } else avatar=u.avatar||null;
    const bio=b.bio==null?(u.bio||''):text(b.bio).replace(/\r\n/g,'\n').slice(0,140);
    // sensitiveFilter：要不要把「不易展示」的内容先模糊掉。纯个人偏好，不验密码。
    const sf=(b.sensitiveFilter==null?(u.sensitive_filter==null?1:(u.sensitive_filter?1:0)):toFlag(b.sensitiveFilter));
    await env.DB.prepare(`UPDATE users SET avatar=?,bio=?,sensitive_filter=? WHERE id=?`).bind(avatar,bio,sf,u.id).run();
    return json({ok:true,user:{...publicUser(u),avatar,bio,sensitive_filter:sf}});
  }

  /* ---- 胁迫密码（本人设置 / 清除）----
     用法：平时用真密码登录；遇到有人逼你解锁时，输这一串。
     效果是「账号进入保护状态」：内容一条都不删、账号从此登不进去，只有站主能恢复。
     它和真密码是两个独立的哈希，谁也不会覆盖谁 ——
     真密码改掉之后胁迫密码依然有效（正被胁迫时通常没法说实话）。 */
  if(path==='/api/account/duress'&&method==='POST'){
    const u=await requireUser(req,env);
    // 管理员不给设：这个功能的出口是「只有站主能恢复」，管理员一旦自己触发保护状态，
    // 就等于把自己锁在门外，而唯一能开门的人也是他自己 —— 没人是安全的了。
    // 真遇到胁迫，管理员改密码即可（改完其它设备立刻掉线）。
    if(isAdmin(u)) return json({error:'管理员账号不能设置胁迫密码；如遇胁迫请直接修改密码，或联系另一位管理员'},403);
    const b=await req.json();
    // confirmSensitive 顺带把完整行（含 password_hash）取回来了 ——
    // 下面要拿它比「胁迫密码是否等于登录密码」，而 currentUser 的 SELECT 里没有这个字段。
    const full=await confirmSensitive(env, u, b);   // 敏感操作：先验当前密码（+ 2FA）
    const dv=String(b.duress||'');
    if(!dv){                                        // 传空串 = 清除
      await env.DB.prepare(`UPDATE users SET duress_hash=NULL WHERE id=?`).bind(u.id).run();
      return json({ok:true, duress_set:0});
    }
    if(dv.length<8) return json({error:'胁迫密码至少 8 位'},400);
    if(dv.length>200) return json({error:'胁迫密码过长'},400);
    // 不能和真密码相同：那样一输就等于直接触发保护状态，平时自己都登不进来
    if(await verifyPassword(dv, full.password_hash)) return json({error:'胁迫密码不能和登录密码相同'},400);
    const ph=await passwordHash(dv);
    await env.DB.prepare(`UPDATE users SET duress_hash=? WHERE id=?`).bind(ph,u.id).run();
    return json({ok:true, duress_set:1});
  }

  if(path==='/api/account/delete'&&method==='POST'){
    const u=await requireUser(req,env);
    const b=await req.json();

    // 管理员一律不允许注销自己的账号：
    // 既是防止站点因误操作陷入无人管理，也是避免「唯一管理员」这类边界被绕过。
    if(isAdmin(u)) return json({error:'管理员账号不能注销自己；如需退出管理，请先由其他管理员撤销你的权限'},403);

    if(text(b.confirm)!==u.username) return json({error:'请输入你的用户名以确认注销'},400);
    await confirmSensitive(env, u, b);

    // 先整包收进回收站：账号行、全部内容、附件清单都在里面 ——
    // 注销从此不是「一按就没」，站主随时能把 TA 整个放回来。
    // ⚠️ 远端附件**不删**（删了就再也恢复不回来）。真要腾空间，
    //    在回收站里对这条记录点「彻底删除」，那一步才会连远端一起清。
    await trashUser(env, u.id, u);
    // TA 发过的东西上的赞也要跟着走（likes.user_id 有外键级联，这里清的是**别人给 TA 点的**）
    const myT=(await env.DB.prepare(`SELECT id FROM threads WHERE author_id=?`).bind(u.id).all()).results.map(r=>r.id);
    const myP=(await env.DB.prepare(`SELECT id FROM posts WHERE author_id=?`).bind(u.id).all()).results.map(r=>r.id);
    await purgeLikes(env,'thread',myT);
    await purgeLikes(env,'post',myP);
    // 顺序很重要：先删回复 → 再删主题 → 最后删账号（会话与票据靠外键级联）
    await env.DB.prepare(`DELETE FROM posts WHERE author_id=?`).bind(u.id).run();
    await env.DB.prepare(`DELETE FROM threads WHERE author_id=?`).bind(u.id).run();
    await env.DB.prepare(`DELETE FROM pending_2fa WHERE user_id=?`).bind(u.id).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(u.id).run();
    await env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(u.id).run();
    // attachments 靠外键级联消失，但**行删了才好在恢复时重建**：
    // 快照里已经存了完整元数据，这里不需要额外动作。

    return json({ok:true, trashed:true},200,{'set-cookie':cookie('bbs_session','',0)});
  }

  /* ---- 用户主页 ----
     公开信息（头像 / 签名 / 发帖统计 / 最近内容），不含邮箱、2FA 等任何私密字段。 */
  const um=path.match(/^\/api\/users\/(\d+)$/);
  if(um&&method==='GET'){
    const id=Number(um[1]);
    const u=await env.DB.prepare(`SELECT id,username,role,bio,avatar,created_at,banned,duress_state,duress_at FROM users WHERE id=?`).bind(id).first();
    if(!u) return json({error:'用户不存在'},404);
    // ?q= 只在这个人自己的内容里搜（主页里的「翻他以前发过什么」）。
    // 统计仍然是全量，不跟着关键词变 —— 那是「他一共发过多少」，不是「搜到多少」。
    const kw=String(new URL(req.url).searchParams.get('q')||'').trim().slice(0,60);
    let tWhere='', pWhere='', arg=[], parg=[];
    if(kw){
      const pat='%'+kw.replace(/[\\%_]/g,c=>'\\'+c)+'%';   // % 和 _ 要当普通字符，否则会全表匹配
      tWhere=` AND (t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\')`;
      pWhere=` AND p.body LIKE ? ESCAPE '\\'`;
      arg=[pat,pat]; parg=[pat];
    }
    const limit=kw?50:20;      // 搜索时多给一些，翻旧帖才不用一趟趟试
    let ts=env.DB.prepare(`SELECT t.id,t.title,t.created_at,t.pinned,b.name board_name,COUNT(p.id) replies FROM threads t LEFT JOIN posts p ON p.thread_id=t.id LEFT JOIN boards b ON b.id=t.board_id WHERE t.author_id=?${tWhere} GROUP BY t.id ORDER BY t.id DESC LIMIT ${limit}`).bind(id,...arg);
    let ps=env.DB.prepare(`SELECT p.id,p.body,p.created_at,p.thread_id,t.title thread_title FROM posts p JOIN threads t ON t.id=p.thread_id WHERE p.author_id=?${pWhere} ORDER BY p.id DESC LIMIT ${limit}`).bind(id,...parg);
    const [threads,posts]=await Promise.all([ts.all(),ps.all()]);
    // 获赞数 = TA 的主题收到的赞 + TA 的回复收到的赞（两条分开算，likes 是同一张表按 type 区分）
    const stats=await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM threads WHERE author_id=?) threads,
        (SELECT COUNT(*) FROM posts WHERE author_id=?) replies,
        (SELECT COUNT(*) FROM likes l JOIN threads t ON t.id=l.target_id WHERE l.target_type='thread' AND t.author_id=?)
         +
        (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id=l.target_id WHERE l.target_type='post' AND p.author_id=?) likes`).bind(id,id,id,id).first();
    return json({
      user:{id:u.id,username:u.username,role:u.role,bio:u.bio||'',avatar:u.avatar||null,created_at:u.created_at,banned:u.banned?1:0,duress_state:u.duress_state?1:0,duress_at:u.duress_at||null},
      stats:{threads:Number(stats?.threads||0),replies:Number(stats?.replies||0),likes:Number(stats?.likes||0)},
      threads:threads.results, posts:posts.results, q:kw
    });
  }

  /* ---- 讨论板块 ----
     权限设计：
       创建 —— 任何登录用户（这是公共讨论区，分类由大家共建）
       删除 —— 只有管理员。板块是公共货架，让随便一个人拆掉会连累里面所有人的帖子；
               而且一旦能删，就等于给了别人「清空某个话题」的权力。
     删除板块时其下的主题**不会被删**，只是回到「未分类」。 */
  const bm = path.match(/^\/api\/boards\/(\d+)$/);

  if(path==='/api/boards'&&method==='GET'){
    const rows=await env.DB.prepare(
      `SELECT b.id,b.name,b.description,b.creator_id,u.username creator,COUNT(t.id) threads
         FROM boards b
         LEFT JOIN users u ON u.id=b.creator_id
         LEFT JOIN threads t ON t.board_id=b.id
        GROUP BY b.id ORDER BY b.id`).all();
    // 没有板块的主题单独统计，前端显示成「未分类」
    const loose=await env.DB.prepare(`SELECT COUNT(*) n FROM threads WHERE board_id IS NULL`).first();
    return json({
      boards: rows.results.map(b=>({id:b.id,name:b.name,description:b.description,creator:b.creator,threads:Number(b.threads||0)})),
      unboarded: Number(loose?.n||0)
    });
  }

  if(path==='/api/boards'&&method==='POST'){
    const u=await requireUser(req,env), b=await req.json();
    const name=cleanBoardName(b.name), desc=cleanBoardDesc(b.description);
    if(name.length<2) return json({error:'板块名称至少 2 个字'},400);
    try{
      const r=await env.DB.prepare(`INSERT INTO boards(name,description,creator_id) VALUES(?,?,?)`).bind(name,desc,u.id).run();
      return json({ok:true,id:r?.meta?.last_row_id});
    }catch(e){ return json({error:'同名板块已存在'},409) }
  }

  if(bm&&method==='DELETE'){
    await requireAdmin(req,env);
    const id=Number(bm[1]);
    const row=await env.DB.prepare(`SELECT id FROM boards WHERE id=?`).bind(id).first();
    if(!row) return json({error:'板块不存在'},404);
    // 主题不跟着删，只是失去归属 → 回到「未分类」，帖子一条都不少
    const mv=await env.DB.prepare(`UPDATE threads SET board_id=NULL WHERE board_id=?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM boards WHERE id=?`).bind(id).run();
    return json({ok:true, moved:Number(mv?.meta?.changes||0)});
  }

  /* ---- 主题 ---- */
  if(path==='/api/threads'&&method==='GET'){
    // 三种筛选可以叠加：
    //   ?board=<id>   只看某板块；?board=none 只看「未分类」；不带就是全部
    //   ?q=关键词     标题 / 正文 / 作者名 的子串匹配（大小写不敏感由 SQLite 的 LIKE 决定）
    //   ?page=&limit= 分页，limit 上限 50 防止一次拉爆
    // 返回体从「裸数组」改成 {items,...}：分页控件需要 total，光看本页条数算不出总页数。
    const sp=new URL(req.url).searchParams;
    const q=sp.get('board');
    const kw=String(sp.get('q')||'').trim().slice(0,60);
    const where=[], arg=[];
    if(q==='none') where.push('t.board_id IS NULL');
    else if(q && /^\d+$/.test(q)) { where.push('t.board_id=?'); arg.push(Number(q)); }
    if(kw){
      // % 和 _ 在 LIKE 里是通配符，用户想搜「50%」时必须当普通字符，否则会命中整张表。
      // 转义后再用 ESCAPE 声明转义符，别让关键词本身改变查询语义。
      const pat='%'+kw.replace(/[\\%_]/g,c=>'\\'+c)+'%';
      where.push(`(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')`);
      arg.push(pat,pat,pat);
    }
    const wSql=where.length?('WHERE '+where.join(' AND ')):'';
    const limit=Math.min(Math.max(parseInt(sp.get('limit')||'',10)||20,1),50);
    let cnt=env.DB.prepare(`SELECT COUNT(*) n FROM threads t JOIN users u ON u.id=t.author_id ${wSql}`);
    if(arg.length) cnt=cnt.bind(...arg);
    const total=Number((await cnt.first())?.n||0);
    const pages=Math.max(1,Math.ceil(total/limit));
    // 页码越界时夹到最后一页，而不是返回空列表 —— 翻页翻过头看到空白会以为站挂了
    const page=Math.min(Math.max(parseInt(sp.get('page')||'',10)||1,1),pages);
    // t.sensitive 也要带出来：列表要显示「限制」角标，并在用户开了模糊时把预览盖住
    // quote_ref / quote_snapshot：这条是不是转帖别人得来的（列表里要显示一个「转帖」角标）
    const sql=`SELECT t.id,t.title,t.body,t.pinned,t.locked,t.created_at,t.updated_at,t.edited_at,t.author_id,t.board_id,t.sensitive,t.protected,t.quote_ref,t.quote_snapshot,u.username,u.avatar,b.name board_name,COUNT(p.id) replies FROM threads t JOIN users u ON u.id=t.author_id LEFT JOIN posts p ON p.thread_id=t.id LEFT JOIN boards b ON b.id=t.board_id ${wSql} GROUP BY t.id ORDER BY t.pinned DESC,t.updated_at DESC,t.id DESC LIMIT ? OFFSET ?`;
    // 末尾的 t.id DESC 是必需的：同一秒发的帖 updated_at 完全相同，
    // 没有稳定的 tie-breaker 时 SQLite 的行序不作保证，翻页就可能重页或漏帖。
    const rows=await env.DB.prepare(sql).bind(...arg,limit,(page-1)*limit).all();
    const results=rows.results;
    // 点赞 / 转帖计数：列表是公开接口，登录了才顺带算「我自己赞过没」
    const viewer=(await currentUser(req,env))?.id||0;
    const rm=await reactionMap(env,'thread',results.map(t=>t.id),viewer);
    const qm=await repostMap(env,'thread',results.map(t=>t.id));
    const pl=await pollMap(env,'thread',results.map(t=>t.id),viewer);
    const items=results.map(t=>({...t,
      likes:Number(rm.get(t.id)?.likes||0), liked:Number(rm.get(t.id)?.liked||0),
      reposts:Number(qm.get(t.id)||0), poll:pl.get(t.id)||null}));
    // 只在确实引用了附件时才附带元数据，纯文字帖子保持原样，免得白白撑大响应
    const att=await attachmentIndex(env, results.map(t=>t.body));
    const hasAtt=Object.keys(att).length>0;
    return json({items: hasAtt ? items.map(t=>({...t, att})) : items, total, page, limit, pages, q:kw});
  }

  if(path==='/api/threads'&&method==='POST'){
    const u=await requireUser(req,env), b=await req.json(), title=cleanTitle(b.title), body=cleanBody(b.body);
    // cleanTitle/cleanBody 已经按 100/10000 截断，所以这里只需校验下界。
    // （原先的 title.length>100 || body.length>10000 永远不会成立，是死代码）
    // 转帖时正文可以留空（只挂一张引用卡），挂了投票也可以留空 ——
    // 那时「有没有内容」由引用 / 投票负责。投票不合规（选项不足）就当没传，
    // 帖子照发 —— 它只是附加物，不该把人打了半天的字全挡回去。
    const poll=normalizePoll(b.poll);
    if(title.length<2||(body.length<1 && !b.quote && !poll)) return json({error:'标题和正文不能为空'},400);
    // 板块是可选的：传了但不存在时，宁/null让帖落进「未分类」，也不要让发帖失败
    let boardId=null;
    if(String(b.boardId??'').match(/^\d+$/)){
      const bid=Number(b.boardId);
      if(bid>0 && await env.DB.prepare(`SELECT id FROM boards WHERE id=?`).bind(bid).first()) boardId=bid;
    }
    // sensitive：创作者自己声明「这条公共场合不宜直接展示」（剧透 / 慎入）
    const sensitive=toFlag(b.sensitive);
    // quote：转帖 / 引用别人的主题或回复。目标不存在时静默丢弃（帖子照样发出去），
    // 快照在这里由服务端生成，前端传什么都改不了别人看到的内容。
    const quote=await buildQuote(env, b.quote);
    const r=await env.DB.prepare(`INSERT INTO threads(title,author_id,body,board_id,sensitive,quote_ref,quote_snapshot) VALUES(?,?,?,?,?,?,?)`).bind(title,u.id,body,boardId,sensitive,quote?quote.ref:null,quote?quote.snapshot:null).run();
    const tid=r.meta.last_row_id;
    // 投票和正文同一条请求建出来：分开的话「发帖成功但投票没挂上」没法解释
    if(poll) await attachPoll(env,'thread',tid,poll);
    return json({ok:true,id:tid,sensitive,quote:quote?quote.ref:null,poll:poll?1:0});
  }

  const tm=path.match(/^\/api\/threads\/(\d+)$/);
  const pm=path.match(/^\/api\/threads\/(\d+)\/posts$/);
  const pdm=path.match(/^\/api\/posts\/(\d+)$/);
  /* ---- 附件上传与读取代理 ---- */
  if(path==='/api/upload'&&method==='POST'){
    const u=await requireUser(req,env);
    // 注：此处**刻意不加**上传限流。荣荣 选择不限 ——
    // 真遇到滥用时，用管理面板的「清理孤儿附件」按天回收即可，不必拦着正常用户。
    const cfg=await storageConfig(env);
    if(!cfg.enabled||!cfg.type||cfg.type==='none') return json({error:'站点尚未开启附件功能'},403);
    // ?kind=avatar：头像走独立的 avatars/ 目录，且只能是图片。
    // 请求体必须是**文件裸字节**，不能是 FormData —— 后端整体 arrayBuffer() 当成文件内容，
    // 用 multipart 包一层的话先解出的是封装头，魔法字节判定必然失败。
    const kind=new URL(req.url).searchParams.get('kind')==='avatar'?'avatar':'';
    // 先按 Content-Length 拦一道：超限就立刻回明确的错误，
    // 不必把几十 MB 读进内存再丢掉（Worker 一共只有 128 MB 内存）。
    const maxBytes=await uploadLimitBytes(env, kind);
    const limitMb=Math.round(maxBytes/1024/1024);
    const declared=Number(req.headers.get('content-length'))||0;
    if(maxBytes>0 && declared>maxBytes)
      return json({error:`文件过大（上限 ${limitMb} MB，当前约 ${Math.ceil(declared/1024/1024)} MB）`},413);
    const bytes=new Uint8Array(await req.arrayBuffer());
    if(!bytes.length) return json({error:'文件内容为空'},400);
    if(maxBytes>0 && bytes.length>maxBytes)
      return json({error:`文件过大（上限 ${limitMb} MB，当前约 ${Math.ceil(bytes.length/1024/1024)} MB）`},413);
    // 类型一律以魔法字节为准，不信浏览器上报的 Content-Type（后者随便伪造）
    const mime=sniffType(bytes);
    if(!mime||!EXT_BY_MIME[mime]) return json({error:'不支持的文件类型（支持常见图片、视频与音频）'},400);
    if(kind==='avatar' && !/^image\//.test(mime)) return json({error:'头像只能是图片'},400);
    if(cfg.type==='r2' && !env[cfg.r2?.binding||'BUCKET']) return json({error:'存储未就绪，请站主检查存储配置'},500);
    const key=newStorageKey(EXT_BY_MIME[mime], kind, mime);
    // storePut 返回「实际写进去的那个 key」：撞上 423 之类它会换个文件名重试，
    // 库里必须记最终落地的那个，否则以后按 key 读回来就是 404。
    let usedKey=key;
    try{ usedKey=(await storePut(env,cfg,key,bytes,mime))||key; }
    catch(e){ return json({error:e.message||'写入存储失败'},502) }
    // 文件名经 URL 编码后才放进 header（header 不能直接带非 ASCII）
    let original=String(req.headers.get('X-File-Name')||'');
    try{ original=decodeURIComponent(original); }catch(e){ /* 不是合法编码就原样用 */ }
    original=original.replace(/[\r\n\t]/g,' ').slice(0,120);
    // 前端读到的图片尺寸一并存下。渲染时带上它，浏览器就能在图还没下完时
    // 先把空间占好，否则加载完成那一刻整页会往下跳一截（手机上尤其明显）。
    const w=Number(req.headers.get('X-Image-W'))||null;
    const h=Number(req.headers.get('X-Image-H'))||null;
    const r=await env.DB.prepare(`INSERT INTO attachments(owner_id,storage_key,mime,size,width,height,original_name) VALUES(?,?,?,?,?,?,?)`).bind(u.id,usedKey,mime,bytes.length,w,h,original).run();
    const id=r?.meta?.last_row_id;
    return json({ok:true, id, url:`/api/files/${id}`, mime, size:bytes.length});
  }

  // 读取代理：WebDAV 的账号密码绝不能下发到浏览器，一律 Workers 代取后再吐给前端
  const fm=path.match(/^\/api\/files\/(\d+)$/);
  if(fm&&(method==='GET'||method==='HEAD')){
    const id=Number(fm[1]);
    const row=await env.DB.prepare(`SELECT * FROM attachments WHERE id=?`).bind(id).first();
    if(!row) return json({error:'附件不存在'},404);
    const cfg=await storageConfig(env);
    if(!cfg.type||cfg.type==='none'||!cfg.enabled) return json({error:'附件功能已关闭'},404);
    try{
      const range=method==='GET'?req.headers.get('Range'):null;
      /* 网盘侧的失败多半是间歇性的：限并发、限速、临时 5xx。
         实测同一个附件上一秒 502、下一秒 200，所以别一失败就把话说死 ——
         对「可能马上就好」的状态码立刻再试一次，用户端就少一次「附件打不开」。 */
      const softFail=/HTTP (403|408|425|429|500|502|503|504)\b/;
      const t0=Date.now();
      let got=null, lastErr=null;
      for(let attempt=0; attempt<2; attempt++){
        try{ got=await storeGet(env,cfg,row.storage_key,range); lastErr=null; break }
        catch(e){
          lastErr=e;
          // 只在「秒回的错误」且总耗时还很短时才重试。
          // 超时（25 秒才回来）不匹配 softFail、也不会重试 ——
          // 那种情况是网盘慢，再试一次只会让用户多等 25 秒。
          if(attempt===0 && softFail.test(String(e.message||'')) && Date.now()-t0 < 8000){
            await new Promise(r=>setTimeout(r,180)); continue;
          }
          break;
        }
      }
      if(lastErr) throw lastErr;
      if(!got) return json({error:'找不到远端文件，可能已被外部清理'},404);
      const h={
        // 优先用入库时按魔法字节判定的 mime，其次存储服务给的，
        // 最后按存储路径的扩展名兜底 —— 见 fileMime() 的说明：
        // nosniff 之下，把图片声明成 application/octet-stream 就等于让它打不开。
        'content-type': fileMime(row, got),
        'cache-control':'public, max-age=31536000, immutable',
        'accept-ranges':'bytes'
      };
      // content-length 必须给：<video>/<audio> 靠它算时长和可拖拽范围，
      // 缺了它 iOS Safari 会直接不播（进度条也点不动）。
      // 存储层没报大小（chunked）时宁可不设，也不要编一个假的。
      if(got.size > 0) h['content-length']=String(got.size);
      if(got.etag) h['etag']=got.etag;
      if(got.status===206&&got.contentRange){
        h['content-range']=got.contentRange;
        return new Response(method==='HEAD'?null:got.body,{status:206,headers:h});
      }
      return new Response(method==='HEAD'?null:got.body,{status:200,headers:h});
    }catch(e){ return json({error:e.message||'读取存储失败'},502) }
  }

  const adm=path.match(/^\/api\/admin\/([\w-]+)$/);

  if(tm&&method==='GET'){
    const id=Number(tm[1]); const thread=await env.DB.prepare(`SELECT t.*,u.username,u.avatar,u.bio,b.name board_name FROM threads t JOIN users u ON u.id=t.author_id LEFT JOIN boards b ON b.id=t.board_id WHERE t.id=?`).bind(id).first(); if(!thread) return json({error:'主题不存在'},404);
    // reply_to 一并取出：前端靠它把平层回复重排成楼中楼
    const posts=await env.DB.prepare(`SELECT p.*,u.username,u.role,u.avatar,u.bio FROM posts p JOIN users u ON u.id=p.author_id WHERE p.thread_id=? ORDER BY p.created_at,p.id`).bind(id).all();
    // 点赞 / 转帖计数：主题一条 + 本页所有回复一批，各两条查询搞定，不逐条 N+1
    const viewer=(await currentUser(req,env))?.id||0;
    const tRm=await reactionMap(env,'thread',[thread.id],viewer);
    const tQm=await repostMap(env,'thread',[thread.id]);
    const pIds=posts.results.map(p=>p.id);
    const pRm=await reactionMap(env,'post',pIds,viewer);
    const pQm=await repostMap(env,'post',pIds);
    const tPl=await pollMap(env,'thread',[thread.id],viewer);
    const pPl=await pollMap(env,'post',pIds,viewer);
    const att=await attachmentIndex(env, [thread.body, ...posts.results.map(p=>p.body)]);
    return json({
      thread:{...thread,
        likes:Number(tRm.get(thread.id)?.likes||0), liked:Number(tRm.get(thread.id)?.liked||0),
        reposts:Number(tQm.get(thread.id)||0), poll:tPl.get(thread.id)||null},
      posts:posts.results.map(p=>({...p,
        likes:Number(pRm.get(p.id)?.likes||0), liked:Number(pRm.get(p.id)?.liked||0),
        reposts:Number(pQm.get(p.id)||0), poll:pPl.get(p.id)||null})),
      att
    });
  }

  /* ---- 点赞 ----
     一人一次、可撤销。重复点两下由唯一索引兜底，不会造出两行。
     点赞是最轻量的互动，刻意不限流：限它只会误伤正常用户。 */
  if(path==='/api/like'&&method==='POST'){
    const u=await requireUser(req,env);
    let b={}; try{ b=(await req.json())||{} }catch(e){ b={} }
    const type=text(b.target)==='post'?'post':'thread';
    const id=Number(b.id)||0;
    if(id<=0) return json({error:'缺少点赞目标'},400);
    const tbl=type==='post'?'posts':'threads';
    const row=await env.DB.prepare(`SELECT id FROM ${tbl} WHERE id=?`).bind(id).first();
    if(!row) return json({error:'内容不存在'},404);
    const has=await env.DB.prepare(`SELECT id FROM likes WHERE target_type=? AND target_id=? AND user_id=?`).bind(type,id,u.id).first();
    if(has){
      await env.DB.prepare(`DELETE FROM likes WHERE id=?`).bind(has.id).run();
    }else{
      try{ await env.DB.prepare(`INSERT INTO likes(target_type,target_id,user_id) VALUES(?,?,?)`).bind(type,id,u.id).run(); }
      catch(e){ /* 并发重复：唯一索引拦下，按「已点赞」返回即可 */ }
    }
    const n=(await env.DB.prepare(`SELECT COUNT(*) n FROM likes WHERE target_type=? AND target_id=?`).bind(type,id).first())?.n||0;
    return json({ok:true, liked:has?0:1, count:Number(n)});
  }

  /* ---- 投票 ----
     谁能挂投票：内容的作者本人；站主额外可以替别人挂（保护中的内容只有站主能动）。
     一条内容最多一个投票，已经有人投过之后就不再允许改 ——
     悄悄把别人的票换成另一组选项，比不给改更糟。
     投票接口本身不限流：它和点赞一样是轻量互动，限了只会误伤正常用户。 */

  // 取出目标内容并判权限。返回 {row, type, admin} 或抛一个 Response。
  async function pollTarget(req, env, body){
    const u = await requireUser(req, env);
    const type = text(body.target) === 'post' ? 'post' : 'thread';
    const id = Number(body.id) || 0;
    if(id <= 0) throw json({error:'缺少投票目标'},400);
    const row = type === 'post'
      ? await env.DB.prepare(`SELECT p.id,p.author_id,p.protected,p.thread_id,t.locked t_locked,t.protected t_protected
          FROM posts p JOIN threads t ON t.id=p.thread_id WHERE p.id=?`).bind(id).first()
      : await env.DB.prepare(`SELECT id,author_id,protected,locked FROM threads WHERE id=?`).bind(id).first();
    if(!row) throw json({error:'内容不存在'},404);
    const admin = isAdmin(u);
    if(row.author_id !== u.id && !admin) throw json({error:'只能给自己发的内容添加投票'},403);
    if(row.protected && !admin) throw json({error:'这条内容已被站主保护，不能再添加投票'},403);
    // 锁定的主题里不许再挂东西（子管理员也绕不过锁定，那是「讨论到此为止」的意思）
    const locked = type === 'post' ? !!(row.t_locked || row.t_protected) : !!row.locked;
    if(locked && !admin) throw json({error:'该主题已锁定'},403);
    return { u, row, type, id, admin };
  }

  if(path==='/api/poll'&&method==='POST'){
    let b={}; try{ b=(await req.json())||{} }catch(e){ b={} }
    const { u, type, id, admin } = await pollTarget(req, env, b);
    const poll = normalizePoll(b.poll);
    if(!poll) return json({error:'投票需要一句话的问题和至少 2 个不同的选项'},400);
    const exist = await env.DB.prepare(`SELECT id FROM polls WHERE target_type=? AND target_id=?`).bind(type,id).first();
    if(exist){
      if(await pollHasVotes(env, exist.id) && !admin)
        return json({error:'已经有人投过票了，不能再改；确实需要修改请联系管理员'},403);
      await deletePoll(env, type, id);              // 票与选项靠外键级联一起走
    }
    const pid = await attachPoll(env, type, id, poll);
    if(!pid) return json({error:'投票创建失败，请稍后再试'},500);
    const m = await pollMap(env, type, [id], u.id);
    return json({ok:true, id:pid, poll:m.get(id)||null});
  }

  if(path==='/api/poll/remove'&&method==='POST'){
    let b={}; try{ b=(await req.json())||{} }catch(e){ b={} }
    const { type, id, admin } = await pollTarget(req, env, b);
    const exist = await env.DB.prepare(`SELECT id FROM polls WHERE target_type=? AND target_id=?`).bind(type,id).first();
    if(!exist) return json({error:'这条内容没有投票'},404);
    if(await pollHasVotes(env, exist.id) && !admin)
      return json({error:'已经有人投过票了，不能再移除；确实需要移除请联系管理员'},403);
    await deletePoll(env, type, id);
    return json({ok:true});
  }

  if(path==='/api/poll/vote'&&method==='POST'){
    const u=await requireUser(req,env);
    let b={}; try{ b=(await req.json())||{} }catch(e){ b={} }
    const pid=Number(b.poll)||0;
    if(pid<=0) return json({error:'缺少投票对象'},400);
    const p=await env.DB.prepare(`SELECT id,target_type,target_id,multi FROM polls WHERE id=?`).bind(pid).first();
    if(!p) return json({error:'这个投票已经不存在了'},404);
    // 原内容被删 / 进了回收站：票还在库里，但界面上根本看不到它 —— 别让人白投
    if(!(await pollTargetAlive(env, p.target_type, p.target_id))) return json({error:'这条内容已经不在了'},404);
    // 一人一次：先查是为了给一句人话提示，真正兜底的是 poll_ballots 上的唯一索引
    // （并发时第二次插入选票会撞上它，只有一次生效）
    const done=await env.DB.prepare(`SELECT id FROM poll_ballots WHERE poll_id=? AND user_id=?`).bind(pid,u.id).first();
    if(done) return json({error:'你已经投过票了，每人只有一票哦'},409);
    let picks=[];
    const raw=(b.options!=null)?b.options:b.option;
    if(raw!=null) picks=(Array.isArray(raw)?raw:[raw]).map(Number).filter(n=>Number.isInteger(n)&&n>0);
    if(!picks.length) return json({error:'请先选一个选项'},400);
    // 单选时前端多传了也只认第一个；多选去重后按上限截断
    if(!p.multi) picks=picks.slice(0,1);
    else picks=[...new Set(picks)].slice(0, POLL_MAX_OPTIONS);
    // 选项必须属于这个投票 —— 拿别家投票的选项 id 来投是不行的
    const ph=picks.map(()=>'?').join(',');
    const valid=(await env.DB.prepare(`SELECT id FROM poll_options WHERE poll_id=? AND id IN (${ph})`).bind(pid,...picks).all()).results.map(r=>r.id);
    if(!valid.length) return json({error:'选项无效'},400);
    // 先插选票：撞上唯一索引就说明这一票已经投过了（并发时的第二次）
    let bid=0;
    try{
      const br=await env.DB.prepare(`INSERT INTO poll_ballots(poll_id,user_id) VALUES(?,?)`).bind(pid,u.id).run();
      bid=Number(br?.meta?.last_row_id||0);
    }catch(e){ return json({error:'你已经投过票了，每人只有一票哦'},409) }
    if(!bid) return json({error:'投票失败，请稍后再试'},500);
    for(const oid of valid){
      try{ await env.DB.prepare(`INSERT INTO poll_votes(ballot_id,option_id) VALUES(?,?)`).bind(bid,oid).run(); }
      catch(e){ /* 同一项重复勾到（理论上不会），跳过 */ }
    }
    const m=await pollMap(env, p.target_type, [p.target_id], u.id);
    return json({ok:true, voted:1, poll:m.get(p.target_id)||null});
  }

  /* ---- 回收站 ----
     看得到什么：
       · 站主：全部；
       · 其他人：与自己有关的（自己删的 + 自己写的被别人删的）——
         后者照样列出来，但标成「需站主恢复」，不用让人对着空白猜自己写过什么。
     能不能恢复由 canRestoreTrash 统一判，can_restore 字段直接下发，前端不自己算。 */
  if(path==='/api/trash'&&method==='GET'){
    const u=await requireUser(req,env);
    const sp=new URL(req.url).searchParams;
    const limit=Math.min(Math.max(parseInt(sp.get('limit')||'',10)||20,1),50);
    const where=[], arg=[];
    if(!isAdmin(u)){ where.push('author_id=?'); arg.push(u.id); }
    const w=where.length?('WHERE '+where.join(' AND ')):'';
    const total=Number((await env.DB.prepare(`SELECT COUNT(*) n FROM trash ${w}`).bind(...arg).first())?.n||0);
    const pages=Math.max(1,Math.ceil(total/limit));
    const page=Math.min(Math.max(parseInt(sp.get('page')||'',10)||1,1),pages);
    const rows=(await env.DB.prepare(`SELECT * FROM trash ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...arg,limit,(page-1)*limit).all()).results;
    return json({
      // payload 是整行原始数据，前端用不到，别白占流量（删账号那条可能挺大）
      items: rows.map(r=>({ id:r.id, kind:r.kind, target_id:r.target_id, parent_id:r.parent_id,
        author_id:r.author_id, author_name:r.author_name, title:r.title, excerpt:r.excerpt,
        item_count:Number(r.item_count||1), deleted_by_name:r.deleted_by_name,
        by_owner:r.by_owner?1:0, was_protected:r.was_protected?1:0, deleted_at:r.deleted_at,
        can_restore: canRestoreTrash(u,r)?1:0, can_purge: isAdmin(u)?1:0 })),
      total, page, pages, limit, admin: isAdmin(u)?1:0
    });
  }

  if(path==='/api/trash/restore'&&method==='POST'){
    const u=await requireUser(req,env);
    let b={}; try{ b=(await req.json())||{} }catch(e){ b={} }
    const id=Number(b.id)||0;
    const row=await env.DB.prepare(`SELECT * FROM trash WHERE id=?`).bind(id).first();
    if(!row) return json({error:'回收站里没有这条记录了'},404);
    if(!canRestoreTrash(u,row)) return json({error:'这条只有站主能恢复'},403);
    try{
      let n=0;
      if(row.kind==='thread') n=await restoreThreadRow(env,row);
      else if(row.kind==='post'){ await restorePostRow(env,row); n=1 }
      else n=await restoreUserRow(env,row);
      await env.DB.prepare(`DELETE FROM trash WHERE id=?`).bind(id).run();
      return json({ok:true, restored:n, kind:row.kind});
    }catch(e){ return json({error:e.message||'恢复失败'},400) }
  }

  // 编辑主题：作者本人（主题未锁时）或管理员。标题和正文都能改。
  if(tm&&method==='PATCH'){
    const u=await requireUser(req,env), id=Number(tm[1]), b=await req.json();
    const t=await env.DB.prepare(`SELECT id,author_id,locked,title,body,sensitive,protected FROM threads WHERE id=?`).bind(id).first();
    if(!t) return json({error:'主题不存在'},404);
    const isAdmin_=isAdmin(u);
    if(t.author_id!==u.id && !isAdmin_) return json({error:'只能编辑自己的主题'},403);
    // 受保护的内容所有权已经交给站主，原作者连自己的帖也改不动
    if(t.protected && !isAdmin_) return json({error:'这条内容已被站主保护，原作者不能再修改'},403);
    if(t.locked && !isAdmin_) return json({error:'该主题已锁定'},403);
    const title=(b.title==null?t.title:cleanTitle(b.title));
    const body=(b.body==null?t.body:cleanBody(b.body));
    // 只挂了投票的主题正文可能就是空的 —— 编辑标题时不该被逼着补一段正文
    const hasPoll=!!(await env.DB.prepare(`SELECT id FROM polls WHERE target_type='thread' AND target_id=?`).bind(id).first());
    if(title.length<2||(body.length<1 && !hasPoll)) return json({error:'标题和正文不能为空'},400);
    // sensitive 没传就保持原样；传了就按 0/1 落库
    const sensitive=(b.sensitive==null?(t.sensitive?1:0):toFlag(b.sensitive));
    const textChanged = !(title===t.title && body===t.body);
    // 只改了「不易展示」这一项时不写编辑痕迹 —— 那表记的是正文改动，
    // 塞一条 before=after 的空记录进去只会让人以为正文被人动过。
    if(!textChanged && sensitive===(t.sensitive?1:0)) return json({ok:true,id,changed:false});
    if(!textChanged){
      await env.DB.prepare(`UPDATE threads SET sensitive=? WHERE id=?`).bind(sensitive,id).run();
      return json({ok:true,id,changed:true,sensitive});
    }
    // 只改了标题时不留正文编辑痕迹：那表记的是正文改动，
    // 塞一条 before=after 的空记录进去，人点开「已编辑」只会看到两个空白框。
    if(body!==t.body) await recordEdit(env,'thread',id,u.id,t.body,body);
    await env.DB.prepare(`UPDATE threads SET title=?,body=?,edited_at=datetime('now'),sensitive=? WHERE id=?`).bind(title,body,sensitive,id).run();
    return json({ok:true,id,changed:true,sensitive});
  }

  // 删除主题：作者本人或管理员。删除 = 移入回收站，作者与管理员的区别只在「谁能恢复」。
  if(tm&&method==='DELETE'){
    const u=await requireUser(req,env); const id=Number(tm[1]);
    const t=await env.DB.prepare(`SELECT id,author_id,protected FROM threads WHERE id=?`).bind(id).first();
    if(!t) return json({error:'主题不存在'},404);
    if(t.author_id!==u.id && u.role!=='admin') return json({error:'只能删除自己的主题'},403);
    // 受保护 = 所有权在站主手上，连作者本人也删不掉（子管理员更不行）
    if(t.protected && u.role!=='admin') return json({error:'这条内容已被站主保护，只有站主能删除'},403);
    // 先收进回收站：主题 + 它下面所有回复（含别人的），随时可以放回来
    const tr=await trashThread(env, id, u);
    // 赞挂在内容上、不是外键，必须自己清（先清回复的，再清主题的）
    const kids=(await env.DB.prepare(`SELECT id FROM posts WHERE thread_id=?`).bind(id).all()).results.map(p=>p.id);
    await purgeLikes(env,'post',kids);
    await purgeLikes(env,'thread',id);
    await env.DB.prepare(`DELETE FROM posts WHERE thread_id=?`).bind(id).run();   // 先清回复（外键本可级联，显式删除更稳妥）
    await env.DB.prepare(`DELETE FROM threads WHERE id=?`).bind(id).run();
    // trashId 回传：前端拿它做「撤销」（就是直接调 /api/trash/restore）
    return json({ok:true, trashed:true, trashId:tr.id, items:tr.items});
  }

  // 删除回复：作者本人或管理员（同样是移入回收站）
  if(pdm&&method==='DELETE'){
    const u=await requireUser(req,env); const id=Number(pdm[1]);
    const p=await env.DB.prepare(`SELECT id,author_id,protected FROM posts WHERE id=?`).bind(id).first();
    if(!p) return json({error:'回复不存在'},404);
    if(p.author_id!==u.id && u.role!=='admin') return json({error:'只能删除自己的回复'},403);
    if(p.protected && u.role!=='admin') return json({error:'这条内容已被站主保护，只有站主能删除'},403);
    const trashId=await trashPost(env, id, u, null);
    await purgeLikes(env,'post',id);
    // 别人回复它时会置空 reply_to（ON DELETE SET NULL），楼不会塌，只是变回顶层
    await env.DB.prepare(`DELETE FROM posts WHERE id=?`).bind(id).run();
    return json({ok:true, trashed:true, trashId});
  }

  // 编辑回复：作者本人或管理员。锁定主题里的回复只有管理员能改。
  if(pdm&&method==='PATCH'){
    const u=await requireUser(req,env), id=Number(pdm[1]), b=await req.json();
    const p=await env.DB.prepare(`SELECT p.id,p.author_id,p.body,p.thread_id,p.sensitive,p.protected,t.locked FROM posts p JOIN threads t ON t.id=p.thread_id WHERE p.id=?`).bind(id).first();
    if(!p) return json({error:'回复不存在'},404);
    const isAdmin_=isAdmin(u);
    if(p.author_id!==u.id && !isAdmin_) return json({error:'只能编辑自己的回复'},403);
    // 受保护的回复所有权在站主手上（主题受保护不算，那条回复得自己也被保护）
    if(p.protected && !isAdmin_) return json({error:'这条回复已被站主保护，原作者不能再修改'},403);
    if(p.locked && !isAdmin_) return json({error:'该主题已锁定'},403);
    // body 不传就当「正文不动」：只想翻一下「不易展示」标记时不该被逼着重打一遍正文
    const body=(b.body==null?p.body:cleanBody(b.body));
    // 同上：只挂了投票的回复正文本来就是空的
    const hasPoll=!!(await env.DB.prepare(`SELECT id FROM polls WHERE target_type='post' AND target_id=?`).bind(id).first());
    if(!body && !hasPoll) return json({error:'回复不能为空'},400);
    const sensitive=(b.sensitive==null?(p.sensitive?1:0):toFlag(b.sensitive));
    if(body===p.body && sensitive===(p.sensitive?1:0)) return json({ok:true,id,changed:false});
    // 只翻「不易展示」时不留编辑痕迹（理由同主题编辑）
    if(body===p.body){
      await env.DB.prepare(`UPDATE posts SET sensitive=? WHERE id=?`).bind(sensitive,id).run();
      return json({ok:true,id,changed:true,sensitive});
    }
    await recordEdit(env,'post',id,u.id,p.body,body);
    await env.DB.prepare(`UPDATE posts SET body=?,edited_at=datetime('now'),sensitive=? WHERE id=?`).bind(body,sensitive,id).run();
    return json({ok:true,id,changed:true,sensitive});
  }

  // 编辑痕迹：谁改的、改成什么样。作者本人和管理员能看，其他人只看到「已编辑」的时间。
  const em=path.match(/^\/api\/(posts|threads)\/(\d+)\/edits$/);
  if(em&&method==='GET'){
    const type=em[1]==='threads'?'thread':'post', id=Number(em[2]);
    const u=await requireUser(req,env);
    const owner=type==='thread'
      ? await env.DB.prepare(`SELECT author_id FROM threads WHERE id=?`).bind(id).first()
      : await env.DB.prepare(`SELECT author_id FROM posts WHERE id=?`).bind(id).first();
    if(!owner) return json({error:'内容不存在'},404);
    if(owner.author_id!==u.id && !isAdmin(u)) return json({error:'只有作者和管理员能查看编辑记录'},403);
    const rows=await env.DB.prepare(`SELECT e.id,e.editor_id,e.before_body,e.after_body,e.created_at,u.username FROM post_edits e LEFT JOIN users u ON u.id=e.editor_id WHERE e.target_type=? AND e.target_id=? ORDER BY e.id`).bind(type,id).all();
    return json({edits:rows.results});
  }

  if(pm&&method==='POST'){
    const u=await requireUser(req,env), id=Number(pm[1]), b=await req.json(), body=cleanBody(b.body);
    // 只挂一个投票的回复也算有内容（同上：投票不合规就当没传）
    const poll=normalizePoll(b.poll);
    if(!body && !poll) return json({error:'回复不能为空'},400);
    const t=await env.DB.prepare(`SELECT locked FROM threads WHERE id=?`).bind(id).first(); if(!t) return json({error:'主题不存在'},404); if(t.locked && u.role!=='admin') return json({error:'该主题已锁定'},403);
    // 楼中楼：replyTo 必须是同一主题里的回复，跨主题引用一律丢弃（不当报错，回复照样发出去）
    let replyTo=null;
    const rid=Number(b.replyTo)||0;
    if(rid>0){
      const target=await env.DB.prepare(`SELECT id FROM posts WHERE id=? AND thread_id=?`).bind(rid,id).first();
      if(target) replyTo=rid;
    }
    const sensitive=toFlag(b.sensitive);
    // quote：回复里也能挂一张引用卡（引用别的主题，或同帖里的某条回复）。
    // 目标不存在就丢弃引用，回复本身照发 —— 引用只是附加信息，不该让话发不出去。
    const quote=await buildQuote(env, b.quote);
    const pr=await env.DB.prepare(`INSERT INTO posts(thread_id,author_id,body,reply_to,sensitive,quote_ref,quote_snapshot) VALUES(?,?,?,?,?,?,?)`).bind(id,u.id,body,replyTo,sensitive,quote?quote.ref:null,quote?quote.snapshot:null).run();
    if(poll) await attachPoll(env,'post',pr.meta.last_row_id,poll);
    await env.DB.prepare(`UPDATE threads SET updated_at=datetime('now') WHERE id=?`).bind(id).run();
    return json({ok:true,replyTo,sensitive,quote:quote?quote.ref:null,poll:poll?1:0});
  }

  /* ---- 管理端 ----
     权限分三级：
       user      —— 只能删自己的内容
       moderator —— 内容治理：删回复、删主题、置顶、锁定（仅此四项，白名单 MOD_ACTIONS）
       admin     —— 全权：另加封禁/解封、删号、重置密码、开关他人 2FA、任命/撤销子管理员
     接口本身一律先 requireMod，只有白名单里的治理动作才允许子管理员走。 */
  if(adm){
    const me_=await requireMod(req,env); const action=adm[1];

    // 请求体只能读一次，这里统一解析后往下传，避免各分支重复 req.json()。
    // 解析失败视为空体：绝大多数分支本来就会因缺少参数返回 400。
    // admin-get 这类无体请求也用同一个变量兜底，不会因此报错。
    let b={};
    // storage-import 走 multipart/form-data，绝不能先 req.json() —— body 是一次性流，
    // 读走了 formData() 就再取不到文件了。
    const isMultipart = (action==='storage-import' && method==='POST');
    if(method==='POST' && !isMultipart){ try{ b=(await req.json())||{}; }catch(e){ b={}; } }

    // --- 内容治理：子管理员可用的四个动作（白名单）---
    if(method==='POST' && action==='moderate' && MOD_ACTIONS.has(text(b.type))){
      const type=text(b.type), id=Number(b.id);
      if(!Number.isInteger(id)||id<=0) return json({error:'缺少目标 ID'},400);
      /* 受保护的内容：所有权在站主手上，子管理员一律碰不得（置顶、锁定、标记、删除都不行）。
         作者本人删不掉它，治理动作也改不动它 —— 这才叫「保护」。
         站主自己走同一条路，不受这条限制。 */
      if(!isAdmin(me_)){
        const tgt=text(b.target)==='post' || type==='deletePost' ? 'posts' : 'threads';
        const pr=await env.DB.prepare(`SELECT protected FROM ${tgt} WHERE id=?`).bind(id).first();
        if(pr && pr.protected) return json({error:'这条内容已被站主保护，子管理员不能修改或删除'},403);
      }
      if(type==='deletePost'){
        const trashId=await trashPost(env,id,me_,null);
        await purgeLikes(env,'post',id);
        await env.DB.prepare(`DELETE FROM posts WHERE id=?`).bind(id).run();
        return json({ok:true,trashed:true,trashId})
      }
      if(type==='deleteThread'){
        // 删主题要连带清掉楼中回复；老库的 threads.author_id 外键没有级联，必须显式删除
        const kids=(await env.DB.prepare(`SELECT id FROM posts WHERE thread_id=?`).bind(id).all()).results.map(p=>p.id);
        const tr=await trashThread(env,id,me_);
        await purgeLikes(env,'post',kids);
        await purgeLikes(env,'thread',id);
        await env.DB.prepare(`DELETE FROM posts WHERE thread_id=?`).bind(id).run();
        await env.DB.prepare(`DELETE FROM threads WHERE id=?`).bind(id).run();
        return json({ok:true,trashed:true,trashId:tr.id,items:tr.items})
      }
      if(type==='moveThread'){
        // 把主题挪到某个板块（boardId 为空/0 = 挪回「未分类」）。
        // 只改归属，不动内容也不碰作者，完全可逆 —— 所以子管理员也能做。
        const t=await env.DB.prepare(`SELECT id FROM threads WHERE id=?`).bind(id).first();
        if(!t) return json({error:'主题不存在'},404);
        const bid=Number(b.boardId)||0;
        if(bid>0 && !(await env.DB.prepare(`SELECT id FROM boards WHERE id=?`).bind(bid).first())) return json({error:'板块不存在'},404);
        await env.DB.prepare(`UPDATE threads SET board_id=? WHERE id=?`).bind(bid>0?bid:null, id).run();
        return json({ok:true})
      }
      if(type==='pin'||type==='lock'){
        const field=type==='pin'?'pinned':'locked';
        const t=await env.DB.prepare(`SELECT id FROM threads WHERE id=?`).bind(id).first();
        if(!t) return json({error:'主题不存在'},404);
        await env.DB.prepare(`UPDATE threads SET ${field}=1-${field} WHERE id=?`).bind(id).run();
        return json({ok:true})
      }
      if(type==='sensitive'){
        // 把别人的帖子标成「不易展示」（或取消）：创作者自己忘了标、或事后被人举报时走这里。
        // target 决定动 threads 还是 posts —— 两者的 id 是各自的序列，光靠 id 分不出来。
        const tbl = text(b.target)==='post' ? 'posts' : 'threads';
        const row=await env.DB.prepare(`SELECT id,sensitive FROM ${tbl} WHERE id=?`).bind(id).first();
        if(!row) return json({error:'内容不存在'},404);
        // 没给 value 就是翻转；给了就按给的值写死（前端两个按钮都传明确的值，避免并发误翻）
        const next = (b.value==null) ? (row.sensitive?0:1) : toFlag(b.value);
        await env.DB.prepare(`UPDATE ${tbl} SET sensitive=? WHERE id=?`).bind(next,id).run();
        return json({ok:true, sensitive:next})
      }
    }

    // moderate 里带管理员专属动作（ban/unban）时，子管理员会掉到这里被拦住
    if(method==='POST' && action==='moderate' && !isAdmin(me_)) return json({error:'该操作需要管理员权限'},403);

    // --- 以下为管理员专属：子管理员一律 403 ---
    await requireAdmin(req,env);

    /* ================= 附件存储：站主专属 =================
       整套「备份 → 确认 → 清除 → 还原」都收在这里。
       设计原则：清除动作是**不可逆**的，所以必须先有「真的下载过」的通行证。 */

    // 当前配置与资产概况
    /* 上传大小上限：管理员可随时调，0 = 不限制。
       平台层面还有一道 100 MB 的墙（Workers 请求体上限），代码拦不住，只能如实告诉站主。 */
    if(action==='upload-limit'&&method==='GET'){
      const [u,a]=await Promise.all([uploadLimitBytes(env,''),uploadLimitBytes(env,'avatar')]);
      return json({
        uploadMb: Math.round(u/1024/1024), avatarMb: Math.round(a/1024/1024),
        platformMaxMb: PLATFORM_MAX_MB
      });
    }
    if(action==='upload-limit'&&method==='POST'){
      const um=Math.floor(Number(b.uploadMb)), am=Math.floor(Number(b.avatarMb));
      if(!Number.isFinite(um)||!Number.isFinite(am)||um<0||am<0)
        return json({error:'上限必须是非负整数（MB），0 表示不限制'},400);
      if(am>0 && um>0 && am>um) return json({error:'头像上限不能大于附件上限'},400);
      // 超过平台的墙就说清楚：存下来也没用，客户端照样发不出去，
      // 最后只会变成「进度条走到头然后卡死」。夹住并告诉站主实际生效多少。
      const clamped = um > PLATFORM_MAX_MB;
      const stored = clamped ? PLATFORM_MAX_MB : um;
      await Promise.all([
        setSetting(env,'upload_limit_mb',String(stored),me_.id),
        setSetting(env,'avatar_limit_mb',String(Math.min(am,PLATFORM_MAX_MB)),me_.id)
      ]);
      return json({ok:true, uploadMb:stored, avatarMb:am, platformMaxMb:PLATFORM_MAX_MB, clamped});
    }

    if(action==='storage'&&method==='GET'){
      const cfg=await rawStorageConfig(env);
      const st=await env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM attachments`).first();
      let armedInfo=null;
      try{ armedInfo=JSON.parse(await getSetting(env,'storage_archive_ready')||'null'); }catch(e){ }
      return json({ config:publicStorageConfig(cfg), attachments:{ count:st?.n||0, bytes:st?.bytes||0 }, armed:armedInfo });
    }

    // 保存 / 更换存储接口（运行时生效，无需重新部署 Worker）
    if(action==='storage-config'&&method==='POST'){
      const type=text(b.type)||'none';
      if(!['none','webdav','r2'].includes(type)) return json({error:'存储类型无效'},400);
      const cfg={ type, enabled:!!b.enabled };
      if(type==='webdav'){
        const baseUrl=text(b.baseUrl), username=text(b.username), password=String(b.password||'');
        if(!baseUrl) return json({error:'请填写 WebDAV 地址'},400);
        if(!/^https?:\/\//i.test(baseUrl)) return json({error:'WebDAV 地址必须以 http(s):// 开头'},400);
        // 密码留空 = 沿用已保存的那一串，避免站主只想改地址时被逼着重输一遍
        const prev=await storageConfig(env);
        const pw=password||(prev.webdav?.password||'');
        if(!pw) return json({error:'请填写 WebDAV 密码'},400);
        cfg.webdav={ baseUrl:baseUrl.replace(/\/+$/,''), username, password_sealed: await sealSecret(env,pw) };
      }
      if(type==='r2') cfg.r2={ binding: text(b.binding)||'BUCKET' };
      await setSetting(env,'storage_config',JSON.stringify(cfg),me_.id);
      // 换了存储，原来那张「已备份」的通行证立即作废，必须重新导出确认
      await env.DB.prepare(`DELETE FROM settings WHERE key='storage_archive_ready'`).run();
      return json({ok:true, config:publicStorageConfig(await rawStorageConfig(env))});
    }

    // 连通性自检：写完 → 读回 → 删掉，三步都过才算通
    if(action==='storage-test'&&method==='POST'){
      try{
        const type=text(b.type)||'none';
        if(type==='r2'){
          const r=await storeTest({type:'r2',r2:{binding:text(b.binding)||'BUCKET'}},env);
          return json({ok:true, detail:r.detail});
        }
        if(type==='webdav'){
          if(!text(b.baseUrl)) return json({error:'请先填写 WebDAV 地址'},400);
          const prev=await storageConfig(env);
          const pw=String(b.password||'')||(prev.webdav?.password||'');
          const r=await storeTest({type:'webdav',webdav:{baseUrl:text(b.baseUrl),username:text(b.username),password:pw}},env);
          return json({ok:true, detail:r.detail});
        }
        return json({error:'尚未选择存储类型'},400);
      }catch(e){ return json({error:e.message||'连接失败'},400); }
    }

    // 导出备份包（流式 ZIP，支持分批：offset / limit）
    if(action==='storage-archive'&&method==='GET'){
      const limit=Math.min(Math.max(Number(url.searchParams.get('limit')||50),1),100);
      const offset=Math.max(Number(url.searchParams.get('offset')||0),0);
      const total=(await env.DB.prepare(`SELECT COUNT(*) n FROM attachments`).first())?.n||0;
      const cfg=await storageConfig(env);
      if(!cfg.type||cfg.type==='none') return json({error:'尚未配置外部存储，无法从远端取回文件'},400);

      const rows=(await env.DB.prepare(`SELECT * FROM attachments ORDER BY id LIMIT ? OFFSET ?`).bind(limit,offset).all()).results;
      // 一次性捞出所有含 [img:n] 的帖子再在内存里配对，避免每个附件查两次库的 N+1
      const thAll=(await env.DB.prepare(`SELECT * FROM threads WHERE body LIKE '%[img:%'`).all()).results;
      const poAll=(await env.DB.prepare(`SELECT * FROM posts WHERE body LIKE '%[img:%'`).all()).results;
      const idSet=new Set(rows.map(r=>r.id));
      const matchIds=(s)=>{
        const out=new Set(); const re=/\[img:(\d+)\]/g; let m;
        while((m=re.exec(s||''))){ if(idSet.has(Number(m[1]))) out.add(Number(m[1])); }
        return [...out];
      };
      const references=[];
      for(const t of thAll){ const ids=matchIds(t.body); if(ids.length) references.push({kind:'thread', id:t.id, attachments:ids, record:t}); }
      for(const p of poAll){ const ids=matchIds(p.body); if(ids.length) references.push({kind:'post', id:p.id, attachments:ids, record:p}); }

      const missing=[];
      async function* build(){
        for(const r of rows){
          try{
            const got=await storeGet(env,cfg,r.storage_key);
            if(!got){ missing.push({id:r.id, storage_key:r.storage_key, reason:'远端已不存在'}); continue; }
            const bytes=new Uint8Array(await new Response(got.body).arrayBuffer());
            const safe=(r.original_name||'file').replace(/[^0-9A-Za-z._\-\u4e00-\u9fa5]/g,'_');
            yield { name:`files/${r.id}-${safe}`.slice(0,180), bytes };
          }catch(e){ missing.push({id:r.id, storage_key:r.storage_key, reason:e.message}); }
        }
        // manifest 放最后一味：这样它能把上面统计出的 missing 一起封进包，
        // 站主拿到手就能看出哪几个没拉回来。
        const manifest={
          format:'xinji-bbs-archive', version:1, exported_at:new Date().toISOString(),
          part:{ offset, limit, returned:rows.length, total, hasMore: offset+rows.length<total },
          attachments: rows.map(r=>({id:r.id, owner_id:r.owner_id, storage_key:r.storage_key, mime:r.mime,
            size:r.size, width:r.width, height:r.height, original_name:r.original_name, created_at:r.created_at})),
          references, missing
        };
        yield { name:'manifest.json', bytes: encoder.encode(JSON.stringify(manifest,null,2)) };
      }
      const partNo=Math.floor(offset/limit)+1;
      return new Response(zipStream(zipEntries(build())),{ headers:{
        'content-type':'application/zip',
        'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(`xinji-attachments-part${partNo}.zip`)}`,
        'cache-control':'no-store',
        'X-Next-Offset': String(offset+rows.length),
        'X-Has-More': (offset+rows.length<total)?'1':'0'
      }});
    }

    // 站主确认「我已下载备份」→ 发放一次性通行证，才解锁后面的清除
    if(action==='storage-confirm'&&method==='POST'){
      const n=(await env.DB.prepare(`SELECT COUNT(*) n FROM attachments`).first())?.n||0;
      await setSetting(env,'storage_archive_ready',JSON.stringify({at:Date.now(), count:n}),me_.id);
      return json({ok:true, count:n});
    }

    // 彻底清除：删掉所有带图的主题与回复，并清空附件与远端文件
    if(action==='storage-purge'&&method==='POST'){
      const raw=await getSetting(env,'storage_archive_ready');
      if(!raw) return json({error:'请先在上方导出备份包、下载到本地，再点「我已下载」'},403);
      let armed=null; try{ armed=JSON.parse(raw); }catch(e){ }
      if(!armed) return json({error:'备份确认记录已损坏，请重新导出并确认'},403);
      const nowCount=(await env.DB.prepare(`SELECT COUNT(*) n FROM attachments`).first())?.n||0;
      if(armed.count!==nowCount) return json({error:`备份之后又新增了附件（备份时 ${armed.count} 个，现在 ${nowCount} 个），请重新导出完整备份`},409);
      if(Date.now()-armed.at > 6*3600*1000) return json({error:'备份确认已超过 6 小时，请重新导出一次备份'},403);
      if(text(b.confirm)!=='DELETE') return json({error:'缺少清除确认标记'},400);

      const cfg=await storageConfig(env);
      const rows=(await env.DB.prepare(`SELECT * FROM attachments`).all()).results;

      // 先连带删掉带图主题的回复，再删主题，最后删被直接引用附件的回复
      await env.DB.prepare(`DELETE FROM posts WHERE thread_id IN (SELECT id FROM threads WHERE body LIKE '%[img:%')`).run();
      const rT=await env.DB.prepare(`DELETE FROM threads WHERE body LIKE '%[img:%'`).run();
      const rP=await env.DB.prepare(`DELETE FROM posts WHERE body LIKE '%[img:%'`).run();

      // 远端尽力删：删不掉也要如实报出来，绝不假装成功
      let remoteFailed=0;
      for(const r of rows){ try{ await storeDelete(env,cfg,r.storage_key); }catch(e){ remoteFailed++; } }
      await env.DB.prepare(`DELETE FROM attachments`).run();

      // 顺手把存储关掉，避免清除后用户还能继续传
      const nextCfg={ ...(await rawStorageConfig(env)), enabled:false };
      await setSetting(env,'storage_config',JSON.stringify(nextCfg),me_.id);
      await env.DB.prepare(`DELETE FROM settings WHERE key='storage_archive_ready'`).run();

      // 顺手把头像引用清掉：文件已经不在了，留着 att:<id> 只会让前端渲染出破图
      await env.DB.prepare(`UPDATE users SET avatar=NULL WHERE avatar LIKE 'att:%'`).run();
      // 还有指向已删内容的赞。likes.target_id 不是外键（同一列要指向两张表，做不到），
      // 这一步是唯一能兜住「一批内容被整片删掉」的地方。
      try{
        await env.DB.prepare(
          `DELETE FROM likes WHERE (target_type='thread' AND target_id NOT IN (SELECT id FROM threads))
              OR (target_type='post' AND target_id NOT IN (SELECT id FROM posts))`).run();
        // 投票同理：这一批内容是直接删掉的（没进回收站），挂在它们上面的投票必须跟着走，
        // 否则 polls.target_id 会永远指向一个不存在的帖子（它没有外键，清不掉自己）。
        await env.DB.prepare(
          `DELETE FROM polls WHERE (target_type='thread' AND target_id NOT IN (SELECT id FROM threads))
              OR (target_type='post' AND target_id NOT IN (SELECT id FROM posts))`).run();
      }catch(e){ }
      return json({ ok:true, removedThreads:rT?.meta?.changes||0, removedPosts:rP?.meta?.changes||0,
        removedAttachments:rows.length, remoteFailed });
    }

    // 从备份包还原（multipart 上传 ZIP）
    if(action==='storage-import'&&method==='POST'){
      const ct=String(req.headers.get('content-type')||'').toLowerCase();
      if(!ct.includes('multipart/form-data')) return json({error:'请通过文件上传方式提交 ZIP'},400);
      let fd; try{ fd=await req.formData(); }catch(e){ return json({error:'无法解析上传内容'},400) }
      const file=fd.get('file');
      if(!file||typeof file.arrayBuffer!=='function') return json({error:'没有收到文件'},400);
      const buf=new Uint8Array(await file.arrayBuffer());
      if(buf.length>MAX_IMPORT_BYTES) return json({error:`备份包过大（上限 ${Math.floor(MAX_IMPORT_BYTES/1024/1024)} MB）`},400);
      let entries; try{ entries=parseZipBytes(buf); }catch(e){ return json({error:e.message||'ZIP 解析失败'},400) }

      const cfg=await storageConfig(env);
      if(!cfg.type||cfg.type==='none') return json({error:'请先在上方配置并启用外部存储，再执行导入'},400);

      const manEntry=entries.find(e=>e.name==='manifest.json'||e.name.endsWith('manifest.json'));
      if(!manEntry) return json({error:'包内缺少 manifest.json，无法还原'},400);
      let man; try{ man=JSON.parse(new TextDecoder().decode(await inflateZipEntry(manEntry))); }catch(e){ return json({error:'manifest.json 解析失败'},400) }

      let restored=0, skipped=0, failed=0;
      for(const fe of entries.filter(e=>e.name.startsWith('files/'))){
        const m=fe.name.match(/^files\/(\d+)-/);
        if(!m){ skipped++; continue; }
        const meta=(man.attachments||[]).find(a=>a.id===Number(m[1]));
        if(!meta){ skipped++; continue; }
        // 原作者已注销则跳过，避免造出没有主人的孤儿数据
        const owner=await env.DB.prepare(`SELECT id FROM users WHERE id=?`).bind(meta.owner_id).first();
        if(!owner){ skipped++; continue; }
        try{
          const bytes=await inflateZipEntry(fe);
          // 用返回的 key 回写：万一撞上 423 换过文件名，库里也要跟着改
          const putKey=(await storePut(env,cfg,meta.storage_key,bytes,meta.mime||'application/octet-stream'))||meta.storage_key;
          await env.DB.prepare(
            `INSERT OR REPLACE INTO attachments(id,owner_id,storage_key,mime,size,width,height,original_name,created_at)
             VALUES(?,?,?,?,?,?,?,?,?)`)
            .bind(meta.id, meta.owner_id, putKey, meta.mime||'application/octet-stream', bytes.length,
                  meta.width??null, meta.height??null, meta.original_name||'', meta.created_at||new Date().toISOString()).run();
          restored++;
        }catch(e){ failed++; }
      }

      // 再把引用了这些附件的帖子补回去（保留原始 id，正文里的 [img:n] 才对得上）
      let restoredThreads=0, restoredPosts=0;
      for(const ref of (man.references||[])){
        const rec=ref.record;
        if(!rec) continue;
        try{
          if(ref.kind==='thread'){
            const author=await env.DB.prepare(`SELECT id FROM users WHERE id=?`).bind(rec.author_id).first();
            if(!author) continue;
            await env.DB.prepare(
              `INSERT OR REPLACE INTO threads(id,title,author_id,body,pinned,locked,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
              .bind(rec.id,rec.title,rec.author_id,rec.body,rec.pinned?1:0,rec.locked?1:0,rec.created_at,rec.updated_at).run();
            restoredThreads++;
          }else if(ref.kind==='post'){
            const t=await env.DB.prepare(`SELECT id FROM threads WHERE id=?`).bind(rec.thread_id).first();
            const author=await env.DB.prepare(`SELECT id FROM users WHERE id=?`).bind(rec.author_id).first();
            if(!t||!author) continue;              // 主题或作者已不在，这条回复没法复原
            await env.DB.prepare(
              `INSERT OR REPLACE INTO posts(id,thread_id,author_id,body,created_at) VALUES(?,?,?,?,?)`)
              .bind(rec.id,rec.thread_id,rec.author_id,rec.body,rec.created_at).run();
            restoredPosts++;
          }
        }catch(e){ /* 单条失败不拖垮整体 */ }
      }
      return json({ok:true, restored, skipped, failed, restoredThreads, restoredPosts});
    }

    // 清理「传了但没被任何帖子引用」的孤儿附件。
    // 传完不发帖就关页面、或帖子被删而附件没跟着清，都会留下这类文件，
    // 它们躺在网盘里白占空间，又不会被任何人看到。
    if(action==='storage-sweep'&&method==='POST'){
      const rows=(await env.DB.prepare(`SELECT id,storage_key,created_at FROM attachments`).all()).results;
      const texts=[
        ...(await env.DB.prepare(`SELECT body FROM threads WHERE body LIKE '%[img:%'`).all()).results.map(r=>r.body),
        ...(await env.DB.prepare(`SELECT body FROM posts WHERE body LIKE '%[img:%'`).all()).results.map(r=>r.body)
      ];
      const used=new Set();
      for(const t of texts){ const re=/\[img:(\d+)\]/g; let m; while((m=re.exec(t||''))) used.add(Number(m[1])); }
      /* 回收站里的正文也算「有人引用」：
         删帖时附件并不会跟着消失，如果这里只认活跃帖，回收站里的帖子一旦超过 24 小时
         图片就被当孤儿清掉了 —— 之后再点「恢复」，恢复回来的是一堆破图，
         那这个后悔药就是残的。 */
      const trashed=(await env.DB.prepare(`SELECT title,excerpt,body FROM trash`).all()).results;
      const trashText=[];
      for(const r of trashed) trashText.push(r.title||'', r.excerpt||'', r.body||'', r.payload||'');
      for(const t of trashText){ const re=/\[img:(\d+)\]/g; let m; while((m=re.exec(t))) used.add(Number(m[1])); }
      // 正在当头像用的附件必须排除：头像不会被任何帖子引用，
      // 按「有没有被 [img:n] 用到」判断它就是个孤儿，照老规则清一次，所有人的头像都会变破图。
      // （反过来，传了头像却没点保存的那些仍在 avatars/ 里，24 小时后照常回收，不会白占空间。）
      const avatarIds=new Set((await env.DB.prepare(`SELECT avatar FROM users WHERE avatar LIKE 'att:%'`).all()).results
        .map(r=>Number(String(r.avatar||'').slice(4))).filter(n=>n>0));
      // 只清 24 小时以前的：刚传完还没来得及发帖的那部分要留着，不能误伤
      const cut=new Date(Date.now()-24*3600*1000).toISOString().replace('T',' ').slice(0,19);
      const orphan=rows.filter(r=>!used.has(r.id) && !avatarIds.has(r.id) && String(r.created_at||'') < cut);
      const cfg=await storageConfig(env);
      let failed=0;
      for(const r of orphan){ try{ await storeDelete(env,cfg,r.storage_key) }catch(e){ failed++ } }
      for(const r of orphan){ await env.DB.prepare(`DELETE FROM attachments WHERE id=?`).bind(r.id).run(); }
      return json({ok:true, removed:orphan.length, failed});
    }

    if(action==='users'&&method==='GET'){
      // avatar 必须带上：管理中心那一行要显示真实头像，
      // 少了它前端只能退化成「用户名首字」的色块，看着像头像全丢了。
      // duress_*：管理中心要显示「保护中」并能一键解除，也顺带告诉站主这人设过胁迫密码。
      const r=await env.DB.prepare(`SELECT id,username,role,banned,created_at,totp_enabled,avatar,duress_state,duress_at,duress_by,CASE WHEN duress_hash IS NULL THEN 0 ELSE 1 END duress_set FROM users ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, id DESC LIMIT 200`).all();
      return json(r.results)
    }
    if(action==='posts'&&method==='GET'){const r=await env.DB.prepare(`SELECT p.id,p.body,p.created_at,p.thread_id,p.sensitive,p.protected,t.title,u.username,u.avatar FROM posts p JOIN threads t ON t.id=p.thread_id JOIN users u ON u.id=p.author_id ORDER BY p.id DESC LIMIT 200`).all(); return json(r.results)}

    // 管理员重置任意用户密码（该用户所有会话立即失效）
    if(action==='set-password'&&method==='POST'){
      const id=Number(b.id), newP=String(b.newPassword||'');
      if(!id) return json({error:'缺少用户 ID'},400);
      if(newP.length<8) return json({error:'新密码至少 8 位'},400);
      if(newP.length>200) return json({error:'新密码过长'},400);
      const target=await env.DB.prepare(`SELECT id,username,role FROM users WHERE id=?`).bind(id).first();
      if(!target) return json({error:'用户不存在'},404);
      // 不允许重置管理员（含自己）：避免管理员之间互相夺权，也避免误把自己踢下线
      if(isAdmin(target)) return json({error:'不能重置管理员的密码，请由该管理员在「设置」中自行修改'},403);
      const ph=await passwordHash(newP);
      await env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=?`).bind(ph,id).run();
      await destroyUserSessions(env,id);   // 强制重新登录
      return json({ok:true});
    }

    // 任命 / 撤销 子管理员（仅管理员可操作）
    if(action==='set-role'&&method==='POST'){
      const id=Number(b.id), role=text(b.role);
      if(!id) return json({error:'缺少用户 ID'},400);
      if(!ROLES.includes(role)) return json({error:'角色无效'},400);
      const target=await env.DB.prepare(`SELECT id,username,role FROM users WHERE id=?`).bind(id).first();
      if(!target) return json({error:'用户不存在'},404);
      // 管理员这个角色只能通过权限转移产生，不允许从这个接口写入，防止越权造 admin
      if(role===ROLE_ADMIN) return json({error:'管理员身份不能在这里授予'},403);
      if(isAdmin(target)) return json({error:'不能修改管理员的角色'},403);
      if(target.banned && role===ROLE_MOD) return json({error:'请先解封该用户，再任命为子管理员'},400);
      await env.DB.prepare(`UPDATE users SET role=? WHERE id=?`).bind(role,id).run();
      // 角色变了，让该用户重新登录一次，权限快照立刻刷新
      await destroyUserSessions(env,id);
      return json({ok:true, role, label:ROLE_LABEL[role]});
    }

    // 管理员关闭任意用户的 2FA（用户丢失认证器时的唯一自救通道）
    if(action==='disable-2fa'&&method==='POST'){
      const id=Number(b.id);
      if(!id) return json({error:'缺少用户 ID'},400);
      const target=await env.DB.prepare(`SELECT id,username,role,totp_enabled FROM users WHERE id=?`).bind(id).first();
      if(!target) return json({error:'用户不存在'},404);
      if(isAdmin(target)) return json({error:'不能关闭管理员的两步验证'},403);
      if(!target.totp_enabled) return json({error:'该用户未开启两步验证'},400);
      await env.DB.prepare(`UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?`).bind(id).run();
      await destroyUserSessions(env,id);
      return json({ok:true});
    }

    // 管理员直接删号（内容整包进回收站，随时可以恢复）
    if(action==='delete-user'&&method==='POST'){
      const id=Number(b.id);
      if(!id) return json({error:'缺少用户 ID'},400);
      const target=await env.DB.prepare(`SELECT id,username,role FROM users WHERE id=?`).bind(id).first();
      if(!target) return json({error:'用户不存在'},404);
      if(target.id===me_.id) return json({error:'不能删除自己的账号，请使用「设置 → 注销账号」'},403);
      if(isAdmin(target)) return json({error:'不能删除管理员账号'},403);

      // 整包进回收站（账号 + 内容 + 附件清单），远端附件保留 —— 不然恢复回来是一堆破图
      await trashUser(env, id, me_);
      // 同上：别人给 TA 点过的赞随内容一起走
      const myT=(await env.DB.prepare(`SELECT id FROM threads WHERE author_id=?`).bind(id).all()).results.map(r=>r.id);
      const myP=(await env.DB.prepare(`SELECT id FROM posts WHERE author_id=?`).bind(id).all()).results.map(r=>r.id);
      await purgeLikes(env,'thread',myT);
      await purgeLikes(env,'post',myP);
      // 顺序：先删回复 → 再删主题 → 最后删账号（sessions / pending_2fa 靠外键级联）
      await env.DB.prepare(`DELETE FROM posts WHERE author_id=?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM threads WHERE author_id=?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM pending_2fa WHERE user_id=?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(id).run();
      return json({ok:true, deleted:target.username, trashed:true});
    }

    /* ---- 内容保护（只有站主）----
       保护一条内容 = 把它「接管」过来：原作者不能再改也不能删，
       子管理员的治理动作（置顶 / 锁定 / 标记 / 删除）一样被挡住。
       取消保护就原样还给作者。 */
    if(action==='protect'&&method==='POST'){
      const target=text(b.target)==='post'?'post':'thread';
      const id=Number(b.id);
      if(!Number.isInteger(id)||id<=0) return json({error:'缺少目标 ID'},400);
      const tbl=target==='post'?'posts':'threads';
      const row=await env.DB.prepare(`SELECT id,protected FROM ${tbl} WHERE id=?`).bind(id).first();
      if(!row) return json({error:'内容不存在'},404);
      const next=(b.value==null)?(row.protected?0:1):toFlag(b.value);
      await env.DB.prepare(`UPDATE ${tbl} SET protected=?,protected_at=? WHERE id=?`)
        .bind(next, next?new Date().toISOString():null, id).run();
      return json({ok:true, target, id, protected:next});
    }

    /* ---- 回收站：彻底删除（不可逆，只有站主）----
       删账号那条会连远端附件一起清；已被恢复过的账号不动远端（那是活人的东西）。 */
    if(action==='trash-purge'&&method==='POST'){
      if(toFlag(b.all)){
        const rows=(await env.DB.prepare(`SELECT * FROM trash`).all()).results;
        let purged=0;
        for(const r of rows){ try{ await purgeTrashRow(env,r); purged++; }catch(e){} }
        return json({ok:true, purged});
      }
      const id=Number(b.id)||0;
      const row=await env.DB.prepare(`SELECT * FROM trash WHERE id=?`).bind(id).first();
      if(!row) return json({error:'回收站里没有这条记录了'},404);
      await purgeTrashRow(env,row);
      return json({ok:true, purged:1});
    }

    /* ---- 附件体检 ----
       逐个用「只取 1 字节」的 Range 请求去问一遍存储：能拿到就算好的。
       网盘删文件、改权限、限并发都是静默发生的 —— 不主动查根本不知道哪几张图挂了，
       只能等用户来抱怨「有的附件打不开」。
       Workers 免费版单请求的子请求上限是 50，所以一次最多查 30 个，剩下的按 offset 接着查。 */
    if(action==='storage-check'&&method==='POST'){
      const cfg=await storageConfig(env);
      if(!cfg.type||cfg.type==='none'||!cfg.enabled) return json({error:'还没有启用附件存储'},400);
      const limit=Math.min(Math.max(Number(b.limit)||30,1),40);
      const offset=Math.max(Number(b.offset)||0,0);
      const total=Number((await env.DB.prepare(`SELECT COUNT(*) n FROM attachments`).first())?.n||0);
      const rows=(await env.DB.prepare(`SELECT id,storage_key,mime,size FROM attachments ORDER BY id LIMIT ? OFFSET ?`).bind(limit,offset).all()).results;
      const bad=[];
      for(const r of rows){
        let err=null, missing=false;
        try{
          const got=await storeGet(env,cfg,r.storage_key,'bytes=0-0');
          if(!got) missing=true;
          else { try{ got.body && got.body.cancel && await got.body.cancel() }catch(e){} }
        }catch(e){ err=String(e.message||e).slice(0,140) }
        if(missing || err){
          bad.push({
            id:r.id, mime:r.mime||'', size:Number(r.size||0),
            error: missing ? '远端没有这个文件（可能被网盘清理或从未迁移过来）' : err,
            used_in: await findAttUsage(env, r.id)
          });
        }
      }
      const next=offset+rows.length;
      return json({ ok:true, checked:rows.length, total, offset, next: next<total?next:null, bad });
    }

    /* ---- 胁迫模式（只有站主）----
       手动把某个账号置入保护状态（内容一条不删、账号登不进去），或者解除。
       on=1 时作废该用户全部会话 —— 正在被胁迫的人手上的登录态也要立刻失效。 */
    if(action==='duress'&&method==='POST'){
      const id=Number(b.id);
      if(!id) return json({error:'缺少用户 ID'},400);
      const target=await env.DB.prepare(`SELECT id,username,role,duress_state FROM users WHERE id=?`).bind(id).first();
      if(!target) return json({error:'用户不存在'},404);
      const on=toFlag(b.value);
      if(on){
        if(isAdmin(target)) return json({error:'管理员账号不能进入保护状态'},403);
        await env.DB.prepare(`UPDATE users SET duress_state=1,duress_at=datetime('now'),duress_by='admin' WHERE id=?`).bind(id).run();
        await destroyUserSessions(env,id);          // 手上有登录态也立刻踢掉
        return json({ok:true, duress:1});
      }
      // 解除：保护状态清掉，但**胁迫密码本身保留** —— 用户下次还能再用它求助
      await env.DB.prepare(`UPDATE users SET duress_state=0,duress_at=NULL,duress_by=NULL WHERE id=?`).bind(id).run();
      return json({ok:true, duress:0});
    }

    if(action==='moderate'&&method==='POST'){
      const type=text(b.type), id=Number(b.id);
      if(type==='ban'){await env.DB.prepare(`UPDATE users SET banned=1 WHERE id=? AND role='user'`).bind(id).run(); return json({ok:true})}
      if(type==='unban'){await env.DB.prepare(`UPDATE users SET banned=0 WHERE id=?`).bind(id).run(); return json({ok:true})}
      return json({error:'未知操作'},400);
    }
  }

  // 未匹配到任何 /api 路由：给结构化 JSON 错误，而不是把静态资源（HTML）回给前端。
  // 否则前端 res.json() 解析失败，只能笼统提示「请求失败」，问题无法定位。
  if(path.startsWith('/api/')) return json({error:'接口不存在', path}, 404);

  return env.ASSETS.fetch(req);
}

// 统一安全 / 隐私响应头。
// ① CSP 锁死同源：本站本来就零第三方资源，加上它之后，即便将来被注入外链脚本也发不出去。
// ② NEL 是重点：Cloudflare 会自动给响应挂 Nel / Report-To，浏览器于是把每一次 4xx
//    （典型是 /favicon.ico 404）上报到 a.nel.cloudflare.com —— 那是一个**跨站**请求，
//    正是广告拦截器把它当成「追踪器」报出来的原因。max_age=0 让浏览器立刻丢弃这条策略。
const SEC_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'interest-cohort=()',
  'nel': '{"report_to":"cf-nel","max_age":0}'
};

// 一律覆盖（而不是「没有才设」），这样连 Cloudflare 自己加的 Nel 也会被顶掉
function harden(res){
  try{
    const h=new Headers(res.headers);
    for(const k in SEC_HEADERS) h.set(k, SEC_HEADERS[k]);
    return new Response(res.body,{status:res.status, statusText:res.statusText, headers:h});
  }catch(e){ return res }
}

export default {async fetch(req,env,ctx){try{await ensureSchema(env);return harden(await route(req,env))}catch(e){if(e instanceof Response)return harden(e); console.error(e);return harden(json({error:'服务器内部错误'},500))}}};
