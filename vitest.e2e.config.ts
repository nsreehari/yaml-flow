import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts', 'tests/examples/*e2e*.test.ts'],
    exclude: ['tests/e2e/python/**', '**/py-*.test.ts'],
    forceExit: true,
    testTimeout: 120_000,
  },
});
