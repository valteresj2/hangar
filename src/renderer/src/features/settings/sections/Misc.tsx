import { UpdaterPanel } from '../../updater'
import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/features/settings'
import { api } from '../../../core/api'
import { settingsApi } from '../api'
import { Card, Kbd, Row, Spinner } from '../ui'
import styles from '../settings.module.css'

export const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'Ctrl+K', label: 'Abrir a paleta de comandos' },
  { keys: 'Ctrl+N', label: 'Nova sessão' },
  { keys: 'Ctrl+B', label: 'Mostrar/ocultar a sidebar' },
  { keys: 'Ctrl+,', label: 'Abrir as configurações' },
  { keys: 'Ctrl+`', label: 'Abrir o terminal no painel lateral' },
  { keys: 'Ctrl+Shift+↑', label: 'Sessão anterior' },
  { keys: 'Ctrl+Shift+↓', label: 'Próxima sessão' },
  { keys: 'Esc', label: 'Fechar paleta / configurações' }
]

export function ShortcutsSection() {
  return (
    <Card>
      <table className={styles.table}>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys}>
              <td>{s.label}</td>
              <td style={{ textAlign: 'right' }}>
                <Kbd keys={s.keys} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

export function AboutSection() {
  const [info, setInfo] = useState<AppInfo>()
  useEffect(() => void settingsApi.appInfo().then(setInfo), [])
  if (!info) return <Spinner />
  return (
    <>
      <UpdaterPanel />
      
    <Card>
      <Row label="Hangar" hint="App desktop para rodar e acompanhar sessões do Claude Code.">
        <span>v{info.version}</span>
      </Row>
      <Row label="Electron">
        <span>{info.electron}</span>
      </Row>
      <Row label="Chromium">
        <span>{info.chrome}</span>
      </Row>
      <Row label="Node.js">
        <span>{info.node}</span>
      </Row>
      <Row label="Pasta de dados" hint={<span className={styles.path}>{info.dataDir}</span>}>
        <button className="btn" onClick={() => void api.openPath(info.dataDir)}>
          Abrir
        </button>
      </Row>
    </Card>
    </>
  )
}
