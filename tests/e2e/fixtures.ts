// Playwright fixtures: a fake Anthropic server and a freshly launched Hangar wired to it.
//
// Isolation: every test gets its own temp root with
//   userData/   Electron --user-data-dir (onboarding already done, bundled claude.exe pinned)
//   claude/     CLAUDE_CONFIG_DIR for every Claude Code the app starts (no login, no user settings.json)
//   work/       a scratch folder for sessions
// The default provider is a gateway profile pointing at the mock with a fake token, so no test can reach the
// real Anthropic API or use the user's subscription.
import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockAnthropic, type MockAnthropic } from '../mock-anthropic/server.ts'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MOCK_TOKEN = 'mock-token'

/** The Claude Code binary shipped with the Agent SDK (same one CI has after `npm ci`). */
function bundledClaude(): string | undefined {
  try {
    const require = createRequire(join(REPO_ROOT, 'package.json'))
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const exe = join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}

/** process.env without anything that would leak a real Claude login or a parent Claude Code session. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_CONFIG_DIR$|CLAUDECODE$|ELECTRON_RENDERER_URL$|ELECTRON_RUN_AS_NODE$|AWS_BEARER_TOKEN)/.test(
        k
      )
    )
      continue
    env[k] = v
  }
  return { ...env, ...extra }
}

export interface Hangar {
  app: ElectronApplication
  page: Page
  root: string
  userData: string
  claudeConfig: string
  work: string
  /** window.hangar.invoke from the renderer's main frame (the only caller the IPC guard accepts). */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** Creates a session in `cwd` (default: the work folder) and opens it from the sidebar. */
  openNewSession(opts?: { cwd?: string; title?: string; permissionMode?: string }): Promise<{ id: string; cwd: string }>
  /** Saves (and makes default) a gateway profile pointing at the mock. Returns its id. */
  useMockProvider(opts?: { token?: string; name?: string; makeDefault?: boolean }): Promise<string>
}

interface Fixtures {
  mock: MockAnthropic
  hangar: Hangar
  /**
   * A real Hangar userData folder whose provider profiles the test app starts with (opt-in specs that reach real
   * models, e.g. bench-real.spec.ts). Only the profile list, its encrypted secrets and the OS-encrypted key that
   * protects them (Local State) are copied; the app decrypts them itself, and the test never reads a secret.
   */
  seedProvidersFrom: string | undefined
}

export const test = base.extend<Fixtures>({
  seedProvidersFrom: [undefined, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  mock: async ({}, use) => {
    const mock = await startMockAnthropic({ log: process.env.MOCK_LOG ? (l) => console.log(`[mock] ${l}`) : undefined })
    await use(mock)
    if (mock.unknown.length)
      console.log(`[mock] unknown routes: ${mock.unknown.map((r) => `${r.method} ${r.path}`).join(', ')}`)
    await mock.close()
  },

  hangar: async ({ mock, seedProvidersFrom }, use, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-e2e-'))
    const userData = join(root, 'userData')
    const claudeConfig = join(root, 'claude')
    const work = join(root, 'work')
    for (const d of [userData, claudeConfig, work]) mkdirSync(d, { recursive: true })
    mkdirSync(join(userData, 'hangar-data'), { recursive: true })
    const claudeExe = bundledClaude()
    writeFileSync(
      join(userData, 'hangar-data', 'settings.json'),
      JSON.stringify(
        {
          onboardingDone: true,
          theme: 'light',
          notifications: false,
          minimizeToTray: false,
          ...(claudeExe ? { claudeExecutablePath: claudeExe } : {})
        },
        null,
        2
      )
    )

    if (seedProvidersFrom) {
      const settingsDir = join(userData, 'hangar-data', 'settings')
      mkdirSync(settingsDir, { recursive: true })
      copyFileSync(join(seedProvidersFrom, 'Local State'), join(userData, 'Local State'))
      for (const f of ['providers.json', 'providers.secrets.json'])
        copyFileSync(join(seedProvidersFrom, 'hangar-data', 'settings', f), join(settingsDir, f))
    }

    const app = await electron.launch({
      args: [REPO_ROOT, `--user-data-dir=${userData}`],
      cwd: REPO_ROOT,
      env: cleanEnv({ CLAUDE_CONFIG_DIR: claudeConfig, HANGAR_E2E: '1' }),
      timeout: 60_000
    })
    await app.context().tracing.start({ screenshots: true, snapshots: true })
    const page = await app.firstWindow()
    page.on('dialog', (d) => void d.accept())
    // The splash (index.html) is in #root until React's first render replaces it.
    await page.waitForSelector('#root > :not(.splash)')

    const invoke = <T>(channel: string, ...args: unknown[]) =>
      page.evaluate(([c, a]) => window.hangar.invoke<T>(c, ...a), [channel, args] as const)

    const useMockProvider: Hangar['useMockProvider'] = async (opts = {}) => {
      const profile = await invoke<{ id: string }>('settings:providerSave', {
        name: opts.name ?? 'Mock Anthropic',
        kind: 'gateway',
        baseUrl: mock.url,
        authStyle: 'bearer',
        extraEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
      })
      await invoke('settings:providerSetSecret', profile.id, opts.token ?? MOCK_TOKEN)
      if (opts.makeDefault !== false) await invoke('settings:providerSetDefault', profile.id)
      return profile.id
    }

    const openNewSession: Hangar['openNewSession'] = async (opts = {}) => {
      const cwd = opts.cwd ?? work
      const title = opts.title ?? `E2E ${Date.now().toString(36)}`
      const session = await invoke<{ id: string; cwd: string }>('sessions:create', {
        cwd,
        title,
        permissionMode: opts.permissionMode ?? 'default'
      })
      await page.getByText(title, { exact: true }).first().click()
      await expect(page.getByPlaceholder(/Responder ao Claude/)).toBeVisible()
      return session
    }

    await use({ app, page, root, userData, claudeConfig, work, invoke, openNewSession, useMockProvider })

    const failed = testInfo.status !== testInfo.expectedStatus
    if (failed) {
      await page
        .screenshot({ path: testInfo.outputPath('failure.png') })
        .then(() =>
          testInfo.attachments.push({
            name: 'screenshot',
            path: testInfo.outputPath('failure.png'),
            contentType: 'image/png'
          })
        )
        .catch(() => {})
      await app
        .context()
        .tracing.stop({ path: testInfo.outputPath('trace.zip') })
        .catch(() => {})
      testInfo.attachments.push({
        name: 'trace',
        path: testInfo.outputPath('trace.zip'),
        contentType: 'application/zip'
      })
    } else {
      await app
        .context()
        .tracing.stop()
        .catch(() => {})
    }
    await app.close().catch(() => {})
    // Claude Code children may hold files for a moment after the app quits.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(root, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
})

export { expect }
