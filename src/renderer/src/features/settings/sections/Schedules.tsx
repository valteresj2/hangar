import { useCallback, useEffect, useState } from 'react'
import type { PermissionMode } from '@shared/contracts'
import { SETTINGS, type CronCheck, type ScheduledTask, type ScheduledTaskInput, type ScheduleRun } from '@shared/features/settings'
import { api, bridge } from '../../../core/api'
import { useUi } from '../../../core/ui'
import { errorText, settingsApi } from '../api'
import { Card, Dot, Spinner, Switch, formatDateTime } from '../ui'
import { MODEL_SUGGESTIONS, PERMISSION_MODES } from './General'
import styles from '../settings.module.css'

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'A cada hora', cron: '0 * * * *' },
  { label: 'Todo dia às 9h', cron: '0 9 * * *' },
  { label: 'Dias úteis às 9h', cron: '0 9 * * 1-5' },
  { label: 'Toda segunda às 8h', cron: '0 8 * * 1' },
  { label: 'A cada 15 minutos', cron: '*/15 * * * *' }
]

const EMPTY: ScheduledTaskInput = { name: '', cron: '0 9 * * 1-5', cwd: '', prompt: '', enabled: true }

const RESULT_LABEL: Record<ScheduleRun['result'], string> = { running: 'Em execução', success: 'Sucesso', error: 'Erro' }
const RESULT_TONE = { running: 'warn', success: 'ok', error: 'bad' } as const

function openSession(sessionId: string): void {
  const ui = useUi.getState()
  ui.selectSession(sessionId)
  ui.setSettingsOpen(false)
}

function ScheduleForm({ initial, onClose }: { initial: ScheduledTaskInput; onClose: () => void }) {
  const [draft, setDraft] = useState(initial)
  const [check, setCheck] = useState<CronCheck>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<ScheduledTaskInput>) => setDraft((d) => ({ ...d, ...patch }))

  useEffect(() => {
    let alive = true
    const t = setTimeout(() => void settingsApi.validateCron(draft.cron).then((c) => alive && setCheck(c)), 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [draft.cron])

  const pick = async () => {
    const folder = await api.pickFolder(draft.cwd || undefined)
    if (folder) set({ cwd: folder })
  }

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await settingsApi.saveSchedule(draft)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={initial.id ? 'Editar tarefa' : 'Nova tarefa'}>
      <div className={styles.form}>
        <label>Nome</label>
        <input className="input" value={draft.name} placeholder="Revisão diária" onChange={(e) => set({ name: e.target.value })} />

        <label>Quando (cron)</label>
        <div>
          <div className={styles.inline}>
            <input className="input" value={draft.cron} placeholder="min hora dia mês dia-da-semana" onChange={(e) => set({ cron: e.target.value })} />
            <select className={styles.select} value="" onChange={(e) => e.target.value && set({ cron: e.target.value })}>
              <option value="">Modelos…</option>
              {CRON_PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.hint} style={{ marginTop: 4 }}>
            {check?.valid ? (
              <>Próximas: {check.next?.map((n) => formatDateTime(n)).join(' · ')}</>
            ) : check?.error ? (
              <span className={styles.errorText}>{check.error}</span>
            ) : (
              ' '
            )}
          </div>
        </div>

        <label>Pasta</label>
        <div className={styles.inline}>
          <input className="input" value={draft.cwd} placeholder="C:\projetos\meu-app" onChange={(e) => set({ cwd: e.target.value })} />
          <button className="btn" onClick={() => void pick()}>
            Escolher…
          </button>
        </div>

        <label style={{ alignSelf: 'start', paddingTop: 6 }}>Prompt</label>
        <textarea
          className="input"
          style={{ minHeight: 110, fontFamily: 'var(--font)', fontSize: 14 }}
          value={draft.prompt}
          placeholder="Revise os commits de ontem e liste riscos."
          onChange={(e) => set({ prompt: e.target.value })}
        />

        <label>Modelo</label>
        <input
          className="input"
          list="hangar-schedule-models"
          value={draft.model ?? ''}
          placeholder="Padrão das configurações"
          onChange={(e) => set({ model: e.target.value })}
        />
        <datalist id="hangar-schedule-models">
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <label>Permissões</label>
        <select
          className={styles.select}
          value={draft.permissionMode ?? ''}
          onChange={(e) => set({ permissionMode: (e.target.value || undefined) as PermissionMode | undefined })}
        >
          <option value="">Padrão das configurações</option>
          {PERMISSION_MODES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <label>Ativa</label>
        <div>
          <Switch label="Ativa" checked={draft.enabled} onChange={(enabled) => set({ enabled })} />
        </div>

        {error && <div className={`${styles.formFull} ${styles.errorText}`}>{error}</div>}

        <div className={styles.formActions}>
          {busy && <Spinner />}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || check?.valid === false} onClick={() => void submit()}>
            Salvar
          </button>
        </div>
      </div>
    </Card>
  )
}

