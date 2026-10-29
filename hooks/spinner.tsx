import type { ClientModule } from 'claude-code'

// A Client module, so the frames turn on the surface clock without redrawing the hint line.

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const FRAME_MS = 80

export type SpinnerProps = { color: string }

const Spinner: ClientModule<SpinnerProps, number> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState(0)
    surface.every(FRAME_MS, () => surface.setState((surface.state! + 1) % FRAMES.length)) // stops when the tool phase unmounts it
  }
  return <Text color={props.color}>{`${FRAMES[surface.state ?? 0]} `}</Text>
}

export default Spinner
