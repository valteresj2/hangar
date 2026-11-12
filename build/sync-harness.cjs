// Vendors the Hangar Harness (https://github.com/valteresj2/HangarHarness) into resources/harness, where the app
// runs it from (engine/hangar/locate.ts). The harness is pure Python with no dependencies, so "vendoring" is a copy.
//
//   node build/sync-harness.cjs <path to a HangarHarness checkout>     copy from a local checkout
//   node build/sync-harness.cjs --tag v0.2.0                           clone that tag from GitHub, then copy
//
// Writes resources/harness/VERSION (version, source commit, date) so a release can be traced to the harness it ships.
const { execFileSync } = require('node:child_process')
const { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const REPO = 'https://github.com/valteresj2/HangarHarness.git'
const root = join(__dirname, '..')
const dest = join(root, 'resources', 'harness')
const args = process.argv.slice(2)

let source
let cloned
if (args[0] === '--tag' && args[1]) {
  cloned = mkdtempSync(join(tmpdir(), 'hangar-harness-'))
  execFileSync('git', ['clone', '--depth', '1', '--branch', args[1], REPO, cloned], { stdio: 'inherit' })
  source = cloned
} else if (args[0]) {
  source = resolve(args[0])
} else {
  console.error('Usage: node build/sync-harness.cjs <checkout dir> | --tag <vX.Y.Z>')
  process.exit(2)
}

const pkg = join(source, 'hangar')
if (!existsSync(join(pkg, 'bridge.py'))) {
  console.error(`Not a Hangar Harness checkout with the bridge (needs >= 0.2.0): ${source}`)
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
cpSync(pkg, join(dest, 'hangar'), {
  recursive: true,
  filter: (src) => !/__pycache__|\.pyc$/.test(src)
})
for (const f of ['LICENSE']) if (existsSync(join(source, f))) cpSync(join(source, f), join(dest, f))

const version = /__version__\s*=\s*"([^"]+)"/.exec(readFileSync(join(pkg, '__init__.py'), 'utf8'))?.[1] ?? 'unknown'
let commit = 'unknown'
try {
  commit = execFileSync('git', ['-C', source, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  // Not a git checkout: the version alone identifies it.
}
writeFileSync(join(dest, 'VERSION'), `${version}\ncommit ${commit}\nsource ${REPO.replace(/\.git$/, '')}\n`)
if (cloned) rmSync(cloned, { recursive: true, force: true })
console.log(`resources/harness ← Hangar Harness ${version} (${commit})`)
