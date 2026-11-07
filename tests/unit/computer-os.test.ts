// Computer workstation on macOS and Linux: the guard per system (Cmd is a normal modifier on a Mac; Super, console
// switching and the terminal shortcut are refused on Linux), the app pickers' parsers (.desktop entries, Info.plist)
// and the Linux driver against a scripted fake of the X tools (stacking, window properties, capture with the other
// apps blacked out, secrets typed through stdin, keys, presence).
import { describe, expect, it } from 'vitest'
import { bundleExecutable, parseDesktopEntry } from '../../src/main/features/computer/apps'
import {
  LinuxDriver,
  keysym,
  parseGeometry,
  parseStacking,
  parseXprop,
  type Exec
} from '../../src/main/features/computer/driver/linux'
import {
  allowedAppOf,
  blockedReason,
  comboRefusal,
  normalizeCombo,
  warningFor
} from '../../src/main/features/computer/guard'
import { fakeWindow } from '../../src/main/features/computer/driver/fake'

describe('guard per system', () => {
  it('macOS: Cmd+S saves; app switching, Force Quit, lock and logout are refused', () => {
    expect(normalizeCombo('s', ['command'], 'darwin').combo).toBe('cmd+s')
    expect(comboRefusal('s', ['cmd'], 'darwin')).toBeUndefined()
    expect(comboRefusal('Return', [], 'darwin')).toBeUndefined()
    expect(comboRefusal('Tab', ['cmd'], 'darwin')).toMatch(/desktop_open/)
    expect(comboRefusal('space', ['cmd'], 'darwin')).toBeTruthy()
    expect(comboRefusal('Escape', ['cmd', 'option'], 'darwin')).toMatch(/Forçar Encerrar/)
    expect(comboRefusal('q', ['ctrl', 'cmd'], 'darwin')).toMatch(/bloqueia a tela/)
    expect(comboRefusal('q', ['cmd', 'shift'], 'darwin')).toMatch(/encerra a sessão/)
    expect(comboRefusal('Escape', ['ctrl', 'option'], 'darwin')).toMatch(/parar/)
  })
  it('Linux: Super, console switching, lock, the terminal and the run dialog are refused', () => {
    expect(normalizeCombo('s', ['meta'], 'linux').modifiers).toEqual(['super'])
    expect(comboRefusal('s', ['ctrl'], 'linux')).toBeUndefined()
    expect(comboRefusal('a', ['super'], 'linux')).toMatch(/Super/)
    expect(comboRefusal('F2', ['ctrl', 'alt'], 'linux')).toBeTruthy()
    expect(comboRefusal('t', ['ctrl', 'alt'], 'linux')).toMatch(/terminal/)
    expect(comboRefusal('F2', ['alt'], 'linux')).toBeTruthy()
    expect(comboRefusal('Tab', ['alt'], 'linux')).toBeTruthy()
    expect(comboRefusal('End', ['ctrl', 'alt'], 'linux')).toMatch(/parar/)
  })
  it('knows the system tools of each system and the shell windows of Linux', () => {
    expect(blockedReason('System Settings')).toBeTruthy()
    expect(blockedReason('Keychain Access')).toBeTruthy()
    expect(blockedReason('gnome-control-center')).toBeTruthy()
    expect(blockedReason('polkit-gnome-authentication-agent-1')).toBeTruthy()
    expect(warningFor('Safari')).toMatch(/navegador/)
    expect(warningFor('gnome-terminal-server')).toMatch(/terminal/)
    const panel = fakeWindow({ hwnd: 3, title: 'Top Bar', process: 'erp', className: 'dock' })
    expect(allowedAppOf(panel, [{ name: 'ERP', process: 'erp' }])).toBeUndefined()
  })
})

