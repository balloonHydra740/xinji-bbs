const $=s=>document.querySelector(s);const app=$('#app');let me=null, setupNeeded=false, uploadOn=false, mode='login', pending2fa=null, adminCache={users:[],posts:[],threads:[]};
// 上传上限（MB）由 /api/status 下发；0 表示未知/不限制。选完文件先本地卡一道，
// 免得把几十 MB 发上去才被拒 —— 那种情况下客户端看起来就像卡死了。
let maxUploadMb=0, maxAvatarMb=0;
// 板块状态：list 是板块数组，unboarded 是没有归属任何板块的主题数。
// 单独的 curBoard：'all' 全部 / 'none' 未分类 / 数字字符串 = 某个板块 id
// curQ 是搜索词；curPage / pageInfo 是分页状态（pageInfo 由后端回传，翻页时要用它夹住边界）
let boards={list:[],unboarded:0}, curBoard='all', curQ='', curPage=1;
let pageInfo={total:0,page:1,pages:1,limit:20};
/* ---- 提示条 ----
   必须走**顶层图层**：<dialog> 一旦打开，它和 ::backdrop 都进 top layer，
   那里 z-index 完全无效 —— 于是「弹窗里报错」时提示条会被弹窗盖住，
   看起来就像"错误提示不在同一个图层"。给 toast 挂 popover 属性，
   它自己也进 top layer，而且 popover="manual" 不会抢焦点、不会自动关。
   不支持 popover 的老浏览器退化成原来的 .show 类（z-index 兜底）。 */
let toastTimer=0;
function hideToast(){
  const t=$('#toast'); if(!t) return;
  t.classList.remove('show','hasAct');
  try{ if(t.hidePopover && t.matches(':popover-open')) t.hidePopover() }catch(e){}
}
/* action = { label:'撤销', onClick } —— 删除后的「后悔药」就挂在这里。
   带按钮的提示条要能点，所以额外挂 .hasAct（#toast 平时是 pointer-events:none，
   不然它会挡住底下的东西）。停留时间也拉长，2.2 秒来不及看清按钮上的字。 */
const toast=(s,action)=>{
  const t=$('#toast'); if(!t) return;
  const hasAct=!!(action&&action.label);
  t.innerHTML=`<span class="toastMsg">${esc(s)}</span>`+(hasAct?`<button type="button" class="toastAct">${esc(action.label)}</button>`:'');
  t.classList.add('show');
  t.classList.toggle('hasAct',hasAct);
  try{ if(t.showPopover && !t.matches(':popover-open')) t.showPopover() }catch(e){}
  if(hasAct){
    const btn=t.querySelector?t.querySelector('.toastAct'):null;
    if(btn) btn.onclick=()=>{ hideToast(); try{ action.onClick&&action.onClick() }catch(e){} };
  }
  clearTimeout(toastTimer);
  toastTimer=setTimeout(hideToast, hasAct?5200:2200);
};
const api=async(p,o={})=>{const r=await fetch('/api'+p,{headers:{'content-type':'application/json',...(o.headers||{})},...o});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'请求失败');return d};
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
// 单个附件 → 真正的媒体元素。
// att 是后端给的元数据表 { id: {mime,w,h} }：
//   · mime 决定用 <img> 还是 <video>/<audio> —— 视频塞进 img 只会得到破图；
//   · w/h 写进 width/height 属性，浏览器就能在图下完之前把空间占好，
//     否则加载完成那一刻整页会往下跳（手机上尤其明显）。
// 媒体上都挂 stopPropagation，免得点在图上时冒泡触发「打开主题」。
/* 附件加载失败的处理。
   以前失败就是一块红虚线框，既不说话也不能重试 —— 用户只会觉得「有的附件打不开」。
   现在：图片先自动重试一次（远端限速/瞬断很常见），再失败才提示，并且点一下能重试；
   音视频不自动重试（文件大，重试太贵），直接给一条可点的提示。 */
function attFail(el){
  const isImg = el.tagName === 'IMG';
  el.classList.remove && el.classList.remove('loading');
  const src = el.dataset && el.dataset.src ? el.dataset.src : el.getAttribute && el.getAttribute('src');
  // 图片：没人操作时先自己悄悄试一次，带 r=1 绕开可能的中转缓存
  if (isImg && el.dataset && el.dataset.retry !== '1' && src) {
    el.dataset.retry = '1';
    el.src = src + (src.includes('?') ? '&' : '?') + 'r=1';
    return;
  }
  el.classList.add && el.classList.add('broken');
  if (el.dataset) el.dataset.fail = '1';
  const mime = String((el.dataset && el.dataset.mime) || '');
  if (isImg) {
    // 破图时浏览器会把 alt 显示出来 —— 正好当提示位用
    el.alt = /hei[cf]/i.test(mime)
      ? 'HEIC 图片，这个浏览器可能看不了 · 点一下重试'
      : '附件加载失败 · 点一下重试';
    return;
  }
  if (el.dataset && el.dataset.tip === '1') return;
  if (el.dataset) el.dataset.tip = '1';
  const tip = document.createElement('button');
  tip.type = 'button';
  tip.className = 'attFailTip';
  tip.textContent = '附件加载失败 · 点这里重试';
  tip.onclick = e => {
    e.stopPropagation();
    if (tip.parentNode) tip.parentNode.removeChild(tip);
    if (el.dataset) el.dataset.tip = '';
    attRetry(el);
  };
  if (el.parentNode) el.parentNode.insertBefore(tip, el.nextSibling);
}

window.attRetry = el => {
  const src = (el.dataset && el.dataset.src) || el.getAttribute('src') || '';
  if (!src) return;
  el.classList && el.classList.remove('broken');
  if (el.dataset) { el.dataset.fail = ''; el.dataset.retry = '1' }
  el.src = src + (src.includes('?') ? '&' : '?') + 'r=' + Date.now();   // 破缓存重来
  if (el.load) { try { el.load() } catch (e) { } }                       // <video>/<audio> 要显式重载
};

// 内联事件里用：点一下破图 → 重试（顺便别把点击穿给外层卡片的「打开主题」）
window.attClick = el => { if (el.dataset && el.dataset.fail === '1') window.attRetry(el) };

