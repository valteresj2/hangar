// Harness component browser + editor. Two modes:
//   'save' — drafts with an unsaved state, persisted with Salvar / Ctrl+S (the side panel, on disk);
//   'live' — every keystroke goes to onSave (HarnessTreeEditor, an in-memory tree for the lab).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { componentOf, isHarnessPath, type HarnessComponentKind, type HarnessTree } from '@shared/harness'
import {
  ALWAYS_ON_FILES,
  ALWAYS_ON_WARN_CHARS,
  COMPONENT_LABELS,
  NAMED_TEMPLATES,
  TEMPLATE_LABELS,
  validTemplateName,
  type HarnessState,
  type TemplateKind
} from '@shared/features/harness'
import { errorText } from './api'
import { Confirm, ErrorLine } from './ui'
import styles from './harness.module.css'

const KIND_ORDER: HarnessComponentKind[] = ['instructions', 'skill', 'subagent', 'command', 'settings', 'script']

const NAME_HINTS: Partial<Record<TemplateKind, string>> = {
  skill: 'nome-da-skill',
  subagent: 'nome-do-subagente',
  command: 'nome (ou pasta/nome)',
  script: 'arquivo.sh, .ps1 ou .py'
}

export interface ComponentsEditorProps {
  tree: HarnessTree
  mode: 'save' | 'live'
  readOnly?: boolean
  skipped?: HarnessState['skipped']
  onSave(rel: string, content: string): Promise<void> | void
  onDelete(rel: string): Promise<void> | void
  /** Creates the template's files; returns the created paths. */
  onCreate(kind: TemplateKind, name: string): Promise<string[]> | string[]
  /** Extra controls shown at the right of the toolbar. */
  toolbar?: ReactNode
  /** Path to select initially. */
  initialPath?: string
}

/** Display name of a file inside its group. */
function itemLabel(rel: string): string {
  const c = componentOf(rel)
  if (!c) return rel
  switch (c.kind) {
    case 'skill':
      return rel.slice(`.claude/skills/`.length)
    case 'subagent':
      return c.name
    case 'command':
    case 'script':
      return c.name
    default:
      return rel
  }
}

