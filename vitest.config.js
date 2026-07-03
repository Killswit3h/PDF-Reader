import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure-logic unit tests only. The E2E smoke suite runs a real Electron
    // window and is driven separately via `npm run test:e2e`.
    include: ['test/unit/**/*.test.js'],
    environment: 'node'
  }
});
