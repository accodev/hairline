# hairline

![hairline](https://raw.githubusercontent.com/accodev/hairline/screenshots/line.png)

Hairline is a Claude Code mod that adds one status line under the prompt. The line shows folder and branch, a context bar with an auto-compact mark, output tokens per second, session tokens, and 5h and 7d limits. Click the token count for cost, cache use, subagent share and how fast each limit fills. Click the model or effort to pick another, and click the session ID to copy it. Hairline takes its colors from your terminal's own palette. Hairline needs Claude Code mods (early access) and is tested on Claude Code 2.1.312 in the terminal. The Claude desktop app is not supported: its Code tab does not draw the `PromptHint` line.

![Token panel](https://raw.githubusercontent.com/accodev/hairline/screenshots/token-panel.png)

![Effort picker](https://raw.githubusercontent.com/accodev/hairline/screenshots/effort-picker.png)

## Install

```sh
claude plugin marketplace add accodev/hairline
claude plugin install hairline@hairline
```

Run `/reload-plugins` in an open session to load it.

## Settings

Claude Code keeps them in `settings.json`, under `pluginConfigs["hairline@hairline"].options`.

| Option | Default | Effect |
|---|---|---|
| `currency` | `EUR` | `USD`, `CAD`, `AUD`, `EUR`, `JPY` or `CNY`. |
| `usdRate` | `0.9` | Value of 1 US dollar in that currency, used when the exchange rate cannot be fetched. |
| `cacheTtlMinutes` | `60` | Prompt cache lifetime, 60 or 5 as your plan uses. |
| `speedRefreshPerSecond` | `30` | Updates of the tokens per second figure, 1 to 30. |
| `animationFps` | `30` | Frames per second of the speed dot line, 1 to 60. |
| `nerdFont` | `false` | Nerd Font pause sign for the idle phase. Off uses `‖`. |

## Development

```sh
claude plugin validate .
claude plugin test .
```

CI runs both commands on every push to `main` and on pull requests. On `main` it also renders the README images from `tests/screenshots.test.ts` and pushes them to the `screenshots` branch.

```sh
node scripts/screenshots.mjs out
```

That renders them locally, with Chrome or Edge.
