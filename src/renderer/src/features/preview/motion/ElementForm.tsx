// Property form of the selected motion element. Every change goes through `edit` (undoable, live preview).
import type { ChartElement, Easing, EnterPreset, ExitPreset, MotionElement, MotionSpec } from '@shared/motion/spec'
import { CheckField, ColorField, Field, NumField, Section, SelectField, TextField } from './fields'
import styles from './motion.module.css'

export type Edit = (mutate: (doc: MotionSpec) => void, key?: string) => void

const EASINGS: { value: Easing | ''; label: string }[] = [
  { value: '', label: 'padrão' },
  { value: 'linear', label: 'linear' },
  { value: 'easeIn', label: 'easeIn' },
  { value: 'easeOut', label: 'easeOut' },
  { value: 'easeInOut', label: 'easeInOut' },
  { value: 'backOut', label: 'backOut' }
]
const ENTER: { value: EnterPreset | ''; label: string }[] = [
  { value: '', label: 'nenhuma' },
  { value: 'fade', label: 'fade' },
  { value: 'slide-up', label: 'slide-up' },
  { value: 'slide-down', label: 'slide-down' },
  { value: 'slide-left', label: 'slide-left' },
  { value: 'slide-right', label: 'slide-right' },
  { value: 'scale', label: 'scale' },
  { value: 'typewriter', label: 'typewriter (texto)' },
  { value: 'draw', label: 'draw (linha/seta)' }
]
const EXIT = ENTER.filter((o) => o.value !== 'typewriter' && o.value !== 'draw') as { value: ExitPreset | ''; label: string }[]
const WEIGHTS = ['', '300', '400', '500', '600', '700', '800', '900'].map((w) => ({ value: w, label: w || 'padrão' }))
export const FONT_LIST_ID = 'hangar-motion-fonts'
export const FONTS = ['Segoe UI', 'Arial', 'Georgia', 'Consolas', 'Verdana', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Courier New']

export function findElement(doc: MotionSpec, sceneIndex: number, id: string): MotionElement | undefined {
  return doc.scenes[sceneIndex]?.elements.find((e) => e.id === id)
}

function ChartData({ el, update }: { el: ChartElement; update(mutate: (c: ChartElement) => void, key: string): void }) {
  const series = el.series.length ? el.series : [{ name: 'Série 1', values: [] }]
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Rótulo</th>
            {series.map((s, k) => (
              <th key={k}>
                <div className={styles.seriesHead}>
                  <input
                    className={`input ${styles.cell}`}
                    value={s.name}
                    title="Nome da série"
                    onChange={(e) => update((c) => (c.series[k].name = e.target.value), `series-name-${k}`)}
                  />
                  <input
                    className={styles.swatch}
                    type="color"
                    value={s.color && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#c96442'}
                    title="Cor da série"
                    onChange={(e) => update((c) => (c.series[k].color = e.target.value), `series-color-${k}`)}
                  />
                  {el.series.length > 1 && (
                    <button className={styles.mini} title="Remover série" onClick={() => update((c) => c.series.splice(k, 1), `series-del`)}>
                      ×
                    </button>
                  )}
                </div>
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {el.labels.map((label, i) => (
            <tr key={i}>
              <td>
                <input className={`input ${styles.cell}`} value={label} onChange={(e) => update((c) => (c.labels[i] = e.target.value), `label-${i}`)} />
              </td>
              {series.map((s, k) => (
                <td key={k}>
                  <input
                    className={`input ${styles.cell} ${styles.num}`}
                    type="number"
                    value={Number.isFinite(s.values[i]) ? s.values[i] : ''}
                    onChange={(e) =>
                      update((c) => {
                        c.series[k] ??= { name: `Série ${k + 1}`, values: [] }
                        c.series[k].values[i] = e.target.value === '' ? 0 : Number(e.target.value)
                      }, `value-${k}-${i}`)
                    }
                  />
                </td>
              ))}
              <td>
                <button
                  className={styles.mini}
                  title="Remover linha"
                  onClick={() =>
                    update((c) => {
                      c.labels.splice(i, 1)
                      for (const s2 of c.series) s2.values.splice(i, 1)
                    }, 'row-del')
                  }
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.rowBtns}>
        <button
          className="btn"
          onClick={() =>
            update((c) => {
              c.labels.push(`Item ${c.labels.length + 1}`)
              for (const s2 of c.series) s2.values.push(0)
            }, 'row-add')
          }
        >
          + Linha
        </button>
        {el.chart !== 'pie' && (
          <button className="btn" onClick={() => update((c) => c.series.push({ name: `Série ${c.series.length + 1}`, values: c.labels.map(() => 0) }), 'series-add')}>
            + Série
          </button>
        )}
      </div>
    </div>
  )
}

export function ElementForm({ el, sceneIndex, edit }: { el: MotionElement; sceneIndex: number; edit: Edit }) {
  const key = (prop: string) => `${el.id}:${prop}`
  const set = (prop: string, value: unknown) =>
    edit((doc) => {
      const target = findElement(doc, sceneIndex, el.id) as unknown as Record<string, unknown> | undefined
      if (!target) return
      if (value === undefined) delete target[prop]
      else target[prop] = value
    }, key(prop))
  const any = el as unknown as Record<string, unknown>
  const num = (prop: string, label: string, opts: { optional?: boolean; step?: number; min?: number; max?: number } = {}) => (
    <NumField label={label} value={any[prop] as number | undefined} onChange={(v) => set(prop, v)} {...opts} />
  )
  const color = (prop: string, label: string, optional = false) => (
    <ColorField label={label} value={any[prop] as string | undefined} onChange={(v) => set(prop, v)} optional={optional} />
  )
  const text = (prop: string, label: string, opts: { optional?: boolean; multiline?: boolean; list?: string } = {}) => (
    <TextField label={label} value={any[prop] as string | undefined} onChange={(v) => set(prop, v)} {...opts} />
  )
  const preset = (which: 'enter' | 'exit') => {
    const value = el[which]
    const update = (patch: Record<string, unknown>) =>
      edit((doc) => {
        const target = findElement(doc, sceneIndex, el.id)
        if (!target) return
        if (patch.type === undefined && 'type' in patch) {
          delete target[which]
          return
        }
        const next = { ...(target[which] ?? { type: 'fade' }), ...patch } as Record<string, unknown>
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
        ;(target as unknown as Record<string, unknown>)[which] = next
      }, key(which))
    return (
      <div className={styles.grid}>
        <SelectField label="Tipo" value={value?.type as string | undefined} options={which === 'enter' ? ENTER : EXIT} onChange={(v) => update({ type: v })} />
        {value && (
          <>
            <NumField label="Duração (s)" value={value.duration} step={0.1} min={0} optional placeholder="0,6" onChange={(v) => update({ duration: v })} />
            <SelectField label="Easing" value={value.easing} options={EASINGS} onChange={(v) => update({ easing: v })} />
          </>
        )}
      </div>
    )
  }

  const updateChart = (mutate: (c: ChartElement) => void, k: string) =>
    edit((doc) => {
      const target = findElement(doc, sceneIndex, el.id)
      if (target?.type === 'chart') mutate(target)
    }, key(k))

  return (
    <>
      <Section title={`Elemento · ${el.id}`}>
        <div className={styles.grid}>
          {el.type === 'text' && (
            <>
              {text('text', 'Texto', { multiline: true })}
              {num('fontSize', 'Tamanho da fonte', { min: 1 })}
              {color('color', 'Cor')}
              <SelectField label="Peso" value={any.fontWeight === undefined ? undefined : String(any.fontWeight)} options={WEIGHTS} onChange={(v) => set('fontWeight', v ? Number(v) : undefined)} />
              {text('fontFamily', 'Fonte', { optional: true, list: FONT_LIST_ID })}
              <SelectField
                label="Alinhamento"
                value={el.align}
                options={[
                  { value: '', label: 'padrão (centro)' },
                  { value: 'left', label: 'esquerda' },
                  { value: 'center', label: 'centro' },
                  { value: 'right', label: 'direita' }
                ]}
                onChange={(v) => set('align', v)}
              />
              {num('maxWidth', 'Largura máx.', { optional: true, min: 1 })}
              {num('lineHeight', 'Entrelinha', { optional: true, step: 0.1, min: 0.5 })}
            </>
          )}
          {el.type === 'shape' && (
            <>
              <SelectField
                label="Forma"
                value={el.shape}
                options={[
                  { value: 'rect', label: 'retângulo' },
                  { value: 'circle', label: 'círculo' },
                  { value: 'line', label: 'linha' },
                  { value: 'arrow', label: 'seta' }
                ]}
                onChange={(v) => set('shape', v ?? 'rect')}
              />
              {num('width', 'Largura', { min: 1 })}
              {num('height', 'Altura', { optional: true, min: 1 })}
              {color('fill', 'Preenchimento', true)}
              {color('stroke', 'Contorno', true)}
              {num('strokeWidth', 'Espessura', { optional: true, min: 0 })}
              {num('radius', 'Raio dos cantos', { optional: true, min: 0 })}
            </>
          )}
          {el.type === 'image' && (
            <>
              {text('src', 'Arquivo (src)')}
              {num('width', 'Largura', { min: 1 })}
              {num('height', 'Altura', { min: 1 })}
              <SelectField
                label="Ajuste"
                value={el.fit}
                options={[
                  { value: '', label: 'padrão (contain)' },
                  { value: 'contain', label: 'contain' },
                  { value: 'cover', label: 'cover' }
                ]}
                onChange={(v) => set('fit', v)}
              />
              {num('radius', 'Raio dos cantos', { optional: true, min: 0 })}
            </>
          )}
          {el.type === 'chart' && (
            <>
              <SelectField
                label="Gráfico"
                value={el.chart}
                options={[
                  { value: 'bar', label: 'barras' },
                  { value: 'line', label: 'linha' },
                  { value: 'pie', label: 'pizza' }
                ]}
                onChange={(v) => set('chart', v ?? 'bar')}
              />
              {num('width', 'Largura', { min: 1 })}
              {num('height', 'Altura', { min: 1 })}
              {num('fontSize', 'Tamanho da fonte', { optional: true, min: 1 })}
              {color('textColor', 'Cor do texto', true)}
              {color('axisColor', 'Cor do eixo', true)}
              {num('growDuration', 'Crescimento (s)', { optional: true, step: 0.1, min: 0 })}
              {num('decimals', 'Decimais', { optional: true, min: 0, max: 6 })}
              {text('valuePrefix', 'Prefixo', { optional: true })}
              {text('valueSuffix', 'Sufixo', { optional: true })}
              <CheckField label="Mostrar valores" value={el.showValues ?? el.chart !== 'line'} onChange={(v) => set('showValues', v)} />
            </>
          )}
          {el.type === 'counter' && (
            <>
              {num('from', 'De')}
              {num('to', 'Até')}
              {text('prefix', 'Prefixo', { optional: true })}
              {text('suffix', 'Sufixo', { optional: true })}
              {num('decimals', 'Decimais', { optional: true, min: 0, max: 6 })}
              {num('countDuration', 'Contagem (s)', { optional: true, step: 0.1, min: 0 })}
              {num('fontSize', 'Tamanho da fonte', { min: 1 })}
              {color('color', 'Cor')}
              <SelectField label="Peso" value={any.fontWeight === undefined ? undefined : String(any.fontWeight)} options={WEIGHTS} onChange={(v) => set('fontWeight', v ? Number(v) : undefined)} />
              {text('fontFamily', 'Fonte', { optional: true, list: FONT_LIST_ID })}
            </>
          )}
        </div>
        {el.type === 'chart' && <ChartData el={el} update={updateChart} />}
      </Section>

      <Section title="Posição e tempo">
        <div className={styles.grid}>
          {num('x', 'X (centro)')}
          {num('y', 'Y (centro)')}
          {num('start', 'Início (s)', { optional: true, step: 0.1, min: 0 })}
          {num('end', 'Fim (s)', { optional: true, step: 0.1, min: 0 })}
          {num('opacity', 'Opacidade', { optional: true, step: 0.05, min: 0, max: 1 })}
          {num('scale', 'Escala', { optional: true, step: 0.05, min: 0 })}
          {num('rotation', 'Rotação (°)', { optional: true })}
        </div>
        {!!el.keyframes?.length && (
          <Field label="Keyframes" wide>
            <span className="muted">{el.keyframes.length} keyframe(s) — edite no JSON ou peça ao Claude.</span>
          </Field>
        )}
      </Section>

      <Section title="Entrada">{preset('enter')}</Section>
      <Section title="Saída">{preset('exit')}</Section>
    </>
  )
}
