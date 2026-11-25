"""Drives a real Claude Code session with the hairline mod, then checks what the line shows before and
after one turn: the context bar, the workspace, the token total and the model.

A fake model (scripts/e2e_kit.py) gives the reply, so no API key is needed. Run from the repo root:
    uv run --no-project --with pyte --with pywinpty python -I scripts/e2e.py      (Windows)
    uv run --no-project --with pyte --with ptyprocess python -I scripts/e2e.py    (Linux, macOS)
Each screen is saved as text in scripts/e2e-out/. Exit code 0 means every check passed.
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder off the path
from e2e_kit import Terminal, base_env, scratch, start_model
from e2e_line import check_line

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS, COLS = 40, 140
# modelLabel drops `claude-` and joins the rest with a space: the line shows "fake model".
MODEL = "claude-fake-model"

sys.stdout.reconfigure(encoding="utf-8")  # screen lines hold ━, which the Windows console code page lacks
model = start_model({"HAIRLINE_E2E_REPLY": "The fake model answers in one line."}, "model-claude.log")

# A fresh config folder: no onboarding, the folder trusted, the fake key accepted.
config = scratch("claude")
KEY = "sk-ant-e2e-fake-key-0000000000000000"
with open(os.path.join(config, ".claude.json"), "w", encoding="utf-8") as f:
    json.dump({"hasCompletedOnboarding": True, "theme": "dark", "customApiKeyResponses": {"approved": [KEY[-20:]], "rejected": []},
               "projects": {PLUGIN.replace("\\", "/"): {"hasTrustDialogAccepted": True}, PLUGIN: {"hasTrustDialogAccepted": True}}}, f)
env = base_env()
env.update(CLAUDE_CONFIG_DIR=config, ANTHROPIC_BASE_URL=model, ANTHROPIC_API_KEY=KEY, ANTHROPIC_MODEL=MODEL,
           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1")

term = Terminal(["claude", "--plugin-dir", PLUGIN], PLUGIN, env, ROWS, COLS)
checks = {}

try:
    if not term.wait(lambda t: "❯" in t, 60, "start"):
        sys.exit(1)
    time.sleep(3)
    # Answer any first-run question the config did not settle: trust, the key, the theme.
    for _ in range(3):
        low = term.text().lower()
        if "trust" in low or "api key" in low or "theme" in low:
            term.write("\r")
            time.sleep(2)
    check_line(term, checks, "fake model", "1-idle")
    term.send("HAIRLINE_E2E_REPLY")
    time.sleep(0.5)
    term.write("\r")
    checks["the reply arrives"] = term.wait(lambda t: "answers in one line" in t, 60, "reply")
    check_line(term, checks, "fake model", "2-after", after=True)
finally:
    term.stop()

for name, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + name)
sys.exit(0 if checks and all(checks.values()) else 3)
