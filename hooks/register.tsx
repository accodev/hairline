import type { ConfigRow, EngineInterface, PluginOptions, Register, RenderChildren, SessionContextUsage, SessionRateLimit } from 'claude-code'

const BAR_CELLS = 16
const WARN_FROM = 60
const BAD_FROM = 85
const RESET_SHOWN_FROM = 70
const LOCATION_REFRESH_MS = 5_000
const RATE_WINDOW_MS = 1_000
const RATE_WARMUP_MS = 300
const HINT_REDRAWS_MAX = 30 // Claude Code folds hint-line redraws past 30 a second
const FRAMES_MAX = 60 // surfaces paint about 60 frames a second
const RATIO_MIN_TOKENS = 20 // shorter responses give a noisy characters-per-token ratio
const RATIO_MIN = 2
const RATIO_MAX = 6
const BURN_MIN_HOURS = 0.1
const HOUR_MS = 3_600_000
const CURRENCIES = ['USD', 'CAD', 'AUD', 'EUR', 'JPY', 'CNY'] as const
const RATES_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=' // European Central Bank rates, no key
// The plain glyphs are in Cascadia, Consolas and Menlo, for terminals without a Nerd Font.
const PHASE_GLYPHS = {
  nerd: { tool: '', idle: '' }, // nf-fa-cog, nf-fa-pause: private-use code points that most editors show as boxes
  plain: { tool: '↻', idle: '‖' },
} as const
const RATE_LIMIT_WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: '7d' },
] as const

// Terminal slots 0-15 (ansi256(n), n < 16) take each person's color scheme. Other surfaces get
// Claude Code theme keys, which follow the light or dark theme.
type Palette = {
  ok: string; warn: string; bad: string; folder: string; branch: string; track: string; marker: string
  effort: readonly string[]; ramp: readonly string[]
}
const TERMINAL_PALETTE: Palette = {
  ok: 'ansi256(2)', warn: 'ansi256(3)', bad: 'ansi256(1)', folder: 'ansi256(4)', branch: 'ansi256(5)', track: 'ansi256(8)', marker: 'ansi256(15)',
  effort: ['ansi256(4)', 'ansi256(5)', 'ansi256(13)', 'ansi256(1)', 'ansi256(9)'],
  ramp: ['ansi256(10)', 'ansi256(2)', 'ansi256(11)', 'ansi256(3)', 'ansi256(1)', 'ansi256(9)'],
}
const THEME_PALETTE: Palette = {
  ok: 'success', warn: 'warning', bad: 'error', folder: 'suggestion', branch: 'merged', track: 'subtle', marker: 'text',
  effort: ['suggestion', 'merged', 'warning', 'error', 'error'],
  ramp: ['success', 'success', 'warning', 'warning', 'error', 'error'],
}
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

type Stats = {
  input: number
  write: number
  read: number
  output: number
  main: number
  sub: number
  turns: number
  activeMs: number
  // Cost per hour counts from here: the cost before Hairline loaded has no turn time to divide by.
  costStart: number | null
}
type LimitStart = Record<string, { pct: number; at: number; resetsAt?: string }>

type Session = {
  folder: string
  branch: string | null
  effort: string | null
  stats: Stats
  limitStart: LimitStart
  tokensPerSecond: number
  phase: 'sending' | 'receiving' | 'tool' | 'idle'
  streaming: boolean
  context: SessionContextUsage | null
  compactAt: number | null
  rateLimits: SessionRateLimit[]
  costUsd: number | null
  lastTurn: { tokens: number; ms: number } | null
  lastTurnUsd: number | null
  lastRequestAt: number | null // the prompt cache's TTL counts from here
  pickedEffort: string | null
  // A change to either clears the pick, so /effort and /model still work after a pick.
  pickBase: { effort: string | null; model: string | null } | null
  // Read before the rewrite: after it, the pick would hide a change made with /effort.
  seen: { effort: string | null; model: string | null }
}

