// Updater install mode (src/main/features/updater/install-mode.ts): which installations can update themselves,
// how the macOS signature is read from `codesign -dv`, and the download link shown to manual installs.
import { describe, expect, it } from 'vitest'
import {
  detectInstallMode,
  downloadUrlFor,
  parseCodesignOutput,
  parseUpdateConfig
} from '../../src/main/features/updater/install-mode'

const CODESIGN_ADHOC = `Executable=/Applications/Hangar.app/Contents/MacOS/Hangar
Identifier=dev.hangar.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=520 flags=0x2(adhoc) hashes=5+7 location=embedded
Hash type=sha256 size=32
Signature=adhoc
Info.plist entries=26
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=10
Internal requirements count=0 size=12`

const CODESIGN_DEVELOPER_ID = `Executable=/Applications/Hangar.app/Contents/MacOS/Hangar
Identifier=dev.hangar.app
Format=app bundle with Mach-O thin (x86_64)
CodeDirectory v=20500 size=1186 flags=0x10000(runtime) hashes=26+7 location=embedded
Signature size=9044
Authority=Developer ID Application: Valter Eduardo (AB12CD34EF)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=25 Oct 2026 at 14:00:00
Info.plist entries=26
TeamIdentifier=AB12CD34EF
Runtime Version=15.0.0`

const CODESIGN_UNSIGNED = '/Applications/Hangar.app: code object is not signed at all'

describe('parseCodesignOutput', () => {
  it('recognizes an ad hoc signature', () => {
    expect(parseCodesignOutput(CODESIGN_ADHOC)).toBe('adhoc')
  })

  it('recognizes a Developer ID signature', () => {
    expect(parseCodesignOutput(CODESIGN_DEVELOPER_ID)).toBe('developer-id')
  })

  it('recognizes an unsigned bundle', () => {
    expect(parseCodesignOutput(CODESIGN_UNSIGNED)).toBe('unsigned')
  })

  it('treats a team-less or non-Developer-ID signature as not Developer ID', () => {
    expect(parseCodesignOutput(CODESIGN_ADHOC.replace('Signature=adhoc\n', ''))).toBe('adhoc')
    const development = CODESIGN_DEVELOPER_ID.replace(
      'Developer ID Application: Valter Eduardo (AB12CD34EF)',
      'Apple Development: Valter Eduardo (AB12CD34EF)'
    )
    expect(parseCodesignOutput(development)).toBe('unknown')
    expect(parseCodesignOutput('')).toBe('unknown')
  })
})

describe('detectInstallMode', () => {
  it('macOS: auto only with a Developer ID signature', () => {
    expect(detectInstallMode({ platform: 'darwin', env: {}, macSignature: 'developer-id' })).toEqual({ mode: 'auto' })
    for (const macSignature of ['adhoc', 'unsigned', 'unknown'] as const) {
      const result = detectInstallMode({ platform: 'darwin', env: {}, macSignature })
      expect(result.mode).toBe('manual')
      expect(result.reason).toMatch(/assinatura/)
    }
    // codesign not run at all (no facts): never try to install.
    expect(detectInstallMode({ platform: 'darwin', env: {} }).mode).toBe('manual')
  })

  it('Windows: the portable exe is manual, the NSIS install is auto', () => {
    expect(detectInstallMode({ platform: 'win32', env: {} })).toEqual({ mode: 'auto' })
    const portable = detectInstallMode({
      platform: 'win32',
      env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\me\\Downloads\\Hangar-0.2.0-portable-x64.exe' }
    })
    expect(portable.mode).toBe('manual')
    expect(portable.reason).toMatch(/portátil/)
    expect(detectInstallMode({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: '' } }).mode).toBe('auto')
  })

  it('Linux: the .deb is manual, the AppImage is auto', () => {
    expect(detectInstallMode({ platform: 'linux', env: { APPIMAGE: '/home/me/Hangar.AppImage' } })).toEqual({
      mode: 'auto'
    })
    const deb = detectInstallMode({ platform: 'linux', env: {}, packageType: 'deb\n' })
    expect(deb.mode).toBe('manual')
    expect(deb.reason).toMatch(/apt install/)
    expect(detectInstallMode({ platform: 'linux', env: {}, packageType: 'rpm' }).mode).toBe('auto')
  })

  it('the portable variable only matters on Windows', () => {
    expect(
      detectInstallMode({ platform: 'linux', env: { PORTABLE_EXECUTABLE_FILE: '/x' }, packageType: undefined }).mode
    ).toBe('auto')
  })
})

