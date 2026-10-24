// Generates build/icon.png (512px) and build/icon.ico (256/128/64/48/32/16) from the inline SVG below.
// Run with Electron (it rasterizes the SVG in an offscreen canvas):  npx electron build/make-icons.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

// Hangar mark: a stylized arched hangar in the brand accent on a light rounded tile.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="112" fill="#faf9f5"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="111.5" fill="none" stroke="#e3e0d6" stroke-width="3"/>
  <path d="M92 388 V292 A164 164 0 0 1 420 292 V388 Z" fill="#c96442"/>
  <path d="M178 388 V318 A78 78 0 0 1 334 318 V388 Z" fill="#faf9f5"/>
  <rect x="178" y="330" width="156" height="12" fill="#c96442" opacity="0.35"/>
  <rect x="178" y="356" width="156" height="12" fill="#c96442" opacity="0.35"/>
  <rect x="64" y="384" width="384" height="28" rx="14" fill="#a9502f"/>
</svg>`

const ICO_SIZES = [256, 128, 64, 48, 32, 16]

function buildIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // palette
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const render = (size) =>
    win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = c.height = ${size}
        const g = c.getContext('2d')
        g.imageSmoothingQuality = 'high'
        g.drawImage(img, 0, 0, ${size}, ${size})
        resolve(c.toDataURL('image/png').split(',')[1])
      }
      img.onerror = reject
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(SVG).toString('base64'))}
    })`)

  const dir = __dirname
  writeFileSync(join(dir, 'icon.png'), Buffer.from(await render(512), 'base64'))
  const pngs = []
  for (const size of ICO_SIZES) pngs.push({ size, data: Buffer.from(await render(size), 'base64') })
  writeFileSync(join(dir, 'icon.ico'), buildIco(pngs))
  console.log('icons written to', dir)
  app.quit()
})
