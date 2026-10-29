import type { ConfigRow, EngineInterface, PluginOptions, Register, RenderChildren, SessionContextUsage, SessionRateLimit } from 'claude-code'

// Hairline: one line under the prompt, below Claude Code's own hint line.
// Left:  folder:branch  context bar  pct used/window · output tokens per second · session tokens · 5h · 7d
// Right: model, effort, session id (a button that copies the full id)
// A click on the session tokens opens a panel below: cost, token split and cache, main and
// subagents, and how fast the rate limits fill.

const BAR_CELLS = 16
const WARN_FROM = 60
const BAD_FROM = 85
const RESET_SHOWN_FROM = 70 // a rate-limit window shows its reset time only above this percent used
const LOCATION_REFRESH_MS = 5_000
const RATE_WINDOW_MS = 1_000 // the speed counts the characters streamed in this last stretch
const RATE_WARMUP_MS = 300
const HINT_REDRAWS_MAX = 30 // Claude Code folds hint-line redraws past 30 a second
const FRAMES_MAX = 60 // surfaces paint about 60 frames a second
const RATIO_MIN_TOKENS = 20 // shorter responses give a noisy characters-per-token ratio
const RATIO_MIN = 2
const RATIO_MAX = 6
const BURN_MIN_HOURS = 0.1 // a limit's fill rate needs this much history before it shows
const HOUR_MS = 3_600_000
// Phase glyphs: Nerd Font icons when the nerdFont setting is on and the surface is a terminal,
// else Unicode arrows and bars that common monospace fonts (Cascadia, Consolas, Menlo) carry.
const PHASE_GLYPHS = {
  nerd: { tool: '', idle: '' }, // nf-fa-cog, nf-fa-pause: one cell in a Nerd Font Mono
  plain: { tool: '↻', idle: '‖' },
} as const
const RATE_LIMIT_WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: '7d' },
] as const

// In the terminal: slots 0-15 of the terminal's own palette (ansi256(n), n < 16), so each
// person's color scheme paints them: 1 red, 2 green, 3 yellow, 4 blue, 5 magenta, 8 bright black,
// 9 bright red, 13 bright magenta.
// Elsewhere: Claude Code theme keys, which follow the light or dark theme.
// `effort` runs from dark blue to bright red, one color per level of EFFORT_LEVELS.
// `ramp` runs from green to red along the context bar, red where auto-compaction runs.
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

// What the session spent, from each turn.complete, subagents included.
type Stats = {
  input: number // uncached input
  write: number // cache writes
  read: number // cache reads
  output: number
  main: number // input + write + output of the main thread
  sub: number // the same for subagents
  turns: number
  activeMs: number // main-thread turn time, the base of the cost per hour
  costStart: number | null // the session cost when Hairline first read it
}
// Each rate-limit window's first reading, the start of its fill rate.
type LimitStart = Record<string, { pct: number; at: number; resetsAt?: string }>

type Session = {
  folder: string
  branch: string | null
  effort: string | null
  stats: Stats
  limitStart: LimitStart
  tokensPerSecond: number | null // output speed of the last main-loop reply, null before the first
  // Where the main thread is: a request going out, tokens coming in, a tool running, or the turn done.
  phase: 'sending' | 'receiving' | 'tool' | 'idle'
  streaming: boolean // a main-loop reply is streaming now
  context: SessionContextUsage | null
  compactAt: number | null // percent of the window where auto-compaction runs, null when off
  rateLimits: SessionRateLimit[]
  costUsd: number | null
  lastTurn: { tokens: number; ms: number } | null // the last main-thread turn
  lastTurnUsd: number | null
  lastRequestAt: number | null // the end of the last main-thread request: the prompt cache's age
  pickedEffort: string | null // the level picked in Hairline, sent on each main-thread request
  // The session's own effort and model when the pick was made; a change to either clears the pick.
  pickBase: { effort: string | null; model: string | null } | null
  // The session's own effort and model on the last main-thread request, before any rewrite.
  seen: { effort: string | null; model: string | null }
}

const emptyStats = (): Stats => ({ input: 0, write: 0, read: 0, output: 0, main: 0, sub: 0, turns: 0, activeMs: 0, costStart: null })
const emptySession = (): Session => ({
  folder: '', branch: null, effort: null, stats: emptyStats(), limitStart: {}, tokensPerSecond: null, phase: 'idle', streaming: false,
  context: null, compactAt: null, rateLimits: [], costUsd: null, lastTurn: null, lastTurnUsd: null, lastRequestAt: null, pickedEffort: null, pickBase: null, seen: { effort: null, model: null },
})
let session = emptySession()
let loaded = false
// The one panel open under the line: the token details, the effort picker or the model picker.
type Panel = 'tokens' | 'effort' | 'model'
let open: Panel | null = null
function setOpen($: EngineInterface, panel: Panel | null): void {
  open = panel
  redraw($)
}
const toggle = ($: EngineInterface, panel: Panel) => setOpen($, open === panel ? null : panel)
// The /config Model row: what the session runs on, and the choices the menu offers.
let modelRow: { value: string; options: readonly string[] } | null = null
let charsPerToken = 4 // until the first response measures it

