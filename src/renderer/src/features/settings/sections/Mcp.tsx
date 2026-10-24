import { useCallback, useEffect, useState } from 'react'
import type { McpAddInput, McpListResult, McpServer, McpTransport } from '@shared/features/settings'
import { api } from '../../../core/api'
import { cliOutput, errorText, settingsApi } from '../api'
import { Card, Dot, Segmented, Spinner } from '../ui'
import styles from '../settings.module.css'

const SCOPE_LABEL: Record<McpServer['scope'], string> = {
  user: 'Usuário',
  local: 'Local',
  project: 'Projeto',
  'claude.ai': 'claude.ai',
  unknown: '?'
}

const HEALTH_TONE = { connected: 'ok', failed: 'bad', 'needs-auth': 'warn', pending: 'warn', unknown: 'neutral' } as const

// The CLI prints English status lines; translate the known prefixes and keep the details.
const STATUS_PT: [RegExp, string][] = [
  [/^Connected/i, 'Conectado'],
  [/^Failed to connect/i, 'Falha ao conectar'],
  [/^Needs authentication/i, 'Precisa de autenticação'],
  [/^Pending approval \(run `claude` to approve\)/i, 'Aguardando aprovação (rode `claude` na pasta para aprovar)'],
  [/^Pending approval/i, 'Aguardando aprovação'],
  [/^Disabled/i, 'Desativado']
]

function statusPt(text: string): string {
  for (const [re, pt] of STATUS_PT) if (re.test(text)) return text.replace(re, pt)
  return text
}

/** Parses `KEY=value` (env) or `Key: value` (headers) lines. */
function parsePairs(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(sep)
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** Splits an argument line respecting double quotes. */
function splitArgs(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2])
  }
  return out
}

function AddServerForm({ cwd, onDone }: { cwd?: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<McpAddInput['scope']>(cwd ? 'local' : 'user')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string }>()

  useEffect(() => {
    setScope(cwd ? 'local' : 'user')
  }, [cwd])

  const submit = async () => {
    setBusy(true)
    setMessage(undefined)
    try {
      const input: McpAddInput =
        transport === 'stdio'
          ? { name, scope, transport, cwd, command, args: splitArgs(args), env: parsePairs(env, '=') }
          : { name, scope, transport, cwd, url, headers: parsePairs(headers, ':') }
      const res = await settingsApi.mcpAdd(input)
      setMessage({ ok: res.ok, text: cliOutput(res) || (res.ok ? 'Servidor adicionado.' : 'Falha ao adicionar.') })
      if (res.ok) {
        setName('')
        setCommand('')
        setArgs('')
        setEnv('')
        setUrl('')
        setHeaders('')
        onDone()
      }
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Adicionar servidor">
      <div className={styles.form}>
        <label>Nome</label>
        <input className="input" value={name} placeholder="meu-servidor" onChange={(e) => setName(e.target.value)} />

        <label>Escopo</label>
        <div>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'user', label: 'Usuário' },
              ...(cwd
                ? [
                    { value: 'local' as const, label: 'Local (só você, nesta pasta)' },
                    { value: 'project' as const, label: 'Projeto (.mcp.json)' }
                  ]
                : [])
            ]}
          />
        </div>

        <label>Transporte</label>
        <div>
          <Segmented
            value={transport}
            onChange={setTransport}
            options={[
              { value: 'stdio', label: 'stdio' },
              { value: 'http', label: 'HTTP' },
              { value: 'sse', label: 'SSE' }
            ]}
          />
        </div>

        {transport === 'stdio' ? (
          <>
            <label>Comando</label>
            <input className="input" value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
            <label>Argumentos</label>
            <textarea
              className="input"
              value={args}
              placeholder={'-y @modelcontextprotocol/server-filesystem "C:\\minha pasta"'}
              onChange={(e) => setArgs(e.target.value)}
            />
            <label>Variáveis de ambiente</label>
            <textarea className="input" value={env} placeholder="API_KEY=valor (uma por linha)" onChange={(e) => setEnv(e.target.value)} />
          </>
        ) : (
          <>
            <label>URL</label>
            <input className="input" value={url} placeholder="https://exemplo.com/mcp" onChange={(e) => setUrl(e.target.value)} />
            <label>Cabeçalhos</label>
            <textarea
              className="input"
              value={headers}
              placeholder="Authorization: Bearer … (um por linha)"
              onChange={(e) => setHeaders(e.target.value)}
            />
          </>
        )}

        {message && <pre className={`${styles.pre} ${styles.formFull} ${message.ok ? '' : styles.errorText}`}>{message.text}</pre>}

        <div className={styles.formActions}>
          {busy && <Spinner />}
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            Adicionar
          </button>
        </div>
      </div>
    </Card>
  )
}

