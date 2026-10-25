// The workspace screen shown in the center (Início or Meus agentes): App.tsx renders it in <main> in place of the
// session while useUi().workspaceView is set.
import { useEffect, type ReactNode } from 'react'
import type { Loadable, WorkspaceState, WorkspaceView as View } from '@shared/features/workspace'
import { useUi } from '../../core/ui'
import { usePlatform } from '../platform'
import { useWorkspace, workspaceApi } from './api'
import { AgentsView } from './AgentsView'
import { ago } from './format'
import { HomeView } from './HomeView'
import styles from './workspace.module.css'

function ConnectCard() {
  const platform = usePlatform()
  return (
    <div className={styles.page}>
      <div className={`${styles.card} ${styles.connectCard}`}>
        <h2 className={styles.cardTitle}>Conecte à plataforma</h2>
        <p className="muted">
          O Início, os seus agentes, as decisões e a caixa de entrada do Agent Hangar aparecem aqui depois que o Hangar
          se conecta à plataforma da sua empresa.
        </p>
        <button className="btn btn-primary" onClick={() => useUi.getState().openSettings('platform')}>
          {platform?.status === 'connecting' ? 'Conectando…' : 'Conectar à plataforma'}
        </button>
      </div>
    </div>
  )
}

/** Loading / error / stale banner of a screen made of several resources. */
export function LoadState(props: { parts: Loadable<unknown>[]; scope: 'home' | 'agents'; children: ReactNode }) {
  const { parts, scope } = props
  const main = parts[0]
  const failed = parts.find((p) => p.status === 'error')
  const retry = () => void workspaceApi.refresh(scope)
  if (main.data === undefined) {
    if (main.status === 'error')
      return (
        <div className={`${styles.card} ${styles.errorCard}`} role="alert">
          <h2 className={styles.cardTitle}>Não foi possível carregar</h2>
          <p>{main.error}</p>
          <button className="btn" onClick={retry}>
            Tentar de novo
          </button>
        </div>
      )
    return (
      <div className={styles.loading} aria-busy="true">
        <span className={styles.spinner} /> Carregando o seu workspace…
      </div>
    )
  }
  return (
    <>
      {failed && (
        <div className={styles.staleBanner} role="status">
          <span>
            {failed.fetchedAt ? `Mostrando dados de ${ago(failed.fetchedAt)}. ` : ''}
            {failed.error}
          </span>
          <button className="btn" onClick={retry}>
            Tentar de novo
          </button>
        </div>
      )}
      {props.children}
    </>
  )
}

export function LiveNote({ state }: { state: WorkspaceState }) {
  const busy = [state.home, state.decisions, state.chart, state.inbox].some((r) => r.status === 'loading')
  const text =
    state.live === 'live'
      ? 'Ao vivo'
      : state.live === 'polling'
        ? 'Atualiza a cada 60 s'
        : state.live === 'connecting'
          ? 'Conectando…'
          : ''
  return (
    <span className={styles.liveNote}>
      <span className={`${styles.liveDot} ${state.live === 'live' ? styles.liveOn : ''}`} aria-hidden="true" />
      {busy ? 'Atualizando…' : text}
    </span>
  )
}

export function WorkspaceView({ view }: { view: View }) {
  const state = useWorkspace()
  const close = () => useUi.getState().closeWorkspace()

  useEffect(() => {
    if (state?.connected) void workspaceApi.refresh(view).catch(() => undefined)
    // Fetch when the screen opens (or the login changes); events and polling keep it current afterwards.
  }, [view, state?.connected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && document.activeElement === document.body) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={styles.screen}>
      {!state ? null : !state.connected ? (
        <ConnectCard />
      ) : view === 'home' ? (
        <HomeView state={state} />
      ) : (
        <AgentsView state={state} />
      )}
    </div>
  )
}
