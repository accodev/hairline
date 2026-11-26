import { expect, test } from 'claude-code/testing'
import { toolReadout } from '../claude/register.tsx'
import { sendingText, waitingText } from '../claude/readout.tsx'
import { areaLine, scanCells, sweepBars } from '../claude/graph.tsx'

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

test('sending waits with a scan; a stream fills the graph from the bottom', () => {
  // The dots grow every 400 ms; the time keeps the last 6 cells.
  expect(waitingText(0, 18)).toBe('waiting.      0.0s')
  expect(waitingText(4_160, 18)).toBe('waiting..     4.1s')
  expect(waitingText(123_400, 18)).toBe('waiting...  123.4s')
  expect(waitingText(4_160, 18)).toHaveLength(18)
  // Too narrow for the word: the time alone, as the desktop band shows it.
  expect(waitingText(4_160, 8)).toBe('    4.1s')
  // A 6-cell head enters, crosses and leaves a 34-cell track in 1500 ms.
  expect(scanCells(0, 34)).toEqual([0, 0, 34])
  expect(scanCells(750, 34)).toEqual([14, 6, 14])
  expect(scanCells(1_499, 34)).toEqual([33, 1, 0])
  for (const ms of [0, 100, 750, 1_400]) expect(scanCells(ms, 34).reduce((a, b) => a + b)).toBe(34)
  expect(areaLine([0, 0, 0.5, 0.5, 1, 1], v => v)).toBe('⣀⣶⣿')
})
