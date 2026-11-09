import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSupportedThinkingLevels, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { copyToClipboard, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { isScrambling, newSlot, newSpeed, sendingText, setSlotKind, slotText, speedDots, tickSlot, tickSpeed } from './anim.ts'
import { basename, counted, drawFooter, type Hit, HOUR_MS, modelLabel, type Limit, type LimitStart, type Phase, slotTarget, type Stats, toolArg, toolName, type Tool, type View } from './line.ts'

const RATE_WINDOW_MS = 1_000
const RATE_WARMUP_MS = 1_000
const RATIO_MIN_TOKENS = 20 // shorter responses give a noisy characters-per-token ratio
const RATIO_MIN = 2
const RATIO_MAX = 6
const REDRAWS_MAX = 30
const FRAMES_MAX = 60
const REFRESH_MS = 5_000
const DEFAULT_RESERVE_TOKENS = 16_384 // Pi's compaction.reserveTokens default
const CURRENCIES = ['USD', 'CAD', 'AUD', 'EUR', 'JPY', 'CNY'] as const
const RATES_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=' // European Central Bank rates, no key
const NERD_FONT_NAME = /nerd ?font|(^|[\s_-])NFM?([\s_.-]|$)/i // CaskaydiaCove Nerd Font, MapleMono-NF-Regular.ttf
// Anthropic sends the subscription limits as response headers; other providers send none.
const LIMIT_HEADERS = [
  { kind: 'five_hour', prefix: 'anthropic-ratelimit-unified-5h' },
  { kind: 'seven_day', prefix: 'anthropic-ratelimit-unified-7d' },
] as const
// A window reset restarts the fill rate. Reset times jitter by seconds, so only 1 minute counts.
const WINDOW_MOVED_MS = 60_000

type Settings = { currency: string; usdRate: number; cacheTtlMinutes: number; refreshPerSecond: number; frameRate: number }

function readSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const code = String(o.currency || 'EUR').trim().toUpperCase().replace(/^RMB$/, 'CNY')
  const rate = Number(o.usdRate)
  const ttl = Number(o.cacheTtlMinutes)
  const refresh = Number(o.speedRefreshPerSecond)
  const frames = Number(o.animationFps)
  return {
    currency: (CURRENCIES as readonly string[]).includes(code) ? code : 'EUR',
    usdRate: rate > 0 ? rate : 0.9,
    cacheTtlMinutes: ttl > 0 ? ttl : 60,
    refreshPerSecond: refresh > 0 ? Math.min(REDRAWS_MAX, Math.max(1, refresh)) : REDRAWS_MAX,
    frameRate: frames > 0 ? Math.min(FRAMES_MAX, Math.max(1, frames)) : 30,
  }
}

// One file for every Pi session: the font answer, the account's last limits, and per session the
// figures no session entry records. Newest session first, as the Claude Code mod keeps them.
type Saved = { sessionId: string; turns: number; activeMs: number; costStart: number | null; limitStart: LimitStart }
type Store = { nerdFont?: boolean; limits?: Limit[]; sessions?: Saved[] }
const SAVED_MAX = 20
const storePath = () => join(getAgentDir(), 'hairline.json')

function readStore(): Store {
  try {
    return JSON.parse(readFileSync(storePath(), 'utf8')) as Store
  } catch {
    return {}
  }
}

function writeStore(change: (s: Store) => void): void {
  try {
    const s = readStore()
    change(s)
    writeFileSync(storePath(), JSON.stringify(s))
  } catch {}
}

// The terminal font is out of reach, so an installed Nerd Font stands in for one in use. fc-list
// covers Linux and Homebrew macOS; the font folders cover Windows and plain macOS.
async function findNerdFont(): Promise<boolean> {
  if (process.platform !== 'win32') {
    const out = await new Promise<string | null>(resolve =>
      execFile('fc-list', [':', 'family'], { timeout: 3_000 }, (err, stdout) => resolve(err ? null : stdout)))
    if (out !== null) return NERD_FONT_NAME.test(out)
  }
  const { WINDIR, LOCALAPPDATA, HOME } = process.env
  const dirs = [WINDIR && `${WINDIR}/Fonts`, LOCALAPPDATA && `${LOCALAPPDATA}/Microsoft/Windows/Fonts`, HOME && `${HOME}/Library/Fonts`, '/Library/Fonts']
  return dirs.some(dir => {
    try {
      return !!dir && readdirSync(dir).some(name => NERD_FONT_NAME.test(name))
    } catch {
      return false
    }
  })
}

