// Drives a real Pi session with only the hairline extension, then checks what the footer shows before
// and after one turn: the context bar, the workspace, the token total and the model.
// A fake model (kit.ts) gives the reply through a custom provider, so no API key is needed. Run from the
// repo root after `npm ci` with `npm run e2e:pi`. Each screen is saved as text in tests/e2e/out/.
// Exit code 0 means every check passed.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseEnv, report, ROOT, scratch, sleep, startModel, Terminal } from './kit.ts'
import { checkLine } from './line.ts'

const ROWS = 40, COLS = 140

const model = await startModel({ HAIRLINE_E2E_REPLY: 'The fake model answers in one line.' }, 'model-pi.log')

// A fresh agent folder: the fake model as the only provider.
const agent = scratch('pi')
writeFileSync(join(agent, 'models.json'), JSON.stringify({
  providers: { fake: { baseUrl: model, api: 'anthropic-messages', apiKey: 'fake', models: [{ id: 'fake-model' }] } },
}))
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model', tuiMode: 'fullscreen' }))
const env = { ...baseEnv(), PI_CODING_AGENT_DIR: agent }

// -ns and -nc: the user's own skills and AGENTS.md files stay out of the run and its screens.
const term = new Terminal(['pi', '-ne', '-ns', '-nc', '-e', join(ROOT, 'pi', 'index.ts'), '--no-session'], ROOT, env, ROWS, COLS, 'pi-')
const checks: Record<string, boolean> = {}

try {
  await sleep(8000)
  // modelLabel turns `fake-model` into "fake model", as in claude.spec.ts.
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
