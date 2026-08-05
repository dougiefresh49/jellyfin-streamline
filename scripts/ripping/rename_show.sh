#!/bin/bash
# Generic Jellyfin renamer.
# Usage: rename_show.sh <root-dir> <mapfile> <undo-file> [plan|apply]
# mapfile lines: <source-basename>|<target-relpath>
set -euo pipefail

ROOT="$1"; MAPFILE="$2"; UNDO="$3"; MODE="${4:-plan}"
cd "$ROOT"

if [ "$MODE" = "apply" ]; then
  printf '#!/bin/bash\nset -euo pipefail\ncd "%s"\n' "$ROOT" > "$UNDO"
fi

count=0; missing=0
while IFS='|' read -r src dst; do
  [ -z "$src" ] && continue
  if [ ! -f "$src" ]; then
    echo "MISSING SOURCE: $src"; missing=$((missing+1)); continue
  fi
  count=$((count+1))
  destdir=$(dirname "$dst")
  if [ "$MODE" = "apply" ]; then
    mkdir -p "$destdir"
    mv "$src" "$dst"
    printf 'mv "%s" "%s"\n' "$dst" "$src" >> "$UNDO"
  else
    printf '  %-46s ->  %s\n' "$src" "$dst"
  fi
done < "$MAPFILE"

echo ""
echo "moves: $count   missing: $missing"
[ "$MODE" = "apply" ] && chmod +x "$UNDO" && echo "undo: $UNDO"
exit 0
