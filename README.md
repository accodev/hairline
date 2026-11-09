# hairline

![hairline](https://raw.githubusercontent.com/accodev/hairline/screenshots/line.png)

Hairline is a Claude Code mod and a [Pi](https://pi.dev) extension that adds one status line under the prompt. The line shows folder and branch, a context bar with an auto-compact mark, output tokens per second (between replies: idle; the seconds since the request went out, with a sweep; or the running tool and its argument), session tokens, and 5h and 7d limits. Click the token count for cost, cache use, subagent share and how fast each limit fills. Click the model or effort to pick another, and click the session ID to copy it. Hairline takes its colors from your terminal's own palette. Hairline is tested on Claude Code 2.1.312 in the terminal. In the Claude desktop app it draws in the band above the prompt, without the folder, branch, model and effort that the app shows already. The idle mark is a white circle everywhere. In the terminal the tool glyph comes from a Nerd Font when one is installed; without one, its place stays blank. Hairline looks for one only once and keeps the answer. After you install or remove a Nerd Font, run `/hairline-fonts` to look again. The desktop app shows an emoji for it.

![Streaming](https://raw.githubusercontent.com/accodev/hairline/screenshots/streaming.png)

![Token panel](https://raw.githubusercontent.com/accodev/hairline/screenshots/token-panel.png)

![Effort picker](https://raw.githubusercontent.com/accodev/hairline/screenshots/effort-picker.png)

## Install

```sh
claude plugin marketplace add accodev/hairline
claude plugin install hairline@hairline
```

Run `/reload-plugins` in an open session to load it.

## Pi

```sh
pi install git:github.com/accodev/hairline
```

Run `/reload` in an open session to load it. In Pi, hairline replaces the footer and keeps other extensions' status texts on a line below it. Pi has no clickable controls, so commands stand in for the clicks:

| Command | Effect |
|---|---|
| `/hairline` | Shows or hides the token panel. |
| `/hairline-id` | Copies the session ID. |
| `/hairline-fonts` | Looks for a Nerd Font again. |

Pi's own controls pick the model (`/model`, `Ctrl+P`) and the thinking level (`Shift+Tab`), which the line shows in place of effort. The 5h and 7d limits come from the headers of Anthropic subscription responses, so other providers show none. The context bar marks where `compaction.reserveTokens` starts auto-compaction. The token panel has no subagent share, because Pi subagents run as separate sessions. Hairline keeps the font answer, the last limits and each session's turn time in `~/.pi/agent/hairline.json`. Pi's `settings.json` takes the options below under a `hairline` key, for example `"hairline": { "currency": "USD" }`.

## Settings

Claude Code keeps them in `settings.json`, under `pluginConfigs["hairline@hairline"].options`.

| Option | Default | Effect |
|---|---|---|
| `currency` | `EUR` | `USD`, `CAD`, `AUD`, `EUR`, `JPY` or `CNY`. |
| `usdRate` | `0.9` | Value of 1 US dollar in that currency, used when the exchange rate cannot be fetched. |
| `cacheTtlMinutes` | `60` | Prompt cache lifetime, 60 or 5 as your plan uses. |
| `speedRefreshPerSecond` | `30` | Updates of the tokens per second figure, 1 to 30. |
| `animationFps` | `30` | Frames per second of the speed dot line, 1 to 60. |

## Development

```sh
claude plugin validate .
claude plugin test .
```

```sh
npm ci
npm run typecheck:pi
npm run test:pi
```

Those check the Pi extension in `pi/`. CI runs all five commands on every push to `main` and on pull requests. On `main` it also renders the README images from `tests/screenshots.test.ts` and pushes them to the `screenshots` branch.

```sh
node scripts/screenshots.mjs out
```

That renders them locally, with Chrome or Edge.