function mediaHtml(id, att, hasIndex){
  const info = att[id];
  const url = `/api/files/${id}`;
  const stop = 'onclick="event.stopPropagation()"';
  if (hasIndex && !info) return `<span class="attMissing">［附件 #${id} 已不存在］</span>`;
  const mime = String(info?.mime || '');
  const dm = ` data-src="${url}" data-mime="${esc(mime)}"`;
  if (/^video\//.test(mime)) {
    const ar = (info.w && info.h) ? ` style="aspect-ratio:${info.w}/${info.h}"` : '';
    return `<video class="att" src="${url}"${dm} controls preload="metadata" playsinline onerror="attFail(this)" ${stop}${ar}></video>`;
  }
  if (/^audio\//.test(mime)) return `<audio class="att audio" src="${url}"${dm} controls preload="metadata" onerror="attFail(this)" ${stop}></audio>`;
  const wh = (info?.w && info?.h) ? ` width="${info.w}" height="${info.h}"` : '';
  // aspect-ratio 是兜底：即便将来有别的规则同时约束了宽高，
  // 浏览器也会按这个比例去算另一边，正方形不会被压成长方形。
  const ar = (info?.w && info?.h) ? ` style="aspect-ratio:${info.w}/${info.h}"` : '';
  return `<img class="att loading" src="${url}"${dm} loading="lazy" alt="附件"` +
    ` onload="this.classList.remove('loading')"` +
    ` onerror="attFail(this)"` +
    ` onclick="event.stopPropagation();attClick(this)"${wh}${ar}>`;
}

// 正文渲染：先 HTML 转义（用户内容永远不能带标签进来），再交给 Markdown。
// [img:id] 先换成占位符 —— 它既不能被转义破坏，也不该被 Markdown 当链接语法吃掉。
// plain=true：列表预览，只留纯文字（Markdown 标记与附件一并剥掉，媒体另排缩略图）
function renderBody(s, att, plain){
  att = att || {};
  if (plain) return esc(MD.plain(s));
  const hasIndex = Object.keys(att).length > 0;
  const ids = [];
  // 先把哨兵字符（\u0001）从用户文本里剔掉再插占位符：
  // 否则谁都能在正文里手打一对哨兵把任意位置伪造成「这里有个附件」。
  const text = esc(String(s == null ? '' : s)).replace(/\u0001/g, '').replace(/\[img:(\d+)\]/g, (m, id) => {
    ids.push(id);
    return 'IMG' + (ids.length - 1) + '';
  });
  return MD.toHtml(text).replace(/IMG(\d+)/g, (m, i) => mediaHtml(ids[Number(i)], att, hasIndex));
}

/* ---- 不易展示内容（隐藏限制帖）----
   作者在发布时勾「不易展示」，管理员 / 子管理员也能事后替别人补标。
   标记本身只是个 flag，盖不盖遮罩由**看的人**决定：账户设置里那颗开关
   关掉之后，这类内容就跟普通帖一样直接显示。默认开着 ——
   「现在是不是公共场合」只有本人知道，作者替不了这个判断。 */
const sensitiveOn=()=> me ? (me.sensitive_filter!==0) : true;

/* 遮罩：正文照常渲染进 DOM（揭示时不用再取一次数据），
   只是在上面盖一层 + 模糊。真正挡住内容的靠 .coverVeil 那层半透明底，
   光 filter:blur 在短文本上仍能看出字形轮廓。 */
function coverHtml(inner, title){
  return `<div class="coverWrap">
    <div class="coverBody">${inner}</div>
    <div class="coverVeil">
      <div class="coverNote"><b>${esc(title)}</b><span>滑到尽头才会显示完整内容，旁边有人时留意一下 (˙꒳˙)</span></div>
      <div class="scTrack"><span class="scFill"></span><span class="scHint">滑动查看 →</span><button class="scKnob" type="button" aria-label="滑动查看完整内容">→</button></div>
    </div>
  </div>`;
}

/* 滑动确认：必须拖到尽头才揭示，半路松手弹回原位。
   刻意不给「点一下就显示」—— 那和直接点开帖子没区别，误触照样看到剧透。
   用 Pointer Events 一套吃掉鼠标 / 触屏 / 手写笔；老 WebKit 没有它时退回 touch。 */
window.initSensitive=()=>{
  if(!document.querySelectorAll) return;
  document.querySelectorAll('.coverWrap:not(.isBound)').forEach(wrap=>{
    wrap.classList.add('isBound');
    const knob=wrap.querySelector('.scKnob'); if(!knob) return;
    const track=wrap.querySelector('.scTrack'); if(!track) return;
    const fill=wrap.querySelector('.scFill');
    let active=false, x=0, startX=0, maxX=1;
    const paint=v=>{
      x=v;
      knob.style.transform='translateX('+v+'px)';
      if(fill) fill.style.width=(v+knob.offsetWidth)+'px';
      wrap.classList.toggle('scArmed', v>=maxX*0.9);
    };
    const finish=ok=>{
      if(ok){ wrap.classList.add('revealed'); return; }
      wrap.classList.add('scBack'); paint(0);
      setTimeout(()=>wrap.classList.remove('scBack'),280);
    };
    // maxX 每次按下时重算：屏幕转个向、帖子被编辑重画，宽度都会变
    // 行程按**轨道**宽度算，不是遮罩宽度 —— 轨道只有 min(300px,86%)
    const begin=cx=>{ maxX=Math.max(1, track.clientWidth-knob.offsetWidth-8); active=true; startX=cx-x; };
    const moveTo=cx=>{ if(!active||cx==null) return; paint(Math.min(Math.max(cx-startX,0),maxX)); };
    const endUp=()=>{ if(!active) return; active=false; finish(x>=maxX*0.9); };
    knob.addEventListener('pointerdown',e=>{ e.preventDefault(); begin(e.clientX); try{knob.setPointerCapture(e.pointerId)}catch(err){} });
    knob.addEventListener('pointermove',e=>moveTo(e.clientX));
    knob.addEventListener('pointerup',endUp);
    knob.addEventListener('pointercancel',()=>{ if(!active)return; active=false; finish(false); });
    if(!window.PointerEvent){
      knob.addEventListener('touchstart',e=>begin(e.touches[0].clientX),{passive:true});
      knob.addEventListener('touchmove',e=>{ moveTo(e.touches[0].clientX); if(e.cancelable) e.preventDefault(); });
      knob.addEventListener('touchend',endUp);
    }
    // 键盘 / 读屏：聚焦滑块后按回车、空格或 → 直接揭示
    knob.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '||e.key==='ArrowRight'){ e.preventDefault(); finish(true); } });
  });
};

// 头像本身也要能点进主页（很多人第一反应是点头像，不是点名字）。
// stopPropagation 是必须的：列表里整张卡片自带「打开主题」的点击。
function avatarLink(u, cls, uid){
  return `<span class="avaLink" onclick="event.stopPropagation();openUser(${uid})">${avatarHtml(u,cls)}</span>`;
}

// 头像：emoji:🐱 显示表情，att:<id> 显示上传的图，都没有就用用户名首字。
// 首字方案保证「还没设头像的人」也能一眼区分开 —— 这正是加头像的初衷。
function avatarHtml(u, cls){
  const c = cls || 'ava';
  const av = String(u && u.avatar ? u.avatar : '');
  if (av.indexOf('emoji:') === 0) return `<span class="${c} avaEmoji">${esc(av.slice(6))}</span>`;
  if (av.indexOf('att:') === 0) return `<img class="${c}" src="/api/files/${av.slice(4)}" alt="" loading="lazy">`;
  const ch = String(u && u.username ? u.username : '?').trim().slice(0, 1).toUpperCase() || '?';
  return `<span class="${c} avaText">${esc(ch)}</span>`;
}

/* ---- 转帖 / 引用 / 点赞 ----
   三件事，别混在一起：
     · 点赞  —— 一条内容一人一次、可撤销，只影响计数；
     · 转帖  —— 引用别人的内容**新发一条主题**（就是 X 的引用转帖），原帖计一次转帖；
     · 引用  —— 在回复里挂一张引用卡，属于楼内讨论，**不计**转帖数
                （回复引一句原帖不该让「转帖 3」这种数字变得讲不清）。
   引用卡一律照**快照**渲染：原内容被删了卡片照样在，只是点过去会提示不存在。 */

// 渲染时顺手记下内容长什么样，转帖弹窗要用它画预览，省一次请求
const QUOTES = new Map();
function rememberQuote(type, o){
  if (!o || o.id == null) return;
  QUOTES.set(type + ':' + o.id, {
    t: type, id: Number(o.id), user: o.username || '', title: o.title || '',
    excerpt: MD.plain(o.body || '').slice(0, 90),
    at: o.created_at || o.updated_at || '',
    sensitive: o.sensitive ? 1 : 0
  });
}
function quoteCache(type, id){ return QUOTES.get(type + ':' + id) || null }

// 引用卡：作者 + 时间 + 标题 / 摘要，点整张卡跳回原处。
// 原内容带「不易展示」标记时，标题连摘要一起收掉 —— 引用不该成为绕开限制的后门。
function quoteCard(q){
  if (!q) return '';
  const who = esc(q.user || '已注销用户');
  const at = q.at ? esc(time(q.at)) : '';
  const jump = q.t === 'thread' ? `openThread(${q.id})` : (q.tid ? `openThread(${q.tid})` : '');
  const inner = (q.sensitive && sensitiveOn())
    ? `<span class="qText muted">这条${q.t === 'thread' ? '主题' : '回复'}被标记为不易展示，内容已隐藏。</span>`
    : ((q.title ? `<b class="qTitle">${esc(q.title)}</b>` : '') +
       (q.excerpt ? `<span class="qText">${esc(q.excerpt)}</span>` : '<span class="qText muted">（没有文字内容）</span>'));
  return `<div class="quoteCard"${jump ? ` onclick="${jump}"` : ''}>
    <div class="qHead">${avatarHtml({ username: q.user }, 'avaMini')}<b>${who}</b>${at ? `<small>${at}</small>` : ''}${q.sensitive ? '<span class="tag warn">不易展示</span>' : ''}</div>
    ${inner}
  </div>`;
}
function quoteCardOf(snap){
  if (!snap) return '';
  let q = null; try { q = JSON.parse(snap) } catch (e) { return '' }
  return quoteCard(q);
}

// 两个图标都画成 SVG：emoji 在各平台上的形状/颜色不一致，
// 而这里的颜色是要跟着状态变的（赞过 = 实心主题色）。
const ICO_HEART = '<svg class="actIco" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.6C6.4 17.1 3 13.8 3 10.1 3 7.2 5.2 5.1 8 5.1c1.5 0 3 .7 4 1.9 1-1.2 2.5-1.9 4-1.9 2.8 0 5 2.1 5 5 0 3.7-3.4 7-9 10.5z"/></svg>';
const ICO_REPOST = '<svg class="actIco" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2.5 20.5 6 17 9.5"/><path d="M20.5 6H7a4 4 0 0 0-4 4v2"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M3.5 18H17a4 4 0 0 0 4-4v-2"/></svg>';
const ICO_QUOTE = '<svg class="actIco" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.6 6.4C6.6 7.9 5 10.3 5 13.4c0 2.4 1.4 4 3.4 4 1.8 0 3.1-1.3 3.1-3.1 0-1.7-1.2-2.9-2.9-2.9-.3 0-.6 0-.8.1.3-1.4 1.3-2.4 2.8-3.4l-1-1.7zm9 0C15.6 7.9 14 10.3 14 13.4c0 2.4 1.4 4 3.4 4 1.8 0 3.1-1.3 3.1-3.1 0-1.7-1.2-2.9-2.9-2.9-.3 0-.6 0-.8.1.3-1.4 1.3-2.4 2.8-3.4l-1-1.7z"/></svg>';

// 图标 + 计数的一颗互动按钮（列表卡片和帖子底部共用）
function actBtn(kind, target, id, n, on, label){
  const ico = kind === 'like' ? ICO_HEART : ICO_REPOST;
  const fn = kind === 'like' ? 'toggleLike' : 'openRepost';
  return `<button type="button" class="act act-${kind}${on ? ' on' : ''}" aria-pressed="${on ? 'true' : 'false'}"` +
    ` title="${esc(label)}" aria-label="${esc(label)}"` +
    ` onclick="event.stopPropagation();${fn}('${target}',${id},this)">${ico}<span class="actN">${Number(n || 0)}</span></button>`;
}
// 互动行：赞 / 转帖 / 引用。三颗都是「图标 + 文字」的同一种形状 ——
// 之前「引用」是个带边框的文字按钮，夹在两颗无边框图标按钮中间，
// 一行里冒出两种按钮语言，手机上尤其明显。
function reactRow(target, id, likes, liked, reposts, withQuote){
  const items = [
    actBtn('like', target, id, likes, liked, liked ? '取消赞' : '赞一个'),
    actBtn('repost', target, id, reposts, false, '转帖这条'),
  ];
  if (withQuote) items.push(`<button type="button" class="act act-quote" title="引用这条内容（挂进你的回复里）" aria-label="引用这条内容" onclick="startQuote('${target}',${id})">${ICO_QUOTE}<span class="actTxt">引用</span></button>`);
  return `<div class="reactRow">${items.join('')}</div>`;
}

// 点赞：先问服务端再改界面，数字以服务端返回的为准（两个人同时点也不会各说各话）
// 游客点了不白点：提示一句，顺手把登录框带出来，省一次「去找登录按钮」。
function needLogin(what){ toast('登录后才能'+what+'，先登录一下吧 (｡･ω･｡)'); const b=$('#loginBtn'); if(b&&b.click) b.click() }
window.toggleLike=async(target,id,btn)=>{
  if(!me){ needLogin('点赞'); return }
  if(btn&&btn.dataset&&btn.dataset.busy==='1') return;      // 连点两下只算一次
  if(btn&&btn.dataset) btn.dataset.busy='1';
  try{
    const d=await api('/like',{method:'POST',body:JSON.stringify({target,id})});
    if(btn){
      const n=btn.querySelector&&btn.querySelector('.actN');
      if(n){
        n.textContent=Number(d.count||0);
        n.classList.remove('up'); void n.offsetWidth; n.classList.add('up');   // 数字弹一下，表明「这一下生效了」
      }
      btn.classList.toggle('on',!!d.liked);
      if(btn.setAttribute) btn.setAttribute('aria-pressed',d.liked?'true':'false');
      btn.title=d.liked?'取消赞':'赞一个';
      if(d.liked){ btn.classList.remove('burst'); void btn.offsetWidth; btn.classList.add('burst') }
    }
  }catch(x){ toast(x.message) }
  finally{ if(btn&&btn.dataset) btn.dataset.busy='0' }
};

let repostTarget=null;
window.openRepost=(target,id)=>{
  if(!me){ needLogin('转帖'); return }
  const q=quoteCache(target,id);
  if(!q){ toast('这条内容还没加载好，请稍后再试'); return }
  repostTarget={type:target,id};
  $('#repostPreview').innerHTML=quoteCard(q);
  $('#repostTitle').value='';
  $('#repostBody').value='';
  if($('#repostSensitive')) $('#repostSensitive').checked=!!q.sensitive;
  $('#repostHint').textContent=q.sensitive
    ? '这条内容本身就带着「不易展示」标记，所以这里默认跟着勾上了。'
    : '留空就是直接转：只挂一张引用卡，不另外写评论。';
  fillBoardSelect('#repostBoard', curBoard!=='all'&&curBoard!=='none'?curBoard:'');
  renderMdBars();
  $('#repostDialog').showModal();
};
$('#repostForm').onsubmit=async e=>{
  e.preventDefault();
  if(!repostTarget) return;
  const q=quoteCache(repostTarget.type,repostTarget.id);
  const body=String($('#repostBody').value||'');
  // 标题留空就沿用原内容的标题（回复没有标题，退而用摘要开头那段）。
  // 截断到 100 是后端那一刀，这里先自己切一遍，
  // 免得用户看到「保存成功但标题被砍了半截」。
  const auto='转帖：'+((q&&q.title)||(q&&String(q.excerpt||'').slice(0,40))||'一条内容');
  const title=(String($('#repostTitle').value||'').trim()||auto).slice(0,100);
  try{
    const d=await api('/threads',{method:'POST',body:JSON.stringify({
      title, body, boardId:$('#repostBoard').value||'',
      sensitive:$('#repostSensitive')?.checked?1:0,
      quote:{type:repostTarget.type,id:repostTarget.id}
    })});
    $('#repostDialog').close(); repostTarget=null;
    toast('已转帖 ✨'); curPage=1;
    if(d&&d.id) openThread(d.id); else list();
  }catch(x){ toast(x.message) }
};

/* ---- 回收站 ----
   删除不再「一删就没」：先落在回收站，自己删的自己能捞回来，站主能捞回任何东西。
   能不能恢复由后端的 can_restore / can_purge 说了算，前端照显示，不自己判权限。 */
let trashItems=[], trashQ='', trashAdmin=false;

window.openTrash=async()=>{
  closeUserMenu();
  const box=$('#trashList'); if(box) box.innerHTML='<p class="muted">读取中…</p>';
  $('#trashDialog')?.showModal?.();
  await loadTrash();
};
async function loadTrash(){
  try{
    const d=await api('/trash?limit=50');
    trashItems=Array.isArray(d?.items)?d.items:[];
    trashAdmin=!!d?.admin;
    $('#trashTools')?.classList?.toggle('hidden',!trashAdmin);
    if($('#trashHint')) $('#trashHint').textContent=trashAdmin
      ? '你是站主：这里能看到全站被删除的内容，任何一条都能恢复。点「彻底删除」才是真的删掉（不可逆）。'
      : '删除的内容会先放在这里。自己删掉的可以自己恢复；被管理员移除的，需要站主恢复。';
    renderTrash();
  }catch(x){
    const box=$('#trashList'); if(box) box.innerHTML=`<p class="muted">${esc(x.message)}</p>`;
  }
}
const trashKindLabel=k=>k==='thread'?'主题':(k==='post'?'回复':'账号');
function renderTrash(){
  const box=$('#trashList'); if(!box) return;
  const q=trashQ.toLowerCase();
  const list=q?trashItems.filter(r=>[r.title,r.excerpt,r.author_name,r.deleted_by_name].join(' ').toLowerCase().includes(q)):trashItems;
  if($('#trashCount')) $('#trashCount').textContent=trashItems.length?`共 ${trashItems.length} 条${q?`（匹配 ${list.length}）`:''}`:'';
  if(!list.length){ box.innerHTML=`<p class="muted">${trashItems.length?'没有匹配的记录。':'回收站是空的。'}</p>`; return }
  box.innerHTML=list.map(r=>{
    const tags=[
      `<span class="tag${r.kind==='user'?' warn':''}">${trashKindLabel(r.kind)}</span>`,
      r.was_protected?'<span class="tag board">曾受保护</span>':'',
      r.by_owner?'<span class="tag mute">自己删的</span>':'<span class="tag mute">管理员移除</span>'
    ].filter(Boolean).join('');
    const acts=[];
    if(r.can_restore) acts.push(`<button class="mini primary" onclick="restoreTrash(${r.id})">恢复</button>`);
    else acts.push('<span class="muted trashNo">需站主恢复</span>');
    if(r.can_purge) acts.push(`<button class="mini danger" onclick="purgeTrash(${r.id})">彻底删除</button>`);
    const sub=`${esc(r.author_name||'已注销')} · ${esc(r.deleted_by_name||'未知')} 移除 · ${timeShort(r.deleted_at)}`+
      (r.kind==='thread'&&r.item_count>1?` · 连带 ${r.item_count-1} 条回复`:'')+
      (r.kind==='user'?` · ${esc(r.excerpt)}`:'');
    // t-* 用来给这一行左侧上一条类型色条（主题=主题色 / 回复=灰 / 账号=红）：
    // 三类条目混在一屏里时，光看角标得先读字，有色条就能扫着看。
    return `<div class="row t-${r.kind}"><span class="rowText"><span class="trashTags">${tags}</span>`+
      `<div class="trashTitle">${esc(r.title||r.excerpt||'（无标题）')}</div>`+
      `<span class="muted">${sub}</span></span>`+
      `<span class="rowActions">${acts.join('')}</span></div>`;
  }).join('');
}
window.filterTrash=()=>{ trashQ=String($('#trashSearch')?.value||'').trim(); renderTrash() };
window.clearTrashSearch=()=>{ const el=$('#trashSearch'); if(el) el.value=''; trashQ=''; renderTrash() };

window.restoreTrash=async id=>{
  try{
    const d=await api('/trash/restore',{method:'POST',body:JSON.stringify({id})});
    const n=Math.max(0,Number(d.restored||1)-1);
    toast(d.kind==='user'?`账号已恢复${n?`（连同 ${n} 条内容）`:''}`:'内容已恢复');
    await loadTrash();
    // 只在「主题列表」这一屏顺手刷新 —— 恢复回来的东西就在那儿。
    // 从管理中心 / 帖子详情里打开回收站时不能无脑 list()，
    // 那会把人从正在看的地方一脚踹回首页。
    const view=document?.documentElement?.getAttribute?.('data-view');
    if(view==='list'||!view) list();
  }catch(x){ toast(x.message); await loadTrash() }
};
window.purgeTrash=async id=>{
  if(!confirm('彻底删除之后无法恢复。\n\n如果这是账号记录，它上传的图片也会一并从存储里清掉。确定吗？')) return;
  try{ await api('/admin/trash-purge',{method:'POST',body:JSON.stringify({id})}); toast('已彻底删除'); await loadTrash() }catch(x){toast(x.message)}
};
$('#trashPurgeAll').onclick=async()=>{
  if(!trashItems.length){ toast('回收站已经是空的了'); return }
  if(!confirm(`清空回收站：里面 ${trashItems.length} 条记录会被彻底删除、无法恢复\n（账号条目会连它上传的图片一起清掉）。确定吗？`)) return;
  try{ const d=await api('/admin/trash-purge',{method:'POST',body:JSON.stringify({all:1})}); toast(`已清空（${d.purged} 条）`); await loadTrash() }catch(x){toast(x.message)}
};

/* 删除后的「后悔药」：toast 上那颗「撤销」直接调恢复接口。
   比让人自己去回收站里翻要快得多 —— 手滑删掉时人根本不会想到还有回收站。 */
function undoDelete(trashId, what){
  if(!trashId) return null;
  return { label:'撤销', onClick:async()=>{
    try{
      await api('/trash/restore',{method:'POST',body:JSON.stringify({id:trashId})});
      toast(what+'已恢复');
      // 同 restoreTrash：只在列表页刷新，别把正在管理中心干活的人拽走
      const view=document?.documentElement?.getAttribute?.('data-view');
      if(view==='list'||!view) list();
      if($('#trashDialog')?.open) loadTrash();
    }catch(x){ toast(x.message) }
  }};
}

/* 附件体检：逐个问一遍存储里还在不在。
   网盘上文件被删/被限权是静默的，不主动查就只能等用户说「有的图打不开」。 */
function fmtBytes(n){
  n=Number(n)||0;
  if(n<1024) return n+' B';
  if(n<1048576) return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(2)+' MB';
}
window.checkAttachments=async offset=>{
  const box=$('#storeCheckResult'), more=$('#storeCheckMore'), btn=$('#storeCheckBtn');
  if(box) box.innerHTML='<p class="muted">正在逐个核对存储里的文件……（一次 30 个）</p>';
  if(btn) btn.disabled=true;
  try{
    const d=await api('/admin/storage-check',{method:'POST',body:JSON.stringify({offset:offset||0,limit:30})});
    // 逐批累积，最后一次性重画（中途反复重排反而看不清）
    window._attBad=(offset?window._attBad||[]:[]).concat(d.bad||[]);
    window._attChecked=(offset?window._attChecked||0:0)+(d.checked||0);
    const bad=window._attBad;
    let html=`<p class="muted">已核对 ${window._attChecked}/${d.total} 个附件`;
    if(!bad.length) html+='，暂时没发现读取失败的文件 ✅</p>';
    else{
      html+=`，其中 <b>${bad.length} 个读不出来</b>：</p>`;
      html+=bad.map(b=>{
        // 只说「附件 #30 读不出来」等于把球踢回给站主 —— 得告诉他出现在哪个帖子里
        const where=[...(b.used_in?.threads||[]).map(t=>`主题《${esc(t.title)}》`),
                     ...(b.used_in?.posts||[]).map(p=>`《${esc(p.title)}》里的回复`)];
        return `<div class="row"><span class="rowText">`+
          `<span class="trashTags"><span class="tag warn">附件 #${b.id}</span><span class="tag mute">${esc(b.mime||'未知类型')}</span></span>`+
          `<span class="muted">${fmtBytes(b.size)} · ${esc(b.error)}</span>`+
          (where.length?`<span class="muted">出现在：${where.slice(0,3).join('、')}</span>`:'<span class="muted">没有任何内容引用它</span>')+
          `</span></div>`;
      }).join('');
      html+='<p class="muted">「远端没有这个文件」多半是网盘那边清理过、或者当初迁移存储时没搬过来；'+
        '「读取存储失败」则是限流/瞬断，过一会儿再体检一次可能就好了。</p>';
    }
    if(box) box.innerHTML=html;
    if(more){
      more.classList.toggle('hidden',!d.next);
      if(d.next) more.setAttribute('onclick',`checkAttachments(${d.next})`);
    }
  }catch(x){ if(box) box.innerHTML=`<p class="muted">${esc(x.message)}</p>` }
  finally{ if(btn) btn.disabled=false }
};

/* ---- 内容保护（只有站主）----
   保护一条内容 = 把它接管过来：原作者不能再改也不能删，子管理员也动不了。
   取消保护就原样还给作者。 */
window.toggleProtect=async(target,id,back)=>{
  try{
    const d=await api('/admin/protect',{method:'POST',body:JSON.stringify({target,id})});
    toast(d.protected?'已保护：原作者不能再修改或删除这条内容':'已取消保护，控制权已交还作者');
    // back：'admin' = 回到管理中心（那边整页重画），数字 = 回到某个主题详情
    if(back==='admin') $('#adminBtn').click(); else openThread(back||id);
  }catch(x){toast(x.message)}
};

/* ---- 胁迫密码 ----
   平时用真密码登录；被人逼着解锁时输这一串 ——
   账号立刻进入保护状态：内容一条不删、账号从此登不进去，只有站主能恢复。 */
function fillDuressCard(){
  const st=$('#duressState'); if(!st) return;
  const locked=!!me?.can_admin;
  $('#duressForm')?.classList?.toggle('hidden',locked);
  $('#duressCard')?.classList?.toggle('is-locked',locked);
  if(locked){
    st.textContent='管理员不能设置：这个功能的出口是「只有站主能恢复」，管理员一触发就等于把自己锁在门外。';
    return;
  }
  st.textContent=me?.duress_set
    ? '✅ 已设置。用它登录会让账号进入保护状态：内容完整保留、账号停用，需要站主手动恢复。'
    : '还没有设置。设一个之后，遇到胁迫时就用它登录 —— 内容不会被删，账号会立刻停用。';
  $('#duressClearBtn')?.classList?.toggle('hidden',!me?.duress_set);
}
$('#duressForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    const body={password:$('#duressPass').value,duress:$('#duressInput').value};
    if(me?.totp_enabled) body.code=$('#duressCode').value;
    const d=await api('/account/duress',{method:'POST',body:JSON.stringify(body)});
    me={...me,duress_set:d.duress_set};
    $('#duressForm').reset(); fillDuressCard();
    toast('胁迫密码已保存 (｡･ω･｡)ﾉ');
  }catch(x){toast(x.message)}
};
// 清除复用同一个「当前密码」输入框：不额外弹一个明文输入框（prompt 会明着显示密码）
window.clearDuress=async()=>{
  const pw=String($('#duressPass')?.value||'');
  if(!pw){ toast('请先在「当前密码」里填上你的登录密码'); $('#duressPass')?.focus?.(); return }
  if(!confirm('确定清除胁迫密码吗？清除之后就少了这条求助通道。')) return;
  try{
    const body={password:pw,duress:''};
    if(me?.totp_enabled) body.code=$('#duressCode').value;
    const d=await api('/account/duress',{method:'POST',body:JSON.stringify(body)});
    me={...me,duress_set:d.duress_set};
    $('#duressForm').reset(); fillDuressCard();
    toast('胁迫密码已清除');
  }catch(x){toast(x.message)}
};

// 回收站里的短时间：手机上一行要放下「谁的内容 + 谁移除的 + 时间 + 连带几条」，
// 带年份的完整写法太占地方。当年只留「月/日 时:分」，跨年才补上年份 ——
// 回收站里的东西基本都是最近删的。
function timeShort(s){
  if(!s) return '';
  const d=new Date(String(s).replace(' ','T')+'Z');
  if(isNaN(d.getTime())) return '';
  const md=`${d.getMonth()+1}/${d.getDate()}`;
  const hm=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return d.getFullYear()===new Date().getFullYear()?`${md} ${hm}`:`${d.getFullYear()}/${md}`;
}

/* ---- 草稿：写一半被杀掉后台 / 误触返回时不至于白写 ----
   只存本地（localStorage），不上传：草稿是私人的，也没必要占服务器。
   隐私模式下 localStorage 会抛异常，统统 try 掉，不能因为存不了就连字都不让打。 */
const DRAFT = 'bbs_draft:';
function draftGet(k){ try { return localStorage.getItem(DRAFT + k) || '' } catch(e) { return '' } }
function draftSet(k, v){ try { if (v) localStorage.setItem(DRAFT + k, v); else localStorage.removeItem(DRAFT + k) } catch(e) {} }
function draftClear(k){ try { localStorage.removeItem(DRAFT + k) } catch(e) {} }

