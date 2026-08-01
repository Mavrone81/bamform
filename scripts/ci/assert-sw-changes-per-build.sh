#!/usr/bin/env bash
# Two builds from DIFFERENT source must produce a DIFFERENT dist/sw.js —
# built the way PRODUCTION builds, not the way CI builds.
#
# WHY THIS GATE EXISTS (slice 22-SELFUPDATE, review finding S-1)
#
# The entire self-update mechanism rests on one property: when a new build is
# deployed, `registration.update()` re-fetches `/sw.js`, byte-compares it, and
# finds it different. If `sw.js` is byte-identical across deploys, the browser
# correctly concludes there is no update — and a device can never leave an old
# build, on every trigger, forever.
#
# That property was silently FALSE in production for the whole of slice 22.
# `sw.js`'s only build-varying content was `bamform-shell-${VITE_APP_VERSION}`,
# and the droplet pins that: docker-compose.yml maps
# `VITE_APP_VERSION: ${IMAGE_TAG:-local}`, .env.example sets `IMAGE_TAG=local`,
# and scripts/server/auto-deploy-bamform.sh sources that .env with `set -a`
# before building. CI passed `${GITHUB_SHA::7}` — but the CI job only proves
# images build; the droplet builds its own. Two builds from genuinely
# different source produced sw.js `fe6d1732…` both times. Every test passed.
# The owner's tablet stayed stale.
#
# So this gate deliberately builds with the value PRODUCTION uses, not the one
# CI uses. Pinning VITE_APP_VERSION to a constant here is the point: if the
# only thing distinguishing two builds' workers is an environment variable
# that production holds constant, this must fail.
set -Eeuo pipefail

cd "$(dirname "$0")/../.."
WEB=web
MARKER='/* assert-sw-changes-per-build: synthetic source change */'
ENTRY="$WEB/src/main.tsx"
BACKUP=$(mktemp)
trap 'cp "$BACKUP" "$ENTRY"; rm -f "$BACKUP"; rm -rf "$WEB/dist"' EXIT

cp "$ENTRY" "$BACKUP"

build_once() {
  rm -rf "$WEB/dist"
  # The production value, verbatim (docker-compose.yml: ${IMAGE_TAG:-local}).
  ( cd "$WEB" \
    && VITE_APP_VERSION=local npx vite build \
    && VITE_APP_VERSION=local npx vite build --config vite.sw.config.ts ) >/dev/null
}

build_once
SW_A=$(shasum "$WEB/dist/sw.js" | cut -d' ' -f1)
BUNDLE_A=$(ls "$WEB"/dist/assets/*.js)

printf '\n%s\nconsole.log("assert-sw-changes-per-build");\n' "$MARKER" >> "$ENTRY"
build_once
SW_B=$(shasum "$WEB/dist/sw.js" | cut -d' ' -f1)
BUNDLE_B=$(ls "$WEB"/dist/assets/*.js)

if [ "$BUNDLE_A" = "$BUNDLE_B" ]; then
  echo "FAIL: the two builds emitted the same bundle ($BUNDLE_A) — this gate did not"
  echo "      actually produce two different builds, so it proves nothing. Fix the gate."
  exit 1
fi

if [ "$SW_A" = "$SW_B" ]; then
  cat <<EOF
FAIL: two builds from different source produced a BYTE-IDENTICAL dist/sw.js.

  sw.js   : $SW_A  (both)
  bundles : $BUNDLE_A
            $BUNDLE_B   <- genuinely different builds

\`registration.update()\` byte-compares /sw.js. Identical bytes mean the browser
correctly reports "no update", so no deployed client will EVER leave its current
build — silently, with every test still passing. This is the exact regression
that stranded the owner mid-test (slice 22-SELFUPDATE, review S-1).

The worker's version must derive from the BUILD OUTPUT (see
web/scripts/asset-fingerprint.mjs), never from an environment variable alone:
production pins VITE_APP_VERSION to the constant \`local\`.
EOF
  exit 1
fi

echo "PASS: sw.js changes across builds under production's own VITE_APP_VERSION"
echo "      A=$SW_A"
echo "      B=$SW_B"
