import { expect, mock, test } from 'claude-code/testing'

const HINT = {
  plugin: 'hairline',
  component: 'PromptHint',
  requestId: 'PromptHint',
  viewport: { columns: 160, rows: 40 },
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const SESSION_ID = '02c6e8dd-64d4-4f01-8f7f-3a43b20104a2'

test('draws workspace, context, limits, model and a copyable session id', { options: { layout: 'columns', currency: 'USD' } }, async ($, on) => {
  const clock = mock.clock(on)
  // Saved by an earlier load of the module in this session: it wins over the config row.
  const stats = { input: 80, write: 2_000_000, read: 8_300_000, output: 400_000, main: 1_600_000, sub: 800_080, turns: 40, activeMs: 2 * 3_600_000, costStart: 0.82 }
  mock.store(on, { sessions: [{ sessionId: SESSION_ID, effort: 'xhigh', stats }] })
  const copied: string[] = []
  on('session.start', () => ({ cwd: 'C:/code/market-it/src' }))
  on('session.cwd', () => ({ value: 'C:/code/market-it/src' }))
  on('fs.stat', ($, e) => (e.path.replace(/\\/g, "/").endsWith('/code/market-it/.git') ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', ($, e) => (e.path.replace(/\\/g, "/").endsWith('/code/market-it/.git/HEAD') ? { value: 'ref: refs/heads/main\n' } : { deny: 'ENOENT' }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: Date.now() - 7 * 86_400_000, // a resumed session: its age says nothing about cost
      cost: { usd: 4.82 },
      context: {
        tokens: 104_000, window: 200_000, percent: 52,
        breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 160_000 } as never, // compaction at 80%
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 38, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 91, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      ],
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  const modelSets: unknown[] = []
  on('config.list', () => ({
    value: [
      { key: 'effortLevel', label: 'Effort', kind: 'choice', value: 'medium' },
      { key: 'model', label: 'Model', kind: 'choice', value: 'opus[1m]', options: ['sonnet', 'opus', 'haiku', 'opus[1m]'], isLocked: false },
    ] as never,
  }))
  on('config.set', ($, e) => {
    modelSets.push(e.value)
    return { value: e.value } as never
  })
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))
  on('ui.copy', ($, e) => (copied.push(e.text), { value: { isCopied: true } }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/code/market-it/src' })

  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface })
    await clock.settle() // the first render outside the desktop app reads the folder and branch
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'market-it' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined() // the second row leaves the branch room
    expect(await ui.find({ type: 'Text', text: '52%' })).toBeDefined()
    if (surface === 'terminal') {
      // The rule spans the 160 columns: the marker sits at 80%, column 128, past the 83 filled ones.
      const marker = await ui.find({ type: 'Text', text: '┃' })
      expect(marker?.props.color).toBe('ansi256(15)')
    }
    expect(await ui.find({ type: 'Text', text: ' 104k/200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '38%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / (\uf017 )?3d$/ })).toBeDefined()
    // in, out, read and write: 80, 400k, 8.3M, 2M, in one muted Text.
    expect((await ui.find({ type: 'Text', text: /80 in \/ +400k out \/ +8\.3M read \/ +2M write$/ }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'opus 5.5' })).toBeDefined()
    const effort = await ui.find({ type: 'Text', text: surface === 'terminal' ? 'xhigh' : 'high' })
    expect(effort?.props.color).toBe(surface === 'terminal' ? 'ansi256(1)' : 'warning')
    await ui.press({ key: 'hairline-session-id' })

    expect(await ui.find({ key: 'hairline-effort-low' })).toBeUndefined()
    await ui.press({ key: 'hairline-effort' })
    expect(await ui.find({ key: 'hairline-effort-low' })).toBeDefined()
    await ui.press({ key: `hairline-effort-${surface === 'terminal' ? 'high' : 'xhigh'}` })
    expect(await ui.find({ key: 'hairline-effort-low' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: surface === 'terminal' ? 'high' : 'xhigh' })).toBeDefined()

    expect(await ui.find({ type: 'Text', text: /^cost/ })).toBeUndefined()
    await ui.press({ key: 'hairline-token-split' })
    expect((await ui.find({ type: 'Text', text: /400k out/ }))?.props.inverse).toBe(true)
    expect(await ui.find({ type: 'Text', text: /4[.,]82/ })).toBeDefined() // cost, in USD
    expect(await ui.find({ type: 'Text', text: /2[.,]00/ })).toBeDefined() // $4.00 since Hairline's first reading, over 2 active hours
    expect(await ui.find({ type: 'Text', text: '2h' })).toBeDefined() // 2 active hours, no zero unit
    expect(await ui.find({ type: 'Text', text: '81%' })).toBeDefined() // cache hit: 8.3M of 10.3M
    expect(await ui.find({ type: 'Text', text: '67%' })).toBeDefined() // main thread share
    expect(await ui.find({ type: 'Text', text: /^limits/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' measuring' })).toBeDefined() // under 6 minutes of readings
    await ui.press({ key: 'hairline-model' })
    expect(await ui.find({ type: 'Text', text: 'opus[1m]' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^cost/ })).toBeUndefined() // one panel at a time
    await ui.press({ key: 'hairline-model-sonnet' })
    expect(await ui.find({ key: 'hairline-model-haiku' })).toBeUndefined()
    await ui.press({ key: 'hairline-token-split' })

    await ui.press({ key: 'hairline-effort' })
    expect(await ui.find({ type: 'Text', text: /^cost/ })).toBeUndefined()
    expect(await ui.find({ key: 'hairline-effort-low' })).toBeDefined()
    await ui.press({ key: 'hairline-effort' })
    expect(await ui.find({ key: 'hairline-effort-low' })).toBeUndefined()
    await ui.unmount()
  }
  expect(copied).toEqual([SESSION_ID, SESSION_ID])
  expect(modelSets).toEqual(['sonnet', 'sonnet'])

  const narrow = await $.ui.mount({ ...HINT, surface: 'terminal', viewport: { columns: 90, rows: 40 } })
  expect(await narrow.find({ type: 'Text', text: ' 104k/200k' })).toBeDefined()
  await narrow.unmount()

  const working = await $.ui.mount({ ...HINT, surface: 'terminal', props: { ...HINT.props, isWorking: true, hint: 'esc to interrupt' } })
  expect(await working.find({ type: 'Text', text: 'esc to interrupt' })).toBeDefined()
  expect(await working.find({ type: 'Text', text: 'market-it' })).toBeDefined()
})

