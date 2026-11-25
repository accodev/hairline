import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { SCAN_BODY_CELLS, SCAN_HEAD_CELLS, SCAN_TAIL, SECONDS_WIDTH, sendingText } from './anim.ts'

// The footer as text. Pi hands every line to the terminal as is, so the colors are SGR codes for
// the 16 palette slots: each person's terminal scheme picks the shades, as in Claude Code.

// Fixed widths, so a changing figure never moves the ones after it on the line.
// The terminal's columns give the readout 12 cells, as in Claude Code.
export const READOUT_WIDTH = 12
export const TPS_WIDTH = READOUT_WIDTH - ' t/s'.length
const TPS_MAX = 9999
// The widest count human() prints: 999.99M, 112.46B. At 6 cells, 112.46M wrapped the row.
export const COUNT_WIDTH = 7
// The padded token row: 4 counts, each a space and its unit, joined by 3 " / ".
export const TOKEN_SPLIT_WIDTH = 4 * COUNT_WIDTH + ' in out read write'.length + 3 * ' / '.length
// The graph fills the activity row to the token split's width: the phase glyph and its space, the
// readout, a space, the graph.
export const GRAPH_CELLS = TOKEN_SPLIT_WIDTH - 2 - READOUT_WIDTH - 1
// The first column: the repository over the context, cut with an ellipsis past this width.
export const WORKSPACE_WIDTH = 52
// scan: the context bar, scanned while a turn runs, over one row. middle: the bar over one row with
// the activity centered.
export const LAYOUTS = ['scan', 'middle'] as const
export type Layout = (typeof LAYOUTS)[number]
// Middle: the tool call's text and the dot line's cells in the centered activity.
const MIDDLE_TOOL_WIDTH = 48
export const MIDDLE_GRAPH_CELLS = 12
const WARN_FROM = 60
const BAD_FROM = 85
const BURN_MIN_HOURS = 0.1
export const HOUR_MS = 3_600_000
// Nerd Font glyphs are private-use code points that any other font draws as a box.
// U+21BB, Claude Code's first reset arrow, is missing from common terminal fonts.
export const NERD_GLYPHS = { reset: '\uf017', worktree: '\uf07b', branch: '\ue725' } as const // nf-fa-clock_o, nf-fa-folder, nf-dev-git_branch
const IDLE_GLYPH = '\u25cb' // a white circle, which every terminal font draws
export const PHASE_WORDS = { idle: 'idle', sending: 'sending', tool: 'running' } as const
// The readout, its gap and the graph: a running tool's name and argument fill them all.
export const TOOL_WIDTH = READOUT_WIDTH + 1 + GRAPH_CELLS
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SPINNER_MS = 80
export const RATE_LIMIT_WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: '7d' },
] as const

const C = {
  ok: 2, warn: 3, bad: 1, folder: 4, branch: 5, track: 8, marker: 15,
  ramp: [10, 2, 11, 3, 1, 9],
} as const
// Pi's thinking levels; "minimal" and "off" have no color of their own and draw dim.
const EFFORT_COLORS: Record<string, number> = { low: 4, medium: 5, high: 13, xhigh: 1, max: 9 }

export type Phase = 'sending' | 'receiving' | 'tool' | 'idle'
export type Tool = { name: string; arg: string }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type LimitStart = Record<string, { pct: number; at: number; resetsAt?: string }>
// The month's extra usage, in the currency the account is billed in.
export type Extra = { used: number; limit: number; currency: string; pct: number }
export type Stats = { input: number; write: number; read: number; output: number; costUsd: number | null }
export type Style = { color?: number; dim?: boolean; bold?: boolean; underline?: boolean; inverse?: boolean }

