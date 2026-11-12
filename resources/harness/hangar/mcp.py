"""Minimal MCP client (stdio + streamable HTTP), stdlib only.
Reads the same `.mcp.json` format as Claude Code, so existing server configs just work."""
from __future__ import annotations

import json
import os
import subprocess
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .config import HOME

PROTOCOL = "2025-06-18"


class MCPError(Exception):
    pass


class MCPServer:
    def __init__(self, name: str, spec: dict, cwd: Path):
        self.name, self.spec, self.cwd = name, spec, cwd
        self.tools: list[dict] = []
        self.error = ""
        self._id = 0
        self._lock = threading.Lock()
        self._pending: dict[int, dict] = {}
        self._cv = threading.Condition()
        self._proc: subprocess.Popen | None = None
        self._http_session = ""

    # -- transport ------------------------------------------------------------
    def _reader(self) -> None:
        assert self._proc and self._proc.stdout
        for line in self._proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                with self._cv:
                    self._pending[msg["id"]] = msg
                    self._cv.notify_all()
        with self._cv:
            self._pending[-1] = {"error": {"message": "server exited"}}
            self._cv.notify_all()

    def _rpc(self, method: str, params: dict | None = None, timeout: float = 60, notify: bool = False):
        with self._lock:
            self._id += 1
            rid = self._id
        msg: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            msg["id"] = rid
        if "url" in self.spec:
            return self._http(msg, timeout, notify)
        assert self._proc and self._proc.stdin
        with self._lock:
            self._proc.stdin.write(json.dumps(msg) + "\n")
            self._proc.stdin.flush()
        if notify:
            return None
        with self._cv:
            ok = self._cv.wait_for(lambda: rid in self._pending or -1 in self._pending, timeout)
            if not ok:
                raise MCPError(f"{self.name}: timeout on {method}")
            resp = self._pending.pop(rid, None) or self._pending[-1]
        if "error" in resp:
            raise MCPError(f"{self.name}: {resp['error'].get('message', resp['error'])}")
        return resp.get("result")

    def _http(self, msg: dict, timeout: float, notify: bool):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": PROTOCOL, **(self.spec.get("headers") or {})}
        if self._http_session:
            headers["Mcp-Session-Id"] = self._http_session
        req = urllib.request.Request(self.spec["url"], data=json.dumps(msg).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            self._http_session = r.headers.get("Mcp-Session-Id") or self._http_session
            body = r.read().decode("utf-8", "replace")
            ctype = r.headers.get("Content-Type", "")
        if notify or not body.strip():
            return None
        resp = None
        if "event-stream" in ctype:
            for line in body.splitlines():
                if line.startswith("data:"):
                    try:
                        cand = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if cand.get("id") == msg.get("id"):
                        resp = cand
        else:
            resp = json.loads(body)
        if not resp:
            raise MCPError(f"{self.name}: empty response")
        if "error" in resp:
            raise MCPError(f"{self.name}: {resp['error'].get('message', resp['error'])}")
        return resp.get("result")

    # -- lifecycle --------------------------------------------------------------
    def start(self) -> None:
        try:
            if "url" not in self.spec:
                env = {**os.environ, **{k: str(v) for k, v in (self.spec.get("env") or {}).items()}}
                cmd = [self.spec["command"], *[str(a) for a in self.spec.get("args") or []]]
                self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                              text=True, encoding="utf-8", errors="replace", bufsize=1, env=env,
                                              cwd=str(self.cwd), shell=(os.name == "nt" and not Path(cmd[0]).is_file()))
                threading.Thread(target=self._reader, daemon=True).start()
            self._rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                     "clientInfo": {"name": "hangar-harness", "version": "0.1"}}, timeout=30)
            self._rpc("notifications/initialized", notify=True)
            self.tools = (self._rpc("tools/list", {}, timeout=30) or {}).get("tools", [])
        except Exception as e:
            self.error = str(e)
            self.stop()

    def call(self, tool: str, args: dict, timeout: float = 120) -> str:
        res = self._rpc("tools/call", {"name": tool, "arguments": args or {}}, timeout=timeout) or {}
        parts = []
        for c in res.get("content") or []:
            parts.append(c.get("text", "") if c.get("type") == "text" else f"[{c.get('type')} content omitted]")
        if not parts and res.get("structuredContent") is not None:
            parts.append(json.dumps(res["structuredContent"], ensure_ascii=False))
        text = "\n".join(parts)
        return ("Error: " + text) if res.get("isError") else text

    def stop(self) -> None:
        p, self._proc = self._proc, None
        if p:
            try:
                p.terminate()
                p.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                pass
            for stream in (p.stdin, p.stdout):
                try:
                    stream.close()
                except (OSError, AttributeError):
                    pass


class MCPManager:
    def __init__(self, cwd: Path, bus=None):
        self.cwd, self.bus = Path(cwd), bus
        self.servers: dict[str, MCPServer] = {}

    def load(self, extra: dict | None = None) -> None:
        """`extra` = servers handed in by a host application (same shape as the files: {name: {url|command, ...}})."""
        specs: dict = {}
        for p in (HOME / "mcp.json", self.cwd / ".mcp.json", self.cwd / ".hangar" / "mcp.json"):
            if p.is_file():
                try:
                    specs.update(json.loads(p.read_text(encoding="utf-8")).get("mcpServers") or {})
                except (OSError, ValueError) as e:
                    if self.bus:
                        self.bus.emit("notice", level="warn", text=f"bad MCP config {p}: {e}")
        specs.update(extra or {})
        if not specs:
            return
        self.servers = {n: MCPServer(n, s, self.cwd) for n, s in specs.items() if isinstance(s, dict) and not s.get("disabled")}
        with ThreadPoolExecutor(max_workers=max(1, len(self.servers))) as ex:
            list(ex.map(lambda s: s.start(), self.servers.values()))
        for s in self.servers.values():
            if self.bus:
                self.bus.emit("mcp", server=s.name, tools=[t["name"] for t in s.tools], error=s.error)

    def all_tools(self) -> list[tuple[str, dict]]:
        return [(s.name, t) for s in self.servers.values() for t in s.tools]

    def call(self, qualified: str, args: dict) -> str:
        """qualified = 'server__tool' (or just 'tool' when unambiguous)."""
        name = qualified.removeprefix("mcp__")
        if "__" in name:
            srv, tool = name.split("__", 1)
            if srv in self.servers:
                return self.servers[srv].call(tool, args)
        owners = [s for s in self.servers.values() if any(t["name"] == name for t in s.tools)]
        if len(owners) == 1:
            return owners[0].call(name, args)
        raise MCPError(f"unknown MCP tool '{qualified}'. Use tool_search to find the exact name.")

    def search(self, query: str, limit: int = 6) -> list[tuple[str, dict]]:
        words = [w for w in query.lower().split() if w]
        scored = []
        for srv, t in self.all_tools():
            hay = f"{srv} {t['name']} {t.get('description', '')}".lower()
            score = sum(3 if w in t["name"].lower() else 1 for w in words if w in hay)
            if score:
                scored.append((score, srv, t))
        scored.sort(key=lambda x: -x[0])
        return [(s, t) for _, s, t in scored[:limit]]

    def stop(self) -> None:
        for s in self.servers.values():
            s.stop()
