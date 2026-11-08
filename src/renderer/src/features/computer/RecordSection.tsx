// Settings → Gravar uma tarefa: the person records the apps she chose while she does and explains a task; she
// reviews what was recorded (and can delete steps or everything), sends it, corrects the draft the platform made and
// hires a Digital employee in shadow mode and probation that does the task on this computer, on the schedule.
// Design: docs/platform/record-to-agent-plan.md.
import { useEffect, useState } from 'react'
import type { AllowedApp } from '@shared/features/computer'
import {
  describeStep,
  type RecordingDetail,
  type RecordingDraft,
  type RecordingSummary
} from '@shared/features/recorder'
import { Card, Row } from '../settings/ui'
import { errorText } from '../platform/api'
import { AppPicker } from './ComputerSection'
import { useComputer } from './api'
import { RECORDING_STATUS, clock, recorderApi, startMicrophone, useRecorder, useRecorderStore } from './recorderApi'
import styles from './computer.module.css'

function StartCard() {
  const [title, setTitle] = useState('')
  const [apps, setApps] = useState<AllowedApp[]>([])
  const [microphone, setMicrophone] = useState(true)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const go = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const s = await recorderApi.start({ title, apps, microphone })
      useRecorderStore.setState({ state: s })
      if (microphone && s.active) await startMicrophone(s.active.id)
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }
  return (
    <Card title="Gravar uma tarefa">
      <div className={styles.body}>
        <p className={styles.lead}>
          Faça a tarefa como sempre e <b>explique em voz alta</b> o que está fazendo, por quê e <b>quando</b> ela
          acontece (&quot;toda segunda às 9h…&quot;). O app grava só os apps que você escolher: onde você clica, o que
          escreve em cada campo (senha nunca: só que foi digitada) e a janela naquele momento. Um aviso vermelho fica no
          alto da tela com <b>Pausar</b> e <b>Parar</b>. Nada sai deste computador antes da sua revisão.
        </p>
        <Row label="Nome da tarefa">
          <input
            className="input"
            value={title}
            maxLength={120}
            placeholder="Ex.: Lançar as faturas da semana"
            onChange={(e) => setTitle(e.target.value)}
            data-testid="record-title"
          />
        </Row>
        <div className={styles.sub}>Apps que entram na gravação</div>
        <AppPicker value={apps} onChange={setApps} />
        <label className={styles.check} style={{ marginTop: 10 }}>
          <input type="checkbox" checked={microphone} onChange={(e) => setMicrophone(e.target.checked)} />
          Gravar o microfone (a sua explicação)
        </label>
        <div className={styles.actions}>
          <button
            className="btn btn-primary"
            disabled={!apps.length || busy}
            onClick={() => void go()}
            data-testid="record-start"
          >
            {busy ? 'Começando…' : 'Começar a gravar'}
          </button>
          {error && <span className={styles.errorText}>{error}</span>}
        </div>
      </div>
    </Card>
  )
}

function ActiveCard({ a }: { a: NonNullable<ReturnType<typeof useRecorder>>['active'] & object }) {
  const micError = useRecorderStore((s) => s.micError)
  const [error, setError] = useState<string>()
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Card title={`Gravando: ${a.title}`}>
      <div className={styles.body} data-testid="record-active">
        <div className={styles.status}>
          <span className={`${styles.dot} ${a.paused ? styles.paused : styles.recording}`} />
          <div>
            <div className={styles.statusText}>
              {a.paused ? 'Pausada' : 'Gravando'} · {clock(a.elapsedMs)} de {clock(a.limitMs)}
            </div>
            <div className="muted">
              {a.steps} passo{a.steps === 1 ? '' : 's'} em {a.apps.join(', ')}
              {a.microphone ? ' · microfone ligado' : ''}
            </div>
          </div>
        </div>
        {micError && <p className={styles.warn}>{micError}</p>}
        <div className={styles.actions}>
          <button
            className="btn"
            onClick={() => void act(() => (a.paused ? recorderApi.resume() : recorderApi.pause()))}
          >
            {a.paused ? 'Continuar' : 'Pausar'}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void act(() => recorderApi.stop())}
            data-testid="record-stop"
          >
            Parar e revisar
          </button>
          {error && <span className={styles.errorText}>{error}</span>}
        </div>
      </div>
    </Card>
  )
}

