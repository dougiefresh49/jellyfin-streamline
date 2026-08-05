**Review based on working-tree reads** (`js/theme.js`, `css/view.css`, `scripts/webdir/*`, specs/docs listed). `git diff HEAD` could not run in Ask mode (shell rejected), so this is a full-file review of those changes plus rename/security greps—not a line-diff against `HEAD`.

---

### Correct but subtle (brief)

- **Save generations + serial queue** (`saveAccent` + `queueAccentWork`): skipping stale gens before GET/POST is sound; serialization prevents overlapping GET-modify-POST cycles for saves/reconcile.
- **Optimistic UI vs cache**: swatch updates immediately; `commitAccent` / localStorage only after successful POST; failure rolls the ring back to `confirmed`.
- **`el()`**: `html` intentionally unsupported; server strings go through `textContent`.
- **Auth gate**: no pref/localStorage work when `getCurrentUserId()` is null; cache wiped on user id change.
- **webdir happy path**: `rsync` then inject means the strip sed is a no-op on a pristine `index.html`.
- **Rename**: no `kd-` / `__kids` / `#kids` in JS/CSS; remaining “kids” hits are repo path / Netflix-reference wording only.
- **JS ↔ CSS**: all runtime `sl-*` / accent-picker classes exist in `view.css` (unused `.sl-ep-more` only).

---

### Findings

1. **P0 — Accent GET-modify-POST can clobber other Display preferences**  
   `js/theme.js:270-284`  
   `saveAccent` GETs the whole prefs object, sets `streamlineAccent`, POSTs the whole object. If the native Display Save (or another writer) commits between that GET and POST, our POST rewrites stale fields and can undo clock/theme/layout changes the user just saved.  
   **Fix:** Keep the serial queue; immediately before `updateDisplayPreferences`, re-GET and merge **only** `CustomPrefs.streamlineAccent` (or merge accent into the freshest `CustomPrefs` and leave other top-level fields from the latest GET). Optionally disable swatches while a native save is in flight / run accent saves only via the same submit path.

2. **P1 — `fetchAccent` is outside the save queue (stale GET can win)**  
   `js/theme.js:104-124`, `324-356`, `270-284`  
   Picker mount/remount calls `fetchAccent` off-queue while saves/reconcile are on `accentQueue`. A remount GET started before a save POST finishes can `commitAccent` an older value into memory/localStorage after the newer POST.  
   **Fix:** Route `fetchAccent` through `queueAccentWork` (same pipeline as save/reconcile), or invalidate/ignore fetch results with a mount generation tied to `accentSelectionGen`.

3. **P1 — Native-form reconcile may never run**  
   `js/theme.js:351-352`, `289-307`  
   Reconciliation is only on `form` `submit`. If 10.11 Display Save is a button/`ApiClient` path that does not fire `submit`, native Save can drop `streamlineAccent` permanently.  
   **Fix:** Verify on live 10.11 whether Save fires `submit`. If not, also hook the real Save control click / `viewhide` after save, or patch into the page’s prefs model before its POST.

4. **P1 — Greedy marker-strip is a latent `index.html` footgun**  
   `scripts/webdir/build-webdir.sh:46-50`  
   **Safe today:** `rsync -a --delete "$SRC/" "$DEST/"` restores pristine `index.html` first, so strip is a no-op and inject is clean.  
   **Latent:** After one successful inject there are **two** `<!--streamline-start-->…<!--streamline-end-->` blocks on one minified line. Running the strip **without** a pristine restore matches first start → last end and deletes everything between head and body injections (the whole app shell). Spec comments treat strip as the idempotency mechanism—so this is a landmine.  
   **Fix:** Distinct markers (`streamline-head-*` / `streamline-body-*`), or non-greedy removal (Perl/`python3`), or drop strip and rely only on rsync + document that.

