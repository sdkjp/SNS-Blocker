// ==UserScript==
// @name         Focus Blocker
// @namespace    focus-blocker.local
// @version      1.0.0
// @description  X・Instagram・YouTube のおすすめ非表示 & 無限スクロール抑制 + 集中モード（Safari Userscripts アプリ用）
// @author       claude-hub
// @match        *://x.com/*
// @match        *://*.x.com/*
// @match        *://twitter.com/*
// @match        *://*.twitter.com/*
// @match        *://instagram.com/*
// @match        *://*.instagram.com/*
// @match        *://youtube.com/*
// @match        *://*.youtube.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// ==/UserScript==
//
// このファイルは tools/build-userscript.mjs が自動生成します。編集は元ファイル
// (extension/common/*.js, extension/content/*.js) 側で行い、再ビルドしてください。


/* ==================== extension/common/core.js ==================== */
/*
 * Focus Blocker — core.js (shared engine)
 * -------------------------------------------------------------
 * Runs in the content-script isolated world on x.com / instagram.com /
 * youtube.com. Provides helpers used by the per-site modules:
 *   - style injection / toggling
 *   - a debounced whole-document MutationObserver
 *   - SPA route-change detection (href polling — robust across JS worlds)
 *   - text-based element hiding (for obfuscated DOM)
 *   - a scroll "wall" that stops infinite scroll
 *   - DEFAULTS + settings merge (single source of truth)
 *
 * NOTE: This file is shared verbatim by the Safari Web Extension and the
 * userscript build (tools/build-userscript.mjs). Keep it framework-free.
 */