// The plugin's /config fields (plugin.json userConfig).
type Settings = { currency: string; usdRate: number; cacheTtlMinutes: number; refreshPerSecond: number; frameRate: number; nerdFont: boolean }
let settings: Settings = { currency: 'USD', usdRate: 1, cacheTtlMinutes: 60, refreshPerSecond: HINT_REDRAWS_MAX, frameRate: 30, nerdFont: false }

function readSettings(options: PluginOptions): Settings {
  const rate = Number(options.usdRate)
  const ttl = Number(options.cacheTtlMinutes)
  const refresh = Number(options.speedRefreshPerSecond)
  const frames = Number(options.animationFps)
  return {
    currency: String(options.currency || 'USD').trim().toUpperCase(),
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

// The ramp color at `pct` of the window: green at 0, red at the compaction point and past it.
function rampColor(c: Palette, pct: number, compactAt: number | null): string {
  const share = pct / (compactAt ?? 100)
  return c.ramp[Math.min(c.ramp.length - 1, Math.floor(share * c.ramp.length))]!
}

// The auto-compaction point, from the local /context estimate (no API request).
async function readCompactAt($: EngineInterface): Promise<void> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    session.compactAt = b?.isAutoCompactEnabled && b.autoCompactThreshold ? (b.autoCompactThreshold / context.window) * 100 : null
    redraw($)
  } catch {
    // no marker
  }
}