describe('app pickers', () => {
  it('reads a .desktop entry (env and field codes, flatpak, hidden entries)', () => {
    expect(
      parseDesktopEntry('[Desktop Entry]\nType=Application\nName=LibreOffice Calc\nExec=libreoffice --calc %U\n')
    ).toEqual({
      name: 'LibreOffice Calc',
      process: 'libreoffice'
    })
    expect(
      parseDesktopEntry('[Desktop Entry]\nType=Application\nName=ERP\nExec=env LANG=pt_BR /opt/erp/bin/erp-client %f\n')
    ).toEqual({
      name: 'ERP',
      process: 'erp-client'
    })
    expect(
      parseDesktopEntry(
        '[Desktop Entry]\nType=Application\nName=GIMP\nExec=/usr/bin/flatpak run --branch=stable org.gimp.GIMP @@ %F @@\n'
      )
    ).toEqual({ name: 'GIMP', process: 'GIMP' })
    expect(parseDesktopEntry('[Desktop Entry]\nType=Application\nName=X\nNoDisplay=true\nExec=x\n')).toBeUndefined()
    expect(parseDesktopEntry('[Desktop Entry]\nType=Link\nName=X\nURL=http://x\n')).toBeUndefined()
  })
  it('reads the executable of a macOS app bundle', () => {
    expect(bundleExecutable('<dict><key>CFBundleExecutable</key>\n\t<string>Microsoft Excel</string></dict>')).toBe(
      'Microsoft Excel'
    )
    expect(bundleExecutable('bplist00…')).toBeUndefined()
  })
})

