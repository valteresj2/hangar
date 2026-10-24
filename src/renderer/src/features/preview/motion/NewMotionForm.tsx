// "Novo Motion": a short brief sent to the session with `output: 'motion'` (the engine adds the authoring guide).
import { useState } from 'react'
import { ENGINE } from '@shared/features/engine'
import { bridge } from '../../../core/api'
import styles from './motion.module.css'

const RATIOS = {
  '16:9': { label: '16:9 (horizontal)', size: '1920x1080' },
  '9:16': { label: '9:16 (vertical)', size: '1080x1920' },
  '1:1': { label: '1:1 (quadrado)', size: '1080x1080' }
} as const
type Ratio = keyof typeof RATIOS

export function buildMotionPrompt(description: string, audience: string, seconds: number, ratio: Ratio): string {
  const lines = [
    `Crie uma animação Hangar Motion (arquivo .motion.json) sobre: ${description.trim()}`,
    audience.trim() ? `Público: ${audience.trim()}.` : '',
    `Duração aproximada: ${seconds} segundos.`,
    `Proporção ${ratio} (${RATIOS[ratio].size}).`
  ]
  return lines.filter(Boolean).join('\n')
}

export function NewMotionForm({ sessionId, onClose, onSent }: { sessionId: string; onClose(): void; onSent(): void }) {
  const [description, setDescription] = useState('')
  const [audience, setAudience] = useState('')
  const [seconds, setSeconds] = useState(30)
  const [ratio, setRatio] = useState<Ratio>('16:9')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()

  const send = async () => {
    if (!description.trim()) return
    setSending(true)
    setError(undefined)
    try {
      // engine:send may only resolve when the turn ends; wait briefly for early errors, then let the chat take over.
      const sent = bridge.invoke(ENGINE.send, sessionId, buildMotionPrompt(description, audience, seconds, ratio), { output: 'motion' })
      sent.catch((err) => console.error('[preview] motion request failed', err))
      await Promise.race([sent, new Promise((r) => setTimeout(r, 1500))])
      onSent()
    } catch (err) {
      setError(String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setSending(false)
    }
  }

  return (
    <div className={styles.modalBackdrop} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form
        className={styles.modal}
        role="dialog"
        aria-label="Novo Motion"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <strong>Novo Motion</strong>
        <span className="muted">O pedido vai para esta sessão; o Claude escreve um .motion.json que abre aqui.</span>
        <label className={styles.formField}>
          <span>O que a animação deve mostrar?</span>
          <textarea
            className={`input ${styles.textarea}`}
            rows={4}
            autoFocus
            value={description}
            placeholder="Ex.: os 3 passos para começar a usar o Hangar"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className={styles.formField}>
          <span>Público</span>
          <input className="input" value={audience} placeholder="Ex.: desenvolvedores iniciantes" onChange={(e) => setAudience(e.target.value)} />
        </label>
        <div className={styles.formRow}>
          <label className={styles.formField}>
            <span>Duração aproximada</span>
            <select className="input" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
              {[10, 15, 30, 45, 60].map((s) => (
                <option key={s} value={s}>
                  {s} s
                </option>
              ))}
            </select>
          </label>
          <label className={styles.formField}>
            <span>Proporção</span>
            <select className="input" value={ratio} onChange={(e) => setRatio(e.target.value as Ratio)}>
              {(Object.keys(RATIOS) as Ratio[]).map((r) => (
                <option key={r} value={r}>
                  {RATIOS[r].label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <div className={styles.errorText}>{error}</div>}
        <div className={styles.modalRow}>
          <div className={styles.flex} />
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!description.trim() || sending}>
            {sending ? 'Enviando…' : 'Criar animação'}
          </button>
        </div>
      </form>
    </div>
  )
}
