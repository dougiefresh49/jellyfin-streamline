#!/bin/bash
# Build a Samsung Tizen .wgt with Streamline baked in.
#
# The Tizen client packages its own copy of jellyfin-web inside the .wgt and only
# ever talks to the server over the JSON API -- it never fetches the server's
# index.html. That is why --webdir injection reaches the Android app and the
# browser but never the TV, and why the theme has to be built INTO the package.
#
# jellyfin-tizen takes a prebuilt web client via JELLYFIN_WEB_DIR, so the same
# directory build-webdir.sh already produces is the input here. No second theme
# pipeline.
#
#   scripts/tizen/build-tizen.sh
#
# Env:
#   WEBDIR   web client to package (default: the Streamline webdir)
#   WORKDIR  where jellyfin-tizen is cloned (default: ~/.cache/jellyfin-tizen)
set -euo pipefail

WEBDIR="${WEBDIR:-$HOME/Library/Application Support/jellyfin/streamline-web}"
WORKDIR="${WORKDIR:-$HOME/.cache/jellyfin-tizen}"
REPO="https://github.com/jellyfin/jellyfin-tizen.git"

fail() { echo "error: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
# Fail on the missing prerequisite by name rather than midway through a build.
command -v git >/dev/null || fail "git not found"
command -v npm >/dev/null || fail "npm not found"
command -v tizen >/dev/null || fail "tizen CLI not found -- install Tizen Studio and add its tools/ide/bin to PATH (see docs/tizen.md)"
java -version >/dev/null 2>&1 || fail "no Java runtime -- the Tizen CLI needs a JDK (see docs/tizen.md)"

[ -d "$WEBDIR" ] || fail "web client not found: $WEBDIR (run scripts/webdir/build-webdir.sh first)"
[ -f "$WEBDIR/index.html" ] || fail "$WEBDIR has no index.html -- not a built web client"

# The whole point is shipping the theme, so refuse to build a stock package.
grep -q "streamline-body-start" "$WEBDIR/index.html" \
  || fail "$WEBDIR/index.html has no Streamline injection -- rerun scripts/webdir/build-webdir.sh"

echo "web client:  $WEBDIR"
echo "theme:       injected (markers present)"

# --- jellyfin-tizen --------------------------------------------------------
if [ -d "$WORKDIR/.git" ]; then
  echo "updating jellyfin-tizen in $WORKDIR"
  git -C "$WORKDIR" pull --ff-only
else
  echo "cloning jellyfin-tizen into $WORKDIR"
  mkdir -p "$(dirname "$WORKDIR")"
  git clone --depth 1 "$REPO" "$WORKDIR"
fi

cd "$WORKDIR"

# jellyfin-tizen's gulp build copies JELLYFIN_WEB_DIR into its www/ rather than
# building jellyfin-web from source. Our webdir is already a built client with
# the theme injected, so it goes in whole. The env var must be exported BEFORE
# npm install: install's postinstall hook runs gulp too, and without it that hook
# fails outright looking for a jellyfin-web dependency we never fetch.
echo "staging web client into jellyfin-tizen (JELLYFIN_WEB_DIR=$WEBDIR)"
export JELLYFIN_WEB_DIR="$WEBDIR"
npm install
npm run build

[ -f "$WORKDIR/www/index.html" ] || fail "gulp produced no www/index.html"
# The package is only worth building if the theme actually survived the copy.
grep -q "streamline-body-start" "$WORKDIR/www/index.html" \
  || fail "www/index.html lost the Streamline injection -- jellyfin-tizen did not take the prebuilt client"
echo "theme present in staged www/"

# .wgt packaging is the Tizen CLI's job, not npm's, and signing needs a Samsung
# certificate profile created in Tizen Studio's Certificate Manager.
tizen build-web -e ".*" -e "README.md" -e "node_modules/*" -- "$WORKDIR"

if [ -z "${CERT_PROFILE:-}" ]; then
  echo
  echo "Built, unsigned. Set CERT_PROFILE=<profile name> to produce an installable .wgt."
  echo "Create the profile in Tizen Studio -> Certificate Manager (needs a Samsung account"
  echo "and the TV reachable, since the distributor cert binds to its device ID)."
  exit 0
fi

tizen package -t wgt -s "$CERT_PROFILE" -- "$WORKDIR/.buildResult"

WGT="$(find "$WORKDIR/.buildResult" -name '*.wgt' | head -1)"
[ -n "$WGT" ] || fail "packaging finished but produced no .wgt"

echo
echo "built: $WGT"
echo "next:  scripts/tizen/install-tizen.sh <tv-ip>"
