// Not named *.test.ts: `claude plugin test` would run it with the Claude Code test kit.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { frameText, newGraph, sendingText, graphText, tickGraph } from './anim.ts'
import { cutWorkspace, drawFooter, duration, human, modelLabel, readExtraBody, readUsageLimits, READOUT_WIDTH, readoutTarget, TOOL_WIDTH, toolArg, toolReadout, type View, worktreeOf } from './line.ts'

const chr = String.fromCharCode(27)
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

const view = (over: Partial<View> = {}): View => ({
  folder: 'market-it',
  worktree: null,
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
  extra: null,
  phase: 'idle',
  tools: [],
  readout: readoutTarget('idle', 0, []).text,
  graph: '⠀⠀⠀⠀⠀⠀',
  isLit: false,
  hasNerdFont: false,
  open: null,
  hover: null,
  models: [{ label: 'opus 5.5', isCurrent: true }, { label: 'sonnet 5.5', isCurrent: false }],
  efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  lastTurn: null,
  lastRequestAt: null,
  cacheTtlMinutes: 60,
  money: usd => `$${usd.toFixed(2)}`,
  statuses: [],
  now: Date.now(),
  ...over,
})

test('draws two rows of columns over a rule across the footer', () => {
  const lines = drawFooter(view(), 160).lines
  assert.equal(lines.length, 3)
  for (const line of lines) assert.equal(visibleWidth(line), 160)
  const [top, bottom, bar] = lines.map(plain) as [string, string, string]
  // Idle, the readout is blank.
  assert.match(top, /^market-it \(main\) {40,}5h 38% \S+ +opus 5\.5 high$/)
  assert.match(bottom, /^52% 104k\/200k · compacts at 80% +80 in \/ +400k out \/ +8\.3M read \/ +2M write +7d 91% 3d +02c6e8dd$/)
  // 52% of 160 cells, and the auto-compact mark at 80%: cell 128.
  assert.match(bar, /^━{83}─{45}┃─{31}$/)
})

