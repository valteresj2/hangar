// Opt-in Linux check (see run.sh): drives the GTK Mini ERP with the real LinuxDriver (src/main/features/computer/driver/linux.ts) on Xvfb + openbox.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { LinuxDriver } from '/repo/src/main/features/computer/driver/linux.ts'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}
const d = new LinuxDriver()
await d.start()
out.notice = d.notice ?? null
let win
for (let i = 0; i < 50 && !win; i++) {
  win = (await d.windows()).find((w) => w.title === 'Mini ERP Linux')
  if (!win) await sleep(200)
}
if (!win) throw new Error('janela do app não apareceu')
out.window = { title: win.title, process: win.process, pid: win.pid, rect: win.rect }
await d.focus(win.hwnd)
out.foreground = (await d.foreground())?.title
const cap = await d.capture(win.hwnd, { maxWidth: 1366, allowedPids: [win.pid], ignoreHwnds: [] })
writeFileSync('/out/capture.png', Buffer.from(cap.png, 'base64'))
out.capture = {
  width: cap.width,
  height: cap.height,
  scale: cap.scale,
  masked: cap.masked.length,
  bytes: cap.png.length
}
const els = await d.elements(win.hwnd, 50)
out.elements = els.map((e) => `${e.type} "${e.name}"${e.password ? ' [senha]' : ''}`)
const el = (type, name) => els.find((e) => e.type === type && e.name === name)
const center = (e) => [e.x + e.width / 2, e.y + e.height / 2]
const hit = await d.hit(...center(el('edit', 'Fatura')))
out.hit = hit?.title
await d.click(...center(el('edit', 'Fatura')), {})
await d.type('88')
await d.click(...center(el('edit', 'Valor')), {})
await d.type('1500,00')
await d.click(...center(el('edit', 'Senha')), {})
await sleep(200)
out.focusedPassword = (await d.focused())?.password ?? null
await d.type('s3nh4-linux')
await d.click(...center(el('button', 'Lançar')), {})
await sleep(500)
out.log = existsSync('/out/lancamentos.log') ? readFileSync('/out/lancamentos.log', 'utf8').trim() : null
const idle = await d.idle()
out.idle = {
  sinceInputMs: idle.now - idle.lastInput,
  sinceInjectMs: idle.now - idle.lastInjectEnd,
  locked: idle.locked
}
await d.key('a', ['ctrl'])
await d.release()
out.ok = true
console.log(JSON.stringify(out, null, 2))