const emptyStats = (): Stats => ({ input: 0, write: 0, read: 0, output: 0, main: 0, sub: 0, turns: 0, activeMs: 0, costStart: null })
const emptySession = (): Session => ({
  folder: '', branch: null, effort: null, stats: emptyStats(), limitStart: {}, tokensPerSecond: 0, phase: 'idle', streaming: false,
  context: null, compactAt: null, rateLimits: [], costUsd: null, lastTurn: null, lastTurnUsd: null, lastRequestAt: null, pickedEffort: null, pickBase: null, seen: { effort: null, model: null },
})
let session = emptySession()
let loaded = false
type Panel = 'tokens' | 'effort' | 'model'
let open: Panel | null = null
function setOpen($: EngineInterface, panel: Panel | null): void {
  open = panel
  redraw($)
}
const toggle = ($: EngineInterface, panel: Panel) => setOpen($, open === panel ? null : panel)
let modelRow: { value: string; options: readonly string[] } | null = null
let charsPerToken = 4 // the usual English ratio, until the first response measures it

type Settings = { currency: string; usdRate: number; cacheTtlMinutes: number; refreshPerSecond: number; frameRate: number; nerdFont: boolean }
let settings: Settings = { currency: 'USD', usdRate: 1, cacheTtlMinutes: 60, refreshPerSecond: HINT_REDRAWS_MAX, frameRate: 30, nerdFont: false }

// Set once a day: the ECB publishes one rate per working day.
let exchange: { currency: string; rate: number; fetchedOn: string } | null = null
let exchangeTriedAt = 0

function readSettings(options: PluginOptions): Settings {
  const code = String(options.currency || 'USD').trim().toUpperCase().replace(/^RMB$/, 'CNY')
  const rate = Number(options.usdRate)
  const ttl = Number(options.cacheTtlMinutes)
  const refresh = Number(options.speedRefreshPerSecond)
  const frames = Number(options.animationFps)
  return {
    currency: (CURRENCIES as readonly string[]).includes(code) ? code : 'USD',
    usdRate: rate > 0 ? rate : 1,
    cacheTtlMinutes: ttl > 0 ? ttl : 60,
    refreshPerSecond: refresh > 0 ? Math.min(HINT_REDRAWS_MAX, Math.max(1, refresh)) : HINT_REDRAWS_MAX,
    frameRate: frames > 0 ? Math.min(FRAMES_MAX, Math.max(1, frames)) : 30,
    nerdFont: options.nerdFont === true,
  }
}

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')
const counted = (s: Stats) => s.input + s.write + s.output // cache reads re-count the same context

function severity(c: Palette, pct: number): string {
  return pct >= BAD_FROM ? c.bad : pct >= WARN_FROM ? c.warn : c.ok
}

function filledCells(pct: number): number {
  return Math.round((Math.min(pct, 100) / 100) * BAR_CELLS)
}

// Red at the compaction point, which is where the context runs out in practice.
function rampColor(c: Palette, pct: number, compactAt: number | null): string {
  const share = pct / (compactAt ?? 100)
  return c.ramp[Math.min(c.ramp.length - 1, Math.floor(share * c.ramp.length))]!
}

// The breakdown comes from the local /context estimate, which costs no API request.
async function readCompactAt($: EngineInterface): Promise<void> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    session.compactAt = b?.isAutoCompactEnabled && b.autoCompactThreshold ? (b.autoCompactThreshold / context.window) * 100 : null
    redraw($)
  } catch {}
}

