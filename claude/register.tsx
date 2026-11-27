import type { BarRun } from './bar.tsx'
import type { ConfigRow, EngineInterface, PluginOptions, Register, RenderChildren, RenderElement, RenderInput, RenderSurface, SessionContextUsage, SessionRateLimit } from 'claude-code'

const BAR_CELLS = 8
// Fixed widths, so a changing figure never moves the ones after it on the line.
const PCT_WIDTH = 4 // 100%
const CONTEXT_WIDTH = 7 // 999k/1M
const TPS_WIDTH = 4
const TPS_MAX = 9999
const READOUT_EASE_MS = 400 // a figure redrawn faster than this flickers past reading
const WARN_FROM = 60
const BAD_FROM = 85
const RESET_SHOWN_FROM = 70
const WORKSPACE_REFRESH_MS = 5_000
const IDLE_REFRESH_MS = 60_000
const RATE_WINDOW_MS = 1_000
const RATE_WARMUP_MS = 1_000
const HINT_REDRAWS_MAX = 30 // Claude Code folds hint-line redraws past 30 a second
const FRAMES_MAX = 240 // the fastest common panel; animationFps 0 matches the display
const FRAMES_FALLBACK = 60 // when no command reports the display's refresh rate
const RATIO_MIN_TOKENS = 20 // shorter responses give a noisy characters-per-token ratio
const RATIO_MIN = 2
const RATIO_MAX = 6
const BURN_MIN_HOURS = 0.1
const HOUR_MS = 3_600_000
const CURRENCIES = ['USD', 'CAD', 'AUD', 'EUR', 'JPY', 'CNY'] as const
const RATES_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=' // European Central Bank rates, no key
// Nerd Font glyphs, private-use code points that any other font draws as a box. Without an
// installed Nerd Font the phase shows blank cells of the same width, so the line stays still.
// U+21BB, the reset arrow before, is missing from common terminal fonts: the fallback glyph spilled
// over the time after it.
const NERD_GLYPHS = { tool: '\uf013', reset: '\uf017', worktree: '\uf07b', branch: '\ue725' } as const // nf-fa-cog, nf-fa-clock_o, nf-fa-folder, nf-dev-git_branch
// The desktop app's monospaced face has no Nerd Font glyphs and Text cannot pick another font,
// so it gets emoji, which every desktop system font set draws.
const DESKTOP_GLYPHS = { tool: '\u2699\ufe0f' } as const // gear
// A white circle: a geometric shape that terminal fonts and the desktop app's fallback fonts both draw.
const IDLE_GLYPH = '\u25cb'
// Outside a reply the readout names the phase, in the cells of the number and " t/s".
const PHASE_WORDS = { idle: 'idle', sending: 'sending', tool: 'running' } as const
const READOUT_WIDTH = TPS_WIDTH + ' t/s'.length
// The readout, its gap and graph.tsx's 6 cells: a running tool's name and argument fill them all.
const TOOL_WIDTH = READOUT_WIDTH + 1 + 6
// The terminal's columns give the readout and the graph more room than the desktop band has.
export const READOUT_WIDTH_WIDE = 12
// The sending time's cells after "waiting...", as readout.tsx draws them: 123.4s.
const SECONDS_WIDTH = 6
// The widest count human() prints: 999.99M, 112.46B. At 6 cells, 112.46M wrapped the row.
// The padded token row: 4 counts, each a space and its unit, joined by 3 " / ".
export const COUNT_WIDTH = 7
export const TOKEN_SPLIT_WIDTH = 4 * COUNT_WIDTH + ' in out read write'.length + 3 * ' / '.length
// The graph fills the activity row to the token split's width, so the column never wraps either row:
// the phase glyph and its space, the readout, a space, the graph.
export const GRAPH_CELLS_WIDE = TOKEN_SPLIT_WIDTH - 2 - READOUT_WIDTH_WIDE - 1
// The workspace takes half the row, never less than this. The repository keeps its name; a longer
// worktree or branch is cut with an ellipsis.
export const WORKSPACE_WIDTH = 52

// Half the row: the limits, the model and the session ID take some 45 cells, so a wide terminal
// spends its room on the names.
export function workspaceWidth(rowCells: number): number {
  return Math.max(WORKSPACE_WIDTH, Math.floor(rowCells / 2))
}
// Middle: the tool call's text and the dot line's cells in the centered activity.
const MIDDLE_TOOL_WIDTH = 48
const MIDDLE_GRAPH_CELLS = 12
// Scan: the tokens per second at which a reply's head crosses the bar once a second.
const SCAN_TPS_PER_PASS = 80
const NERD_FONT_NAME = /nerd ?font|(^|[\s_-])NFM?([\s_.-]|$)/i // CaskaydiaCove Nerd Font, MapleMono-NF-Regular.ttf
const RATE_LIMIT_WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: '7d' },
] as const
// claude.ai's own usage endpoint, undocumented: it alone reports the extra usage spend. A change in
// its shape hides the figure. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC refuses the call.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const EXTRA_REFRESH_MS = 60_000
export const EXTRA_SHOWN_FROM = 95 // percent of the 5h or 7d window
const EXTRA_RETRY_MS = 600_000

