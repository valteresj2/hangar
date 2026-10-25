// Settings → Plataforma: URL and mode (locked when set by Windows policy), connection state, account, synced token
// models, device.
import { useState } from 'react'
import {
  PLATFORM_MODES,
  type PlatformMode,
  type PlatformState,
  type PlatformValueSource
} from '@shared/features/platform'
import { Card, Row, Segmented, Spinner, formatDateTime } from '../settings/ui'
import { MODE_LABEL, platformApi, runAction, statusLabel, usePlatform } from './api'
import { formatContext, priceLabel } from './models'
import { Avatar, ConnectButtons, StatusDot, UrlField } from './parts'
import styles from './platform.module.css'

const MODE_HINT: Record<PlatformMode, string> = {
  off: 'O Hangar não fala com nenhuma plataforma.',
  optional: 'O app funciona sem plataforma; conecte quando quiser.',
  required: 'Sem conexão, o Hangar não cria sessões.'
}

function LockedBadge({ source }: { source: PlatformValueSource }) {
  return (
    <span
      className={styles.locked}
      title={
        source === 'policy-machine'
          ? 'HKLM\\Software\\Policies\\Hangar (política do computador)'
          : 'HKCU\\Software\\Policies\\Hangar (política do usuário)'
      }
    >
      🔒 Definido pela política da empresa
    </span>
  )
}

export function NoticeBanner({ state }: { state: PlatformState }) {
  const [dismissed, setDismissed] = useState<number>()
  const n = state.notice
  if (!n || n.at === dismissed) return null
  return (
    <div className={`${styles.notice} ${styles[`notice_${n.tone}`]}`} role="status">
      <span style={{ flex: 1 }}>{n.message}</span>
      <button className="icon-btn" title="Dispensar" onClick={() => setDismissed(n.at)}>
        ✕
      </button>
    </div>
  )
}

