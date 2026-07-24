/**
 * TEST_PLAN.md §9 lists S-01 to S-34. This file is the honest ledger for
 * every case NOT wired into a real, running test by jest.security.config.js
 * — each is a `test.todo(...)`, which Jest reports as "todo" and which can
 * never silently pass: there is no function body to fake a pass with.
 *
 * A case appears here only when slices 1-4 genuinely do not yet implement
 * the feature/endpoint the case exercises (verified by searching api/src
 * for the relevant module — records/attachments/notifications/PDF/
 * delegation-acting/security-headers-middleware/AUDITOR-role enforcement/
 * a chain-verification routine none of these exist yet). As each later
 * slice lands, replace the corresponding line below with a real spec file
 * added to jest.security.config.js's testMatch — never with a stub that
 * asserts nothing.
 *
 * Full S-01..S-34 status (see jest.security.config.js's testMatch comments
 * and .superpowers/sdd/ci-C-report.md for the complete file-by-file map):
 *
 *   RUNNING (real assertions, wired below):
 *     S-01..S-05  api/src/auth/jwt/access-token.service.spec.ts
 *     S-06        api/test/integration/auth-refresh-reuse.spec.ts
 *     S-07/S-08   api/test/integration/auth-step-up.spec.ts
 *     S-09        api/test/integration/auth-lockout.spec.ts
 *     S-13        api/src/auth/crypto/identity-codec.spec.ts +
 *                 api/test/integration/field-encryption.spec.ts (U-ENC-03 —
 *                 identical attack: ciphertext relocated between rows)
 *     S-18        api/test/integration/assets.spec.ts (403 out-of-scope)
 *     S-21        api/src/auth/guards/roles.guard.spec.ts
 *     S-22        api/test/integration/triggers.spec.ts (I-INV-05)
 *     S-23        api/test/integration/schema-constraints.spec.ts (I-INV-03)
 *     S-26        api/test/integration/grants.spec.ts (I-INV-08)
 *     S-29        api/test/integration/auth-flow.spec.ts
 *   HANDLED BY A DIFFERENT JOB-6 STEP (not test:security):
 *     S-15        npm run test:log-redaction (this same job, next step)
 *     S-28        bash scripts/ci/assert-csp-safe.sh (this same job)
 *     S-33        npm audit / CodeQL / Trivy (this same job, earlier steps)
 *     S-34        gitleaks-action (job 2 · Secret scan)
 *   PENDING — feature not yet built in slices 1-4 (test.todo below):
 *     S-10, S-11, S-12, S-14, S-16, S-17, S-19, S-20, S-24, S-25, S-27,
 *     S-30, S-31, S-32
 */
describe('S-01..S-34 pending cases (later slices) — tracked, never faked', () => {
  test.todo(
    'S-10 (T-1): alter an archived record directly in the DB, run /records/{id}/integrity — ' +
      'reported as mismatch. PENDING: no records module / integrity-check endpoint exists yet ' +
      '(api/src has no "records" or "integrity" route — canonical-serialiser and record-signer ' +
      'are wired primitives with no live endpoint on top of them yet).',
  );

  test.todo(
    'S-11 (T-2): alter an audit_event hash, run chain verification — break detected at the ' +
      'right sequence. PENDING: audit_event hash-chain construction is proven correct at write ' +
      'time (api/test/integration/audit-transaction.spec.ts), but no post-hoc chain-verification ' +
      'routine/endpoint exists yet to walk the chain and report where a tamper broke it.',
  );

  test.todo(
    'S-12 (T-4): a malformed body bypassing client-side validation is rejected by the server. ' +
      'PENDING: ZodValidationPipe (api/src/common/zod-validation.pipe.ts) is wired on every ' +
      'mutating route, but it has no dedicated regression test yet proving rejection of a ' +
      'malformed/extra-field payload — not fabricating a pass without one.',
  );

  test.todo(
    'S-14 (T-7): SQL injection payloads across all string inputs — no injection, parameterised. ' +
      "PENDING: requires a systematic fuzz harness iterating every mutating endpoint's string " +
      'fields; not yet built. (All queries observed in slices 1-4 use parameterised pg/Prisma ' +
      'calls, but that is not the same as an executed regression test.)',
  );

  test.todo(
    'S-16 (I-4): decode an access token — contains no name or email. PENDING: true by ' +
      'construction today (AccessTokenService.sign() only puts {sub, roles, jti, iat, exp, aud, ' +
      'iss} in the payload — see api/src/auth/jwt/access-token.service.ts) but there is no ' +
      'dedicated regression test asserting it, so a future change could silently add PII to the ' +
      'token without any test failing. Not fabricating a pass.',
  );

  test.todo(
    'S-17 (I-5): inspect Redis after a notification — payload contains identifiers only. ' +
      'PENDING: no notification module exists yet (no "notification" source under api/src) — ' +
      'later slice.',
  );

  test.todo(
    'S-19 (I-7): an attachment URL requested by an unauthorised user is rejected 403. PENDING: ' +
      'no attachment/MinIO endpoint exists yet — job 4\'s own comment confirms "MinIO is not yet ' +
      'used by any test in slices 1-4" (.github/workflows/ci.yml) — later slice.',
  );

  test.todo(
    'S-20 (I-9): trigger a 500 — no stack trace, SQL or hostname in the response. PENDING: no ' +
      'global exception filter exists yet under api/src to assert a sanitised 500 body against — ' +
      'later slice.',
  );

  test.todo(
    'S-24 (E-4): AUDITOR attempts any write — rejected; connection is read-only. PENDING: the ' +
      'AUDITOR role is seeded (api/test/integration/schema-constraints.spec.ts confirms the row ' +
      'exists) but no dedicated read-only-connection/write-rejection test exists yet — later ' +
      'slice.',
  );

  test.todo(
    'S-25 (E-5): act under an expired delegation — not permitted. PENDING: no delegation-acting ' +
      'feature exists yet (I-INV-20 in TEST_PLAN covers queue exclusion, a different, ' +
      'not-yet-built integration test) — later slice.',
  );

  test.todo(
    'S-27 (§10.2): response headers — CSP, HSTS, nosniff, referrer, permissions all present. ' +
      'PENDING: no security-headers middleware (e.g. helmet) is wired in api/src/main.ts yet — ' +
      'later slice. (S-28, the CSP-specific unsafe-inline/unsafe-eval check, is separately gated ' +
      'today by scripts/ci/assert-csp-safe.sh against web/nginx.conf.)',
  );

  test.todo(
    'S-30 (§10.1): upload a renamed executable as .jpg — rejected by magic-byte check. PENDING: ' +
      'no attachment upload endpoint exists yet — later slice.',
  );

  test.todo(
    'S-31 (§10.1): a remark containing markup, rendered to PDF — escaped, no injection. ' +
      'PENDING: no PDF rendering feature exists yet — later slice.',
  );

  test.todo(
    'S-32 (D-2): an attachment over 10 MB is rejected. PENDING: no attachment endpoint exists ' +
      'yet — later slice.',
  );
});
