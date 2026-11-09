// Not named *.test.ts: `claude plugin test` would run it with the Claude Code test kit.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { frameText, newSpeed, sendingText, speedDots, tickSpeed } from './anim.ts'
import { drawFooter, duration, human, modelLabel, SLOT_WIDTH, slotTarget, TOOL_WIDTH, toolArg, toolSlot, type View } from './line.ts'

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

const view = (over: Partial<View> = {}): View => ({
  folder: 'market-it',
  branch: 'main',
  model: 'claude-opus-5-5',
  effort: 'high',
  sessionId: '02c6e8dd-64d4-4f01-8f7f-3a43b20104a2',
  context: { tokens: 104_000, contextWindow: 200_000, percent: 52 },
  compactAt: 80,
  stats: { input: 80, write: 2_000_000, read: 8_300_000, output: 400_000, costUsd: 4.82 },
  turns: 40,
  activeMs: 2 * 3_600_000,
  costStart: 0.82,
  limits: [
    { kind: 'five_hour', percentUsed: 38, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 91, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  ],
  limitStart: {},
  phase: 'idle',
  tools: [],
  slot: slotTarget('idle', 0, []).text,
  dots: '⠀⠀⠀⠀⠀⠀',
  isLit: false,
  hasNerdFont: false,
  isPanelOpen: false,
  lastTurn: null,
  lastRequestAt: null,
  cacheTtlMinutes: 60,
  money: usd => `$${usd.toFixed(2)}`,
  statuses: [],
  now: Date.now(),
  ...over,
})

test('draws location, context, speed, tokens, limits, model and session id on one line', () => {
  const [line, ...rest] = drawFooter(view(), 160)
  assert.equal(rest.length, 0)
  assert.equal(visibleWidth(line!), 160)
  const text = plain(line!)
  assert.match(text, /^market-it:main {2}━━━━──┃─ {2}52% 104k\/200k · ○ {5}idle ⠀{6} · 10.7M tok · 5h 38% · 7d 91% resets 3d/)
  assert.match(text, /opus 5\.5 high · 02c6e8dd$/)
})

test('a narrow footer shortens the location first and keeps every figure', () => {
  const full = plain(drawFooter(view(), 160)[0]!)
  const figuresAt = full.indexOf('━')
  const narrow = plain(drawFooter(view({ folder: 'a-very-long-folder-name-for-a-repository' }), 120)[0]!)
  assert.equal(visibleWidth(narrow), 120)
  assert.match(narrow, /…/)
  assert.match(narrow, /7d 91%/)
  assert.match(narrow, /02c6e8dd$/)
  assert.ok(figuresAt > 0)
})

test('the panel lists cost, tokens, turns and limits, and other extensions keep their status', () => {
  const lines = drawFooter(view({ isPanelOpen: true, statuses: ['lsp: ready'] }), 160).map(plain)
  assert.equal(lines.length, 6)
  assert.match(lines[1]!, /^ {2}cost {4}\$4\.82 · \$2\.00 per active hour/)
  assert.match(lines[2]!, /^ {2}tokens {2}80 in · 2M cache write · 8\.3M cache read · 400k out · 81% cache hit/)
  assert.match(lines[3]!, /^ {2}turns {3}40 turns · 2h active/)
  assert.match(lines[4]!, /^ {2}limits {2}5h 38% measuring · 7d 91% measuring/)
  assert.equal(lines[5], 'lsp: ready')
})

test('the speed group keeps one width in every phase', () => {
  const widths = (['idle', 'sending', 'receiving'] as const).map(phase => slotTarget(phase, 1234, []).text.length)
  assert.deepEqual(widths, [SLOT_WIDTH, SLOT_WIDTH, SLOT_WIDTH])
  const tool = toolSlot([{ name: 'bash', arg: 'npm test' }], TOOL_WIDTH)
  assert.equal(tool.text.length, TOOL_WIDTH)
  assert.equal(tool.bright, 4)
  const toolLine = plain(drawFooter(view({ phase: 'tool', tools: [{ name: 'bash', arg: 'npm test' }], slot: tool.text }), 160)[0]!)
  const idleLine = plain(drawFooter(view(), 160)[0]!)
  assert.equal(toolLine.indexOf('10.7M tok'), idleLine.indexOf('10.7M tok'))
})

test('tool arguments name the file, the command or the pattern', () => {
  assert.equal(toolArg({ path: 'C:\\code\\hairline\\pi\\index.ts' }), 'index.ts')
  assert.equal(toolArg({ command: 'npm test' }), 'npm test')
  assert.equal(toolArg({ pattern: 'TODO', path: 'src' }), 'src')
  assert.equal(toolArg({ url: 'https://www.example.com/a' }), 'example.com/a')
  assert.equal(toolSlot([{ name: 'read', arg: 'a' }, { name: 'read', arg: 'b' }], TOOL_WIDTH).text.trim(), 'read ×2')
})

test('figures and times keep their short forms', () => {
  assert.equal(human(999_499), '999k')
  assert.equal(human(999_500), '1M')
  assert.equal(duration(500), '1s')
  assert.equal(duration(3 * 86_400_000 + 2 * 3_600_000), '3d 2h')
  assert.equal(modelLabel('claude-sonnet-5-5'), 'sonnet 5.5')
  assert.equal(sendingText(4_160, 8), '    4.1s')
})

test('the slot scrambles, then settles left to right', () => {
  assert.notEqual(frameText('idle', 'sending', 0), 'sending')
  assert.equal(frameText('idle', 'sending', 2 + 7), 'sending')
})

test('the dot line rises with the stream and settles flat after it', () => {
  const s = newSpeed()
  for (let i = 0; i < 40; i++) tickSpeed(s, 33, 100, false)
  assert.notEqual(speedDots(s, true, false), '⠀⠀⠀⠀⠀⠀')
  for (let i = 0; i < 400 && !s.isSettled; i++) tickSpeed(s, 33, 0, false)
  assert.ok(s.isSettled)
  assert.equal(speedDots(s, false, false), '⣀⣀⣀⣀⣀⣀')
})

test('the extension draws the footer from Pi events', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { mkdirSync } = await import('node:fs')
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'hairline-'))
  const repo = join(process.env.PI_CODING_AGENT_DIR, 'market-it')
  mkdirSync(join(repo, '.git', 'refs'), { recursive: true })
  const { default: hairline } = await import('./index.ts')
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>()
  const commands = new Map<string, { handler: (args: string, c: unknown) => Promise<void> }>()
  const pi = {
    on: (name: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => handlers.set(name, fn),
    registerCommand: (name: string, options: { handler: (args: string, c: unknown) => Promise<void> }) => commands.set(name, options),
    getSettings: () => ({ hairline: { currency: 'USD' }, compaction: { reserveTokens: 40_000 } }),
    getThinkingLevel: () => 'high',
  }
  hairline(pi as never)
  const usage = { input: 1_000, output: 500, cacheRead: 9_000, cacheWrite: 2_000, totalTokens: 12_500, cost: { total: 0.25 } }
  const entries: unknown[] = []
  let footer: { render(width: number): string[]; dispose(): void } | null = null
  const ctx = {
    cwd: join(repo, 'src'),
    mode: 'tui',
    model: { id: 'claude-opus-5-5', provider: 'anthropic', contextWindow: 200_000 },
    sessionManager: { getSessionId: () => '02c6e8dd-64d4', getEntries: () => entries },
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
    ui: {
      setFooter: (factory: (tui: unknown, theme: unknown, data: unknown) => typeof footer) => {
        footer = factory({ requestRender() {} }, {}, { getGitBranch: () => 'feat/pi', getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} })
      },
      notify() {},
    },
  }
  const emit = (name: string, e: unknown = {}) => handlers.get(name)!(e, ctx)
  const line = () => plain(footer!.render(160)[0]!)
  await emit('session_start', { reason: 'startup' })
  assert.match(line(), /^market-it:feat\/pi .* 25% 50k\/200k · ○ {5}idle .* --- tok/)
  assert.match(line(), /opus 5\.5 high · 02c6e8dd$/)

  await emit('agent_start')
  await emit('turn_start')
  assert.match(line(), /· ↑ /)
  await emit('after_provider_response', { status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.38', 'anthropic-ratelimit-unified-5h-reset': '9999999999' } })
  await emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
  assert.match(line(), /· ↓ /)
  const message = { role: 'assistant', usage, content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'npm test' } }] }
  entries.push({ type: 'message', message })
  await emit('message_end', { message })
  await new Promise(done => setTimeout(done, 1_000)) // the slot scrambles, then settles
  assert.match(line(), /bash npm test/)
  await emit('agent_settled', { aborted: false })
  assert.match(line(), /○ .* 13k tok · 5h 38%/)

  await commands.get('hairline')!.handler('', ctx)
  const panel = footer!.render(160).map(plain)
  assert.match(panel[1]!, /cost {4}\$0\.25/)
  assert.match(panel[3]!, /1 turns/)
  footer!.dispose()
  await emit('session_shutdown', { reason: 'quit' })
})