// The working copy's top folder, which a worktree's .git file also marks.
function repoFolder(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (let n = parts.length; n > 0; n--) {
    const top = parts.slice(0, n).join('/')
    if (existsSync(`${top}/.git`)) return basename(top)
  }
  return basename(cwd)
}

function readLimits(headers: Record<string, string>): Limit[] {
  return LIMIT_HEADERS.flatMap(({ kind, prefix }) => {
    const used = Number(headers[`${prefix}-utilization`])
    const reset = Number(headers[`${prefix}-reset`])
    if (!headers[`${prefix}-utilization`] || !Number.isFinite(used)) return []
    return [{ kind, percentUsed: used * 100, resetsAt: reset > 0 ? new Date(reset * 1000).toISOString() : undefined }]
  })
}

function sumUsage(ctx: ExtensionContext): Stats {
  const s: Stats = { input: 0, write: 0, read: 0, output: 0, costUsd: null }
  // Every branch: tokens spent on a branch left behind were still spent.
  for (const e of ctx.sessionManager.getEntries()) {
    if (e.type !== 'message' || e.message.role !== 'assistant') continue
    const u = (e.message as AssistantMessage).usage
    if (!u) continue
    s.input += u.input
    s.write += u.cacheWrite
    s.read += u.cacheRead
    s.output += u.output
    if (u.cost?.total) s.costUsd = (s.costUsd ?? 0) + u.cost.total
  }
  return s
}

