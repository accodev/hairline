import type { ConfigRow, EngineInterface, PluginOptions, Register, RenderChildren, RenderElement, RenderInput, RenderSurface, SessionContextUsage, SessionRateLimit } from 'claude-code'

const BAR_CELLS = 8
// Fixed widths, so a changing figure never moves the ones after it on the line.
const PCT_WIDTH = 4 // 100%
const CONTEXT_WIDTH = 7 // 999k/1M
const TPS_WIDTH = 4
const TPS_MAX = 9999
const WARN_FROM = 60
const BAD_FROM = 85
const RESET_SHOWN_FROM = 70
const LOCATION_REFRESH_MS = 5_000
const RATE_WINDOW_MS = 1_000
const RATE_WARMUP_MS = 1_000
const HINT_REDRAWS_MAX = 30 // Claude Code folds hint-line redraws past 30 a second
const FRAMES_MAX = 60 // surfaces paint about 60 frames a second
const RATIO_MIN_TOKENS = 20 // shorter responses give a noisy characters-per-token ratio
const RATIO_MIN = 2
const RATIO_MAX = 6
const BURN_MIN_HOURS = 0.1
const HOUR_MS = 3_600_000
const CURRENCIES = ['USD', 'CAD', 'AUD', 'EUR', 'JPY', 'CNY'] as const
const RATES_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=' // European Central Bank rates, no key
// Nerd Font glyphs, private-use code points that any other font draws as a box. Without an
// installed Nerd Font the phase shows blank cells of the same width, so the line stays still.
const NERD_GLYPHS = { tool: '\uf013' } as const // nf-fa-cog
// The desktop app's monospaced face has no Nerd Font glyphs and Text cannot pick another font,
// so it gets emoji, which every desktop system font set draws.
const DESKTOP_GLYPHS = { tool: '\u2699\ufe0f' } as const // gear
// A white circle: a geometric shape that terminal fonts and the desktop app's fallback fonts both draw.
const IDLE_GLYPH = '\u25cb'
// Outside a reply the speed slot names the phase, in the cells of the number and " t/s".
const PHASE_WORDS = { idle: 'idle', sending: 'sending', tool: 'running' } as const
const NERD_FONT_NAME = /nerd ?font|(^|[\s_-])NFM?([\s_.-]|$)/i // CaskaydiaCove Nerd Font, MapleMono-NF-Regular.ttf
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

type Settings = { currency: string; usdRate: number; cacheTtlMinutes: number; refreshPerSecond: number; frameRate: number }
let settings: Settings = { currency: 'EUR', usdRate: 0.9, cacheTtlMinutes: 60, refreshPerSecond: HINT_REDRAWS_MAX, frameRate: 30 }

// Set once a day: the ECB publishes one rate per working day.
let exchange: { currency: string; rate: number; fetchedOn: string } | null = null
let exchangeTriedAt = 0

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
    frameRate: frames > 0 ? Math.min(FRAMES_MAX, Math.max(1, frames)) : 30,
  }
}

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')
const counted = (s: Stats) => s.input + s.write + s.read + s.output // every token in and out, as ccstatusline's Tokens Total counts them

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
// One entry per session, newest first, as Claude Code's own plugins keep theirs: parallel
// sessions share this store, and a single entry let each overwrite the others.
const SAVED_KEY = 'sessions'
const SAVED_MAX = 20
type Saved = { sessionId: string; effort: string | null; pickedEffort?: string | null; pickBase?: Session['pickBase']; stats?: Stats; limitStart?: LimitStart }

async function readSaved($: EngineInterface): Promise<Saved[]> {
  const list = await $.store.get(SAVED_KEY)
  return Array.isArray(list) ? (list as Saved[]) : []
}

