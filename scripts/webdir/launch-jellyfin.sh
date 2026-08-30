#!/bin/bash

set -euo pipefail

DEST=${DEST:-$HOME/Library/Application Support/jellyfin/streamline-web}
JELLYFIN=/Applications/Jellyfin.app/Contents/MacOS/jellyfin
FFMPEG=/Applications/Jellyfin.app/Contents/MacOS/ffmpeg
DATADIR="$HOME/Library/Application Support/jellyfin"
LOG="$HOME/Library/Logs/jellyfin-streamline.log"

if [[ ! -x "$JELLYFIN" ]]; then
    printf 'error: Jellyfin binary is missing or not executable: %s\n' "$JELLYFIN" >&2
    exit 1
fi
if [[ ! -x "$FFMPEG" ]]; then
    printf 'error: ffmpeg binary is missing or not executable: %s\n' "$FFMPEG" >&2
    exit 1
fi

if pgrep -f '/MacOS/jellyfin( |$)' >/dev/null; then
    printf 'Refusing to start: a MacOS/jellyfin process is already running.\n' >&2
    printf 'If you intend to replace it, stop it yourself first (for example: pkill -f '\''/MacOS/jellyfin'\'').\n' >&2
    exit 1
fi

if [[ ! -d "$DEST" || ! -f "$DEST/index.html" ]]; then
    printf 'error: webdir is not built: %s\nRun scripts/webdir/build-webdir.sh first.\n' "$DEST" >&2
    exit 1
fi
if ! grep -F 'streamline/theme.' "$DEST/index.html" >/dev/null ||
   ! grep -F 'streamline/view.' "$DEST/index.html" >/dev/null; then
    printf 'error: webdir index.html has no verified Streamline asset injection: %s\n' "$DEST/index.html" >&2
    printf 'Run scripts/webdir/build-webdir.sh first.\n' >&2
    exit 1
fi

mkdir -p "${LOG%/*}"
# Use this launcher or the Streamline LaunchAgent, never both at the same time.
printf 'Note: do not load the Streamline LaunchAgent while this launcher is in use.\n'
nohup "$JELLYFIN" \
    --webdir "$DEST" \
    --ffmpeg "$FFMPEG" \
    --datadir "$DATADIR" \
    >>"$LOG" 2>&1 </dev/null &

printf 'Started Jellyfin (PID %s); log: %s\n' "$!" "$LOG"
