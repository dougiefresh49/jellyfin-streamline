# Ripper v3: portable DVD box-set ripping pipeline

Status: proposed specification  
Scope: specification only; no v3 implementation is included here  
Requirements source: `specs/ripper-pipeline.md`, `docs/reviews/ripper-*`, the current
`scripts/ripper/` implementation, and the 2026-07-20 ripper/DVD failure log in
`docs/media-server-notes.md`.

## 1. Goals

Ripper v3 turns the TMNT-specific attended ripper into a macOS-first, portable tool for
one or more optical drives and arbitrary episodic DVD box sets. It must:

1. Configure itself interactively without source edits or absolute paths in code.
2. Capture a disc into neutral staging before unverified metadata can affect filenames.
3. Identify series, season/volume, and printed episode order from a box/pamphlet image,
   then confirm that identification against canonical external metadata.
4. Classify individual-title, play-all-only, and hybrid discs before ripping, and require
   an expected-output-count agreement before automatic naming/ejection.
5. Track an entire series across discs and sessions, including missing episodes and
   recoverable failures.
6. Support one, two, or N drives without making shelf slots part of drive identity.
7. Fail closed on identity, layout, ordering, and verification ambiguity while allowing
   useful neutral capture when safe.
8. Run fully without Gemini, Slack, a webcam, or network access by using explicit manual
   metadata and console prompts.

Judgment: correctness of episode identity is more valuable than unattended throughput;
uncertainty may produce neutral files, but never authoritative library names.

## 2. Non-goals

- Circumventing copy protection unsupported by MakeMKV or distributing MakeMKV keys.
- Blu-ray-specific playlist-obfuscation logic in v3.0 (the schemas should not prevent it
  later).
- Fully unattended robotic disc changing.
- Inferring episode identity from title number alone.
- Video transcoding, restoration, deinterlacing, or compression; v3 remuxes/splits only.
- Replacing Jellyfin's scanner or managing Jellyfin libraries after files are finalized.
- Automatically deleting source, partial, duplicate, or extra files.
- Guaranteeing that every pathological DVD can be classified automatically.

## 3. Operating model and invariants

The unit of work is a **project** (normally one TV series/edition), containing persistent
disc loads and canonical episodes. A **load** is an immutable binding of a physical drive,
disc fingerprint, scan/override, and attempt. A drive's short CLI ID is only an alias; its
stable hardware identity is revalidated before every operation.

The following invariants are mandatory:

- All initial output is under
  `<stagingRoot>/projects/<project-id>/loads/<load-id>/attempt-<n>/`; show names and OCR
  never choose the capture directory.
- A file enters the library only from a verified manifest with a unique canonical episode
  mapping and successful media verification.
- The expected printed episode count is known before automatic title selection. Without
  it, `analyze` may recommend but cannot approve a layout.
- MakeMKV exit, file-close/settle, and decode verification happen in that order.
- Eject is automatic only after verified success. Failure leaves the disc seated unless
  the user explicitly passes an eject command.
- State and manifests use atomic temp-file-plus-rename writes. One controller lock and one
  operation lock per stable drive prevent competing commands.
- Every automatic decision records inputs, rule/version, confidence, and reasons. Raw
  MakeMKV robot output, image hash, model response, external lookup result, and overrides
  remain auditable.

## 4. CLI surface

Executable name below is `ripper`; `node ripper.mjs` may remain a development alias.
All commands accept `--config <path>`, `--json`, `--verbose`, and `--no-color` unless noted.
Mutating commands accept `--dry-run` where meaningful.

### Configuration and diagnostics

`ripper setup [--config <path>] [--non-interactive] [--force-new <path>]`

- Detects tools, drives, cameras, writable destinations, Gemini, and Slack; shows the
  proposed config and writes only after confirmation.
- If the target exists, default behavior is to display detected differences and offer
  `keep`, `merge`, `write-new`, or `cancel`. It never silently overwrites. `--force-new`
  means create a different file and fails if that path exists; it does not authorize an
  overwrite.
- `--non-interactive` validates values supplied through flags/environment and refuses to
  write if required values or confirmation are absent.

`ripper config show [--effective] [--redact]` prints stored or merged configuration.  
`ripper config validate` validates schema, paths, stable drive bindings, and secrets.  
`ripper doctor [--full] [--drive <id>|--all-drives]` performs read-only checks by default.
`--full` also writes/removes a staging probe, captures a camera test image, exercises the
configured Gemini structured-output contract, tests the metadata provider, optionally
posts a Slack test, and runs safe drive/concurrency checks with explicit prompts.

### Projects and identification

`ripper project create [--name <name>] [--scan <image>|--camera] [--manual]`
creates a project from confirmed identification or manual fields.  
`ripper project list [--archived]` lists projects.  
`ripper project select <project-id>` sets the default project in user config.  
`ripper project edit <project-id> [--title <title>] [--year <year>] [--provider-id <id>]`
records a revision, never rewriting history.  
`ripper project import <project-id> --episodes <json|csv>` supplies canonical metadata for
offline/unlisted series.  
`ripper project reconcile <project-id> [--refresh-provider]` recomputes coverage and reports
conflicts without moving files.  
`ripper project archive <project-id>` hides a completed project but retains state.

