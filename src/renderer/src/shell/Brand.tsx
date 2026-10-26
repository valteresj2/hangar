// The Agent Hangar mark and the window's title bar. The mark is the same drawing build/make-icons.cjs rasterizes for
// the app icons: an outlined hangar with a gabled roof and an open door, on a 1024 grid.
import { BRAND } from '@shared/brand'
import { bridge } from '../core/api'
import styles from './shell.module.css'

// Heavier stroke and wider door below ~32 px (the icons' small variant), so the outline survives small sizes.
const LARGE = 'M232 760 V462 L512 300 L792 462 V760 H694 V530 H330 V760 Z'
const SMALL = 'M196 800 V444 L512 262 L828 444 V800 H656 V572 H368 V800 Z'

export function BrandMark({ size = 20, color = 'var(--mark)' }: { size?: number; color?: string }) {
  const small = size <= 32
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <path
        d={small ? SMALL : LARGE}
        transform={`translate(0 ${small ? -6 : -18})`}
        fill="none"
        stroke={color}
        strokeWidth={small ? 104 : 46}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Wordmark: "Agent Hangar" with the "Desktop" tag. */
export function Wordmark({ large = false }: { large?: boolean }) {
  return (
    <span className={large ? `${styles.wordmark} ${styles.wordmarkLarge}` : styles.wordmark}>
      <span className={styles.wordmarkName}>{BRAND.wordmark}</span>
      <span className={styles.wordmarkTag}>{BRAND.tag}</span>
    </span>
  )
}

/**
 * The window's own title bar (the main window is frameless: titleBarStyle hidden). It is the drag area; Windows and
 * Linux draw their native controls over its right end (titleBarOverlay), macOS its traffic lights at the left.
 */
export function TitleBar() {
  const mac = bridge.platform === 'darwin'
  return (
    <header
      className={`${styles.titleBar} ${mac ? styles.titleBarMac : ''}`}
      style={{ height: BRAND.titleBarHeight }}
      aria-label={BRAND.productName}
    >
      <BrandMark size={18} />
      <Wordmark />
    </header>
  )
}
