import { expect, test } from 'claude-code/testing'
import { toolReadout } from '../hooks/register.tsx'
import { sendingText } from '../hooks/readout.tsx'
import { areaLine, breathColor, sweepBars } from '../hooks/graph.tsx'

const WIDTH = 24

test('a running tool fills exactly the readout and the graph', () => {
  const cases = [
    [[{ name: 'Bash', arg: 'Run the hairline tests and more' }], 'Bash Run the hairline t…', 4],
    [[{ name: 'Read', arg: 'readout.tsx' }], 'Read readout.tsx        ', 4],
    [[{ name: 'Grep', arg: '' }], 'Grep                    ', 4],
    // Parallel calls: the count, then each call, so every tool the turn runs shows.
    [[{ name: 'Agent', arg: 'a' }, { name: 'Agent', arg: 'b' }, { name: 'Agent', arg: 'c' }], '3 tools Agent a · Agent…', 7],
    [[{ name: 'Read', arg: 'a' }, { name: 'Grep', arg: 'b' }], '2 tools Read a · Grep b ', 7],
    [[{ name: 'Bash', arg: 'npm\n  test' }], 'Bash npm test           ', 4],
    [[], '                 running', 0],
  ] as const
  for (const [tools, text, bright] of cases) {
    const readout = toolReadout([...tools], WIDTH)
    expect(readout.text).toBe(text)
    expect(readout.text).toHaveLength(WIDTH)
    expect(readout.bright).toBe(bright)
  }
})

test('the sending time keeps the readout width', () => {
  expect(sendingText(0, 8)).toBe('    0.0s')
  expect(sendingText(4_160, 8)).toBe('    4.1s')
  expect(sendingText(128_000, 8)).toBe('  128.0s')
})

test('the sweep bump crosses the line and leaves it', () => {
  expect(Math.max(...sweepBars(0))).toBe(0)                 // it starts outside the line
  expect(Math.max(...sweepBars(600))).toBeGreaterThan(0.9)  // and crosses it
  expect(sweepBars(600)).toHaveLength(12)
})

test('sending breathes the whole track; a stream fills the graph from the bottom', () => {
  const breath = ['ansi256(8)', 'ansi256(7)', 'ansi256(4)', 'ansi256(12)']
  // One breath over 1600 ms: the darkest color at its start, the brightest halfway.
  expect(breathColor(0, breath)).toBe('ansi256(8)')
  expect(breathColor(800, breath)).toBe('ansi256(12)')
  expect(areaLine([0, 0, 0.5, 0.5, 1, 1], v => v)).toBe('⣀⣶⣿')
})
