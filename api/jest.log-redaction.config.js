/** @type {import('jest').Config} */
// CI job 6 step "Passwords never appear in log output (S-15)". Runs only
// src/common/logging/redacting-logger.spec.ts — the test suite for the
// redacting log serialiser wired into main.ts (`app.useLogger(new
// RedactingLogger())`). Deliberately its own config/script (not folded into
// test:unit's run) so job 6 has one unambiguous named gate for S-15, per
// .github/workflows/ci.yml's "npm run test:log-redaction" step. The same
// spec file also runs under test:unit (job 3) as ordinary unit coverage —
// running it again here is cheap and keeps the S-15 gate self-describing.
module.exports = {
  displayName: 'log-redaction',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/common/logging/redacting-logger.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@bamform/shared$': '<rootDir>/../shared/src/index.ts',
  },
  testTimeout: 15000,
};
