// Minimal stand-in for the `electron` module in unit tests:
//   vi.mock('electron', async () => (await import('./helpers/electron')).default)
// app.getPath() points at HANGAR_TEST_USER_DATA (set it, e.g. with useTempUserData(), before the module under
// test first touches the disk). safeStorage "encrypts" reversibly without ever keeping the plain text.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const noop = () => {}

function userData(): string {
  const dir = process.env.HANGAR_TEST_USER_DATA
  if (!dir) throw new Error('HANGAR_TEST_USER_DATA is not set (call useTempUserData() first)')
  return dir
}

const app = {
  getPath: (name: string) =>
    name === 'home' ? (process.env.HANGAR_TEST_HOME ?? userData()) : join(userData(), name === 'userData' ? '' : name),
  getVersion: () => '0.0.0-test',
  getName: () => 'Hangar',
  isPackaged: false,
  on: noop,
  once: noop,
  whenReady: () => Promise.resolve(),
  quit: noop
}

/** Reversible, obviously fake "encryption": base64 of the reversed text, behind a prefix. */
const encryptString = (text: string) =>
  Buffer.from(`mock-enc:${Buffer.from([...text].reverse().join(''), 'utf8').toString('base64')}`, 'utf8')
const decryptString = (buf: Buffer) => {
  const s = buf.toString('utf8')
  if (!s.startsWith('mock-enc:')) throw new Error('not encrypted by the mock')
  return [...Buffer.from(s.slice('mock-enc:'.length), 'base64').toString('utf8')].reverse().join('')
}
// Both the synchronous API and the asynchronous one (Electron 45+) are provided.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString,
  decryptString,
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (text: string) => encryptString(text),
  decryptStringAsync: async (buf: Buffer) => ({ result: decryptString(buf), shouldReEncrypt: false })
}

const ipcMain = { handle: noop, handleOnce: noop, on: noop, once: noop, removeHandler: noop, removeAllListeners: noop }

const electron = {
  app,
  safeStorage,
  ipcMain,
  BrowserWindow: Object.assign(function BrowserWindow() {}, { getAllWindows: () => [], getFocusedWindow: () => null }),
  webContents: { getAllWebContents: () => [] },
  shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 0 })
  },
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on: noop },
  Notification: Object.assign(function Notification() {}, { isSupported: () => false }),
  session: {
    fromPartition: () => ({ setPermissionRequestHandler: noop, setPermissionCheckHandler: noop, on: noop }),
    defaultSession: { setPermissionRequestHandler: noop, on: noop }
  }
}

export default { ...electron, default: electron }

/** Creates a temp userData dir for this test file and returns a cleanup function. */
export function useTempUserData(prefix = 'hangar-unit-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  process.env.HANGAR_TEST_USER_DATA = dir
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
