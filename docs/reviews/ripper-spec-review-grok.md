## Findings (prioritized)

### 1. CRITICAL — `disc:N` treated as stable Drive A/B identity
**Section:** Verified facts; `rip` §1; `lib/drives`; Open Q1  
**Failure mode:** After eject/USB sleep/replug, MakeMKV’s drive list order can change. Cached `A→disc:0` then rips the wrong drive (or fails). Dual-drive makes this likely.  
**Fix:** Re-parse `DRV:` on every `info`/`mkv` invocation; bind A/B by stable fields (device name / path string in `DRV`), never by a sticky ordinal. Fail closed if the binding is ambiguous.

### 2. CRITICAL — `--noscan` on a fresh `mkv` process is wrong / harmful
**Section:** `rip` §4; Open Q2  
**Failure mode:** `--noscan` means “don’t scan for devices at start,” not “reuse prior title analysis.” Across separate processes, `info` cache is not shared. With `--noscan`, `disc:N` may be missing/stale → empty drive list or wrong target. Spec also implies it saves re-analysis; it does not.  
**Fix:** Drop `--noscan` for physical `disc:N` rips. Expect a full open/analyze per `makemkvcon` process. Prefer one `mkv disc:N all` (or one invocation) + post-filter over N per-title processes.

### 3. CRITICAL — Box↔disc binding race (box after disc / dual swap)
**Section:** `watch`; human loop; Open Q5  
**Failure mode:** Settle is time-based (8s), not “box present + stable.” Owner inserts disc(s) first; scan fires on old/empty shelf → folder named for wrong volume; rip proceeds; Slack mismatch is only a warning (`rip` §6). Dual swap while away: both `DISC_DETECTED` → serialized scans can still bind if boxes are late or mid-swap. Protocol text does not enforce box-before-scan.  
**Fix:** Gate `SCANNED` on: OCR confidence for that slot ≥ threshold **and** disc volume label from MakeMKV captured and stored with the scan. On rip start, re-read label; mismatch → re-scan, do not rip into the old folder. Optionally require both slots’ boxes visible when both drives are in `DISC_DETECTED`.

### 4. CRITICAL — `t##` order ≠ box episode order → silent mass mis-name at finalize
**Section:** `finalize`; `rename_show.sh` context in `docs/media-server-notes.md`  
**Failure mode:** Finalize assumes `title_tNN` ascending = box order. MakeMKV title IDs follow IFO/playlist order, which often ≠ printed box order. Fuzzy title match then attaches wrong `SxxExx` to the wrong file (or leaves unmatched).  
**Fix:** At rip time, record ordered OCR episode list in `episodes.md` and map by **matched title string** (or manual confirm), not by `t##`. If matching fails, do not `--apply`. Add a finalize check: N files vs N OCR titles vs N canonical matches.

### 5. HIGH — Resume “expected files” vs title-selection mismatch loops or false-done
**Section:** `watch` resume; `rip` title selection; Error philosophy  
**Failure mode:** “All expected files = done” is undefined. OCR may say 3 eps; duration filter keeps 2 (or 4). Crash mid-rip → endless `attempt-N/`, or 2/3 files marked done and the missing ep never retried.  
**Fix:** Persist the **selected title ID table** (ids, durations, output names) at rip start. Done = those outputs exist and pass ffprobe. Selection yielding 0 or ≠ OCR count → Slack and stay `DISC_DETECTED`/`FAILED`, do not eject as success.

### 6. HIGH — Eject-on-failure / verify-failure strands or loses the disc chance
**Section:** `rip` §5–7; Error philosophy  
**Failure mode:** Spec doesn’t say whether failed verify or `MSG` error still ejects. Eject-after-fail → human swaps, bad/partial files left in staging, hard to retry. No-eject-after-success-path confusion leaves watch stuck in `RIPPING`/`DONE` with media still loaded → re-detect loops.  
**Fix:** Eject only on verified success. On failure: leave disc seated, state `FAILED`, Slack ❌, require explicit retry/skip. Distinguish `DONE(ejected)` from `FAILED(seated)`.

### 7. HIGH — `ffprobe` too early / mid-write false failure
**Section:** `rip` §5; `docs/media-server-notes.md` (“0-min while makemkvcon running”)  
**Failure mode:** Verify runs while file still open or before FS flush → 0-min / tiny size → false ❌, possible eject or re-attempt spam.  
**Fix:** Wait for `makemkvcon` exit, confirm outputs not open (`lsof`), then ffprobe. Retry verify once after short delay before failing the drive.

