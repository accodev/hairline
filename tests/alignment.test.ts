import { expect, mock, test } from 'claude-code/testing'

// The line's speed group keeps one width in every phase, so the separator after it never moves.

const HINT = {
  plugin: 'hairline',
  component: 'PromptHint',
  requestId: 'PromptHint',
  surface: 'terminal',
  viewport: { columns: 150, rows: 40 },
  props: { isDraft: false, isWorking: false, hint: '' },
} as const

type Node = { type: string; props?: Record<string, unknown>; children?: (Node | string)[] }

async function inline(node: Node | string, drawn: (key: string) => Promise<Node>): Promise<Node | string> {
  if (typeof node === 'string') return node
  if (node.type === 'Client') return drawn(String(node.props?.key))
  return { ...node, children: await Promise.all((node.children ?? []).map(child => inline(child, drawn))) }
}
const flat = (node: Node | string): string => (typeof node === 'string' ? node : (node.children ?? []).map(flat).join(''))

test('the speed group keeps its width in every phase', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  on('session.start', () => ({ cwd: '/home/dev/hairline' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.cwd', () => ({ value: '/home/dev/hairline' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: '8f3a2c1d-5b7e-4a90-9c61-2d4e8b0f7a13' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  on('turn.step', async function* () {
    await held
    for (let i = 0; i < 20; i++) {
      await clock.advance(50)
      yield { kind: 'text', index: 0, text: 'x'.repeat(40) } as never
    }
    return { turnId: 't', index: 0, answer: '', toolUses: [] } as never
  })
  on('tool.check', () => ({ decision: 'allow' }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/home/dev/hairline' })
  const ui = await $.ui.mount(HINT)
  const line = async () => flat(await inline((await ui.drawn()) as Node, async key => (await ui.drawn({ in: key })) as Node))
  // The column of the separator after the speed group: the second " · " after the context figures.
  const sepAt = (text: string) => text.indexOf(' · ', text.indexOf(' · ') + 1)

  await ui.advance(3_000)
  const idle = await line()
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })[Symbol.asyncIterator]()
  const first = stream.next()
  await ui.advance(500)
  const sending = await line()
  release()
  await first
  await ui.advance(200)
  const receiving = await line()
  while (!(await stream.next()).done) {}
  for (const id of ['a', 'b', 'c']) await $.tool.check({ tool: 'Agent', input: { description: id }, tool_use_id: id } as never)
  await ui.advance(500)
  const tools = await line()

  const lines = { idle, sending, receiving, tools }
  for (const [name, text] of Object.entries(lines)) console.log(`${name.padEnd(9)} ${text}`)
  expect(new Set(Object.values(lines).map(sepAt)).size).toBe(1)
})

declare const console: { log: (line: string) => void }
