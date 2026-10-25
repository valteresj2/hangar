// In-memory undo/redo for the motion editor. Changes with the same key in quick succession
// (typing in a field, dragging an element) collapse into a single undo step.
import { useCallback, useRef, useState } from 'react'

const COALESCE_MS = 800
const LIMIT = 200

interface HistoryState<T> {
  past: T[]
  present: T
  future: T[]
}

export interface History<T> {
  value: T
  canUndo: boolean
  canRedo: boolean
  /** Applies `next`; `key` groups rapid edits of the same thing into one step. */
  set(next: T, key?: string): void
  undo(): void
  redo(): void
  /** Replaces everything (e.g. after loading from disk). */
  reset(value: T): void
}

export function useHistory<T>(initial: T): History<T> {
  const [state, setState] = useState<HistoryState<T>>({ past: [], present: initial, future: [] })
  const last = useRef<{ key?: string; at: number }>({ at: 0 })

  const set = useCallback((next: T, key?: string) => {
    const now = Date.now()
    const merge = !!key && last.current.key === key && now - last.current.at < COALESCE_MS
    last.current = { key, at: now }
    setState((s) =>
      s.present === next
        ? s
        : { past: merge ? s.past : [...s.past, s.present].slice(-LIMIT), present: next, future: [] }
    )
  }, [])

  const undo = useCallback(() => {
    last.current = { at: 0 }
    setState((s) =>
      s.past.length
        ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] }
        : s
    )
  }, [])

  const redo = useCallback(() => {
    last.current = { at: 0 }
    setState((s) =>
      s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s
    )
  }, [])

  const reset = useCallback((value: T) => {
    last.current = { at: 0 }
    setState({ past: [], present: value, future: [] })
  }, [])

  return {
    value: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    set,
    undo,
    redo,
    reset
  }
}
