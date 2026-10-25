// Synced token models (docs/platform/app-api-models.md): the platform's answer → connections → managed provider
// profiles (src/main/features/platform/catalog.ts), their storage as read-only profiles with the device key
// (settings/providers.ts), and the fallback of sessions to the subscription when a profile goes away.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../src/shared/contracts'
import { useTempUserData } from './helpers/electron'

vi.mock('electron', async () => (await import('./helpers/electron')).default)

const userData = useTempUserData()
const { parseModels, planFallback, profileFor, profileModels } =
  await import('../../src/main/features/platform/catalog')
const providers = await import('../../src/main/features/settings/providers')
const { settings } = await import('../../src/main/core/store')
await providers.loadProviders()

afterAll(() => userData.cleanup())

const KEY = 'ahl_device-key-0123456789abcdef'

const ANSWER = {
  version: 'v7',
  connections: [
    {
      id: 11,
      name: 'Anthropic Acme',
      provider: 'anthropic',
      base_path: '/api/app/llm/11',
      models: [
        {
          model_id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet 4.5',
          context_length: 200000,
          caps: ['tools'],
          price_in_per_mtok: 3,
          price_out_per_mtok: 15
        },
        { model_id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', price_in_per_mtok: 1, price_out_per_mtok: 5 },
        { model_id: 'claude-haiku-4-5', name: 'duplicado' }
      ]
    },
    { id: 12, name: 'Sem modelos', provider: 'anthropic', base_path: '/api/app/llm/12', models: [] },
    { id: 13, name: 'Caminho estranho', base_path: 'https://evil.example/steal', models: [{ model_id: 'x' }] },
    { id: 'abc', name: 'Id inválido', models: [{ model_id: 'y' }] },
    { id: 14, name: 'OpenRouter', provider: 'openrouter', models: [{ model_id: 'openai/gpt-4o', name: 'GPT-4o' }] }
  ]
}

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

describe('parseModels', () => {
  it('keeps valid connections with models, under the proxy path only', () => {
    const c = parseModels(ANSWER)
    expect(c.version).toBe('v7')
    expect(c.connections.map((x) => x.id)).toEqual([11, 14])
    expect(c.connections[0]).toMatchObject({
      name: 'Anthropic Acme',
      provider: 'anthropic',
      basePath: '/api/app/llm/11',
      profileId: 'platform-11'
    })
    expect(c.connections[0].models).toEqual([
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        contextLength: 200000,
        caps: ['tools'],
        priceInPerMTok: 3,
        priceOutPerMTok: 15
      },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', priceInPerMTok: 1, priceOutPerMTok: 5 }
    ])
    // No base_path: the documented default.
    expect(c.connections[1].basePath).toBe('/api/app/llm/14')
  })

  it('survives garbage', () => {
    expect(parseModels(undefined)).toEqual({ version: undefined, connections: [] })
    expect(parseModels({ connections: 'x' })).toEqual({ version: undefined, connections: [] })
    expect(parseModels({ version: 3, connections: [null, 1] })).toEqual({ version: '3', connections: [] })
  })
})

describe('connection → managed profile', () => {
  const [anthropic, openrouter] = parseModels(ANSWER).connections

  it('maps the aliases to visible models (same family, else the default)', () => {
    expect(profileModels(anthropic.models)).toEqual({
      default: 'claude-sonnet-4-5',
      opus: 'claude-sonnet-4-5',
      sonnet: 'claude-sonnet-4-5',
      haiku: 'claude-haiku-4-5',
      extra: ['claude-haiku-4-5']
    })
    expect(profileModels(openrouter.models)).toEqual({
      default: 'openai/gpt-4o',
      opus: 'openai/gpt-4o',
      sonnet: 'openai/gpt-4o',
      haiku: 'openai/gpt-4o'
    })
  })

  it('points the profile at the platform proxy', () => {
    expect(profileFor('https://hangar.acme.example/', anthropic)).toEqual({
      id: 'platform-11',
      connectionId: 11,
      name: 'Plataforma · Anthropic Acme',
      baseUrl: 'https://hangar.acme.example/api/app/llm/11',
      models: profileModels(anthropic.models)
    })
  })
})

