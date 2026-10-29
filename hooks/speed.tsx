import type { ClientModule } from 'claude-code'

// The output speed: a braille dot line that scrolls while Claude streams. Runs on the surface's
// frame clock while `live`, and holds the last shape, still and dim, between replies. The hooks
// module sends only the target and draws the number and the trend arrow itself.

const SHIFT_MS = 60 // the line moves one dot column left this often
const CELLS = 6
const SAMPLES = CELLS * 2 // a braille cell holds 2 columns of 4 dots
// Braille dot bits, top row first: the left column, then the right.
const DOTS = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]] as const

// A line through the samples: each column lights its own height and the rows up to the
// previous sample's height, so the dots join.
function dotLine(samples: number[]): string {
  const top = Math.max(...samples, 1)
  const rows = samples.map(v => 3 - Math.min(3, Math.round((v / top) * 3)))
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

export type SpeedProps = { rate: number; live: boolean; color: string; frameMs: number }
type Anim = { shown: number; bars: number[]; sinceShift: number; ticking: boolean }

// Per instance: the terminal and the desktop app each run their own Client of this module.
const targets = new WeakMap<object, number>()
const stops = new WeakMap<object, () => void>()

const Speed: ClientModule<SpeedProps, Anim> = (props, surface) => {
  const { Text } = surface.elements
  targets.set(surface, props.rate)
  const s: Anim = surface.state ?? { shown: 0, bars: Array(SAMPLES).fill(0), sinceShift: 0, ticking: false }
  if (props.live && !s.ticking) {
    surface.setState({ ...s, ticking: true })
    const frameMs = props.frameMs
    const ease = 1 - 0.88 ** (frameMs / 16) // 12% of the gap per 16 ms, whatever the frame interval
    stops.set(surface, surface.every(frameMs, () => {
      const now = surface.state!
      const shown = now.shown + (targets.get(surface)! - now.shown) * ease
      const sinceShift = now.sinceShift + frameMs
      // The newest cell follows the eased value on every frame; the others are history.
      const isShift = sinceShift >= SHIFT_MS
      const bars = isShift ? [...now.bars.slice(1), shown] : [...now.bars.slice(0, -1), shown]
      surface.setState({ ...now, shown, bars, sinceShift: isShift ? 0 : sinceShift })
    }))
  } else if (!props.live && s.ticking) {
    stops.get(surface)?.()
    surface.setState({ ...s, ticking: false })
  }
  return <Text color={props.color} dimColor={!props.live}>{`${dotLine(s.bars)} `}</Text>
}

export default Speed
