// Opt-in (HANGAR_REAL_COMPUTER=1, Windows): the helper's watch mode on the REAL screen, against Windows' own Character
// Map (signed, saves nothing). It clicks and types with SendInput, so it asks the helper to accept injected input
// (acceptInjected, tests only: in the app the person's own input is what counts). It moves the mouse and types: do not
// touch the computer while it runs, and close full-screen apps (a game in front takes the clicks).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WindowsDriver } from '../../src/main/features/computer/driver/windows'

const REAL = process.env.HANGAR_REAL_COMPUTER === '1' && process.platform === 'win32'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!REAL)('recording a task on the real screen (opt-in)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-real-rec-'))
  let app: ChildProcess | undefined
  afterAll(async () => {
    app?.kill()
    await wait(1500) // the helper exits ~0.5 s after dispose(); its .exe is locked until then
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the OS cleans the temp folder later */
    }
  })

  it('records the click with its element and the field value, only in the watched app', async () => {
    const d = new WindowsDriver(join(dir, 'helper'), async () => '')
    await d.start()
    app = spawn('C:\\Windows\\System32\\charmap.exe', [], { stdio: 'ignore' })
    await wait(2000)
    const win = (await d.windows()).find((w) => w.process.toLowerCase() === 'charmap')
    expect(win).toBeDefined()
    await d.focus(win!.hwnd)
    const fg = await d.foreground()
    if (fg?.process.toLowerCase() !== 'charmap') throw new Error(`outra janela na frente (${fg?.process}): feche-a`)
    const els = await d.elements(win!.hwnd, 100)
    const field = els.find((e) => e.type === 'edit' && e.name.length > 0)!
    const button = els.find((e) => e.type === 'button')!
    await d.watchStart({ processes: ['charmap'], maxWidth: 800, ignoreHwnds: [], acceptInjected: true })
    await d.click(field.x + 10, field.y + Math.floor(field.height / 2), {})
    await wait(600)
    await d.type('abc')
    await wait(400)
    await d.click(button.x + Math.floor(button.width / 2), button.y + Math.floor(button.height / 2), {})
    await wait(1000)
    const events = await d.watchStop()
    d.dispose()
    const clicks = events.filter((e) => e.kind === 'click' && !e.outside)
    expect(clicks[0]).toMatchObject({ process: 'charmap', element: { type: 'edit' } })
    expect(clicks[0].frame?.length).toBeGreaterThan(100)
    expect(events.find((e) => e.kind === 'type')).toMatchObject({ value: expect.stringContaining('abc') })
    expect(clicks.some((e) => e.element?.type === 'button')).toBe(true)
  }, 60_000)
})