(function () {
  'use strict';
  if (window.__FB_CORE__) return;
  window.__FB_CORE__ = true;

  var FB = (window.FB = window.FB || {});

  /* ----------------------------------------------------------- defaults -- */
  FB.DEFAULTS = {
    enabled: true,
    resetMinutes: 30,          // auto-reset the scroll counter after N min (0 = never)
    x: {
      enabled: true,
      focusMode: false,        // 集中モード(任意/強): redirect everything except the allow-list to /i/bookmarks
      hideForYou: true,        // hide the "For you" (おすすめ) home tab, KEEP "Following"
      forceFollowing: true,    // auto-switch the home timeline to "Following" (フォロー中)
      redirectExplore: true,   // /explore (algorithmic) → /explore/tabs/trending
      hideSidebar: true,       // hide the entire right column ([data-testid="sidebarColumn"])
      declutterNav: true,      // remove unnecessary left-nav items (follow-suggest / Grok / studio / premium)
      hideWhoToFollow: true,   // inline "Who to follow / おすすめユーザー" in the timeline
      hideDiscoverMore: true,  // "Discover more / さらに表示" under a post
      limitScroll: true,       // count scrolls on the home timeline & block at the limit
      scrollLimit: 40          // number of scroll actions before blocking
    },
    instagram: {
      enabled: true,
      focusMode: false,        // 集中モード(任意/強): redirect everything except the allow-list to /direct/inbox/
      hideExplore: true,       // hide Explore nav + block the /explore page
      hideReels: true,         // hide Reels nav + block the /reels page
      hideSuggested: true,     // in-feed "おすすめ" posts / suggested reels (non-followed)
      hideAds: true,           // in-feed 広告 / Sponsored posts
      limitScroll: true,       // count scrolls on the home feed & block at the limit
      scrollLimit: 30
    },
    youtube: {
      enabled: true,
      hideHomeFeed: true,      // recommendation grid on the Home page
      redirectHome: true,      // send Home (/) to /feed/subscriptions (集中モード既定ON)
      hideShorts: true,        // Shorts shelves + guide entries
      redirectShorts: true,    // open /shorts/<id> as a normal /watch
      hideRelated: true,       // "Up next" / related sidebar on watch pages
      hideEndScreen: true,     // end-screen video suggestions in the player
      hideComments: false      // (off by default) hide the comments section
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Two-level deep merge of stored settings over DEFAULTS.
  FB.mergeSettings = function (over) {
    var d = FB.DEFAULTS;
    var out = { enabled: (over && typeof over.enabled === 'boolean') ? over.enabled : d.enabled };
    out.resetMinutes = (over && typeof over.resetMinutes === 'number') ? over.resetMinutes : d.resetMinutes;
    ['x', 'instagram', 'youtube'].forEach(function (site) {
      var o = (over && over[site] && typeof over[site] === 'object') ? over[site] : {};
      out[site] = Object.assign({}, d[site], o);
    });
    return out;
  };

  /* ------------------------------------------------------------- styles -- */
  var GLOBAL_CSS = '[data-fb-hide="1"]{display:none !important;}';
  function ensureGlobalStyle() {
    if (document.getElementById('fb-global-style')) return;
    var el = document.createElement('style');
    el.id = 'fb-global-style';
    el.textContent = GLOBAL_CSS;
    (document.head || document.documentElement).appendChild(el);
  }
  ensureGlobalStyle();

  FB.setStyle = function (id, css) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
    return el;
  };
  FB.removeStyle = function (id) {
    var el = document.getElementById(id);
    if (el) el.parentNode && el.parentNode.removeChild(el);
  };
  FB.toggleStyle = function (id, css, enabled) {
    if (enabled) FB.setStyle(id, css); else FB.removeStyle(id);
  };

  FB.mark = function (el) {
    if (el && el.getAttribute && el.getAttribute('data-fb-hide') !== '1') {
      el.setAttribute('data-fb-hide', '1');
      return true;
    }
    return false;
  };
  FB.unhideAll = function () {
    var nodes = document.querySelectorAll('[data-fb-hide="1"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].removeAttribute('data-fb-hide');
  };

  /* ------------------------------------------------------ text-based hide -- */
  // For every `selector` whose trimmed text matches `textRe`, hide an ancestor:
  // the nearest `closest` match, else climb `climb` levels.
  FB.hideByText = function (opts) {
    var scope = opts.scope || document;
    var nodes = scope.querySelectorAll(opts.selector);
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var t = (node.textContent || '').trim();
      if (!t || t.length > (opts.maxLen || 40) || !opts.textRe.test(t)) continue;
      var target = node;
      if (opts.closest) {
        var c = node.closest(opts.closest);
        if (c) target = c;
      } else {
        var levels = opts.climb || 0;
        for (var j = 0; j < levels && target.parentElement; j++) target = target.parentElement;
      }
      if (FB.mark(target)) count++;
    }
    return count;
  };

  /* --------------------------------------------------------- lifecycle -- */
  FB.onReady = function (cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { cb(); }, { once: true });
    } else { cb(); }
  };

  // Debounced observer over the whole document. `cb` should be cheap &
  // idempotent (it re-applies hiding as the SPA mutates the DOM).
  FB.observe = function (cb) {
    var scheduled = false;
    function run() { scheduled = false; ensureGlobalStyle(); try { cb(); } catch (e) {} }
    function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(run); } }
    function start() {
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (document.documentElement) start(); else FB.onReady(start);
    setInterval(run, 2000);   // safety net for mutations we might miss
    schedule();
  };

  // SPA route changes. We poll location.href because monkey-patching
  // history.pushState from the isolated world does NOT intercept the page's
  // own navigations (separate JS worlds). Polling is world-agnostic.
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      window.dispatchEvent(new Event('fb:locationchange'));
    }
  }, 350);
  window.addEventListener('popstate', function () {
    window.dispatchEvent(new Event('fb:locationchange'));
  });
  FB.onLocationChange = function (cb) {
    window.addEventListener('fb:locationchange', function () {
      setTimeout(function () { try { cb(); } catch (e) {} }, 0);
    });
  };

  /* ----------------------------------------------- infinite-scroll limiter -- */
  // Count-based scroll limiter, modeled on NoMoScroll / ScrollStop:
  //   * count a "scroll" every time the page moves > STEP px (throttled),
  //   * when the count reaches the (per-site) limit, drop a full-screen overlay
  //     and lock scrolling,
  //   * "+more" grants grace scrolls, and the count auto-resets after N minutes.
  // Site modules call setActive(onFeed, limit, resetMinutes); swipe UIs (Reels/
  // Shorts) can call bump() since they don't accumulate window scroll.
  FB.installScrollCounter = function (opts) {
    opts = opts || {};
    var STEP = 100, THROTTLE = 250, GRACE = 10;
    var st = { active: false, blocked: false, limit: 30, count: 0, bonus: 0,
               label: opts.siteLabel || '', lastY: 0, lastTick: 0,
               resetMinutes: 30, lastReset: Date.now() };
    var overlay = null, badge = null;

    function effLimit() { return st.limit + st.bonus; }
    function scrollY() { return window.pageYOffset || document.documentElement.scrollTop || 0; }

    function styles() {
      FB.setStyle('fb-scrollstop-style',
        '#fb-scrollstop-overlay{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(10,10,14,.94);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
        '#fb-scrollstop-overlay .fb-ss-card{text-align:center;color:#fff;max-width:380px;padding:32px 34px;}' +
        '#fb-scrollstop-overlay .fb-ss-emoji{font-size:44px;margin-bottom:8px;}' +
        '#fb-scrollstop-overlay h2{font-size:20px;margin:0 0 6px;font-weight:700;}' +
        '#fb-scrollstop-overlay .fb-ss-sub{font-size:13px;opacity:.72;margin:0 0 22px;line-height:1.5;}' +
        '#fb-scrollstop-overlay .fb-ss-actions{display:flex;flex-direction:column;gap:10px;}' +
        '#fb-scrollstop-overlay button{border:0;border-radius:11px;padding:12px 18px;cursor:pointer;' +
        'font-size:14px;font-weight:600;background:#4f46e5;color:#fff;font-family:inherit;}' +
        '#fb-scrollstop-overlay button.fb-ss-secondary{background:rgba(255,255,255,.14);}' +
        '#fb-scrollstop-overlay button:hover{filter:brightness(1.12);}' +
        '#fb-scrollstop-overlay .fb-ss-note{font-size:11px;opacity:.4;margin:18px 0 0;}' +
        '#fb-scrollstop-badge{position:fixed;right:14px;bottom:14px;z-index:2147483550;background:rgba(20,20,24,.82);' +
        'color:#fff;font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;padding:7px 11px;border-radius:999px;' +
        'pointer-events:none;opacity:.85;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);}' +
        '#fb-scrollstop-badge[data-warn="1"]{background:rgba(220,38,38,.9);}');
    }

    function ensureOverlay() {
      if (overlay && overlay.isConnected) return overlay;
      overlay = document.createElement('div');
      overlay.id = 'fb-scrollstop-overlay';
      overlay.innerHTML =
        '<div class="fb-ss-card"><div class="fb-ss-emoji">🧘</div>' +
        '<h2>スクロール上限に達しました</h2><p class="fb-ss-sub"></p>' +
        '<div class="fb-ss-actions">' +
        '<button type="button" data-act="more">+' + GRACE + '回 スクロールを続ける</button>' +
        '<button type="button" class="fb-ss-secondary" data-act="reset">カウントをリセット</button>' +
        '</div><p class="fb-ss-note">Focus Blocker · 無限スクロール抑制</p></div>';
      overlay.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]'); if (!b) return;
        var act = b.getAttribute('data-act');
        if (act === 'more') { st.bonus += GRACE; unblock(); }
        else if (act === 'reset') { st.count = 0; st.bonus = 0; st.lastReset = Date.now(); unblock(); }
      });
      (document.body || document.documentElement).appendChild(overlay);
      return overlay;
    }

    function ensureBadge() {
      if (badge && badge.isConnected) return badge;
      badge = document.createElement('div');
      badge.id = 'fb-scrollstop-badge';
      (document.body || document.documentElement).appendChild(badge);
      return badge;
    }
    function updateBadge() {
      if (!st.active || st.blocked) { if (badge) badge.style.display = 'none'; return; }
      var el = ensureBadge(); el.style.display = '';
      var lim = effLimit();
      el.textContent = 'スクロール ' + Math.min(st.count, lim) + '/' + lim;
      el.setAttribute('data-warn', st.count >= lim * 0.8 ? '1' : '0');
    }

    function lockBody(lock) {
      var de = document.documentElement, b = document.body;
      de.style.overflow = lock ? 'hidden' : '';
      if (b) b.style.overflow = lock ? 'hidden' : '';
    }
    function block() {
      if (st.blocked) return;
      st.blocked = true; styles();
      var ov = ensureOverlay();
      ov.querySelector('.fb-ss-sub').textContent =
        (st.label ? st.label + ' で ' : '') + effLimit() + ' 回スクロールしました。少し休憩しませんか？';
      ov.style.display = 'flex';
      lockBody(true); updateBadge();
    }
    function unblock() {
      st.blocked = false;
      if (overlay) overlay.style.display = 'none';
      lockBody(false); updateBadge();
    }
    function maybeBlock() { if (st.active && !st.blocked && st.count >= effLimit()) block(); }

    function onScroll() {
      if (!st.active || st.blocked) return;
      var now = Date.now();
      if (now - st.lastTick < THROTTLE) return;
      st.lastTick = now;
      var y = scrollY();
      if (Math.abs(y - st.lastY) > STEP) { st.count++; st.lastY = y; updateBadge(); maybeBlock(); }
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    // auto-reset timer
    setInterval(function () {
      if (st.resetMinutes > 0 && Date.now() - st.lastReset >= st.resetMinutes * 60000) {
        st.count = 0; st.bonus = 0; st.lastReset = Date.now();
        if (st.blocked) unblock(); else updateBadge();
      }
    }, 1000);

    styles();
    return {
      setActive: function (active, limit, resetMinutes) {
        st.active = !!active;
        if (typeof limit === 'number' && limit > 0) st.limit = limit;
        if (typeof resetMinutes === 'number') st.resetMinutes = resetMinutes;
        if (!st.active) { if (overlay) overlay.style.display = 'none'; lockBody(false); if (badge) badge.style.display = 'none'; }
        else { st.lastY = scrollY(); updateBadge(); maybeBlock(); }
      },
      bump: function () { if (st.active && !st.blocked) { st.count++; updateBadge(); maybeBlock(); } },
      reset: function () { st.count = 0; st.bonus = 0; st.lastReset = Date.now(); unblock(); }
    };
  };

  /* --------------------------------------------------------- block overlay -- */
  // Full-viewport overlay used to neutralise a whole page (IG Explore/Reels).
  FB.showBlockOverlay = function (id, label, sublabel) {
    FB.setStyle('fb-overlay-style',
      '.fb-block-overlay{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(12,12,16,.86);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
      '.fb-block-overlay .fb-ov-card{text-align:center;color:#fff;max-width:340px;padding:28px 30px;}' +
      '.fb-block-overlay h2{font-size:19px;margin:0 0 6px;font-weight:700;}' +
      '.fb-block-overlay p{font-size:13px;opacity:.75;margin:0 0 18px;}' +
      '.fb-block-overlay button{border:0;border-radius:10px;padding:10px 18px;cursor:pointer;' +
      'font-size:14px;font-weight:600;background:#4f46e5;color:#fff;font-family:inherit;}');
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'fb-block-overlay';
      el.innerHTML =
        '<div class="fb-ov-card"><h2>🚫 ' + label + '</h2>' +
        '<p>' + (sublabel || 'Focus Blocker が非表示にしています') + '</p>' +
        '<button type="button">← 前のページに戻る</button></div>';
      el.querySelector('button').addEventListener('click', function () {
        if (history.length > 1) history.back(); else location.href = '/';
      });
      (document.body || document.documentElement).appendChild(el);
    }
  };
  FB.removeBlockOverlay = function (id) {
    var el = document.getElementById(id);
    if (el) el.parentNode && el.parentNode.removeChild(el);
  };
})();

