#!/bin/bash

set -euo pipefail

SCRIPT_DIR=${BASH_SOURCE[0]%/*}
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

SRC=${SRC:-/Applications/Jellyfin.app/Contents/Resources/jellyfin-web}
DEST=${DEST:-$HOME/Library/Application Support/jellyfin/streamline-web}

THEME_SOURCE="$REPO_ROOT/js/theme.js"
VIEW_SOURCE="$REPO_ROOT/css/view.css"

if [[ ! -d "$SRC" ]]; then
    printf 'error: Jellyfin web source does not exist: %s\n' "$SRC" >&2
    exit 1
fi
if [[ ! -f "$SRC/index.html" ]]; then
    printf 'error: Jellyfin web source has no index.html: %s\n' "$SRC" >&2
    exit 1
fi
if [[ ! -f "$THEME_SOURCE" || ! -f "$VIEW_SOURCE" ]]; then
    printf 'error: Streamline source assets are missing under %s\n' "$REPO_ROOT" >&2
    exit 1
fi

theme_sum=$(shasum -a 256 "$THEME_SOURCE")
theme_sum=${theme_sum%% *}
theme_hash=${theme_sum:0:8}
view_sum=$(shasum -a 256 "$VIEW_SOURCE")
view_sum=${view_sum%% *}
view_hash=${view_sum:0:8}

theme_name="theme.$theme_hash.js"
view_name="view.$view_hash.css"

# Refreshing from SRC first also removes every stale Streamline hash.
rsync -a --delete "$SRC/" "$DEST/"
# Create the asset directory without depending on mkdir.
rsync -a --exclude='*' "$SCRIPT_DIR/" "$DEST/streamline/"
rsync -a "$THEME_SOURCE" "$DEST/streamline/$theme_name"
rsync -a "$VIEW_SOURCE" "$DEST/streamline/$view_name"

# Jellyfin's index is minified. Strip each injection independently with a
# non-greedy, whole-file match so repeated injection cannot consume app markup.
perl -0pi -e 's/<!--streamline-head-start-->.*?<!--streamline-head-end-->//gs; s/<!--streamline-body-start-->.*?<!--streamline-body-end-->//gs' "$DEST/index.html"
sed -i '' \
    -e "s#</head>#<!--streamline-head-start--><link rel=\"stylesheet\" href=\"streamline/$view_name\"><!--streamline-head-end--></head>#" \
    -e "s#</body>#<!--streamline-body-start--><script defer src=\"streamline/$theme_name\"></script><!--streamline-body-end--></body>#" \
    "$DEST/index.html"

grep -F "<link rel=\"stylesheet\" href=\"streamline/$view_name\">" "$DEST/index.html" >/dev/null
grep -F "<script defer src=\"streamline/$theme_name\"></script>" "$DEST/index.html" >/dev/null

# Jellyfin registers this stable URL from main.jellyfin.bundle.js. Replace the
# bundled worker so an update evicts any app-shell caches left by this or older
# Jellyfin versions. Include a per-run hash so the browser always sees new
# worker bytes, even when the theme sources have not changed.
build_nonce="$(date -u +%Y%m%dT%H%M%S).$$.$RANDOM"
build_sum=$(printf '%s' "$build_nonce" | shasum -a 256)
build_hash=${build_sum%% *}
perl -0pi -e 's#<script defer="defer" src="serviceworker\.js(?:\?[^"<]*)?"></script>#<script defer="defer" src="serviceworker.js?'"$build_hash"'"></script>#' "$DEST/index.html"

apply_sw=$(mktemp "$DEST/.serviceworker.js.XXXXXX")
cat >"$apply_sw" <<EOF
// Streamline build: $build_hash
self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith((async () => {
        try {
            const request = event.request.mode === 'navigate'
                ? new Request(event.request, { cache: 'no-store' })
                : event.request;
            return await fetch(request);
        } catch (error) {
            const cached = await caches.match(event.request);
            if (cached) return cached;
            throw error;
        }
    })());
});
EOF
mv "$apply_sw" "$DEST/serviceworker.js"

grep -F "serviceworker.js?$build_hash" "$DEST/index.html" >/dev/null
grep -F "// Streamline build: $build_hash" "$DEST/serviceworker.js" >/dev/null

printf 'Built and verified Streamline webdir: %s\n' "$DEST"
printf 'Launch with:\n'
printf '"/Applications/Jellyfin.app/Contents/MacOS/jellyfin" --webdir "%s" --ffmpeg "/Applications/Jellyfin.app/Contents/MacOS/ffmpeg" --datadir "%s/Library/Application Support/jellyfin"\n' "$DEST" "$HOME"
