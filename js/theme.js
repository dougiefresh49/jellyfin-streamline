/* Jellyfin Kids — theme.js  (v2)
 * Route-scoped hijack of the TV-show detail view. Renders a custom Netflix/Disney+-style
 * combined show->seasons->episodes view from the Jellyfin REST API (via window.ApiClient).
 * Playback delegates to Jellyfin's native controls (playbackManager is a module export, not global):
 *   - series Play  -> click the native .btnPlay (data-action="resume") on the series page
 *   - an episode   -> navigate to its detail hash, then click that page's native play control
 * Verified against live Jellyfin 10.11 markup: primary=.btnPlay[data-action=resume],
 *   from-start=.btnReplay[data-action=play] (hidden), overflow=.btnMoreCommands.
 * Reinjection-safe via a versioned global sentinel with dispose().
 */
(function () {
  'use strict';
  var VERSION = 2;
  if (window.__kidsTheme && typeof window.__kidsTheme.dispose === 'function') {
    try { window.__kidsTheme.dispose(); } catch (e) {}
  }

  var CONTAINER_ID = 'kids-detail';
  var gen = 0;
  var mounted = null;          // { el, page, pagePrevPosition }
  var hashHandler = null;

  // ---------- helpers ----------
  function api() { return window.ApiClient; }
  function userId() { return api() && api().getCurrentUserId(); }
  function ticksToMin(t) { return Math.round((t || 0) / 600000000); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];              // server text -> textContent, never innerHTML
      else if (k === 'style') n.setAttribute('style', attrs[k]);
      else if (k === 'html') { /* intentionally unsupported */ }
      else if (k in n) { try { n[k] = attrs[k]; } catch (e) { n.setAttribute(k, attrs[k]); } }
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function imageUrl(item, type, maxWidth) {
    var tags = item.ImageTags || {};
    var tag = type === 'Backdrop' ? (item.BackdropImageTags || [])[0] : tags[type];
    if (!tag) return null;
    try { return api().getImageUrl(item.Id, { type: type, tag: tag, maxWidth: maxWidth || 640 }); }
    catch (e) { return null; }
  }
  function thumb(item, opts) {
    var box = el('div', { className: 'kd-thumb' });
    var url = imageUrl(item, 'Primary', 320) || imageUrl(item, 'Backdrop', 320);
    if (url) {
      var img = el('img', { src: url, loading: 'lazy', alt: '' });
      img.addEventListener('error', function () { img.remove(); });   // image fallback (must-fix g)
      box.appendChild(img);
    }
    if (opts && opts.progress > 0) {
      var bar = el('div', { className: 'kd-progress' }); bar.appendChild(el('i', { style: 'width:' + Math.min(100, opts.progress) + '%' }));
      box.appendChild(bar);
    }
    if (opts && opts.watched) box.appendChild(el('div', { className: 'kd-watched', text: '✓' }));
    return box;
  }

  // ---------- native playback delegation ----------
  function visibleDetailPage() {
    var pages = document.querySelectorAll('#itemDetailPage:not(.hide), .page.itemDetailPage:not(.hide)');
    for (var i = 0; i < pages.length; i++) { if (pages[i].offsetParent !== null) return pages[i]; }
    return null;
  }
  // click the series play control on the given (series) page; retries briefly for the native bind race
  function nativeSeriesPlay(page, cb, tries) {
    tries = tries || 0;
    var btn = page && page.querySelector('.mainDetailButtons .btnPlay:not(.hide)');
    if (btn) { btn.click(); if (cb) cb(true); return; }
    if (tries < 25) return void setTimeout(function () { nativeSeriesPlay(page, cb, tries + 1); }, 120);
    if (cb) cb(false);
  }
  function nativeOverflow(page) {
    var btn = page && page.querySelector('.mainDetailButtons .btnMoreCommands:not(.hide)');
    if (btn) btn.click();
  }
  // play a concrete episode: navigate to its detail, then click that page's native play control
  function playEpisode(epId) {
    location.hash = '#/details?id=' + epId;
    var tries = 0;
    (function poll() {
      var p = visibleDetailPage();
      var btn = p && p.querySelector('.mainDetailButtons .btnPlay:not(.hide), .mainDetailButtons .btnReplay:not(.hide)');
      if (btn) { btn.click(); return; }
      if (tries++ < 40) setTimeout(poll, 120);
    })();
  }

  // ---------- render pieces ----------
  function metaLine(item) {
    var bits = [];
    if (item.ProductionYear) bits.push(el('span', { text: String(item.ProductionYear) }));
    if (item.OfficialRating) bits.push(el('span', { className: 'kd-badge', text: item.OfficialRating }));
    if (item.ChildCount) bits.push(el('span', { text: item.ChildCount + ' Season' + (item.ChildCount > 1 ? 's' : '') }));
    if (item.CommunityRating) bits.push(el('span', { text: '★ ' + item.CommunityRating.toFixed(1) }));
    return el('div', { className: 'kd-meta' }, bits);
  }
  function synopsis(item) {
    if (!item.Overview) return null;
    var wrap = el('div', { className: 'kd-synopsis', 'data-expanded': 'false' });
    var p = el('p', { text: item.Overview });
    wrap.appendChild(p);
    var btn = el('button', { className: 'kd-more', type: 'button', text: 'Show more', 'aria-expanded': 'false' });
    btn.addEventListener('click', function () {
      var open = wrap.getAttribute('data-expanded') === 'true';
      wrap.setAttribute('data-expanded', open ? 'false' : 'true');
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      btn.textContent = open ? 'Show more' : 'Show less';
    });
    wrap.appendChild(btn);
    // only show the toggle if the text actually overflows (measure after layout)
    requestAnimationFrame(function () { if (p.scrollHeight <= p.clientHeight + 2) btn.style.display = 'none'; });
    return wrap;
  }
  function continueCard(nextItem) {
    if (!nextItem) return null;
    var ud = nextItem.UserData || {};
    var pct = ud.PlayedPercentage || 0;
    var inProgress = (ud.PlaybackPositionTicks || 0) > 0;
    var left = ticksToMin((nextItem.RunTimeTicks || 0) - (ud.PlaybackPositionTicks || 0));
    var epLabel = 'S' + (nextItem.ParentIndexNumber || 1) + ':E' + (nextItem.IndexNumber || 1) + ' · ' + (nextItem.Name || '');
    var card = el('button', { className: 'kd-continue', type: 'button' }, [
      thumb(nextItem, { progress: pct }),
      el('div', {}, [
        el('div', { className: 'kd-c-title', text: nextItem.Name || 'Play' }),      // episode name, not the section label
        el('div', { className: 'kd-c-sub', text: epLabel + (inProgress ? ' · ' + left + ' min left' : '') })
      ])
    ]);
    card.addEventListener('click', function () { playEpisode(nextItem.Id); });        // play THIS episode
    return { card: card, inProgress: inProgress };
  }
  function episodeRow(ep) {
    var ud = ep.UserData || {};
    var row = el('button', { className: 'kd-ep', type: 'button' }, [
      thumb(ep, { watched: !!ud.Played, progress: ud.PlayedPercentage || 0 }),
      el('div', {}, [
        el('div', { className: 'kd-ep-title', text: (ep.IndexNumber ? ep.IndexNumber + '. ' : '') + (ep.Name || '') }),
        el('div', { className: 'kd-ep-run', text: ep.RunTimeTicks ? ticksToMin(ep.RunTimeTicks) + 'm' : '' }),
        ep.Overview ? el('div', { className: 'kd-ep-desc', text: ep.Overview }) : null
      ])
    ]);
    row.addEventListener('click', function () { playEpisode(ep.Id); });
    return row;
  }
  function seasonCard(season, onSelect) {
    var card = el('button', { className: 'kd-season', type: 'button', 'aria-selected': 'false' }, [
      el('div', { className: 'kd-s-num', text: season.Name || ('Season ' + (season.IndexNumber || '')) }),
      el('div', { className: 'kd-s-count', text: (season.ChildCount || 0) + ' episodes' })
    ]);
    card.addEventListener('click', function () { onSelect(season, card); });
    return card;
  }

  // ---------- mount ----------
  function mountSeries(item, page, myGen) {
    var uid = userId();
    var root = el('div', { id: CONTAINER_ID });

    var hero = el('div', { className: 'kd-hero' });
    var bg = imageUrl(item, 'Backdrop', 800) || imageUrl(item, 'Primary', 640);
    if (bg) hero.style.backgroundImage = 'url(' + JSON.stringify(bg) + ')';
    var back = el('button', { className: 'kd-back', type: 'button', 'aria-label': 'Back', text: '‹' });
    back.addEventListener('click', function () { history.back(); });
    hero.appendChild(back);
    hero.appendChild(el('h1', { className: 'kd-hero-title', text: item.Name || '' }));
    root.appendChild(hero);
    root.appendChild(metaLine(item));

    var play = el('button', { className: 'kd-play', type: 'button', disabled: true }, [el('span', { text: '▶  Play' })]);
    play.addEventListener('click', function () { nativeSeriesPlay(page); });
    // enable Play only once the native control is present (avoids clicking an unbound/hidden button)
    (function waitReady(t) {
      if (myGen !== gen) return;
      if (page.querySelector('.mainDetailButtons .btnPlay:not(.hide)')) { play.disabled = false; return; }
      if ((t || 0) < 25) setTimeout(function () { waitReady((t || 0) + 1); }, 120);
      else play.disabled = false;
    })();
    var fav = el('button', { className: 'kd-icon-btn', type: 'button', 'aria-pressed': String(!!(item.UserData || {}).IsFavorite), 'aria-label': 'Favorite', text: '♥' });
    fav.addEventListener('click', function () {
      var on = fav.getAttribute('aria-pressed') === 'true';
      fav.setAttribute('aria-pressed', on ? 'false' : 'true');
      try { api().updateFavoriteStatus(uid, item.Id, !on).catch(function () { fav.setAttribute('aria-pressed', String(on)); }); }
      catch (e) { fav.setAttribute('aria-pressed', String(on)); }
    });
    var more = el('button', { className: 'kd-icon-btn', type: 'button', 'aria-label': 'More', text: '⋯' });
    more.addEventListener('click', function () { nativeOverflow(page); });   // wired to native menu (not inert)
    root.appendChild(el('div', { className: 'kd-actions' }, [play, fav, more]));

    var syn = synopsis(item); if (syn) root.appendChild(syn);

    var contSection = el('div', { className: 'kd-section' });
    root.appendChild(contSection);

    var seasonsSection = el('div', { className: 'kd-section' }, [el('h2', { text: 'Seasons' })]);
    var seasonsRail = el('div', { className: 'kd-seasons' });
    var episodesWrap = el('div', { className: 'kd-episodes' });
    seasonsSection.appendChild(seasonsRail); seasonsSection.appendChild(episodesWrap);
    root.appendChild(seasonsSection);

    var prevPos = page.style.position;
    if (getComputedStyle(page).position === 'static') page.style.position = 'relative';
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
          episodesWrap.appendChild(el('div', { className: 'kd-status', text: 'Loading…' }));
          api().getEpisodes(item.Id, { seasonId: season.Id, userId: uid, Fields: 'Overview' })
            .then(function (er) {
              if (myGen !== gen) return;
              episodesWrap.textContent = '';
              var items = er.Items || [];
              (items).forEach(function (ep) { episodesWrap.appendChild(episodeRow(ep)); });
              // keep the rail honest even if ChildCount was missing
              var cnt = card.querySelector('.kd-s-count');
              if (cnt && (!season.ChildCount || season.ChildCount === 0)) cnt.textContent = items.length + ' episodes';
            }).catch(function () { episodesWrap.textContent = ''; episodesWrap.appendChild(el('div', { className: 'kd-status', text: 'Could not load episodes.' })); });
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
    if (!mounted) return;
    try { mounted.el.remove(); } catch (e) {}
    try { if (mounted.page) mounted.page.style.position = mounted.pagePrevPosition || ''; } catch (e) {}
    mounted = null;
  }
  function onRoute() {
    var myGen = ++gen;         // invalidates all in-flight callbacks
    teardown();
    var id = currentDetailId();
    if (!id || !api()) return;
    var tries = 0;
    (function attempt() {
      if (myGen !== gen) return;
      var page = visibleDetailPage();
      if (!page && tries++ < 20) return void setTimeout(attempt, 100);
      api().getItem(userId(), id).then(function (item) {
        if (myGen !== gen) return;
        if (!item || item.Type !== 'Series') return;      // only hijack the series page; Episode/Season pages stay native (also lets playEpisode delegate)
        var p = visibleDetailPage(); if (!p) return;
        mountSeries(item, p, myGen);
      }).catch(function () {});
    })();
  }
  function init() {
    hashHandler = function () { onRoute(); };
    window.addEventListener('hashchange', hashHandler);
    onRoute();
  }

  window.__kidsTheme = {
    version: VERSION,
    dispose: function () {
      try { window.removeEventListener('hashchange', hashHandler); } catch (e) {}
      teardown();
      gen++;
    }
  };

  if (api()) init();
  else { var w = 0; var t = setInterval(function () { if (api() || w++ > 40) { clearInterval(t); if (api()) init(); } }, 150); }
})();
