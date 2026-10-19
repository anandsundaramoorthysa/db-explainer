import { defineConfig } from 'vitest/config';

// Live checks against a real model (Ollama by default). Not part of `npm test`: they need a running model and take minutes.
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.ts'],
    testTimeout: 900000,
    hookTimeout: 120000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
