# Ripper v3 — portable DVD box-set ripping pipeline

**Status:** spec only (no code). Author: grok. Date: 2026-07-20.  
**Supersedes for design purposes:** `specs/ripper-pipeline.md` (v2, TMNT-hardcoded).  
**Requirements source of truth:** `docs/media-server-notes.md` § RIPPER STATE 2026-07-20 + § DVD ripping, plus live failures in that log. Reviews: `docs/reviews/ripper-*`.

---

## 1. Goals

1. **Portable.** A stranger (or the owner's friend) can install tools, run `setup`, and rip *their* shows on *their* machine with 1–N DVD drives and no code edits.
2. **Show-agnostic.** Series name, season/volume identity, and episode lists come from box/pamphlet scan + external confirmation — never from hardcoded `SHOW_NAME` or a per-show `.txt` baked into the repo.
3. **Project-aware.** A run can span an entire box set across many discs and sessions, with resumable progress and a `status` view of what is done vs missing.
4. **Layout-correct.** Explicit disc-layout classification that matches the owner's proven manual method: prefer individual episode titles when present; only chapter-split a play-all when that is the only episode source; verify selected title count against the box before ripping.
5. **Recoverable.** Every in-progress state has a timeout; hung tools and scratched discs become `MARGINAL` / `FAILED_SEATED`, not silent deadlocks; verify never races MakeMKV's open file handle.
6. **Optional cloud.** Gemini and Slack are optional. The pipeline must rip, classify, and stage fully offline (manual identify / `--expect-eps` / pasted episode list).

## 2. Non-goals

- Blu-ray / UHD / encrypted AACS beyond what MakeMKV already handles.
- Automatic library import into Jellyfin (finalize still stages + renames; Jellyfin refresh is operator's job).
- QR/barcode shelf binding, multi-camera, or a disc fingerprint DB (rejected in v2 as overkill; still rejected).
- Guaranteeing perfect episode *content* identity without human spot-check (names can be wrong in rare OCR/TMDB misses; finalize stays fail-closed).
- Windows support in v3 (document later; macOS-first, Linux noted).
- Replacing MakeMKV / mkvtoolnix (we wrap them).

---

## 3. Design judgments (opinionated, one-line why)

| Decision | Choice | Why |
|----------|--------|-----|
| User config path | `~/.config/ripper/config.json` + `~/.config/ripper/secrets.env` | Survives repo clones; friend installs once; secrets stay out of the project tree. |
| Config format | JSON (config) + dotenv (secrets) | Hand-editable; matches existing Gemini/Slack env pattern; no YAML parser dependency. |
| Drive IDs | Stable string ids (`drive-1`, …) assigned at setup, not A/B | N drives without renaming the world when adding a third. |
| 1-drive scan UX | No shelf slots — "present the box" handheld scan | Shelf slots only make sense when camera sees multiple fixed positions. |
| Show authority | Scan proposes → TMDB (or local override) confirms → project locks show | OCR alone burned us on volume numbering and volume titles vs episode titles. |
| Hybrid discs | Prefer individual [epMin, epMax] titles; drop 1–2 largest play-alls; require count == box | Owner's manual method that always worked; v2 playall-first is wrong for Courage/Batman Beyond. |
| Project state | Per-project dir under staging + `project.json` | Survives watch restarts; `status` is a file read, not a live drive poll. |
| Setup overwrite | Never silent; write `config.json.new` or require `--replace` after backup | Friend re-running setup must not nuke a working multi-drive map. |

---

## 4. Proposed CLI surface

Binary entry (keep): `node ripper.mjs <command> …` (or a future `ripper` bin). Global flags on all commands unless noted:

| Flag | Effect |
|------|--------|
| `--dry-run` | Log planned actions; no rip/eject/write of media (setup may still write config when explicitly confirmed). |
| `--config <path>` | Override user config path. |
| `--project <id\|path>` | Bind to a project (required for `watch`/`status`/`finalize` when multiple projects exist). |
| `--json` | Machine-readable stdout for `status`/`doctor`/`identify`. |

### 4.1 `setup` — first-run wizard (re-runnable)

```
ripper setup [--non-interactive] [--replace] [--config <path>]
```

**Behavior:**

1. Detect tools on `PATH` (and well-known macOS MakeMKV path): `makemkvcon`, `ffmpeg`, `ffprobe`, `mkvmerge`, `imagesnap` (macOS). Record resolved absolute paths into config (so code never hardcodes `/Applications/...` or Seagate).
2. Enumerate DVD drives via `makemkvcon -r info disc:9999`. Present list; ask user to map each physical drive they will use (1–N). Store **full `driveName` string** (serial suffix) + optional friendly label.
3. Detect cameras via `imagesnap -l` (macOS). Ask which device; test one frame to a temp file.
4. Ask rip/staging root and library root (suggest existing mounts under `/Volumes/*` / `$HOME/Movies`). Create dirs if missing.
5. Ask whether shelf slots are used:
   - **0 / handheld** (default when `drives.length === 1`): no slots.
   - **N slots**: for each drive, optional `slotLabel` (sticker color/name) + brief position note for the OCR prompt.
6. Prompt for optional `GEMINI_API_KEY` and optional Slack (`SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`). Verify with a cheap call / `auth.test` when provided; skip when declined.
7. Write config. **If `config.json` exists and `--replace` not set:** print diff summary, write proposed file to `config.json.new`, exit 2 with instructions. With `--replace`: copy existing → `config.json.bak.<iso8601>` then write.
8. Print `doctor` summary and next-step: `ripper project new`.

`--non-interactive` requires all values via env/`--config` template; fails closed on missing required fields.

### 4.2 `doctor`

```
ripper doctor [--full]
```

Basic: tools exist at configured paths, staging/library mounts exist, drives resolve uniquely, config schema valid, camera device listed, lockfiles not stale.  
`--full`: capture one camera frame; if Gemini configured, OCR sample/fixture or live frame + schema validate; if Slack configured, post+note a test message; write+delete a probe file on staging; run drive enumeration.

Gemini/Slack missing ⇒ **warn**, not fail (optional).

### 4.3 `project`

```
ripper project new [--title <str>] [--tmdb-id <id>] [--from-scan]
ripper project list
ripper project use <id>          # sets "current" pointer in state dir
ripper project show [id]
```

`new --from-scan`: run identify flow once (handheld or slot), confirm TMDB match, create project locked to that show + full episode catalog.

### 4.4 `identify` / `scan`

```
ripper identify [--drive <id>] [--slot <label>] [--handheld]
                [--image <path>] [--no-tmdb] [--confirm]
ripper scan    # alias when shelf mode: same as identify with slot binding
```

- **Handheld / 1-drive:** capture (or `--image`) of the box the human is holding; no slot field in Gemini contract.
- **Shelf / multi-drive:** capture full shelf; bind only the requested slot (poisoning guard from v2 retained).
- Prints proposed identity + TMDB candidates; `--confirm` writes into the active project's pending disc record.

### 4.5 `rip`

```
ripper rip --drive <id>
           [--expect-eps N]
           [--layout individual|playall|auto]
           [--no-extras]
           [--force-neutral]   # skip identity naming; always vol-unknown-*
           [--trust-layout]    # ack when classifier flagged but count forced
```

Manual single-disc path. Uses project identity if bound; otherwise identify or neutral folder.

### 4.6 `watch`

```
ripper watch [--drives <id,id,...>] [--project <id>]
```

One process, N async drive workers + shared scan mutex + shared camera lock. Same human protocol as v2 when slots exist; handheld mode prompts via Slack/console: "hold box to camera, press Enter / send ack" is **out of scope for unattended watch** — judgment: **watch requires shelf mode OR pre-identified queue**. For 1-drive attended use, prefer `rip` after `identify`.

### 4.7 `status`

```
ripper status [--project <id>] [--verbose]
```

Example output:

```
Project: Teenage Mutant Ninja Turtles (2003)  [tmdb:123]
Staging: …/_staging/shows/Teenage Mutant Ninja Turtles (2003)/
S1: 26/26
S2: 17/26 — missing E18–E26
S3:  0/26 — not started
Discs: 12 done, 1 failed (vol13 cracked), 1 parked (vol14), 1 seated FAILED (s3v3)
Drives: drive-1 EMPTY | drive-2 FAILED_SEATED (TMNT_s3v3) since 03:12 — timeout overdue
```

### 4.8 `finalize`

```
ripper finalize [--apply] [--trust-title-order] [--volume <id>]
```

Same fail-closed gates as v2 (no unverified OCR, count match, no ambiguous fuzzy). Maps against **project canonical episode list**, not a repo `tmnt-2003-episodes.txt`.

### 4.9 Recovery / ops

```
ripper reset-drive <id> [--to EMPTY]     # clear stranded state after removing disc
ripper retry --drive <id>               # FAILED_SEATED → rip again same attempt policy
ripper park --drive <id>                # move attempt to parked/, eject optional
ripper resplit --folder <path> [--expect-eps N]   # fix bad chapter groups without re-rip
ripper unlock [--watch] [--drive <id>]  # clear stale locks
```

### 4.10 Help

```
ripper help [command]
```

---

## 5. Config schema

**Path:** `~/.config/ripper/config.json` (override with `RIPPER_CONFIG` / `--config`).  
**Secrets:** `~/.config/ripper/secrets.env` (chmod 600), loaded after process env. Keys: `GEMINI_API_KEY`, `GEMINI_OCR_MODEL`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_CHANNEL_NAME`, optional `TMDB_API_KEY`.

```jsonc
{
  "version": 3,
  "platform": "darwin",           // set by setup; linux later
  "tools": {
    "makemkvcon": "/Applications/MakeMKV.app/Contents/MacOS/makemkvcon",
    "ffmpeg": "/opt/homebrew/bin/ffmpeg",
    "ffprobe": "/opt/homebrew/bin/ffprobe",
    "mkvmerge": "/opt/homebrew/bin/mkvmerge",
    "imagesnap": "/opt/homebrew/bin/imagesnap",  // omit / null on Linux
    "eject": "diskutil"           // linux: eject / udisksctl — see §11
  },
  "camera": {
    "device": "HD Pro Webcam C920",
    "warmup_s": 2,
    "mode": "shelf" | "handheld", // setup picks; 1 drive ⇒ handheld default
    "exclusive": true             // flock around capture; fail if busy
  },
  "paths": {
    "media_root": "/Volumes/Seagate 4TB/media",
    "staging_root": "/Volumes/Seagate 4TB/media/_staging/shows",
    "library_root": "/Volumes/Seagate 4TB/media/library/shows",
    "state_dir": "/Volumes/Seagate 4TB/media/_staging/.ripper",
    "projects_dir": null          // default: {state_dir}/projects
  },
  "drives": [
    {
      "id": "drive-1",
      "label": "Slimtype left",
      "drive_name": "DVD+R-DL Slimtype DVD A DS8A4S JL61 007080176998",
      "slot": { "label": "blue", "side": "left" }   // omit entirely in handheld
    },
    {
      "id": "drive-2",
      "label": "LG right",
      "drive_name": "…full DRV name…",
      "slot": { "label": "red", "side": "right" }
    }
  ],
  "notify": {
    "slack": true,                // false if no secrets
    "gemini": true
  },
  "thresholds": {
    "settle_ms": 8000,
    "confirm_frame_delay_ms": 3000,
    "poll_ms": 10000,
    "state_timeout_ms": {
      "SETTLING": 120000,
      "IDENTIFYING": 180000,
      "RIPPING": null,            // bounded by makemkvcon_timeout instead
      "VERIFYING": 120000,
      "SPLITTING": 300000
    },
    "makemkvcon_info_timeout_ms": 300000,     // 5 min
    "makemkvcon_rip_timeout_ms": 3600000,     // 60 min hard cap; scratched disc path
    "makemkvcon_stall_ms": 180000,            // no PRGV / no bytes for 3 min ⇒ marginal
    "verify_open_retry": { "attempts": 10, "delay_ms": 2000 },
    "episode_min_s": 900,         // 15 min
    "episode_max_s": 2100,        // 35 min
    "episode_double_max_s": 2700, // 45 min — candidate two-parter
    "playall_min_s": 2700,        // 45 min
    "extra_max_s": 900,
    "playall_sum_tolerance": 0.1,
    "verify_duration_tolerance_s": 120,
    "ocr_confidence_min": 0.6,
    "free_space_multiplier": 2
  },
  "features": {
    "rip_extras": true,
    "confirm_second_frame": true,
    "tmdb": true
  }
}
```

**Drive resolution rule (fixes "prefix matched 2 drives"):** match on **exact `drive_name` equality** first; if setup stored a prefix historically, require exactly one `startsWith` match **and** prefer matching `osDevice` from last successful resolve stored in drive runtime state. On ambiguity ⇒ `DRIVE_OFFLINE` / fail closed — never pick arbitrarily. After eject, re-enumerate before next resolve; do not cache `disc:N` across operations (v2 rule retained).

**No absolute paths in shipped code** — only in user config written by `setup`.

---

## 6. Project & runtime state schemas

### 6.1 Project file

`{projects_dir}/{project_id}/project.json`

```jsonc
{
  "version": 3,
  "id": "tmnt-2003",
  "created_at": "ISO-8601",
  "show": {
    "title": "Teenage Mutant Ninja Turtles (2003)",
    "year": 2003,
    "tmdb_id": 12345,
    "tmdb_type": "tv",
    "slug": "teenage-mutant-ninja-turtles-2003",
    "source": "tmdb" | "manual"
  },
  "canonical_episodes": [
    { "id": "S01E01", "season": 1, "episode": 1, "title": "Things Change" }
    // … full series from TMDB or manual import
  ],
  "canonical_path": "canonical-episodes.json",  // sibling file; editable override
  "discs": [
    {
      "disc_id": "disc-20260720-s3v1",
      "season": 3,
      "volume": 1,                    // season-local volume (from "3.1")
      "volume_label_print": "3.1",
      "volume_title": "…",
      "disc_label_makemkv": "TMNT_s3v1",
      "expected_episodes": ["S03E01", "S03E02", "…"],
      "box_episode_titles": ["…"],   // OCR strings, audit only
      "status": "done" | "ripped_unverified" | "failed" | "parked" | "missing",
      "staging_folder": "vol-unknown-… or vol03-01-…",
      "layout": "individual" | "playall" | "hybrid" | "unknown",
      "notes": ""
    }
  ],
  "progress": {
    // denormalized cache; status command may recompute from canonical ∩ discs
    "by_season": {
      "1": { "have": 26, "total": 26, "missing": [] },
      "2": { "have": 17, "total": 26, "missing": [18, 19, 20, 21, 22, 23, 24, 25, 26] }
    }
  }
}
```

**Judgment:** progress is recomputed on `status` / after finalize from manifests + library/staging presence — the cache is a hint, not authority.

### 6.2 Runtime `state.json`

`{state_dir}/state.json` — per-drive machine only (project progress lives in project files).

```jsonc
{
  "version": 3,
  "current_project_id": "tmnt-2003",
  "drives": {
    "drive-1": {
      "status": "EMPTY",
      "drive_name": "…",
      "os_device": "/dev/rdisk5",     // last resolved; hint only
      "disc_label": null,
      "entered_status_at": "ISO-8601",
      "attempt_dir": null,
      "pid": null,
      "reason": null,
      "load_id": null
    }
  },
  "updated_at": "ISO-8601"
}
```

**States:**  
`EMPTY → SETTLING → IDENTIFYING → CLASSIFYING → RIPPING → VERIFYING → SPLITTING → DONE_EJECTED`  
plus `FAILED_SEATED`, `NEEDS_ATTENTION`, `MARGINAL_DISC`, `DRIVE_OFFLINE`.

**Timeout law:** every non-terminal state records `entered_status_at`. Watcher **must not** `continue` forever on in-progress statuses. On timeout:

| State | Action |
|-------|--------|
| `SETTLING` / `IDENTIFYING` | → `NEEDS_ATTENTION` (camera/OCR); notify; allow `reset-drive` |
| `CLASSIFYING` | → `NEEDS_ATTENTION` with title table dump |
| `RIPPING` | if child dead → `FAILED_SEATED`; if child alive but stall/hard timeout → kill if interruptible, else `MARGINAL_DISC` + notify "disc may be scratched; leave seated" |
| `VERIFYING` | retry open-wait; then `FAILED_SEATED` |
| `SPLITTING` | `FAILED_SEATED` but keep play-all for `resplit` |

This directly fixes the 2026-07-20 SETTLING deadlock (worker skipped in-progress forever).

### 6.3 Per-disc `manifest.json`

Unchanged in spirit from v2: disc label, drive id/name, scan_id, layout decision + full TINFO table, selected titles, verify results, chapter groups, expected episode ids from project. Finalize and resplit read this, not directory listings.

---

## 7. N-drive & scan binding model

### 7.1 Cardinality

| Drives | Camera mode | Binding |
|--------|-------------|---------|
| 1 | `handheld` (default) | No slots. Human runs `identify` (or watch is not used). Scan = "the box you're holding." |
| 2+ with fixed shelf | `shelf` | Each drive has optional `slot.label`. OCR returns results keyed by slot label; only the drive that requested the scan may consume its slot. |
| 2+ without shelf / shared table | `handheld` per disc | Same as 1-drive; parallel rip OK, identify serializes on camera lock. |

### 7.2 Slot generalization

Replace hardcoded `blue|red` enum with **config-defined slot labels** (`"blue"`, `"red"`, `"left"`, `"1"`, …). Gemini prompt is generated from config:

> Slot labels visible in frame: blue=left→drive-1, red=right→drive-2. Return only those labels.

Settle agreement keys: `{season, volume, volume_title}` (see §9), not bare `volume_number`.

### 7.3 Watch with one drive

**Judgment:** do not invent a fake second slot. `watch` with one shelf-mapped drive is fine; `watch` with handheld mode is unsupported (exit with message to use `identify` + `rip`). Friend with one drive gets a simple attended loop, not a broken two-slot camera crop.

---

## 8. Disc-layout decision algorithm (CRITICAL)

Inputs: `titles[]` from `makemkvcon info` (`id`, `duration_s`, `chapters`, `size`, `outName`), `expected_eps` (integer from box/project), optional `avg_ep_s` (default 22*60).

### 8.1 Definitions

```
EP_MIN, EP_MAX, EP_DOUBLE_MAX, PLAYALL_MIN, EXTRA_MAX  // from config thresholds
individuals = titles where duration in [EP_MIN, EP_MAX]
doubles     = titles where duration in (EP_MAX, EP_DOUBLE_MAX]
longs       = titles where duration >= PLAYALL_MIN
extras      = titles where duration < EXTRA_MAX
sum_ind     = sum(durations of individuals)
```

### 8.2 Decision table

| # | Condition | Layout | Strategy |
|---|-----------|--------|----------|
| 1 | `len(individuals) == expected_eps` (≥1) | **individual** | Rip those titles in duration/title-id order for ripping only; **naming order comes from box/project list**, not `t##`. Skip longs. |
| 2 | `len(individuals) == expected_eps` and some `long` ≈ `sum_ind` (±10%) or `long` ≫ max(individuals) | **hybrid** | Same as individual; explicitly **ignore** the one or two largest longs (play-alls). Owner's Courage/Batman method. |
| 3 | `len(individuals) == 0` and exactly one `long` with `chapters >= expected_eps` (or ≥ 2×expected if chapters are scene-level) | **playall** | Rip that title; chapter-split into `expected_eps` groups. TMNT pattern. |
| 4 | `len(individuals) == 0` and one `long` but chapters < expected_eps | **unknown** | `NEEDS_ATTENTION` — cannot split safely. |
| 5 | `len(individuals) > 0` and `len(individuals) != expected_eps` | **mismatch** | Do **not** rip yet. Dump table. Offer: `--expect-eps` override, include `doubles` as one logical ep, or mark extras. |
| 6 | `len(individuals) == 0` and `len(longs) >= 2` | **unknown** | Multiple play-alls, no individuals — needs human. |
| 7 | else | **unknown** | `NEEDS_ATTENTION`. |

**Verify gate (mandatory before first `mkv` write):**

```
selected_count =
  individual/hybrid → len(episodeTitleIds)
  playall → expected_eps   # post-split target
if selected_count != expected_eps → refuse auto path (NEEDS_ATTENTION)
unless --trust-layout with logged ack
```

### 8.3 Pseudocode

```
function classify(titles, expected_eps):
  individuals = filter EP_MIN..EP_MAX
  doubles     = filter EP_MAX..EP_DOUBLE_MAX
  longs       = filter >= PLAYALL_MIN
  extras      = filter < EXTRA_MAX

  if expected_eps is missing:
    return unknown("need expected episode count from box/project")

  if len(individuals) == expected_eps:
    playalls = longs sorted by duration desc
    skip = playalls that look like compilations
      (duration ≈ sum(individuals) ±10% OR duration > 1.5 * max(individuals))
    return hybrid_or_individual(
      episode_ids = individuals.ids,
      skip_ids = skip.ids (max 2),
      extra_ids = extras.ids
    )

  if len(individuals) == 0 and len(longs) == 1:
    L = longs[0]
    if L.chapters >= expected_eps:
      return playall(L, extras)
    return unknown("playall chapters < expected_eps")

  if len(individuals) + len(doubles) == expected_eps:
    // double-length two-parter discs: treat each double as ONE ripped title
    // mapping to TWO canonical episodes happens at finalize with Part 1/2 titles
    return individual_with_doubles(...)

  if abs(len(individuals) - expected_eps) == 1 and len(doubles) >= 1:
    return mismatch_hint("possible two-parter / extra-as-long-as-ep")

  return mismatch(dump_table(titles), expected_eps)
```

### 8.4 Degenerate cases (explicit)

| Case | Behavior |
|------|----------|
| Double-length two-part ep (~40–45 min) | In `doubles` band; if box lists 2 titles for that slot, rip one file → finalize maps to two canonical ids only with `--split-double` or manual map (default: one file, NEEDS_ATTENTION note). |
| Extra as long as an episode (15–35 min) | Count will exceed box → **mismatch**, refuse. Human excludes title ids via future `rip --exclude-title` or parks. Never silently drop mid-band titles. |
| Play-all not exact sum of individuals | Still treat as hybrid if individual count matches box; sum heuristic is only for *labeling* skip candidates, not for requiring equality. |
| Count simply ≠ box | Refuse rip (neutral folder only if `--force-neutral` for archival dump of all candidates — advanced). |
| Play-all-only with wrong chapter grouping | Keep play-all; `resplit --expect-eps N` (fixes s3v1 / vol14 from 2026-07-20 without re-rip). |
| Two largest play-alls on hybrid | Skip up to **two** longest compilation titles when individuals already satisfy count (Batman-style). |

**Ordering note:** For individual/hybrid, rip order may follow MakeMKV title id for throughput, but **finalize order = box/project episode list order** matched by fuzzy title — never assume `t##` == broadcast order without `--trust-title-order`.

---

## 9. Identification flow & Gemini JSON contract

### 9.1 Flow

```
capture frame(s)
  → Gemini structured JSON (proposal)
  → local schema validate
  → parse season-aware volume (fixes "3.1" → season=3, volume=1)
  → settle: second frame must agree on {season, volume, volume_title, series_normalized}
  → TMDB search by series title (+ year if present)
  → user/project confirm show (first disc of project) OR auto-match if project already locked
  → map box episode titles → canonical SxxExx (fuzzy); store both
  → expected_eps = len(mapped) or len(box episodes) if still unverified
  → only verified identity may name folders / finalize
```

OCR failure / camera busy → rip to neutral folder is allowed; finalize refuses (v2 behavior; correct per 2026-07-20).

### 9.2 Gemini JSON contract (v3)

Handheld (no slots):

```json
{
  "box_present": true,
  "series": "Teenage Mutant Ninja Turtles",
  "series_year_guess": 2003,
  "season": 3,
  "volume": 1,
  "volume_label_raw": "3.1",
  "volume_title": "Ways of the Warrior",
  "episodes": ["Ep Title 1", "Ep Title 2", "Ep Title 3", "Ep Title 4", "Ep Title 5"],
  "confidence": 0.86,
  "uncertainties": ["volume_title partially obscured"]
}
```

Shelf (multi-slot): JSON **array** of the above objects, each with `"slot": "<label from config>"`.

**Schema rules (local validation, fail closed):**

- `season` int 1–99 or null; `volume` int 1–99 or null.
- `volume_label_raw` string (may be `"3.1"`, `"Vol. 14"`, `"Disc 2"`).
- `episodes` 1–12 nonempty strings (raise max from v2's 6 — season-3 TMNT volumes had 5).
- No extras/bonus lines in `episodes`.
- `confidence` finite ∈ [0,1].

**Season-aware parser (mandatory, independent of model):**

```
parseVolumeLabel(raw, season_from_model):
  if match /^(\d+)\.(\d+)$/ → season=$1, volume=$2
  if match /S(?:eason)?\s*(\d+).*V(?:ol(?:ume)?)?\s*(\d+)/i → …
  if match /^(\d+)$/ only → volume=$1, season=season_from_model or null
  settle compare uses (season, volume) tuple, NOT raw volume_number alone
```

This fixes settle frames disagreeing because every S3 box OCR'd as `volume_number=3`.

### 9.3 TMDB confirmation

1. Search TV: `query=series`, prefer year match.
2. If 0 hits → ask user to paste TMDB id or import `canonical-episodes.json`.
3. If 1 hit → fetch season episode lists; build canonical catalog.
4. If many hits → print top 5; require interactive pick (`identify --confirm` / `project new`).
5. Project locks `tmdb_id`; later discs must match same show (series string fuzzy) or `NEEDS_ATTENTION`.

**Without TMDB / Gemini:** `project new --title "…" --canonical-file path.txt` (SxxExx\|Title lines). `--expect-eps N` on rip. Full offline path required.

### 9.4 Overrides

```
ripper identify --image box.jpg --confirm
ripper project show
# edit projects/…/canonical-episodes.json
ripper rip --drive drive-1 --expect-eps 5
ripper finalize   # still fail-closed on unverified folders
```

Manual override file next to a volume: `identity.override.json` with season/volume/episode ids — finalize honors when `verified: true` set by user command `ripper verify-identity --folder …`.

---

## 10. Error / timeout / recovery matrix

| Failure (real or likely) | Detection | Automatic response | Human recovery |
|--------------------------|-----------|--------------------|----------------|
| SETTLING stranded forever | `entered_status_at` + `state_timeout_ms.SETTLING` | → `NEEDS_ATTENTION`; Slack/console; worker **handles** timeout instead of skip | Remove disc or `reset-drive`; fix camera; retry |
| Settle disagree on vol (`3.1`) | season-aware compare | Retry one frame; then NEEDS_ATTENTION + neutral rip optional | Fix lighting; `identify --image`; override |
| Camera busy (LOTR / other app) | `imagesnap` fail or `exclusive` lock | Do not leave SETTLING forever; NEEDS_ATTENTION "camera busy" | Quit other webcam users; retry |
| `verify failed: file is open` | `lsof` after makemkv exit | Retry up to 10× / 2s; only then fail | Wait; `retry`; do not re-rip if file size stable |
| Drive prefix matched 2 | resolve ≠ 1 exact | `DRIVE_OFFLINE`; no rip | Re-run `setup` to refresh names; unplug ghost device |
| Hung `makemkvcon` (D-state, scratched) | rip timeout / stall (no PRGV) | Best-effort SIGTERM; if unkillable → `MARGINAL_DISC`, pause **that** drive only, others continue | Clean disc; `park`; reboot drive USB if needed |
| `info` > 5 min | info timeout | Kill info; NEEDS_ATTENTION | Retry / different drive |
| Split wrong (1 chunk or 2 huge) | split verify vs expected_eps | FAILED_SEATED keep play-all | `resplit --expect-eps N` |
| OCR unverified folders | finalize gate | Refuse apply | `verify-identity` or re-scan box photo |
| Staging volume unmounted | mount check each poll | Pause all workers; notify | Remount; watch resumes |
| Ambiguous TMDB / wrong show | identify | Do not lock project | User pick / manual canonical |
| Count ≠ box | classifier | Refuse rip | `--trust-layout` with eyes on table, or exclude titles |

**Concurrency (retained from v2):** never `info` a drive mid-rip; serialize disc-open phase until acceptance test passes on the machine; PRGV releases open-gate early.

---

## 11. Portability

### 11.1 macOS (supported)

- Camera: `imagesnap`.
- Eject: `diskutil eject` on BSD device from MakeMKV `osDevice` (already proven; do not use `drutil -drive N`).
- Paths: `/Volumes/…` external disks.

### 11.2 Linux (documented, not required to implement in phase 1)

| Concern | Change |
|---------|--------|
| Camera | `fswebcam` / `ffmpeg -f v4l2` instead of imagesnap; setup detects. |
| Eject | `eject /dev/sr0` or `udisksctl unmount/eject`; map MakeMKV device names carefully. |
| MakeMKV | Linux binary path via setup, not `.app` bundle. |
| Config dir | Still `~/.config/ripper/` (XDG). |
| Optical detect | Prefer MakeMKV `DRV:` only (same as macOS). |

### 11.3 Optional integrations

- **Gemini:** if unset, `identify` requires `--image` + manual JSON/`--expect-eps` / canonical file.
- **Slack:** if unset, log to stdout + `runlog.jsonl` only; disc threads no-op.
- **TMDB:** if unset, manual canonical list required for finalize names.

Pipeline must complete rip → verify → split → eject without any of the three.

---

## 12. README outline (for a stranger)

1. **What this is** — unattended/attended DVD box-set ripper for MakeMKV; stages MKVs then finalizes Jellyfin-style names.
2. **Hardware assumptions** — 1+ USB/optical DVD drive; optional fixed webcam + shelf stickers for multi-drive; external disk with space ≥ 2× disc size; good lighting for box backs.
3. **Install** — Node 20+, MakeMKV, mkvtoolnix, ffmpeg; macOS: `brew install imagesnap`; clone/copy `scripts/ripper`; `npm i`.
4. **Setup** — `node ripper.mjs setup`; show non-destructive re-run behavior; where config lives; optional Gemini/Slack/TMDB keys.
5. **Daily use**
   - Multi-drive shelf: `project new --from-scan` once → `watch` → swap discs with box-before-tray protocol → `status` → `finalize --apply`.
   - Single drive: `identify` → `rip --drive drive-1` → repeat → `finalize`.
6. **Recovery**
   - Failed/scratched: leave seated, clean, `retry` / `park`.
   - Bad split: `resplit`.
   - Stranded state: remove disc, `reset-drive`.
   - Wrong identity: do not force finalize; `verify-identity` or re-scan.
7. **When identification is wrong** — check lighting/camera exclusivity; use `--image`; edit canonical list; neutral folders are safe.
8. **Limits** — no warranty on scratched media; spot-check one episode per volume in QuickTime before trusting a whole season.

---

## 13. Migration from current TMNT-specific tool

| v2 artifact | v3 action |
|-------------|-----------|
| `config.mjs` hardcoded Seagate + SHOW_NAME + A/B | Replace with user `config.json` from `setup`; keep `config.mjs` as thin loader of user config + defaults for thresholds. |
| `data/tmnt-2003-episodes.txt` | Import once into `projects/tmnt-2003/canonical-episodes.json` via `project new --canonical-file`. |
| `RIPPER_DRIVE_A_NAME` env | Map to `drives[].drive_name` in setup. |
| Existing `_staging/.../vol-*` folders | `project` import scan of manifests; mark done episodes; leave neutral folders unverified until identity fixed. |
| Drive A stuck SETTLING | `reset-drive` semantics + timeouts (behavioral fix). |
| Slack disc threads | Keep as optional module; no change to API keys layout beyond secrets.env. |
| Fixtures / unit tests | Keep; add fixtures for Courage-style hybrid + `3.1` volume labels + ambiguous DRV lists. |

**Compat:** v3 may read v2 `state.json` drives A/B and migrate keys to `drive-1`/`drive-2` on first boot if names match config — or require clean state after setup (judgment: **require `doctor` + empty in-progress states**; simpler and safer after the deadlock incident).

---

## 14. Phased implementation plan

### Phase 0 — Stabilization (ship first, unblocks owner tonight/tomorrow)

1. State timeouts + watcher handles in-progress expiry (`SETTLING` deadlock).
2. Verify open-file retry loop.
3. Exact drive_name resolve + ambiguity handling.
4. Season-aware volume parse + settle keys `{season,volume,volume_title}`.
5. Camera exclusive lock / busy → NEEDS_ATTENTION.
6. `makemkvcon` info/rip timeouts + `MARGINAL_DISC`.
7. `resplit` CLI for bad chapter groups.
8. `reset-drive` CLI.

*Still TMNT-hardcoded OK in phase 0 — these are the logged P0 bugs.*

### Phase 1 — Portability core

1. `setup` wizard + `~/.config/ripper/config.json` (no silent overwrite).
2. N-drive config; drop hardcoded A/B blue/red from code paths.
3. Handheld vs shelf camera modes.
4. Tool paths only from config.
5. Gemini/Slack optional hard switches.
6. README sections 1–5.

### Phase 2 — Show-agnostic identity + projects

1. New Gemini contract + TMDB confirm.
2. `project` / `status` / canonical episode store.
3. Remove `SHOW_NAME` + repo episode file dependency.
4. Finalize reads project catalog.

### Phase 3 — Layout classifier v3

1. Implement decision table §8 (hybrid-first when individuals match count).
2. Pre-rip count verification gate.
3. Fixtures for TMNT playall, Courage hybrid, mismatch, doubles.
4. `--trust-layout` / exclude-title escape hatches.

### Phase 4 — Polish

1. Linux eject/camera notes + experimental setup branch.
2. Disc-thread Slack under optional flag.
3. Import wizard for existing TMNT staging tree.
4. Concurrency acceptance test documented in README.

---

## 15. Acceptance criteria (v3 done)

- Friend with one DVD drive, no Slack, no Gemini key: can `setup`, provide canonical list, `rip`, `finalize` a Courage-style disc with correct individual-title selection.
- Owner with two drives: shelf watch works; season-3 `3.1` boxes settle; no SETTLING deadlock after kill -9 of watch.
- Hybrid disc: play-alls skipped; episode count matches box or refuses.
- Playall disc: chapter-split; bad split fixable via `resplit` without re-rip.
- Verify never fails solely because MakeMKV still holds the file (retry succeeds).
- `setup` twice never destroys config without `--replace` + backup.
- `status` reports per-season missing episodes for an in-progress project.

---

## 16. Open questions (intentionally deferred)

1. Whether handheld `watch` with a physical button/HTTP ack is worth it — deferred; attended `rip` is enough for 1-drive friends.
2. Auto-fetch TMDB without API key (scrape) — **no**; require key or manual file.
3. Embedding a second confirmation model for episode frame-matching — out of scope; human spot-check remains.

---

*End of ripper v3 spec. Implementation must not begin from this file alone without phase-0 fixes landing first — those failures are production blockers on the current tool.*
