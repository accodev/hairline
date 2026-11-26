// What claude.spec.ts and pi.spec.ts share: a fake model, a pseudo-terminal, and the screen.
// The fake model answers the Anthropic Messages API with fixed replies, so a run needs no API key,
// costs nothing, and draws the same reply every time. Claude Code reaches it through ANTHROPIC_BASE_URL,
// Pi through a custom provider in models.json.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from '@lydell/node-pty'
import xterm from '@xterm/headless'

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const OUT = join(ROOT, 'tests', 'e2e', 'out')

export const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

type Block = { type?: string, text?: string }
type Message = { role?: string, content?: string | Block[] }
type Request = { model?: string, stream?: boolean, messages?: Message[] }

const textOf = (m: Message): string =>
  typeof m.content === 'string' ? m.content
    : (m.content ?? []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n')

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

// Serves POST /v1/messages on 127.0.0.1. `replies` maps a word in the last user message to the reply
// text; any other request (a title, a summary) gets "ok". Resolves to the base URL.
export function startModel(replies: Record<string, string>, logName: string): Promise<string> {
  mkdirSync(OUT, { recursive: true })
  const log: string[] = []
  const flush = () => writeFileSync(join(OUT, logName), log.join(''))
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST') {
      log.push(`${req.method} ${req.url}\n`); flush()
      if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
      return json(res, 200, {})
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const body: Request = raw ? JSON.parse(raw) : {}
    log.push(`POST ${path} stream=${body.stream}\n`); flush()
    if (path.endsWith('/count_tokens')) return json(res, 200, { input_tokens: 12 })
    if (!path.endsWith('/messages')) return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: path } })
    const users = (body.messages ?? []).filter(m => m.role === 'user')
    const last = users.length ? textOf(users[users.length - 1]) : ''
    const text = Object.entries(replies).find(([word]) => last.includes(word))?.[1] ?? 'ok'
    const model = body.model ?? 'fake'
    const usage = { input_tokens: 12, output_tokens: Math.max(1, Math.floor(text.length / 4)) }
    if (!body.stream) {
      return json(res, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null, usage })
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const event = (kind: string, data: unknown) => res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`)
    event('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } })
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (let i = 0; i < text.length; i += 200) {
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 200) } })
    }
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
    event('message_stop', { type: 'message_stop' })
    res.end()
  })
  return new Promise(done => server.listen(0, '127.0.0.1', () => {
    server.unref()
    const address = server.address()
    done(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
  }))
}

// ConPTY needs a full path: on Windows `claude` and `pi` are .cmd shims that a bare name misses.
function which(name: string, path: string | undefined): string {
  if (process.platform !== 'win32') return name
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
  for (const dir of (path ?? '').split(delimiter)) {
    for (const ext of ['', ...exts]) {
      const file = join(dir, name + ext)
      if (ext && existsSync(file)) return file
    }
  }
  return name
}

// A program in a pseudo-terminal, read into an xterm screen. `raw` keeps the bytes for the escapes
// the screen does not expose: OSC 8 hyperlinks and OSC 52 clipboard writes.
export class Terminal {
  readonly rows: number
  readonly cols: number
  private readonly prefix: string
  private readonly screen: xterm.Terminal
  private readonly proc: pty.IPty
  private raw = ''
  private alive = true

  constructor(argv: string[], cwd: string, env: Record<string, string>, rows: number, cols: number, prefix = '') {
    mkdirSync(OUT, { recursive: true })
    this.rows = rows
    this.cols = cols
    this.prefix = prefix
    this.screen = new xterm.Terminal({ cols, rows, allowProposedApi: true })
    this.proc = pty.spawn(which(argv[0], env.PATH ?? env.Path), argv.slice(1), { name: 'xterm-256color', cols, rows, cwd, env })
    this.proc.onData(data => { this.raw += data; this.screen.write(data) })
    this.proc.onExit(() => { this.alive = false })
  }

  write(s: string): void { this.proc.write(s) }

  async send(s: string, gap = 20): Promise<void> {
    for (const ch of s) { this.proc.write(ch); await sleep(gap) }
  }

  text(): string {
    const buffer = this.screen.buffer.active
    const lines: string[] = []
    for (let y = 0; y < this.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  dump(name: string): void { writeFileSync(join(OUT, this.prefix + name + '.txt'), this.text()) }

  async wait(pred: (text: string) => boolean, seconds: number, label: string): Promise<boolean> {
    const end = Date.now() + seconds * 1000
    while (Date.now() < end) {
      if (pred(this.text())) { this.dump(label); return true }
      await sleep(500)
    }
    this.dump('fail-' + label)
    console.log('TIMEOUT', label)
    return false
  }

  find(s: string): [number, number] | null {
    const lines = this.text().split('\n')
    for (let y = 0; y < lines.length; y++) {
      const x = lines[y].indexOf(s)
      if (x >= 0) return [x + 1, y + 1]
    }
    return null
  }

  // OSC 8 may carry an id before the second `;`.
  links(): Set<string> {
    return new Set([...this.raw.matchAll(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)/g)].map(m => m[1]))
  }

  async stop(): Promise<void> {
    for (let i = 0; i < 2 && this.alive; i++) { this.proc.write('\x03'); await sleep(500) }
    if (this.alive) this.proc.kill()
  }
}

// A fresh folder for one run's agent config, so every run starts the same way.
export const scratch = (name: string): string => mkdtempSync(join(tmpdir(), `hairline-${name}-`))

export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // A run started from inside Claude Code inherits its session markers, which turn transcripts off.
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT']) delete env[name]
  env.TERM = 'xterm-256color'
  return env
}

export function report(checks: Record<string, boolean>): never {
  for (const [name, ok] of Object.entries(checks)) console.log((ok ? 'PASS ' : 'FAIL ') + name)
  const passed = Object.values(checks).filter(Boolean).length
  console.log(`${passed} of ${Object.keys(checks).length} passed`)
  process.exit(passed && passed === Object.keys(checks).length ? 0 : 3)
}
