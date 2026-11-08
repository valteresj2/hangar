// The red ● "Gravar" button in the new-session box: a quick way to record a task (Settings → Gravar uma tarefa has the
// same flow in full). The first click opens a small panel to confirm the apps (the last ones are remembered on this
// computer) and the microphone; ● starts. While recording, the button shows the time and ■ stops; the review opens.
import { useEffect, useRef, useState } from 'react'
import type { AllowedApp } from '@shared/features/computer'
import { useUi } from '../../core/ui'
import { errorText } from '../platform/api'
import { AppPicker } from './ComputerSection'
import { clock, recorderApi, startMicrophone, useRecorder, useRecorderStore } from './recorderApi'
import styles from './computer.module.css'

const LAST_APPS = 'hangar.record.lastApps'

function lastApps(): AllowedApp[] {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_APPS) ?? '[]') as AllowedApp[]
    return Array.isArray(v) ? v.filter((a) => a && a.name && a.process) : []
  } catch {
    return []
  }
}

export function RecordButton({ title }: { title?: string }) {
  const s = useRecorder()
  const openSettings = useUi((u) => u.openSettings)
  const [open, setOpen] = useState(false)
  const [apps, setApps] = useState<AllowedApp[]>(lastApps)
  const [microphone, setMicrophone] = useState(true)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const active = s?.active

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  if (!s?.supported) return null

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      try {
        localStorage.setItem(LAST_APPS, JSON.stringify(apps))
      } catch {
        /* only a convenience */
      }
      const st = await recorderApi.start({ title: title?.trim() || 'Tarefa gravada', apps, microphone })
      useRecorderStore.setState({ state: st })
      if (microphone && st.active) await startMicrophone(st.active.id)
      setOpen(false)
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const stop = async (): Promise<void> => {
    const id = active?.id
    try {
      useRecorderStore.setState({ state: await recorderApi.stop() })
    } catch (e) {
      setError(errorText(e))
      return
    }
    if (id) useRecorderStore.setState({ reviewId: id })
    openSettings('record')
  }

  if (active)
    return (
      <button
        className={`btn ${styles.recBtn} ${styles.recOn}`}
        title="Parar a gravação e revisar"
        onClick={() => void stop()}
        data-testid="composer-record-stop"
      >
        <span className={styles.recSquare} /> {clock(active.elapsedMs)} · Parar
      </button>
    )

  return (
    <div className={styles.recWrap} ref={box}>
      <button
        className={`btn ${styles.recBtn}`}
        title="Gravar uma tarefa: a tela dos apps escolhidos e a sua explicação no microfone"
        onClick={() => setOpen((o) => !o)}
        data-testid="composer-record"
      >
        <span className={styles.recDot} /> Gravar
      </button>
      {open && (
        <div className={styles.recPanel} data-testid="composer-record-panel">
          <div className={styles.sub} style={{ marginTop: 0 }}>
            Gravar uma tarefa
          </div>
          <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
            Faça a tarefa e explique em voz alta o que faz e quando. Só os apps marcados entram; senhas nunca.
          </p>
          <AppPicker value={apps} onChange={setApps} />
          <label className={styles.check} style={{ marginTop: 8 }}>
            <input type="checkbox" checked={microphone} onChange={(e) => setMicrophone(e.target.checked)} />
            Microfone (a sua explicação)
          </label>
          <div className={styles.actions}>
            <button
              className={`btn ${styles.recStart}`}
              disabled={!apps.length || busy}
              onClick={() => void start()}
              data-testid="composer-record-start"
            >
              <span className={styles.recDot} /> {busy ? 'Começando…' : 'Começar a gravar'}
            </button>
            {error && <span className={styles.errorText}>{error}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