export type View = {
  folder: string // the repository's name: in a worktree, the main checkout's folder
  worktree: string | null
  branch: string | null
  model: string
  effort: string | null
  sessionId: string
  context: { tokens: number | null; contextWindow: number; percent: number | null } | null
  compactAt: number | null // percent of the window where auto-compaction starts
  stats: Stats
  turns: number
  activeMs: number
  costStart: number | null
  limits: Limit[]
  limitStart: LimitStart
  extra: Extra | null
  phase: Phase
  tools: Tool[]
  readout: string // the readout as the animation shows it, READOUT_WIDTH or TOOL_WIDTH cells
  graph: string // the graph, GRAPH_CELLS cells
  sweepMs: number // the time into the sending scan
  layout: Layout
  scanAt: number // the scan layout's passes so far; the fraction is the head's place
  waitedMs: number // how long the request has been out, while sending
  line: string // the middle layout's dot line, MIDDLE_GRAPH_CELLS cells
  thinking?: (text: string) => string // Pi's own thinkingText color, from the theme
  isLit: boolean // the graph draws at full strength while a reply streams or a request waits
  hasNerdFont: boolean
  open: 'ledger' | 'model' | 'effort' | null
  hover: string | null // the action of the part under the mouse pointer
  models: { label: string; isCurrent: boolean }[] // the models the picker offers
  efforts: string[] // the thinking levels the model supports
  lastTurn: { tokens: number; ms: number; usd: number | null } | null
  lastRequestAt: number | null
  cacheTtlMinutes: number
  money: (usd: number) => string
  statuses: string[]
  now: number
}

export function paint(text: string, s: Style = {}): string {
  const codes: number[] = []
  if (s.bold) codes.push(1)
  if (s.dim) codes.push(2)
  if (s.underline) codes.push(4)
  if (s.inverse) codes.push(7)
  if (s.color !== undefined) codes.push(s.color < 8 ? 30 + s.color : 90 + s.color - 8)
  return codes.length && text ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text
}
const dim = (text: string) => paint(text, { dim: true })
const SEP = dim(' · ')

export const counted = (s: Stats) => s.input + s.write + s.read + s.output

function severity(pct: number): number {
  return pct >= BAD_FROM ? C.bad : pct >= WARN_FROM ? C.warn : C.ok
}

// Red at the compaction point, which is where the context runs out in practice.
function rampColor(pct: number, compactAt: number | null): number {
  const share = pct / (compactAt ?? 100)
  return C.ramp[Math.max(0, Math.min(C.ramp.length - 1, Math.floor(share * C.ramp.length)))]!
}

// Largest first. Each cut is where the unit below would round up to 1000: 999,500 prints 1000k
// with whole thousands, 999.995M prints 1000.00M with 2 decimals.
const BIG_UNITS = [
  ['Q', 1e15, 999_995e9],
  ['T', 1e12, 999_995e6],
  ['B', 1e9, 999_995e3],
  ['M', 1e6, 999_500],
] as const

