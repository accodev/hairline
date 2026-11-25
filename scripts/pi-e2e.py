"""Drives a real Pi session with only the hairline extension, then checks what the footer shows before
and after one turn: the context bar, the workspace, the token total and the model.

A fake model (scripts/e2e_kit.py) gives the reply through a custom provider, so no API key is needed.
Run from the repo root after `npm ci`:
    uv run --no-project --with pyte --with pywinpty python -I scripts/pi-e2e.py      (Windows)
    uv run --no-project --with pyte --with ptyprocess python -I scripts/pi-e2e.py    (Linux, macOS)
Each screen is saved as text in scripts/e2e-out/. Exit code 0 means every check passed.
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder off the path
from e2e_kit import Terminal, base_env, scratch, start_model
from e2e_line import check_line

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS, COLS = 40, 140

sys.stdout.reconfigure(encoding="utf-8")
model = start_model({"HAIRLINE_E2E_REPLY": "The fake model answers in one line."}, "model-pi.log")

# A fresh agent folder: the fake model as the only provider.
agent = scratch("pi")
with open(os.path.join(agent, "models.json"), "w", encoding="utf-8") as f:
    json.dump({"providers": {"fake": {"baseUrl": model, "api": "anthropic-messages", "apiKey": "fake",
                                      "models": [{"id": "fake-model"}]}}}, f)
with open(os.path.join(agent, "settings.json"), "w", encoding="utf-8") as f:
    json.dump({"defaultProvider": "fake", "defaultModel": "fake-model", "tuiMode": "fullscreen"}, f)
env = base_env()
env["PI_CODING_AGENT_DIR"] = agent
# -ns and -nc: the user's own skills and AGENTS.md files stay out of the run and its screens.
term = Terminal(["pi", "-ne", "-ns", "-nc", "-e", os.path.join(PLUGIN, "pi", "index.ts"), "--no-session"], PLUGIN, env, ROWS, COLS, prefix="pi-")
checks = {}

try:
    time.sleep(8)
    # modelLabel turns `fake-model` into "fake model", as in scripts/e2e.py.
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
