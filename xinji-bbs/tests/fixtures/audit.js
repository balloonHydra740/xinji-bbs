/* 页面内配色审计脚本（跑在 tests/fixtures/ui-kit.html 里）。
 *
 * 为什么不用静态解析 CSS：
 * 一个颜色「可读性够不够」取决于它**实际叠在什么背景上**。本站背景大量是
 * 半透明卡片（--card:rgba(255,255,255,.86)）叠在页面渐变上，还有 linear-gradient
 * 的深红卡片 —— 静态读 CSS 根本算不出最终渲染色。所以这里遍历真实 DOM，
 * 用 getComputedStyle 拿到计算后的颜色，再逐层把背景合成出来。
 *
 * 判定标准用 WCAG 2.1：
 *   · 正文（<18.66px，或 <24px 且非粗体）  ≥ 4.5:1
 *   · 大文本（≥24px，或 ≥18.66px 且 bold） ≥ 3:1
 * 结果写进 <script id="__report" type="application/json">，交给 Node 侧解析。
 */
(function () {
  function c2rgb(s) {
    s = String(s || '').trim();
    if (!s) return null;
    var m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      var p = m[1].split(/[,\/\s]+/).filter(Boolean).map(Number);
      if (p.length < 3 || p.some(isNaN)) return null;
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      ];
    }
    if (s === 'transparent') return [0, 0, 0, 0];
    return null;
  }

  // fg 覆盖在 bg 之上
  function over(fg, bg) {
    var a = fg[3] + bg[3] * (1 - fg[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [
      (fg[0] * fg[3] + bg[0] * bg[3] * (1 - fg[3])) / a,
      (fg[1] * fg[3] + bg[1] * bg[3] * (1 - fg[3])) / a,
      (fg[2] * fg[3] + bg[2] * bg[3] * (1 - fg[3])) / a,
      a
    ];
  }

  function lum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }

  function ratio(a, b) {
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function hex(c) {
    function h(v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }

  // 从元素向上把所有背景层收集起来并「压平」成一个不透明色
  function bgOf(el) {
    var layers = [], n = el;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      var bi = cs.backgroundImage;
      if (bi && bi !== 'none' && /gradient/i.test(bi)) {
        var stops = [];
        bi.replace(/(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi, function (m) { stops.push(m); return m; });
        var cols = stops.map(c2rgb).filter(Boolean);
        if (cols.length) {
          var acc = [0, 0, 0, 0];
          cols.forEach(function (c) { acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += c[3]; });
          // 渐变取色标均值：深红渐变两头都很深，均值足以判定可读性
          layers.push(acc.map(function (v) { return v / cols.length; }));
        }
      }
      var bc = c2rgb(cs.backgroundColor);
      if (bc && bc[3] > 0) layers.push(bc);
      if (bc && bc[3] >= 1) break;
      n = n.parentElement;
    }
    layers.push([255, 255, 255, 1]);
    var out = layers[layers.length - 1];
    for (var i = layers.length - 2; i >= 0; i--) out = over(layers[i], out);
    return out;
  }

  function opacityOf(el) {
    var o = 1, n = el;
    while (n && n.nodeType === 1) {
      o *= parseFloat(getComputedStyle(n).opacity);
      n = n.parentElement;
    }
    return o;
  }

  function label(el) {
    var cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).join('.');
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  }

  var out = [], done = {}, tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var node;
  while ((node = tw.nextNode())) {
    var txt = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    var el = node.parentElement;
    if (!el || el.closest('#__report')) continue;

    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    var fg = c2rgb(cs.color);
    if (!fg || fg[3] === 0) continue;

    var bg = bgOf(el);
    // 去重键必须带上「计算色 + 合成背景」：同一个选择器在不同卡片里
    // 背景完全不同（.mini 在白卡上是白底深字、在红卡上是白底白字），
    // 只按类名去重会把后者整个藏起来。
    var key = label(el) + '@' + cs.color + '@' + hex(bg);
    if (done[key]) continue;
    done[key] = 1;

    var op = opacityOf(el);
    var fgFlat = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    var cr = ratio(fgFlat, bg);

    var fs = parseFloat(cs.fontSize);
    var fw = parseInt(cs.fontWeight, 10) || 400;
    var large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    var need = large ? 3 : 4.5;

    out.push({
      sel: label(el),
      text: txt.slice(0, 42),
      fg: cs.color,
      fgFlat: hex(fgFlat),
      bg: hex(bg),
      size: Math.round(fs * 10) / 10,
      weight: fw,
      op: Math.round(op * 1000) / 1000,
      ratio: Math.round(cr * 100) / 100,
      need: need,
      pass: cr >= need - 0.005
    });
  }

  /* 占位符是伪元素，TreeWalker 走不到 —— 但它恰恰是输入框里最先被看到的一行字
     （截图里那个看不清的「你的用户名」就是它）。单独按 ::placeholder 取色再算一次。 */
  Array.prototype.forEach.call(document.querySelectorAll('[placeholder]'), function (el) {
    var txt = String(el.getAttribute('placeholder') || '').trim();
    if (!txt) return;
    var ps = getComputedStyle(el, '::placeholder');
    var pc = c2rgb(ps.color);
    if (!pc) return;
    var bg = bgOf(el);
    var pk = 'ph@' + ps.color + '@' + hex(bg);
    if (done[pk]) return;
    done[pk] = 1;
    var op = opacityOf(el) * (parseFloat(ps.opacity) || 1);
    var flat = over([pc[0], pc[1], pc[2], pc[3] * op], bg);
    var cr = ratio(flat, bg);
    var fs = parseFloat(getComputedStyle(el).fontSize);
    out.push({
      sel: '::placeholder @ ' + label(el),
      text: txt,
      fg: ps.color,
      fgFlat: hex(flat),
      bg: hex(bg),
      size: Math.round(fs * 10) / 10,
      weight: 400,
      op: Math.round(op * 1000) / 1000,
      ratio: Math.round(cr * 100) / 100,
      need: 4.5,
      pass: cr >= 4.495
    });
  });

  out.sort(function (a, b) { return a.ratio - b.ratio; });
  var tag = document.createElement('script');
  tag.id = '__report';
  tag.type = 'application/json';
  tag.textContent = JSON.stringify({ total: out.length, items: out });
  document.body.appendChild(tag);
})();