function human(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M` // 1M, 2.4M, 1.25M
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// Every time on the line and in the panel: the 2 largest units, rounded to the smaller one,
// in the reader's locale through Intl.DurationFormat's narrow style ("38s", "12m 30s", "5h 12m",
// "2d 3h"), as humanize-duration and pretty-ms do with a unit count of 2.
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
  const first = largest === -1 ? DURATION_UNITS.length - 1 : largest // under 1 second: "0s"
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

// US dollars in the configured currency, at the configured rate.
function money(usd: number): string {
  const value = usd * settings.usdRate
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: settings.currency, maximumFractionDigits: 2 }).format(value)
  } catch {
    return `${value.toFixed(2)} ${settings.currency}` // not an ISO 4217 code
  }
}

// "claude-opus-5-5[1m]" -> "opus 5.5"
function modelLabel(id: string): string {
  const [family, ...version] = id.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').split('-')
  return version.length ? `${family} ${version.join('.')}` : family ?? id
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

// The effort, the stats and the limits' first readings, kept in the plugin store under the
// session id: /reload-plugins clears the module, and no engine call reports any of them.
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
    return undefined // a new session, or no store
  }
}

function setEffort($: EngineInterface, value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number') return
  if (String(value) === session.effort) return
  session.effort = String(value)
  redraw($)
  save($)
}

// A window's first reading starts its fill rate. A new window starts it again: its reset time
// moved forward (the readings jitter by seconds, so a minute is the bar), or its percent dropped.
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

// One git call gives the repo top folder and the branch ("HEAD" when detached).
async function readLocation($: EngineInterface): Promise<void> {
  try {
    const cwd = await $.session.cwd()
    const out = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 2_000 })
    const [top = cwd, branch = null] = out.exitCode === 0 ? out.stdout.trim().split(/\r?\n/) : [cwd]
    if (basename(top) === session.folder && branch === session.branch) return
    session.folder = basename(top)
    session.branch = branch
    redraw($)
  } catch {
    // keep the last location
  }
}

// Usage, location and the effort setting, read once per session (also after /reload-plugins,
// where session.start does not fire). Later changes arrive through events.
async function load($: EngineInterface): Promise<void> {
  loaded = true
  await readLocation($)
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
    // numbers arrive with the first session.measure
  }
  await readCompactAt($)
  try {
    session.pickedEffort = saved?.pickedEffort ?? null
    session.pickBase = saved?.pickBase ?? null
    const rows = await $.config.list()
    readRows(rows)
    setEffort($, session.pickedEffort ?? saved?.effort ?? rows.find(row => /effort/i.test(row.key))?.value)
  } catch {
    // effort arrives with the first request
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
        if (open === 'tokens') redraw($) // the panel's clocks: cache age
      })
    }
    return result
  })

  // Effort, and output speed: streamed characters (text, thinking, tool arguments) in the last
  // second, over the characters per token the last response measured.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    // A level picked in Hairline replaces the session's, on a model that takes effort.
    // The session's own setting, before Hairline rewrites it.
    session.seen = { effort: e.effort === undefined ? null : String(e.effort), model: e.model }
    if (session.pickedEffort) {
      const base = session.pickBase
      if (!base || base.effort === null) session.pickBase = { ...session.seen } // picked before any request: take this one as the base
      else if (base.effort !== session.seen.effort || base.model !== session.seen.model) {
        // /effort or a model switch since the pick: the session's own setting applies again.
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
        // At the end, the real output tokens give the ratio for the next reply, and the
        // response's average speed, which the line holds until the next reply streams.
        if (chunk.kind === 'stop' && chunk.usage && chunk.usage.output_tokens >= RATIO_MIN_TOKENS && chars) {
          charsPerToken = Math.min(RATIO_MAX, Math.max(RATIO_MIN, chars / chunk.usage.output_tokens))
          const secs = (now - firstChunkAt) / 1000
          if (secs >= RATE_WARMUP_MS / 1000) session.tokensPerSecond = Math.round(chunk.usage.output_tokens / secs)
        }
        yield chunk
      }
      return await stream.result
    } finally {
      session.lastRequestAt = Date.now()
      session.phase = 'tool' // the turn goes on with a tool, or turn.complete sets idle
      if (session.streaming) {
        session.streaming = false
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

  // Claude Code's own hint line (? for shortcuts, esc to interrupt) stays on top.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineHint = await next(e)
    if (!loaded) void load($)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Client = 'Client' in elements ? elements.Client : null // the surfaces that run the dot line
    const c = e.surface === 'terminal' ? TERMINAL_PALETTE : THEME_PALETTE
    const [model, sessionId] = await Promise.all([$.session.model().catch(() => ''), $.session.id().catch(() => '')])
    const { folder, branch, effort, stats, tokensPerSecond, context, compactAt, rateLimits } = session
    const tokens = counted(stats)
    const pct = context?.percent ?? null
    const now = Date.now()

    const Sep = () => <Text dimColor> · </Text>
    // The main thread's phase: ↑ a request going out (with the context it carries), ↓ tokens
    // streaming in, a gear while a tool runs, a dim pause sign while Claude waits for you.
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

    // Each filled cell takes the ramp color of its place on the bar. A bold ┃ marks the cell
    // where auto-compaction runs. The desktop app draws line glyphs wider than a cell, so it
    // gets painted boxes there.
    const filled = pct === null ? 0 : filledCells(pct)
    const markerCell = compactAt === null ? -1 : Math.min(BAR_CELLS - 1, Math.floor((compactAt / 100) * BAR_CELLS))
    const cells = Array.from({ length: BAR_CELLS }, (_, i) => ({
      isFilled: i < filled,
      isMarker: i === markerCell,
      color: rampColor(c, ((i + 0.5) / BAR_CELLS) * 100, compactAt),
    }))
    const contextBar = e.surface === 'terminal' ? (
      <Box>
        {cells.map((cell, i) =>
          cell.isMarker ? <Text key={`cell-${i}`} bold color={cell.isFilled ? cell.color : c.marker}>┃</Text>
          : cell.isFilled ? <Text key={`cell-${i}`} color={cell.color}>━</Text>
          : <Text key={`cell-${i}`} dimColor>─</Text>)}
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

    // The panel: one row per topic, a dim label column, the figures after it.
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
      // Cost per active hour: the cost since Hairline first read it, over the turn time since then.
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
            {/* Only the location shrinks, cut at its end on one line; the figures keep their width. */}
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
            {(tokensPerSecond !== null || session.phase !== 'idle') && (
              <Box>
                <Sep />
                <Phase />
                {session.phase === 'sending' && context?.tokens !== undefined && <Text color={c.folder}>{`${human(context.tokens)} `}</Text>}
                {tokensPerSecond !== null && Client && (
                  <Client key="hairline-speed" module="./speed.tsx" props={{ rate: tokensPerSecond, live: session.streaming, color: c.folder, frameMs: Math.round(1000 / settings.frameRate) }} />
                )}
                {tokensPerSecond !== null && <Text dimColor={!session.streaming}>{tokensPerSecond}</Text>}
                {tokensPerSecond !== null && <Text dimColor>t/s</Text>}
              </Box>
            )}
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
                  {/* Open, the title stays inverted, as the pointer draws a pressed Button. */}
                  <Text inverse={open === 'tokens'}>{human(tokens)}</Text>
                  <Text inverse={open === 'tokens'} dimColor={open !== 'tokens'}>{` tok ${open === 'tokens' ? '×' : '…'}`}</Text>
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
                <Text inverse={open === 'model'} dimColor={open !== 'model'}>{open === 'model' ? ' ×' : ' …'}</Text>
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
                  <Text inverse={open === 'effort'} dimColor={open !== 'effort'}>{open === 'effort' ? ' ×' : ' …'}</Text>
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
