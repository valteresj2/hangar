import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import type { GitCommit, GitDiffResult, GitFileChange, GitPrStatus, GitStatus } from '@shared/features/git'
import { api } from '../../core/api'
import { BranchMenu } from './BranchMenu'
import { DiffView, type DiffMode } from './DiffView'
import { errorMessage, gitApi, joinPath, sessionDir, splitPath, useGitChanged } from './gitApi'
import styles from './git.module.css'

type Group = 'staged' | 'unstaged' | 'untracked'

interface Selection {
  group: Group
  path: string
}

const GROUP_LABEL: Record<Group, string> = {
  staged: 'Staged',
  unstaged: 'Alterações',
  untracked: 'Não rastreados'
}

const STATUS_TITLE: Record<string, string> = {
  M: 'Modificado',
  A: 'Adicionado',
  D: 'Excluído',
  R: 'Renomeado',
  C: 'Copiado',
  T: 'Tipo alterado',
  U: 'Conflito',
  '?': 'Não rastreado'
}

const MODE_KEY = 'hangar.git.diffMode'

function readMode(): DiffMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })

function relativeTime(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60]
  ]
  for (const [unit, secs] of steps) if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit)
  return 'agora'
}

/** Paths a git command must receive for a change (renames need both sides). */
function pathsOf(c: GitFileChange): string[] {
  return c.origPath ? [c.origPath, c.path] : [c.path]
}

