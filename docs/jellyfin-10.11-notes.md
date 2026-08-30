# Jellyfin 10.11 web-client facts (verified)

Hard-won facts about the stock web client, verified against the live 10.11 DOM and/or the
jellyfin-web v10.11.8 source (gpt cloned + grepped it during spec review). These are what the
transform depends on — re-verify if Jellyfin is upgraded.

## Globals / modules
- `window.ApiClient` **IS** exposed (set in `ServerConnections.js`: `window.ApiClient = apiClient`).
  Use its helpers — do NOT hand-build URLs or put tokens in image URLs:
  - `ApiClient.getCurrentUserId()`
  - `ApiClient.getItem(userId, itemId)`
  - `ApiClient.getSeasons(seriesId, { userId, Fields:'ChildCount' })`  ← Fields MUST be `ChildCount` for episode counts; `ItemCounts` does NOT populate `ChildCount`.
  - `ApiClient.getEpisodes(seriesId, { seasonId, userId, Fields:'Overview' })`
  - `ApiClient.getNextUpEpisodes({ SeriesId, UserId, Fields:'Overview', Limit:1 })`
  - `ApiClient.getImageUrl(itemId, { type:'Primary'|'Backdrop', tag, maxWidth })`
  - `ApiClient.updateFavoriteStatus(userId, itemId, isFavorite)` → Promise
- `playbackManager` is a **module export** (`export const playbackManager = new PlaybackManager()`
  in `components/playback/playbackmanager.js`), NOT a global. Injected code cannot import it.
  → **Delegate playback to native controls** instead.

## Item detail page — native markup (in `.mainDetailButtons`, page `#itemDetailPage`)
Verified by dumping the live buttons:
| Button | class | data-action | notes |
|--------|-------|-------------|-------|
| Play / Resume (primary) | `.btnPlay` | `resume` | VISIBLE. Click this for "Play" (native resume/play). |
| Play from start | `.btnReplay` | `play` | HIDDEN unless resume available. |
| Shuffle | `.btnShuffle` | — | (a fix removes it from our UI) |
| Mark played (check) | `.btnPlaystate` (`emby-playstatebutton`) | — | (removed from our UI) |
| Favorite (heart) | `.btnUserRating` (`emby-ratingbutton`) | — | we use the API instead |
| Overflow (…) | `.btnMoreCommands` | — | wire our ⋯ to click this for a real menu |
| Download / Trailer / InstantMix / Split / timers | `.btnDownload` etc. | — | usually `.hide` |
- `.btnResume` does **NOT** exist (an early wrong guess). Resume is `.btnPlay[data-action=resume]`.
- The visible detail page is `#itemDetailPage:not(.hide)` with `offsetParent !== null`. A
  `.itemDetailPage` can exist hidden after SPA transitions — always gate on visibility.
- Native bind race: `.btnPlay` may be present but not yet wired right after route change;
  our code retries the click briefly and disables the Play pill until `.btnPlay:not(.hide)` exists.

### iPad-UA pinned detail header
- Verified at 834×1194, DPR 2, touch, iPad Safari UA against the live 10.11 UI:
  - `.skinHeader` is a sibling/outside ancestor of `#itemDetailPage`, with `position: fixed` and
    `z-index: 999`; it forms the top app bar and therefore cannot be covered by an absolute
    overlay inside the detail page.
  - `#itemDetailPage:not(.hide) > .detailPageWrapperContainer > .detailPagePrimaryContainer >
    .detailRibbon` has `position: relative` and `z-index: 2`. It contains `.infoWrapper`
    (poster thumbnail, centered title/metadata) and `.mainDetailButtons` (play, shuffle,
    play-state, favorite, and overflow). It paints above `#streamline-detail` (`z-index: 1`).
- While a Streamline Series view is mounted, `body.streamline-series-active` hides the native
  `.skinHeader` and visible page `.detailRibbon` with Streamline-owned CSS. Do not add Jellyfin's
  `.hide` class: `.btnPlay:not(.hide)` readiness/delegation and `.btnMoreCommands:not(.hide)`
  overflow delegation must continue to find and click the native controls.

