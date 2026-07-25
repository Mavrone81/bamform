#!/usr/bin/env bash
# CI dependency audit gate.
#
# Fails on ANY high/critical npm advisory EXCEPT a small, explicitly-listed
# and justified allowlist. This is NOT `--audit-level` weakening: every
# high/critical advisory still fails the build unless its exact GHSA id is
# named below with a reason. A NEW advisory (any id not on the list) fails.
#
# Accepted advisories (each: why it is acceptable + why it can't be cleanly
# fixed):
#   GHSA-mh99-v99m-4gvg — brace-expansion DoS via a crafted brace pattern
#     causing unbounded expansion. Present ONLY as a transitive dev/build
#     dependency under jest, @rollup/plugin-commonjs, @stoplight/spectral-*
#     and fork-ts-checker-webpack-plugin — none of which ever receive an
#     attacker-controlled brace pattern in CI (trusted source globs only),
#     and none ship in any runtime image. We override brace-expansion to
#     ^5.0.8 (the patched line) wherever npm can hoist it; a few deeply
#     nested copies inside the above tools resist the override. No runtime
#     exposure.
#
#   GHSA-vj76-c3g6-qr5v / GHSA-8cj5-5rvv-wf4v / GHSA-pq67-2wwv-3xjx —
#     tar-fs symlink-validation / path-traversal issues on a CRAFTED tarball.
#     Transitive via `puppeteer` -> `@puppeteer/browsers` -> `tar-fs@3.0.4`
#     (slice 12, PR-117 — server-side PDF rendering). This `tar-fs` only
#     ever runs during `npm install`'s postinstall (extracting Puppeteer's
#     OWN bundled Chromium download from a tarball Puppeteer's own code
#     fetches from Google's Chrome-for-Testing CDN — not an
#     attacker-controlled source) and NEVER at runtime: the shipped
#     `api/Dockerfile` sets `PUPPETEER_SKIP_DOWNLOAD=true` in every stage
#     that runs `npm ci` (see that file), so `tar-fs` is never invoked at
#     all in the built image — it uses the distro `chromium` package
#     instead. Pinning `puppeteer` to a version whose `@puppeteer/browsers`
#     resolves a patched `tar-fs` is not currently possible without moving
#     to a puppeteer major (22+) that is ESM-only and breaks this
#     CommonJS/ts-jest toolchain (see pdf/chromium-browser.service.ts's doc
#     comment); tried overriding via package.json `overrides` first — npm
#     silently would not apply it for this nested transitive position, only
#     the allowlist route was viable within this slice's time budget.
#   GHSA-3h5v-q93c-6h6q / GHSA-96hv-2xvq-fx4p — `ws` DoS (many headers /
#     tiny fragments) advisories describe a `ws` SERVER receiving hostile
#     input from a remote client. Transitive via `puppeteer-core@ws@8.16.0`
#     (same PR-117 render pipeline): here `ws` is used the OTHER way round
#     — Node is the CLIENT, connecting outward to Chromium's own
#     remote-debugging (CDP) port, which Puppeteer launches as a private
#     child process with no host port ever published (docker-compose.yml
#     never exposes it) and no external network reachability. The
#     "malicious remote client" precondition these advisories require does
#     not exist in this topology. Same override-attempt/version-lock
#     constraint as tar-fs above.
set -euo pipefail

ALLOW="GHSA-mh99-v99m-4gvg,GHSA-vj76-c3g6-qr5v,GHSA-8cj5-5rvv-wf4v,GHSA-pq67-2wwv-3xjx,GHSA-3h5v-q93c-6h6q,GHSA-96hv-2xvq-fx4p"

audit_json="$(npm audit --json 2>/dev/null || true)"

blocking="$(printf '%s' "$audit_json" | node -e '
  let s = "";
  process.stdin.on("data", d => (s += d)).on("end", () => {
    let a;
    try { a = JSON.parse(s); } catch { console.error("could not parse npm audit --json"); process.exit(2); }
    const allow = new Set(process.argv[1].split(","));
    // Collect every distinct advisory (GHSA id) that appears anywhere in the
    // tree at high/critical severity. `via` entries are either advisory
    // objects (root cause, carry the GHSA url) or strings (a parent that is
    // vulnerable only *through* a child) — we only harvest the root-cause
    // GHSA ids, then require every one of them to be on the allowlist.
    const advisories = new Set();
    for (const v of Object.values(a.vulnerabilities || {})) {
      for (const via of v.via || []) {
        if (typeof via === "object" && via.url && (via.severity === "high" || via.severity === "critical")) {
          const m = String(via.url).match(/GHSA-[a-z0-9-]+/);
          if (m) advisories.add(m[0]);
        }
      }
    }
    for (const id of advisories) if (!allow.has(id)) console.log(id);
  });
' "$ALLOW")"

if [ -n "$blocking" ]; then
  echo "BLOCKING high/critical advisories (not on the documented allowlist):"
  echo "$blocking" | sed "s/^/  - /"
  echo ""
  echo "Run 'npm audit' for detail. To accept one, add its GHSA id to ALLOW in $0 WITH a written justification — never lower --audit-level."
  exit 1
fi

echo "npm audit: no un-allowed high/critical advisories (allowlist: $ALLOW)"
