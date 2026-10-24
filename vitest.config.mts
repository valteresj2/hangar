// Unit tests (Vitest): pure functions and main-process modules with `electron` mocked
// (see tests/unit/helpers/electron.ts). End-to-end tests live in tests/e2e (Playwright).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': `${root}src/shared`,
      '@renderer': `${root}src/renderer/src`
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Main-process modules keep state in module scope: give every file a fresh module graph.
    isolate: true,
    testTimeout: 20_000,
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default']
  }
})
