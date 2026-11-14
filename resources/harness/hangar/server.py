"""The Hangar web app (`hangar ui`): chat sessions with permission cards, side panels (terminal, changes, files,
browser, artifacts, harness, live graph), attachments and screen/microphone recordings.

Each chat session is one `python -m hangar bridge` process; everything it says is appended to the session's own
JSONL log, which the browser replays and then follows over SSE. Runs started elsewhere (CLI, benchmark) are still
listed read-only from their own logs.

Bound to 127.0.0.1. Every /api call needs the per-launch token (a header, or `?token=` where a header cannot be
set: EventSource, <img>, <iframe>), so no other web page can read files or start commands through this server."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__, config, lessons, media, memory, project, router, skills
from .models import Catalog
from .session import SESSIONS
from .tools import SKIP_DIRS

PKG = Path(__file__).parent
STATIC = {"/": ("ui.html", "text/html"), "/ui.css": ("ui.css", "text/css"), "/ui.js": ("ui.js", "text/javascript"),
          "/flow.js": ("flow.js", "text/javascript")}
PERMISSIONS = ("ask", "edits", "readonly", "auto")
EFFORTS = ("low", "medium", "high")
MAX_UPLOAD = 600 * 1024 * 1024
MAX_TEXT = 600_000
ARTIFACT_EXT = {".html", ".htm", ".svg", ".md", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp4", ".webm", ".pptx"}
HARNESS_FILES = re.compile(r"^(HANGAR\.md|AGENTS\.md|CLAUDE\.md|\.mcp\.json|\.(claude|hangar)/(CLAUDE\.md|settings\.json|hooks\.json|"
                           r"(skills|agents|commands|scripts|plugins|workflows)/.+))$")


def _safe_id(sid: str) -> str:
    return "".join(ch for ch in str(sid) if ch.isalnum() or ch in "-_")[:64]


def _now() -> int:
    return int(time.time() * 1000)


class Store:
    """UI sessions: an index file plus one event log per session, under HANGAR_HOME/ui."""

    def __init__(self):
        self.dir = config.HOME / "ui"
        (self.dir / "logs").mkdir(parents=True, exist_ok=True)
        (self.dir / "uploads").mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.sessions: dict[str, dict] = {}
        try:
            for s in json.loads((self.dir / "sessions.json").read_text(encoding="utf-8")):
                s["status"] = "idle" if s.get("status") in ("working", "waiting") else s.get("status", "idle")
                self.sessions[s["id"]] = s
        except (OSError, ValueError, KeyError, TypeError):
            pass
        self.version = 1

    def save(self) -> None:
        with self.lock:
            self.version += 1
            tmp = self.dir / "sessions.json.tmp"
            tmp.write_text(json.dumps(list(self.sessions.values()), ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.dir / "sessions.json")

    def log_path(self, sid: str) -> Path:
        return self.dir / "logs" / f"{_safe_id(sid)}.jsonl"

    def append(self, sid: str, ev: dict) -> None:
        ev.setdefault("t", round(time.time(), 3))
        with self.lock:
            with open(self.log_path(sid), "a", encoding="utf-8") as f:
                f.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")

    def patch(self, sid: str, **fields) -> dict | None:
        with self.lock:
            s = self.sessions.get(sid)
            if not s:
                return None
            s.update(fields)
            s["updatedAt"] = _now()
            self.save()
            return s


class Live:
    """A running bridge process of one UI session."""

    def __init__(self, app: "App", sid: str):
        self.app, self.sid = app, sid
        self.proc: subprocess.Popen | None = None
        self.ready = threading.Event()
        self.fatal = ""
        self.wlock = threading.Lock()
        self.pending: dict[str, dict] = {}
        self.busy = 0

    def start(self) -> None:
        s = self.app.store.sessions[self.sid]
        env = {**os.environ, "PYTHONPATH": str(config.PKG_ROOT), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        self.proc = subprocess.Popen([sys.executable, "-u", "-m", "hangar", "bridge"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, env=env, cwd=s["cwd"],
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.err_tail: list[str] = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()
        start = {"type": "start", "cwd": s["cwd"], "model": s["model"], "permission": s.get("permission", "ask"),
                 "effort": s.get("effort") or None, "title": s["title"], "lessons": True, "memory": True, **self.app.bridge_extra}
        if s.get("hangarSessionId"):
            start["resume"] = s["hangarSessionId"]
        self.send(start)

    def send(self, msg: dict) -> None:
        if not self.proc or self.proc.poll() is not None:
            return
        with self.wlock:
            try:
                self.proc.stdin.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
                self.proc.stdin.flush()
            except OSError:
                pass

    def alive(self) -> bool:
        return bool(self.proc) and self.proc.poll() is None

    def _stderr(self) -> None:
        for line in self.proc.stderr:
            self.err_tail.append(line.decode("utf-8", "replace"))
            del self.err_tail[:-12]

    def _read(self) -> None:
        store = self.app.store
        for raw in self.proc.stdout:
            try:
                ev = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            t = ev.get("type")
            if t == "ready":
                store.patch(self.sid, hangarSessionId=ev.get("session"), contextWindow=ev.get("context_window"), team=ev.get("team"))
                self.ready.set()
                continue
            if t == "options":
                continue
            if t == "fatal":
                self.fatal = str(ev.get("message") or "fatal")
                self.ready.set()
            if t == "permission" or (t == "question" and ev.get("kind") != "approval"):
                self.pending[str(ev.get("qid"))] = {"kind": t}
                store.patch(self.sid, status="waiting")
            if t == "turn_end":
                self.busy = max(0, self.busy - 1)
                self.pending.clear()
                s = store.sessions.get(self.sid) or {}
                status = ev.get("status")
                store.patch(self.sid, status="error" if status in ("error", "incomplete") else "idle" if not self.busy else "working",
                            cost=ev.get("session_cost", s.get("cost", 0)), byRole=ev.get("session_by_role") or s.get("byRole"),
                            contextTokens=ev.get("context_tokens"),
                            contextWindow=ev.get("context_window"), unread=self.app.active != self.sid)
            store.append(self.sid, ev)
        code = self.proc.wait()
        if self.busy:
            self.busy = 0
            store.append(self.sid, {"type": "error", "text": f"O motor encerrou inesperadamente (código {code}).\n" + "".join(self.err_tail)[-1500:]})
            store.append(self.sid, {"type": "turn_end", "status": "error", "error": "process exited"})
            store.patch(self.sid, status="error")
        self.ready.set()

    def close(self) -> None:
        if self.alive():
            self.send({"type": "close"})
            try:
                self.proc.wait(timeout=25)              # closing may write a lesson (one short model call)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.proc:
            for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                try:
                    stream.close()
                except OSError:
                    pass


class App:
    def __init__(self, bridge_extra: dict | None = None):
        self.token = secrets.token_urlsafe(24)
        self.store = Store()
        self.live: dict[str, Live] = {}
        self.lock = threading.RLock()
        self.active = ""
        self.bridge_extra = bridge_extra or {}        # extra `start` fields (tests point the bridge at a fake server)
        self.terms: dict[str, subprocess.Popen] = {}
        self._models: list[str] | None = None

    # ------------------------------------------------------------ sessions
    def session(self, sid: str) -> dict:
        s = self.store.sessions.get(_safe_id(sid))
        if not s:
            raise ApiError(404, "sessão não encontrada")
        return s

    def cwd(self, sid: str) -> Path:
        return Path(self.session(sid)["cwd"])

    def create(self, data: dict) -> dict:
        cfg = config.load()
        cwd = Path(str(data.get("cwd") or Path.cwd())).expanduser()
        if not cwd.is_dir():
            raise ApiError(400, f"pasta não encontrada: {cwd}")
        sid = time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)
        s = {"id": sid, "title": str(data.get("title") or "Nova sessão").strip()[:120] or "Nova sessão", "cwd": str(cwd.resolve()),
             "model": str(data.get("model") or "auto"),
             "effort": data.get("effort") if data.get("effort") in EFFORTS else (cfg["reasoning_effort"] if cfg["reasoning_effort"] in EFFORTS else "low"),
             "permission": data.get("permission") if data.get("permission") in PERMISSIONS else "ask",
             "pinned": False, "archived": False, "unread": False, "status": "idle", "cost": 0, "createdAt": _now(), "updatedAt": _now()}
        with self.store.lock:
            self.store.sessions[sid] = s
            self.store.save()
        return s

    def update(self, sid: str, data: dict) -> dict:
        s = self.session(sid)
        fields = {}
        for k in ("title", "model"):
            if isinstance(data.get(k), str) and data[k].strip():
                fields[k] = data[k].strip()[:200]
        for k in ("pinned", "archived", "unread"):
            if isinstance(data.get(k), bool):
                fields[k] = data[k]
        if data.get("permission") in PERMISSIONS:
            fields["permission"] = data["permission"]
        if data.get("effort") in EFFORTS:
            fields["effort"] = data["effort"]
        self.store.patch(sid, **fields)
        live = self.live.get(s["id"])
        if live and live.alive():
            opts = {k: fields[k] for k in ("permission", "effort", "model") if k in fields}
            if opts:
                live.send({"type": "set_options", **opts})
            if fields.get("archived"):
                live.close()
        return s

    def delete(self, sid: str) -> None:
        s = self.session(sid)
        live = self.live.pop(s["id"], None)
        if live:
            live.close()
        with self.store.lock:
            self.store.sessions.pop(s["id"], None)
            self.store.save()
        try:
            self.store.log_path(s["id"]).unlink()
        except OSError:
            pass

    def _live(self, sid: str) -> Live:
        with self.lock:
            live = self.live.get(sid)
            if not live or not live.alive():
                live = self.live[sid] = Live(self, sid)
                live.start()
            return live

    def send(self, sid: str, data: dict) -> dict:
        s = self.session(sid)
        text = str(data.get("text") or "")
        atts = [str(a) for a in data.get("attachments") or [] if str(a).strip()]
        if not text.strip() and not atts:
            raise ApiError(400, "mensagem vazia")
        if s["title"] in ("Nova sessão", "") and text.strip():
            line = " ".join(text.strip().split("\n")[0].split())
            self.store.patch(s["id"], title=line[:57].rstrip() + "…" if len(line) > 60 else line)
        self.store.append(s["id"], {"type": "user", "text": text, "model": s["model"], "attachments": [
            {"path": a, "name": re.sub(r"^\d{6}-[0-9a-f]{4}-", "", Path(a).name), "kind": media.kind_of(Path(a)) if Path(a).is_file() else "missing"}
            for a in atts]})
        live = self._live(s["id"])
        live.busy += 1
        self.store.patch(s["id"], status="working", archived=False)
        if not live.ready.wait(90) or live.fatal or not live.alive():
            live.busy = 0
            message = live.fatal or "".join(getattr(live, "err_tail", []))[-800:] or "o motor não respondeu ao iniciar"
            live.fatal = ""
            self.store.append(s["id"], {"type": "error", "text": f"Falha ao iniciar o motor: {message}"})
            self.store.append(s["id"], {"type": "turn_end", "status": "error", "error": message})
            self.store.patch(s["id"], status="error")
            raise ApiError(502, message)
        live.send({"type": "user", "text": text, "attachments": atts})
        return {"ok": True}

    def respond(self, sid: str, data: dict) -> dict:
        s = self.session(sid)
        live = self.live.get(s["id"])
        qid = str(data.get("qid") or "")
        if not live or qid not in live.pending:
            raise ApiError(409, "esse pedido não está mais pendente")
        kind = live.pending.pop(qid)["kind"]
        if kind == "permission":
            decision = data.get("decision") if data.get("decision") in ("allow", "allow_always", "deny") else "deny"
            live.send({"type": "permission_response", "qid": qid, "decision": decision, "message": str(data.get("message") or "")})
        else:
            answer = str(data.get("answer") or "")
            live.send({"type": "answer", "qid": qid, "answer": answer})
            self.store.append(s["id"], {"type": "answer", "qid": qid, "answer": answer})
        if not live.pending and live.busy:
            self.store.patch(s["id"], status="working")
        return {"ok": True}

    def interrupt(self, sid: str) -> dict:
        live = self.live.get(self.session(sid)["id"])
        if live and live.alive():
            live.pending.clear()
            live.send({"type": "interrupt"})
        return {"ok": True}

    def state(self) -> dict:
        cfg = config.load()
        cli = []
        ui_ids = {s.get("hangarSessionId") for s in self.store.sessions.values()}
        for d in sorted(SESSIONS.glob("*"), reverse=True)[:60]:
            try:
                m = json.loads((d / "meta.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if m.get("id") in ui_ids or m.get("task") == "(headless)":
                continue
            cli.append({k: m.get(k) for k in ("id", "task", "model", "status", "workflow", "started", "cwd")} | {"cost": (m.get("totals") or {}).get("cost", 0)})
        with self.store.lock:
            sessions = sorted(self.store.sessions.values(), key=lambda s: -s.get("updatedAt", 0))
            for s in sessions:
                live = self.live.get(s["id"])
                s["busy"] = bool(live and live.busy)
        return {"version": __version__, "sessions": sessions, "cli": cli,
                "defaults": {"model": "auto", "cwd": str(Path.cwd()), "permission": "ask",
                             "effort": cfg["reasoning_effort"] if cfg["reasoning_effort"] in EFFORTS else "low"},
                "hasKey": bool(os.environ.get(cfg["providers"].get(cfg["default_provider"], {}).get("api_key_env") or "") or
                               not cfg["providers"].get(cfg["default_provider"], {}).get("api_key_env"))}

    def models(self) -> list[str]:
        if self._models is None:
            try:
                self._models = [m["id"] for m in Catalog(config.load()).search("", 800) if m["tools"]]
            except Exception:
                self._models = []
        return self._models

    # --------------------------------------------------------------- files
    def inside(self, sid: str, rel: str, must_exist: bool = True) -> Path:
        root = self.cwd(sid).resolve()
        p = Path(rel)
        p = (p if p.is_absolute() else root / p).resolve()
        ups = (self.store.dir / "uploads" / _safe_id(sid)).resolve()
        if not any(p == r or r in p.parents for r in (root, ups)):
            raise ApiError(403, "fora da pasta da sessão")
        if must_exist and not p.exists():
            raise ApiError(404, "arquivo não encontrado")
        return p

    def tree(self, sid: str, rel: str) -> list[dict]:
        d = self.inside(sid, rel or ".")
        if not d.is_dir():
            raise ApiError(400, "não é uma pasta")
        root = self.cwd(sid).resolve()
        rows = []
        for p in sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if p.name in SKIP_DIRS and p.is_dir() and p.name not in (".claude", ".hangar"):
                continue
            try:
                rows.append({"name": p.name, "path": str(p.relative_to(root)).replace("\\", "/"), "dir": p.is_dir(),
                             "size": p.stat().st_size if p.is_file() else 0})
            except OSError:
                continue
        return rows[:2000]

    def find(self, sid: str, q: str) -> list[dict]:
        root, q, out = self.cwd(sid).resolve(), q.lower().strip(), []
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in SKIP_DIRS]
            for f in fns:
                rel = str((Path(dp) / f).relative_to(root)).replace("\\", "/")
                if q in rel.lower():
                    out.append({"name": f, "path": rel, "dir": False, "size": 0})
                    if len(out) >= 200:
                        return out
        return out

    def read_file(self, sid: str, rel: str) -> dict:
        p = self.inside(sid, rel)
        if not p.is_file():
            raise ApiError(400, "não é um arquivo")
        kind, size = media.kind_of(p), p.stat().st_size
        out = {"path": str(p), "name": p.name, "size": size, "kind": kind}
        if kind == "text":
            data = p.read_bytes()[:MAX_TEXT]
            if b"\0" in data[:4000]:
                out["kind"] = "binary"
            else:
                out["text"], out["truncated"] = data.decode("utf-8", "replace"), size > MAX_TEXT
        return out

    def write_harness(self, sid: str, rel: str, text: str) -> dict:
        rel = rel.replace("\\", "/").lstrip("/")
        if not HARNESS_FILES.match(rel) or ".." in rel.split("/"):
            raise ApiError(403, "só arquivos do harness do projeto podem ser editados aqui")
        p = self.inside(sid, rel, must_exist=False)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
        return {"ok": True}

    def harness(self, sid: str) -> dict:
        cwd = self.cwd(sid)
        files = []
        for dp, dns, fns in os.walk(cwd):
            rel_dir = str(Path(dp).relative_to(cwd)).replace("\\", "/")
            dns[:] = [d for d in dns if (rel_dir == "." and d in (".claude", ".hangar")) or rel_dir != "."]
            for f in sorted(fns):
                rel = (f if rel_dir == "." else f"{rel_dir}/{f}")
                if HARNESS_FILES.match(rel):
                    files.append(rel)
        cfg = config.load(cwd)
        try:
            sk = skills.discover(cwd, cfg.get("skills_dirs"))
        except Exception:
            sk = {}
        try:
            ls = lessons.load()
        except Exception:
            ls = []
        return {"files": sorted(files)[:500],
                "instructions": [n for n, _ in project.instructions(cwd)],
                "agents": [{"name": n, "description": a["description"]} for n, a in project.agents(cwd).items()],
                "commands": [{"name": n, "description": c["description"], "hint": c["hint"]} for n, c in project.commands(cwd).items()],
                "skills": [{"name": n, "description": str(s.get("description", ""))[:200]} for n, s in sk.items()],
                "hooks": {k: len(v) for k, v in project.claude_hooks(cwd).items()},
                "memory": [{"name": f["name"], "kind": f["kind"], "fact": f["fact"], "command": f["command"], "paths": f["paths"],
                            "verified": str(f.get("verified", "")), "confirmations": f["confirmations"], "stale": f["_stale"],
                            "source": str(f.get("source", ""))} for f in memory.load(cwd)],
                "lessons": [{k: str(l.get(k, ""))[:400] for k in ("cue", "lesson", "task", "model")} for l in ls[-40:]]}

    # ----------------------------------------------------------------- git
    def git(self, sid: str) -> dict:
        cwd = self.cwd(sid)

        def run(*args: str) -> tuple[int, str]:
            try:
                r = subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=cwd, capture_output=True, timeout=20,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                return r.returncode, r.stdout.decode("utf-8", "replace")
            except (OSError, subprocess.TimeoutExpired):
                return 1, ""
        code, top = run("rev-parse", "--show-toplevel")
        if code != 0:
            return {"repo": False, "files": []}
        _, branch = run("rev-parse", "--abbrev-ref", "HEAD")
        _, status = run("status", "--porcelain=v1", "-uall")
        files = []
        for line in status.splitlines()[:300]:
            st, path = line[:2].strip() or "M", line[3:].split(" -> ")[-1].strip().strip('"')
            if st == "??":
                try:
                    text = (cwd / path).read_text(encoding="utf-8", errors="replace")[:60_000]
                    diff = "\n".join("+" + l for l in text.splitlines())
                except OSError:
                    diff = ""
            else:
                _, diff = run("diff", "HEAD", "--no-color", "--", path)
                diff = diff[:120_000]
            files.append({"path": path, "status": "?" if st == "??" else st[0], "diff": diff})
        return {"repo": True, "branch": branch.strip(), "files": files}

    # ------------------------------------------------------------ terminal
    def term_stream(self, sid: str, command: str, wfile) -> None:
        cwd = self.cwd(sid)
        tid = secrets.token_hex(4)
        shell = ["powershell", "-NoLogo", "-NoProfile", "-Command", command] if os.name == "nt" else ["bash", "-lc", command]
        try:
            p = subprocess.Popen(shell, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as e:
            wfile.write(json.dumps({"type": "exit", "code": 127, "text": str(e)}).encode() + b"\n")
            return
        self.terms[tid] = p

        def out(obj: dict) -> None:
            wfile.write(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")
            wfile.flush()
        try:
            out({"type": "start", "id": tid})
            while True:
                chunk = p.stdout.read1(8192)
                if not chunk:
                    break
                try:
                    text = chunk.decode("utf-8")
                except UnicodeDecodeError:
                    text = chunk.decode("cp850" if os.name == "nt" else "latin-1", "replace")
                out({"type": "out", "text": text})
            out({"type": "exit", "code": p.wait()})
        except OSError:
            p.kill()
        finally:
            self.terms.pop(tid, None)

    def term_kill(self, tid: str) -> dict:
        p = self.terms.get(tid)
        if p and p.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
            else:
                p.kill()
        return {"ok": True}

    # ------------------------------------------------------------- uploads
    def upload(self, sid: str, name: str, rfile, length: int) -> dict:
        self.session(sid)
        if length <= 0 or length > MAX_UPLOAD:
            raise ApiError(413, "arquivo vazio ou grande demais")
        clean = re.sub(r"[^\w.\- ()]", "_", Path(name).name)[:120] or "arquivo"
        d = self.store.dir / "uploads" / _safe_id(sid)
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{time.strftime('%H%M%S')}-{secrets.token_hex(2)}-{clean}"
        left = length
        with open(p, "wb") as f:
            while left > 0:
                chunk = rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        return {"path": str(p), "name": clean, "size": p.stat().st_size, "kind": media.kind_of(p)}

    def shutdown(self) -> None:
        for live in list(self.live.values()):
            live.close()
        for p in list(self.terms.values()):
            try:
                p.kill()
            except OSError:
                pass


class ApiError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    app: App

    def log_message(self, *a):  # quiet
        pass

    # ------------------------------------------------------------- helpers
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8"), "application/json; charset=utf-8")

    def _local(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ("127.0.0.1", "localhost")

    def _authorized(self, q: dict) -> bool:
        tok = self.headers.get("X-Hangar-Token") or (q.get("token") or [""])[0]
        return self._local() and secrets.compare_digest(tok, self.app.token)

    def _body(self) -> dict:
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            raise ApiError(400, "json inválido")
        if not isinstance(data, dict):
            raise ApiError(400, "json inválido")
        return data

    # ----------------------------------------------------------------- GET
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in STATIC:
            if not self._local():
                return self._json({"error": "forbidden"}, 403)
            name, ctype = STATIC[u.path]
            body = (PKG / name).read_bytes()
            if u.path == "/":
                body = body.replace(b"__HANGAR_TOKEN__", self.app.token.encode())
            return self._send(200, body, ctype + "; charset=utf-8")
        if not u.path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        if not self._authorized(q):
            return self._json({"error": "forbidden"}, 403)
        one = lambda k, d="": (q.get(k) or [d])[0]  # noqa: E731
        app = self.app
        try:
            m = re.match(r"^/api/sessions/([\w-]+)/(\w+)$", u.path)
            if u.path == "/api/state":
                app.active = _safe_id(one("active"))
                return self._json(app.state())
            if u.path == "/api/models":
                return self._json(app.models())
            if u.path == "/api/team":                       # who does what when the harness picks the models
                cwd = Path(one("cwd")) if one("cwd") and Path(one("cwd")).is_dir() else None
                cfg = config.load(cwd)
                try:
                    return self._json({"team": router.describe(router.team(cfg, Catalog(cfg)))})
                except ValueError as e:
                    return self._json({"team": [], "error": str(e)})
            if u.path == "/api/dirs":
                return self._json(_dirs(one("path")))
            if u.path == "/api/events":                     # a run started elsewhere (CLI, benchmark): its own log
                return self._stream(SESSIONS / _safe_id(one("session")) / "events.jsonl")
            if u.path == "/api/search":
                return self._json(_search(app, one("q")))
            if not m:
                return self._json({"error": "not found"}, 404)
            sid, what = m.group(1), m.group(2)
            if what == "events":
                app.session(sid)
                if app.store.sessions[sid].get("unread"):
                    app.store.patch(sid, unread=False)
                return self._stream(app.store.log_path(sid))
            if what == "tree":
                return self._json(app.tree(sid, one("path")))
            if what == "find":
                return self._json(app.find(sid, one("q")))
            if what == "file":
                return self._json(app.read_file(sid, one("path")))
            if what == "raw":
                return self._raw(app.inside(sid, one("path")))
            if what == "git":
                return self._json(app.git(sid))
            if what == "harness":
                return self._json(app.harness(sid))
            if what == "commands":
                return self._json([{"name": n, "description": c["description"], "hint": c["hint"]}
                                   for n, c in project.commands(app.cwd(sid)).items()])
            return self._json({"error": "not found"}, 404)
        except ApiError as e:
            return self._json({"error": str(e)}, e.code)
        except (BrokenPipeError, ConnectionError):
            return
        except Exception as e:
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    def _raw(self, p: Path) -> None:
        if not p.is_file():
            raise ApiError(400, "não é um arquivo")
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        size = p.stat().st_size
        rng = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
        start, end = 0, size - 1
        if rng and (rng.group(1) or rng.group(2)):
            if rng.group(1):
                start, end = int(rng.group(1)), int(rng.group(2) or size - 1)
            else:
                start = max(0, size - int(rng.group(2)))
            end = min(end, size - 1)
        self.send_response(206 if rng and start <= end else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(max(0, end - start + 1)))
        self.send_header("Accept-Ranges", "bytes")
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        # Files of the project render in a sandboxed frame: scripts may run, but with an opaque origin (no token, no API).
        self.send_header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(p, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def _stream(self, path: Path) -> None:
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
                time.sleep(0.12)
        except (BrokenPipeError, ConnectionError, OSError):
            pass

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not self._authorized(q):
            return self._json({"error": "forbidden"}, 403)
        app = self.app
        one = lambda k, d="": (q.get(k) or [d])[0]  # noqa: E731
        try:
            m = re.match(r"^/api/sessions/([\w-]+)/(\w+)$", u.path)
            if u.path == "/api/sessions":
                return self._json(app.create(self._body()))
            if m and m.group(2) == "upload":
                return self._json(app.upload(m.group(1), unquote(one("name", "arquivo")), self.rfile,
                                             int(self.headers.get("Content-Length") or 0)))
            if m and m.group(2) == "terminal":
                data = self._body()
                app.session(m.group(1))
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                return app.term_stream(m.group(1), str(data.get("command") or ""), self.wfile)
            data = self._body()
            if m:
                sid, what = m.group(1), m.group(2)
                if what == "update":
                    return self._json(app.update(sid, data))
                if what == "delete":
                    app.delete(sid)
                    return self._json({"ok": True})
                if what == "send":
                    return self._json(app.send(sid, data))
                if what == "respond":
                    return self._json(app.respond(sid, data))
                if what == "interrupt":
                    return self._json(app.interrupt(sid))
                if what == "save":
                    return self._json(app.write_harness(sid, str(data.get("path") or ""), str(data.get("text") or "")))
                if what == "forget":                        # drop one fact of the project memory (or all, without a name)
                    return self._json({"removed": memory.forget(app.cwd(sid), str(data.get("name") or ""))})
                if what == "open":
                    _open_path(app.inside(sid, str(data.get("path") or ".")))
                    return self._json({"ok": True})
                if what == "kill":
                    return self._json(app.term_kill(str(data.get("id") or "")))
            # ---- runs started from the old dashboard / the CLI (read-only sessions)
            if u.path == "/api/answer":
                d = SESSIONS / _safe_id(data.get("session", "")) / "answers"
                if not d.is_dir():
                    return self._json({"error": "unknown session"}, 404)
                (d / f"{_safe_id(data.get('qid', ''))}.json").write_text(json.dumps({"answer": str(data.get("answer", ""))}), encoding="utf-8")
                return self._json({"ok": True})
            if u.path == "/api/stop":
                d = SESSIONS / _safe_id(data.get("session", ""))
                if d.is_dir():
                    (d / "stop").write_text("1")
                return self._json({"ok": True})
            if u.path == "/api/run":
                return self._json(_run_cli(data))
            return self._json({"error": "not found"}, 404)
        except ApiError as e:
            return self._json({"error": str(e)}, e.code)
        except (BrokenPipeError, ConnectionError):
            return
        except Exception as e:
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)


def _dirs(path: str) -> dict:
    """Folders under `path`, for the folder picker (a browser cannot hand a local path to the server)."""
    if not path:
        p = Path.cwd()
    else:
        p = Path(path).expanduser()
    if not p.is_dir():
        raise ApiError(400, f"pasta não encontrada: {path}")
    p = p.resolve()
    dirs = []
    try:
        for d in sorted(p.iterdir(), key=lambda d: d.name.lower()):
            try:
                if d.is_dir() and not d.name.startswith("$"):
                    dirs.append(d.name)
            except OSError:
                continue
    except OSError:
        pass
    roots = [f"{c}:\\" for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if Path(f"{c}:\\").exists()] if os.name == "nt" else ["/"]
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else "", "dirs": dirs[:600], "home": str(Path.home()), "roots": roots}


def _search(app: App, q: str) -> list[dict]:
    q = q.lower().strip()
    if len(q) < 2:
        return []
    hits = []
    for s in list(app.store.sessions.values()):
        where = ""
        if q in s["title"].lower():
            where = s["title"]
        else:
            try:
                with open(app.store.log_path(s["id"]), encoding="utf-8") as f:
                    for line in f:
                        if q in line.lower() and ('"type": "user"' in line or '"type": "assistant"' in line):
                            text = str(json.loads(line).get("text") or "")
                            i = text.lower().find(q)
                            if i >= 0:
                                where = ("…" if i > 40 else "") + text[max(0, i - 40):i + 80].replace("\n", " ")
                                break
            except (OSError, ValueError):
                pass
        if where:
            hits.append({"id": s["id"], "title": s["title"], "snippet": where})
    return hits[:40]


def _open_path(p: Path) -> None:
    try:
        if os.name == "nt":
            os.startfile(str(p))  # noqa: S606 - the user's own file, opened with their own default app
        else:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(p)])
    except OSError as e:
        raise ApiError(500, str(e))


def _run_cli(data: dict) -> dict:
    task = str(data.get("task", "")).strip()
    cwd = Path(str(data.get("cwd") or Path.cwd())).expanduser()
    if not task:
        raise ApiError(400, "empty task")
    if not cwd.is_dir():
        raise ApiError(400, f"folder not found: {cwd}")
    sid = time.strftime("%Y%m%d-%H%M%S-ui") + str(int(time.time() * 1000) % 1000)
    cmd = [sys.executable, "-m", "hangar", "run", task, "--ui", "--quiet", "--session-id", sid, "--cwd", str(cwd)]
    cmd += ["-m", str(data.get("model") or "auto")]
    if data.get("workflow"):
        cmd += ["-w", str(data["workflow"])]
    if data.get("planner"):
        cmd += ["--planner", str(data["planner"])]
    if data.get("verifier"):
        cmd += ["--verifier", str(data["verifier"])]
    if data.get("permission") in PERMISSIONS:
        cmd += ["--permission", str(data["permission"])]
    if data.get("effort") in EFFORTS:
        cmd += ["--effort", str(data["effort"])]
    if data.get("workflow") not in (None, "", "loop", "verify", "pev"):
        raise ApiError(400, "workflow desconhecido")
    for a in data.get("attachments") or []:
        if str(a).strip():
            cmd += ["-a", str(a).strip()]
    subprocess.Popen(cmd, cwd=str(config.PKG_ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True, "session": sid}


def make_server(port: int = 3090, bridge_extra: dict | None = None) -> tuple[ThreadingHTTPServer, App]:
    config.load()
    SESSIONS.mkdir(parents=True, exist_ok=True)
    app = App(bridge_extra)
    handler = type("BoundHandler", (Handler,), {"app": app})
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    srv.daemon_threads = True
    return srv, app


def serve(port: int = 3090, open_browser: bool = True) -> int:
    srv, app = make_server(port)
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    print(f"Hangar: {url}  (Ctrl+C para encerrar)")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.shutdown()
    return 0