// Terminal slots 0-15 (ansi256(n), n < 16) take each person's color scheme. Other surfaces get
// Claude Code theme keys, which follow the light or dark theme.
type Palette = {
  ok: string; warn: string; bad: string; folder: string; branch: string; track: string; marker: string
  effort: readonly string[]; ramp: readonly string[]
  // The scan's head and body per phase. Thinking takes Claude's own spinner color, the theme key
  // claude, so the bar thinks in the color Claude Code thinks in; 16 slots have no orange.
  thinking: string; scan: Record<'sending' | 'receiving' | 'tool', { head: string; body: string }>
}
const TERMINAL_PALETTE: Palette = {
  ok: 'ansi256(2)', warn: 'ansi256(3)', bad: 'ansi256(1)', folder: 'ansi256(4)', branch: 'ansi256(5)', track: 'ansi256(8)', marker: 'ansi256(15)',
  effort: ['ansi256(4)', 'ansi256(5)', 'ansi256(13)', 'ansi256(1)', 'ansi256(9)'],
  ramp: ['ansi256(10)', 'ansi256(2)', 'ansi256(11)', 'ansi256(3)', 'ansi256(1)', 'ansi256(9)'],
  thinking: 'claude',
  scan: { sending: { head: 'claude', body: 'claude' }, receiving: { head: 'ansi256(10)', body: 'ansi256(2)' }, tool: { head: 'ansi256(11)', body: 'ansi256(3)' } },
}
const THEME_PALETTE: Palette = {
  ok: 'success', warn: 'warning', bad: 'error', folder: 'suggestion', branch: 'merged', track: 'subtle', marker: 'text',
  effort: ['suggestion', 'merged', 'warning', 'error', 'error'],
  ramp: ['success', 'success', 'warning', 'warning', 'error', 'error'],
  thinking: 'claude',
  scan: { sending: { head: 'claude', body: 'claude' }, receiving: { head: 'success', body: 'success' }, tool: { head: 'warning', body: 'warning' } },
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
  folder: string // the repository's name: in a worktree, the main checkout's folder
  worktree: string | null
  branch: string | null
  effort: string | null
  stats: Stats
  limitStart: LimitStart
  tokensPerSecond: number
  readoutTps: number // the figure the readout shows, eased every READOUT_EASE_MS
  phase: 'sending' | 'receiving' | 'tool' | 'idle'
  tools: { name: string; arg: string }[] // the tool calls of the main loop's last response
  sentAt: number // when the main loop's last request went out
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
  folder: '', worktree: null, branch: null, effort: null, stats: emptyStats(), limitStart: {}, tokensPerSecond: 0, readoutTps: 0, phase: 'idle', tools: [], sentAt: 0, streaming: false,
  context: null, compactAt: null, rateLimits: [], costUsd: null, lastTurn: null, lastTurnUsd: null, lastRequestAt: null, pickedEffort: null, pickBase: null, seen: { effort: null, model: null },
})
let session = emptySession()
let loaded = false
type Open = 'ledger' | 'effort' | 'model'
let open: Open | null = null
function setOpen($: EngineInterface, panel: Open | null): void {
  open = panel
  redraw($)
}
const toggle = ($: EngineInterface, panel: Open) => setOpen($, open === panel ? null : panel)
let modelRow: { value: string; options: readonly string[] } | null = null
let charsPerToken = 4 // the usual English ratio, until the first response measures it

// scan: the context bar, scanned while a turn runs, over one row. middle: the bar over one row with the
// activity centered.
export const LAYOUTS = ['scan', 'middle'] as const
export type Layout = (typeof LAYOUTS)[number]
type Settings = { currency: string; usdRate: number; cacheTtlMinutes: number; refreshPerSecond: number; frameRate: number; layout: Layout }
let settings: Settings = { currency: 'EUR', usdRate: 0.9, cacheTtlMinutes: 60, refreshPerSecond: HINT_REDRAWS_MAX, frameRate: 0, layout: 'scan' }
// The display's refresh rate, read once per load: frameRate 0 animates at it.
let displayHz = FRAMES_FALLBACK
const frameMs = () => Math.round(1000 / (settings.frameRate || displayHz))

// Set once a day: the ECB publishes one rate per working day.
let exchange: { currency: string; rate: number; fetchedOn: string } | null = null
let exchangeTriedAt = 0

// The month's extra usage, in the currency the account is billed in.
type Extra = { used: number; limit: number; currency: string; pct: number }
let extra: Extra | null = null
let extraNextAt = 0

function readSettings(options: PluginOptions): Settings {
  const code = String(options.currency || 'EUR').trim().toUpperCase().replace(/^RMB$/, 'CNY')
  const rate = Number(options.usdRate)
  const ttl = Number(options.cacheTtlMinutes)
  const refresh = Number(options.speedRefreshPerSecond)
  const frames = Number(options.animationFps)
  return {
    currency: (CURRENCIES as readonly string[]).includes(code) ? code : 'EUR',
    usdRate: rate > 0 ? rate : 0.9,
    cacheTtlMinutes: ttl > 0 ? ttl : 60,
    refreshPerSecond: refresh > 0 ? Math.min(HINT_REDRAWS_MAX, Math.max(1, refresh)) : HINT_REDRAWS_MAX,
    frameRate: frames > 0 ? Math.min(FRAMES_MAX, Math.max(1, frames)) : 0,
    layout: (LAYOUTS as readonly string[]).includes(String(options.layout)) ? (String(options.layout) as Layout) : 'scan',
  }
}

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')
// The display's refresh rate as a command prints it: Windows a bare number per graphics card,
// macOS "@ 120.00Hz" or "ProMotion", Linux xrandr's current mode marked "*". The highest wins, so
// a 120 Hz panel beside a 60 Hz one animates at 120.
export function refreshRateOf(output: string): number | null {
  const rates: number[] = []
  // Each regex below starts once per number and never twice in one digit run, so a long run of
  // digits costs linear time: the old single regex was quadratic on "999...".
  const unit = /\s*(?:Hz\b|\*)/iy
  for (const line of output.split(/\r?\n/)) {
    if (/^\d+$/.test(line.trim())) rates.push(Number(line.trim()))
    for (const m of line.matchAll(/\d+(?:\.\d+)?/g)) {
      unit.lastIndex = m.index + m[0].length
      if (unit.test(line)) rates.push(Number(m[0]))
    }
  }
  if (/ProMotion/i.test(output)) rates.push(120)
  const valid = rates.filter(n => n >= 24 && n <= 500)
  return valid.length ? Math.round(Math.max(...valid)) : null
}

// One command per system; a failed or silent one falls through to the next, then to 60.
async function readDisplayHz($: EngineInterface): Promise<void> {
  const isWindows = Boolean(await $.env.get('WINDIR').catch(() => undefined))
  const commands = isWindows
    ? [['powershell', '-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).CurrentRefreshRate']]
    : [['system_profiler', 'SPDisplaysDataType'], ['xrandr', '--current']]
  for (const command of commands) {
    try {
      const out = await $.process.run(command, { timeoutMs: 5_000 })
      const hz = out.exitCode === 0 ? refreshRateOf(out.stdout) : null
      if (hz) {
        displayHz = Math.min(FRAMES_MAX, hz)
        redraw($)
        return
      }
    } catch {}
  }
}
const counted = (s: Stats) => s.input + s.write + s.read + s.output // every token in and out, as ccstatusline's Tokens Total counts them

function severity(c: Palette, pct: number): string {
  return pct >= BAD_FROM ? c.bad : pct >= WARN_FROM ? c.warn : c.ok
}