## Custom-view DOM classes (stock detail page, for CSS-only hiding if ever needed)
- Synopsis paragraph: `.overview` (also `.detail-clamp-text`) — NOT `.overview-text`.
- Metadata rows: `.genresGroup`, `.studiosGroup`, `.itemTags`, `.itemExternalLinks`.
- Cast: `#castCollapsible`.

## Display preferences page and Save behavior
- Verified by read-only grep of the installed macOS bundle at
  `/Applications/Jellyfin.app/Contents/Resources/jellyfin-web` (the
  `user-display.*.chunk.js` and `user-display-index-tsx.*.chunk.js` chunks).
- The React Display page renders with `id="displayPreferencesPage"`, and its settings container
  contains a single `<form>`. Therefore `#displayPreferencesPage form` is the verified picker
  mount selector for this installed 10.11 bundle.
- The Save control is rendered inside that form with `type="submit"`. The form has an `onSubmit`
  handler that calls `preventDefault()` and then the native `submitChanges()` path. A native DOM
  `submit` listener on the form therefore observes Save activation; a separate click-only hook is
  not required for this bundle.

## Playback for a specific episode
No global playbackManager → navigate to the episode's detail hash
(`location.hash = '#/details?id=<episodeId>'`), wait for that page's
`.mainDetailButtons .btnPlay/.btnReplay`, and click it. Our route watcher only mounts on
`Type === 'Series'`, so Episode/Season detail pages stay native and this delegation works.

## Home route, DOM, navigation, and data helpers
- The installed 10.11 route is exactly `#/home`. The index route uses a replace redirect to
  `/home`; empty-hash forms (`""`, `"#"`, and `"#/"`) are transient router states and are not
  safe home-mount targets.
- The visible home container is `#indexPage.homePage:not(.hide)`, additionally gated by
  `isConnected && offsetParent !== null`. Jellyfin may replace this React-owned node without a
  hash change, so the transform stores and observes the exact node identity.
- The native home tab content roots under `#indexPage` are `#homeTab` and `#favoritesTab`.
  Streamline replaces the entire home route and hides exactly those roots plus `.skinHeader`;
  broad `#indexPage > *` hiding would also hide the injected overlay and must not be used.
- Native Search and profile-menu routes are exactly `#/search` and `#/mypreferencesmenu`.
  Assigning either to `location.hash` creates the normal history entry expected by Back.
- `ApiClient.getCurrentUser()` returns a Promise. Home avatar values therefore load
  asynchronously and are cached by server ID plus current-user ID.
- `ApiClient.getResumableItems(userId, options)` is the installed Resume helper and returns a
  query-result object (`result.Items`). `ApiClient.getItems(userId, options)` is the installed
  helper used for the Series and Movie library rails.
- Home-specific playback intentionally navigates through `#/details?id=<concreteItemId>` and
  clicks that visible page's native `.btnPlay`/`.btnReplay`. The poll must first verify that the
  route ID equals the requested item ID; this native delegation adds a detail entry to playback's
  back stack, which is accepted v1 behavior.
- Shows and Movies intentionally request the complete small library in one rail for v1. Revisit
  a cap or pagination if the library grows enough for unbounded rail queries to become costly.

## Delivery / production caveats (from gpt spec review, docs/reviews/)
- Bundled `index.html` is macOS App-Management-protected (can't edit in place).
- Inline `<script>`/`<style>` may be blocked by CSP in prod — prefer external `<script src>`/`<link>`.
- The **service worker** can serve a cached old app shell — version injected asset URLs.
- The mobile webview differs from desktop Chrome (safe-area insets, autoplay gestures, back
  button, layout) — test in the real app, don't assume parity.
- `/Branding/Css` is hard-cached by the client; changes need a hard reload / app force-close.