`ripper identify [--project <id>] (--camera|--image <path>|--manual)
[--drive <id>] [--region <name>] [--season <n>] [--volume <n>]
[--title <text>] [--episodes <file>] [--provider-id <id>] [--accept-candidate <n>]`
captures/parses box metadata, queries canonical metadata when available, and prompts for
confirmation. `--manual` works with neither camera nor Gemini. Overrides are stored with
source `user`, timestamp, and prior value.

### Disc work

`ripper drives [--refresh]` lists configured and discovered physical drives, exact match
status, media state, and current load.  
`ripper scan [--drive <id>] [--project <id>] [--identify ...]` creates a load, captures
identity if requested, fingerprints the disc, and runs MakeMKV info only; it never rips.  
`ripper analyze --load <id> [--expected <n>] [--layout individual|play-all-only|hybrid]
[--include-title <id>] [--exclude-title <id>] [--map <file>] [--accept]` prints the complete
title decision table. Overrides require an interactive confirmation or `--accept` and are
persisted.  
`ripper rip [--drive <id>|--load <id>] [--project <id>] [--no-extras]
[--keep-play-all] [--jobs <n>] [--timeout <duration>] [--resume]` identifies/scans/analyzes
as needed, but stops before ripping if an approval gate remains. `--jobs` caps concurrent
drive workers and cannot exceed configured safety policy.  
`ripper watch [--project <id>] [--drives <id,id,...>] [--jobs <n>] [--no-auto-eject]`
runs the resumable controller. With one drive, it prompts “hold or scan this box” for every
new load. With configured camera regions it binds only the region explicitly assigned to
that drive/load.  
`ripper retry --load <id> [--from info|rip|verify|split|identify] [--drive <id>]`
starts a new attempt while reusing only fingerprint-matching verified artifacts.  
`ripper recover [--load <id>|--all] [--apply]` explains stale states/processes/open files
and proposes deterministic repairs; without `--apply` it is read-only.  
`ripper eject --drive <id> [--force]` ejects one revalidated OS device. `--force` bypasses
the “unfinished load” prompt, not hardware identity checks.  
`ripper cancel --load <id>` asks a responsive child to terminate, records cancellation,
and keeps artifacts. It does not promise to kill an uninterruptible kernel I/O wait.

### Progress and finalization

`ripper status [--project <id>] [--drive <id>] [--missing] [--json]` shows live drive
states, active attempts, failures, and canonical coverage, for example:

```text
Teenage Mutant Ninja Turtles (2003)  [tmdb:...]
S1: 13/13 complete
S2: 17/26 complete — missing E18-E26
Drives: slimtype=EMPTY  lg=MARGINAL_MEDIA (S2 disc 7, retry available)
```

`ripper verify --load <id> [--deep] [--retry-open-for <duration>]` reruns media checks;
`--deep` decodes all streams rather than bounded samples.  
`ripper finalize --project <id> [--season <n>] [--apply] [--copy|--move]
[--allow-incomplete]` prints the exact source-to-destination plan by default. `--apply`
refuses unverified, ambiguous, duplicate, open, missing, or existing destinations.
`--allow-incomplete` permits verified episodes to move while the project remains partial;
it never relaxes per-file identity gates. Default operation is move within a filesystem and
copy-verify-delete across filesystems.  
`ripper logs [--load <id>] [--follow]` renders the event journal; raw secrets are redacted.

Judgment: explicit `load-id` is the safest automation handle; drive IDs are convenient
only at the moment a new load is created.

## 5. First-run setup and configuration

### Location and format

Default user config is `${XDG_CONFIG_HOME:-~/.config}/ripper/config.json`; macOS users may
override it with `--config`. Runtime state defaults to
`${XDG_STATE_HOME:-~/.local/state}/ripper`, while project media remains beneath the selected
staging root. JSON is used because it is portable, strictly schema-validatable, and can be
written atomically without executing user code. A `schemaVersion` supports migrations.

Secrets are not stored in config. The config contains environment-variable names (default
`GEMINI_API_KEY`, `TMDB_API_TOKEN`, `SLACK_BOT_TOKEN`) and Slack channel ID. Environment,
an optional user-selected `.env` file with mode 0600, or a future OS-keychain adapter
provides values. Diagnostic output always redacts them.

### Setup flow

1. Find `makemkvcon`, `ffmpeg`, `ffprobe`, `mkvmerge`, and optional `imagesnap` using PATH
   and standard macOS application/Homebrew locations. Store the resolved path only in the
   user config; code contains no host path. Run `--version`/safe help probes.
2. Enumerate MakeMKV `DRV` records and OS optical devices. Present vendor/product, serial
   when exposed, OS device path, and a generated friendly ID. Ask the user to open/close or
   insert a labeled test disc one drive at a time to disambiguate identical units.
3. Store a stable match tuple (serial/WWN if available; otherwise exact MakeMKV name plus
   transport registry identity). Never store a prefix as authority. Current `disc:N` and
   `/dev/diskN` are ephemeral observations only.
4. Detect cameras with `imagesnap -l` on macOS, offer a test capture, and permit `none`.
   Probe exclusive access. Camera failure cannot fail setup when manual/image identification
   is selected.
5. Ask for a staging/rip destination and library shows destination. Suggest mounted volumes
   with adequate free space, but require user confirmation and a write/fsync/read/delete
   probe. They may be on different filesystems.
