import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { useTempUserData } from './helpers/electron'

vi.mock('electron', async () => (await import('./helpers/electron')).default)

const userData = useTempUserData()
// The user's ~/.claude/settings.json: points at a local gateway, like the real machine does.
const claudeConfig = mkdtempSync(join(tmpdir(), 'hangar-claude-config-'))
writeFileSync(join(claudeConfig, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:8787', ANTHROPIC_MODEL: 'gw-model' } }))
process.env.CLAUDE_CONFIG_DIR = claudeConfig

const providers = await import('../../src/main/features/settings/providers')
const { resolveLaunch, saveProvider, setDefaultProvider, listProviders, providersState, maskSecrets, deleteProvider } = providers
// setProviderSecret may be synchronous or async depending on the safeStorage API in use; normalize to a promise.
const setProviderSecret = (id: string, secret: string) => Promise.resolve().then(() => providers.setProviderSecret(id, secret))
await providers.loadProviders()

const SECRET = 'sk-ant-test-0123456789abcdefSECRET'

afterAll(() => {
  userData.cleanup()
  rmSync(claudeConfig, { recursive: true, force: true })
})

/** Every file under userData, concatenated (to prove secrets never hit the disk in clear). */
function diskText(): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else out.push(readFileSync(join(d, e.name), 'utf8'))
    }
  }
  walk(userData.dir)
  return out.join('\n')
}

