# Spec: Home page transform (Streamline) — v2 (gpt spec-review applied; review is BINDING)

Implementer MUST also read `docs/reviews/home-spec-review-gpt.md` — every MUST-FIX there is
binding; NICE-TO-HAVE items 19–22 are also adopted. Facts below marked (verified) were checked
against the installed 10.11 bundle by the reviewer.

## Goal
Replace the stock Jellyfin home page with the approved concept
`docs/design/home-concept-gpt.html`: quiet top bar, cinematic billboard doubling as a one-tap
resume surface, then rails — Continue Watching (landscape, progress), Shows (posters),
Movies (posters). Injected-JS approach in js/theme.js, css in css/view.css.

## Route + readiness (review #1, #2)
- Route (verified): `#/home` — match `^#\/?home(?:[?]|$)`. NEVER mount on `""`, `"#"`, `"#/"`
  (transient pre-router states; Jellyfin redirects to `#/home` itself).
- Mount only when ALL THREE hold: route matches, `window.ApiClient` exists, AND
  `ApiClient.getCurrentUserId()` is non-empty. Bounded, disposable retry timer for the
  sign-in race (client can exist before the user does; sign-in doesn't change the hash).
  Teardown immediately if the user id changes.

## Mount + lifecycle (review #3, #4, #5, #6, #14)
- Container (verified): `#indexPage.homePage:not(.hide)` with `isConnected &&
  offsetParent !== null`. Store the exact node; reject async work if it's disconnected/hidden.
- Overlay `#streamline-home` (absolute, same pattern as detail) + `body.streamline-home-active`.
- Hiding (verified selectors — pin in docs/jellyfin-10.11-notes.md): hide `.skinHeader` and
  the native tab contents `#homeTab`, `#favoritesTab` under the page — NEVER arbitrary
  children of `#indexPage` (must not hide our own root).
- Tabs policy (v1): our view replaces the ENTIRE `#/home` route including a restored
  Favorites tab; native header tabs are hidden while active. Favorites is not exposed in v1.
- Lifecycle: hashchange + bounded mount-retry + a narrow observer that detects `#indexPage`
  replacement/removal and remounts (debounced). Every observer/timer/rAF/listener is
  cancelled in teardown and `dispose()`. All callbacks (success AND failure, incl. avatar,
  accent, images, section renders) re-check: gen, current user id, root identity,
  `root.isConnected`. A stale catch must never clear a newer mount's content.

## Top bar (review #7, #16)
- Wordmark "Streamline" + concept mark.
- Search icon (inline SVG, ≥44px) → `location.hash = '#/search'` (verified route; normal
  history entry; our teardown restores `.skinHeader` on route exit).
- Avatar → `#/mypreferencesmenu` (verified). Render neutral avatar first;
  `ApiClient.getCurrentUser()` is a PROMISE — `.then(u => u.Name[0])`, cached per
  (serverId,userId), guarded, cache cleared on user change/logout.

## Data (review #8, #9, #10, #17, #18)
- Fetch all sections concurrently, render with `Promise.allSettled`-style orchestration:
  each rail degrades independently, but the HERO is selected only after both the merged
  Continue Watching list and the Shows result are known.
- Continue Watching:
  - `ApiClient.getResumableItems(uid, { Recursive:true, Limit:12, MediaTypes:'Video', Fields:'Overview', EnableTotalRecordCount:false })` (verified helper) → `.Items || []`.
  - `ApiClient.getNextUpEpisodes({ UserId:uid, Limit:12, Fields:'Overview', EnableTotalRecordCount:false })`.
  - Merge: resume items first; then next-up episodes whose SeriesId is NOT in the set of
    non-empty SeriesIds from resumable EPISODES (movies must not poison the set with
    undefined). Dedup by item Id across both lists. Multiple resumable episodes of one
    series are kept as returned.
- Shows: `ApiClient.getItems(uid, { IncludeItemTypes:'Series', Recursive:true, SortBy:'SortName', Fields:'ChildCount', EnableTotalRecordCount:false })` → sub `N season(s)`.
- Movies: same with `IncludeItemTypes:'Movie'` (+ runtime fields) → sub `YYYY · Xh Ym`.
- "Everything in one rail" is intentional v1 policy for this small library (documented cap
  revisit later).

## Hero (review #9)
First merged Continue Watching entry; fallback first Series with `BackdropImageTags[0]`;
else omit. Real Backdrop (maxWidth 1280) under the concept scrims. Kicker "Continue
watching" / "Featured". Primary `▶ Resume`/`▶ Play` → `playItem`; secondary `ⓘ Details` →
detail page.

## Cards: navigation + a11y (review #11, #12, #21)
- Accessible model (pinned): the card's art+text is ONE button → Details; the play-chip is a
  SEPARATE ≥44px button (item-specific aria-label like "Resume Batman Beyond episode 3") →
  plays via `playItem`. No nested interactive elements. Rails are labelled regions with
  visible focus styles.
- Details targets: episode card → its SeriesId's detail page (fallback own Id if absent);
  movie → own Id. `encodeURIComponent` the id; route `#/details?id=<id>` pushes a NORMAL
  history entry (one Back returns to `#/home`).
- Play targets: episode/movie's OWN Id via `playItem`. Document (and verify in testing, not
  fix) that `playItem` routes through the item's native detail page, which adds a back-stack
  entry — accepted v1 behavior.

