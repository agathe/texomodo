/*
 * TexoModo: Review Mode overlay (used on the All Saints prototype).
 *
 * Loaded on demand by review-launcher.js. Provides:
 *   - Google sign-in through Supabase Auth, allowlist check (also enforced by RLS)
 *   - annotation tools: pin, rectangle, circle, freehand draw
 *   - rich context capture (selector, text, HTML snippet, geometry, build info, screenshot)
 *   - right-hand drawer: comments for this page, filters, replies, resolve/reopen, deep links
 *   - a storage adapter (Supabase, or browser-local for UI development)
 *   - an "Ask AI to change this" extension point (Phase 2; hidden unless REVIEW_AI_CHANGES=true)
 *
 * Data shapes: review/types.d.ts. Database: supabase/migrations/0001_review_schema.sql.
 * All user-provided text is rendered with textContent; never innerHTML.
 */
(function () {
  'use strict';
  if (window.TexoModo) return;

  var SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
  var HTML2CANVAS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  var LIMITS = { text: 300, nearby: 500, html: 1500, selected: 300, comment: 5000, shotMax: 1400 };
  // The comment tools. 'pin' is still understood for existing data and as the
  // result of a click-without-drag, but is no longer offered as a tool.
  var TOOLS = { inspect: 'Select element', rectangle: 'Rectangle', circle: 'Circle', draw: 'Draw' };
  var SCOPES = { page: 'This page only', component: 'This component on every page', site: 'The whole site (a style or rule)' };
  var CATEGORIES = { content: 'Content', navigation: 'Navigation', layout: 'Layout', typography: 'Typography', color: 'Colour', imagery: 'Imagery', other: 'Other' };

  // Where the toolbar, drawer, toasts and dialogs are mounted. Inside a device
  // frame this is the shell (parent) document, so the review UI sits over the
  // frame at full size while markers and drawing stay inside the frame.
  var UI = { doc: document, win: window };
  var S = {
    started: false, base: 'review/', config: null, store: null, user: null,
    annotations: [], tool: null, drawerOpen: false, filter: 'open', selectedId: null,
    draft: null, replyDrafts: {}, unsubscribe: null, lastFocus: null, shotUrls: {},
    nodes: {}, drawing: null, resizeTimer: null, hold: null, holdSheet: null, inspect: null, inspectDown: null, lastPointer: null, sharedCollapsed: false, frame: null, advanced: false, role: 'reviewer', retarget: null, activityOpen: {}, lastTool: 'inspect', includeOthers: true, othersCollapsed: true,
  };

  // =========================================================================
  // Small helpers
  // =========================================================================
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    n.setAttribute('data-tm', '');
    (children || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function svgIcon(d) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p);
    return s;
  }
  var ICONS = {
    pin: 'M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    rectangle: 'M4 5h16v14H4z',
    circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    draw: 'M4 20c3-7 6-9 8-8s-1 6 2 6 4-6 6-6',
    comments: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.3A8 8 0 1 1 21 12z',
    exit: 'M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4m6-4 5-4-5-4m5 4H9',
    close: 'M6 6l12 12M18 6 6 18',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
    check: 'M5 12l5 5L20 7',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    ai: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z',
    verify: 'M12 2l7 3v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V5zM9 12l2 2 4-4',
    hold: 'M6 3l12 9-5 1 3 6-2 1-3-6-4 4z',
    inspect: 'M3 3h6M3 3v6M21 21h-6M21 21v-6M3 21v-6M3 21h6M21 3h-6M21 3v6M10 9l6 3-2.5 1L15 16l-1.5.8-1.5-3-1.8 2z',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    chevron: 'M6 9l6 6 6-6',
  };
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = resolve; s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function cap(str, n) { str = (str || '').replace(/\s+/g, ' ').trim(); return str.length > n ? str.slice(0, n - 1) + '…' : str; }
  function uid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function relTime(iso) {
    var d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.round(diff / 60) + ' min ago';
    if (diff < 86400) return Math.round(diff / 3600) + ' h ago';
    if (diff < 86400 * 7) return Math.round(diff / 86400) + ' d ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  }
  function initials(name) { return (name || '?').split(/\s+/).map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase(); }
  function isOurs(node) { return !!(node && node.closest && node.closest('[data-tm]')); }
  function pagePath() { return location.pathname.replace(/\/index\.html$/, '/'); }
  // Simple vs advanced mode (remembered per browser). Simple hides technical
  // detail (selectors, rules, scope/size fields, inspect/draw/hold tools); the
  // smart defaults still apply underneath.
  function loadMode() { try { S.advanced = localStorage.getItem('tm:advanced') === '1'; } catch (e) { S.advanced = false; } }
  function setAdvanced(on) {
    S.advanced = !!on;
    try { localStorage.setItem('tm:advanced', on ? '1' : '0'); } catch (e) {}
    ['toolbar', 'drawer'].forEach(function (k) { if (S.nodes[k]) S.nodes[k].classList.toggle('tm-advanced', S.advanced); });
    renderDrawer();
    toast(S.advanced ? 'Advanced mode: selectors, rules, scope and size controls are shown.' : 'Simple mode: technical details hidden. Use "Details" on a comment to see them.', null, 3500);
  }
  function detailsToggle(container) {
    return el('button', { class: 'tm-link tm-adv-toggle', type: 'button', text: 'Details', 'aria-expanded': 'false', onClick: function (e) {
      var on = container.classList.toggle('tm-show-adv'); e.currentTarget.setAttribute('aria-expanded', on ? 'true' : 'false'); e.currentTarget.textContent = on ? 'Hide details' : 'Details';
    } });
  }
  function isMine(x) { return S.config.mode === 'local' ? (!x.author || !S.user || x.author.email === S.user.email || x.author.name === S.user.name) : !!(S.user && x.author && x.author.email === S.user.email); }
  function isMaintainer() { return S.role === 'maintainer'; }
  function canEdit(a) { return isMine(a) || isMaintainer(); }
  function statusLabel(a) { return a.status === 'resolved' ? (a.resolution || 'resolved') : a.status; }
  function uiActive() { try { return UI.doc.activeElement; } catch (e) { return null; } }
  function toast(msg, kind, ms) {
    var box = S.nodes.toasts;
    if (!box) return;
    var t = el('div', { class: 'tm-toast' + (kind ? ' tm-toast--' + kind : ''), text: msg });
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 3200);
  }

  // =========================================================================
  // Geometry and DOM context capture
  // =========================================================================
  function docBox(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
  }
  function pageElementAt(clientX, clientY) {
    var list = document.elementsFromPoint(clientX, clientY);
    for (var i = 0; i < list.length; i++) if (!isOurs(list[i]) && list[i] !== document.documentElement) return list[i];
    return document.body;
  }
  // Climb until the element's box contains most (60%+) of the drawn rectangle.
  // Partial overlap is accepted so a mark that slightly overshoots an absolutely
  // positioned dropdown still anchors to the dropdown, not to <body>.
  function pickAnchor(startEl, rect) {
    var node = startEl || document.body, area = Math.max(1, rect.w * rect.h);
    while (node && node !== document.body) {
      var b = docBox(node);
      if (b.w > 0 && b.h > 0) {
        var ix = Math.max(0, Math.min(b.x + b.w, rect.x + rect.w) - Math.max(b.x, rect.x));
        var iy = Math.max(0, Math.min(b.y + b.h, rect.y + rect.h) - Math.max(b.y, rect.y));
        if ((ix * iy) / area >= 0.6) return node;
      }
      node = node.parentElement;
    }
    return document.body;
  }
  function uniqueSelector(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
  function classPart(node) {
    var cls = Array.prototype.filter.call(node.classList, function (c) { return !/^(open|active|is-|js-|tm-)/.test(c) && !/\d{3,}/.test(c); }).slice(0, 2);
    return cls.length ? '.' + cls.map(function (c) { return CSS.escape(c); }).join('.') : '';
  }
  function nthPart(node) {
    var i = 1, sib = node;
    while ((sib = sib.previousElementSibling)) if (sib.nodeName === node.nodeName) i++;
    return ':nth-of-type(' + i + ')';
  }
  function buildSelector(node) {
    if (!node || node === document.body) return 'body';
    if (node.id && uniqueSelector('#' + CSS.escape(node.id))) return '#' + CSS.escape(node.id);
    var parts = [], cur = node;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      if (cur.id && uniqueSelector('#' + CSS.escape(cur.id))) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      parts.unshift({ tag: cur.nodeName.toLowerCase(), cls: classPart(cur), nth: nthPart(cur) });
      cur = cur.parentElement;
    }
    // Prefer the readable form; add :nth-of-type from the end only as far as needed for uniqueness.
    var render = function (nthFrom) {
      return parts.map(function (p, i) { return typeof p === 'string' ? p : p.tag + p.cls + (i >= nthFrom ? p.nth : ''); }).join(' > ');
    };
    for (var k = parts.length; k >= 0; k--) {
      var sel = render(k);
      if (uniqueSelector(sel)) return sel;
    }
    return render(0);
  }
  function readablePath(node) {
    var parts = [], cur = node, n = 0;
    while (cur && cur !== document.body && n < 6) {
      parts.unshift(cur.nodeName.toLowerCase() + (cur.id ? '#' + cur.id : classPart(cur)));
      if (/^(main|header|footer|nav)$/i.test(cur.nodeName)) break;
      cur = cur.parentElement; n++;
    }
    return parts.join(' > ');
  }
  function landmarkOf(node) {
    var l = node.closest && node.closest('header, nav, main, footer, aside');
    return l ? l.nodeName.toLowerCase() : null;
  }
  function nearestHeading(node) {
    var heads = document.querySelectorAll('h1, h2, h3, h4'), best = null;
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      if (isOurs(h)) continue;
      if (h === node || h.contains(node)) return cap(h.textContent, 120);
      if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) best = h; else break;
    }
    return best ? cap(best.textContent, 120) : null;
  }
  function blockOf(node) {
    return node.closest && node.closest('section, article, .card, .tile, .event-card, .path-card, .drop-col, .footer-grid > div, .quick-grid, header, footer, nav, main') || node.parentElement || node;
  }
  function captureTarget(node, selectedText) {
    if (!node || node === document.documentElement) node = document.body;
    var r = node.getBoundingClientRect();
    var html = node.outerHTML || '';
    return {
      selector: buildSelector(node),
      tagName: node.nodeName.toLowerCase(),
      id: node.id || null,
      classes: Array.prototype.slice.call(node.classList),
      landmark: landmarkOf(node),
      heading: nearestHeading(node),
      path: readablePath(node),
      text: cap(node.innerText || node.textContent, LIMITS.text),
      nearbyText: cap(blockOf(node).innerText || '', LIMITS.nearby),
      selectedText: selectedText ? cap(selectedText, LIMITS.selected) : null,
      html: html.length > LIMITS.html ? html.slice(0, LIMITS.html) + '…' : html,
      boundingRect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      visible: isVisible(node),
      /** Hover/open state that was held while the mark was made (see holdHover). */
      state: S.hold ? { held: S.hold.selectors.slice() } : null,
      /** Computed typography/colour and the stylesheet rules that set them. */
      style: captureStyle(node),
      /** Which breakpoints show this element, inferred from the stylesheet. */
      visibleAt: visibleAt(node),
    };
  }

  // =========================================================================
  // Scope, category and style context
  // =========================================================================
  function componentOf(node) {
    var c = node.closest && node.closest('[data-component]');
    if (c) return c.getAttribute('data-component');
    var l = node.closest && node.closest('header, nav, footer');
    return l ? l.nodeName.toLowerCase() : null;
  }
  function inferScope(node) {
    var component = node ? componentOf(node) : null;
    return { scope: component ? 'component' : 'page', component: component };
  }
  function inferCategory(node) {
    if (!node) return 'content';
    var tag = node.nodeName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'typography';
    if (tag === 'img' || tag === 'picture' || tag === 'svg') return 'imagery';
    if (tag === 'a' || tag === 'button') return node.closest('nav, header, footer, [data-component]') ? 'navigation' : 'content';
    if (/^(p|li|span|blockquote|small|strong|em|b|td|th|label)$/.test(tag)) return 'content';
    return 'layout';
  }
  var STYLE_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'background', 'padding', 'margin', 'letter-spacing', 'text-transform', 'border-radius', 'gap', 'grid-template-columns'];
  function captureStyle(node) {
    var cs = getComputedStyle(node);
    var computed = { fontFamily: (cs.fontFamily || '').split(',')[0].replace(/"/g, '').trim(), fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color, backgroundColor: cs.backgroundColor };
    var rules = [];
    function walk(list, sheetName, media) {
      for (var i = 0; i < list.length && rules.length < 40; i++) {
        var r = list[i];
        if (r.type === 1 && r.selectorText) {
          var matched = false;
          try { matched = node.matches(r.selectorText); } catch (e) {}
          if (!matched) continue;
          var set = STYLE_PROPS.filter(function (prop) { return r.style.getPropertyValue(prop); });
          if (!set.length) continue;
          var affects = 0; try { affects = document.querySelectorAll(r.selectorText).length; } catch (e) {}
          var active = true; try { active = !media || window.matchMedia(media).matches; } catch (e) {}
          rules.push({ selector: r.selectorText, properties: set, css: cap(r.style.cssText, 240), sheet: sheetName, media: media || null, active: active, affectsOnPage: affects });
        } else if (r.cssRules && (r.type === 4 || r.type === 12)) walk(r.cssRules, sheetName, r.type === 4 ? (r.conditionText || r.media.mediaText) : media);
      }
    }
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sh = document.styleSheets[i];
      if (sh.ownerNode && (isOurs(sh.ownerNode) || sh.ownerNode.id === 'tm-hold-sheet')) continue;
      if (sh.href && /\/review\.css(\?|$)/.test(sh.href)) continue;
      try { walk(sh.cssRules, sh.href ? sh.href.split('/').pop().split('?')[0] : 'inline', null); } catch (e) {}
    }
    // Later rules win in the cascade (roughly); keep the last few, they are the most specific.
    return { computed: computed, rules: rules.slice(-8) };
  }
  // The rule a human would edit: the last active one that sets font-size or colour.
  function keyRule(style) {
    if (!style || !style.rules || !style.rules.length) return null;
    var rules = style.rules, i;
    for (i = rules.length - 1; i >= 0; i--) if (rules[i].active !== false && (rules[i].properties.indexOf('font-size') >= 0 || rules[i].properties.indexOf('color') >= 0)) return rules[i];
    for (i = rules.length - 1; i >= 0; i--) if (rules[i].active !== false) return rules[i];
    return rules[rules.length - 1];
  }
  function findDuplicates(target) {
    if (!target) return [];
    var rule = keyRule(target.style);
    return S.annotations.filter(function (a) {
      if (a.status !== 'open' || !a.target) return false;
      if (a.target.selector === target.selector) return true;
      var r2 = keyRule(a.target.style);
      return !!(rule && r2 && a.category === 'typography' && rule.selector === r2.selector);
    });
  }
  function ancestry(node) {
    var list = [], cur = node;
    while (cur && cur !== document.body && cur.nodeType === 1 && list.length < 8) { list.unshift(cur); cur = cur.parentElement; }
    return list;
  }
  function describeEl(node) { return node.nodeName.toLowerCase() + (node.id ? '#' + node.id : '') + classPart(node); }

  // =========================================================================
  // Inspect tool: DevTools-style element picker
  // =========================================================================
  function ensureInspectBox() {
    if (S.nodes.inspect) return S.nodes.inspect;
    var box = el('div', { id: 'tm-inspect', 'aria-hidden': 'true' }, [el('span', { class: 'tm-inspect-badge' })]);
    S.nodes.layer.appendChild(box); S.nodes.inspect = box; return box;
  }
  function showInspect(node) {
    if (!node || node === document.documentElement) node = document.body;
    var box = ensureInspectBox(), b = docBox(node);
    box.style.display = 'block';
    box.style.left = b.x + 'px'; box.style.top = b.y + 'px'; box.style.width = b.w + 'px'; box.style.height = b.h + 'px';
    box.firstChild.textContent = describeEl(node) + '  ' + Math.round(b.w) + '\u00d7' + Math.round(b.h);
    box.classList.toggle('tm-inspect--top', b.y - window.scrollY < 30);
    S.inspect = S.inspect || {}; S.inspect.el = node;
  }
  function hideInspect() { if (S.nodes.inspect) S.nodes.inspect.style.display = 'none'; S.inspect = null; }
  function updateInspect(e) {
    if (S.inspect && S.inspect.pinnedAt && Math.hypot(e.clientX - S.inspect.pinnedAt.x, e.clientY - S.inspect.pinnedAt.y) < 16) return;
    if (S.inspect) S.inspect.pinnedAt = null;
    showInspect(pageElementAt(e.clientX, e.clientY));
  }
  function walkInspect(dir) {
    if (!S.inspect || !S.inspect.el) return;
    var cur = S.inspect.el, next = dir < 0 ? cur.parentElement : cur.firstElementChild;
    if (!next || next === document.documentElement || (dir < 0 && cur === document.body) || isOurs(next)) return;
    showInspect(next);
    S.inspect.pinnedAt = S.lastPointer || { x: -999, y: -999 };
  }
  function elementGeometry(node) { return { kind: 'element', selector: buildSelector(node), absolute: docBox(node) }; }
  function finishInspect(node) {
    hideInspect();
    openComposer('element', elementGeometry(node), captureTarget(node, currentSelection()), docBox(node), node);
  }
  function isVisible(node) {
    try { return node.checkVisibility ? node.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true; } catch (e) { return true; }
  }

  // =========================================================================
  // Breakpoints and device frames
  // The site's breakpoints are read from its stylesheet (max-width media
  // queries) unless window.TexoModoConfig.breakpoints overrides them.
  // A device frame renders the page in an iframe of a fixed CSS width so media
  // queries behave exactly as on that device; ?tmView=phone|tablet|desktop|<px>.
  // =========================================================================
  var BP = null;
  function pageSheets() {
    var out = [];
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sh = document.styleSheets[i];
      if (sh.ownerNode && (isOurs(sh.ownerNode) || sh.ownerNode.id === 'tm-hold-sheet')) continue;
      if (sh.href && /\/review\.css(\?|$)/.test(sh.href)) continue;
      out.push(sh);
    }
    return out;
  }
  function detectBreakpoints() {
    if (BP) return BP;
    var cfg = window.TexoModoConfig && window.TexoModoConfig.breakpoints;
    var widths = cfg ? cfg.slice() : [];
    if (!widths.length) {
      var found = {};
      pageSheets().forEach(function (sh) {
        try {
          for (var j = 0; j < sh.cssRules.length; j++) {
            var r = sh.cssRules[j];
            if (r.type !== 4) continue;
            var re = /\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g, m;
            while ((m = re.exec(r.media.mediaText))) found[Math.round(+m[1])] = 1;
          }
        } catch (e) {}
      });
      widths = Object.keys(found).map(Number).sort(function (a, b) { return a - b; });
    }
    if (!widths.length) widths = [650, 1000];
    var thresholds = widths.length === 1 ? [widths[0]] : [widths[0], widths[widths.length - 1]];
    var names = thresholds.length === 1 ? ['phone', 'desktop'] : ['phone', 'tablet', 'desktop'];
    var presets = { phone: Math.min(390, thresholds[0]), desktop: Math.max(1280, thresholds[thresholds.length - 1] + 280) };
    if (names.length === 3) presets.tablet = Math.min(820, thresholds[1]) > thresholds[0] ? Math.min(820, thresholds[1]) : Math.round((thresholds[0] + thresholds[1]) / 2);
    BP = { thresholds: thresholds, names: names, presets: presets };
    return BP;
  }
  function breakpointFor(width, bp) {
    bp = bp || detectBreakpoints();
    for (var i = 0; i < bp.thresholds.length; i++) if (width <= bp.thresholds[i]) return bp.names[i];
    return bp.names[bp.names.length - 1];
  }
  function currentBreakpoint() { return breakpointFor(window.innerWidth); }
  function cap1(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
  function mediaMatchesAt(mediaText, width) {
    if (!mediaText || /^(all|screen)?$/.test(mediaText.trim())) return true;
    if (/print/.test(mediaText) && !/screen/.test(mediaText)) return false;
    var ok = true, m, re = /\((min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|em|rem)\)/g;
    while ((m = re.exec(mediaText))) {
      var px = m[3] === 'px' ? +m[2] : +m[2] * 16;
      if (m[1] === 'max' && width > px) ok = false;
      if (m[1] === 'min' && width < px) ok = false;
    }
    return ok;
  }
  // Which breakpoints show this element, from the stylesheet's display rules
  // (order-based cascade approximation); the current one uses the live DOM.
  function visibleAt(node) {
    var bp = detectBreakpoints(), out = {};
    var chain = [], cur = node;
    while (cur && cur !== document.documentElement) { chain.push(cur); cur = cur.parentElement; }
    var displayRules = [];
    function walk(rules, media) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.type === 1 && r.selectorText && r.style.getPropertyValue('display')) {
          var hits = chain.filter(function (n) { try { return n.matches(r.selectorText); } catch (e) { return false; } });
          if (hits.length) displayRules.push({ nodes: hits, value: r.style.getPropertyValue('display'), media: media });
        } else if (r.cssRules && (r.type === 4 || r.type === 12)) walk(r.cssRules, r.type === 4 ? (r.conditionText || r.media.mediaText) : media);
      }
    }
    pageSheets().forEach(function (sh) { try { walk(sh.cssRules, null); } catch (e) {} });
    bp.names.forEach(function (name) {
      var width = bp.presets[name], disp = new Map();
      displayRules.forEach(function (dr) { if (mediaMatchesAt(dr.media, width)) dr.nodes.forEach(function (n) { disp.set(n, dr.value); }); });
      out[name] = !chain.some(function (n) { return disp.get(n) === 'none'; });
    });
    out[currentBreakpoint()] = isVisible(node);
    return out;
  }
  function defaultDevices(vis) {
    var names = detectBreakpoints().names;
    var on = names.filter(function (n) { return !vis || vis[n] !== false; });
    return on.length === names.length || !on.length ? [] : on; // [] = all sizes
  }
  function devicesLabel(devices) {
    var names = detectBreakpoints().names;
    if (!devices || !devices.length || devices.length === names.length) return 'all sizes';
    return devices.map(cap1).join(' & ') + ' only';
  }
  function appliesHere(a) { return !a.devices || !a.devices.length || a.devices.indexOf(currentBreakpoint()) >= 0; }

  // =========================================================================
  // Versions: which deployment a comment belongs to.
  // A comment belongs on this deploy when the commit it was made on is in this
  // deploy's history (build.ancestors from the build step). Without history we
  // fall back to: same branch, or the main branch as the baseline.
  // =========================================================================
  function buildInfo() { return (S.config && S.config.build) || {}; }
  function short(sha) { return (sha || '').slice(0, 7); }
  function commitsAgo(sha) { var list = buildInfo().ancestors || []; var i = list.indexOf(short(sha)); return i < 0 ? null : i; }
  function belongsHere(a) {
    var b = a.build, cur = buildInfo();
    if (!b || !b.commit) return true;                           // made before versions were recorded
    var sameBranch = b.branch && cur.branch && b.branch === cur.branch;
    var sameCommit = short(b.commit) === short(cur.commit);
    if (sameCommit || sameBranch) return true;
    if (!S.includeOthers) return false;                         // this branch is a separate site
    var list = cur.ancestors || [];
    if (list.length) return list.indexOf(short(b.commit)) >= 0; // in our history (also covers merged branches)
    return !!(b.branch && b.branch === (cur.mainBranch || 'main')); // no history: main is the baseline
  }
  function versionChip(a) {
    var b = a.build, cur = buildInfo();
    if (!b || !b.commit || short(b.commit) === short(cur.commit)) return null;
    var ago = commitsAgo(b.commit), parts = [];
    if (b.branch && b.branch !== cur.branch) parts.push(b.branch === (cur.mainBranch || 'main') ? 'main' : 'branch ' + b.branch);
    if (ago != null) parts.push(ago === 0 ? 'this build' : ago + ' commit' + (ago > 1 ? 's' : '') + ' ago');
    else if (!belongsHere(a)) parts.push('not in this deploy');
    else parts.push('older build');
    return el('span', { class: 'tm-chip tm-chip--version' + (belongsHere(a) ? '' : ' tm-chip--off'), text: parts.join(' \u00b7 '), title: 'Made on ' + short(b.commit) + (b.branch ? ' (' + b.branch + ')' : '') + (b.deployUrl ? ' at ' + b.deployUrl : '') });
  }
  function loadIncludeOthers() { try { var v = localStorage.getItem('tm:includeOthers:' + (buildInfo().branch || '')); S.includeOthers = v !== '0'; } catch (e) { S.includeOthers = true; } }
  function setIncludeOthers(on) { S.includeOthers = !!on; try { localStorage.setItem('tm:includeOthers:' + (buildInfo().branch || ''), on ? '1' : '0'); } catch (e) {} renderMarkers(); renderDrawer(); }
  function framedView() {
    var fe = null; try { fe = window.frameElement; } catch (e) {}
    if (!fe || !fe.dataset || !fe.dataset.tmView) return null;
    return { name: fe.dataset.tmView, width: +fe.dataset.tmWidth || window.innerWidth, custom: fe.dataset.tmCustom === '1' };
  }
  // Request a view: inside a frame it resizes live (no reload); outside it opens the frame shell.
  function requestView(view, focusId) {
    if (S.frame) { try { window.parent.postMessage({ type: 'tm:setview', view: String(view) }, location.origin); } catch (e) {} return; }
    saveDraft();
    var u = new URL(location.href);
    if (view) u.searchParams.set('tmView', String(view)); else u.searchParams.delete('tmView');
    if (focusId) u.searchParams.set('review', focusId);
    location.href = u.toString();
  }
  // keepWindow: the reviewer chose "Actual window" / "Exit frame"; remember it for
  // this session so Review Mode does not reopen the desktop frame on the next page.
  function exitFrame(keepWindow) {
    if (keepWindow === true) rememberViewChoice('window');
    var u = new URL(window.top.location.href); u.searchParams.delete('tmView');
    window.top.location.href = u.toString();
  }
  function rememberViewChoice(choice) { try { if (choice) sessionStorage.setItem('tm:viewChoice', choice); else sessionStorage.removeItem('tm:viewChoice'); } catch (e) {} }
  // Desktop by default: when Review Mode starts at top level in a window that is
  // in the desktop layout, open the Desktop frame so every reviewer sees the same
  // width, unless "Actual window" was chosen earlier in this session.
  function shouldAutoFrame() {
    if (S.frame || window.top !== window) return false;
    try { if (sessionStorage.getItem('tm:viewChoice') === 'window') return false; } catch (e) {}
    var bp = detectBreakpoints();
    return window.innerWidth > bp.thresholds[bp.thresholds.length - 1];
  }
  function parseView(v) {
    var bp = detectBreakpoints();
    if (/^\d+$/.test(v)) {
      var preset = bp.names.filter(function (n) { return bp.presets[n] === +v; })[0];
      return preset ? { name: preset, width: +v, custom: false } : { name: breakpointFor(+v, bp), width: +v, custom: true };
    }
    return bp.presets[v] ? { name: v, width: bp.presets[v], custom: false } : { name: bp.names[bp.names.length - 1], width: bp.presets.desktop, custom: false };
  }
  // Runs in the top window: replaces the page with a device-frame shell around an iframe of the same URL.
  function enterFrameShell(view) {
    var v = parseView(view), bp = detectBreakpoints();
    try { sessionStorage.setItem('tmReviewMode', '1'); } catch (e) {}
    document.documentElement.style.overflow = 'hidden';
    var inner = new URL(location.href); inner.searchParams.delete('tmView');
    var frame = document.createElement('iframe');
    frame.id = 'tm-frame'; frame.setAttribute('data-tm', ''); frame.title = 'Page under review'; frame.src = inner.toString();
    var wrap = el('div', { class: 'tm-shell-wrap' }, [frame]);
    var stage = el('div', { class: 'tm-shell-stage' }, [wrap]);
    var widthLabel = el('span', { class: 'tm-shell-width' });
    var buttons = {};
    var bar = el('div', { class: 'tm-shell-bar', role: 'toolbar', 'aria-label': 'Device frame' }, [el('span', { class: 'tm-shell-title', text: 'Device frame' })]);
    bp.names.forEach(function (name) {
      buttons[name] = el('button', { class: 'tm-shell-btn', type: 'button', 'aria-pressed': 'false', text: cap1(name) + ' ' + bp.presets[name], onClick: function () { setView({ name: name, width: bp.presets[name], custom: false }); } });
      bar.appendChild(buttons[name]);
    });
    bar.appendChild(widthLabel);
    bar.appendChild(el('button', { class: 'tm-shell-btn tm-shell-btn--exit', type: 'button', text: 'Exit frame', onClick: function () { exitFrame(true); } }));
    var shell = el('div', { id: 'tm-shell' }, [bar, stage]);
    document.body.appendChild(shell);
    function layout() {
      var avail = stage.clientWidth - 24, availH = stage.clientHeight - 24 - 64; // 64: room for the review toolbar
      var k = Math.min(1, avail / v.width);
      wrap.style.width = Math.round(v.width * k) + 'px'; wrap.style.height = availH + 'px';
      frame.style.width = v.width + 'px'; frame.style.height = Math.round(availH / k) + 'px'; frame.style.transform = 'scale(' + k + ')';
      frame.dataset.tmView = v.name; frame.dataset.tmWidth = v.width; frame.dataset.tmCustom = v.custom ? '1' : '0';
      widthLabel.textContent = v.width + ' px \u00b7 ' + v.name + (k < 1 ? ' \u00b7 shown at ' + Math.round(k * 100) + '%' : '');
      Object.keys(buttons).forEach(function (n) { buttons[n].setAttribute('aria-pressed', n === v.name && !v.custom ? 'true' : 'false'); });
    }
    function setView(nv) {
      v = nv; layout();
      var u = new URL(location.href); u.searchParams.set('tmView', v.custom ? String(v.width) : v.name); history.replaceState(null, '', u.toString());
      try { frame.contentWindow.postMessage({ type: 'tm:view', name: v.name, width: v.width, custom: v.custom }, location.origin); } catch (e) {}
    }
    // A hash link inside the frame (about.html#councils) makes the browser scroll
    // every scrollable ancestor, including our clipped wrapper, which would cut
    // off the top of the framed page for good. Keep the shell's containers at 0.
    function unscroll() {
      if (wrap.scrollTop || wrap.scrollLeft) { wrap.scrollTop = 0; wrap.scrollLeft = 0; }
      if (stage.scrollTop || stage.scrollLeft) { stage.scrollTop = 0; stage.scrollLeft = 0; }
      if (document.documentElement.scrollTop || document.body.scrollTop) { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }
    }
    wrap.addEventListener('scroll', unscroll); stage.addEventListener('scroll', unscroll); window.addEventListener('scroll', unscroll);
    frame.addEventListener('load', function () {
      unscroll(); setTimeout(unscroll, 50);
      // The browser used our wrapper for the fragment scroll; do it inside the frame instead.
      try {
        var cw = frame.contentWindow, hash = cw.location.hash.slice(1);
        var target = hash ? cw.document.getElementById(decodeURIComponent(hash)) : null;
        if (target) setTimeout(function () { unscroll(); cw.scrollTo({ top: target.getBoundingClientRect().top + cw.scrollY - 96, behavior: 'auto' }); }, 80);
      } catch (e) {}
    });
    window.addEventListener('resize', layout);
    if (window.ResizeObserver) new ResizeObserver(function () { layout(); }).observe(stage);
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'tm:setview') return;
      if (e.data.view === '') { exitFrame(true); return; }
      rememberViewChoice(null);
      setView(parseView(e.data.view));
    });
    layout();
  }

  // Draft persistence across a reload (entering a device frame mid-comment).
  function saveDraft() {
    var d = S.draft; if (!d) return;
    var ta = S.nodes.drawer && S.nodes.drawer.querySelector('#tm-draft-text'); if (ta) d.comment = ta.value;
    try { sessionStorage.setItem('tm:draft', JSON.stringify({ page: pagePath(), type: d.type, geometry: d.geometry, target: d.target, scope: d.scope, component: d.component, category: d.category, devices: d.devices, comment: d.comment })); } catch (e) {}
  }
  function restoreDraft() {
    var raw = null; try { raw = sessionStorage.getItem('tm:draft'); sessionStorage.removeItem('tm:draft'); } catch (e) {}
    if (!raw) return false;
    try {
      var d = JSON.parse(raw); if (d.page !== pagePath()) return false;
      var env = envContext(), node = null;
      try { node = d.geometry && d.geometry.selector ? document.querySelector(d.geometry.selector) : null; } catch (e) {}
      S.draft = { type: d.type, geometry: d.geometry, target: d.target, viewport: env.viewport, scroll: env.scroll, comment: d.comment || '', shot: null, shotPending: true, el: node, scope: d.scope, component: d.component, category: d.category, devices: d.devices || [], duplicates: findDuplicates(d.target) };
      renderMarkers(); renderDrawer(); openDrawer(true);
      var g = resolveGeometry(d.geometry); captureDraftShot({ x: g.x - (g.w ? 0 : 60), y: g.y - (g.h ? 0 : 40), w: g.w || 120, h: g.h || 80 });
      return true;
    } catch (e) { return false; }
  }

  // =========================================================================
  // Hover hold: freeze :hover-dependent UI (dropdown menus, tooltips) so it can
  // be annotated. Every same-origin CSS rule that uses :hover is cloned once
  // with [data-tm-hold] in its place; holding = adding that attribute to the
  // elements currently under the pointer. The held selectors are saved with
  // the annotation and re-applied when the comment is selected later.
  // =========================================================================
  function buildHoldSheet() {
    if (S.holdSheet) return;
    var out = [];
    function walk(rules, mediaText) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.type === 1 && r.selectorText && r.selectorText.indexOf(':hover') !== -1) {
          var sel = r.selectorText.replace(/:hover/g, '[data-tm-hold]');
          var body = sel + '{' + r.style.cssText + '}';
          out.push(mediaText ? '@media ' + mediaText + '{' + body + '}' : body);
        } else if (r.cssRules && (r.type === 4 || r.type === 12)) {
          walk(r.cssRules, r.type === 4 ? (r.conditionText || r.media.mediaText) : mediaText);
        }
      }
    }
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      if (sheet.ownerNode && isOurs(sheet.ownerNode)) continue;
      if (sheet.href && /\/review\.css(\?|$)/.test(sheet.href)) continue;
      try { walk(sheet.cssRules, null); } catch (e) { /* cross-origin sheet: skip */ }
    }
    var style = document.createElement('style'); // no data-tm: screenshots must keep the held state
    style.id = 'tm-hold-sheet';
    style.textContent = out.join('\n');
    document.head.appendChild(style);
    S.holdSheet = style;
  }
  function holdHover() {
    buildHoldSheet();
    var nodes = Array.prototype.filter.call(document.querySelectorAll(':hover'), function (n) { return n !== document.documentElement && n !== document.body && !isOurs(n); });
    if (!nodes.length) { toast('Move the pointer over the menu or element first, then press H.', 'error', 3500); return; }
    releaseHold();
    applyHold(nodes, false);
    toast('Hover state held. Mark it with a tool; press H to release.', 'success', 3500);
  }
  function applyHold(nodes, fromAnnotation) {
    nodes.forEach(function (n) { n.setAttribute('data-tm-hold', ''); });
    S.hold = { nodes: nodes, selectors: nodes.map(buildSelector).slice(0, 12), fromAnnotation: !!fromAnnotation };
    var b = S.nodes.holdBtn; if (b) b.setAttribute('aria-pressed', 'true');
    scheduleRelayout(); setTimeout(renderMarkers, 500); // again after CSS transitions settle
  }
  function releaseHold() {
    if (!S.hold) return;
    S.hold.nodes.forEach(function (n) { n.removeAttribute('data-tm-hold'); });
    S.hold = null;
    var b = S.nodes.holdBtn; if (b) b.setAttribute('aria-pressed', 'false');
    scheduleRelayout(); setTimeout(renderMarkers, 500);
  }
  // Re-create the hover state an annotation was made in (or release it).
  function syncHeldState() {
    var a = S.selectedId ? byId(S.selectedId) : null;
    var held = a && a.target && a.target.state && a.target.state.held;
    if (held && held.length) {
      buildHoldSheet();
      var nodes = [];
      held.forEach(function (sel) { try { var n = document.querySelector(sel); if (n) nodes.push(n); } catch (e) {} });
      if (S.hold && S.hold.fromAnnotation) releaseHold();
      if (nodes.length && !S.hold) applyHold(nodes, true);
    } else if (S.hold && S.hold.fromAnnotation) {
      releaseHold();
    }
  }
  function envContext() {
    return {
      viewport: {
        width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1,
        breakpoint: currentBreakpoint(), preset: S.frame ? (S.frame.custom ? String(S.frame.width) : S.frame.name) : null,
        userAgent: cap(navigator.userAgent, 160), touch: !!(navigator.maxTouchPoints > 0),
      },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    };
  }
  // Resolve stored geometry to document pixels (relative to anchor if it still exists).
  function resolveGeometry(g) {
    var anchor = null;
    try { anchor = g.selector ? document.querySelector(g.selector) : null; } catch (e) {}
    var box = anchor && anchor.getBoundingClientRect().width > 0 ? docBox(anchor) : null;
    var abs = g.absolute || { x: 0, y: 0, w: 0, h: 0 };
    if (g.kind === 'pin') {
      return box ? { kind: 'pin', x: box.x + g.x * box.w, y: box.y + g.y * box.h, anchored: true } : { kind: 'pin', x: abs.x, y: abs.y, anchored: false };
    }
    if (g.kind === 'element') {
      return box ? { kind: 'element', x: box.x, y: box.y, w: box.w, h: box.h, anchored: true } : { kind: 'element', x: abs.x, y: abs.y, w: abs.w, h: abs.h, anchored: false };
    }
    if (g.kind === 'draw') {
      var pts = box ? g.points.map(function (p) { return [box.x + p[0] * box.w, box.y + p[1] * box.h]; })
                    : g.points.map(function (p) { return [abs.x + p[0] * abs.w, abs.y + p[1] * abs.h]; });
      var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
      return { kind: 'draw', points: pts, x: Math.min.apply(null, xs), y: Math.min.apply(null, ys), w: Math.max.apply(null, xs) - Math.min.apply(null, xs), h: Math.max.apply(null, ys) - Math.min.apply(null, ys), anchored: !!box };
    }
    return box ? { kind: g.kind, x: box.x + g.x * box.w, y: box.y + g.y * box.h, w: g.w * box.w, h: g.h * box.h, anchored: true }
               : { kind: g.kind, x: abs.x, y: abs.y, w: abs.w, h: abs.h, anchored: false };
  }

  // =========================================================================
  // Screenshot (best effort; never blocks posting)
  // =========================================================================
  function captureScreenshot(rect) {
    return loadScript(HTML2CANVAS_CDN).then(function () {
      // Render the whole page at 1x and crop ourselves: html2canvas's own x/y
      // crop mode drops backgrounds of transformed elements (e.g. dropdowns).
      return window.html2canvas(document.body, {
        scale: 1, useCORS: true, allowTaint: false, logging: false, backgroundColor: '#ffffff',
        ignoreElements: function (node) { return node.hasAttribute && node.hasAttribute('data-tm'); },
      });
    }).then(function (full) {
      var pad = 28;
      var x = Math.max(0, Math.round(rect.x - pad)), y = Math.max(0, Math.round(rect.y - pad));
      var w = Math.max(220, Math.round(rect.w + pad * 2)), h = Math.max(140, Math.round(rect.h + pad * 2));
      w = Math.min(w, LIMITS.shotMax, full.width - x); h = Math.min(h, 1000, full.height - y);
      if (w <= 0 || h <= 0) return null;
      var out = document.createElement('canvas');
      var scale = Math.min(1.5, window.devicePixelRatio || 1);
      out.width = Math.round(w * scale); out.height = Math.round(h * scale);
      out.getContext('2d').drawImage(full, x, y, w, h, 0, 0, out.width, out.height);
      return new Promise(function (resolve) { out.toBlob(function (b) { resolve(b ? { blob: b, dataUrl: out.toDataURL('image/jpeg', 0.8) } : null); }, 'image/jpeg', 0.82); });
    }).catch(function (err) { console.warn('[review] screenshot skipped:', err && err.message); return null; });
  }

  // =========================================================================
  // Stores
  // =========================================================================
  function rowToAnnotation(row) {
    return {
      id: row.id, site: row.site || null, page: row.page, url: row.url, title: row.title, type: row.type,
      geometry: row.geometry, viewport: row.viewport, scroll: row.scroll, target: row.target,
      scope: row.scope || 'page', component: row.component || null, category: row.category || null, devices: row.devices || [],
      comment: row.comment, author: row.author, authorId: row.author_id, status: row.status, resolution: row.resolution || null,
      resolvedAt: row.resolved_at, resolvedBy: row.resolved_by, verifiedAt: row.verified_at || null, verifiedBy: row.verified_by || null,
      editedAt: row.edited_at || null, editedBy: row.edited_by || null, build: row.build,
      events: (row.annotation_events || []).map(function (e) { return { id: e.id, actor: e.actor, kind: e.kind, changes: e.changes, at: e.at }; }).sort(function (a, b) { return a.at < b.at ? -1 : 1; }),
      screenshotPath: row.screenshot_path, createdAt: row.created_at, updatedAt: row.updated_at,
      replies: (row.annotation_replies || []).map(function (r) {
        return { id: r.id, annotationId: r.annotation_id, author: r.author, authorId: r.author_id, body: r.body, createdAt: r.created_at, editedAt: r.edited_at || null };
      }).sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; }),
    };
  }

  function SupabaseStore(client, site) {
    // Every row belongs to a site (config.site); the database policies check it
    // too, so this is for correctness and indexes, not for security.
    var shotKey = function (a) { return site + '/' + a.page.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') + '/' + a.id + '.jpg'; };
    function check(res) { if (res.error) throw new Error(res.error.message || 'Database error'); return res.data; }
    return {
      // This page's own comments, plus component/site-wide comments made anywhere.
      listForPage: function (page) {
        var sel = '*, annotation_replies(*), annotation_events(*)';
        return Promise.all([
          client.from('annotations').select(sel).eq('site', site).eq('page', page).eq('scope', 'page').then(check),
          client.from('annotations').select(sel).eq('site', site).in('scope', ['component', 'site']).then(check),
        ]).then(function (parts) {
          var seen = {}, rows = [];
          parts[0].concat(parts[1]).forEach(function (r) { if (!seen[r.id]) { seen[r.id] = true; rows.push(r); } });
          rows.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; });
          return rows.map(rowToAnnotation);
        });
      },
      create: function (input) {
        return client.from('annotations').insert({
          site: site, page: input.page, url: input.url, title: input.title, type: input.type, geometry: input.geometry,
          viewport: input.viewport, scroll: input.scroll, target: input.target, comment: input.comment,
          scope: input.scope || 'page', component: input.component || null, category: input.category || null, devices: input.devices || [],
          author: input.author, build: input.build, status: 'open',
        }).select('*, annotation_replies(*)').single().then(check).then(rowToAnnotation);
      },
      update: function (id, patch) { return client.from('annotations').update(patch).eq('id', id).then(check); },
      reply: function (annotationId, body) {
        return client.from('annotation_replies').insert({ annotation_id: annotationId, author: S.user, body: body }).select().single().then(check);
      },
      setStatus: function (id, status, resolution) {
        return client.from('annotations').update({ status: status, resolution: status === 'resolved' ? (resolution || 'addressed') : null }).eq('id', id).then(check);
      },
      updateReply: function (replyId, body) { return client.from('annotation_replies').update({ body: body }).eq('id', replyId).then(check); },
      removeReply: function (replyId) { return client.from('annotation_replies').delete().eq('id', replyId).then(check); },
      role: function () { return client.rpc('review_role', { site_id: site }).then(function (res) { return res.error ? 'reviewer' : (res.data || 'reviewer'); }); },
      remove: function (id) { return client.from('annotations').delete().eq('id', id).then(check); },
      uploadScreenshot: function (a, blob) {
        var path = shotKey(a);
        return client.storage.from('review-screenshots').upload(path, blob, { contentType: 'image/jpeg', upsert: true })
          .then(check).then(function () { return client.from('annotations').update({ screenshot_path: path }).eq('id', a.id).then(check); })
          .then(function () { return path; });
      },
      screenshotUrl: function (path) {
        return client.storage.from('review-screenshots').createSignedUrl(path, 3600).then(function (res) { return res.data ? res.data.signedUrl : null; });
      },
      requestChange: function (annotationId, instruction) {
        var a = byId(annotationId);
        return client.from('change_requests').insert({
          annotation_id: annotationId, instruction: instruction, requested_by: { email: S.user.email, name: S.user.name },
          page_context: a ? { page: a.page, url: a.url, title: a.title, target: a.target, geometry: a.geometry, build: a.build, comment: a.comment, replies: a.replies } : null,
        }).select().single().then(check);
      },
      subscribe: function (page, onChange) {
        // One filter per subscription: any change on this site reloads the page's
        // list (cheap at review scale). RLS still decides what is delivered.
        var ch = client.channel('review:' + site + ':' + page)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'annotations', filter: 'site=eq.' + site }, onChange)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'annotation_replies' }, onChange)
          .subscribe();
        return function () { try { client.removeChannel(ch); } catch (e) {} };
      },
    };
  }

  // Browser-local store for UI development without a backend (REVIEW_LOCAL_MODE=true).
  function LocalStore() {
    var KEY = 'tm:annotations';
    function read() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
    function write(list) { localStorage.setItem(KEY, JSON.stringify(list)); window.dispatchEvent(new CustomEvent('tm:local-change')); }
    function logEv(a, kind, changes) { a.events = a.events || []; a.events.push({ id: uid(), actor: { email: S.user.email, name: S.user.name }, kind: kind, changes: changes || null, at: new Date().toISOString() }); a.updatedAt = new Date().toISOString(); }
    function find(list, id) { return list.filter(function (x) { return x.id === id; })[0]; }
    return {
      role: function () { return Promise.resolve('maintainer'); },
      updateReply: function (replyId, body) { var list = read(); list.forEach(function (a) { (a.replies || []).forEach(function (r) { if (r.id === replyId) { r.body = body; r.editedAt = new Date().toISOString(); logEv(a, 'reply_edited', { replyId: replyId }); } }); }); write(list); return Promise.resolve(); },
      removeReply: function (replyId) { var list = read(); list.forEach(function (a) { var before = (a.replies || []).length; a.replies = (a.replies || []).filter(function (r) { return r.id !== replyId; }); if (a.replies.length !== before) logEv(a, 'reply_deleted', { replyId: replyId }); }); write(list); return Promise.resolve(); },
      listForPage: function (page) { return Promise.resolve(read().filter(function (a) { return a.page === page || (a.scope && a.scope !== 'page'); })); },
      create: function (input) {
        var now = new Date().toISOString();
        var a = Object.assign({}, input, { id: uid(), authorId: 'local', createdAt: now, updatedAt: now, replies: [], events: [], status: 'open', resolution: null, resolvedAt: null, resolvedBy: null, verifiedAt: null, verifiedBy: null, editedAt: null, editedBy: null, screenshotPath: null });
        logEv(a, 'created');
        var list = read(); list.push(a); write(list); return Promise.resolve(a);
      },
      reply: function (id, body) {
        var list = read(), a = list.filter(function (x) { return x.id === id; })[0];
        var r = { id: uid(), annotationId: id, author: S.user, authorId: 'local', body: body, createdAt: new Date().toISOString() };
        if (a) { a.replies.push(r); logEv(a, 'replied', { replyId: r.id }); write(list); }
        return Promise.resolve(r);
      },
      update: function (id, patch) {
        var list = read(), a = find(list, id); if (!a) return Promise.resolve();
        var meta = {}, moved = false;
        Object.keys(patch).forEach(function (k) {
          var before = JSON.stringify(a[k] == null ? null : a[k]), after = JSON.stringify(patch[k] == null ? null : patch[k]);
          if (before === after) return;
          if (k === 'comment') logEv(a, 'edited', { comment: { from: a.comment, to: patch.comment } });
          else if (k === 'type' || k === 'geometry') moved = true;
          else if (k === 'scope' || k === 'component' || k === 'category' || k === 'devices') meta[k] = { from: a[k], to: patch[k] };
          a[k] = patch[k];
        });
        if (moved) logEv(a, 'moved', { type: { to: a.type }, selector: { to: a.target && a.target.selector } });
        if (Object.keys(meta).length) logEv(a, 'metadata', meta);
        if (patch.comment != null) { a.editedAt = new Date().toISOString(); a.editedBy = S.user; }
        write(list); return Promise.resolve();
      },
      setStatus: function (id, status, resolution) {
        var list = read(), a = find(list, id); if (!a) return Promise.resolve();
        var from = a.status; a.status = status;
        if (status === 'resolved') { a.resolution = resolution || 'addressed'; a.resolvedAt = new Date().toISOString(); a.resolvedBy = S.user; }
        else { a.resolution = null; a.resolvedAt = null; a.resolvedBy = null; }
        if (status === 'verified') { a.verifiedAt = new Date().toISOString(); a.verifiedBy = S.user; }
        if (status === 'open') { a.verifiedAt = null; a.verifiedBy = null; }
        logEv(a, status === 'verified' ? 'verified' : status === 'resolved' ? 'resolved' : 'reopened', { status: { from: from, to: status }, resolution: a.resolution });
        write(list); return Promise.resolve();
      },
      remove: function (id) { write(read().filter(function (a) { return a.id !== id; })); try { localStorage.removeItem('tm:shot:' + id); } catch (e) {} return Promise.resolve(); },
      uploadScreenshot: function (a, blob, dataUrl) {
        try { localStorage.setItem('tm:shot:' + a.id, dataUrl); } catch (e) { return Promise.resolve(null); }
        var list = read(); list.forEach(function (x) { if (x.id === a.id) x.screenshotPath = 'local:' + a.id; }); write(list);
        return Promise.resolve('local:' + a.id);
      },
      screenshotUrl: function (path) { return Promise.resolve(localStorage.getItem('tm:shot:' + path.replace(/^local:/, '')) || null); },
      requestChange: function () { return Promise.reject(new Error('Change requests need the Supabase backend')); },
      subscribe: function (page, onChange) {
        var h = function () { onChange(); };
        window.addEventListener('storage', h); window.addEventListener('tm:local-change', h);
        return function () { window.removeEventListener('storage', h); window.removeEventListener('tm:local-change', h); };
      },
    };
  }

  // =========================================================================
  // Auth
  // =========================================================================
  var sb = null;
  function userFromSession(session) {
    var u = session.user, m = u.user_metadata || {};
    return { email: u.email, name: m.full_name || m.name || (u.email || '').split('@')[0], avatar: m.avatar_url || m.picture || null };
  }
  function cleanUrl() {
    var u = new URL(location.href);
    u.hash = ''; u.searchParams.delete('code'); u.searchParams.delete('error'); u.searchParams.delete('error_description');
    return u.toString();
  }
  function authenticate() {
    var cfg = S.config;
    if (cfg.mode === 'local') {
      var name = null;
      try { name = localStorage.getItem('tm:localName'); } catch (e) {}
      S.user = { email: 'local-reviewer@example.invalid', name: name || 'Local reviewer', avatar: null };
      S.store = LocalStore();
      S.role = 'maintainer';
      return Promise.resolve(true);
    }
    return loadScript(SUPABASE_CDN).then(function () {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
      return sb.auth.getSession();
    }).then(function (res) {
      if (/(^|[&#])access_token=|[?&]code=/.test(location.hash + location.search)) history.replaceState(null, '', cleanUrl());
      var session = res.data && res.data.session;
      if (!session) return showSignIn();
      return authorize(session);
    });
  }
  function authorize(session) {
    S.user = userFromSession(session);
    return sb.rpc('review_is_authorized', { site_id: S.config.site }).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      if (!res.data) return showNotAuthorized();
      S.store = SupabaseStore(sb, S.config.site);
      sb.auth.onAuthStateChange(function (event) { if (event === 'SIGNED_OUT') exit(); });
      return S.store.role().then(function (r) { S.role = r; return true; });
    });
  }
  function showSignIn() {
    return new Promise(function (resolve) {
      var hint = S.config.allowedDomainHint ? 'Use your @' + S.config.allowedDomainHint + ' Google account, or a Gmail address that has been added to the reviewer list.' : 'Use the Google account that has been added to the reviewer list.';
      var modal = mountModal('Sign in to review', 'Comments and annotations are only visible to authorized reviewers. ' + hint, [
        googleButton(function () {
          try { sessionStorage.setItem('tmReviewMode', '1'); } catch (e) {}
          if (S.frame) { exitFrame(); return; } // Google refuses to sign in inside an iframe; sign in at top level, then reopen the frame
          sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: cleanUrl(), queryParams: { prompt: 'select_account' } } })
            .then(function (res) { if (res.error) toast(res.error.message, 'error'); });
        }),
        el('button', { class: 'tm-btn tm-btn--quiet', type: 'button', text: 'Cancel', onClick: function () { modal.remove(); resolve(false); } }),
      ]);
    });
  }
  function showNotAuthorized() {
    return new Promise(function (resolve) {
      var modal = mountModal('Not on the reviewer list', 'You are signed in as ' + S.user.email + ', but that account is not authorized to review ' + (S.config.siteName || 'this site') + '. Ask the project owner to add it to the reviewer list for this site, or use an account on the organisation\'s domain.', [
        el('button', { class: 'tm-btn', type: 'button', text: 'Sign out and try another account', onClick: function () { sb.auth.signOut().then(function () { modal.remove(); resolve(false); }); } }),
        el('button', { class: 'tm-btn tm-btn--quiet', type: 'button', text: 'Close', onClick: function () { modal.remove(); resolve(false); } }),
      ]);
    });
  }
  function googleButton(onClick) {
    var b = el('button', { class: 'tm-btn tm-google', type: 'button', onClick: onClick });
    var ns = 'http://www.w3.org/2000/svg';
    var g = document.createElementNS(ns, 'svg'); g.setAttribute('viewBox', '0 0 48 48'); g.setAttribute('aria-hidden', 'true');
    [['#EA4335', 'M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z'],
     ['#4285F4', 'M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z'],
     ['#FBBC05', 'M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.1z'],
     ['#34A853', 'M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.6-5.9c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z']
    ].forEach(function (p) { var path = document.createElementNS(ns, 'path'); path.setAttribute('fill', p[0]); path.setAttribute('d', p[1]); g.appendChild(path); });
    b.appendChild(g); b.appendChild(document.createTextNode('Continue with Google'));
    return b;
  }
  function mountModal(title, text, buttons) {
    var dialog = el('div', { class: 'tm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tm-dialog-title' }, [
      el('div', { class: 'tm-kicker', text: 'TexoModo' }),
      el('h2', { id: 'tm-dialog-title', text: title }),
      el('p', { text: text }),
      el('div', { class: 'tm-actions' }, buttons),
    ]);
    var modal = el('div', { id: 'tm-modal' }, [dialog]);
    modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var cancel = buttons[buttons.length - 1]; cancel && cancel.click(); } });
    UI.doc.body.appendChild(modal);
    setTimeout(function () { buttons[0] && buttons[0].focus(); }, 0);
    return modal;
  }

  // =========================================================================
  // Mount / unmount UI
  // =========================================================================
  function mountChrome() {
    S.nodes.toasts = el('div', { id: 'tm-toasts', role: 'status', 'aria-live': 'polite' });
    UI.doc.body.appendChild(S.nodes.toasts);
  }
  function mountOverlay() {
    var layer = el('div', { id: 'tm-layer' });
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg'); svg.id = 'tm-svg'; svg.setAttribute('data-tm', '');
    layer.appendChild(svg);
    document.body.appendChild(layer);
    S.nodes.layer = layer; S.nodes.svg = svg;
    layer.addEventListener('pointerdown', onPointerDown);
    layer.addEventListener('pointermove', onPointerMove);
    layer.addEventListener('pointerup', onPointerUp);
    layer.addEventListener('pointercancel', cancelDrawing);
    sizeLayer();

    var tb = el('div', { id: 'tm-toolbar', role: 'toolbar', 'aria-label': 'Review tools' });
    tb.classList.toggle('tm-advanced', S.advanced);
    // One pill, styled like the View select: shows the current tool, opens a menu of tools.
    var split = el('div', { class: 'tm-split' });
    var mainBtn = el('button', { class: 'tm-tool tm-split-main', type: 'button', 'aria-pressed': 'false', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Comment tool', onClick: function () { menu.hidden ? openMenu() : closeMenu(); } },
      [svgIcon(ICONS[S.lastTool]), el('span', { class: 'tm-label', text: TOOLS[S.lastTool] }), svgIcon(ICONS.chevron)]);
    var menu = el('div', { class: 'tm-menu', role: 'menu', 'aria-label': 'Comment tools', hidden: true });
    Object.keys(TOOLS).forEach(function (key) {
      menu.appendChild(el('button', { class: 'tm-menu-item', type: 'button', role: 'menuitemradio', 'data-tool': key, 'aria-checked': 'false', onClick: function () { closeMenu(); setTool(key); } },
        [svgIcon(ICONS[key]), el('span', { text: TOOLS[key] })]));
    });
    var stopItem = el('button', { class: 'tm-menu-item tm-menu-item--stop', type: 'button', role: 'menuitem', hidden: true, onClick: function () { closeMenu(); setTool(null); } }, [svgIcon(ICONS.close), el('span', { text: 'Stop commenting' })]);
    menu.appendChild(stopItem);
    function menuItems() { return Array.prototype.filter.call(menu.children, function (n) { return !n.hidden; }); }
    function openMenu() { menu.hidden = false; mainBtn.setAttribute('aria-expanded', 'true'); var cur = menu.querySelector('[aria-checked="true"]') || menu.firstElementChild; if (cur) cur.focus(); UI.doc.addEventListener('pointerdown', outside, true); }
    function closeMenu() { if (menu.hidden) return; menu.hidden = true; mainBtn.setAttribute('aria-expanded', 'false'); UI.doc.removeEventListener('pointerdown', outside, true); }
    function outside(e) { if (!split.contains(e.target)) closeMenu(); }
    menu.addEventListener('keydown', function (e) {
      var items = menuItems(), i = items.indexOf(UI.doc.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); mainBtn.focus(); }
    });
    split.appendChild(mainBtn); split.appendChild(menu);
    tb.appendChild(split);
    S.nodes.toolMain = mainBtn; S.nodes.toolMenu = menu; S.nodes.toolStop = stopItem;
    var bp = detectBreakpoints();
    var viewSel = el('select', { class: 'tm-tool-select', 'aria-label': 'View the page at a device width', title: 'Device frame: render the page at a fixed width so breakpoints behave like that device', onChange: function (e) { rememberViewChoice(e.target.value ? null : 'window'); requestView(e.target.value); } });
    viewSel.appendChild(el('option', { value: '', text: 'Actual window' }));
    bp.names.forEach(function (n) { viewSel.appendChild(el('option', { value: n, text: cap1(n) + ' ' + bp.presets[n] })); });
    if (S.frame && S.frame.custom) viewSel.appendChild(el('option', { value: String(S.frame.width), text: 'Custom ' + S.frame.width }));
    viewSel.value = S.frame ? (S.frame.custom ? String(S.frame.width) : S.frame.name) : '';
    S.nodes.viewSel = viewSel;
    tb.appendChild(viewSel);
    S.nodes.holdBtn = el('button', { class: 'tm-tool', type: 'button', 'aria-pressed': 'false', title: 'Hold the current hover state, e.g. an open menu (H)', onClick: function () { S.hold ? releaseHold() : holdHover(); } },
      [svgIcon(ICONS.hold), el('span', { class: 'tm-label', text: 'Hold hover' })]);
    tb.appendChild(S.nodes.holdBtn);
    tb.appendChild(el('span', { class: 'tm-sep' }));
    S.nodes.commentsBtn = el('button', { class: 'tm-tool', type: 'button', 'aria-pressed': 'false', 'aria-controls': 'tm-drawer', title: 'Show comments for this page', onClick: function () { toggleDrawer(); } },
      [svgIcon(ICONS.comments), el('span', { class: 'tm-label', text: 'Comments' }), el('span', { class: 'tm-badge', text: '0' })]);
    tb.appendChild(S.nodes.commentsBtn);
    tb.appendChild(el('button', { class: 'tm-tool tm-tool--exit', type: 'button', title: 'Exit review mode', onClick: exit }, [svgIcon(ICONS.exit), el('span', { class: 'tm-label', text: 'Exit' })]));
    UI.doc.body.appendChild(tb);
    S.nodes.toolbar = tb;

    var drawer = el('aside', { id: 'tm-drawer', class: S.advanced ? 'tm-advanced' : '', role: 'dialog', 'aria-label': 'Review comments', 'aria-modal': 'false' });
    UI.doc.body.appendChild(drawer);
    S.nodes.drawer = drawer;
    renderDrawer();

    document.addEventListener('keydown', onKeyDown, true);
    if (UI.doc !== document) {
      UI.doc.addEventListener('keydown', onKeyDown, true);
      // The frame is navigating away: take our UI out of the shell; the next page mounts its own.
      window.addEventListener('pagehide', removeUi);
    }
    window.addEventListener('resize', scheduleRelayout);
    window.addEventListener('load', scheduleRelayout);
    if (window.ResizeObserver) { S.ro = new ResizeObserver(scheduleRelayout); S.ro.observe(document.body); }
  }
  function sizeLayer() {
    var d = document.documentElement;
    var w = Math.max(d.scrollWidth, d.clientWidth), h = Math.max(d.scrollHeight, d.clientHeight);
    S.nodes.layer.style.width = w + 'px'; S.nodes.layer.style.height = h + 'px';
    S.nodes.svg.setAttribute('width', w); S.nodes.svg.setAttribute('height', h);
  }
  function scheduleRelayout() { clearTimeout(S.resizeTimer); S.resizeTimer = setTimeout(function () { sizeLayer(); renderMarkers(); }, 120); }

  // =========================================================================
  // Tools and drawing
  // =========================================================================
  function setTool(tool) {
    S.tool = tool;
    var layer = S.nodes.layer;
    layer.className = tool ? 'tm-layer--active tm-tool-' + tool : '';
    if (tool !== 'inspect') hideInspect();
    if (!tool && S.retarget) { S.retarget = null; renderDrawer(); }
    if (tool && TOOLS[tool]) S.lastTool = tool;
    var main = S.nodes.toolMain;
    if (main) {
      main.setAttribute('aria-pressed', tool ? 'true' : 'false');
      while (main.firstChild) main.removeChild(main.firstChild);
      main.appendChild(svgIcon(ICONS[S.lastTool])); main.appendChild(el('span', { class: 'tm-label', text: TOOLS[S.lastTool] })); main.appendChild(svgIcon(ICONS.chevron));
    }
    if (S.nodes.toolStop) S.nodes.toolStop.hidden = !tool;
    if (S.nodes.toolMenu) S.nodes.toolMenu.querySelectorAll('[data-tool]').forEach(function (b) { b.setAttribute('aria-checked', b.getAttribute('data-tool') === tool ? 'true' : 'false'); });
    if (tool) toast(tool === 'pin' ? 'Click the page where you want to comment.' : tool === 'inspect' ? 'Hover to outline an element, \u2191/\u2193 to widen or narrow, click to pick it.' : 'Drag on the page to mark a region. Esc cancels.', null, 3000);
  }
  function onPointerDown(e) {
    if (!S.tool || e.button !== 0 && e.pointerType === 'mouse') return;
    if (S.tool === 'inspect') { S.inspectDown = { x: e.clientX, y: e.clientY }; return; }
    if (S.draft) cancelDraft();
    var target = pageElementAt(e.clientX, e.clientY);
    var pt = { x: e.pageX, y: e.pageY };
    if (S.tool === 'pin') { finishPin(target, pt); return; }
    e.preventDefault();
    S.drawing = { startEl: target, start: pt, points: [[pt.x, pt.y]], node: null };
    try { S.nodes.layer.setPointerCapture(e.pointerId); } catch (err) {}
  }
  function onPointerMove(e) {
    S.lastPointer = { x: e.clientX, y: e.clientY };
    if (S.tool === 'inspect') { updateInspect(e); return; }
    var d = S.drawing; if (!d) return;
    e.preventDefault();
    var pt = { x: e.pageX, y: e.pageY };
    var ns = 'http://www.w3.org/2000/svg';
    if (S.tool === 'draw') {
      d.points.push([pt.x, pt.y]);
      if (!d.node) { d.node = document.createElementNS(ns, 'polyline'); d.node.setAttribute('class', 'tm-shape tm-shape--draft'); S.nodes.svg.appendChild(d.node); }
      d.node.setAttribute('points', d.points.map(function (p) { return p.join(','); }).join(' '));
      return;
    }
    var r = normRect(d.start, pt);
    if (!d.node) { d.node = document.createElementNS(ns, S.tool === 'circle' ? 'ellipse' : 'rect'); d.node.setAttribute('class', 'tm-shape tm-shape--draft'); S.nodes.svg.appendChild(d.node); }
    setShapeAttrs(d.node, S.tool, r);
  }
  function onPointerUp(e) {
    if (S.tool === 'inspect') {
      var down = S.inspectDown; S.inspectDown = null;
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
      if (S.draft) cancelDraft();
      finishInspect(S.inspect && S.inspect.el ? S.inspect.el : pageElementAt(e.clientX, e.clientY));
      return;
    }
    var d = S.drawing; if (!d) return;
    S.drawing = null;
    try { S.nodes.layer.releasePointerCapture(e.pointerId); } catch (err) {}
    var pt = { x: e.pageX, y: e.pageY };
    var rect = S.tool === 'draw' ? bboxOf(d.points) : normRect(d.start, pt);
    if (d.node) d.node.remove();
    if (rect.w < 6 && rect.h < 6) { if (S.tool !== 'draw') finishPin(d.startEl, d.start); return; }
    finishShape(d, rect);
  }
  function cancelDrawing() { if (S.drawing && S.drawing.node) S.drawing.node.remove(); S.drawing = null; }
  function normRect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
  function bboxOf(points) {
    var xs = points.map(function (p) { return p[0]; }), ys = points.map(function (p) { return p[1]; });
    var x = Math.min.apply(null, xs), y = Math.min.apply(null, ys);
    return { x: x, y: y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
  }
  function setShapeAttrs(node, kind, r) {
    if (kind === 'circle') { node.setAttribute('cx', r.x + r.w / 2); node.setAttribute('cy', r.y + r.h / 2); node.setAttribute('rx', r.w / 2); node.setAttribute('ry', r.h / 2); }
    else { node.setAttribute('x', r.x); node.setAttribute('y', r.y); node.setAttribute('width', r.w); node.setAttribute('height', r.h); node.setAttribute('rx', 3); }
  }
  function currentSelection() { var s = window.getSelection(); return s && !s.isCollapsed ? s.toString() : null; }

  function finishPin(target, pt) {
    var anchor = target || document.body, box = docBox(anchor);
    var geometry = { kind: 'pin', selector: buildSelector(anchor), x: box.w ? (pt.x - box.x) / box.w : 0, y: box.h ? (pt.y - box.y) / box.h : 0, absolute: { x: pt.x, y: pt.y, w: 0, h: 0 } };
    openComposer('pin', geometry, captureTarget(anchor, currentSelection()), { x: pt.x - 60, y: pt.y - 40, w: 120, h: 80 }, anchor);
  }
  function finishShape(d, rect) {
    var anchor = pickAnchor(d.startEl, rect), box = docBox(anchor);
    var fx = function (x) { return box.w ? (x - box.x) / box.w : 0; }, fy = function (y) { return box.h ? (y - box.y) / box.h : 0; };
    var geometry;
    if (S.tool === 'draw') geometry = { kind: 'draw', selector: buildSelector(anchor), points: d.points.map(function (p) { return [round4(fx(p[0])), round4(fy(p[1]))]; }), absolute: rect };
    else geometry = { kind: S.tool, selector: buildSelector(anchor), x: round4(fx(rect.x)), y: round4(fy(rect.y)), w: round4(rect.w / (box.w || 1)), h: round4(rect.h / (box.h || 1)), absolute: rect };
    // The most specific element under the shape's centre is the human-meaningful target.
    var centre = pageElementAt(rect.x + rect.w / 2 - window.scrollX, rect.y + rect.h / 2 - window.scrollY);
    var targetEl = centre && anchor.contains(centre) ? centre : anchor;
    openComposer(S.tool, geometry, captureTarget(targetEl, currentSelection()), rect, targetEl);
  }
  function round4(n) { return Math.round(n * 10000) / 10000; }

  // =========================================================================
  // Composer (draft annotation)
  // =========================================================================
  // Re-anchor an existing comment with any tool, keeping its text and thread.
  function startRetarget(id, tool) { S.retarget = { id: id, tool: tool }; if (S.draft) cancelDraft(); setTool(tool); renderDrawer(); toast('Mark the new location with the ' + TOOLS[tool] + ' tool.', null, 3000); }
  function cancelRetarget() { S.retarget = null; setTool(null); renderDrawer(); }
  function applyRetarget(type, geometry, target, shotRect) {
    var id = S.retarget.id, a = byId(id); S.retarget = null; setTool(null);
    if (!a) return;
    S.store.update(id, { type: type, geometry: geometry, target: target }).then(function () {
      toast('Comment moved.', 'success');
      return reload().then(function () { select(id, { scroll: false }); });
    }).then(function () {
      return captureScreenshot(shotRect).then(function (shot) { var b = byId(id); if (shot && b) return S.store.uploadScreenshot(b, shot.blob, shot.dataUrl).then(function () { delete S.shotUrls[b.screenshotPath]; return reload(); }); });
    }).catch(function (err) { toast('Could not move: ' + err.message, 'error', 5000); });
  }
  function openComposer(type, geometry, target, shotRect, node) {
    if (S.retarget) { applyRetarget(type, geometry, target, shotRect); return; }
    var env = envContext(), inferred = inferScope(node);
    S.draft = {
      type: type, geometry: geometry, target: target, viewport: env.viewport, scroll: env.scroll, comment: '', shot: null, shotPending: true,
      el: node || null, scope: inferred.scope, component: inferred.component, category: inferCategory(node), duplicates: findDuplicates(target),
      devices: defaultDevices(target && target.visibleAt),
    };
    setTool(null);
    S.selectedId = null;
    renderMarkers(); renderDrawer();
    openDrawer(true);
    captureDraftShot(shotRect);
  }
  function captureDraftShot(shotRect) {
    var draft = S.draft;
    captureScreenshot(shotRect).then(function (shot) {
      if (S.draft !== draft) return;
      draft.shot = shot; draft.shotPending = false;
      var img = S.nodes.drawer.querySelector('#tm-draft-shot');
      if (img && shot) { img.src = shot.dataUrl; img.hidden = false; }
      var pend = S.nodes.drawer.querySelector('#tm-draft-shot-pending');
      if (pend) pend.textContent = shot ? '' : 'Screenshot unavailable (context below is still saved).';
    });
  }
  // Breadcrumb click: move the draft to an ancestor (or descendant) element.
  function retargetDraft(node) {
    var d = S.draft; if (!d) return;
    var ta = S.nodes.drawer.querySelector('#tm-draft-text'); if (ta) d.comment = ta.value;
    var inferred = inferScope(node);
    d.el = node; d.type = 'element'; d.geometry = elementGeometry(node); d.target = captureTarget(node, null);
    d.scope = inferred.scope; d.component = inferred.component; d.category = inferCategory(node); d.duplicates = findDuplicates(d.target);
    d.devices = defaultDevices(d.target.visibleAt);
    d.shot = null; d.shotPending = true;
    renderMarkers(); renderDrawer();
    var again = S.nodes.drawer.querySelector('#tm-draft-text'); if (again) again.focus({ preventScroll: true });
    captureDraftShot(docBox(node));
  }
  function cancelDraft() { S.draft = null; try { sessionStorage.removeItem('tm:draft'); } catch (e) {} renderMarkers(); renderDrawer(); }
  function postDraft() {
    var d = S.draft; if (!d) return;
    var text = (S.nodes.drawer.querySelector('#tm-draft-text') || {}).value || '';
    text = text.trim();
    if (!text) { toast('Write a comment first.', 'error'); return; }
    if (text.length > LIMITS.comment) { toast('Comment is too long.', 'error'); return; }
    var btn = S.nodes.drawer.querySelector('#tm-draft-post'); if (btn) btn.disabled = true;
    var input = {
      site: S.config.site || null, page: pagePath(), url: location.href.split('#')[0], title: document.title, type: d.type, geometry: d.geometry,
      viewport: d.viewport, scroll: d.scroll, target: d.target, comment: text, author: S.user, build: S.config.build || null,
      scope: d.scope || 'page', component: d.scope === 'component' ? d.component : null, category: d.category || null,
      devices: d.devices || [],
    };
    var shot = d.shot;
    S.store.create(input).then(function (a) {
      S.draft = null;
      S.annotations.push(a);
      S.selectedId = a.id;
      renderMarkers(); renderDrawer();
      toast('Comment posted.', 'success');
      if (shot) S.store.uploadScreenshot(a, shot.blob, shot.dataUrl).then(function (path) { if (path) { a.screenshotPath = path; renderDrawer(); } }).catch(function (err) { console.warn('[review] screenshot upload failed:', err && err.message); });
    }).catch(function (err) { if (btn) btn.disabled = false; toast('Could not post: ' + err.message, 'error', 5000); });
  }

  // =========================================================================
  // Data
  // =========================================================================
  function byId(id) { return S.annotations.filter(function (a) { return a.id === id; })[0] || null; }
  function reload() {
    return S.store.listForPage(pagePath()).then(function (list) {
      S.annotations = list;
      // Keep the selected thread visible after a status change.
      var sel = S.selectedId && byId(S.selectedId);
      if (sel && S.filter !== 'all' && (S.filter === 'resolved' ? sel.status !== 'resolved' : sel.status === 'resolved')) S.filter = 'all';
      renderMarkers(); renderDrawer();
    }).catch(function (err) { toast('Could not load comments: ' + err.message, 'error', 5000); });
  }
  function visibleAnnotations() {
    return S.annotations.filter(function (a) { return belongsHere(a) && (S.filter === 'all' || (S.filter === 'resolved' ? a.status === 'resolved' : a.status !== 'resolved')); });
  }

  // =========================================================================
  // Markers on the page
  // =========================================================================
  function renderMarkers() {
    var layer = S.nodes.layer, svg = S.nodes.svg;
    if (!layer) return;
    layer.querySelectorAll('.tm-marker').forEach(function (n) { n.remove(); });
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var ns = 'http://www.w3.org/2000/svg';
    S.annotations.forEach(function (a, i) {
      if (S.filter !== 'all' && (S.filter === 'resolved' ? a.status !== 'resolved' : a.status === 'resolved')) return;
      if (!belongsHere(a)) return; // from a branch this deploy does not contain
      var g = resolveGeometry(a.geometry);
      if (!g.anchored && a.page !== pagePath()) return; // made elsewhere and its element is not on this page
      if (!appliesHere(a)) return; // does not apply to this screen size; listed in the drawer only
      var cls = 'tm-shape' + (g.kind === 'element' ? ' tm-shape--element' : '') + (a.status === 'resolved' ? ' tm-shape--resolved' : '') + (a.id === S.selectedId ? ' tm-shape--selected' : '');
      var hiddenAnchor = false;
      try { var ae = a.geometry.selector ? document.querySelector(a.geometry.selector) : null; hiddenAnchor = !!(ae && !isVisible(ae)) && a.id !== S.selectedId; } catch (e) {}
      if (!hiddenAnchor && (g.kind === 'rectangle' || g.kind === 'circle' || g.kind === 'element')) { var sh = document.createElementNS(ns, g.kind === 'circle' ? 'ellipse' : 'rect'); sh.setAttribute('class', cls); setShapeAttrs(sh, g.kind, g); svg.appendChild(sh); }
      if (!hiddenAnchor && g.kind === 'draw') { var pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('class', cls); pl.setAttribute('points', g.points.map(function (p) { return p.join(','); }).join(' ')); svg.appendChild(pl); }
      var label = 'Comment ' + (i + 1) + ' by ' + (a.author && a.author.name || 'reviewer') + (a.status === 'resolved' ? ' (resolved)' : '') + ': ' + cap(a.comment, 80) + (hiddenAnchor ? ' (on a hover-only element; select to reveal)' : '');
      var m = el('button', { class: 'tm-marker' + (g.kind !== 'pin' ? ' tm-marker--shape' : '') + (a.status === 'resolved' ? ' tm-marker--resolved' : '') + (a.status === 'verified' ? ' tm-marker--verified' : '') + (a.id === S.selectedId ? ' tm-marker--selected' : '') + (hiddenAnchor ? ' tm-marker--ghost' : ''), type: 'button', 'data-id': a.id, 'aria-label': label, title: label, text: String(i + 1), onClick: function () { select(a.id, { scroll: false }); } });
      m.style.left = g.x + 'px'; m.style.top = g.y + 'px';
      layer.appendChild(m);
    });
    if (S.draft) {
      var dg = resolveGeometry(S.draft.geometry);
      if (dg.kind === 'rectangle' || dg.kind === 'circle' || dg.kind === 'element') { var ds = document.createElementNS(ns, dg.kind === 'circle' ? 'ellipse' : 'rect'); ds.setAttribute('class', 'tm-shape tm-shape--draft' + (dg.kind === 'element' ? ' tm-shape--element' : '')); setShapeAttrs(ds, dg.kind, dg); svg.appendChild(ds); }
      if (dg.kind === 'draw') { var dp = document.createElementNS(ns, 'polyline'); dp.setAttribute('class', 'tm-shape tm-shape--draft'); dp.setAttribute('points', dg.points.map(function (p) { return p.join(','); }).join(' ')); svg.appendChild(dp); }
      var dm = el('span', { class: 'tm-marker tm-marker--draft' + (dg.kind !== 'pin' ? ' tm-marker--shape' : ''), text: '+', 'aria-hidden': 'true' });
      dm.style.left = dg.x + 'px'; dm.style.top = dg.y + 'px';
      layer.appendChild(dm);
    }
    var badge = S.nodes.commentsBtn && S.nodes.commentsBtn.querySelector('.tm-badge');
    if (badge) badge.textContent = String(S.annotations.filter(function (a) { return a.status !== 'resolved' && belongsHere(a); }).length);
  }
  function select(id, opts) {
    opts = opts || {};
    var a = byId(id); if (!a) return;
    if (S.filter !== 'all' && (S.filter === 'resolved' ? a.status !== 'resolved' : a.status === 'resolved')) S.filter = 'all';
    S.selectedId = id;
    syncHeldState();
    renderMarkers(); renderDrawer();
    openDrawer(false);
    var g = resolveGeometry(a.geometry);
    if (opts.scroll !== false) {
      var top = g.y - window.innerHeight / 3;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    var m = S.nodes.layer.querySelector('.tm-marker[data-id="' + id + '"]');
    if (m) { m.classList.add('tm-marker--pulse'); setTimeout(function () { m.classList.remove('tm-marker--pulse'); }, 2600); }
    try {
      var t = a.target && a.target.selector ? document.querySelector(a.target.selector) : null;
      if (t) { t.classList.add('tm-target-glow'); setTimeout(function () { t.classList.remove('tm-target-glow'); }, 1800); }
    } catch (e) {}
    var card = S.nodes.drawer.querySelector('.tm-card[data-id="' + id + '"]');
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // =========================================================================
  // Drawer
  // =========================================================================
  function openDrawer(focusComposer, instant) {
    var wasOpen = S.drawerOpen;
    if (!wasOpen) S.lastFocus = document.activeElement;
    S.drawerOpen = true;
    if (instant) { // restoring after navigation: no slide-in
      S.nodes.drawer.classList.add('tm-no-anim');
      UI.doc.body.classList.add('tm-no-anim');
      setTimeout(function () { S.nodes.drawer.classList.remove('tm-no-anim'); UI.doc.body.classList.remove('tm-no-anim'); }, 50);
    }
    try { sessionStorage.setItem('tm:drawerOpen', '1'); } catch (e) {} // stays open across page navigation
    S.nodes.drawer.classList.add('tm-open');
    UI.doc.body.classList.add('tm-drawer-open');
    S.nodes.commentsBtn.setAttribute('aria-pressed', 'true');
    if (!wasOpen || focusComposer) setTimeout(function () {
      var target = focusComposer ? S.nodes.drawer.querySelector('#tm-draft-text') : S.nodes.drawer.querySelector('.tm-drawer-head h2');
      if (target) target.focus({ preventScroll: true });
    }, 60);
  }
  function closeDrawer() {
    S.drawerOpen = false;
    try { sessionStorage.removeItem('tm:drawerOpen'); } catch (e) {}
    S.nodes.drawer.classList.remove('tm-open');
    UI.doc.body.classList.remove('tm-drawer-open');
    S.nodes.commentsBtn.setAttribute('aria-pressed', 'false');
    try { S.nodes.commentsBtn.focus({ preventScroll: true }); } catch (e) {}
  }
  function toggleDrawer() { S.drawerOpen ? closeDrawer() : openDrawer(false); }

  function renderDrawer() {
    var drawer = S.nodes.drawer; if (!drawer) return;
    var scrollTop = (drawer.querySelector('.tm-body') || {}).scrollTop || 0;
    var active0 = uiActive();
    var activeId = active0 && drawer.contains(active0) ? active0.id : null;
    var ta0 = S.draft && drawer.querySelector('#tm-draft-text'); if (ta0) S.draft.comment = ta0.value;
    while (drawer.firstChild) drawer.removeChild(drawer.firstChild);

    var title = document.title.replace(/\s+[—–-]\s+All Saints.*$/i, '');
    var head = el('div', { class: 'tm-drawer-head' }, [
      el('div', { class: 'tm-head-row' }, [
        el('div', {}, [el('div', { class: 'tm-kicker', text: 'TexoModo' }), el('h2', { text: title, tabindex: '-1' }), el('div', { class: 'tm-path', text: pagePath() })]),
        el('button', { class: 'tm-icon-btn', type: 'button', 'aria-label': 'Close comments', onClick: closeDrawer }, [svgIcon(ICONS.close)]),
      ]),
      userRow(),
    ]);
    drawer.appendChild(head);

    var counts = { open: 0, resolved: 0, toVerify: 0 };
    var others = [];
    S.annotations.forEach(function (a) { if (!belongsHere(a)) { others.push(a); return; } if (a.status === 'resolved') counts.resolved++; else { counts.open++; if (a.status === 'open') counts.toVerify++; } });
    var tabs = el('div', { class: 'tm-tabs', role: 'tablist' });
    [['open', 'Open', counts.open], ['resolved', 'Resolved', counts.resolved], ['all', 'All', counts.open + counts.resolved]].forEach(function (t) {
      tabs.appendChild(el('button', { class: 'tm-tab', role: 'tab', type: 'button', 'aria-selected': S.filter === t[0] ? 'true' : 'false', onClick: function () { S.filter = t[0]; try { sessionStorage.setItem('tm:filter', S.filter); } catch (e) {} renderMarkers(); renderDrawer(); } },
        [t[1], el('span', { class: 'tm-count', text: String(t[2]) })]));
    });
    tabs.appendChild(el('button', { class: 'tm-icon-btn', type: 'button', 'aria-label': 'Refresh comments', title: 'Refresh', onClick: function () { reload().then(function () { toast('Refreshed.'); }); } }, [svgIcon(ICONS.refresh)]));
    drawer.appendChild(tabs);

    var body = el('div', { class: 'tm-body' });
    if (isMaintainer() && counts.toVerify && S.filter !== 'resolved') body.appendChild(el('div', { class: 'tm-note' }, [svgIcon(ICONS.verify), ' ' + counts.toVerify + ' comment' + (counts.toVerify > 1 ? 's' : '') + ' awaiting verification']));
    if (S.retarget) body.appendChild(el('div', { class: 'tm-note tm-note--active' }, ['Moving comment: use the ' + TOOLS[S.retarget.tool] + ' tool on the page. Esc cancels. ', el('button', { class: 'tm-link', type: 'button', text: 'Cancel', onClick: cancelRetarget })]));
    if (S.draft) body.appendChild(composerCard());
    var list = visibleAnnotations();
    var here = list.filter(function (a) { return (a.scope || 'page') === 'page'; });
    var shared = list.filter(function (a) { return (a.scope || 'page') !== 'page'; });
    if (!list.length && !S.draft) {
      body.appendChild(el('div', { class: 'tm-empty' }, [
        el('strong', { text: S.annotations.length ? 'Nothing ' + S.filter + ' on this page.' : 'No comments on this page yet.' }), document.createElement('br'),
        S.annotations.length ? 'Switch tabs to see other comments.' : 'Click "Select element" in the toolbar, then click the part of the page you want to comment on.',
      ]));
    }
    if (shared.length) body.appendChild(el('div', { class: 'tm-group', text: 'On this page (' + here.length + ')' }));
    here.slice().reverse().forEach(function (a) { body.appendChild(commentCard(a, S.annotations.indexOf(a) + 1)); });
    if (shared.length) {
      body.appendChild(el('button', { class: 'tm-group', type: 'button', 'aria-expanded': S.sharedCollapsed ? 'false' : 'true', onClick: function () { S.sharedCollapsed = !S.sharedCollapsed; renderDrawer(); } },
        [(S.sharedCollapsed ? '\u25b8 ' : '\u25be ') + 'Shared components & site-wide (' + shared.length + ')']));
      if (!S.sharedCollapsed) shared.slice().reverse().forEach(function (a) { body.appendChild(commentCard(a, S.annotations.indexOf(a) + 1)); });
    }
    if (others.length && isMaintainer()) {
      body.appendChild(el('button', { class: 'tm-group', type: 'button', 'aria-expanded': S.othersCollapsed ? 'false' : 'true', title: 'Comments made on commits this deployment does not contain', onClick: function () { S.othersCollapsed = !S.othersCollapsed; renderDrawer(); } },
        [(S.othersCollapsed ? '\u25b8 ' : '\u25be ') + 'Other branches & builds (' + others.length + ')']));
      if (!S.othersCollapsed) others.slice().reverse().forEach(function (a) { body.appendChild(commentCard(a, S.annotations.indexOf(a) + 1)); });
    }
    drawer.appendChild(body);

    var b = S.config.build || {};
    drawer.appendChild(el('div', { class: 'tm-drawer-foot' }, [
      el('span', { class: 'tm-legend' }, [el('i'), ' open']),
      el('span', { class: 'tm-legend' }, [el('i', { class: 'tm-legend--resolved' }), ' resolved']),
      S.config.mode === 'local' ? el('span', { class: 'tm-mode--local', text: 'Local demo: comments stay in this browser' }) : null,
      b.commit ? el('span', { title: 'Build ' + b.commit + (b.builtAt ? ' at ' + b.builtAt : '') + (b.ancestors ? ' · ' + b.ancestors.length + ' commits of history' + (b.shallow ? ' (shallow)' : '') : '') }, ['build ', el('code', { text: b.commit.slice(0, 7) }), b.branch ? ' · ' + b.branch : '', b.context && b.context !== 'production' ? ' · ' + b.context : '']) : null,
      b.branch && b.branch !== (b.mainBranch || 'main') ? (function () {
        var cb = el('input', { type: 'checkbox', id: 'tm-include-others', onChange: function (e) { setIncludeOthers(e.target.checked); } }); cb.checked = S.includeOthers;
        return el('label', { for: 'tm-include-others', class: 'tm-switch', title: 'Show comments from main and from commits in this branch\'s history. Turn off if this branch is a separate site.' }, [cb, ' Include comments from ' + (b.mainBranch || 'main')]);
      })() : null,
    ]));

    body.scrollTop = scrollTop;
    if (activeId) { var again = drawer.querySelector('#' + activeId); if (again) again.focus({ preventScroll: true }); }
  }
  function userRow() {
    var u = S.user || {};
    var avatar = u.avatar ? el('img', { src: u.avatar, alt: '', referrerpolicy: 'no-referrer' }) : el('span', { class: 'tm-avatar', text: initials(u.name), 'aria-hidden': 'true' });
    var row = el('div', { class: 'tm-user' }, [avatar, el('span', { class: 'tm-user-name', text: (u.name || '') + (isMaintainer() ? ' · maintainer' : ''), title: (u.email || '') + ' · ' + S.role })]);
    var sw = el('input', { type: 'checkbox', id: 'tm-advanced-switch', onChange: function (e) { setAdvanced(e.target.checked); } });
    sw.checked = S.advanced;
    row.appendChild(el('label', { for: 'tm-advanced-switch', class: 'tm-switch', title: 'Show selectors, style rules, scope and size controls' }, [sw, ' Advanced']));
    if (S.config.mode === 'supabase') row.appendChild(el('button', { class: 'tm-link', type: 'button', text: 'Sign out', onClick: function () { sb.auth.signOut(); } }));
    else row.appendChild(el('button', { class: 'tm-link', type: 'button', text: 'Change name', onClick: function () {
      var name = window.prompt('Your name for local comments:', u.name); // local mode only; never used with the real backend
      if (name) { try { localStorage.setItem('tm:localName', name); } catch (e) {} S.user.name = name; renderDrawer(); }
    } }));
    return row;
  }
  function contextBlock(a, opts) {
    var t = a.target || {};
    var box = el('div', { class: 'tm-context' });
    if (opts && opts.draft) {
      var img = el('img', { id: 'tm-draft-shot', alt: 'Screenshot of the selected area', hidden: !a.shot });
      if (a.shot) img.src = a.shot.dataUrl;
      box.appendChild(img);
      box.appendChild(el('div', { id: 'tm-draft-shot-pending', class: 'tm-shot-pending', text: a.shotPending ? 'Capturing screenshot…' : '' }));
    } else if (a.screenshotPath) {
      var shot = el('img', { alt: 'Screenshot of the annotated area', loading: 'lazy' });
      box.appendChild(shot);
      if (S.shotUrls[a.screenshotPath]) shot.src = S.shotUrls[a.screenshotPath];
      else S.store.screenshotUrl(a.screenshotPath).then(function (url) { if (url) { S.shotUrls[a.screenshotPath] = url; shot.src = url; } else shot.remove(); });
    }
    if (t.heading) box.appendChild(el('div', { class: 'tm-ctx-row' }, [el('b', { text: 'Section' }), el('span', { text: t.heading })]));
    if (t.text) box.appendChild(el('div', { class: 'tm-ctx-row' }, [el('b', { text: 'Element' }), el('span', { class: 'tm-ctx-text', text: '“' + cap(t.text, 140) + '”' })]));
    if (t.selectedText) box.appendChild(el('div', { class: 'tm-ctx-row' }, [el('b', { text: 'Selected' }), el('span', { class: 'tm-ctx-text', text: '“' + cap(t.selectedText, 140) + '”' })]));
    if (t.selector) box.appendChild(el('div', { class: 'tm-ctx-row tm-adv' }, [el('b', { text: 'Selector' }), el('code', { text: t.selector })]));
    var rule = keyRule(t.style);
    if (t.style && t.style.computed && (opts && opts.style || (rule && /^h[1-6]$|^a$|^button$|^p$/.test(t.tagName || '')))) {
      var c = t.style.computed;
      box.appendChild(el('div', { class: 'tm-ctx-row tm-adv' }, [el('b', { text: 'Style' }), el('span', { text: [c.fontFamily, c.fontSize, c.fontWeight, c.color].filter(Boolean).join(' \u00b7 ') })]));
    }
    if (rule) box.appendChild(el('div', { class: 'tm-ctx-row tm-adv' }, [el('b', { text: 'Rule' }), el('span', {}, [el('code', { text: rule.selector }), ' in ' + rule.sheet + (rule.media ? ' @media ' + rule.media : '') + ' (' + rule.affectsOnPage + ' on this page)'])]));
    if (t.state && t.state.held && t.state.held.length) box.appendChild(el('div', { class: 'tm-ctx-row tm-adv' }, [el('b', { text: 'State' }), el('span', { text: 'Made with a hover state held (' + t.state.held.length + ' element' + (t.state.held.length > 1 ? 's' : '') + '); selecting this comment re-opens it.' })]));
    return box;
  }
  function composerCard() {
    var d = S.draft;
    var card = el('div', { class: 'tm-composer', role: 'form', 'aria-label': 'New comment' }, [
      el('h3', {}, ['New comment', el('span', { class: 'tm-type', text: d.type })]),
      contextBlock(d, { draft: true, style: d.category === 'typography' || d.category === 'color' }),
    ]);
    if (d.el && document.contains(d.el)) {
      var crumbs = el('div', { class: 'tm-crumbs tm-adv', role: 'group', 'aria-label': 'Element ancestry; click to widen or narrow' });
      var chain = ancestry(d.el);
      chain.forEach(function (node, i) {
        if (i) crumbs.appendChild(el('span', { class: 'tm-sep', text: '\u203a', 'aria-hidden': 'true' }));
        crumbs.appendChild(el('button', { class: 'tm-crumb', type: 'button', 'aria-current': node === d.el ? 'true' : 'false', title: node === d.el ? 'Selected element' : 'Comment on this element instead', onClick: function () { if (node !== d.el) retargetDraft(node); } }, [describeEl(node)]));
      });
      var child = d.el.firstElementChild;
      while (child && /^(br|hr|wbr|script|style)$/i.test(child.nodeName)) child = child.nextElementSibling;
      if (child && !isOurs(child)) { crumbs.appendChild(el('span', { class: 'tm-sep', text: '\u203a', 'aria-hidden': 'true' })); crumbs.appendChild(el('button', { class: 'tm-crumb tm-crumb--child', type: 'button', title: 'Narrow to the first child', onClick: function () { retargetDraft(child); } }, [describeEl(child)])); }
      card.appendChild(crumbs);
    }
    if (d.duplicates && d.duplicates.length) {
      var dup = d.duplicates[0];
      card.appendChild(el('div', { class: 'tm-dup' }, [
        'There is already an open comment on this ' + (dup.target && dup.target.selector === (d.target && d.target.selector) ? 'element' : 'style rule') + ' by ' + (dup.author && dup.author.name || 'a reviewer') + ': \u201c' + cap(dup.comment, 70) + '\u201d',
        el('button', { class: 'tm-link', type: 'button', text: 'Reply there instead', onClick: function () { var id = dup.id; S.draft = null; select(id); } }),
      ]));
    }
    var scopeSel = el('select', { id: 'tm-draft-scope', onChange: function (e) { d.scope = e.target.value; } });
    Object.keys(SCOPES).forEach(function (k) {
      if (k === 'component' && !d.component) return;
      var label = k === 'component' ? 'The ' + d.component + ' on every page' : SCOPES[k];
      var o = el('option', { value: k, text: label }); if (k === d.scope) o.selected = true; scopeSel.appendChild(o);
    });
    var catSel = el('select', { id: 'tm-draft-category', onChange: function (e) { d.category = e.target.value; } });
    Object.keys(CATEGORIES).forEach(function (k) { var o = el('option', { value: k, text: CATEGORIES[k] }); if (k === d.category) o.selected = true; catSel.appendChild(o); });
    card.appendChild(detailsToggle(card));
    card.appendChild(el('div', { class: 'tm-fields tm-adv' }, [
      el('div', {}, [el('label', { for: 'tm-draft-scope', text: 'Applies to' }), scopeSel]),
      el('div', {}, [el('label', { for: 'tm-draft-category', text: 'About' }), catSel]),
    ]));
    var sizesRow = sizesField(d.devices, function (next) { d.devices = next; }, 'tm-draft'); sizesRow.classList.add('tm-adv');
    card.appendChild(sizesRow);
    var bp = detectBreakpoints(), cur = currentBreakpoint();
    var check = el('div', { class: 'tm-checkon tm-adv' }, [el('span', { text: 'Check on:' })]);
    bp.names.forEach(function (n) {
      check.appendChild(el('button', { class: 'tm-crumb', type: 'button', 'aria-current': n === cur ? 'true' : 'false', title: 'Render the page at ' + bp.presets[n] + ' px' + (S.frame ? '' : ' (opens a device frame; your draft is kept)'), onClick: function () { requestView(n); } }, [cap1(n)]));
    });
    if (S.frame) check.appendChild(el('button', { class: 'tm-link', type: 'button', text: 'Exit frame', onClick: function () { saveDraft(); exitFrame(true); } }));
    card.appendChild(check);
    var ta = el('textarea', { id: 'tm-draft-text', placeholder: 'What should change here, and why?', maxlength: String(LIMITS.comment), onKeydown: function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postDraft(); } });
    ta.value = d.comment || '';
    card.appendChild(el('div', { class: 'tm-form' }, [el('label', { for: 'tm-draft-text', class: 'tm-kicker', text: 'Your comment' }), ta]));
    card.appendChild(el('div', { class: 'tm-actions' }, [
      el('button', { id: 'tm-draft-post', class: 'tm-btn', type: 'button', text: 'Post comment', onClick: postDraft }),
      el('button', { class: 'tm-btn tm-btn--quiet', type: 'button', text: 'Cancel', onClick: cancelDraft }),
    ]));
    return card;
  }
  function eventText(ev) {
    var c = ev.changes || {};
    switch (ev.kind) {
      case 'created': return 'created this comment';
      case 'edited': return 'edited the comment';
      case 'moved': return 'moved the mark' + (c.type && c.type.to ? ' (' + (c.type.from && c.type.from !== c.type.to ? c.type.from + ' → ' : '') + c.type.to + ')' : '');
      case 'metadata': return 'changed ' + Object.keys(c).map(function (k) {
        var to = c[k] && c[k].to;
        if (k === 'devices') return 'sizes to ' + devicesLabel(to || []);
        if (k === 'scope') return 'applies-to to ' + (SCOPES[to] || to);
        if (k === 'category') return 'about to ' + (CATEGORIES[to] || to);
        return k + ' to ' + to;
      }).join(', ');
      case 'verified': return 'verified';
      case 'resolved': return 'resolved as ' + (c.resolution || 'addressed');
      case 'reopened': return 'reopened';
      case 'replied': return 'replied';
      case 'reply_edited': return 'edited a reply';
      case 'reply_deleted': return 'deleted a reply';
      default: return ev.kind;
    }
  }
  function inlineEditor(initial, onSave, onCancel, label) {
    var ta = el('textarea', { 'aria-label': label, maxlength: String(LIMITS.comment), onKeydown: function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } } });
    ta.value = initial;
    function save() { var v = ta.value.trim(); if (!v) { toast('Text cannot be empty.', 'error'); return; } onSave(v); }
    var box = el('div', { class: 'tm-form tm-inline-edit' }, [ta, el('div', { class: 'tm-actions' }, [
      el('button', { class: 'tm-btn', type: 'button', text: 'Save', onClick: save }),
      el('button', { class: 'tm-btn tm-btn--quiet', type: 'button', text: 'Cancel', onClick: onCancel }),
    ])]);
    setTimeout(function () { ta.focus(); }, 0);
    return box;
  }
  function commentCard(a, num) {
    var expanded = a.id === S.selectedId;
    var mine = isMine(a), editable = canEdit(a), resolved = a.status === 'resolved';
    var card = el('div', { class: 'tm-card' + (expanded ? ' tm-card--selected' : ' tm-card--collapsed') + (resolved ? ' tm-card--resolved' : ''), 'data-id': a.id });
    card.appendChild(el('button', { class: 'tm-card-head', type: 'button', 'aria-expanded': expanded ? 'true' : 'false', onClick: function () { if (expanded) { S.selectedId = null; syncHeldState(); renderMarkers(); renderDrawer(); } else select(a.id); } }, [
      el('span', { class: 'tm-num', text: String(num), 'aria-hidden': 'true' }),
      el('span', { class: 'tm-card-meta' }, [
        el('strong', { text: (a.author && a.author.name) || 'Reviewer' }),
        el('span', { text: relTime(a.createdAt) + ' · ' + a.type + (a.viewport && a.viewport.breakpoint ? ' · ' + a.viewport.breakpoint + ' ' + a.viewport.width : '') + (a.editedAt ? ' · edited' : ''), title: new Date(a.createdAt).toLocaleString() + (a.viewport ? ' · made at ' + a.viewport.width + '×' + a.viewport.height + ' (' + (a.viewport.breakpoint || '?') + ')' : '') + (a.editedAt ? ' · edited ' + new Date(a.editedAt).toLocaleString() + (a.editedBy ? ' by ' + a.editedBy.name : '') : '') }),
      ]),
      el('span', { class: 'tm-status' + (resolved ? ' tm-status--resolved' : '') + (a.status === 'verified' ? ' tm-status--verified' : '') + (a.resolution === 'declined' ? ' tm-status--declined' : ''), text: statusLabel(a), title: a.status === 'verified' && a.verifiedBy ? 'Verified by ' + a.verifiedBy.name : resolved && a.resolvedBy ? 'Resolved by ' + a.resolvedBy.name : '' }),
    ]));
    var commentEl = el('p', { class: 'tm-comment', text: a.comment });
    card.appendChild(commentEl);
    if ((a.scope && a.scope !== 'page') || a.category || (a.devices && a.devices.length) || versionChip(a)) {
      card.appendChild(el('div', { class: 'tm-chips' }, [
        versionChip(a),
        a.devices && a.devices.length ? el('span', { class: 'tm-chip tm-chip--size' + (appliesHere(a) ? '' : ' tm-chip--off'), text: devicesLabel(a.devices) }) : null,
        a.scope === 'component' ? el('span', { class: 'tm-chip', text: (a.component || 'component') + ' · every page' }) : null,
        a.scope === 'site' ? el('span', { class: 'tm-chip tm-chip--site', text: 'site-wide' }) : null,
        a.category ? el('span', { class: 'tm-chip tm-chip--cat tm-adv', text: CATEGORIES[a.category] || a.category }) : null,
      ]));
    }
    if (!expanded) return card;

    if (editable) card.appendChild(el('div', { class: 'tm-checkon' }, [el('button', { class: 'tm-link', type: 'button', text: 'Edit text', onClick: function (e) {
      var row = e.currentTarget.parentNode;
      var editor = inlineEditor(a.comment, function (v) { S.store.update(a.id, { comment: v }).then(reload).catch(function (err) { toast(err.message, 'error', 5000); }); }, function () { renderDrawer(); }, 'Edit comment ' + num);
      commentEl.replaceWith(editor); row.remove();
    } })]));

    card.appendChild(contextBlock(a, { style: a.category === 'typography' || a.category === 'color' }));
    card.appendChild(detailsToggle(card));
    if (a.page !== pagePath()) card.appendChild(el('div', { class: 'tm-made-on' }, ['Made on ', el('a', { href: a.page + '?review=' + encodeURIComponent(a.id), text: a.page })]));
    var madeAt = a.viewport && a.viewport.breakpoint, curBp = currentBreakpoint(), bpInfo = detectBreakpoints();
    var viewRow = el('div', { class: 'tm-checkon' });
    if (madeAt && (madeAt !== curBp || (S.frame && a.viewport.width && Math.abs(a.viewport.width - window.innerWidth) > 40)))
      viewRow.appendChild(el('button', { class: 'tm-btn tm-btn--outline', type: 'button', title: 'Render the page at the width this comment was made at (' + a.viewport.width + ' px)', onClick: function () { requestView(String(a.viewport.width), a.id); } }, ['View at ' + madeAt + ' ' + a.viewport.width]));
    else if (!appliesHere(a)) viewRow.appendChild(el('span', { class: 'tm-shot-pending', text: 'Not shown at this size.' }));
    if (viewRow.childNodes.length) card.appendChild(viewRow);
    var sizeRow = el('div', { class: 'tm-checkon tm-adv' });
    sizeRow.appendChild(el('span', { text: 'Check on:' }));
    bpInfo.names.forEach(function (n) { sizeRow.appendChild(el('button', { class: 'tm-crumb', type: 'button', 'aria-current': n === curBp ? 'true' : 'false', onClick: function () { requestView(n, a.id); } }, [cap1(n)])); });
    card.appendChild(sizeRow);
    if (editable) {
      // Advanced: edit scope / category / sizes, or re-anchor with any tool, keeping the thread.
      var editRow = el('div', { class: 'tm-checkon tm-adv' }, [
        el('button', { class: 'tm-link', type: 'button', text: 'Edit details', onClick: function () {
          var next = { scope: a.scope || 'page', component: a.component, category: a.category || 'content', devices: (a.devices || []).slice() };
          var scopeSel = el('select', { 'aria-label': 'Applies to', onChange: function (e) { next.scope = e.target.value; } });
          Object.keys(SCOPES).forEach(function (k) { if (k === 'component' && !next.component) return; var o = el('option', { value: k, text: k === 'component' ? 'The ' + next.component + ' on every page' : SCOPES[k] }); if (k === next.scope) o.selected = true; scopeSel.appendChild(o); });
          var catSel = el('select', { 'aria-label': 'About', onChange: function (e) { next.category = e.target.value; } });
          Object.keys(CATEGORIES).forEach(function (k) { var o = el('option', { value: k, text: CATEGORIES[k] }); if (k === next.category) o.selected = true; catSel.appendChild(o); });
          var editor = el('div', { class: 'tm-sizes-editor tm-details-editor' }, [
            el('div', { class: 'tm-fields' }, [el('div', {}, [el('label', { text: 'Applies to' }), scopeSel]), el('div', {}, [el('label', { text: 'About' }), catSel])]),
            sizesField(next.devices, function (v) { next.devices = v; }, 'tm-edit-' + a.id),
            el('div', { class: 'tm-actions' }, [
              el('button', { class: 'tm-btn', type: 'button', text: 'Save', onClick: function () { S.store.update(a.id, { scope: next.scope, component: next.scope === 'component' ? next.component : null, category: next.category, devices: next.devices }).then(reload).catch(function (err) { toast(err.message, 'error', 5000); }); } }),
              el('button', { class: 'tm-btn tm-btn--quiet', type: 'button', text: 'Cancel', onClick: function () { renderDrawer(); } }),
            ]),
          ]);
          editRow.replaceWith(editor);
        } }),
        el('span', { text: '· Move mark:' }),
      ]);
      Object.keys(TOOLS).forEach(function (t) { editRow.appendChild(el('button', { class: 'tm-crumb', type: 'button', title: 'Re-anchor this comment with the ' + TOOLS[t] + ' tool; the text and replies are kept', onClick: function () { startRetarget(a.id, t); } }, [TOOLS[t]])); });
      card.appendChild(editRow);
    }
    if (a.replies.length) {
      var replies = el('div', { class: 'tm-replies' });
      a.replies.forEach(function (r) {
        var body = el('div', { class: 'tm-reply-body', text: r.body });
        var meta = el('div', { class: 'tm-reply-meta' }, [el('strong', { text: (r.author && r.author.name) || 'Reviewer' }), ' · ' + relTime(r.createdAt) + (r.editedAt ? ' · edited' : '')]);
        if (isMine(r)) {
          meta.appendChild(el('button', { class: 'tm-link', type: 'button', text: 'Edit', onClick: function () {
            body.replaceWith(inlineEditor(r.body, function (v) { S.store.updateReply(r.id, v).then(reload).catch(function (err) { toast(err.message, 'error', 5000); }); }, function () { renderDrawer(); }, 'Edit reply'));
          } }));
          meta.appendChild(el('button', { class: 'tm-link', type: 'button', text: 'Delete', onClick: function (e) {
            if (e.currentTarget.getAttribute('data-confirm') === '1') S.store.removeReply(r.id).then(reload).catch(function (err) { toast(err.message, 'error', 5000); });
            else { e.currentTarget.setAttribute('data-confirm', '1'); e.currentTarget.textContent = 'Confirm delete'; }
          } }));
        }
        replies.appendChild(el('div', { class: 'tm-reply' }, [el('span', { class: 'tm-avatar', text: initials(r.author && r.author.name), 'aria-hidden': 'true' }), el('div', {}, [meta, body])]));
      });
      card.appendChild(replies);
    }
    var replyId = 'tm-reply-' + a.id;
    var ta = el('textarea', { id: replyId, placeholder: 'Reply…', 'aria-label': 'Reply to comment ' + num, maxlength: String(LIMITS.comment), onInput: function (e) { S.replyDrafts[a.id] = e.target.value; }, onKeydown: function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendReply(); } });
    ta.value = S.replyDrafts[a.id] || '';
    function sendReply() {
      var text = ta.value.trim(); if (!text) return;
      S.store.reply(a.id, text).then(function () { delete S.replyDrafts[a.id]; return reload(); }).catch(function (err) { toast('Could not reply: ' + err.message, 'error', 5000); });
    }
    card.appendChild(el('div', { class: 'tm-form' }, [ta]));
    function setStatus(status, resolution) { S.store.setStatus(a.id, status, resolution).then(reload).catch(function (err) { toast(err.message, 'error', 5000); }); }
    var actions = el('div', { class: 'tm-actions' }, [el('button', { class: 'tm-btn', type: 'button', text: 'Reply', onClick: sendReply })]);
    if (isMaintainer() && a.status === 'open') actions.appendChild(el('button', { class: 'tm-btn tm-btn--outline', type: 'button', title: 'Confirm the target, scope and sizes are right and this is ready to be worked on', onClick: function () { setStatus('verified'); } }, [svgIcon(ICONS.verify), 'Verify']));
    if (editable && !resolved) actions.appendChild(el('button', { class: 'tm-btn tm-btn--outline', type: 'button', title: 'Close this comment with an outcome', onClick: function (e) {
      var choice = el('span', { class: 'tm-resolve-choice' }, [
        el('button', { class: 'tm-btn', type: 'button', text: 'Addressed', title: 'The change was made', onClick: function () { setStatus('resolved', 'addressed'); } }),
        el('button', { class: 'tm-btn tm-btn--quiet', type: 'button', text: 'Declined', title: 'Will not be done', onClick: function () { setStatus('resolved', 'declined'); } }),
        el('button', { class: 'tm-link', type: 'button', text: 'Cancel', onClick: function () { renderDrawer(); } }),
      ]);
      e.currentTarget.replaceWith(choice);
    } }, [svgIcon(ICONS.check), 'Resolve']));
    if (editable && resolved) actions.appendChild(el('button', { class: 'tm-btn tm-btn--outline', type: 'button', text: 'Reopen', onClick: function () { setStatus(a.verifiedAt && !isMaintainer() ? 'open' : 'open'); } }));
    actions.appendChild(el('button', { class: 'tm-btn tm-btn--quiet', type: 'button', title: 'Copy a link to this comment', 'aria-label': 'Copy link to comment ' + num, onClick: function () { copyLink(a.id); } }, [svgIcon(ICONS.link)]));
    if (editable) actions.appendChild(el('button', { class: 'tm-btn tm-btn--danger tm-btn--icon', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment ' + num, onClick: function (e) {
      if (card.getAttribute('data-confirm') === '1') { S.store.remove(a.id).then(function () { S.selectedId = null; return reload(); }).catch(function (err) { toast(err.message, 'error', 5000); }); }
      else { var b = e.currentTarget; card.setAttribute('data-confirm', '1'); b.title = 'Click again to delete'; toast('Click the trash icon again to confirm.', null, 3000); setTimeout(function () { card.removeAttribute('data-confirm'); b.title = 'Delete comment'; }, 3500); }
    } }, [svgIcon(ICONS.trash)]));
    card.appendChild(actions);
    if (a.events && a.events.length) {
      var open = !!S.activityOpen[a.id];
      var list = el('ul', { class: 'tm-activity', hidden: !open });
      a.events.slice().reverse().forEach(function (ev) { list.appendChild(el('li', { title: new Date(ev.at).toLocaleString() }, [el('strong', { text: (ev.actor && ev.actor.name) || 'Someone' }), ' ' + eventText(ev) + ' · ' + relTime(ev.at)])); });
      card.appendChild(el('button', { class: 'tm-link tm-activity-toggle', type: 'button', 'aria-expanded': open ? 'true' : 'false', text: (open ? 'Hide activity' : 'Activity') + ' (' + a.events.length + ')', onClick: function (e) { S.activityOpen[a.id] = !open; list.hidden = open; e.currentTarget.textContent = (open ? 'Activity' : 'Hide activity') + ' (' + a.events.length + ')'; e.currentTarget.setAttribute('aria-expanded', open ? 'false' : 'true'); open = !open; } }));
      card.appendChild(list);
    }
    // Phase 2 extension point: turns this thread into an AI change request (see docs/ai-change-requests.md).
    // Hidden until the pipeline exists: set REVIEW_AI_CHANGES=true at build time to show it.
    if (S.config && S.config.aiChangeRequests) card.appendChild(el('div', { class: 'tm-actions' }, [
      el('button', { class: 'tm-btn tm-btn--ai', type: 'button', disabled: true, title: 'Coming in Phase 2, for verified comments: an AI coding agent proposes a change on a branch with a Deploy Preview.', 'aria-describedby': 'tm-ai-note' }, [svgIcon(ICONS.ai), 'Ask AI to change this']),
      el('span', { id: 'tm-ai-note', class: 'tm-shot-pending', text: a.status === 'verified' ? 'Not available yet' : 'Needs verification first' }),
    ]));
    return card;
  }
  // "Applies to sizes" checkboxes. devices [] means all sizes.
  function sizesField(devices, onChange, idPrefix) {
    var bp = detectBreakpoints(), set = {};
    (devices && devices.length ? devices : bp.names).forEach(function (n) { set[n] = true; });
    var row = el('div', { class: 'tm-sizes', role: 'group', 'aria-label': 'Applies to sizes' }, [el('span', { class: 'tm-sizes-label', text: 'Sizes' })]);
    bp.names.forEach(function (n) {
      var id = idPrefix + '-size-' + n;
      var cb = el('input', { type: 'checkbox', id: id, onChange: function () {
        set[n] = cb.checked;
        var on = bp.names.filter(function (k) { return set[k]; });
        onChange(on.length === bp.names.length ? [] : on);
      } });
      cb.checked = !!set[n];
      row.appendChild(el('label', { for: id, class: 'tm-size' }, [cb, ' ' + cap1(n)]));
    });
    return row;
  }
  function copyLink(id) {
    var url = location.origin + location.pathname + '?review=' + encodeURIComponent(id);
    var done = function () { toast('Link copied.', 'success'); };
    var fallback = function () { toast('Link: ' + url, null, 9000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback);
    else fallback();
  }

  // =========================================================================
  // Keyboard
  // =========================================================================
  function onKeyDown(e) {
    if (UI.doc.getElementById('tm-modal')) return; // modal handles its own keys
    var typing = e.target && e.target.matches && e.target.matches('input, textarea, select, [contenteditable]');
    if (S.tool === 'inspect' && !typing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); walkInspect(e.key === 'ArrowUp' ? -1 : 1); return; }
    if ((e.key === 'h' || e.key === 'H') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      S.hold && !S.hold.fromAnnotation ? releaseHold() : holdHover();
      return;
    }
    if (e.key !== 'Escape') return;
    if (S.drawing) { cancelDrawing(); e.preventDefault(); return; }
    if (S.retarget) { cancelRetarget(); e.preventDefault(); return; }
    if (S.draft) { cancelDraft(); e.preventDefault(); return; }
    if (S.tool) { setTool(null); e.preventDefault(); return; }
    var active = e.target && e.target.ownerDocument ? e.target.ownerDocument.activeElement : uiActive();
    if (S.drawerOpen && (!active || isOurs(active) || active === active.ownerDocument.body)) { closeDrawer(); e.preventDefault(); }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================
  function start(opts) {
    opts = opts || {};
    if (S.started) { if (opts.openDrawer) openDrawer(false); return; }
    S.started = true;
    S.base = opts.base || S.base;
    if (window.__tmLauncher) window.__tmLauncher.setVisible(false);
    if (opts.frame && window.top === window) { enterFrameShell(opts.frame); return; } // this window becomes the device-frame shell
    S.frame = framedView();
    loadMode();
    loadIncludeOthers();
    // Smooth scrolling (the site sets scroll-behavior: smooth) stalls inside a
    // scaled iframe in Chrome, which also breaks fragment links. Use instant
    // scrolling while framed; the page's own behaviour is restored on exit.
    if (S.frame) { S.prevScrollBehavior = document.documentElement.style.scrollBehavior; document.documentElement.style.scrollBehavior = 'auto'; }
    if (S.frame) { try { UI.doc = window.parent.document; UI.win = window.parent; } catch (e) { UI.doc = document; UI.win = window; } }
    mountChrome();
    fetch(S.base + 'config.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('config.json ' + r.status); return r.json(); })
      .then(function (cfg) {
        S.config = cfg;
        if (cfg.mode === 'disabled') throw new Error('Review Mode is not configured on this deployment (set SUPABASE_URL, SUPABASE_ANON_KEY and TEXOMODO_SITE_ID).');
        if (cfg.mode === 'supabase' && !cfg.site) throw new Error('Review Mode is misconfigured: config.json has no site id (set TEXOMODO_SITE_ID at build time).');
        return authenticate();
      })
      .then(function (ok) {
        if (!ok) { exit(); return; }
        try { sessionStorage.setItem('tmReviewMode', '1'); } catch (e) {}
        if (shouldAutoFrame()) { requestView('desktop', opts.focus); return; }
        mountOverlay();
        if (S.frame) window.addEventListener('message', onFrameMessage);
        S.unsubscribe = S.store.subscribe(pagePath(), function () { reload(); });
        var wasOpen = false;
        try { wasOpen = sessionStorage.getItem('tm:drawerOpen') === '1'; var f = sessionStorage.getItem('tm:filter'); if (f === 'open' || f === 'resolved' || f === 'all') S.filter = f; } catch (e) {}
        return reload().then(function () {
          if (restoreDraft()) return;
          if (opts.focus) {
            if (byId(opts.focus)) select(opts.focus); else toast('That comment is not on this page.', 'error', 4000);
          } else if (opts.openDrawer || wasOpen) openDrawer(false, wasOpen && !opts.openDrawer);
          var ph = UI.doc.getElementById('tm-drawer-placeholder'); if (ph) ph.remove();
          // Inside a device frame the browser's own fragment scroll is unreliable (it
          // targets the shell's clipped wrapper); do it here, after our layer exists.
          if (S.frame && location.hash && !opts.focus) {
            try {
              var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
              if (target) window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 96, behavior: 'auto' });
            } catch (e) {}
          }
          toast('Review mode on. Click "Select element", then click the page.', null, 3500);
        });
      })
      .catch(function (err) {
        console.warn('[review]', err);
        toast(err.message || 'Review mode unavailable', 'error', 6000);
        setTimeout(exit, 500);
      });
  }
  function onFrameMessage(e) {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'tm:view') return;
    S.frame = { name: e.data.name, width: e.data.width, custom: !!e.data.custom };
    var sel = S.nodes.viewSel;
    if (sel) {
      var want = S.frame.custom ? String(S.frame.width) : S.frame.name;
      if (S.frame.custom && !sel.querySelector('option[value="' + want + '"]')) sel.appendChild(el('option', { value: want, text: 'Custom ' + want }));
      sel.value = want;
    }
    scheduleRelayout(); setTimeout(function () { renderMarkers(); renderDrawer(); }, 400);
  }
  function removeUi() {
    var ph = UI.doc.getElementById('tm-drawer-placeholder'); if (ph) ph.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    if (UI.doc !== document) { try { UI.doc.removeEventListener('keydown', onKeyDown, true); UI.doc.body.classList.remove('tm-drawer-open'); } catch (e) {} }
    ['layer', 'toolbar', 'drawer', 'toasts'].forEach(function (k) { if (S.nodes[k]) { try { S.nodes[k].remove(); } catch (e) {} S.nodes[k] = null; } });
    var modal = UI.doc.getElementById('tm-modal'); if (modal) modal.remove();
  }
  function exit() {
    try { sessionStorage.removeItem('tmReviewMode'); sessionStorage.removeItem('tm:drawerOpen'); sessionStorage.removeItem('tm:viewChoice'); } catch (e) {}
    window.removeEventListener('message', onFrameMessage);
    if (S.frame) { document.documentElement.style.scrollBehavior = S.prevScrollBehavior || ''; removeUi(); exitFrame(); return; }
    try { var u = new URL(location.href); if (u.searchParams.has('review')) { u.searchParams.delete('review'); history.replaceState(null, '', u.toString()); } } catch (e) {}
    if (S.unsubscribe) { try { S.unsubscribe(); } catch (e) {} }
    if (S.ro) { try { S.ro.disconnect(); } catch (e) {} }
    window.removeEventListener('resize', scheduleRelayout);
    releaseHold();
    if (S.holdSheet) { S.holdSheet.remove(); S.holdSheet = null; }
    document.querySelectorAll('.tm-target-glow').forEach(function (n) { n.classList.remove('tm-target-glow'); });
    document.body.classList.remove('tm-drawer-open');
    removeUi();
    S.started = false; S.tool = null; S.draft = null; S.drawerOpen = false; S.selectedId = null; S.annotations = [];
    if (window.__tmLauncher) window.__tmLauncher.setVisible(true);
  }

  window.TexoModo = {
    version: '0.1.0',
    start: start,
    exit: exit,
    /** Current annotations for this page (read-only copy). */
    annotations: function () { return S.annotations.slice(); },
    role: function () { return S.role; },
    /** Phase 2 hook: turn a thread into an AI change request (server-side pipeline). */
    requestChange: function (annotationId, instruction) { return S.store ? S.store.requestChange(annotationId, instruction) : Promise.reject(new Error('Review mode is not active')); },
  };
})();
