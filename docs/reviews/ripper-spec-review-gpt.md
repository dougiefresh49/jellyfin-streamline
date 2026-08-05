## Findings

### 1. Critical — `watch`: disc and box identity are never atomically bound

**Failure mode:** Disc detection starts an eight-second timer, after which the camera reads the shelf. A user can insert a disc and replace its box slightly later, replace the box before inserting the disc, or swap both drives in stages. The pipeline can therefore associate a new disc with the previous box. The fuzzy volume-label warning is not a reliable safety barrier because many DVD labels are generic, truncated, or unrelated to the printed volume title. Since low-confidence OCR explicitly does not block ripping, this can silently produce confidently misnamed files.

**Suggested fix:** Introduce an immutable `load_id` per drive and a positive “load is stable” condition. For example:

- Detect tray transition/open-close, then disc insertion.
- Wait until the same physical device and disc fingerprint are observed twice.
- Capture two camera frames a few seconds apart and require the applicable slot to be stable.
- Bind `{load_id, physical_device_id, disc_fingerprint, slot, scan_id, OCR result}` before starting the rip.
- If the identity checks disagree, enter `NEEDS_ATTENTION`; rip into a neutral directory if desired, but never assign an OCR-derived name.

An explicit “both discs and boxes ready” command/button would be even safer than a timer.

---

### 2. Critical — `finalize`: title-number order is not episode order

**Failure mode:** Sorting `title_tNN.mkv` by title number and pairing it with box episode order can assign valid episode names to the wrong videos. DVD title-table order is authoring-dependent and can include duplicate angles, alternate playlists, hidden titles, or an order different from the box. Duration and file-size verification cannot detect this because all three episodes are approximately equal length.

This is the most dangerous failure because the resulting library looks complete and correctly named.

**Suggested fix:** Treat title-to-episode correspondence as unverified metadata. Persist a manifest containing title ID, MakeMKV output name, duration, chapter count, size, and any source-title name. Before applying final names, require one of:

- A manual preview/contact-sheet confirmation for each disc.
- Episode identification using sampled frames/subtitles/audio and the canonical episode list.
- A verified per-volume mapping table established during testing.

Never let fuzzy title-name matching plus `tNN` ordering automatically authorize moves.

---

### 3. Critical — Layout/Error philosophy: OCR uncertainty is allowed to become authoritative naming

**Failure mode:** A confidence below 0.6, malformed episode list, hallucinated volume number, missing slot, or OCR service failure “never blocks the rip,” but `finalize` later consumes `episodes.md`. Model-supplied confidence is not calibrated and does not establish correctness. A plausible hallucination could fuzzy-match a canonical title and silently rename the wrong video.

**Suggested fix:** Separate capture from authority:

- Rip under a neutral, disc-fingerprint-based directory.
- Mark OCR metadata `unverified` unless it passes schema validation and deterministic cross-checks.
- Require the OCR episode count to agree with the selected-title count.
- Never allow fallback/low-confidence metadata into `finalize --apply` without explicit approval.
- Preserve the raw model response and image for audit.
- Make `finalize` fail closed on ambiguous fuzzy matches, duplicates, count mismatches, or unverified scans.

“Keep ripping” is reasonable; “keep naming” is not.

---

### 4. High — `watch`: the state machine omits failure and recovery states

**Failure mode:** The documented machine only has `EMPTY → DISC_DETECTED → SCANNED → RIPPING → DONE → EMPTY`. It does not define OCR failure, MakeMKV scan failure, partial-title failure, verification failure, eject failure, camera contention, target-volume loss, or a drive disappearing. It is consequently unclear whether a failed disc is retried forever, ejected, mistaken for a new insertion, or stranded in `RIPPING` after a restart.

**Suggested fix:** Define explicit states and legal transitions, at minimum:

`EMPTY`, `SETTLING`, `IDENTIFYING`, `READY_TO_RIP`, `RIPPING`, `VERIFYING`, `COMPLETE`, `EJECTING`, `AWAITING_REMOVAL`, `RETRYABLE_FAILURE`, `NEEDS_ATTENTION`, `DRIVE_OFFLINE`.

Persist current stage, attempt number, child PID, selected titles, completed titles, output paths, failure reason, and retry deadline. Specify retry limits and whether human intervention is required. A failed or unverified rip should normally remain loaded rather than ejecting automatically.

---

### 5. High — MakeMKV drive identity: `disc:N` is not a durable drive mapping