// Cells into runs of one glyph and color; the label's cells become one text run.
function joinRuns(cells: { glyph: string; color: string }[], label: string, at: number): BarRun[] {
  const runs: BarRun[] = []
  cells.forEach((cell, i) => {
    const ch = cell.glyph === 'text' ? label[i - at]! : cell.glyph
    const last = runs[runs.length - 1]
    if (last && last.glyph === cell.glyph && last.color === cell.color) last.text += ch
    else runs.push({ glyph: cell.glyph, color: cell.color, text: ch })
  })
  return runs
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

// Largest first. Each cut is where the unit below would round up to 1000: 999,500 prints 1000k
// with whole thousands, 999.995M prints 1000.00M with 2 decimals.
const BIG_UNITS = [
  ['Q', 1e15, 999_995e9],
  ['T', 1e12, 999_995e6],
  ['B', 1e9, 999_995e3],
  ['M', 1e6, 999_500],
] as const

function human(n: number): string {
  for (const [suffix, size, cut] of BIG_UNITS) {
    if (n >= cut) return `${(n / size).toFixed(2).replace(/\.?0+$/, '')}${suffix}`
  }
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

// Amounts come in the billing currency's minor units: 972 with 2 decimal places is 9.72.
function readExtraBody(text: string): Extra | null {
  const x = (JSON.parse(text) as { extra_usage?: { is_enabled?: boolean; monthly_limit?: number | null; used_credits?: number | null; utilization?: number | null; currency?: string | null; decimal_places?: number | null } | null }).extra_usage
  if (!x?.is_enabled || typeof x.monthly_limit !== 'number' || typeof x.used_credits !== 'number' || x.monthly_limit <= 0) return null
  const scale = 10 ** (x.decimal_places ?? 2)
  const used = x.used_credits / scale
  const limit = x.monthly_limit / scale
  return { used, limit, currency: x.currency || 'USD', pct: x.utilization ?? (used / limit) * 100 }
}

// The endpoint reports the account's 5h and 7d use, other sessions' included. A response header
// reports it too, but only when this session sends a request.
function readUsageLimits(text: string): SessionRateLimit[] {
  const body = JSON.parse(text) as Record<string, { utilization?: number | null; resets_at?: string | null } | null | undefined>
  return RATE_LIMIT_WINDOWS.flatMap(({ kind }) => {
    const w = body[kind]
    if (typeof w?.utilization !== 'number') return []
    return [{ kind, percentUsed: Math.round(w.utilization * 10) / 10, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) }]
  })
}

function setLimits($: EngineInterface, limits: SessionRateLimit[]): void {
  if (!limits.length) return
  const next = [...session.rateLimits.filter(l => !limits.some(n => n.kind === l.kind)), ...limits]
  if (JSON.stringify(next) === JSON.stringify(session.rateLimits)) return
  session.rateLimits = next
  trackLimits($, limits)
  redraw($)
}

// Only a subscription login holds a bearer credential; an API key has no extra usage to show.
async function readExtra($: EngineInterface): Promise<void> {
  const now = await $.clock.now() // the test kit's clock, so a test can move to the next reading
  if (now < extraNextAt) return
  extraNextAt = now + EXTRA_RETRY_MS
  try {
    const auth = await $.session.authorize()
    if (auth?.kind !== 'bearer') return
    const { ok, text } = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
    if (!ok) return
    const next = readExtraBody(text)
    extraNextAt = now + EXTRA_REFRESH_MS
    setLimits($, readUsageLimits(text))
    if (JSON.stringify(next) === JSON.stringify(extra)) return
    extra = next
    redraw($)
  } catch {}
}

// 9.72 keeps its cents, a whole 100 drops them.
function amount(value: number, currency: string): string {
  const digits = Number.isInteger(value) ? 0 : 2
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(value)
}

export function modelLabel(id: string): string {
  // An ID ending in "]" loses all from its first "[", as "[1m]". indexOf: /\[.*\]$/ is quadratic on "[[[...".
  const bare = id.replace(/^claude-/, '')
  const open = bare.indexOf('[')
  const [family, ...version] = (open >= 0 && bare.endsWith(']') ? bare.slice(0, open) : bare).replace(/-\d{8}$/, '').split('-')
  return version.length ? `${family} ${version.join('.')}` : family ?? id
}

// The argument that says most about a call, for the readout: a Bash description, a file name, a pattern.
function toolArg(tool: string, input: unknown): string {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  switch (tool) {
    case 'Bash': case 'PowerShell': return text('description') || text('command')
    case 'Read': case 'Edit': case 'Write': return basename(text('file_path'))
    case 'NotebookEdit': return basename(text('notebook_path'))
    case 'Grep': case 'Glob': return text('pattern')
    case 'WebFetch': return text('url').replace(/^https?:\/\/(www\.)?/, '')
    case 'WebSearch': return text('query')
    case 'Agent': case 'Task': return text('description') || text('subagent_type')
    default: return ''
  }
}

// Exactly `width` cells. One call: its name and argument. Parallel calls: their count, then each
// call's name and argument, so every tool the turn runs shows, not the first alone.
export function toolReadout(tools: { name: string; arg: string }[], width: number): { text: string; bright: number } {
  const first = tools[0]
  if (!first) return { text: PHASE_WORDS.tool.padStart(width), bright: 0 }
  const head = tools.length < 2 ? '' : `${tools.length} tools `
  const full = (head + tools.map(t => `${t.name} ${t.arg}`.trim()).join(' · ')).replace(/\s+/g, ' ')
  const text = full.length > width ? `${full.slice(0, width - 1)}…` : full.padEnd(width)
  return { text, bright: Math.min(head ? head.length - 1 : first.name.length, width) }
}

// A path without its trailing separators. A loop: the regex /[\\/]+$/ restarts at every separator
// of a long run, which is quadratic.
export function trimSeparators(path: string): string {
  let end = path.length
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end--
  return path.slice(0, end)
}

export function basename(path: string): string {
  return trimSeparators(path).split(/[\\/]/).pop() || path
}

// /reload-plugins clears the module, and no engine call reports these values again.
// One entry per session, newest first, as Claude Code's own plugins keep theirs: parallel
// sessions share this store, and a single entry let each overwrite the others.
const SAVED_KEY = 'sessions'
const SAVED_MAX = 20
type Saved = { sessionId: string; effort: string | null; pickedEffort?: string | null; pickBase?: Session['pickBase']; stats?: Stats; limitStart?: LimitStart }

async function readSaved($: EngineInterface): Promise<Saved[]> {
  const list = await $.store.get(SAVED_KEY)
  return Array.isArray(list) ? (list as Saved[]) : []
}

// load() restores the saved counts; a save before that would write the module's fresh zeros.
let restored: Promise<unknown> = Promise.resolve()

function save($: EngineInterface): void {
  void restored
    .then(() => Promise.all([$.session.id(), readSaved($)]))
    .then(([sessionId, list]) => {
      const { effort, pickedEffort, pickBase, stats, limitStart } = session
      // A session's counts only grow: a zero over them would hide the token split for good.
      const stored = list.find(saved => saved.sessionId === sessionId)?.stats
      const kept = stored && counted(stored) > counted(stats) ? stored : stats
      return $.store.set(SAVED_KEY, [
        { sessionId, effort, pickedEffort, pickBase, stats: kept, limitStart } satisfies Saved,
        ...list.filter(saved => saved.sessionId !== sessionId),
      ].slice(0, SAVED_MAX))
    })
    .catch(() => {})
}

async function restore($: EngineInterface): Promise<Saved | undefined> {
  try {
    const [sessionId, list] = await Promise.all([$.session.id(), readSaved($)])
    return list.find(saved => saved.sessionId === sessionId)
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

// default, best and opusplan pick a model by a rule; the picker offers the models themselves.
const RULE_MODELS = ['default', 'best', 'opusplan']

// `opus[1m]` reads `opus (1m)`: the short name, then the context size.
export function optionLabel(option: string): string {
  return option.replace(/\[1m\]$/i, ' (1m)')
}

function readRows(rows: readonly ConfigRow[]): void {
  const row = rows.find(r => r.key === 'model' && r.kind === 'choice')
  const options = (row?.options ?? []).filter(o => !RULE_MODELS.includes(o))
  modelRow = options.length && !row!.isLocked ? { value: String(row!.value), options } : null
}

// Set once per process: the font list does not change while a session runs.
let hasNerdFont = false

// The terminal or app font is out of reach, so an installed Nerd Font stands in for one in use.
// fc-list covers Linux and Homebrew macOS; the font folders cover Windows and plain macOS.
// Windows has no fc-list, and a failed spawn there costs about 95 ms.
async function findNerdFont($: EngineInterface): Promise<boolean> {
  const [windir, localAppData, home] = await Promise.all([
    $.env.get('WINDIR').catch(() => undefined),
    $.env.get('LOCALAPPDATA').catch(() => undefined),
    $.env.get('HOME').catch(() => undefined),
  ])
  if (!windir) {
    try {
      const out = await $.process.run(['fc-list', ':', 'family'], { timeoutMs: 3_000 })
      if (out.exitCode === 0) return NERD_FONT_NAME.test(out.stdout)
    } catch {}
  }
  const dirs = [
    windir && `${windir}/Fonts`,
    localAppData && `${localAppData}/Microsoft/Windows/Fonts`,
    home && `${home}/Library/Fonts`,
    '/Library/Fonts',
  ].filter((dir): dir is string => Boolean(dir))
  for (const dir of dirs) {
    try {
      if ((await $.fs.list(dir)).some(entry => NERD_FONT_NAME.test(entry.name))) return true
    } catch {}
  }
  return false
}

// The working copy's top folder and its HEAD file, found again when /cd moves the session.
type Repo = { name: string; worktree: string | null; head: string | null }
let repo: Repo | null = null
let repoCwd = ''

async function findRepo($: EngineInterface, cwd: string): Promise<Repo> {
  const parts = trimSeparators(cwd).split(/[\\/]/)
  for (let n = parts.length; n > 0; n--) {
    const top = parts.slice(0, n).join('/')
    const stat = await $.fs.stat(`${top}/.git`).catch(() => null)
    if (stat?.kind === 'dir') return { name: basename(top), worktree: null, head: `${top}/.git/HEAD` }
    // A worktree's .git is a file that names its git folder.
    if (stat?.kind === 'file') {
      const dir = String(await $.fs.read(`${top}/.git`)).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
      if (!dir) return { name: basename(top), worktree: null, head: null }
      const gitDir = /^([a-z]:)?[\\/]/i.test(dir) ? dir : `${top}/${dir}`
      return { ...worktreeOf(gitDir, top), head: `${gitDir}/HEAD` }
    }
  }
  return { name: basename(cwd), worktree: null, head: null }
}

// The worktree and the branch cut to fit `width` with the repository, the parentheses, the
// separator and the glyphs. The longer name loses a cell first, so both stay readable.
function cutWorkspace(folder: string, worktree: string | null, branch: string | null, hasGlyphs: boolean, width: number): { worktree: string; branch: string } {
  const glyph = hasGlyphs ? 2 : 0
  const fixed = folder.length + (worktree || branch ? 3 : 0) + (worktree && branch ? 3 : 0) + (worktree ? glyph : 0) + (branch ? glyph : 0)
  const room = Math.max(0, width - fixed)
  let w = worktree?.length ?? 0
  let b = branch?.length ?? 0
  while (w + b > room) {
    if (w >= b && w > 1) w--
    else if (b > 1) b--
    else break
  }
  const cut = (name: string | null, n: number) => (!name ? '' : name.length <= n ? name : `${name.slice(0, Math.max(0, n - 1))}…`)
  return { worktree: cut(worktree, w), branch: cut(branch, b) }
}

// A linked worktree's git folder is <main checkout>/.git/worktrees/<id>, so the main checkout names
// the repository. A submodule's is .git/modules/<name>, and it stays a repository of its own.
export function worktreeOf(gitDir: string, top: string): { name: string; worktree: string | null } {
  // Parts: the old /^(.*)[\\/]\.git.../ regex backtracked once per separator.
  const parts = trimSeparators(gitDir).split(/[\\/]/)
  const n = parts.length
  const main = n >= 4 && parts[n - 3] === '.git' && parts[n - 2] === 'worktrees' ? parts.slice(0, n - 3).join('/') : ''
  return main ? { name: basename(main), worktree: basename(top) } : { name: basename(top), worktree: null }
}

// Reads the HEAD file, so the 5 s refresh starts no git process. A detached HEAD shows as git shows it.
async function readWorkspace($: EngineInterface): Promise<void> {
  try {
    const cwd = await $.session.cwd()
    if (!repo || cwd !== repoCwd) {
      repo = await findRepo($, cwd)
      repoCwd = cwd
    }
    const head = repo.head ? await $.fs.read(repo.head).then(text => String(text).trim(), () => null) : null
    const branch = head === null ? null : (head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] ?? 'HEAD')
    if (repo.name === session.folder && repo.worktree === session.worktree && branch === session.branch) return
    session.folder = repo.name
    session.worktree = repo.worktree
    session.branch = branch
    redraw($)
  } catch {}
}

const NERD_FONT_KEY = 'nerdFont'

// Fonts are looked for once; /hairline-fonts looks again after one is installed or removed.
async function readNerdFont($: EngineInterface, isFresh = false): Promise<boolean> {
  const cached = isFresh ? undefined : await $.store.get(NERD_FONT_KEY).catch(() => undefined)
  const found = typeof cached === 'boolean' ? cached : await findNerdFont($)
  if (found !== cached) await $.store.set(NERD_FONT_KEY, found).catch(() => {})
  if (found !== hasNerdFont) {
    hasNerdFont = found
    redraw($)
  }
  return found
}

// Folder, branch and the Nerd Font glyphs show only in the terminal, so nothing reads them before it draws.
let isTerminalStarted = false

function startTerminal($: EngineInterface): void {
  if (isTerminalStarted) return
  isTerminalStarted = true
  void readNerdFont($)
  void readWorkspace($)
}

// Also called from the first render: after /reload-plugins, session.start does not fire.
// The reads run side by side; each redraws when it lands, so the line fills in as they arrive.
// Started from load: a change to the plugin's options reloads it without a session.start.
let isTimerStarted = false
let idleReadAt = 0

function startTimer($: EngineInterface): void {
  if (isTimerStarted) return
  isTimerStarted = true
  $.clock.every(WORKSPACE_REFRESH_MS, () => {
    if (isTerminalStarted) void readWorkspace($)
    void readExchange($)
    void readExtra($)
    void readIdle($)
    if (open === 'ledger') redraw($) // the cache countdown changes with no event
  })
}

// /config, /model and /compact change the model list, the model and the context with no event here.
async function readIdle($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (session.phase !== 'idle' || now - idleReadAt < IDLE_REFRESH_MS) return
  idleReadAt = now
  const [usage, rows] = await Promise.all([$.session.usage().catch(() => null), $.config.list().catch(() => null)])
  if (usage) session.context = usage.context
  if (rows) readRows(rows)
  redraw($)
}

async function load($: EngineInterface): Promise<void> {
  loaded = true
  startTimer($)
  void $.command.register({ name: 'hairline-fonts', description: 'Look for a Nerd Font again, after installing or removing one' }).catch(() => {})
  void readExchange($)
  void readExtra($)
  void readCompactAt($)
  void readDisplayHz($)
  const saving = restore($).then(saved => {
    if (saved?.stats && counted(saved.stats) > counted(session.stats)) session.stats = { ...emptyStats(), ...saved.stats }
    return saved
  })
  restored = saving
  const [saved, usage, rows] = await Promise.all([
    saving,
    $.session.usage().catch(() => null), // the first session.measure sends the numbers
    $.config.list().catch(() => null), // the first request sends the effort
  ])
  if (saved?.limitStart) session.limitStart = { ...saved.limitStart, ...session.limitStart }
  if (usage) {
    session.context = usage.context
    session.rateLimits = usage.rateLimits
    session.costUsd = usage.cost?.usd ?? null
    session.stats.costStart ??= session.costUsd
    trackLimits($, usage.rateLimits)
  }
  if (rows) {
    session.pickedEffort = saved?.pickedEffort ?? null
    session.pickBase = saved?.pickBase ?? null
    readRows(rows)
    setEffort($, session.pickedEffort ?? saved?.effort ?? rows.find(row => /effort/i.test(row.key))?.value)
  }
  redraw($)
}

async function copySessionId($: EngineInterface, surface: RenderSurface): Promise<void> {
  const sessionId = await $.session.id()
  const r = await $.ui.copy({ text: sessionId, surface })
  $.ui.toast(r.isCopied ? `session id copied: ${sessionId}` : `session id: ${sessionId}`)
}

// The desktop app sets text in a proportional font, where the line's glyphs and figures drift.
// Monospaced caption text draws them as the terminal does; other mods' rows keep their own style.
function monospace(node: RenderElement): RenderElement {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(monospace) as never
  const el = node as { type: string; props?: Record<string, unknown>; children?: RenderElement }
  const props = el.type === 'Text' ? { mono: true, tabular: true, size: 'caption', ...el.props } : el.props
  return { ...el, props, children: el.children === undefined ? undefined : monospace(el.children) } as never
}

// The line and its panels, under whatever the hooks beneath drew: the engine's hint on the terminal,
// another mod's rows in the desktop app's band above the prompt.
async function drawLine($: EngineInterface, e: RenderInput<'PromptHint' | 'AbovePrompt'>, engineHint: RenderElement | null | undefined) {
  if (!loaded) void load($)
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Client = 'Client' in elements ? elements.Client : null // only the terminal and the desktop app run Client modules
  const c = e.surface === 'terminal' ? TERMINAL_PALETTE : THEME_PALETTE
  // The desktop app shows the folder, model and effort next to the prompt already.
  const isDesktop = e.surface === 'desktop'
  const pad = (text: string, width: number) => text.padStart(width)
  if (!isDesktop) startTerminal($)
  const [model, sessionId] = await Promise.all([isDesktop ? '' : $.session.model().catch(() => ''), $.session.id().catch(() => '')])
  const { folder, worktree, branch, effort, stats, tokensPerSecond, context, compactAt, rateLimits } = session
  const tokens = counted(stats)
  // Each kind costs a different price, so the line splits them as Pi's footer does.
  // In the terminal each count is padded to the widest human() gives (35.52M), so a count that
  // grows a digit moves none of the figures after it.
  const count = (n: number) => (isDesktop ? human(n) : human(n).padStart(COUNT_WIDTH))
  const tokenSplit = [[count(stats.input), 'in'], [count(stats.output), 'out'], [count(stats.read), 'read'], [count(stats.write), 'write']] as const
  // Fixed in the terminal, so the columns keep their place whatever the figures in them.
  const readoutWidth = isDesktop ? READOUT_WIDTH : READOUT_WIDTH_WIDE
  const graphCells = GRAPH_CELLS_WIDE
  const activityWidth = TOKEN_SPLIT_WIDTH
  // Claude Code indents the hint line 2 columns on each side.
  const workspaceCut = cutWorkspace(folder, worktree, branch, hasNerdFont, workspaceWidth((e.viewport?.columns ?? 0) - 4))
  const pct = context?.percent ?? null
  const now = Date.now()

  const Sep = () => <Text dimColor> · </Text>
  // The number and " t/s" while a reply streams, the phase's word otherwise: readoutWidth cells either
  // way. A running tool fills the readout and the graph's cells too; readout.tsx counts the sending time.
  const columnTool = toolReadout(session.tools, isDesktop ? TOOL_WIDTH : readoutWidth + 1 + graphCells)
  // Sending in the terminal: the readout takes the graph's first SECONDS_WIDTH cells for the time
  // after "waiting...", and the scan runs in the rest.
  const isWaitingWide = !isDesktop && session.phase === 'sending'
  const readoutText = isWaitingWide ? ' '.repeat(readoutWidth + SECONDS_WIDTH) : session.phase === 'receiving'
    ? `${pad(String(Math.min(TPS_MAX, session.readoutTps)), readoutWidth - 4)} t/s`
    : session.phase === 'tool' ? columnTool.text : pad(PHASE_WORDS[session.phase], readoutWidth)
  const isToolShown = session.phase === 'tool'
  const Phase = () => {
    switch (session.phase) {
      case 'sending': return <Text color={c.folder}>↑ </Text>
      case 'receiving': return <Text color={c.ok}>↓ </Text>
      case 'tool': return Client
        ? <Client key="hairline-spinner" module="./spinner.tsx" props={{ color: c.warn, mono: isDesktop }} />
        : <Text color={c.warn}>{`${isDesktop ? DESKTOP_GLYPHS.tool : hasNerdFont ? NERD_GLYPHS.tool : ' '} `}</Text>
      case 'idle': return <Text dimColor>{`${IDLE_GLYPH} `}</Text>
    }
  }
  const Percent = ({ value }: { value: number }) => <Text color={severity(c, value)}>{`${Math.round(value)}%`}</Text>

  // Other graphical surfaces draw line glyphs wider than a cell, so they get painted boxes. The
  // desktop app's text is monospaced (see monospace), which keeps the glyphs one cell wide.
  const filled = pct === null ? 0 : filledCells(pct)
  // In the last cell the marker would only repeat the bar's own end, so it hides there.
  const compactCell = compactAt === null ? BAR_CELLS : Math.floor((compactAt / 100) * BAR_CELLS)
  const markerCell = compactCell < BAR_CELLS - 1 ? compactCell : -1
  const cells = Array.from({ length: BAR_CELLS }, (_, i) => ({
    isFilled: i < filled,
    isMarker: i === markerCell,
    color: rampColor(c, ((i + 0.5) / BAR_CELLS) * 100, compactAt),
  }))
  const contextBar = e.surface === 'terminal' || isDesktop ? (
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
      <Box key={kind} flexShrink={0}>
        <Sep />
        <Text dimColor>{`${label} `}</Text>
        <Percent value={w.percentUsed} />
        {w.percentUsed >= RESET_SHOWN_FROM && w.resetsAt && <Text dimColor>{` ${!isDesktop && hasNerdFont ? `${NERD_GLYPHS.reset} ` : 'resets '}${untilReset(w.resetsAt)}`}</Text>}
      </Box>
    )
  })

  // Extra usage is billed only after the 5h or 7d window is full. The spend shows from EXTRA_SHOWN_FROM,
  // so the cap is in view before the first billed request.
  const isCapped = RATE_LIMIT_WINDOWS.some(({ kind }) => (rateLimits.find(l => l.kind === kind)?.percentUsed ?? 0) >= EXTRA_SHOWN_FROM)
  const extraSpend = extra && isCapped && (
    <Box key="extra" flexShrink={0}>
      <Sep />
      <Text dimColor>extra </Text>
      <Text color={severity(c, extra.pct)}>{amount(extra.used, extra.currency)}</Text>
      <Text dimColor>{`/${amount(extra.limit, extra.currency)}`}</Text>
    </Box>
  )

  const Row = ({ label, children }: { label: string; children: RenderChildren }) => (
    <Box flexDirection="row" paddingLeft={2} flexWrap="wrap">
      <Text dimColor>{label.padEnd(8)}</Text>
      {children}
    </Box>
  )
  const Fig = ({ value, unit }: { value: string; unit?: string }) => (
    <Box><Text>{value}</Text>{unit && <Text dimColor>{` ${unit}`}</Text>}</Box>
  )
  const ledger = () => {
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
              {/* Only a limit that fills before its reset needs a word. */}
              {(fullInMs === null || resetsInMs === null || fullInMs < resetsInMs) && <Text color={c.warn}>{`, full in ${duration(fullInMs ?? 0)}`}</Text>}
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
          <Fig value={`${Math.round((stats.main / Math.max(1, stats.main + stats.sub)) * 100)}%`} unit="main" /><Sep />
          <Fig value={`${Math.round((stats.sub / Math.max(1, stats.main + stats.sub)) * 100)}%`} unit="subagents" /><Sep />
          <Fig value={String(stats.turns)} unit="turns" />
          {stats.activeMs > 0 && <Box><Sep /><Fig value={duration(stats.activeMs)} unit="active" /></Box>}
          {lastTurn && <Box><Sep /><Text dimColor>last turn </Text><Fig value={human(lastTurn.tokens)} unit={`tok in ${duration(lastTurn.ms)}`} /></Box>}
        </Row>
        {burns.length > 0 && <Row label="limits">{burns}</Row>}
      </Box>
    )
  }

  // The pieces both layouts share. Built once per draw, each goes into one layout only.
  // Idle in the terminal, the readout stays empty: a dim glyph, a word and a flat graph only said so.
  const activity = !isDesktop && session.phase === 'idle' ? <Text> </Text> : (
    <Box flexShrink={0}>
      {/* An emoji or a fallback-font glyph is wider than a cell in the desktop app; the box keeps the glyph 3 cells: 2 for it, 1 of space. */}
      {isDesktop ? <Box width={3} overflow="hidden"><Phase /></Box> : <Phase />}
      {/* The number first, padded on its left: the bar ends the group, with only the separator after it. */}
      {Client ? (
        <Client key="hairline-readout" module="./readout.tsx" props={{ text: readoutText, kind: session.phase, bright: session.phase === 'receiving' ? readoutWidth - 4 : isToolShown ? columnTool.bright : 0, frameMs: frameMs(), sentAt: session.sentAt, mono: isDesktop }} />
      ) : isToolShown ? <Text dimColor>{readoutText}</Text> : session.phase === 'receiving' ? (
        <Box>
          <Text>{pad(String(Math.min(TPS_MAX, session.readoutTps)), readoutWidth - 4)}</Text>
          <Text dimColor> t/s</Text>
        </Box>
      ) : <Text dimColor>{pad(PHASE_WORDS[session.phase], readoutWidth)}</Text>}
      {Client && !isToolShown && <Text> </Text>}
      {Client && !isToolShown && (
        <Client key="hairline-graph" module="./graph.tsx" props={{ rate: tokensPerSecond, live: session.streaming, sweep: session.phase === 'sending', color: c.folder, frameMs: frameMs(), mono: isDesktop, ...(isDesktop ? {} : { cells: isWaitingWide ? graphCells - SECONDS_WIDTH : graphCells, scan: true }) }} />
      )}
    </Box>
  )

  // One target for the four figures: each is 3 to 5 cells, too small to aim at alone.
  const tokenSplitControl = tokens === 0 ? <Text dimColor>--- tok</Text> : isDesktop && Client ? (
    <Box>
      <Client key="hairline-token-split" module="./chip.tsx" props={{ text: tokenSplit.map(([n, unit]) => `${n} ${unit}`).join(' / '), inverse: open === 'ledger' }} />
    </Box>
  ) : (
    <Button key="hairline-token-split" label="token split" plain onPress={() => toggle($, 'ledger')}>
      {/* One muted gray: the token split is a tally to glance at, the activity above it is live. */}
      <Text inverse={open === 'ledger'} dimColor wrap="truncate-end">{tokenSplit.map(([n, unit]) => `${n} ${unit}`).join(' / ')}</Text>
    </Button>
  )

  const modelControls = model && !isDesktop && (
    <Box flexShrink={0}>
      {modelRow ? (
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
      ) : <Text>{modelLabel(model)}</Text>}
      {effort && (
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
    </Box>
  )

  const sessionIdControl = sessionId && (isDesktop && Client ? (
    <Client key="hairline-session-id" module="./chip.tsx" props={{ text: sessionId.slice(0, 8), color: c.track, dim: true }} />
  ) : (
    <Button
      key="hairline-session-id"
      label={sessionId.slice(0, 8)}
      plain
      onPress={press => copySessionId($, press.surface)}
    >
      <Text color={c.track} dimColor>{sessionId.slice(0, 8)}</Text>
    </Button>
  ))

  // The desktop app's band: one wrapping row of whole chunks, as before the columns. A narrow band
  // moves a chunk to the next row and never wraps the text inside one.
  const desktopLine = (
    <Box flexDirection="row" width="100%" flexWrap="wrap">
      <Box flexDirection="row" flexShrink={0}>
        {contextBar}
        {pct === null
          ? <Text dimColor>{` ${pad('--%', PCT_WIDTH)}`}</Text>
          : <Text color={rampColor(c, pct, compactAt)}>{` ${pad(`${Math.round(pct)}%`, PCT_WIDTH)}`}</Text>}
        <Text dimColor>{` ${pad(context?.tokens === undefined ? '---/---' : `${human(context.tokens)}/${human(context.window)}`, CONTEXT_WIDTH)}`}</Text>
      </Box>
      <Box flexShrink={0}><Sep />{activity}</Box>
      <Box flexShrink={0}><Sep />{tokenSplitControl}</Box>
      {windows}
      {extraSpend}
      <Box flexDirection="row" flexShrink={0} paddingLeft={2} flexGrow={1} justifyContent="flex-end">
        {sessionIdControl}
      </Box>
    </Box>
  )

  // Claude Code indents the hint line 2 columns on each side: a rule of the full width wraps.
  const contextBarCells = Math.max(BAR_CELLS, (e.viewport?.columns ?? 0) - 4)
  const contextBarFilled = pct === null ? 0 : Math.round((Math.min(pct, 100) / 100) * contextBarCells)
  // In the last cell the marker would only repeat the rule's own end, so it hides there.
  const contextBarMarker = compactAt === null ? -1 : Math.min(contextBarCells, Math.floor((compactAt / 100) * contextBarCells))
  // Runs of one glyph in one color share a Text: a cell each would be some 200 elements.
  const contextBarRuns: { glyph: string; color: string; text: string }[] = []
  for (let i = 0; i < contextBarCells; i++) {
    const isFilled = i < contextBarFilled
    const ramp = rampColor(c, ((i + 0.5) / contextBarCells) * 100, compactAt)
    const isMarker = i === contextBarMarker && i < contextBarCells - 1
    const glyph = isMarker ? '┃' : isFilled ? '━' : '─'
    // The track is dim text: slot 8 vanishes on translucent and dark backgrounds.
    const color = isMarker ? (isFilled ? ramp : c.marker) : isFilled ? ramp : ''
    const last = contextBarRuns[contextBarRuns.length - 1]
    if (last && last.glyph === glyph && last.color === color) last.text += glyph
    else contextBarRuns.push({ glyph, color, text: glyph })
  }
  const workspaceRow = (
    <Box flexDirection="row" height={1} overflow="hidden" flexShrink={0}>
      <Text color={c.folder}>{folder}</Text>
      {(worktree || branch) && <Text dimColor> (</Text>}
      {worktree && <Text dimColor>{`${hasNerdFont ? `${NERD_GLYPHS.worktree} ` : ''}${workspaceCut.worktree}`}</Text>}
      {worktree && branch && <Text dimColor> · </Text>}
      {branch && hasNerdFont && <Text color={c.branch}>{`${NERD_GLYPHS.branch} `}</Text>}
      {branch && <Text color={c.branch}>{workspaceCut.branch}</Text>}
      {(worktree || branch) && <Text dimColor>)</Text>}
    </Box>
  )

  // The one-row layouts, scan and middle. The percent rides the bar where the fill ends.
  const barRuns: BarRun[] = (() => {
    const cells = contextBarRuns.flatMap(run => Array.from(run.text, () => ({ glyph: run.glyph, color: run.color })))
    if (pct !== null) {
      const label = ` ${Math.round(pct)}% `
      const at = Math.max(0, Math.min(contextBarFilled, cells.length - label.length))
      for (let i = 0; i < label.length && at + i < cells.length; i++) cells[at + i] = { glyph: 'text', color: rampColor(c, pct, compactAt) }
      return joinRuns(cells, label, at)
    }
    return joinRuns(cells, '', 0)
  })()
  const phaseScan = session.phase === 'idle' ? null : c.scan[session.phase]
  // A reply crosses the bar once a second at 80 t/s; thinking and a tool have no rate, so a steady pace.
  const passes = session.phase === 'receiving' ? Math.max(0.2, tokensPerSecond / SCAN_TPS_PER_PASS) : session.phase === 'sending' ? 0.5 : 0.7
  // The scan runs in the terminal's Client; other surfaces draw the bar still.
  const barRow = settings.layout === 'scan' && Client && e.surface === 'terminal' ? (
    <Client key="hairline-bar" module="./bar.tsx" props={{ runs: barRuns, frameMs: frameMs(), ...(phaseScan ? { scan: { ...phaseScan, passes } } : {}) }} />
  ) : (
    <Box width="100%" overflow="hidden" flexWrap="nowrap">
      {barRuns.map((run, i) => run.color
        ? <Text key={`rule-${i}`} color={run.color} wrap="truncate-end">{run.text}</Text>
        : <Text key={`rule-${i}`} dimColor wrap="truncate-end">{run.text}</Text>)}
    </Box>
  )
  // The ledger opens from the limits: the token split is not on these rows.
  const limitButton = (kind: string, label: string) => {
    const w = rateLimits.find(l => l.kind === kind)
    return w && (
      <Button key={`hairline-ledger-${label}`} label={`${label} limit`} plain onPress={() => toggle($, 'ledger')}>
        <Text inverse={open === 'ledger'}><Text dimColor>{`${label} `}</Text><Text color={severity(c, w.percentUsed)}>{`${Math.round(w.percentUsed)}%`}</Text></Text>
      </Button>
    )
  }
  const hasBothLimits = RATE_LIMIT_WINDOWS.every(({ kind }) => rateLimits.some(l => l.kind === kind))
  const rightGroup = (
    <Box flexShrink={0}>
      {limitButton('five_hour', '5h')}
      {hasBothLimits && <Sep />}
      {limitButton('seven_day', '7d')}
      {rateLimits.length === 0 && (
        <Button key="hairline-ledger-tokens" label="ledger" plain onPress={() => toggle($, 'ledger')}>
          <Text inverse={open === 'ledger'} dimColor>{tokens === 0 ? '--- tok' : `${human(tokens)} tok`}</Text>
        </Button>
      )}
      {extraSpend}
      {modelControls && <Text>   </Text>}
      {modelControls}
      {sessionIdControl && <Sep />}
      {sessionIdControl}
    </Box>
  )
  // Middle: the activity in a fixed place between the pinned sides, in words a glance reads.
  const tool = toolReadout(session.tools, MIDDLE_TOOL_WIDTH)
  const centerActivity = session.phase === 'sending' ? (
    <Box flexShrink={0}>
      <Text color={c.thinking}>✻ thinking </Text>
      {Client && <Client key="hairline-readout" module="./readout.tsx" props={{ text: ' '.repeat(SECONDS_WIDTH), kind: 'sending', bright: SECONDS_WIDTH, frameMs: frameMs(), sentAt: session.sentAt }} />}
    </Box>
  ) : session.phase === 'receiving' ? (
    <Box flexShrink={0}>
      <Text color={c.ok}>↓ </Text>
      <Text>{String(Math.min(TPS_MAX, session.readoutTps))}</Text>
      <Text dimColor> t/s </Text>
      {Client && <Client key="hairline-graph" module="./graph.tsx" props={{ rate: tokensPerSecond, live: session.streaming, color: c.folder, frameMs: frameMs(), cells: MIDDLE_GRAPH_CELLS, line: true }} />}
    </Box>
  ) : session.phase === 'tool' ? (
    <Box flexShrink={0}>
      <Phase />
      <Text>{tool.text.slice(0, tool.bright)}</Text>
      <Text dimColor>{tool.text.slice(tool.bright).trimEnd()}</Text>
    </Box>
  ) : <Text> </Text>
  const oneRow = settings.layout === 'middle' ? (
    <Box flexDirection="row" width="100%" height={1}>
      <Box flexShrink={1} overflow="hidden">{workspaceRow}</Box>
      <Box flexGrow={1} />
      <Box flexShrink={1} overflow="hidden" paddingLeft={2} paddingRight={2}>{centerActivity}</Box>
      <Box flexGrow={1} />
      {rightGroup}
    </Box>
  ) : (
    <Box flexDirection="row" width="100%" height={1}>
      <Box flexGrow={1} overflow="hidden">{workspaceRow}</Box>
      {rightGroup}
    </Box>
  )
  const oneLine = (
    <Box flexDirection="column" width="100%">
      {barRow}
      {oneRow}
    </Box>
  )

  const line = (
    <Box flexDirection="column">
      {isDesktop ? desktopLine : oneLine}
      {open === 'model' && modelRow && (
        <Box flexDirection="row" justifyContent="flex-end" width="100%" flexWrap="wrap">
          {modelRow.options.map((option, i) => (
            <Box key={`model-${option}`}>
              {i > 0 && <Text> </Text>}
              <Button
                key={`hairline-model-${option}`}
                label={optionLabel(option)}
                plain
                onPress={async () => {
                  setOpen($, null)
                  const { deny } = await $.config.set({ key: 'model', value: option })
                  if (!deny && modelRow) modelRow = { ...modelRow, value: option }
                  $.ui.toast(deny ? `model not changed: ${deny}` : `model ${optionLabel(option)}`)
                  redraw($)
                }}
              >
                <Text bold={option === modelRow!.value} underline={option === modelRow!.value} dimColor={option !== modelRow!.value}>{optionLabel(option)}</Text>
              </Button>
            </Box>
          ))}
        </Box>
      )}
      {open === 'effort' && effort && (
        <Box flexDirection="row" justifyContent="flex-end" width="100%" flexWrap="wrap">
          {EFFORT_LEVELS.map((level, i) => (
            <Box key={`effort-${level}`}>
              {i > 0 && <Text> </Text>}
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
      {open === 'ledger' && tokens > 0 && ledger()}
    </Box>
  )
  return (
    <Box flexDirection="column">
      {engineHint}
      {isDesktop ? monospace(line) : line}
    </Box>
  )
}

export const register: Register = (on, options) => {
  settings = readSettings(options)
  on('command.run', { command: 'hairline-fonts' }, async $ => ({
    text: (await readNerdFont($, true)) ? 'Nerd Font found: the line shows its glyphs.' : 'No Nerd Font found: the line shows no glyphs.',
  }))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    session = emptySession()
    void load($) // the session starts without waiting for the line's data
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
    session.tools = []
    session.sentAt = Date.now()
    redraw($)
    let firstChunkAt = 0
    let chars = 0
    let lastSample = 0
    let lastReadout = 0
    const recent: { at: number; chars: number }[] = []
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        const now = await $.clock.now() // the test kit's clock, so a test can stream at a fixed pace
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
            // The graph takes every sample; the readout's figure eases at a pace the eye can read.
            if (now - lastReadout >= READOUT_EASE_MS) {
              session.readoutTps = session.readoutTps ? Math.round(session.readoutTps + (session.tokensPerSecond - session.readoutTps) / 2) : session.tokensPerSecond
              lastReadout = now
            }
            redraw($)
          }
        }
        // Only the stop chunk has real token counts, so it sets the ratio for the next reply.
        if (chunk.kind === 'stop' && chunk.usage && chunk.usage.output_tokens >= RATIO_MIN_TOKENS && chars) {
          charsPerToken = Math.min(RATIO_MAX, Math.max(RATIO_MIN, chars / chunk.usage.output_tokens))
        }
        yield chunk
      }
      const result = await stream.result
      // The response lists every tool call it made; tool.check misses those the engine allows itself.
      session.tools = result.toolUses.map(use => ({ name: use.name.startsWith('mcp__') ? use.name.split('__').pop()! : use.name, arg: toolArg(use.name, use.input) }))
      return result
    } finally {
      session.lastRequestAt = Date.now()
      session.phase = 'tool' // a request without a turn.complete after it runs a tool
      if (session.streaming) {
        session.streaming = false
        session.tokensPerSecond = 0
        session.readoutTps = 0
        redraw($)
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      session.phase = 'idle'
      session.tools = []
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

  // Clicks on the desktop app's chips (claude/chip.tsx), which stand in for the terminal's Buttons.
  on('ui.message', async ($, e, next) => {
    if (e.element === 'hairline-token-split') toggle($, 'ledger')
    else if (e.element === 'hairline-session-id') await copySessionId($, e.surface)
    return next(e)
  })

  // A Client that fails drops out of the line with no trace on screen; the toast names the module
  // and the reason, so a broken frame shows up in use, not only in a log nobody reads.
  on('ui.fault', async ($, e, next) => {
    $.ui.toast(`hairline: ${e.module} failed (${e.phase}): ${e.reason}`)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => drawLine($, e, await next(e)))

  // The desktop app never asks for PromptHint, so the line goes in this band there. A survey owns it
  // while it shows.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    return e.surface === 'desktop' && !e.props.hasSurvey ? drawLine($, e, below) : below
  })
}
