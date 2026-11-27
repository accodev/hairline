import { expect, mock, test } from 'claude-code/testing'
import { scanCells, type BarRun } from '../claude/bar.tsx'
import { basename, modelLabel, refreshRateOf, trimSeparators, workspaceWidth, WORKSPACE_WIDTH, worktreeOf } from '../claude/register.tsx'

// The one-row layouts: scan draws the activity as a light on the context bar, middle centers it
// between the workspace and the limits. Both keep the percent on the bar, where the fill ends.

const COLUMNS = 120
type Node = { type: string; props?: Record<string, unknown>; children?: (Node | string)[] }

async function inline(node: Node | string, drawn: (key: string) => Promise<Node>): Promise<Node | string> {
  if (typeof node === 'string') return node
  if (node.type === 'Client') return drawn(String(node.props?.key))
  return { ...node, children: await Promise.all((node.children ?? []).map(child => inline(child, drawn))) }
}
const flat = (node: Node | string): string => (typeof node === 'string' ? node : (node.children ?? []).map(flat).join(''))
// The Text nodes in order, with their color and strength.
function texts(node: Node | string, out: { text: string; color?: unknown; dim?: unknown }[] = []) {
  if (typeof node === 'string') return out
  if (node.type === 'Text') out.push({ text: flat(node), color: node.props?.color, dim: node.props?.dimColor })
  else for (const child of node.children ?? []) texts(child, out)
  return out
}

