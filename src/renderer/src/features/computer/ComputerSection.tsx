// Settings → Posto no computador: a Digital employee the person manages works on this computer's screen, only in the
// apps picked here. Off by default; turning it on is explicit, the indicator and the kill switch are always there.
import { useEffect, useMemo, useState } from 'react'
import type {
  AllowedApp,
  AuthMode,
  ComputerState,
  InstalledApp,
  ManagedEmployee,
  TeamOption
} from '@shared/features/computer'
import { Card, Row, Segmented } from '../settings/ui'
import { errorText } from '../platform/api'
import { STATUS_LABEL, computerApi, useComputer, useComputerStore } from './api'
import styles from './computer.module.css'

async function run<T>(fn: () => Promise<T>, setError: (e?: string) => void): Promise<T | undefined> {
  setError(undefined)
  try {
    const out = await fn()
    if (out && typeof out === 'object' && 'status' in (out as object) && 'apps' in (out as object))
      useComputerStore.setState({ state: out as never })
    return out
  } catch (e) {
    setError(errorText(e))
    return undefined
  }
}

export function AppPicker({ value, onChange }: { value: AllowedApp[]; onChange(apps: AllowedApp[]): void }) {
  const [found, setFound] = useState<InstalledApp[]>()
  const [q, setQ] = useState('')
  useEffect(() => {
    void computerApi.installedApps().then(setFound, () => setFound([]))
  }, [])
  const chosen = new Set(value.map((a) => a.process.toLowerCase()))
  const list = useMemo(() => {
    const all = [...(found ?? [])]
    for (const a of value)
      if (!all.some((x) => x.process.toLowerCase() === a.process.toLowerCase())) all.push({ ...a, source: 'window' })
    const t = q.trim().toLowerCase()
    return all
      .filter((a) => !t || a.name.toLowerCase().includes(t) || a.process.toLowerCase().includes(t))
      .sort((a, b) => Number(chosen.has(b.process.toLowerCase())) - Number(chosen.has(a.process.toLowerCase())))
      .slice(0, 80)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, q, value])
  const toggle = (a: InstalledApp): void => {
    if (a.blocked) return
    if (chosen.has(a.process.toLowerCase()))
      onChange(value.filter((x) => x.process.toLowerCase() !== a.process.toLowerCase()))
    else onChange([...value, { name: a.name, process: a.process, ...(a.launch ? { launch: a.launch } : {}) }])
  }
  return (
    <div className={styles.picker} data-testid="computer-apps">
      <input className="input" placeholder="Procurar app…" value={q} onChange={(e) => setQ(e.target.value)} />
      {!found && <div className="muted">Procurando os apps deste computador…</div>}
      <ul className={styles.apps}>
        {list.map((a) => {
          const on = chosen.has(a.process.toLowerCase())
          return (
            <li key={a.process} className={a.blocked ? styles.blocked : undefined}>
              <label title={a.blocked ? `Nunca liberado: ${a.blocked}` : a.launch || a.process}>
                <input type="checkbox" checked={on} disabled={!!a.blocked} onChange={() => toggle(a)} />
                <span className={styles.appName}>{a.name}</span>
                <span className={styles.process}>{a.process}</span>
              </label>
              {a.blocked && <div className={styles.why}>Nunca liberado: {a.blocked}</div>}
              {!a.blocked && a.warning && on && <div className={styles.warn}>⚠ {a.warning}</div>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Who may borrow this computer and how the person authorizes (used to share and, later, to change it). */
function ShareSettingsFields({
  authMode,
  allowManaged,
  teamIds,
  onChange
}: {
  authMode: AuthMode
  allowManaged: boolean
  teamIds: number[]
  onChange(p: { authMode?: AuthMode; allowManaged?: boolean; teamIds?: number[] }): void
}) {
  const [teams, setTeams] = useState<TeamOption[]>()
  useEffect(() => {
    void computerApi.teams().then(setTeams, () => setTeams([]))
  }, [])
  return (
    <>
      <Row label="Autorização" hint="Perguntar: você permite cada empréstimo, na hora, neste computador (recomendado).">
        <Segmented
          value={authMode}
          options={[
            { value: 'ask', label: 'Perguntar a cada uso' },
            { value: 'preauthorized', label: 'Pré-autorizado' }
          ]}
          onChange={(v) => onChange({ authMode: v })}
        />
      </Row>
      <Row label="Quem pode usar" hint="Funcionários que você gerencia e/ou os dos times que você escolher.">
        <div className={styles.who} data-testid="computer-who">
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={allowManaged}
              onChange={(e) => onChange({ allowManaged: e.target.checked })}
            />
            funcionários que eu gerencio
          </label>
          {teams?.map((t) => (
            <label key={t.id} className={styles.check}>
              <input
                type="checkbox"
                checked={teamIds.includes(t.id)}
                onChange={(e) =>
                  onChange({ teamIds: e.target.checked ? [...teamIds, t.id] : teamIds.filter((x) => x !== t.id) })
                }
              />
              funcionários do time {t.name}
            </label>
          ))}
        </div>
      </Row>
    </>
  )
}

function ShareCard() {
  const [apps, setApps] = useState<AllowedApp[]>(useComputerStore.getState().state?.apps ?? [])
  const [authMode, setAuthMode] = useState<AuthMode>('ask')
  const [allowManaged, setAllowManaged] = useState(true)
  const [teamIds, setTeamIds] = useState<number[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const go = async (): Promise<void> => {
    setBusy(true)
    await run(() => computerApi.share({ apps, authMode, allowManaged, teamIds }), setError)
    setBusy(false)
  }
  return (
    <Card title="Compartilhar este computador">
      <p className={`${styles.lead} ${styles.body}`}>
        Os funcionários digitais que você liberar podem <b>pegar este computador emprestado</b> quando uma tarefa
        precisa de um app que só existe aqui. Eles continuam rodando na plataforma; só os passos de tela acontecem neste
        computador, nos apps que você escolher, com a alçada de cada um. Por padrão, cada empréstimo pergunta antes; um
        aviso fica no alto da tela enquanto alguém usa, e você para quando quiser.
      </p>
      <ShareSettingsFields
        authMode={authMode}
        allowManaged={allowManaged}
        teamIds={teamIds}
        onChange={(p) => {
          if (p.authMode) setAuthMode(p.authMode)
          if (p.allowManaged !== undefined) setAllowManaged(p.allowManaged)
          if (p.teamIds) setTeamIds(p.teamIds)
        }}
      />
      <div className={styles.body}>
        <div className={styles.sub}>Apps liberados neste computador</div>
        <AppPicker value={apps} onChange={setApps} />
        <div className={styles.actions}>
          <button
            className="btn btn-primary"
            disabled={!apps.length || busy || (!allowManaged && !teamIds.length)}
            onClick={() => void go()}
          >
            {busy ? 'Compartilhando…' : 'Compartilhar este computador'}
          </button>
          {error && <span className={styles.errorText}>{error}</span>}
        </div>
      </div>
    </Card>
  )
}

/** Loan requests waiting for the person (the same as the dialog the app shows). */
function RequestsCard({ s, setError }: { s: ComputerState; setError(e?: string): void }) {
  if (!s.requests.length) return null
  return (
    <Card title="Pedidos de uso">
      <ul className={styles.requests} data-testid="computer-requests">
        {s.requests.map((r) => (
          <li key={r.lease_id}>
            <div>
              <b>{r.employee}</b> quer usar este computador para a tarefa #{r.task_id}: {r.task_title}
              {r.app && <span className="muted"> · app {r.app}</span>}
              {r.reason && <div className="muted">Motivo: {r.reason}</div>}
            </div>
            <div className={styles.actions}>
              <button
                className="btn btn-primary"
                onClick={() => void run(() => computerApi.answer(r.lease_id, true), setError)}
              >
                Permitir
              </button>
              <button className="btn" onClick={() => void run(() => computerApi.answer(r.lease_id, false), setError)}>
                Recusar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function EnableCard({ connected }: { connected: boolean }) {
  const [employees, setEmployees] = useState<ManagedEmployee[]>()
  const [slug, setSlug] = useState('')
  const [apps, setApps] = useState<AllowedApp[]>(useComputerStore.getState().state?.apps ?? [])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!connected) return
    void computerApi.employees().then(
      (list) => {
        setEmployees(list)
        if (list.length === 1) setSlug(list[0].slug)
      },
      (e) => setError(errorText(e))
    )
  }, [connected])
  if (!connected)
    return (
      <Card title="Ligar o posto">
        <p className={`muted ${styles.body}`}>
          Conecte o app à plataforma (Configurações → Plataforma) para escolher um funcionário.
        </p>
      </Card>
    )
  const go = async (): Promise<void> => {
    setBusy(true)
    await run(() => computerApi.enable({ slug, apps }), setError)
    setBusy(false)
  }
  return (
    <Card title="Ou: o posto de um funcionário neste computador">
      <p className={`${styles.lead} ${styles.body}`}>
        O funcionário escolhido passa a trabalhar <b>na tela deste computador</b>: olha a janela, clica, digita e abre
        os apps que você liberar aqui — nenhum outro. Enquanto ele trabalha, um aviso fica no alto da tela com o botão
        <b> Parar</b> (ou Ctrl+Alt+End). Se você mexer no mouse ou no teclado, ele pausa. O que salva, confirma, envia
        ou paga espera a aprovação na plataforma, com a captura da tela. Ele deixa de trabalhar em outro posto (VS
        Code).
      </p>
      <Row label="Funcionário" hint="Só os Digital employees que você gerencia.">
        <select
          className="input"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          data-testid="computer-employee"
        >
          <option value="">{employees ? 'Escolha…' : 'Carregando…'}</option>
          {employees?.map((e) => (
            <option key={e.slug} value={e.slug}>
              {e.name} {e.title ? `— ${e.title}` : ''}
            </option>
          ))}
        </select>
      </Row>
      <div className={styles.body}>
        <div className={styles.sub}>Apps liberados neste computador</div>
        <AppPicker value={apps} onChange={setApps} />
        <div className={styles.actions}>
          <button className="btn btn-primary" disabled={!slug || !apps.length || busy} onClick={() => void go()}>
            {busy ? 'Ligando…' : 'Ligar neste computador'}
          </button>
          {error && <span className={styles.errorText}>{error}</span>}
        </div>
      </div>
    </Card>
  )
}

export function ComputerSection() {
  const s = useComputer()
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<AllowedApp[]>()
  const [giveBack, setGiveBack] = useState(true)
  if (!s) return <div className="muted">Carregando…</div>
  if (!s.supported)
    return (
      <Card title="Posto no computador">
        <p className={`muted ${styles.body}`}>{s.unsupportedReason}</p>
      </Card>
    )
  if (s.status === 'off' && s.mode === 'off')
    return (
      <>
        {s.connected ? (
          <ShareCard />
        ) : (
          <Card title="Compartilhar este computador">
            <p className={`muted ${styles.body}`}>
              Conecte o app à plataforma (Configurações → Plataforma) para compartilhar o computador.
            </p>
          </Card>
        )}
        <EnableCard connected={s.connected} />
      </>
    )
  const running = s.status === 'working' || s.status === 'paused' || s.status === 'idle'
  const sharedMode = s.mode === 'shared'
  return (
    <>
      <Card title={sharedMode ? 'Computador compartilhado' : 'Posto no computador'}>
        <div className={styles.body}>
          <div className={styles.status} data-testid="computer-status" data-status={s.status}>
            <span className={`${styles.dot} ${styles[s.status] ?? ''}`} />
            <div>
              <div className={styles.statusText}>
                {sharedMode
                  ? s.borrower
                    ? `${s.borrower.employee} · ${STATUS_LABEL[s.status]}`
                    : `${s.share?.name ?? 'Este computador'} · compartilhado`
                  : `${s.employee?.name ?? ''} · ${STATUS_LABEL[s.status]}`}
              </div>
              {s.task && (
                <div className="muted">
                  Tarefa #{s.task.id}: {s.task.title}
                </div>
              )}
              {s.detail && <div className="muted">{s.detail}</div>}
              {s.notice && <div className={styles.warn}>⚠ {s.notice}</div>}
            </div>
          </div>
          <div className={styles.actions}>
            {running && (
              <button className="btn btn-danger" onClick={() => void run(() => computerApi.stop(), setError)}>
                Parar ({s.stopShortcut})
              </button>
            )}
            {s.status === 'paused' && (
              <button className="btn" onClick={() => void run(() => computerApi.resumeNow(), setError)}>
                Retomar agora
              </button>
            )}
            {(s.status === 'stopped' || s.status === 'error') && (
              <button className="btn btn-primary" onClick={() => void run(() => computerApi.resume(), setError)}>
                Ligar de novo
              </button>
            )}
            {sharedMode ? (
              <button className="btn" onClick={() => void run(() => computerApi.unshare(), setError)}>
                Parar de compartilhar
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => void run(() => computerApi.disable(giveBack), setError)}>
                  Desligar o posto
                </button>
                <label className={styles.check}>
                  <input type="checkbox" checked={giveBack} onChange={(e) => setGiveBack(e.target.checked)} />
                  devolver o funcionário à plataforma
                </label>
              </>
            )}
          </div>
          {error && <div className={styles.errorText}>{error}</div>}
        </div>
      </Card>
      {sharedMode && <RequestsCard s={s} setError={setError} />}
      {sharedMode && s.share && (
        <Card title="Quem pode usar e como">
          <ShareSettingsFields
            authMode={s.share.authMode}
            allowManaged={s.share.allowManaged}
            teamIds={s.share.teamIds}
            onChange={(p) => void run(() => computerApi.updateShare(p), setError)}
          />
        </Card>
      )}
      <Card
        title="Apps liberados"
        actions={
          editing ? (
            <>
              <button
                className="btn btn-primary"
                onClick={() => void run(() => computerApi.setApps(editing), setError).then(() => setEditing(undefined))}
              >
                Salvar
              </button>
              <button className="btn" onClick={() => setEditing(undefined)}>
                Cancelar
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setEditing(s.apps)}>
              Alterar
            </button>
          )
        }
      >
        <div className={styles.body}>
          {editing ? (
            <AppPicker value={editing} onChange={setEditing} />
          ) : (
            <ul className={styles.chosen}>
              {s.apps.map((a) => (
                <li key={a.process}>
                  <b>{a.name}</b> <span className={styles.process}>{a.process}</span>
                  {a.warning && <div className={styles.warn}>⚠ {a.warning}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <Card title="Pausa">
        <Row
          label="Retomar depois de"
          hint="Segundos sem você usar o mouse ou o teclado antes de o funcionário agir de novo."
        >
          <input
            className="input"
            type="number"
            min={1}
            max={600}
            value={s.resumeAfterS}
            onChange={(e) => void run(() => computerApi.setResumeAfter(Number(e.target.value)), setError)}
            style={{ width: 90 }}
          />
        </Row>
      </Card>
      <Card title="Últimas ações na tela">
        <div className={styles.body}>
          {s.recent.length === 0 ? (
            <p className="muted">Nada ainda. Cada ação também fica na linha do tempo da tarefa, na plataforma.</p>
          ) : (
            <ul className={styles.recent} data-testid="computer-recent">
              {s.recent.map((a, i) => (
                <li key={`${a.at}-${i}`} className={a.ok ? undefined : styles.failed}>
                  <span className={styles.time}>{new Date(a.at).toLocaleTimeString('pt-BR')}</span>
                  <span className={styles.tool}>{a.tool.replace('desktop_', '')}</span>
                  <span>{a.summary}</span>
                  <span className="muted">#{a.taskId}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </>
  )
}
