import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.js'],
    exclude: [
      '**/py-*.test.ts',
      'tests/e2e/**',
      'tests/examples/*e2e*.test.ts',
    ],
    forceExit: true,
    environmentMatchGlobs: [
      ['tests/browser/**', 'jsdom'],
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
