import { defineConfig } from 'vitest/config';

// Integration tests for the built converter (needs Chrome, Edge or Chromium installed).
export default defineConfig({
  test: {
    include: ['test/converter/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
