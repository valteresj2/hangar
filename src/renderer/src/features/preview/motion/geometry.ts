// Approximate on-canvas bounds of motion elements, for click selection, dragging and the selection outline.
import { sceneAt, sceneStart, type MotionElement, type MotionScene, type MotionSpec } from '@shared/motion/spec'
import { elementState } from '@renderer/motion/runtime'

export interface Bounds {
  /** Center, in spec pixels. */
  cx: number
  cy: number
  width: number
  height: number
  /** Degrees. */
  rotation: number
}

const DEFAULT_FONT = "'Segoe UI', Arial, sans-serif"
let measureCtx: OffscreenCanvasRenderingContext2D | null | undefined

function measure(text: string, fontCss: string): number {
  measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d')
  if (!measureCtx) return text.length * 10
  measureCtx.font = fontCss
  return measureCtx.measureText(text).width
}

function textLines(text: string, fontCss: string, maxWidth: number | undefined): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!maxWidth) {
      out.push(paragraph)
      continue
    }
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (line && measure(candidate, fontCss) > maxWidth) {
        out.push(line)
        line = word
      } else line = candidate
    }
    out.push(line)
  }
  return out
}

/** Unscaled size of an element (before its animated scale). */
export function elementSize(el: MotionElement, specFont?: string): { width: number; height: number } {
  switch (el.type) {
    case 'shape':
      if (el.shape === 'line' || el.shape === 'arrow')
        return { width: el.width, height: Math.max((el.strokeWidth ?? 6) * 3, 24) }
      return { width: el.width, height: el.height ?? el.width }
    case 'image':
    case 'chart':
      return { width: el.width, height: el.height }
    case 'text': {
      const fontCss = `${el.fontWeight ?? 400} ${el.fontSize}px ${el.fontFamily ?? specFont ?? DEFAULT_FONT}`
      const lines = textLines(el.text, fontCss, el.maxWidth)
      const width = el.maxWidth ?? Math.max(...lines.map((l) => measure(l, fontCss)), el.fontSize * 0.5)
      return { width, height: lines.length * el.fontSize * (el.lineHeight ?? 1.2) }
    }
    case 'counter': {
      const fontCss = `${el.fontWeight ?? 700} ${el.fontSize}px ${el.fontFamily ?? specFont ?? DEFAULT_FONT}`
      const widest = [el.from, el.to].map(
        (v) =>
          `${el.prefix ?? ''}${v.toLocaleString('pt-BR', { minimumFractionDigits: el.decimals ?? 0, maximumFractionDigits: el.decimals ?? 0 })}${el.suffix ?? ''}`
      )
      return { width: Math.max(...widest.map((t) => measure(t, fontCss))), height: el.fontSize * 1.2 }
    }
  }
}

/** Bounds of an element at scene time `t`, or undefined when it is not on screen. */
export function elementBounds(el: MotionElement, scene: MotionScene, t: number, specFont?: string): Bounds | undefined {
  const state = elementState(el, t, scene.duration)
  if (!state) return undefined
  const size = elementSize(el, specFont)
  return {
    cx: state.x,
    cy: state.y,
    width: size.width * state.scale,
    height: size.height * state.scale,
    rotation: state.rotation
  }
}

function contains(b: Bounds, x: number, y: number): boolean {
  const a = (-b.rotation * Math.PI) / 180
  const dx = x - b.cx
  const dy = y - b.cy
  const lx = dx * Math.cos(a) - dy * Math.sin(a)
  const ly = dx * Math.sin(a) + dy * Math.cos(a)
  const pad = 6
  return Math.abs(lx) <= b.width / 2 + pad && Math.abs(ly) <= b.height / 2 + pad
}

/** Topmost element under (x, y) at global `time`, with its scene index. */
export function hitTest(
  spec: MotionSpec,
  time: number,
  x: number,
  y: number
): { sceneIndex: number; elementId: string } | undefined {
  const { index, local } = sceneAt(spec, time)
  const scene = spec.scenes[index]
  if (!scene) return undefined
  for (let i = scene.elements.length - 1; i >= 0; i--) {
    const el = scene.elements[i]
    const b = elementBounds(el, scene, local, spec.fontFamily)
    if (b && contains(b, x, y)) return { sceneIndex: index, elementId: el.id }
  }
  return undefined
}

/** A global time where the element has finished entering (so it is visible and settled). */
export function settledTime(spec: MotionSpec, sceneIndex: number, el?: MotionElement): number {
  const scene = spec.scenes[sceneIndex]
  if (!scene) return 0
  const startAt = sceneStart(spec, sceneIndex)
  if (!el) return startAt + Math.min(scene.duration * 0.5, 2)
  let settle = (el.start ?? 0) + (el.enter ? (el.enter.duration ?? 0.6) : 0)
  if (el.type === 'chart') settle = Math.max(settle, (el.start ?? 0) + (el.growDuration ?? 1.2))
  if (el.type === 'counter') settle = Math.max(settle, (el.start ?? 0) + (el.countDuration ?? 1.5))
  const end = (el.end ?? scene.duration) - (el.exit ? (el.exit.duration ?? 0.6) : 0)
  const local = Math.max(el.start ?? 0, Math.min(settle + 0.05, end - 0.01, scene.duration - 0.001))
  return startAt + local
}
