import type { ClientModule } from 'claude-code'

// A Client module, because the desktop app draws a Button as a native control in its own font and
// the line around it is monospaced. A click posts to the hooks module, which acts as onPress would.

export type ChipProps = { text: string; color?: string; dim?: boolean; inverse?: boolean }

const Chip: ClientModule<ChipProps> = (props, surface) => {
  const { Text } = surface.elements
  surface.onPointer(e => {
    if (e.type === 'up' && e.button === 'left') surface.post({ press: true })
  })
  return (
    <Text
      mono
      tabular
      size="caption"
      {...(props.color && { color: props.color })}
      {...(props.dim && { dimColor: true })}
      {...(props.inverse && { inverse: true })}
    >
      {props.text}
    </Text>
  )
}

export default Chip
