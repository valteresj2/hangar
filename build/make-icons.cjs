// Generates the app icons from the inline SVG below, in the Agent Hangar platform brand (mark yellow #F4B400 on the
// tarmac #1C2530, tokens in src/renderer/src/theme/tokens.json):
//   build/icon.png   1024 px, full tile (Linux; electron-builder also derives other sizes from it)
//   build/icon.ico   256/128/64/48/32/16 (Windows exe, NSIS installer and uninstaller)
//   build/icon.icns  16…1024 px on the macOS icon grid (824 px tile with margin, like the system icons)
// Run with Electron (it rasterizes the SVG in an offscreen canvas):  npx electron build/make-icons.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const TARMAC = '#1C2530'
const TARMAC_2 = '#26313E'
const MARK = '#F4B400'

// Artwork drawn on a 1024 grid for a full-bleed tile (32 px margin). `scale` shrinks it around the centre for the
// macOS grid (824 / 960 keeps the tile at 824 px).
function svg({ scale = 1 } = {}) {
  const t = (1 - scale) * 512
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#232E3B"/>
      <stop offset="1" stop-color="${TARMAC}"/>
    </linearGradient>
  </defs>
  <g transform="translate(${t} ${t}) scale(${scale})">
    <rect x="32" y="32" width="960" height="960" rx="216" fill="url(#tile)"/>
    <rect x="34" y="34" width="956" height="956" rx="214" fill="none" stroke="${TARMAC_2}" stroke-width="4"/>
    <g transform="translate(0 -24)">
    <!-- hangar: arched shed with an open door (raised 24 px to centre it optically) -->
    <path d="M184 760 V584 A328 328 0 0 1 840 584 V760 Z" fill="${MARK}"/>
    <path d="M352 760 V636 A160 160 0 0 1 672 636 V760 Z" fill="${TARMAC}"/>
    <rect x="352" y="664" width="320" height="18" fill="${TARMAC_2}"/>
    <rect x="352" y="708" width="320" height="18" fill="${TARMAC_2}"/>
    <!-- apron with runway centre-line dashes -->
    <rect x="128" y="760" width="768" height="56" rx="28" fill="${MARK}"/>
    <rect x="236" y="780" width="88" height="16" rx="8" fill="${TARMAC}"/>
    <rect x="468" y="780" width="88" height="16" rx="8" fill="${TARMAC}"/>
    <rect x="700" y="780" width="88" height="16" rx="8" fill="${TARMAC}"/>
    </g>
  </g>
</svg>`
}

const ICO_SIZES = [256, 128, 64, 48, 32, 16]
// icns entries holding PNG data: type → pixel size (ic11–ic14 are the @2x variants).
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['icp6', 64],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic13', 256],
  ['ic09', 512],
  ['ic14', 512],
  ['ic10', 1024]
]

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

function buildIcns(entries) {
  const chunks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([head, data])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'latin1')
  header.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const render = async (source, size) =>
    Buffer.from(
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
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
        img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(source).toString('base64'))}
      })`),
      'base64'
    )

  const full = svg()
  const mac = svg({ scale: 824 / 960 })
  const dir = __dirname
  writeFileSync(join(dir, 'icon.png'), await render(full, 1024))
  const pngs = []
  for (const size of ICO_SIZES) pngs.push({ size, data: await render(full, size) })
  writeFileSync(join(dir, 'icon.ico'), buildIco(pngs))
  const icns = []
  for (const [type, size] of ICNS_TYPES) icns.push({ type, data: await render(mac, size) })
  writeFileSync(join(dir, 'icon.icns'), buildIcns(icns))
  console.log('icons written to', dir)
  app.quit()
})
