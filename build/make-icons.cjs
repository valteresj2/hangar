// Generates every brand image of the app from the inline SVGs below: the Agent Hangar mark (an outlined hangar with a
// gabled roof and an open door), mark yellow #F4B400 on the tarmac #1C2530 (tokens in src/renderer/src/theme/tokens.json).
//
//   build/icon.png              1024 px tile (Linux; electron-builder derives other sizes from it)
//   build/icon.ico              256…16 px (Windows exe, NSIS installer and uninstaller)
//   build/icon.icns             16…1024 px on the macOS icon grid (824 px tile with margin, like the system icons)
//   build/installerHeader.bmp   150×57, NSIS header      build/installerSidebar.bmp  164×314, NSIS welcome/finish
//   resources/icon.png          512 px window, taskbar and notification icon (loaded by src/main/features/settings/tray.ts)
//   resources/tray*.png         16/24/32 px tray icon (Windows, Linux)
//   resources/trayTemplate*.png 16/32 px black mark, macOS menu-bar template image
//
// Small sizes (≤ 32 px) use a heavier stroke and a full-bleed tile: the 1024 artwork's outline would vanish at 16 px.
// Run with Electron (it rasterizes the SVGs in an offscreen canvas):  npx electron build/make-icons.cjs
const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const TARMAC = '#1C2530'
const TARMAC_2 = '#26313E'
const MARK = '#F4B400'

/** The mark's outline on a 1024 grid: walls, gabled roof, and the open door cut into the front. */
function markPath({ l, r, apex, eave, bottom, doorL, doorR, doorTop }) {
  return `M${l} ${bottom} V${eave} L512 ${apex} L${r} ${eave} V${bottom} H${doorR} V${doorTop} H${doorL} V${bottom} Z`
}

const LARGE = { l: 232, r: 792, apex: 300, eave: 462, bottom: 760, doorL: 330, doorR: 694, doorTop: 530, stroke: 46 }
const SMALL = { l: 196, r: 828, apex: 262, eave: 444, bottom: 800, doorL: 368, doorR: 656, doorTop: 572, stroke: 104 }

function mark(geo, color, dy) {
  return `<path transform="translate(0 ${dy})" d="${markPath(geo)}" fill="none" stroke="${color}" stroke-width="${geo.stroke}"
    stroke-linejoin="round" stroke-linecap="round"/>`
}

// App tile. `scale` shrinks it around the centre for the macOS grid (824 / 960 keeps the tile at 824 px).
function tileSvg({ scale = 1, small = false } = {}) {
  const t = (1 - scale) * 512
  const geo = small ? SMALL : LARGE
  // Full-bleed for small sizes: every pixel counts.
  const [x, size, rx] = small ? [0, 1024, 200] : [32, 960, 216]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#232E3B"/>
      <stop offset="1" stop-color="${TARMAC}"/>
    </linearGradient>
  </defs>
  <g transform="translate(${t} ${t}) scale(${scale})">
    <rect x="${x}" y="${x}" width="${size}" height="${size}" rx="${rx}" fill="url(#tile)"/>
    ${small ? '' : `<rect x="34" y="34" width="956" height="956" rx="214" fill="none" stroke="${TARMAC_2}" stroke-width="4"/>`}
    ${mark(geo, MARK, small ? -6 : -18)}
  </g>
</svg>`
}

/** Mark alone (macOS template image: black on transparent; the system recolours it). */
function templateSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${mark({ ...SMALL, stroke: 112 }, '#000', -6)}</svg>`
}

const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]
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

/** 24-bit bottom-up BMP (what NSIS accepts) from RGBA pixels. */
function buildBmp(width, height, rgba) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const data = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = ((height - 1 - y) * width + x) * 4
      const dst = y * rowSize + x * 3
      data[dst] = rgba[src + 2]
      data[dst + 1] = rgba[src + 1]
      data[dst + 2] = rgba[src]
    }
  }
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(54 + data.length, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14) // BITMAPINFOHEADER
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(data.length, 34)
  header.writeInt32LE(2835, 38) // 72 dpi
  header.writeInt32LE(2835, 42)
  return Buffer.concat([header, data])
}