function ScheduleItem({ task, onEdit }: { task: ScheduledTask; onEdit: () => void }) {
  const [showHistory, setShowHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const run = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const r = await settingsApi.runSchedule(task.id)
      if (r.result === 'error' && r.error) setError(r.error)
      setShowHistory(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (enabled: boolean) => {
    const { id, name, cron, cwd, prompt, model, permissionMode } = task
    void settingsApi.saveSchedule({ id, name, cron, cwd, prompt, model, permissionMode, enabled }).catch((err) => setError(errorText(err)))
  }

  const remove = async () => {
    if (window.confirm(`Excluir a tarefa "${task.name}"?`)) await settingsApi.deleteSchedule(task.id)
  }

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className={styles.item} style={{ borderBottom: 'none' }}>
        <div style={{ paddingTop: 2 }}>
          <Switch label="Ativa" checked={task.enabled} onChange={toggle} />
        </div>
        <div className={styles.itemMain}>
          <div className={styles.itemTitle}>
            {task.name}
            <span className={`${styles.badge} ${styles.path}`}>{task.cron}</span>
            {task.lastResult && (
              <span className={styles.badge}>
                <Dot tone={RESULT_TONE[task.lastResult]} /> {RESULT_LABEL[task.lastResult]}
              </span>
            )}
          </div>
          <div className={`${styles.itemSub} ${styles.path}`}>{task.cwd}</div>
          <div className={styles.itemSub} title={task.prompt}>
            {task.prompt.length > 140 ? `${task.prompt.slice(0, 140)}…` : task.prompt}
          </div>
          <div className={styles.itemSub}>
            Última: {formatDateTime(task.lastRunAt)} · Próxima: {task.enabled ? formatDateTime(task.nextRunAt) : 'desativada'}
            {task.history?.length ? (
              <>
                {' · '}
                <button className={styles.link} onClick={() => setShowHistory((v) => !v)}>
                  {showHistory ? 'ocultar histórico' : `histórico (${task.history.length})`}
                </button>
              </>
            ) : null}
          </div>
          {error && <div className={styles.errorText}>{error}</div>}
        </div>
        <div className={styles.itemActions}>
          {busy && <Spinner />}
          <button className="btn" disabled={busy} onClick={() => void run()}>
            Rodar agora
          </button>
          <button className="btn" onClick={onEdit}>
            Editar
          </button>
          <button className={`btn ${styles.btnDanger}`} onClick={() => void remove()}>
            Excluir
          </button>
        </div>
      </div>
      {showHistory && task.history?.length ? (
        <div className={styles.history}>
          <ul>
            {task.history.map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <Dot tone={RESULT_TONE[r.result]} />
                <span>{formatDateTime(r.at)}</span>
                <span className="muted">{r.manual ? 'manual' : 'agendada'}</span>
                <span>{RESULT_LABEL[r.result]}</span>
                {r.error && <span className={styles.errorText}>{r.error}</span>}
                {r.sessionId && (
                  <button className={styles.link} onClick={() => openSession(r.sessionId!)}>
                    abrir sessão
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export function SchedulesSection() {
  const [tasks, setTasks] = useState<ScheduledTask[]>()
  const [editing, setEditing] = useState<ScheduledTaskInput>()

  const refresh = useCallback(() => void settingsApi.schedules().then(setTasks), [])

  useEffect(() => {
    refresh()
    // nextRunAt moves with the clock; refresh it now and then while the section is open.
    const timer = setInterval(refresh, 30_000)
    const off = bridge.on(SETTINGS.schedulesChanged, refresh)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [refresh])

  const edit = (t: ScheduledTask) => {
    const { id, name, cron, cwd, prompt, model, permissionMode, enabled } = t
    setEditing({ id, name, cron, cwd, prompt, model, permissionMode, enabled })
  }

  return (
    <>
      <div className={styles.toolbar}>
        <span className="muted" style={{ flex: 1 }}>
          Rode um prompt numa pasta em horários definidos. Cada execução cria uma nova sessão. O Hangar precisa estar aberto.
        </span>
        {!editing && (
          <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}>
            Nova tarefa
          </button>
        )}
      </div>

      {editing && <ScheduleForm key={editing.id ?? 'new'} initial={editing} onClose={() => setEditing(undefined)} />}

      <Card title="Tarefas">
        {!tasks ? (
          <div className={styles.empty}>
            <Spinner />
          </div>
        ) : tasks.length === 0 ? (
          <div className={styles.empty}>Nenhuma tarefa agendada.</div>
        ) : (
          <div className={styles.list}>
            {tasks.map((t) => (
              <ScheduleItem key={t.id} task={t} onEdit={() => edit(t)} />
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
