// Small form controls for the motion editor.
import { useEffect, useState, type ReactNode } from 'react'
import styles from './motion.module.css'

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`${styles.field} ${wide ? styles.fieldWide : ''}`}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  )
}

/** Number input; with `optional`, clearing it yields undefined (the runtime default applies). */
export function NumField(props: {
  label: string
  value: number | undefined
  onChange(v: number | undefined): void
  step?: number
  min?: number
  max?: number
  optional?: boolean
  placeholder?: string
}) {
  const { label, value, onChange, step = 1, min, max, optional, placeholder } = props
  // Local text so partial input ("-", "1.") is not overwritten while typing.
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => {
    setText((cur) => (Number(cur) === value && cur !== '' ? cur : value === undefined ? '' : String(value)))
  }, [value])
  return (
    <Field label={label}>
      <input
        className={`input ${styles.control}`}
        type="number"
        step={step}
        min={min}
        max={max}
        value={text}
        placeholder={placeholder ?? (optional ? 'padrão' : undefined)}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value === '') {
            if (optional) onChange(undefined)
            return
          }
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
      />
    </Field>
  )
}

export function TextField(props: {
  label: string
  value: string | undefined
  onChange(v: string | undefined): void
  optional?: boolean
  multiline?: boolean
  list?: string
  wide?: boolean
}) {
  const { label, value, onChange, optional, multiline, list, wide } = props
  const handle = (v: string) => onChange(optional && v === '' ? undefined : v)
  return (
    <Field label={label} wide={wide || multiline}>
      {multiline ? (
        <textarea
          className={`input ${styles.control} ${styles.textarea}`}
          value={value ?? ''}
          rows={3}
          onChange={(e) => handle(e.target.value)}
        />
      ) : (
        <input
          className={`input ${styles.control}`}
          value={value ?? ''}
          list={list}
          placeholder={optional ? 'padrão' : undefined}
          onChange={(e) => handle(e.target.value)}
        />
      )}
    </Field>
  )
}

const HEX = /^#[0-9a-f]{6}$/i

function toHex(color: string | undefined): string {
  if (!color) return '#000000'
  if (HEX.test(color)) return color
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join('')}`
  return '#000000'
}

/** Color picker plus free text (named colors, rgba() …). */
export function ColorField({
  label,
  value,
  onChange,
  optional
}: {
  label: string
  value: string | undefined
  onChange(v: string | undefined): void
  optional?: boolean
}) {
  return (
    <Field label={label}>
      <div className={styles.colorRow}>
        <input className={styles.swatch} type="color" value={toHex(value)} onChange={(e) => onChange(e.target.value)} />
        <input
          className={`input ${styles.control}`}
          value={value ?? ''}
          placeholder={optional ? 'nenhuma' : undefined}
          onChange={(e) => onChange(optional && e.target.value === '' ? undefined : e.target.value)}
        />
      </div>
    </Field>
  )
}

export function SelectField<T extends string>(props: {
  label: string
  value: T | undefined
  options: { value: T | ''; label: string }[]
  onChange(v: T | undefined): void
}) {
  const { label, value, options, onChange } = props
  return (
    <Field label={label}>
      <select
        className={`input ${styles.control}`}
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function CheckField({ label, value, onChange }: { label: string; value: boolean; onChange(v: boolean): void }) {
  return (
    <label className={`${styles.field} ${styles.check}`}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <strong>{title}</strong>
        <div className={styles.flex} />
        {actions}
      </div>
      {children}
    </section>
  )
}
