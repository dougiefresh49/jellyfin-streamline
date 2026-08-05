#!/bin/bash
# Push a built .wgt to the TV over the network. No thumb drive: sdb connects to
# the TV's IP on port 26101, so every reinstall is over-the-air from this Mac.
#
#   scripts/tizen/install-tizen.sh 192.168.86.50
#
# The TV must be in Developer Mode with this Mac's IP set as the host, and on
# the same network. See docs/tizen.md.
set -euo pipefail

TV_IP="${1:-${TIZEN_TV_IP:-}}"
[ -n "$TV_IP" ] || { echo "usage: $0 <tv-ip>" >&2; exit 1; }

WORKDIR="${WORKDIR:-$HOME/.cache/jellyfin-tizen}"
WGT="${WGT:-$(find "$WORKDIR/.buildResult" -name "*.wgt" 2>/dev/null | head -1)}"
[ -n "$WGT" ] && [ -f "$WGT" ] || { echo "error: no .wgt found -- run build-tizen.sh first" >&2; exit 1; }

command -v sdb >/dev/null || { echo "error: sdb not found (Tizen Studio tools/ not on PATH)" >&2; exit 1; }

echo "connecting to $TV_IP"
sdb connect "$TV_IP:26101"

# Name the target explicitly: sdb happily lists a stale device and installs nowhere.
TARGET="$(sdb devices | awk -v ip="$TV_IP" '$0 ~ ip { print $NF; exit }')"
[ -n "$TARGET" ] || { echo "error: TV did not appear in 'sdb devices' -- is Developer Mode on, with this Mac's IP as host?" >&2; exit 1; }

echo "installing $(basename "$WGT") to $TARGET"
tizen install -n "$WGT" -t "$TARGET"

echo
echo "installed. Launch Jellyfin on the TV; the theme is inside the package."
echo "After a theme change: scripts/webdir/build-webdir.sh && scripts/tizen/build-tizen.sh && $0 $TV_IP"
