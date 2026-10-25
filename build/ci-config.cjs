// Writes release/electron-builder.ci.json: electron-builder.yml plus the publish target and code signing
// chosen through environment variables. Used by .github/workflows/release.yml on every OS; also works locally:
//   node build/ci-config.cjs && npx electron-builder --config release/electron-builder.ci.json --win nsis portable --x64
// Nothing here is required: with no variables set the build is unsigned (Windows, Linux) or ad hoc signed (macOS).
//
// Publish target (embedded in the app as app-update.yml — must be reachable WITHOUT a token):
//   UPDATE_PROVIDER      github (default) | generic
//   UPDATE_GITHUB_OWNER  default valteresj2          (provider github)
//   UPDATE_GITHUB_REPO   default hangar-releases     (provider github; must be a PUBLIC repo)
//   UPDATE_GENERIC_URL   https://… base URL holding latest.yml + installer (provider generic)
//   UPDATE_CHANNEL       optional channel name (latest by default)
// Azure Trusted Signing (all four required to enable it; credentials come from AZURE_TENANT_ID,
// AZURE_CLIENT_ID and AZURE_CLIENT_SECRET, read by electron-builder itself):
//   AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE, AZURE_SIGNING_PUBLISHER
// A .pfx certificate needs no config here: electron-builder picks up CSC_LINK / CSC_KEY_PASSWORD on its own.
// macOS Developer ID (only when this runs on macOS): CSC_LINK + CSC_KEY_PASSWORD (a .p12 with the "Developer ID
// Application" certificate) or CSC_NAME (an identity already in the keychain) replaces the ad hoc signature and turns
// on the hardened runtime. Notarization runs when one set of Apple credentials is complete:
//   APPLE_API_KEY (path to the .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER, or
//   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const yaml = require('js-yaml')

const root = join(__dirname, '..')
const config = yaml.load(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
const env = process.env
const notes = []

const provider = (env.UPDATE_PROVIDER || 'github').trim().toLowerCase()
if (provider === 'generic') {
  if (!/^https:\/\//i.test(env.UPDATE_GENERIC_URL || '')) {
    console.error('UPDATE_PROVIDER=generic requires UPDATE_GENERIC_URL (https://…).')
    process.exit(1)
  }
  config.publish = { provider: 'generic', url: env.UPDATE_GENERIC_URL.trim() }
} else if (provider === 'github') {
  const owner = (env.UPDATE_GITHUB_OWNER || 'valteresj2').trim()
  const repo = (env.UPDATE_GITHUB_REPO || 'hangar-releases').trim()
  if (owner === 'valteresj2' && repo === 'hangar') {
    console.error(
      'valteresj2/hangar is private: installed apps could not download updates. Use a public releases repo.'
    )
    process.exit(1)
  }
  config.publish = { provider: 'github', owner, repo, releaseType: 'release' }
} else {
  console.error(`Unknown UPDATE_PROVIDER "${provider}" (use github or generic).`)
  process.exit(1)
}
if (env.UPDATE_CHANNEL) config.publish.channel = env.UPDATE_CHANNEL.trim()
notes.push(`publish: ${JSON.stringify(config.publish)}`)

const azure = {
  endpoint: env.AZURE_SIGNING_ENDPOINT,
  codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
  certificateProfileName: env.AZURE_SIGNING_PROFILE,
  publisherName: env.AZURE_SIGNING_PUBLISHER
}
const azureSet = Object.values(azure).filter((v) => v && v.trim())
if (azureSet.length === 4) {
  for (const k of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) {
    if (!env[k]) {
      console.error(`Azure Trusted Signing configured but ${k} is missing.`)
      process.exit(1)
    }
  }
  config.win = {
    ...config.win,
    azureSignOptions: Object.fromEntries(Object.entries(azure).map(([k, v]) => [k, v.trim()]))
  }
  notes.push(`signing: Azure Trusted Signing (${azure.codeSigningAccountName}/${azure.certificateProfileName})`)
} else if (azureSet.length > 0) {
  console.error('Azure Trusted Signing needs AZURE_SIGNING_ENDPOINT, _ACCOUNT, _PROFILE and _PUBLISHER together.')
  process.exit(1)
} else if (process.platform === 'darwin') {
  // CSC_LINK on a macOS runner is the Developer ID certificate (the workflow maps MAC_CSC_LINK into it there).
} else if (env.CSC_LINK || env.WIN_CSC_LINK) {
  notes.push('signing (Windows): .pfx certificate from CSC_LINK / WIN_CSC_LINK')
} else if (process.platform === 'win32') {
  notes.push('signing (Windows): none (unsigned build — SmartScreen / Smart App Control will warn or block)')
}

if (process.platform === 'darwin') {
  const has = (...names) => names.every((n) => env[n] && env[n].trim())
  if (has('CSC_LINK') || has('CSC_NAME')) {
    const entitlements = 'build/entitlements.mac.plist'
    const mac = { ...config.mac, hardenedRuntime: true, entitlements, entitlementsInherit: entitlements }
    delete mac.identity // let electron-builder pick the Developer ID from CSC_LINK / CSC_NAME
    const notarize =
      has('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER') ||
      has('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID')
    mac.notarize = notarize
    config.mac = mac
    notes.push(
      `signing (macOS): Developer ID, hardened runtime, notarization ${notarize ? 'on' : 'off (no Apple credentials)'}`
    )
  } else {
    notes.push('signing (macOS): ad hoc (no Developer ID — Gatekeeper asks the user to allow the app; no auto-install)')
  }
}

mkdirSync(join(root, 'release'), { recursive: true })
const out = join(root, 'release', 'electron-builder.ci.json')
writeFileSync(out, JSON.stringify(config, null, 2))
console.log(`wrote ${out}\n  ${notes.join('\n  ')}`)