async function mount($: Parameters<Parameters<typeof test>[2]>[0], on: Parameters<Parameters<typeof test>[2]>[1]) {
  const clock = mock.clock(on, { now: Date.now() })
  on('session.start', () => ({ cwd: '/home/dev/hairline' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.cwd', () => ({ value: '/home/dev/hairline' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: '8f3a2c1d-5b7e-4a90-9c61-2d4e8b0f7a13' }))
  on('session.usage', () => ({
    value: {
      startedAt: Date.now(),
      context: { tokens: 410_000, window: 1_000_000, percent: 41, breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 800_000 } as never },
      rateLimits: [{ kind: 'five_hour', percentUsed: 34 }, { kind: 'seven_day', percentUsed: 58 }],
    },
  }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  on('turn.step', async function* () {
    await held
    for (let i = 0; i < 20; i++) {
      await clock.advance(50)
      yield { kind: 'text', index: 0, text: 'x'.repeat(40) } as never
    }
    const toolUses = ['a', 'b', 'c'].map(description => ({ name: 'Agent', input: { description } }))
    return { turnId: 't', index: 0, answer: '', toolUses } as never
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/home/dev/hairline' })
  const ui = await $.ui.mount({
    plugin: 'hairline', component: 'PromptHint', requestId: 'PromptHint', surface: 'terminal',
    viewport: { columns: COLUMNS, rows: 40 }, props: { isDraft: false, isWorking: false, hint: '' },
  })
  const tree = async () => (await inline((await ui.drawn()) as Node, async key => (await ui.drawn({ in: key })) as Node)) as Node
  const start = () => $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })[Symbol.asyncIterator]()
  return { ui, clock, tree, start, release }
}

test('the workspace takes half the row, never less than 52 cells', () => {
  expect(workspaceWidth(80)).toBe(WORKSPACE_WIDTH)
  expect(workspaceWidth(196)).toBe(98)
})

test('the scan head crosses the whole bar in 3 steps and leaves the percent alone', () => {
  const runs: BarRun[] = [{ glyph: '━', color: 'ansi256(2)', text: '━━━━' }, { glyph: 'text', color: 'ansi256(3)', text: ' 41% ' }, { glyph: '─', color: '', text: '─'.repeat(31) }]
  const scan = { head: 'ansi256(10)', body: 'ansi256(2)', passes: 1 }
  // Idle: as given, the track dim.
  expect(scanCells(runs, undefined, 0).map(c => c.text).join('')).toBe('━━━━ 41% ' + '─'.repeat(31))
  // 40 cells and a 12-cell tail: at 0.5 the head is on cell 26, past the percent.
  const cells = scanCells(runs, scan, 0.5)
  expect(cells[26]).toEqual({ text: '━', color: 'ansi256(10)', dim: false })
  expect(cells[24]).toEqual({ text: '━', color: 'ansi256(2)', dim: false })
  expect(cells[19]).toEqual({ text: '━', color: 'ansi256(2)', dim: true })
  expect(cells[27]).toEqual({ text: '─', color: '', dim: true })
  // The fill and the percent keep their color and strength outside the head.
  expect(cells[0]).toEqual({ text: '━', color: 'ansi256(2)', dim: false })
  expect(cells[5]).toEqual({ text: '4', color: 'ansi256(3)', dim: false })
  // The percent keeps its text under the tail.
  const early = scanCells(runs, scan, 0.2)
  expect(early.slice(4, 9).map(c => c.text).join('')).toBe(' 41% ')
})

test('scan: one bar and one row; the bar lights up while a turn runs, in the phase color', { options: { layout: 'scan' } }, async ($, on) => {
  const { ui, tree, start, release } = await mount($, on)
  await ui.advance(3_000)
  const idle = texts(await tree())
  // The bar's runs: glyphs, and the percent that joins the fill's last color.
  const bar = idle.filter(t => /^[━─┃ \d%]+$/.test(t.text) && /[━─┃]/.test(t.text) || /^ \d+% $/.test(t.text))
  // The bar spans the terminal less Claude Code's 2-column indent on each side.
  expect(bar.map(t => t.text).join('')).toHaveLength(COLUMNS - 4)
  expect(bar.map(t => t.text).join('')).toMatch(/━ 41% ─/)
  expect(idle.some(t => t.text === '5h 34%')).toBe(true)
  // The window name is gray; the percent alone takes the severity color.
  const limit = (await ui.find({ type: 'Text', text: '5h 34%' })) as Node
  const [name, percent] = limit.children as Node[]
  expect(name!.props?.dimColor).toBe(true)
  expect(percent!.props?.color).toBeDefined()
  expect(idle.some(t => t.text === '7d 58%')).toBe(true)

  const stream = start()
  const first = stream.next()
  await ui.advance(600)
  // Thinking: the head in Claude's own spinner color.
  expect(texts(await tree()).some(t => t.color === 'claude' && /━/.test(t.text))).toBe(true)
  release()
  await first
  await ui.advance(400)
  expect(texts(await tree()).some(t => t.color === 'ansi256(10)' && /━/.test(t.text))).toBe(true)
  while (!(await stream.next()).done) {}
  await ui.advance(500)
  expect(texts(await tree()).some(t => t.color === 'ansi256(11)' && /━/.test(t.text))).toBe(true)

  // The limits open the ledger: the token split has no place on this row.
  await ui.press({ key: 'hairline-ledger-5h' })
  expect(texts(await tree()).find(t => t.text === '5h 34%')).toBeDefined()
  expect(((await ui.find({ type: 'Text', text: '5h 34%' })) as Node).props?.inverse).toBe(true)
  await ui.unmount()
})

test('middle: the activity sits between the workspace and the limits, in words', { options: { layout: 'middle' } }, async ($, on) => {
  const { ui, tree, start, release } = await mount($, on)
  await ui.advance(3_000)
  const row = async () => flat(await tree())
  expect(await row()).toMatch(/hairline.* 5h 34% · 7d 58%/)
  const stream = start()
  const first = stream.next()
  await ui.advance(600)
  expect(await row()).toMatch(/hairline.*✻ thinking .*\d\.\ds.*5h 34%/)
  release()
  await first
  await ui.advance(400)
  expect(await row()).toMatch(/hairline.*↓ \d+ t\/s [⠀-⣿]+.*5h 34%/)
  while (!(await stream.next()).done) {}
  await ui.advance(500)
  expect(await row()).toMatch(/hairline.*3 tools Agent a.*5h 34%/)
  await ui.unmount()
})

test('the refresh rate reads from Windows, macOS and xrandr output, the highest display winning', () => {
  const cases: [string, number | null][] = [
    ['119\r\n\r\n', 119],
    ['60\r\n144\r\n', 144],
    ['UI Looks like: 1512 x 982 @ 120.00Hz', 120],
    ['Display Type: Built-in Liquid Retina XDR Display\n  ProMotion', 120],
    ['   2560x1440     59.95*+  143.97\n   1920x1080     60.00', 60],
    ['', null],
    ['Screen 0: minimum 320 x 200', null],
  ]
  for (const [output, hz] of cases) expect(refreshRateOf(output)).toBe(hz)
})

// CodeQL js/polynomial-redos: each input took quadratic time with the old regexes. 50,000 repeats
// ran for seconds; linear code finishes in milliseconds and gives the old result.
const LONG = 50_000
const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = Date.now()
  const value = run()
  return { value, ms: Date.now() - start }
}
const adversarial: [string, () => unknown, unknown][] = [
  ['refreshRateOf on 9 repeated', () => refreshRateOf('9'.repeat(LONG) + 'x'), null],
  ['refreshRateOf on digits and dots', () => refreshRateOf('1.'.repeat(LONG)), null],
  ['modelLabel on [ repeated', () => modelLabel('claude-opus-5-5' + '['.repeat(LONG)), `opus 5.5${'['.repeat(LONG)}`],
  ['basename on / repeated', () => basename('/'.repeat(LONG) + 'x'), 'x'],
  ['basename on trailing / repeated', () => basename('a' + '/'.repeat(LONG) + 'b' + '/'.repeat(LONG)), 'b'],
  ['worktreeOf on / repeated', () => worktreeOf('/'.repeat(LONG) + 'x', 'top'), { name: 'top', worktree: null }],
  ['refreshRateOf on blanks repeated', () => refreshRateOf('1' + ' '.repeat(LONG) + 'x'), null],
  ['refreshRateOf on numbers and blanks repeated', () => refreshRateOf('1 '.repeat(LONG)), null],
]

for (const [name, run, expected] of adversarial) {
  test(`${name} finishes in linear time`, () => {
    const { value, ms } = timed(run)
    expect(value).toEqual(expected)
    expect(ms).toBeLessThan(500)
  })
}

test('the rewritten parsers keep their old results', () => {
  expect(refreshRateOf('   2560x1440     59.95*+  143.97\n   1920x1080     60.00')).toBe(60)
  expect(refreshRateOf('UI Looks like: 1512 x 982 @ 120.00Hz')).toBe(120)
  expect(modelLabel('claude-opus-5-5[1m]')).toBe('opus 5.5')
  expect(modelLabel('claude-haiku-5-5-20261001')).toBe('haiku 5.5')
  expect(modelLabel('claude-x[a]b')).toBe('x[a]b')
  expect(basename('C:\\code\\hairline\\')).toBe('hairline')
  expect(trimSeparators('a/b//\\')).toBe('a/b')
  expect(worktreeOf('C:/code/hairline/.git/worktrees/extra-usage/', 'C:/code/hairline/.claude/worktrees/extra-usage')).toEqual({ name: 'hairline', worktree: 'extra-usage' })
  expect(worktreeOf('C:\\code\\hairline\\.git\\worktrees\\x', 'C:/w/x')).toEqual({ name: 'hairline', worktree: 'x' })
  expect(worktreeOf('/.git/worktrees/x', '/w/x')).toEqual({ name: 'x', worktree: null })
  expect(worktreeOf('/home/dev/app/.git/modules/lib', '/home/dev/app/lib')).toEqual({ name: 'lib', worktree: null })
})
