#!/bin/bash
# Ships finished MMPR episodes from ready-to-copy/ to the Seagate, then
# extracts audio for voice-lab and queues the episode for Demucs.
# MMPR discs are stereo (no 5.1 center): Demucs was trained on stereo mixes,
# so we feed it the untouched stereo track — better separation than a mono
# downmix, and if a disc surprises us with 5.1 we still take the center.
# Safe to restart anytime; skips files still open.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/.env" 2>/dev/null || true
# Roots (override in the repo env file; defaults are the historical paths).
LOCAL_LIBRARY="${LOCAL_LIBRARY:-$HOME/Movies/library}"
MEDIA_ROOT="${RIPPER_MEDIA_ROOT:-/Volumes/Seagate 4TB/media}"
VOICE_LAB="${VOICE_LAB:-$LOCAL_LIBRARY/voice-lab}"

SHOW="Mighty Morphin Power Rangers (1993)"
READY="$LOCAL_LIBRARY/ready-to-copy/$SHOW"
DEST_ROOT="$MEDIA_ROOT/library/shows/$SHOW"
LAB_SHOW="$VOICE_LAB/MMPR-1993"
QUEUE="$VOICE_LAB/queue/pending.txt"
LOG="$LOCAL_LIBRARY/.ripper-mmpr/copy-watcher.log"

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

extract_dialogue() { # $1=mkv $2=out.flac
  local layout
  layout=$(ffprobe -v error -select_streams a:0 \
    -show_entries stream=channels,channel_layout -of csv=p=0 "$1")
  local channels="${layout%%,*}"
  if [ "${channels:-0}" -ge 6 ]; then
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "$1" -map 0:a:0 \
      -af "pan=mono|c0=FC" -c:a flac "$2"
  else
    # stereo source: keep both channels for Demucs
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "$1" -map 0:a:0 \
      -c:a flac "$2"
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
    if lsof -- "$f" >/dev/null 2>&1; then continue; fi
    rel="${f#"$READY"/}"
    code=$(basename "$f" | grep -oE 'S[0-9]{2}E[0-9]{2}' | head -1)
    if [ -z "$code" ]; then log "SKIP (no code): $f"; continue; fi

    dest="$DEST_ROOT/$rel"
    mkdir -p "$(dirname "$dest")"
    if ! rsync -t "$f" "$dest"; then
      log "rsync FAILED: $rel"; slack "🚨 mmpr copy watcher: rsync failed for $rel"; sleep 30; continue
    fi
    src_size=$(stat -f%z "$f"); dst_size=$(stat -f%z "$dest")
    if [ "$src_size" != "$dst_size" ]; then
      log "size mismatch: $rel ($src_size vs $dst_size)"; slack "🚨 mmpr copy watcher: size mismatch for $rel"; continue
    fi

    epdir="$LAB_SHOW/$code"
    mkdir -p "$epdir"
    if extract_dialogue "$f" "$epdir/center.flac"; then
      grep -qx "MMPR-1993/$code" "$QUEUE" || echo "MMPR-1993/$code" >> "$QUEUE"
    else
      log "audio extract FAILED: $code"; slack "⚠️ voice-lab: audio extract failed for $code (video copied fine)"
    fi

    rm -f "$f"
    log "shipped $rel + audio"
  done

  [ "$found" = 0 ] && sleep 20 || sleep 5
done
