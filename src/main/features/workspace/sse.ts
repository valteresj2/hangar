// The platform's event stream (GET /api/app/events, Server-Sent Events): a spec-following parser and a connection
// that keeps itself up — reconnects with `Last-Event-ID` and exponential backoff, treats a silent stream as dead
// (the platform sends a keepalive comment every 25 s) and polls every 60 s while the stream is down.
// Transport-agnostic (the caller opens the HTTP stream), so it runs in unit tests with fake timers.

export interface SseMessage {
  /** The `id:` of this event, when it had one. */
  id?: string
  /** `event:` (default `message`). */
  event: string
  data: string
}

/** Incremental parser of a text/event-stream (https://html.spec.whatwg.org/#event-stream-interpretation). */
export class SseParser {
  private buffer = ''
  private data: string[] = []
  private event = ''
  private id: string | undefined
  private sawId = false
  /** The last event ID seen so far (what a reconnection sends as Last-Event-ID). */
  lastEventId: string | undefined

  feed(chunk: string): SseMessage[] {
    const out: SseMessage[] = []
    this.buffer += chunk
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer)
      // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
      if (!m || (m[0] === '\r' && m.index === this.buffer.length - 1)) break
      const line = this.buffer.slice(0, m.index)
      this.buffer = this.buffer.slice(m.index + m[0].length)
      const msg = this.line(line)
      if (msg) out.push(msg)
    }
    return out
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return undefined // comment (keepalive)
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.event = value
    else if (field === 'id' && !value.includes('\0')) {
      this.id = value
      this.sawId = true
      this.lastEventId = value
    }
    return undefined
  }

  private dispatch(): SseMessage | undefined {
    const msg: SseMessage | undefined = this.data.length
      ? { event: this.event || 'message', data: this.data.join('\n'), ...(this.sawId ? { id: this.id } : {}) }
      : undefined
    this.data = []
    this.event = ''
    this.sawId = false
    return msg
  }
}

export type StreamStatus = 'connecting' | 'live' | 'polling'

export interface EventStreamDeps {
  /** Opens the stream (resuming after `lastEventId`); throws on HTTP errors. */
  open(lastEventId: string | undefined, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null>
  onMessage(msg: SseMessage): void
  onStatus(status: StreamStatus): void
  /** Called every POLL_MS while the stream is down. */
  poll(): void
  /** The stream is back after being down: events may have been missed. */
  onReconnected(): void
  /** A failed attempt (the caller may check the login). */
  onError?(err: unknown): void
  /** True for errors that mean "this platform has no event stream" (retried rarely). */
  unsupported?(err: unknown): boolean
  random?(): number
}

export const POLL_MS = 60_000
/** No byte for this long (keepalives every 25 s) and the connection is considered dead. */
export const IDLE_MS = 75_000
export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 60_000
export const UNSUPPORTED_RETRY_MS = 10 * 60_000

/** Delay before reconnection attempt `failures` (1, 2, …): 1 s doubling up to 60 s, ±20 % jitter. */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1))
  return Math.round(base * (0.8 + 0.4 * random()))
}

export class EventStream {
  private gen = 0
  private abort: AbortController | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private failures = 0
  private down = false
  private lastId: string | undefined

  constructor(private readonly deps: EventStreamDeps) {}

  get lastEventId(): string | undefined {
    return this.lastId
  }

  get running(): boolean {
    return this.abort !== undefined || this.retryTimer !== undefined
  }

  /** (Re)starts from scratch: a new login means a new stream (no Last-Event-ID). */
  start(): void {
    this.stop()
    this.lastId = undefined
    this.failures = 0
    this.down = false
    const gen = this.gen
    this.deps.onStatus('connecting')
    void this.attempt(gen)
  }

  stop(): void {
    this.gen++
    this.abort?.abort()
    this.abort = undefined
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.stopPolling()
  }

  /** Drops the current connection now and reconnects (e.g. after the computer wakes up). */
  reconnect(): void {
    if (!this.running) return
    const gen = this.gen
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      void this.attempt(gen)
    } else this.abort?.abort()
  }

  private startPolling(): void {
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.deps.poll(), POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  private async attempt(gen: number): Promise<void> {
    this.retryTimer = undefined
    if (gen !== this.gen) return
    const ac = new AbortController()
    this.abort = ac
    let delay: number
    try {
      const body = await this.deps.open(this.lastId, ac.signal)
      if (gen !== this.gen) return
      if (!body) throw new Error('event stream without a body')
      this.stopPolling()
      this.deps.onStatus('live')
      if (this.down) this.deps.onReconnected()
      this.down = false
      const clean = await this.read(body, ac, gen)
      if (gen !== this.gen) return
      // Ended (or went silent): reconnect soon, but a platform that keeps closing at once still backs off.
      this.failures++
      delay = backoffDelay(this.failures, this.deps.random ?? Math.random)
      if (clean) {
        // The platform closes long streams on purpose (every 30 min): resume quietly, still "live" — the events in
        // between come back through Last-Event-ID. Only a failed reconnection switches to polling.
        this.retryTimer = setTimeout(() => void this.attempt(gen), delay)
        return
      }
    } catch (err) {
      if (gen !== this.gen) return
      this.failures++
      delay = this.deps.unsupported?.(err)
        ? UNSUPPORTED_RETRY_MS
        : backoffDelay(this.failures, this.deps.random ?? Math.random)
      this.deps.onError?.(err)
    } finally {
      if (this.abort === ac) this.abort = undefined
    }
    if (gen !== this.gen) return
    this.down = true
    this.deps.onStatus('polling')
    this.startPolling()
    this.retryTimer = setTimeout(() => void this.attempt(gen), delay)
  }

  /** Reads until the stream ends; true for a clean end (bytes came, not cut by the idle timer or reconnect()). */
  private async read(body: ReadableStream<Uint8Array>, ac: AbortController, gen: number): Promise<boolean> {
    let gotBytes = false
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    let idle = setTimeout(() => ac.abort(), IDLE_MS)
    const onAbort = () => void reader.cancel().catch(() => undefined)
    ac.signal.addEventListener('abort', onAbort)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || gen !== this.gen || ac.signal.aborted) break
        clearTimeout(idle)
        idle = setTimeout(() => ac.abort(), IDLE_MS)
        // Bytes (events or keepalives) arrive: the connection works.
        this.failures = 0
        gotBytes = true
        for (const msg of parser.feed(decoder.decode(value, { stream: true }))) {
          if (gen !== this.gen) return false
          if (msg.id !== undefined) this.lastId = msg.id
          this.deps.onMessage(msg)
        }
      }
    } finally {
      clearTimeout(idle)
      ac.signal.removeEventListener('abort', onAbort)
      void reader.cancel().catch(() => undefined)
    }
    return gotBytes && !ac.signal.aborted
  }
}
