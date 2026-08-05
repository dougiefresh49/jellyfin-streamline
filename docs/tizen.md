# Streamline on the Samsung TV (Tizen)

## Why this is needed at all

Streamline is delivered through Jellyfin's `--webdir`: the server serves a patched
`index.html` and every client that loads its UI *from the server* gets the theme. The Android
app and any browser work this way — they are wrappers around the server's web client.

Jellyfin for Tizen does not. It packages its own copy of jellyfin-web inside the installed
`.wgt` and talks to the server only over the JSON API. It never requests the server's
`index.html`, so there is no injection point and no server-side change can reach it. New
movies appear on the TV because those come over the API; the interface does not change because
it is shipped inside the app.

The theme therefore has to be built *into* the package. `jellyfin-tizen` accepts a prebuilt
web client through `JELLYFIN_WEB_DIR`, so the directory `scripts/webdir/build-webdir.sh`
already produces is the input — there is no second theme pipeline to maintain.

Custom CSS (Dashboard → General → Branding) is *not* an alternative. It does reach the Tizen
app, but it delivers CSS only, and 125 of Streamline's 133 rule blocks style elements that
`theme.js` builds at runtime. Without the JS those rules match nothing.

## One-time setup

Steps 2–4 are **already done on this machine**; they are recorded for rebuilding elsewhere.

1. **Samsung account** — <https://developer.samsung.com>, "Sign In" → create account. Free;
   the same account works for the developer site and for certificate signing. No paid
   membership is involved. **Still required — see step 5.**
2. **Java (JDK)** — the Tizen CLI runs on Java. `brew install openjdk@17`. The *formula* (not
   the `temurin` cask) avoids needing an admin password, but it is keg-only, so it must be put
   on `PATH` explicitly.
3. **Tizen CLI** — the Web CLI installer is public, no Samsung login needed:
   `https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_macos-64.bin`,
   run with `--accept-license "$HOME/tizen-studio"`.
   Then add the IDE web-app package, **without which `tizen build-web` dies** with
   `ClassNotFoundException: org.eclipse.core.runtime.Plugin`:
   `~/tizen-studio/package-manager/package-manager-cli.bin install TIZEN-9.0-WebAppDevelopment --accept-license`
4. **PATH** — everything below assumes:
   ```sh
   export PATH="$HOME/tizen-studio/tools/ide/bin:$HOME/tizen-studio/tools:$PATH"
   export PATH="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home/bin:$PATH"
   ```
5. **Certificates — the one remaining manual step.** Signing needs a Samsung certificate
   profile, which is created in Tizen Studio's **Certificate Manager** (the GUI installer, not
   the Web CLI used here). It creates an author certificate and a distributor certificate,
   signing both against Samsung's CA using your account. The distributor certificate binds to
   the specific TV's device ID (DUID), so the TV must be reachable during this step. Then:
   `CERT_PROFILE=<profile name> scripts/tizen/build-tizen.sh`
6. **Developer Mode on the TV** — Apps → press `12345` on the remote → Developer Mode **On** →
   enter this Mac's LAN IP → restart the TV.

Developer Mode does not disable signature checking. It only tells the TV to accept installs
pushed from that host IP instead of from the store; the firmware still verifies that the
package is signed by a chain it trusts. That check is not ownership-aware, which is why owning
the TV is not sufficient and a certificate is unavoidable.

## Build and install

```sh
scripts/webdir/build-webdir.sh        # refresh the themed web client
scripts/tizen/build-tizen.sh          # package it into a .wgt
scripts/tizen/install-tizen.sh <tv-ip>
```

`build-tizen.sh` refuses to run if the web client has no Streamline injection, so a stock
package cannot be shipped by accident.

## Updates are over the network

`sdb` connects to the TV over LAN/Wi-Fi on port 26101 and `tizen install` pushes the package
across it. No thumb drive, no physical access. Rebuilding after a theme change is the three
commands above, and the TV picks up the new package on next launch.

This is a push, not a pull: the TV never checks for updates on its own. A theme change reaches
the phone by restarting the app, but the TV stays on whatever was last pushed until this is
rerun. That is the standing cost of the Tizen route.

## Maintenance and caveats

- **Rebuild required** after any theme change *and* after a Jellyfin server upgrade, so that
  the bundled client matches the server version.
- **Sideloaded apps need periodic reinstallation.** This is widely reported for Tizen; the
  exact trigger and interval are not verified here. Expect to rerun the install occasionally.
- **The prebuilt-web-client path works — verified 2026-08-05.** The concern was that
  `jellyfin-tizen` normally builds jellyfin-web from source and might reject an already-built
  client copied from the macOS app bundle. It does not: gulp copied the whole webdir into
  `www/`, `.buildResult/www/index.html` carries the Streamline injection, and
  `.buildResult/www/streamline/` holds both hashed assets. `tizen build-web` reports BUILD
  SUCCESSFUL.
- **Verified end to end — 2026-08-05.** Built, signed with the `treecastle-tv` profile,
  installed over `sdb`, launched, and confirmed rendering Streamline on a UN60DU7200FXZA
  (101 transformed elements, matching desktop).

## The host-IP trap

Developer Mode opens port 26101 to everyone but only *accepts* connections from the Host PC IP
configured on the TV. When this Mac's address changes, `sdb connect` fails while the port still
reads as open — which looks like a broken TV rather than a stale setting, and cost a night of
debugging here. The Mac moving between Ethernet and Wi-Fi is enough to trigger it, since those
are separate DHCP leases.

Reserve this machine's address in the router, and remember the same change breaks the *server*
URL configured in every Jellyfin client, not just the sideload path.

If `sdb` refuses despite a correct Host PC IP, connect during the window early in a TV **restart**
(standby does not reopen it): loop `sdb connect` every 2s while it boots. Then wait ~45s before
installing — the TV accepts a connection well before it can accept a 36MB package.

Two operational notes for that flow:

- Install with `tizen install`, never `sdb install`. The latter only pushes the file, reports
  success, and installs nothing.
- Do not `pkill` anything sdb-related; it takes down the local sdb server and drops the
  connection.
