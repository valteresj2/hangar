// Conversion between keyboard events and Electron accelerators (for the Quick Entry shortcut).

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/'
}

/** Accelerator key name for a physical key (by `code`, so it doesn't depend on the keyboard layout). */
function keyName(code: string): string | undefined {
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]
  m = /^Digit(\d)$/.exec(code)
  if (m) return m[1]
  m = /^Numpad(\d)$/.exec(code)
  if (m) return `num${m[1]}`
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return CODE_KEYS[code]
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'])

export type RecordResult = { kind: 'partial'; preview: string } | { kind: 'done'; accelerator: string } | { kind: 'invalid'; reason: string }

/** Interprets one keydown while recording. Needs Ctrl, Alt or Win plus a key (F-keys may stand alone). */
export function recordKey(e: KeyboardEvent): RecordResult {
  const mods = [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(
    (m): m is string => !!m
  )
  if (MODIFIER_KEYS.has(e.key)) return { kind: 'partial', preview: formatAccelerator(mods.join('+')) }
  const key = keyName(e.code)
  if (!key) return { kind: 'invalid', reason: 'Tecla não suportada.' }
  const strong = e.ctrlKey || e.altKey || e.metaKey
  if (!strong && !/^F\d+$/.test(key)) return { kind: 'invalid', reason: 'Use Ctrl, Alt ou Win com outra tecla.' }
  return { kind: 'done', accelerator: [...mods, key].join('+') }
}

/** Human-readable form, e.g. `CommandOrControl+Alt+Space` → `Ctrl+Alt+Espaço`. */
export function formatAccelerator(accelerator: string): string {
  if (!accelerator) return ''
  return accelerator
    .split('+')
    .map((part) =>
      part === 'CommandOrControl' || part === 'CmdOrCtrl' || part === 'Control'
        ? 'Ctrl'
        : part === 'Super' || part === 'Meta'
          ? 'Win'
          : part === 'Space'
            ? 'Espaço'
            : part
    )
    .join('+')
}

/** Set while the settings UI records a shortcut, so app-level shortcut handlers stand aside. */
export const shortcutRecorder = { active: false }
