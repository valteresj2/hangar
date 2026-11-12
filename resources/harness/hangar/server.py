"""Live dashboard. The server only tails the JSONL session logs, so it shows any run from any
process (CLI, benchmark, another terminal) with zero coupling to the agent itself.
Bound to 127.0.0.1; state-changing endpoints require a custom header so web pages cannot call them."""
from __future__ import annotations

import json
import subprocess
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import config
from .models import Catalog
from .session import SESSIONS

UI = Path(__file__).with_name("ui.html")


def _safe_id(sid: str) -> str:
    return "".join(ch for ch in sid if ch.isalnum() or ch in "-_")[:64]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    port = 3090

    def log_message(self, *a):  # quiet
        pass

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        if not self._local():
            return self._json({"error": "forbidden"}, 403)
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/flow.js"):
            body = (UI if u.path == "/" else UI.with_name("flow.js")).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ("text/html" if u.path == "/" else "text/javascript") + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/api/sessions":
            rows = []
            for d in sorted(SESSIONS.glob("*"), reverse=True)[:80]:
                try:
                    rows.append(json.loads((d / "meta.json").read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    continue
            self._json(rows)
        elif u.path == "/api/defaults":
            cfg = config.load()
            cat = Catalog(cfg)
            self._json({"model": cfg["model"], "cwd": str(Path.cwd()), "workflows": ["loop", "verify", "pev"],
                        "models": [m["id"] for m in cat.search("", 600) if m["tools"]]})
        elif u.path == "/api/events":
            self._stream(_safe_id((q.get("session") or [""])[0]))
        else:
            self._json({"error": "not found"}, 404)

    def _stream(self, sid: str) -> None:
        path = SESSIONS / sid / "events.jsonl"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        pos, beat = 0, time.time()
        try:
            while True:
                if path.is_file():
                    with open(path, "rb") as f:
                        f.seek(pos)
                        chunk = f.read()
                    cut = chunk.rfind(b"\n")
                    if cut >= 0:
                        data = chunk[:cut + 1]
                        pos += len(data)
                        self.wfile.write(b"".join(b"data: " + l + b"\n\n" for l in data.splitlines() if l.strip()))
                        self.wfile.flush()
                        beat = time.time()
                if time.time() - beat > 10:
                    self.wfile.write(b": hb\n\n")
                    self.wfile.flush()
                    beat = time.time()
                time.sleep(0.2)
        except (BrokenPipeError, ConnectionError, OSError):
            pass

    # --------------------------------------------------------------- POST
    def do_POST(self):
        if not self._local() or self.headers.get("X-Hangar") != "1":
            return self._json({"error": "forbidden"}, 403)
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self._json({"error": "bad json"}, 400)
        path = urlparse(self.path).path
        if path == "/api/answer":
            d = SESSIONS / _safe_id(data.get("session", "")) / "answers"
            if not d.is_dir():
                return self._json({"error": "unknown session"}, 404)
            (d / f"{_safe_id(data.get('qid', ''))}.json").write_text(json.dumps({"answer": str(data.get("answer", ""))}), encoding="utf-8")
            return self._json({"ok": True})
        if path == "/api/stop":
            d = SESSIONS / _safe_id(data.get("session", ""))
            if d.is_dir():
                (d / "stop").write_text("1")
            return self._json({"ok": True})
        if path == "/api/run":
            task = str(data.get("task", "")).strip()
            cwd = Path(str(data.get("cwd") or Path.cwd())).expanduser()
            if not task:
                return self._json({"error": "empty task"}, 400)
            if not cwd.is_dir():
                return self._json({"error": f"folder not found: {cwd}"}, 400)
            sid = time.strftime("%Y%m%d-%H%M%S-ui") + str(int(time.time() * 1000) % 1000)
            cmd = [sys.executable, "-m", "hangar", "run", task, "--ui", "--quiet", "--session-id", sid, "--cwd", str(cwd)]
            if data.get("model"):
                cmd += ["-m", str(data["model"])]
            if data.get("workflow"):
                cmd += ["-w", str(data["workflow"])]
            if data.get("planner"):
                cmd += ["--planner", str(data["planner"])]
            for a in data.get("attachments") or []:
                if str(a).strip():
                    cmd += ["-a", str(a).strip()]
            subprocess.Popen(cmd, cwd=str(config.PKG_ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self._json({"ok": True, "session": sid})
        self._json({"error": "not found"}, 404)


def serve(port: int = 3090, open_browser: bool = True) -> int:
    config.load()
    SESSIONS.mkdir(parents=True, exist_ok=True)
    Handler.port = port
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    url = f"http://127.0.0.1:{port}"
    print(f"Hangar dashboard: {url}  (Ctrl+C to stop)")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0
