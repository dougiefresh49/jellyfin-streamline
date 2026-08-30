# TMNT 2003 two-drive ripping pipeline — spec v2

v2 after gpt + grok spec reviews (docs/reviews/ripper-*) and a live scan of the real
"TMNT vol 1" disc that invalidated v1's core title-selection assumption. Owner has
~20 TMNT (2003) DVD volumes, ~3 eps each. Goal: human does "swap disc, put box on
shelf, walk away"; Slack pings when a drive wants attention. Rips to Seagate 4TB.

## Empirical facts (verified live on this Mac — fixtures in scripts/ripper/fixtures/)

- **TMNT vol 1 disc layout (fixture `info-tmnt-vol1-disc0.txt`): there are NO
  per-episode titles.** Title 0 = 1:04:08, 13 chapters, 2.4GB — the play-all holding
  all 3 episodes. Titles 1–5 = 2–6 min DVD extras. v1's "keep [15,35]min titles"
  would select nothing. Episodes must come from **ripping the play-all and splitting
  it at chapter boundaries**. Upside: play-all order = broadcast order, which kills
  v1's risky `t##`-ordering assumption for these discs.
- Drive enumeration (fixture `drv-enumeration.txt`):
  `DRV:0,2,999,1,"DVD+R-DL Slimtype DVD A DS8A4S JL61 007080176998","TMNT vol 1","/dev/rdisk5"`
  — fields: index, visible, ?, mediaPresent, driveName(with serial-ish suffix),
  discLabel, osDevice. `info disc:9999` enumerates all drives cheaply (~2s, then
  "Failed to open disc" which is expected and harmless).
- `makemkvcon` v1.18.4. Usage: `info <source>`, `mkv <source> <titleId> <dest>`;
  sources `disc:<id>` and `dev:<DeviceName>`. Full `info disc:0` scan of a loaded
  DVD took ~2 min. Robot lines are quote-escaped CSV: `TINFO:tid,attr,code,"value"`
  (attr 8=chapters, 9=duration H:MM:SS, 10=size pretty, 27=output filename),
  `CINFO:2/30/32 = disc label`, `MSG:code,...`, `TCOUNT:n`.
- Camera `HD Pro Webcam C920` via `imagesnap` (installed): 1920×1080, not mirrored,
  both box backs fully legible in one frame. **BLUE dot sticker = LEFT shelf slot,
  RED dot = RIGHT slot** (config maps slot→drive).
- `mkvtoolnix` (mkvmerge) installed — lossless `--split chapters:...`.
- Node v26, ffprobe/ffmpeg present. HFS+ target (avoid `:` in names).
- `.env` (repo root): SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, SLACK_CHANNEL_NAME,
  GEMINI_API_KEY. Gemini via `@google/genai` (installed in scripts/ripper):
  `new GoogleGenAI({apiKey})`, `createPartFromBase64/Text`,
  `models.generateContent({model, contents, config})`, read `response.text`.
  OCR model `gemini-3.1-flash-lite` default, `GEMINI_OCR_MODEL` override; use
  `config: {responseMimeType: "application/json"}` (+ responseSchema) so the reply
  is machine JSON, then STILL validate strictly locally.
- Slack `chat.postMessage` bearer-token pattern (comic-reader `notifySlack`):
  best-effort, log-and-continue on failure.

## Review resolutions baked into v2 (both reviews agreed unless noted)

1. **Drive identity**: `disc:N` is an enumeration index, not stable. Config binds
   drive A/B to the `DRV` **driveName string** (contains serial suffix). Every
   makemkvcon operation re-enumerates first, resolves driveName → current index +
   osDevice, and fails closed on ambiguity. State stores driveName + osDevice, never
   a bare index. Eject targets the resolved osDevice (`drutil eject` matched by
   device, verify media actually gone afterwards).
2. **`--noscan` removed** — it means "don't enumerate at startup", not "reuse
   analysis". No flag claims survive into code without the acceptance test below.
