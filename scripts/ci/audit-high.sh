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
set -euo pipefail

ALLOW="GHSA-mh99-v99m-4gvg"

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
