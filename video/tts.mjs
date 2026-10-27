// Narration for the product video: one clip per scene of script.json, through OpenRouter's speech endpoint
// (POST /api/v1/audio/speech; Gemini TTS answers raw PCM, 24 kHz, 16-bit, mono), saved as video/narration/<scene>.wav.
//
// Run it yourself with your key in the environment (it is read here and sent only to openrouter.ai, never written):
//   PowerShell:  $env:OPENROUTER_API_KEY = '<sua chave>'; node video/tts.mjs
//   bash:        OPENROUTER_API_KEY=<sua chave> node video/tts.mjs
// Options: --only <scene,scene> (redo some clips), --voice <name>, --model <id>.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error('Defina OPENROUTER_API_KEY no ambiente (veja o comentário no topo deste arquivo).')
  process.exit(1)
}
const script = JSON.parse(readFileSync(join(DIR, 'script.json'), 'utf8'))
const only = opt('--only')?.split(',')
const voice = opt('--voice') ?? script.voice
const model = opt('--model') ?? script.model
const out = join(DIR, 'narration')
mkdirSync(out, { recursive: true })

let total = 0
for (const scene of script.scenes) {
  if (only && !only.includes(scene.id)) continue
  const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'x-title': 'Agent Hangar Desktop video'
    },
    body: JSON.stringify({
      model,
      voice,
      input: scene.narration,
      instructions: script.instructions,
      response_format: 'pcm'
    })
  })
  if (!res.ok) {
    console.error(`${scene.id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    process.exit(1)
  }
  const audio = Buffer.from(await res.arrayBuffer())
  const wav = join(out, `${scene.id}.wav`)
  if (audio.subarray(0, 4).toString('latin1') === 'RIFF') {
    writeFileSync(wav, audio)
  } else {
    const pcm = join(out, `${scene.id}.pcm`)
    writeFileSync(pcm, audio)
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      's16le',
      '-ar',
      '24000',
      '-ac',
      '1',
      '-i',
      pcm,
      wav
    ])
    rmSync(pcm)
  }
  const seconds = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], {
      encoding: 'utf8'
    })
  )
  total += seconds
  console.log(`${scene.id}: ${seconds.toFixed(1)} s`)
}
console.log(`narração: ${total.toFixed(1)} s em ${out}`)
