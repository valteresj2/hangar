// The Hangar engine end to end: the built app, a gateway profile set to "Hangar Harness", the real Python bridge
// (resources/harness) and a scripted OpenAI-compatible server. Skipped when the machine has no Python 3.11+.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startMockOpenAI } from '../mock-openai/server.ts'
import { expect, test } from './fixtures'

function hasPython(): boolean {
  const candidates: [string, string[]][] = [
    ['python', []],
    ['python3', []],
    ['py', ['-3']]
  ]
  return candidates.some(
    ([cmd, args]) =>
      spawnSync(cmd, [...args, '-c', 'import sys;sys.exit(0 if sys.version_info >= (3, 11) else 1)'], {
        timeout: 15_000
      }).status === 0
  )
}

test.skip(!hasPython(), 'o motor Hangar precisa do Python 3.11+')

test('motor Hangar: permissão → Permitir → arquivo escrito → resultado → Artifacts → segunda mensagem', async ({
  hangar
}) => {
  const openai = await startMockOpenAI()
  try {
    const { page, invoke } = hangar
    const profile = await invoke<{ id: string; engine?: string }>('settings:providerSave', {
      name: 'Gateway (motor Hangar)',
      kind: 'gateway',
      baseUrl: openai.url,
      authStyle: 'bearer',
      engine: 'hangar',
      models: { default: 'fake/model' }
    })
    expect(profile.engine).toBe('hangar')
    await invoke('settings:providerSetSecret', profile.id, 'mock-openai-token')
    await invoke('settings:providerSetDefault', profile.id)

    const session = await hangar.openNewSession({ title: 'E2E Motor Hangar', permissionMode: 'default' })
    openai.script = [
      {
        tool: 'write',
        args: { path: 'pagina.html', content: '<h1>Criado pelo Hangar</h1>' },
        thinking: 'Vou criar a página.'
      },
      { text: 'Pronto: pagina.html foi criado.' },
      { text: 'Conferido: pagina.html existe.' }
    ]
    const composer = page.getByPlaceholder(/Responder ao Claude/)
    await composer.fill('Crie uma página')
    await composer.press('Enter')

    // The harness asks before writing; the app shows the same permission card as for Claude Code.
    await expect(page.getByRole('button', { name: 'Permitir', exact: true })).toBeVisible({ timeout: 60_000 })
    const file = join(session.cwd, 'pagina.html')
    expect(existsSync(file)).toBe(false)
    await page.getByRole('button', { name: 'Permitir', exact: true }).click()

    await expect(page.getByText('Pronto: pagina.html foi criado.').first()).toBeVisible({ timeout: 60_000 })
    expect(readFileSync(file, 'utf8')).toBe('<h1>Criado pelo Hangar</h1>')

    // The turn ended like any other: idle session, a result line with cost, the Hangar session id saved for resume.
    await expect
      .poll(
        async () =>
          (await invoke<{ id: string; status: string }[]>('store:list', 'sessions')).find((s) => s.id === session.id)
            ?.status
      )
      .toBe('idle')
    const history = await invoke<{ kind: string; name?: string; costUsd?: number; model?: string }[]>(
      'engine:history',
      session.id
    )
    const kinds = history.map((e) => e.kind)
    for (const k of [
      'user',
      'thinking',
      'tool_use',
      'permission_request',
      'permission_decision',
      'tool_result',
      'assistant',
      'result'
    ])
      expect(kinds).toContain(k)
    expect(history.find((e) => e.kind === 'tool_use')?.name).toBe('Write')
    const result = history.find((e) => e.kind === 'result')
    expect(result?.model).toBe('fake/model')
    expect(result?.costUsd).toBeGreaterThan(0)
    const stored = (await invoke<{ id: string; hangarSessionId?: string }[]>('store:list', 'sessions')).find(
      (s) => s.id === session.id
    )
    expect(stored?.hangarSessionId).toBeTruthy()

    // The file the agent wrote reaches the rest of the app (Artifacts), as with the Claude Code engine.
    await page.locator('header').getByRole('button', { name: 'Artifacts' }).click()
    await expect(page.getByRole('button', { name: /pagina\.html/ }).first()).toBeVisible()

    // Same conversation on the second message, and every call went to the gateway's /v1 with the profile's secret.
    openai.script = [{ text: 'Sim, lembro da pagina.html.' }]
    await composer.fill('Lembra do arquivo?')
    await composer.press('Enter')
    await expect(page.getByText('Sim, lembro da pagina.html.').first()).toBeVisible({ timeout: 60_000 })
    const last = openai.requests[openai.requests.length - 1]
    expect(last.body.messages.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(2)
    expect(
      openai.requests.every((r) => r.path === '/v1/chat/completions' && r.auth === 'Bearer mock-openai-token')
    ).toBe(true)
  } finally {
    await openai.close()
  }
})
