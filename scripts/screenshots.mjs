// Renders the scenes that tests/screenshots.test.ts prints into PNGs under the given directory.
// The test kit returns element trees without painting them, so this lays the trees out as
// terminal cells and lets a headless Chromium take the picture.
//
//   node scripts/screenshots.mjs <out-dir>
//
// CHROME names the browser; otherwise google-chrome, chromium, or Edge on Windows.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Everblush, the scheme the README images have used since the first capture.
const PALETTE = [
  '#232A2D', '#E57474', '#8CCF7E', '#E5C76B', '#67B0E8', '#C47FD5', '#6CBFBF', '#B3B9B8',
  '#2D3437', '#EF7E7E', '#96D988', '#F4D67A', '#71BAF2', '#CE89DF', '#67CBE7', '#BDC3C2',
]
const FG = '#DADADA'
const BG = '#141B1E'
const RULE = '#888888'
const DIM = '#999999' // Claude Code paints dim text this gray, whatever its color
const CELL_W = 8 // Maple Mono at 10 pt, as in Windows Terminal
const CELL_H = 18
const PAD_X = 16
const PAD_Y = 14

const outDir = resolve(process.argv[2] ?? 'screenshots')

function color(value) {
  const slot = /^ansi256\((\d+)\)$/.exec(value ?? '')
  return slot ? PALETTE[Number(slot[1])] : value
}

const blank = style => ({ ch: ' ', ...style })
const widthOf = lines => Math.max(0, ...lines.map(line => line.length))

function textCells(node, style) {
  if (typeof node === 'string') return [...node].map(ch => ({ ch, ...style }))
  const p = node.props ?? {}
  const next = {
    ...style,
    ...(p.color !== undefined && { fg: color(p.color) }),
    ...(p.backgroundColor !== undefined && { bg: color(p.backgroundColor) }),
    ...(p.dimColor !== undefined && { dim: p.dimColor }),
    ...(p.bold !== undefined && { bold: p.bold }),
    ...(p.inverse !== undefined && { inverse: p.inverse }),
    ...(p.underline !== undefined && { underline: p.underline }),
  }
  return (node.children ?? []).flatMap(child => textCells(child, next))
}

// Flexbox reduced to what the hint line uses: rows, columns, padding, a full-width row that
// spreads or right-aligns its children.
function lay(node, width) {
  if (typeof node === 'string' || node.type === 'Text') return [textCells(node, {})]
  const p = node.props ?? {}
  const padLeft = p.paddingLeft ?? 0
  const padRight = p.paddingRight ?? 0
  const inner = (typeof p.width === 'number' ? p.width : width) - padLeft - padRight
  const kids = (node.children ?? []).map(child => lay(child, inner))
  let lines
  if (p.flexDirection === 'column') {
    lines = kids.flat()
  } else {
    const widths = kids.map(widthOf)
    const height = Math.max(1, ...kids.map(k => k.length))
    const free = Math.max(0, inner - widths.reduce((a, b) => a + b, 0))
    const isFull = p.width === '100%'
    const lead = isFull && p.justifyContent === 'flex-end' ? free : 0
    const gap = isFull && p.justifyContent === 'space-between' && kids.length > 1 ? free / (kids.length - 1) : 0
    lines = Array.from({ length: height }, (_, row) => {
      const cells = Array.from({ length: lead }, () => blank({}))
      kids.forEach((kid, i) => {
        const line = kid[row] ?? []
        cells.push(...line, ...Array.from({ length: widths[i] - line.length }, () => blank({})))
        if (i < kids.length - 1) cells.push(...Array.from({ length: Math.floor(gap * (i + 1)) - Math.floor(gap * i) }, () => blank({})))
      })
      return cells
    })
  }
  if (p.width === '100%' || typeof p.width === 'number') lines = lines.map(line => line.slice(0, inner))
  const pad = n => Array.from({ length: n }, () => blank({}))
  return lines.map(line => [...pad(padLeft), ...line])
}

function escape(ch) {
  return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch
}

function cellHtml(cell) {
  let fg = cell.dim ? DIM : cell.fg ?? FG
  let bg = cell.bg ?? 'transparent'
  if (cell.inverse) [fg, bg] = [cell.bg ?? BG, cell.fg ?? FG]
  const style = [
    `color:${fg}`,
    bg !== 'transparent' && `background:${bg}`,
    cell.bold && 'font-weight:700',
    cell.underline && 'text-decoration:underline',
  ].filter(Boolean).join(';')
  return `<span style="${style}">${escape(cell.ch)}</span>`
}

// Claude Code's prompt box sits above the hint, so the line is shown where people see it.
function page(scene) {
  const rule = [[...'─'.repeat(scene.columns)].map(ch => ({ ch, fg: RULE }))]
  const prompt = [[{ ch: '❯', fg: DIM }, blank({}), { ch: ' ', bg: FG }]]
  const lines = [...rule, ...prompt, ...rule, [], ...lay(scene.tree, scene.columns)]
  const body = lines.map(line => `<div class="r">${line.map(cellHtml).join('')}</div>`).join('')
  const size = { width: scene.columns * CELL_W + 2 * PAD_X, height: lines.length * CELL_H + 2 * PAD_Y }
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${BG}}
body{padding:${PAD_Y}px ${PAD_X}px;font:13.33px/${CELL_H}px 'Maple Mono NF','Maple Mono','DejaVu Sans Mono',monospace}
.r{height:${CELL_H}px;white-space:pre}
.r span{display:inline-block;width:${CELL_W}px;text-align:center;overflow:visible}
</style>${body}`
  return { html, size }
}

function chrome() {
  const candidates = [
    process.env.CHROME,
    'google-chrome',
    'chromium',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  // Edge on Windows opens a window for --version, so a full path is only checked for existence.
  const found = candidates.find(c => existsSync(c) || (!/[\\/]/.test(c) && spawnSync(c, ['--version'], { timeout: 5_000 }).status === 0))
  if (!found) throw new Error('no Chromium found: set CHROME')
  return found
}

const output = spawnSync('claude', ['plugin', 'test', '.'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 })
if (output.status !== 0) throw new Error(`claude plugin test failed:\n${output.stdout}${output.stderr}`)
const scenes = (output.stdout + output.stderr).split(/\r?\n/).filter(line => line.startsWith('SCENE ')).map(line => JSON.parse(line.slice(6)))
if (!scenes.length) throw new Error('no SCENE lines: is tests/screenshots.test.ts present?')

mkdirSync(outDir, { recursive: true })
const work = join(tmpdir(), `hairline-shots-${process.pid}`)
mkdirSync(work, { recursive: true })
const browser = chrome()
for (const scene of scenes) {
  const { html, size } = page(scene)
  const file = join(work, `${scene.name}.html`)
  writeFileSync(file, html)
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--user-data-dir=${join(work, 'profile')}`,
    `--window-size=${size.width},${size.height}`,
    `--screenshot=${join(outDir, `${scene.name}.png`)}`,
    `file://${file.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' })
  console.log(`${scene.name}.png ${size.width * 2}x${size.height * 2}`)
}
rmSync(work, { recursive: true, force: true })
