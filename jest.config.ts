/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
        useESM: true,
      },
    ],
    '^.+\\.jsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
        useESM: true,
      },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@faker-js/faker)/)',
  ],
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/tests/**/*.test.tsx'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/popup/main.tsx',
  ],
  // These are a regression floor, not an aspirational target: background/index.ts
  // and content/index.ts are large browser-bootstrap/wiring files (MutationObservers,
  // hotkey handling, modal detection) that are inherently hard to unit test and were
  // previously excluded from coverage collection entirely, which silently hid that
  // they (and profile-manager.ts/message-handler.ts/popup/api.ts) had ~0% coverage.
  // Now that they're included, the honest current floor is well below 80% — set
  // thresholds a few points below the last measured run so a real coverage drop
  // still fails CI without making this gate permanently red.
  coverageThreshold: {
    global: {
      branches: 38,
      functions: 34,
      lines: 41,
      statements: 39,
    },
  },
  setupFiles: ['<rootDir>/tests/setup.ts'],
};