function DraftEditor({
  r,
  onChange,
  computerMode
}: {
  r: RecordingDetail
  onChange(r: RecordingDetail): void
  computerMode: string
}) {
  const [d, setD] = useState<RecordingDraft>(r.draft!)
  const [share, setShare] = useState(computerMode !== 'worker')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<RecordingDraft>): void => setD({ ...d, ...patch })
  const hire = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      onChange(await recorderApi.hire(r.id, { draft: d, shareComputer: share }))
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }
  const save = async (): Promise<void> => {
    setError(undefined)
    try {
      onChange(await recorderApi.saveDraft(r.id, d))
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <div data-testid="record-draft">
      <div className={styles.sub}>Rascunho do funcionário — corrija o que precisar</div>
      <Row label="Cargo">
        <input className="input" value={d.title} onChange={(e) => set({ title: e.target.value })} />
      </Row>
      <Row label="Missão">
        <textarea className="input" rows={2} value={d.mission} onChange={(e) => set({ mission: e.target.value })} />
      </Row>
      <div className={styles.sub}>Procedimento</div>
      <ol className={styles.draftSteps}>
        {d.steps.map((s, i) => (
          <li key={i}>
            <input
              className="input"
              value={`${s.target}${s.value ? ` → ${s.value}` : ''}`}
              title={s.note}
              onChange={(e) => {
                const [target, ...rest] = e.target.value.split(' → ')
                const steps = [...d.steps]
                steps[i] = { ...s, target, ...(rest.length ? { value: rest.join(' → ') } : { value: undefined }) }
                set({ steps })
              }}
            />
            <span className={styles.process}>
              {s.action}
              {s.app ? ` · ${s.app}` : ''}
            </span>
            <label className={styles.check} title="Este passo confirma algo (salva, envia, paga): pede aprovação">
              <input
                type="checkbox"
                checked={!!s.confirms}
                onChange={(e) => {
                  const steps = [...d.steps]
                  steps[i] = { ...s, confirms: e.target.checked }
                  set({ steps })
                }}
              />
              pede aprovação
            </label>
            <button className="btn btn-ghost" onClick={() => set({ steps: d.steps.filter((_x, j) => j !== i) })}>
              Tirar
            </button>
          </li>
        ))}
      </ol>
      {!!d.variables.length && (
        <>
          <div className={styles.sub}>O que muda a cada vez</div>
          <ul className={styles.chosen}>
            {d.variables.map((v) => (
              <li key={v.name}>
                <b>{v.name}</b>: {v.description} <span className="muted">({v.source})</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className={styles.sub}>Quando roda</div>
      <Row label="Agenda" hint="Cron (minuto hora dia mês dia-da-semana), no horário em que o computador fica ligado.">
        <div className={styles.schedule}>
          <input
            className="input"
            value={d.schedule.cron}
            placeholder="0 9 * * 1"
            onChange={(e) => set({ schedule: { ...d.schedule, cron: e.target.value } })}
            data-testid="record-cron"
          />
          <input
            className="input"
            value={d.schedule.text}
            placeholder="toda segunda às 9h"
            onChange={(e) => set({ schedule: { ...d.schedule, text: e.target.value } })}
          />
        </div>
      </Row>
      {!!d.questions.length && (
        <>
          <div className={styles.sub}>Perguntas que a gravação não respondeu</div>
          {d.questions.map((q, i) => (
            <Row key={i} label={q.question}>
              <input
                className="input"
                value={q.answer}
                onChange={(e) => {
                  const questions = [...d.questions]
                  questions[i] = { ...q, answer: e.target.value }
                  set({ questions })
                }}
                data-testid="record-answer"
              />
            </Row>
          ))}
        </>
      )}
      {!!d.secrets.length && (
        <p className={styles.warn}>
          Senhas usadas: {d.secrets.map((s) => `${s.name} (${s.field})`).join(', ')}. O funcionário recebe só o nome
          (secret://…): cadastre o valor no cofre da plataforma.
        </p>
      )}
      {!!d.probation.length && (
        <>
          <div className={styles.sub}>Ensaios do período de experiência</div>
          <ul className={styles.chosen}>
            {d.probation.map((p, i) => (
              <li key={i}>
                <b>{p.title}</b> — espera-se: {p.expected}
              </li>
            ))}
          </ul>
        </>
      )}
      <label className={styles.check} style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={share}
          disabled={computerMode === 'worker'}
          onChange={(e) => setShare(e.target.checked)}
        />
        Compartilhar este computador com os apps da gravação (perguntando a cada uso), para os ensaios e a rotina
      </label>
      <p className="muted">
        O funcionário nasce em <b>modo sombra</b> e em <b>período de experiência</b>: o que confirma algo é simulado e
        você avalia os ensaios antes de ele trabalhar de verdade.
      </p>
      <div className={styles.actions}>
        <button className="btn btn-primary" disabled={busy} onClick={() => void hire()} data-testid="record-hire">
          {busy ? 'Contratando…' : 'Contratar em modo sombra'}
        </button>
        <button className="btn" onClick={() => void save()}>
          Salvar o rascunho
        </button>
        {error && <span className={styles.errorText}>{error}</span>}
      </div>
    </div>
  )
}

function Review({ id, onClose }: { id: string; onClose(): void }) {
  const computer = useComputer()
  const [r, setR] = useState<RecordingDetail>()
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  useEffect(() => {
    void recorderApi.get(id).then(
      (x) => {
        setR(x)
        setNotes(x.notes)
      },
      (e) => setError(errorText(e))
    )
  }, [id])
  const act = async (label: string, fn: () => Promise<RecordingDetail | void>): Promise<void> => {
    setBusy(label)
    setError(undefined)
    try {
      const out = await fn()
      if (out) setR(out)
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(undefined)
  }
  if (!r)
    return (
      <Card title="Revisar a gravação">
        <p className={`muted ${styles.body}`}>{error ?? 'Abrindo…'}</p>
      </Card>
    )
  const sent = r.status === 'drafted' || r.status === 'hired'
  return (
    <Card
      title={`Revisar: ${r.title}`}
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          Voltar
        </button>
      }
    >
      <div className={styles.body} data-testid="record-review">
        <p className="muted">
          {clock(r.durationMs)} · {r.apps.join(', ')} · {RECORDING_STATUS[r.status]}
        </p>
        <div className={styles.sub}>O que foi gravado ({r.timeline.length})</div>
        <ol className={styles.timeline} data-testid="record-timeline">
          {r.timeline.map((s, i) => (
            <li key={i} className={s.outside ? styles.outside : undefined}>
              <span className={styles.time}>{clock(s.t)}</span>
              <span>{describeStep(s)}</span>
              {s.frame !== undefined && r.frames[s.frame] && (
                <a href={r.frames[s.frame]} target="_blank" rel="noreferrer">
                  <img className={styles.thumb} src={r.frames[s.frame]} alt="janela neste passo" />
                </a>
              )}
              {!sent && (
                <button
                  className="btn btn-ghost"
                  onClick={() => void act('rm', () => recorderApi.update(r.id, { removeSteps: [i] }))}
                >
                  Apagar
                </button>
              )}
            </li>
          ))}
        </ol>
        <div className={styles.sub}>A sua explicação</div>
        {r.audio ? (
          <div className={styles.actions}>
            <span className="muted">Narração gravada.</span>
            {!sent && (
              <>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() => void act('tr', () => recorderApi.transcribe(r.id))}
                  data-testid="record-transcribe"
                >
                  {busy === 'tr' ? 'Transcrevendo…' : r.transcript.length ? 'Transcrever de novo' : 'Transcrever'}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => void act('ra', () => recorderApi.update(r.id, { removeAudio: true }))}
                >
                  Apagar a narração
                </button>
              </>
            )}
          </div>
        ) : (
          <p className="muted">Sem narração: escreva abaixo o que você faz, por quê e quando.</p>
        )}
        {!!r.transcript.length && (
          <blockquote className={styles.transcript} data-testid="record-transcript">
            {r.transcript.map((t) => t.text).join(' ')}
          </blockquote>
        )}
        <textarea
          className="input"
          rows={3}
          value={notes}
          disabled={sent}
          placeholder="Ex.: toda segunda às 9h eu lanço as faturas vencidas da semana no ERP…"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            // saved quietly: leaving the field right into "Enviar" must not disable the button under the click
            if (notes !== r.notes)
              void recorderApi.update(r.id, { notes }).then(
                (x) => setR((cur) => (cur && cur.status === x.status ? { ...cur, notes: x.notes } : cur)),
                (e) => setError(errorText(e))
              )
          }}
          data-testid="record-notes"
        />
        {!sent && (
          <div className={styles.actions}>
            <button
              className="btn btn-primary"
              disabled={!!busy || r.status === 'sending'}
              onClick={() =>
                void act('send', async () => {
                  if (notes !== r.notes) await recorderApi.update(r.id, { notes })
                  return recorderApi.send(r.id)
                })
              }
              data-testid="record-send"
            >
              {busy === 'send' || r.status === 'sending' ? 'Montando o rascunho…' : 'Enviar e montar o rascunho'}
            </button>
            <span className="muted">
              Vão: os passos, a explicação e até 12 capturas das janelas. O vídeo e o áudio ficam aqui.
            </span>
          </div>
        )}
        {r.status === 'failed' && r.error && <p className={styles.errorText}>{r.error}</p>}
        {r.status === 'drafted' && r.draft && (
          <DraftEditor r={r} onChange={setR} computerMode={computer?.mode ?? 'off'} />
        )}
        {r.status === 'hired' && (
          <p data-testid="record-hired">
            <b>{r.employee?.name ?? 'O funcionário'}</b> foi contratado em modo sombra e período de experiência. Os
            ensaios rodam neste computador; acompanhe e avalie na plataforma.
          </p>
        )}
        <div className={styles.actions}>
          <button
            className="btn btn-ghost"
            onClick={() =>
              void act('del', async () => {
                await recorderApi.discard(r.id)
                onClose()
              })
            }
            data-testid="record-discard"
          >
            Apagar tudo desta gravação
          </button>
          {error && <span className={styles.errorText}>{error}</span>}
        </div>
      </div>
    </Card>
  )
}

function ListCard({ list, onOpen, days }: { list: RecordingSummary[]; onOpen(id: string): void; days: number }) {
  if (!list.length) return null
  return (
    <Card title="Gravações neste computador">
      <ul className={styles.requests} data-testid="record-list">
        {list.map((r) => (
          <li key={r.id}>
            <div className={styles.status}>
              <div style={{ flex: 1 }}>
                <div className={styles.statusText}>{r.title}</div>
                <div className="muted">
                  {new Date(r.createdAt).toLocaleString()} · {clock(r.durationMs)} · {r.steps} passos ·{' '}
                  {RECORDING_STATUS[r.status]}
                  {r.employee ? ` · ${r.employee.name}` : ''}
                </div>
              </div>
              <button className="btn" onClick={() => onOpen(r.id)}>
                Abrir
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className={`muted ${styles.body}`}>Cada gravação fica aqui, cifrada, por {days} dias e depois é apagada.</p>
    </Card>
  )
}

export function RecordSection() {
  const s = useRecorder()
  const [open, setOpen] = useState<string>()
  const [last, setLast] = useState<string>()
  const reviewId = useRecorderStore((x) => x.reviewId)
  useEffect(() => {
    // stopped from the ● button of the new-session box: open its review here
    if (reviewId) {
      setOpen(reviewId)
      useRecorderStore.setState({ reviewId: undefined })
    }
  }, [reviewId])
  const activeId = s?.active?.id
  useEffect(() => {
    // When a recording stops (here or on the red indicator), its review opens.
    if (activeId) setLast(activeId)
    else if (last) {
      setOpen(last)
      setLast(undefined)
    }
  }, [activeId, last])
  if (!s) return <div className="muted">Carregando…</div>
  if (!s.supported)
    return (
      <Card title="Gravar uma tarefa">
        <p className={`muted ${styles.body}`}>{s.why}</p>
      </Card>
    )
  if (s.active) return <ActiveCard a={s.active} />
  if (open) return <Review id={open} onClose={() => setOpen(undefined)} />
  return (
    <>
      <StartCard />
      <ListCard list={s.recordings} onOpen={setOpen} days={s.retentionDays} />
    </>
  )
}