### 8. HIGH — Naive robot-line splitting will break on real discs
**Section:** `rip` §2–4; Open Q3  
**Failure mode:** `MSG`/`TINFO`/`CINFO` are quote-escaped CSV. Titles with commas/apostrophes, and multi-arg `MSG` lines, break `split(',')` → wrong durations, wrong title ids, missed errors, silent bad selection.  
**Fix:** Proper CSV parse (respect quotes). Key fields: `TINFO:id,9,…,"H:MM:SS"` duration; size code (bytes, not the pretty `"1.2 GB"` string); `CINFO` for disc name; `DRV:` for presence/label; treat non-zero fatal `MSG` codes as hard fail.

### 9. HIGH — OCR JSON contract is underspecified → wrong folders / extras ripped later via bad lists
**Section:** `scan` §2–4; Open Q4  
**Failure modes:**
- Response is object not array; slots `"left"`/`"right"`; `volume_number` as `"[2]"` / string; episodes include “DVD EXTRAS” titles; truncated JSON; always-high confidence.
- Low confidence still creates dirs and **never blocks rip** → wrong slug folders; finalize fuzzy-matches garbage titles to wrong canonical eps.  
**Fix:** Strict schema (Zod): array length ≤2, `slot` enum, `volume_number` int 1–99, `episodes` 1–6 strings, strip EXTRAS. On parse/schema fail: one retry with stronger model; then name from disc label only and Slack ⚠️; do not invent episode lists for finalize.

### 10. HIGH — Cross-check is warn-only while rip already writes into OCR folder
**Section:** `rip` §6; Error philosophy  
**Failure mode:** Wrong box on wrong slot → files land in `volNN-wrong-title/`; Slack ⚠️ easy to miss; finalize names from that folder’s `episodes.md`.  
**Fix:** Mismatch = hard stop before rip (or rip into `mismatch-<discLabel>-<ts>/` only). Do not treat as success for watch progression.

### 11. MEDIUM — `drutil` as primary presence poll is unreliable for USB DVD on macOS
**Section:** `watch`; Open Q1; Verified “drutil present”  
**Failure mode:** Many USB burners are invisible or flaky in `drutil`; `-drive` index ≠ `disc:N`; status lags insert/eject; false EMPTY↔DISC flaps → double scan/rip or missed discs.  
**Fix:** Prefer MakeMKV `DRV:` for the mapped device when that drive is not mid-rip; optional secondary: optical `/Volumes/*` appear/disappear. Never `info` the drive currently in `RIPPING`. `drutil eject` only after resolving the same device identity used for rip. `--directio` is unrelated to cross-drive collision.

### 12. MEDIUM — Per-title rip cost claim underspecified; `all` tradeoff mis-framed
**Section:** `rip` §4; Open Q2  
**Failure mode:** Each title = new process ≈ full re-analyze (often tens of seconds each, sometimes more on slow USB). Three titles ≈ 3× analyze + 3× rip. Spec “leans per-title” without budgeting wall-clock; human “walk away” still fine, but dual-drive throughput suffers. `all` + delete play-all is usually faster and still clean if delete is size/duration-based.  
**Fix:** Benchmark one disc both ways. Default to `mkv … all --minlength=900`, delete play-all via the same sum heuristic, keep individuals. Only use per-id if `all` pulls unwanted long titles.

### 13. MEDIUM — Concurrent `makemkvcon` fact overstated / incomplete
**Section:** Verified facts “two simultaneous instances… supported”; Open Q1  
**Failure mode:** Two instances on **different** drives is generally OK. `info`/`mkv` on the **same** `disc:N` concurrent with an active rip is not. Watch polling via `makemkvcon info` without per-drive locking can hit the ripping drive. Shared USB bandwidth / bus power still fails rips (see Batman vs TMNT I/O notes) even when software “supports” parallel.  
**Fix:** Mutex `makemkvcon` per drive; global USB niceness optional. Poll only idle drives. Document thermal/power as operational constraint.

### 14. MEDIUM — Play-all / duration heuristics can drop real eps or keep extras
**Section:** `rip` §3  
**Failure mode:** ±10% sum heuristic fails with 2-ep discs, play-all that includes extras, or ep lengths outside [15,35]. Extras ≥15 min survive; short “real” content dropped. Expect “~3 survivors” becomes 0–5 without a hard stop.  
**Fix:** Prefer intersection with OCR episode **count**; if selected ≠ OCR count, Slack and pause. Log full table (already specified) and require count match for auto-eject success.

