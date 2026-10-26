import { UpdaterPanel } from '../../updater'
import { useEffect, useState } from 'react'
import type { AppInfo, ThirdPartyNotice } from '@shared/features/settings'
import { BRAND } from '@shared/brand'
import { BrandMark, Wordmark } from '../../../shell/Brand'
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
      <section className={styles.about}>
        <BrandMark size={64} />
        <div className={styles.aboutText}>
          <Wordmark large />
          <div className={styles.aboutVersion}>Versão {info.version}</div>
          <div className={styles.hint}>{BRAND.tagline}</div>
          <div className={styles.aboutLegal}>
            {BRAND.copyright}. {BRAND.license}
          </div>
        </div>
      </section>

      <UpdaterPanel />

      <Card title="Componentes">
        <Row label="Claude Code" hint="Embutido no Agent SDK; usado quando não há um claude instalado.">
          <span>{info.claudeCode ?? '—'}</span>
        </Row>
        <Row label="Claude Agent SDK">
          <span>{info.agentSdk ?? '—'}</span>
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
        <Row label="Sistema">
          <span>{info.platform}</span>
        </Row>
        <Row label="Pasta de dados" hint={<span className={styles.path}>{info.dataDir}</span>}>
          <button className="btn" onClick={() => void api.openPath(info.dataDir)}>
            Abrir
          </button>
        </Row>
      </Card>

      <ThirdPartyNotices />
    </>
  )
}

/** Licenses of the packages shipped with the app (resources/third-party-notices.json). */
function ThirdPartyNotices() {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<ThirdPartyNotice[]>()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string>()
  useEffect(() => {
    if (open && !list) void settingsApi.thirdPartyNotices().then(setList)
  }, [open, list])

  const q = query.trim().toLowerCase()
  const shown = (list ?? []).filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q)
  )
  return (
    <Card
      title="Avisos de terceiros"
      actions={
        <button className="btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Ocultar' : 'Ver licenças'}
        </button>
      }
    >
      <div className={styles.noticesBody}>
        <div className={styles.hint}>
          O {BRAND.productName} usa software de código aberto. Abaixo, cada pacote distribuído com o app, sua versão e
          licença.
        </div>
        {open && !list && <Spinner />}
        {open && list && (
          <>
            <input
              className="input"
              value={query}
              placeholder={`Filtrar ${list.length} pacotes por nome ou licença`}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul className={styles.notices}>
              {shown.map((p) => {
                const key = `${p.name}@${p.version}`
                const isOpen = expanded === key
                return (
                  <li key={key}>
                    <button
                      className={styles.noticeRow}
                      onClick={() => setExpanded(isOpen ? undefined : key)}
                      aria-expanded={isOpen}
                    >
                      <span className={styles.noticeName}>{p.name}</span>
                      <span className={styles.noticeVersion}>{p.version}</span>
                      <span className={styles.noticeLicense}>{p.license}</span>
                    </button>
                    {isOpen && (
                      <div className={styles.noticeBody}>
                        {p.repository && (
                          <button className={styles.link} onClick={() => void api.openExternal(p.repository!)}>
                            {p.repository}
                          </button>
                        )}
                        <pre className={styles.noticeText}>
                          {p.text ?? 'O pacote não inclui o texto da licença; consulte o repositório.'}
                        </pre>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </Card>
  )
}
