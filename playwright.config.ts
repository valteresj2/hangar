// End-to-end tests: the built app (out/) driven through Playwright's Electron support, talking to the
// fake Anthropic server in tests/mock-anthropic. `npm run test:e2e` builds first.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // Each test launches its own Electron with a fresh user data dir; run them one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  outputDir: 'test-results',
  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
})