### 15. MEDIUM — Scan mutex + “scan only this slot” still photographs both; stale other slot
**Section:** `watch`; `scan`  
**Failure mode:** While A rips, owner pre-stages B’s next box; later B’s disc triggers scan — OK. Inverse: A scans while B’s shelf is empty/wrong; if implementation writes both slots from one Gemini response, B’s staging folder gets poisoned early. Spec says only process requested slot — implementers may still “helpfully” write both.  
**Fix:** Spec must say: ignore non-requested slots entirely; never create/update the other slot’s folder from an opportunistic parse.

### 16. MEDIUM — Cold start / crash with media already loaded### 16. MEDIUM — Cold start / crash with media already loaded
**Section:** `watch` resume  
**Failure mode:** Restart with disc seated and partial `attempt-1/` → re-detect as new disc, re-scan (wrong box if already swapped), second rip folder; or mark done from incomplete files. Tray may still be closed after crash without eject.  
**Fix:** On startup, reconcile `state.json` with live `DRV:` + filesystem: `RIPPING` with incomplete outputs → `FAILED`/retry same attempt dir; never re-OCR unless disc label changed.

### 17. MEDIUM — `finalize` / `rename_show.sh` path and basename pitfalls
**Section:** `finalize`; `scripts/ripping/rename_show.sh`  
**Failure mode:** Map uses basenames relative to `ROOT`; if finalize emits staging-relative paths that don’t match cwd layout, `MISSING SOURCE` and silent skips (`exit 0` even with missings). Duplicate episode titles across volumes → fuzzy collide. Season `0S` typo risk in the example path (`S0SE0E`).  
**Fix:** Emit absolute-or-root-relative paths that match rename_show’s `cd "$ROOT"` contract; fail `--apply` if `missing > 0`; include volume number in matching; fix example to `SxxExx`.

### 18. LOW — Camera serialization vs dual insert timing
**Section:** `watch` (OCR mutex)  
**Failure mode:** Both drives settle nearly together; second scan waits behind first OCR+Gemini. Disc may spin down / mount change; settle timer already fired → rip on stale assumption.  
**Fix:** Re-validate disc still present + re-read label immediately before rip; if wait > N seconds, re-settle.

### 19. LOW — Staging on external volume / sleep
**Section:** Layout; Error philosophy  
**Failure mode:** Seagate disconnect or Mac sleep mid-rip → stranded partial MKVs, watch may think EMPTY or crash-loop.  
**Fix:** `doctor` + watch heartbeat: staging mount must exist; on unmount → pause all drives, Slack, no eject.

---

## Open questions (answers from knowledge)

| # | Spec question | Answer |
|---|---------------|--------|
| 1 | Cheap disc-presence poll; collision with other rip; `--directio`? | Prefer **MakeMKV `DRV:` for the idle drive only**, or volume-mount events. `drutil` is fine as a secondary signal for Apple/native optical, weak for many USB enclosures. Do **not** run `makemkvcon info` against a drive mid-`mkv`. `--directio` is I/O mode, not a concurrency/safety switch. |
| 2 | Per-title re-analysis vs `all`? | Per-title **does** pay analyze cost again per process; `--noscan` doesn’t remove it. For ~3 eps, **`all` + minlength + delete play-all** is usually better wall-clock; per-title mainly for control, not speed. |
| 3 | Robot parsing pitfalls? | Real: quote-aware CSV; duration in `TINFO` code 9; don’t parse human size strings for logic; `MSG` codes matter more than text. Apostrophes inside quotes are fine if CSV-parsed. |
| 4 | Flash-lite vs flash for OCR? | Structured JSON from cluttered box art is where lite models drop slots/extras. Spec’s fallback env is right; treat schema-invalid as model failure, not “low confidence folder.” |
| 5 | Dual eject / dual swap mis-pair? | **Yes, the current SM can mis-pair** if scan isn’t gated on (box OCR + disc label) binding and mismatch isn’t a hard stop. Time-based settle alone is insufficient when the owner swaps both while away. |

---

## Strand / mis-name checklist (highest leverage)

1. Sticky `disc:N` → rip wrong drive.  
2. `--noscan` / per-process assumptions → empty/wrong rip or wasted retries.  
3. Scan before box stable → wrong `volNN` folder; warn-only mismatch → finalize trusts bad `episodes.md`.  
4. `t##` order assumption → wrong `SxxExx` names.  
5. Selection count ≠ OCR count but still “done” + eject.  
6. Verify on mid-write files → false fail / orphan folders.  
7. Failed rip + eject + human swap → unrecoverable without re-inserting the same disc.

I’m in Ask mode so this is review-only; switch to Agent mode if you want these folded into the spec as an errata section.
