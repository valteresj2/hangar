import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../src/renderer/src/', import.meta.url)
const tokens = JSON.parse(readFileSync(new URL('theme/tokens.json', root), 'utf8'))
const css = readFileSync(new URL('styles.css', root), 'utf8')
const block = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('\n}', css.indexOf(`${sel} {`)))
const decls = (t: string) =>
  Object.fromEntries([...t.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]))
const norm = (v = '') => v.toLowerCase().replace(/'/g, '"').replace(/\s+/g, ' ')
const light = decls(block(':root'))
const dark = { ...light, ...decls(block(":root[data-theme='dark']")) }
const cssName = (k: string) => (k === 'bg' ? '--concrete' : `--${k}`)

describe('design tokens', () => {
  for (const [theme, vals] of [
    ['light', light],
    ['dark', dark]
  ] as const)
    it(`styles.css repeats tokens.json (${theme})`, () => {
      for (const [k, v] of Object.entries(tokens[theme] as Record<string, string>))
        expect(norm(vals[cssName(k)]), k).toBe(norm(v))
    })
  it('fonts and radii', () => {
    for (const [k, v] of Object.entries(tokens.fonts as Record<string, string>))
      expect(norm(light[`--f-${k}`]), k).toBe(norm(v))
    expect([light['--r'], light['--r-lg']]).toEqual([tokens.radius.r, tokens.radius.r_lg])
  })
})
