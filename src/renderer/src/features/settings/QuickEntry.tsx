// Root view of the Quick Entry window (#quick-entry): type a prompt, pick a folder, Enter starts a session.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import { ENGINE } from '@shared/features/engine'
import { SESSIONS, type CreateSessionInput } from '@shared/features/sessions'
import { SETTINGS } from '@shared/features/settings'
import { bridge } from '../../core/api'
import { useSettings } from '../../core/data'
import { errorText, settingsApi } from './api'
import styles from './quickEntry.module.css'

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

/** Same light/dark resolution as the main window. */
function useTheme(theme: string | undefined): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const pref = theme ?? 'system'
      document.documentElement.dataset.theme =
        pref === 'dark' || (pref === 'system' && media.matches) ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

export function QuickEntry() {
  const settings = useSettings()
  useTheme(settings?.theme)
  const [text, setText] = useState('')
  const [cwd, setCwd] = useState<string>()
  const [extraFolder, setExtraFolder] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const folders = useMemo(() => {
    const out: { path: string; pinned: boolean }[] = []
    const add = (path: string, pinned: boolean) => {
      if (path && !out.some((f) => samePath(f.path, path))) out.push({ path, pinned })
    }
    for (const p of settings?.pinnedFolders ?? []) add(p, true)
    for (const p of settings?.recentFolders ?? []) add(p, false)
    if (extraFolder) add(extraFolder, false)
    return out
  }, [settings?.pinnedFolders, settings?.recentFolders, extraFolder])

  // Default to the most recently used folder (falling back to the first pinned one).
  useEffect(() => {
    if (!cwd && settings) setCwd(settings.recentFolders[0] ?? settings.pinnedFolders[0])
  }, [settings, cwd])

  useEffect(() => {
    document.title = 'Quick Entry'
    const focus = () => {
      setError(undefined)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    focus()
    return bridge.on(SETTINGS.quickEntryShown, focus)
  }, [])

  const pickFolder = async () => {
    const folder = await settingsApi.quickEntryPickFolder(cwd)
    if (folder) {
      setExtraFolder(folder)
      setCwd(folder)
    }
    inputRef.current?.focus()
  }

  const submit = async () => {
    const prompt = text.trim()
    if (!prompt || busy) return
    if (!cwd) return setError('Escolha uma pasta.')
    setBusy(true)
    setError(undefined)
    try {
      const input: CreateSessionInput = { cwd }
      const session = await bridge.invoke<Session>(SESSIONS.create, input)
      await bridge.invoke(ENGINE.send, session.id, prompt)
      setText('')
      await settingsApi.quickEntryDone(session.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      void settingsApi.quickEntryHide()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className={styles.root} onKeyDown={onKeyDown}>
      <div className={styles.dragBar}>
        <span className={styles.logo}>H</span>
        <span>Nova sessão</span>
        <span className={styles.spacer} />
        <button className={styles.close} title="Fechar (Esc)" onClick={() => void settingsApi.quickEntryHide()}>
          ✕
        </button>
      </div>
      <textarea
        ref={inputRef}
        className={styles.prompt}
        value={text}
        placeholder="O que o Claude deve fazer?"
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
      />
      <div className={styles.footer}>
        <select
          className={styles.folder}
          value={cwd ?? ''}
          title={cwd}
          onChange={(e) => (e.target.value === '__pick__' ? void pickFolder() : setCwd(e.target.value))}
        >
          {!cwd && <option value="">Escolha uma pasta…</option>}
          {folders.map((f) => (
            <option key={f.path} value={f.path}>
              {f.pinned ? '📌 ' : ''}
              {baseName(f.path)} — {f.path}
            </option>
          ))}
          <option value="__pick__">Escolher outra pasta…</option>
        </select>
        {error ? (
          <span className={styles.error}>{error}</span>
        ) : (
          <span className={styles.hint}>Enter envia · Shift+Enter quebra linha · Esc fecha</span>
        )}
        <button className="btn btn-primary" disabled={busy || !text.trim() || !cwd} onClick={() => void submit()}>
          {busy ? 'Enviando…' : 'Iniciar'}
        </button>
      </div>
    </div>
  )
}
