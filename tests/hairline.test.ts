import { expect, mock, test } from 'claude-code/testing'

const HINT = {
  plugin: 'hairline',
  component: 'PromptHint',
  requestId: 'PromptHint',
  viewport: { columns: 160, rows: 40 },
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const SESSION_ID = '02c6e8dd-64d4-4f01-8f7f-3a43b20104a2'

test('draws location, context, limits, model and a copyable session id', { options: { currency: 'USD' } }, async ($, on) => {
  mock.clock(on)
  // Saved by an earlier load of the module in this session: it wins over the config row.
  const stats = { input: 80, write: 2_000_000, read: 8_300_000, output: 400_000, main: 1_600_000, sub: 800_080, turns: 40, activeMs: 2 * 3_600_000, costStart: 0.82 }
  mock.store(on, { sessions: [{ sessionId: SESSION_ID, effort: 'xhigh', stats }] })
  const copied: string[] = []
  on('session.start', () => ({ cwd: 'C:/code/market-it/src' }))
  on('session.cwd', () => ({ value: 'C:/code/market-it/src' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'C:/code/market-it\nmain\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface })
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'market-it' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  52%' })).toBeDefined()
    if (surface === 'terminal') {
      // 80% of 16 cells: the marker sits in cell 12, past the 8 filled cells.
      const marker = await ui.find({ type: 'Text', text: '┃' })
      expect(marker?.props.color).toBe('ansi256(15)')
    }
    expect(await ui.find({ type: 'Text', text: ' 104k/200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '38%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / ↻3d$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '10.7M tok' })).toBeDefined()
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
    await ui.press({ key: 'hairline-tokens' })
    expect((await ui.find({ type: 'Text', text: '10.7M tok' }))?.props.inverse).toBe(true)
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
    await ui.press({ key: 'hairline-tokens' })

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
  expect((await narrow.find({ type: 'Text', text: 'main' }))?.props.wrap).toBe('truncate-end')
  expect(await narrow.find({ type: 'Text', text: ' 104k/200k' })).toBeDefined()
  await narrow.unmount()

  const working = await $.ui.mount({ ...HINT, surface: 'terminal', props: { ...HINT.props, isWorking: true, hint: 'esc to interrupt' } })
  expect(await working.find({ type: 'Text', text: 'esc to interrupt' })).toBeDefined()
  expect(await working.find({ type: 'Text', text: 'market-it' })).toBeDefined()
})

test('shows cost in the chosen currency at the day\'s ECB rate', { options: { currency: 'rmb' } }, async ($, on) => {
  mock.clock(on)
  // Another session saved last: its entry must not replace this one's.
  const other = { sessionId: 'another-session', effort: 'low', stats: { input: 1, write: 0, read: 0, output: 99_000, main: 99_001, sub: 0, turns: 9, activeMs: 1, costStart: 0 } }
  mock.store(on, { sessions: [other, { sessionId: SESSION_ID, stats: { input: 10, write: 1_000, read: 0, output: 500, main: 1_510, sub: 0, turns: 1, activeMs: 60_000, costStart: 0 } }] })
  const fetched: string[] = []
  on('http.fetch', ($, e) => (fetched.push(e.url), { value: { status: 200, ok: true, headers: {}, text: '{"amount":1.0,"base":"USD","date":"2026-10-29","rates":{"CNY":6.6616}}' } }))
  on('session.start', () => ({ cwd: 'C:/code/hairline' }))
  on('session.cwd', () => ({ value: 'C:/code/hairline' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'C:/code/hairline\nmain\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({
    value: { startedAt: Date.now(), cost: { usd: 10 }, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/code/hairline' })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await ui.press({ key: 'hairline-tokens' })
  expect(fetched).toEqual(['https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY'])
  expect(await ui.find({ type: 'Text', text: /66[.,]62/ })).toBeDefined() // 10 USD at 6.6616
  expect(await ui.find({ type: 'Text', text: '2k tok' })).toBeDefined() // this session's 1,510, not the other's 99,001
  await ui.unmount()
})

test('marks the cost with a tilde when the rate cannot be fetched', { options: { currency: 'EUR', usdRate: 0.9 } }, async ($, on) => {
  mock.clock(on)
  mock.store(on, { sessions: [{ sessionId: SESSION_ID, stats: { input: 10, write: 1_000, read: 0, output: 500, main: 1_510, sub: 0, turns: 1, activeMs: 60_000, costStart: 0 } }] })
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('session.start', () => ({ cwd: 'C:/code/hairline' }))
  on('session.cwd', () => ({ value: 'C:/code/hairline' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'C:/code/hairline\nmain\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({
    value: { startedAt: Date.now(), cost: { usd: 10 }, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['hint' in e.props ? e.props.hint : ''] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/code/hairline' })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await ui.press({ key: 'hairline-tokens' })
  expect(await ui.find({ type: 'Text', text: /^~.*9[.,]00/ })).toBeDefined() // 10 USD at the 0.9 setting
  await ui.unmount()
})
