// Is the person using the computer? (pure, unit-tested). The helper reports the last input Windows saw and the end of
// our own last injection in the same clock; input after our injection (beyond a small grace) is the person's, and so is
// the cursor leaving the spot where we left it. The employee acts only after `resumeAfterMs` without the person's input
// (or when the person says "Retomar agora"), and an action whose screen the model saw before the person's input is not
// executed blind: the model is told to look again.
import type { IdleReading } from './driver/types'

export type PresenceState = 'free' | 'paused' | 'locked'

const GRACE_MS = 250
const CURSOR_SLACK_PX = 3

export class Presence {
  /** Tick of the person's latest input (0 = none seen). */
  lastHuman = 0
  private expectedCursor?: { x: number; y: number }
  private overrideAt = 0
  state: PresenceState = 'free'
  lastNow = 0

  constructor(public resumeAfterMs = 15_000) {}

  /** Feeds a reading; returns the state after it. */
  observe(r: IdleReading): PresenceState {
    this.lastNow = r.now
    const humanKey = r.lastInput - r.lastInjectEnd > GRACE_MS
    const c = this.expectedCursor
    const moved =
      c !== undefined && (Math.abs(r.cursor.x - c.x) > CURSOR_SLACK_PX || Math.abs(r.cursor.y - c.y) > CURSOR_SLACK_PX)
    if (humanKey) this.lastHuman = Math.max(this.lastHuman, r.lastInput)
    if (moved) {
      this.lastHuman = Math.max(this.lastHuman, r.now)
      this.expectedCursor = undefined
    }
    if (r.locked) this.state = 'locked'
    else if (this.lastHuman > this.overrideAt && r.now - this.lastHuman < this.resumeAfterMs) this.state = 'paused'
    else this.state = 'free'
    return this.state
  }

  /** After our own move/click: the cursor is expected there (moving it away is the person). */
  movedTo(x: number, y: number): void {
    this.expectedCursor = { x, y }
  }

  /** "Retomar agora": the person's input so far no longer pauses. */
  override(now = this.lastNow): void {
    this.overrideAt = Math.max(this.lastHuman, now)
    if (this.state === 'paused') this.state = 'free'
  }

  /** The person used the computer after the model's last look (tick of that look): the screen may have changed. */
  staleSince(lookTick: number): boolean {
    return this.lastHuman > 0 && this.lastHuman > lookTick
  }

  /** Seconds until the employee may act again (0 = now). */
  waitS(now = this.lastNow): number {
    if (this.state !== 'paused') return 0
    return Math.max(0, Math.ceil((this.resumeAfterMs - (now - this.lastHuman)) / 1000))
  }
}