/* ---- 主题：深浅 + 配色方案 ----
   两件事分开存：
     bbs_theme   light / dark / auto（auto = 跟随系统）
     bbs_palette violet / ocean / mint / sunset / rose / slate
   首屏那点内联脚本已经先把属性写好，这里只负责后续切换与同步 UI。 */

// 这两份是「站内可选清单」，用 var 而不是 const：
// 顶层 var 会挂成 window 的属性，测试脚本和将来可能的第三方小代码
// 都能直接读到，不必再抄一遍（抄一遍就会漏同步）。
var PALETTES=[
  {id:'violet',name:'星铃紫',c:['#6d5dfc','#4f46e5','#e9e6ff']},
  {id:'ocean', name:'深海蓝',c:['#2563eb','#1d4ed8','#dfe9ff']},
  {id:'mint',  name:'薄荷青',c:['#0d9488','#0f766e','#d7f3ee']},
  {id:'sunset',name:'暖阳橘',c:['#ea580c','#c2410c','#ffe6d7']},
  {id:'rose',  name:'玫瑰粉',c:['#db2777','#be185d','#ffe1ee']},
  {id:'slate', name:'石墨灰',c:['#475569','#334155','#e6eaf2']},
];
var THEME_MODES=[{id:'light',name:'浅色'},{id:'dark',name:'深色'},{id:'auto',name:'跟随系统'}];

function lsGet(k,d){ try{ return localStorage.getItem(k)||d }catch(e){ return d } }
function lsSet(k,v){ try{ localStorage.setItem(k,v) }catch(e){} }
function sysDark(){ return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) }
function curMode(){ return lsGet('bbs_theme','auto') }
function curPalette(){ return lsGet('bbs_palette','violet') }

// 把 mode/palette 真正写进 DOM。加了两道保险：DOM 桩 / 极老浏览器里
// 可能拿不到 documentElement，主题只是锦上添花，绝不能因为它把 init() 带崩。
function applyTheme(){
  const root=document && document.documentElement;
  if(!root||!root.setAttribute) return;
  const mode=curMode();
  const dark=mode==='dark'||(mode!=='light'&&sysDark());
  root.setAttribute('data-theme',dark?'dark':'light');
  root.setAttribute('data-palette',curPalette());
  const meta=document.querySelector?.('meta[name=theme-color]');
  if(meta&&meta.setAttribute) meta.setAttribute('content',dark?'#0e1320':'#f4f6fb');
}
function initTheme(){ applyTheme() }

// 深浅只有「三档选择」（导航抽屉里），不再有顶栏那颗「盲翻」按钮：
// 盲翻看不出当前是哪一档，也不给「跟随系统」。
window.setThemeMode=mode=>{ lsSet('bbs_theme',mode); applyTheme(); fillAppearance() };
window.setPalette=id=>{ lsSet('bbs_palette',id); applyTheme(); fillAppearance() };

// 系统主题变化时，只有「跟随系统」这一档需要跟着变
if(window.matchMedia){
  try{
    const mq=window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change',()=>{ if(curMode()==='auto') applyTheme() });
  }catch(e){}
}

// 外观面板：配色小圆点 + 深浅三档。
// 深浅选择器有两处（设置弹窗与导航抽屉），共用同一份 HTML 生成器 ——
// 各写一份的话，加一档就必然漏掉一处。
function themeSegHtml(){
  return THEME_MODES.map(m=>
    `<button type="button" class="segBtn${curMode()===m.id?' on':''}" onclick="setThemeMode('${m.id}')" aria-pressed="${curMode()===m.id}">${m.name}</button>`).join('');
}
function fillAppearance(){
  const pk=$('#palettePicker');
  if(pk) pk.innerHTML=PALETTES.map(p=>
    `<button type="button" class="palOpt${curPalette()===p.id?' on':''}" style="--sw:${p.c[1]}" onclick="setPalette('${p.id}')" aria-pressed="${curPalette()===p.id}">`+
    `<span class="palDots"><i style="background:${p.c[0]}"></i><i style="background:${p.c[1]}"></i><i style="background:${p.c[2]}"></i></span>${p.name}</button>`).join('');
  const seg=$('#themeSeg');
  if(seg) seg.innerHTML=themeSegHtml();
  const nseg=$('#navThemeSeg');
  if(nseg) nseg.innerHTML=themeSegHtml();
}

/* ---- Markdown 工具栏 ----
   「第一次用的人一眼就懂」比「看着简洁」重要得多 —— 所以按钮上写**中文**，
   而且标签本身就把效果演示出来（加粗是粗体、斜体是斜体、删除线带删除线），
   鼠标悬停再补一句语法提示。纯图标（B / I / S / </>
   这一类）只有写惯了 Markdown 的人认得出，对新手等于没有标签。

   两个关键细节：
     · 按钮必须 onmousedown="event.preventDefault()" —— 否则点下去的瞬间
       textarea 失焦、选区被清空，加粗就只能作用在空字符串上；
     · 改完手动派发 input 事件 —— 草稿是监听 input 存的，不派发就不会存。 */

// n = 无障碍名称（也是悬停提示里的名字）；v = 按钮上的可见文字；s = 语法提示
const MD_ACTS=[
  {a:'b',    n:'加粗',     v:'<b>加粗</b>',     s:'**文字**'},
  {a:'i',    n:'斜体',     v:'<i>斜体</i>',     s:'*文字*'},
  {a:'s',    n:'删除线',   v:'<s>删除线</s>',   s:'~~文字~~'},
  {a:'h',    n:'标题',     v:'标题',            s:'## 标题'},
  {a:'quote',n:'引用',     v:'引用',            s:'> 引用'},
  {a:'code', n:'行内代码', v:'<code>代码</code>', s:'`代码`'},
  {a:'pre',  n:'代码块',   v:'代码块',          s:'``` 代码块 ```'},
  {a:'link', n:'链接',     v:'链接',            s:'[文字](网址)'},
  {a:'ul',   n:'无序列表', v:'列表',            s:'- 项目'},
  {a:'ol',   n:'有序列表', v:'编号',            s:'1. 项目'},
  {a:'hr',   n:'分隔线',   v:'分隔线',          s:'---'},
];

function mdBarHtml(ta,file,prev){
  // 提示里的语法示例带 > < 这类字符，进 HTML 属性前必须转义
  // （不转义的话，`title="引用：> 引用"` 里的 > 会被当成标签结束）
  const btns=MD_ACTS.map(x=>
    `<button type="button" class="mdBtn" title="${esc(x.n)}：${esc(x.s)}" aria-label="${esc(x.n)}" onmousedown="event.preventDefault()" onclick="mdAct('${ta}','${x.a}')">${x.v}</button>`).join('');
  // 上传控件必须是 <label for>，不能是 <button onclick="input.click()">：
  // label 由浏览器原生触发，各内核 / 移动端都稳；JS 调 .click() 在部分移动浏览器里
  // 会被判成「非用户手势」而静默失效 —— 点了完全没反应，也看不到任何报错。
  // 标签写全「图片/视频/音频」，只写「图片」会让人以为音频视频传不了。
  const up=file
    ? `<label class="mdBtn upBtn" for="${esc(String(file).replace(/^#/,''))}" title="插入图片 / 视频 / 音频">＋ 图片/视频/音频</label>`
    : '';
  const pv=prev
    ? `<span class="sp"></span><button type="button" class="mdBtn act" title="按 Markdown 预览渲染效果" aria-label="预览" onmousedown="event.preventDefault()" onclick="mdPreview('${ta}','${prev}',this)">预览</button>`
    : '';
  return btns+up+pv;
}

// 把所有占位的工具栏填上按钮。data-ta 指向目标 textarea。
// 附件按钮只在站点开启了存储时才出现 —— 入口统一到工具栏这一个地方，
// 上传的进度条和提示就挂在输入框下面，不再另设一颗「＋ 图片 / 视频 / 音频」。
function renderMdBars(){
  if(!document.querySelectorAll) return;
  document.querySelectorAll('.mdBar[data-ta]').forEach(el=>{
    if(!el.dataset||el.dataset.filled) return;   // 已经填过的不重复填，否则会打架
    const file=uploadOn?(el.dataset.file||''):'';
    el.innerHTML=mdBarHtml(el.dataset.ta,file,el.dataset.prev||'');
    el.dataset.filled='1';
  });
}

// 纯函数：算出「替换成什么 + 选中哪一段」，方便单独测
function mdApply(val,s,e,act){
  const sel=val.slice(s,e), multi=sel.indexOf('\n')>=0;
  const pick=(open,close,ph)=>{ const body=sel||ph; return [open+body+close,open.length,open.length+body.length] };
  // 行前缀类：选中多行就逐行加
  const pre=p=>{
    if(multi){ const out=sel.split('\n').map(l=>p+l).join('\n'); return [out,p.length,out.length] }
    return [p+sel,p.length,p.length+sel.length];
  };
  switch(act){
    case 'b':     return pick('**','**','粗体');
    case 'i':     return pick('*','*','斜体');
    case 's':     return pick('~~','~~','删除线');
    case 'code':  return pick('`','`','代码');
    case 'pre':   return pick('\n```\n','\n```\n','代码块');
    case 'h':     return pre('## ');
    case 'quote': return pre('> ');
    case 'ul':    return pre('- ');
    case 'ol':    return pre('1. ');
    case 'hr':    return ['\n\n---\n\n',4,4];
    case 'link':{ const body=sel||'链接文字'; return ['['+body+'](https://)',1,1+body.length] }
    default:      return [sel,0,sel.length];
  }
}

window.mdAct=(taSel,act)=>{
  const ta=document.querySelector(taSel); if(!ta) return;
  const val=String(ta.value||'');
  const s=ta.selectionStart==null?val.length:ta.selectionStart;
  const e=ta.selectionEnd==null?s:ta.selectionEnd;
  const r=mdApply(val,s,e,act);
  ta.value=val.slice(0,s)+r[0]+val.slice(e);
  try{ ta.focus(); ta.setSelectionRange(s+r[1],s+r[2]) }catch(err){}
  try{ ta.dispatchEvent(new Event('input',{bubbles:true})) }catch(err){}
};

// 预览：附件已经传过，所以 [img:n] 在这里能直接出图（renderBody 认得这个 id）
window.mdPreview=(taSel,prevSel,btn)=>{
  const ta=document.querySelector(taSel), box=document.querySelector(prevSel);
  if(!ta||!box) return;
  const on=box.classList.contains('hidden');
  box.classList.toggle('hidden',!on);
  if(btn&&btn.classList) btn.classList.toggle('on',on);
  if(on){
    const v=String(ta.value||'');
    box.innerHTML=v.trim()?renderBody(v,{},false):'<span class="muted">还没有内容</span>';
  }
};


// 列表里的缩略图：统一排成一行小方块，最多 4 张。
// 用 object-fit:cover 裁切（缩略图的常规做法），但绝不拉伸。
function previewThumbs(body, att, locked){
  const ids=[...String(body||'').matchAll(/\[img:(\d+)\]/g)].map(m=>m[1]).slice(0,4);
  if(!ids.length) return '';
  const items=ids.map(id=>{
    const info=att?.[id];
    if(info && /^(video|audio)\//.test(info.mime))
      return `<span class="thumbVideo">${/^video/.test(info.mime)?'🎬 视频':'🎵 音频'}</span>`;
    if(!info && att && Object.keys(att).length) return `<span class="thumbVideo">已失效</span>`;
    return `<img class="thumb" src="/api/files/${id}" loading="lazy" alt="" onclick="event.stopPropagation()">`;
  }).join('');
  return `<div class="thumbs${locked?' blurLock':''}">${items}</div>`;
}
// 时间戳渲染：D1 给的是 'YYYY-MM-DD HH:MM:SS'（UTC），补个 T + Z 才是标准格式。
// 缺值 / 格式不对时返回空串而不是抛异常 —— 一个字段的锅不该让整页白屏。
function time(s){
  if(!s) return '';
  const d=new Date(String(s).replace(' ','T')+'Z');
  if(isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
const isMine=(uid)=>!!me && (me.id===uid || me.can_mod);

async function init(){initTheme();const st=await api('/status');me=st.user;setupNeeded=st.setupNeeded;uploadOn=!!st.uploadEnabled;maxUploadMb=Number(st.maxUploadMb)||0;maxAvatarMb=Number(st.maxAvatarMb)||0;updateNav();if(setupNeeded)$('#setupDialog').showModal();renderMdBars();await list();}

function updateNav(){
  $('#loginBtn').classList.toggle('hidden',!!me);
  $('#userBtn').classList.toggle('hidden',!me);
  $('#newBtn').classList.toggle('hidden',!me);
  $('#adminBtn').classList.toggle('hidden',!canMod());
  $('#settingsBtn').classList.toggle('hidden',!me);
  $('#trashBtn')?.classList.toggle('hidden',!me);
  $('#logoutBtn').classList.toggle('hidden',!me);
  $('#profileBtn')?.classList.toggle('hidden',!me);
  const n=$('#me'); if(n) n.textContent=me?me.username:'游客';
  const a=$('#meAva'); if(a) a.innerHTML=me?avatarHtml(me,'avaMini'):'';
  if(!me) closeUserMenu();
}

/* ---- 顶栏用户菜单 ----
   手机上一排按钮根本放不下，统一收进头像下拉；桌面同款，只维护一份。
   （DOM 桩里没有 setAttribute / contains，所以一律走 setAttr 这种带守卫的写法） */
/* 当前处在哪个视图，写到 <html data-view>。
   手机端靠它决定「要不要把首页那套 hero / 板块栏收起来」——
   看帖子时首屏一半被装饰性内容占掉，是手机体验最直接的槽点。 */
function setView(v){
  const r=document&&document.documentElement;
  if(r&&r.setAttribute) r.setAttribute('data-view',v);
  window.scrollTo?.({top:0});
}
// 窄屏判定。渲染时就要知道（比如回复框默认折叠），所以不能只靠 CSS。
function narrowScreen(){
  try{ return !!(window.matchMedia && window.matchMedia('(max-width:560px)').matches) }catch(e){ return false }
}

const setAttr=(el,k,v)=>{ if(el&&el.setAttribute) el.setAttribute(k,v) };
function closeUserMenu(){
  $('#userMenu')?.classList.add('hidden');
  setAttr($('#userBtn'),'aria-expanded','false');
}
window.toggleUserMenu=e=>{
  e?.stopPropagation?.();
  const m=$('#userMenu'); if(!m) return;
  const open=m.classList.contains('hidden');   // 现在是隐藏的 ⇒ 这次要打开
  m.classList.toggle('hidden',!open);
  setAttr($('#userBtn'),'aria-expanded',open?'true':'false');
  if(open) fillAppearance();
};
window.goProfile=()=>{ closeUserMenu(); if(me) openUser(me.id) };
// 点空白处 / 按 Esc 收起菜单。桩里没有 addEventListener，守卫一下。
if(document.addEventListener){
  document.addEventListener('click',e=>{
    const m=$('#userMenu'); if(!m||m.classList.contains('hidden')) return;
    const u=$('#userBtn');
    if((m.contains&&m.contains(e.target))||(u&&u.contains&&u.contains(e.target))) return;
    closeUserMenu();
  });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeUserMenu(); closeNav() } });
}

async function loadBoards(){
  try{
    const d=await api('/boards');
    boards={ list: Array.isArray(d?.boards)?d.boards:[], unboarded:Number(d?.unboarded||0) };
  }catch(e){ boards={list:[],unboarded:0}; }
  renderNav();   // 板块数据一变，抽屉里的列表跟着走（不用每个调用点各记一次）
}

// 当前筛选中的板块名：'all' / 'none' / 数字 id
function curBoardName(){
  if(curBoard==='all') return '全部';
  if(curBoard==='none') return '未分类';
  const b=boards.list.find(x=>String(x.id)===String(curBoard));
  return b?b.name:'全部';
}

/* hero 文案跟着当前板块走：进板块就把站点的标语换成板块自己的名字和介绍，
   回到「全部」再换回默认。只在 list() 里统一调一次 —— pickBoard / 建板块后跳转 /
   管理员删板块回退，最终都会走 list()，不用每个入口各记一次。 */
function renderHero(){
  const pill=$('#heroPill'), title=$('#heroTitle'), desc=$('#heroDesc');
  if(!pill||!title||!desc) return;
  if(curBoard==='all'){
    pill.textContent='自由讨论 · BBS';
    title.textContent='说点什么，留下你的痕迹。';
    desc.textContent='这里是一个自由的讨论社区。可以发帖、回复，也可以带上图片和视频。';
    return;
  }
  pill.textContent='板块 · BBS';
  if(curBoard==='none'){
    title.textContent='未分类';
    desc.textContent='发帖时没有选择板块的主题都会落在这里。';
    return;
  }
  const b=boards.list.find(x=>String(x.id)===String(curBoard));
  title.textContent=b?b.name:'板块';
  desc.textContent=(b&&b.description)?b.description:'这个板块还没有填写介绍。';
}

/* ---- 导航抽屉（左上角菜单）----
   板块以前是横着一排胶囊：板块一多就换两三行，首屏被撑得很长，
   而且每个板块都常驻视线里，安静看帖的人先被一排按钮拦一道。
   现在收进这里：点开才出现，条目改成行式排版 ——
   名字吃满剩余宽度（超长省略号）、计数固定右对齐，板块名长短不一时右侧也是齐的。
   同一个抽屉也收下了「外观」：顶栏那颗深浅按钮看不出当前档位，这里换成三档。 */
