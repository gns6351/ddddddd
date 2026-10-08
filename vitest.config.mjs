import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/unit/**/*.test.js'], globals: true, testTimeout: 30000, hookTimeout: 30000, pool: 'forks', fileParallelism: true },
});