3. **Concurrency is an acceptance test, not an assumption**: with a rip active on
   drive A, enumerate/inspect/rip drive B and verify A's PRGV keeps advancing. Until
   that passes on this Mac, `watch` serializes disc-opening (never runs `info`
   against any drive while another makemkvcon is in its opening/analyze phase, and
   never touches a drive that is mid-rip).
4. **Fail-closed naming**: OCR output is *metadata*, never *authority*. Rips always
   land in a folder keyed by disc label + timestamp (`vol-unknown-<label>-<ts>` if
   OCR invalid). A valid, schema-checked OCR result adds `episodes.md` + renames the
   folder to `vol<NN>-<slug>`. `finalize --apply` refuses any folder whose OCR is
   missing/unverified, whose episode count ≠ split count, or whose fuzzy matches are
   ambiguous/duplicated. Warn-only mismatch is gone: label-vs-OCR disagreement ⇒
   `NEEDS_ATTENTION` (rip still runs into the neutral folder; no success eject).
5. **State machine with failure states** (per drive):
   `EMPTY → SETTLING → IDENTIFYING → RIPPING → VERIFYING → SPLITTING → DONE_EJECTED`
   plus `FAILED_SEATED` (rip/verify failed — disc stays in, ❌ Slack, manual retry),
   `NEEDS_ATTENTION` (identity/OCR problems), `DRIVE_OFFLINE`. Eject happens ONLY on
   verified success, and the "swap me" Slack goes out only after eject is confirmed
   (media absent on re-enumerate). Startup reconciliation: compare state.json vs live
   enumeration + filesystem; `RIPPING` with no live child ⇒ `FAILED_SEATED` (same
   attempt dir kept); never re-OCR unless the disc label changed.
6. **Locks & atomicity**: single `watch` instance via lockfile (pid + start time);
   per-drive op lock shared by manual `rip`; `state.json` written via tmp+rename.
7. **Robot parsing**: real quote-aware CSV parser, dispatch on record type + numeric
   attr codes; control flow from exit status + structured codes, not message prose;
   fixtures committed and unit-tested against.
8. **Verification**: preflight free space (2× estimated size); after makemkvcon
   exits 0: confirm no process holds the file (lsof), `ffprobe -v error` stream
   check, container duration within ±2 min of TINFO. Split outputs: per-piece
   duration ≈ playall/N ±20%, sum of pieces ≈ play-all ±1 min. Failures ⇒
   `FAILED_SEATED`, keep partials in `attempt-N/`, never auto-delete.
9. **Camera/scan transaction**: one frame per scan event, stamped scan_id; a scan
   binds ONLY the requested slot — the other slot's data from the same frame is
   logged but never creates/updates folders (poisoning guard). Settle = disc
   detected + 8s + (optional, default on) second frame 3s later must OCR-match the
   first on {volume_number, volume_title}; disagreement ⇒ retry once ⇒
   `NEEDS_ATTENTION`.
10. **Human protocol invariant (document in README + Slack messages)**: put the new
    box in the drive's shelf slot BEFORE closing that drive's tray. When swapping
    both drives at once: place both boxes first, then close both trays.
11. **finalize ordering**: for chapter-split discs, episode order = play-all order
    (safe). For per-title discs (Courage-style layout, if any TMNT vol has one),
    order = t## and the plan output says so; `--apply` on those requires
    `--trust-title-order` ack flag. Plan always prints the full mapping table;
    destination-exists ⇒ hard fail; `missing>0` from rename_show ⇒ abort apply.
    Generated names come from the canonical list (safe charset; strip `|"$:` etc.).
12. **doctor full mode**: `doctor` = basic checks; `doctor --full` additionally OCRs
    the committed sample box photo with the configured model + validates schema,
    posts (and notes) a real Slack message, writes+deletes a test file on the
    Seagate, and runs `info disc:9999` enumeration.
