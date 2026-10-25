import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  McpAddInput,
  McpListResult,
  McpLog,
  McpServer,
  McpToggleInput,
  McpTransport
} from '@shared/features/settings'
import { api } from '../../../core/api'
import { cliOutput, errorText, settingsApi } from '../api'
import { Card, Dot, Segmented, Spinner, Switch, formatDateTime } from '../ui'
import styles from '../settings.module.css'

const SCOPE_LABEL: Record<McpServer['scope'], string> = {
  user: 'Usuário',
  local: 'Local',
  project: 'Projeto',
  'claude.ai': 'claude.ai',
  unknown: '?'
}

const HEALTH_TONE = {
  connected: 'ok',
  failed: 'bad',
  'needs-auth': 'warn',
  pending: 'warn',
  disabled: 'neutral',
  unknown: 'neutral'
} as const

// The CLI prints English status lines; translate the known prefixes and keep the details.
const STATUS_PT: [RegExp, string][] = [
  [/^Connected/i, 'Conectado'],
  [/^Failed to connect/i, 'Falha ao conectar'],
  [/^Needs authentication/i, 'Precisa de autenticação'],
  [/^Pending approval \(run `claude` to approve\)/i, 'Aguardando aprovação (rode `claude` na pasta para aprovar)'],
  [/^Pending approval/i, 'Aguardando aprovação'],
  [/^Disabled for this project \(re-enable via \/mcp\)/i, 'Desligado neste projeto'],
  [/^Disabled for this project/i, 'Desligado neste projeto'],
  [/^Disabled everywhere by Hangar/i, 'Desligado em todos os projetos pelo Hangar'],
  [
    /^Rejected \(see disabledMcpjsonServers in settings\)/i,
    'Rejeitado por disabledMcpjsonServers num arquivo de configurações do Claude Code'
  ],
  [/^Rejected/i, 'Rejeitado'],
  [/^Disabled/i, 'Desligado']
]

/** Which mechanism switched the server off, in words, so the UI is explicit about it. */
const MECHANISM_TEXT: Record<NonNullable<McpServer['disabledBy']>, string> = {
  project: 'Desligado só nesta pasta, pela lista disabledMcpServers do ~/.claude.json (a mesma do /mcp).',
  mcpjson: 'Servidor do .mcp.json rejeitado nesta pasta (disabledMcpjsonServers em .claude/settings.local.json).',
  hangar:
    'Removido do Claude Code com `claude mcp remove`; o Hangar guardou a configuração para re-adicionar ao ligar.',
  settings:
    'Rejeitado por disabledMcpjsonServers em .claude/settings.json ou ~/.claude/settings.json; edite esse arquivo para ligar.'
}

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
            <textarea
              className="input"
              value={env}
              placeholder="API_KEY=valor (uma por linha)"
              onChange={(e) => setEnv(e.target.value)}
            />
          </>
        ) : (
          <>
            <label>URL</label>
            <input
              className="input"
              value={url}
              placeholder="https://exemplo.com/mcp"
              onChange={(e) => setUrl(e.target.value)}
            />
            <label>Cabeçalhos</label>
            <textarea
              className="input"
              value={headers}
              placeholder="Authorization: Bearer … (um por linha)"
              onChange={(e) => setHeaders(e.target.value)}
            />
          </>
        )}

        {message && (
          <pre className={`${styles.pre} ${styles.formFull} ${message.ok ? '' : styles.errorText}`}>{message.text}</pre>
        )}

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

function LogViewer({ server, cwd }: { server: McpServer; cwd?: string }) {
  const [log, setLog] = useState<McpLog>()
  const [loading, setLoading] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setLog(await settingsApi.mcpLog(server.name, cwd))
    } catch (err) {
      setLog({ dir: '', lines: [], truncated: false, error: errorText(err) })
    } finally {
      setLoading(false)
    }
  }, [server.name, cwd])

  useEffect(() => {
    void load()
  }, [load])

  // Newest lines are at the end.
  useEffect(() => {
    const pre = preRef.current
    if (pre) pre.scrollTop = pre.scrollHeight
  }, [log])

  return (
    <div style={{ marginTop: 8 }}>
      <div className={styles.toolbar} style={{ marginBottom: 6 }}>
        <span className={`${styles.hint} ${styles.path}`} style={{ flex: 1 }}>
          {log?.file ? `${log.file} · ${formatDateTime(log.modifiedAt)}` : log?.dir ? `Nenhum log em ${log.dir}` : ''}
        </span>
        {loading && <Spinner />}
        <button className="btn" disabled={loading} onClick={() => void load()}>
          Recarregar
        </button>
        {log?.dir && (
          <button className="btn" onClick={() => void api.openPath(log.dir)}>
            Abrir pasta
          </button>
        )}
      </div>
      {log?.error && <div className={styles.errorText}>{log.error}</div>}
      {log && !log.error && (
        <pre ref={preRef} className={styles.pre}>
          {log.lines.length
            ? `${log.truncated ? '… (início do arquivo omitido)\n' : ''}${log.lines.join('\n')}`
            : 'O Claude Code ainda não gravou log para este servidor. Os logs aparecem depois que uma sessão usa o servidor.'}
        </pre>
      )}
    </div>
  )
}

