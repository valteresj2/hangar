// Motion player: a responsive canvas drawn with the shared runtime, transport controls and a scene timeline.
// In edit mode a click selects the element under the cursor and dragging moves it.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { sceneAt, sceneStart, totalDuration, type MotionSpec } from '@shared/motion/spec'
import { drawFrame, type MotionAssets } from '@renderer/motion/runtime'
import { elementBounds, hitTest } from './geometry'
import styles from './motion.module.css'

export interface PlayerController {
  seek(time: number): void
  pause(): void
  time(): number
}

export type DragPhase = 'start' | 'move' | 'end'

interface Props {
  spec: MotionSpec
  assets: MotionAssets
  editing: boolean
  selectedId?: string
  onSelect?(hit: { sceneIndex: number; elementId: string } | undefined): void
  onDrag?(elementId: string, x: number, y: number, phase: DragPhase): void
  controllerRef?: Ref<PlayerController>
  /** Extra buttons on the right of the transport bar. */
  actions?: ReactNode
}

const SPEEDS = [0.5, 1, 2]

function formatTime(t: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function Player({ spec, assets, editing, selectedId, onSelect, onDrag, controllerRef, actions }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const total = totalDuration(spec)

  const seek = useCallback(
    (t: number) => {
      timeRef.current = Math.min(Math.max(t, 0), total)
      setTime(timeRef.current)
    },
    [total]
  )

  useImperativeHandle(controllerRef, () => ({ seek, pause: () => setPlaying(false), time: () => timeRef.current }), [seek])

  // Keep the playhead inside the animation when the spec changes (reload from disk, edits).
  useEffect(() => {
    if (timeRef.current > total) seek(total)
  }, [total, seek])

  // Fit the canvas to the stage while keeping the spec's aspect ratio.
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const fit = () => {
      const { clientWidth: w, clientHeight: h } = stage
      const aspect = spec.width / spec.height
      const width = Math.max(1, Math.min(w, h * aspect))
      setBox({ width, height: width / aspect })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [spec.width, spec.height])

  // Draw whenever the instant, the spec, the assets or the size change.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !box.width) return
    // Device pixels, but never more than the spec's own resolution.
    const scale = Math.max(Math.min(window.devicePixelRatio || 1, spec.width / box.width), 0.25)
    const w = Math.max(1, Math.round(box.width * scale))
    const h = Math.max(1, Math.round(box.height * scale))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx) drawFrame(ctx, spec, time, assets)
  }, [spec, assets, time, box])

  // Playback loop.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speed
      last = now
      let t = timeRef.current + dt
      if (t >= total) {
        if (loop && total > 0) t %= total
        else {
          t = total
          setPlaying(false)
        }
      }
      timeRef.current = t
      setTime(t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, loop, total])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const togglePlay = () => {
    if (!playing && timeRef.current >= total) seek(0)
    setPlaying((p) => !p)
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTyping(e.target)) return
    const frame = 1 / spec.fps
    if (e.key === ' ') {
      e.preventDefault()
      togglePlay()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      seek(timeRef.current - (e.shiftKey ? 1 : frame))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      seek(timeRef.current + (e.shiftKey ? 1 : frame))
    } else if (e.key === 'Home') seek(0)
    else if (e.key === 'End') seek(total)
  }

  // ---- timeline scrubbing ----
  const seekFromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    seek(((clientX - rect.left) / rect.width) * total)
  }

  // ---- canvas selection / dragging ----
  const specPoint = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - rect.left) / rect.width) * spec.width, y: ((e.clientY - rect.top) / rect.height) * spec.height }
  }

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    rootRef.current?.focus({ preventScroll: true })
    if (!editing) {
      togglePlay()
      return
    }
    const start = specPoint(e)
    const hit = hitTest(spec, timeRef.current, start.x, start.y)
    onSelect?.(hit)
    if (!hit || !onDrag) return
    const el = spec.scenes[hit.sceneIndex]?.elements.find((x) => x.id === hit.elementId)
    if (!el) return
    setPlaying(false)
    const canvas = e.currentTarget
    canvas.setPointerCapture(e.pointerId)
    const base = { x: el.x, y: el.y }
    let moved = false
    const move = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const dx = ((ev.clientX - e.clientX) / rect.width) * spec.width
      const dy = ((ev.clientY - e.clientY) / rect.height) * spec.height
      if (!moved && Math.hypot(dx, dy) < 2) return
      onDrag(hit.elementId, Math.round(base.x + dx), Math.round(base.y + dy), moved ? 'move' : 'start')
      moved = true
    }
    const up = () => {
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      if (moved) onDrag(hit.elementId, NaN, NaN, 'end')
    }
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
  }

  // Selection outline of the selected element at the current instant.
  let outline: ReactNode = null
  if (editing && selectedId && box.width) {
    const { index, local } = sceneAt(spec, time)
    const scene = spec.scenes[index]
    const el = scene?.elements.find((x) => x.id === selectedId)
    const b = el && scene ? elementBounds(el, scene, local, spec.fontFamily) : undefined
    if (b) {
      const k = box.width / spec.width
      outline = (
        <div
          className={styles.outline}
          style={{
            left: (b.cx - b.width / 2) * k,
            top: (b.cy - b.height / 2) * k,
            width: b.width * k,
            height: b.height * k,
            transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined
          }}
        />
      )
    }
  }

  const progress = total > 0 ? (time / total) * 100 : 0

  return (
    <div ref={rootRef} className={`${styles.player} ${fullscreen ? styles.fullscreen : ''}`} tabIndex={0} onKeyDown={onKeyDown}>
      <div ref={stageRef} className={styles.stage}>
        <div className={styles.canvasBox} style={{ width: box.width, height: box.height }}>
          <canvas
            ref={canvasRef}
            className={`${styles.canvas} ${editing ? styles.canvasEditing : ''}`}
            style={{ width: box.width, height: box.height }}
            onPointerDown={onCanvasPointerDown}
          />
          {outline}
        </div>
      </div>

      <div className={styles.timeline}>
        <div className={styles.markers}>
          {spec.scenes.map((scene, i) => (
            <button
              key={scene.id}
              className={styles.marker}
              style={{ left: `${(sceneStart(spec, i) / (total || 1)) * 100}%` }}
              title={`Ir para "${scene.name ?? scene.id}"`}
              onClick={() => seek(sceneStart(spec, i))}
            >
              {scene.name ?? scene.id}
            </button>
          ))}
        </div>
        <div
          ref={trackRef}
          className={styles.track}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            seekFromPointer(e.clientX)
          }}
          onPointerMove={(e) => e.buttons === 1 && seekFromPointer(e.clientX)}
        >
          {spec.scenes.map((scene, i) => (
            <div
              key={scene.id}
              className={styles.segment}
              style={{ left: `${(sceneStart(spec, i) / (total || 1)) * 100}%`, width: `${(scene.duration / (total || 1)) * 100}%` }}
            />
          ))}
          <div className={styles.progress} style={{ width: `${progress}%` }} />
          <div className={styles.playhead} style={{ left: `${progress}%` }} />
        </div>
      </div>

      <div className={styles.transport}>
        <button className="icon-btn" title={playing ? 'Pausar (Espaço)' : 'Tocar (Espaço)'} onClick={togglePlay}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className={`icon-btn ${loop ? styles.on : ''}`} title={loop ? 'Repetir: ligado' : 'Repetir: desligado'} onClick={() => setLoop((v) => !v)}>
          ⟲
        </button>
        <span className={styles.clock}>
          {formatTime(time)} / {formatTime(total)}
        </span>
        <select className={styles.speed} value={speed} title="Velocidade" onChange={(e) => setSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s.toLocaleString('pt-BR')}×
            </option>
          ))}
        </select>
        <div className={styles.flex} />
        {actions}
        <button className="icon-btn" title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} onClick={toggleFullscreen}>
          ⛶
        </button>
      </div>
    </div>
  )
}