function charsLabel(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} mil` : String(n)
}

export function ComponentsEditor(props: ComponentsEditorProps) {
  const { tree, mode, readOnly } = props
  const [selected, setSelected] = useState<string | undefined>(props.initialPath)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState<{ kind: TemplateKind | 'path'; name: string }>()
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)

  const paths = useMemo(() => Object.keys(tree).sort(), [tree])

  // Pick something sensible to show, and drop drafts that now match the file on disk.
  useEffect(() => {
    if (selected && !(selected in tree) && !(selected in drafts)) setSelected(undefined)
    if (!selected && paths.length) setSelected(paths.find((p) => p === 'CLAUDE.md') ?? paths[0])
    setDrafts((d) => {
      const next = Object.fromEntries(Object.entries(d).filter(([p, v]) => tree[p] !== v))
      return Object.keys(next).length === Object.keys(d).length ? d : next
    })
  }, [tree])

  const groups = useMemo(() => {
    const byKind = new Map<HarnessComponentKind, string[]>()
    for (const p of paths) {
      const kind = componentOf(p)?.kind
      if (!kind) continue
      byKind.set(kind, [...(byKind.get(kind) ?? []), p])
    }
    return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({ kind: k, paths: byKind.get(k)! }))
  }, [paths])

  const effective = (p: string) => drafts[p] ?? tree[p] ?? ''
  const alwaysOn = ALWAYS_ON_FILES.reduce((n, f) => n + (f in tree || f in drafts ? effective(f).length : 0), 0)
  const dirty = selected !== undefined && selected in drafts && drafts[selected] !== tree[selected]
  const content = selected !== undefined ? effective(selected) : ''

  const save = async (rel = selected) => {
    if (!rel || readOnly || mode !== 'save' || !(rel in drafts)) return
    setSaving(true)
    try {
      await props.onSave(rel, drafts[rel])
      setDrafts((d) => {
        const next = { ...d }
        delete next[rel]
        return next
      })
    } catch (err) {
      setError(`Não foi possível salvar: ${errorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const edit = (value: string) => {
    if (!selected || readOnly) return
    if (mode === 'live') void props.onSave(selected, value)
    else setDrafts((d) => ({ ...d, [selected]: value }))
  }

  const create = async () => {
    if (!creating) return
    const name = creating.name.trim()
    try {
      if (creating.kind === 'path') {
        const rel = name.replace(/\\/g, '/')
        if (!isHarnessPath(rel)) throw new Error('Esse caminho não faz parte do harness (veja os tipos aceitos).')
        if (rel in tree) throw new Error(`Já existe: ${rel}`)
        await props.onSave(rel, '')
        setSelected(rel)
      } else {
        if (NAMED_TEMPLATES.includes(creating.kind) && !validTemplateName(creating.kind, name)) {
          throw new Error('Nome inválido: use letras, números, ponto, hífen ou sublinhado.')
        }
        const created = await props.onCreate(creating.kind, name)
        if (created[0]) setSelected(created[0])
      }
      setCreating(undefined)
      setError(undefined)
      setTimeout(() => textRef.current?.focus(), 50)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const kindsAvailable = (Object.keys(TEMPLATE_LABELS) as TemplateKind[]).filter((k) => {
    if (k === 'instructions') return !('CLAUDE.md' in tree)
    if (k === 'local-instructions') return !('.claude/CLAUDE.md' in tree)
    if (k === 'settings') return !('.claude/settings.json' in tree)
    return true
  })

  return (
    <div
      className={styles.components}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          void save()
        }
      }}
    >
      <div className={styles.toolbar}>
        {!readOnly && (
          <select
            className={`input ${styles.selectInline}`}
            value=""
            title="Criar a partir de um modelo"
            onChange={(e) => {
              const kind = e.target.value as TemplateKind | 'path'
              if (!kind) return
              if (kind !== 'path' && !NAMED_TEMPLATES.includes(kind))
                void Promise.resolve(props.onCreate(kind, ''))
                  .then((c) => c[0] && setSelected(c[0]))
                  .catch((err) => setError(errorText(err)))
              else setCreating({ kind, name: '' })
            }}
          >
            <option value="">+ Novo…</option>
            {kindsAvailable.map((k) => (
              <option key={k} value={k}>
                {TEMPLATE_LABELS[k]}
              </option>
            ))}
            <option value="path">Arquivo por caminho…</option>
          </select>
        )}
        <span
          className={`${styles.alwaysOn} ${alwaysOn > ALWAYS_ON_WARN_CHARS ? styles.alwaysOnWarn : ''}`}
          title="CLAUDE.md e .claude/CLAUDE.md entram no contexto de TODA sessão. Texto aqui custa em cada rodada; prefira skills para procedimentos longos."
        >
          Sempre carregado: {charsLabel(alwaysOn)} caracteres (~{charsLabel(Math.round(alwaysOn / 4))} tokens)
        </span>
        <div className={styles.spacer} />
        {props.toolbar}
      </div>

      {creating && (
        <div className={styles.createRow}>
          <span className="muted">{creating.kind === 'path' ? 'Caminho' : TEMPLATE_LABELS[creating.kind]}:</span>
          <input
            className="input"
            autoFocus
            placeholder={
              creating.kind === 'path' ? '.claude/skills/minha-skill/referencia.md' : NAME_HINTS[creating.kind]
            }
            value={creating.name}
            onChange={(e) => setCreating({ ...creating, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
              else if (e.key === 'Escape') setCreating(undefined)
            }}
          />
          <button className="btn btn-primary" disabled={!creating.name.trim()} onClick={() => void create()}>
            Criar
          </button>
          <button className="btn" onClick={() => setCreating(undefined)}>
            Cancelar
          </button>
        </div>
      )}
      <ErrorLine text={error} onClose={() => setError(undefined)} />

      <div className={styles.split}>
        <nav className={styles.fileList}>
          {groups.length === 0 && (
            <div className={styles.empty}>
              Nenhum componente de harness ainda.
              {!readOnly && <> Use “+ Novo…” para criar um CLAUDE.md, uma skill ou um subagente.</>}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.kind} className={styles.group}>
              <div className={styles.groupTitle}>
                {COMPONENT_LABELS[g.kind]} <span className={styles.count}>{g.paths.length}</span>
              </div>
              {g.paths.map((p) => (
                <button
                  key={p}
                  className={`${styles.fileItem} ${p === selected ? styles.fileItemActive : ''}`}
                  title={p}
                  onClick={() => setSelected(p)}
                >
                  <span className={styles.fileName}>{itemLabel(p)}</span>
                  {p in drafts && drafts[p] !== tree[p] && <span className={styles.dirtyDot} title="Não salvo" />}
                </button>
              ))}
            </div>
          ))}
          {props.skipped && props.skipped.length > 0 && (
            <div
              className={styles.skipped}
              title={props.skipped
                .map((s) => `${s.path} (${s.reason === 'large' ? '> 256 KB' : 'binário'})`)
                .join('\n')}
            >
              {props.skipped.length} arquivo{props.skipped.length > 1 ? 's' : ''} não exibido
              {props.skipped.length > 1 ? 's' : ''} (binário ou &gt; 256 KB)
            </div>
          )}
        </nav>

        <section className={styles.editor}>
          {selected !== undefined ? (
            <>
              <div className={styles.editorHead}>
                <code className={styles.editorPath} title={selected}>
                  {selected}
                </code>
                {dirty && <span className={styles.unsaved}>não salvo</span>}
                <div className={styles.spacer} />
                {!readOnly && mode === 'save' && (
                  <button
                    className="btn btn-primary"
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                    title="Salvar (Ctrl+S)"
                  >
                    {saving ? 'Salvando…' : 'Salvar'}
                  </button>
                )}
                {!readOnly && (
                  <button className="btn" onClick={() => setConfirmDelete(selected)} title="Excluir arquivo">
                    Excluir
                  </button>
                )}
              </div>
              <textarea
                ref={textRef}
                className={styles.code}
                spellCheck={false}
                readOnly={readOnly}
                value={content}
                onChange={(e) => edit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Tab' && !e.shiftKey && !readOnly) {
                    e.preventDefault()
                    const el = e.currentTarget
                    const { selectionStart: s, selectionEnd: end } = el
                    const value = `${el.value.slice(0, s)}  ${el.value.slice(end)}`
                    edit(value)
                    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
                  }
                }}
              />
            </>
          ) : (
            <div className={styles.empty}>Selecione um arquivo.</div>
          )}
        </section>
      </div>

      {confirmDelete && (
        <Confirm
          title="Excluir arquivo de harness"
          message={
            <>
              Excluir <code>{confirmDelete}</code>?{mode === 'save' ? ' O arquivo é apagado do disco.' : ''}
            </>
          }
          confirm="Excluir"
          danger
          onConfirm={async () => {
            try {
              await props.onDelete(confirmDelete)
              setDrafts((d) => {
                const next = { ...d }
                delete next[confirmDelete]
                return next
              })
              if (selected === confirmDelete) setSelected(undefined)
            } catch (err) {
              setError(`Não foi possível excluir: ${errorText(err)}`)
            }
          }}
          onClose={() => setConfirmDelete(undefined)}
        />
      )}
    </div>
  )
}
