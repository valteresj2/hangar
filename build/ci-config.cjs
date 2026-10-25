// Writes release/electron-builder.ci.json: electron-builder.yml plus the publish target and code signing
// chosen through environment variables. Used by .github/workflows/release.yml; also works locally:
//   node build/ci-config.cjs && npx electron-builder --config release/electron-builder.ci.json --win nsis --x64
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
} else if (env.CSC_LINK || env.WIN_CSC_LINK) {
  notes.push('signing: .pfx certificate from CSC_LINK / WIN_CSC_LINK')
} else {
  notes.push('signing: none (unsigned build — SmartScreen / Smart App Control will warn or block)')
}

mkdirSync(join(root, 'release'), { recursive: true })
const out = join(root, 'release', 'electron-builder.ci.json')
writeFileSync(out, JSON.stringify(config, null, 2))
console.log(`wrote ${out}\n  ${notes.join('\n  ')}`)