5. **P1 — Document-wide `MutationObserver` while on Display**  
   `js/theme.js:365-371`  
   Observing `document.body` with `subtree: true` re-enters `mountAccentPicker` on unrelated SPA mutations → extra `fetchAccent` traffic, dispose/remount churn, risk of fighting the native form rebuild. Unlikely to hard-break the page (hash/`isConnected` guards help) but fragile.  
   **Fix:** Observe `#displayPreferencesPage` (or the form’s parent) only; debounce remount; prefer Jellyfin `viewshow`/`viewdestroy` if present in the bundle.

6. **P1 — Selector drift fails closed for picker, but is unverified**  
   `js/theme.js:327` (`#displayPreferencesPage form`)  
   Not recorded in `docs/jellyfin-10.11-notes.md`. Wrong/missing node → silent omit (OK); a wrong match → injecting into the wrong form (bad). Detail hijack selectors (`.mainDetailButtons .btnPlay`, etc.) are the same class of risk if 10.11.11 ≠ verified markup.  
   **Fix:** Confirm selectors on the live bundle; pin them in `jellyfin-10.11-notes.md`; keep fail-soft behavior.

7. **P2 — `reconcileNativeSave` uses `confirmed`, not latest selection**  
   `js/theme.js:294`  
   Usually OK because reconcile is queued after in-flight saves. If you ever run reconcile without going through the queue, a native Save during an optimistic tap could re-POST the old `confirmed`.  
   **Fix:** Prefer `picker.selected` (or “latest successful gen”) as `desired`, still inside the queue.

8. **P2 — Logout / user-null does not always drop the observer**  
   `js/theme.js:54-64` vs `358-363`  
   `checkAuth()` disposes the picker on logout but only `updateAccentRoute` disconnects `accentObserver`. Stays live until hash change.  
   **Fix:** Disconnect observer inside the `!current` branch of `checkAuth` (or a shared `teardownAccentRoute()`).

9. **P2 — Uncleared `setTimeout`s / init `setInterval`**  
   `js/theme.js:290`, `512`  
   Reconcile timers and the ApiClient-wait interval are not cleared in `dispose()`. Reinjection/`dispose` before `init` can leave a stray interval that still calls `init()`.  
   **Fix:** Track timer ids; clear them in `dispose()`.

10. **P2 — webdir launch/plist polish**  
    `launch-jellyfin.sh`, `com.jellyfin.streamline.plist`  
    Paths/quoting/`pgrep` refuse-to-double-start look correct; plist matches the same flags with `REPLACE_WITH_HOME`. Missing: binary existence checks; launch script does not verify injected markers in `index.html`; `KeepAlive` can tight-loop if the process exits immediately (port/FDA).  
    **Fix:** `[[ -x $JELLYFIN ]]`; grep for `streamline/theme.` in `index.html` before launch; document not to run launcher + LaunchAgent together.

11. **P2 — Docs/rename nits**  
    `README.md` still says production delivery / accent pick are undone; `docs/media-server-notes.md:20` says “kid overlay”; `css/view.css:99` `.sl-ep-more` unused.  
    **Fix:** Sync README “Where we are”; rename wording; delete dead CSS.

12. **P2 — Security: clean on injected theme path**  
    No `innerHTML` with API data; images via `ApiClient.getImageUrl`; hero URL via `JSON.stringify` inside `url(...)`; no tokens in theme code. `docs/verification-recipe.md` correctly uses `<TOKEN>` placeholders (do not paste real tokens into commits).  
    **Fix:** None required for ship of `theme.js`; keep tokens out of the repo.

---

### webdir scripts — failure modes (summary)

| Path | Result |
|------|--------|
| Missing `SRC` / assets | Loud `exit 1` — good |
| Mid-run after rsync, before sed | Unthemed but valid client — acceptable |
| `rsync --delete` while serving | Brief 404s on old hashed assets — expected |
| Sed inject without prior rsync | **Catastrophic** (finding 4) — latent |
| Launch with unbuilt DEST | Refused — good |
| Second jellyfin already up | Refused, no kill — good |

---

### Ship call

No crash-level P0 in the happy-path webdir build, but **finding 1 is a real P0 for Display settings integrity** if accent taps interleave with native Save. Fix 1–3 (and ideally 4–5) before calling accent + delivery done; 4 is mandatory before anyone treats strip-as-idempotent without rsync.
