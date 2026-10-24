import { useCallback, useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import { ChangesPanel, FilesPanel } from '../features/git'
import { ArtifactsPanel, BrowserPanel } from '../features/preview'
import { HarnessPanel } from '../features/harness'
import { TerminalPanel } from '../features/terminal'
import { useUi } from '../core/ui'
import styles from './shell.module.css'

export function SidePanel({ session }: { session: Session }) {
  const tab = useUi((s) => s.sidePanelTab)
  const [width, setWidth] = useState(560)
  const dragging = useRef(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true
      const startX = e.clientX
      const startW = width
      const move = (ev: PointerEvent) => {
        if (dragging.current) setWidth(Math.min(Math.max(startW + (startX - ev.clientX), 320), window.innerWidth - 420))
      }
      const up = () => {
        dragging.current = false
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [width]
  )

  return (
    <section className={styles.sidePanel} style={{ width }}>
      <div className={styles.resizer} onPointerDown={onPointerDown} />
      {/* Terminal stays mounted so shells survive tab switches. */}
      <div className={styles.sideContent} hidden={tab !== 'terminal'}>
        <TerminalPanel session={session} />
      </div>
      {tab === 'changes' && <ChangesPanel session={session} />}
      {tab === 'files' && <FilesPanel session={session} />}
      <div className={styles.sideContent} hidden={tab !== 'browser'}>
        <BrowserPanel session={session} />
      </div>
      {tab === 'artifacts' && <ArtifactsPanel session={session} />}
      {tab === 'harness' && <HarnessPanel session={session} />}
    </section>
  )
}