/* ==================== extension/common/settings-userscript.js ==================== */
/*
 * Focus Blocker — settings-userscript.js
 * -------------------------------------------------------------
 * Settings backend for the USERSCRIPT build (Userscripts app on Safari).
 * There is no popup UI here, so settings come from GM storage if available,
 * otherwise from DEFAULTS. Edit the defaults in common/core.js, or set
 * per-key overrides via the Userscripts app if it exposes GM_setValue.
 *
 * This file is NOT referenced by the Web Extension manifest — it is only
 * concatenated into the .user.js by tools/build-userscript.mjs.
 */
(function () {
  'use strict';
  var FB = (window.FB = window.FB || {});

  var hasGM = (typeof GM_getValue === 'function');

  FB.getSettings = function () {
    var over = null;
    if (hasGM) {
      try { over = JSON.parse(GM_getValue('settings', 'null')); } catch (e) { over = null; }
    }
    return Promise.resolve(FB.mergeSettings(over));
  };

  FB.saveSettings = function (settings) {
    if (hasGM) { try { GM_setValue('settings', JSON.stringify(settings)); } catch (e) {} }
    return Promise.resolve();
  };

  // No live-change channel in the userscript build; settings apply on reload.
  FB.onSettingsChange = function () {};
})();

/* ==================== extension/content/x.js ==================== */
/*
 * Focus Blocker — X (Twitter) module
 * -------------------------------------------------------------
 * - hideForYou / forceFollowing: hide the "For you" (おすすめ) home tab and
 *   switch the timeline to "Following" (フォロー中).
 * - hideTrends: right-sidebar "Trends / いま話題" module.
 * - hideWhoToFollow: "Who to follow / おすすめユーザー" (sidebar + inline).
 * - hideDiscoverMore: "Discover more / さらに表示" module under a post.
 * - wall: firm stop on the home timeline's infinite scroll.
 *
 * X's DOM is heavily obfuscated & localized, so recommendation modules are
 * matched by heading TEXT (see CONFIG regexes) and hidden via their nearest
 * <section> / cell. Update the regexes here if X changes wording/markup.
 */