13. Rejected as over-engineering for a 20-disc attended tool: QR/barcode binding,
    multi-point decode sampling, disc fingerprint database, Zod dependency
    (hand-rolled strict validator is fine).

## Rip strategy (replaces v1 title selection)

From the parsed TINFO table, classify:
- **playall-layout** (TMNT vol 1 pattern): exactly one title ≥ 45 min whose
  chapterCount ≥ episode count; everything else < 15 min.
  → Rip that one title. Read chapter timestamps from the ripped MKV (ffprobe
  `-show_chapters`). Group chapters into N contiguous groups (N = OCR episode count,
  else round(duration/22min)) minimizing squared deviation from equal duration
  (DP or greedy — N≤5, chapters≤20, trivial). Split losslessly:
  `mkvmerge -o ep.mkv --split chapters:c1,c2 playall.mkv` → `ep-01.mkv … ep-0N.mkv`.
- **per-title layout** (Courage pattern): ≥ 2 titles in [15,35] min.
  → Rip those individually (`mkv disc:N <id>`); if a title ≈ sum of the others ±10%
  also exists, skip it (that's the play-all).
- **anything else** ⇒ `NEEDS_ATTENTION` with the decision table in Slack/log.
- Extras (< 15 min titles): ripped AFTER episodes into `extras/` (config
  `RIP_EXTRAS=1` default on — owner keeps extras, see Batman Beyond/LOTR).
- Every rip records a `manifest.json` in the folder: disc label, driveName, scan_id,
  selected title ids + TINFO rows, expected outputs, per-file verify results,
  chapter grouping. `finalize` and resume both read this, not directory listings.

## Layout

```
scripts/ripper/
  package.json          # exists; type:module; @google/genai, dotenv
  ripper.mjs            # CLI: doctor | scan | rip | watch | finalize
  config.mjs            # slots↔drives, paths, thresholds, env overrides
  lib/robot.mjs         # quote-aware CSV parser for -r output (pure, fixture-tested)
  lib/makemkv.mjs       # enumerate/resolve drives, info, rip title (spawn + stream parse)
  lib/split.mjs         # chapter read (ffprobe), grouping, mkvmerge split, verify
  lib/camera.mjs        # imagesnap capture
  lib/ocr.mjs           # Gemini box scan + strict schema validation
  lib/slack.mjs         # notify(text) best-effort
  lib/state.mjs         # state.json (atomic), locks, runlog.jsonl
  lib/finalize.mjs      # canonical-list fuzzy match → rename map + gates
  data/tmnt-2003-episodes.txt   # exists (S1–S5, 116 eps, Part-suffixed)
  fixtures/             # exists: info-tmnt-vol1-disc0.txt, drv-enumeration.txt
  test/                 # node:test units for robot.mjs, split grouping, finalize gates
```

Staging: `/Volumes/Seagate 4TB/media/_staging/shows/Teenage Mutant Ninja Turtles (2003)/`
State: `/Volumes/Seagate 4TB/media/_staging/.ripper/` (state.json, runlog.jsonl, scans/).

## Module interfaces (pinned so two agents can implement independently)

```js
// lib/robot.mjs  (pure functions, no I/O)
parseRobotLine(line) -> {type:'DRV'|'TINFO'|'CINFO'|'MSG'|'PRGV'|'TCOUNT', fields:[...]}
parseInfoOutput(text) -> {drives:[{index,mediaPresent,driveName,discLabel,osDevice}],
                          discLabel, titles:[{id,chapters,duration_s,sizeStr,outName}]}

// lib/makemkv.mjs
enumerateDrives() -> Promise<drives[]>                    // info disc:9999
resolveDrive(driveNamePrefix) -> Promise<{index,osDevice,discLabel,mediaPresent}> // throws if ambiguous
scanDisc(index) -> Promise<{discLabel, titles[]}>          // info disc:<index>, ~2min
ripTitle({index, titleId, destDir, onProgress}) -> Promise<{outFile}> // spawn, parse stream, exit code
classifyTitles(titles, expectedEps) -> {mode:'playall'|'per-title'|'unknown',
                                        episodeTitleIds:[], playallId, extraIds:[]}
eject(osDevice) -> Promise<void>                           // verify media gone after

// lib/split.mjs
readChapters(mkvPath) -> Promise<[{start_s,end_s}]>        // ffprobe -show_chapters
groupChapters(chapters, n) -> [[chapterIdx,...] x n]       // contiguous, ~equal duration
splitAtChapters(mkvPath, groups, destDir, baseName) -> Promise<[files]>  // mkvmerge
verifyRip(file, expected_s) -> Promise<{ok, duration_s, reason?}>

// lib/ocr.mjs
scanBoxes(imagePath, requestedSlots) -> Promise<{scanId, results:[{slot,'blue'|'red',
  series, volume_number:int, volume_title, episodes:[string], confidence}], raw}>
// throws OcrInvalid on schema failure after 1 retry; caller treats as no-OCR

// lib/state.mjs
loadState()/saveState(mutfn)  // atomic tmp+rename
acquireWatchLock()/acquireDriveLock(drive)
logEvent(obj)                 // runlog.jsonl append
```

CLI contracts: `scan [--slot blue|red|both]`, `rip --drive A|B [--expect-eps N]
[--no-extras]`, `watch`, `finalize [--apply] [--trust-title-order]`, `doctor
[--full]`. All commands `--dry-run`-able except doctor.

## watch loop (single process, two async drive workers + shared scan mutex)

Poll: enumerateDrives() every 10s **only when no makemkvcon child is in its opening
phase** (during a rip's write phase polling is allowed but uses cached enumeration;
never `info` a busy drive). Rising edge of mediaPresent on a mapped drive ⇒ SETTLING
⇒ scan (that slot only) ⇒ IDENTIFYING ⇒ rip ⇒ verify ⇒ split ⇒ eject ⇒ Slack ⇒
EMPTY. Failures per §Review-resolutions 5. Slack on: success (with per-ep minutes +
folder), FAILED_SEATED, NEEDS_ATTENTION, watch start/stop, staging volume
unmounted (pause everything).

## finalize

Reads every vol folder's manifest.json + episodes.md. Volumes are sequential 3-ep
blocks (vol1 = S01E01–03 confirmed from the vol 1 box back), but mapping is by
NAME match against data/tmnt-2003-episodes.txt (normalized: lowercase, strip
punctuation/", Part N"). Gates per §Review-resolutions 4/11. Output: rename_show.sh
map + undo path, target
`library/shows/Teenage Mutant Ninja Turtles (2003)/Season 01/Teenage Mutant Ninja
Turtles (2003) S01E04 - Meet Casey Jones.mkv`.

## Test plan (owner back with 2nd drive)
1. `doctor --full`.
2. `scan --slot both` with the two boxes already on the shelf.
3. `rip --drive A` on the loaded TMNT vol 1 → expect playall rip → 3 split eps
   (~21.4 min each) + 5 extras → Slack → eject.
4. Concurrency acceptance test (§3) while B rips its first disc.
5. `watch` for the rest of the stack; deliberate wrong-box test once.
6. `finalize` plan over 2–3 vols → spot-check one episode start/end in QuickTime →
   `finalize --apply`.

## Implementation split (agents)
- **gpt/codex — "disc side"**: robot.mjs, makemkv.mjs, split.mjs + their tests
  against fixtures. No camera/network code.
- **grok/cursor — "world side"**: config.mjs, camera.mjs, ocr.mjs, slack.mjs,
  state.mjs, finalize.mjs, ripper.mjs CLI + watch loop, calling the disc-side
  interfaces exactly as pinned above. May stub disc-side with fixtures.
- Claude reviews both, integrates, runs unit tests; live test with owner.
