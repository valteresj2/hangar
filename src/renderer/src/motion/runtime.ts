// Hangar Motion runtime: draws one instant of a MotionSpec on a 2D canvas.
// Pure and deterministic — the same (spec, time, assets) always yields the same pixels — so the player and the
// MP4 exporter share it. Owned by the chief; features import from '@renderer/motion/runtime'.

import {
  sceneAt,
  type ChartElement,
  type CounterElement,
  type Easing,
  type ImageElement,
  type MotionElement,
  type MotionScene,
  type MotionSpec,
  type ShapeElement,
  type TextElement
} from '@shared/motion/spec'

/** Loaded images keyed by the element's `src` string. */
export type MotionAssets = Map<string, CanvasImageSource>

/** On-screen (player) or offscreen (MP4 export) 2D context. */
export type MotionContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const PALETTE = ['#c96442', '#3d6fb6', '#3d8a5a', '#b8860b', '#8a4fbf', '#d9534f']
const DEFAULT_FONT = "'Segoe UI', Arial, sans-serif"

const EASINGS: Record<Easing, (p: number) => number> = {
  linear: (p) => p,
  easeIn: (p) => p * p * p,
  easeOut: (p) => 1 - (1 - p) ** 3,
  easeInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  backOut: (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2
}

const ease = (name: Easing | undefined, p: number, fallback: Easing = 'easeOut'): number =>
  EASINGS[name ?? fallback](clamp01(p))

function clamp01(p: number): number {
  return p < 0 ? 0 : p > 1 ? 1 : p
}

interface ElementState {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
  /** 0..1 progress for typewriter text and drawn lines. */
  reveal: number
}

type AnimatedProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity'
const ANIMATED: AnimatedProp[] = ['x', 'y', 'scale', 'rotation', 'opacity']

/**
 * Draws the frame at global `time` (seconds). The canvas may be any size; the spec is scaled to fit it.
 * Callers must load images first (see loadMotionAssets); missing images draw as placeholders.
 */
export function drawFrame(ctx: MotionContext, spec: MotionSpec, time: number, assets: MotionAssets = new Map()): void {
  const { width, height } = ctx.canvas
  ctx.setTransform(width / spec.width, 0, 0, height / spec.height, 0, 0)
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, spec.width, spec.height)

  const { index, local } = sceneAt(spec, time)
  const scene = spec.scenes[index]
  if (!scene) return
  const transition = scene.transition
  const tDur = transition?.duration ?? 0.5

  if (index > 0 && transition && transition.type !== 'none' && local < tDur) {
    const prev = spec.scenes[index - 1]
    const p = ease('easeInOut', local / tDur)
    if (transition.type === 'fade') {
      drawScene(ctx, spec, prev, prev.duration, assets, 1, 0, 0)
      drawScene(ctx, spec, scene, local, assets, p, 0, 0)
    } else if (transition.type === 'slide-left') {
      drawScene(ctx, spec, prev, prev.duration, assets, 1, -spec.width * p, 0)
      drawScene(ctx, spec, scene, local, assets, 1, spec.width * (1 - p), 0)
    } else {
      drawScene(ctx, spec, prev, prev.duration, assets, 1, 0, -spec.height * p)
      drawScene(ctx, spec, scene, local, assets, 1, 0, spec.height * (1 - p))
    }
    return
  }
  drawScene(ctx, spec, scene, local, assets, 1, 0, 0)
}

function drawScene(
  ctx: MotionContext,
  spec: MotionSpec,
  scene: MotionScene,
  t: number,
  assets: MotionAssets,
  alpha: number,
  dx: number,
  dy: number
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = scene.background ?? spec.background
  ctx.fillRect(dx, dy, spec.width, spec.height)
  ctx.restore()
  for (const el of scene.elements) {
    const state = elementState(el, t, scene.duration)
    if (!state || state.opacity <= 0) continue
    ctx.save()
    ctx.translate(state.x + dx, state.y + dy)
    if (state.rotation) ctx.rotate((state.rotation * Math.PI) / 180)
    if (state.scale !== 1) ctx.scale(state.scale, state.scale)
    ctx.globalAlpha = alpha * clamp01(state.opacity)
    const local = t - (el.start ?? 0)
    switch (el.type) {
      case 'text':
        drawText(ctx, el, state.reveal, spec.fontFamily)
        break
      case 'shape':
        drawShape(ctx, el, state.reveal)
        break
      case 'image':
        drawImage(ctx, el, assets.get(el.src))
        break
      case 'chart':
        drawChart(ctx, el, local, spec.fontFamily)
        break
      case 'counter':
        drawCounter(ctx, el, local, spec.fontFamily)
        break
    }
    ctx.restore()
  }
}