function renderNav(){
  const box=$('#navBody'); if(!box) return;
  const item=(v,label,n,i)=>{
    const on=curBoard===String(v);
    return `<button type="button" class="navItem${on?' on':''}" style="--i:${i}" onclick="pickBoard('${v}')"${on?' aria-current="true"':''}>`+
      `<span class="navTick" aria-hidden="true"></span><span class="navName">${esc(label)}</span>`+
      (n==null?'':`<span class="navN">${n}</span>`)+`</button>`;
  };
  const rows=[item('all','全部',null,0),item('none','未分类',boards.unboarded,1)]
    .concat(boards.list.map((b,i)=>item(b.id,b.name,b.threads,i+2)));
  box.innerHTML=
    `<section class="navSec">`+
      `<h4 class="navSecT">板块</h4>`+
      `<div class="navList">${rows.join('')}</div>`+
      (me?`<button type="button" class="mini navAdd" style="--i:${rows.length}" onclick="openBoardDialog()">＋ 新建板块</button>`:'')+
    `</section>`+
    `<section class="navSec">`+
      `<h4 class="navSecT">外观</h4>`+
      `<div class="segRow" id="navThemeSeg"></div>`+
    `</section>`;
  fillAppearance();
}

/* 列表顶部那一行：当前板块 + 搜索框。
   板块按钮是「筛选状态」唯一可见的出口 —— 板块收进菜单之后必须留它，
   否则切到某个板块再回到列表，用户根本看不出列表正被筛过，只会以为帖子少了。 */
function renderBoardBar(){
  const bar=$('#boardBar');
  if(!bar) return;
  bar.classList.remove('hidden');
  bar.innerHTML=
    `<div class="filterRow">`+
      `<button type="button" class="chip pickChip" onclick="toggleNav(event)" aria-haspopup="dialog" title="切换板块">`+
        `<span class="pickK">板块</span><b>${esc(curBoardName())}</b><span class="caret">▾</span>`+
      `</button>`+
      `<form class="searchRow" onsubmit="event.preventDefault();doSearch()">`+
        `<input id="searchInput" type="search" maxlength="60" placeholder="搜索标题、正文或作者…" value="${esc(curQ)}" oninput="onSearchType()">`+
        `<button class="mini primary" type="submit">搜索</button>`+
        (curQ?`<button class="mini" type="button" onclick="clearSearch()">清除</button>`:'')+
      `</form>`+
    `</div>`;
}

function drawerOpen(){ const d=$('#navDrawer'); return !!(d&&d.classList.contains('open')) }
/* 锁背景滚动：iOS Safari 不吃 body{overflow:hidden} 那一套（橡皮筋照样带动整页），
   所以 CSS 那边是 position:fixed，这里负责记下 / 还原滚动位置 ——
   不还原的话关掉抽屉时页面会跳回顶部，比「背景跟着滚」还烦人。 */
let navScrollY=0;
window.openNav=()=>{
  const d=$('#navDrawer'); if(!d) return;
  navScrollY=window.scrollY||0;
  renderNav();
  d.classList.add('open');
  $('#navMask')?.classList.add('open');
  setAttr(d,'aria-hidden','false');
  setAttr($('#navBtn'),'aria-expanded','true');
  document.body?.classList?.add?.('navOpen');
  const bs=document.body?.style; if(bs) bs.top=(-navScrollY)+'px';
};
window.closeNav=()=>{
  const d=$('#navDrawer'); if(!d) return;
  d.classList.remove('open');
  $('#navMask')?.classList.remove('open');
  setAttr(d,'aria-hidden','true');
  setAttr($('#navBtn'),'aria-expanded','false');
  document.body?.classList?.remove?.('navOpen');
  const bs=document.body?.style; if(bs) bs.top='';
  window.scrollTo?.(0,navScrollY);
};
/* 内容限制开关：改动立刻存，不另设「保存」按钮 ——
   这类偏好改完就想看到效果，多一步保存只会让人怀疑到底生效没有。 */
window.saveSensitiveFilter=async on=>{
  try{
    const d=await api('/account/profile',{method:'POST',body:JSON.stringify({sensitiveFilter:on?1:0})});
    me=d.user||me;
    toast(on?'已开启：不易展示的内容会先模糊':'已关闭：这类内容将直接显示');
    list();                       // 重画一次，让列表里的遮罩跟着变
  }catch(x){ toast(x.message); $('#settingsBtn').click(); }
};

// 管理员 / 子管理员给别人的内容补标（或撤标）。tid 有值就回帖子详情，否则刷管理中心。
window.toggleSensitive=async(target,id,tid)=>{
  try{
    const d=await api('/admin/moderate',{method:'POST',body:JSON.stringify({type:'sensitive',target,id})});
    toast(d&&d.sensitive?'已标记为不易展示':'已取消不易展示标记');
    if(tid) openThread(tid); else $('#adminBtn').click();
  }catch(x){toast(x.message)}
};

window.toggleNav=e=>{ e?.stopPropagation?.(); drawerOpen()?closeNav():openNav() };
// 「＋ 新建板块」在抽屉里：先收起抽屉再开弹窗，否则两层浮层叠在一起
window.openBoardDialog=()=>{ closeNav(); $('#boardDialog')?.showModal?.() };

window.pickBoard=async v=>{
  closeNav();                      // 选完就收起抽屉（点当前板块也一样，算「关掉」）
  if(curBoard===String(v)) return;
  curBoard=String(v);
  curPage=1;                       // 换板块 = 换结果集，页码必须回到 1
  await list();
};

let searchTimer=0;
// 输入时不立刻打请求，停手 400ms 再搜。中文输入法每敲一下都会触发 input，不防抖会打爆后端。
window.onSearchType=()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(()=>doSearch(),400) };
window.doSearch=async()=>{
  const v=String($('#searchInput')?.value||'').trim().slice(0,60);
  if(v===curQ) return;             // 词没变就别重画，否则输入过程中光标会被 innerHTML 冲掉
  curQ=v; curPage=1;
  await list(true);                // keepBar：板块栏没变，重画会抢走输入框焦点
};
window.clearSearch=async()=>{
  if(!curQ) return;
  curQ=''; curPage=1;
  await list();                    // 这里要重画，「清除」按钮得消失
};

// 翻页。页码在后端已夹过，这里再夹一次纯粹是为了按钮点得快时不出负数。
window.goPage=async p=>{
  const target=Math.min(Math.max(Number(p)||1,1),Math.max(pageInfo.pages||1,1));
  if(target===pageInfo.page) return;
  curPage=target;
  await list(true);
  window.scrollTo({top:0,behavior:'smooth'});
};

// 分页条。只有一页时不出现，免得列表底下挂着一条没用的横条。
function pagerHtml(){
  const {page,pages,total}=pageInfo;
  if(!total||pages<=1) return '';
  const b=(p,label,dis)=>`<button class="pageBtn" ${dis?'disabled':''} onclick="goPage(${p})">${label}</button>`;
  return `<nav class="pager">${b(page-1,'‹ 上一页',page<=1)}<span class="pageInfo">第 ${page} / ${pages} 页 · 共 ${total} 条</span>${b(page+1,'下一页 ›',page>=pages)}</nav>`;
}

// keepBar=true：板块栏与搜索框保持原样（翻页、搜索时用，避免输入框被重画）
async function list(keepBar){
  setView('list');
  await loadBoards();
  renderHero();                    // hero 文案跟随当前板块（含建板块后跳转 / 删板块回退）
  if(!keepBar) renderBoardBar();
  const sp=new URLSearchParams();
  if(curBoard!=='all') sp.set('board',curBoard);
  if(curQ) sp.set('q',curQ);
  sp.set('page',String(curPage));
  const d=await api('/threads?'+sp.toString());
  const rows=Array.isArray(d?.items)?d.items:[];
  rows.forEach(t=>rememberQuote('thread',t));      // 转帖弹窗的预览要用
  pageInfo={total:Number(d?.total||0),page:Number(d?.page||1),pages:Number(d?.pages||1),limit:Number(d?.limit||20)};
  $('#threadCount').textContent=pageInfo.total;   // 顶栏那个「主题」显示的是筛选后的总数，不是本页条数
  const emptyMsg=curQ?`没有找到和「${esc(curQ)}」有关的主题。换个词试试 ✨`
    :(curBoard==='all'?'还没有主题。成为第一个留下文字的人吧 ✨':'这个板块还没有帖子，来开个头吧 ✨');
  app.innerHTML=`<div class="threadList">${rows.map((t,i)=>{const locked=sensitiveOn()&&!!(t.sensitive);const acts=reactRow('thread',t.id,t.likes||0,!!t.liked,t.reposts||0,false);return `<article class="thread anim-in" style="animation-delay:${Math.min(i*45,450)}ms" onclick="openThread(${t.id})"><div class="threadTop">${t.pinned?'<span class="tag">置顶</span>':''}${t.locked?'<span class="tag">已锁</span>':''}${t.sensitive?'<span class="tag warn">不易展示</span>':''}${t.protected?'<span class="tag board shieldTag">已保护</span>':''}${t.quote_ref?'<span class="tag mute">转帖</span>':''}${t.board_name?`<span class="tag board">${esc(t.board_name)}</span>`:''}</div><h3>${esc(t.title)}</h3><p class="${locked?'blurLock':''}">${renderBody(t.body, t.att, true)}</p>${previewThumbs(t.body,t.att,locked)}<div class="meta">${avatarLink(t,'avaMini',t.author_id)}<span class="linkName" onclick="event.stopPropagation();openUser(${t.author_id})">${esc(t.username)}</span><span>${time(t.updated_at)}</span><span>${t.replies} 回复</span>${locked?'<span class="lockTip">滑动确认后可读</span>':''}</div>${pollMiniHtml(t.poll)}${acts}</article>`}).join('')}</div>${!rows.length?`<div class="empty anim-in">${emptyMsg}</div>`:''}${pagerHtml()}`;
}

/* ---- 楼中楼 ----
   后端只存 reply_to 一个自引用字段，树由前端现搭。
   深度封顶 3 层：再深下去手机上每一行都被缩进挤成一条，反而没法读。
   超过深度的回复按顶层展示（内容不丢，只是不再缩进）。 */
const MAX_DEPTH = 3;
function buildReplyTree(posts){
  const nodes = new Map();
  posts.forEach((p, i) => nodes.set(p.id, { p, no: i + 1, kids: [] }));
  const roots = [];
  posts.forEach(p => {
    const node = nodes.get(p.id);
    const parent = p.reply_to ? nodes.get(p.reply_to) : null;
    // 父节点存在、不是自己、且链上没有环，才挂上去
    if (parent && parent !== node && !isAncestor(nodes, node, parent)) parent.kids.push(node);
    else roots.push(node);
  });
  return roots;
}
// node 是否是 maybeChild 的祖先（防止 A→B→A 这种环把渲染卡死）
function isAncestor(nodes, node, maybeChild){
  let cur = maybeChild, guard = 0;
  while (cur && guard++ < 100) {
    if (cur === node) return true;
    cur = cur.p && cur.p.reply_to ? nodes.get(cur.p.reply_to) : null;
  }
  return false;
}

// 引用条：楼中楼回复头顶那一行「回复 @xxx：原文摘要」
function quoteBar(parent){
  if (!parent) return '';
  const txt = MD.plain(parent.p.body).slice(0, 60);
  return `<div class="quoteBar"><i>回复 ${esc(parent.p.username)}：</i>${esc(txt)}${MD.plain(parent.p.body).length > 60 ? '…' : ''}</div>`;
}

function replyNodeHtml(node, depth, att, threadId, lock){
  const p = node.p;
  const acts = [];
  // 游客既没有回复框也没有编辑权，按钮就不该出现
  if (me && !lock) acts.push(`<button class="mini" onclick="startReply(${threadId},${p.id})">回复</button>`);
  // 受保护的回复：所有权已经交给站主，作者本人也不能改不能删 ——
  // 按钮干脆不渲染，免得点了才吃一个 403。
  const canTouch = !(p.protected && !canAdmin());
  if (isMine(p.author_id) && canTouch) {
    acts.push(`<button class="mini" onclick="editPost(${p.id},${threadId})">编辑</button>`);
    acts.push(`<button class="mini danger" onclick="delPost(${p.id},${threadId})">删除</button>`);
  }
  // 管理员 / 子管理员可以给别人的内容补上（或撤掉）「不易展示」标记（受保护的除外）
  if (canMod() && canTouch) acts.push(`<button class="mini" onclick="toggleSensitive('post',${p.id},${threadId})">${p.sensitive?'取消限制':'设为限制'}</button>`);
  // 站主：把这条回复「接管」过来（或交还作者）
  if (canAdmin()) acts.push(`<button class="mini" onclick="toggleProtect('post',${p.id},${threadId})">${p.protected?'取消保护':'保护此回复'}</button>`);
  // 投票：一条回复最多挂一个；已经有人投过票就只能找站主移除
  if (isMine(p.author_id) && canTouch && !lock) {
    if (p.poll) { if (!p.poll.total || canAdmin()) acts.push(`<button class="mini danger" onclick="removePoll('post',${p.id},${threadId})">移除投票</button>`); }
    else acts.push(`<button class="mini" onclick="openPollDialog('post',${p.id},${threadId})">＋ 投票</button>`);
  }
  // 赞 / 转帖 / 引用：登录了才有 —— 游客连回复框都没有，这三颗也不该出现。
  // 主题锁了就没有「引用」可言（引用是要挂进一条新回复里的），赞和转帖不受影响。
  const react = me ? reactRow('post', p.id, p.likes || 0, !!p.liked, p.reposts || 0, !lock) : '';
  // 楼层按序号错开进场 —— 一层层落下比整块弹出更容易看出阅读顺序
  return `<article class="post anim-in${depth > 0 ? ' nested' : ''}" style="--depth:${Math.min(depth, MAX_DEPTH)};animation-delay:${Math.min(node.no * 35, 320)}ms">
    <div class="postHead">
      ${avatarLink(p, 'ava', p.author_id)}
      <div class="postWho">
        <b class="linkName" onclick="openUser(${p.author_id})">${esc(p.username)}</b>
        <small>#${node.no} · ${time(p.created_at)}${p.role === 'admin' ? ' · 管理员' : ''}${p.protected ? ' · <span class="tag board shieldTag">已保护</span>' : ''}${p.edited_at ? ` · <span class="edited" onclick="showEdits('post',${p.id})">已编辑</span>` : ''}</small>
        ${p.bio ? `<span class="sig">${esc(p.bio)}</span>` : ''}
      </div>
    </div>
    ${quoteBar(parentOf(node))}
    ${quoteCardOf(p.quote_snapshot)}
    <div class="postBody">${bodyWithPollHtml(p, att, '这条回复被标记为不易展示')}</div>
    ${react}
    ${acts.length ? `<div class="postActions">${acts.join('')}</div>` : ''}
    ${node.kids.map(k => replyNodeHtml(k, depth + 1, att, threadId, lock)).join('')}
  </article>`;
}
// 渲染时临时记一下父节点，供 quoteBar 取用（避免把 parent 一路当参数传下去）
let parentMap = new Map();
function parentOf(node){ return parentMap.get(node) || null; }
let replyNoMap = {};

