// Small fuzzy matcher for the command palette: substring hits rank first, then in-order
// subsequences, with bonuses for consecutive characters and word starts. Accent-insensitive.

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/** Higher is better; undefined means no match. */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = normalize(query.trim())
  if (!q) return 0
  const t = normalize(text)
  const at = t.indexOf(q)
  if (at >= 0) {
    const wordStart = at === 0 || /[\s\-_/.:·]/.test(t[at - 1])
    return 1000 + (wordStart ? 200 : 0) - at - t.length * 0.1
  }
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    if (ch === ' ') continue
    while (ti < t.length && t[ti] !== ch) ti++
    if (ti >= t.length) return undefined
    score += ti === prev + 1 ? 6 : 1
    if (ti === 0 || /[\s\-_/.:·]/.test(t[ti - 1])) score += 4
    prev = ti
    ti++
  }
  return score - t.length * 0.05
}
