// Hangar Motion: short animations described as data (`*.motion.json`) and rendered by code.
// Owned by the chief. The runtime (src/renderer/src/motion/runtime.ts) draws any instant `t`
// deterministically, so the player and the MP4 export produce the same frames.
//
// Coordinates are canvas pixels with the origin at the top-left. An element's (x, y) is its CENTER,
// so scale and rotation pivot around it. Times are seconds; element times are relative to their scene.

export const MOTION_EXTENSION = '.motion.json'

/**
 * Renderer DOM event (window.dispatchEvent(new CustomEvent(OPEN_ARTIFACT_EVENT, { detail: { path } })))
 * asking the Artifacts panel to show a file. The sender also calls useUi().openSidePanel('artifacts').
 */
export const OPEN_ARTIFACT_EVENT = 'hangar:artifacts:open'
export interface OpenArtifactDetail {
  path: string
}

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'backOut'

export type EnterPreset =
  'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'scale' | 'typewriter' | 'draw'
export type ExitPreset = 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'scale'

export interface Preset<T extends string> {
  type: T
  /** Seconds. Default 0.6. */
  duration?: number
  easing?: Easing
}

/** Animated properties at scene-relative time `t`. Missing properties keep the element's base value. */
export interface Keyframe {
  t: number
  x?: number
  y?: number
  scale?: number
  rotation?: number
  opacity?: number
  /** Easing used to reach THIS keyframe from the previous one. Default 'easeInOut'. */
  easing?: Easing
}

interface ElementBase {
  /** Stable id; edits (by Claude or the editor) must keep ids. */
  id: string
  x: number
  y: number
  /** Degrees. */
  rotation?: number
  /** 0..1, default 1. */
  opacity?: number
  /** Default 1. */
  scale?: number
  /** Seconds from scene start when the element appears. Default 0. */
  start?: number
  /** Seconds from scene start when it disappears. Default: scene end. */
  end?: number
  enter?: Preset<EnterPreset>
  exit?: Preset<ExitPreset>
  keyframes?: Keyframe[]
}

export interface TextElement extends ElementBase {
  type: 'text'
  text: string
  fontSize: number
  color: string
  fontWeight?: number
  fontFamily?: string
  /** Line alignment inside the text block. Default 'center'. */
  align?: 'left' | 'center' | 'right'
  /** Wrap width in px. Default: no wrapping (explicit \n still breaks lines). */
  maxWidth?: number
  /** Multiple of fontSize. Default 1.2. */
  lineHeight?: number
}

export interface ShapeElement extends ElementBase {
  type: 'shape'
  shape: 'rect' | 'circle' | 'line' | 'arrow'
  /** rect/circle size; for line/arrow, width is the length (drawn horizontally, rotate to aim). */
  width: number
  height?: number
  fill?: string
  stroke?: string
  strokeWidth?: number
  /** Corner radius for rect. */
  radius?: number
}

export interface ImageElement extends ElementBase {
  type: 'image'
  /** Path relative to the .motion.json file, absolute path, or data: URI. */
  src: string
  width: number
  height: number
  fit?: 'contain' | 'cover'
  radius?: number
}

export interface ChartSeries {
  name: string
  values: number[]
  color?: string
}

export interface ChartElement extends ElementBase {
  type: 'chart'
  chart: 'bar' | 'line' | 'pie'
  width: number
  height: number
  labels: string[]
  series: ChartSeries[]
  /** Seconds the data takes to grow in after `start`. Default 1.2. */
  growDuration?: number
  textColor?: string
  axisColor?: string
  fontSize?: number
  /** Show value labels. Default true for bar/pie. */
  showValues?: boolean
  valuePrefix?: string
  valueSuffix?: string
  /** Default 0. */
  decimals?: number
}

export interface CounterElement extends ElementBase {
  type: 'counter'
  from: number
  to: number
  /** Seconds to count after `start`. Default 1.5. */
  countDuration?: number
  decimals?: number
  prefix?: string
  suffix?: string
  fontSize: number
  color: string
  fontWeight?: number
  fontFamily?: string
}

