import type { ClientModule } from 'claude-code'

// A Client module, so the scan moves on the surface clock without redrawing the hint line.

// One run of the context bar as register.tsx lays it out: a glyph repeated, or the percent's text.
// An empty color is dim default text: palette slot 8 vanishes on dark backgrounds.
export type BarRun = { glyph: string; color: string; text: string }
// While a turn runs: the head's colors and how many times a second it crosses the bar.
export type BarScan = { head: string; body: string; passes: number }
export type BarProps = { runs: BarRun[]; scan?: BarScan; frameMs: number }
type Drawn = { text: string; color: string; dim: boolean }
type Anim = { at: number } // passes done; the fraction is the head's place

// The terminal has no fades: 2 cells in the head color, 4 in the body color, 6 dim. At 30 frames
// a second, MAX_PASSES keeps a frame's step under 8 cells, so the head glides and does not jump.
const HEAD = 2
const BODY = 6
const TAIL = 12
export const MAX_PASSES = 1.5

// The cells as the bar draws them at `at` passes: idle as given, working every cell dim but the
// head's. The head and its tail are heavy on the track too, so it shows at any context size.
export function scanCells(runs: BarRun[], scan: BarScan | undefined, at: number): Drawn[] {
  const cells = runs.flatMap(run => Array.from(run.text, ch => ({ ch, color: run.color, isText: run.glyph === 'text' })))
  const head = Math.floor((at % 1) * (cells.length + TAIL))
  return cells.map((cell, i) => {
    if (!scan) return { text: cell.ch, color: cell.color, dim: !cell.color }
    const d = head - i
    if (cell.isText || d < 0 || d >= TAIL) return { text: cell.ch, color: cell.color, dim: true }
    return { text: '━', color: d < HEAD ? scan.head : scan.body, dim: d >= BODY }
  })
}

// Runs of one color and strength share a Text: a cell each would be some 200 elements.
function joined(cells: Drawn[]): Drawn[] {
  const out: Drawn[] = []
  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last && last.color === cell.color && last.dim === cell.dim) last.text += cell.text
    else out.push({ ...cell })
  }
  return out
}

// Per instance: the props of the last call, for the timer that outlives it, and the timer's stop.
const latest = new WeakMap<object, BarProps>()
const stops = new WeakMap<object, () => void>()

const Bar: ClientModule<BarProps, Anim> = (props, surface) => {
  const { Box, Text } = surface.elements
  latest.set(surface, props)
  const s = surface.state ?? { at: 0 }
  if (props.scan && !stops.has(surface)) {
    const stop = surface.every(props.frameMs, () => {
      const now = latest.get(surface)!
      if (!now.scan) {
        stop()
        stops.delete(surface)
        return
      }
      const passes = Math.min(MAX_PASSES, now.scan.passes)
      surface.setState({ at: (surface.state?.at ?? 0) + (now.frameMs / 1000) * passes })
    })
    stops.set(surface, stop)
  }
  return (
    <Box>
      {joined(scanCells(props.runs, props.scan, s.at)).map((run, i) => run.color
        ? <Text key={`bar-${i}`} color={run.color} dimColor={run.dim} wrap="truncate-end">{run.text}</Text>
        : <Text key={`bar-${i}`} dimColor wrap="truncate-end">{run.text}</Text>)}
    </Box>
  )
}

export default Bar
