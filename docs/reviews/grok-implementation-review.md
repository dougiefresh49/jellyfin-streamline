## Verdict

Design goals 1–6 are largely met visually. Several prior must-fixes are only half-honored. The live screenshot can look “done” while Play/Continue/episode-row behavior is still wrong or fragile under real Jellyfin 10.11 markup and API field rules.

---

### P0 — Breaks core behavior

**1. Season “0 episodes” — wrong `Fields` (confirmed)**  
`getSeasons(..., { Fields: 'ItemCounts' })` does not populate `ChildCount`. On the server, `ChildCount` is attached only when `ItemFields.ChildCount` is requested; `ItemCounts` is for name/aggregate DTOs (people, genres, etc.).

```js
// broken
api().getSeasons(item.Id, { userId: uid, Fields: 'ItemCounts' })
// fix
api().getSeasons(item.Id, { userId: uid, Fields: 'ChildCount' })
// then prefer:
(season.ChildCount ?? season.RecursiveItemCount ?? '—') + ' episodes'
```
Better UX: after `getEpisodes`, set the count from `er.Items.length` / `TotalRecordCount` so the rail stays honest even if `ChildCount` is missing.

**2. Episode-row “play” is not play**  
`location.hash = '#/details?id=' + ep.Id` leaves the kids view and opens native episode details. That is navigation, not playback, and it fails must-fix (e) (“resolve concrete episode” and play it).

Concrete fix options (in order of robustness):
1. Prefer a hidden native control on the series page if you can bind one with the episode id (hard).
2. Navigate to the episode detail hash, wait for `#itemDetailPage` / `.btnPlay`, then `nativePlay` that page (works with module-scoped `playbackManager`).
3. Long-term: obtain `playbackManager` via the same webpack/AMD path Jellyfin uses — not `window.playbackManager`.

**3. Continue card also does not play that episode**  
`continueCard` → `nativePlay(page, …)` clicks the **series** `.btnPlay`. That often *coincides* with Next Up via `playbackManager`’s series path, but it does not target the card’s episode id, and series-level `startPosition` comes from **series** `UserData.PlaybackPositionTicks` (usually `0`), not the episode’s resume ticks. In-progress “Continue watching” can restart or pick the wrong item if Next Up and the card diverge.

Fix: same as (2) — resolve the concrete episode (you already have `nextItem`) and play/resume **that** id.

**4. Native Play selectors do not match 10.11 markup**  
From `itemDetails/index.html` (10.11):

| Reality | Code assumes |
|--------|----------------|
| Resume control is `.btnPlay` with `data-action="resume"` | `.btnResume` (does not exist) |
| Play-from-start is `.btnReplay` with `data-action="play"` | `.btnPlay` means “play from start” |

```js
// current resume=false path matches .btnPlay FIRST — which is data-action="resume"
'.btnPlay, [data-action="play"], [data-action="resume"], ...'
```

Hero Play “works” mostly because everything collapses to `.btnPlay`, not because resume/play semantics are correct. `nativePlay(page, false)` never reliably hits `.btnReplay`.

```js
function nativePlay(page, resume) {
  if (!page) return false;
  var sel = resume
    ? '.mainDetailButtons .btnPlay[data-action="resume"], .mainDetailButtons .btnPlay'
    : '.mainDetailButtons .btnReplay[data-action="play"], .mainDetailButtons .btnPlay';
  var btn = page.querySelector(sel);
  if (!btn || btn.classList.contains('hide')) return false;
  btn.click();
  return true;
}
```

Also gate on listeners existing / button not `.hide` (see P1 race).

---

### P1 — Wrong UX / correctness holes

**5. Next Up card title is the section label, not the episode**  
Confirmed. Structure today:

- section `<h2>Next up</h2>`
- card title also `"Next up"` / `"Continue watching"`
- episode name buried in `.kd-c-sub`

Fix: card primary = episode name (or `S1:E3 · Name`); section h2 alone carries “Next up” / “Continue watching”. Drop the duplicate title inside the card.

**6. Series-level Play resume check is meaningless**  
```js
nativePlay(page, (item.UserData || {}).PlaybackPositionTicks > 0)
```
Series DTOs almost never carry a useful `PlaybackPositionTicks`. Label stays “▶ Play” even when Next Up is mid-episode. Drive label + resume from the Next Up / continue item’s `UserData`, not the series.

**7. Mount vs native button bind race**  
`onRoute` waits for a visible page, then `getItem`, then mounts. Native `bindAll(view, '.btnPlay', …)` may still be pending. Programmatic `.click()` on an unbound or still-`.hide` button is a silent no-op.

Fix: retry `nativePlay` briefly, or wait until `.mainDetailButtons .btnPlay:not(.hide)` exists before enabling the pill (disable Play until then).

**8. No in-hero Back (known)**  
Overlay sits inside `#itemDetailPage`; skin header back may still work on desktop, but mobile/fullscreen kids layout often needs an explicit hero back (`history.back()` or Jellyfin’s back handler). Missing for the “tight header / Netflix” goal.