test('a worktree shows the repository name, then the worktree and the branch', { options: { layout: 'columns' } }, async ($, on) => {
  const clock = mock.clock(on)
  const top = 'C:/code/hairline/.claude/worktrees/extra-usage'
  const at = (path: string, end: string) => path.replace(/\\/g, '/').endsWith(end)
  on('session.start', () => ({ cwd: top }))
  on('session.cwd', () => ({ value: top }))
  on('fs.stat', ($, e) => (at(e.path, '/extra-usage/.git') ? { value: { kind: 'file', size: 60, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', ($, e) => (
    at(e.path, '/extra-usage/.git') ? { value: 'gitdir: C:/code/hairline/.git/worktrees/extra-usage\n' }
      : at(e.path, '/.git/worktrees/extra-usage/HEAD') ? { value: 'ref: refs/heads/feat/x\n' }
        : { deny: 'ENOENT' }) as never)
  on('session.usage', () => ({ value: { startedAt: Date.now(), context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: top })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'hairline' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /extra-usage$/ }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: ' · ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'feat/x' })).toBeDefined()
  await ui.unmount()
})

test('long worktree and branch names are cut to fit the first column on one row', { options: { layout: 'columns' } }, async ($, on) => {
  const clock = mock.clock(on)
  const name = '1245_the-tills-fiscal-module-runs-as'
  const top = `C:/code/market-it/.claude/worktrees/${name}`
  const at = (path: string, end: string) => path.replace(/\\/g, '/').endsWith(end)
  on('session.start', () => ({ cwd: top }))
  on('session.cwd', () => ({ value: top }))
  on('fs.stat', ($, e) => (at(e.path, `/${name}/.git`) ? { value: { kind: 'file', size: 60, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', ($, e) => (
    at(e.path, `/${name}/.git`) ? { value: `gitdir: C:/code/market-it/.git/worktrees/${name}\n` }
      : at(e.path, `/.git/worktrees/${name}/HEAD`) ? { value: `ref: refs/heads/accodev/${name}\n` }
        : { deny: 'ENOENT' }) as never)
  on('session.usage', () => ({ value: { startedAt: Date.now(), context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: top })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await clock.settle()
  const worktree = String((await ui.find({ type: 'Text', text: /^1245_.*…$/ }))?.children?.[0] ?? '')
  const branch = String((await ui.find({ type: 'Text', text: /^accodev\/.*…$/ }))?.children?.[0] ?? '')
  expect(worktree).toMatch(/…$/)
  expect(branch).toMatch(/…$/)
  // market-it, " (", the worktree, " · ", the branch, ")": within the column's 52 cells.
  expect('market-it'.length + 2 + worktree.length + 3 + branch.length + 1).toBeLessThanOrEqual(52)
  await ui.unmount()
})

test('shows cost in the chosen currency at the day\'s ECB rate', { options: { layout: 'columns', currency: 'rmb' } }, async ($, on) => {
  mock.clock(on)
  // Another session saved last: its entry must not replace this one's.
  const other = { sessionId: 'another-session', effort: 'low', stats: { input: 1, write: 0, read: 0, output: 99_000, main: 99_001, sub: 0, turns: 9, activeMs: 1, costStart: 0 } }
  mock.store(on, { sessions: [other, { sessionId: SESSION_ID, stats: { input: 10, write: 1_000, read: 0, output: 500, main: 1_510, sub: 0, turns: 1, activeMs: 60_000, costStart: 0 } }] })
  const fetched: string[] = []
  on('http.fetch', ($, e) => (fetched.push(e.url), { value: { status: 200, ok: true, headers: {}, text: '{"amount":1.0,"base":"USD","date":"2026-10-29","rates":{"CNY":6.6616}}' } }))
  on('session.start', () => ({ cwd: 'C:/code/hairline' }))
  on('session.cwd', () => ({ value: 'C:/code/hairline' }))
  on('fs.stat', ($, e) => (e.path.replace(/\\/g, "/").endsWith('/code/hairline/.git') ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', ($, e) => (e.path.replace(/\\/g, "/").endsWith('/code/hairline/.git/HEAD') ? { value: 'ref: refs/heads/main\n' } : { deny: 'ENOENT' }) as never)
  on('session.usage', () => ({
    value: { startedAt: Date.now(), cost: { usd: 10 }, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/code/hairline' })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await ui.press({ key: 'hairline-token-split' })
  expect(fetched).toEqual(['https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY'])
  expect(await ui.find({ type: 'Text', text: /66[.,]62/ })).toBeDefined() // 10 USD at 6.6616
  expect(await ui.find({ type: 'Text', text: / 500 out/ })).toBeDefined() // this session's 500 out, not the other's 99k
  expect(await ui.find({ type: 'Text', text: /99k out/ })).toBeUndefined()
  await ui.unmount()
})

test('marks the cost with a tilde when the rate cannot be fetched', { options: { layout: 'columns', currency: 'EUR', usdRate: 0.9 } }, async ($, on) => {
  mock.clock(on)
  mock.store(on, { sessions: [{ sessionId: SESSION_ID, stats: { input: 10, write: 1_000, read: 0, output: 500, main: 1_510, sub: 0, turns: 1, activeMs: 60_000, costStart: 0 } }] })
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('session.start', () => ({ cwd: 'C:/code/hairline' }))
  on('session.cwd', () => ({ value: 'C:/code/hairline' }))
  on('fs.stat', ($, e) => (e.path.replace(/\\/g, "/").endsWith('/code/hairline/.git') ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', ($, e) => (e.path.replace(/\\/g, "/").endsWith('/code/hairline/.git/HEAD') ? { value: 'ref: refs/heads/main\n' } : { deny: 'ENOENT' }) as never)
  on('session.usage', () => ({
    value: { startedAt: Date.now(), cost: { usd: 10 }, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/code/hairline' })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await ui.press({ key: 'hairline-token-split' })
  expect(await ui.find({ type: 'Text', text: /^~.*9[.,]00/ })).toBeDefined() // 10 USD at the 0.9 setting
  await ui.unmount()
})

test('a save before the reload restored the counts keeps the token split', { options: { layout: 'columns' } }, async ($, on) => {
  mock.clock(on)
  const stats = { input: 10, write: 1_000, read: 0, output: 500, main: 1_510, sub: 0, turns: 1, activeMs: 60_000, costStart: 0 }
  const kept = new Map<string, unknown>([['sessions', [{ sessionId: SESSION_ID, stats }]]])
  on('store.get', ($, e) => ({ value: kept.get(e.key) }) as never)
  on('store.set', ($, e) => (kept.set(e.key, e.value), { value: undefined }) as never)
  on('session.cwd', () => ({ value: 'C:/code/hairline' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('config.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: Date.now(), context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] } }))
  // The session id comes late, so the restore of the saved counts is still out when the effort is saved.
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  on('session.id', async () => (await held, { value: SESSION_ID }))
  on('turn.step', async function* () { return { turnId: 't', index: 0, answer: '', toolUses: [] } as never })
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  // /reload-plugins: no session.start, the first render loads.
  const mounting = $.ui.mount({ ...HINT, surface: 'terminal' })
  // A request with a new effort saves before the restore is back.
  const step = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, effort: 'high' } as never)[Symbol.asyncIterator]()
  await step.next()
  release()
  const ui = await mounting
  await ui.advance(1_000)
  expect(await ui.find({ type: 'Text', text: / 500 out/ })).toBeDefined()
  const saved = kept.get('sessions') as { sessionId: string; stats: { output: number } }[]
  expect(saved.find(s => s.sessionId === SESSION_ID)?.stats.output).toBe(500)
  await ui.unmount()
})

async function mountWithExtra($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], weekUsed: number) {
  const clock = mock.clock(on)
  const state = { isEnabled: true }
  const asked: { url: string; auth?: string; beta?: string }[] = []
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', ($, e) => {
    asked.push({ url: e.url, auth: e.init?.auth, beta: e.init?.headers?.['anthropic-beta'] })
    const body = e.url.includes('/api/oauth/usage')
      ? { five_hour: { utilization: 25 }, extra_usage: { is_enabled: state.isEnabled, monthly_limit: 10_000, used_credits: 972, utilization: 9.72, currency: 'EUR', decimal_places: 2 } }
      : { rates: { EUR: 0.9 } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('session.start', () => ({ cwd: 'C:/code/hairline' }))
  on('session.cwd', () => ({ value: 'C:/code/hairline' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }) as never)
  on('fs.read', () => ({ deny: 'ENOENT' }) as never)
  on('session.usage', () => ({ value: { startedAt: Date.now(), context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [{ kind: 'seven_day', percentUsed: weekUsed }] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/code/hairline' })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await clock.settle()
  return { ui, clock, state, asked }
}

test('shows the month\'s extra usage spend from 95% of a limit, only while it is enabled', { options: { layout: 'columns' } }, async ($, on) => {
  const { ui, clock, state, asked } = await mountWithExtra($, on, 95)
  expect(asked.find(a => a.url.includes('/api/oauth/usage'))).toEqual({ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'h1', beta: 'oauth-2025-04-20' })
  expect(await ui.find({ type: 'Text', text: 'extra ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^€\s?9[.,]72$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\/€\s?100$/ })).toBeDefined()

  // Turned off on claude.ai: the reading a minute later hides the figure.
  state.isEnabled = false
  await clock.advance(65_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'extra ' })).toBeUndefined()
  await ui.unmount()
})

test('hides the extra usage spend while both limits are under 95%', { options: { layout: 'columns' } }, async ($, on) => {
  const { ui } = await mountWithExtra($, on, 94)
  expect(await ui.find({ type: 'Text', text: '94%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'extra ' })).toBeUndefined()
  await ui.unmount()
})

test('after a reload with no session.start, the line still reads the limits other sessions move, every minute', { options: { layout: 'columns' } }, async ($, on) => {
  const clock = mock.clock(on)
  let fiveHour = 25
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', ($, e) => {
    const body = e.url.includes('/api/oauth/usage') ? { five_hour: { utilization: fiveHour }, seven_day: { utilization: 40 } } : { rates: { EUR: 0.9 } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('session.cwd', () => ({ value: 'C:/code/hairline' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }) as never)
  on('fs.read', () => ({ deny: 'ENOENT' }) as never)
  on('session.usage', () => ({ value: { startedAt: Date.now(), context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined() // the account's, over this session's 10%
  expect(await ui.find({ type: 'Text', text: '40%' })).toBeDefined()

  fiveHour = 31 // another session's requests
  await clock.advance(65_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '31%' })).toBeDefined()
  await ui.unmount()
})

test('draws the line in the desktop band above the prompt, under other mods and never over a survey', { options: { layout: 'columns' } }, async ($, on) => {
  mock.clock(on)
  mock.store(on, { sessions: [{ sessionId: SESSION_ID, effort: null, stats: { input: 10, write: 1_000, read: 0, output: 500, main: 1_510, sub: 0, turns: 1, activeMs: 60_000, costStart: 0 } }] })
  on('session.start', () => ({ cwd: 'C:/code/hairline' }))
  on('session.cwd', () => ({ value: 'C:/code/hairline' }))
  on('fs.stat', ($, e) => (e.path.replace(/\\/g, "/").endsWith('/code/hairline/.git') ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', ($, e) => (e.path.replace(/\\/g, "/").endsWith('/code/hairline/.git/HEAD') ? { value: 'ref: refs/heads/main\n' } : { deny: 'ENOENT' }) as never)
  on('session.usage', () => ({ value: { startedAt: Date.now(), context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  // Another mod's rows in the band, beneath hairline in the chain.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['another mod'] }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:/code/hairline' })
  const band = <S extends 'desktop' | 'terminal'>(surface: S, hasSurvey: boolean) => $.ui.mount({
    plugin: 'hairline',
    component: 'AbovePrompt',
    requestId: 'AbovePrompt',
    surface,
    viewport: { columns: 160, rows: 40 },
    props: { hasSurvey, isWorking: false, maxRows: 20, bodyColumns: 155, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  })

  const desktop = await band('desktop', false)
  expect(await desktop.find({ type: 'Text', text: 'another mod' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: '○ ' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: 'hairline' })).toBeUndefined() // the app shows the folder already
  expect((await desktop.find({ type: 'Text', text: '○ ' }))?.props.mono).toBe(true)
  expect((await desktop.find({ type: 'Text', text: 'another mod' }))?.props.mono).toBeUndefined() // other mods keep their style
  // The token split is a chip there: a click posts, and the hooks module opens the panel.
  expect(await desktop.find({ type: 'Text', text: /^cost/ })).toBeUndefined()
  await desktop.post({ press: true }, { in: 'hairline-token-split' })
  expect(await desktop.find({ type: 'Text', text: /^cost/ })).toBeDefined()
  // The pointer inverts the session ID chip, as it does a terminal Button.
  await desktop.pointer({ type: 'enter', x: 0, y: 0, in: 'hairline-session-id' })
  expect((await desktop.drawn({ in: 'hairline-session-id' })).children?.[0]?.props?.inverse).toBe(true)
  await desktop.pointer({ type: 'leave', x: 0, y: 0, in: 'hairline-session-id' })
  expect((await desktop.drawn({ in: 'hairline-session-id' })).children?.[0]?.props?.inverse).toBeUndefined()
  await desktop.unmount()

  for (const [surface, hasSurvey] of [['terminal', false], ['desktop', true]] as const) {
    const ui = await band(surface, hasSurvey)
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ ' })).toBeUndefined() // the terminal has PromptHint; a survey owns the band
    await ui.unmount()
  }
})
