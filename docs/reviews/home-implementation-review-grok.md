**Verdict:** Home’s hard lifecycle/binding items (#1–#6, #9, #15) and the OCR/trailer pieces mostly look real — not paper claims. Scroll restoration (#12/#13) is broken in practice, and series episode `.catch` can still paint across mounts.

### Correct but subtle
- **#1 route:** `isHomeRoute` is `/^#\/?home(?:[?]|$)/i` — abstains on `""`/`#`/`#/`; does not match `#/home.html`.
- **#2 readiness:** Mount needs route + `ApiClient` + `userId`; `homeAuthTries` retry while on `#/home` without a user; `homeUserTimer` tears down on mid-session user change.
- **#5/#6 hide:** CSS targets `.skinHeader` + `#homeTab`/`#favoritesTab` only — `#streamline-home` is a sibling under `#indexPage`, not hidden.
- **#9 hero:** `Promise.all([continueP, showsP, moviesP])` picks CW[0] else first Series with backdrop; rails degrade independently via `settled`.
- **#15 playItem:** Polls `currentDetailId() === requested` **and** visible `.btnPlay`/`.btnReplay`; `playRequest++` on dispose; no click on timeout.
- **Merge (#10):** Represented-series set only from resumable episodes with `SeriesId`; id dedupe; movies don’t poison the set.
- **Trailer:** Starts `hidden`, polls native `.btnPlayTrailer:not(.hide)`, clicks that control; movie + series share `trailerButton`.
- **extras_ocr:** Plan-only (`writeFile` map); apply/undo via `rename_show.sh`; Gemini JSON schema + fence strip; duration-then-order match; `pgrep makemkvcon` warning.
- **Accent coexistence:** Prior GET-modify-POST clobber and off-queue fetch issues look addressed (`writeAccentPreference` re-GET; `fetchAccent` via `queueAccentWork`); home/detail accent applies are gen/root-guarded.
- **CSS collision:** `#streamline-home` / `#streamline-detail` namespaces don’t share selectors; body active classes are mutually cleared on route change.

---

### Findings

1. **P1 — Scroll restoration self-cancels (binding #13)**  
   `js/theme.js:558-568`, `657`, `760`, `713-718`  
   `restoreHomeState` is scheduled from `mountHome` and every `renderHomeRail`. First run with `homeReturnKey` restores then clears the key; later runs hit `state === null` and force `scrollTop = 0` / rail `scrollLeft = 0`. Even the first run often hits skeleton rails, then `rail.textContent = ''` wipes any `scrollLeft`.  
   **Fix:** Restore once after final rail DOM exists (e.g. end of the `Promise.all` in `loadHome`). Remove restore from `renderHomeRail` / early `mountHome`. If no `homeReturnKey` state, no-op (don’t zero).

2. **P1 — Stale series episode `.catch` can paint a newer mount**  
   `js/theme.js:971`  
   Success path checks `myGen !== gen`; the failure path always clears `episodesWrap` and writes “Could not load episodes.” A slow failed fetch from mount N can clobber mount N+1’s episodes.  
   **Fix:** Guard the catch with `if (myGen !== gen || !mounted || mounted.el !== root) return;` (same as the `.then`).

3. **P1 — Home auth retry can permanently stop on `#/home`**  
   `js/theme.js:805-808`  
   After 80×150ms (~12s) without `userId`, retries stop. A later sign-in that doesn’t change the hash never remounts (no observer until mount; `homeUserTimer` only runs while mounted).  
   **Fix:** While `isHomeRoute() && !userId()`, keep a slow poll or reset `homeAuthTries` on any auth/storage signal; or start a lightweight body observer before first mount that only watches for user/page readiness.

4. **P2 — `cancelTimeout(homeAuthTimer)` orphans entries in `homeTimeoutIds`**  
   `js/theme.js:798`, `72-77`, `78-86`  
   Leaving home cancels the auth timer via `cancelTimeout` (strips `timeoutIds` only). The id can linger in `homeTimeoutIds` until a later `clearHomeTimeouts`.  
   **Fix:** Cancel home timers through a helper that removes from both arrays (or always `clearHomeTimeouts` on route exit).

5. **P2 — Trailer visibility poll treats “no trailer” as “keep waiting”**  
   `js/theme.js:852-857`, `909-914`  
   Loop continues while `trailer.hidden`, so every Series/Movie without a trailer burns the full ~3s poll even after Play is ready. Harmless but noisy.  
   **Fix:** Track `trailerResolved` separately; stop when play is ready and trailer still absent after a shorter budget.

6. **P2 — Home `MutationObserver` is document-wide, not narrow**  
   `js/theme.js:783-794`  
   Binding #4 asked for a narrow `#indexPage` replacement observer. Debounced identity checks prevent spurious remounts, but every SPA mutation still schedules work.  
   **Fix:** Observe the mounted `page` (or its parent) for `childList`/`subtree` removal, with body fallback only if the page node is gone.

7. **P2 — Continue/Movies field lists may under-request image/parent backdrop metadata**  
   `js/theme.js:703-709`, `217-222`  
   CW asks only `Overview`; landscape fallback uses `ParentBackdrop*`. Movies ask only `RunTimeTicks` while UI uses year + Primary art (often defaulted by Jellyfin, not guaranteed).  
   **Fix:** Explicitly add fields used by rendering (`ParentBackdropImageTags,ParentBackdropItemId`, etc.) per binding #18/#20.

8. **P2 — `extras_ocr` map includes all `??` duration/order rows with no apply gate**  
   `scripts/ripping/extras_ocr.mjs:349-388`, `436-454`  
   Plan-only is correct, but weak matches are written into `_extras_rename_map.txt` the same as `high`. A careless `rename_show.sh … apply` renames bad pairs.  
   **Fix:** Omit `??` from the map by default (print them as unmatched), or write a second `*_review.txt` and only map `confidence === 'high'`.

9. **P2 — view.css header comment is stale**  
   `css/view.css:1-2`  
   Still says styles are only for `#streamline-detail`; file now owns home + accent.  
   **Fix:** Update the file banner.

---

### Spot-check of requested binding items

| Item | Status |
|------|--------|
| #1 ambiguous-hash abstention | Implemented |
| #2 sign-in readiness + retry | Implemented; exhaustion edge → finding 3 |
| #4 observer + dispose cancellation | Implemented (`teardownHome` / `dispose` clear observer, home timers, `playRequest`); breadth → finding 6 |
| #5/#6 tab hide without hiding root | Implemented |
| #9 hero orchestration | Implemented |
| #12/#13 back-stack + scroll | Details via `location.hash`; detail Back via `history.back()`; **scroll restore broken** → finding 1 |
| #15 playItem route verification | Implemented |

Trailer + `extras_ocr.mjs` match the stated contracts (no silent rename; plan/undo via `rename_show.sh`; sane OCR parse/match; camera warning). No CSS selector collision between home and detail roots found.
