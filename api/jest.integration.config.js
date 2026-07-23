/** @type {import('jest').Config} */
module.exports = {
  displayName: 'integration',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
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
};
