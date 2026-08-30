# Streamline — a Jellyfin theme

Modern streaming-style UI for our self-hosted **Jellyfin** (v10.11) media server, delivered as
**injected JavaScript + CSS**. It transforms the stock TV-show detail page into a
Netflix/Disney+-style combined show → seasons → episodes view. Viewed in the Jellyfin mobile
app (a webview) on tablets/phones.

**Status: DEPLOYED** (2026-07-19). Served automatically by the live server via a custom
web-dir (`scripts/webdir/`, see `docs/delivery.md`) — no manual injection. Owner approved the
look. Per-user accent color is choosable in the user's Display settings. Verified on an iPad
Pro 11" viewport; real-phone check by the owner is the remaining step — see
[Where we are](#where-we-are).

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
  own `#streamline-detail` view (styled by `css/view.css`) into the native `#itemDetailPage`,
  covering it. Data comes from `window.ApiClient` (getItem / getSeasons / getEpisodes /
  getNextUpEpisodes / getImageUrl).
- **Playback delegates to Jellyfin's native controls** (its `playbackManager` is a module
  export, not a global, so we can't call it directly): the Play pill clicks the native
  `.btnPlay`; an episode navigates to its detail hash and clicks that page's native play.
- Everything else (home, library grids, search, the video player, season/episode detail
  pages) stays **stock**. Lifecycle is route-keyed with a versioned global sentinel
  (`window.__streamlineTheme`) so re-injection disposes the prior instance.

See `specs/show-detail-transform.md` for the full spec and `docs/jellyfin-10.11-notes.md` for
the hard-won DOM/API facts (verified against live 10.11 markup).

## Repo layout
```
css/theme.css     branding-box CSS (Ultrachromic import + hide/clamp) — styles STOCK Jellyfin
css/view.css      styles ONLY the injected #streamline-detail custom view
js/theme.js       the route-hijack + custom render (v2)
specs/            implementation specs (detail transform, webdir delivery, accent preference)
docs/design/      approved concept + alternates + brief
docs/reviews/     gpt spec reviews + grok implementation reviews
docs/delivery.md  how production delivery works + upgrade/caching/TCC notes
docs/verification-recipe.md   how to verify against the live server (login inject, screenshot)
docs/jellyfin-10.11-notes.md  DOM selectors, ApiClient facts, gotchas
scripts/webdir/   build-webdir.sh (webdir copy + tag injection), launcher, LaunchAgent template
scripts/ripping/  DVD-rip renaming helpers (rename_show.sh, courage_titles.txt)
scripts/ripper/   two-drive automated TMNT ripping pipeline (see specs/ripper-pipeline.md)
```

## Where we are
DONE (as of 2026-07-19):
1. **Production delivery LIVE** — custom web-dir at
   `~/Library/Application Support/jellyfin/streamline-web/`, built by
   `scripts/webdir/build-webdir.sh` (hashed asset names beat the service-worker cache; tags
   injected with marker comments; idempotent). Server runs with `--webdir` pointing at it.
   Re-run the build script after editing theme files or upgrading Jellyfin (`docs/delivery.md`).
2. **Per-user accent color** — 6 presets, picker injected into the user's Display settings
   (`#/mypreferencesdisplay`), stored server-side in DisplayPreferences CustomPrefs
   (`streamlineAccent`), localStorage mirror for instant paint. Spec-reviewed by gpt (11
   must-fixes applied), implementation-reviewed by grok (P0 + fixes applied, see docs/reviews/).
3. **Verified on iPad Pro 11" viewport** (gpt computer-use): auto-delivery, layout, play
   delegation, accent persistence incl. native-Save reconciliation, route cleanup.

NOT DONE:
1. **Owner phone check** in the real mobile app webview (emulated iPad ≠ real device).
2. Only the **Series** page is transformed; season/episode pages stay native (intentional).
3. Optional polish from grok's original review: AbortController for in-flight fetches,
   per-season episode caching.

## How we work on this (multi-agent pipeline)
Claude specs → **gpt** (codex, Sol tier) reviews the spec → Claude implements → **grok**
(cursor-agent) reviews the implementation → Claude verifies any factual dispute against the
live DOM (authoritative) → screenshot to owner. Both review docs are in `docs/reviews/`.