/** Resolved transform of an element at scene time `t`, or undefined when it is not on screen. */
export function elementState(el: MotionElement, t: number, sceneDuration: number): ElementState | undefined {
  const start = el.start ?? 0
  const end = el.end ?? sceneDuration
  if (t < start || t > end) return undefined

  const s: ElementState = {
    x: el.x,
    y: el.y,
    scale: el.scale ?? 1,
    rotation: el.rotation ?? 0,
    opacity: el.opacity ?? 1,
    reveal: 1
  }
  if (el.keyframes?.length) {
    const sorted = [...el.keyframes].sort((a, b) => a.t - b.t)
    for (const prop of ANIMATED) {
      // The base value acts as an implicit keyframe at the element's start.
      let prevT = start
      let prevV = s[prop]
      for (const kf of sorted) {
        const v = kf[prop]
        if (v === undefined) continue
        if (t >= kf.t) {
          prevT = kf.t
          prevV = v
          s[prop] = v
          continue
        }
        const span = kf.t - prevT
        s[prop] = span > 0 ? prevV + (v - prevV) * ease(kf.easing, (t - prevT) / span, 'easeInOut') : v
        break
      }
    }
  }
  if (el.enter) {
    const p = ease(el.enter.easing, (t - start) / (el.enter.duration ?? 0.6))
    applyPreset(s, el.enter.type, p, 1)
  }
  if (el.exit) {
    const p = ease(el.exit.easing, (end - t) / (el.exit.duration ?? 0.6), 'easeIn')
    applyPreset(s, el.exit.type, p, -1)
  }
  return s
}

/** p = 0 fully hidden, p = 1 fully in place. `dir` flips slide direction for exits. */
function applyPreset(s: ElementState, type: string, p: number, dir: 1 | -1): void {
  const offset = 1 - p
  switch (type) {
    case 'fade':
      s.opacity *= p
      break
    case 'slide-up':
      s.y += offset * 80 * dir
      s.opacity *= p
      break
    case 'slide-down':
      s.y -= offset * 80 * dir
      s.opacity *= p
      break
    case 'slide-left':
      s.x += offset * 120 * dir
      s.opacity *= p
      break
    case 'slide-right':
      s.x -= offset * 120 * dir
      s.opacity *= p
      break
    case 'scale':
      s.scale *= p
      s.opacity *= Math.min(1, p * 2)
      break
    case 'typewriter':
    case 'draw':
      s.reveal = Math.min(s.reveal, p)
      break
  }
}

function font(
  weight: number | undefined,
  size: number,
  family: string | undefined,
  fallback: string | undefined
): string {
  return `${weight ?? 400} ${size}px ${family ?? fallback ?? DEFAULT_FONT}`
}

function wrapLines(ctx: MotionContext, text: string, maxWidth: number | undefined): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!maxWidth) {
      out.push(paragraph)
      continue
    }
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (line && ctx.measureText(candidate).width > maxWidth) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out
}

function drawText(ctx: MotionContext, el: TextElement, reveal: number, specFont?: string): void {
  ctx.font = font(el.fontWeight, el.fontSize, el.fontFamily, specFont)
  ctx.fillStyle = el.color
  ctx.textBaseline = 'middle'
  const lines = wrapLines(ctx, el.text, el.maxWidth)
  const lh = el.fontSize * (el.lineHeight ?? 1.2)
  const blockWidth = el.maxWidth ?? Math.max(...lines.map((l) => ctx.measureText(l).width))
  const align = el.align ?? 'center'
  ctx.textAlign = align
  const x = align === 'center' ? 0 : align === 'left' ? -blockWidth / 2 : blockWidth / 2

  let budget = reveal >= 1 ? Infinity : Math.floor(lines.reduce((n, l) => n + l.length, 0) * reveal)
  lines.forEach((line, i) => {
    if (budget <= 0) return
    const visible = line.slice(0, budget)
    budget -= line.length
    ctx.fillText(visible, x, (i - (lines.length - 1) / 2) * lh)
  })
}

