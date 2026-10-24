import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '@shared/contracts'
import { SETTINGS, type QuickEntryStatus } from '@shared/features/settings'
import { api, bridge } from '../../../core/api'
import { formatAccelerator, recordKey, shortcutRecorder } from '../accelerator'
import { errorText, settingsApi } from '../api'
import { Card, Dot, Row, Switch } from '../ui'
import styles from '../settings.module.css'

function useQuickEntryStatus(): QuickEntryStatus | undefined {
  const [status, setStatus] = useState<QuickEntryStatus>()
  useEffect(() => {
    let alive = true
    void settingsApi.quickEntryStatus().then((s) => alive && setStatus(s))
    const off = bridge.on(SETTINGS.quickEntryStatusChanged, (s: QuickEntryStatus) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

function ShortcutRecorder({ value, onChange }: { value: string; onChange: (accelerator: string) => void }) {
  const [recording, setRecording] = useState(false)
  const [preview, setPreview] = useState('')
  const [hint, setHint] = useState<string>()
  // Read through a ref so a parent re-render doesn't restart the recording effect.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!recording) return
    shortcutRecorder.active = true
    // Release the current global shortcut so pressing it is captured here instead of opening Quick Entry.
    void settingsApi.quickEntrySuspend(true)
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return setRecording(false)
      const res = recordKey(e)
      if (res.kind === 'partial') {
        setPreview(res.preview)
        setHint(undefined)
      } else if (res.kind === 'invalid') {
        setHint(res.reason)
      } else {
        onChangeRef.current(res.accelerator)
        setRecording(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      shortcutRecorder.active = false
      setPreview('')
      setHint(undefined)
      void settingsApi.quickEntrySuspend(false)
    }
  }, [recording])

  return (
    <span className={styles.inline}>
      <button
        className={`btn ${recording ? styles.recording : ''}`}
        style={{ minWidth: 180, justifyContent: 'center' }}
        title="Clique e pressione a combinação de teclas"
        onClick={() => setRecording((r) => !r)}
      >
        {recording ? preview || 'Pressione o atalho…' : formatAccelerator(value) || 'Desligado'}
      </button>
      {recording && <span className={styles.hint}>{hint ?? 'Esc cancela'}</span>}
    </span>
  )
}

/** Settings → Geral: tray behaviour and the Quick Entry shortcut. */
export function TrayQuickEntryCard({ settings }: { settings: Settings }) {
  const status = useQuickEntryStatus()
  const [error, setError] = useState<string>()
  const patch = (p: Partial<Settings>) => {
    setError(undefined)
    api.patchSettings(p).catch((err) => setError(errorText(err)))
  }
  const enabled = !!settings.quickEntryShortcut

  return (
    <Card title="Bandeja e Quick Entry">
      <Row
        label="Minimizar para a bandeja ao fechar"
        hint="Fechar a janela deixa o Hangar rodando na bandeja (notificações e tarefas agendadas continuam). Use “Sair” no menu do ícone para encerrar."
      >
        <Switch label="Minimizar para a bandeja" checked={settings.minimizeToTray} onChange={(minimizeToTray) => patch({ minimizeToTray })} />
      </Row>
      <Row
        label="Quick Entry"
        hint={
          status?.error ? (
            <span className={styles.errorText}>{status.error}</span>
          ) : status?.registered ? (
            <span className={styles.inline}>
              <Dot tone="ok" /> Ativo: {formatAccelerator(status.accelerator)} abre uma caixa para começar uma sessão de qualquer lugar.
            </span>
          ) : (
            'Atalho global que abre uma caixa para começar uma sessão de qualquer lugar.'
          )
        }
      >
        {enabled && <ShortcutRecorder value={settings.quickEntryShortcut} onChange={(quickEntryShortcut) => patch({ quickEntryShortcut })} />}
        <Switch
          label="Quick Entry"
          checked={enabled}
          onChange={(on) => patch({ quickEntryShortcut: on ? DEFAULT_SETTINGS.quickEntryShortcut : '' })}
        />
      </Row>
      {error && <div className={`${styles.row} ${styles.errorText}`}>{error}</div>}
    </Card>
  )
}
