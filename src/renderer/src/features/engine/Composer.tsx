import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Effort, PermissionMode, Session } from '@shared/contracts'
import { ENGINE, type EngineOptions, type OutputMode, type SlashCommandInfo } from '@shared/features/engine'
import { bridge } from '../../core/api'
import { useSettings } from '../../core/data'
import { SUBSCRIPTION_PROFILE_ID, type ProviderProfile } from '@shared/providers'
import { ModelPicker, platformApi } from '../platform'
import { blobToImage, type ComposerImage } from './pasted'
import styles from './engine.module.css'

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
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function OptionsBar({
  session,
  busy,
  providers,
  onError
}: {
  session: Session
  busy: boolean
  providers: ProviderProfile[]
  onError(message: string): void
}) {
  const settings = useSettings()
  const providerId = session.providerId || settings?.defaultProviderId || SUBSCRIPTION_PROFILE_ID
  const profile = providers.find((p) => p.id === providerId)
  const model = session.model ?? profile?.models?.default ?? settings?.defaultModel ?? 'opus'
  const effort = session.effort ?? settings?.defaultEffort ?? 'high'
  const mode = session.permissionMode ?? settings?.defaultPermissionMode ?? 'default'

  const apply = (patch: EngineOptions) => void bridge.invoke(ENGINE.setOptions, session.id, patch)
  // One picker for profile + model: another profile ends the Claude Code process and the next message resumes.
  const choose = (choice: { providerId: string; model: string }) =>
    void platformApi
      .chooseModel(session.id, choice)
      .catch((err: unknown) =>
        onError(
          err instanceof Error
            ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
            : String(err)
        )
      )

  return (
    <div className={styles.optionsBar}>
      <ModelPicker
        className={styles.select}
        inputClassName={styles.modelInput}
        profiles={providers}
        value={{ providerId, model }}
        onChange={choose}
        lockProvider={busy}
        allowCustom
        title={
          busy
            ? 'Modelo (pare a geração para trocar de origem: assinatura, modelos de token ou outro perfil)'
            : 'Modelo e origem: trocar de origem mantém o histórico da conversa, mas o cache de prompt recomeça'
        }
      />
      <select
        className={styles.select}
        title="Esforço"
        value={effort}
        onChange={(e) => apply({ effort: e.target.value as Effort })}
      >
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

export interface ComposerDraft {
  text: string
  /** Changes on every new draft so the same text can be restored twice. */
  nonce: number
}

interface Props {
  session: Session
  busy: boolean
  attachments: string[]
  setAttachments(update: (a: string[]) => string[]): void
  images: ComposerImage[]
  setImages(update: (i: ComposerImage[]) => ComposerImage[]): void
  draft?: ComposerDraft
  /** Provider profiles (no secrets), for the "Provedor" selector and the profile's models. */
  providers: ProviderProfile[]
  /** "Saída": 'motion' sends every message with the Motion guide until switched back. */
  output?: OutputMode
  setOutput(mode: OutputMode | undefined): void
  onSend(text: string): Promise<boolean>
  onStop(): void
  onError(message: string): void
}

type Menu = { kind: 'slash'; items: SlashCommandInfo[] } | { kind: 'file'; items: string[]; start: number }

/** `@token` right before the caret, if any. */
function mentionAt(text: string, caret: number): { query: string; start: number } | undefined {
  const m = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret))
  return m ? { query: m[2], start: caret - m[2].length - 1 } : undefined
}

