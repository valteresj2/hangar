// Captures the real app screens used by the product video (video/README.md): `npx playwright test -c video`.
// Same isolation as the e2e suite (fake Anthropic and platform servers, temp user data): nothing real is called.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'shots.spec.ts',
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: '../test-results/video',
  reporter: [['list']]
})
