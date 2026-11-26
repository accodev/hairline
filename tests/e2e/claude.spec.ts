// Drives a real Claude Code session with the hairline mod, then checks what the line shows before and
// after one turn: the context bar, the workspace, the token total and the model.
// A fake model (kit.ts) gives the reply, so no API key is needed. Run from the repo root with
// `npm run e2e:claude`. Each screen is saved as text in tests/e2e/out/. Exit code 0 means every check passed.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseEnv, report, ROOT, scratch, sleep, startModel, Terminal } from './kit.ts'
import { checkLine } from './line.ts'

const ROWS = 40, COLS = 140
// modelLabel drops `claude-` and joins the rest with a space: the line shows "fake model".
const MODEL = 'claude-fake-model'
const KEY = 'sk-ant-e2e-fake-key-0000000000000000'

const model = await startModel({ HAIRLINE_E2E_REPLY: 'The fake model answers in one line.' }, 'model-claude.log')

// A fresh config folder: no onboarding, the folder trusted, the fake key accepted.
const config = scratch('claude')
writeFileSync(join(config, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
  projects: { [ROOT.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true }, [ROOT]: { hasTrustDialogAccepted: true } },
}))
const env = {
  ...baseEnv(), CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: model, ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: MODEL,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
}

const term = new Terminal(['claude', '--plugin-dir', ROOT], ROOT, env, ROWS, COLS)
const checks: Record<string, boolean> = {}

try {
  if (!await term.wait(t => t.includes('❯'), 60, 'start')) process.exit(1)
  await sleep(3000)
  // Answer any first-run question the config did not settle: trust, the key, the theme.
  for (let i = 0; i < 3; i++) {
    const low = term.text().toLowerCase()
    if (low.includes('trust') || low.includes('api key') || low.includes('theme')) {
      term.write('\r')
      await sleep(2000)
    }
  }
  await checkLine(term, checks, 'fake model', '1-idle')
  await term.send('HAIRLINE_E2E_REPLY')
  await sleep(500)
  term.write('\r')
  checks['the reply arrives'] = await term.wait(t => t.includes('answers in one line'), 60, 'reply')
  await checkLine(term, checks, 'fake model', '2-after', true)
} finally {
  await term.stop()
}

report(checks)