export function human(n: number): string {
  for (const [suffix, size, cut] of BIG_UNITS) {
    if (n >= cut) return `${(n / size).toFixed(2).replace(/\.?0+$/, '')}${suffix}`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

const DURATION_UNITS = [
  ['days', 86_400_000, 'd'],
  ['hours', 3_600_000, 'h'],
  ['minutes', 60_000, 'm'],
  ['seconds', 1_000, 's'],
] as const
type DurationFormatter = { format(d: Partial<Record<string, number>>): string }
// Node 22 has no Intl.DurationFormat; its narrow English output is the fallback's.
const DurationFormat = (Intl as unknown as { DurationFormat?: new (l?: string, o?: object) => DurationFormatter }).DurationFormat
const durationFormat: DurationFormatter = DurationFormat
  ? new DurationFormat(undefined, { style: 'narrow' })
  : { format: d => DURATION_UNITS.filter(([unit]) => d[unit]).map(([unit, , short]) => `${d[unit]}${short}`).join(' ') || '0s' }

// 2 units, as humanize-duration and pretty-ms default to, so every time on the line has one form.
export function duration(ms: number): string {
  const largest = DURATION_UNITS.findIndex(([, size]) => ms >= size)
  const first = largest === -1 ? DURATION_UNITS.length - 1 : largest // under 1 second shows "0s"
  const shown = DURATION_UNITS.slice(first, first + 2)
  const step = shown[shown.length - 1]![1]
  let left = Math.round(Math.max(0, ms) / step) * step
  const parts: Partial<Record<string, number>> = {}
  for (const [unit, size] of shown) {
    parts[unit] = Math.floor(left / size)
    left -= parts[unit]! * size
  }
  return durationFormat.format(parts)
}

export function modelLabel(id: string): string {
  const [family, ...version] = id.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').split('-')
  return version.length ? `${family} ${version.join('.')}` : family ?? id
}

export function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

// The argument that says most about a call. Pi's built-in tools and Claude Code's share these keys.
const ARG_KEYS = ['description', 'command', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'subagent_type', 'agent'] as const
const PATH_KEYS = new Set(['file_path', 'path', 'notebook_path'])

export function toolArg(input: unknown): string {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const key = ARG_KEYS.find(k => typeof args[k] === 'string' && args[k])
  if (!key) return ''
  const value = args[key] as string
  return PATH_KEYS.has(key) ? basename(value) : key === 'url' ? value.replace(/^https?:\/\/(www\.)?/, '') : value
}

export function toolName(name: string): string {
  return name.startsWith('mcp__') ? name.split('__').pop()! : name
}

// Exactly `width` cells. One call: its name and argument. Parallel calls: their count, then each
// call's name and argument, so every tool the turn runs shows, not the first alone.
export function toolReadout(tools: Tool[], width: number): { text: string; bright: number } {
  const first = tools[0]
  if (!first) return { text: PHASE_WORDS.tool.padStart(width), bright: 0 }
  const head = tools.length < 2 ? '' : `${tools.length} tools `
  const full = (head + tools.map(t => `${t.name} ${t.arg}`.trim()).join(' · ')).replace(/\s+/g, ' ')
  const text = full.length > width ? `${full.slice(0, width - 1)}…` : full.padEnd(width)
  return { text, bright: Math.min(head ? head.length - 1 : first.name.length, width) }
}

// The readout's target text for a phase, before the animation scrambles it.
export function readoutTarget(phase: Phase, tps: number, tools: Tool[]): { text: string; bright: number } {
  if (phase === 'receiving') return { text: `${String(Math.min(TPS_MAX, tps)).padStart(TPS_WIDTH)} t/s`, bright: TPS_WIDTH }
  if (phase === 'tool') return toolReadout(tools, TOOL_WIDTH)
  // Sending: the readout takes the graph's first SECONDS_WIDTH cells for the time after "waiting...".
  if (phase === 'sending') return { text: ' '.repeat(READOUT_WIDTH + SECONDS_WIDTH), bright: 0 }
  return { text: PHASE_WORDS[phase].padStart(READOUT_WIDTH), bright: 0 }
}


function phaseGlyph(v: View): string {
  switch (v.phase) {
    case 'sending': return paint('↑ ', { color: C.folder })
    case 'receiving': return paint('↓ ', { color: C.ok })
    case 'tool': return paint(`${SPINNER[Math.floor(v.now / SPINNER_MS) % SPINNER.length]} `, { color: C.warn })
    case 'idle': return dim(`${IDLE_GLYPH} `)
  }
}

function percent(value: number): string {
  return paint(`${Math.round(value)}%`, { color: severity(value) })
}


// claude.ai's usage endpoint gives amounts in the currency's minor units: 972 with 2 decimal
// places is 9.72. Its shape is undocumented, so anything unexpected reads as no extra usage.
// The endpoint reports the account's 5h and 7d use, other sessions' included. A response header
// reports it too, but only when this session sends a request.
export function readUsageLimits(text: string): Limit[] {
  const body = JSON.parse(text) as Record<string, { utilization?: number | null; resets_at?: string | null } | null | undefined>
  return RATE_LIMIT_WINDOWS.flatMap(({ kind }) => {
    const w = body[kind]
    if (typeof w?.utilization !== 'number') return []
    return [{ kind, percentUsed: Math.round(w.utilization * 10) / 10, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) }]
  })
}

export function readExtraBody(text: string): Extra | null {
  const x = (JSON.parse(text) as { extra_usage?: { is_enabled?: boolean; monthly_limit?: number | null; used_credits?: number | null; utilization?: number | null; currency?: string | null; decimal_places?: number | null } | null }).extra_usage
  if (!x?.is_enabled || typeof x.monthly_limit !== 'number' || typeof x.used_credits !== 'number' || x.monthly_limit <= 0) return null
  const scale = 10 ** (x.decimal_places ?? 2)
  const used = x.used_credits / scale
  const limit = x.monthly_limit / scale
  return { used, limit, currency: x.currency || 'USD', pct: x.utilization ?? (used / limit) * 100 }
}

// 9.72 keeps its cents, a whole 100 drops them.
export function amount(value: number, currency: string): string {
  const digits = Number.isInteger(value) ? 0 : 2
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(value)
}

// Extra usage is billed only after the 5h or 7d window is full. The spend shows from EXTRA_SHOWN_FROM,
// so the cap is in view before the first billed request.
export const EXTRA_SHOWN_FROM = 95 // percent of the 5h or 7d window
function extraSpend(v: View): string {
  const x = v.extra
  const isCapped = RATE_LIMIT_WINDOWS.some(({ kind }) => (v.limits.find(l => l.kind === kind)?.percentUsed ?? 0) >= EXTRA_SHOWN_FROM)
  return x && isCapped ?`${SEP}${dim('extra ')}${paint(amount(x.used, x.currency), { color: severity(x.pct) })}${dim(`/${amount(x.limit, x.currency)}`)}` : ''
}

export type Hit = { row: number; from: number; to: number; action: string }

// The part under the pointer is underlined, so it reads as a control before the click.
function hoverable(text: string, action: string | undefined, v: View): string {
  return action && action === v.hover ? `\x1b[4m${text}\x1b[0m` : text
}

// A linked worktree's git folder is <main checkout>/.git/worktrees/<id>, so the main checkout names
// the repository. A submodule's is .git/modules/<name>, and it stays a repository of its own.
export function worktreeOf(gitDir: string, top: string): { name: string; worktree: string | null } {
  const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
  const main = gitDir.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/)?.[1]
  return main ? { name: base(main), worktree: base(top) } : { name: base(top), worktree: null }
}