function human(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M` // 999,500 rounds to 1M; a lower cut would print 1000k
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// 2 units, as humanize-duration and pretty-ms default to, so every time on the line and in the
// panel has the same form. Intl.DurationFormat gives the reader's locale.
const DURATION_UNITS = [
  ['days', 86_400_000],
  ['hours', 3_600_000],
  ['minutes', 60_000],
  ['seconds', 1_000],
] as const
// The runtime has Intl.DurationFormat (ES2025); TypeScript 5.6's lib does not declare it yet.
declare global {
  namespace Intl {
    class DurationFormat {
      constructor(locales?: string, options?: { style?: 'long' | 'short' | 'narrow' | 'digital' })
      format(duration: Partial<Record<'days' | 'hours' | 'minutes' | 'seconds', number>>): string
    }
  }
}
const durationFormat = new Intl.DurationFormat(undefined, { style: 'narrow' })

function duration(ms: number): string {
  const largest = DURATION_UNITS.findIndex(([, size]) => ms >= size)
  const first = largest === -1 ? DURATION_UNITS.length - 1 : largest // an empty format prints nothing, so under 1 second shows "0s"
  const shown = DURATION_UNITS.slice(first, first + 2)
  let left = Math.round(Math.max(0, ms) / shown[shown.length - 1]![1]) * shown[shown.length - 1]![1]
  const parts: Partial<Record<(typeof DURATION_UNITS)[number][0], number>> = {}
  for (const [unit, size] of shown) {
    parts[unit] = Math.floor(left / size)
    left -= parts[unit]! * size
  }
  return durationFormat.format(parts)
}

const untilReset = (resetsAt: string) => duration(Date.parse(resetsAt) - Date.now())

// usdRate stays the rate when the fetch fails or the organization's web-fetch policy refuses it.
async function readExchange($: EngineInterface): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  if (settings.currency === 'USD' || (exchange?.currency === settings.currency && exchange.fetchedOn === today)) return
  if (Date.now() - exchangeTriedAt < HOUR_MS) return // a failed fetch waits an hour, the clock ticks every 5 s
  exchangeTriedAt = Date.now()
  try {
    const { ok, text } = await $.http.fetch(RATES_URL + settings.currency)
    const body = JSON.parse(text) as { rates: Record<string, number> }
    const rate = body.rates[settings.currency]
    if (!ok || !rate || rate <= 0) return
    exchange = { currency: settings.currency, rate, fetchedOn: today }
    exchangeTriedAt = 0
    redraw($)
  } catch {}
}

// The tilde marks an amount at the usdRate setting, which is only an estimate of the rate.
function money(usd: number): string {
  const rate = settings.currency === 'USD' ? 1 : exchange?.currency === settings.currency ? exchange.rate : null
  const amount = new Intl.NumberFormat(undefined, { style: 'currency', currency: settings.currency, maximumFractionDigits: 2 }).format(usd * (rate ?? settings.usdRate))
  return rate === null ? `~${amount}` : amount
}

function modelLabel(id: string): string {
  const [family, ...version] = id.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').split('-')
  return version.length ? `${family} ${version.join('.')}` : family ?? id
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

// /reload-plugins clears the module, and no engine call reports these values again.
const SAVED_KEY = 'session'
type Saved = { sessionId: string; effort: string | null; pickedEffort?: string | null; pickBase?: Session['pickBase']; stats?: Stats; limitStart?: LimitStart }

function save($: EngineInterface): void {
  const { effort, pickedEffort, pickBase, stats, limitStart } = session
  void $.session.id()
    .then(sessionId => $.store.set(SAVED_KEY, { sessionId, effort, pickedEffort, pickBase, stats, limitStart } satisfies Saved))
    .catch(() => {})
}

async function restore($: EngineInterface): Promise<Saved | undefined> {
  try {
    const saved = (await $.store.get(SAVED_KEY)) as Saved | undefined
    return saved?.sessionId === (await $.session.id()) ? saved : undefined
  } catch {
    return undefined
  }
}

function setEffort($: EngineInterface, value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number') return
  if (String(value) === session.effort) return
  session.effort = String(value)
  redraw($)
  save($)
}

// A window reset restarts the fill rate. Readings of the reset time jitter by seconds, so only a
// move of 1 minute or more counts as a new window.
const WINDOW_MOVED_MS = 60_000

function trackLimits($: EngineInterface, limits: SessionRateLimit[]): void {
  let changed = false
  for (const l of limits) {
    const start = session.limitStart[l.kind]
    const isNewWindow = !!start && (
      l.percentUsed < start.pct ||
      (!!l.resetsAt && !!start.resetsAt && Date.parse(l.resetsAt) - Date.parse(start.resetsAt) > WINDOW_MOVED_MS)
    )
    if (!start || isNewWindow) {
      session.limitStart[l.kind] = { pct: l.percentUsed, at: Date.now(), resetsAt: l.resetsAt }
      changed = true
    }
  }
  if (changed) save($)
}

function readRows(rows: readonly ConfigRow[]): void {
  const row = rows.find(r => r.key === 'model' && r.kind === 'choice')
  modelRow = row?.options?.length && !row.isLocked ? { value: String(row.value), options: row.options } : null
}

// One process for both values: a spawn costs more than the git work.
async function readLocation($: EngineInterface): Promise<void> {
  try {
    const cwd = await $.session.cwd()
    const out = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 2_000 })
    const [top = cwd, branch = null] = out.exitCode === 0 ? out.stdout.trim().split(/\r?\n/) : [cwd]
    if (basename(top) === session.folder && branch === session.branch) return
    session.folder = basename(top)
    session.branch = branch
    redraw($)
  } catch {}
}

// Also called from the first render: after /reload-plugins, session.start does not fire.
async function load($: EngineInterface): Promise<void> {
  loaded = true
  await readLocation($)
  void readExchange($)
  const saved = await restore($)
  if (saved?.stats && counted(saved.stats) > counted(session.stats)) session.stats = { ...emptyStats(), ...saved.stats }
  if (saved?.limitStart) session.limitStart = { ...saved.limitStart, ...session.limitStart }
  try {
    const usage = await $.session.usage()
    session.context = usage.context
    session.rateLimits = usage.rateLimits
    session.costUsd = usage.cost?.usd ?? null
    session.stats.costStart ??= session.costUsd
    trackLimits($, usage.rateLimits)
  } catch {
    // the first session.measure sends the numbers
  }
  await readCompactAt($)
  try {
    session.pickedEffort = saved?.pickedEffort ?? null
    session.pickBase = saved?.pickBase ?? null
    const rows = await $.config.list()
    readRows(rows)
    setEffort($, session.pickedEffort ?? saved?.effort ?? rows.find(row => /effort/i.test(row.key))?.value)
  } catch {
    // the first request sends the effort
  }
  redraw($)
}

export const register: Register = (on, options) => {
  settings = readSettings(options)
  let timerStarted = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    session = emptySession()
    await load($)
    if (!timerStarted) {
      timerStarted = true
      $.clock.every(LOCATION_REFRESH_MS, () => {
        void readLocation($)
        void readExchange($)
        if (open === 'tokens') redraw($) // the cache countdown changes with no event
      })
    }
    return result
  })

  // Streams carry characters, so the speed divides by the characters per token of the last response.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    session.seen = { effort: e.effort === undefined ? null : String(e.effort), model: e.model }
    if (session.pickedEffort) {
      const base = session.pickBase
      if (!base || base.effort === null) session.pickBase = { ...session.seen } // a pick before any request has no base to compare
      else if (base.effort !== session.seen.effort || base.model !== session.seen.model) {
        session.pickedEffort = null
        session.pickBase = null
        save($)
        $.ui.toast('effort pick cleared: /effort or the model changed')
      }
    }
    if (session.pickedEffort && e.effort !== undefined) e = { ...e, effort: session.pickedEffort as typeof e.effort }
    setEffort($, e.effort)
    session.phase = 'sending'
    redraw($)
    let firstChunkAt = 0
    let chars = 0
    let lastSample = 0
    const recent: { at: number; chars: number }[] = []
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        const now = Date.now()
        firstChunkAt ||= now
        const piece = chunk.kind === 'text' || chunk.kind === 'thinking' ? chunk.text.length : chunk.kind === 'input' ? chunk.json.length : 0
        if (piece) {
          session.streaming = true
          if (session.phase !== 'receiving') {
            session.phase = 'receiving'
            redraw($)
          }
          chars += piece
          recent.push({ at: now, chars: piece })
          while (recent[0]!.at < now - RATE_WINDOW_MS) recent.shift()
          if (now - firstChunkAt >= RATE_WARMUP_MS && now - lastSample >= 1000 / settings.refreshPerSecond) {
            const windowSecs = Math.min(RATE_WINDOW_MS, now - firstChunkAt) / 1000
            session.tokensPerSecond = Math.round(recent.reduce((sum, r) => sum + r.chars, 0) / charsPerToken / windowSecs)
            lastSample = now
            redraw($)
          }
        }
        // Only the stop chunk has real token counts, so it sets the ratio for the next reply.
        if (chunk.kind === 'stop' && chunk.usage && chunk.usage.output_tokens >= RATIO_MIN_TOKENS && chars) {
          charsPerToken = Math.min(RATIO_MAX, Math.max(RATIO_MIN, chars / chunk.usage.output_tokens))
        }
        yield chunk
      }
      return await stream.result
    } finally {
      session.lastRequestAt = Date.now()
      session.phase = 'tool' // a request without a turn.complete after it runs a tool
      if (session.streaming) {
        session.streaming = false
        session.tokensPerSecond = 0
        redraw($)
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      session.phase = 'idle'
      redraw($)
    }
    const u = result?.usage
    if (u) {
      const s = session.stats
      const spent = u.input_tokens + u.cache_creation_input_tokens + u.output_tokens
      s.input += u.input_tokens
      s.write += u.cache_creation_input_tokens
      s.read += u.cache_read_input_tokens
      s.output += u.output_tokens
      s.turns += 1
      if (e.agentId) s.sub += spent
      else {
        s.main += spent
        s.activeMs += e.durationMs
        session.lastTurn = { tokens: spent, ms: e.durationMs }
      }
      redraw($)
      save($)
    }
    return result
  })

  on('session.measure', ($, e, next) => {
    const windowChanged = e.context.window !== session.context?.window // a /model switch moves the compaction point
    session.context = e.context
    session.rateLimits = e.rateLimits
    trackLimits($, e.rateLimits)
    // The engine measures after each main-thread turn, so the cost step is that turn's cost.
    if (e.cost && e.cost.usd !== session.costUsd) {
      if (session.costUsd !== null) session.lastTurnUsd = e.cost.usd - session.costUsd
      session.costUsd = e.cost.usd
      session.stats.costStart ??= e.cost.usd
    }
    redraw($)
    if (windowChanged) void readCompactAt($)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineHint = await next(e)
    if (!loaded) void load($)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Client = 'Client' in elements ? elements.Client : null // only the terminal and the desktop app run Client modules
    const c = e.surface === 'terminal' ? TERMINAL_PALETTE : THEME_PALETTE
    const [model, sessionId] = await Promise.all([$.session.model().catch(() => ''), $.session.id().catch(() => '')])
    const { folder, branch, effort, stats, tokensPerSecond, context, compactAt, rateLimits } = session
    const tokens = counted(stats)
    const pct = context?.percent ?? null
    const now = Date.now()

    const Sep = () => <Text dimColor> · </Text>
    const glyphs = PHASE_GLYPHS[settings.nerdFont && e.surface === 'terminal' ? 'nerd' : 'plain']
    const Phase = () => {
      switch (session.phase) {
        case 'sending': return <Text color={c.folder}>↑ </Text>
        case 'receiving': return <Text color={c.ok}>↓ </Text>
        case 'tool': return <Text color={c.warn}>{`${glyphs.tool} `}</Text>
        case 'idle': return <Text dimColor>{`${glyphs.idle} `}</Text>
      }
    }
    const Percent = ({ value }: { value: number }) => <Text color={severity(c, value)}>{`${Math.round(value)}%`}</Text>

    // The desktop app draws line glyphs wider than a cell, so it gets painted boxes.
    const filled = pct === null ? 0 : filledCells(pct)
    // In the last cell the marker would only repeat the bar's own end, so it hides there.
    const compactCell = compactAt === null ? BAR_CELLS : Math.floor((compactAt / 100) * BAR_CELLS)
    const markerCell = compactCell < BAR_CELLS - 1 ? compactCell : -1
    const cells = Array.from({ length: BAR_CELLS }, (_, i) => ({
      isFilled: i < filled,
      isMarker: i === markerCell,
      color: rampColor(c, ((i + 0.5) / BAR_CELLS) * 100, compactAt),
    }))
    const contextBar = e.surface === 'terminal' ? (
      <Box>
        {cells.map((cell, i) =>
          cell.isMarker ? <Text key={`cell-${i}`} dimColor color={cell.isFilled ? cell.color : c.marker}>┃</Text>
          : cell.isFilled ? <Text key={`cell-${i}`} color={cell.color}>━</Text>
          : <Text key={`cell-${i}`} dimColor color={cell.color}>─</Text>)}
      </Box>
    ) : (
      <Box width={BAR_CELLS} height={1} overflow="hidden">
        {cells.map((cell, i) => (
          <Box key={`cell-${i}`} width={1} height={1} backgroundColor={cell.isMarker ? c.marker : cell.isFilled ? cell.color : c.track} />
        ))}
      </Box>
    )

    const windows = RATE_LIMIT_WINDOWS.map(({ kind, label }) => {
      const w = rateLimits.find(l => l.kind === kind)
      return w && (
        <Box key={kind}>
          <Sep />
          <Text dimColor>{`${label} `}</Text>
          <Percent value={w.percentUsed} />
          {w.percentUsed >= RESET_SHOWN_FROM && w.resetsAt && <Text dimColor>{` ↻${untilReset(w.resetsAt)}`}</Text>}
        </Box>
      )
    })

    const Row = ({ label, children }: { label: string; children: RenderChildren }) => (
      <Box flexDirection="row" paddingLeft={2}>
        <Text dimColor>{label.padEnd(8)}</Text>
        {children}
      </Box>
    )
    const Fig = ({ value, unit }: { value: string; unit?: string }) => (
      <Box><Text>{value}</Text>{unit && <Text dimColor>{` ${unit}`}</Text>}</Box>
    )
    const panel = () => {
      const { costUsd, lastTurn, lastTurnUsd, lastRequestAt, limitStart } = session
      const hours = stats.activeMs / HOUR_MS
      const trackedUsd = costUsd !== null && stats.costStart !== null ? costUsd - stats.costStart : null
      const hit = stats.read / Math.max(1, stats.read + stats.write + stats.input)
      const cacheLeft = lastRequestAt === null ? null : settings.cacheTtlMinutes * 60_000 - (now - lastRequestAt)
      const burns = RATE_LIMIT_WINDOWS.flatMap(({ kind, label }) => {
        const w = rateLimits.find(l => l.kind === kind)
        return w ? [{ kind, label, w }] : []
      }).map(({ kind, label, w }, i) => {
        const start = limitStart[kind]
        const spanHours = start ? (now - start.at) / HOUR_MS : 0
        const perHour = start && spanHours >= BURN_MIN_HOURS ? (w.percentUsed - start.pct) / spanHours : 0
        const fullInMs = perHour > 0 ? ((100 - w.percentUsed) / perHour) * HOUR_MS : null
        const resetsInMs = w.resetsAt ? Date.parse(w.resetsAt) - now : null
        return (
          <Box key={`burn-${kind}`}>
            {i > 0 && <Sep />}
            <Text dimColor>{`${label} `}</Text>
            <Percent value={w.percentUsed} />
            {perHour > 0 ? (
              <Box>
                <Text dimColor>{` +${perHour.toFixed(1)}%/h`}</Text>
                {fullInMs !== null && resetsInMs !== null && fullInMs >= resetsInMs
                  ? <Text dimColor>{', resets first'}</Text>
                  : <Text color={c.warn}>{`, full in ${duration(fullInMs ?? 0)}`}</Text>}
              </Box>
            ) : <Text dimColor>{spanHours < BURN_MIN_HOURS ? ' measuring' : ' steady'}</Text>}
          </Box>
        )
      })
      return (
        <Box flexDirection="column">
          <Row label="cost">
            {costUsd === null ? <Text dimColor>not reported</Text> : (
              <Box>
                <Fig value={money(costUsd)} />
                {trackedUsd !== null && hours >= BURN_MIN_HOURS && <Box><Sep /><Fig value={money(trackedUsd / hours)} unit="per active hour" /></Box>}
                {lastTurnUsd !== null && <Box><Sep /><Text dimColor>last turn </Text><Fig value={money(lastTurnUsd)} /></Box>}
              </Box>
            )}
          </Row>
          <Row label="tokens">
            <Fig value={human(stats.input)} unit="in" /><Sep />
            <Fig value={human(stats.write)} unit="cache write" /><Sep />
            <Fig value={human(stats.read)} unit="cache read" /><Sep />
            <Fig value={human(stats.output)} unit="out" /><Sep />
            <Fig value={`${Math.round(hit * 100)}%`} unit="cache hit" />
            {cacheLeft !== null && (
              <Box>
                <Sep />
                {cacheLeft > 0
                  ? <Text dimColor>{`cache warm ${duration(cacheLeft)}`}</Text>
                  : <Text color={c.warn}>cache cold</Text>}
              </Box>
            )}
          </Row>
          <Row label="split">
            <Fig value={`${Math.round((stats.main / Math.max(1, tokens)) * 100)}%`} unit="main" /><Sep />
            <Fig value={`${Math.round((stats.sub / Math.max(1, tokens)) * 100)}%`} unit="subagents" /><Sep />
            <Fig value={String(stats.turns)} unit="turns" />
            {stats.activeMs > 0 && <Box><Sep /><Fig value={duration(stats.activeMs)} unit="active" /></Box>}
            {lastTurn && <Box><Sep /><Text dimColor>last turn </Text><Fig value={human(lastTurn.tokens)} unit={`tok in ${duration(lastTurn.ms)}`} /></Box>}
          </Row>
          {burns.length > 0 && <Row label="limits">{burns}</Row>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {engineHint}
        <Box flexDirection="row" justifyContent="space-between" width="100%" overflow="hidden">
          <Box flexDirection="row" flexShrink={1} overflow="hidden">
            {/* Only the location shrinks, so the figures never wrap to a second row. */}
            <Box flexDirection="row" flexShrink={1} overflow="hidden">
              <Text color={c.folder} wrap="truncate-end">{folder}</Text>
              {branch && <Text dimColor>:</Text>}
              {branch && <Text color={c.branch} wrap="truncate-end">{branch}</Text>}
            </Box>
            <Box flexDirection="row" flexShrink={0}>
            <Text>  </Text>
            {contextBar}
            {pct !== null && <Text color={rampColor(c, pct, compactAt)}>{` ${Math.round(pct)}%`}</Text>}
            {context?.tokens !== undefined && <Text dimColor>{` ${human(context.tokens)}/${human(context.window)}`}</Text>}
            <Box>
              <Sep />
              <Phase />
              {Client && (
                <Client key="hairline-speed" module="./speed.tsx" props={{ rate: tokensPerSecond, live: session.streaming, color: c.folder, frameMs: Math.round(1000 / settings.frameRate) }} />
              )}
              <Text dimColor={!session.streaming}>{tokensPerSecond}</Text>
              <Text dimColor>t/s</Text>
            </Box>
            {tokens > 0 && (
              <Box>
                <Sep />
                <Button
                  key="hairline-tokens"
                  label={`${human(tokens)} tok`}
                  plain
                  onPress={() => {
                    toggle($, 'tokens')
                  }}
                >
                  <Text inverse={open === 'tokens'}>{`${human(tokens)} tok`}</Text>
                </Button>
              </Box>
            )}
            {windows}
            </Box>
          </Box>
          <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
            {model && (modelRow ? (
              <Button
                key="hairline-model"
                label={modelLabel(model)}
                plain
                onPress={async () => {
                  await $.config.list().then(readRows, () => {})
                  toggle($, 'model')
                }}
              >
                <Text inverse={open === 'model'}>{modelLabel(model)}</Text>
              </Button>
            ) : <Text>{modelLabel(model)}</Text>)}
            {model && effort && (
              <Box>
                <Text> </Text>
                <Button
                  key="hairline-effort"
                  label={effort}
                  plain
                  onPress={async () => {
                    await $.config.list().then(readRows, () => {})
                    toggle($, 'effort')
                  }}
                >
                  <Text inverse={open === 'effort'} color={c.effort[EFFORT_LEVELS.indexOf(effort)]} dimColor={!EFFORT_LEVELS.includes(effort)}>{effort}</Text>
                </Button>
              </Box>
            )}
            {sessionId && (
              <Box>
                {model && <Sep />}
                <Button
                  key="hairline-session-id"
                  label={sessionId.slice(0, 8)}
                  plain
                  onPress={async press => {
                    const r = await $.ui.copy({ text: sessionId, surface: press.surface })
                    $.ui.toast(r.isCopied ? `session id copied: ${sessionId}` : `session id: ${sessionId}`)
                  }}
                >
                  <Text color={c.track} dimColor>{sessionId.slice(0, 8)}</Text>
                </Button>
              </Box>
            )}
          </Box>
        </Box>
        {open === 'model' && modelRow && (
          <Box flexDirection="row" justifyContent="flex-end" width="100%" flexWrap="wrap">
            <Text dimColor>model </Text>
            {modelRow.options.map(option => (
              <Box key={`model-${option}`}>
                <Text> </Text>
                <Button
                  key={`hairline-model-${option}`}
                  label={option}
                  plain
                  onPress={async () => {
                    setOpen($, null)
                    const { deny } = await $.config.set({ key: 'model', value: option })
                    if (!deny && modelRow) modelRow = { ...modelRow, value: option }
                    $.ui.toast(deny ? `model not changed: ${deny}` : `model ${option}`)
                    redraw($)
                  }}
                >
                  <Text bold={option === modelRow!.value} underline={option === modelRow!.value} dimColor={option !== modelRow!.value}>{option}</Text>
                </Button>
              </Box>
            ))}
          </Box>
        )}
        {open === 'effort' && effort && (
          <Box flexDirection="row" justifyContent="flex-end" width="100%">
            <Text dimColor>effort </Text>
            {EFFORT_LEVELS.map((level, i) => (
              <Box key={`effort-${level}`}>
                <Text> </Text>
                <Button
                  key={`hairline-effort-${level}`}
                  label={level}
                  plain
                  onPress={() => {
                    session.pickedEffort = level
                    session.pickBase = { ...session.seen }
                    setOpen($, null)
                    setEffort($, level)
                    save($)
                    $.ui.toast(`effort ${level} from your next message`)
                  }}
                >
                  <Text color={c.effort[i]} bold={level === effort} underline={level === effort}>{level}</Text>
                </Button>
              </Box>
            ))}
          </Box>
        )}
        {open === 'tokens' && tokens > 0 && panel()}
      </Box>
    )
  })
}
