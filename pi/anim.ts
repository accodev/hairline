// The speed slot's scramble and the dot line, as in hooks/slot.tsx and hooks/speed.tsx. Pi has no
// Client modules, so the footer's own timer calls tick() and redraws the line.

// When the phase changes, every cell that held or will hold a character shows random ones, then
// the cells settle on the new text from left to right, one each frame after the first SETTLE_AT.
const SETTLE_AT = 2
const NOISE = 'abcdefghijklmnopqrstuvwxyz0123456789/'
const SENDING_STEP_MS = 100 // the sending time shows tenths of a second

// Steps through NOISE by frame and cell, so neighbouring cells differ and a test sees the same frames.
const noise = (frame: number, cell: number) => NOISE[(frame * 7 + cell * 13) % NOISE.length]!

export function frameText(from: string, to: string, frame: number): string {
  return Array.from(to, (char, cell) => {
    if (frame >= SETTLE_AT + cell) return char
    return char === ' ' && (from[cell] ?? ' ') === ' ' ? ' ' : noise(frame, cell)
  }).join('')
}

// The time since the request went out, in the slot's width: 4.1s, 12.8s.
export function sendingText(ms: number, width: number): string {
  return `${(Math.floor(ms / SENDING_STEP_MS) / 10).toFixed(1)}s`.padStart(width)
}

export type Slot = { kind: string; from: string; frame: number; shown: string }

export const newSlot = (): Slot => ({ kind: 'idle', from: '', frame: Number.POSITIVE_INFINITY, shown: '' })

// A change of kind scrambles from what the slot shows; a change of text alone does not.
export function setSlotKind(s: Slot, kind: string, text: string): void {
  if (s.kind === kind) return
  s.from = s.shown || text
  s.kind = kind
  s.frame = 0
}

export function tickSlot(s: Slot, width: number): void {
  if (!Number.isFinite(s.frame)) return
  s.frame = s.frame + 1 >= SETTLE_AT + width ? Number.POSITIVE_INFINITY : s.frame + 1
}

export const isScrambling = (s: Slot) => Number.isFinite(s.frame)

export function slotText(s: Slot, target: string): string {
  s.shown = frameText(s.from, target, s.frame)
  return s.shown
}

const SHIFT_MS = 60
const CELLS = 6
const SAMPLES = CELLS * 2 // a braille cell holds 2 columns of 4 dots
// Unicode added the bottom braille row last, so its bits (0x40, 0x80) break the order.
const DOTS = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]] as const
const MIN_SPAN = 0.2 // of the peak: a steadier stream than that would draw noise as big swings
const SWEEP_MS = 1200
const SWEEP_HALF_WIDTH = 2 // samples on each side of the bump's top

// From the lowest recent sample to the peak, so a steady 100 to 140 t/s fills the height.
function scale(samples: number[], top: number, isLive: boolean): (v: number) => number {
  const low = isLive ? Math.min(...samples) : 0
  const span = Math.max(top - low, top * MIN_SPAN)
  return v => Math.min(1, Math.max(0, (v - low) / span))
}

// Each column also lights the rows up to the previous sample, so steep steps stay joined.
export function dotLine(samples: number[], at: (v: number) => number): string {
  const rows = samples.map(v => 3 - Math.round(at(v) * 3))
  let line = ''
  for (let cell = 0; cell < CELLS; cell++) {
    let bits = 0
    for (const side of [0, 1] as const) {
      const i = cell * 2 + side
      const from = Math.min(rows[i]!, rows[i - 1] ?? rows[i]!)
      const to = Math.max(rows[i]!, rows[i - 1] ?? rows[i]!)
      for (let r = from; r <= to; r++) bits |= DOTS[side][r]!
    }
    line += String.fromCharCode(0x2800 + bits)
  }
  return line
}

// The samples of the bump at `ms` into the sweep; it starts and ends outside the line. A sweep
// runs while a request is out and nothing has come back, so the wait shows as motion.
export function sweepBars(ms: number): number[] {
  const at = ((ms % SWEEP_MS) / SWEEP_MS) * (SAMPLES + 2 * SWEEP_HALF_WIDTH) - SWEEP_HALF_WIDTH
  return Array.from({ length: SAMPLES }, (_, i) => Math.max(0, 1 - Math.abs(i - at) / SWEEP_HALF_WIDTH))
}

export type Speed = { shown: number; bars: number[]; top: number; sinceShift: number; sweepMs: number; isSettled: boolean }

export const newSpeed = (): Speed => ({ shown: 0, bars: Array(SAMPLES).fill(0), top: 1, sinceShift: 0, sweepMs: 0, isSettled: true })

// target: the tokens per second while a reply streams, 0 otherwise.
export function tickSpeed(s: Speed, frameMs: number, target: number, isSweeping: boolean): void {
  if (s.isSettled && target === 0 && !isSweeping) return
  const ease = 1 - 0.88 ** (frameMs / 16) // 12% of the gap per 16 ms, whatever the frame interval
  s.shown += (target - s.shown) * ease
  s.sinceShift += frameMs
  const isShift = s.sinceShift >= SHIFT_MS
  s.bars = isShift ? [...s.bars.slice(1), s.shown] : [...s.bars.slice(0, -1), s.shown]
  if (isShift) s.sinceShift = 0
  // The scale freezes when the stream ends, so the falling samples drop on screen. The line runs
  // on until every sample has reached the bottom row.
  if (target > 0) s.top = Math.max(...s.bars, 1)
  s.sweepMs = isSweeping ? s.sweepMs + frameMs : 0
  s.isSettled = target === 0 && !isSweeping && s.bars.every(v => v < s.top / 8)
  if (s.isSettled) s.bars = s.bars.map(() => 0)
}

export function speedDots(s: Speed, isLive: boolean, isSweeping: boolean): string {
  if (isSweeping) {
    const samples = sweepBars(s.sweepMs)
    return dotLine(samples, scale(samples, 1, false))
  }
  return dotLine(s.bars, scale(s.bars, s.top, isLive))
}