// The worktree and the branch cut to fit the column with the repository, the parentheses, the
// separator and the glyphs. The longer name loses a cell first, so both stay readable.
export function cutWorkspace(folder: string, worktree: string | null, branch: string | null, hasGlyphs: boolean, width: number): { worktree: string; branch: string } {
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

// The repository, then the worktree and the branch in parentheses: two rows leave them room.
function workspace(v: View, width: number): string {
  if (!v.folder) return ''
  const glyph = (g: string) => (v.hasNerdFont ? `${g} ` : '')
  const cut = cutWorkspace(v.folder, v.worktree, v.branch, v.hasNerdFont, width)
  const parts = [
    v.worktree ? dim(glyph(NERD_GLYPHS.worktree) + cut.worktree) : '',
    v.branch ? paint(glyph(NERD_GLYPHS.branch) + cut.branch, { color: C.branch }) : '',
  ].filter(Boolean)
  return paint(v.folder, { color: C.folder }) + (parts.length ? `${dim(' (')}${parts.join(dim(' · '))}${dim(')')}` : '')
}

// The model and the thinking level on the first row, the session ID on the second, each part with
// the action a click on it runs.
function modelParts(v: View): { text: string; action?: string }[][] {
  const top: { text: string; action?: string }[] = []
  if (v.model) {
    top.push({ text: paint(modelLabel(v.model), { inverse: v.open === 'model' }), action: v.models.length > 1 ? 'model' : undefined })
    if (v.effort) {
      const style: Style = EFFORT_COLORS[v.effort] === undefined ? { dim: true } : { color: EFFORT_COLORS[v.effort] }
      top.push({ text: ' ' }, { text: paint(v.effort, { ...style, inverse: v.open === 'effort' }), action: v.efforts.length > 1 ? 'effort' : undefined })
    }
  }
  // Dim only: slot 8 with dim on top vanished on dark terminal schemes.
  const bottom = v.sessionId ? [{ text: dim(v.sessionId.slice(0, 8)), action: 'id' }] : []
  return [top, bottom].map(parts => parts.map(p => ({ ...p, text: hoverable(p.text, p.action, v) })))
}

// The bar, then one row. scan and middle differ only in the row's middle.
function mainRows(v: View, width: number, hits: Hit[]): string[] {
  return oneLineRows(v, width, hits)
}

// Thinking in Pi's own thinking color, as Claude Code thinks in its spinner's; slot 5 without a theme.
function thinkingPaint(v: View, text: string, isDim = false): string {
  if (!v.thinking) return paint(text, { color: 5, dim: isDim })
  return isDim ? `\x1b[2m${v.thinking(text)}\x1b[22m` : v.thinking(text)
}

// The one-row layouts' bar: the context fill with its percent where the fill ends. In scan, a turn
// dims every cell and a head runs along the whole bar, the empty track included.
function scanBar(v: View, width: number): string {
  const pct = v.context?.percent ?? null
  const filled = pct === null ? 0 : Math.round((Math.min(pct, 100) / 100) * width)
  const marker = v.compactAt === null ? -1 : Math.floor((v.compactAt / 100) * width)
  type Cell = { ch: string; style: Style; isText?: boolean; isThinking?: boolean }
  const cells: Cell[] = Array.from({ length: width }, (_, i) => {
    const color = rampColor(((i + 0.5) / width) * 100, v.compactAt)
    if (i === marker && i < width - 1) return { ch: '┃', style: { color: i < filled ? color : C.marker } }
    // The track is dim text: slot 8 vanishes on translucent and dark backgrounds.
    return i < filled ? { ch: '━', style: { color } } : { ch: '─', style: { dim: true } }
  })
  if (pct !== null) {
    const label = ` ${Math.round(pct)}% `
    const at = Math.max(0, Math.min(filled, width - label.length))
    for (let i = 0; i < label.length && at + i < width; i++) cells[at + i] = { ch: label[i]!, style: { color: rampColor(pct, v.compactAt) }, isText: true }
  }
  if (v.layout === 'scan' && v.phase !== 'idle') {
    const head = Math.floor((v.scanAt % 1) * (width + SCAN_TAIL))
    const colors = v.phase === 'receiving' ? [10, 2] : [11, 3]
    cells.forEach((cell, i) => {
      const d = head - i
      // Dim on a fill slot turns it gray in many terminals, so cells outside the head keep their style.
      if (!cell.isText && d >= 0 && d < SCAN_TAIL) cells[i] = { ch: '━', style: { color: d < SCAN_HEAD_CELLS ? colors[0] : colors[1], dim: d >= SCAN_BODY_CELLS }, isThinking: v.phase === 'sending' }
    })
  }
  let out = ''
  let run = ''
  let key = ''
  let last: Cell | null = null
  const flush = () => {
    if (!run || !last) return
    out += last.isThinking ? thinkingPaint(v, run, !!last.style.dim) : paint(run, last.style)
  }
  for (const cell of cells) {
    const k = JSON.stringify([cell.style, !!cell.isThinking])
    if (k !== key) { flush(); run = ''; key = k; last = cell }
    run += cell.ch
  }
  flush()
  return out
}

// The middle layout's activity, in words a glance reads.
function centerActivity(v: View): string {
  if (v.phase === 'sending') return `${thinkingPaint(v, '✻ thinking ')}${sendingText(v.waitedMs, SECONDS_WIDTH).trim()}`
  if (v.phase === 'receiving') return `${paint('↓ ', { color: C.ok })}${v.readout.trim().replace(/ t\/s$/, '')}${dim(' t/s ')}${paint(v.line, { color: C.folder })}`
  if (v.phase === 'tool') {
    const t = toolReadout(v.tools, MIDDLE_TOOL_WIDTH)
    return `${phaseGlyph(v)}${t.text.slice(0, t.bright)}${dim(t.text.slice(t.bright).trimEnd())}`
  }
  return ''
}

// The bar, then one row: the workspace left; the limits, the model and the session ID right. The
// limits open the ledger, as the token split does in columns. Middle centers the activity between.
function oneLineRows(v: View, width: number, hits: Hit[]): string[] {
  const limit = (kind: string, label: string) => {
    const w = v.limits.find(l => l.kind === kind)
    const open = v.open === 'ledger'
    // The window name stays gray; only the percent takes the severity color.
    return w ? hoverable(paint(`${label} `, { dim: true, inverse: open }) + paint(`${Math.round(w.percentUsed)}%`, { color: severity(w.percentUsed), inverse: open }), 'ledger', v) : ''
  }
  const fiveHour = limit('five_hour', '5h')
  const sevenDay = limit('seven_day', '7d')
  const [top, bottom] = modelParts(v)
  const right: { text: string; action?: string }[] = [
    { text: fiveHour, action: fiveHour ? 'ledger' : undefined },
    { text: fiveHour && sevenDay ? SEP : '' },
    { text: sevenDay, action: sevenDay ? 'ledger' : undefined },
    ...(v.limits.length ? [] : [{ text: hoverable(paint(counted(v.stats) ? `${human(counted(v.stats))} tok` : '--- tok', { dim: true, inverse: v.open === 'ledger' }), 'ledger', v), action: 'ledger' }]),
    { text: extraSpend(v) },
    { text: top!.length ? '   ' : '' },
    ...top!,
    { text: bottom!.length ? SEP : '' },
    ...bottom!,
  ].filter(p => p.text)
  const rightText = right.map(p => p.text).join('')
  const rightWidth = visibleWidth(rightText)
  const full = v.layout === 'middle' ? centerActivity(v) : ''
  const leftWidth = Math.max(12, Math.min(WORKSPACE_WIDTH, width - rightWidth - (full ? visibleWidth(full) + 4 : 2)))
  const left = workspace(v, leftWidth)
  const leftUsed = visibleWidth(left)
  // The activity sits in the middle of the gap between the sides; a short gap cuts it, never them.
  const gap = width - rightWidth - leftUsed
  const center = full && gap >= 12 ? truncateToWidth(full, gap - 4, '…') : ''
  const centerWidth = visibleWidth(center)
  const centerAt = leftUsed + Math.floor((gap - centerWidth) / 2)
  const rightAt = Math.max(leftUsed + (centerWidth ? 2 + centerWidth + 2 : 2), width - rightWidth)
  let at = rightAt
  for (const p of right) {
    const w = visibleWidth(p.text)
    if (p.action && at + w <= width) hits.push({ row: 1, from: at, to: at + w, action: p.action })
    at += w
  }
  const row = centerWidth
    ? left + ' '.repeat(Math.max(2, centerAt - leftUsed)) + center + ' '.repeat(Math.max(2, rightAt - centerAt - centerWidth)) + rightText
    : left + ' '.repeat(Math.max(2, rightAt - leftUsed)) + rightText
  return [scanBar(v, width), truncateToWidth(row, width, '')]
}

// A picker's options, right-aligned under the line as Claude Code shows them, wrapped to the width.
function pickerRows(label: string, options: { text: string; action: string }[], width: number, firstRow: number, hits: Hit[], v: View): string[] {
  const rows: { parts: { text: string; action?: string }[]; width: number }[] = []
  let current = { parts: [{ text: dim(`${label} `) }] as { text: string; action?: string }[], width: label.length + 1 }
  for (const o of options) {
    const w = visibleWidth(o.text) + 1
    if (current.width + w > width && current.parts.length > 1) {
      rows.push(current)
      current = { parts: [], width: 0 }
    }
    current.parts.push({ text: ' ' }, { ...o, text: hoverable(o.text, o.action, v) })
    current.width += w
  }
  rows.push(current)
  return rows.map((r, i) => {
    let at = Math.max(0, width - r.width)
    for (const p of r.parts) {
      const w = visibleWidth(p.text)
      if (p.action) hits.push({ row: firstRow + i, from: at, to: at + w, action: p.action })
      at += w
    }
    return `${' '.repeat(Math.max(0, width - r.width))}${r.parts.map(p => p.text).join('')}`
  })
}

function row(label: string, body: string): string {
  return `  ${dim(label.padEnd(8))}${body}`
}
const fig = (value: string, unit?: string) => `${value}${unit ? dim(` ${unit}`) : ''}`

function ledger(v: View): string[] {
  const { stats } = v
  const hours = v.activeMs / HOUR_MS
  const trackedUsd = stats.costUsd !== null && v.costStart !== null ? stats.costUsd - v.costStart : null
  const hit = stats.read / Math.max(1, stats.read + stats.write + stats.input)
  const cacheLeft = v.lastRequestAt === null ? null : v.cacheTtlMinutes * 60_000 - (v.now - v.lastRequestAt)
  const cost = stats.costUsd === null ? dim('not reported') : [
    fig(v.money(stats.costUsd)),
    trackedUsd !== null && hours >= BURN_MIN_HOURS ? `${SEP}${fig(v.money(trackedUsd / hours), 'per active hour')}` : '',
    v.lastTurn?.usd != null ? `${SEP}${dim('last turn ')}${fig(v.money(v.lastTurn.usd))}` : '',
  ].join('')
  const tokens = [
    fig(human(stats.input), 'in'), fig(human(stats.write), 'cache write'), fig(human(stats.read), 'cache read'),
    fig(human(stats.output), 'out'), fig(`${Math.round(hit * 100)}%`, 'cache hit'),
    ...(cacheLeft === null ? [] : [cacheLeft > 0 ? dim(`cache warm ${duration(cacheLeft)}`) : paint('cache cold', { color: C.warn })]),
  ].join(SEP)
  const turns = [
    fig(String(v.turns), 'turns'),
    ...(v.activeMs > 0 ? [fig(duration(v.activeMs), 'active')] : []),
    ...(v.lastTurn ? [`${dim('last turn ')}${fig(human(v.lastTurn.tokens), `tok in ${duration(v.lastTurn.ms)}`)}`] : []),
  ].join(SEP)
  const burns = RATE_LIMIT_WINDOWS.flatMap(({ kind, label }) => {
    const w = v.limits.find(l => l.kind === kind)
    if (!w) return []
    const start = v.limitStart[kind]
    const spanHours = start ? (v.now - start.at) / HOUR_MS : 0
    const perHour = start && spanHours >= BURN_MIN_HOURS ? (w.percentUsed - start.pct) / spanHours : 0
    const fullInMs = perHour > 0 ? ((100 - w.percentUsed) / perHour) * HOUR_MS : null
    const resetsInMs = w.resetsAt ? Date.parse(w.resetsAt) - v.now : null
    // Only a limit that fills before its reset needs a word.
    const trend = perHour > 0
      ? `${dim(` +${perHour.toFixed(1)}%/h`)}${fullInMs === null || resetsInMs === null || fullInMs < resetsInMs ? paint(`, full in ${duration(fullInMs ?? 0)}`, { color: C.warn }) : ''}`
      : dim(spanHours < BURN_MIN_HOURS ? ' measuring' : ' steady')
    return [`${dim(`${label} `)}${percent(w.percentUsed)}${trend}`]
  }).join(SEP)
  return [row('cost', cost), row('tokens', tokens), row('turns', turns), ...(burns ? [row('limits', burns)] : [])]
}


// The lines, and where each clickable part sits: Pi routes mouse events to the footer in fullscreen mode.
export function drawFooter(v: View, width: number): { lines: string[]; hits: Hit[] } {
  const hits: Hit[] = []
  const lines = mainRows(v, width, hits)
  if (v.open === 'model') {
    lines.push(...pickerRows('model', v.models.map((m, i) => ({
      text: paint(m.label, m.isCurrent ? { bold: true, underline: true } : { dim: true }),
      action: `model:${i}`,
    })), width, lines.length, hits, v))
  }
  if (v.open === 'effort') {
    lines.push(...pickerRows('thinking', v.efforts.map(level => ({
      text: paint(level, { ...(EFFORT_COLORS[level] === undefined ? { dim: true } : { color: EFFORT_COLORS[level] }), bold: level === v.effort, underline: level === v.effort }),
      action: `effort:${level}`,
    })), width, lines.length, hits, v))
  }
  if (v.open === 'ledger' && counted(v.stats) > 0) lines.push(...ledger(v))
  // Other extensions' setStatus texts, which Pi's own footer would show.
  if (v.statuses.length) lines.push(v.statuses.join(dim('  ')))
  return { lines: lines.map(line => truncateToWidth(line, width, '')), hits }
}
