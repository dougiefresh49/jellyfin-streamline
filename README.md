# Jellyfin Kids Theme

Custom kid-friendly UI for our self-hosted **Jellyfin** (v10.11) media server, delivered as
**injected JavaScript + CSS**. It transforms the stock TV-show detail page into a modern,
Netflix/Disney+-style combined show → seasons → episodes view. Viewed in the Jellyfin mobile
app (a webview) on the kids' tablets.

**Status: POC WORKING** (2026-07-18). Verified live via DevTools injection against the real
server. Owner approved the look ("looks really good, not childish, buttons big enough for
grown-up fingers"). Production delivery not yet built — see [Where we are](#where-we-are).

## Why injected JS+CSS (not a plugin, not just CSS)
- **Jellyfin plugins** are server-side .NET — they cannot touch the web UI. Wrong tool.
- **Custom CSS alone** (branding box) can only style/hide/clamp (~60%). It cannot restructure
  the DOM (single hero, one Play pill, combined view, working "show more"). So we need JS.
- **Injected JS** runs in the authenticated page, can call the full REST API via
  `window.ApiClient`, and can render our own view. This is the approach.

## The design
Approved concept: **`docs/design/gpt-concept-APPROVED.html`** (open in a browser). The six
fixes it bakes in (all implemented):
1. One primary **Play** pill + heart + overflow (no shuffle / mark-played).
2. Single cinematic hero, **no** redundant poster card.
3. Tight header → content above the fold.
4. Episode descriptions **clamped to 2 lines**.
5. **"Show more" actually toggles** (and hides itself when text doesn't overflow).
6. **No per-episode heart.**

Also in `docs/design/`: `grok-concept.html` (the cleaner Netflix-clone alt, not chosen),
`sewerstream-goham-*.html` (fun over-the-top TMNT skins — NOT for implementation), `brief.md`.

## Architecture
Targeted **route hijack** of the **series** detail route only (`#/details?id=<seriesId>`):
- `js/theme.js` watches the SPA hash, and when a *Series* detail route is shown, renders our
  own `#kids-detail` view (styled by `css/view.css`) into the native `#itemDetailPage`,
  covering it. Data comes from `window.ApiClient` (getItem / getSeasons / getEpisodes /
  getNextUpEpisodes / getImageUrl).
- **Playback delegates to Jellyfin's native controls** (its `playbackManager` is a module
  export, not a global, so we can't call it directly): the Play pill clicks the native
  `.btnPlay`; an episode navigates to its detail hash and clicks that page's native play.
- Everything else (home, library grids, search, the video player, season/episode detail
  pages) stays **stock**. Lifecycle is route-keyed with a versioned global sentinel
  (`window.__kidsTheme`) so re-injection disposes the prior instance.

See `specs/show-detail-transform.md` for the full spec and `docs/jellyfin-10.11-notes.md` for
the hard-won DOM/API facts (verified against live 10.11 markup).

## Repo layout
```
css/theme.css     branding-box CSS (Ultrachromic import + hide/clamp) — styles STOCK Jellyfin
css/view.css      styles ONLY the injected #kids-detail custom view
js/theme.js       the route-hijack + custom render (v2)
specs/            implementation spec
docs/design/      approved concept + alternates + brief
docs/reviews/     gpt spec review + grok implementation review
docs/verification-recipe.md   how to reproduce the live POC (login inject, http server, screenshot)
docs/jellyfin-10.11-notes.md  DOM selectors, ApiClient facts, gotchas
scripts/          (reserved for the production inject/delivery scripts — not built yet)
```

## Where we are
DONE: spec → gpt spec-review (7 must-fixes) → implement → grok implementation-review (P0 bugs
found) → fixes applied & re-verified (incl. Play delegation spied and confirmed) → owner
approved screenshot.

NOT DONE (next session):
1. **Production delivery — the blocker.** The POC is injected via DevTools; that proves the
   *code*, not the *deployment*. The bundled `index.html`
   (`/Applications/Jellyfin.app/Contents/Resources/jellyfin-web/index.html`) is **macOS
   App-Management-protected** (can't edit in place). Pick + build one of:
   custom web-dir copy (point Jellyfin at a writable copy with our tags baked in) OR a
   reverse proxy that injects `<script src>`/`<link>`. Both survive Jellyfin updates.
   (gpt flagged: inline injection may hit CSP; use external assets; version them; watch the
   service worker cache.)
2. Only the **Series** page is transformed; season/episode pages stay native (intentional).
3. **Test in the real mobile app webview** (POC ran in desktop-UA headless Chrome forced narrow).
4. **Pick an accent color** — currently a placeholder violet (`--kd-accent` in `view.css`).
5. Optional polish from grok's review (docs/reviews): AbortController for in-flight fetches,
   `viewshow`/`viewhide` events vs hash-only, per-season episode caching.

## How we work on this (multi-agent pipeline)
Claude specs → **gpt** (codex, Sol tier) reviews the spec → Claude implements → **grok**
(cursor-agent) reviews the implementation → Claude verifies any factual dispute against the
live DOM (authoritative) → screenshot to owner. Both review docs are in `docs/reviews/`.
