import type { ClientModule } from 'claude-code'

// A Client module, so the frames turn on the surface clock without redrawing the hint line.

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const FRAME_MS = 80

export type SpinnerProps = { color: string; mono?: boolean }

const Spinner: ClientModule<SpinnerProps, number> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState(0)
    surface.every(FRAME_MS, () => surface.setState((surface.state! + 1) % FRAMES.length)) // stops when the tool phase unmounts it
  }
  const frame = FRAMES[surface.state ?? 0]
  // The desktop app's monospaced face has no braille; its fallback font is wider, so a box holds it to a cell.
  return props.mono
    ? <Box width={2}><Box width={1} overflow="hidden"><Text color={props.color} mono size="caption">{frame}</Text></Box></Box>
    : <Text color={props.color}>{`${frame} `}</Text>
}

export default Spinner