## playItem hardening (review #15)
Polling must confirm the visible detail page is for the REQUESTED item (check the route id),
not merely that any `.btnPlay` exists (outgoing cached page trap). All polling timers
cancellable on gen change/dispose; on timeout, degrade silently but do not half-click.

## State restoration (review #13)
In-memory (per server+user) record of home `scrollTop` + each rail's `scrollLeft`, captured
before navigating away, restored after remount. Reset on logout/full dispose. Fresh
navigation to home starts at top.

## Formatting + images (review #19, #20)
- Remaining time: `max(0, RunTimeTicks - PlaybackPositionTicks)`; absent runtime or ≤0 left →
  fall back to `S1:E3` metadata or runtime-only; never negative or "0 min left".
- Every card type: `img.onerror` → remove img, keep a labelled placeholder card (navigable).
  Episode landscape art: episode Primary → series Backdrop/Thumb fallback (ParentBackdrop*
  fields if present).

## Loading (review #22)
Non-blocking: render top bar immediately; lightweight skeleton blocks for rails while
fetching; failed/empty sections removed silently; if EVERYTHING fails keep the top bar and
show one modest "Couldn't load — tap to retry" affordance (no toasts).

## CSS
`#streamline-home` section in css/view.css using existing `--sl-*` tokens; adapt the
concept's hero/rail/card styles incl. 560px phone breakpoint, scroll-snap, hidden
scrollbars, active-press scale, reduced-motion guards. Accent applies via `applyAccent`.
No borders on cards; all tap targets ≥44px.

## Out of scope (v1)
Favorites tab, See-all library views, genre rows, search/profile redesign.

## Verification (computer-use; iPad 834px AND phone 412px; review #23)
- Cold authenticated boot with empty hash → Jellyfin redirects → our home mounts once.
- ApiClient-before-user race: our view appears after sign-in without a hash change.
- Home renders: billboard w/ real backdrop; rails scroll; Continue Watching sublabels
  correct; Shows 3 posters w/ season counts; Movies 7 w/ year·runtime.
- Hero Resume delegation spy fires (no playback). Poster → detail mounts; Back → home
  remounts with restored scroll; ×3 rapid cycles → exactly one overlay, one body class, no
  stray observers/timers.
- Search + avatar routes land native with header restored; Back returns home.
- Restored-Favorites-tab case: our view still replaces home entirely.
- Accent preset reflects on chips/progress/primary. No console errors from streamline assets.