function ConnectionCard({ state }: { state: PlatformState }) {
  const [error, setError] = useState<string>()
  const { config } = state
  const shownError = error ?? state.error

  return (
    <Card title="Conexão">
      <Row
        label="URL da plataforma"
        hint={
          config.locked.url ? (
            <LockedBadge source={config.source.url} />
          ) : (
            'Endereço do Agent Hangar da sua empresa (o admin encontra em Console → App Hangar).'
          )
        }
      >
        <UrlField state={state} onError={setError} />
      </Row>
      <Row
        label="Modo"
        hint={config.locked.mode ? <LockedBadge source={config.source.mode} /> : MODE_HINT[config.mode]}
      >
        {config.locked.mode ? (
          <span className={styles.badge}>{MODE_LABEL[config.mode]}</span>
        ) : (
          <Segmented
            value={config.mode}
            options={PLATFORM_MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
            onChange={(mode) => {
              if (
                mode === 'off' &&
                (state.status === 'connected' || state.status === 'error') &&
                !window.confirm('Desligar a plataforma desconecta o Hangar. Continuar?')
              )
                return
              void runAction(() => platformApi.setConfig({ mode })).then(setError)
            }}
          />
        )}
      </Row>
      {state.status !== 'off' && (
        <Row
          label={
            <span className={styles.statusLine}>
              <StatusDot state={state} /> {statusLabel(state)}
              {state.status === 'connecting' && <Spinner />}
            </span>
          }
          hint={
            state.status === 'connecting'
              ? 'Termine o login no navegador que abriu. Ele expira em 5 minutos.'
              : state.status === 'connected' && state.lastHeartbeatAt
                ? `Último contato: ${formatDateTime(state.lastHeartbeatAt)}`
                : state.status === 'unconfigured'
                  ? 'Informe a URL para conectar.'
                  : undefined
          }
        >
          <ConnectButtons state={state} onError={setError} />
        </Row>
      )}
      {shownError && <div className={styles.errorRow}>{shownError}</div>}
    </Card>
  )
}

function AccountCard({ state }: { state: PlatformState }) {
  const { user, org } = state
  if (!user) return null
  return (
    <Card title="Conta">
      <Row
        label={
          <span className={styles.account}>
            <Avatar user={user} size={36} />
            <span>
              <span className={styles.accountName}>{user.name}</span>
              <span className={styles.accountEmail}>{user.email}</span>
            </span>
          </span>
        }
      />
      <Row label="Empresa">
        <span>{org?.name ?? '—'}</span>
      </Row>
      {user.orgRole && (
        <Row label="Papel">
          <span>{ROLE_LABEL[user.orgRole] ?? user.orgRole}</span>
        </Row>
      )}
      <Row label="Times">
        {user.teams.length ? (
          <span className={styles.teams}>
            {user.teams.map((t) => (
              <span key={t.id} className={styles.badge} title={t.slug}>
                {t.name}
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">Nenhum</span>
        )}
      </Row>
      {state.platformVersion && (
        <Row label="Versão da plataforma">
          <span>{state.platformVersion}</span>
        </Row>
      )}
    </Card>
  )
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  member: 'Membro',
  viewer: 'Leitor'
}

function ModelsCard({ state }: { state: PlatformState }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { models } = state
  if (state.status !== 'connected' && state.status !== 'error') return null
  const count = models.connections.reduce((n, c) => n + c.models.length, 0)
  const sync = async () => {
    setBusy(true)
    setError(await runAction(() => platformApi.syncModels()))
    setBusy(false)
  }
  const syncing = busy || models.status === 'syncing'
  return (
    <Card title="Modelos de token">
      <Row
        label={
          models.status === 'unsupported'
            ? 'Esta plataforma ainda não sincroniza modelos com o app'
            : models.connections.length
              ? `${models.connections.length} ${models.connections.length === 1 ? 'conexão sincronizada' : 'conexões sincronizadas'} · ${count} ${count === 1 ? 'modelo' : 'modelos'}`
              : 'Nenhuma conexão sincronizada'
        }
        hint={
          models.syncedAt
            ? `Última sincronização: ${formatDateTime(models.syncedAt)}. A chave das conexões fica na plataforma; o Hangar usa uma chave própria deste dispositivo.`
            : 'O admin escolhe em Console → Provedores de LLM quais conexões vão para o Hangar.'
        }
      >
        {syncing && <Spinner />}
        <button className="btn" disabled={syncing} onClick={() => void sync()}>
          Sincronizar agora
        </button>
      </Row>
      {models.connections.map((c) => (
        <Row
          key={c.id}
          label={c.name}
          hint={`${c.provider} · aparece no seletor de modelo como “Modelos de token · ${c.name}”`}
        >
          <span className={styles.teams}>
            {c.models.map((m) => (
              <span
                key={m.id}
                className={styles.badge}
                title={[
                  m.id,
                  formatContext(m.contextLength) && `${formatContext(m.contextLength)} de contexto`,
                  priceLabel(m)
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                {m.name}
              </span>
            ))}
          </span>
        </Row>
      ))}
      {(error ?? models.error) && <div className={styles.errorRow}>{error ?? models.error}</div>}
    </Card>
  )
}

const DEVICE_STATUS = { active: 'Registrado', revoked: 'Revogado', unregistered: 'Não registrado' } as const

function DeviceCard({ state }: { state: PlatformState }) {
  const { device } = state
  return (
    <Card title="Dispositivo">
      <Row label="Nome" hint="Como este computador aparece para o admin da plataforma.">
        <span>{device.name}</span>
      </Row>
      <Row label="ID do dispositivo">
        <span className={styles.mono}>{device.deviceId}</span>
      </Row>
      <Row label="Estado">
        <span className={device.status === 'revoked' ? styles.textBad : undefined}>{DEVICE_STATUS[device.status]}</span>
      </Row>
      {device.registeredAt && (
        <Row label="Registrado em">
          <span>{formatDateTime(device.registeredAt)}</span>
        </Row>
      )}
    </Card>
  )
}

export function PlatformSection() {
  const state = usePlatform()
  if (!state) return <Spinner />
  return (
    <>
      <p className={`muted ${styles.intro}`}>
        Conecte o Hangar ao Agent Hangar da sua empresa para entrar com a sua conta corporativa. O código dos seus
        projetos nunca é enviado à plataforma.
      </p>
      <NoticeBanner state={state} />
      <ConnectionCard state={state} />
      {state.status !== 'off' && <AccountCard state={state} />}
      <ModelsCard state={state} />
      {state.status !== 'off' && <DeviceCard state={state} />}
    </>
  )
}