function save($: EngineInterface): void {
  const { effort, pickedEffort, pickBase, stats, limitStart } = session
  void Promise.all([$.session.id(), readSaved($)])
    .then(([sessionId, list]) => $.store.set(SAVED_KEY, [
      { sessionId, effort, pickedEffort, pickBase, stats, limitStart } satisfies Saved,
      ...list.filter(saved => saved.sessionId !== sessionId),
    ].slice(0, SAVED_MAX)))
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

function readRows(rows: readonly ConfigRow[]): void {
  const row = rows.find(r => r.key === 'model' && r.kind === 'choice')
  modelRow = row?.options?.length && !row.isLocked ? { value: String(row.value), options: row.options } : null
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

// The working copy's top folder and its HEAD file, found once: the session's directory never moves.
type Repo = { top: string; head: string | null }
let repo: Repo | null = null

async function findRepo($: EngineInterface): Promise<Repo> {
  const cwd = await $.session.cwd()
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (let n = parts.length; n > 0; n--) {
    const top = parts.slice(0, n).join('/')
    const stat = await $.fs.stat(`${top}/.git`).catch(() => null)
    if (stat?.kind === 'dir') return { top, head: `${top}/.git/HEAD` }
    // A worktree's .git is a file that names its git folder.
    if (stat?.kind === 'file') {
      const dir = String(await $.fs.read(`${top}/.git`)).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
      if (!dir) return { top, head: null }
      return { top, head: `${/^([a-z]:)?[\\/]/i.test(dir) ? dir : `${top}/${dir}`}/HEAD` }
    }
  }
  return { top: cwd, head: null }
}

// Reads the HEAD file, so the 5 s refresh starts no git process. A detached HEAD shows as git shows it.
async function readLocation($: EngineInterface): Promise<void> {
  try {
    repo ??= await findRepo($)
    const head = repo.head ? await $.fs.read(repo.head).then(text => String(text).trim(), () => null) : null
    const branch = head === null ? null : (head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] ?? 'HEAD')
    if (basename(repo.top) === session.folder && branch === session.branch) return
    session.folder = basename(repo.top)
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
  void readLocation($)
}

// Also called from the first render: after /reload-plugins, session.start does not fire.
// The reads run side by side; each redraws when it lands, so the line fills in as they arrive.
async function load($: EngineInterface): Promise<void> {
  loaded = true
  void $.command.register({ name: 'hairline-fonts', description: 'Look for a Nerd Font again, after installing or removing one' }).catch(() => {})
  void readExchange($)
  void readCompactAt($)
  const [saved, usage, rows] = await Promise.all([
    restore($),
    $.session.usage().catch(() => null), // the first session.measure sends the numbers
    $.config.list().catch(() => null), // the first request sends the effort
  ])
  if (saved?.stats && counted(saved.stats) > counted(session.stats)) session.stats = { ...emptyStats(), ...saved.stats }
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
  const slot = (text: string, width: number) => text.padStart(width)
  if (!isDesktop) startTerminal($)
  const [model, sessionId] = await Promise.all([isDesktop ? '' : $.session.model().catch(() => ''), $.session.id().catch(() => '')])
  const { folder, branch, effort, stats, tokensPerSecond, context, compactAt, rateLimits } = session
  const tokens = counted(stats)
  const pct = context?.percent ?? null
  const now = Date.now()

  const Sep = () => <Text dimColor> · </Text>
  // The number and " t/s" while a reply streams, the phase's word otherwise: 8 cells either way.
  const speedSlot = session.phase === 'receiving'
    ? `${slot(String(Math.min(TPS_MAX, session.tokensPerSecond)), TPS_WIDTH)} t/s`
    : slot(PHASE_WORDS[session.phase], TPS_WIDTH + ' t/s'.length)
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

  const line = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" width="100%" overflow="hidden">
        <Box flexDirection="row" flexShrink={1} overflow="hidden">
          {/* Only the location shrinks, so the figures never wrap to a second row. */}
          {!isDesktop && (
            <Box flexDirection="row" flexShrink={1} overflow="hidden">
              <Text color={c.folder} wrap="truncate-end">{folder}</Text>
              {branch && <Text dimColor>:</Text>}
              {branch && <Text color={c.branch} wrap="truncate-end">{branch}</Text>}
            </Box>
          )}
          <Box flexDirection="row" flexShrink={0}>
          {!isDesktop && <Text>  </Text>}
          {contextBar}
          {pct === null
            ? <Text dimColor>{` ${slot('--%', PCT_WIDTH)}`}</Text>
            : <Text color={rampColor(c, pct, compactAt)}>{` ${slot(`${Math.round(pct)}%`, PCT_WIDTH)}`}</Text>}
          <Text dimColor>{` ${slot(context?.tokens === undefined ? '---/---' : `${human(context.tokens)}/${human(context.window)}`, CONTEXT_WIDTH)}`}</Text>
          <Box>
            <Sep />
            {/* An emoji or a fallback-font glyph is wider than a cell in the desktop app; the box keeps the slot 3 cells: 2 for it, 1 of space. */}
            {isDesktop ? <Box width={3} overflow="hidden"><Phase /></Box> : <Phase />}
            {/* The number first, padded on its left: the bar ends the group, with only the separator after it. */}
            {Client ? (
              <Client key="hairline-slot" module="./slot.tsx" props={{ text: speedSlot, kind: session.phase, bright: session.phase === 'receiving' ? TPS_WIDTH : 0, frameMs: Math.round(1000 / settings.frameRate), mono: isDesktop }} />
            ) : session.phase === 'receiving' ? (
              <Box>
                <Text>{slot(String(Math.min(TPS_MAX, tokensPerSecond)), TPS_WIDTH)}</Text>
                <Text dimColor> t/s</Text>
              </Box>
            ) : <Text dimColor>{slot(PHASE_WORDS[session.phase], TPS_WIDTH + ' t/s'.length)}</Text>}
            {Client && <Text> </Text>}
            {Client && (
              <Client key="hairline-speed" module="./speed.tsx" props={{ rate: tokensPerSecond, live: session.streaming, color: c.folder, frameMs: Math.round(1000 / settings.frameRate), mono: isDesktop }} />
            )}
          </Box>
          <Sep />
          {tokens === 0 ? <Text dimColor>--- tok</Text> : (
            <Box>
              {isDesktop && Client ? (
                <Box>
                <Client key="hairline-tokens" module="./chip.tsx" props={{ text: `${human(tokens)} tok`, inverse: open === 'tokens' }} />
                </Box>
              ) : (
                <Box>
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
            </Box>
          )}
          {windows}
          </Box>
        </Box>
        <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
          {model && !isDesktop && (modelRow ? (
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
          {model && effort && !isDesktop && (
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
              {model && !isDesktop && <Sep />}
              {isDesktop && Client ? (
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
              )}
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
  return (
    <Box flexDirection="column">
      {engineHint}
      {isDesktop ? monospace(line) : line}
    </Box>
  )
}

export const register: Register = (on, options) => {
  settings = readSettings(options)
  let timerStarted = false

  on('command.run', { command: 'hairline-fonts' }, async $ => ({
    text: (await readNerdFont($, true)) ? 'Nerd Font found: the line shows its glyphs.' : 'No Nerd Font found: the line shows no glyphs.',
  }))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    session = emptySession()
    void load($) // the session starts without waiting for the line's data
    if (!timerStarted) {
      timerStarted = true
      $.clock.every(LOCATION_REFRESH_MS, () => {
        if (isTerminalStarted) void readLocation($)
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

  // Clicks on the desktop app's chips (hooks/chip.tsx), which stand in for the terminal's Buttons.
  on('ui.message', async ($, e, next) => {
    if (e.element === 'hairline-tokens') toggle($, 'tokens')
    else if (e.element === 'hairline-session-id') await copySessionId($, e.surface)
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