(function () {
  'use strict';
  var FB = window.FB;
  if (!FB) return;
  if (!/(^|\.)(x|twitter)\.com$/.test(location.hostname)) return;

  var CONFIG = {
    forYouTabRe:    /^(for you|おすすめ)$/i,
    followingTabRe: /^(following|フォロー中)$/i,
    whoToFollowRe:  /(who to follow|you might like|relevant people|おすすめユーザー|話題の人|関連する人)/i,
    discoverMoreRe: /(discover more|さらに表示|関連(する)?ポスト)/i,
    // 左メニュー(nav)から消す「不要」項目。安定した data-testid / href で指定 —
    // ここを増減すれば残す/消す項目を調整できる（ホーム・検索・通知・DM・
    // ブックマーク・プロフィール・もっと見る は残す）。
    navRemove: [
      '[data-testid="AppTabBar_Follow_Link"]',   // フォローする（フォロー提案＝おすすめ）
      '[data-testid="premium-signup-tab"]',       // プレミアム（課金導線）
      'nav a[href="/i/grok"]',                     // Grok
      'nav a[href="/i/jf/creators/studio"]'        // クリエイタースタジオ
    ],
    // /explore（アルゴリズムの「おすすめ」着地）を開いたら /explore/tabs/trending へ転送
    exploreTarget: '/explore/tabs/trending',
    exploreRedirectRe: /^\/explore\/?$|^\/explore\/tabs\/for_you\/?$/,
    // 集中モード (Distraction-Blocker style・任意/強): confine X to bookmarks.
    // Everything not matching focusAllow is redirected to focusTarget.
    focusTarget: '/i/bookmarks',
    focusAllow: [/^\/i\/bookmarks/, /^\/i\/grok/, /^\/messages/, /^\/notifications/,
                 /^\/jobs/, /^\/settings/, /^\/compose/, /^\/i\/flow/, /^\/login/, /^\/logout/, /^\/account/]
  };

  var s = FB.DEFAULTS.x;
  var root = FB.DEFAULTS;
  var counter = FB.installScrollCounter({ siteLabel: 'X' });

  function isHome() { return location.pathname === '/' || location.pathname === '/home'; }

  function buildCSS() {
    var css = '';
    // Hide the entire right column (search / premium / news / trends / who-to-follow / footer).
    if (s.hideSidebar) {
      css += '[data-testid="sidebarColumn"]{display:none !important;}';
    }
    // Remove unnecessary left-nav items.
    if (s.declutterNav) {
      css += CONFIG.navRemove.join(',') + '{display:none !important;}';
    }
    // Explore ページの「For you（おすすめ）」タブ（安定 href）も隠す。
    if (s.hideForYou) {
      css += 'a[role="tab"][href="/explore/tabs/for_you"]{display:none !important;}';
    }
    return css;
  }

  function hideForYouTab() {
    if (!isHome()) return;
    var tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
    if (!tabs.length) return;
    var forYou = null, following = null;
    for (var i = 0; i < tabs.length; i++) {
      var t = (tabs[i].textContent || '').trim();
      if (CONFIG.forYouTabRe.test(t)) forYou = tabs[i];
      else if (CONFIG.followingTabRe.test(t)) following = tabs[i];
    }
    if (s.hideForYou && forYou) {
      FB.mark(forYou.closest('[role="presentation"]') || forYou);
    }
    if (s.forceFollowing && forYou && following &&
        forYou.getAttribute('aria-selected') === 'true' && !following.__fbClicked) {
      following.__fbClicked = true;
      following.click();
      setTimeout(function () { following.__fbClicked = false; }, 1500);
    }
  }

  function hideModules() {
    // Inline "Who to follow / おすすめユーザー" injected into the home timeline.
    // (The sidebar copy is already gone when hideSidebar is on.)
    if (s.hideWhoToFollow) {
      FB.hideByText({ selector: '[data-testid="cellInnerDiv"] h2, [data-testid="cellInnerDiv"] [role="heading"]',
                      textRe: CONFIG.whoToFollowRe, closest: '[data-testid="cellInnerDiv"]', maxLen: 40 });
    }
    if (s.hideDiscoverMore) {
      FB.hideByText({ selector: '[data-testid="cellInnerDiv"] h2, [data-testid="cellInnerDiv"] [role="heading"]',
                      textRe: CONFIG.discoverMoreRe, closest: '[data-testid="cellInnerDiv"]', maxLen: 40 });
    }
  }

  function focusRedirect() {
    if (!s.focusMode) return false;
    var p = location.pathname;
    for (var i = 0; i < CONFIG.focusAllow.length; i++) if (CONFIG.focusAllow[i].test(p)) return false;
    location.replace('https://' + location.hostname + CONFIG.focusTarget);
    return true;
  }

  function exploreRedirect() {
    if (!s.redirectExplore) return false;
    if (CONFIG.exploreRedirectRe.test(location.pathname)) {
      location.replace('https://' + location.hostname + CONFIG.exploreTarget);
      return true;
    }
    return false;
  }

  function apply() {
    if (!root.enabled || !s.enabled) {
      FB.removeStyle('fb-x'); FB.unhideAll(); counter.setActive(false);
      return;
    }
    if (focusRedirect()) return;
    if (exploreRedirect()) return;
    FB.setStyle('fb-x', buildCSS());
    hideForYouTab();
    hideModules();
    counter.setActive(s.limitScroll && isHome(), s.scrollLimit, root.resetMinutes);
  }

  FB.getSettings().then(function (settings) {
    root = settings; s = settings.x;
    apply();
    FB.observe(apply);
    FB.onLocationChange(apply);
    FB.onSettingsChange(function (next) { root = next; s = next.x; FB.unhideAll(); apply(); });
  });
})();

