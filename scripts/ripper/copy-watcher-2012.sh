#!/bin/bash
# Ships finished TMNT (2012) episodes from ready-to-copy/ to the Seagate,
# then extracts the dialogue-carrying audio to voice-lab (SSD) and queues
# the episode for Demucs. Safe to restart anytime; skips files still open.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/.env" 2>/dev/null || true
# Roots (override in the repo env file; defaults are the historical paths).
LOCAL_LIBRARY="${LOCAL_LIBRARY:-$HOME/Movies/library}"
MEDIA_ROOT="${RIPPER_MEDIA_ROOT:-/Volumes/Seagate 4TB/media}"
VOICE_LAB="${VOICE_LAB:-$LOCAL_LIBRARY/voice-lab}"

SHOW="Teenage Mutant Ninja Turtles (2012)"
READY="$LOCAL_LIBRARY/ready-to-copy/$SHOW"
DEST_ROOT="$MEDIA_ROOT/library/shows/$SHOW"
LAB_SHOW="$VOICE_LAB/TMNT-2012"
QUEUE="$VOICE_LAB/queue/pending.txt"
LOG="$LOCAL_LIBRARY/.ripper-2012/copy-watcher.log"

mkdir -p "$LAB_SHOW" "$(dirname "$QUEUE")" "$(dirname "$LOG")"
touch "$QUEUE"

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

slack() {
  [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_CHANNEL_ID:-}" ] || return 0
  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H 'Content-Type: application/json; charset=utf-8' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"channel": sys.argv[1], "text": sys.argv[2]}))' "$SLACK_CHANNEL_ID" "$1")" >/dev/null
}

extract_center() { # $1=mkv $2=out.flac
  local layout
  layout=$(ffprobe -v error -select_streams a:0 \
    -show_entries stream=channels,channel_layout -of csv=p=0 "$1")
  local channels="${layout%%,*}"
  if [ "${channels:-0}" -ge 6 ]; then
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "$1" -map 0:a:0 \
      -af "pan=mono|c0=FC" -c:a flac "$2"
  else
    # stereo/mono disc (extras or odd masters): mono downmix fallback
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "$1" -map 0:a:0 \
      -ac 1 -c:a flac "$2"
  fi
}

log "copy watcher started (ready=$READY)"

while true; do
  if [ ! -d "$MEDIA_ROOT" ]; then
    log "Seagate not mounted; sleeping"
    sleep 60
    continue
  fi

  # Collect paths BEFORE processing: rsync/ffmpeg/curl in the loop body would
  # otherwise eat the find stream off stdin and mangle subsequent paths.
  files=()
  while IFS= read -r -d '' f; do files+=("$f"); done \
    < <(find "$READY" -name '*.mkv' -type f -print0 2>/dev/null)

  found=0
  # ${files[@]+...} guard: bash 3.2 + set -u errors on expanding an empty array
  for f in ${files[@]+"${files[@]}"}; do
    found=1
    # skip files still being written/held
    if lsof -- "$f" >/dev/null 2>&1; then continue; fi
    rel="${f#"$READY"/}"                       # e.g. Season 01/Show S01E01 - Title.mkv
    code=$(basename "$f" | grep -oE 'S[0-9]{2}E[0-9]{2}' | head -1)
    if [ -z "$code" ]; then log "SKIP (no code): $f"; continue; fi

    dest="$DEST_ROOT/$rel"
    mkdir -p "$(dirname "$dest")"
    if ! rsync -t "$f" "$dest"; then
      log "rsync FAILED: $rel"; slack "🚨 copy watcher: rsync failed for $rel"; sleep 30; continue
    fi
    src_size=$(stat -f%z "$f"); dst_size=$(stat -f%z "$dest")
    if [ "$src_size" != "$dst_size" ]; then
      log "size mismatch: $rel ($src_size vs $dst_size)"; slack "🚨 copy watcher: size mismatch for $rel"; continue
    fi

    epdir="$LAB_SHOW/$code"
    mkdir -p "$epdir"
    if extract_center "$f" "$epdir/center.flac"; then
      grep -qx "TMNT-2012/$code" "$QUEUE" || echo "TMNT-2012/$code" >> "$QUEUE"
    else
      log "center extract FAILED: $code"; slack "⚠️ voice-lab: center extract failed for $code (video copied fine)"
    fi

    rm -f "$f"
    log "shipped $rel + center.flac"
  done

  [ "$found" = 0 ] && sleep 20 || sleep 5
done
