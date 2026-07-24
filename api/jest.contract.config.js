/** @type {import('jest').Config} */
module.exports = {
  displayName: 'contract',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/contract/**/*.spec.ts'],
  transform: {
    // See jest.unit.config.js — tsconfig.jest.json adds a path mapping so
    // @bamform/shared resolves to source for ts-jest's type-checker too.
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@bamform/shared$': '<rootDir>/../shared/src/index.ts',
  },
  testTimeout: 15000,
  // Job 5 (Contract, .github/workflows/ci.yml) has NO Postgres/Redis service
  // container — unlike job 4 — so these tests must never boot the real Nest
  // application (see route-inventory.ts header comment). No coverage
  // collection here: job 5 is not part of the coverage gate (that's job 4).
};