function ServerItem({ server, cwd, onChanged }: { server: McpServer; cwd?: string; onChanged: () => void }) {
  const [details, setDetails] = useState<string>()
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const hangarOff = server.disabledBy === 'hangar'
  const removable = server.scope !== 'claude.ai' && !hangarOff

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleDetails = () => {
    if (details !== undefined) return setDetails(undefined)
    void run(async () => setDetails(cliOutput(await settingsApi.mcpGet(server.name, cwd))))
  }

  const setEnabled = (enabled: boolean, mechanism: McpToggleInput['mechanism']) =>
    run(async () => {
      if (mechanism === 'hangar' && !enabled) {
        const ok = window.confirm(
          `Desligar "${server.name}" em todos os projetos?\n\n` +
            'O Claude Code não tem "desligar" para servidores do usuário: o Hangar guarda a configuração e remove o ' +
            'servidor com `claude mcp remove`. Ao ligar, ele volta com `claude mcp add-json`.'
        )
        if (!ok) return
      }
      const res = await settingsApi.mcpSetEnabled({ name: server.name, enabled, mechanism, cwd })
      if (!res.ok) return setError(res.message)
      setNotice(res.message)
      onChanged()
    })

  const remove = () =>
    run(async () => {
      if (!window.confirm(`Remover o servidor MCP "${server.name}"?`)) return
      const res = await settingsApi.mcpRemove(server.name, server.scope, cwd)
      if (res.ok) onChanged()
      else setError(cliOutput(res) || 'Falha ao remover.')
    })

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
        {server.disabledBy && <div className={styles.hint}>{MECHANISM_TEXT[server.disabledBy]}</div>}
        {notice && <div className={`${styles.hint} ${styles.okText}`}>{notice}</div>}
        {error && <div className={styles.errorText}>{error}</div>}
        {details !== undefined && (
          <pre className={styles.pre} style={{ marginTop: 8 }}>
            {details}
          </pre>
        )}
        {showLog && <LogViewer server={server} cwd={cwd} />}
      </div>
      <div className={`${styles.itemActions} ${styles.mcpActions}`}>
        {busy && <Spinner />}
        {server.projectToggle && (
          <span
            className={styles.inline}
            title={
              server.projectToggle === 'mcpjson'
                ? 'Aprovar ou rejeitar este servidor do .mcp.json nesta pasta'
                : 'Ligar ou desligar só nesta pasta'
            }
          >
            <span className={styles.hint}>Nesta pasta</span>
            <Switch
              label="Ligado nesta pasta"
              checked={server.health !== 'disabled'}
              onChange={(v) => void setEnabled(v, server.projectToggle!)}
            />
          </span>
        )}
        {server.canDisableEverywhere && (
          <button className="btn" disabled={busy} onClick={() => void setEnabled(hangarOff, 'hangar')}>
            {hangarOff ? 'Ligar' : 'Desligar em todos'}
          </button>
        )}
        <button className="btn" onClick={() => setShowLog((v) => !v)}>
          {showLog ? 'Ocultar log' : 'Log'}
        </button>
        {!hangarOff && (
          <button className="btn" disabled={busy} onClick={toggleDetails}>
            {details !== undefined ? 'Ocultar' : 'Detalhes'}
          </button>
        )}
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
      setResult({ ok: false, servers: [], raw: '', cwd, error: errorText(err) })
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
        {cwd ? (
          <span className={styles.path}>{cwd}</span>
        ) : (
          <span className="muted">nenhum (escolha uma pasta para ver o .mcp.json e ligar/desligar por projeto)</span>
        )}
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