test('the month\'s extra usage spend follows the limits, only while it is enabled and a window is full', () => {
  const body = (isEnabled: boolean) => JSON.stringify({ five_hour: { utilization: 25 }, extra_usage: { is_enabled: isEnabled, monthly_limit: 10_000, used_credits: 972, utilization: 9.72, currency: 'EUR', decimal_places: 2 } })
  const extra = readExtraBody(body(true))
  assert.deepEqual(extra, { used: 9.72, limit: 100, currency: 'EUR', pct: 9.72 })
  assert.doesNotMatch(drawFooter(view({ extra }), 180).lines.map(plain).join('\n'), /extra/)
  const capped = view({ extra, limits: [{ kind: 'five_hour', percentUsed: 38 }, { kind: 'seven_day', percentUsed: 100, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }] })
  assert.match(plain(drawFooter(capped, 180).lines[1]!), /7d 100% 3d · extra €\s?9[.,]72\/€\s?100 /)
  assert.equal(readExtraBody(body(false)), null)
  assert.equal(readExtraBody('{"extra_usage":null}'), null)
  // The same reply carries the account's limits, other sessions' use included.
  assert.deepEqual(readUsageLimits('{"five_hour":{"utilization":31.04,"resets_at":"2026-11-17T15:00:00Z"},"seven_day":{"utilization":40},"seven_day_opus":null}'), [
    { kind: 'five_hour', percentUsed: 31, resetsAt: '2026-11-17T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 40 },
  ])
  assert.deepEqual(readUsageLimits('{"five_hour":null}'), [])
})

test('a worktree shows after the repository name, next to the branch', () => {
  assert.deepEqual(worktreeOf('C:/code/hairline/.git/worktrees/extra-usage', 'C:/code/hairline/.claude/worktrees/extra-usage'), { name: 'hairline', worktree: 'extra-usage' })
  assert.deepEqual(worktreeOf('/home/dev/app/.git/modules/lib', '/home/dev/app/lib'), { name: 'lib', worktree: null })
  const top = (v: Partial<View>) => plain(drawFooter(view({ folder: 'hairline', worktree: 'extra-usage', branch: 'feat/x', ...v }), 180).lines[0]!)
  assert.match(top({}), /^hairline \(extra-usage · feat\/x\) /)
  assert.match(top({ hasNerdFont: true }), /^hairline \(\uf07b extra-usage · \ue725 feat\/x\) /)
  assert.match(top({ worktree: null, branch: null }), /^hairline /)
  // Long names are cut to the column, the longer first, and the row stays one row.
  const name = '1245_the-tills-fiscal-module-runs-as'
  const cut = cutWorkspace('market-it', name, `accodev/${name}`, false, 52)
  assert.equal('market-it'.length + 2 + cut.worktree.length + 3 + cut.branch.length + 1, 52)
  assert.match(cut.worktree, /…$/)
  assert.match(cut.branch, /…$/)
})

test('a narrow footer shortens the workspace first and keeps every figure', () => {
  const [top, bottom] = drawFooter(view({ folder: 'a-very-long-folder-name-for-a-repository', worktree: 'a-long-worktree' }), 140).lines.map(plain) as [string, string]
  assert.equal(visibleWidth(top), 140)
  assert.match(top, /…/)
  assert.match(bottom, /7d 91%/)
  assert.match(bottom, /02c6e8dd$/)
})

test('a narrow footer keeps the model, the thinking level and the session id', () => {
  for (const width of [120, 140, 160]) {
    const [top, bottom] = drawFooter(view(), width).lines.map(plain) as [string, string]
    assert.equal(visibleWidth(top), width)
    assert.match(top, /opus 5\.5 high$/)
    assert.match(bottom, /02c6e8dd$/)
  }
})

test('the token split, the model, the thinking level and the session id are clickable', () => {
  const { lines, hits } = drawFooter(view(), 160)
  const at = (action: string) => {
    const hit = hits.find(h => h.action === action)!
    return [...plain(lines[hit.row]!)].slice(hit.from, hit.to).join('').trim()
  }
  assert.match(at('ledger'), /^80 in \/ +400k out \/ +8\.3M read \/ +2M write$/)
  assert.equal(at('model'), 'opus 5.5')
  assert.equal(at('effort'), 'high')
  assert.equal(at('id'), '02c6e8dd')
})

test('the part under the pointer is underlined', () => {
  const line = drawFooter(view({ hover: 'model' }), 160).lines[0]!
  assert.ok(line.includes(`${chr}[4mopus 5.5${chr}[0m`))
  assert.ok(!drawFooter(view(), 160).lines[0]!.includes(`${chr}[4m`))
})

test('the pickers list the models and the thinking levels under the line', () => {
  const model = drawFooter(view({ open: 'model' }), 160)
  assert.match(plain(model.lines[3]!), /model {2}opus 5\.5 sonnet 5\.5$/)
  assert.deepEqual(model.hits.filter(h => h.row === 3).map(h => h.action), ['model:0', 'model:1'])
  const effort = drawFooter(view({ open: 'effort' }), 160)
  assert.match(plain(effort.lines[3]!), /thinking {2}off minimal low medium high xhigh$/)
  const xhigh = effort.hits.find(h => h.action === 'effort:xhigh')!
  assert.equal([...plain(effort.lines[3]!)].slice(xhigh.from, xhigh.to).join(''), 'xhigh')
})

test('the panel lists cost, tokens, turns and limits, and other extensions keep their status', () => {
  const lines = drawFooter(view({ open: 'ledger', statuses: ['lsp: ready'] }), 160).lines.map(plain)
  assert.equal(lines.length, 8)
  assert.match(lines[3]!, /^ {2}cost {4}\$4\.82 · \$2\.00 per active hour/)
  assert.match(lines[4]!, /^ {2}tokens {2}80 in · 2M cache write · 8\.3M cache read · 400k out · 81% cache hit/)
  assert.match(lines[5]!, /^ {2}turns {3}40 turns · 2h active/)
  assert.match(lines[6]!, /^ {2}limits {2}5h 38% measuring · 7d 91% measuring/)
  assert.equal(lines[7], 'lsp: ready')
})

test('the activity keeps one width in every phase', () => {
  const widths = (['idle', 'sending', 'receiving'] as const).map(phase => readoutTarget(phase, 1234, []).text.length)
  assert.deepEqual(widths, [READOUT_WIDTH, READOUT_WIDTH, READOUT_WIDTH])
  const tool = toolReadout([{ name: 'bash', arg: 'npm test' }], TOOL_WIDTH)
  assert.equal(tool.text.length, TOOL_WIDTH)
  assert.equal(tool.bright, 4)
  const toolLines = drawFooter(view({ phase: 'tool', tools: [{ name: 'bash', arg: 'npm test' }], readout: tool.text }), 160).lines.map(plain)
  const idleLines = drawFooter(view(), 160).lines.map(plain)
  assert.equal(toolLines[1]!.indexOf('80 in'), idleLines[1]!.indexOf('80 in'))
  assert.equal(toolLines[0]!.indexOf('5h'), idleLines[0]!.indexOf('5h'))
})

test('tool arguments name the file, the command or the pattern', () => {
  assert.equal(toolArg({ path: 'C:\\code\\hairline\\pi\\index.ts' }), 'index.ts')
  assert.equal(toolArg({ command: 'npm test' }), 'npm test')
  assert.equal(toolArg({ pattern: 'TODO', path: 'src' }), 'src')
  assert.equal(toolArg({ url: 'https://www.example.com/a' }), 'example.com/a')
  assert.equal(toolReadout([{ name: 'read', arg: 'a' }, { name: 'read', arg: 'b' }], TOOL_WIDTH).text.trim(), 'read ×2')
})

test('figures and times keep their short forms', () => {
  assert.equal(human(999_499), '999k')
  assert.equal(human(999_500), '1M')
  assert.equal(human(999_994_999), '999.99M')
  assert.equal(human(999_995_000), '1B') // no 1000M
  assert.equal(human(1_234_000_000), '1.23B')
  assert.equal(human(100e9), '100B')
  assert.equal(human(1e12), '1T')
  assert.equal(human(250e15), '250Q')
  assert.equal(duration(500), '1s')
  assert.equal(duration(3 * 86_400_000 + 2 * 3_600_000), '3d 2h')
  assert.equal(modelLabel('claude-sonnet-5-5'), 'sonnet 5.5')
  assert.equal(sendingText(4_160, 8), '    4.1s')
})

test('the readout scrambles, then settles left to right', () => {
  assert.notEqual(frameText('idle', 'sending', 0), 'sending')
  assert.equal(frameText('idle', 'sending', 2 + 7), 'sending')
})

test('the graph rises with the stream and settles flat after it', () => {
  const s = newGraph()
  for (let i = 0; i < 40; i++) tickGraph(s, 33, 100, false)
  assert.notEqual(graphText(s, true, false), '⠀⠀⠀⠀⠀⠀')
  for (let i = 0; i < 400 && !s.isSettled; i++) tickGraph(s, 33, 0, false)
  assert.ok(s.isSettled)
  assert.equal(graphText(s, false, false), '⣀⣀⣀⣀⣀⣀')
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
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: string) => { thinking = level },
    setModel: async (m: { id: string }) => { picked.push(m.id); return true },
  }
  let thinking = 'high'
  const picked: string[] = []
  hairline(pi as never)
  const usage = { input: 1_000, output: 500, cacheRead: 9_000, cacheWrite: 2_000, totalTokens: 12_500, cost: { total: 0.25 } }
  const entries: unknown[] = []
  let footer: { render(width: number): string[]; dispose(): void; handleMouse(e: object): unknown } | null = null
  const ctx = {
    cwd: join(repo, 'src'),
    mode: 'tui',
    model: { id: 'claude-opus-5-5', provider: 'anthropic', contextWindow: 200_000, reasoning: true },
    scopedModels: [{ model: { id: 'claude-opus-5-5', provider: 'anthropic' } }, { model: { id: 'claude-sonnet-5-5', provider: 'anthropic' } }],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: { getSessionId: () => '02c6e8dd-64d4', getEntries: () => entries },
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
    ui: {
      setFooter: (factory: (tui: unknown, theme: unknown, data: unknown) => typeof footer) => {
        footer = factory({ requestRender() {} }, {}, { getGitBranch: () => 'feat/pi', getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} })
      },
      notify() {},
      onTerminalInput: () => () => {},
    },
  }
  const emit = (name: string, e: unknown = {}) => handlers.get(name)!(e, ctx)
  const line = () => footer!.render(160).slice(0, 2).map(plain).join('\n')
  await emit('session_start', { reason: 'startup' })
  assert.match(line(), /^market-it \((?:\S )?feat\/pi\) .*opus 5\.5 high\n25% 50k\/200k .*--- tok .*02c6e8dd$/)

  await emit('agent_start')
  await emit('turn_start')
  assert.match(line(), / ↑ /)
  await emit('after_provider_response', { status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.38', 'anthropic-ratelimit-unified-5h-reset': '9999999999' } })
  await emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
  assert.match(line(), / ↓ /)
  const message = { role: 'assistant', usage, content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'npm test' } }] }
  entries.push({ type: 'message', message })
  await emit('message_end', { message })
  await new Promise(done => setTimeout(done, 1_000)) // the readout scrambles, then settles
  assert.match(line(), /bash npm test/)
  await emit('agent_settled', { aborted: false })
  assert.match(line(), /5h 38%[\s\S]*1k in \/ +500 out \/ +9k read \/ +2k write/)

  const click = async (text: string, row = 0) => {
    const x = [...plain(footer!.render(160)[row]!)].join('').indexOf(text)
    assert.ok(x >= 0, text)
    for (const type of ['press', 'click']) footer!.handleMouse({ type, button: 'left', x, y: row })
    await new Promise(done => setTimeout(done, 10))
  }
  await click('1k in', 1)
  const panel = footer!.render(160).map(plain)
  assert.match(panel[3]!, /cost {4}\$0\.25/)
  assert.match(panel[5]!, /1 turns/)
  await click('1k in', 1)
  assert.equal(footer!.render(160).length, 3)
  await click('opus 5.5')
  await click('sonnet 5.5', 3)
  assert.deepEqual(picked, ['claude-sonnet-5-5'])
  await click('high')
  await click('low', 3)
  assert.equal(thinking, 'low')
  footer!.dispose()
  await emit('session_shutdown', { reason: 'quit' })
})