/* ==================== extension/content/instagram.js ==================== */
/*
 * Focus Blocker — Instagram module
 * -------------------------------------------------------------
 * - hideExplore: hide the Explore nav icon and block the /explore page.
 * - hideReels:   hide the Reels nav icon and block the /reels page.
 * - hideSuggested: hide "Suggested for you / あなたへのおすすめ" posts and the
 *   suggested-accounts sidebar block.
 * - wall: firm stop on the home-feed infinite scroll.
 *
 * The nav icons have stable hrefs, so those are hidden via CSS. Suggested
 * content is matched by label TEXT (obfuscated classes) — tune CONFIG if IG
 * changes wording.
 */
(function () {
  'use strict';
  var FB = window.FB;
  if (!FB) return;
  if (!/(^|\.)instagram\.com$/.test(location.hostname)) return;

  var CONFIG = {
    // フィード内ラベル（完全一致）: おすすめ投稿/リール・広告。IG はヘッダーに短いラベルを出す。
    suggestedLabelRe: /^(おすすめ|Suggested)$/,
    adRe:             /^(広告|Sponsored|スポンサー|광고|广告)$/i,
    // 「Suggested for you」節・サイドバー用（長いフレーズ）
    suggestedRe: /(suggested for you|suggested posts|あなたへのおすすめ|おすすめの投稿|おすすめ投稿|フォローする候補)/i,
    // おすすめアカウント カルーセル判定用（article ではない）
    followBtnRe:   /^(フォロー|Follow)$/,
    suggestHintRe: /(がフォロー中|おすすめ|Suggested|Followed by)/,
    // 広告CTAリンク（facebook ads redirect）＝最も確実な広告シグナル
    adLinkSel: 'a[href*="ig_redirect"], a[href*="/ads/"]',
    // 集中モード (任意/強): confine Instagram to DMs.
    focusTarget: '/direct/inbox/',
    focusAllow: [/^\/direct/, /^\/accounts/]
  };

  var s = FB.DEFAULTS.instagram;
  var root = FB.DEFAULTS;
  var counter = FB.installScrollCounter({ siteLabel: 'Instagram' });

  function path() { return location.pathname; }
  function isHome() { return path() === '/'; }

  function buildCSS() {
    var css = '';
    if (s.hideExplore) {
      css += 'a[href="/explore/"],a[role="link"][href="/explore/"]{display:none !important;}';
    }
    if (s.hideReels) {
      css += 'a[href="/reels/"],a[role="link"][href="/reels/"]{display:none !important;}';
    }
    return css;
  }

  function handleOverlays() {
    // Explore page
    if (s.hideExplore && /^\/explore(\/|$)/.test(path())) {
      FB.showBlockOverlay('fb-ig-explore', 'Explore は非表示中', 'おすすめ探索は Focus Blocker が停止しています');
    } else {
      FB.removeBlockOverlay('fb-ig-explore');
    }
    // Reels tab
    if (s.hideReels && /^\/reels(\/|$)/.test(path())) {
      FB.showBlockOverlay('fb-ig-reels', 'Reels は非表示中', 'リールの無限スクロールは Focus Blocker が停止しています');
    } else {
      FB.removeBlockOverlay('fb-ig-reels');
    }
  }

  function hideFeedJunk() {
    // 広告（Sponsored）: CTAリンク（確実）＋「広告」ラベル（保険）
    if (s.hideAds) {
      var links = document.querySelectorAll(CONFIG.adLinkSel);
      for (var i = 0; i < links.length; i++) {
        var art = links[i].closest('article');
        if (art) FB.mark(art);
      }
      FB.hideByText({ selector: 'article span', textRe: CONFIG.adRe, closest: 'article', maxLen: 8 });
    }
    if (s.hideSuggested) {
      // おすすめ投稿・おすすめ動画（リール）: 記事ヘッダーの「おすすめ」ラベル
      FB.hideByText({ selector: 'article span, article div', textRe: CONFIG.suggestedLabelRe, closest: 'article', maxLen: 10 });
      // 「Suggested for you」見出し（記事内）
      FB.hideByText({ selector: 'article h2, article [role="heading"]', textRe: CONFIG.suggestedRe, closest: 'article', maxLen: 30 });
      // 右サイドバーのおすすめアカウント（デスクトップ）
      FB.hideByText({ selector: 'aside span, aside h3, aside [role="heading"]', textRe: CONFIG.suggestedRe, closest: 'aside', maxLen: 30 });
      hideSuggestedAccounts();
    }
  }

  // フィードに挿入される「おすすめアカウント」カルーセル（article ではない）を丸ごと隠す。
  // 「フォロー」ボタンを2つ以上含み <article> を含まない最大の塊＝カルーセルを対象にする。
  function hideSuggestedAccounts() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!CONFIG.followBtnRe.test((b.textContent || '').trim())) continue;
      if (b.closest('article')) continue;              // 記事内はおすすめ投稿側で処理
      if (b.closest('[data-fb-hide="1"]')) continue;   // 既に非表示
      var best = null, el = b;
      for (var k = 0; k < 12 && el.parentElement; k++) {
        el = el.parentElement;
        if (el.querySelector('article')) break;        // 実投稿を巻き込む手前で止める
        var n = 0, bs = el.querySelectorAll('button');
        for (var j = 0; j < bs.length; j++) {
          if (CONFIG.followBtnRe.test((bs[j].textContent || '').trim())) n++;
        }
        if (n >= 2) best = el;
      }
      if (best && CONFIG.suggestHintRe.test(best.textContent || '')) FB.mark(best);
    }
  }

  function focusRedirect() {
    if (!s.focusMode) return false;
    var p = path();
    for (var i = 0; i < CONFIG.focusAllow.length; i++) if (CONFIG.focusAllow[i].test(p)) return false;
    location.replace('https://www.instagram.com' + CONFIG.focusTarget);
    return true;
  }

  function apply() {
    if (!root.enabled || !s.enabled) {
      FB.removeStyle('fb-ig'); FB.unhideAll();
      FB.removeBlockOverlay('fb-ig-explore'); FB.removeBlockOverlay('fb-ig-reels');
      counter.setActive(false);
      return;
    }
    if (focusRedirect()) return;
    FB.setStyle('fb-ig', buildCSS());
    handleOverlays();
    hideFeedJunk();
    counter.setActive(s.limitScroll && isHome(), s.scrollLimit, root.resetMinutes);
  }

  FB.getSettings().then(function (settings) {
    root = settings; s = settings.instagram;
    apply();
    FB.observe(apply);
    FB.onLocationChange(apply);
    FB.onSettingsChange(function (next) { root = next; s = next.instagram; FB.unhideAll(); apply(); });
  });
})();