**Failure mode:** `disc:N` is an enumeration index, not a persistent physical-drive identity. Enumeration can change after unplugging a USB drive, a drive going offline, or possibly tray/media changes. Restart recovery could therefore send drive A’s job to drive B. Running a separate `info` enumeration while another instance is ripping may also touch or pause other optical drives; users have reported exactly that behavior.

**Suggested fix:** At startup, map configured drives to stable macOS device paths and hardware identifiers, then invoke MakeMKV with `dev:<DeviceName>` if supported by the installed drive stack. The installed CLI’s usage explicitly supports both `disc:<DiscId>` and `dev:<DeviceName>`. Revalidate serial/vendor/product/device path before every operation and refuse a changed mapping.

Do not store only `disc:N` in state.

---

### 6. High — Verified-environment facts: concurrent CLI instances are overstated as “supported”

**Failure mode:** Multiple instances on separate drives are widely used, but the spec treats interference-free concurrent CLI behavior as settled. MakeMKV users report that starting/scanning another instance can touch every drive and temporarily pause an active rip. The commonly recommended GUI protection is “Ask for single drive mode,” while a CLI user reports that `--noscan` avoids the interference; this needs validation on this exact macOS installation rather than assumption. [MakeMKV multi-instance discussion](https://forum.makemkv.com/forum/viewtopic.php?t=35438), [CLI drive-scanning report](https://forum.makemkv.com/forum/viewtopic.php?t=35728).

**Suggested fix:** Make concurrency an acceptance test:

1. Start a long rip on A.
2. Repeatedly enumerate, inspect, load, and eject B.
3. Confirm A does not pause, error, or change device.
4. Test commands using stable `dev:` sources and `--noscan`.
5. Record the installed MakeMKV version and exact successful command lines.

If interference persists, serialize MakeMKV disc-opening/scanning while allowing already-open ripping processes to continue, or run persistent drive-pinned workers.

---

### 7. High — `rip`: per-title output ownership and partial success are underspecified

**Failure mode:** Each MakeMKV invocation writes into the same volume directory. The spec does not define how it determines which file was created, handles an existing filename, distinguishes a partial file from an older valid file, or records that title 0 succeeded before title 1 failed. Restarting into a fresh attempt directory avoids overwriting but can leave valid titles split across attempts and makes “all expected files = done” ambiguous.

**Suggested fix:** Give every title invocation its own temporary directory, for example `attempt-N/title-<id>.partial/`. On success:

- Identify exactly one newly created MKV.
- Verify it.
- Atomically move it into the attempt’s completed directory with a pipeline-owned deterministic name.
- Record completion in the manifest.

On restart, reuse individually verified titles only when their source disc fingerprint and selection manifest match. Ignore files still open by MakeMKV and never infer success merely from file count.

---

### 8. High — Title selection: duration heuristics cannot reliably distinguish episodes from extras or duplicates

**Failure mode:** Extras can be 15–35 minutes, episodes can be combined, and duplicated episode playlists can have identical duration. The “play-all is approximately the sum of the others” test is also mostly ineffective with the stated 35-minute upper bound: a three-episode play-all is excluded before that heuristic runs. Multiple overlapping compilation titles can make the sum test drop the wrong item.

**Suggested fix:** Treat selection as a scored decision, not an automatic truth:

- Use expected episode count from verified box/canonical metadata.
- Include chapter count, segment map/playlist information, title name, size, and exact duration.
- Detect near-duplicate titles.
- Log why each title was included or excluded.
- If the survivor count differs from the verified episode count, enter `NEEDS_ATTENTION` or rip all plausible candidates into neutral names.

Do not assume every sub-15-minute title is unwanted; make the threshold a default filter with an audit trail.

---

### 9. High — `rip`: verification is too weak to establish a usable rip

**Failure mode:** A corrupt, truncated, or wrong-title file can exceed 200 MB and have an apparently correct container duration. `ffprobe` metadata inspection does not necessarily decode the streams. The target disk can also fill or disconnect between titles.

**Suggested fix:** Before starting, estimate required free space with headroom. After each title:

- Require successful MakeMKV exit and a recognized success message.
- Confirm the file is closed.
- Run `ffprobe -v error` over all streams.
- Perform at least a bounded decode check near the beginning, middle, and end.
- Validate video and audio stream presence and nonzero timestamps.
- Flush/sync before declaring success if removable-storage reliability matters.

A verification failure must not transition to `DONE` or eject automatically.

---

### 10. High — OCR/Gemini contract lacks strict schema and adversarial parsing rules

**Failure mode:** “Strip markdown fences and parse JSON” does not handle prose before/after JSON, truncated responses, duplicate slots, wrong types, `NaN`, episode objects instead of strings, invented empty boxes, repeated synopsis lines, or a response for both slots when only one was requested. A simple greedy bracket extraction can also accept unrelated arrays. Model updates can alter formatting.

**Suggested fix:** Use the SDK’s structured-output controls if supported by the pinned model: JSON response MIME type plus a response schema. Then validate locally with a strict schema:

- Exactly one result per requested, visibly present slot.
- `slot` enum and unique.
- Bounded integer/string volume number.
- Nonempty trimmed episode strings with sane count limits.
- No unknown properties.
- Finite confidence in `[0,1]`.
- Explicit `box_present`, `uncertainties`, and per-field confidence/evidence.

Reject the whole association on invalid JSON rather than salvaging fragments. Store raw response, model name/version, prompt version, and image hash. Add retry prompts that include validation errors, with a hard retry limit.

---

### 11. Medium — `scan`: one photo can describe a different moment for the unrequested slot

**Failure mode:** The camera sees both boxes, but `watch` processes only the slot whose disc was just detected. If both discs arrive close together, A’s job may use photo 1 and B’s job photo 2. A box moved between photos can yield a cross-time pairing that never existed as a coherent two-drive setup.

**Suggested fix:** When either drive changes, capture a full-rack snapshot and create one scan transaction for both slots. Bind both observed slots to the same `scan_id` and timestamp. If a second load occurs during identification, invalidate the scan and recapture after both slots are stable. Serialize the entire identify-and-commit transaction, not only camera/Gemini calls.

---

### 12. Medium — Box-swap protocol: simultaneous swaps are safe only under an unstated invariant

**Failure mode:** Swapping both at once is not inherently unsafe if each new box is placed in the slot corresponding to the physical drive. It becomes unsafe because the program has no way to know when the two-disc/two-box transaction is complete. Tray closure and box placement are separate human actions.

**Suggested fix:** State the invariant explicitly: “Do not close either tray until both new boxes occupy their correct slots,” or provide a positive ready action after both swaps. The software should capture one stable full-rack transaction after that point. If convenience requires independent swaps, use per-slot visual markers that remain attached to each disc/box pair or add a barcode/QR confirmation.

---

### 13. Medium — MakeMKV robot parsing must be CSV-aware and code-aware

**Failure mode:** Splitting `MSG`, `TINFO`, `CINFO`, or `DRV` lines on commas breaks quoted messages and values containing commas. Apostrophes are harmless; commas, quotes, backslashes, empty fields, and localized human-readable text are the actual risks. `PRGV` is numeric progress data, while `MSG` text should not be the primary success/failure contract.

**Suggested fix:** Implement the documented robot records as a real quoted-field parser and dispatch by record prefix and numeric field code. Preserve raw lines. Base control flow primarily on process exit status plus structured record codes, not English message substrings. Pin fixtures captured from the installed MakeMKV version for:

- Commas and escaped quotes.
- Empty fields.
- DVD titles with punctuation.
- Read errors.
- Partial saves.
- Successful completion.
- `PRGV` reset between titles.

The installed binary currently describes `-r/--robot`, `info`, single-title `mkv`, and `dev:`/`disc:` sources, but its terse usage does not document record-field semantics; those must be fixture-tested and version-pinned.

---

### 14. Medium — MakeMKV flags are not sufficiently pinned down

**Failure mode:** The spec assumes `--cache=1`, `--noscan`, and `--minlength=900` behave as intended in these exact command positions and that `--minlength` affects a specifically requested title. `--minlength` is principally useful during title discovery/filtering; it does not add meaningful protection after the program has already selected an explicit title. `--noscan` may be important for multi-drive isolation, but its interaction with `disc:N` enumeration is precisely what must be tested.

**Suggested fix:** Pin:

- MakeMKV version.
- Exact accepted syntax and units for every option.
- Whether options must precede the command.
- Whether `--noscan` works reliably with `dev:` and `disc:`.
- Whether `--cache=1` is beneficial or harms throughput.
- Whether `mkv ... all` is accepted and what `--minlength` filters in that mode.

Remove redundant `--minlength` from explicit per-title rips unless testing proves a benefit. Do not add `--directio` speculatively; benchmark it only if there is a demonstrated I/O problem.

---

### 15. Medium — Disc-label comparison is not a robust box/disc mismatch detector

**Failure mode:** `CINFO`/`DRV` may expose a filesystem or metadata label such as a product code, generic series name, or blank string—not the printed volume title. A fuzzy contains-match will produce false warnings and false reassurance. Two volumes may share essentially the same label.

**Suggested fix:** Build a stronger disc fingerprint from stable observable data: physical device, filesystem volume ID/label, title count, ordered title durations, sizes, chapter counts, and optionally MakeMKV disc metadata. Persist known fingerprints after manual confirmation. Treat label matching only as a weak signal, never as authorization for naming.

---

### 16. Medium — Eject semantics and notification ordering can mislead the operator

**Failure mode:** The spec says to eject and then post “done,” but does not require eject success. `drutil eject` without an explicitly resolved target risks acting on the wrong drive. If ejection fails, Slack still tells the user to swap. If Slack is down and trays are open, the operator has no durable indication of which load completed successfully.

**Suggested fix:** Eject by validated physical device, verify the drive becomes tray-open/no-media, and only then send the “swap” message. Otherwise enter `EJECT_FAILED` and send a different message. Include slot color, physical drive description, and `load_id` in the console and notification.

---

### 17. Medium — Process ownership and single-controller locking are absent

**Failure mode:** Two `watch` processes, or a manual `rip` alongside `watch`, can operate on the same drive and state file. A crash can leave `makemkvcon` running while the restarted watcher starts another rip. Concurrent state writes can corrupt `state.json`.

**Suggested fix:** Use:

- A global watcher lock.
- A per-drive operation lock.
- Atomic state writes via temporary-file-plus-rename.
- PID and process-start metadata.
- Restart reconciliation that checks whether the recorded child still exists and whether it owns an open output file.
- A command policy preventing manual `rip` from taking a drive owned by `watch`.

---

### 18. Medium — `finalize --apply`: rename-map format cannot safely represent every filename

**Failure mode:** The existing script uses `|` as an unescaped delimiter and writes undo commands with raw double-quoted paths. A source or generated title containing `|`, `"`, `$`, backticks, or a newline can break parsing or produce an unsafe/incorrect undo script. It also does not check whether a destination already exists before `mv`, so platform behavior may overwrite an existing library file.

**Suggested fix:** Constrain/sanitize generated filenames and explicitly reject delimiter/control characters. Before apply, require unique sources and destinations and fail if any destination exists. Prefer a structured manifest consumed by a safer renamer; if retaining the current script, define its restricted character contract in this spec.

---

### 19. Low — `doctor` does not test the risky integrations it claims are ready

**Failure mode:** A tiny text-only Gemini call does not verify the configured vision model, image upload, structured JSON response, or box-reading prompt. Slack `auth.test` does not prove the bot can post to the configured channel. Drive enumeration alone does not validate stable A/B mapping or concurrent isolation.

**Suggested fix:** Distinguish basic and full doctor checks. The full preflight should process a saved test image using the configured OCR model, validate the schema, optionally post and delete/mark a test Slack message, verify write/free-space behavior on the Seagate volume, and exercise each physical drive using the exact production source syntax.

---

## Answers to the open questions

1. **Cheap presence polling:** Prefer a macOS-native, read-only drive/tray status poll, provided its output is fixture-tested for empty, tray-open, loading, unreadable-disc, and mounted-disc states. Do not periodically invoke MakeMKV while the other drive is ripping until interference tests pass. Use MakeMKV only after a native transition indicates a stable inserted disc. `--directio` is not a presence-poll solution.

2. **Per-title versus `all`:** Per-title is safer for avoiding known unwanted titles but pays repeated disc-open/analysis overhead and increases the number of opportunities for drive interference. A better design is one analysis followed by a persistent operation if MakeMKV permits it; the CLI does not expose that cleanly. For this small collection, start with per-title and measure. If re-analysis is substantial, `all` into an isolated attempt directory is operationally simpler, but do not auto-delete extras/play-all—classify them and retain them pending verification.

3. **Robot parsing:** Use a proper quoted CSV-style parser. Commas and escaped quotes matter; apostrophes do not. Do not parse localized `MSG` prose for core state. Pin captured fixtures and numeric codes to the installed version.

4. **Flash-lite versus flash:** Use structured output plus schema validation first. Evaluate both models against a small labeled corpus of real box photos, including glare, one empty slot, two boxes, rotated boxes, and small red volume squares. Choose by exact field accuracy, not subjective readability or self-reported confidence. Escalate to the stronger model only when the lite result fails validation or disagrees across repeated crops.

5. **Both drives finishing and being swapped together:** The current state machine cannot guarantee correct pairing. It is safe only if both boxes are placed correctly before the software captures a single stable snapshot of the completed swap. The present per-drive detection plus eight-second delay permits cross-time mispairing and needs a transaction/handshake as described above.
