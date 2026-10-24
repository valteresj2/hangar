// xterm theme derived from the app's CSS variables; ANSI palettes tuned per light/dark.
import type { ITheme } from '@xterm/xterm'

const LIGHT_ANSI: ITheme = {
  black: '#1f1e1d',
  red: '#b3392b',
  green: '#2f7a4b',
  yellow: '#8f6a00',
  blue: '#2f5fb3',
  magenta: '#8a3fa0',
  cyan: '#1f7a87',
  // "white" is often used as plain text color by shells; keep it readable on the light background.
  white: '#6f6e69',
  brightBlack: '#6b6a66',
  brightRed: '#d0473a',
  brightGreen: '#3d8a5a',
  brightYellow: '#a67c00',
  brightBlue: '#3b73d1',
  brightMagenta: '#a24fbb',
  brightCyan: '#2a90a0',
  brightWhite: '#b5b3ad'
}

const DARK_ANSI: ITheme = {
  black: '#3a3a38',
  red: '#e06c5a',
  green: '#5cb07a',
  yellow: '#d9a83a',
  blue: '#6fa3e8',
  magenta: '#c88ae0',
  cyan: '#5fbfc9',
  white: '#d6d5cf',
  brightBlack: '#7a7974',
  brightRed: '#f08a7a',
  brightGreen: '#7cc994',
  brightYellow: '#ecc25e',
  brightBlue: '#8fbaf2',
  brightMagenta: '#d9a6ec',
  brightCyan: '#7fd3db',
  brightWhite: '#ffffff'
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color
}

export function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

export function terminalTheme(): ITheme {
  const background = cssVar('--bg-sunken') || (isDarkTheme() ? '#141413' : '#f0eee6')
  const accent = cssVar('--accent') || '#c96442'
  return {
    background,
    foreground: cssVar('--text') || (isDarkTheme() ? '#ecebe6' : '#1f1e1d'),
    cursor: accent,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, '4d'),
    scrollbarSliderBackground: withAlpha(cssVar('--text-muted'), '40'),
    scrollbarSliderHoverBackground: withAlpha(cssVar('--text-muted'), '66'),
    scrollbarSliderActiveBackground: withAlpha(cssVar('--text-muted'), '80'),
    ...(isDarkTheme() ? DARK_ANSI : LIGHT_ANSI)
  }
}

export function terminalFont(): string {
  return cssVar('--mono') || "'Cascadia Code', Consolas, monospace"
}

/** Calls `cb` whenever the app switches between light and dark. Returns an unsubscribe function. */
export function onThemeChange(cb: () => void): () => void {
  const observer = new MutationObserver(cb)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}
