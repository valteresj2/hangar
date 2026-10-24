import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import type { FileContent, FileEntry } from '@shared/features/git'
import { errorMessage, gitApi, sessionDir, useGitChanged } from './gitApi'
import { highlight } from './highlight'
import styles from './git.module.css'

const ICONS: [RegExp, string, string][] = [
  [/\.(tsx?|mts|cts)$/i, 'TS', '#3178c6'],
  [/\.(jsx?|mjs|cjs)$/i, 'JS', '#c9a400'],
  [/\.(json|jsonc|lock)$/i, '{}', '#a07a3a'],
  [/\.(md|mdx|rst)$/i, 'MD', '#4a7ab0'],
  [/\.(txt|log|csv)$/i, '≡', '#6b6a66'],
  [/\.(css|scss|sass|less)$/i, '#', '#7c4dbd'],
  [/\.(html?|xml|svg|vue|svelte)$/i, '<>', '#d1572b'],
  [/\.(py|pyi|ipynb)$/i, 'PY', '#3b7bbf'],
  [/\.(rs|go|java|kt|cs|c|cpp|h|hpp|rb|php|swift)$/i, '{ }', '#5a8f5a'],
  [/\.(sh|bash|ps1|psm1|bat|cmd)$/i, '$', '#4a7a4a'],
  [/\.(ya?ml|toml|ini|env|conf)$/i, '⚙', '#7a7a7a'],
  [/\.(png|jpe?g|gif|webp|ico|bmp|avif)$/i, '▣', '#b0569a'],
  [/\.(zip|gz|tar|7z|rar|exe|dll|bin|pdf)$/i, '■', '#8a8a8a']
]

