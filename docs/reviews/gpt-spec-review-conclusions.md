`window.ApiClient` is still assigned by Jellyfin Web 10.11 and is used throughout the stable client. That makes it viable for a version-pinned injection, but it is a legacy internal global rather than a stable extension API. It may be temporarily absent during startup, logout, server switching, or connection recovery.

Prefer its methods:

```js
const apiClient = window.ApiClient;
const userId = apiClient.getCurrentUserId();

apiClient.getItem(userId, itemId);
apiClient.getNextUpEpisodes(options);
apiClient.getSeasons(seriesId, options);
apiClient.getEpisodes(seriesId, options);
apiClient.getImageUrl(...);
```

This avoids base-path and token mistakes.

For manual `fetch`, do not describe “the session token” abstractly. Specify:

- how the active server base URL is obtained;
- how the current user and access token are obtained;
- the `Authorization: MediaBrowser ... Token="..."` header;
- behavior under a configured Jellyfin base URL;
- server-switch invalidation;
- handling of 401/403.

Do not extract and persist tokens in custom storage.

### Image URLs

Do not manually concatenate `/Items/{id}/Images/...` against `location.origin`; Jellyfin can use a base URL or a different connected server.

Use `ApiClient.getImageUrl()` or `ApiClient.getUrl()` and include image tags and sizing parameters for caching, for example `tag`, `maxWidth`, and quality as appropriate.

An `api_key` query parameter is not universally required for ordinary authenticated item-image requests, but assuming unauthenticated image access is unsafe across server configuration, proxies, and endpoints. The client’s image URL helper is the correct compatibility path because it handles the active server and established Jellyfin conventions. Avoid placing tokens in image URLs unless the tested client/server combination actually requires it: query-string tokens leak into logs, caches, screenshots of network panels, and proxy telemetry.

## 4. Cleanup and teardown

The spec needs a concrete ownership model.

Per mounted detail view, teardown must:

- abort all outstanding requests;
- invalidate stale promises;
- remove its DOM;
- restore exactly the native elements it hid;
- remove classes and inline styles it added;
- remove click/change/scroll listeners;
- disconnect view-specific observers;
- cancel timers, animation frames, and debounced callbacks;
- revoke object URLs if any;
- close or remove custom menus/dialogs;
- restore scroll/body overflow and focus state.

Store the original hidden state per element. Do not blindly set `display: block` on cleanup; the element may originally have been hidden or use a different display mode.

The document-level route controller should remain installed until full script disposal/logout. Make reinjection safe by using a global versioned sentinel with a `dispose()` method. Otherwise repeated DevTools injection or proxy duplication will install multiple hash listeners and observers even though only one `#streamline-detail` is visible.

Favorite mutations also need teardown-safe optimistic behavior and rollback. Use Jellyfin’s authenticated favorite/user-data API rather than changing only the icon.

## 5. Additional risks and missing requirements

### CSP and injection delivery

DevTools evaluation proving that the UI renders does not prove production injection works.

A reverse proxy must inject an external `<script src>` and `<link rel="stylesheet">` where possible. Inline script/style may be rejected by `script-src`/`style-src`, nonces, hashes, or webview policy. It may also require updating:

- `Content-Security-Policy`;
- compressed responses;
- `Content-Length`;
- ETag/Last-Modified handling;
- HTML integrity or cache headers;
- base-path-aware asset URLs.

A proxy performing naive text replacement against gzip/Brotli HTML is particularly likely to fail.

### Service worker and caching

The service worker can serve a cached app shell before the proxy’s newly modified `index.html` is fetched. Version the injected asset URLs and define an upgrade procedure that includes:

- cache-busting filenames or query versions;
- reload/update behavior;
- testing offline/reconnect cases;
- verifying that old CSS and new JS cannot be mixed.

Do not automatically unregister Jellyfin’s service worker; that could break intended client behavior.

### Mobile webview assumptions

“Same client, should match” is too optimistic. Verify separately in the actual Android/iOS Jellyfin app because webviews can differ in:

- safe-area insets and status/navigation bars;
- viewport height and address-bar resizing;
- back-button/history behavior;
- autoplay/user-gesture enforcement;
- fullscreen and orientation transitions;
- touch scrolling inside horizontal rails;
- long-press behavior;
- memory pressure and image decoding;
- CSP/network interception;
- whether the wrapper loads the server-hosted web client or a bundled client in that configuration.

Use `env(safe-area-inset-*)`, sensible image sizes, `loading="lazy"`, and avoid fetching/rendering all seasons’ episodes at once. Fetch the selected season initially and cache other seasons on demand.

### Security and robustness

- Never interpolate API text through `innerHTML`. Titles and overviews are server-controlled content; use `textContent`.
- Sanitize any permitted markup explicitly.
- Add `aria-expanded`, focus management, keyboard activation, visible focus, reduced-motion support, and sufficiently large touch targets.
- Prevent cumulative layout shift with fixed image aspect ratios.
- Supply image fallbacks for missing logos, backdrops, season art, and episode stills.
- Overflow actions are not specified. An inert `⋯` should not ship.
- Verify permissions: hidden episodes, parental restrictions, playback restrictions, and deleted items.
- Do not let custom z-index rules cover native dialogs, toast messages, media-source selectors, or the video player.

## Prioritized must-fix list

1. **Choose and prove a real playback bridge.** An injected script cannot simply import Jellyfin’s internal `playbackManager`. Prove native-control delegation or add a maintained bundled/global bridge, including resume and cast behavior.
2. **Replace the ID guard with a route-keyed lifecycle controller.** Add item-type validation, abort/generation handling, idempotent reconciliation, and A→B detail navigation support.
3. **Define permanent versus per-view teardown.** Make reinjection safe and guarantee native UI restoration on navigation, fetch failure, logout, and render exceptions.
4. **Use `window.ApiClient` helpers for API and image URLs.** Explicitly handle startup readiness, user/server identity, base URLs, query-result shapes, and fallback authentication.
5. **Correct Play/Resume semantics.** Distinguish resumable episode from Next Up and resolve a concrete episode before invoking playback.
6. **Validate the production injection mechanism.** Test CSP, compressed proxy responses, service-worker caching, versioned assets, and the actual mobile app webview—not only DevTools in a desktop browser.
7. **Add failure, performance, and security requirements.** Lazy-load episodes, escape API content, handle missing metadata/images, and restore stock detail UI on any failure.

As written, the spec is suitable for a visual POC, provided the native Play control remains available. It is not yet a sound production design until playback access and SPA lifecycle ownership are made explicit and proven against the exact pinned 10.11.x client.
