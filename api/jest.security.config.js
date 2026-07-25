/** @type {import('jest').Config} */
// CI job 6 step "Security test cases S-01 to S-34 (npm run test:security)".
//
// This wires the EXISTING S-01..S-09 / U-SIG-01..10 / U-ENC-01..09 test
// files (built in slices 1-2 auth and slice 3 crypto) into one runnable
// script for the security job — see docs/TEST_PLAN.md §5.3/§5.5/§9 and
// .superpowers/sdd/ci-C-report.md for the full S-01..S-34 -> file mapping,
// including which cases are genuinely not yet buildable (later slices) and
// are tracked as `test.todo(...)` in test/security/pending-cases.spec.ts —
// never faked as passing.
//
// Mixes pure-unit spec files (src/**) with real-Postgres/Redis integration
// spec files (test/integration/**) that have no unit-level equivalent
// (S-06 refresh-reuse, S-07/08 step-up, S-09 lockout are genuine end-to-end
// attack simulations against the running app). CI job 6 therefore also
// provisions Postgres + Redis service containers (see ci.yml "6 · Security"
// — a minimal, explained addition; those two services did not exist in
// job 6 before this change, and there is no way to prove S-06..S-09 without
// them). Slice 6 adds a MinIO service container to the SAME job for the
// same reason: S-19/S-30/S-32 are real end-to-end attacks against the
// attachment endpoints (IDOR fetch, magic-byte upload, oversized upload)
// with no unit-level equivalent either.
module.exports = {
  displayName: 'security',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    // -- pure unit, no infra --------------------------------------------
    '<rootDir>/src/auth/jwt/access-token.service.spec.ts', // S-01..S-05
    '<rootDir>/src/auth/guards/roles.guard.spec.ts', // S-21 (role escalation refused)
    '<rootDir>/src/crypto/canonical-serialiser.spec.ts', // U-SIG-01..08
    '<rootDir>/src/crypto/record-signer.spec.ts', // U-SIG-09/10
    '<rootDir>/src/crypto/field-encryption.spec.ts', // U-ENC-01/02/04/08
    '<rootDir>/src/crypto/crypto-bootstrap.spec.ts', // U-ENC-07
    '<rootDir>/src/auth/crypto/blind-index.spec.ts', // U-ENC-05/06 (unit)
    '<rootDir>/src/auth/crypto/identity-codec.spec.ts', // U-ENC-03 (unit, AAD binding)
    '<rootDir>/src/common/logging/redacting-logger.spec.ts', // S-15 mechanism (also gated separately by test:log-redaction)

    // -- real Postgres + Redis (job 6 now provisions both) ---------------
    '<rootDir>/test/integration/auth-refresh-reuse.spec.ts', // S-06
    '<rootDir>/test/integration/auth-step-up.spec.ts', // S-07/S-08
    '<rootDir>/test/integration/auth-lockout.spec.ts', // S-09
    '<rootDir>/test/integration/auth-flow.spec.ts', // S-29 (refresh cookie attrs) + deny-by-default
    '<rootDir>/test/integration/field-encryption.spec.ts', // U-ENC-03/05/06 against real rows
    '<rootDir>/test/integration/assets.spec.ts', // S-18 (403 out-of-scope, not 404)
    '<rootDir>/test/integration/schema-constraints.spec.ts', // S-23 (author cannot approve own revision)
    '<rootDir>/test/integration/triggers.spec.ts', // S-22 (submitter cannot verify own record)
    '<rootDir>/test/integration/grants.spec.ts', // S-26 (bamform_app denied UPDATE on audit_event)

    // -- real Postgres + Redis + MinIO (slice 6; job 6 now provisions all three) --
    '<rootDir>/test/integration/attachments-security.spec.ts', // S-19, S-30, I-INV-19
    '<rootDir>/test/integration/jobs-attachments.spec.ts', // S-32 (oversized attachment rejected)

    // -- slice 7 — approval workflow ------------------------------------
    '<rootDir>/src/jobs/drawn-signature.spec.ts', // S-30-equivalent for the drawn-signature field (unit)
    '<rootDir>/test/integration/approval-verify.spec.ts', // S-22 (live HTTP self-approval), I-INV-13, drawn-signature encryption
    '<rootDir>/test/integration/approval-auditor-readonly.spec.ts', // S-24 (AUDITOR rejected on every new write)
    '<rootDir>/test/integration/approval-delegation.spec.ts', // S-25 (expired/revoked/absent delegation rejected)
    '<rootDir>/test/integration/records-integrity.spec.ts', // S-10 (tampered content_hash detected)

    // -- honestly-tracked gaps: pending cases only, never faked ----------
    '<rootDir>/test/security/pending-cases.spec.ts',
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@bamform/shared$': '<rootDir>/../shared/src/index.ts',
  },
  testTimeout: 30000,
  // Several of the integration files above share one Postgres instance and
  // reset it between tests (helpers/db.ts resetDatabase) — mirrors
  // jest.integration.config.js's maxWorkers: 1 requirement.
  maxWorkers: 1,
};
