import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Effort, PermissionMode, Session } from '@shared/contracts'
import { ENGINE, type EngineOptions, type SlashCommandInfo } from '@shared/features/engine'
import { bridge } from '../../core/api'
import { useSettings } from '../../core/data'
import styles from './engine.module.css'

const MODELS = ['opus', 'sonnet', 'haiku', 'fable']
const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'Baixo' },
  { value: 'medium', label: 'Médio' },
  { value: 'high', label: 'Alto' },
  { value: 'xhigh', label: 'Muito alto' },
  { value: 'max', label: 'Máximo' }
]
const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Perguntar' },
  { value: 'acceptEdits', label: 'Aceitar edições' },
  { value: 'plan', label: 'Planejar' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Ignorar permissões' }
]
const CUSTOM = '\u0000custom'

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function OptionsBar({ session }: { session: Session }) {
  const settings = useSettings()
  const model = session.model ?? settings?.defaultModel ?? 'opus'
  const effort = session.effort ?? settings?.defaultEffort ?? 'high'
  const mode = session.permissionMode ?? settings?.defaultPermissionMode ?? 'default'
  const [customModel, setCustomModel] = useState<string | undefined>(MODELS.includes(model) ? undefined : model)

  const apply = (patch: EngineOptions) => void bridge.invoke(ENGINE.setOptions, session.id, patch)

  return (
    <div className={styles.optionsBar}>
      {customModel !== undefined ? (
        <input
          className={styles.modelInput}
          value={customModel}
          placeholder="id do modelo"
          title="Modelo (Enter aplica, Esc volta)"
          onChange={(e) => setCustomModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customModel.trim()) apply({ model: customModel.trim() })
            if (e.key === 'Escape') setCustomModel(undefined)
          }}
          onBlur={() => customModel.trim() && customModel.trim() !== model && apply({ model: customModel.trim() })}
        />
      ) : (
        <select
          className={styles.select}
          title="Modelo"
          value={model}
          onChange={(e) => (e.target.value === CUSTOM ? setCustomModel('') : apply({ model: e.target.value }))}
        >
          {!MODELS.includes(model) && <option value={model}>{model}</option>}
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m[0].toUpperCase() + m.slice(1)}
            </option>
          ))}
          <option value={CUSTOM}>Outro…</option>
        </select>
      )}
      <select className={styles.select} title="Esforço" value={effort} onChange={(e) => apply({ effort: e.target.value as Effort })}>
        {EFFORTS.map((o) => (
          <option key={o.value} value={o.value}>
            Esforço: {o.label}
          </option>
        ))}
      </select>
      <select
        className={`${styles.select} ${mode === 'bypassPermissions' ? styles.selectDanger : ''}`}
        title="Modo de permissão"
        value={mode}
        onChange={(e) => apply({ permissionMode: e.target.value as PermissionMode })}
      >
        {MODES.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <label className={styles.toggle} title="Fast mode">
        <input type="checkbox" checked={!!session.fastMode} onChange={(e) => apply({ fastMode: e.target.checked })} />
        Rápido
      </label>
    </div>
  )
}

interface Props {
  session: Session
  busy: boolean
  attachments: string[]
  setAttachments(update: (a: string[]) => string[]): void
  onSend(text: string): Promise<boolean>
  onStop(): void
}

export function Composer({ session, busy, attachments, setAttachments, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const [commands, setCommands] = useState<SlashCommandInfo[]>([])
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const loadedCommands = useRef(false)

  useEffect(() => area.current?.focus(), [session.id])

  // Grow with content up to a cap.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  const slashQuery = /^\/(\S*)$/.exec(text)?.[1]
  useEffect(() => {
    if (slashQuery === undefined || loadedCommands.current) return
    loadedCommands.current = true
    void bridge.invoke<SlashCommandInfo[]>(ENGINE.slashCommands, session.id).then(setCommands, () => (loadedCommands.current = false))
  }, [slashQuery, session.id])

  const matches = useMemo(() => {
    if (slashQuery === undefined) return []
    const q = slashQuery.toLowerCase()
    return commands
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
      .slice(0, 12)
  }, [commands, slashQuery])
  const menuOpen = !menuClosed && matches.length > 0

  useEffect(() => {
    setMenuIndex(0)
    setMenuClosed(false)
  }, [slashQuery])

  const pick = (c: SlashCommandInfo) => {
    setText(`/${c.name} `)
    area.current?.focus()
  }

  const submit = async () => {
    if (!text.trim() && attachments.length === 0) return
    const sent = text
    setText('')
    if (!(await onSend(sent))) setText(sent)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setMenuIndex((i) => (i + delta + matches.length) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pick(matches[menuIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuClosed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape' && busy) {
      onStop()
    }
  }

  const addFiles = (files: FileList | null) => {
    if (!files) return
    const paths = [...files].map((f) => bridge.pathForFile(f)).filter(Boolean)
    setAttachments((a) => [...a, ...paths.filter((p) => !a.includes(p))])
  }

  return (
    <div className={styles.composerWrap}>
      {menuOpen && (
        <div className={styles.slashMenu}>
          {matches.map((c, i) => (
            <button
              key={c.name}
              className={`${styles.slashItem} ${i === menuIndex ? styles.slashItemOn : ''}`}
              onMouseEnter={() => setMenuIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(c)
              }}
            >
              <span className={styles.slashName}>
                /{c.name}
                {c.argumentHint ? <span className="muted"> {c.argumentHint}</span> : null}
              </span>
              <span className={styles.slashDesc}>{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className={styles.composer}>
        {attachments.length > 0 && (
          <div className={styles.attachments}>
            {attachments.map((a) => (
              <span key={a} className={styles.chip} title={a}>
                📎 {basename(a)}
                <button className={styles.chipX} title="Remover" onClick={() => setAttachments((all) => all.filter((x) => x !== a))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          className={styles.textarea}
          rows={1}
          value={text}
          placeholder={busy ? 'Enviar outra mensagem (fica na fila)…' : 'Responder ao Claude… (/ para comandos)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={styles.composerBar}>
          <button className="icon-btn" title="Anexar arquivos" onClick={() => fileInput.current?.click()}>
            📎
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <OptionsBar session={session} />
          <div className={styles.spacer} />
          {busy && (
            <button className={`btn ${styles.stopBtn}`} title="Parar (Esc)" onClick={onStop}>
              ■ Parar
            </button>
          )}
          <button
            className="btn btn-primary"
            title="Enviar (Enter)"
            disabled={!text.trim() && attachments.length === 0}
            onClick={() => void submit()}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
