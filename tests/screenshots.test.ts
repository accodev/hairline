import { mock, test } from 'claude-code/testing'

// Prints each scene's drawn tree for scripts/screenshots.mjs, which lays it out and saves a PNG.
// The data is fixed, so the README images change only when the line's code does.

const SESSION_ID = '8f3a2c1d-5b7e-4a90-9c61-2d4e8b0f7a13'
const COLUMNS = 150
const HINT = {
  plugin: 'hairline',
  component: 'PromptHint',
  requestId: 'PromptHint',
  surface: 'terminal',
  viewport: { columns: COLUMNS, rows: 40 },
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

// The test runtime has console.log; the es2023 lib the types build against does not declare it.
declare const console: { log: (line: string) => void }

type Node = { type: string; props?: Record<string, unknown>; children?: (Node | string)[] }

// A Client draws in its own module, so its tree is read separately and put in its place.
async function inline(node: Node | string, drawn: (key: string) => Promise<Node>): Promise<Node | string> {
  if (typeof node === 'string') return node
  if (node.type === 'Client') return drawn(String(node.props?.key))
  return { ...node, children: await Promise.all((node.children ?? []).map(child => inline(child, drawn))) }
}

test('screenshots', { options: { currency: 'EUR', usdRate: 0.9 } }, async ($, on) => {
  mock.clock(on)
  const stats = { input: 1_200, write: 640_000, read: 9_800_000, output: 96_000, main: 610_000, sub: 127_200, turns: 31, activeMs: 5_400_000, costStart: 0 }
  mock.store(on, { sessions: [{ sessionId: SESSION_ID, effort: 'medium', stats }] })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"date":"2026-10-29","rates":{"EUR":0.9}}' } }))
  on('session.start', () => ({ cwd: '/home/dev/hairline' }))
  on('session.cwd', () => ({ value: '/home/dev/hairline' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/dev/hairline\nmain\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({
    value: {
      startedAt: Date.now() - 2 * 3_600_000,
      cost: { usd: 6.4 },
      context: {
        tokens: 412_000, window: 1_000_000, percent: 41.2,
        breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 967_000 } as never,
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      ],
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({
    value: [
      { key: 'effortLevel', label: 'Effort', kind: 'choice', value: 'medium' },
      { key: 'model', label: 'Model', kind: 'choice', value: 'opus', options: ['sonnet', 'opus', 'haiku'], isLocked: false },
    ] as never,
  }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/home/dev/hairline' })
  const ui = await $.ui.mount(HINT)
  const shoot = async (name: string) => {
    const tree = await inline((await ui.drawn()) as Node, async key => (await ui.drawn({ in: key })) as Node)
    console.log(`SCENE ${JSON.stringify({ name, columns: COLUMNS, tree })}`)
  }
  await shoot('line')
  await ui.press({ key: 'hairline-tokens' })
  await shoot('token-panel')
  await ui.press({ key: 'hairline-tokens' })
  await ui.press({ key: 'hairline-effort' })
  await shoot('effort-picker')
  await ui.unmount()
})