describe('parseUpdateConfig', () => {
  it('reads the flat app-update.yml electron-builder writes', () => {
    const text =
      'owner: valteresj2\r\nrepo: hangar-releases\nprovider: github\nreleaseType: release\nupdaterCacheDirName: hangar-updater\n'
    expect(parseUpdateConfig(text)).toEqual({
      owner: 'valteresj2',
      repo: 'hangar-releases',
      provider: 'github',
      releaseType: 'release',
      updaterCacheDirName: 'hangar-updater'
    })
  })

  it('unquotes values', () => {
    expect(parseUpdateConfig('provider: generic\nurl: "https://dl.example.com/hangar/"\n').url).toBe(
      'https://dl.example.com/hangar/'
    )
  })
})

describe('downloadUrlFor', () => {
  const github = { provider: 'github', owner: 'valteresj2', repo: 'hangar-releases' }

  it('links to the GitHub release of the version', () => {
    expect(downloadUrlFor(github, '0.2.0')).toBe('https://github.com/valteresj2/hangar-releases/releases/tag/v0.2.0')
    expect(downloadUrlFor(github, '0.3.0-beta.1')).toBe(
      'https://github.com/valteresj2/hangar-releases/releases/tag/v0.3.0-beta.1'
    )
  })

  it('falls back to the releases list for an odd version string', () => {
    expect(downloadUrlFor(github, '1.0.0/../../x')).toBe('https://github.com/valteresj2/hangar-releases/releases')
  })

  it('refuses suspicious owner/repo names', () => {
    expect(downloadUrlFor({ ...github, owner: 'evil.com/x' }, '0.2.0')).toBeUndefined()
    expect(downloadUrlFor({ ...github, repo: '' }, '0.2.0')).toBeUndefined()
  })

  it('uses the generic feed URL, https only', () => {
    expect(downloadUrlFor({ provider: 'generic', url: 'https://dl.example.com/hangar/' }, '0.2.0')).toBe(
      'https://dl.example.com/hangar/'
    )
    expect(downloadUrlFor({ provider: 'generic', url: 'http://dl.example.com/hangar/' }, '0.2.0')).toBeUndefined()
    expect(downloadUrlFor({ provider: 'generic', url: 'file:///C:/evil.exe' }, '0.2.0')).toBeUndefined()
    expect(downloadUrlFor({ provider: 'generic', url: 'javascript:alert(1)' }, '0.2.0')).toBeUndefined()
    expect(downloadUrlFor({ provider: 'generic', url: 'https://user:pw@dl.example.com/' }, '0.2.0')).toBeUndefined()
    expect(downloadUrlFor({ provider: 'generic', url: 'not a url' }, '0.2.0')).toBeUndefined()
  })

  it('accepts the loopback test feed only when allowed (dev builds)', () => {
    const local = { provider: 'generic', url: 'http://127.0.0.1:18765/' }
    expect(downloadUrlFor(local, '9.9.9')).toBeUndefined()
    expect(downloadUrlFor(local, '9.9.9', { allowLoopback: true })).toBe('http://127.0.0.1:18765/')
    expect(
      downloadUrlFor({ provider: 'generic', url: 'http://example.com/' }, '9.9.9', { allowLoopback: true })
    ).toBeUndefined()
  })

  it('has no link for other providers', () => {
    expect(downloadUrlFor({ provider: 's3', bucket: 'x' }, '0.2.0')).toBeUndefined()
    expect(downloadUrlFor({}, '0.2.0')).toBeUndefined()
  })
})