function ServerItem({ server, cwd, onChanged }: { server: McpServer; cwd?: string; onChanged: () => void }) {
  const [details, setDetails] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const removable = server.scope !== 'claude.ai'

  const toggleDetails = async () => {
    if (details !== undefined) return setDetails(undefined)
    setBusy(true)
    try {
      setDetails(cliOutput(await settingsApi.mcpGet(server.name, cwd)))
    } catch (err) {
      setDetails(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Remover o servidor MCP "${server.name}"?`)) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await settingsApi.mcpRemove(server.name, server.scope, cwd)
      if (res.ok) onChanged()
      else setError(cliOutput(res) || 'Falha ao remover.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.item}>
      <div style={{ paddingTop: 6 }}>
        <Dot tone={HEALTH_TONE[server.health]} />
      </div>
      <div className={styles.itemMain}>
        <div className={styles.itemTitle}>
          {server.name}
          <span className={styles.badge}>{SCOPE_LABEL[server.scope]}</span>
          {server.transport && <span className={styles.badge}>{server.transport}</span>}
        </div>
        <div className={`${styles.itemSub} ${styles.path}`}>{server.target}</div>
        <div className={styles.itemSub}>
          {statusPt(server.statusText)}
          {server.envKeys?.length ? ` · env: ${server.envKeys.join(', ')}` : ''}
          {server.headerKeys?.length ? ` · cabeçalhos: ${server.headerKeys.join(', ')}` : ''}
        </div>
        {error && <div className={styles.errorText}>{error}</div>}
        {details !== undefined && <pre className={styles.pre} style={{ marginTop: 8 }}>{details}</pre>}
      </div>
      <div className={styles.itemActions}>
        {busy && <Spinner />}
        <button className="btn" disabled={busy} onClick={() => void toggleDetails()}>
          {details !== undefined ? 'Ocultar' : 'Detalhes'}
        </button>
        {removable && (
          <button className={`btn ${styles.btnDanger}`} disabled={busy} onClick={() => void remove()}>
            Remover
          </button>
        )}
      </div>
    </div>
  )
}

export function McpSection() {
  const [cwd, setCwd] = useState<string>()
  const [result, setResult] = useState<McpListResult>()
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setResult(await settingsApi.mcpList(cwd))
    } catch (err) {
      setResult({ ok: false, servers: [], raw: '', error: errorText(err) })
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => void refresh(), [refresh])

  const pick = async () => {
    const folder = await api.pickFolder(cwd)
    if (folder) setCwd(folder)
  }

  return (
    <>
      <div className={styles.toolbar}>
        <span className="muted">Projeto:</span>
        {cwd ? <span className={styles.path}>{cwd}</span> : <span className="muted">nenhum (só servidores do usuário)</span>}
        <button className="btn" onClick={() => void pick()}>
          Escolher pasta…
        </button>
        {cwd && (
          <button className="btn" onClick={() => setCwd(undefined)}>
            Limpar
          </button>
        )}
        <span style={{ flex: 1 }} />
        {loading && <Spinner />}
        <button className="btn" disabled={loading} onClick={() => void refresh()}>
          Atualizar
        </button>
      </div>

      <Card title="Servidores configurados">
        {!result ? (
          <div className={styles.empty}>Verificando servidores…</div>
        ) : result.error ? (
          <div className={styles.empty}>
            <div className={styles.errorText}>{result.error}</div>
          </div>
        ) : result.servers.length === 0 ? (
          result.raw && !/no mcp servers/i.test(result.raw) ? (
            <div style={{ padding: 16 }}>
              <pre className={styles.pre}>{result.raw}</pre>
            </div>
          ) : (
            <div className={styles.empty}>Nenhum servidor MCP configurado.</div>
          )
        ) : (
          <div className={styles.list}>
            {result.servers.map((s) => (
              <ServerItem key={`${s.scope}:${s.name}`} server={s} cwd={cwd} onChanged={() => void refresh()} />
            ))}
          </div>
        )}
      </Card>

      <AddServerForm cwd={cwd} onDone={() => void refresh()} />
    </>
  )
}
