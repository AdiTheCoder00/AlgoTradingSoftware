import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/shared/src/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
    // The API reads DATABASE_PATH once, at import time, so the setup file has to
    // redirect it before any engine module loads.
    setupFiles: ['apps/api/test/setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