export type MotionElement = TextElement | ShapeElement | ImageElement | ChartElement | CounterElement

export interface SceneTransition {
  type: 'none' | 'fade' | 'slide-left' | 'slide-up'
  /** Seconds at the START of this scene, blending from the previous one. Default 0.5. */
  duration?: number
}

export interface MotionScene {
  id: string
  name?: string
  /** Seconds. */
  duration: number
  background?: string
  transition?: SceneTransition
  elements: MotionElement[]
}

export interface MotionSpec {
  version: 1
  title: string
  /** Default 1920. */
  width: number
  /** Default 1080. */
  height: number
  /** Default 30. */
  fps: number
  background: string
  /** Default font for text/counters. */
  fontFamily?: string
  scenes: MotionScene[]
}

export interface MotionValidation {
  spec?: MotionSpec
  errors: string[]
}

/** Parses and normalizes a .motion.json document. Never throws. */
export function parseMotion(source: string): MotionValidation {
  let raw: any
  try {
    raw = JSON.parse(source)
  } catch (err) {
    return { errors: [`JSON inválido: ${(err as Error).message}`] }
  }
  const errors: string[] = []
  if (!raw || typeof raw !== 'object') return { errors: ['O documento precisa ser um objeto.'] }
  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) errors.push('"scenes" precisa ter ao menos uma cena.')
  const spec: MotionSpec = {
    version: 1,
    title: typeof raw.title === 'string' ? raw.title : 'Motion',
    width: num(raw.width, 1920),
    height: num(raw.height, 1080),
    fps: Math.min(Math.max(num(raw.fps, 30), 1), 60),
    background: typeof raw.background === 'string' ? raw.background : '#ffffff',
    fontFamily: typeof raw.fontFamily === 'string' ? raw.fontFamily : undefined,
    scenes: []
  }
  const kinds = new Set(['text', 'shape', 'image', 'chart', 'counter'])
  ;(Array.isArray(raw.scenes) ? raw.scenes : []).forEach((s: any, i: number) => {
    if (!s || typeof s !== 'object') return errors.push(`Cena ${i + 1}: inválida.`)
    if (!(num(s.duration, 0) > 0)) errors.push(`Cena ${i + 1}: "duration" precisa ser > 0.`)
    const elements: MotionElement[] = []
    ;(Array.isArray(s.elements) ? s.elements : []).forEach((e: any, j: number) => {
      if (!e || !kinds.has(e.type)) return errors.push(`Cena ${i + 1}, elemento ${j + 1}: "type" inválido.`)
      if (typeof e.x !== 'number' || typeof e.y !== 'number')
        errors.push(`Cena ${i + 1}, elemento ${e.id ?? j + 1}: "x" e "y" são obrigatórios.`)
      elements.push({ ...e, id: typeof e.id === 'string' ? e.id : `s${i + 1}e${j + 1}` })
    })
    spec.scenes.push({
      ...s,
      id: typeof s.id === 'string' ? s.id : `scene${i + 1}`,
      duration: num(s.duration, 1),
      elements
    })
  })
  return { spec: errors.length ? undefined : spec, errors }
}

export function totalDuration(spec: MotionSpec): number {
  return spec.scenes.reduce((sum, s) => sum + s.duration, 0)
}

/** Scene index and scene-relative time for a global time. */
export function sceneAt(spec: MotionSpec, time: number): { index: number; local: number } {
  let acc = 0
  for (let i = 0; i < spec.scenes.length; i++) {
    const d = spec.scenes[i].duration
    if (time < acc + d || i === spec.scenes.length - 1) return { index: i, local: Math.min(Math.max(time - acc, 0), d) }
    acc += d
  }
  return { index: 0, local: 0 }
}

/** Global start time of a scene. */
export function sceneStart(spec: MotionSpec, index: number): number {
  return spec.scenes.slice(0, index).reduce((sum, s) => sum + s.duration, 0)
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
