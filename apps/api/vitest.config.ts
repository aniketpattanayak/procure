import swc from 'unplugin-swc';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// Parallel agents each set TEST_DB (e.g. procure_test_wf) and TEST_REDIS_DB (2–15) so runs never collide.
const DB = process.env.TEST_DB ?? 'procure_test';
const REDIS_DB = process.env.TEST_REDIS_DB ?? '1';

// @procure/schema is compiled to CommonJS and loads zod's CJS build. Resolve every `zod` import to that
// same build so `instanceof ZodError` (ProblemFilter) sees one class, exactly as in the CJS production build.
const zodCjs = createRequire(import.meta.url).resolve('zod');

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { alias: { zod: zodCjs } },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    env: {
      DATABASE_URL: `postgres://app_user:app_pass@localhost:5432/${DB}`,
      DATABASE_MIGRATOR_URL: `postgres://postgres@localhost:5432/${DB}`,
      DATABASE_PLATFORM_URL: `postgres://platform_user:platform_pass@localhost:5432/${DB}`,
      REDIS_URL: `redis://localhost:${process.env.TEST_REDIS_PORT ?? '6379'}/${REDIS_DB}`,
      JWT_SECRET: 'test-secret-test-secret-test-secret!!',
      NODE_ENV: 'test',
    },
  },
});
