import type { ClientModule } from 'claude-code'

// A Client module, so the scramble and the sending time run on the surface clock without redrawing
// the hint line.

// When the phase changes, every cell that held or will hold a character shows random ones, then
// the cells settle on the new text from left to right, one each frame after the first SETTLE_AT.
const SETTLE_AT = 2
const NOISE = 'abcdefghijklmnopqrstuvwxyz0123456789/'
const SENDING = 'sending' // the phase whose time the slot counts: the request is out, nothing back yet
const SENDING_STEP_MS = 100 // the time shows tenths of a second

export type SlotProps = {
  text: string // the whole slot, already padded to its width
  kind: string // the phase: a change of kind scrambles, a change of text alone does not
  bright: number // the leading cells drawn at full strength; the rest are dim
  frameMs: number
  mono?: boolean
}
type Slot = { kind: string; from: string; frame: number; sendingMs: number }

// Per instance: the terminal and the desktop app each run their own Client of this module.
const shown = new WeakMap<object, string>()
// The props of the last call, for the timer, which outlives the call that started it.
const latest = new WeakMap<object, SlotProps>()

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

const SlotModule: ClientModule<SlotProps, Slot> = (props, surface) => {
  const { Box, Text } = surface.elements
  latest.set(surface, props)
  const s = surface.state
  if (s === undefined) {
    surface.setState({ kind: props.kind, from: props.text, frame: Number.POSITIVE_INFINITY, sendingMs: 0 })
    // One timer for the instance's life, started on its first call. A tick sets state only when
    // the slot changes: a scramble frame, or the sending time's next tenth.
    surface.every(props.frameMs, () => {
      const now = surface.state!
      const current = latest.get(surface)!
      const isScrambling = Number.isFinite(now.frame)
      const isSending = now.kind === SENDING
      if (!isScrambling && !isSending) return
      const frame = isScrambling && now.frame + 1 >= SETTLE_AT + current.text.length ? Number.POSITIVE_INFINITY : now.frame + (isScrambling ? 1 : 0)
      const sendingMs = isSending ? now.sendingMs + current.frameMs : now.sendingMs
      const isNewTenth = Math.floor(sendingMs / SENDING_STEP_MS) !== Math.floor(now.sendingMs / SENDING_STEP_MS)
      if (isScrambling || isNewTenth) surface.setState({ ...now, frame, sendingMs })
    })
  } else if (s.kind !== props.kind) {
    // A change during a scramble restarts it from what the slot shows.
    surface.setState({ kind: props.kind, from: shown.get(surface) ?? props.text, frame: 0, sendingMs: 0 })
  }
  const isCurrent = s !== undefined && s.kind === props.kind
  const frame = s === undefined ? Number.POSITIVE_INFINITY : isCurrent ? s.frame : 0
  const target = props.kind === SENDING ? sendingText(isCurrent ? s.sendingMs : 0, props.text.length) : props.text
  const text = frameText(isCurrent ? s.from : (shown.get(surface) ?? props.text), target, frame)
  shown.set(surface, text)
  const style = props.mono ? { mono: true, size: 'caption' as const } : {}
  return (
    <Box>
      {props.bright > 0 && <Text {...style}>{text.slice(0, props.bright)}</Text>}
      <Text dimColor {...style}>{text.slice(props.bright)}</Text>
    </Box>
  )
}

export default SlotModule
