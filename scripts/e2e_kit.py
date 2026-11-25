"""What scripts/e2e.py and scripts/pi-e2e.py share: a fake model, a pseudo-terminal, and the screen.

The fake model answers the Anthropic Messages API with fixed replies, so a run needs no API key,
costs nothing, and draws the same reply every time. Claude Code reaches it through ANTHROPIC_BASE_URL,
Pi through a custom provider in models.json.
"""
import json, os, re, shutil, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pyte

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "e2e-out")


# ---------- The fake model ----------

def _text_of(message):
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    return "\n".join(block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text")


def start_model(replies, log_name):
    """Serves POST /v1/messages on 127.0.0.1. `replies` maps a word in the last user message to the
    reply text; any other request (a title, a summary) gets "ok". Returns the base URL."""
    os.makedirs(OUT, exist_ok=True)
    log = open(os.path.join(OUT, log_name), "w", encoding="utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _json(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            log.write(f"GET {self.path}\n")
            log.flush()
            self._json(200, {})

        def do_HEAD(self):
            self.send_response(200)
            self.end_headers()

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            path = self.path.split("?")[0]
            log.write(f"POST {path} stream={body.get('stream')}\n")
            log.flush()
            if path.endswith("/count_tokens"):
                return self._json(200, {"input_tokens": 12})
            if not path.endswith("/messages"):
                return self._json(404, {"type": "error", "error": {"type": "not_found_error", "message": path}})
            users = [m for m in body.get("messages", []) if m.get("role") == "user"]
            last = _text_of(users[-1]) if users else ""
            text = next((reply for word, reply in replies.items() if word in last), "ok")
            model = body.get("model", "fake")
            usage = {"input_tokens": 12, "output_tokens": max(1, len(text) // 4)}
            if not body.get("stream"):
                return self._json(200, {"id": "msg_fake", "type": "message", "role": "assistant", "model": model,
                                        "content": [{"type": "text", "text": text}], "stop_reason": "end_turn",
                                        "stop_sequence": None, "usage": usage})
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()

            def event(kind, data):
                self.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()

            event("message_start", {"type": "message_start", "message": {
                "id": "msg_fake", "type": "message", "role": "assistant", "model": model, "content": [],
                "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 12, "output_tokens": 1}}})
            event("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
            for i in range(0, len(text), 200):
                event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text[i:i + 200]}})
            event("content_block_stop", {"type": "content_block_stop", "index": 0})
            event("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": usage["output_tokens"]}})
            event("message_stop", {"type": "message_stop"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


# ---------- The terminal ----------

if sys.platform == "win32":
    from winpty import PtyProcess as _Pty
else:
    from ptyprocess import PtyProcessUnicode as _Pty


class Terminal:
    """A program in a pseudo-terminal, read into a pyte screen. `raw` keeps the bytes for what pyte
    drops: OSC 8 hyperlinks and OSC 52 clipboard writes."""

    def __init__(self, argv, cwd, env, rows, cols, prefix=""):
        os.makedirs(OUT, exist_ok=True)
        self.rows, self.cols, self.prefix = rows, cols, prefix
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.lock = threading.Lock()
        self.raw = bytearray()
        # winpty needs a full path: on Windows `claude` and `pi` are .cmd shims that a bare name misses.
        argv = [shutil.which(argv[0], path=env.get("PATH")) or argv[0], *argv[1:]]
        self.proc = _Pty.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols))
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while self.proc.isalive():
            try:
                data = self.proc.read(65536)
            except EOFError:
                break
            b = data.encode("utf-8", "surrogatepass") if isinstance(data, str) else data
            with self.lock:
                self.raw.extend(b)
                self.stream.feed(b)

    def write(self, s):
        self.proc.write(s)

    def send(self, s, gap=0.02):
        for ch in s:
            self.proc.write(ch)
            time.sleep(gap)

    def text(self):
        with self.lock:
            return "\n".join(self.screen.display)

    def dump(self, name):
        with open(os.path.join(OUT, self.prefix + name + ".txt"), "w", encoding="utf-8") as f:
            f.write(self.text())

    def wait(self, pred, timeout, label):
        end = time.time() + timeout
        while time.time() < end:
            if pred(self.text()):
                self.dump(label)
                return True
            time.sleep(0.5)
        self.dump("fail-" + label)
        print("TIMEOUT", label)
        return False

    def find(self, s):
        for y, line in enumerate(self.text().split("\n")):
            x = line.find(s)
            if x >= 0:
                return x + 1, y + 1
        return None

    def links(self):
        """The targets of every OSC 8 hyperlink the program drew; OSC 8 may carry an id before the second `;`."""
        with self.lock:
            return set(m.decode("utf-8", "replace") for m in re.findall(rb"\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)", bytes(self.raw)))

    def stop(self):
        for _ in range(2):
            try:
                self.proc.write("\x03")
            except OSError:
                break
            time.sleep(0.5)
        try:
            if self.proc.isalive():
                self.proc.terminate(force=True)
        except OSError:
            pass


def scratch(name):
    """A fresh folder for one run's agent config, so every run starts the same way."""
    return tempfile.mkdtemp(prefix=f"hairline-{name}-")


def base_env():
    env = dict(os.environ)
    # pyte keeps 256 colors and drops 24-bit ones: with COLORTERM=truecolor every color reads "default".
    env.pop("COLORTERM", None)
    # A run started from inside Claude Code inherits its session markers, which turn transcripts off.
    for name in ("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"):
        env.pop(name, None)
    env["FORCE_COLOR"] = "2"
    env["TERM"] = "xterm-256color"
    return env
