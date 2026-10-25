import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

interface RoundView {
  id: string
  status: string
  cleanedUp?: boolean
  blindMap?: Record<string, string>
  variants: { id: string; worktree?: { path: string } }[]
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

test('rodada manual do Lab com K=1: variantes, seleção cega e limpeza', async ({ hangar }) => {
  test.setTimeout(240_000)
  // A throwaway git repository with one commit and a harness.
  const repo = join(hangar.work, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@hangar.test')
  git(repo, 'config', 'user.name', 'Hangar E2E')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'CLAUDE.md'), '# Projeto E2E\n')
  writeFileSync(join(repo, 'README.md'), 'Repositório de teste.\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')

  await hangar.useMockProvider()
  await hangar.openNewSession({ cwd: repo, title: 'E2E Lab' })
  const { page, invoke } = hangar
  await page.locator('header').getByRole('button', { name: 'Harness' }).click()
  await page.getByRole('button', { name: 'Abrir Lab' }).click()
  await expect(page.getByRole('button', { name: 'Nova rodada' })).toBeVisible()

  // One manual variant besides the base (K = 1). Each run asks the mock to write resultado.md in its worktree.
  const task = '[[script:write-file path=resultado.md]] Escreva o resultado'
  const created = await invoke<RoundView>('lab:create', {
    projectCwd: repo,
    task,
    permissionMode: 'acceptEdits',
    variants: [{ label: 'Variante K1', tree: { 'CLAUDE.md': '# Projeto E2E\n\nResponda em uma linha.\n' } }]
  })
  await page.getByText(task).first().click()

  // Both runs finish → blind selection with two anonymous candidates.
  await expect(page.getByRole('heading', { name: 'Seleção cega' })).toBeVisible({ timeout: 180_000 })
  await expect(page.getByText(/^Candidato [AB]$/)).toHaveCount(2)
  await expect(page.getByText('Pronto: resultado.md foi criado.')).toHaveCount(2)
  // Labels are hidden until the decision.
  await expect(page.getByText('Variante K1')).toHaveCount(0)
  const blind = (await invoke<RoundView[]>('lab:list', repo)).find((r) => r.id === created.id)!
  expect(blind.status).toBe('selecting')
  expect(blind.blindMap).toBeUndefined()
  const worktrees = blind.variants.map((v) => v.worktree?.path).filter((p): p is string => !!p)
  expect(worktrees).toHaveLength(2)
  for (const wt of worktrees) expect(existsSync(join(wt, 'resultado.md'))).toBe(true)

  await page.getByText('Escolher A').click()
  await page.getByPlaceholder(/Por quê\?/).fill('Escolha do teste E2E.')
  await page.getByRole('button', { name: 'Confirmar A' }).click()
  await expect
    .poll(async () => (await invoke<RoundView[]>('lab:list', repo)).find((r) => r.id === created.id)?.status, {
      timeout: 30_000
    })
    .toBe('decided')
  const decided = (await invoke<RoundView[]>('lab:list', repo)).find((r) => r.id === created.id)!
  expect(Object.keys(decided.blindMap ?? {}).sort()).toEqual(['A', 'B'])

  // Cleanup removes the round's worktrees (the fixture accepts any confirmation dialog).
  await page.getByRole('button', { name: 'Limpar worktrees e sessões' }).click()
  await expect
    .poll(async () => (await invoke<RoundView[]>('lab:list', repo)).find((r) => r.id === created.id)?.cleanedUp, {
      timeout: 60_000
    })
    .toBe(true)
  for (const wt of worktrees) expect(existsSync(wt)).toBe(false)
  const listed = git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
  expect(listed).toHaveLength(1)
  // The project itself was not touched by the round.
  expect(existsSync(join(repo, 'resultado.md'))).toBe(false)
})
