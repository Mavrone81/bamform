/** @type {import('jest').Config} */
module.exports = {
  displayName: 'unit',
  rootDir: '.',
  testEnvironment: 'node',
  // Slice masterlist-migration: scripts/template-load/src/masterlist/*.spec.ts
  // are pure functions (no network, no database) that belong beside the
  // template loader they extend (see docs/superpowers/plans/
  // 2026-08-02-masterlist-migration.md), not under api/src — but they are
  // exactly what this "unit" config exists to run, and Task 6 of that plan's
  // final gate (`cd api && npx jest --config jest.unit.config.js`) only ever
  // exercises them if this config discovers them. `roots` defaults to
  // [rootDir] (api/), which would silently exclude them even with a
  // matching testMatch glob, so it is widened explicitly here.
  roots: ['<rootDir>/src', '<rootDir>/../scripts/template-load/src'],
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/../scripts/template-load/src/**/*.spec.ts'],
  transform: {
    // tsconfig.jest.json extends tsconfig.json and adds a path mapping so
    // @bamform/shared resolves to source for ts-jest's type-checker too
    // (see that file's comment) — without it, ts-jest falls back to
    // shared's built dist/, which doesn't exist on a fresh checkout until
    // `npm run build --workspace=shared` runs.
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Resolve @bamform/shared straight to its TS source, mirroring
  // jest.integration.config.js — unit tests must not depend on
  // `npm run build --workspace=shared` having already happened.
  moduleNameMapper: {
    '^@bamform/shared$': '<rootDir>/../shared/src/index.ts',
  },
  testTimeout: 15000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/main.ts',
    // Entrypoint scripts (worker.ts mirrors main.ts; worker-healthcheck.ts
    // is a standalone Docker HEALTHCHECK script) — process-lifecycle glue
    // exercised by running the container, not meaningfully unit-testable.
    '!src/worker.ts',
    '!src/worker-healthcheck.ts',
  ],
  // Emit an istanbul JSON into the repo-root .nyc_output so the CI coverage
  // gate (`nyc check-coverage --lines 80 --branches 70`, run from the
  // integration job over BOTH suites' output) can read jest's coverage.
  // Business logic here is deliberately covered by the INTEGRATION suite
  // (real Postgres), not by mocked unit tests — unit coverage alone is
  // ~26%/28% by design — so this file uses a name distinct from the
  // integration config's output (see jest.integration.config.js) so `nyc`
  // merges both instead of one overwriting the other. text-summary keeps
  // the console output readable.
  coverageDirectory: '<rootDir>/../.nyc_output',
  coverageReporters: [['json', { file: 'unit-coverage.json' }], 'text-summary'],
};
