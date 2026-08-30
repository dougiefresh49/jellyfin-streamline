# Spec: production delivery via custom web-dir (Streamline)

## Goal
Serve the Jellyfin web client from a writable COPY of the bundled jellyfin-web with the
Streamline theme assets baked in, so the theme loads automatically — no DevTools injection.
Survives Jellyfin app updates by re-running the build script.

## Why custom webdir (not reverse proxy, not editing the bundle)
- The bundled `index.html` is macOS App-Management-protected → cannot edit in place.
- A reverse proxy adds an always-on moving part; `--webdir` is a first-class jellyfin flag and
  this server is ALREADY launched with explicit flags (menu-bar TCC workaround), so it's free.

## Locations (pinned)
- SOURCE bundle: `/Applications/Jellyfin.app/Contents/Resources/jellyfin-web` (env `SRC` overrides)
- DEST webdir: `"$HOME/Library/Application Support/jellyfin/streamline-web"` (env `DEST` overrides)
  Rationale: NOT the repo (40 MB+ build artifact, git noise, and the server shouldn't depend on
  where the repo lives) and NOT /Applications (protected; replaced on app update). It lives next
  to the jellyfin datadir, which survives both.
- Theme assets inside DEST: `streamline/theme.<hash8>.js`, `streamline/view.<hash8>.css` where
  hash8 = first 8 hex chars of the sha-256 of the file content (cache-busting vs the service
  worker / HTTP cache).

## Deliverables
1. `scripts/webdir/build-webdir.sh` (bash; only rsync/shasum/sed/grep — no other deps)
   - `rsync -a --delete SRC/ DEST/` (fail loudly if SRC missing).
   - Copy repo `js/theme.js` → `DEST/streamline/theme.<hash8>.js` and `css/view.css` →
     `DEST/streamline/view.<hash8>.css`; delete stale hashed versions.
   - Inject into `DEST/index.html`, idempotently (strip any previous marker block first):
     - before `</head>`: `<link rel="stylesheet" href="streamline/view.<hash8>.css">`
     - before `</body>`: `<script defer src="streamline/theme.<hash8>.js"></script>`
     wrapped in `<!--streamline-start-->` / `<!--streamline-end-->` marker comments so re-runs
     replace cleanly. Note index.html is likely minified/single-line — anchors must not assume
     line breaks.
   - Self-verify: grep the injected tags back out of `DEST/index.html`; then echo the launch
     command the integrator will use:
     `"/Applications/Jellyfin.app/Contents/MacOS/jellyfin" --webdir "$DEST" --ffmpeg "<bundled ffmpeg path>" --datadir "$HOME/Library/Application Support/jellyfin"`
     (verify the real bundled ffmpeg path by looking inside the app bundle, read-only).
   - Idempotent; safe to re-run while the server runs (files are read per-request).
2. `scripts/webdir/launch-jellyfin.sh` — starts the server detached (nohup) with the flags
   above, logging to `"$HOME/Library/Logs/jellyfin-streamline.log"`. REFUSES to start if a
   `MacOS/jellyfin` process is already running (print the pkill hint; never kill anything).
3. `scripts/webdir/com.jellyfin.streamline.plist` — launchd LaunchAgent TEMPLATE (RunAtLoad,
   KeepAlive) running the same command, for reboot survival. Provided as a template + docs
   only; nothing installs it automatically (FDA/TCC implications are handled at the Mac).
4. `docs/delivery.md` — how delivery works; procedure after a Jellyfin app upgrade (re-run the
   build script); the service-worker / index.html caching caveat (client may need app
   force-close or hard refresh); TCC note: a process launched from launchd or a shell needs
   Full Disk Access in its own right — the planned FDA grant must cover whichever launcher is
   used, else the server loses `/Volumes/Seagate 4TB`.

## Constraints for the implementer
- Do NOT touch `js/`, `css/`, `README.md`, or anything outside `scripts/webdir/` and
  `docs/delivery.md`.
- Do NOT start, stop, or signal any server process. Do NOT write to the real DEST — the
  integrator runs the build. For a self-test, use a temp DEST inside the repo (e.g.
  `.tmp-webdir-test/`) against the real SRC (read-only), verify the injection, then delete it.