function drawShape(ctx: MotionContext, el: ShapeElement, reveal: number): void {
  const w = el.width
  const h = el.height ?? el.width
  if (el.shape === 'line' || el.shape === 'arrow') {
    const len = w * reveal
    if (len <= 0) return
    ctx.strokeStyle = el.stroke ?? el.fill ?? '#1f1e1d'
    ctx.lineWidth = el.strokeWidth ?? 6
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-w / 2, 0)
    ctx.lineTo(-w / 2 + len, 0)
    ctx.stroke()
    if (el.shape === 'arrow') {
      const head = Math.max(ctx.lineWidth * 3, 18)
      const tip = -w / 2 + len
      ctx.fillStyle = ctx.strokeStyle
      ctx.beginPath()
      ctx.moveTo(tip + ctx.lineWidth / 2, 0)
      ctx.lineTo(tip - head, -head * 0.6)
      ctx.lineTo(tip - head, head * 0.6)
      ctx.closePath()
      ctx.fill()
    }
    return
  }
  ctx.beginPath()
  if (el.shape === 'circle') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
  else ctx.roundRect(-w / 2, -h / 2, w, h, el.radius ?? 0)
  if (el.fill) {
    ctx.fillStyle = el.fill
    ctx.fill()
  }
  if (el.stroke) {
    ctx.strokeStyle = el.stroke
    ctx.lineWidth = el.strokeWidth ?? 4
    ctx.stroke()
  }
}

function drawImage(ctx: MotionContext, el: ImageElement, img: CanvasImageSource | undefined): void {
  const { width: w, height: h } = el
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(-w / 2, -h / 2, w, h, el.radius ?? 0)
  ctx.clip()
  if (!img) {
    ctx.fillStyle = '#e3e0d6'
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.restore()
    return
  }
  const iw = (img as HTMLImageElement).naturalWidth || (img as ImageBitmap).width || w
  const ih = (img as HTMLImageElement).naturalHeight || (img as ImageBitmap).height || h
  const ratio = el.fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih)
  const dw = iw * ratio
  const dh = ih * ratio
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
}

function formatNumber(v: number, decimals = 0, prefix = '', suffix = ''): string {
  return (
    prefix + v.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix
  )
}

