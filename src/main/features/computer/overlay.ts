// The "an employee is using this computer" indicator: an always-on-top pill (name, task, status, Retomar agora, Parar)
// and a colored border around the window it works in. Both are content-protected, so they never show in the captures
// the employee gets (and the helper skips them when it blacks out other apps). The buttons tell the main process
// through the page title (the app's hardening blocks navigations), so the page needs no preload and no IPC.
import { BrowserWindow, screen } from 'electron'
import type { ComputerStatus } from '../../../shared/features/computer'
import type { Rect } from './driver/types'

export interface IndicatorView {
  status: ComputerStatus
  employee: string
  task?: string
  detail?: string
  shortcut: string
}

const PILL_W = 620
const PILL_H = 48

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:13px "Segoe UI",system-ui,sans-serif;user-select:none}
.pill{box-sizing:border-box;height:${PILL_H - 6}px;margin:3px;border-radius:21px;display:flex;align-items:center;gap:10px;
padding:0 8px 0 14px;background:#1d1b2e;color:#f4f2ff;border:2px solid #e8590c;box-shadow:0 4px 14px rgba(0,0,0,.35);-webkit-app-region:drag}
.dot{width:10px;height:10px;border-radius:50%;background:#e8590c;flex:none;animation:p 1.2s infinite}
.paused .dot{background:#f2c94c;animation:none}.paused{border-color:#f2c94c}
@keyframes p{50%{opacity:.35}}
.txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.txt b{font-weight:600}.sub{opacity:.75;margin-left:6px}
button{-webkit-app-region:no-drag;border:0;border-radius:14px;padding:6px 12px;font:600 12px "Segoe UI",sans-serif;cursor:pointer}
#resume{background:#3a3755;color:#fff;display:none}.paused #resume{display:inline-block}
#stop{background:#d63939;color:#fff}
.key{opacity:.6;font-size:11px;margin-left:2px}
</style></head><body><div class="pill" id="pill"><span class="dot"></span><span class="txt" id="txt"></span>
<button id="resume" title="Agir agora, mesmo que você tenha usado o computador há pouco">Retomar agora</button>
<button id="stop">Parar <span class="key" id="key"></span></button></div>
<script>
let n=0;const say=a=>{document.title=a+':'+(++n)};
document.getElementById('stop').onclick=()=>say('stop');
document.getElementById('resume').onclick=()=>say('resume');
window.render=v=>{const p=document.getElementById('pill');p.className='pill'+(v.status==='paused'?' paused':'');
const t=document.getElementById('txt');t.textContent='';const b=document.createElement('b');
b.textContent=v.employee+(v.status==='paused'?' pausou':' está usando este computador');t.appendChild(b);
const s=document.createElement('span');s.className='sub';s.textContent=[v.task,v.detail].filter(Boolean).join(' · ');t.appendChild(s);
document.getElementById('key').textContent=v.shortcut;};
</script></body></html>`

const BORDER = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
div{box-sizing:border-box;height:100%;border:3px solid #e8590c;border-radius:6px}
</style></head><body><div></div></body></html>`

const dataUrl = (html: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

function protect(win: BrowserWindow): void {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setContentProtection(true)
  win.setVisibleOnAllWorkspaces(true)
}

/** Screen pixels (helper) → DIP (Electron) on Windows; identity elsewhere. */
function toDip(r: Rect): Rect {
  try {
    return process.platform === 'win32' ? screen.screenToDipRect(null, r) : r
  } catch {
    return r
  }
}

export class Indicator {
  private pill?: BrowserWindow
  private border?: BrowserWindow
  private last?: IndicatorView

  constructor(private readonly on: { stop(): void; resume(): void }) {}

  /** The native handles of the indicator windows (the helper never blacks them out nor counts them). */
  hwnds(): number[] {
    const out: number[] = []
    for (const w of [this.pill, this.border]) {
      if (!w || w.isDestroyed()) continue
      const b = w.getNativeWindowHandle()
      out.push(b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0))
    }
    return out
  }

  show(v: IndicatorView): void {
    this.last = v
    const pill = this.ensurePill()
    void pill.webContents
      .executeJavaScript(`window.render && window.render(${JSON.stringify(v)})`)
      .catch(() => undefined)
    if (!pill.isVisible()) pill.showInactive()
  }

  /** The border around the window the employee works in (undefined: hide it). */
  target(rect: Rect | undefined): void {
    if (!rect) {
      if (this.border && !this.border.isDestroyed()) this.border.destroy()
      this.border = undefined
      return
    }
    const b = this.ensureBorder()
    const d = toDip(rect)
    b.setBounds({
      x: Math.round(d.x - 3),
      y: Math.round(d.y - 3),
      width: Math.round(d.width + 6),
      height: Math.round(d.height + 6)
    })
    if (!b.isVisible()) b.showInactive()
    this.placePill(d)
  }

  /** Not just hidden: destroyed. A hidden window would keep the app from quitting when the person closes the main
   *  window ('window-all-closed' counts every window); the indicator is cheap to create again. */
  hide(): void {
    this.dispose()
  }

  dispose(): void {
    for (const w of [this.pill, this.border]) if (w && !w.isDestroyed()) w.destroy()
    this.pill = this.border = undefined
  }

  private placePill(near?: Rect): void {
    if (!this.pill || this.pill.isDestroyed()) return
    const display = near
      ? screen.getDisplayMatching({
          x: near.x,
          y: near.y,
          width: Math.max(1, near.width),
          height: Math.max(1, near.height)
        })
      : screen.getPrimaryDisplay()
    const wa = display.workArea
    this.pill.setBounds({ x: Math.round(wa.x + (wa.width - PILL_W) / 2), y: wa.y + 6, width: PILL_W, height: PILL_H })
  }

  private ensurePill(): BrowserWindow {
    if (this.pill && !this.pill.isDestroyed()) return this.pill
    const w = new BrowserWindow({
      width: PILL_W,
      height: PILL_H,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: false,
      title: 'Agent Hangar — posto no computador',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    protect(w)
    w.webContents.on('page-title-updated', (e, title) => {
      e.preventDefault()
      if (title.startsWith('stop:')) this.on.stop()
      else if (title.startsWith('resume:')) this.on.resume()
    })
    w.webContents.once('did-finish-load', () => {
      if (this.last) this.show(this.last)
    })
    void w.loadURL(dataUrl(PAGE))
    this.pill = w
    this.placePill()
    return w
  }

  private ensureBorder(): BrowserWindow {
    if (this.border && !this.border.isDestroyed()) return this.border
    const w = new BrowserWindow({
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: false,
      title: 'Agent Hangar — janela em uso',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
    })
    protect(w)
    w.setIgnoreMouseEvents(true)
    void w.loadURL(dataUrl(BORDER))
    this.border = w
    return w
  }
}

// ------------------------------------------------------------------ recording a task
// The red "Gravando" pill while the person records a task: elapsed time, steps, Pausar/Continuar and Parar. Also
// content-protected (it never shows in the captures) and its handle is given to the helper so clicks on it are not
// recorded.

export interface RecordingView {
  title: string
  paused: boolean
  elapsed: string
  steps: number
  microphone: boolean
}

const REC_W = 520

const REC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:13px "Segoe UI",system-ui,sans-serif;user-select:none}
.pill{box-sizing:border-box;height:${PILL_H - 6}px;margin:3px;border-radius:21px;display:flex;align-items:center;gap:10px;
padding:0 8px 0 14px;background:#2a1414;color:#fff;border:2px solid #e03131;box-shadow:0 4px 14px rgba(0,0,0,.35);-webkit-app-region:drag}
.dot{width:11px;height:11px;border-radius:50%;background:#e03131;flex:none;animation:p 1s infinite}
.paused .dot{background:#f2c94c;animation:none}.paused{border-color:#f2c94c}
@keyframes p{50%{opacity:.3}}
.txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.txt b{font-weight:600}.sub{opacity:.75;margin-left:6px}
button{-webkit-app-region:no-drag;border:0;border-radius:14px;padding:6px 12px;font:600 12px "Segoe UI",sans-serif;cursor:pointer}
#pause{background:#4a2b2b;color:#fff}#stop{background:#e03131;color:#fff}
</style></head><body><div class="pill" id="pill"><span class="dot"></span><span class="txt" id="txt"></span>
<button id="pause">Pausar</button><button id="stop">Parar</button></div>
<script>
let n=0;const say=a=>{document.title=a+':'+(++n)};
document.getElementById('stop').onclick=()=>say('stop');
document.getElementById('pause').onclick=()=>say('pause');
window.render=v=>{document.getElementById('pill').className='pill'+(v.paused?' paused':'');
const t=document.getElementById('txt');t.textContent='';const b=document.createElement('b');
b.textContent=(v.paused?'Gravação pausada':'Gravando')+' · '+v.elapsed;t.appendChild(b);
const s=document.createElement('span');s.className='sub';
s.textContent=v.steps+' passo'+(v.steps===1?'':'s')+(v.microphone?' · microfone ligado':'');t.appendChild(s);
document.getElementById('pause').textContent=v.paused?'Continuar':'Pausar';};
</script></body></html>`

export class RecordingIndicator {
  private pill?: BrowserWindow
  private last?: RecordingView

  constructor(private readonly on: { stop(): void; pause(): void }) {}

  hwnds(): number[] {
    const w = this.pill
    if (!w || w.isDestroyed()) return []
    const b = w.getNativeWindowHandle()
    return [b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0)]
  }

  /** Shows (creating it) and waits until the page can render, so its handle exists before the watch starts. */
  async ready(): Promise<void> {
    const w = this.ensure()
    if (w.webContents.isLoading()) await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()))
  }

  show(v: RecordingView): void {
    this.last = v
    const w = this.ensure()
    void w.webContents.executeJavaScript(`window.render && window.render(${JSON.stringify(v)})`).catch(() => undefined)
    if (!w.isVisible()) w.showInactive()
  }

  dispose(): void {
    if (this.pill && !this.pill.isDestroyed()) this.pill.destroy()
    this.pill = undefined
  }

  private ensure(): BrowserWindow {
    if (this.pill && !this.pill.isDestroyed()) return this.pill
    const w = new BrowserWindow({
      width: REC_W,
      height: PILL_H,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: false,
      title: 'Agent Hangar — gravando uma tarefa',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    protect(w)
    w.webContents.on('page-title-updated', (e, title) => {
      e.preventDefault()
      if (title.startsWith('stop:')) this.on.stop()
      else if (title.startsWith('pause:')) this.on.pause()
    })
    w.webContents.once('did-finish-load', () => {
      if (this.last) this.show(this.last)
    })
    void w.loadURL(dataUrl(REC_PAGE))
    const wa = screen.getPrimaryDisplay().workArea
    w.setBounds({ x: Math.round(wa.x + (wa.width - REC_W) / 2), y: wa.y + 6, width: REC_W, height: PILL_H })
    this.pill = w
    return w
  }
}
