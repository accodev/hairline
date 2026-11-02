import { expect, test } from 'claude-code/testing'
import { frameText } from '../hooks/slot.tsx'

test('the slot scrambles, then settles left to right', () => {
  const from = ' 224 t/s', to = '    idle'
  expect(frameText(from, to, 0)).not.toBe(to)
  expect(frameText(from, to, 0)).toHaveLength(8)
  expect(frameText(from, to, 5).slice(0, 4)).toBe('    ') // settled cells show the new text
  expect(frameText(from, to, 9)).toBe(to)
  expect(frameText('    ', '    ', 0)).toBe('    ') // blank in both stays blank
})
