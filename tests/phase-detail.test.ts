import { expect, test } from 'claude-code/testing'
import { toolSlot } from '../hooks/register.tsx'
import { sendingText } from '../hooks/slot.tsx'
import { sweepBars } from '../hooks/speed.tsx'

const WIDTH = 15 // the slot, its gap and the dot line

test('a running tool fills exactly the slot and the dot line', () => {
  const cases = [
    [[{ name: 'Bash', arg: 'Run the hairline tests' }], 'Bash Run the h…', 4],
    [[{ name: 'Read', arg: 'slot.tsx' }], 'Read slot.tsx  ', 4],
    [[{ name: 'Grep', arg: '' }], 'Grep           ', 4],
    [[{ name: 'Agent', arg: 'a' }, { name: 'Agent', arg: 'b' }, { name: 'Agent', arg: 'c' }], 'Agent ×3       ', 5],
    [[{ name: 'Read', arg: 'a' }, { name: 'Grep', arg: 'b' }], 'Read +1        ', 4],
    [[{ name: 'Bash', arg: 'npm\n  test' }], 'Bash npm test  ', 4],
    [[], '        running', 0],
  ] as const
  for (const [tools, text, bright] of cases) {
    const slot = toolSlot([...tools], WIDTH)
    expect(slot.text).toBe(text)
    expect(slot.text).toHaveLength(WIDTH)
    expect(slot.bright).toBe(bright)
  }
})

test('the sending time keeps the slot width', () => {
  expect(sendingText(0, 8)).toBe('    0.0s')
  expect(sendingText(4_160, 8)).toBe('    4.1s')
  expect(sendingText(128_000, 8)).toBe('  128.0s')
})

test('the sweep bump crosses the line and leaves it', () => {
  expect(Math.max(...sweepBars(0))).toBe(0)                 // it starts outside the line
  expect(Math.max(...sweepBars(600))).toBeGreaterThan(0.9)  // and crosses it
  expect(sweepBars(600)).toHaveLength(12)
})