function mentionFor(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

export function Composer(props: Props) {
  const {
    session,
    busy,
    attachments,
    setAttachments,
    images,
    setImages,
    draft,
    providers,
    output,
    setOutput,
    onSend,
    onStop,
    onError
  } = props
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [commands, setCommands] = useState<SlashCommandInfo[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const loadedCommands = useRef(false)

  useEffect(() => area.current?.focus(), [session.id])

  // A rewind hands the removed message back for editing.
  useEffect(() => {
    if (!draft) return
    setText(draft.text)
    setCaret(draft.text.length)
    area.current?.focus()
  }, [draft])

  // Grow with content up to a cap.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  const slashQuery = /^\/(\S*)$/.exec(text)?.[1]
  const mention = slashQuery === undefined ? mentionAt(text, caret) : undefined

  useEffect(() => {
    if (slashQuery === undefined || loadedCommands.current) return
    loadedCommands.current = true
    void bridge.invoke(ENGINE.slashCommands, session.id).then(setCommands, () => (loadedCommands.current = false))
  }, [slashQuery, session.id])

  const mentionQuery = mention?.query
  useEffect(() => {
    if (mentionQuery === undefined) return setFiles([])
    let alive = true
    const timer = setTimeout(() => {
      bridge.invoke(ENGINE.listFiles, session.id, mentionQuery).then(
        (r) => alive && setFiles(r),
        () => alive && setFiles([])
      )
    }, 80)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [mentionQuery, session.id])

  const menu = useMemo<Menu | undefined>(() => {
    if (slashQuery !== undefined) {
      const q = slashQuery.toLowerCase()
      const items = commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 12)
      return items.length ? { kind: 'slash', items } : undefined
    }
    if (mention && files.length) return { kind: 'file', items: files.slice(0, 12), start: mention.start }
    return undefined
  }, [commands, slashQuery, mention?.start, files])
  const menuOpen = !menuClosed && !!menu

  useEffect(() => {
    setMenuIndex(0)
    setMenuClosed(false)
  }, [slashQuery, mentionQuery])

  const pickCommand = (c: SlashCommandInfo) => {
    setText(`/${c.name} `)
    area.current?.focus()
  }

  const pickFile = (path: string, start: number) => {
    const inserted = `${mentionFor(path)} `
    const next = text.slice(0, start) + inserted + text.slice(caret)
    const pos = start + inserted.length
    setText(next)
    setCaret(pos)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(pos, pos)
    })
  }

  const pickCurrent = () => {
    if (!menu) return
    if (menu.kind === 'slash') pickCommand(menu.items[menuIndex])
    else pickFile(menu.items[menuIndex], menu.start)
  }

  const canSend = !!text.trim() || attachments.length > 0 || images.length > 0

  const submit = async () => {
    if (!canSend) return
    const sent = text
    setText('')
    setCaret(0)
    if (!(await onSend(sent))) setText(sent)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && menu) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setMenuIndex((i) => (i + delta + menu.items.length) % menu.items.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pickCurrent()
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

  const addImages = async (blobs: Blob[]) => {
    for (const blob of blobs) {
      try {
        const img = await blobToImage(blob)
        setImages((all) => [...all, img])
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const addFiles = (list: FileList | null) => {
    if (!list) return
    const withPath: string[] = []
    const pathless: Blob[] = []
    for (const f of list) {
      const path = bridge.pathForFile(f)
      if (path) withPath.push(path)
      else if (f.type.startsWith('image/')) pathless.push(f)
    }
    setAttachments((a) => [...a, ...withPath.filter((p) => !a.includes(p))])
    void addImages(pathless)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const list = e.clipboardData.files
    if (!list.length) return
    // Screenshots and copied images come without text; keep normal text pastes untouched.
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault()
    addFiles(list)
  }

  const syncCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart)

  return (
    <div className={styles.composerWrap}>
      {menuOpen && menu?.kind === 'slash' && (
        <div className={styles.slashMenu}>
          {menu.items.map((c, i) => (
            <button
              key={c.name}
              className={`${styles.slashItem} ${i === menuIndex ? styles.slashItemOn : ''}`}
              onMouseEnter={() => setMenuIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pickCommand(c)
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
      {menuOpen && menu?.kind === 'file' && (
        <div className={styles.slashMenu}>
          {menu.items.map((path, i) => {
            const slash = path.lastIndexOf('/')
            return (
              <button
                key={path}
                className={`${styles.slashItem} ${i === menuIndex ? styles.slashItemOn : ''}`}
                onMouseEnter={() => setMenuIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickFile(path, menu.start)
                }}
              >
                <span className={styles.slashName}>{path.slice(slash + 1)}</span>
                <span className={styles.slashDesc}>{slash > 0 ? path.slice(0, slash) : ''}</span>
              </button>
            )
          })}
        </div>
      )}
      <div className={styles.composer}>
        {(images.length > 0 || attachments.length > 0) && (
          <div className={styles.attachments}>
            {images.map((img) => (
              <span key={img.id} className={styles.thumbWrap}>
                <img className={styles.thumb} src={img.url} alt="Imagem colada" />
                <button
                  className={styles.thumbX}
                  title="Remover"
                  onClick={() => setImages((all) => all.filter((x) => x.id !== img.id))}
                >
                  ×
                </button>
              </span>
            ))}
            {attachments.map((a) => (
              <span key={a} className={styles.chip} title={a}>
                📎 {basename(a)}
                <button
                  className={styles.chipX}
                  title="Remover"
                  onClick={() => setAttachments((all) => all.filter((x) => x !== a))}
                >
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
          placeholder={
            busy
              ? 'Enviar outra mensagem (fica na fila)…'
              : output === 'motion'
                ? 'Descreva a animação: assunto, público, duração… (Saída: Motion)'
                : 'Responder ao Claude… (/ comandos, @ arquivos, Ctrl+V cola imagem)'
          }
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
          }}
          onSelect={syncCaret}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
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
          <select
            className={`${styles.select} ${output === 'motion' ? styles.selectMotion : ''}`}
            title="Saída: Motion pede uma animação (*.motion.json) que toca no painel Artifacts"
            value={output ?? 'default'}
            onChange={(e) => setOutput(e.target.value === 'motion' ? 'motion' : undefined)}
          >
            <option value="default">🎬 Saída: Padrão</option>
            <option value="motion">🎬 Saída: Motion</option>
          </select>
          <OptionsBar session={session} busy={busy} providers={providers} onError={onError} />
          <div className={styles.spacer} />
          {busy && (
            <button className={`btn ${styles.stopBtn}`} title="Parar (Esc)" onClick={onStop}>
              ■ Parar
            </button>
          )}
          <button className="btn btn-primary" title="Enviar (Enter)" disabled={!canSend} onClick={() => void submit()}>
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