6. Ask whether the workflow is handheld (recommended for one drive), per-drive camera
   regions, or manual image files. Region setup captures an image and lets the user name
   rectangles; it never assumes blue/red or left/right.
7. Gemini is optional. If enabled, require a successful image plus schema validation test.
   TMDB (or another canonical provider) is separately optional; test authentication and
   search. With neither provider, manual/imported canonical metadata is required before
   finalization.
8. Slack is optional. If enabled, call `auth.test`, validate channel access, and offer a real
   test post. Failure disables notification readiness but not ripping.
9. Display the complete redacted config and differences from any existing file; obtain an
   explicit write choice and use create-exclusive or atomic replace only after that choice.

### Configuration schema (normative shape)

```json
{
  "schemaVersion": 3,
  "paths": {
    "stagingRoot": "/user/chosen/path",
    "libraryShowsRoot": "/user/chosen/path",
    "stateRoot": "/user/chosen/or/default/path",
    "tempRoot": null
  },
  "tools": {
    "makemkvcon": "/resolved/path",
    "ffmpeg": "/resolved/path",
    "ffprobe": "/resolved/path",
    "mkvmerge": "/resolved/path",
    "imagesnap": null
  },
  "drives": [
    {
      "id": "slimtype",
      "label": "Upper drive",
      "match": {
        "serial": "007080176998",
        "makeMkvNameExact": "DVD+R-DL Slimtype ... 007080176998",
        "transportId": "macOS-IORegistry-id-if-available"
      },
      "lastSeen": { "osDevice": "/dev/rdisk5", "makeMkvIndex": 0 }
    }
  ],
  "capture": {
    "mode": "handheld",
    "camera": { "nameExact": "HD Pro Webcam C920", "warmupMs": 2000 },
    "regions": [],
    "settle": { "frames": 2, "frameGapMs": 3000, "deadlineMs": 45000 }
  },
  "providers": {
    "vision": {
      "enabled": false,
      "kind": "gemini",
      "model": "user-selected-tested-model",
      "apiKeyEnv": "GEMINI_API_KEY"
    },
    "canonical": {
      "enabled": false,
      "kind": "tmdb",
      "apiTokenEnv": "TMDB_API_TOKEN",
      "language": "en-US"
    }
  },
  "notifications": {
    "slack": {
      "enabled": false,
      "tokenEnv": "SLACK_BOT_TOKEN",
      "channelId": null
    }
  },
  "policy": {
    "extras": "keep",
    "autoEject": true,
    "maxConcurrentRips": 1,
    "serializeMakeMkvOpen": true,
    "freeSpaceHeadroom": 2.0,
    "timeoutsMs": {
      "driveSettle": 45000,
      "cameraAcquire": 10000,
      "identify": 90000,
      "discInfo": 300000,
      "ripNoProgress": 180000,
      "ripAbsolutePerTitle": 7200000,
      "fileClose": 60000,
      "verify": 300000,
      "split": 600000,
      "eject": 30000
    },
    "duration": {
      "episodeTargetSeconds": 1320,
      "episodeLooseMinSeconds": 900,
      "episodeLooseMaxSeconds": 3300,
      "playAllMinSeconds": 2400,
      "nearDuplicateToleranceSeconds": 5,
      "sumToleranceRatio": 0.12
    }
  },
  "defaultProjectId": null
}
```

`lastSeen` is informational and may change. A drive match succeeds only when exactly one
device satisfies the stable tuple; zero is offline and more than one is
`DRIVE_IDENTITY_AMBIGUOUS`. Prefix matching is forbidden.

## 6. Drive, camera, and slot binding for N drives

Drive identity and camera position are separate concepts.

- **One drive/default:** no shelf-slot concept exists. On insertion the console says which
  drive changed and asks the user to hold the corresponding box/pamphlet in view, press
  Enter, or provide/manual-enter metadata. That scan is bound directly to the new load ID.
- **N drives/handheld:** the prompt includes stable friendly drive ID, disc label, and a
  short load token. The user scans one box at a time. Other visible boxes are ignored.
- **N drives/fixed camera:** setup defines arbitrary named rectangular regions and an
  explicit `region -> drive-id` mapping. A scan request includes exactly one region/load;
  detections from all other regions are discarded and cannot mutate their loads. Markers
  and colors are optional user labels, not built-in semantics.
- **Batch-ready option:** users may place several boxes, then run `identify --drive ...`
  per load or confirm a single atomic snapshot. The snapshot has one `scanId`; every region
  must be stable across the same two frames. Any drive/media or region change invalidates
  the transaction.

Before rip, v3 revalidates stable drive identity, media presence, disc fingerprint, and the
bound load. A scan waiting longer than its deadline is discarded. Shared-camera access uses
an interprocess camera lock; inability to acquire it transitions to `CAMERA_BUSY`, releases
the worker, and offers image/manual identification rather than retrying forever.

Judgment: making the load—not a shelf color—the binding unit removes the two-drive
assumption and the most dangerous stale-image race.

## 7. Identification and canonical confirmation

### Gemini JSON contract

Gemini structured output must use JSON MIME type plus a response schema. Unknown fields are
rejected locally. The response describes evidence, not authority:

```json
{
  "schema_version": 1,
  "box_present": true,
  "series": {
    "title": "Teenage Mutant Ninja Turtles",
    "year_hint": 2003,
    "confidence": 0.94,
    "evidence": "printed series logo and copyright line"
  },
  "release": {
    "raw_designator": "3.1",
    "season_number": 3,
    "volume_number": 1,
    "disc_number": null,
    "volume_title": "Ways of the Warrior",
    "confidence": 0.90,
    "evidence": "spine reads 3.1"
  },
  "episodes": [
    {
      "printed_order": 1,
      "printed_title": "Episode title",
      "part_hint": null,
      "confidence": 0.91,
      "evidence": "episode list block"
    }
  ],
  "extras": ["optional printed bonus title"],
  "uncertainties": []
}
```

Rules:

- `schema_version` is exactly 1; `box_present` is boolean. If false, all descriptive fields
  are null/empty and the result cannot bind.
- `raw_designator` is always preserved. Season and volume are independent nullable
  integers, 0–999. Never coerce `3.1` to volume 3.
- The deterministic parser first recognizes labeled forms (`Season 3 Volume 1`, `S3 V1`),
  then dotted season-volume forms (`3.1`) only when box context supports that convention.
  Gemini returns both raw and parsed values; local validation recomputes and compares them.
- Episode titles are nonempty, trimmed, unique only when the printed list is unique, in
  printed order, and separated from extras. Count is 1–99 rather than the old TMNT 1–6.
- Confidence is finite `[0,1]`; evidence is short text identifying where the value appeared.
  Model confidence alone never approves identity.
- Raw response, prompt/schema/model version, image SHA-256, timestamp, and requested
  region/load are retained. Invalid results receive at most one schema-correction request,
  then become `IDENTITY_NEEDS_INPUT`.

Settle-frame agreement compares normalized series plus
`{raw_designator, season_number, volume_number, volume_title, episode-title list}`. A
season-aware normalized result may agree even if punctuation differs; `3.1` and an
unlabeled `3` do not agree automatically.

### Canonical source confirmation

1. Search the configured provider (default example: TMDB TV search) by title and optional
   year/language. Store the query and complete candidate summary.
2. Score candidates using normalized title, original title, year proximity, and known
   season availability. Never auto-select when the top candidates are close, the year
   conflicts, or the requested season is absent. Show numbered candidates with title,
   year, overview snippet, and provider ID.
3. After user/unique-candidate selection, fetch canonical season episode records. Persist
   provider ID, provider revision/fetch timestamp, season/episode numbers, titles, air dates,
   and ordering type. Provider ordering is authoritative for filenames only after project
   confirmation.
4. Match the printed list to a contiguous or explicitly selected canonical window using
   normalized title similarity, part indicators, and order. Require a unique one-to-one
   mapping. Volume titles never match episodes (fixes the `City at War` failure).
5. If printed count, order, or titles disagree, show the diff and require one of:
   choose another series/season/provider order; edit OCR fields; select canonical episodes;
   import a local canonical list; or keep the load neutral. The override records who/when,
   reason, old/new values, and cannot be hidden by later rescans.
6. Network/provider failure uses the last pinned canonical snapshot. With no snapshot, rip
   may proceed neutrally but finalization waits for manual/imported canonical metadata.

Double episodes are modeled explicitly: one physical program may map to either one
canonical double-length episode or two canonical episode records. The mapping declares
`outputCount` and `canonicalEpisodeKeys[]`; the user must choose when provider and printed
packaging disagree.

Judgment: pinning provider IDs and episode snapshots makes future metadata changes
reviewable and keeps filenames independent of OCR spelling.

## 8. Disc information and layout classifier

### Inputs and normalized title table

Run a bounded `makemkvcon -r info` against the revalidated physical device and parse robot
CSV by record/attribute code. For every title persist:

- title ID, output name, duration, byte size, chapter count;
- available title/stream metadata, audio/subtitle counts, angles, and segment/playlist
  identity when MakeMKV exposes it;
- near-duplicate group based on duration, size, chapter/segment signature;
- classification tags and the exact include/exclude reason.

The classifier also receives `expectedPrintedEntries`, resolved canonical mapping,
`expectedOutputCount`, and any explicit overrides. Duration thresholds are loose candidate
features, not truth.

### Decision algorithm

```text
classify(titles, expectedOutputCount, printedEntries, overrides):
  require expectedOutputCount > 0 for automatic approval
  apply explicit include/exclude/map overrides; never infer around a contradiction
  group exact/near duplicates; retain all rows in the audit table

  plausible_programs = titles with duration in loose 15–55 minute range
  long_titles = titles above playAllMin or roughly >= 1.7 * median plausible duration
  mark a long title play-all-like when any of these is true:
    - duration is near the sum of a subset of plausible programs
    - chapter/segment structure can yield expectedOutputCount episode-sized groups
    - it is the sole substantial title and has enough chapters
  NOTE: sum mismatch does not disprove play-all; menus, bumpers, branching, and credits vary

  individual_solution = search plausible titles (one representative per duplicate group)
    for mappings whose output contribution totals expectedOutputCount
    where normal title contributes 1 and a confirmed double-length title may contribute 2
  score count agreement first, then duration consistency, duplicate evidence,
    printed/canonical part structure, chapter evidence, and extras risk

  playall_solution = each play-all-like title whose chapters admit exactly
    expectedOutputCount valid contiguous groups (or an approved 1-to-2 canonical mapping)

  if unique high-margin individual_solution and no competing play-all-like title:
    layout = individual; select individuals
  else if unique individual_solution plus one/two excluded play-all-like duplicates:
    layout = hybrid; select individuals; retain/skip play-all per policy
  else if no valid individual_solution and unique valid playall_solution:
    layout = play-all-only; select it and require a reviewed chapter split plan
  else:
    layout = ambiguous; refuse automatic rip/naming and request an override

  require predicted output count == expectedOutputCount
  require every selected output maps uniquely to printed/canonical entries
  otherwise NEEDS_LAYOUT_REVIEW
```