describe('Linux driver', () => {
  it('parses the X tools', () => {
    expect(parseStacking('_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1a00003, 0x2200007')).toEqual([
      0x1a00003, 0x2200007
    ])
    const p = parseXprop(
      '_NET_WM_PID(CARDINAL) = 4242\n_NET_WM_NAME(UTF8_STRING) = "Planilha \\"Q3\\" - LibreOffice"\nWM_CLASS(STRING) = "libreoffice", "libreoffice-calc"\n' +
        '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_FOCUSED'
    )
    expect(p).toEqual({
      pid: 4242,
      title: 'Planilha "Q3" - LibreOffice',
      wmClass: 'libreoffice-calc',
      type: 'normal',
      hidden: false
    })
    expect(parseXprop('WM_NAME(STRING) = "xterm"\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN').title).toBe('xterm')
    expect(parseXprop('_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN').hidden).toBe(true)
    expect(
      parseGeometry(
        '  Absolute upper-left X:  10\n  Absolute upper-left Y:  20\n  Relative upper-left X:  1\n  Width: 800\n  Height: 600\n'
      )
    ).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600
    })
    expect(keysym('return')).toBe('Return')
    expect(keysym('f5')).toBe('F5')
    expect(keysym('pagedown')).toBe('Next')
  })

  /** A pretend X session: two windows (an editor below, a chat app above it) and the commands it received. */
  function session() {
    const calls: { cmd: string; args: string[]; input?: string }[] = []
    const out = (s: string | Buffer, code = 0) => ({
      code,
      stdout: Buffer.isBuffer(s) ? s : Buffer.from(s),
      stderr: ''
    })
    const exec: Exec = async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, input: opts.input })
      if (cmd === 'sh') return out('/usr/bin/x')
      if (cmd === 'python3') return out('', 1) // no AT-SPI here
      if (cmd === 'xprop' && args[0] === '-root')
        return out('_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x100, 0x200')
      if (cmd === 'xprop' && args[1] === '256')
        return out(
          '_NET_WM_PID(CARDINAL) = 1\n_NET_WM_NAME(UTF8_STRING) = "nota.txt - gedit"\nWM_CLASS(STRING) = "gedit", "Gedit"'
        )
      if (cmd === 'xprop' && args[1] === '512')
        return out('_NET_WM_PID(CARDINAL) = 2\n_NET_WM_NAME(UTF8_STRING) = "Chat"\nWM_CLASS(STRING) = "chat", "Chat"')
      if (cmd === 'xwininfo')
        return out(
          args[1] === '256'
            ? 'Absolute upper-left X: 100\nAbsolute upper-left Y: 100\nWidth: 2000\nHeight: 1000'
            : 'Absolute upper-left X: 1900\nAbsolute upper-left Y: 150\nWidth: 400\nHeight: 300'
        )
      if (cmd === 'xdotool' && args[0] === 'getactivewindow') return out('256')
      if (cmd === 'xdotool' && args[0] === 'getmouselocation') return out('X=5\nY=6\nSCREEN=0\nWINDOW=1')
      if (cmd === 'xprintidle') return out('2500')
      if (cmd === 'import') return out(Buffer.from('PNGDATA'))
      return out('')
    }
    return { calls, driver: new LinuxDriver(exec, { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }) }
  }

  it('lists windows top to bottom and captures the window with the app above it blacked out and scaled', async () => {
    const { calls, driver } = session()
    await driver.start()
    expect(driver.notice).toMatch(/AT-SPI/)
    const ws = await driver.windows()
    expect(ws.map((w) => w.title)).toEqual(['Chat', 'nota.txt - gedit'])
    expect(ws[1].foreground).toBe(true)
    const cap = await driver.capture(256, { maxWidth: 1000, allowedPids: [1], ignoreHwnds: [] })
    expect(cap).toMatchObject({
      width: 1000,
      height: 500,
      scale: 0.5,
      masked: [{ x: 1900, y: 150, width: 200, height: 300 }]
    })
    const imp = calls.find((c) => c.cmd === 'import')!.args
    expect(imp).toEqual(
      expect.arrayContaining([
        '-crop',
        '2000x1000+100+100',
        '-fill',
        'black',
        'rectangle 1800,50 1999,349',
        '-resize',
        '1000x500!',
        'png:-'
      ])
    )
    // the indicator windows are not blacked out
    const again = await driver.capture(256, { maxWidth: 3000, allowedPids: [1], ignoreHwnds: [512] })
    expect(again.masked).toEqual([])
    // the window under a point skips the indicator windows too
    expect((await driver.hit(2000, 200))?.title).toBe('Chat')
    expect((await driver.hit(2000, 200, [512]))?.title).toBe('nota.txt - gedit')
  })

  it('types through stdin (a secret never shows in a process list) and maps keys', async () => {
    const { calls, driver } = session()
    await driver.type('s3nh4')
    const t = calls.find((c) => c.args[0] === 'type')!
    expect(t.args).toEqual(['type', '--clearmodifiers', '--delay', '12', '--file', '-'])
    expect(t.input).toBe('s3nh4')
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain('s3nh4')
    await driver.key('s', ['ctrl'])
    await driver.key('Return', [])
    expect(calls.filter((c) => c.args[0] === 'key').map((c) => c.args.at(-1))).toEqual(['ctrl+s', 'Return'])
    await driver.click(10, 20, { double: true })
    expect(calls.find((c) => c.args[0] === 'mousemove')!.args).toEqual([
      'mousemove',
      '--sync',
      '10',
      '20',
      'click',
      '--repeat',
      '2',
      '--delay',
      '80',
      '1'
    ])
  })

  it('reports the person’s input for the pause', async () => {
    const { driver } = session()
    const r = await driver.idle()
    expect(r.now - r.lastInput).toBe(2500)
    expect(r.cursor).toEqual({ x: 5, y: 6 })
    expect(r.locked).toBe(false)
  })

  it('refuses to start without a display or the tools', async () => {
    await expect(
      new LinuxDriver(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }), {}).start()
    ).rejects.toThrow(/X11/)
    const none: Exec = async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: '' })
    await expect(new LinuxDriver(none, { DISPLAY: ':0' }).start()).rejects.toThrow(
      /sudo apt install xdotool x11-utils xprintidle imagemagick/
    )
  })
})
