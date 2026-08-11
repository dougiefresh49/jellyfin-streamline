/* Jellyfin Streamline — theme.js  (v4)
 * Route-scoped hijack of Home, Series, and Movie views. Renders custom Netflix/Disney+-style
 * show->seasons->episodes and movie views from the Jellyfin REST API (via window.ApiClient).
 * Playback delegates to Jellyfin's native controls (playbackManager is a module export, not global):
 *   - series Play  -> click the native .btnPlay (data-action="resume") on the series page
 *   - an episode   -> navigate to its detail hash, then click that page's native play control
 * Verified against live Jellyfin 10.11 markup: primary=.btnPlay[data-action=resume],
 *   from-start=.btnReplay[data-action=play] (hidden), overflow=.btnMoreCommands.
 * Reinjection-safe via a versioned global sentinel with dispose().
 */
(function () {
  'use strict';
  var VERSION = 4;
  if (window.__streamlineTheme && typeof window.__streamlineTheme.dispose === 'function') {
    try { window.__streamlineTheme.dispose(); } catch (e) {}
  }

  // TEMPORARY (remove before release): the Samsung TV app gives no console and
  // no remote web inspector, so the only way to observe the theme there is to
  // draw its state on the screen and read it off a camera.
  // Off unless explicitly asked for. The TV build opts in by appending
  // ?sldebug=1 to the app's entry redirect (see scripts/tizen/build-tizen.sh),
  // since there is no console or address bar on a TV to turn it on any other way.
  var DEBUG = /[?&]sldebug=1/.test(location.search) || /sldebug=1/.test(location.hash) ||
    (function () { try { return localStorage.getItem('sl.debug') === '1'; } catch (e) { return false; } })();
  var debugEl = null;
  function debugBanner(message) {
    if (!DEBUG) return;
    try {
      if (!debugEl) {
        debugEl = document.createElement('div');
        debugEl.id = 'streamline-debug';
        debugEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;' +
          'background:#000;color:#0f0;font:700 28px/1.35 monospace;padding:10px 14px;' +
          'white-space:pre-wrap;word-break:break-word;border-bottom:4px solid #0f0';
        (document.body || document.documentElement).appendChild(debugEl);
      }
      debugEl.textContent = 'SL v' + VERSION + ': ' + message;
    } catch (e) {}
  }

  var CONTAINER_ID = 'streamline-detail';
  var ACTIVE_CLASS = 'streamline-series-active';
  var gen = 0;
  var mounted = null;          // { el, page, pagePrevPosition }
  var hashHandler = null;
  var accentObserver = null;
  var accentPicker = null;     // { section, form, submitHandler, targetUserId, confirmed, selected }
  var accentCache = {};
  var accentQueue = Promise.resolve();
  var accentSelectionGen = 0;
  var knownCurrentUserId = null;
  var timeoutIds = [];
  var initInterval = null;
  var accentMountTimer = null;
  var homeMounted = null;      // { el, page, pagePrevPosition, uid, generation }
  var homeObserver = null;
  var homeRetryTimer = null;
  var homeObserverTimer = null;
  var homeAuthTimer = null;
  var homeAuthSignalHandler = null;
  var homeAuthTries = 0;
  var homeMountTries = 0;
  var homeUserTimer = null;
  var homeGen = 0;
  var homeState = {};
  var homeReturnKey = null;
  var avatarCache = {};
  var playPollTimer = null;
  var playRequest = 0;
  var homeTimeoutIds = [];
  var rafIds = [];
  var ACCENT_PREF = 'streamlineAccent';
  var ACCENTS = {
    violet: { name: 'Violet', accent: '#7c5cff', ink: '#0a0713' },
    sky: { name: 'Sky', accent: '#38bdf8', ink: '#041018' },
    mint: { name: 'Mint', accent: '#34d399', ink: '#04150c' },
    amber: { name: 'Amber', accent: '#fbbf24', ink: '#1a1002' },
    coral: { name: 'Coral', accent: '#fb7185', ink: '#1c040a' },
    mono: { name: 'Mono', accent: '#e2e8f0', ink: '#0b0b0d' }
  };
  var ACCENT_IDS = ['violet', 'sky', 'mint', 'amber', 'coral', 'mono'];

  // ---------- helpers ----------
  function api() { return window.ApiClient; }
  function userId() { return api() && api().getCurrentUserId(); }
  function validAccent(id) { return typeof id === 'string' && !!ACCENTS[id]; }
  function scheduleTimeout(callback, delay) {
    var id = setTimeout(function () {
      var index = timeoutIds.indexOf(id);
      if (index !== -1) timeoutIds.splice(index, 1);
      callback();
    }, delay);
    timeoutIds.push(id);
    return id;
  }
  function cancelTimeout(id) {
    if (id === null || typeof id === 'undefined') return;
    clearTimeout(id);
    var index = timeoutIds.indexOf(id);
    if (index !== -1) timeoutIds.splice(index, 1);
  }
  function cancelHomeTimeout(id) {
    if (id === null || typeof id === 'undefined') return;
    cancelTimeout(id);
    var index = homeTimeoutIds.indexOf(id);
    if (index !== -1) homeTimeoutIds.splice(index, 1);
  }
  function scheduleHomeTimeout(callback, delay) {
    var id = scheduleTimeout(function () {
      var index = homeTimeoutIds.indexOf(id);
      if (index !== -1) homeTimeoutIds.splice(index, 1);
      callback();
    }, delay);
    homeTimeoutIds.push(id);
    return id;
  }
  function clearHomeTimeouts() {
    while (homeTimeoutIds.length) cancelHomeTimeout(homeTimeoutIds.pop());
    homeRetryTimer = null; homeObserverTimer = null; homeAuthTimer = null; homeUserTimer = null;
  }
  function scheduleRaf(callback) {
    var id = requestAnimationFrame(function () {
      var index = rafIds.indexOf(id);
      if (index !== -1) rafIds.splice(index, 1);
      callback();
    });
    rafIds.push(id); return id;
  }
  function clearRafs() { while (rafIds.length) cancelAnimationFrame(rafIds.pop()); }
  function clearScheduledWork() {
    while (timeoutIds.length) clearTimeout(timeoutIds.pop());
    accentMountTimer = null;
    homeRetryTimer = null; homeObserverTimer = null; homeAuthTimer = null; playPollTimer = null;
    // A timeout id, not an interval id, since the bootstrap reschedules itself.
    if (initInterval !== null) { clearTimeout(initInterval); initInterval = null; }
  }
  function serverId() {
    try { return api() && api().serverId(); } catch (e) { return null; }
  }
  function accentKey(uid) {
    var sid = serverId();
    return sid && uid ? sid + '.' + uid : null;
  }
  function accentStorageKey(uid) {
    var key = accentKey(uid);
    return key ? 'streamline.accent.' + key : null;
  }
  function checkAuth() {
    var current = userId() || null;
    if (knownCurrentUserId !== current) {
      accentCache = {};
      avatarCache = {};
      homeState = {};
      homeReturnKey = null;
      knownCurrentUserId = current;
      if (homeMounted && homeMounted.uid !== current) teardownHome(false);
      if (!current) {
        teardownAccentRoute();
        if (mounted) applyAccent(mounted.el, null);
      }
    }
    return current;
  }
  function cachedAccent(uid) {
    if (!uid || !checkAuth()) return null;
    var key = accentKey(uid);
    if (!key) return null;
    if (!accentCache[key]) {
      var stored = null;
      try { stored = localStorage.getItem(accentStorageKey(uid)); } catch (e) {}
      accentCache[key] = { loaded: false, value: validAccent(stored) ? stored : null, inflight: null };
    }
    return accentCache[key].value;
  }
  function commitAccent(uid, presetId) {
    if (!uid || !checkAuth()) return;
    var key = accentKey(uid);
    var storageKey = accentStorageKey(uid);
    if (!key || !storageKey) return;
    var value = validAccent(presetId) ? presetId : null;
    var entry = accentCache[key] || { loaded: false, value: null, inflight: null };
    entry.loaded = true; entry.value = value;
    accentCache[key] = entry;
    try {
      if (value) localStorage.setItem(storageKey, value);
      else localStorage.removeItem(storageKey);
    } catch (e) {}
  }
  function applyAccent(root, presetId) {
    if (!root) return;
    var preset = validAccent(presetId) ? ACCENTS[presetId] : null;
    try {
      if (preset) {
        root.style.setProperty('--sl-accent', preset.accent);
        root.style.setProperty('--sl-accent-ink', preset.ink);
      } else {
        root.style.removeProperty('--sl-accent');
        root.style.removeProperty('--sl-accent-ink');
      }
    } catch (e) {}
  }
  function fetchAccent(uid) {
    var authUid = checkAuth();
    var key = accentKey(uid);
    if (!authUid || !uid || !key) return Promise.reject(new Error('No authenticated user'));
    cachedAccent(uid);
    var entry = accentCache[key];
    if (entry.inflight) return entry.inflight;
    entry.inflight = queueAccentWork(function () {
      if (authUid !== userId() || key !== accentKey(uid)) throw new Error('User changed');
      return api().getDisplayPreferences('usersettings', uid, 'emby').then(function (prefs) {
        if (authUid !== userId() || key !== accentKey(uid)) throw new Error('User changed');
        var value = prefs && prefs.CustomPrefs && prefs.CustomPrefs[ACCENT_PREF];
        value = validAccent(value) ? value : null;
        commitAccent(uid, value);
        return value;
      });
    }).then(function (value) {
      if (accentCache[key]) accentCache[key].inflight = null;
      return value;
    }, function (err) {
      if (accentCache[key]) accentCache[key].inflight = null;
      throw err;
    });
    return entry.inflight;
  }
  // The OSD's fast-forward is a fixed skip whose length comes from the user
  // setting skipForwardLength (default 30s). The theme's player styling draws
  // that button as a circled 10, so the behavior has to match. Seed 10s ONCE
  // per user, only when they have never chosen a value themselves -- a later
  // explicit choice (5s..30s in Display settings) is theirs and stays.
  function seedSkipLength() {
    var uid = userId();
    if (!uid) return;
    var mark = 'sl.skipSeed.' + uid;
    try { if (localStorage.getItem(mark)) return; } catch (e) { return; }
    api().getDisplayPreferences('usersettings', uid, 'emby').then(function (prefs) {
      if (!prefs || uid !== userId()) return;
      prefs.CustomPrefs = prefs.CustomPrefs || {};
      if (prefs.CustomPrefs.skipForwardLength != null) {
        try { localStorage.setItem(mark, '1'); } catch (e) {}
        return;
      }
      prefs.CustomPrefs.skipForwardLength = '10000';
      return api().updateDisplayPreferences('usersettings', prefs, uid, 'emby').then(function () {
        try { localStorage.setItem(mark, '1'); } catch (e) {}
      });
    }).catch(function () {});
  }
  function ticksToMin(t) { return Math.round((t || 0) / 600000000); }
  function el(tag, attrs, children) {
    var svgTags = { svg: true, circle: true, path: true };
    var n = svgTags[tag] ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];              // server text -> textContent, never innerHTML
      else if (k === 'style') n.setAttribute('style', attrs[k]);
      else if (k === 'html') { /* intentionally unsupported */ }
      else if (k in n) { try { n[k] = attrs[k]; } catch (e) { n.setAttribute(k, attrs[k]); } }
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function imageUrl(item, type, maxWidth) {
    var tags = item.ImageTags || {};
    var tag = type === 'Backdrop' ? (item.BackdropImageTags || [])[0] : tags[type];
    if (!tag) return null;
    try { return api().getImageUrl(item.Id, { type: type, tag: tag, maxWidth: maxWidth || 640 }); }
    catch (e) { return null; }
  }
  function inheritedLandscapeUrl(item, maxWidth) {
    var url = imageUrl(item, 'Primary', maxWidth) || imageUrl(item, 'Backdrop', maxWidth) || imageUrl(item, 'Thumb', maxWidth);
    var tags = item.ParentBackdropImageTags || [];
    if (url || !item.ParentBackdropItemId || !tags[0]) return url;
    try { return api().getImageUrl(item.ParentBackdropItemId, { type: 'Backdrop', tag: tags[0], maxWidth: maxWidth || 640 }); }
    catch (e) { return null; }
  }
  function heroBackdropUrl(item, maxWidth) {
    // The hero fills the screen and wants 1280; a focused tile is ~400px wide,
    // so asking for 1280 there costs decode time and memory on the TV for
    // detail nobody sees.
    var width = maxWidth || 1280;
    var url = imageUrl(item, 'Backdrop', width);
    var tags = item.ParentBackdropImageTags || [];
    if (url || !item.ParentBackdropItemId || !tags[0]) return url;
    try { return api().getImageUrl(item.ParentBackdropItemId, { type: 'Backdrop', tag: tags[0], maxWidth: width }); }
    catch (e) { return null; }
  }
  function thumb(item, opts) {
    var box = el('div', { className: 'sl-thumb' });
    var url = imageUrl(item, 'Primary', 320) || imageUrl(item, 'Backdrop', 320);
    if (url) {
      var img = el('img', { src: url, loading: 'lazy', alt: '' });
      img.addEventListener('error', function () { img.remove(); });   // image fallback (must-fix g)
      box.appendChild(img);
    }
    if (opts && opts.progress > 0) {
      var bar = el('div', { className: 'sl-progress' }); bar.appendChild(el('i', { style: 'width:' + Math.min(100, opts.progress) + '%' }));
      box.appendChild(bar);
    }
    if (opts && opts.watched) box.appendChild(el('div', { className: 'sl-watched', text: '✓' }));
    return box;
  }

  // ---------- native playback delegation ----------
  function visibleDetailPage() {
    var pages = document.querySelectorAll('#itemDetailPage:not(.hide), .page.itemDetailPage:not(.hide)');
    for (var i = 0; i < pages.length; i++) { if (pages[i].offsetParent !== null) return pages[i]; }
    return null;
  }
  // click the native play control on the given detail page; retries briefly for the native bind race
  function nativeDetailPlay(page, cb, tries) {
    tries = tries || 0;
    var btn = page && page.querySelector('.mainDetailButtons .btnPlay:not(.hide)');
    if (btn) { btn.click(); if (cb) cb(true); return; }
    if (tries < 25) return void scheduleTimeout(function () { nativeDetailPlay(page, cb, tries + 1); }, 120);
    if (cb) cb(false);
  }
  function nativeOverflow(page) {
    var btn = page && page.querySelector('.mainDetailButtons .btnMoreCommands:not(.hide)');
    if (btn) btn.click();
  }
  function trailerButton(page) {
    var btn = el('button', { className: 'sl-icon-btn sl-trailer', type: 'button', 'aria-label': 'Trailer', hidden: true });
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    path.setAttribute('d', 'M4 9h16v10H4z M4 9l2-4h4L8 9m5 0 2-4h4l-2 4 M9 13l5 3-5 3z');
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.addEventListener('click', function () {
      // resolve the live page at click time — the mount-time node can be replaced by SPA re-renders
      var p = visibleDetailPage() || page;
      var nativeBtn = p && p.querySelector('.mainDetailButtons .btnPlayTrailer:not(.hide)');
      if (nativeBtn) nativeBtn.click();
    });
    return btn;
  }
  // play a concrete item: navigate to its detail, then click that page's native play control
  function playItem(itemId) {
    var requested = String(itemId || '');
    if (!requested) return;
    var request = ++playRequest;
    if (playPollTimer !== null) { cancelTimeout(playPollTimer); playPollTimer = null; }
    // The route can update while the OLD detail page is still the visible one
    // (view transition), and both pages carry an identical .btnPlay. Clicking
    // during that window plays the SERIES resume target (Next Up) instead of
    // the tapped episode. Remember the outgoing page and refuse to click it;
    // jellyfin alternates detail-view elements, so the destination is a
    // different node. After the transition window has safely passed, accept
    // whatever is visible rather than never playing at all.
    var pageAtStart = visibleDetailPage();
    location.hash = '#/details?id=' + encodeURIComponent(requested);
    var tries = 0;
    (function poll() {
      if (request !== playRequest) return;
      var routeId = currentDetailId();
      var p = visibleDetailPage();
      var btn = p && p.querySelector('.mainDetailButtons .btnPlay:not(.hide), .mainDetailButtons .btnReplay:not(.hide)');
      var settled = p && (p !== pageAtStart || tries > 15);
      if (routeId === requested && btn && settled) { playPollTimer = null; btn.click(); return; }
      if (tries++ < 40) playPollTimer = scheduleTimeout(function () { playPollTimer = null; poll(); }, 120);
    })();
  }

  // ---------- render pieces ----------
  function metaLine(item) {
    var bits = [];
    if (item.ProductionYear) bits.push(el('span', { text: String(item.ProductionYear) }));
    if (item.OfficialRating) bits.push(el('span', { className: 'sl-badge', text: item.OfficialRating }));
    if (item.ChildCount) bits.push(el('span', { text: item.ChildCount + ' Season' + (item.ChildCount > 1 ? 's' : '') }));
    if (item.Type === 'Movie' && item.RunTimeTicks) bits.push(el('span', { text: runtimeLabel(item.RunTimeTicks) }));
    if (item.CommunityRating) bits.push(el('span', { text: '★ ' + item.CommunityRating.toFixed(1) }));
    return el('div', { className: 'sl-meta' }, bits);
  }
  function runtimeLabel(ticks) {
    var minutes = ticksToMin(ticks);
    var hours = Math.floor(minutes / 60);
    var remainder = minutes % 60;
    return hours ? hours + 'h' + (remainder ? ' ' + remainder + 'm' : '') : minutes + 'm';
  }
  function synopsis(item) {
    if (!item.Overview) return null;
    var wrap = el('div', { className: 'sl-synopsis', 'data-expanded': 'false' });
    var p = el('p', { text: item.Overview });
    wrap.appendChild(p);
    var btn = el('button', { className: 'sl-more', type: 'button', text: 'Show more', 'aria-expanded': 'false' });
    btn.addEventListener('click', function () {
      var open = wrap.getAttribute('data-expanded') === 'true';
      wrap.setAttribute('data-expanded', open ? 'false' : 'true');
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      btn.textContent = open ? 'Show more' : 'Show less';
    });
    wrap.appendChild(btn);
    // only show the toggle if the text actually overflows (measure after layout)
    scheduleRaf(function () { if (p.isConnected && p.scrollHeight <= p.clientHeight + 2) btn.style.display = 'none'; });
    return wrap;
  }
  function continueCard(nextItem) {
    if (!nextItem) return null;
    var ud = nextItem.UserData || {};
    var pct = ud.PlayedPercentage || 0;
    var inProgress = (ud.PlaybackPositionTicks || 0) > 0;
    var left = ticksToMin((nextItem.RunTimeTicks || 0) - (ud.PlaybackPositionTicks || 0));
    var epLabel = 'S' + (nextItem.ParentIndexNumber || 1) + ':E' + (nextItem.IndexNumber || 1) + ' · ' + (nextItem.Name || '');
    var card = el('button', { className: 'sl-continue', type: 'button' }, [
      thumb(nextItem, { progress: pct }),
      el('div', {}, [
        el('div', { className: 'sl-c-title', text: nextItem.Name || 'Play' }),      // episode name, not the section label
        el('div', { className: 'sl-c-sub', text: epLabel + (inProgress ? ' · ' + left + ' min left' : '') })
      ])
    ]);
    card.addEventListener('click', function () { playItem(nextItem.Id); });        // play THIS episode
    return { card: card, inProgress: inProgress };
  }
  function episodeRow(ep) {
    var ud = ep.UserData || {};
    var row = el('button', { className: 'sl-ep', type: 'button' }, [
      thumb(ep, { watched: !!ud.Played, progress: ud.PlayedPercentage || 0 }),
      el('div', {}, [
        el('div', { className: 'sl-ep-title', text: (ep.IndexNumber ? ep.IndexNumber + '. ' : '') + (ep.Name || '') }),
        el('div', { className: 'sl-ep-run', text: ep.RunTimeTicks ? ticksToMin(ep.RunTimeTicks) + 'm' : '' }),
        ep.Overview ? el('div', { className: 'sl-ep-desc', text: ep.Overview }) : null
      ])
    ]);
    row.addEventListener('click', function () { playItem(ep.Id); });
    return row;
  }
  function seasonCard(season, onSelect) {
    var card = el('button', { className: 'sl-season', type: 'button', 'aria-selected': 'false' }, [
      el('div', { className: 'sl-s-num', text: season.Name || ('Season ' + (season.IndexNumber || '')) }),
      el('div', { className: 'sl-s-count', text: (season.ChildCount || 0) + ' episodes' })
    ]);
    card.addEventListener('click', function () { onSelect(season, card); });
    return card;
  }
  function specialFeatures(uid, itemId) {
    if (typeof api().getSpecialFeatures === 'function') return api().getSpecialFeatures(uid, itemId);
    return api().ajax({
      type: 'GET',
      url: api().getUrl('Users/' + uid + '/Items/' + itemId + '/SpecialFeatures'),
      dataType: 'json'
    });
  }
  function extraRow(item) {
    var row = el('button', { className: 'sl-extra', type: 'button' }, [
      thumb(item),
      el('div', { className: 'sl-extra-copy' }, [
        el('div', { className: 'sl-extra-title', text: item.Name || 'Extra' }),
        el('div', { className: 'sl-extra-run', text: item.RunTimeTicks ? runtimeLabel(item.RunTimeTicks) : '' })
      ])
    ]);
    row.addEventListener('click', function () { playItem(item.Id); });
    return row;
  }

  // ---------- per-user accent preference ----------
  function setPickerSelection(picker, presetId) {
    if (!picker || !picker.section) return;
    presetId = validAccent(presetId) ? presetId : 'violet';
    picker.selected = presetId;
    Array.prototype.forEach.call(picker.section.querySelectorAll('[role="radio"]'), function (button) {
      button.setAttribute('aria-checked', String(button.getAttribute('data-accent') === presetId));
    });
  }
  function queueAccentWork(work) {
    accentQueue = accentQueue.then(work, work);
    return accentQueue;
  }
  function writeAccentPreference(picker, presetId, stillCurrent) {
    return api().getDisplayPreferences('usersettings', picker.targetUserId, 'emby').then(function (freshPrefs) {
      if (!stillCurrent()) return;
      freshPrefs = freshPrefs || {};
      freshPrefs.CustomPrefs = freshPrefs.CustomPrefs || {};
      if (validAccent(presetId)) freshPrefs.CustomPrefs[ACCENT_PREF] = presetId;
      else delete freshPrefs.CustomPrefs[ACCENT_PREF];
      return api().updateDisplayPreferences('usersettings', freshPrefs, picker.targetUserId, 'emby');
    });
  }
  function saveAccent(picker, presetId, selectionGeneration) {
    queueAccentWork(function () {
      var authUid = checkAuth();
      if (!authUid || !picker || picker !== accentPicker || selectionGeneration !== accentSelectionGen) return;
      function stillCurrent() {
        return picker === accentPicker && authUid === userId() && selectionGeneration === accentSelectionGen;
      }
      return writeAccentPreference(picker, presetId, stillCurrent).then(function () {
        if (!stillCurrent()) return;
        picker.confirmed = presetId;
        commitAccent(picker.targetUserId, presetId);
        setPickerSelection(picker, presetId);
      });
    }).catch(function () {
      if (picker === accentPicker && selectionGeneration === accentSelectionGen) setPickerSelection(picker, picker.confirmed);
    });
  }
  function reconcileNativeSave(picker) {
    scheduleTimeout(function () {
      queueAccentWork(function () {
        var authUid = checkAuth();
        if (!authUid || picker !== accentPicker) return;
        var desired = picker.selected;
        return api().getDisplayPreferences('usersettings', picker.targetUserId, 'emby').then(function (prefs) {
          if (picker !== accentPicker || authUid !== userId()) return;
          var current = prefs.CustomPrefs && prefs.CustomPrefs[ACCENT_PREF];
          if (current === desired) return;
          return writeAccentPreference(picker, desired, function () {
            return picker === accentPicker && authUid === userId();
          }).then(function () {
            if (picker === accentPicker && authUid === userId()) commitAccent(picker.targetUserId, desired);
          });
        });
      }).catch(function () {});
    }, 350);
  }
  function disposeAccentPicker() {
    if (!accentPicker) return;
    try { accentPicker.form.removeEventListener('submit', accentPicker.submitHandler); } catch (e) {}
    try { accentPicker.section.remove(); } catch (e) {}
    accentPicker = null;
    accentSelectionGen++;
  }
  function displayTargetUserId() {
    var current = checkAuth();
    if (!current) return null;
    try {
      var query = (location.hash.split('?')[1] || '').split('#')[0];
      return new URLSearchParams(query).get('userId') || current;
    } catch (e) { return current; }
  }
  function mountAccentPicker() {
    if (!/^#\/?mypreferencesdisplay(?:\?|$)/i.test(location.hash || '')) return;
    var targetUid = displayTargetUserId();
    var form = document.querySelector('#displayPreferencesPage form');
    if (!targetUid || !form) return;
    if (accentPicker && accentPicker.form === form && accentPicker.targetUserId === targetUid) return;
    disposeAccentPicker();
    var authUid = userId();
    fetchAccent(targetUid).then(function (presetId) {
      if (authUid !== userId() || targetUid !== displayTargetUserId() || !form.isConnected || document.getElementById('streamline-accent-picker')) return;
      var section = el('div', { id: 'streamline-accent-picker', className: 'sl-accent-picker verticalSection' });
      section.appendChild(el('h2', { className: 'sectionTitle', text: 'Accent color' }));
      var group = el('div', { className: 'sl-accent-options', role: 'radiogroup', 'aria-label': 'Accent color' });
      var picker = { section: section, form: form, targetUserId: targetUid, confirmed: presetId, selected: presetId, submitHandler: null };
      ACCENT_IDS.forEach(function (id) {
        var button = el('button', { className: 'sl-accent-swatch', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': ACCENTS[id].name, 'data-accent': id });
        button.style.setProperty('--sl-swatch', ACCENTS[id].accent);
        button.style.setProperty('--sl-swatch-ink', ACCENTS[id].ink);
        button.appendChild(el('span', { className: 'sl-accent-check', text: '✓', 'aria-hidden': 'true' }));
        button.addEventListener('click', function () {
          var selectionGeneration = ++accentSelectionGen;
          setPickerSelection(picker, id);
          saveAccent(picker, id, selectionGeneration);
        });
        group.appendChild(button);
      });
      section.appendChild(group);
      picker.submitHandler = function () { reconcileNativeSave(picker); };
      form.addEventListener('submit', picker.submitHandler);
      form.appendChild(section);
      accentPicker = picker;
      setPickerSelection(picker, presetId);
    }).catch(function () {}); // unauthorized/failed target GET: omit the picker
  }
  function updateAccentRoute() {
    var onDisplay = /^#\/?mypreferencesdisplay(?:\?|$)/i.test(location.hash || '');
    if (!onDisplay || !checkAuth()) {
      teardownAccentRoute();
      return;
    }
    var displayPage = document.getElementById('displayPreferencesPage');
    if (!displayPage) {
      if (accentMountTimer === null) accentMountTimer = scheduleTimeout(function () {
        accentMountTimer = null;
        updateAccentRoute();
      }, 100);
      return;
    }
    if (!accentObserver) {
      accentObserver = new MutationObserver(function () {
        if (accentMountTimer !== null) cancelTimeout(accentMountTimer);
        accentMountTimer = scheduleTimeout(function () {
          accentMountTimer = null;
          if (accentPicker && (!accentPicker.form.isConnected || !accentPicker.section.isConnected)) disposeAccentPicker();
          mountAccentPicker();
        }, 75);
      });
      accentObserver.observe(displayPage, { childList: true, subtree: true });
    }
    mountAccentPicker();
  }
  function teardownAccentRoute() {
    if (accentMountTimer !== null) { cancelTimeout(accentMountTimer); accentMountTimer = null; }
    if (accentObserver) { try { accentObserver.disconnect(); } catch (e) {} accentObserver = null; }
    disposeAccentPicker();
  }

  // ---------- home transform ----------
  // Jellyfin still uses the legacy "#/home.html" form in places -- notably the
  // route it lands on right after sign-in. Matching only "#/home" meant a fresh
  // login showed a stock, untransformed home until something else changed the
  // route, while a resumed session looked fine. Accept both spellings.
  function isHomeRoute() { return /^#\/?home(?:\.html)?(?:[?#]|$)/i.test(location.hash || ''); }
  function visibleHomePage() {
    var page = document.querySelector('#indexPage.homePage:not(.hide)');
    return page && page.isConnected && page.offsetParent !== null ? page : null;
  }
  function homeKey(uid) { var sid = serverId(); return sid && uid ? sid + '.' + uid : null; }
  function validHome(myGen, uid, root, page) {
    return myGen === homeGen && uid === userId() && homeMounted && homeMounted.el === root &&
      homeMounted.page === page && root.isConnected && page.isConnected && page.offsetParent !== null;
  }
  function captureHomeState() {
    if (!homeMounted || !homeMounted.el || !homeMounted.uid) return;
    var key = homeKey(homeMounted.uid); if (!key) return;
    var rails = {};
    Array.prototype.forEach.call(homeMounted.el.querySelectorAll('.sl-home-rail[data-rail]'), function (rail) {
      rails[rail.getAttribute('data-rail')] = rail.scrollLeft;
    });
    homeState[key] = { scrollTop: homeMounted.el.scrollTop, rails: rails };
    homeReturnKey = key;
  }
  function restoreHomeState(root, uid, myGen, page) {
    var key = homeKey(uid);
    var state = key && homeReturnKey === key ? homeState[key] : null;
    if (!state) return;
    scheduleHomeTimeout(function () {
      if (!validHome(myGen, uid, root, page)) return;
      root.scrollTop = state.scrollTop;
      Array.prototype.forEach.call(root.querySelectorAll('.sl-home-rail[data-rail]'), function (rail) {
        var railName = rail.getAttribute('data-rail');
        if (Object.prototype.hasOwnProperty.call(state.rails, railName)) rail.scrollLeft = state.rails[railName];
      });
      homeReturnKey = null;
    }, 0);
  }
  function homeNavigate(hash) { captureHomeState(); location.hash = hash; }
  function detailsTarget(item) { return item && (item.Type === 'Episode' ? (item.SeriesId || item.Id) : item.Id); }
  function navigateDetails(item) {
    var id = detailsTarget(item); if (id) homeNavigate('#/details?id=' + encodeURIComponent(id));
  }
  function itemTitle(item) { return item && (item.Type === 'Episode' ? (item.SeriesName || item.Name) : item.Name) || 'Untitled'; }
  function episodeLabel(item) {
    if (!item || item.Type !== 'Episode') return '';
    var season = item.ParentIndexNumber; var episode = item.IndexNumber;
    return season != null && episode != null ? 'S' + season + ':E' + episode : '';
  }
  function remainingLabel(item) {
    var ud = item.UserData || {};
    var metadata = episodeLabel(item);
    var runtime = item.RunTimeTicks || 0;
    var position = ud.PlaybackPositionTicks || 0;
    var remaining = Math.max(0, runtime - position);
    if (runtime > 0 && remaining > 0) {
      var minutes = ticksToMin(remaining);
      if (minutes > 0) return (metadata ? metadata + ' · ' : '') + minutes + ' min left';
    }
    if (metadata) return metadata;
    return runtime > 0 ? runtimeLabel(runtime) : '';
  }
  function posterLabel(item) {
    if (item.Type === 'Series') {
      var count = item.ChildCount || 0;
      return count + ' season' + (count === 1 ? '' : 's');
    }
    var bits = [];
    if (item.ProductionYear) bits.push(String(item.ProductionYear));
    if (item.RunTimeTicks) bits.push(runtimeLabel(item.RunTimeTicks));
    return bits.join(' · ');
  }
  function homeImage(box, item, landscape, myGen, uid, root, page) {
    var url = landscape ? inheritedLandscapeUrl(item, 640) : imageUrl(item, 'Primary', 360);
    if (!landscape && isTvLayout()) {
      // Netflix's focused tile is the same picture revealed wider, not a
      // different asset. Using the wide art cropped to portrait means focus
      // changes the box only: one decoded bitmap, nothing to fetch or swap
      // while the D-pad is moving. Falls back to the poster when a title has
      // no backdrop, in which case the tile simply does not widen.
      var wide = heroBackdropUrl(item, 640);
      if (wide) url = wide;
    }
    if (!url) return;
    var img = el('img', { src: url, loading: 'lazy', alt: '' });
    img.addEventListener('error', function () {
      if (!validHome(myGen, uid, root, page)) return;
      try { img.remove(); } catch (e) {}
    });
    box.appendChild(img);
  }
  function isTvLayout() {
    return document.documentElement.classList.contains('layout-tv');
  }
  /**
   * On TV, a focused poster widens into a landscape card and swaps its 2:3
   * poster for the 16:9 backdrop -- the Netflix behaviour. The width and
   * aspect-ratio animation is CSS; only the artwork swap needs JS, because the
   * backdrop is a separate image rather than a transform of the poster.
   *
   * A poster with no backdrop available keeps its own art and simply grows, so
   * a missing image degrades to a plain highlight instead of a blank tile.
   */
  function tvFocusExpand(wrap, art, button, item) {
    // Deliberately does no image work. The tile already holds the wide art, so
    // focusing is a class toggle and a box resize -- the cheapest thing that
    // still reads as the Netflix reveal. Anything that fetches or decodes here
    // lands mid-navigation and shows up as lag between rows.
    var wideAvailable = isTvLayout() && !!heroBackdropUrl(item, 640);
    if (!wideAvailable) return;
    button.addEventListener('focus', function () { wrap.classList.add('sl-tv-focus'); });
    button.addEventListener('blur', function () { wrap.classList.remove('sl-tv-focus'); });
  }
  function homeCard(item, kind, myGen, uid, root, page) {
    var landscape = kind === 'continue';
    var title = itemTitle(item);
    var wrap = el('div', { className: 'sl-home-card-wrap ' + (landscape ? 'sl-home-landscape' : 'sl-home-poster') });
    var art = el('div', { className: 'sl-home-art', 'aria-hidden': 'true' });
    homeImage(art, item, landscape, myGen, uid, root, page);
    if (landscape) {
      var ud = item.UserData || {};
      var position = ud.PlaybackPositionTicks || 0;
      if (position > 0 && item.RunTimeTicks) art.appendChild(el('span', { className: 'sl-home-progress' }, [
        el('i', { style: 'width:' + Math.min(100, position / item.RunTimeTicks * 100) + '%' })
      ]));
    }
    var detail = el('button', { className: 'sl-home-card', type: 'button', 'aria-label': 'View details for ' + title }, [
      art,
      el('span', { className: 'sl-home-card-title', text: title }),
      el('span', { className: 'sl-home-card-sub', text: landscape ? remainingLabel(item) : posterLabel(item) })
    ]);
    detail.addEventListener('click', function () { if (validHome(myGen, uid, root, page)) navigateDetails(item); });
    if (!landscape) tvFocusExpand(wrap, art, detail, item);
    wrap.appendChild(detail);
    if (landscape) {
      var action = (item.UserData || {}).PlaybackPositionTicks > 0 ? 'Resume ' : 'Play ';
      var ep = item.Type === 'Episode' && item.IndexNumber != null ? ', episode ' + item.IndexNumber : '';
      var chip = el('button', { className: 'sl-home-play-chip', type: 'button', 'aria-label': action + title + ep, text: '▶' });
      chip.addEventListener('click', function () { if (validHome(myGen, uid, root, page)) { captureHomeState(); playItem(item.Id); } });
      wrap.appendChild(chip);
    }
    return wrap;
  }
  function homeSection(title, name) {
    var headingId = 'sl-home-' + name + '-title';
    var section = el('section', { className: 'sl-home-section', 'aria-labelledby': headingId, 'data-section': name });
    section.appendChild(el('div', { className: 'sl-home-section-head' }, [el('h2', { id: headingId, text: title })]));
    var rail = el('div', { className: 'sl-home-rail', role: 'region', 'aria-label': title, 'data-rail': name });
    for (var i = 0; i < 4; i++) rail.appendChild(el('div', { className: 'sl-home-skeleton ' + (name === 'continue' ? 'sl-home-landscape' : 'sl-home-poster'), 'aria-hidden': 'true' }));
    section.appendChild(rail);
    return section;
  }
  function renderHomeRail(section, items, kind, myGen, uid, root, page) {
    if (!validHome(myGen, uid, root, page)) return;
    if (!items.length) { section.remove(); return; }
    var rail = section.querySelector('.sl-home-rail'); rail.textContent = '';
    items.forEach(function (item) { rail.appendChild(homeCard(item, kind, myGen, uid, root, page)); });
  }
  function heroMeta(item) { return item.Type === 'Episode' ? remainingLabel(item) : posterLabel(item); }
  function renderHomeHero(slot, item, featured, myGen, uid, root, page) {
    if (!validHome(myGen, uid, root, page)) return;
    slot.textContent = '';
    if (!item) { slot.remove(); return; }
    var hero = el('section', { className: 'sl-home-hero', 'aria-labelledby': 'sl-home-featured-title' });
    var bg = heroBackdropUrl(item);
    if (bg) {
      var probe = new Image();
      probe.onload = function () { if (validHome(myGen, uid, root, page)) hero.style.backgroundImage = 'url(' + JSON.stringify(bg) + ')'; };
      probe.onerror = function () { if (!validHome(myGen, uid, root, page)) return; };
      probe.src = bg;
    }
    var resume = !featured;
    var primary = el('button', { className: 'sl-home-primary', type: 'button', text: resume ? '▶  Resume' : '▶  Play' });
    primary.addEventListener('click', function () { if (validHome(myGen, uid, root, page)) { captureHomeState(); playItem(item.Id); } });
    var details = el('button', { className: 'sl-home-secondary', type: 'button', text: 'ⓘ  Details' });
    details.addEventListener('click', function () { if (validHome(myGen, uid, root, page)) navigateDetails(item); });
    hero.appendChild(el('div', { className: 'sl-home-hero-copy' }, [
      el('div', { className: 'sl-home-kicker', text: featured ? 'Featured' : 'Continue watching' }),
      el('h2', { id: 'sl-home-featured-title', text: itemTitle(item) }),
      el('div', { className: 'sl-home-hero-meta', text: heroMeta(item) }),
      item.Overview ? el('p', { className: 'sl-home-hero-summary', text: item.Overview }) : null,
      el('div', { className: 'sl-home-hero-actions' }, [primary, details])
    ]));
    slot.appendChild(hero);
  }
  function settled(promise) {
    return promise.then(function (value) { return { ok: true, value: value }; }, function () { return { ok: false, value: null }; });
  }
  function mergeContinue(resume, next) {
    var represented = {}; var seen = {}; var merged = [];
    resume.forEach(function (item) {
      if (!item || !item.Id || seen[item.Id]) return;
      seen[item.Id] = true; merged.push(item);
      if (item.Type === 'Episode' && item.SeriesId) represented[item.SeriesId] = true;
    });
    next.forEach(function (item) {
      if (!item || !item.Id || seen[item.Id] || (item.SeriesId && represented[item.SeriesId])) return;
      seen[item.Id] = true; merged.push(item);
    });
    return merged;
  }
  /* A genre rail holding one or two titles reads as broken next to a full one,
   * so only genres with real depth get a row, and only the few biggest. Both
   * numbers are deliberately conservative for a small library -- as it grows,
   * more genres cross the threshold on their own. */
  var GENRE_MIN_ITEMS = 3;
  var GENRE_MAX_RAILS = 3;

  function topGenres(movies) {
    var counts = {};
    movies.forEach(function (item) {
      (item.Genres || []).forEach(function (name) {
        if (!name) return;
        counts[name] = (counts[name] || 0) + 1;
      });
    });
    return Object.keys(counts)
      .filter(function (name) { return counts[name] >= GENRE_MIN_ITEMS; })
      // Biggest first, then alphabetical so the order is stable between loads
      // rather than shuffling as the library changes.
      .sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); })
      .slice(0, GENRE_MAX_RAILS);
  }

  function renderGenreRails(feed, movies, myGen, uid, root, page) {
    if (!validHome(myGen, uid, root, page)) return;
    topGenres(movies).forEach(function (name) {
      var items = movies.filter(function (item) { return (item.Genres || []).indexOf(name) !== -1; });
      var section = homeSection(name, 'genre-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      feed.appendChild(section);
      renderHomeRail(section, items, 'poster', myGen, uid, root, page);
    });
  }

  function loadHome(root, page, uid, myGen, slots) {
    var resumeP = settled(api().getResumableItems(uid, { Recursive: true, Limit: 12, MediaTypes: 'Video', Fields: 'Overview,RunTimeTicks,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,ParentBackdropImageTags,ParentBackdropItemId,BackdropImageTags', EnableImages: true, ImageTypeLimit: 1, EnableTotalRecordCount: false }));
    var nextP = settled(api().getNextUpEpisodes({ UserId: uid, Limit: 12, Fields: 'Overview,RunTimeTicks,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,ParentBackdropImageTags,ParentBackdropItemId,BackdropImageTags', EnableImages: true, ImageTypeLimit: 1, EnableTotalRecordCount: false }));
    var continueP = Promise.all([resumeP, nextP]).then(function (parts) {
      return { ok: parts[0].ok || parts[1].ok, items: mergeContinue(parts[0].ok ? ((parts[0].value && parts[0].value.Items) || []) : [], parts[1].ok ? ((parts[1].value && parts[1].value.Items) || []) : []) };
    });
    var showsP = settled(api().getItems(uid, { IncludeItemTypes: 'Series', Recursive: true, SortBy: 'SortName', Fields: 'ChildCount,BackdropImageTags', EnableImages: true, ImageTypeLimit: 1, EnableTotalRecordCount: false }));
    // Genres ride along on this one request so the genre rails below need no
    // extra round trips, and can only contain titles already known to exist.
    var moviesP = settled(api().getItems(uid, { IncludeItemTypes: 'Movie', Recursive: true, SortBy: 'SortName', Fields: 'RunTimeTicks,ProductionYear,PrimaryImageAspectRatio,Genres', EnableImages: true, ImageTypeLimit: 1, EnableTotalRecordCount: false }));
    var recentP = settled(api().getItems(uid, { IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 14, Fields: 'RunTimeTicks,ProductionYear,ChildCount', EnableImages: true, ImageTypeLimit: 1, EnableTotalRecordCount: false }));
    continueP.then(function (result) { if (validHome(myGen, uid, root, page)) renderHomeRail(slots.continueSection, result.items, 'continue', myGen, uid, root, page); });
    showsP.then(function (result) { if (validHome(myGen, uid, root, page)) renderHomeRail(slots.showsSection, result.ok ? ((result.value && result.value.Items) || []) : [], 'poster', myGen, uid, root, page); });
    recentP.then(function (result) { if (validHome(myGen, uid, root, page)) renderHomeRail(slots.recentSection, result.ok ? ((result.value && result.value.Items) || []) : [], 'poster', myGen, uid, root, page); });
    moviesP.then(function (result) {
      if (!validHome(myGen, uid, root, page)) return;
      var movies = result.ok ? ((result.value && result.value.Items) || []) : [];
      renderHomeRail(slots.moviesSection, movies, 'poster', myGen, uid, root, page);
      renderGenreRails(slots.feed, movies, myGen, uid, root, page);
    });
    Promise.all([continueP, showsP, moviesP]).then(function (results) {
      if (!validHome(myGen, uid, root, page)) return;
      var shows = results[1].ok ? ((results[1].value && results[1].value.Items) || []) : [];
      var featured = null;
      for (var i = 0; i < shows.length; i++) if ((shows[i].BackdropImageTags || [])[0]) { featured = shows[i]; break; }
      renderHomeHero(slots.heroSlot, results[0].items[0] || featured, !results[0].items[0], myGen, uid, root, page);
      if (!results[0].ok && !results[1].ok && !results[2].ok) {
        var retry = el('button', { className: 'sl-home-retry', type: 'button', text: "Couldn't load — tap to retry" });
        retry.addEventListener('click', function () { if (validHome(myGen, uid, root, page)) { teardownHome(false); updateHomeRoute(); } });
        slots.feed.appendChild(retry);
      }
      restoreHomeState(root, uid, myGen, page);
    });
  }
  function renderHomeTopbar(root, page, uid, myGen) {
    var search = el('button', { className: 'sl-home-icon', type: 'button', 'aria-label': 'Search' });
    search.appendChild(el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [el('circle', { cx: '11', cy: '11', r: '7' }), el('path', { d: 'm16.2 16.2 4 4' })]));
    search.addEventListener('click', function () { if (validHome(myGen, uid, root, page)) homeNavigate('#/search'); });
    var avatar = el('button', { className: 'sl-home-avatar', type: 'button', 'aria-label': 'Open profile', text: '•' });
    avatar.addEventListener('click', function () { if (validHome(myGen, uid, root, page)) homeNavigate('#/mypreferencesmenu'); });
    root.appendChild(el('nav', { className: 'sl-home-topbar', 'aria-label': 'Primary navigation' }, [
      el('div', { className: 'sl-home-wordmark', 'aria-label': 'Streamline home' }, [el('span', { className: 'sl-home-mark', 'aria-hidden': 'true' }), el('span', { text: 'Streamline' })]), search, avatar
    ]));
    var key = homeKey(uid);
    if (key && avatarCache[key]) { avatar.textContent = avatarCache[key]; avatar.setAttribute('aria-label', 'Open profile for ' + avatarCache[key]); return; }
    api().getCurrentUser().then(function (current) {
      if (!validHome(myGen, uid, root, page)) return;
      var initial = current && current.Name ? current.Name.charAt(0).toUpperCase() : '•';
      if (key) avatarCache[key] = initial;
      avatar.textContent = initial; avatar.setAttribute('aria-label', 'Open profile for ' + initial);
    }).catch(function () { if (!validHome(myGen, uid, root, page)) return; });
  }
  function mountHome(page, uid) {
    var myGen = ++homeGen;
    var root = el('div', { id: 'streamline-home' });
    var prev = page.style.position;
    if (getComputedStyle(page).position === 'static') page.style.position = 'relative';
    page.appendChild(root);
    homeMounted = { el: root, page: page, pagePrevPosition: prev, uid: uid, generation: myGen };
    document.body.classList.add('streamline-home-active');
    applyAccent(root, cachedAccent(uid));
    renderHomeTopbar(root, page, uid, myGen);
    var heroSlot = el('div', { className: 'sl-home-hero-slot' }); root.appendChild(heroSlot);
    var feed = el('div', { className: 'sl-home-feed' });
    var continueSection = homeSection('Continue Watching', 'continue');
    var recentSection = homeSection('Recently Added', 'recent');
    var showsSection = homeSection('Shows', 'shows');
    var moviesSection = homeSection('Movies', 'movies');
    feed.appendChild(continueSection); feed.appendChild(recentSection);
    feed.appendChild(showsSection); feed.appendChild(moviesSection); root.appendChild(feed);
    fetchAccent(uid).then(function (preset) { if (validHome(myGen, uid, root, page)) applyAccent(root, preset); }).catch(function () { if (!validHome(myGen, uid, root, page)) return; });
    loadHome(root, page, uid, myGen, { heroSlot: heroSlot, feed: feed, continueSection: continueSection, recentSection: recentSection, showsSection: showsSection, moviesSection: moviesSection });
    (function watchUser() {
      homeUserTimer = scheduleHomeTimeout(function () {
        homeUserTimer = null;
        if (!homeMounted || homeMounted.el !== root || !isHomeRoute()) return;
        if (userId() !== uid) { checkAuth(); teardownHome(false); updateHomeRoute(); return; }
        watchUser();
      }, 500);
    })();
  }
  function teardownHome(capture) {
    if (capture !== false) captureHomeState();
    homeGen++;
    clearHomeTimeouts();
    if (homeObserver) { try { homeObserver.disconnect(); } catch (e) {} homeObserver = null; }
    document.body.classList.remove('streamline-home-active');
    if (!homeMounted) return;
    try { homeMounted.el.remove(); } catch (e) {}
    try { homeMounted.page.style.position = homeMounted.pagePrevPosition || ''; } catch (e) {}
    homeMounted = null;
  }
  function observeHomePage() {
    if (homeObserver || !homeMounted || !homeMounted.page) return;
    homeObserver = new MutationObserver(function () {
      if (homeObserverTimer !== null) cancelHomeTimeout(homeObserverTimer);
      homeObserverTimer = scheduleHomeTimeout(function () {
        homeObserverTimer = null;
        if (!isHomeRoute()) return;
        var page = visibleHomePage();
        if (!homeMounted || homeMounted.page !== page || !homeMounted.el.isConnected) { teardownHome(); updateHomeRoute(); }
      }, 75);
    });
    var target = homeMounted.page.parentNode || document.body;
    if (target) homeObserver.observe(target, { childList: true });
  }
  function updateHomeRoute() {
    if (!isHomeRoute()) {
      if (homeAuthTimer !== null) { cancelHomeTimeout(homeAuthTimer); homeAuthTimer = null; }
      homeAuthTries = 0;
      homeMountTries = 0;
      if (homeMounted || homeObserver) teardownHome();
      return;
    }
    var uid = api() && userId();
    if (!uid) {
      if (homeMounted) teardownHome(false);
      if (homeAuthTimer === null) {
        var authDelay = homeAuthTries++ < 80 ? 150 : 1000;
        homeAuthTimer = scheduleHomeTimeout(function () { homeAuthTimer = null; updateHomeRoute(); }, authDelay);
      }
      return;
    }
    homeAuthTries = 0;
    var page = visibleHomePage();
    if (!page) {
      if (homeMountTries++ < 40 && homeRetryTimer === null) homeRetryTimer = scheduleHomeTimeout(function () { homeRetryTimer = null; updateHomeRoute(); }, 100);
      return;
    }
    homeMountTries = 0;
    if (homeMounted && homeMounted.page === page && homeMounted.uid === uid && homeMounted.el.isConnected) return;
    if (homeMounted) teardownHome();
    mountHome(page, uid); observeHomePage();
  }

  // ---------- mount ----------
  function mountMovie(item, page, myGen) {
    var uid = userId();
    var root = el('div', { id: CONTAINER_ID, className: 'sl-movie' });
    applyAccent(root, cachedAccent(uid));
    if (uid) fetchAccent(uid).then(function (presetId) {
      if (myGen === gen && uid === userId() && mounted && mounted.el === root) applyAccent(root, presetId);
    }).catch(function () {});

    var hero = el('div', { className: 'sl-hero' });
    var bg = imageUrl(item, 'Backdrop', 800) || imageUrl(item, 'Primary', 640);
    if (bg) hero.style.backgroundImage = 'url(' + JSON.stringify(bg) + ')';
    var back = el('button', { className: 'sl-back', type: 'button', 'aria-label': 'Back', text: '‹' });
    back.addEventListener('click', function () { history.back(); });
    hero.appendChild(back);
    hero.appendChild(el('h1', { className: 'sl-hero-title', text: item.Name || '' }));
    var ud = item.UserData || {};
    var position = ud.PlaybackPositionTicks || 0;
    if (position > 0 && item.RunTimeTicks) {
      var progress = Math.min(100, position / item.RunTimeTicks * 100);
      hero.appendChild(el('div', { className: 'sl-movie-progress' }, [el('i', { style: 'width:' + progress + '%' })]));
    }
    root.appendChild(hero);
    root.appendChild(metaLine(item));

    var left = Math.max(0, ticksToMin((item.RunTimeTicks || 0) - position));
    var playLabel = position > 0 ? 'Resume · ' + left + ' min left' : 'Play';
    var play = el('button', { className: 'sl-play', type: 'button', disabled: true }, [el('span', { text: '▶  ' + playLabel })]);
    play.addEventListener('click', function () { nativeDetailPlay(page); });
    var trailer = trailerButton(page);
    var trailerResolved = false;
    (function waitReady(t) {
      if (myGen !== gen) return;
      if (page.querySelector('.mainDetailButtons .btnPlay:not(.hide)')) play.disabled = false;
      if (page.querySelector('.mainDetailButtons .btnPlayTrailer:not(.hide)')) { trailer.hidden = false; trailerResolved = true; }
      if (!trailerResolved && (t || 0) >= 8) trailerResolved = true;
      if ((t || 0) < 25 && (play.disabled || !trailerResolved)) scheduleTimeout(function () { waitReady((t || 0) + 1); }, 120);
      else if (play.disabled) play.disabled = false;
    })();
    var fav = el('button', { className: 'sl-icon-btn', type: 'button', 'aria-pressed': String(!!ud.IsFavorite), 'aria-label': 'Favorite', text: '♥' });
    fav.addEventListener('click', function () {
      var on = fav.getAttribute('aria-pressed') === 'true';
      fav.setAttribute('aria-pressed', on ? 'false' : 'true');
      try { api().updateFavoriteStatus(uid, item.Id, !on).catch(function () { fav.setAttribute('aria-pressed', String(on)); }); }
      catch (e) { fav.setAttribute('aria-pressed', String(on)); }
    });
    var more = el('button', { className: 'sl-icon-btn', type: 'button', 'aria-label': 'More', text: '⋯' });
    more.addEventListener('click', function () { nativeOverflow(page); });
    root.appendChild(el('div', { className: 'sl-actions' }, [play, trailer, fav, more]));
    var syn = synopsis(item); if (syn) root.appendChild(syn);

    var prevPos = page.style.position;
    if (getComputedStyle(page).position === 'static') page.style.position = 'relative';
    try { document.body.classList.add(ACTIVE_CLASS); } catch (e) {}
    page.appendChild(root);
    mounted = { el: root, page: page, pagePrevPosition: prevPos };

    specialFeatures(uid, item.Id).then(function (result) {
      if (myGen !== gen || !mounted || mounted.el !== root) return;
      var items = Array.isArray(result) ? result : ((result && result.Items) || []);
      if (!items.length) return;
      var section = el('div', { className: 'sl-section sl-extras' }, [el('h2', { text: 'Extras' })]);
      items.forEach(function (extra) { section.appendChild(extraRow(extra)); });
      root.appendChild(section);
    }).catch(function () {});
  }

  function mountSeries(item, page, myGen) {
    var uid = userId();
    var root = el('div', { id: CONTAINER_ID });
    applyAccent(root, cachedAccent(uid));
    if (uid) fetchAccent(uid).then(function (presetId) {
      if (myGen === gen && uid === userId() && mounted && mounted.el === root) applyAccent(root, presetId);
    }).catch(function () {});

    var hero = el('div', { className: 'sl-hero' });
    var bg = imageUrl(item, 'Backdrop', 800) || imageUrl(item, 'Primary', 640);
    if (bg) hero.style.backgroundImage = 'url(' + JSON.stringify(bg) + ')';
    var back = el('button', { className: 'sl-back', type: 'button', 'aria-label': 'Back', text: '‹' });
    back.addEventListener('click', function () { history.back(); });
    hero.appendChild(back);
    hero.appendChild(el('h1', { className: 'sl-hero-title', text: item.Name || '' }));
    root.appendChild(hero);
    root.appendChild(metaLine(item));

    var play = el('button', { className: 'sl-play', type: 'button', disabled: true }, [el('span', { text: '▶  Play' })]);
    play.addEventListener('click', function () { nativeDetailPlay(page); });
    var trailer = trailerButton(page);
    // enable Play only once the native control is present (avoids clicking an unbound/hidden button)
    var trailerResolved = false;
    (function waitReady(t) {
      if (myGen !== gen) return;
      if (page.querySelector('.mainDetailButtons .btnPlay:not(.hide)')) play.disabled = false;
      if (page.querySelector('.mainDetailButtons .btnPlayTrailer:not(.hide)')) { trailer.hidden = false; trailerResolved = true; }
      if (!trailerResolved && (t || 0) >= 8) trailerResolved = true;
      if ((t || 0) < 25 && (play.disabled || !trailerResolved)) scheduleTimeout(function () { waitReady((t || 0) + 1); }, 120);
      else if (play.disabled) play.disabled = false;
    })();
    var fav = el('button', { className: 'sl-icon-btn', type: 'button', 'aria-pressed': String(!!(item.UserData || {}).IsFavorite), 'aria-label': 'Favorite', text: '♥' });
    fav.addEventListener('click', function () {
      var on = fav.getAttribute('aria-pressed') === 'true';
      fav.setAttribute('aria-pressed', on ? 'false' : 'true');
      try { api().updateFavoriteStatus(uid, item.Id, !on).catch(function () { fav.setAttribute('aria-pressed', String(on)); }); }
      catch (e) { fav.setAttribute('aria-pressed', String(on)); }
    });
    var more = el('button', { className: 'sl-icon-btn', type: 'button', 'aria-label': 'More', text: '⋯' });
    more.addEventListener('click', function () { nativeOverflow(page); });   // wired to native menu (not inert)
    root.appendChild(el('div', { className: 'sl-actions' }, [play, trailer, fav, more]));

    var syn = synopsis(item); if (syn) root.appendChild(syn);

    var contSection = el('div', { className: 'sl-section' });
    root.appendChild(contSection);

    var seasonsSection = el('div', { className: 'sl-section' }, [el('h2', { text: 'Seasons' })]);
    var seasonsRail = el('div', { className: 'sl-seasons' });
    var episodesWrap = el('div', { className: 'sl-episodes' });
    seasonsSection.appendChild(seasonsRail); seasonsSection.appendChild(episodesWrap);
    root.appendChild(seasonsSection);

    var prevPos = page.style.position;
    if (getComputedStyle(page).position === 'static') page.style.position = 'relative';
    try { document.body.classList.add(ACTIVE_CLASS); } catch (e) {}
    page.appendChild(root);
    mounted = { el: root, page: page, pagePrevPosition: prevPos };

    // Next Up / continue
    api().getNextUpEpisodes({ SeriesId: item.Id, UserId: uid, Fields: 'Overview', Limit: 1 })
      .then(function (r) {
        if (myGen !== gen) return;
        var res = continueCard((r.Items || [])[0]);
        if (res) { contSection.appendChild(el('h2', { text: res.inProgress ? 'Continue watching' : 'Next up' })); contSection.appendChild(res.card); }
      }).catch(function () {});

    // Seasons + inline episodes (lazy per season, honest counts)
    api().getSeasons(item.Id, { userId: uid, Fields: 'ChildCount' })
      .then(function (r) {
        if (myGen !== gen) return;
        var seasons = (r.Items || []);
        function selectSeason(season, card) {
          Array.prototype.forEach.call(seasonsRail.children, function (c) { c.setAttribute('aria-selected', 'false'); });
          card.setAttribute('aria-selected', 'true');
          episodesWrap.textContent = '';
          episodesWrap.appendChild(el('div', { className: 'sl-status', text: 'Loading…' }));
          api().getEpisodes(item.Id, { seasonId: season.Id, userId: uid, Fields: 'Overview' })
            .then(function (er) {
              if (myGen !== gen) return;
              episodesWrap.textContent = '';
              var items = er.Items || [];
              (items).forEach(function (ep) { episodesWrap.appendChild(episodeRow(ep)); });
              // keep the rail honest even if ChildCount was missing
              var cnt = card.querySelector('.sl-s-count');
              if (cnt && (!season.ChildCount || season.ChildCount === 0)) cnt.textContent = items.length + ' episodes';
            }).catch(function () {
              if (myGen !== gen || !mounted || mounted.el !== root) return;
              episodesWrap.textContent = ''; episodesWrap.appendChild(el('div', { className: 'sl-status', text: 'Could not load episodes.' }));
            });
        }
        seasons.forEach(function (s) { seasonsRail.appendChild(seasonCard(s, selectSeason)); });
        if (seasons[0]) selectSeason(seasons[0], seasonsRail.firstChild);
      }).catch(function () {});
  }

  // ---------- route lifecycle ----------
  function currentDetailId() {
    var m = (location.hash || '').match(/#\/?details\?id=([0-9a-f]+)/i);
    return m ? m[1] : null;
  }
  function teardown() {
    clearRafs();
    try { document.body.classList.remove(ACTIVE_CLASS); } catch (e) {}
    if (!mounted) return;
    try { mounted.el.remove(); } catch (e) {}
    try { if (mounted.page) mounted.page.style.position = mounted.pagePrevPosition || ''; } catch (e) {}
    mounted = null;
  }
  function onRoute() {
    var myGen = ++gen;         // invalidates all in-flight callbacks
    teardown();
    updateAccentRoute();
    updateHomeRoute();
    var id = currentDetailId();
    if (!id || !api()) return;
    var tries = 0;
    (function attempt() {
      if (myGen !== gen) return;
      var page = visibleDetailPage();
      if (!page && tries++ < 20) return void scheduleTimeout(attempt, 100);
      api().getItem(userId(), id).then(function (item) {
        if (myGen !== gen) return;
        if (!item || (item.Type !== 'Series' && item.Type !== 'Movie')) return; // Episode/Season/other pages stay native so playItem can delegate
        var p = visibleDetailPage(); if (!p) return;
        if (item.Type === 'Movie') mountMovie(item, p, myGen);
        else mountSeries(item, p, myGen);
      }).catch(function () {});
    })();
  }
  function init() {
    if (DEBUG) {
      debugBanner('init at ' + Math.round((Date.now() - bootStarted) / 1000) + 's');
      // Heartbeat, so the camera sees whether the transform actually mounts
      // rather than just whether the script started.
      setInterval(function () {
        var mounted = document.querySelectorAll('[class*="sl-"]').length;
        debugBanner(
          'layout=' + (document.documentElement.className.match(/layout-\w+/) || ['NONE'])[0] +
          ' hash=' + (location.hash || '(none)').slice(0, 22) +
          ' user=' + (userId() ? 'yes' : 'NO') +
          ' sl=' + mounted,
        );
      }, 3000);
    }
    hashHandler = function () { seedSkipLength(); onRoute(); };
    seedSkipLength();
    homeAuthSignalHandler = function () {
      if (!isHomeRoute() || userId()) return;
      homeAuthTries = 0;
      if (homeAuthTimer !== null) { cancelHomeTimeout(homeAuthTimer); homeAuthTimer = null; }
      updateHomeRoute();
    };
    window.addEventListener('hashchange', hashHandler);
    window.addEventListener('storage', homeAuthSignalHandler);
    onRoute();
  }

  window.__streamlineTheme = {
    version: VERSION,
    dispose: function () {
      try { window.removeEventListener('hashchange', hashHandler); } catch (e) {}
      try { window.removeEventListener('storage', homeAuthSignalHandler); } catch (e) {}
      teardownAccentRoute();
      teardownHome(false);
      clearScheduledWork();
      clearRafs();
      teardown();
      homeState = {}; avatarCache = {}; homeReturnKey = null; playRequest++;
      gen++;
    }
  };

  // ---------- bootstrap ----------
  // ApiClient is created asynchronously after the client connects and
  // authenticates. On a desktop browser that is nearly instant, but inside the
  // Samsung TV app -- slower hardware, app cold start, a login round trip -- it
  // routinely takes far longer than the 6s this used to wait before giving up
  // permanently, which left the TV showing a stock, untransformed client.
  // Waiting costs one timer, so wait a long time and slow the polling down
  // rather than abandoning the page.
  var BOOT_FAST_MS = 150;   // responsive while the page is still settling
  var BOOT_SLOW_MS = 750;   // after that, cheap background polling
  var BOOT_FAST_UNTIL = 10 * 1000;
  var BOOT_GIVE_UP_MS = 5 * 60 * 1000;
  var bootStarted = Date.now();

  function bootstrap() {
    if (api()) { init(); return; }
    var waited = Date.now() - bootStarted;
    if (waited > BOOT_GIVE_UP_MS) {
      debugBanner('ApiClient never appeared after ' + Math.round(waited / 1000) + 's');
      return;
    }
    if (DEBUG && waited > 2000) debugBanner('waiting for ApiClient (' + Math.round(waited / 1000) + 's)');
    initInterval = setTimeout(bootstrap, waited < BOOT_FAST_UNTIL ? BOOT_FAST_MS : BOOT_SLOW_MS);
  }

  bootstrap();
})();
