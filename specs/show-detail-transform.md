# Spec: Show-detail transform (Jellyfin Kids)

## Goal
Replace Jellyfin's TV-show detail experience with a single cinematic, kid-friendly streaming view matching the approved **gpt** concept, via injected CSS + JS in the web client. Combine show → seasons → episodes into one flow (like Netflix/Disney+). Applies to the detail/season route ONLY; home, library grids, search, and the video player stay stock.

## Delivery (POC vs production)
- **POC / verification:** inject `theme.js` + `theme.css` into the live authenticated page via DevTools `evaluate_script` — no sudo, no bundle edits. This proves the code.
- **Production (decide after POC):** serve the web client from a writable COPY (custom webdir) OR a reverse proxy that injects `<script>`/`<style>`. Both survive Jellyfin app updates. (The bundled `index.html` is macOS App-Management-protected, so we do NOT edit it in place for prod.)

## Architecture: targeted route hijack (render our own view from API data)
Single injected script, runs on every load:
1. **Router watch:** listen for `hashchange` + a `MutationObserver` on `#reactRoot` to detect when the SPA shows a series/season detail route (`#/details?id=<id>`). Guard against React re-renders by keying our container on a fixed id.
2. **On entering a series detail**, fetch via the authenticated `window.ApiClient` (fallback: `fetch` with the session token):
   - Series item — name, production years, OfficialRating, CommunityRating, Overview, image tags. `GET /Users/{uid}/Items/{seriesId}`
   - Resume / Next Up — `GET /Shows/NextUp?SeriesId=` + item `UserData` (`PlaybackPositionTicks`, `RunTimeTicks` → % watched + minutes left)
   - Seasons — `GET /Shows/{seriesId}/Seasons` (+ episode counts via `ChildCount` or `/Episodes`)
   - Episodes (combined view) — `GET /Shows/{seriesId}/Episodes?seasonId=` — index, name, runtime, overview, primary image, UserData (watched/progress)
3. **Render** our own DOM into a container `#kids-detail` appended to the page; hide Jellyfin's native detail content while ours is shown. Compose per gpt layout:
   - **Hero:** full-bleed backdrop (`/Items/{id}/Images/Backdrop`) with gradient fade; title/logo overlaid; ONE metadata line (year · rating badge · N seasons · ★score). No poster card.
   - **Primary action:** big Play/Resume pill; label reflects resume state (e.g., "Resume S1:E3 · 12 min left"). Secondary: Favorite (heart) toggle + overflow (⋯). No shuffle/checkmark.
   - **Synopsis:** 3-line clamp + working Show more/less (real JS toggle).
   - **Continue Watching card** (if resume exists): thumbnail + progress bar + "S1:E3 · Black Out · 12 min left".
   - **Seasons:** horizontal landscape cards w/ episode counts; selecting a season expands the episode list INLINE (true combined view). Episodes: thumbnail + title + runtime + 2-line clamp + overflow + watched tick. NO per-episode heart.
4. **Play/Resume must hook Jellyfin's REAL playback** — do not reinvent the player. Reuse Jellyfin's `playbackManager` entrypoint, or navigate to its play route, or (fallback) programmatically trigger the native Play control. Confirming this hook against Jellyfin 10.11 is the #1 technical risk.
5. **Cleanup on navigate-away:** remove `#kids-detail`, unhide native content, tear down observers/listeners (no leaks, no duplicate containers).

## The six fixes (baked in)
1. One Play pill + heart + overflow (shuffle/checkmark gone). 2. Single hero, no poster. 3. Tight header → content above the fold. 4. Episode descriptions clamped to 2 lines. 5. Show more actually toggles. 6. No per-episode heart.

## Theming
gpt layout approved. Accent is a CSS var `--accent` (owner did NOT commit to the lime — expose it, pick a color owner approves). Dark near-black base.

## Risks / open questions
- **Play hook** (top risk): exact `playbackManager` entrypoint must be confirmed on 10.11.
- **SPA timing:** observer must not duplicate our container on re-render (id guard) and must fire after data-bearing DOM/route is ready.
- **Version fragility:** REST endpoints are stable; DOM hooks (hiding native content, finding Play) are the fragile part — minimize; prefer API + our own render.
- **Combined vs separate season view:** recommend inline-expand within detail (confirm).
- **Mobile app parity:** verify the transform in the webview app after POC (same client, should match).

## Verification plan
Inject via DevTools on the live "Batman Beyond" series page at mobile viewport → screenshot → confirm: layout matches gpt concept, Play triggers real playback, Show more toggles, navigating away cleans up, no dupes.
