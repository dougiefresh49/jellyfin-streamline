# Ripper v3 — portable DVD box-set pipeline (MERGED PLAN)

Synthesis of two independent specs, both written 2026-07-20 against the real failure log of
the 2026-07-19/20 session. Read those for full detail; this file is the decision record and
the build order.

- `specs/ripper-v3-gpt.md` — more rigorous on ambiguity: subset search, duplicate playlists,
  DP chapter splitting, ordering-vs-count distinction, phasing, acceptance criteria.
- `specs/ripper-v3-grok.md` — more immediately buildable: crisp bands + decision table,
  config/state schemas, `resplit`, recovery matrix.

## Why v3 exists
v2 works only for its author: two named drives, a blue/red shelf, a hardcoded `SHOW_NAME` and
a hardcoded canonical episode list, absolute Seagate paths. A second person with one drive and
different shows cannot run it. Separately, v2 has three proven defects (see
`docs/media-server-notes.md`, "RIPPER STATE 2026-07-20"): no timeout on in-progress states
(deadlocks a drive forever), season-style "3.1" box numbering breaks volume identification,
and it silently takes ONE title from multi-title discs (Courage: got 1 episode instead of 8).

## Decisions where the two specs differ

1. **Layout classification — take gpt's model, keep grok's bands as the fast path.**
   grok's duration bands (individual / double / play-all / extra) are the readable first cut;
   gpt is right that the final decision must be a *search for a solution whose output count
   equals the expected count*, not a single-pass band match, and that:
   - a play-all's duration NOT equaling the sum of individuals does **not** disprove play-all
     (menus, bumpers, credits vary) — sum similarity is a labeling hint only;
   - DVDs frequently expose **duplicate playlists/angles** of the same episode; these must be
     grouped and de-duplicated before counting, or counts lie;
   - **count agreement never proves ordering.** Title id order ≠ broadcast order. Ordering
     needs disc metadata or content evidence, else an explicit user map.
2. **Refuse-by-default.** Both agree: if predicted output count ≠ expected count, do not rip
   or name — dump the full title table and require an override. Keep this absolutely.
   The owner's rule from manual work ("ignore the one or two big play-alls, count the rest
   against the box") is the *hybrid* branch, and it is the default for Courage/Batman-style
   discs.
3. **Chapter splitting — gpt's constrained search, not equal division.** Must produce exactly
   N contiguous groups within plausible duration bounds, print start/end chapters and
   predicted durations for review before applying. This is what v2 got wrong on `s3v1`
   (1 group) and `vol14` (2 groups instead of ~5).
4. **`resplit --expect-eps N` (grok) ships in phase 1.** It fixes both broken volumes from
   last night without re-ripping. Never re-rip a good source just to retry a split.
5. **Identification — three sources, ranked. PROVEN ON 25 FILES 2026-07-20.**
   Ranked by trustworthiness, because on real discs they disagreed constantly:
   1. **Title cards in the ripped video = GROUND TRUTH.** Build an ffmpeg contact sheet per
      episode file (`-ss 40 -t 200 -vf "fps=1/4,scale=340:-1,tile=6x9"`) and have Gemini read
      the card text off it, prompted to *report only text it can literally read, never infer
      from imagery or memory*. This identified every file, including ones where the box, the
      disc order, and the web all disagreed. Cheap: one vision call per episode, batched.
   2. **TMDb = the numbering authority**, because that is what Jellyfin matches. Fetch the
      season page (`themoviedb.org/tv/<id>/season/<n>`); get `<id>` from the media server's
      own `ProviderIds` when the show already exists.
   3. **Cover/pamphlet lookup (Gemini + web search)** — good for narrowing the candidate set
      and reading the printed volume title. UNRELIABLE for episode numbers: it was wrong on
      every disc tested, and on one disc invented two episodes that were not on it. Use for
      candidates and cross-check only; never name from it.
   Kills hardcoded `SHOW_NAME` + the per-show `.txt`. Must parse season-style volume numbering
   ("3.1") — the thing that made every season-3 box report `volume_number: 3`.

   **Three assumptions the classifier must never make** (each cost us real time):
   - *Volume number ≠ season.* "3.4 Shredder's Final Countdown" and "3.5 Mutants & Monsters"
     are MIXED season-3 + season-4 compilations. Episodes from one disc can land in different
     season folders; the finalizer must support that per-file, not per-disc.
   - *Disc play-all order ≠ broadcast order.* Vol 3.1 plays The Lesson, Hunted, then Space
     Invaders 1-3. Position on the disc proves nothing about episode number.
   - *Catalogue numbering differs between sources.* TMDb's TMNT S3 puts "The Christmas Aliens"
     at E12 (not E01), shifts everything before it down one, and swaps The Lesson/New Blood
     vs Turtlepedia and broadcast order. Always resolve numbering against the server's own
     metadata provider.

   **Verification trap to encode as a test:** comparing a filename's `SxxExx` against the media
   server's episode number ALWAYS passes — the server parses the number from the filename.
   Post-import verification MUST compare the provider's episode **title** to the file's
   content-derived title. This flaw hid ten mis-numbered files until titles were compared.
6. **N drives.** Config lists drives; slot/shelf-dot binding becomes optional metadata that
   only exists for multi-drive attended runs. With one drive there is no slot concept: scan
   the box you're holding, then rip. Single drive is the DEFAULT assumption for a stranger.
7. **Everything optional stays optional.** Slack and Gemini absent → tool still rips and
   finalizes, with identification falling back to manual entry.

## Build order (phased)

**Phase 1 — portable safe core.** `setup` wizard (detect drives/tools/camera, write user
config, never silently overwrite), config file replacing all absolute paths, single-drive
support, the layout classifier + verify gate, `resplit`, and the timeout/recovery fixes below.
At the end of phase 1 the friend can rip a box set with manual identification.

**Phase 2 — projects + identification.** Persistent per-series project state (which discs and
episodes are done, what's missing), `status` showing "S2: 17/26 — missing E18–26", the
three-source identification of decision 5 (title-card OCR as ground truth, TMDb for numbering,
cover lookup for candidates), per-file season routing, and post-import title verification.
A working prototype of the title-card step already exists: `scripts/ripper/dvd-lookup.mjs`
(cover + web search) plus the contact-sheet/Gemini card reader used on 2026-07-20.

**Phase 3 — multi-drive attended automation.** Re-introduce the shelf/slot camera flow as an
opt-in for people with 2+ drives, now on top of a state machine with timeouts.

**Phase 4 — hardening + Linux adapters, docs for strangers.**

## Non-negotiable robustness fixes (all observed, phase 1)
| Failure seen | Fix |
|---|---|
| Drive deadlocked in `SETTLING` 2+ hrs, no worker running | Every in-progress state carries a deadline; on expiry → `NEEDS_ATTENTION` with the reason. No state without a timeout. |
| `verify failed: file is open by another process` | Verification waits for the writer to close (lsof/size-stable poll) before probing. |
| `makemkvcon` hung 12 min in uninterruptible disk-wait, blocking all drives | Per-operation timeouts; a marginal disc degrades ITS drive only, never blocks others. |
| "Drive prefix matched 2 drives" after eject | Match drives by stable identity, not name prefix; re-resolve on every media change. |
| Shared webcam contention broke settle frames | Camera is a named exclusive resource; wait or fail cleanly with the reason. |
| Multi-title disc silently yielded 1 episode | The verify gate above — predicted count must equal expected count before any write. |

## Migration
v2 stays as-is until phase 1 passes on a real box set. First real test: re-split `s3v1` and
`vol14`, then finalize the four unfinished season-3 volumes.