describe('resolveLaunch', () => {
  it('built-in subscription: no env, only removes ANTHROPIC_API_KEY', async () => {
    expect(resolveLaunch('subscription')).toEqual({ env: {}, unset: ['ANTHROPIC_API_KEY'], settingsEnv: {} })
    expect(resolveLaunch()).toEqual({ env: {}, unset: ['ANTHROPIC_API_KEY'], settingsEnv: {} })
  })

  it('gateway (bearer): base URL + auth token, clears other credentials and blanks the user settings override', async () => {
    const p = saveProvider({ name: 'Gateway', kind: 'gateway', baseUrl: 'http://127.0.0.1:9999/', authStyle: 'bearer', extraEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
    expect(() => resolveLaunch(p.id)).toThrow(/não tem chave salva/)
    await setProviderSecret(p.id, SECRET)
    const l = resolveLaunch(p.id)
    expect(l.env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999', ANTHROPIC_AUTH_TOKEN: SECRET, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    expect(l.unset).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_MODEL']))
    expect(l.unset).not.toContain('ANTHROPIC_BASE_URL')
    expect(l.unset).not.toContain('ANTHROPIC_AUTH_TOKEN')
    // Flag settings carry the profile and blank what ~/.claude/settings.json sets but the profile doesn't.
    expect(l.settingsEnv).toEqual({ ...l.env, ANTHROPIC_MODEL: '' })
  })

  it('gateway (x-api-key) uses ANTHROPIC_API_KEY', async () => {
    const p = saveProvider({ name: 'GW key', kind: 'gateway', baseUrl: 'https://gw.example.com', authStyle: 'x-api-key' })
    await setProviderSecret(p.id, 'gw-secret-value-123')
    const l = resolveLaunch(p.id)
    expect(l.env.ANTHROPIC_API_KEY).toBe('gw-secret-value-123')
    expect(l.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(l.unset).toContain('ANTHROPIC_AUTH_TOKEN')
  })

  it('anthropic API key: default endpoint and model mapping', async () => {
    const p = saveProvider({ name: 'API', kind: 'anthropic', models: { default: 'claude-x', opus: 'o-1', sonnet: 's-1', haiku: 'h-1' } })
    await setProviderSecret(p.id, 'sk-ant-api-key-abcdef123456')
    const l = resolveLaunch(p.id)
    expect(l.env).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant-api-key-abcdef123456',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'o-1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 's-1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h-1'
    })
    expect(l.defaultModel).toBe('claude-x')
  })

  it('user subscription profile: explicit endpoint and keeps the OAuth token', async () => {
    const p = saveProvider({ name: 'Assinatura (direto)', kind: 'subscription', baseUrl: 'https://api.anthropic.com' })
    const l = resolveLaunch(p.id)
    expect(l.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
    expect(l.unset).toContain('ANTHROPIC_API_KEY')
    expect(l.unset).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('bedrock: region/profile, optional bearer token', async () => {
    const p = saveProvider({ name: 'Bedrock', kind: 'bedrock', region: 'us-east-1', awsProfile: 'dev', baseUrl: 'https://bedrock.example.com' })
    expect(resolveLaunch(p.id).env).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', AWS_PROFILE: 'dev', ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example.com' })
    await setProviderSecret(p.id, 'bedrock-token-123456')
    expect(resolveLaunch(p.id).env.AWS_BEARER_TOKEN_BEDROCK).toBe('bedrock-token-123456')
  })

  it('vertex: project and region; requires the project', async () => {
    expect(() => saveProvider({ name: 'V', kind: 'vertex' })).toThrow(/projeto GCP/)
    const p = saveProvider({ name: 'Vertex', kind: 'vertex', region: 'global', project: 'my-proj' })
    expect(resolveLaunch(p.id).env).toEqual({ CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_PROJECT_ID: 'my-proj' })
  })

  it('foundry: resource name, key style', async () => {
    expect(() => saveProvider({ name: 'F', kind: 'foundry', project: 'https://x' })).toThrow(/Recurso Foundry/)
    const p = saveProvider({ name: 'Foundry', kind: 'foundry', project: 'my-resource', authStyle: 'x-api-key' })
    expect(resolveLaunch(p.id).env).toEqual({ CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'my-resource' })
    await setProviderSecret(p.id, 'foundry-key-123456')
    expect(resolveLaunch(p.id).env.ANTHROPIC_FOUNDRY_API_KEY).toBe('foundry-key-123456')
  })

  it('extraEnv cannot override managed variables and must be well-formed', async () => {
    expect(() => saveProvider({ name: 'X', kind: 'gateway', baseUrl: 'http://x', extraEnv: { ANTHROPIC_BASE_URL: 'http://evil' } })).toThrow(/controlada pelo próprio perfil/)
    expect(() => saveProvider({ name: 'X', kind: 'gateway', baseUrl: 'http://x', extraEnv: { AWS_PROFILE: 'x' } })).toThrow(/controlada/)
    expect(() => saveProvider({ name: 'X', kind: 'gateway', baseUrl: 'http://x', extraEnv: { 'bad-name': '1' } })).toThrow(/letras maiúsculas/)
    expect(() => saveProvider({ name: 'X', kind: 'gateway', baseUrl: 'ftp://x' })).toThrow(/http:\/\/ ou https:\/\//)
    expect(() => saveProvider({ name: 'X', kind: 'gateway' })).toThrow(/URL base do gateway/)
  })

  it('a deleted profile falls back to the default, then the subscription', async () => {
    const a = saveProvider({ name: 'Default GW', kind: 'gateway', baseUrl: 'http://a.example' })
    await setProviderSecret(a.id, 'default-gw-secret-1')
    setDefaultProvider(a.id)
    expect(resolveLaunch('p_gone').env.ANTHROPIC_BASE_URL).toBe('http://a.example')
    deleteProvider(a.id)
    expect(resolveLaunch('p_gone')).toEqual({ env: {}, unset: ['ANTHROPIC_API_KEY'], settingsEnv: {} })
  })
})

describe('secrets', () => {
  it('never appear in profiles, state or files on disk, and are masked in messages', async () => {
    const p = saveProvider({ name: 'Secret holder', kind: 'gateway', baseUrl: 'http://s.example' })
    await setProviderSecret(p.id, SECRET)
    expect(JSON.stringify(listProviders())).not.toContain(SECRET)
    expect(JSON.stringify(providersState())).not.toContain(SECRET)
    expect(listProviders().find((x) => x.id === p.id)?.hasSecret).toBe(true)
    expect(diskText()).not.toContain(SECRET)
    expect(diskText()).not.toContain('gw-secret-value-123')
    expect(maskSecrets(`erro: chave ${SECRET} recusada`)).toBe('erro: chave •••• recusada')
    expect(maskSecrets('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
    expect(maskSecrets('x-api-key: zyxwvutsrqponm123')).not.toContain('zyxwvutsrqponm123')
  })

  it('rejects empty or multi-line keys', async () => {
    const p = saveProvider({ name: 'Bad key', kind: 'gateway', baseUrl: 'http://b.example' })
    await expect(setProviderSecret(p.id, '   ')).rejects.toThrow(/vazia/)
    await expect(setProviderSecret(p.id, 'a\nb')).rejects.toThrow(/quebras de linha/)
  })

  it('the subscription profile cannot be edited or deleted', async () => {
    expect(() => saveProvider({ id: 'subscription', name: 'x', kind: 'subscription' })).toThrow(/não pode ser alterado/)
    expect(() => deleteProvider('subscription')).toThrow(/não pode ser excluído/)
  })
})
