/** @type {import('jest').Config} */
module.exports = {
  displayName: 'unit',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Resolve @bamform/shared straight to its TS source, mirroring
  // jest.integration.config.js — unit tests must not depend on
  // `npm run build --workspace=shared` having already happened.
  moduleNameMapper: {
    '^@bamform/shared$': '<rootDir>/../shared/src/index.ts',
  },
  testTimeout: 15000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts'],
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
