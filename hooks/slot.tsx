import type { ClientModule } from 'claude-code'

// A Client module, so the scramble runs on the surface clock without redrawing the hint line.

// When the phase changes, every cell that held or will hold a character shows random ones, then
// the cells settle on the new text from left to right, one each frame after the first SETTLE_AT.
const SETTLE_AT = 2
const NOISE = 'abcdefghijklmnopqrstuvwxyz0123456789/'

export type SlotProps = {
  text: string // the whole slot, already padded to its width
  kind: string // the phase: a change of kind scrambles, a change of text alone does not
  bright: number // the leading cells drawn at full strength; the rest are dim
  frameMs: number
  mono?: boolean
}
type Scramble = { kind: string; from: string; frame: number; ticking: boolean }

// Per instance: the terminal and the desktop app each run their own Client of this module.
const shown = new WeakMap<object, string>()

// Steps through NOISE by frame and cell, so neighbouring cells differ and a test sees the same frames.
const noise = (frame: number, cell: number) => NOISE[(frame * 7 + cell * 13) % NOISE.length]!

export function frameText(from: string, to: string, frame: number): string {
  return Array.from(to, (char, cell) => {
    if (frame >= SETTLE_AT + cell) return char
    return char === ' ' && (from[cell] ?? ' ') === ' ' ? ' ' : noise(frame, cell)
  }).join('')
}

const Slot: ClientModule<SlotProps, Scramble> = (props, surface) => {
  const { Box, Text } = surface.elements
  const s = surface.state
  if (s === undefined) {
    surface.setState({ kind: props.kind, from: props.text, frame: Number.POSITIVE_INFINITY, ticking: false })
  } else if (s.kind !== props.kind) {
    // A change during a scramble restarts it from what the slot shows; the running clock carries on.
    surface.setState({ kind: props.kind, from: shown.get(surface) ?? props.text, frame: 0, ticking: true })
    if (!s.ticking) {
      const stop = surface.every(props.frameMs, () => {
        const now = surface.state!
        const isDone = now.frame + 1 >= SETTLE_AT + props.text.length
        if (isDone) stop()
        surface.setState({ ...now, frame: isDone ? Number.POSITIVE_INFINITY : now.frame + 1, ticking: !isDone })
      })
    }
  }
  const frame = s === undefined ? Number.POSITIVE_INFINITY : s.kind === props.kind ? s.frame : 0
  const text = frameText(s && s.kind === props.kind ? s.from : (shown.get(surface) ?? props.text), props.text, frame)
  shown.set(surface, text)
  const style = props.mono ? { mono: true, size: 'caption' as const } : {}
  return (
    <Box>
      {props.bright > 0 && <Text {...style}>{text.slice(0, props.bright)}</Text>}
      <Text dimColor {...style}>{text.slice(props.bright)}</Text>
    </Box>
  )
}

export default Slot
