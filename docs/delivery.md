# Streamline delivery

Streamline is delivered through Jellyfin's `--webdir` option. The build script copies the read-only web client bundled in `/Applications/Jellyfin.app` to a writable directory beside Jellyfin's data, adds content-hashed copies of the theme assets, injects their tags into the copied `index.html`, and installs a self-updating service worker. It never edits the application bundle.

## Build and launch

Build the custom web directory:

```sh
scripts/webdir/build-webdir.sh
```

By default this writes to `$HOME/Library/Application Support/jellyfin/streamline-web`. `SRC` and `DEST` may override the source and destination. The script is idempotent and may safely be rerun while Jellyfin is serving files.

Launch Jellyfin detached with the same paths and log to `$HOME/Library/Logs/jellyfin-streamline.log`:

```sh
scripts/webdir/launch-jellyfin.sh
```

The launcher refuses to run when a `MacOS/jellyfin` process already exists and does not stop it. To launch directly, use:

```sh
"/Applications/Jellyfin.app/Contents/MacOS/jellyfin" --webdir "$HOME/Library/Application Support/jellyfin/streamline-web" --ffmpeg "/Applications/Jellyfin.app/Contents/MacOS/ffmpeg" --datadir "$HOME/Library/Application Support/jellyfin"
```

## LaunchAgent template

`scripts/webdir/com.jellyfin.streamline.plist` is a template for a per-user LaunchAgent with `RunAtLoad` and `KeepAlive`. Replace every `REPLACE_WITH_HOME` with the absolute home-directory path before installing it yourself. Nothing in this repository installs or loads the template automatically.

A process started by launchd or by a shell needs Full Disk Access in its own right. The FDA grant must cover whichever launcher is actually used; otherwise Jellyfin will lose access to `/Volumes/Seagate 4TB`.

## After a Jellyfin update

Rerun `scripts/webdir/build-webdir.sh`. It refreshes the entire copied web client from the updated application bundle, removes stale hashed theme assets, and reinjects the current theme tags.

The bundled Jellyfin web client registers `serviceworker.js` from `main.jellyfin.bundle.js`. In the currently bundled version, that worker has no Workbox precache manifest, named app-shell cache, or `index.html` revision to bump; it handles notification clicks and claims clients on activation. Older clients or Jellyfin versions can nevertheless leave Cache Storage entries behind, and the stable worker URL can keep an old controller in charge during an update.

Each Streamline build therefore replaces the copied `serviceworker.js` with a minimal worker containing a unique build hash. It calls `skipWaiting()` during installation, deletes **all** Cache Storage caches and claims open clients during activation, and handles GET requests network-first with a cache fallback. Navigation requests use `cache: no-store` so the browser's HTTP cache cannot supply a stale shell. The build also puts the same hash on the worker script URL in `index.html`. This makes browsers detect every deployment and removes stale app-shell caches without changing the application bundle.

Service-worker updates are inherently staged. The first launch after a deployment may still show the old shell once while the new worker installs and activates; after closing it, the next launch is fresh. A hard refresh or repeated manual refreshes should no longer be necessary.

The Android app's webview obeys service-worker lifecycle and caching behavior when service workers are enabled for that client/version. Do not use Android's **Clear storage** as a routine theme-update fix: it also removes the Jellyfin login and other app data, and is no longer needed for Streamline deployments.