window.openThread=async id=>{
  setView('thread');
  curReplyTo=0;                  // 换帖时必须清掉，否则会把上一条的「回复某楼」带过来
  curQuote=null;                 // 同理：「正在引用」也是一次性状态
  curThreadId=Number(id)||0;
  // 换了一帖就把编辑器里的投票草稿丢掉：那一份属于上一帖的回复框
  if(pollLastThread!==curThreadId){ curPollDraft=null; pollLastThread=curThreadId }
  // 整个渲染包一层 try：主题被删 / 网络出错时以前是静默白屏（Promise 拒绝没人接），
  // 现在至少说一句人话，并且退回列表，不把用户留在半屏上。
  let d;
  try{ d=await api('/threads/'+id) }
  catch(x){ toast(x.message); list(); return }
  const t=d.thread, lock=!!(t.locked&&!canMod());
  rememberQuote('thread',t);
  (d.posts||[]).forEach(p=>rememberQuote('post',p));   // 回复也能被引用 / 转帖
  // 管理员 / 子管理员可以把帖子挪到别的板块。只改归属，内容一条不少，随时可以再挪回来。
  const moveRow=canMod()?`<div class="moveRow"><span class="muted">板块</span><select id="moveBoard">`+
    `<option value="">未分类</option>`+
    boards.list.map(b=>`<option value="${b.id}"${t.board_id===b.id?' selected':''}>${esc(b.name)}</option>`).join('')+
    `</select><button class="mini" onclick="moveThread(${t.id})">移动到该板块</button></div>`:'';

  const roots = buildReplyTree(d.posts || []);
  replyNoMap = {}; (d.posts || []).forEach((p, i) => { replyNoMap[p.id] = i + 1 });
  parentMap = new Map();
  const fill = (nodes, parent, depth) => nodes.forEach(n => {
    parentMap.set(n, parent);
    fill(n.kids, n, depth + 1);
  });
  fill(roots, null, 0);

  const headActs=[];
  // 受保护 = 所有权在站主手上，作者那一排按钮直接不渲染（点了也只会吃 403）
  const canTouchT = !(t.protected && !canAdmin());
  if (isMine(t.author_id) && canTouchT) headActs.push(`<button class="mini" onclick="editThread(${t.id})">编辑</button>`);
  if (isMine(t.author_id) && canTouchT) headActs.push(`<button class="mini danger" onclick="delThread(${t.id})">删除主题</button>`);
  if (canMod() && canTouchT) headActs.push(`<button class="mini" onclick="toggleSensitive('thread',${t.id},${t.id})">${t.sensitive?'取消限制':'设为限制'}</button>`);
  if (canAdmin()) headActs.push(`<button class="mini" onclick="toggleProtect('thread',${t.id},${t.id})">${t.protected?'取消保护':'保护此主题'}</button>`);
  // 投票：一条内容最多挂一个。已经有人投过票之后后端不让移除，前端也就别给这颗按钮。
  if (isMine(t.author_id) && canTouchT && !lock) {
    if (t.poll) { if (!t.poll.total || canAdmin()) headActs.push(`<button class="mini danger" onclick="removePoll('thread',${t.id},${t.id})">移除投票</button>`); }
    else headActs.push(`<button class="mini" onclick="openPollDialog('thread',${t.id},${t.id})">＋ 投票</button>`);
  }

  app.innerHTML=`<div class="view anim-in">
    <span class="back" onclick="list()">← 返回主题列表</span>
    <article class="post first anim-in">
      <div class="postHead">
        ${avatarLink(t, 'ava', t.author_id)}
        <div class="postWho">
          <b class="linkName" onclick="openUser(${t.author_id})">${esc(t.username)}</b>
          <small>${time(t.created_at)}${t.board_name?` · <span class="tag board">${esc(t.board_name)}</span>`:''}${t.protected?' · <span class="tag board shieldTag">已保护</span>':''}${t.locked?' · 已锁定':''}${t.edited_at?` · <span class="edited" onclick="showEdits('thread',${t.id})">已编辑</span>`:''}</small>
          ${t.bio?`<span class="sig">${esc(t.bio)}</span>`:''}
        </div>
      </div>
      <h1>${esc(t.title)}</h1>
      ${t.protected?'<p class="shieldNote">这条内容已由站主保护：原作者不再能修改或删除它。</p>':''}
      ${quoteCardOf(t.quote_snapshot)}
      <div class="postBody">${bodyWithPollHtml(t, d.att, '这条内容被标记为不易展示')}</div>
      ${moveRow}
      ${me?reactRow('thread',t.id,t.likes||0,!!t.liked,t.reposts||0,!lock):''}
      ${headActs.length?`<div class="postActions">${headActs.join('')}</div>`:''}
    </article>
    <div class="replies">${roots.map(n=>replyNodeHtml(n,0,d.att,id,lock)).join('')}</div>
    ${me?`<form class="replyBox${narrowScreen()?' collapsed':''}" id="replyForm">
      <button type="button" class="replyOpen" onclick="expandReply()">写下回复……</button>
      <div class="replyTo hidden" id="replyToBar"></div>
      <div class="replyTo hidden" id="quoteBar"></div>
      <textarea id="replyBody" maxlength="10000" placeholder="写下回复……" ${lock?'disabled':''}></textarea>
      ${lock?'':`<div class="mdBar" data-ta="#replyBody"${uploadOn?' data-file="#replyFile"':''}></div>`}
      ${lock||!uploadOn?'':`<input type="file" id="replyFile" class="fileHidden" accept="image/*,video/*,audio/*" multiple onchange="uploadInto('#replyFile','#replyBody')"><div class="progress hidden"><i></i></div><div class="upRow hidden"><span class="upTip muted"></span><button class="mini" type="button" onclick="cancelUpload()">取消</button></div>`}
      ${lock?'':`<label class="checkRow slim"><input type="checkbox" id="replySensitive"> 标记为不易展示（剧透 / 公共场合不宜）</label>`}
      ${lock?'':`<div class="pollCompose"><div class="hrRow"><button class="mini" type="button" id="replyPollBtn" onclick="openPollDialog()">＋ 插入投票</button><span class="muted">每个账号只能投一次</span></div><div id="replyPollChip"></div></div>`}
      <div class="rowActions end"><span class="muted" id="draftTip"></span><button class="primary" ${lock?'disabled':''}>回复</button></div>
    </form>`:'<div class="empty">登录后才能回复。</div>'}
  </div>`;

  renderMdBars();

  // 草稿：写一半被打断不至于白写。恢复后给个提示，让人知道不是自己写的残影。
  const ta=$('#replyBody');
  if(ta && !lock){
    const saved=draftGet('post:'+id);
    if(saved){ ta.value=saved; $('#draftTip').textContent='已恢复上次未发送的草稿'; }
    ta.addEventListener('input',()=>draftSet('post:'+id,ta.value));
  }
  $('#replyForm')?.addEventListener('submit',async e=>{
    e.preventDefault();
    try{
      // 引用和「回复某楼」是两件独立的事，但一次只能挂一个 ——
      // 引用的是内容，回复的是楼层，同时给两条关系只会让读的人分不清。
      await api('/threads/'+id+'/posts',{method:'POST',body:JSON.stringify({body:$('#replyBody').value,replyTo:curReplyTo,sensitive:$('#replySensitive')?.checked?1:0,quote:curQuote||null,poll:curPollDraft||null})});
      draftClear('post:'+id); curReplyTo=0; curQuote=null; curPollDraft=null; toast('回复已发布'); openThread(id);
    }catch(x){toast(x.message)}
  });
  renderReplyToBar();
  renderQuoteBar();
  renderPollChips();        // 回复框里可能还留着上一次的投票草稿
  initSensitive();          // 给这一屏里所有遮罩挂上滑动确认
};

/* ---- 楼中楼：点「回复」进入针对某楼的回复状态 ---- */
let curReplyTo=0;
/* 手机上回复框默认是折叠的一行提示条（展开要占掉半屏，而看帖时它并不是主角）。
   点某一楼的「回复」会自动展开 —— 那时候用户确实是要写字了。 */
window.expandReply=()=>{
  const f=$('#replyForm'); if(!f) return;
  // 从折叠展开时给个「opening」标记，让刚露出来的内容淡入一下，
  // 而不是硬生生地跳出来（标记自己会摘掉，不残留）。
  if(f.classList.contains('collapsed')){
    f.classList.remove('collapsed');
    f.classList.add('opening');
    setTimeout(()=>f.classList.remove('opening'),420);
  }
  const ta=$('#replyBody');
  ta?.focus?.();
  f.scrollIntoView?.({block:'nearest'});
};
window.startReply=(threadId,postId)=>{
  curReplyTo=postId;
  window.expandReply();
  renderReplyToBar();
  $('#replyBody')?.focus();
  $('#replyForm')?.scrollIntoView({behavior:'smooth',block:'center'});
};
window.cancelReply=()=>{ curReplyTo=0; renderReplyToBar() };
function renderReplyToBar(){
  const bar=$('#replyToBar'); if(!bar) return;
  bar.classList.toggle('hidden',!curReplyTo);
  // 显示楼层号（#3）比显示数据库 id 好认，映射在打开主题时建好
  if(curReplyTo) bar.innerHTML=`正在回复 #${replyNoMap[curReplyTo]||curReplyTo} <button class="mini" type="button" onclick="cancelReply()">取消</button>`;
}

/* ---- 引用：把别人的内容挂进自己的回复里 ----
   和「回复某楼」不同的两处：回复是**楼层关系**（渲染成楼中楼），
   引用是**内容关系**（渲染成一张卡）。所以两者可以同时存在，
   但如果都挂上了，提交时只认引用 —— 楼层关系靠 reply_to 已经表达过了。 */
let curQuote=null;
window.startQuote=(type,id)=>{
  if(!me){ needLogin('引用'); return }
  curQuote={type,id};
  window.expandReply();
  renderQuoteBar();
  $('#replyBody')?.focus?.();
  $('#replyForm')?.scrollIntoView?.({behavior:'smooth',block:'center'});
};
window.cancelQuote=()=>{ curQuote=null; renderQuoteBar() };
function renderQuoteBar(){
  const bar=$('#quoteBar'); if(!bar) return;
  const on=!!curQuote;
  bar.classList.toggle('hidden',!on);
  if(!on){ bar.innerHTML=''; return }
  const q=quoteCache(curQuote.type,curQuote.id);
  const what=q?(esc(q.user||'')+(q.title?'：'+esc(q.title):'：'+esc(q.excerpt||''))):'#'+curQuote.id;
  bar.innerHTML=`正在引用 ${what} <button class="mini" type="button" onclick="cancelQuote()">取消</button>`;
}

/* ---- 投票 ----
   一条内容最多挂一个投票，每个账号只能投一次（后端唯一索引兜底，前端只负责把话说清楚）。
   没投票前**不显示票数**：先看见「大家都选 A」会带着人走，那就不叫投票了。
   投过票的人、以及没登录的游客直接看结果 —— 他们已经投不了了，藏着数字没有意义。 */
const ICO_POLL = '<svg class="pollIco" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20.5h4.2V11H4zM9.9 20.5h4.2V3.5H9.9zM15.8 20.5H20V8h-4.2z"/></svg>';
const POLL_MAX_OPT = 10;      // 与后端 POLL_MAX_OPTIONS 一致
let curPollDraft = null;      // 编辑器草稿（发帖框 / 回复框共用一份）
let curPoll = null;           // 弹窗里正在编辑的那份
let curPollTarget = null;     // null = 编辑草稿；{type,id,back} = 给已发出的内容补一个
const pollPicks = new Map();  // 多选时「当前勾了哪几项」，按投票 id 分开记
let curThreadId = 0;          // 当前打开的主题（投票完要原地重画，用得上）
let pollLastThread = -1;      // 草稿属于哪一帖
function pollPicksOf(pid){ if(!pollPicks.has(pid)) pollPicks.set(pid,new Set()); return pollPicks.get(pid) }

// 投票卡。id 是必须的：投完票只重画这一张卡，整屏重画会把人正看着的位置冲掉。
function pollCardHtml(p){
  if(!p||!p.id) return '';
  const total=Number(p.total||0);
  const voted=!!p.voted;
  const showRes=voted||!me;                       // 投过 / 游客 → 直接看结果
  const mine=Array.isArray(p.mine)?p.mine:[];
  const opts=(p.options||[]).map(o=>{
    const n=Number(o.n||0);
    const pct=total?Math.round(n*100/total):0;
    if(!showRes){
      // 未投票：可点的选项。多选是可勾选的（配一颗「投票」按钮），单选点一下就投
      const on=mine.indexOf(o.id)>=0;
      const act=p.multi?`togglePollPick(${p.id},${o.id},this)`:`votePoll(${p.id},${o.id})`;
      return `<button type="button" class="pollOpt${on?' on':''}" aria-pressed="${on?'true':'false'}" onclick="${act}">`+
        `<span class="pollMark" aria-hidden="true"></span><span class="pollOptTxt">${esc(o.label)}</span></button>`;
    }
    const hit=mine.indexOf(o.id)>=0;
    return `<div class="pollRes${hit?' mine':''}">
      <span class="pollResTop"><span class="pollResLabel">${hit?'<span class="pollTick" aria-label="你投的是这个">✓</span>':''}${esc(o.label)}</span><span class="pollResNum">${n} 票 · ${pct}%</span></span>
      <span class="pollBar"><i style="width:${pct}%"></i></span>
    </div>`;
  }).join('');
  const submit=(!showRes&&p.multi)?`<button class="mini primary pollSubmit" type="button" onclick="submitPoll(${p.id})">投票</button>`:'';
  const foot=showRes
    ? `共 ${total} 人参与${voted?' · 已投票，谢谢你的这一票':(!me?' · 登录后才能投票':'')}`
    : (p.multi?'可以选多个 · 每个人只有一票':'选一个 · 每个人只有一票');
  return `<div class="pollCard" id="pollCard-${p.id}">
    <div class="pollHead">${ICO_POLL}<b>${esc(p.question)}</b><span class="tag mute">${p.multi?'多选':'单选'}</span></div>
    <div class="pollOpts">${opts}</div>
    ${submit}
    <div class="pollFoot muted">${foot}</div>
  </div>`;
}

/* 正文 + 投票卡一起渲染：标记了「不易展示」时两者一起被遮住 ——
   只遮正文、把投票露在外面，等于那条限制标记形同虚设。 */
function bodyWithPollHtml(o, att, note){
  const inner = renderBody(o.body, att) + pollCardHtml(o.poll);
  return (sensitiveOn() && o.sensitive) ? coverHtml(inner, note || '这条内容被标记为不易展示') : inner;
}

// 列表里的投票只给一句摘要：整张卡片本来就是「点进去看」，
// 在列表里铺开一排选项既占地方，也让人误以为可以直接在列表里投。
function pollMiniHtml(p){
  if(!p||!p.id) return '';
  const total=Number(p.total||0);
  return `<div class="pollMini">${ICO_POLL}<b>${esc(p.question)}</b>`+
    `<span class="muted">${total?`${total} 人参与`:'还没有人投票'} · ${p.multi?'多选':'单选'}</span>`+
    `<span class="pollMiniGo">${p.voted?'看结果':'去投票'} →</span></div>`;
}

/* ---- 投票编辑器 ----
   选项框在打字时**不重排**（重排会抢走光标，中文输入法下尤其明显），
   只有增删选项才重画 —— 所以输入只改数组，不碰 DOM。 */
window.openPollDialog=(target,id,back)=>{
  if(!me){ needLogin('发起投票'); return }
  curPollTarget=(target&&id)?{type:String(target),id:Number(id),back:Number(back)||0}:null;
  const blank=()=>({question:'',options:['',''],multi:0});
  // 给已发出的内容补投票时永远从空白开始；编辑器那一档沿用已有草稿
  curPoll=curPollTarget?blank():(curPollDraft||blank());
  const q=$('#pollQuestion'); if(q) q.value=curPoll.question||'';
  const m=$('#pollMulti'); if(m) m.checked=!!curPoll.multi;
  renderPollEditor();
  const hint=$('#pollHint');
  if(hint) hint.textContent=curPollTarget
    ? '这个投票会挂在你已经发出的这条内容上。每个人只能投一次。'
    : '会和这条内容一起发出去。每个人只能投一次。';
  $('#pollDialog')?.showModal?.();
};
function renderPollEditor(){
  const box=$('#pollOptList'); if(!box||!curPoll) return;
  const list=curPoll.options||[];
  box.innerHTML=list.map((v,i)=>`<div class="pollOptRow"><span class="pollOptNo">${i+1}</span>`+
    `<input value="${esc(v)}" maxlength="80" placeholder="选项 ${i+1}" oninput="onPollOpt(${i},this.value)">`+
    `<button class="mini danger pollDel" type="button" onclick="removePollOpt(${i})"${list.length<=2?' disabled':''} aria-label="删除选项 ${i+1}">×</button></div>`).join('');
  const c=$('#pollOptCount'); if(c) c.textContent=`${list.length} / ${POLL_MAX_OPT}`;
  const add=$('#pollAddOpt'); if(add&&add.classList) add.classList.toggle('hidden',list.length>=POLL_MAX_OPT);
}
window.onPollOpt=(i,v)=>{ if(curPoll&&curPoll.options) curPoll.options[i]=v };
window.addPollOption=()=>{
  if(!curPoll) return;
  if((curPoll.options||[]).length>=POLL_MAX_OPT){ toast(`最多 ${POLL_MAX_OPT} 个选项`); return }
  curPoll.options.push(''); renderPollEditor();
};
window.removePollOpt=i=>{
  if(!curPoll||!curPoll.options) return;
  curPoll.options.splice(i,1);
  while(curPoll.options.length<2) curPoll.options.push('');     // 永远留两个空位
  renderPollEditor();
};
$('#pollForm').onsubmit=async e=>{
  e.preventDefault();
  if(!curPoll) return;
  const q=String(($('#pollQuestion')||{}).value||'').trim();
  const opts=(curPoll.options||[]).map(s=>String(s||'').trim()).filter(Boolean);
  if(!q){ toast('先写一句投票的问题吧'); return }
  if(opts.length<2){ toast('至少要填 2 个选项'); return }
  const poll={question:q,options:opts,multi:$('#pollMulti')?.checked?1:0};
  const t=curPollTarget;
  try{
    if(t) await api('/poll',{method:'POST',body:JSON.stringify({target:t.type,id:t.id,poll})});
    else { curPollDraft=poll; renderPollChips(); }
    curPoll=null; curPollTarget=null;
    $('#pollDialog')?.close?.();
    if(t){ toast('投票已添加 ✨'); openThread(t.back||t.id) }
  }catch(x){ toast(x.message) }
};

// 草稿条：发帖框与回复框各有一个容器，内容同源（一次只可能在一个地方写）
function renderPollChips(){
  const d=curPollDraft;
  const html=d?`<div class="pollChip"><span class="pollChipHead">${ICO_POLL}<b>${esc(d.question)}</b>`+
    `<span class="tag mute">${d.multi?'多选':'单选'}</span></span>`+
    `<span class="muted">${(d.options||[]).length} 个选项 · 每人一票</span>`+
    `<span class="chipActs"><button class="mini" type="button" onclick="openPollDialog()">编辑</button>`+
    `<button class="mini danger" type="button" onclick="clearPollDraft()">移除</button></span></div>`:'';
  const a=$('#postPollChip'); if(a) a.innerHTML=html;
  const b=$('#replyPollChip'); if(b) b.innerHTML=html;
  const pb=$('#postPollBtn'); if(pb&&pb.classList) pb.classList.toggle('hidden',!!d);
  const rb=$('#replyPollBtn'); if(rb&&rb.classList) rb.classList.toggle('hidden',!!d);
}
window.clearPollDraft=()=>{ curPollDraft=null; renderPollChips() };

// 投票：只把这一张卡换掉，别整屏重画（滚动位置会丢）
window.votePoll=async(pid,oid)=>{ await doVote(pid,[oid]) };
window.togglePollPick=(pid,oid,btn)=>{
  const set=pollPicksOf(pid);
  if(set.has(oid)) set.delete(oid); else set.add(oid);
  if(btn&&btn.classList) btn.classList.toggle('on',set.has(oid));
  if(btn&&btn.setAttribute) btn.setAttribute('aria-pressed',set.has(oid)?'true':'false');
};
window.submitPoll=async pid=>{
  const set=pollPicksOf(pid);
  if(!set.size){ toast('先选一个选项吧'); return }
  await doVote(pid,[...set]);
};
async function doVote(pid,picks){
  if(!me){ needLogin('投票'); return }
  try{
    const d=await api('/poll/vote',{method:'POST',body:JSON.stringify({poll:pid,options:picks})});
    pollPicks.delete(pid);
    toast('投票成功，谢谢你的一票 ✨');
    if(d&&d.poll){
      const el=(document.getElementById&&document.getElementById('pollCard-'+pid))||null;
      if(el&&el.outerHTML!=null){ el.outerHTML=pollCardHtml(d.poll); return }
    }
    if(curThreadId) openThread(curThreadId);
  }catch(x){
    const msg=String(x.message||'');
    toast(msg);
    // 「已经投过」/「内容已经不在」说明本地这屏是旧的，重取一次把状态对齐
    if(curThreadId && /已经投过|已经不在|不存在/.test(msg)) openThread(curThreadId);
  }
}

