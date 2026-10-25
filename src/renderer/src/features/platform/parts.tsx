// Small pieces shared by the platform views: avatar, status dot, URL field and the connect/disconnect buttons.
import { useState } from 'react'
import type { PlatformState, PlatformUser } from '@shared/features/platform'
import { initials, platformApi, runAction, statusLabel } from './api'
import styles from './platform.module.css'

export function Avatar({ user, size = 28 }: { user?: PlatformUser; size?: number }) {
  const [broken, setBroken] = useState<string>()
  const src = user?.avatarUrl && user.avatarUrl !== broken ? user.avatarUrl : undefined
  return (
    <span className={styles.avatar} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {src ? (
        <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(src)} />
      ) : (
        initials(user?.name ?? user?.email)
      )}
    </span>
  )
}

export function tone(state: PlatformState): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (state.status === 'connected') return 'ok'
  if (state.status === 'error' || state.status === 'connecting') return 'warn'
  if (state.config.mode === 'required') return 'bad'
  return 'neutral'
}

export function StatusDot({ state }: { state: PlatformState }) {
  return <span className={`${styles.dot} ${styles[tone(state)]}`} title={statusLabel(state)} />
}

/** Platform URL input with a save button; read-only when the Windows policy sets it. */
export function UrlField({ state, onError }: { state: PlatformState; onError: (msg?: string) => void }) {
  const [draft, setDraft] = useState<string>()
  const value = draft ?? state.config.url
  const dirty = draft !== undefined && draft.trim() !== state.config.url
  const locked = state.config.locked.url
  const busy = state.status === 'connecting'

  const save = async () => {
    if (!dirty) return
    if (
      (state.status === 'connected' || state.status === 'error') &&
      !window.confirm('Trocar a URL desconecta o Hangar da plataforma atual. Continuar?')
    )
      return
    const err = await runAction(() => platformApi.setConfig({ url: value }))
    onError(err)
    if (!err) setDraft(undefined)
  }

  return (
    <div className={styles.urlField}>
      <input
        className="input"
        placeholder="https://hangar.suaempresa.com"
        value={value}
        disabled={locked || busy}
        spellCheck={false}
        aria-label="URL da plataforma"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          else if (e.key === 'Escape') setDraft(undefined)
        }}
      />
      {!locked && (
        <button className="btn" disabled={!dirty || busy} onClick={() => void save()}>
          Salvar
        </button>
      )}
    </div>
  )
}

/** Conectar / Cancelar / Desconectar, depending on the state. */
export function ConnectButtons({
  state,
  onError,
  primary = true
}: {
  state: PlatformState
  onError: (msg?: string) => void
  primary?: boolean
}) {
  if (state.status === 'off') return null
  if (state.status === 'connecting')
    return (
      <button className="btn" onClick={() => void runAction(() => platformApi.cancelConnect())}>
        Cancelar login
      </button>
    )
  if (state.status === 'connected' || state.status === 'error')
    return (
      <>
        <button className="btn" onClick={() => void runAction(() => platformApi.refresh()).then(onError)}>
          Atualizar
        </button>
        <button
          className="btn"
          onClick={() => {
            if (!window.confirm('Desconectar o Hangar da plataforma? O login deste computador será revogado.')) return
            void runAction(() => platformApi.disconnect()).then(onError)
          }}
        >
          Desconectar
        </button>
      </>
    )
  return (
    <button
      className={`btn ${primary ? 'btn-primary' : ''}`}
      disabled={!state.config.url}
      title={state.config.url ? 'Abre o login da plataforma no navegador' : 'Informe a URL da plataforma primeiro'}
      onClick={() => {
        onError(undefined)
        void runAction(() => platformApi.connect()).then(onError)
      }}
    >
      Conectar à plataforma
    </button>
  )
}
