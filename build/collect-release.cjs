// Gathers the artifacts of every build job (one folder per job, as actions/download-artifact leaves them) into one
// flat folder for the release, merging the auto-update files that more than one job writes. Each macOS architecture
// builds on its own runner and writes its own latest-mac.yml; electron-updater expects a single latest-mac.yml listing
// both zips (it picks the one for its CPU), so the `files` lists are merged. Other update files (latest.yml,
// latest-linux.yml, latest-linux-arm64.yml) come from one job each and are copied as they are.
// Usage: node build/collect-release.cjs <artifacts dir> <output dir>
const { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } = require('node:fs')
const { basename, join } = require('node:path')
const yaml = require('js-yaml')

const [inputDir, outDir] = process.argv.slice(2)
if (!inputDir || !outDir) {
  console.error('Usage: node build/collect-release.cjs <artifacts dir> <output dir>')
  process.exit(2)
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

// Update-info files: <channel>.yml, <channel>-mac.yml, <channel>-linux[-arm64].yml (channel: latest, beta, …).
const isUpdateInfo = (name) => /^[a-z0-9]+(-mac|-linux(-arm64)?)?\.yml$/i.test(name) && !name.startsWith('builder-')

mkdirSync(outDir, { recursive: true })
const updateInfo = new Map()
let copied = 0
for (const file of walk(inputDir)) {
  const name = basename(file)
  if (name.startsWith('builder-')) continue // electron-builder debug files (builder-debug.yml, …), not release assets
  if (isUpdateInfo(name)) {
    if (!updateInfo.has(name)) updateInfo.set(name, [])
    updateInfo.get(name).push(yaml.load(readFileSync(file, 'utf8')))
    continue
  }
  const target = join(outDir, name)
  if (existsSync(target)) {
    if (!readFileSync(target).equals(readFileSync(file))) {
      console.error(`Two different artifacts are named ${name}.`)
      process.exit(1)
    }
    continue
  }
  copyFileSync(file, target)
  copied++
}

for (const [name, infos] of updateInfo) {
  const versions = new Set(infos.map((i) => i.version))
  if (versions.size !== 1) {
    console.error(`${name}: jobs built different versions (${[...versions].join(', ')}).`)
    process.exit(1)
  }
  const merged = { ...infos[0], files: [] }
  for (const info of infos) {
    for (const f of info.files ?? []) {
      const same = merged.files.find((m) => m.url === f.url)
      if (!same) merged.files.push(f)
      else if (same.sha512 !== f.sha512) {
        console.error(`${name}: ${f.url} has different checksums in two jobs.`)
        process.exit(1)
      }
    }
    if (info.releaseDate > merged.releaseDate) merged.releaseDate = info.releaseDate
  }
  for (const f of merged.files) {
    if (!existsSync(join(outDir, f.url))) {
      console.error(`${name} lists ${f.url}, which no job produced.`)
      process.exit(1)
    }
  }
  writeFileSync(join(outDir, name), yaml.dump(merged, { lineWidth: -1 }))
  console.log(
    `${name}: ${infos.length} job(s), ${merged.files.length} file(s) — ${merged.files.map((f) => f.url).join(', ')}`
  )
}
console.log(`${copied} artifact(s) copied to ${outDir}`)