function drawChart(ctx: MotionContext, el: ChartElement, local: number, specFont?: string): void {
  const g = ease('easeOut', local / (el.growDuration ?? 1.2))
  const fs = el.fontSize ?? 28
  const text = el.textColor ?? '#1f1e1d'
  const axis = el.axisColor ?? '#d6d3c9'
  ctx.font = font(500, fs, undefined, specFont)
  ctx.textBaseline = 'middle'
  const color = (k: number) => el.series[k]?.color ?? PALETTE[k % PALETTE.length]
  const fmt = (v: number) => formatNumber(v, el.decimals, el.valuePrefix, el.valueSuffix)

  if (el.chart === 'pie') {
    const values = el.series[0]?.values ?? []
    const total = values.reduce((a, b) => a + Math.max(b, 0), 0) || 1
    const r = Math.min(el.width, el.height) / 2 - fs
    let angle = -Math.PI / 2
    values.forEach((v, i) => {
      const sweep = (Math.max(v, 0) / total) * Math.PI * 2 * g
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.arc(0, 0, r, angle, angle + sweep)
      ctx.closePath()
      ctx.fillStyle = el.series[0]?.color && values.length === 1 ? el.series[0].color : PALETTE[i % PALETTE.length]
      ctx.fill()
      if (el.showValues !== false && g > 0.6) {
        const mid = angle + sweep / 2
        ctx.save()
        ctx.globalAlpha *= (g - 0.6) / 0.4
        ctx.fillStyle = '#ffffff'
        ctx.textAlign = 'center'
        ctx.fillText(el.labels[i] ?? '', Math.cos(mid) * r * 0.62, Math.sin(mid) * r * 0.62 - fs * 0.6)
        ctx.fillText(fmt(v), Math.cos(mid) * r * 0.62, Math.sin(mid) * r * 0.62 + fs * 0.6)
        ctx.restore()
      }
      angle += sweep
    })
    return
  }

  const labelH = fs * 1.8
  const left = -el.width / 2
  const right = el.width / 2
  const top = -el.height / 2 + fs * 1.5
  const base = el.height / 2 - labelH
  const plotH = base - top
  const max = Math.max(1e-9, ...el.series.flatMap((s) => s.values))
  const n = el.labels.length || 1
  const groupW = (right - left) / n

  ctx.strokeStyle = axis
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(left, base)
  ctx.lineTo(right, base)
  ctx.stroke()

  ctx.fillStyle = text
  ctx.textAlign = 'center'
  el.labels.forEach((label, i) => ctx.fillText(label, left + groupW * (i + 0.5), base + labelH / 2))

  if (el.chart === 'bar') {
    const m = el.series.length || 1
    const barW = (groupW * 0.7) / m
    el.series.forEach((series, k) => {
      series.values.forEach((v, i) => {
        const h = (Math.max(v, 0) / max) * plotH * g
        const x = left + groupW * i + groupW * 0.15 + barW * k
        ctx.fillStyle = color(k)
        ctx.beginPath()
        ctx.roundRect(x, base - h, barW - 4, h, [6, 6, 0, 0])
        ctx.fill()
        if (el.showValues !== false && g > 0) {
          ctx.fillStyle = text
          ctx.fillText(fmt(v * g), x + (barW - 4) / 2, base - h - fs * 0.8)
        }
      })
    })
    return
  }

  // Line chart: the path is revealed left to right.
  el.series.forEach((series, k) => {
    const pts = series.values.map((v, i) => [left + groupW * (i + 0.5), base - (v / max) * plotH] as const)
    if (pts.length === 0) return
    const span = pts[pts.length - 1][0] - pts[0][0]
    const limit = pts[0][0] + span * g
    ctx.strokeStyle = color(k)
    ctx.lineWidth = 6
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]
      const [x1, y1] = pts[i]
      if (x1 <= limit) ctx.lineTo(x1, y1)
      else {
        if (limit > x0) ctx.lineTo(limit, y0 + ((y1 - y0) * (limit - x0)) / (x1 - x0))
        break
      }
    }
    ctx.stroke()
    ctx.fillStyle = color(k)
    for (const [x, y] of pts) {
      if (x > limit + 0.5) break
      ctx.beginPath()
      ctx.arc(x, y, 8, 0, Math.PI * 2)
      ctx.fill()
    }
    if (el.showValues && g >= 1) {
      ctx.fillStyle = text
      series.values.forEach((v, i) => ctx.fillText(fmt(v), pts[i][0], pts[i][1] - fs))
    }
  })
}

function drawCounter(ctx: MotionContext, el: CounterElement, local: number, specFont?: string): void {
  const g = ease('easeOut', local / (el.countDuration ?? 1.5))
  ctx.font = font(el.fontWeight ?? 700, el.fontSize, el.fontFamily, specFont)
  ctx.fillStyle = el.color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(formatNumber(el.from + (el.to - el.from) * g, el.decimals, el.prefix, el.suffix), 0, 0)
}

/** Every distinct image `src` the spec references. */
export function imageSources(spec: MotionSpec): string[] {
  const set = new Set<string>()
  for (const scene of spec.scenes) for (const el of scene.elements) if (el.type === 'image') set.add(el.src)
  return [...set]
}

/**
 * Loads the spec's images. `resolve` maps an element `src` to a URL the renderer can load
 * (e.g. through the preview artifact server); images that fail are skipped (drawn as placeholders).
 */
export async function loadMotionAssets(spec: MotionSpec, resolve: (src: string) => string): Promise<MotionAssets> {
  const assets: MotionAssets = new Map()
  await Promise.all(
    imageSources(spec).map(
      (src) =>
        new Promise<void>((done) => {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            assets.set(src, img)
            done()
          }
          img.onerror = () => done()
          img.src = src.startsWith('data:') ? src : resolve(src)
        })
    )
  )
  return assets
}
