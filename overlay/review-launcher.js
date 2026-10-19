/*
 * TexoModo Review Mode launcher. This is the ONLY review code the public site loads.
 * It adds a small "Comment / Review" button and, when asked, lazy-loads the
 * real overlay (review/review.js + review.css + Supabase client).
 *
 * Nothing in here may break the page: everything is wrapped in try/catch and
 * the button is added after DOMContentLoaded.
 */
(function () {
  'use strict';
  try {
    var script = document.currentScript;
    var base = script && script.src ? script.src.replace(/review-launcher\.js(\?.*)?$/, '') : 'review/';
    var params = new URLSearchParams(location.search);
    var deepLink = params.get('review');                 // ?review=<annotation-id>
    var view = params.get('tmView');                    // ?tmView=phone|tablet|desktop|<px>: device frame
    var oauthReturn = /(^|[&#])access_token=|[?&]code=/.test(location.hash + location.search);
    var sticky = false;
    try { sticky = sessionStorage.getItem('tmReviewMode') === '1'; } catch (e) {}

    var loading = null;
    function load() {
      if (window.TexoModo) return Promise.resolve(window.TexoModo);
      if (loading) return loading;
      loading = new Promise(function (resolve, reject) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = base + 'review.css';
        document.head.appendChild(css);
        var js = document.createElement('script');
        js.src = base + 'review.js';
        js.defer = true;
        js.onload = function () { window.TexoModo ? resolve(window.TexoModo) : reject(new Error('review.js did not initialise')); };
        js.onerror = function () { reject(new Error('could not load review.js')); };
        document.head.appendChild(js);
      });
      return loading;
    }

    function start(opts) {
      load().then(function (api) { api.start(Object.assign({ base: base }, opts || {})); })
        .catch(function (err) { console.warn('[review] unavailable:', err && err.message); });
    }

    function addButton() {
      if (document.getElementById('tm-launch')) return;
      var style = document.createElement('style');
      style.textContent =
        '#tm-launch{position:fixed;right:16px;bottom:16px;z-index:9998;display:inline-flex;align-items:center;gap:8px;' +
        'padding:10px 14px;border-radius:999px;border:1px solid #c6a34d;background:#07351f;color:#fff;font:600 13px/1 Inter,ui-sans-serif,system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(7,53,31,.28);cursor:pointer;opacity:.92}' +
        '#tm-launch:hover,#tm-launch:focus-visible{opacity:1;outline:2px solid #c6a34d;outline-offset:2px}' +
        '#tm-launch svg{width:15px;height:15px;fill:none;stroke:#f2d98f;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
        '@media(max-width:650px){#tm-launch{right:12px;bottom:12px;padding:9px 12px}}' +
        '@media print{#tm-launch{display:none}}';
      document.head.appendChild(style);
      var btn = document.createElement('button');
      btn.id = 'tm-launch';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Comment or review this page');
      btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.3A8 8 0 1 1 21 12z"/></svg><span>Comment / Review</span>';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.querySelector('span').textContent = 'Loading…';
        start({ openDrawer: true });
      });
      document.body.appendChild(btn);
    }

    // The drawer was open on the previous page: reserve its space immediately so the
    // overlay (loaded a moment later) appears in place instead of sliding in.
    function placeholder() {
      var open = false;
      try { open = sticky && sessionStorage.getItem('tm:drawerOpen') === '1'; } catch (e) {}
      if (!open || window.top !== window || document.getElementById('tm-drawer-placeholder')) return;
      var ph = document.createElement('div');
      ph.id = 'tm-drawer-placeholder';
      ph.setAttribute('data-tm', '');
      ph.setAttribute('aria-hidden', 'true');
      ph.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:400px;max-width:100vw;z-index:9996;background:#fff;border-left:1px solid #e4e3dc;box-shadow:0 14px 40px rgba(7,53,31,.22)';
      if (matchMedia('(max-width: 650px)').matches) ph.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:66vh;z-index:9996;background:#fff;border-top:1px solid #e4e3dc;border-radius:16px 16px 0 0';
      document.body.appendChild(ph);
    }
    function init() {
      if (view && window.top === window) { start({ frame: view, focus: deepLink }); return; } // this window hosts the device frame
      placeholder();
      addButton();
      if (deepLink || oauthReturn || sticky) start({ focus: deepLink, openDrawer: !!deepLink });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Allows review.js to hide the launcher while Review Mode is active and restore it on exit.
    window.__tmLauncher = {
      setVisible: function (v) { var b = document.getElementById('tm-launch'); if (b) { b.style.display = v ? '' : 'none'; b.disabled = false; var s = b.querySelector('span'); if (s) s.textContent = 'Comment / Review'; } }
    };
  } catch (err) {
    try { console.warn('[review] launcher failed:', err); } catch (e) {}
  }
})();