---

### P2 — Lifecycle / robustness

**9. Teardown is thinner than must-fix (c) claimed**  
You only restore `page.style.position`. That is OK **if** the strategy is purely overlay (native never `display:none`). Comments/`mounted.abort` promise an AbortController that does not exist — in-flight `getNextUp` / `getSeasons` / `getEpisodes` only gen-gate; they still resolve and touch DOM checks. Add `AbortController` or ignore results strictly (you mostly do) and delete the fake `abort` field.

**10. `visibleDetailPage()` can return a hidden `.itemDetailPage`**  
```js
pages[i].classList.contains('itemDetailPage') // returns even if offsetParent === null
```
Can mount the overlay on a stale page instance after SPA transitions. Prefer: visible `#itemDetailPage:not(.hide)` / `.page.itemDetailPage:not(.hide)` with `offsetParent` (or Jellyfin `viewshow`) only.

**11. Route detection is hash-only**  
Reinjection + `hashchange` + gen token is good for (b). Jellyfin also fires view lifecycle events; pure hash listening misses some client transitions / query-only updates. Subscribe to `viewshow`/`viewhide` on the detail page if you see remount gaps in the real webview.

**12. Reinjection sentinel is fine; VERSION never bumps**  
`dispose` + gen bump is correct. Bump `VERSION` when behavior changes so older injected copies always lose.

---

### P3 — A11y / polish / production

**13. Inert overflow controls**  
Show-level `⋯` and per-episode `⋮` are focusable buttons with no action. Either wire to native overflow / item menu, or don’t render them (design goal 1 allows overflow only if real).

**14. Episode / continue rows are non-accessible**  
Clickable `<div>`s — no `role="button"`, no keyboard handler, no focus style. Prefer `<button>` or `role="link"` with Enter/Space.

**15. Image fallbacks incomplete (must-fix g)**  
Empty thumb if no tag — OK. No `img.onerror` → broken icon if Primary 404. Add onerror → hide img or series fallback.

**16. “Show more” always shown**  
Toggle works (goal 5). Still show the control when the overview doesn’t overflow. Measure `scrollHeight > clientHeight` after layout and hide the button when unneeded.

**17. Production injection (must-fix f)**  
Code assumes DevTools-like `window.ApiClient` and free DOM injection. CSP, SW-cached old `main*.js`, and native shell webviews still need a documented inject path (plugin / custom CSS+JS / `index.html`). Not a logic bug, but it will “work in DevTools, die in prod” without that plan.

**18. Minor API / code nits**
- Dead line: `var call = on ? api().updateFavoriteStatus : api().updateFavoriteStatus`
- Favorite optimistic toggle is fine; `updateFavoriteStatus` signature matches apiclient.
- `getImageUrl` usage is correct (no manual tokens).
- `getNextUpEpisodes({ SeriesId, UserId, Fields, Limit })` shape is fine.
- `el()` + `textContent` escaping is good.
- CSS `url("…")` from `getImageUrl` is OK; still prefer `style.backgroundImage = 'url(' + JSON.stringify(bg) + ')'` to avoid quote edge cases.

---

### Must-fix scorecard

| Must-fix | Status |
|-----------|--------|
| (a) Play via native control, not `playbackManager` global | Partial — approach right; selectors/`btnResume` wrong; episode/continue not concrete |
| (b) Gen tokens + versioned dispose | Mostly — abort unused; hash-only |
| (c) Teardown restores native UI | OK via overlay; overstated vs “stored display” |
| (d) ApiClient for API + images | Yes — except wrong `Fields` for counts |
| (e) Play/Resume / concrete episode | Fail for rows; weak for continue |
| (f) Prod ≠ DevTools | Unaddressed in code |
| (g) textContent / lazy seasons / image fallbacks | Mostly — weak image onerror |

### Design goals

| Goal | Status |
|------|--------|
| 1 One Play + heart + overflow | Visual yes; overflow inert |
| 2 Single hero, no poster | Yes |
| 3 Tight header / above fold | Partial — no hero Back |
| 4 Episode desc 2 lines | Yes |
| 5 Show more toggles | Yes |
| 6 No per-episode heart | Yes |

---

### Fix order I’d ship

1. `Fields: 'ChildCount'` (+ optional recount from episodes).  
2. Fix `nativePlay` selectors to `.btnPlay` / `.btnReplay` as in 10.11 HTML; don’t use `.btnResume`.  
3. Continue + episode row: play **episode id** (detail-page delegate or equivalent), not series `.btnPlay` / hash-only navigation.  
4. Card title = episode name; section header = Next up / Continue.  
5. Enable Play only when native `.btnPlay:not(.hide)` is ready; hero Back.  
6. A11y + remove or wire inert `⋯`/`⋮`; img `onerror`.

I would not rubber-stamp this for production injection until (2) and (3) are fixed and verified on a cold series page (Play before/after native bind) and on an in-progress Next Up episode (resume position).
