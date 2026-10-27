// Renders the product video: video/index.html captured frame by frame in an offscreen Electron window, encoded with
// ffmpeg, then mixed with the narration (video/narration/<scene>.wav, from tts.mjs) and a soft synthesized pad.
//
//   npx electron video/render.cjs                 → video/out/agent-hangar-desktop.mp4
//   npx electron video/render.cjs --stills 2,9.5  → video/out/stills/t<seconds>.png (quick look at instants)
//   options: --fps 30 (default), --no-audio
//
// Scene lengths follow the narration: max(minDuration, clip + lead + tail), so the voice never gets cut.
const { app, BrowserWindow } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const DIR = __dirname
const OUT = join(DIR, 'out')
const W = 1920
const H = 1080
const LEAD = 0.35 // the voice starts this long after its scene
const TAIL = 0.75 // and the scene holds this long after the voice ends

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const FPS = Number(opt('--fps', 30))
const stills = opt('--stills')
const withAudio = !args.includes('--no-audio')

const script = JSON.parse(readFileSync(join(DIR, 'script.json'), 'utf8'))
const clip = (id) => join(DIR, 'narration', `${id}.wav`)
const probe = (file) =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8'
    }).trim()
  )

function timing() {
  const durations = {}
  const voice = {}
  for (const s of script.scenes) {
    const has = existsSync(clip(s.id))
    voice[s.id] = has ? probe(clip(s.id)) : 0
    durations[s.id] = Math.max(s.minDuration, has ? LEAD + voice[s.id] + TAIL : s.minDuration)
  }
  return { durations, voice }
}

function ffmpeg(argv) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], {
    stdio: ['pipe', 'inherit', 'inherit']
  })
  const done = new Promise((resolve, reject) =>
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
  )
  return { stdin: p.stdin, done }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  // A normal window kept hidden: capturePage then returns exactly what was just drawn (offscreen rendering's paint
  // events lag a frame behind). It paints while hidden thanks to paintWhenInitiallyHidden and no throttling.
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false }
  })
  await win.loadFile(join(DIR, 'index.html'))
  win.webContents.setZoomFactor(1)
  const { durations, voice } = timing()
  const { total, starts } = await win.webContents.executeJavaScript(
    `window.ready.then(() => window.setDurations(${JSON.stringify(durations)}))`
  )
  console.log(
    `timeline ${total.toFixed(1)} s · ${script.scenes.map((s) => `${s.id} ${durations[s.id].toFixed(1)}`).join(' · ')}`
  )

  const frameAt = async (t) => {
    await win.webContents.executeJavaScript(
      `window.renderAt(${t}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`
    )
    const img = await win.webContents.capturePage()
    const size = img.getSize()
    return size.width === W && size.height === H ? img : img.resize({ width: W, height: H, quality: 'best' })
  }

  // The first capture after loading comes back empty: take one and discard it.
  await frameAt(0)

  const probeAt = opt('--probe')
  if (probeAt) {
    for (const t of probeAt.split(',').map(Number)) {
      const r = await win.webContents.executeJavaScript(
        `(() => { try { window.renderAt(${t}); return [...document.querySelectorAll('.scene')].map((s, i) => i + ':' + Number(s.style.opacity).toFixed(2)).join(' ') } catch (e) { return 'ERR ' + e.stack } })()`
      )
      console.log(`t=${t} ${r}`)
    }
    return
  }

  if (stills) {
    const dir = join(OUT, 'stills')
    mkdirSync(dir, { recursive: true })
    const { writeFileSync } = require('node:fs')
    for (const t of stills.split(',').map(Number)) writeFileSync(join(dir, `t${t}.png`), (await frameAt(t)).toPNG())
    console.log(`stills written to ${dir}`)
    return
  }

  const silent = join(OUT, 'video-silent.mp4')
  const enc = ffmpeg([
    '-f',
    'rawvideo',
    '-pix_fmt',
    'bgra',
    '-s',
    `${W}x${H}`,
    '-r',
    String(FPS),
    '-i',
    '-',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    silent
  ])
  const frames = Math.ceil(total * FPS)
  const started = Date.now()
  for (let f = 0; f < frames; f++) {
    const img = await frameAt(f / FPS)
    if (!enc.stdin.write(img.toBitmap())) await new Promise((r) => enc.stdin.once('drain', r))
    if (f % (FPS * 5) === 0) console.log(`frame ${f}/${frames} (${((Date.now() - started) / 1000).toFixed(0)} s)`)
  }
  enc.stdin.end()
  await enc.done

  const final = join(OUT, 'agent-hangar-desktop.mp4')
  if (!withAudio) {
    console.log(`video (no audio): ${silent}`)
    return
  }
  // Narration clips at their scene starts, over a quiet pad (A minor add9, slow swell) and a low hit on the logo.
  const clips = script.scenes.filter((s) => voice[s.id] > 0)
  const inputs = ['-i', silent]
  for (const s of clips) inputs.push('-i', clip(s.id))
  const pad =
    "aevalsrc='0.045*(sin(2*PI*110*t)+0.7*sin(2*PI*164.81*t)+0.55*sin(2*PI*220*t)+0.35*sin(2*PI*246.94*t)+0.3*sin(2*PI*329.63*t))*(0.65+0.35*sin(2*PI*0.07*t))'" +
    `:s=48000:d=${total.toFixed(2)}`
  const hit = "aevalsrc='0.55*sin(2*PI*55*t)*exp(-2.5*t)+0.2*sin(2*PI*110*t)*exp(-4*t)':s=48000:d=2.5"
  inputs.push('-f', 'lavfi', '-i', pad, '-f', 'lavfi', '-i', hit)
  const padIdx = clips.length + 1
  const hitIdx = clips.length + 2
  const filters = clips.map(
    (s, i) =>
      `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round((starts[s.id] + LEAD) * 1000)}:all=1[v${i}]`
  )
  const voices = clips.map((_, i) => `[v${i}]`).join('')
  filters.push(
    `[${padIdx}:a]aformat=channel_layouts=stereo,lowpass=f=1400,afade=t=in:d=2,afade=t=out:st=${(total - 3).toFixed(2)}:d=3,volume=0.55[pad]`,
    `[${hitIdx}:a]aformat=channel_layouts=stereo,adelay=${Math.round(starts.logo * 1000)}:all=1,volume=0.8[hit]`,
    // Two copies of the voice: one drives the ducking of the pad, the other is heard.
    clips.length
      ? `${voices}amix=inputs=${clips.length}:normalize=0,volume=1.6,asplit=2[voice][voice2]`
      : `anullsrc=r=48000:cl=stereo:d=${total.toFixed(2)},asplit=2[voice][voice2]`,
    `[pad][voice]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[duck]`,
    `[duck][voice2][hit]amix=inputs=3:normalize=0,alimiter=limit=0.95[a]`
  )
  const graph = filters.join(';')
  const mux = ffmpeg([
    ...inputs,
    '-filter_complex',
    graph,
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-t',
    total.toFixed(2),
    '-movflags',
    '+faststart',
    final
  ])
  mux.stdin.end()
  await mux.done
  rmSync(silent, { force: true })
  console.log(`video: ${final}`)
}

app.disableHardwareAcceleration()
app.whenReady().then(() =>
  main()
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
    .finally(() => app.quit())
)
