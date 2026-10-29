import type { ClientModule } from 'claude-code'

// A Client module, because hint-line redraws stop at 30 a second and the surface clock does not.

const SHIFT_MS = 60
const CELLS = 6
const SAMPLES = CELLS * 2 // a braille cell holds 2 columns of 4 dots
// Unicode added the bottom braille row last, so its bits (0x40, 0x80) break the order.
const DOTS = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]] as const

// Each column also lights the rows up to the previous sample, so steep steps stay joined.
function dotLine(samples: number[], top: number): string {
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
type Anim = { shown: number; bars: number[]; top: number; sinceShift: number; ticking: boolean }

// Per instance: the terminal and the desktop app each run their own Client of this module.
const targets = new WeakMap<object, number>()
const stops = new WeakMap<object, () => void>()

const Speed: ClientModule<SpeedProps, Anim> = (props, surface) => {
  const { Text } = surface.elements
  targets.set(surface, props.live ? props.rate : 0)
  const s: Anim = surface.state ?? { shown: 0, bars: Array(SAMPLES).fill(0), top: 1, sinceShift: 0, ticking: false }
  if (props.live && !s.ticking) {
    surface.setState({ ...s, ticking: true })
    const frameMs = props.frameMs
    const ease = 1 - 0.88 ** (frameMs / 16) // 12% of the gap per 16 ms, whatever the frame interval
    stops.set(surface, surface.every(frameMs, () => {
      const now = surface.state!
      const target = targets.get(surface)!
      const shown = now.shown + (target - now.shown) * ease
      const sinceShift = now.sinceShift + frameMs
      const isShift = sinceShift >= SHIFT_MS
      const bars = isShift ? [...now.bars.slice(1), shown] : [...now.bars.slice(0, -1), shown]
      // The scale freezes when the stream ends, so the falling samples drop on screen. The line
      // runs on until every sample has reached the bottom row.
      const top = target > 0 ? Math.max(...bars, 1) : now.top
      const isSettled = target === 0 && bars.every(v => v < top / 8)
      if (isSettled) stops.get(surface)?.()
      surface.setState({ shown, bars: isSettled ? bars.map(() => 0) : bars, top, sinceShift: isShift ? 0 : sinceShift, ticking: !isSettled })
    }))
  }
  return <Text color={props.color} dimColor={!props.live}>{`${dotLine(s.bars, s.top)} `}</Text>
}

export default Speed
