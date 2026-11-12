// Opt-in: the Hangar engine against a REAL model through OpenRouter (costs a fraction of a cent).
//   HANGAR_REAL_OPENROUTER_KEY=sk-or-... npx playwright test tests/e2e/hangar-engine-real.spec.ts
// Optional: HANGAR_REAL_MODEL (default openai/gpt-4o-mini). The key is typed into the app's own encrypted profile
// store through IPC and is never printed.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const KEY = process.env.HANGAR_REAL_OPENROUTER_KEY
const MODEL = process.env.HANGAR_REAL_MODEL || 'openai/gpt-4o-mini'

test.skip(!KEY, 'defina HANGAR_REAL_OPENROUTER_KEY para rodar contra um modelo real')
test.setTimeout(300_000)

test('motor Hangar com modelo real: cria um script, pede permissão para rodar e confere o resultado', async ({
  hangar
}) => {
  const { page, invoke } = hangar
  const profile = await invoke<{ id: string }>('settings:providerSave', {
    name: 'OpenRouter (motor Hangar)',
    kind: 'gateway',
    baseUrl: 'https://openrouter.ai/api',
    authStyle: 'bearer',
    engine: 'hangar',
    models: { default: MODEL }
  })
  await invoke('settings:providerSetSecret', profile.id, KEY)
  await invoke('settings:providerSetDefault', profile.id)

  // "Aceitar edições": files are written without asking, shell commands still need the card.
  const session = await hangar.openNewSession({ title: 'E2E Hangar real', permissionMode: 'acceptEdits' })
  const composer = page.getByPlaceholder(/Responder ao Claude/)
  await composer.fill(
    'Crie o arquivo soma.py com uma função soma(a, b) e, no final, print(soma(20, 22)). Depois rode `python soma.py` e me diga o número que apareceu.'
  )
  await composer.press('Enter')

  // The model writes the file on its own, then asks before running it: allow for the rest of the session.
  const always = page.getByRole('button', { name: /Permitir sempre/ })
  const allow = page.getByRole('button', { name: 'Permitir', exact: true })
  await expect(allow.or(always).first()).toBeVisible({ timeout: 180_000 })
  await ((await always.count()) ? always.first() : allow.first()).click()

  await expect
    .poll(
      async () => {
        // A second, different command may ask again: keep allowing until the turn ends.
        if (await allow.count())
          await allow
            .first()
            .click()
            .catch(() => undefined)
        const list = await invoke<{ id: string; status: string }[]>('store:list', 'sessions')
        return list.find((s) => s.id === session.id)?.status
      },
      { timeout: 240_000, intervals: [1000] }
    )
    .toBe('idle')

  const file = join(session.cwd, 'soma.py')
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('def soma')
  type Entry = {
    kind: string
    name?: string
    text?: string
    content?: string
    isError?: boolean
    costUsd?: number
    model?: string
  }
  const history = await invoke<Entry[]>('engine:history', session.id)
  const tools = history.filter((e) => e.kind === 'tool_use').map((e) => e.name)
  expect(tools).toContain('Write')
  expect(tools).toContain('Bash')
  expect(history.some((e) => e.kind === 'tool_result' && !e.isError && (e.content ?? '').includes('42'))).toBe(true)
  const answer = history
    .filter((e) => e.kind === 'assistant')
    .map((e) => e.text ?? '')
    .join('\n')
  expect(answer).toContain('42')
  const result = history.filter((e) => e.kind === 'result').pop()
  expect(result?.model).toBe(MODEL)
  expect(result?.costUsd).toBeGreaterThan(0)
  console.log(`[hangar real] ${MODEL}: ${tools.length} tool calls, custo US$ ${result?.costUsd?.toFixed(5)}`)
})
