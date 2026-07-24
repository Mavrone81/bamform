/** @type {import('jest').Config} */
module.exports = {
  displayName: 'integration',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  transform: {
    // See jest.unit.config.js — tsconfig.jest.json adds a path mapping so
    // @bamform/shared resolves to source for ts-jest's type-checker too.
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Resolve @bamform/shared straight to its TS source — tests must not
  // depend on `npm run build --workspace=shared` having already happened
  // (CI's integration job does not build shared before running tests).
  moduleNameMapper: {
    '^@bamform/shared$': '<rootDir>/../shared/src/index.ts',
  },
  testTimeout: 30000,
  // I-INV tests share one Postgres instance and reset it between tests
  // (helpers/db.ts resetDatabase) — files must not run concurrently.
  maxWorkers: 1,
  // Same collectCoverageFrom as jest.unit.config.js so both suites report
  // over the identical module set — required for a meaningful merged
  // combined-coverage number (CI job 4 runs both suites with --coverage
  // and gates on the merge; see .github/workflows/ci.yml "4 · Integration").
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts'],
  coverageDirectory: '<rootDir>/../.nyc_output',
  coverageReporters: [['json', { file: 'integration-coverage.json' }], 'text-summary'],
};
