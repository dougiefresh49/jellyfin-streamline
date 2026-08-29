# Handoff: add WhisperX transcription status to the rip dashboard

For the agent running the WhisperX pipeline. The dashboard reads everything
from the filesystem — you should NOT need to change your worker; just teach
the dashboard to read the artifacts you already write.

## The dashboard you're patching

- `scripts/ripper/dashboard/status-server.mjs` — Node (built-ins ONLY, no npm
  deps), serves `/` and `/api/status` on 0.0.0.0:4242. Status is assembled
  per-request with a 2s cache; follow the existing helper patterns in there
  (safe fs reads that return null/[] on missing files, `ps -axo command` is
  already captured once — reuse it, don't exec again).
- `scripts/ripper/dashboard/index.html` — single static page, vanilla JS
  template-string rendering, inline CSS, dark theme, phone-width friendly,
  polls `/api/status` every 5s. No frameworks, no CDN assets.

Hard constraints (repo is PUBLIC): no hardcoded IPs/hostnames/tokens, no new
dependencies, no build step. Do not rename or remove any existing key in the
`/api/status` JSON — only add. Do not modify any file outside `dashboard/`.

## Source of truth on disk (all under `$HOME/Movies/library/voice-lab/`)

- Episode/movie dirs: `TMNT-2012/SxxEyy/` and `movies/<name>/`. Per dir:
  - `vocals.flac` present → Demucs finished (transcription is eligible)
  - `whisperx.json` present → transcription + alignment + diarization DONE
- `queue/whisperx-failed.txt` — one rel path per line (e.g. `TMNT-2012/S01E03`)
- `queue/whisperx.log` — worker log; last line ≈ current activity
- Worker process: a running transcription shows up in `ps` as
  `.venv-asr/bin/whisperx` (match on `whisperx`).

## Add to `/api/status`

```json
"transcription": {
  "running": true,
  "current": "last whisperx.log line, truncated to ~160 chars",
  "doneCount": 12,
  "eligibleCount": 80,     // dirs with vocals.flac
  "pendingCount": 68,      // eligible - done - failed
  "failedCount": 0,
  "failed": ["TMNT-2012/S01E03"],
  "done": ["TMNT-2012/S01E01"]   // rel paths, sorted
}
```

Counting rule: scan `TMNT-2012/*/` and `movies/*/` one level deep; a dir is
eligible iff `vocals.flac` exists, done iff `whisperx.json` also exists,
failed iff listed in whisperx-failed.txt (failed wins over pending, done wins
over failed). Missing files/dirs → zeros and empty arrays, never a crash.

## Add to the page

A "Transcription (WhisperX)" card directly below the existing "Voice lab
(Demucs)" card, same visual language: done/eligible progress bar,
pending/failed counts (failed in red, only when > 0, listing the rel paths),
running indicator + current-item line (truncate with ellipsis). When
`running` is false and pendingCount > 0, show a muted "worker not running"
hint. Keep it one card — this is a glance-from-phone board, not a report.

## Verify before handing back

1. `curl -s localhost:4242/api/status | python3 -m json.tool` — new block
   present, all pre-existing keys unchanged.
2. Page renders on a ~390px viewport with the new card, and still renders
   when voice-lab dirs are absent.
3. Restart recipe (the server may already be running):
   `pkill -f "dashboard/status-server.mjs"; cd <repo> && nohup node scripts/ripper/dashboard/status-server.mjs >/dev/null 2>&1 &`
