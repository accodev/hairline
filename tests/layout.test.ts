import { expect, mock, test } from 'claude-code/testing'
import { TOKEN_SPLIT_WIDTH, WORKSPACE_WIDTH } from '../hooks/register.tsx'

// The UI test: the line is drawn with the widest figures it can show, and every box of a fixed
// width must hold what it draws. A row wider than its box wraps in the terminal, which is how
// `write` and the workspace's `(` fell to a row of their own.

const COLUMNS = 200
const SESSION_ID = '02c6e8dd-64d4-4f01-8f7f-3a43b20104a2'
type Node = { type: string; props?: Record<string, unknown>; children?: (Node | string)[] }

// A Client draws in its own module, so its tree is read separately and put in its place.
async function inline(node: Node | string, drawn: (key: string) => Promise<Node>): Promise<Node | string> {
  if (typeof node === 'string') return node
  if (node.type === 'Client') return drawn(String(node.props?.key))
  return { ...node, children: await Promise.all((node.children ?? []).map(child => inline(child, drawn))) }
}

const text = (node: Node | string): string => (typeof node === 'string' ? node : (node.children ?? []).map(text).join(''))

// Cells a node needs on one row, as the terminal lays it out: a row adds its children up, a column
// takes the widest, and a margin adds its cells.
function cells(node: Node | string): number {
  if (typeof node === 'string') return [...node].length
  if (node.type === 'Text') return [...text(node)].length
  const kids = (node.children ?? []).map(cells)
  const own = node.props?.flexDirection === 'column' ? Math.max(0, ...kids) : kids.reduce((a, b) => a + b, 0)
  return own + Number(node.props?.marginRight ?? 0)
}

// Every Box with a width in cells, and the cells its children need.
function overruns(node: Node | string, out: string[] = []): string[] {
  if (typeof node === 'string') return out
  const width = node.props?.width
  if (node.type === 'Box' && typeof width === 'number') {
    const need = cells({ ...node, props: { ...node.props, marginRight: 0 } })
    if (need > width) out.push(`${need} cells in a box of ${width}: "${text(node)}"`)
  }
  for (const child of node.children ?? []) overruns(child, out)
  return out
}

test('at the widest figures every column holds its text on one row', { options: { layout: 'columns' } }, async ($, on) => {
  const clock = mock.clock(on)
  const name = '1245_the-tills-fiscal-module-runs-as-a-separate-process'
  const top = `C:/code/market-it/.claude/worktrees/${name}`
  const at = (path: string, end: string) => path.replace(/\\/g, '/').endsWith(end)
  // 999.99M, 112.46M, 112.46B and 999.99B: every count at 7 cells, the most human() prints.
  const stats = { input: 999_990_000, output: 112_460_000, read: 112_460_000_000, write: 999_990_000_000, main: 1, sub: 0, turns: 999, activeMs: 99 * 3_600_000, costStart: 0 }
  mock.store(on, { sessions: [{ sessionId: SESSION_ID, effort: 'xhigh', stats }] })
  on('session.start', () => ({ cwd: top }))
  on('session.cwd', () => ({ value: top }))
  on('fs.stat', ($, e) => (at(e.path, `/${name}/.git`) ? { value: { kind: 'file', size: 60, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', ($, e) => (
    at(e.path, `/${name}/.git`) ? { value: `gitdir: C:/code/market-it/.git/worktrees/${name}\n` }
      : at(e.path, `/.git/worktrees/${name}/HEAD`) ? { value: `ref: refs/heads/accodev/${name}\n` }
        : { deny: 'ENOENT' }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: Date.now(),
      context: { tokens: 999_000, window: 1_000_000, percent: 99.9, breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 800_000 } as never },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(Date.now() + 4 * 3_600_000 + 59 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 100, resetsAt: new Date(Date.now() + 6 * 86_400_000 + 23 * 3_600_000).toISOString() },
      ],
    },
  }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Maple Mono NF\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: top })
  const ui = await $.ui.mount({
    plugin: 'hairline', component: 'PromptHint', requestId: 'PromptHint', surface: 'terminal',
    viewport: { columns: COLUMNS, rows: 40 }, props: { isDraft: false, isWorking: false, hint: '' },
  })
  await clock.settle()
  const tree = (await inline((await ui.drawn()) as Node, async key => (await ui.drawn({ in: key })) as Node)) as Node

  expect(overruns(tree)).toEqual([])
  // The token split itself: 4 counts of 7 cells, so its column is as wide as the widest split.
  const split = await ui.find({ type: 'Text', text: /write$/ })
  expect([...text(split as Node)].length).toBeLessThanOrEqual(TOKEN_SPLIT_WIDTH)
  expect(text(split as Node)).toMatch(/^999\.99M in \/ 112\.46M out \/ 112\.46B read \/ 999\.99B write$/)
  // The workspace row: the long names cut to the column, the repository whole.
  const workspace = (await ui.find({ type: 'Text', text: 'market-it' })) as Node
  expect(workspace).toBeDefined()
  expect(WORKSPACE_WIDTH).toBe(52)
  await ui.unmount()
})
