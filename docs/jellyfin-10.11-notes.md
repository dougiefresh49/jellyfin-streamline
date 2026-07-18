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

## Custom-view DOM classes (stock detail page, for CSS-only hiding if ever needed)
- Synopsis paragraph: `.overview` (also `.detail-clamp-text`) — NOT `.overview-text`.
- Metadata rows: `.genresGroup`, `.studiosGroup`, `.itemTags`, `.itemExternalLinks`.
- Cast: `#castCollapsible`.

## Playback for a specific episode
No global playbackManager → navigate to the episode's detail hash
(`location.hash = '#/details?id=<episodeId>'`), wait for that page's
`.mainDetailButtons .btnPlay/.btnReplay`, and click it. Our route watcher only mounts on
`Type === 'Series'`, so Episode/Season detail pages stay native and this delegation works.

## Delivery / production caveats (from gpt spec review, docs/reviews/)
- Bundled `index.html` is macOS App-Management-protected (can't edit in place).
- Inline `<script>`/`<style>` may be blocked by CSP in prod — prefer external `<script src>`/`<link>`.
- The **service worker** can serve a cached old app shell — version injected asset URLs.
- The mobile webview differs from desktop Chrome (safe-area insets, autoplay gestures, back
  button, layout) — test in the real app, don't assume parity.
- `/Branding/Css` is hard-cached by the client; changes need a hard reload / app force-close.
