import type { ClientModule } from 'claude-code'

// A Client module, because the desktop app draws a Button as a native control in its own font and
// the line around it is monospaced. A click posts to the hooks module, which acts as onPress would.

export type ChipProps = { text: string; color?: string; dim?: boolean; inverse?: boolean }

// The pointer inverts the chip, as it does a terminal Button.
const Chip: ClientModule<ChipProps, { isHovered: boolean }> = (props, surface) => {
  const { Box, Text } = surface.elements
  const isHovered = surface.state?.isHovered ?? false
  surface.onPointer(e => {
    if (e.type === 'enter' || e.type === 'leave') surface.setState({ isHovered: e.type === 'enter' })
    else if (e.type === 'up' && e.button === 'left') surface.post({ press: true })
  })
  // A bare Text sits higher than the line around it in the desktop app; in a Box it lines up, as speed.tsx does.
  return (
    <Box>
      <Text
        mono
        tabular
        size="caption"
        {...(props.color && { color: props.color })}
        {...(props.dim && { dimColor: true })}
        {...((props.inverse || isHovered) && { inverse: true })}
      >
        {props.text}
      </Text>
    </Box>
  )
}

export default Chip
