// The event stream behind the live workflow graph (src/shared/flow.ts) of a Hangar-engine session: the harness
// events the graph reads, slimmed, appended to <userData>/hangar-data/flow/<sessionId>.jsonl (so the graph is there
// again after a restart) and sent to the renderer as they happen.
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { broadcast } from '../../../core/broadcast'
import { ENGINE } from '../../../../shared/features/engine'
import { FLOW_EVENT_TYPES, type FlowEvent } from '../../../../shared/flow'

const MAX_EVENTS = 6000
const MAX_STRING = 400

function flowDir(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'flow')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function fileOf(sessionId: string): string {
  return join(flowDir(), `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`)
}

/** Long strings (file contents in tool arguments, outputs) are cut: the graph shows a summary and a tooltip. */
function slim(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  if (Array.isArray(value)) return depth > 3 ? [] : value.slice(0, 40).map((v) => slim(v, depth + 1))
  if (value && typeof value === 'object') {
    if (depth > 3) return {}
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, slim(v, depth + 1)]))
  }
  return value
}

/** Records one event of the session's graph; `mask` hides the profile's secrets. */
export function recordFlow(sessionId: string, ev: FlowEvent, mask: (text: string) => string = (t) => t): void {
  if (ev.type !== 'turn' && ev.type !== 'turn_end' && !FLOW_EVENT_TYPES.has(ev.type)) return
  const { output: _output, seq: _seq, ...rest } = ev as FlowEvent & { output?: unknown; seq?: unknown }
  let event: FlowEvent
  try {
    event = JSON.parse(mask(JSON.stringify(slim(rest)))) as FlowEvent
  } catch {
    return
  }
  try {
    appendFileSync(fileOf(sessionId), `${JSON.stringify(event)}\n`, 'utf8')
  } catch {
    // The live graph still works without the file.
  }
  broadcast(ENGINE.evFlow, { sessionId, event })
}

/** Everything recorded for a session, oldest first (the last MAX_EVENTS). */
export function readFlow(sessionId: string): FlowEvent[] {
  let text: string
  try {
    text = readFileSync(fileOf(sessionId), 'utf8')
  } catch {
    return []
  }
  const events: FlowEvent[] = []
  for (const line of text.split('\n').slice(-MAX_EVENTS)) {
    if (!line) continue
    try {
      events.push(JSON.parse(line) as FlowEvent)
    } catch {
      // A torn last line.
    }
  }
  return events
}

export function deleteFlow(sessionId: string): void {
  rmSync(fileOf(sessionId), { force: true })
}