describe('managed provider profiles', () => {
  const url = 'https://hangar.acme.example'
  const conns = parseModels(ANSWER).connections

  it('creates one read-only gateway profile per connection, the device key as its encrypted secret', async () => {
    const own = providers.saveProvider({ name: 'Meu gateway', kind: 'gateway', baseUrl: 'http://127.0.0.1:4000' })
    const result = await providers.syncManagedProviders(
      conns.map((c) => profileFor(url, c)),
      KEY
    )
    expect(result).toEqual({ removed: [], defaultReset: false })
    const managed = providers.managedProviders()
    expect(managed.map((p) => p.id)).toEqual(['platform-11', 'platform-14'])
    expect(managed[0]).toMatchObject({
      name: 'Plataforma · Anthropic Acme',
      kind: 'gateway',
      baseUrl: `${url}/api/app/llm/11`,
      authStyle: 'bearer',
      managedBy: 'platform',
      platformConnectionId: 11,
      hasSecret: true
    })
    expect(providers.listProviders().map((p) => p.id)).toEqual(['subscription', own.id, 'platform-11', 'platform-14'])
    expect(providers.managedProviderSecret()).toBe(KEY)
    expect(diskText()).not.toContain(KEY)

    const launch = providers.resolveLaunch('platform-11')
    expect(launch.env).toMatchObject({
      ANTHROPIC_BASE_URL: `${url}/api/app/llm/11`,
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5'
    })
    expect(launch.defaultModel).toBe('claude-sonnet-4-5')
    expect(launch.unset).toContain('ANTHROPIC_API_KEY')
  })

  it('refuses edits, secrets and deletion from the user', async () => {
    expect(() =>
      providers.saveProvider({ id: 'platform-11', name: 'x', kind: 'gateway', baseUrl: 'http://a' })
    ).toThrow(/gerenciado pela plataforma/)
    expect(() => providers.deleteProvider('platform-11')).toThrow(/gerenciado pela plataforma/)
    expect(() => providers.clearProviderSecret('platform-11')).toThrow(/gerenciado pela plataforma/)
    await expect(providers.setProviderSecret('platform-11', 'outra')).rejects.toThrow(/gerenciado pela plataforma/)
    // It may still be the default.
    providers.setDefaultProvider('platform-11')
    expect(providers.providersState().defaultId).toBe('platform-11')
  })

  it('updates in place and rotates the key without touching the user profiles', async () => {
    const before = providers.managedProviders()[0]
    const renamed = { ...conns[0], name: 'Anthropic (empresa)' }
    await providers.syncManagedProviders([profileFor(url, renamed), profileFor(url, conns[1])], `${KEY}-rotated`)
    const after = providers.managedProviders()[0]
    expect(after.name).toBe('Plataforma · Anthropic (empresa)')
    expect(after.createdAt).toBe(before.createdAt)
    expect(providers.resolveLaunch('platform-14').env.ANTHROPIC_AUTH_TOKEN).toBe(`${KEY}-rotated`)
    expect(providers.listProviders().filter((p) => !p.managedBy && p.id !== 'subscription')).toHaveLength(1)
  })

  it('removes profiles that left the list, with their secret, and resets the default', async () => {
    const result = await providers.syncManagedProviders([profileFor(url, conns[1])])
    expect(result).toEqual({ removed: ['platform-11'], defaultReset: true })
    expect(providers.providersState().defaultId).toBe('subscription')
    expect(providers.managedProviders().map((p) => p.id)).toEqual(['platform-14'])
    expect(
      JSON.parse(readFileSync(join(userData.dir, 'hangar-data', 'settings', 'providers.secrets.json'), 'utf8'))
    ).not.toHaveProperty('platform-11')
    // A session still pointing at it runs on the default (here the subscription).
    expect(providers.resolveLaunch('platform-11')).toEqual(providers.resolveLaunch('subscription'))

    const all = await providers.syncManagedProviders([])
    expect(all.removed).toEqual(['platform-14'])
    expect(providers.managedProviders()).toEqual([])
    expect(providers.managedProviderSecret()).toBeUndefined()
    expect(settings().get().defaultProviderId).toBe('subscription')
  })

  it('never takes over a profile the user owns', async () => {
    const own = providers.listProviders().find((p) => !p.managedBy && p.id !== 'subscription')!
    await expect(providers.syncManagedProviders([{ ...profileFor(url, conns[0]), id: own.id }], KEY)).rejects.toThrow(
      /não é gerenciado/
    )
  })
})

describe('fallback to the subscription', () => {
  const session = (id: string, patch: Partial<Session>): Session => ({
    id,
    title: id,
    cwd: 'C:\\work',
    pinned: false,
    archived: false,
    unread: false,
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    ...patch
  })
  const removed = [
    { profileId: 'platform-11', name: 'Anthropic Acme', modelIds: ['claude-sonnet-4-5', 'claude-haiku-4-5'] }
  ]
  const sessions = [
    session('on-token', { providerId: 'platform-11', model: 'claude-haiku-4-5' }),
    session('on-token-alias', { providerId: 'platform-11', model: 'opus' }),
    session('on-other', { providerId: 'p_mine', model: 'claude-sonnet-4-5' }),
    session('default-token', { model: 'claude-sonnet-4-5' }),
    session('default-alias', { model: 'sonnet' })
  ]

  it('moves sessions on a removed profile, with a note', () => {
    const steps = planFallback(sessions, removed, undefined, 'a conexão deixou de ser sincronizada')
    expect(steps.map((s) => s.sessionId)).toEqual(['on-token', 'on-token-alias'])
    expect(steps[0].patch).toEqual({ providerId: 'subscription', model: undefined })
    expect(steps[0].note).toMatch(
      /“Anthropic Acme” não estão mais disponíveis \(a conexão deixou de ser sincronizada\)/
    )
    expect(steps[0].note).toMatch(/assinatura Claude, com o modelo padrão/)
    // An alias works on the subscription too: kept.
    expect(steps[1].patch).toEqual({ providerId: 'subscription' })
  })

  it('sessions that followed the removed default: token models move, aliases only restart', () => {
    const steps = planFallback(sessions, removed, 'platform-11', 'o Hangar foi desconectado')
    expect(steps.map((s) => s.sessionId)).toEqual(['on-token', 'on-token-alias', 'default-token', 'default-alias'])
    expect(steps[2]).toMatchObject({ patch: { providerId: 'subscription', model: undefined } })
    expect(steps[2].note).toMatch(/o Hangar foi desconectado/)
    expect(steps[3]).toEqual({ sessionId: 'default-alias', patch: {} })
  })

  it('does nothing when the default was another profile', () => {
    expect(planFallback([sessions[3], sessions[4]], removed, undefined, 'x')).toEqual([])
    expect(planFallback(sessions, [], 'platform-11', 'x')).toEqual([])
  })
})