/* ==================== extension/content/youtube.js ==================== */
/*
 * Focus Blocker — YouTube module
 * -------------------------------------------------------------
 * Hides: Home recommendation grid, Shorts (shelves + sidebar guide entries),
 * "Up next"/related sidebar, in-player end-screen suggestions, (optional)
 * comments. Optionally redirects Home -> Subscriptions and /shorts -> /watch.
 *
 * Most YouTube targets are custom elements (ytd-*), so CSS selectors are
 * locale-independent and reliable. The only localized bit is the Shorts
 * *guide entry* title (e.g. "ショート"), handled by CSS for common locales
 * plus a JS text fallback below.  ← adjust CONFIG if YouTube changes markup.
 */
(function () {
  'use strict';
  var FB = window.FB;
  if (!FB) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  var CONFIG = {
    // Shorts guide-entry titles across locales (JS fallback / CSS list).
    shortsTitleRe: /^(shorts|ショート|쇼츠|шортс|短视频|短影片|séquences|kurzvideos|شورتس)$/i
  };

  var s = FB.DEFAULTS.youtube;
  var root = FB.DEFAULTS;

  function path() { return location.pathname; }

  function buildCSS() {
    var css = '';

    if (s.hideHomeFeed) {
      css +=
        'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer,' +
        'ytd-browse[page-subtype="home"] #chips-wrapper,' +
        'ytd-browse[page-subtype="home"] ytd-rich-section-renderer{display:none !important;}';
    }
    if (s.hideShorts) {
      css +=
        // shelves / lockups (locale-independent)
        'ytd-rich-shelf-renderer[is-shorts],ytd-reel-shelf-renderer,' +
        'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),' +
        'grid-shelf-view-model,ytm-shorts-lockup-view-model,' +
        // individual shorts entries in search / subscriptions
        'ytd-video-renderer:has(a[href*="/shorts/"]),' +
        'ytd-grid-video-renderer:has(a[href*="/shorts/"]),' +
        'ytd-rich-item-renderer:has(a[href*="/shorts/"]),' +
        // left guide + mini-guide entries (href form + localized titles)
        'ytd-guide-entry-renderer:has(> a[href="/shorts"]),' +
        'ytd-mini-guide-entry-renderer:has(a[href="/shorts"]),' +
        'ytd-guide-entry-renderer:has(> a#endpoint[title="Shorts"]),' +
        'ytd-guide-entry-renderer:has(> a#endpoint[title="ショート"]),' +
        'ytd-guide-entry-renderer:has(> a#endpoint[title="쇼츠"]),' +
        'ytd-mini-guide-entry-renderer:has(a[title="Shorts"]),' +
        'ytd-mini-guide-entry-renderer:has(a[title="ショート"]),' +
        'ytd-mini-guide-entry-renderer:has(a[title="쇼츠"])' +
        '{display:none !important;}';
    }
    if (s.hideRelated) {
      css += '#related,ytd-watch-next-secondary-results-renderer{display:none !important;}';
    }
    if (s.hideEndScreen) {
      css += '.html5-endscreen,.ytp-endscreen-content,.ytp-ce-element,.ytp-ce-covering-overlay{display:none !important;}';
    }
    if (s.hideComments) {
      css += '#comments,ytd-comments{display:none !important;}';
    }
    return css;
  }

  // JS fallback: hide Shorts guide entries in any locale not covered by CSS.
  function hideShortsGuide() {
    if (!s.hideShorts) return;
    var entries = document.querySelectorAll('ytd-guide-entry-renderer,ytd-mini-guide-entry-renderer');
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      var a = en.querySelector('a[title]');
      var title = a ? a.getAttribute('title') : '';
      if (!title) {
        var t = en.querySelector('.title, yt-formatted-string.title');
        title = t ? (t.textContent || '').trim() : '';
      }
      if (title && CONFIG.shortsTitleRe.test(title.trim())) FB.mark(en);
    }
  }

  function handleRedirects() {
    if (s.redirectHome && root.enabled && s.enabled &&
        (path() === '/' || path() === '/feed/explore' || path() === '/feed/trending')) {
      location.replace('/feed/subscriptions');
      return true;
    }
    if (s.redirectShorts && path().indexOf('/shorts/') === 0 && root.enabled && s.enabled) {
      var id = path().split('/')[2];
      if (id) { location.replace('/watch?v=' + encodeURIComponent(id)); return true; }
    }
    return false;
  }

  function apply() {
    if (!root.enabled || !s.enabled) {
      FB.removeStyle('fb-youtube');
      FB.unhideAll();
      return;
    }
    if (handleRedirects()) return;
    FB.setStyle('fb-youtube', buildCSS());
    hideShortsGuide();
  }

  FB.getSettings().then(function (settings) {
    root = settings; s = settings.youtube;
    apply();
    FB.observe(apply);
    FB.onLocationChange(apply);
    FB.onSettingsChange(function (next) { root = next; s = next.youtube; FB.unhideAll(); apply(); });
  });
})();