The subset search is practical because DVD title counts are small; cap it and fall back to
review rather than choosing greedily. Scores are explanatory ranking only. Automatic
approval requires a unique solution separated from the runner-up by a configured margin.

### Required decision table behavior

| Observed disc | Classification | Automatic action |
|---|---|---|
| N episode-length titles, no plausible compilation, N expected | `individual` | Rip those N after duplicate/extras checks. |
| N episode-length titles plus one/two large compilations | `hybrid` | Ignore the compilations, rip the N individuals, verify count N. This is the Courage/Batman Beyond default. |
| One substantial long title, short extras, chapter plan yields N | `play-all-only` | Rip long title, split into N reviewed groups, verify each and the sum. This is the TMNT default. |
| Individual titles plus play-all whose duration is not their exact sum | Usually `hybrid` if the unique N-individual solution survives | Do not require sum equality; use count, duplicate/segment/chapter evidence. Flag low confidence. |
| One ~44-minute title where packaging/provider indicates a two-parter | Individual contribution 2 only with explicit canonical evidence | Either retain as one multi-episode file with two episode keys or chapter-split after review. |
| Extra has episode-like duration | Ambiguous unless title/stream/printed evidence separates it | Never silently include/exclude; preview/manual override. |
| Duplicate angles/playlists of equal episode duration | Duplicate group | Pick none automatically unless segment/stream evidence identifies a unique representative; otherwise review. |
| Survivor/output count differs from printed count | `ambiguous` | Refuse automatic rip/eject; show complete table and allow explicit map. |
| Printed count conflicts with canonical count | Identity/layout conflict | Resolve metadata/multi-part mapping first; neutral capture only. |
| No chapters or chapter grouping produces implausible pieces | Invalid play-all split | Keep source play-all, mark `SPLIT_NEEDS_REVIEW`; never re-rip a good source merely to retry splitting. |

For play-all splitting, chapter boundaries are chosen with constrained dynamic programming,
not equal-duration division alone. Exactly N nonempty contiguous groups must meet loose
duration bounds, cover all intended program chapters, and minimize deviation while
penalizing very short edge chapters. Always print start/end chapters and predicted duration
before applying. Menu/bumper chapters may be explicitly excluded only by override. The
source play-all remains until finalization has completed and the retention policy permits
cleanup.

For individual layouts, title-number order is not assumed to be episode order. Automatic
mapping requires disc metadata or content evidence that uniquely establishes order;
otherwise the user previews start frames/audio/subtitles and writes an explicit title-ID to
canonical-episode map. Count agreement prevents missing/extra output but does not prove
ordering.

## 9. Persistent project and runtime state

State root layout:

```text
<stateRoot>/
  controller.lock
  state.json
  events.jsonl
  projects/<project-id>/project.json
  projects/<project-id>/canonical.json
<stagingRoot>/projects/<project-id>/loads/<load-id>/
  identification.json
  manifest.json
  scans/
  info/
  attempt-1/{partial,completed,extras}/
```

`project.json` normative shape (large evidence is referenced, not embedded):

```json
{
  "schemaVersion": 3,
  "projectId": "uuid",
  "revision": 7,
  "status": "active",
  "series": {
    "displayTitle": "Example Show (2003)",
    "provider": "tmdb",
    "providerId": "1234",
    "year": 2003,
    "ordering": "aired",
    "confirmedAt": "ISO-8601"
  },
  "canonicalSnapshot": {
    "path": "canonical.json",
    "sha256": "...",
    "fetchedAt": "ISO-8601"
  },
  "seasons": [
    {
      "seasonNumber": 1,
      "episodes": [
        {
          "key": "S01E01",
          "title": "Canonical title",
          "status": "missing",
          "loadId": null,
          "outputId": null,
          "libraryPath": null
        }
      ]
    }
  ],
  "loads": [
    {
      "loadId": "uuid",
      "discFingerprint": "sha256:...",
      "seasonNumber": 1,
      "volumeNumber": 2,
      "discNumber": 1,
      "printedEpisodeKeys": ["S01E04", "S01E05"],
      "state": "COMPLETE",
      "manifestPath": "relative/path/manifest.json",
      "attempt": 2,
      "lastError": null
    }
  ],
  "overrides": [
    {
      "id": "uuid",
      "kind": "title-map",
      "reason": "manual preview",
      "before": null,
      "after": {},
      "createdAt": "ISO-8601"
    }
  ],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

`manifest.json` records the immutable load binding, full title table, classifier version
and decision, selected title IDs, title-to-output-to-canonical mapping, child processes,
attempt artifacts, checksums/sizes/durations, verification evidence, and eject outcome.
Disc fingerprint is a hash of stable observable facts: disc label/volume ID when present,
ordered title durations/sizes/chapters, title count, and other disc metadata. It is not just
the label and is rechecked before reusing artifacts.

Runtime `state.json` contains configured drive ID, current exact device observation,
load ID, state, state entry/deadline timestamps, heartbeat/progress timestamp, child PID plus
process start identity, attempt, retry count, and last error. On startup, reconcile it with
processes, media, manifests, and open files; never merely skip an “in-progress” string.

Legal core states are:

```text
EMPTY -> MEDIA_SETTLING -> FINGERPRINTING -> IDENTIFYING -> ANALYZING
      -> READY -> RIPPING -> WAITING_FOR_CLOSE -> VERIFYING -> SPLITTING
      -> COMPLETE -> EJECTING -> AWAITING_REMOVAL -> EMPTY
