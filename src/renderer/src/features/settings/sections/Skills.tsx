import { useCallback, useEffect, useState } from 'react'
import type { PluginInfo, SkillInfo } from '@shared/features/settings'
import { api } from '../../../core/api'
import { settingsApi } from '../api'
import { Card, Spinner } from '../ui'
import styles from '../settings.module.css'

export function SkillsSection() {
  const [skills, setSkills] = useState<SkillInfo[]>()
  const [plugins, setPlugins] = useState<PluginInfo[]>()
  const [claudeDir, setClaudeDir] = useState<string>()
  const [filter, setFilter] = useState('')

  const refresh = useCallback(async () => {
    const [s, p, dir] = await Promise.all([settingsApi.skills(), settingsApi.plugins(), settingsApi.claudeDir()])
    setSkills(s)
    setPlugins(p)
    setClaudeDir(dir)
  }, [])

  useEffect(() => void refresh(), [refresh])

  const q = filter.trim().toLowerCase()
  const shown = skills?.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  const sep = window.hangar.platform === 'win32' ? '\\' : '/'

  return (
    <>
      <div className={styles.toolbar}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Filtrar skills…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {claudeDir && (
          <button className="btn" onClick={() => void api.openPath(`${claudeDir}${sep}skills`)}>
            Abrir pasta de skills
          </button>
        )}
        <button className="btn" onClick={() => void refresh()}>
          Atualizar
        </button>
      </div>

      <Card title={`Skills${skills ? ` (${skills.length})` : ''}`}>
        {!shown ? (
          <div className={styles.empty}>
            <Spinner />
          </div>
        ) : shown.length === 0 ? (
          <div className={styles.empty}>
            {q ? 'Nenhuma skill encontrada.' : 'Nenhuma skill instalada em ~/.claude/skills.'}
          </div>
        ) : (
          <div className={styles.list}>
            {shown.map((s) => (
              <div key={s.dir} className={styles.item}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>
                    {s.name}
                    {s.source === 'synced' && <span className={styles.badge}>sincronizada</span>}
                  </div>
                  <div className={`${styles.itemSub} ${styles.clamp}`} title={s.description}>
                    {s.description || 'Sem descrição.'}
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button className="btn" onClick={() => void api.openPath(s.dir)}>
                    Abrir pasta
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title={`Plugins${plugins ? ` (${plugins.length})` : ''}`}
        actions={
          claudeDir && (
            <button className="btn" onClick={() => void api.openPath(`${claudeDir}${sep}plugins`)}>
              Abrir pasta de plugins
            </button>
          )
        }
      >
        <div style={{ height: 8 }} />
        {!plugins ? (
          <div className={styles.empty}>
            <Spinner />
          </div>
        ) : plugins.length === 0 ? (
          <div className={styles.empty}>Nenhum plugin instalado. Instale pelo Claude Code com /plugin.</div>
        ) : (
          <div className={styles.list}>
            {plugins.map((p) => (
              <div key={`${p.id}:${p.scope ?? ''}`} className={styles.item}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>
                    {p.name}
                    {p.version && <span className={styles.badge}>v{p.version}</span>}
                    {p.marketplace && <span className={styles.badge}>{p.marketplace}</span>}
                    {p.scope && <span className={styles.badge}>{p.scope}</span>}
                    {p.enabled === false && <span className={styles.badge}>desativado</span>}
                  </div>
                  <div className={`${styles.itemSub} ${styles.clamp}`}>{p.description || 'Sem descrição.'}</div>
                </div>
                {p.installPath && (
                  <div className={styles.itemActions}>
                    <button className="btn" onClick={() => void api.openPath(p.installPath!)}>
                      Abrir pasta
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
