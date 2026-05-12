import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/py-*.test.ts'],
    forceExit: true,
    testTimeout: 120_000,
  },
});