function FileIcon({ entry, open }: { entry: Pick<FileEntry, 'name' | 'isDir'>; open?: boolean }) {
  if (entry.isDir) return <span className={styles.ficon}>{open ? '📂' : '📁'}</span>
  const hit = ICONS.find(([re]) => re.test(entry.name))
  return (
    <span className={`${styles.ficon} ${styles.ficonText}`} style={{ color: hit?.[2] }}>
      {hit?.[1] ?? '·'}
    </span>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

interface TreeProps {
  dir: string
  depth: number
  tree: Record<string, FileEntry[] | undefined>
  expanded: Set<string>
  showIgnored: boolean
  selected?: string
  onToggle(entry: FileEntry): void
  onOpen(entry: FileEntry): void
}

function Tree({ dir, depth, tree, expanded, showIgnored, selected, onToggle, onOpen }: TreeProps) {
  const entries = tree[dir]
  if (!entries) return <div className={styles.treeLoading} style={{ paddingLeft: 8 + depth * 14 }}>…</div>
  const visible = showIgnored ? entries : entries.filter((e) => !e.ignored)
  if (!visible.length && depth > 0) {
    return (
      <div className={styles.treeLoading} style={{ paddingLeft: 8 + depth * 14 }}>
        vazio
      </div>
    )
  }
  return (
    <>
      {visible.map((e) => {
        const isOpen = e.isDir && expanded.has(e.path)
        return (
          <div key={e.path}>
            <div
              className={`${styles.treeRow} ${selected === e.path ? styles.fileRowActive : ''} ${e.ignored ? styles.ignored : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => (e.isDir ? onToggle(e) : onOpen(e))}
              title={e.path}
            >
              <span className={styles.chevron}>{e.isDir ? (isOpen ? '▾' : '▸') : ''}</span>
              <FileIcon entry={e} open={isOpen} />
              <span className={styles.ellipsis}>{e.name}</span>
            </div>
            {isOpen && (
              <Tree
                dir={e.path}
                depth={depth + 1}
                tree={tree}
                expanded={expanded}
                showIgnored={showIgnored}
                selected={selected}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

function FileViewer({ path, rev, onError }: { path: string; rev: number; onError(msg: string): void }) {
  const [file, setFile] = useState<FileContent>()
  const [html, setHtml] = useState<string>()
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    let alive = true
    gitApi.read(path).then(
      async (f) => {
        if (!alive) return
        setFile(f)
        const code = f.text?.replace(/\r?\n$/, '')
        const out = code !== undefined ? await highlight(code, baseName(path)).catch(() => undefined) : undefined
        if (alive) setHtml(out)
      },
      (e) => alive && onError(errorMessage(e))
    )
    return () => {
      alive = false
    }
  }, [path, onError])

  // Mounted per path (keyed by the parent); `rev` reloads in place when the file changes on disk.
  useEffect(() => {
    void load()
  }, [load, rev])

  const copyPath = () => {
    void navigator.clipboard.writeText(path).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  const lines = file?.text?.replace(/\r\n/g, '\n').split('\n')
  if (lines && lines[lines.length - 1] === '') lines.pop()

  return (
    <div className={styles.viewer}>
      <div className={styles.diffToolbar}>
        <span className={styles.diffPath} title={path}>
          {baseName(path)}
          {file && <span className="muted"> · {formatSize(file.size)}</span>}
        </span>
        <button className="btn" onClick={copyPath}>
          {copied ? 'Copiado!' : 'Copiar caminho'}
        </button>
        <button className="btn" onClick={() => void gitApi.openInEditor(path).catch((e) => onError(errorMessage(e)))}>
          Abrir no editor
        </button>
      </div>
      {!file ? (
        <div className={styles.empty}>Carregando…</div>
      ) : file.binary ? (
        <div className={styles.empty}>Arquivo binário ({formatSize(file.size)}) — use "Abrir no editor".</div>
      ) : (
        <div className={styles.codeScroll}>
          {html ? (
            <div className={styles.shiki} dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className={`${styles.shiki} ${styles.plain}`}>
              <code>
                {lines?.map((l, i) => (
                  <Fragment key={i}>
                    <span className="line">{l}</span>
                    {'\n'}
                  </Fragment>
                ))}
              </code>
            </pre>
          )}
          {file.truncated && <div className={styles.notice}>Arquivo grande: exibindo só o primeiro 1 MB.</div>}
        </div>
      )}
    </div>
  )
}

export function FilesPanel({ session }: { session: Session }) {
  const root = sessionDir(session)
  const [children, setChildren] = useState<Record<string, FileEntry[] | undefined>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string>()
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<FileEntry[]>()
  const [showIgnored, setShowIgnored] = useState(false)
  const [error, setError] = useState<string>()
  const [rev, setRev] = useState(0)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const loadDir = useCallback(async (dir: string) => {
    try {
      const list = await gitApi.listDir(dir)
      setChildren((c) => ({ ...c, [dir]: list }))
    } catch (e) {
      setChildren((c) => ({ ...c, [dir]: [] }))
      setError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    setChildren({})
    setExpanded(new Set())
    setSelected(undefined)
    setFilter('')
    void loadDir(root)
  }, [root, loadDir])

  // Reload the root and every open folder when files change on disk.
  useGitChanged(root, () => {
    void loadDir(root)
    for (const dir of expandedRef.current) void loadDir(dir)
    setRev((r) => r + 1)
  })

  useEffect(() => {
    const q = filter.trim()
    if (!q) return setResults(undefined)
    let alive = true
    const t = setTimeout(() => {
      gitApi.find(root, q).then(
        (r) => alive && setResults(r),
        (e) => alive && setError(errorMessage(e))
      )
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [filter, root])

  const onToggle = useCallback(
    (e: FileEntry) => {
      const next = new Set(expandedRef.current)
      if (next.has(e.path)) next.delete(e.path)
      else {
        next.add(e.path)
        void loadDir(e.path)
      }
      setExpanded(next)
    },
    [loadDir]
  )
  const onOpen = useCallback((e: FileEntry) => setSelected(e.path), [])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <input
          className={`input ${styles.filterInput}`}
          placeholder="Filtrar arquivos por nome…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
        />
        <button
          className={`icon-btn ${showIgnored ? styles.iconActive : ''}`}
          title={showIgnored ? 'Ocultar arquivos ignorados' : 'Mostrar arquivos ignorados (.gitignore)'}
          onClick={() => setShowIgnored((v) => !v)}
        >
          ◐
        </button>
        <button
          className="icon-btn"
          title="Recolher tudo"
          onClick={() => setExpanded(new Set())}
        >
          ⊟
        </button>
        <button className="icon-btn" title="Atualizar" onClick={() => void loadDir(root)}>
          ⟳
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
      <div className={`${styles.fileList} ${styles.tree}`}>
        {results ? (
          results.length ? (
            results.map((r) => (
              <div
                key={r.path}
                className={`${styles.treeRow} ${selected === r.path ? styles.fileRowActive : ''}`}
                style={{ paddingLeft: 8 }}
                onClick={() => setSelected(r.path)}
                title={r.path}
              >
                <FileIcon entry={{ name: r.name, isDir: false }} />
                <span className={styles.ellipsis}>{r.name}</span>
              </div>
            ))
          ) : (
            <div className={styles.empty}>Nenhum arquivo encontrado.</div>
          )
        ) : (
          <Tree
            dir={root}
            depth={0}
            tree={children}
            expanded={expanded}
            showIgnored={showIgnored}
            selected={selected}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        )}
      </div>
      <div className={styles.diffArea}>
        {selected ? (
          <FileViewer key={selected} path={selected} rev={rev} onError={setError} />
        ) : (
          <div className={styles.empty}>Selecione um arquivo para visualizar.</div>
        )}
      </div>
    </div>
  )
}
