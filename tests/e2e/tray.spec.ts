import type { ElectronApplication } from '@playwright/test'
import { expect, test } from './fixtures'

/** The main window's visibility (the Quick Entry window is another, hidden, BrowserWindow). */
const mainVisible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.webContents.getURL().includes('quick-entry'))
      .some((w) => w.isVisible())
  )

const closeMain = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('quick-entry'))
      ?.close()
  })

test('primeiro X com a bandeja ligada: o app avisa uma vez que continua aberto e deixa sair', async ({ hangar }) => {
  const { app, invoke } = hangar
  await invoke('settings:patch', { minimizeToTray: true })
  // The native dialog cannot be clicked: record what it would show and answer "Manter na bandeja".
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { asked?: { message: string; buttons?: string[] }[] }
    g.asked = []
    dialog.showMessageBox = (async (opts: { message: string; buttons?: string[] }) => {
      g.asked!.push(opts)
      return { response: 0, checkboxChecked: false }
    }) as unknown as typeof dialog.showMessageBox
  })
  const asked = () =>
    app.evaluate(() => (globalThis as { asked?: { message: string; buttons?: string[] }[] }).asked ?? [])

  await closeMain(app)
  await expect.poll(async () => (await asked()).map((a) => a.message)).toEqual(['O app continua aberto na bandeja'])
  expect((await asked())[0].buttons).toEqual(['Manter na bandeja', 'Sair do app'])
  // Kept in the tray: the window is hidden, the app still runs.
  expect(await mainVisible(app)).toBe(false)

  // Next time the window just goes to the tray, without asking again.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('quick-entry'))
      ?.show()
  })
  await closeMain(app)
  await expect.poll(() => mainVisible(app)).toBe(false)
  expect(await asked()).toHaveLength(1)
})