// 移除已挂上的投票。已经有人投过票之后后端会挡回来（防止悄悄作废别人的票）。
window.removePoll=async(type,id,back)=>{
  if(!confirm('移除这个投票？已经投过的票也会一起消失。')) return;
  try{
    await api('/poll/remove',{method:'POST',body:JSON.stringify({target:type,id})});
    toast('投票已移除');
    openThread(back||id);
  }catch(x){ toast(x.message) }
};

/* ---- 编辑：主题与回复 ---- */
window.editThread=async id=>{
  const d=await api('/threads/'+id);
  $('#editTitle').value=d.thread.title; $('#editBody').value=d.thread.body;
  if($('#editSensitive')) $('#editSensitive').checked=!!(d.thread.sensitive);
  $('#editTitleWrap').classList.remove('hidden');
  editTarget={type:'thread',id};
  $('#editDialog').showModal();
};
window.editPost=async (pid,tid)=>{
  const d=await api('/threads/'+tid);
  const p=(d.posts||[]).find(x=>x.id===pid); if(!p) return;
  $('#editTitle').value=''; $('#editBody').value=p.body;
  if($('#editSensitive')) $('#editSensitive').checked=!!(p.sensitive);
  $('#editTitleWrap').classList.add('hidden');
  editTarget={type:'post',id:pid,threadId:tid};
  $('#editDialog').showModal();
};
let editTarget=null;
window.submitEdit=async()=>{
  if(!editTarget) return;
  const body=$('#editBody').value;
  // sensitive 一起提交：作者发完才想起「这段是剧透」时不用删帖重发
  const sensitive=$('#editSensitive')?.checked?1:0;
  try{
    if(editTarget.type==='thread'){
      await api('/threads/'+editTarget.id,{method:'PATCH',body:JSON.stringify({title:$('#editTitle').value,body,sensitive})});
    }else{
      await api('/posts/'+editTarget.id,{method:'PATCH',body:JSON.stringify({body,sensitive})});
    }
    $('#editDialog').close(); toast('已保存修改');
    if(editTarget.type==='thread') openThread(editTarget.id); else openThread(editTarget.threadId);
  }catch(x){toast(x.message)}
};

/* ---- 用户主页 ----
   顶部是本人资料，下面两块：他发的主题、他跟过的帖。
   搜索框只在他自己的内容里搜，翻旧帖不用回首页大海捞针。 */
function userThreadList(d, q){
  const arr=d.threads||[];
  if(!arr.length) return `<p class="muted">${q?`没有找到和「${esc(q)}」有关的主题。`:'还没有发过主题。'}</p>`;
  return arr.map(x=>`<div class="row"><span class="linkName" onclick="openThread(${x.id})">${x.pinned?'📌 ':''}${esc(x.title)}</span><span class="muted">${x.board_name?esc(x.board_name)+' · ':''}${time(x.created_at)}</span></div>`).join('');
}
function userPostList(d, q){
  const arr=d.posts||[];
  if(!arr.length) return `<p class="muted">${q?`没有找到和「${esc(q)}」有关的回复。`:'还没有回复过。'}</p>`;
  return arr.map(x=>`<div class="row"><span><span class="muted">回复在「</span><span class="linkName" onclick="openThread(${x.thread_id})">${esc(x.thread_title)}</span><span class="muted">」</span>：${esc(MD.plain(x.body).slice(0,60))}</span><span class="muted">${time(x.created_at)}</span></div>`).join('');
}

window.openUser=async (uid,q)=>{
  setView('user');
  try{
    curUserQ=String(q||'');
    const d=await api('/users/'+uid+(curUserQ?'?q='+encodeURIComponent(curUserQ):''));
    const u=d.user;
    const roleTag=u.role==='admin'?' · 管理员':(u.role==='moderator'?' · 子管理员':'');
    // 胁迫模式：账号被停用，但内容一条没少 —— 主页上要把这件事说明白，
    // 免得别人以为这人被删号了、东西都没了。
    const duressBanner=u.duress_state?`<div class="shieldBanner">
      <b>该账号已进入保护状态</b>
      <span>TA 已输入保护密码（或由站主手动启动），账号暂时停用。所有内容都完整保留、一条未删，
      需要站主手动恢复之后才能继续使用。</span>
      ${u.duress_at?`<small class="muted">触发时间：${time(u.duress_at)}</small>`:''}
    </div>`:'';
    app.innerHTML=`<div class="view anim-in">
      <span class="back" onclick="list()">← 返回主题列表</span>
      <div class="profile">
        ${avatarHtml(u,'avaBig')}
        <div class="profileInfo">
          <h2>${esc(u.username)}<small>${roleTag}${u.banned?' · 已封禁':''}${u.duress_state?' · 保护中':''}</small></h2>
          <p class="muted">${esc(u.bio||'这个人还没写签名档 ✨')}</p>
          <p class="muted">加入于 ${time(u.created_at)} · ${d.stats.threads} 个主题 · ${d.stats.replies} 条回复 · 收到 ${Number(d.stats.likes||0)} 个赞</p>
        </div>
      </div>
      ${duressBanner}
      <form class="searchRow" onsubmit="event.preventDefault();doUserSearch(${uid})">
        <input id="userSearchInput" type="search" maxlength="60" placeholder="在 ${esc(u.username)} 发过的帖子里搜索…" value="${esc(curUserQ)}" oninput="onUserSearchType(${uid})">
        <button class="mini primary" type="submit">搜索</button>
        ${curUserQ?`<button class="mini" type="button" onclick="clearUserSearch(${uid})">清除</button>`:''}
      </form>
      <div class="adminCard"><h3>${curUserQ?'匹配的主题':'最近主题'}</h3><div id="userThreads">${userThreadList(d,curUserQ)}</div></div>
      <div class="adminCard"><h3>${curUserQ?'匹配的回复':'最近回复'}</h3><div id="userPosts">${userPostList(d,curUserQ)}</div></div>
    </div>`;
    window.scrollTo({top:0,behavior:'smooth'});
  }catch(x){ toast(x.message) }
};

let curUserQ='', userSearchTimer=0;
window.onUserSearchType=(uid)=>{ clearTimeout(userSearchTimer); userSearchTimer=setTimeout(()=>doUserSearch(uid),400) };
// 只重画两块列表，不重画整个视图 —— 否则输入到一半输入框会被 innerHTML 冲掉、光标丢失
window.doUserSearch=async uid=>{
  const box=$('#userSearchInput');
  const v=String(box?.value||'').trim().slice(0,60);
  if(v===curUserQ) return;
  curUserQ=v;
  try{
    const d=await api('/users/'+uid+(v?'?q='+encodeURIComponent(v):''));
    $('#userThreads').innerHTML=userThreadList(d,v);
    $('#userPosts').innerHTML=userPostList(d,v);
  }catch(x){ toast(x.message) }
};
window.clearUserSearch=async uid=>{ await openUser(uid,'') };

// 编辑记录：作者本人和管理员可看，其他人点了会拿到 403
window.showEdits=async(type,id)=>{
  try{
    const d=await api(`/${type==='thread'?'threads':'posts'}/${id}/edits`);
    const rows=(d.edits||[]).map(e=>`<div class="editRow"><div class="muted">${esc(e.username||'已注销用户')} · ${time(e.created_at)}</div><div class="editDiff"><div class="editBefore">− ${esc(MD.plain(e.before_body).slice(0,300))}</div><div class="editAfter">＋ ${esc(MD.plain(e.after_body).slice(0,300))}</div></div></div>`).join('');
    $('#editLogBody').innerHTML=rows||'<p class="muted">没有编辑记录。</p>';
    $('#editLogDialog').showModal();
  }catch(x){toast(x.message)}
};

window.moveThread=async id=>{
  const boardId=$('#moveBoard')?.value||'';
  try{
    // 这里刻意不走 window.mod()：那个 helper 成功后会顺手打开管理中心，
    // 从帖子详情里挪板块时并不想跳走。
    await api('/admin/moderate',{method:'POST',body:JSON.stringify({type:'moveThread',id,boardId})});
    toast(boardId?'已移动到该板块':'已移出板块（未分类）');
    await loadBoards();
    openThread(id);
  }catch(x){toast(x.message)}
};

window.delThread=async id=>{
  if(!confirm('确定删除这个主题吗？\n\n它会先移入回收站（主题下的回复一并收走），随时可以恢复。'))return;
  try{
    const d=await api('/threads/'+id,{method:'DELETE'});
    toast('主题已移入回收站', undoDelete(d?.trashId,'主题'));
    list();
  }catch(x){toast(x.message)}
};
window.delPost=async(pid,tid)=>{
  if(!confirm('确定删除这条回复吗？\n\n它会先移入回收站，随时可以恢复。'))return;
  try{
    const d=await api('/posts/'+pid,{method:'DELETE'});
    toast('回复已移入回收站', undoDelete(d?.trashId,'回复'));
    openThread(tid);
  }catch(x){toast(x.message)}
};

/* ---- 登录 / 注册 / 2FA 登录 ---- */
$('#loginBtn').onclick=()=>{mode='login';$('#authTitle').textContent='登录';$('#authPass').minLength=1;$('#switchAuth').innerHTML='没有账号？<a href="#">注册</a>';$('#authDialog').showModal()};
$('#switchAuth').onclick=e=>{e.preventDefault();mode=mode==='login'?'register':'login';$('#authTitle').textContent=mode==='login'?'登录':'注册';$('#switchAuth').innerHTML=mode==='login'?'没有账号？<a href="#">注册</a>':'已有账号？<a href="#">登录</a>'};

$('#authForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    const p={username:$('#authUser').value,password:$('#authPass').value};
    const d=await api(mode==='login'?'/login':'/register',{method:'POST',body:JSON.stringify(p)});
    if(mode==='register'){toast('注册成功，请登录');mode='login';$('#authTitle').textContent='登录';$('#switchAuth').innerHTML='没有账号？<a href="#">注册</a>';$('#authPass').value='';return}
    // 胁迫密码：**不是登录成功** —— 后端一个会话都没下发。
    // 这里只负责把「账号已进入保护状态」这件事说清楚。
    if(d.duress){
      me=null; pending2fa=null;
      $('#authDialog').close(); $('#authPass').value='';
      updateNav(); list();
      $('#duressNotice')?.showModal?.();
      return;
    }
    if(d.need2fa){
      pending2fa=d.pending;$('#authDialog').close();$('#tfaLoginCode').value='';$('#tfaLoginDialog').showModal();return;
    }
    me=d.user;$('#authDialog').close();updateNav();toast('欢迎回来，'+me.username);list();
  }catch(x){toast(x.message)}
};

$('#tfaLoginForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    const d=await api('/2fa/verify',{method:'POST',body:JSON.stringify({pending:pending2fa,code:$('#tfaLoginCode').value})});
    me=d.user;pending2fa=null;$('#tfaLoginDialog').close();updateNav();toast('欢迎回来，'+me.username);list();
  }catch(x){toast(x.message)}
};

$('#logoutBtn').onclick=async()=>{closeUserMenu();await api('/logout',{method:'POST'});me=null;updateNav();list();toast('已退出')};
$('#profileBtn').onclick=()=>window.goProfile();
// 回收站入口：菜单项是静态 HTML，绑定必须写在这里 ——
// 少了这一行，按钮看得见、点了没反应（曾经真的漏过）。
$('#trashBtn').onclick=()=>window.openTrash();
// 回收站入口：菜单项是静态 HTML，绑定必须写在这里 ——
// 少了这一行，按钮看得见、点了没反应（曾经真的漏过）。

// 把板块列表填进发帖/移动用的下拉框，并选中指定的那一项
function fillBoardSelect(sel, selected){
  const el=$(sel); if(!el) return;
  el.innerHTML=`<option value="">未分类</option>`+boards.list.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('');
  el.value=selected&&[...el.options].some(o=>o.value===String(selected))?String(selected):'';
}

$('#newBtn').onclick=async()=>{
  // 附件入口统一在 Markdown 工具栏里（上传关掉时那个按钮根本不渲染），
  // 所以这里不用再单独控制某个「＋ 图片」按钮的显隐。
  await loadBoards();
  // 正停在某个板块里发帖时，默认就选它，省得每次再挑一遍
  fillBoardSelect('#postBoard', curBoard!=='all'&&curBoard!=='none'?curBoard:'');
  if(!$('#postTitle').value && !$('#postBody').value){
    const saved=draftGet('thread');           // 上次没发完的稿子，接着写
    if(saved){ try{ const o=JSON.parse(saved); $('#postTitle').value=o.t||''; $('#postBody').value=o.b||'' }catch(e){} }
  }
  $('#postDraftTip').textContent=$('#postBody').value?'已恢复上次未发送的草稿':'';
  // 发帖框是一次全新的写作：把上一帖回复框里可能留下的投票草稿清掉，
  // 免得它跟到新帖里（两个编辑器共用一份草稿，但一次只该有一个在用）。
  curPollDraft=null; renderPollChips();
  $('#postDialog').showModal();
};
// 输入即存草稿（发帖框内容少，直接存，不做防抖）
['#postTitle','#postBody'].forEach(sel=>{
  $(sel)?.addEventListener('input',()=>{ draftSet('thread',JSON.stringify({t:$('#postTitle').value,b:$('#postBody').value})) });
});

$('#postForm').onsubmit=async e=>{e.preventDefault();try{await api('/threads',{method:'POST',body:JSON.stringify({title:$('#postTitle').value,body:$('#postBody').value,boardId:$('#postBoard').value||'',sensitive:$('#postSensitive')?.checked?1:0,poll:curPollDraft||null})});$('#postDialog').close();$('#postForm').reset();draftClear('thread');$('#postDraftTip').textContent='';curPollDraft=null;renderPollChips();toast('发布成功');curPage=1;list()}catch(x){toast(x.message)}};

$('#boardForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    const d=await api('/boards',{method:'POST',body:JSON.stringify({name:$('#boardName').value,description:$('#boardDesc').value})});
    $('#boardDialog').close();$('#boardForm').reset();
    await loadBoards();
    curBoard=String(d.id);          // 建完直接跳进新板块，省一次点击
    curPage=1;
    toast('板块已创建');
    list();
  }catch(x){toast(x.message)}
};
$('#setupForm').onsubmit=async e=>{e.preventDefault();try{await api('/setup',{method:'POST',body:JSON.stringify({username:$('#setupUser').value,password:$('#setupPass').value})});$('#setupDialog').close();toast('管理员已创建，请登录');$('#loginBtn').click()}catch(x){toast(x.message)}};

/* ---- 账户设置 ---- */
$('#settingsBtn').onclick=()=>{
  const on=!!me?.totp_enabled;
  fillAppearance();                 // 配色 / 深浅选择器每次都重建，保证选中态是最新的
  $('#tfaState').textContent=on?'已开启 · 登录时需要额外输入认证器验证码':'未开启 · 建议开启，可显著提升账号安全性';
  $('#tfaOnBtn').classList.toggle('hidden',on);
  $('#tfaOffForm').classList.toggle('hidden',!on);
  $('#renameCodeWrap').classList.toggle('hidden',!on);
  $('#repassCodeWrap').classList.toggle('hidden',!on);
  $('#delCodeWrap').classList.toggle('hidden',!on);
  $('#duressCodeWrap')?.classList.toggle('hidden',!on);
  fillDuressCard();
  // 管理员不允许注销自己（后端也会拦）。这里保留「注销账号」卡片本身，
  // 只把表单收起来、把说明文字换成明确提示，让管理员一眼知道为什么不能注销，
  // 而不是整块消失得莫名其妙。同时给卡片挂 is-locked —— 禁用态换成中性灰蓝，
  // 免得一个点不动的按钮还顶着满屏红色喊「危险」。
  const isAdminSelf=!!me?.can_admin;
  $('#delForm').classList.toggle('hidden',isAdminSelf);
  $('#delZone')?.classList.toggle('is-locked',isAdminSelf);
  $('#delNotice').textContent=isAdminSelf
    ? '管理员不允许注销账户'
    : '账号会立即停用，全部主题与回复移入回收站。站主可以恢复它们，你自己不行 —— 请确认这是你要的。';
  ['renameForm','repassForm','delForm','tfaOffForm','duressForm'].forEach(f=>$('#'+f).reset());
  // 「不易展示」那颗开关每次开设置都要跟着账号里的值走：
  // 换设备登录时本地没有缓存，写死成 on / off 都会和实际生效的相反。
  if($('#sensitiveFilter')) $('#sensitiveFilter').checked=sensitiveOn();
  fillProfileCard();
  $('#settingsDialog').showModal();
};