const font = (weight) =>
  readFileSync(
    require.resolve(`@fontsource/barlow-semi-condensed/files/barlow-semi-condensed-latin-${weight}-normal.woff2`)
  ).toString('base64')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  await win.webContents.executeJavaScript(`Promise.all([
    new FontFace('Barlow', 'url(data:font/woff2;base64,${font(600)})', { weight: '600' }).load(),
    new FontFace('Barlow', 'url(data:font/woff2;base64,${font(700)})', { weight: '700' }).load()
  ]).then((faces) => { for (const f of faces) document.fonts.add(f) })`)

  const loadSvg = (source) =>
    `new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(source).toString('base64'))}
    })`
  const png = async (source, size) =>
    Buffer.from(
      await win.webContents.executeJavaScript(`${loadSvg(source)}.then((img) => {
        const c = document.createElement('canvas')
        c.width = c.height = ${size}
        const g = c.getContext('2d')
        g.imageSmoothingQuality = 'high'
        g.drawImage(img, 0, 0, ${size}, ${size})
        return c.toDataURL('image/png').split(',')[1]
      })`),
      'base64'
    )
  // Installer bitmaps: `draw` is canvas code run in the page with `g`, `w`, `h` and the loaded `mark` image.
  const bmp = async (width, height, draw) => {
    const rgba = Buffer.from(
      await win.webContents.executeJavaScript(`${loadSvg(tileSvg())}.then((mark) => {
        const c = document.createElement('canvas')
        const w = (c.width = ${width}), h = (c.height = ${height})
        const g = c.getContext('2d')
        g.imageSmoothingQuality = 'high'
        ${draw}
        const px = g.getImageData(0, 0, w, h).data
        let s = ''
        for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000))
        return btoa(s)
      })`),
      'base64'
    )
    return buildBmp(width, height, rgba)
  }

  const buildDir = __dirname
  const resDir = join(__dirname, '..', 'resources')
  mkdirSync(resDir, { recursive: true })

  const large = tileSvg()
  const small = tileSvg({ small: true })
  const forSize = (size) => (size <= 32 ? small : large)

  writeFileSync(join(buildDir, 'icon.png'), await png(large, 1024))
  const pngs = []
  for (const size of ICO_SIZES) pngs.push({ size, data: await png(forSize(size), size) })
  writeFileSync(join(buildDir, 'icon.ico'), buildIco(pngs))
  const macLarge = tileSvg({ scale: 824 / 960 })
  const macSmall = tileSvg({ scale: 824 / 960, small: true })
  const icns = []
  for (const [type, size] of ICNS_TYPES) icns.push({ type, data: await png(size <= 32 ? macSmall : macLarge, size) })
  writeFileSync(join(buildDir, 'icon.icns'), buildIcns(icns))

  writeFileSync(join(resDir, 'icon.png'), await png(large, 512))
  writeFileSync(join(resDir, 'tray.png'), await png(small, 16))
  writeFileSync(join(resDir, 'tray@1.5x.png'), await png(small, 24))
  writeFileSync(join(resDir, 'tray@2x.png'), await png(small, 32))
  writeFileSync(join(resDir, 'trayTemplate.png'), await png(templateSvg(), 16))
  writeFileSync(join(resDir, 'trayTemplate@2x.png'), await png(templateSvg(), 32))

  // NSIS header (top right of the inner pages, on the installer's white background).
  writeFileSync(
    join(buildDir, 'installerHeader.bmp'),
    await bmp(
      150,
      57,
      `g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h)
       g.drawImage(mark, w - 46, 11, 36, 36)
       g.textAlign = 'right'; g.textBaseline = 'alphabetic'
       g.fillStyle = '${TARMAC}'; g.font = '700 15px Barlow'; g.fillText('Agent Hangar', w - 52, 28)
       g.fillStyle = '#56616E'; g.font = '600 11px Barlow'; g.fillText('Desktop', w - 52, 42)`
    )
  )
  // NSIS welcome/finish sidebar.
  const sidebar = await bmp(
    164,
    314,
    `const bg = g.createLinearGradient(0, 0, 0, h)
     bg.addColorStop(0, '#232E3B'); bg.addColorStop(1, '#151C25')
     g.fillStyle = bg; g.fillRect(0, 0, w, h)
     g.fillStyle = '${MARK}'; g.fillRect(0, 0, w, 4)
     g.drawImage(mark, 37, 54, 90, 90)
     g.textAlign = 'center'; g.textBaseline = 'alphabetic'
     g.fillStyle = '#FFFFFF'; g.font = '700 22px Barlow'; g.fillText('Agent Hangar', w / 2, 180)
     g.fillStyle = '${MARK}'; g.font = '600 14px Barlow'; g.fillText('DESKTOP', w / 2, 200)
     g.fillStyle = '#8793A1'; g.font = '600 10px Barlow'; g.fillText('© 2026 Agent Hangar', w / 2, h - 16)`
  )
  writeFileSync(join(buildDir, 'installerSidebar.bmp'), sidebar)
  writeFileSync(join(buildDir, 'uninstallerSidebar.bmp'), sidebar)

  console.log('brand images written to', buildDir, 'and', resDir)
  app.quit()
})
