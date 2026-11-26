// The checks claude.spec.ts and pi.spec.ts run on hairline's two rows, so both agents pass the same
// asserts. They find the rows by content and leave widths and paddings free.
import { sleep, type Terminal } from './kit.ts'

// The workspace shows the main repo's folder, also in a worktree, and CI checks out into hairline/.
const WORKSPACE = 'hairline'
const BAR_CELLS = ['━', '─']
const TOTAL = /(\d[\d.,]*[kKMB]?) tok\b/

// The context bar and the row under it: the last row that holds the token total, and the one above.
function rows(term: Terminal): [string | null, string | null] {
  const lines = term.text().split('\n')
  for (let i = lines.length - 1; i > 0; i--) if (lines[i].includes(' tok')) return [lines[i - 1], lines[i]]
  return [null, null]
}

const count = (s: string, c: string): number => s.split(c).length - 1

// Idle: the bar, the workspace, `--- tok` and the model. After a turn: a percent on the bar and a
// token count in place of the dashes.
export async function checkLine(term: Terminal, checks: Record<string, boolean>, model: string, label: string, after = false): Promise<string> {
  // The workspace reads git after the first draw, so the row can show the dashes before it.
  const total = (r: string) => after ? TOTAL.test(r) : r.includes('--- tok')
  const want = (r: string) => total(r) && r.trimStart().startsWith(WORKSPACE)
  await term.wait(() => { const row = rows(term)[1]; return row !== null && want(row) }, 30, label)
  await sleep(1000)
  term.dump(label)
  const [b, r] = rows(term)
  const bar = b ?? '', row = r ?? ''
  const when = after ? 'after a turn' : 'idle'
  checks[`${when}: context bar`] = BAR_CELLS.reduce((n, c) => n + count(bar, c), 0) >= Math.floor(term.cols / 2)
  checks[`${when}: workspace under the bar`] = row.trimStart().startsWith(WORKSPACE)
  checks[`${when}: model`] = row.includes(model)
  if (after) {
    checks[`${when}: percent on the bar`] = / \d+% /.test(bar)
    checks[`${when}: token total`] = !row.includes('--- tok') && TOTAL.test(row)
  } else {
    checks[`${when}: --- tok`] = row.includes('--- tok')
  }
  return row
}