/* ---- 个人资料：头像 + 签名档 ---- */
const AVATAR_EMOJIS=['🐱','🐶','🦊','🐼','🐧','🦉','🐳','🦋','🌸','🍀','🌙','⭐','🎧','☕','🎮','📷'];
function fillProfileCard(){
  if(!$('#profileForm')) return;
  draftAvatar=null;                  // 每次打开都是干净的初始状态
  $('#bioInput').value=me?.bio||'';
  const cur=String(me?.avatar||'');
  $('#avaPreview').innerHTML=avatarHtml(me,'avaBig');
  $('#avaPicker').innerHTML=AVATAR_EMOJIS.map(e=>
    `<button type="button" class="avaPick${cur==='emoji:'+e?' on':''}" onclick="pickAvatar('emoji:${e}')">${e}</button>`).join('');
  // 「清除」只在当前确实有自定义头像时才需要出现
  $('#avaClearWrap').classList.toggle('hidden',!cur);
  const msg=$('#avaMsg'); if(msg){ msg.textContent=''; msg.classList.add('hidden') }
}
window.pickAvatar=v=>{
  draftAvatar=v;
  $('#avaPreview').innerHTML=avatarHtml({username:me?.username,avatar:v},'avaBig');
  paintAvaPick();
};
// 高亮当前选中的 emoji：改头像 / 清除头像后都要刷一次，
// 否则「选了 emoji 又点清除」会留下一个还在高亮的选项，看着像没生效。
function paintAvaPick(){
  if(!document.querySelectorAll) return;
  const cur=String(draftAvatar!=null?draftAvatar:(me?.avatar||''));
  document.querySelectorAll('#avaPicker .avaPick').forEach(b=>b.classList.toggle('on',cur==='emoji:'+b.textContent));
}
let draftAvatar=null;
// 上传头像：和普通附件走同一个接口，只多一个 ?kind=avatar（存进独立的 avatars/ 目录）。
// 关键：**必须像 doUpload 那样把 File 当请求体裸发出去**。
// 之前用 FormData 是错的 —— 后端直接把整个请求体当文件内容读，
// multipart 的封装头会让魔法字节判定失败，于是每张图都被判成「不支持的文件类型」。
// 头像是「上传中 / 已上传 / 出错」的状态行；没话可说时就整行收起来
// （原来那里常年挂着一句「头像单独存放在 avatars/ 目录，最大 2 MB」，纯噪音）
function avaMsg(text){
  const el=$('#avaMsg'); if(!el) return;
  el.textContent=text||'';
  el.classList.toggle('hidden',!text);
}
window.uploadAvatar=async()=>{
  const f=$('#avaFile')?.files?.[0]; if(!f) return;
  if(!uploadOn){ toast('站点还没开启附件存储，暂时不能上传头像'); return }
  if(maxAvatarMb>0 && f.size>maxAvatarMb*1024*1024){
    toast(`头像不能超过 ${maxAvatarMb} MB，这张约 ${Math.ceil(f.size/1024/1024)} MB`);
    $('#avaFile').value='';
    return;
  }
  try{
    avaMsg('上传中…');
    const size=await probeImageSize(f);
    const d=await uploadOne(f, p=>avaMsg('上传中 '+Math.round(p*100)+'%'), size, 'avatar');
    if(!d.id) throw Error('上传返回异常，请重试');
    draftAvatar='att:'+d.id;
    $('#avaPreview').innerHTML=avatarHtml({username:me?.username,avatar:draftAvatar},'avaBig');
    paintAvaPick();
    avaMsg('已上传，点「保存资料」才会生效');
    toast('头像已上传，记得点保存');
  }catch(x){ avaMsg(''); toast(x.message) }
};
window.clearAvatar=()=>{ draftAvatar=''; $('#avaPreview').innerHTML=avatarHtml({username:me?.username,avatar:''},'avaBig'); paintAvaPick() };

$('#profileForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    const body={bio:$('#bioInput').value};
    if(draftAvatar!=null) body.avatar=draftAvatar;
    const d=await api('/account/profile',{method:'POST',body:JSON.stringify(body)});
    me=d.user||me; draftAvatar=null;
    toast('资料已保存'); list();
  }catch(x){toast(x.message)}
};

$('#renameForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    const body={username:$('#renameUser').value,password:$('#renamePass').value};
    if(me.totp_enabled) body.code=$('#renameCode').value;
    const d=await api('/account/username',{method:'POST',body:JSON.stringify(body)});
    me=d.user||{...me,username:$('#renameUser').value};
    $('#settingsDialog').close();updateNav();toast('用户名已更新');list();
  }catch(x){toast(x.message)}
};

$('#repassForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    const body={password:$('#repassOld').value,newPassword:$('#repassNew').value};
    if(me.totp_enabled) body.code=$('#repassCode').value;
    await api('/account/password',{method:'POST',body:JSON.stringify(body)});
    $('#settingsDialog').close();toast('密码已更新，其它设备已退出登录');
  }catch(x){toast(x.message)}
};

$('#delForm').onsubmit=async e=>{
  e.preventDefault();
  if(!confirm('最后确认：你的账号会立即停用，全部主题与回复移入回收站。\n\n站主可以恢复，你自己不行。确定继续吗？'))return;
  try{
    const body={password:$('#delPass').value,confirm:$('#delConfirm').value};
    if(me.totp_enabled) body.code=$('#delCode').value;
    await api('/account/delete',{method:'POST',body:JSON.stringify(body)});
    me=null;pending2fa=null;$('#settingsDialog').close();updateNav();toast('账号已注销');list();
  }catch(x){toast(x.message)}
};

/* ---- 两步验证绑定 / 关闭 ---- */
// 二维码库已本地化为 /vendor/qrcode.min.js（不再走第三方 CDN，
// 避免广告拦截器按域名把跨站脚本请求判成「追踪器」而误拦）。
// 仍然保留降级：库没加载成功时只显示密钥，用户可在认证器里手动输入。
const qrReady=()=>typeof window.QRCode==='function';

$('#tfaOnBtn').onclick=async()=>{
  try{
    const d=await api('/2fa/setup',{method:'POST'});
    $('#tfaSecret').textContent=d.secret;
    const qrWrap=$('#qr').parentElement;
    $('#qr').innerHTML='';
    let ok=false;
    if(qrReady()){
      try{new QRCode($('#qr'),{text:d.uri,width:180,height:180,correctLevel:QRCode.CorrectLevel.M});ok=true}catch(err){ok=false}
    }
    // 二维码不可用时，降级为展示密钥供认证器手动输入
    qrWrap.classList.toggle('hidden',!ok);
    $('#qrFallback').classList.toggle('hidden',ok);
    $('#tfaForm').reset();$('#settingsDialog').close();$('#tfaDialog').showModal();
  }catch(x){toast(x.message)}
};

$('#tfaForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    await api('/2fa/enable',{method:'POST',body:JSON.stringify({secret:$('#tfaSecret').textContent.trim(),code:$('#tfaCode').value,password:$('#tfaPass').value})});
    me.totp_enabled=1;$('#tfaDialog').close();toast('两步验证已开启');
  }catch(x){toast(x.message)}
};

$('#tfaOffForm').onsubmit=async e=>{
  e.preventDefault();
  try{
    await api('/2fa/disable',{method:'POST',body:JSON.stringify({password:$('#tfaOffPass').value,code:$('#tfaOffCode').value})});
    me.totp_enabled=0;$('#settingsDialog').close();toast('两步验证已关闭');
  }catch(x){toast(x.message)}
};

$('#copySecret').onclick=async()=>{
  const s=$('#tfaSecret').textContent.trim();
  try{await navigator.clipboard.writeText(s);toast('密钥已复制')}catch(e){toast('复制失败，请手动选择复制')}
};

/* ---- 管理端 ---- */
const ROLE_LABEL={user:'普通用户',moderator:'子管理员',admin:'管理员'};
const canMod=()=>!!me?.can_mod;
const canAdmin=()=>!!me?.can_admin;

/* 管理中心「用户」卡片 —— 抽成函数是为了搜索框只重画列表。
   整页重画会把刚敲进搜索框的内容和光标一起冲掉。 */
let adminUsers=[];
// animate：只有首次渲染才做入场动画。搜索框每敲一个字都重画一次列表，
// 那时候再逐个飞进来就成了闪烁，反而更难用。
function adminUserRows(list, animate){
  if(!list||!list.length) return '<p class="muted">没有匹配的用户。</p>';
  return list.map((u,i)=>{
    const isMe=me && me.id===u.id;
    const isAdmin=u.role==='admin';
    const btns=[];
    if(!isAdmin){
      if(u.role==='moderator') btns.push(`<button class="mini" onclick="adminSetRole(${u.id},'user')">撤销子管理员</button>`);
      else btns.push(`<button class="mini" onclick="adminSetRole(${u.id},'moderator')">设为子管理员</button>`);
    }
    if(u.totp_enabled && !isAdmin) btns.push(`<button class="mini" onclick="adminDisable2fa(${u.id})">关闭2FA</button>`);
    // 胁迫模式：站主能手动启动 / 解除。管理员账号不能进（不然就没人能开门了）
    if(!isAdmin && !isMe){
      if(u.duress_state) btns.push(`<button class="mini" onclick="adminDuress(${u.id},0)">解除保护</button>`);
      else btns.push(`<button class="mini" onclick="adminDuress(${u.id},1)">启动保护</button>`);
    }
    if(!isMe && !isAdmin){
      btns.push(`<button class="mini" onclick="adminSetPassword(${u.id})">改密</button>`);
      btns.push(`<button class="mini" onclick="mod('moderate',{type:'${u.banned?'unban':'ban'}',id:${u.id}})">${u.banned?'解封':'封禁'}</button>`);
      btns.push(`<button class="mini danger" onclick="adminDeleteUser(${u.id})">删号</button>`);
    }
    const tags=[
      `<span class="tag${isAdmin?'':' mute'}">${ROLE_LABEL[u.role]||u.role}</span>`,
      u.banned?'<span class="tag warn">已封禁</span>':'',
      u.duress_state?'<span class="tag warn">保护中</span>':'',
      u.duress_set?'<span class="tag mute">有保护密码</span>':'',
      u.totp_enabled?'<span class="tag mute">2FA</span>':'',
      isMe?'<span class="tag mute">我自己</span>':''
    ].filter(Boolean).join('');
    const stag=animate?` class="row anim-in" style="animation-delay:${Math.min(i*35,280)}ms"`:' class="row"';
    return `<div${stag}>
      <span class="rowMain">
        <span class="avaLink" onclick="openUser(${u.id})">${avatarHtml(u,'ava')}</span>
        <span class="uName"><b class="linkName" onclick="openUser(${u.id})">${esc(u.username)}</b><span class="uTags">${tags}</span></span>
      </span>
      <span class="rowActions">${btns.join('')}</span>
    </div>`;
  }).join('');
}
// 只要接口一次拉回来的这些（上限 200 条），本地过滤就够快，不必再来一次请求
window.filterAdminUsers=()=>{
  const el=document.querySelector('#adminUserSearch');
  const q=String(el?.value||'').trim().toLowerCase();
  const hit=q?adminUsers.filter(u=>{
    const role=ROLE_LABEL[u.role]||u.role;
    const state=u.banned?'已封禁 封禁':'正常';
    return String(u.username||'').toLowerCase().includes(q)||role.includes(q)||state.includes(q);
  }):adminUsers;
  const box=document.querySelector('#adminUserList');
  if(box) box.innerHTML=adminUserRows(hit);
  const n=document.querySelector('#adminUserCount');
  if(n) n.textContent=q?`匹配 ${hit.length} / ${adminUsers.length}`:'';
};
window.clearAdminUserSearch=()=>{
  const el=document.querySelector('#adminUserSearch');
  if(el) el.value='';
  window.filterAdminUsers();
};

$('#adminBtn').onclick=async()=>{
  setView('admin');
  try{
    // 子管理员只能拿到治理相关数据；管理员列表/内容总表是管理员专属接口
    // 主题列表接口返回的是 {items,total,...}，管理中心要的是裸数组，别直接拿去 .map
    const jobs=[canAdmin()?api('/admin/users'):Promise.resolve(null),canAdmin()?api('/admin/posts'):Promise.resolve(null),api('/threads?limit=50')];
    const [users,posts,tl]=await Promise.all(jobs);
    const threads=Array.isArray(tl?.items)?tl.items:[];
    adminCache={users:users||[],posts:posts||[],threads};
    await loadBoards();

    // 用户行：头像 + 用户名 + 角色标签，右边一组操作按钮。
    // 名字与头像都能点进主页 —— 在列表里看到一个人，第一反应就是点他名字，
    // 以前这里点不动，只能回首页翻帖子找人，很别扭。
    // 行渲染抽成 adminUserRows()，是为了让搜索框能只重画列表、不重画整页。
    adminUsers=users;
    const userCard=canAdmin()?`<div class="adminCard full">
      <div class="adminHead"><h3>用户</h3><span class="muted" id="adminUserCount"></span></div>
      <div class="searchRow adminSearch">
        <input id="adminUserSearch" type="search" placeholder="搜索用户名、角色或状态…" autocomplete="off" oninput="filterAdminUsers()">
        <button class="mini" type="button" onclick="clearAdminUserSearch()">清除</button>
      </div>
      <p class="adminNote">点头像或用户名可以直接打开 TA 的主页。</p>
      <div id="adminUserList">${adminUserRows(users,true)}</div>
    </div>`:'';

    // 最近内容只有一颗「删除」，半宽和板块管理并排刚好（整行的话右边会空一大块）
    const postsCard=canAdmin()?`<div class="adminCard"><h3>最近内容</h3>
      <p class="adminNote">点标题跳到对应主题。</p>
      ${posts.map(p=>{
        const t=p.thread_id?`<span class="linkName" onclick="openThread(${p.thread_id})">${esc(p.title||'未命名主题')}</span>`:'';
        return `<div class="row"><span class="rowText">${p.sensitive?'<span class="tag warn">不易展示</span>':''}${p.protected?'<span class="tag board shieldTag">已保护</span>':''}${t?t+' · ':''}<span class="muted">${esc(p.username)}：${esc(MD.plain(p.body||'').slice(0,40))}</span></span><span class="rowActions">${canAdmin()?`<button class="mini" onclick="toggleProtect('post',${p.id},'admin')">${p.protected?'取消保护':'保护'}</button>`:''}<button class="mini" onclick="mod('moderate',{type:'sensitive',id:${p.id},target:'post',value:${p.sensitive?0:1}})">${p.sensitive?'取消限制':'设为限制'}</button><button class="mini danger" onclick="mod('moderate',{type:'deletePost',id:${p.id}})">删除</button></span></div>`;
      }).join('')||'<p class="muted">还没有内容。</p>'}</div>`:'';

    // 主题管理也用整行：它的每一行有三颗按钮（置顶/锁定/删帖），
    // 挤在半宽卡片里标题只能折成三行，看着很憋。板块管理 / 最近内容各一颗按钮，半宽正好。
    const threadCard=`<div class="adminCard full"><h3>主题管理</h3>
      <p class="adminNote">点标题打开主题；右侧按钮直接作用于这一条。</p>
      ${threads.map(t=>`<div class="row">
        <span class="rowMain"><span class="rowText">${t.pinned?'<span class="tag">置顶</span>':''}${t.locked?'<span class="tag mute">已锁</span>':''}${t.protected?'<span class="tag board shieldTag">已保护</span>':''}${t.board_name?`<span class="tag board">${esc(t.board_name)}</span>`:''}<span class="linkName" onclick="openThread(${t.id})">${esc(t.title)}</span></span></span>
        <span class="rowActions"><button class="mini" onclick="mod('moderate',{type:'pin',id:${t.id}})">置顶</button><button class="mini" onclick="mod('moderate',{type:'lock',id:${t.id}})">锁定</button><button class="mini" onclick="mod('moderate',{type:'sensitive',id:${t.id},target:'thread',value:${t.sensitive?0:1}})">${t.sensitive?'取消限制':'设为限制'}</button>${canAdmin()?`<button class="mini" onclick="toggleProtect('thread',${t.id},'admin')">${t.protected?'取消保护':'保护'}</button>`:''}<button class="mini danger" onclick="mod('moderate',{type:'deleteThread',id:${t.id}})">删帖</button></span>
      </div>`).join('')||'<p class="muted">还没有主题。</p>'}</div>`;

    // 板块管理只有管理员能删 —— 板块是公共货架，删掉会波及里面所有人的帖子
    const boardCard=canAdmin()?`<div class="adminCard"><h3>板块管理</h3>
      <p class="adminNote">删除板块不会删掉里面的帖子，它们会回到「未分类」。</p>`+
      (boards.list.length?boards.list.map(b=>`<div class="row"><span class="rowText"><span class="linkName" onclick="pickBoard('${b.id}')">${esc(b.name)}</span><span class="muted"> · ${b.threads} 帖${b.description?' · '+esc(b.description):''}${b.creator?' · 由 '+esc(b.creator)+' 创建':''}</span></span><span class="rowActions"><button class="mini danger" onclick="adminDeleteBoard(${b.id})">删除板块</button></span></div>`).join('')
        :'<p class="muted">还没有板块。登录用户在首页可以自己创建。</p>')+`</div>`:'';

    app.innerHTML=`<div class="view adminView anim-in">
      <span class="back" onclick="list()">← 返回</span>
      <h2>管理中心</h2>
      <p class="muted">${canAdmin()?'你是管理员，拥有全部权限。':'你是子管理员，可进行置顶、锁定、删帖、删回复、移动板块等内容治理操作。'}</p>
      ${canAdmin()?'<div class="adminTools"><button class="mini" onclick="openTrash()">回收站</button><button class="mini" onclick="openStore()">附件存储设置</button></div>':''}
      <div class="admin">${userCard}${threadCard}${boardCard}${postsCard}</div></div>`;
  }catch(x){toast(x.message)}
};

window.adminDeleteBoard=async id=>{
  const b=boards.list.find(x=>x.id===id);
  if(!confirm('确定删除板块「'+(b?b.name:'该板块')+'」吗？\n\n里面的 '+(b?b.threads:0)+' 个帖子**不会被删除**，只是回到「未分类」。'))return;
  try{
    const d=await api('/boards/'+id,{method:'DELETE'});
    toast('板块已删除，'+(d.moved||0)+' 个帖子回到未分类');
    if(curBoard===String(id)) curBoard='all';
    await loadBoards();
    $('#adminBtn').click();
  }catch(x){toast(x.message)}
};

window.adminDuress=async(uid,on)=>{
  const u=adminCache.users.find(x=>x.id===uid);
  const name=u?u.username:'该用户';
  const ask=on
    ? `把「${name}」置入保护状态？\n\nTA 的全部内容会完整保留（一条都不删），但账号立刻停用、所有设备下线，\n只有你能手动恢复。`
    : `解除「${name}」的保护状态？\n\nTA 可以重新登录了（保护密码本身会保留，下次还能用）。`;
  if(!confirm(ask))return;
  try{
    await api('/admin/duress',{method:'POST',body:JSON.stringify({id:uid,value:on?1:0})});
    toast(on?'已置入保护状态':'已解除保护状态');
    $('#adminBtn').click();
  }catch(x){toast(x.message)}
};