export function ChangesPanel({ session }: { session: Session }) {
  const cwd = sessionDir(session)
  const [status, setStatus] = useState<GitStatus>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [selected, setSelected] = useState<Selection>()
  const [diff, setDiff] = useState<GitDiffResult>()
  const [mode, setMode] = useState<DiffMode>(readMode)
  const [message, setMessage] = useState('')
  const [view, setView] = useState<'diff' | 'log'>('diff')
  const [log, setLog] = useState<GitCommit[]>([])
  const [pr, setPr] = useState<GitPrStatus>()
  const [collapsed, setCollapsed] = useState<Record<Group, boolean>>({ staged: false, unstaged: false, untracked: false })
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const st = await gitApi.status(cwd)
      if (mine === seq.current) setStatus(st)
    } catch (e) {
      if (mine === seq.current) setError(errorMessage(e))
    }
  }, [cwd])

  useEffect(() => {
    setStatus(undefined)
    setSelected(undefined)
    setDiff(undefined)
    void refresh()
  }, [refresh])
  useGitChanged(cwd, () => void refresh())
  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Keep the selection pointing at a file that still exists, following it across groups.
  const groups: Record<Group, GitFileChange[]> = {
    staged: status?.staged ?? [],
    unstaged: status?.unstaged ?? [],
    untracked: status?.untracked ?? []
  }
  const selectedChange = selected && groups[selected.group].find((c) => c.path === selected.path)
  useEffect(() => {
    if (!status || !selected || selectedChange) return
    const order: Group[] = ['unstaged', 'staged', 'untracked']
    const next = order.find((g) => groups[g].some((c) => c.path === selected.path))
    setSelected(next ? { group: next, path: selected.path } : undefined)
  }, [status])

  useEffect(() => setDiff(undefined), [selected])
  useEffect(() => {
    if (!selectedChange || !selected) return
    let alive = true
    gitApi
      .diff(cwd, {
        path: selectedChange.path,
        origPath: selectedChange.origPath,
        staged: selected.group === 'staged',
        untracked: selected.group === 'untracked'
      })
      .then(
        (d) => alive && setDiff(d),
        (e) => alive && setError(errorMessage(e))
      )
    return () => {
      alive = false
    }
  }, [cwd, selected, selectedChange, status])

  useEffect(() => {
    if (view !== 'log' || !status?.isRepo) return
    gitApi.log(cwd, 50).then(setLog, (e) => setError(errorMessage(e)))
  }, [view, cwd, status])

  useEffect(() => {
    if (!status?.isRepo || !status.branch) return setPr(undefined)
    let alive = true
    gitApi.prStatus(cwd).then((p) => alive && setPr(p), () => undefined)
    return () => {
      alive = false
    }
  }, [cwd, status?.isRepo, status?.branch, status?.ahead])

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(undefined)
      void refresh()
    }
  }

  const stage = (changes: GitFileChange[]) => act('stage', () => gitApi.stage(cwd, changes.flatMap(pathsOf)))
  const unstage = (changes?: GitFileChange[]) => act('unstage', () => gitApi.unstage(cwd, changes?.flatMap(pathsOf)))
  const discard = (changes: GitFileChange[], group: Group) => {
    if (!changes.length) return
    const untracked = group === 'untracked'
    const what = changes.length === 1 ? `"${changes[0].path}"` : `${changes.length} arquivos`
    const ok = window.confirm(
      untracked
        ? `Excluir ${what} do disco? Arquivos não rastreados não podem ser recuperados.`
        : `Descartar as alterações em ${what}? Esta ação não pode ser desfeita.`
    )
    if (ok) void act('discard', () => gitApi.discard(cwd, changes.map((c) => c.path), untracked))
  }

  const commit = () => {
    if (!status || busy) return
    const msg = message.trim()
    if (!msg) return setError('Escreva uma mensagem de commit.')
    const nothingStaged = !status.staged.length
    if (nothingStaged) {
      const pending = status.unstaged.length + status.untracked.length
      if (!pending) return setError('Não há nada para commitar.')
      if (!window.confirm('Nenhuma alteração está staged. Fazer stage de tudo e commitar?')) return
    }
    void act('commit', async () => {
      if (nothingStaged) await gitApi.stage(cwd)
      await gitApi.commit(cwd, msg)
      setMessage('')
      setSelected(undefined)
    })
  }

  const setDiffMode = (m: DiffMode) => {
    setMode(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      // Storage unavailable: keep the in-memory choice.
    }
  }

  if (!status) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>{error ?? 'Carregando…'}</div>
      </div>
    )
  }

  if (!status.isRepo) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>⎇</div>
          <div className={styles.emptyTitle}>Esta pasta não é um repositório git</div>
          <div className="muted">{cwd}</div>
          <div className="muted">Inicialize um repositório (git init) para acompanhar as alterações aqui.</div>
        </div>
      </div>
    )
  }

  const total = status.staged.length + status.unstaged.length + status.untracked.length
  const absPath = (c: GitFileChange) => joinPath(status.root ?? cwd, c.path)

  const renderGroup = (group: Group) => {
    const list = groups[group]
    if (!list.length) return null
    const isCollapsed = collapsed[group]
    return (
      <div key={group} className={styles.group}>
        <div className={styles.groupHeader}>
          <button
            className={styles.groupToggle}
            onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
          >
            <span className={styles.chevron}>{isCollapsed ? '▸' : '▾'}</span>
            {GROUP_LABEL[group]}
            <span className={styles.count}>{list.length}</span>
          </button>
          <div className={styles.groupActions}>
            {group === 'staged' ? (
              <button className={styles.linkBtn} disabled={!!busy} onClick={() => void unstage()}>
                Unstage tudo
              </button>
            ) : (
              <>
                <button className={styles.linkBtn} disabled={!!busy} onClick={() => discard(list, group)}>
                  {group === 'untracked' ? 'Excluir tudo' : 'Descartar tudo'}
                </button>
                <button className={styles.linkBtn} disabled={!!busy} onClick={() => void stage(list)}>
                  Stage tudo
                </button>
              </>
            )}
          </div>
        </div>
        {!isCollapsed &&
          list.map((c) => {
            const { name, dir } = splitPath(c.path)
            const active = selected?.group === group && selected.path === c.path
            return (
              <div
                key={c.path}
                className={`${styles.fileRow} ${active ? styles.fileRowActive : ''}`}
                onClick={() => {
                  setSelected({ group, path: c.path })
                  setView('diff')
                }}
                onDoubleClick={() => void gitApi.openInEditor(absPath(c)).catch((e) => setError(errorMessage(e)))}
                title={c.origPath ? `${c.origPath} → ${c.path}` : c.path}
              >
                <span className={styles.fileName}>{name}</span>
                <span className={styles.fileDir}>{c.origPath ? `${c.origPath} →` : dir}</span>
                <span className={styles.rowActions}>
                  {group !== 'staged' && (
                    <button
                      className={styles.miniBtn}
                      title={group === 'untracked' ? 'Excluir arquivo' : 'Descartar alterações'}
                      disabled={!!busy}
                      onClick={(e) => {
                        e.stopPropagation()
                        discard([c], group)
                      }}
                    >
                      ↺
                    </button>
                  )}
                  <button
                    className={styles.miniBtn}
                    title={group === 'staged' ? 'Unstage' : 'Stage'}
                    disabled={!!busy}
                    onClick={(e) => {
                      e.stopPropagation()
                      void (group === 'staged' ? unstage([c]) : stage([c]))
                    }}
                  >
                    {group === 'staged' ? '−' : '+'}
                  </button>
                </span>
                <span className={`${styles.badge} ${styles[`st${c.status === '?' ? 'Q' : c.status}`] ?? ''}`} title={STATUS_TITLE[c.status]}>
                  {c.status === '?' ? 'U' : c.status === 'U' ? '!' : c.status}
                </span>
              </div>
            )
          })}
      </div>
    )
  }

  const canPush = !!status.branch && (!status.upstream || status.ahead > 0)

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <BranchMenu
          cwd={cwd}
          current={status.branch}
          detachedLabel={status.detached ? `HEAD ${status.head ?? ''}` : undefined}
          disabled={!!busy}
          onError={setError}
        />
        {status.upstream && (
          <span className={styles.aheadBehind} title={`Upstream: ${status.upstream}`}>
            ↑{status.ahead} ↓{status.behind}
          </span>
        )}
        <div className={styles.spacer} />
        {pr?.number && (
          <button
            className={styles.prChip}
            title={pr.title}
            onClick={() => pr.url && void api.openExternal(pr.url)}
          >
            PR #{pr.number} · {pr.isDraft ? 'rascunho' : (pr.state ?? '').toLowerCase()}
          </button>
        )}
        <button
          className={`icon-btn ${view === 'log' ? styles.iconActive : ''}`}
          title="Histórico de commits"
          onClick={() => setView((v) => (v === 'log' ? 'diff' : 'log'))}
        >
          ☰
        </button>
        <button className="icon-btn" title="Atualizar" onClick={() => void refresh()}>
          ⟳
        </button>
        <button
          className="btn"
          disabled={!canPush || !!busy}
          title={status.upstream ? `Enviar para ${status.upstream}` : 'Publicar branch no remote'}
          onClick={() => void act('push', () => gitApi.push(cwd))}
        >
          {busy === 'push' ? 'Enviando…' : status.upstream ? 'Push' : 'Publicar'}
        </button>
      </div>

      {error && (
        <div className={styles.errorBar}>
          <span className={styles.errorText}>{error}</span>
          <button className={styles.miniBtn} title="Fechar" onClick={() => setError(undefined)}>
            ×
          </button>
        </div>
      )}

      <div className={styles.commitBox}>
        <textarea
          className={`input ${styles.commitInput}`}
          placeholder={`Mensagem de commit (Ctrl+Enter para commitar em ${status.branch ?? 'HEAD'})`}
          value={message}
          rows={2}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              commit()
            }
          }}
        />
        <button className="btn btn-primary" disabled={!!busy || !message.trim() || !total} onClick={commit}>
          {busy === 'commit' ? 'Commitando…' : status.staged.length ? `Commit (${status.staged.length})` : 'Commit'}
        </button>
      </div>

      <div className={styles.fileList}>
        {total === 0 ? (
          <div className={styles.cleanState}>✓ Nenhuma alteração — a árvore de trabalho está limpa.</div>
        ) : (
          (['staged', 'unstaged', 'untracked'] as Group[]).map(renderGroup)
        )}
        {status.truncated && <div className={styles.notice}>Lista truncada: muitos arquivos alterados.</div>}
      </div>

      <div className={styles.diffArea}>
        {view === 'log' ? (
          <div className={styles.logList}>
            {log.length === 0 && <div className={styles.empty}>Nenhum commit ainda.</div>}
            {log.map((c) => (
              <div key={c.hash} className={styles.logRow} title={`${c.hash}\n${c.author} <${c.email}>`}>
                <code className={styles.logHash}>{c.short}</code>
                <span className={styles.logSubject}>{c.subject}</span>
                <span className={styles.logMeta}>
                  {c.author} · {relativeTime(c.date)}
                </span>
              </div>
            ))}
          </div>
        ) : selectedChange && selected ? (
          <>
            <div className={styles.diffToolbar}>
              <span className={styles.diffPath} title={selectedChange.path}>
                {selectedChange.path}
                <span className="muted"> · {selected.group === 'staged' ? 'staged' : selected.group === 'untracked' ? 'novo' : 'working tree'}</span>
              </span>
              <div className={styles.segmented}>
                <button className={mode === 'unified' ? styles.segActive : ''} onClick={() => setDiffMode('unified')}>
                  Unificado
                </button>
                <button className={mode === 'split' ? styles.segActive : ''} onClick={() => setDiffMode('split')}>
                  Lado a lado
                </button>
              </div>
              <button
                className="icon-btn"
                title="Abrir no editor"
                onClick={() => void gitApi.openInEditor(absPath(selectedChange)).catch((e) => setError(errorMessage(e)))}
              >
                ↗
              </button>
            </div>
            {!diff ? (
              <div className={styles.empty}>Carregando diff…</div>
            ) : diff.truncated ? (
              <div className={styles.empty}>Diff grande demais para exibir.</div>
            ) : diff.binary ? (
              <div className={styles.empty}>Arquivo binário — sem diff de texto.</div>
            ) : (
              <DiffView text={diff.text} mode={mode} />
            )}
          </>
        ) : (
          <div className={styles.empty}>{total ? 'Selecione um arquivo para ver o diff.' : ''}</div>
        )}
      </div>
    </div>
  )
}
