import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  parseMotion,
  sceneAt,
  sceneStart,
  totalDuration,
  type MotionElement,
  type MotionSpec
} from '@shared/motion/spec'
import { elementState, imageSources } from '@renderer/motion/runtime'

const example = readFileSync(new URL('../../docs/motion/example.motion.json', import.meta.url), 'utf8')

function spec(scenes: { duration: number; elements?: unknown[] }[], extra: Record<string, unknown> = {}): MotionSpec {
  const { spec: s, errors } = parseMotion(
    JSON.stringify({
      version: 1,
      title: 't',
      scenes: scenes.map((x, i) => ({ id: `s${i}`, elements: [], ...x })),
      ...extra
    })
  )
  expect(errors).toEqual([])
  return s!
}

describe('parseMotion', () => {
  it('accepts the bundled example', () => {
    const { spec: s, errors } = parseMotion(example)
    expect(errors).toEqual([])
    expect(s?.title).toBe('Hangar em 12 segundos')
    expect(s?.scenes.map((x) => x.id)).toEqual(['intro', 'numbers', 'closing'])
    expect(s?.scenes.flatMap((x) => x.elements.map((e) => e.type))).toEqual(
      expect.arrayContaining(['shape', 'text', 'chart', 'counter'])
    )
  })

  it('reports invalid JSON instead of throwing', () => {
    const r = parseMotion('{ nope')
    expect(r.spec).toBeUndefined()
    expect(r.errors[0]).toMatch(/^JSON inválido/)
  })

  it('requires at least one scene and a positive duration', () => {
    expect(parseMotion(JSON.stringify({ scenes: [] })).errors).toContain('"scenes" precisa ter ao menos uma cena.')
    expect(parseMotion(JSON.stringify({ scenes: [{ duration: 0, elements: [] }] })).errors).toContain(
      'Cena 1: "duration" precisa ser > 0.'
    )
    expect(parseMotion('[]').errors.length).toBeGreaterThan(0)
  })

  it('rejects unknown element types and elements without x/y', () => {
    const r = parseMotion(
      JSON.stringify({
        scenes: [
          {
            duration: 1,
            elements: [
              { type: 'video', x: 0, y: 0 },
              { id: 'a', type: 'text', text: 'x' }
            ]
          }
        ]
      })
    )
    expect(r.spec).toBeUndefined()
    expect(r.errors).toEqual([
      'Cena 1, elemento 1: "type" inválido.',
      'Cena 1, elemento a: "x" e "y" são obrigatórios.'
    ])
  })

  it('fills defaults, clamps fps and keeps unknown fields and existing ids', () => {
    const r = parseMotion(
      JSON.stringify({
        fps: 500,
        scenes: [
          {
            duration: 2,
            custom: 7,
            elements: [
              { type: 'shape', shape: 'rect', x: 1, y: 2, width: 3 },
              { id: 'keep', type: 'shape', shape: 'circle', x: 0, y: 0, width: 1 }
            ]
          }
        ]
      })
    )
    expect(r.errors).toEqual([])
    const s = r.spec!
    expect([s.width, s.height, s.fps, s.background, s.title]).toEqual([1920, 1080, 60, '#ffffff', 'Motion'])
    expect(s.scenes[0].id).toBe('scene1')
    expect((s.scenes[0] as unknown as { custom: number }).custom).toBe(7)
    expect(s.scenes[0].elements.map((e) => e.id)).toEqual(['s1e1', 'keep'])
    expect(parseMotion(JSON.stringify({ fps: 0, scenes: [{ duration: 1 }] })).spec!.fps).toBe(1)
  })
})