```

Side states are `CAMERA_BUSY`, `IDENTITY_NEEDS_INPUT`, `LAYOUT_NEEDS_REVIEW`,
`RETRYABLE_FAILURE`, `MARGINAL_MEDIA`, `VERIFY_FAILED_SEATED`, `SPLIT_NEEDS_REVIEW`,
`EJECT_FAILED`, `DRIVE_OFFLINE`, and `CANCELLED`. Each has defined allowed recovery
commands and a deadline or is explicitly human-waiting. Human-waiting states do not occupy
a worker or MakeMKV gate.

Every active state has both a wall-clock deadline and, where applicable, progress heartbeat.
The controller watchdog examines them independently of worker dispatch. Expiry atomically
transitions to a recovery state and releases scheduler resources even if an orphan child
still exists; the per-drive lock remains guarded until process ownership is reconciled.

Coverage is computed from canonical episode keys with verified outputs, not volume numbers
or file counts. Thus `status` can truthfully render complete ranges and missing keys across
months and multiple machines/sessions.

## 10. Timeouts, verification, and recovery

Timeouts in config are defaults and setup may tune them. “No progress” means neither
structured MakeMKV progress nor output growth/drive-read evidence. On timeout send SIGTERM,
wait a short grace period, then SIGKILL only if the process is killable. A process in
uninterruptible disk wait may ignore both: mark the load `MARGINAL_MEDIA`, detach it from
the global scheduler, stop issuing commands to that drive, and allow other drives to
continue. The user may physically eject/unplug only after the OS/tool reports it safe.

Each title writes to its own `partial/title-<id>/`. On successful MakeMKV exit, exactly one
new output is identified and moved atomically to `completed/`. Reuse requires matching disc
fingerprint, selected-title manifest, checksum, and verification result.

Verification sequence:

1. Require successful MakeMKV exit and structured success evidence.
2. Poll `lsof`/platform equivalent plus stable size/mtime until closed and stable, up to
   `fileClose`; retry after a short delay. Never run ffprobe while open.
3. `ffprobe -v error` all streams; require video, audio, valid timestamps, expected duration
   tolerance, and sensible size.
4. Bounded decode with ffmpeg near beginning, middle, and end; `--deep` decodes all.
5. Split outputs additionally require N files, per-piece bounds, monotonic chapter coverage,
   and sum approximately matching the selected source after approved exclusions.
6. Flush writes and recheck destination availability/free space before complete/eject.

### Failure and recovery matrix

| Failure | Detection / timeout | State and automatic action | User recovery |
|---|---|---|---|
| Stranded `SETTLING` or any active state | State deadline/heartbeat expires even if worker vanished | `RETRYABLE_FAILURE`; release scheduler slot, preserve load, reconcile child/lock | `recover --load ... --apply`, then `retry`; removal returns drive to `EMPTY` without deleting the load. |
| `3.1` parsed as volume 3 / frames disagree | Raw season-volume parser and normalized frame comparison | `IDENTITY_NEEDS_INPUT`; no authoritative folder/name | Confirm S3/V1 or edit raw designator; override is audited. |
| Verification sees file open | MakeMKV not exited, `lsof` hit, or changing size | `WAITING_FOR_CLOSE`; bounded retry, never ffprobe early | Wait, inspect owner PID, then `recover` or `verify`; do not re-rip a closed valid file. |
| Drive prefix matches two drives | Exact stable tuple resolves to zero/multiple devices | `DRIVE_IDENTITY_AMBIGUOUS`; no MakeMKV/eject command issued | Re-run `setup`, identify drives one at a time, store serial/transport identity. |
| Camera used by another tool | Interprocess lock or capture/open timeout | `CAMERA_BUSY`; release worker; continue other drives and notify console/optional Slack | Close other app, `identify --camera`, provide `--image`, or use `--manual`. |
| Scratched disc / MakeMKV no-progress or disk-wait | No-progress deadline; absolute deadline; repeated read errors | Cancel if possible; `MARGINAL_MEDIA`; quarantine that drive, continue other drives, keep partials | Clean disc, try slower/other drive, raise timeout for this retry, replace disc, or mark missing. |
| Disc info exceeds deadline | `discInfo` timeout | `MARGINAL_MEDIA` after limited retry; no classifier decision | Retry in another drive or override timeout; never block unrelated drives. |
| Printed count vs selected outputs differs | Classifier count gate | `LAYOUT_NEEDS_REVIEW`; no auto-eject/naming | Include/exclude/map titles, correct printed list, preview extras/double episode, then accept. |
| Play-all split wrong or produces one/too few pieces | Split output/count/duration/chapter verification | `SPLIT_NEEDS_REVIEW`; retain verified source play-all | Correct chapter map and `retry --from split`; do not re-rip. |
| Extra is episode-length | Multiple classifier solutions/low margin | `LAYOUT_NEEDS_REVIEW` | Preview and persist include/exclude override. |
| Play-all not exact sum | Sum mismatch but individual count solution exists | May remain `hybrid` with warning; require other evidence and unique count solution | Review table if score margin is insufficient. |
| MakeMKV creates zero/multiple new files | Per-title isolated output ownership check | `RETRYABLE_FAILURE`, preserve directory | Inspect logs/partials, retry title only after fingerprint match. |
| Staging disappears/fills | mount/write/free-space heartbeat | Pause new work; active child cancelled if safe; no eject | Restore volume/free space, validate, resume. |
| Identity/provider ambiguous | Candidate score/mapping not unique | `IDENTITY_NEEDS_INPUT`; neutral capture allowed only by explicit choice | Select provider result/season/episodes or import manual metadata. |
| Eject fails or device changes | Exact-device eject plus media-state confirmation | `EJECT_FAILED`; completion retained but “swap” notification withheld | Manually eject the named drive, then `recover`. |
| Restart with child/state mismatch | PID start identity, manifest and filesystem reconciliation | Adopt owned live child if provable; otherwise safe recovery state | Use `recover`; never create a second rip against an unverified live process. |
| Slack/Gemini/provider unavailable | Auth/network error | Degrade only the optional feature; console/manual flow remains functional | Retry integration later; no rip data is lost. |

Retries are limited and exponential for service/camera/transient operations. Media read
errors do not loop automatically. Notifications are best effort and never drive state
transitions.

## 11. Portability

All executable and destination paths come from config or discovery. Repository-relative
fixtures/assets use URL/path resolution from the installed package, never host-specific
absolute paths. Process arguments are arrays, generated filenames exclude control and
filesystem-reserved characters, and no shell scripts interpolate untrusted metadata.

macOS v3 uses `imagesnap`, IOKit/disk arbitration observations, `diskutil eject`, and `lsof`.
Linux needs adapter implementations for:

- camera enumeration/capture (`v4l2-ctl`/ffmpeg instead of imagesnap);
- stable optical identity and media events (`udev`, `/dev/disk/by-id`, `lsblk`);
- exact-device eject (`eject`/`udisksctl`);
- open-file inspection (`lsof` remains available, `/proc` fallback);
- config/state roots (the selected XDG defaults already fit Linux).

The core robot parser, classifier, project schema, manifests, Gemini/manual identification,
TMDB/import confirmation, ffprobe verification, and mkvmerge split logic are platform
neutral. Platform capabilities are probed; unsupported adapters produce actionable setup
errors rather than fallback guesses.

Gemini and Slack are explicitly optional. Canonical confirmation can use TMDB, another
future provider, or a user-imported JSON/CSV snapshot. A zero-network install supports
manual box metadata, imported episode lists, console progress, ripping, verification,
status, and finalization.

## 12. Stranger-facing README outline

1. **What Ripper v3 does and does not do** — neutral staging, metadata confirmation,
   remux/split/finalize, attended operation, legal/MakeMKV note.
2. **Hardware assumptions** — macOS computer, one or more supported DVD drives, powered USB
   hub guidance for multiple drives, enough staging space, optional webcam/light, scratched
   disc caveat.
3. **Install** — Node/package installation, MakeMKV, ffmpeg/ffprobe, MKVToolNix, optional
   imagesnap; permissions for removable storage/camera; PATH checks.
4. **Setup** — run `ripper setup`, identify identical drives, choose staging/library,
   handheld versus fixed regions, optional Gemini/TMDB/Slack, and `doctor --full`.
5. **Create a whole-series project** — scan/manual title confirmation, choose canonical
   candidate and ordering, understand provider snapshots.
6. **Daily one-drive use** — insert disc, hold/scan the box, approve identification/layout,
   wait for eject, check `status`.
7. **Daily multi-drive use** — friendly drive IDs, per-load scanning, fixed-region protocol,
   concurrency limits, and why boxes must be bound before rip.
8. **Understanding disc layouts** — individual, hybrid, and play-all-only examples; count
   gate; double episodes and extras.
9. **When identification is wrong** — select another provider result, edit S/V parsing,
   import episodes, record an override, and rerun `project reconcile`; never rename neutral
   files by hand without updating the manifest.
10. **When a disc fails** — seated failures, `status`, `logs`, clean/retry/alternate drive,
    marginal-media timeout, split-only retry, safe eject, and replacement-disc workflow.
11. **Finalize and Jellyfin naming** — review plan, conflicts, partial project finalization,
    move/copy behavior, undo/recovery expectations.
12. **Troubleshooting** — camera busy, drive ambiguous/offline, output still open, storage
    disconnected/full, API unavailable, stale state and `recover`.
13. **Privacy/security** — box images sent only when Gemini enabled, secrets outside config,
    redacted logs, Slack message contents.
14. **Linux status** — supported core versus required platform adapters.

## 13. Migration from the current TMNT-specific tool

1. Keep v2 and its data untouched during migration. v3 uses a new config/state schema and
   staging namespace, so an unfinished v2 watcher cannot share locks or drive ownership.
2. `setup` imports current environment values only as suggestions: Seagate staging/library
   roots, exact drive names, camera, model, extras preference, and Slack channel. It removes
   `SHOW_NAME`, A/B, blue/red, hardcoded C920, absolute MakeMKV path, and TMNT canonical-file
   assumptions from runtime code.
3. Convert the TMNT canonical text file into a pinned project `canonical.json` with explicit
   provenance `local-import`; optionally reconcile it with a chosen provider. Never silently
   replace existing titles/codes.
4. Provide a read-only migration report for existing `vol*` and `vol-unknown*` folders.
   Import only manifests whose disc evidence and files can be parsed. Existing neutral
   folders remain neutral until manually/project-confirmed.
5. Specifically flag the 2026-07-20 artifacts: S3V1 and vol14 require split-only recovery;
   S3V2/S3V4 require verification; S3V3 remains an unresolved seated/failure load; the four
   `vol-unknown` folders require season-aware identification. Migration must not re-rip good
   play-all sources or treat `City at War` as an episode.
6. Translate v2 drive state into historical events, not live active states. On first v3 run,
   enumerate/reconcile drives from hardware and media anew, eliminating stranded `SETTLING`
   and ambiguous prefix state.
7. Generate a proposed source-to-load/project mapping and require confirmation before any
   file or manifest write. No library move occurs as part of state migration.

Judgment: side-by-side state is safer than an in-place schema rewrite while valuable neutral
rips and a possibly seated disc exist.

## 14. Phased implementation plan

### Phase 1 — portable safe core (ships first)

- JSON config/schema, non-overwriting `setup`, tool/path/destination discovery.
- Exact N-drive identity, per-drive/global locks, neutral load directories, atomic state and
  event journal.
- `drives`, `doctor`, manual `project create/import`, `scan`, `analyze`, `rip`, `verify`,
  `retry`, `recover`, `eject`, `status`, and plan-only/fail-closed `finalize`.
- Explicit individual/hybrid/play-all classifier with expected-count gate and manual maps.
- Active-state deadlines, MakeMKV progress/no-progress cancellation, marginal-media
  isolation, file-close wait, bounded decode verification, and split-only retry.
- Console-only operation; one drive is the primary acceptance path.

Why first: it fixes every data-loss/deadlock/layout failure without depending on network,
camera, or multi-drive concurrency.

### Phase 2 — projects and authoritative identification

- Gemini structured box contract and season-aware parser.
- TMDB provider adapter, ambiguity UI, canonical snapshots, local import parity, audited
  overrides, and coverage reconciliation.
- Whole-series `status`, partial finalization, canonical filename planning.
- Handheld camera flow with exclusive lock and image fallback.

Why second: metadata automation is useful only after neutral capture and recovery are safe.

### Phase 3 — N-drive attended automation

- `watch`, arbitrary fixed-camera regions, atomic batch snapshots, camera contention flow.
- Scheduler with per-drive isolation and serialized MakeMKV-open gate.
- Hardware acceptance test before allowing `maxConcurrentRips > 1`; powered-hub/bus failure
  documentation.
- Optional Slack threads and notifications.

Why third: concurrency multiplies hardware and binding failure modes and must build on proven
single-drive semantics.

### Phase 4 — hardening and Linux adapters

- Larger fixture corpus for hybrid, doubles, extras, duplicates, bad counts, damaged media,
  non-sum play-all, and restart/open-file cases.
- Full decode verification option, richer preview/contact sheets, provider adapters.
- Linux camera/device/eject/open-file adapters and cross-platform packaging.
- Migration assistant for v2 folders after dry-run fixtures reproduce the 2026-07-20 cases.

## 15. Acceptance criteria

v3 is ready for general sharing only when all of the following pass:

- Fresh one-drive Mac completes setup and a manual/offline project without editing code.
- Re-running setup preserves an existing config unless the user explicitly approves a shown
  merge or writes a new path.
- One-, two-, and three-drive fixtures resolve by exact stable identity after index/eject
  reorder; ambiguous identical drives fail closed.
- `3.1` yields season 3 volume 1 and stable-frame comparison succeeds.
- TMNT fixture selects/splits the play-all; Courage/Batman-style fixture excludes one/two
  play-alls and selects exactly the printed count of individual titles.
- Every listed degenerate classifier case produces the specified review/approval behavior.
- Killing the controller in every active state recovers without a permanent skipped drive,
  duplicate rip, or lost verified title.
- An open output is never ffprobed; a delayed close succeeds without rerip.
- A simulated uninterruptible/scratched-disc job quarantines one drive while another drive
  continues.
- Camera busy, Gemini absent, TMDB absent, and Slack absent all retain a functional manual
  console workflow.
- `status` coverage is computed from verified canonical keys and reports exact missing
  ranges.
- `finalize --apply` cannot overwrite a destination or consume unverified/ambiguous output,
  and cross-filesystem copies are verified before source deletion.

