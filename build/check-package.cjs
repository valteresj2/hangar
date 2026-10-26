// Checks an unpacked build (release/<os>[-arm64]-unpacked, or the .app on macOS) for the native pieces the app needs
// at run time, for the TARGET platform and architecture:
//   - the Agent SDK's claude binary (@anthropic-ai/claude-agent-sdk-<platform>-<arch>) in app.asar.unpacked;
//   - node-pty's native module (prebuilds on Windows/macOS, build/Release on Linux) and its helpers;
//   - no native packages of other platforms/architectures; the CPU type in each binary header matches the target;
//   - app-update.yml (auto-update feed) and the packaged package.json (main entry, desktopName).
// Usage: node build/check-package.cjs [--os win|mac|linux] [--arch x64|arm64] [--dir <unpacked dir>] [--release]
// Defaults to the host OS/arch. --release (after building the installers, as CI does) also requires app-update.yml,
// which electron-builder writes only for publishable targets, not for --dir. Exits 1 listing every problem found. Used by .github/workflows/release.yml.
const { existsSync, readdirSync, statSync, openSync, readSync, closeSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const hostOs = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
const os = arg('os', hostOs)
const arch = arg('arch', process.arch)
if (!['win', 'mac', 'linux'].includes(os) || !['x64', 'arm64'].includes(arch)) {
  console.error(`Unsupported target ${os}/${arch}.`)
  process.exit(2)
}
const platform = { win: 'win32', mac: 'darwin', linux: 'linux' }[os]
const root = join(__dirname, '..')
const suffix = arch === 'x64' ? '' : `-${arch}`
const dir = arg(
  'dir',
  os === 'mac' ? join(root, 'release', `mac${suffix}`) : join(root, 'release', `${os}${suffix}-unpacked`)
)

const problems = []
const ok = []
const fail = (msg) => problems.push(msg)

function resourcesDir() {
  if (os !== 'mac') return join(dir, 'resources')
  const app = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.app')) : undefined
  return app ? join(dir, app, 'Contents', 'Resources') : join(dir, 'Agent Hangar Desktop.app', 'Contents', 'Resources')
}

/** CPU architecture from a PE / ELF / Mach-O header ('x64' | 'arm64' | 'x64+arm64' | undefined). */
function binaryArch(file) {
  const buf = Buffer.alloc(65536)
  const fd = openSync(file, 'r')
  const n = readSync(fd, buf, 0, buf.length, 0)
  closeSync(fd)
  if (n >= 64 && buf.toString('latin1', 0, 2) === 'MZ') {
    const pe = buf.readUInt32LE(0x3c)
    if (pe + 6 > n || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return undefined
    return { 0x8664: 'x64', 0xaa64: 'arm64' }[buf.readUInt16LE(pe + 4)]
  }
  if (n >= 20 && buf.readUInt32BE(0) === 0x7f454c46) return { 0x3e: 'x64', 0xb7: 'arm64' }[buf.readUInt16LE(18)]
  const cpu = (t) => ({ 0x01000007: 'x64', 0x0100000c: 'arm64' })[t]
  if (n >= 8 && buf.readUInt32LE(0) === 0xfeedfacf) return cpu(buf.readUInt32LE(4))
  if (n >= 8 && buf.readUInt32BE(0) === 0xcafebabe) {
    const archs = []
    for (let i = 0; i < buf.readUInt32BE(4) && 8 + i * 20 + 4 <= n; i++) archs.push(cpu(buf.readUInt32BE(8 + i * 20)))
    return archs.filter(Boolean).sort().reverse().join('+') || undefined
  }
  return undefined
}

function checkBinary(file, { executable = false } = {}) {
  const rel = file.slice(dir.length + 1)
  if (!existsSync(file)) return fail(`missing ${rel}`)
  const found = binaryArch(file)
  if (!found || !found.split('+').includes(arch)) fail(`${rel}: CPU ${found ?? 'unknown'}, expected ${arch}`)
  else ok.push(`${rel} (${found}, ${(statSync(file).size / 1048576).toFixed(1)} MB)`)
  if (executable && os !== 'win' && process.platform !== 'win32' && !(statSync(file).mode & 0o111)) {
    fail(`${rel}: not executable`)
  }
}

const resources = resourcesDir()
const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
if (!existsSync(join(resources, 'app.asar'))) {
  console.error(`No app.asar under ${resources}. Build first (npm run pack / electron-builder --dir).`)
  process.exit(1)
}

// Agent SDK: only this platform's package, unpacked, with a binary for this CPU.
const sdkScope = join(unpacked, '@anthropic-ai')
const sdkPackages = existsSync(sdkScope) ? readdirSync(sdkScope).filter((d) => d.startsWith('claude-agent-sdk-')) : []
const sdkWanted = `claude-agent-sdk-${platform}-${arch}`
for (const d of sdkPackages) if (d !== sdkWanted) fail(`extra Agent SDK package @anthropic-ai/${d}`)
checkBinary(join(sdkScope, sdkWanted, os === 'win' ? 'claude.exe' : 'claude'), { executable: true })

// node-pty
const pty = join(unpacked, 'node-pty')
const prebuilds = join(pty, 'prebuilds')
const prebuildDirs = existsSync(prebuilds) ? readdirSync(prebuilds) : []
if (os === 'linux') {
  if (prebuildDirs.length) fail(`unexpected node-pty prebuilds on Linux: ${prebuildDirs.join(', ')}`)
  checkBinary(join(pty, 'build', 'Release', 'pty.node'))
} else {
  for (const d of prebuildDirs) if (d !== `${platform}-${arch}`) fail(`extra node-pty prebuild ${d}`)
  const own = join(prebuilds, `${platform}-${arch}`)
  if (os === 'win') {
    for (const f of ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty-agent.exe', 'winpty.dll']) {
      checkBinary(join(own, f))
    }
    // useConptyDll: the bundled conpty.dll + OpenConsole.exe for this CPU (src/main/features/terminal/manager.ts).
    const conptyRoot = join(pty, 'third_party', 'conpty')
    const versions = existsSync(conptyRoot) ? readdirSync(conptyRoot) : []
    if (!versions.length) fail('missing node-pty/third_party/conpty')
    for (const v of versions) {
      for (const d of readdirSync(join(conptyRoot, v))) if (d !== `win10-${arch}`) fail(`extra conpty build ${v}/${d}`)
      checkBinary(join(conptyRoot, v, `win10-${arch}`, 'conpty.dll'))
      checkBinary(join(conptyRoot, v, `win10-${arch}`, 'OpenConsole.exe'))
    }
  } else {
    checkBinary(join(own, 'pty.node'))
    checkBinary(join(own, 'spawn-helper'), { executable: true })
  }
}
if (!existsSync(join(pty, 'lib', 'index.js'))) fail('missing node-pty/lib/index.js')

// Auto-update feed and packaged metadata.
if (existsSync(join(resources, 'app-update.yml'))) ok.push('resources/app-update.yml')
else if (args.includes('--release')) fail('missing resources/app-update.yml')
else ok.push('resources/app-update.yml not written (expected for --dir builds)')
try {
  const asar = require('@electron/asar')
  const pkg = JSON.parse(asar.extractFile(join(resources, 'app.asar'), 'package.json').toString('utf8'))
  if (pkg.desktopName !== 'hangar.desktop') fail(`package.json desktopName is ${pkg.desktopName}`)
  const main = pkg.main.replace(/^\.\//, '')
  if (!asar.listPackage(join(resources, 'app.asar')).some((f) => f.replace(/\\/g, '/') === `/${main}`)) {
    fail(`app.asar has no ${main}`)
  } else ok.push(`app.asar: ${main}, desktopName ${pkg.desktopName}, v${pkg.version}`)
} catch (err) {
  fail(`cannot read app.asar: ${err.message}`)
}

console.log(`Package check ${os}/${arch} — ${dir}`)
for (const line of ok) console.log(`  ok   ${line}`)
for (const line of problems) console.log(`  FAIL ${line}`)
if (problems.length) process.exit(1)
console.log('  all native pieces present')
