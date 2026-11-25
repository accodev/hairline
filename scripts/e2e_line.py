"""The checks scripts/e2e.py and scripts/pi-e2e.py run on hairline's two rows, so both agents pass
the same asserts. They find the rows by content and leave widths and paddings free."""
import re, time

# The workspace shows the main repo's folder, also in a worktree, and CI checks out into hairline/.
WORKSPACE = "hairline"
BAR_CELLS = "━─"
TOTAL = re.compile(r"(\d[\d.,]*[kKMB]?) tok\b")


def rows(term):
    """The context bar and the row under it: the last row that holds the token total, and the one above."""
    lines = term.text().split("\n")
    at = next((i for i in range(len(lines) - 1, 0, -1) if " tok" in lines[i]), None)
    return (lines[at - 1], lines[at]) if at else (None, None)


def check_line(term, checks, model, label, after=False):
    """Idle: the bar, the workspace, `--- tok` and the model. After a turn: a percent on the bar and a
    token count in place of the dashes."""
    # The workspace reads git after the first draw, so the row can show the dashes before it.
    total = (lambda r: TOTAL.search(r)) if after else (lambda r: "--- tok" in r)
    want = lambda r: total(r) and r.lstrip().startswith(WORKSPACE)
    term.wait(lambda t: (lambda b, r: r is not None and bool(want(r)))(*rows(term)), 30, label)
    time.sleep(1)
    term.dump(label)
    bar, row = rows(term)
    bar, row = bar or "", row or ""
    when = "after a turn" if after else "idle"
    checks[f"{when}: context bar"] = sum(bar.count(c) for c in BAR_CELLS) >= term.cols // 2
    checks[f"{when}: workspace under the bar"] = row.lstrip().startswith(WORKSPACE)
    checks[f"{when}: model"] = model in row
    if after:
        checks[f"{when}: percent on the bar"] = re.search(r" \d+% ", bar) is not None
        checks[f"{when}: token total"] = "--- tok" not in row and TOTAL.search(row) is not None
    else:
        checks[f"{when}: --- tok"] = "--- tok" in row
    return row
