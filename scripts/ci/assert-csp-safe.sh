#!/usr/bin/env bash
# S-28 / PR-SEC-23: CSP must contain neither unsafe-inline nor unsafe-eval.
set -euo pipefail
if grep -rEn "unsafe-(inline|eval)" web/nginx.conf web/security-headers.conf api/src 2>/dev/null; then
  echo "FAIL: CSP contains unsafe-inline or unsafe-eval"; exit 1
fi

# CR-2 (crypto review 2026-07-27): nginx's add_header inheritance rule means a
# location block with ANY add_header of its own silently discards every header
# inherited from the server block. Production served ZERO security headers on
# real pages for its entire life while this gate stayed green, because the old
# gate only checked the headers existed somewhere in the file. Enforce the
# actual invariant: every location block that uses add_header must re-include
# the security-headers snippet.
fail=0
awk '
  /location/ && /\{/ { inloc=1; locline=NR; loc=$0; has_add=0; has_inc=0; depth=0 }
  inloc {
    n = gsub(/\{/, "{"); depth += n
    m = gsub(/\}/, "}"); depth -= m
    if ($0 ~ /add_header/) has_add=1
    if ($0 ~ /security-headers\.conf/) has_inc=1
    if (depth == 0 && NR > locline) {
      if (has_add && !has_inc) {
        printf "MISSING security-headers include in location started at line %d: %s\n", locline, loc
        bad=1
      }
      inloc=0
    }
  }
  END { exit bad ? 1 : 0 }
' web/nginx.conf || fail=1

# The snippet itself must exist, be copied into the image, and be included at
# server level — otherwise the include directives break the container at boot
# or the server block itself goes unprotected.
[ -f web/security-headers.conf ] || { echo "MISSING: web/security-headers.conf"; fail=1; }
grep -q "security-headers.conf" web/Dockerfile || { echo "MISSING: Dockerfile does not COPY security-headers.conf"; fail=1; }
grep -qE "^\s*include .*security-headers\.conf" web/nginx.conf || { echo "MISSING: server-level include of security-headers.conf"; fail=1; }
for h in Content-Security-Policy X-Content-Type-Options X-Frame-Options Referrer-Policy; do
  grep -q "$h" web/security-headers.conf || { echo "MISSING header in snippet: $h"; fail=1; }
done

[ "$fail" -eq 0 ] && echo "PASS: CSP is safe and headers survive location-level add_header" || exit 1