export default function hairline(pi: ExtensionAPI) {
  let settings = readSettings(undefined)
  let requestRender: (() => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let refresh: ReturnType<typeof setInterval> | null = null

  let folder = ''
  let model = ''
  let sessionId = ''
  let stats: Stats = { input: 0, write: 0, read: 0, output: 0, costUsd: null }
  let saved: Saved = { sessionId: '', turns: 0, activeMs: 0, costStart: null, limitStart: {} }
  let limits: Limit[] = []
  let context: View['context'] = null
  let compactAt: number | null = null
  let phase: Phase = 'idle'
  let tools: Tool[] = []
  let sentAt = 0
  let tps = 0
  let isStreaming = false
  let charsPerToken = 4 // the usual English ratio, until the first response measures it
  let hasNerdFont = false
  type Open = View['open']
  let open: Open = null
  let ui: ExtensionContext | null = null // for notify and the model list, from the last session_start
  let hits: Hit[] = []
  let currentModel: Model<any> | undefined // the session's model, which model_select replaces
  let lastRequestAt: number | null = null
  let lastTurn: { tokens: number; ms: number; usd: number | null } | null = null
  let run: { at: number; tokens: number; usd: number | null } | null = null
  let exchange: { currency: string; rate: number; fetchedOn: string } | null = null
  let exchangeTriedAt = 0
  const slot = newSlot()
  const speed = newSpeed()
  let stream = { firstAt: 0, lastSample: 0, recent: [] as { at: number; chars: number }[], chars: 0 }

  const redraw = () => requestRender?.()

  function save(): void {
    writeStore(s => {
      s.sessions = [saved, ...(s.sessions ?? []).filter(x => x.sessionId !== saved.sessionId)].slice(0, SAVED_MAX)
    })
  }

  function trackLimits(next: Limit[]): void {
    let changed = false
    for (const l of next) {
      const start = saved.limitStart[l.kind]
      const isNewWindow = !!start && (
        l.percentUsed < start.pct ||
        (!!l.resetsAt && !!start.resetsAt && Date.parse(l.resetsAt) - Date.parse(start.resetsAt) > WINDOW_MOVED_MS)
      )
      if (!start || isNewWindow) {
        saved.limitStart[l.kind] = { pct: l.percentUsed, at: Date.now(), resetsAt: l.resetsAt }
        changed = true
      }
    }
    if (changed) save()
  }

  // The tilde marks an amount at the usdRate setting, which is only an estimate of the rate.
  function money(usd: number): string {
    const rate = settings.currency === 'USD' ? 1 : exchange?.currency === settings.currency ? exchange.rate : null
    const amount = new Intl.NumberFormat(undefined, { style: 'currency', currency: settings.currency, maximumFractionDigits: 2 }).format(usd * (rate ?? settings.usdRate))
    return rate === null ? `~${amount}` : amount
  }

  async function readExchange(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    if (settings.currency === 'USD' || (exchange?.currency === settings.currency && exchange.fetchedOn === today)) return
    if (Date.now() - exchangeTriedAt < HOUR_MS) return // a failed fetch waits an hour
    exchangeTriedAt = Date.now()
    try {
      const res = await fetch(RATES_URL + settings.currency, { signal: AbortSignal.timeout(10_000) })
      const rate = ((await res.json()) as { rates?: Record<string, number> }).rates?.[settings.currency]
      if (!res.ok || !rate || rate <= 0) return
      exchange = { currency: settings.currency, rate, fetchedOn: today }
      exchangeTriedAt = 0
      redraw()
    } catch {}
  }

  async function readNerdFont(isFresh = false): Promise<boolean> {
    const cached = isFresh ? undefined : readStore().nerdFont
    const found = typeof cached === 'boolean' ? cached : await findNerdFont()
    if (found !== cached) writeStore(s => { s.nerdFont = found })
    if (found !== hasNerdFont) {
      hasNerdFont = found
      redraw()
    }
    return found
  }

  function readContext(c: ExtensionContext): void {
    context = c.getContextUsage() ?? null
    const compaction = (pi.getSettings() as { compaction?: { enabled?: boolean; reserveTokens?: number; modelOverrides?: Record<string, { reserveTokens?: number }> } }).compaction
    const window = context?.contextWindow ?? c.model?.contextWindow ?? 0
    const reserve = (c.model && compaction?.modelOverrides?.[`${c.model.provider}/${c.model.id}`]?.reserveTokens) ?? compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS
    compactAt = compaction?.enabled !== false && window > reserve ? ((window - reserve) / window) * 100 : null
  }

  function setPhase(next: Phase): void {
    phase = next
    setSlotKind(slot, next, slotTarget(next, tps, tools).text)
    startTimer()
    redraw()
  }

  const isAnimating = () => phase !== 'idle' || isScrambling(slot) || !speed.isSettled

  // One timer drives the spinner, the scramble, the sending time and the dot line, and stops
  // when all four are still.
  function startTimer(): void {
    if (timer || !requestRender) return
    const frameMs = Math.round(1000 / settings.frameRate)
    timer = setInterval(() => {
      tickSlot(slot, slotTarget(phase, tps, tools).text.length)
      tickSpeed(speed, frameMs, isStreaming ? tps : 0, phase === 'sending')
      redraw()
      if (!isAnimating() && timer) {
        clearInterval(timer)
        timer = null
      }
    }, frameMs)
    timer.unref?.()
  }

  function stopTimers(): void {
    if (timer) clearInterval(timer)
    if (refresh) clearInterval(refresh)
    timer = refresh = null
  }

  function install(c: ExtensionContext): void {
    c.ui.setFooter((tui, _theme, footerData) => {
      requestRender = () => tui.requestRender()
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender())
      return {
        dispose() {
          unsubscribe()
          requestRender = null
          stopTimers()
        },
        invalidate() {},
        render(width: number): string[] {
          const target = slotTarget(phase, tps, tools)
          const text = phase === 'sending' ? sendingText(Date.now() - sentAt, target.text.length) : target.text
          const branch = footerData.getGitBranch()
          const models = pickableModels()
          const drawn = drawFooter({
            folder,
            branch: branch === 'detached' ? 'HEAD' : branch,
            model,
            effort: model ? pi.getThinkingLevel() : null,
            sessionId,
            context,
            compactAt,
            stats,
            turns: saved.turns,
            activeMs: saved.activeMs,
            costStart: saved.costStart,
            limits,
            limitStart: saved.limitStart,
            phase,
            tools,
            slot: slotText(slot, text),
            dots: speedDots(speed, isStreaming, phase === 'sending'),
            isLit: isStreaming || phase === 'sending',
            hasNerdFont,
            open,
            models: models.map(m => ({ label: modelLabel(m.id), isCurrent: m.id === model })),
            efforts: supportedEfforts(),
            lastTurn,
            lastRequestAt,
            cacheTtlMinutes: settings.cacheTtlMinutes,
            money,
            statuses: [...footerData.getExtensionStatuses().values()],
            now: Date.now(),
          }, width)
          hits = drawn.hits
          return drawn.lines
        },
        // Fullscreen mode routes the mouse here; regular mode leaves it to the terminal.
        handleMouse(event) {
          if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined
          const hit = hits.find(h => h.row === event.y && event.x >= h.from && event.x < h.to)
          if (!hit) return undefined
          if (event.type === 'click') void act(hit.action)
          return { handled: true }
        },
      }
    })
  }

  function setOpen(next: Open): void {
    open = open === next ? null : next
    redraw()
  }

  // The session's scoped models, as Pi's own picker offers them, or every model with a key.
  function pickableModels(): Model<any>[] {
    if (!ui) return []
    const scoped = ui.scopedModels.map(s => s.model)
    return scoped.length ? scoped : ui.modelRegistry.getAvailable()
  }

  function supportedEfforts(): string[] {
    return currentModel ? getSupportedThinkingLevels(currentModel) : []
  }

  async function copySessionId(c: ExtensionContext): Promise<void> {
    const id = c.sessionManager.getSessionId()
    const isCopied = await copyToClipboard(id).then(() => true, () => false)
    c.ui.notify(isCopied ? `session id copied: ${id}` : `session id: ${id}`, 'info')
  }

  async function act(action: string): Promise<void> {
    if (action === 'tokens' || action === 'model' || action === 'effort') return setOpen(action)
    if (!ui) return
    if (action === 'id') return copySessionId(ui)
    const [kind, value] = action.split(':') as [string, string]
    open = null
    redraw()
    if (kind === 'model') {
      const picked = pickableModels()[Number(value)]
      if (!picked) return
      const isSet = await pi.setModel(picked)
      ui.ui.notify(isSet ? `model ${picked.id}` : `model not changed: ${picked.provider} has no API key`, isSet ? 'info' : 'warning')
    } else if (kind === 'effort') {
      pi.setThinkingLevel(value as Parameters<ExtensionAPI['setThinkingLevel']>[0])
      ui.ui.notify(`thinking ${pi.getThinkingLevel()}`, 'info')
    }
  }

  pi.registerCommand('hairline', {
    description: 'Show or hide the hairline token panel; in fullscreen mode, a click on the token count does too',
    handler: async () => setOpen('tokens'),
  })

  pi.registerCommand('hairline-fonts', {
    description: 'Look for a Nerd Font again, after installing or removing one',
    handler: async (_args, c) => {
      c.ui.notify((await readNerdFont(true)) ? 'Nerd Font found: the line shows its glyphs.' : 'No Nerd Font found: the line shows no glyphs.', 'info')
    },
  })

  pi.registerCommand('hairline-id', {
    description: 'Copy the session ID',
    handler: async (_args, c) => copySessionId(c),
  })

  pi.on('session_start', async (_e, c) => {
    ui = c
    settings = readSettings((pi.getSettings() as Record<string, unknown>).hairline)
    folder = repoFolder(c.cwd)
    model = c.model?.id ?? ''
    currentModel = c.model
    sessionId = c.sessionManager.getSessionId()
    stats = sumUsage(c)
    const store = readStore()
    saved = { turns: 0, activeMs: 0, limitStart: {}, ...store.sessions?.find(s => s.sessionId === sessionId), sessionId, costStart: null }
    saved.costStart = store.sessions?.find(s => s.sessionId === sessionId)?.costStart ?? stats.costUsd
    // Limits belong to the account, so the last ones seen hold until their window resets.
    limits = (store.limits ?? []).filter(l => !l.resetsAt || Date.parse(l.resetsAt) > Date.now())
    readContext(c)
    if (c.mode !== 'tui') return
    install(c)
    void readNerdFont()
    void readExchange()
    refresh = setInterval(() => {
      void readExchange()
      if (open === 'tokens') redraw() // the cache countdown changes with no event
    }, REFRESH_MS)
    refresh.unref?.()
  })

  pi.on('session_shutdown', async () => {
    stopTimers()
    ui = null
  })

  pi.on('model_select', async (e, c) => {
    model = e.model.id
    currentModel = e.model
    readContext(c)
    redraw()
  })

  pi.on('thinking_level_select', async () => redraw())

  pi.on('agent_start', async () => {
    run = { at: Date.now(), tokens: counted(stats), usd: stats.costUsd }
  })

  pi.on('turn_start', async () => {
    tools = []
    sentAt = Date.now()
    setPhase('sending')
  })

  pi.on('after_provider_response', async e => {
    const next = readLimits(e.headers)
    if (!next.length) return
    limits = next
    trackLimits(next)
    writeStore(s => { s.limits = next })
    redraw()
  })

  // Streams carry characters, so the speed divides by the characters per token of the last response.
  pi.on('message_update', async e => {
    const ev = e.assistantMessageEvent
    const piece = ev.type === 'text_delta' || ev.type === 'thinking_delta' || ev.type === 'toolcall_delta' ? ev.delta.length : 0
    if (!piece) return
    const now = Date.now()
    if (!isStreaming) {
      isStreaming = true
      stream = { firstAt: now, lastSample: 0, recent: [], chars: 0 }
      setPhase('receiving')
    }
    stream.chars += piece
    stream.recent.push({ at: now, chars: piece })
    while (stream.recent[0]!.at < now - RATE_WINDOW_MS) stream.recent.shift()
    if (now - stream.firstAt >= RATE_WARMUP_MS && now - stream.lastSample >= 1000 / settings.refreshPerSecond) {
      const windowSecs = Math.min(RATE_WINDOW_MS, now - stream.firstAt) / 1000
      tps = Math.round(stream.recent.reduce((sum, r) => sum + r.chars, 0) / charsPerToken / windowSecs)
      stream.lastSample = now
      redraw()
    }
  })

  pi.on('message_end', async (e, c) => {
    if (e.message.role !== 'assistant') return
    const m = e.message as AssistantMessage
    // Only the finished message has real token counts, so it sets the ratio for the next reply.
    if (m.usage?.output >= RATIO_MIN_TOKENS && stream.chars) {
      charsPerToken = Math.min(RATIO_MAX, Math.max(RATIO_MIN, stream.chars / m.usage.output))
    }
    isStreaming = false
    tps = 0
    stream.chars = 0
    lastRequestAt = Date.now()
    tools = m.content.flatMap(part => (part.type === 'toolCall' ? [{ name: toolName(part.name), arg: toolArg(part.arguments) }] : []))
    stats = sumUsage(c)
    readContext(c)
    setPhase(tools.length ? 'tool' : 'idle')
  })

  pi.on('session_compact', async (_e, c) => {
    readContext(c)
    redraw()
  })

  pi.on('agent_settled', async (_e, c) => {
    isStreaming = false
    tps = 0
    stats = sumUsage(c)
    readContext(c)
    if (run) {
      const ms = Date.now() - run.at
      lastTurn = { tokens: counted(stats) - run.tokens, ms, usd: stats.costUsd !== null ? stats.costUsd - (run.usd ?? 0) : null }
      saved.turns += 1
      saved.activeMs += ms
      saved.costStart ??= run.usd ?? 0
      run = null
      save()
    }
    tools = []
    setPhase('idle')
  })

}
