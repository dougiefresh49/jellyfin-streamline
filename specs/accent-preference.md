# Spec: per-user accent color (Streamline) — v2 (gpt spec-review fixes applied)

## Goal
The accent (`--sl-accent` / `--sl-accent-ink` in `css/view.css`, used by the injected
`#streamline-detail` view) becomes a per-user preference, choosable from a preset palette in
the user's Display settings page. Same injected-JS approach — no server plugin.

NOTE: names here assume the kids→Streamline rename has landed (`#streamline-detail`, `sl-`
prefix, `window.__streamlineTheme`). Implement AFTER that rename; if any `kd-`/`kids` name is
still present, stop and report instead of guessing.

## Presets (pinned)
| id     | accent  | ink     |            |
|--------|---------|---------|------------|
| violet | #7c5cff | #0a0713 | (default)  |
| sky    | #38bdf8 | #041018 |            |
| mint   | #34d399 | #04150c |            |
| amber  | #fbbf24 | #1a1002 |            |
| coral  | #fb7185 | #1c040a |            |
| mono   | #e2e8f0 | #0b0b0d |            |

## Storage — per-user, server-side (verified on the installed 10.11 bundle)
DisplayPreferences CustomPrefs, key `streamlineAccent` = preset id. Pinned calls:
```js
ApiClient.getDisplayPreferences('usersettings', userId, 'emby')                     // GET  /DisplayPreferences/usersettings?userId=<uid>&client=emby
ApiClient.updateDisplayPreferences('usersettings', displayPrefs, userId, 'emby')    // POST  same
```
GET-modify-POST the whole object so other CustomPrefs are preserved. `ApiClient.ajax` is a
documented fallback only.

- **Write serialization (review #3/#6):** one save queue; each tap gets a monotonically
  increasing selection generation; only the latest generation may update final UI/cache/server
  state. Never issue overlapping GET-modify-POST cycles.
- **Optimistic UI with rollback (#7):** tapping shows the selected state immediately, but
  localStorage + in-memory cache commit only after the POST succeeds; on failure, roll the
  ring back to the previous confirmed value (silent otherwise — never break the native page,
  but never falsely report persistence).
- **Native-form coordination (#3):** the native Display page holds its own settings object and
  POSTs it on Save, which can drop `streamlineAccent` (or our POST can clobber its save).
  Attach a `submit` listener to the native form; after a native save settles (short delay),
  GET the prefs and, if `streamlineAccent` is missing/stale, re-merge and re-POST once
  (through the same serialized queue).
- **Cache:** in-memory per (serverId, userId) with one deduped in-flight GET (#13); mirror in
  localStorage key `streamline.accent.<serverId>.<userId>` (#12) for instant paint.
- **Server value wins (#5):** a SUCCESSFUL server response with absent/invalid id clears the
  cached value, removes any inline `--sl-accent*` overrides from a mounted root, and resets
  the picker to violet. A FAILED request keeps the cached value.

## Applying it
- Central `applyAccent(root, presetId)` sets/removes `--sl-accent`/`--sl-accent-ink` inline on
  the container (#14). `mountSeries` applies the cached value synchronously, then the deduped
  async GET refreshes (guarded by the existing `gen` counter). Unknown/absent id → remove
  overrides (CSS violet default applies). Live update of an already-mounted detail view is NOT
  required — next mount picks up the new value.
- **Auth lifecycle (#11):** no pref request and no user-keyed localStorage access when
  `getCurrentUserId()` is null; invalidate the in-memory cache when the user id changes;
  gen-guard responses from a previous user; picker and overrides removed on logout. The detail
  view always uses the authenticated CURRENT user.

## Picker UI (route verified: `#/mypreferencesdisplay`, links carry `?userId=<uid>`)
- Parse the hash query with `URLSearchParams` (#9); extra params are fine. The picker
  reads/writes the route's TARGET `userId` (admins can edit another user, #4), falling back to
  the current user; if the target GET fails/unauthorized, omit the picker entirely.
- Append ONE section (`#streamline-accent-picker`) to the settings form: heading
  "Accent color" + a `role="radiogroup"` of 6 round swatch buttons — every one
  `type="button"` (inside a native `<form>`, anything else submits it, #10) with
  `role="radio"`, `aria-checked`, `aria-label` = preset name, ≥36px, accent-filled, visible
  selected ring PLUS a non-color indicator (✓), keyboard focus styling. Styles in
  `css/view.css` under `.sl-accent-picker`; reuse native `.verticalSection`/heading classes to
  blend, guarded if absent.
- **Lifecycle (#8):** `hashchange` alone is insufficient — the Display controller rebuilds its
  form without a hash change. Attach to the page's `viewshow`/`viewhide`/`viewdestroy` events
  (verify exact names in the bundle) or use a narrowly-scoped MutationObserver to remount the
  picker if the form is replaced. Id-guard against duplicates; every listener/observer
  disconnected in `dispose()` and on route exit; all failures degrade silently.

## Out of scope
Server-wide/dashboard default (the CSS default covers it), custom non-preset colors, theming
of stock pages, live re-theme of a mounted view.

## Verification
- curl round-trip of CustomPrefs with commands REDACTED (`$TOKEN` placeholders, never literal
  tokens, #15); verify with a NON-admin user token too (admin token only proves admin auth).
- In-browser: pick amber as user X → next detail mount shows amber without full reload；
  reload → persists; second user unaffected; native Display Save does not erase the accent.
