// Third-party notices: every package the app ships (the production dependency tree, plus Electron's runtime) with its
// version, license and license text, for the About screen (Configurações → Sobre). Writes
// resources/third-party-notices.json; run after dependency changes:  node build/third-party.cjs
// (npm run notices; `npm run check:notices` tells whether the committed file is current).
const { execSync } = require('node:child_process')
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const out = join(root, 'resources', 'third-party-notices.json')
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i

function licenseText(dir) {
  if (!dir || !existsSync(dir)) return undefined
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
  const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim())
  return texts.length ? texts.join('\n\n') : undefined
}

function repoUrl(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url
  if (!url) return undefined
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/')
}

const tree = JSON.parse(execSync('npm query .prod', { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const self = require(join(root, 'package.json')).name

const packages = new Map()
for (const p of tree) {
  if (!p.name || p.name === self) continue
  // The Agent SDK's per-platform binary packages carry the SDK's own license (listed once, as the SDK); only the one
  // for the build machine is installed, so listing it would make the file differ between operating systems.
  if (/^@anthropic-ai\/claude-agent-sdk-/.test(p.name)) continue
  const key = `${p.name}@${p.version}`
  if (packages.has(key)) continue
  const pkg = existsSync(join(p.path, 'package.json'))
    ? JSON.parse(readFileSync(join(p.path, 'package.json'), 'utf8'))
    : {}
  packages.set(key, {
    name: p.name,
    version: p.version,
    license: typeof p.license === 'string' ? p.license : (p.license?.type ?? 'desconhecida'),
    repository: repoUrl(pkg.repository) ?? (pkg.homepage || undefined),
    text: licenseText(p.path)
  })
}

// Electron is a devDependency of the source tree but its runtime (and Chromium's) ships inside the app.
const electronDir = join(root, 'node_modules', 'electron')
const electron = require(join(electronDir, 'package.json'))
packages.set(`electron@${electron.version}`, {
  name: 'electron',
  version: electron.version,
  license: electron.license,
  repository: 'https://github.com/electron/electron',
  text:
    licenseText(electronDir) +
    '\n\nChromium and its third-party components: see LICENSES.chromium.html next to the application executable.'
})

const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const json = `${JSON.stringify(list, null, 1)}\n`
if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : ''
  if (current !== json) {
    console.error('resources/third-party-notices.json is out of date: run `npm run notices`.')
    process.exit(1)
  }
  console.log(`third-party notices up to date (${list.length} packages)`)
} else {
  writeFileSync(out, json)
  console.log(`wrote ${list.length} packages to ${out}`)
}