describe('timeline helpers', () => {
  const s = spec([{ duration: 4 }, { duration: 5 }, { duration: 3 }])

  it('totalDuration sums scenes', () => {
    expect(totalDuration(s)).toBe(12)
    expect(totalDuration(parseMotion(example).spec!)).toBe(12)
  })

  it('sceneAt maps global time to scene and local time', () => {
    expect(sceneAt(s, 0)).toEqual({ index: 0, local: 0 })
    expect(sceneAt(s, 3.99)).toEqual({ index: 0, local: 3.99 })
    expect(sceneAt(s, 4)).toEqual({ index: 1, local: 0 })
    expect(sceneAt(s, 9.5)).toEqual({ index: 2, local: 0.5 })
    // Past the end: last scene, clamped to its duration; negative time clamps to 0.
    expect(sceneAt(s, 99)).toEqual({ index: 2, local: 3 })
    expect(sceneAt(s, -1)).toEqual({ index: 0, local: 0 })
  })

  it('sceneStart is the sum of the previous scenes', () => {
    expect([0, 1, 2].map((i) => sceneStart(s, i))).toEqual([0, 4, 9])
  })
})

describe('elementState', () => {
  const base = { id: 'e', type: 'shape', shape: 'rect', x: 100, y: 200, width: 10 } as const

  it('is undefined outside [start, end]', () => {
    const el = { ...base, start: 1, end: 2 } as MotionElement
    expect(elementState(el, 0.5, 5)).toBeUndefined()
    expect(elementState(el, 2.5, 5)).toBeUndefined()
    expect(elementState(el, 1.5, 5)).toMatchObject({ x: 100, y: 200, scale: 1, rotation: 0, opacity: 1, reveal: 1 })
    // end defaults to the scene duration
    expect(elementState(base as MotionElement, 5, 5)).toBeDefined()
    expect(elementState(base as MotionElement, 5.01, 5)).toBeUndefined()
  })

  it('fades in with the enter preset (linear easing)', () => {
    const el = { ...base, enter: { type: 'fade', duration: 1, easing: 'linear' } } as MotionElement
    expect(elementState(el, 0, 5)!.opacity).toBeCloseTo(0)
    expect(elementState(el, 0.25, 5)!.opacity).toBeCloseTo(0.25)
    expect(elementState(el, 2, 5)!.opacity).toBeCloseTo(1)
  })

  it('slides up from 80 px below and slides out on exit', () => {
    const el = {
      ...base,
      enter: { type: 'slide-up', duration: 1, easing: 'linear' },
      exit: { type: 'slide-up', duration: 1, easing: 'linear' }
    } as MotionElement
    expect(elementState(el, 0.5, 4)!.y).toBeCloseTo(240)
    expect(elementState(el, 2, 4)!.y).toBeCloseTo(200)
    // Exit runs over the last second, moving the other way.
    expect(elementState(el, 3.5, 4)!.y).toBeCloseTo(160)
  })

  it('interpolates keyframes from the base value', () => {
    const el = {
      ...base,
      keyframes: [
        { t: 2, x: 300, easing: 'linear' },
        { t: 4, scale: 2, easing: 'linear' }
      ]
    } as MotionElement
    expect(elementState(el, 1, 5)!.x).toBeCloseTo(200)
    expect(elementState(el, 3, 5)!.x).toBeCloseTo(300)
    expect(elementState(el, 3, 5)!.scale).toBeCloseTo(1.75)
    expect(elementState(el, 4.5, 5)!.scale).toBeCloseTo(2)
  })

  it('reveals typewriter text progressively', () => {
    const el = {
      id: 't',
      type: 'text',
      text: 'abcd',
      x: 0,
      y: 0,
      fontSize: 10,
      color: '#000',
      enter: { type: 'typewriter', duration: 2, easing: 'linear' }
    } as MotionElement
    expect(elementState(el, 1, 5)!.reveal).toBeCloseTo(0.5)
    expect(elementState(el, 1, 5)!.opacity).toBe(1)
  })

  it('imageSources lists distinct image srcs', () => {
    const s = spec([
      {
        duration: 1,
        elements: [
          { id: 'a', type: 'image', src: 'a.png', x: 0, y: 0, width: 1, height: 1 },
          { id: 'b', type: 'image', src: 'a.png', x: 0, y: 0, width: 1, height: 1 },
          { id: 'c', type: 'image', src: 'b.png', x: 0, y: 0, width: 1, height: 1 }
        ]
      }
    ])
    expect(imageSources(s)).toEqual(['a.png', 'b.png'])
  })
})