window.adminSetRole=async(uid,role)=>{
  const u=adminCache.users.find(x=>x.id===uid);
  const label=ROLE_LABEL[role]||role;
  if(!confirm('确定把「'+(u?u.username:'该用户')+'」设为'+label+'吗？\n\n子管理员可以置顶、锁定、删帖、删回复，但不能封禁用户、改密、删号或任命他人。\n设置后该用户需要重新登录。'))return;
  try{await api('/admin/set-role',{method:'POST',body:JSON.stringify({id:uid,role})});toast('已设为'+label);$('#adminBtn').click()}catch(x){toast(x.message)}
};

window.adminDisable2fa=async uid=>{
  const u=adminCache.users.find(x=>x.id===uid);
  if(!confirm('确定关闭「'+(u?u.username:'该用户')+'」的两步验证吗？\n\n该用户之后登录只需密码，安全性会下降。仅在对方丢失了认证器时使用。'))return;
  try{await api('/admin/disable-2fa',{method:'POST',body:JSON.stringify({id:uid})});toast('已关闭该用户的两步验证');$('#adminBtn').click()}catch(x){toast(x.message)}
};

window.adminDeleteUser=async uid=>{
  const u=adminCache.users.find(x=>x.id===uid);
  const name=u?u.username:'该用户';
  // 目标是子管理员时额外提醒一次：对方是有治理权限的人，删错代价更大
  const extra=u&&u.role==='moderator'?'\n\n⚠️ 注意：'+name+' 是子管理员，删除后 TA 的治理权限也会一并消失。':'';
  const typed=prompt('删除「'+name+'」会把它整包移入回收站（账号 + 全部主题与回复），\n之后你仍然可以从回收站把 TA 完整恢复回来（连带内容）。'+extra+'\n\n请输入用户名「'+name+'」以确认：');
  if(typed===null)return;
  if(typed!==name){toast('用户名不匹配，已取消');return}
  try{await api('/admin/delete-user',{method:'POST',body:JSON.stringify({id:uid})});toast('账号已删除');$('#adminBtn').click()}catch(x){toast(x.message)}
};

window.adminSetPassword=async uid=>{
  const u=adminCache.users.find(x=>x.id===uid);
  const np=prompt('为「'+(u?u.username:'该用户')+'」设置新密码（至少 8 位）：');
  if(np===null)return;
  if(np.length<8){toast('新密码至少 8 位');return}
  try{await api('/admin/set-password',{method:'POST',body:JSON.stringify({id:uid,newPassword:np})});toast('密码已重置，该用户需重新登录');$('#adminBtn').click()}catch(x){toast(x.message)}
};

window.mod=async(action,body)=>{
  try{
    const d=await api('/admin/'+action,{method:'POST',body:JSON.stringify(body)});
    // 删除已经从「一删就没」变成「先进回收站」：顺手给一颗撤销，
    // 在管理中心误点删帖时不用再跑去回收站翻。
    if(d&&d.trashed&&d.trashId) toast('已移入回收站', undoDelete(d.trashId,'内容'));
    else toast('操作完成');
    $('#adminBtn').click();
  }catch(x){toast(x.message)}
};

/* ---- 附件上传 ---- */
// 传完后把 [img:id] 直接写进文本域，发帖与回复共用这一套。
//
// 注意函数名：这里**不能**叫 uploadInto。
// 浏览器里普通脚本的顶层函数声明本身就会成为 window 的同名属性，
// 若再写 `window.uploadInto = …` 去包装它，等于把那个标识符替换成包装函数，
// 而包装函数内部又引用 uploadInto —— 自己调自己，直接爆栈。
// 所以内部实现叫 doUpload，对外只暴露带选择器参数的 uploadInto。

// 用 XHR 而不是 fetch：fetch 至今没有上传进度事件，
// 只有 XMLHttpRequest 的 upload.onprogress 拿得到已发送字节数。
let curXhr=null;                                   // 当前正在传的那个，供「取消上传」用
window.cancelUpload=()=>{ try{ curXhr?.abort() }catch(e){} };
function uploadOne(file, onProgress, size, kind){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    curXhr=xhr;
    // 一定要有超时。没有它，遇上网络卡住或请求根本没到 Worker 的情况，
    // 客户端会永远等下去 —— 用户看到的就是「进度条走到头然后一直卡着」。
    // 240 秒是配合服务端的：单次写入上限 60 秒、最多重试 3 次。
    xhr.timeout=240000;
    xhr.open('POST','/api/upload'+(kind==='avatar'?'?kind=avatar':''));
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    if(size?.w) xhr.setRequestHeader('X-Image-W', String(size.w));
    if(size?.h) xhr.setRequestHeader('X-Image-H', String(size.h));
    xhr.upload.onprogress=e=>{ if(e.lengthComputable) onProgress(e.loaded/e.total) };
    xhr.onload=()=>{
      curXhr=null;
      let d={};
      try{ d=JSON.parse(xhr.responseText||'{}') }catch(e){}
      if(xhr.status>=200&&xhr.status<300) resolve(d);
      else reject(Error(d.error||('上传失败（HTTP '+xhr.status+'）')));
    };
    xhr.onerror=()=>{ curXhr=null; reject(Error('网络错误，上传中断。文件太大或网络不稳时都可能这样')) };
    xhr.ontimeout=()=>{ curXhr=null; reject(Error('上传超时（超过 3 分钟），请重试或换个更小的文件')) };
    xhr.onabort=()=>{ curXhr=null; reject(Error('已取消上传')) };
    xhr.send(file);                                  // 直接甩 File，body 就是文件本体
  });
}

// 上传前先量一下图片尺寸。不为压缩、不为校验，只为让后端记下来，
// 渲染时能提前占位，消除「图加载完页面跳一下」。
async function probeImageSize(file){
  if(!/^image\//.test(file.type||'')) return null;
  try{
    const bmp=await createImageBitmap(file);
    const r={w:bmp.width,h:bmp.height};
    bmp.close?.();
    return r;
  }catch(e){ return null }                           // 量不到就算了，不阻断上传
}

async function doUpload(fileInput,targetSel){
  const files=[...(fileInput?.files||[])];
  if(!files.length)return;
  const ta=document.querySelector(targetSel);
  if(!ta)return;
  if(!uploadOn){ toast('站点还没开启附件存储，暂时不能上传'); return }

  // 进度条 / 文案 / 取消按钮都挂在 file input 的父节点下面（发帖弹窗、回复框各一份）。
  // 只给一根光秃秃的细线是不够的：多文件时用户既不知道在传第几张，
  // 也不知道「字节已经发完、正在等服务端保存」—— 那一段最容易看着像卡死。
  const holder=fileInput.parentElement;
  const box=holder?.querySelector?.('.progress');
  const bar=holder?.querySelector?.('.progress i');
  const row=holder?.querySelector?.('.upRow');
  const tip=holder?.querySelector?.('.upTip');
  const total=files.length;

  // 选完文件先按大小筛一遍：超限的直接说清楚，别让用户把几十 MB 发上去再被拒。
  // 最要命的是超过平台请求体上限的文件 —— 请求连 Worker 都到不了，
  // Worker 没被调用就没有任何响应可回，客户端只会一直等。
  if(maxUploadMb>0){
    const over=files.find(f=>f.size>maxUploadMb*1024*1024);
    if(over){
      toast(`「${over.name}」约 ${Math.ceil(over.size/1024/1024)} MB，超过 ${maxUploadMb} MB 的上限`);
      fileInput.value='';
      return;
    }
  }

  const show=(p,idx)=>{
    const on=p!=null;
    if(box) box.classList.toggle('hidden',!on);
    if(row) row.classList.toggle('hidden',!on);
    if(bar) bar.style.width=on?Math.round(p*100)+'%':'0%';
    if(tip&&on){
      // 字节发完之后是服务端在写网盘，这一步没有任何进度事件，
      // 文案必须换一换，否则看着就是卡住了。
      tip.textContent = p>=1
        ? `正在保存到存储…（${idx}/${total}）`
        : `正在上传 ${idx}/${total} · ${Math.round(p*100)}%`;
    }
  };

  let ok=0, fail=0;
  for(let i=0;i<files.length;i++){
    try{
      show(0,i+1);
      const size=await probeImageSize(files[i]);
      const d=await uploadOne(files[i],p=>show(p,i+1),size);
      if(!d.id) throw Error('上传返回异常，请重试');
      ta.value=(ta.value?ta.value.replace(/\s*$/,'')+'\n':'')+`[img:${d.id}]`;
      // 手动派发 input：草稿是监听 input 存的，不派发的话刚插进去的附件不会被存下来
      try{ ta.dispatchEvent(new Event('input',{bubbles:true})) }catch(e){}
      ok++;
    }catch(e){ fail++; toast(e.message) }
  }
  show(null);
  if(ok) toast(fail?`已插入 ${ok} 个附件，${fail} 个失败`:`已插入 ${ok} 个附件`);
  fileInput.value='';                                // 允许再次选择同一文件
}
window.uploadInto=(inputSel,targetSel)=>doUpload(document.querySelector(inputSel),targetSel);

/* ---- 附件存储（站主）---- */
let storeState=null, storeLimit=null;

window.openStore=async()=>{
  try{
    const [s,l]=await Promise.all([api('/admin/storage'),api('/admin/upload-limit').catch(()=>null)]);
    storeState=s; storeLimit=l;
    renderStore();
    $('#storeDialog').showModal();
  }catch(x){toast(x.message)}
};

// 上传上限：0 = 不限制（实际也就到平台的墙）。两个框都支持直接清空 / 填 0。
window.saveUploadLimit=async()=>{
  const um=Number($('#limitUpload').value), am=Number($('#limitAvatar').value);
  if(!Number.isFinite(um)||!Number.isFinite(am)||um<0||am<0){ toast('上限必须是非负整数，0 表示不限制'); return }
  try{
    const d=await api('/admin/upload-limit',{method:'POST',body:JSON.stringify({uploadMb:um,avatarMb:am})});
    storeLimit={...storeLimit,uploadMb:d.uploadMb,avatarMb:d.avatarMb,platformMaxMb:d.platformMaxMb};
    // 全局那两个值只在 init() 读过一次（doUpload / 头像上传都看它们）。
    // 不同步的话：站主刚把上限从 85 改成 100，**当前这个标签页**仍然按 85 拦人，
    // 表现就是「明明改大了还是传不上去，非得刷新页面」。d.avatarMb 后端原样回传
    // （没夹平台墙），这里补一次夹取，免得放行一个注定到不了 Worker 的头像。
    maxUploadMb=Number(d.uploadMb)||0;
    maxAvatarMb=Math.min(Number(d.avatarMb)||0, Number(d.platformMaxMb)||100);
    renderStore();
    // 填了超过平台硬上限的值时，后端会夹回来 —— 必须说清楚，
    // 否则站主以为生效了，实际用户那边照样传不上去。
    toast(d.clamped?`已保存。超过平台上限，实际生效 ${d.uploadMb} MB`:'上传限制已保存');
  }catch(x){ toast(x.message) }
};

function renderStore(){
  if(!storeState) return;
  const c=storeState.config||{};
  $('#storeType').value=c.type||'none';
  $('#storeWebdavFields').classList.toggle('hidden',c.type!=='webdav');
  $('#storeR2Fields').classList.toggle('hidden',c.type!=='r2');
  $('#storeUrl').value=c.webdav?.baseUrl||'';
  $('#storeUser').value=c.webdav?.username||'';
  $('#storePass').value='';                       // 永远不回显密码
  $('#storeBinding').value=c.r2?.binding||'BUCKET';
  $('#storeEnabled').checked=!!c.enabled;

  const a=storeState.attachments||{};
  $('#storeStats').textContent=`当前附件 ${a.count||0} 个，合计 ${((a.bytes||0)/1048576).toFixed(2)} MB`+
    (c.webdav?.hasPassword?'；已保存 WebDAV 密码（留空即沿用）':'');

  // 上传大小上限（管理员可调，0 = 不限制）
  const L=storeLimit||{};
  if($('#limitUpload')){
    $('#limitUpload').value=String(L.uploadMb??30);
    $('#limitAvatar').value=String(L.avatarMb??2);
    const hint=`填 0 表示不限制（实际最多也就到下面这道平台墙）。⚠️ Workers 的请求体硬上限是 ${L.platformMaxMb||100} MB —— 超过它的文件连 Worker 都到不了，填再大也没用，会被自动夹到这个值。`;
    $('#limitHint').textContent=hint;
    $('#limitMsg').textContent='';
  }

  const armed=storeState.armed;
  $('#storePurgeBtn').disabled=!armed;
  $('#storeStep').textContent=armed
    ? `✅ 已确认备份（${new Date(armed.at).toLocaleString('zh-CN')}，共 ${armed.count} 个附件）。现在可以执行 ③ 彻底清除。`
    : '① 先导出备份包并保存到本地，再点 ② 确认，才解锁 ③。';
}

$('#storeType').onchange=()=>{
  const t=$('#storeType').value;
  $('#storeWebdavFields').classList.toggle('hidden',t!=='webdav');
  $('#storeR2Fields').classList.toggle('hidden',t!=='r2');
};

$('#storeTestBtn').onclick=async()=>{
  $('#storeMsg').textContent='正在测试…';
  try{
    const d=await api('/admin/storage-test',{method:'POST',body:JSON.stringify({
      type:$('#storeType').value, baseUrl:$('#storeUrl').value, username:$('#storeUser').value,
      password:$('#storePass').value, binding:$('#storeBinding').value})});
    $('#storeMsg').textContent='✅ '+d.detail;
  }catch(x){$('#storeMsg').textContent='❌ '+x.message}
};

$('#storeSaveBtn').onclick=async()=>{
  try{
    await api('/admin/storage-config',{method:'POST',body:JSON.stringify({
      type:$('#storeType').value, enabled:$('#storeEnabled').checked,
      baseUrl:$('#storeUrl').value, username:$('#storeUser').value,
      password:$('#storePass').value, binding:$('#storeBinding').value})});
    toast('存储配置已保存');
    await openStore();
  }catch(x){$('#storeMsg').textContent='❌ '+x.message}
};

// 分批循环下载，直到服务端说没有剩余。附件多时也不会因为一次性拉取而超时。
async function downloadAllArchives(){
  let offset=0, part=0;
  while(true){
    const r=await fetch(`/api/admin/storage-archive?offset=${offset}&limit=50`);
    if(!r.ok){ const d=await r.json().catch(()=>({})); throw Error(d.error||'导出失败'); }
    const blob=await r.blob();
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`xinji-attachments-part${++part}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    if(r.headers.get('X-Has-More')!=='1') break;
    offset=Number(r.headers.get('X-Next-Offset')||0);
    if(part>200) throw Error('附件批次过多，已中止');
    await new Promise(res=>setTimeout(res,350));    // 连着弹下载容易被浏览器拦
  }
  return part;
}

$('#storeExportBtn').onclick=async()=>{
  try{
    const part=await downloadAllArchives();
    toast(`已导出 ${part} 个备份包，请先保存到本地再继续`);
  }catch(x){toast(x.message)}
};

$('#storeConfirmBtn').onclick=async()=>{
  if(!confirm('请确认：备份包已经**下载并保存到本地**了。\n\n一旦执行清除，带图片的主题与回复将无法找回。\n\n确定继续吗？'))return;
  try{
    const d=await api('/admin/storage-confirm',{method:'POST',body:JSON.stringify({})});
    toast('已记录备份确认：'+d.count+' 个附件');
    await openStore();
  }catch(x){toast(x.message)}
};

$('#storePurgeBtn').onclick=async()=>{
  if(!storeState?.armed){toast('请先完成 ① ② 两步');return}
  if(!confirm('最后确认：将删除所有带图片的主题与回复，并清空全部附件与远端文件。\n\n此操作不可撤销。确定执行？'))return;
  try{
    const d=await api('/admin/storage-purge',{method:'POST',body:JSON.stringify({confirm:'DELETE'})});
    toast(`已清除：主题 ${d.removedThreads} / 回复 ${d.removedPosts} / 附件 ${d.removedAttachments}`+
      (d.remoteFailed?`（远端删除失败 ${d.remoteFailed} 个，请手动清理）`:''));
    $('#storeDialog').close(); storeState=null; list();
  }catch(x){toast(x.message)}
};

$('#storeSweepBtn').onclick=async()=>{
  try{
    const d=await api('/admin/storage-sweep',{method:'POST',body:JSON.stringify({})});
    toast(d.removed
      ? `已清理 ${d.removed} 个孤儿附件${d.failed?`（远端删除失败 ${d.failed} 个）`:''}`
      : '没有需要清理的孤儿附件');
    await openStore();
  }catch(x){toast(x.message)}
};

$('#storeImportBtn').onclick=async()=>{
  const f=$('#storeImportFile').files?.[0];
  if(!f){toast('请选择之前导出的 .zip 备份包');return}
  try{
    // 这里不能走 api()：必须让浏览器自己生成 multipart 的 boundary
    const fd=new FormData(); fd.append('file',f);
    const r=await fetch('/api/admin/storage-import',{method:'POST',body:fd});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw Error(d.error||'还原失败');
    toast(`还原完成：附件 ${d.restored} 个、主题 ${d.restoredThreads}、回复 ${d.restoredPosts}`+
      (d.failed?`（失败 ${d.failed} 个）`:''));
    await openStore(); list();
  }catch(x){toast(x.message)}
};

init().catch(e=>{
  toast(e.message);
  app.innerHTML=`<div class="empty anim-in">加载失败：${esc(e.message)}<div class="muted" style="margin-top:10px">请确认服务正常运行后重试。</div><div style="margin-top:14px"><button class="ghost" onclick="location.reload()">重新加载</button></div></div>`;
});
