import { useCallback, useEffect, useState } from 'react'
import type { OutputMode, TranscriptEntry } from '@shared/features/engine'
import { OPEN_ARTIFACT_EVENT, type OpenArtifactDetail } from '@shared/motion/spec'
import { useUi } from '../../core/ui'
import styles from './engine.module.css'

type MotionEntry = Extract<TranscriptEntry, { kind: 'motion' }>

const STORAGE_PREFIX = 'hangar.engine.output.'

/** "Saída" choice of a session, remembered per session in this browser profile. */
export function useOutputMode(sessionId: string): [OutputMode | undefined, (mode: OutputMode | undefined) => void] {
  const read = () => {
    try {
      return localStorage.getItem(STORAGE_PREFIX + sessionId) === 'motion' ? ('motion' as const) : undefined
    } catch {
      return undefined
    }
  }
  const [mode, setMode] = useState<OutputMode | undefined>(read)
  useEffect(() => setMode(read()), [sessionId])
  const update = useCallback(
    (next: OutputMode | undefined) => {
      setMode(next)
      try {
        if (next) localStorage.setItem(STORAGE_PREFIX + sessionId, next)
        else localStorage.removeItem(STORAGE_PREFIX + sessionId)
      } catch {
        // Storage unavailable: the choice just lasts for this view.
      }
    },
    [sessionId]
  )
  return [mode, update]
}

/** Opens the Artifacts side panel on a file. */
export function openInPlayer(path: string): void {
  const ui = useUi.getState()
  const wasOpen = ui.sidePanelOpen && ui.sidePanelTab === 'artifacts'
  ui.openSidePanel('artifacts')
  const fire = () => window.dispatchEvent(new CustomEvent<OpenArtifactDetail>(OPEN_ARTIFACT_EVENT, { detail: { path } }))
  fire()
  // A panel that was closed mounts on the next render; repeat once so its listener gets the event.
  if (!wasOpen) setTimeout(fire, 120)
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function seconds(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',')
}

export function MotionCard({ entry, busy, onAskFix }: { entry: MotionEntry; busy: boolean; onAskFix(text: string): void }) {
  const invalid = entry.errors.length > 0
  const askFix = () => {
    const list = entry.errors.map((e) => `- ${e}`).join('\n')
    onAskFix(
      `O arquivo ${entry.path} não passou na validação do Hangar Motion:\n${list}\n\nCorrija esse arquivo no lugar, mantendo os ids existentes.`
    )
  }
  return (
    <div className={`${styles.motionCard} ${invalid ? styles.motionInvalid : ''}`}>
      <div className={styles.motionIcon}>🎬</div>
      <div className={styles.motionBody}>
        <div className={styles.motionTitle}>
          Motion: {entry.title ?? basename(entry.path)}
          {!invalid && entry.duration !== undefined && (
            <span className="muted">
              {' '}
              · {seconds(entry.duration)}s · {entry.scenes} {entry.scenes === 1 ? 'cena' : 'cenas'}
            </span>
          )}
        </div>
        <div className={styles.motionPath} title={entry.path}>
          {basename(entry.path)}
        </div>
        {invalid && (
          <ul className={styles.motionErrors}>
            {entry.errors.slice(0, 8).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {entry.errors.length > 8 && <li>… mais {entry.errors.length - 8}</li>}
          </ul>
        )}
      </div>
      <div className={styles.motionActions}>
        <button className={invalid ? 'btn' : 'btn btn-primary'} onClick={() => openInPlayer(entry.path)}>
          Abrir no player
        </button>
        {invalid && (
          <button className="btn btn-primary" disabled={busy} title={busy ? 'Aguarde a rodada atual' : undefined} onClick={askFix}>
            Pedir correção
          </button>
        )}
      </div>
    </div>
  )
}
