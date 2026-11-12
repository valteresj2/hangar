"""Built-in tools: a small, non-overlapping set with terse descriptions (every schema is
re-sent on each call, so words here cost money on every turn)."""
from __future__ import annotations

import difflib
import html.parser
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from . import media, skills as skills_mod
from .config import PKG_ROOT

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".hangar", "dist", "build", ".mypy_cache", ".next", "target"}
DANGEROUS = [re.compile(p, re.I) for p in (
    r"\brm\s+(-\w+\s+)*-\w*r\w*\s+(-\w+\s+)*(/|~|\$HOME|[a-z]:[\\/]?)(\s|$|\*)", r"\bformat\s+[a-z]:", r"\bmkfs", r"\bdd\s+if=",
    r"\b(shutdown|reboot|halt)\b", r"\bgit\b[^|;&]*\bpush\b[^|;&]*(--force|-f\b)", r"\bgit\b[^|;&]*\breset\b[^|;&]*--hard", r"\bgit\b[^|;&]*\bclean\b[^|;&]*-\w*f",
    r"\breg(\.exe)?\s+(delete|add)\b", r"(curl|wget|iwr|Invoke-WebRequest)[^|;]*\|\s*(ba|z)?sh", r"\|\s*iex\b", r"\bsudo\b",
    r":\(\)\s*\{", r"\b(del|rd|rmdir)\s+/s", r"Set-ExecutionPolicy", r"\bnetsh\b", r"\bschtasks\b", r"\bdiskpart\b",
    r"Remove-Item\b.*-Recurse.*\s([a-z]:[\\/]?|~|\$HOME|\$env:USERPROFILE)[\\/]?(\s|$)", r"\bchmod\s+-R\s+777\s+/",
)]


# Killing by NAME takes down unrelated programs (the user's own, other agents, this harness). Seen in real runs:
# strong models ran `taskkill /F /IM python.exe` just to stop their own test server.
KILL_BY_NAME = [re.compile(p, re.I) for p in (
    r"taskkill\b[^|;&]*[/-]+IM\b",
    r"\b(pkill|killall)\b",
    r"Stop-Process\b[^|;&]*-(Name|ProcessName)\b",
    r"\bwmic\b[^|;&]*process[^|;&]*(delete|terminate)",
    r"\bkill\s+(-\w+\s+)*-1\b",
    r"Get-Process\b[^;&]*\|\s*Stop-Process",
)]


class ToolError(Exception):
    pass


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    fn: object
    readonly: bool = False
    cap: int = 0

    def schema(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


@dataclass
class Ctx:
    session: object
    agent: object


def S(props: dict, req: list | None = None) -> dict:
    return {"type": "object", "properties": props, "required": req or []}


STR, INT, BOOL = {"type": "string"}, {"type": "integer"}, {"type": "boolean"}


def _resolve(ctx: Ctx, p: str) -> Path:
    path = Path(str(p)).expanduser()
    if not path.is_absolute():
        path = ctx.session.cwd / path
    return path.resolve()


def _guard_write(ctx: Ctx, path: Path) -> None:
    s = ctx.session
    if s.cfg["permission"] == "readonly":
        raise ToolError("read-only mode: writing is disabled.")
    inside = any(str(path).lower().startswith(str(root).lower()) for root in (s.cwd, s.dir))
    if not inside or s.cfg["permission"] == "ask":
        if not s.approve(f"Write to {path}?", tool="write", args={"path": str(path)}, can_always=inside):
            raise ToolError(f"write to {path} was not approved" + (f": {s.deny_message}" if s.deny_message
                            else " (outside the working directory or denied by the user)."))
    s.backup(path)


# ------------------------------------------------------------------ file tools
def t_read(ctx: Ctx, a: dict) -> str:
    path = _resolve(ctx, a["path"])
    if not path.is_file():
        near = [p.name for p in path.parent.glob("*")][:30] if path.parent.is_dir() else []
        raise ToolError(f"file not found: {a['path']}." + (f" Files in that directory: {', '.join(near)}" if near else ""))
    if media.kind_of(path) != "text":
        raise ToolError("binary media file — use perceive(path, question) to look at / listen to it.")
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    off = max(1, int(a.get("offset") or 1))
    lim = max(1, int(a.get("limit") or 300))
    chunk = lines[off - 1: off - 1 + lim]
    out = "\n".join(f"{i}\t{l[:1000]}" for i, l in enumerate(chunk, off))
    if off - 1 + lim < len(lines):
        out += f"\n[{len(lines)} lines total; continue with offset={off + lim}]"
    return out or "[empty file]"


def t_write(ctx: Ctx, a: dict) -> str:
    path = _resolve(ctx, a["path"])
    _guard_write(ctx, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if a.get("append") and path.is_file():
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(a["content"])
        ctx.session.touched(path)
        return f"Appended {len(a['content'].splitlines())} lines to {path.name} (now {len(path.read_text(encoding='utf-8', errors='replace').splitlines())} lines)."
    path.write_text(a["content"], encoding="utf-8", newline="\n")
    ctx.session.touched(path)
    return f"Wrote {path.name} ({len(a['content'].splitlines())} lines)."


def _fuzzy_span(text: str, old: str):
    """Match `old` ignoring per-line leading/trailing whitespace. Returns (start, end) or None."""
    tl, ol = text.splitlines(keepends=True), [l.strip() for l in old.strip("\n").splitlines()]
    if not ol:
        return None
    hits = [i for i in range(len(tl) - len(ol) + 1) if all(tl[i + k].strip() == ol[k] for k in range(len(ol)))]
    if len(hits) != 1:
        return None
    start = sum(len(l) for l in tl[:hits[0]])
    return start, start + sum(len(l) for l in tl[hits[0]:hits[0] + len(ol)])


def t_edit(ctx: Ctx, a: dict) -> str:
    path = _resolve(ctx, a["path"])
    if not path.is_file():
        raise ToolError(f"file not found: {a['path']} (use write to create files).")
    _guard_write(ctx, path)
    text = path.read_text(encoding="utf-8", errors="replace")
    old, new = a["old"], a["new"]
    if old == new:
        raise ToolError("old and new are identical.")
    n = text.count(old)
    if n == 1 or (n > 1 and a.get("all")):
        text = text.replace(old, new)
    elif n > 1:
        raise ToolError(f"`old` matches {n} places; add surrounding lines to make it unique, or pass all=true.")
    else:
        span = _fuzzy_span(text, old)
        if not span:
            first = next((l for l in old.splitlines() if l.strip()), old)
            close = difflib.get_close_matches(first.strip(), [l.strip() for l in text.splitlines()], n=3, cutoff=0.5)
            raise ToolError("`old` text not found in the file; it must match exactly. "
                            + (f"Closest lines: {close}. " if close else "") + "Read the file again and retry.")
        repl = new if new.endswith("\n") or not text[span[0]:span[1]].endswith("\n") else new + "\n"
        text, n = text[:span[0]] + repl + text[span[1]:], 1
    path.write_text(text, encoding="utf-8", newline="\n")
    ctx.session.touched(path)
    return f"Edited {path.name} ({n} replacement{'s' if n != 1 else ''})."


def _walk(root: Path):
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for f in fns:
            yield Path(dp) / f


def t_glob(ctx: Ctx, a: dict) -> str:
    root = _resolve(ctx, a.get("path") or ".")
    pat = a["pattern"]
    hits = [p for p in root.glob(pat) if not (set(p.relative_to(root).parts) & SKIP_DIRS)][:2000]
    hits.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    rel = [str(p.relative_to(root)).replace("\\", "/") + ("/" if p.is_dir() else "") for p in hits[:200]]
    return "\n".join(rel) + (f"\n[{len(hits)} matches, showing 200]" if len(hits) > 200 else "") if rel else "No matches."


def t_grep(ctx: Ctx, a: dict) -> str:
    root = _resolve(ctx, a.get("path") or ".")
    try:
        rx = re.compile(a["pattern"], re.I if a.get("ignore_case") else 0)
    except re.error as e:
        raise ToolError(f"invalid regex: {e}")
    files = [root] if root.is_file() else _walk(root)
    g, out, limit = a.get("glob"), [], int(a.get("max") or 60)
    for f in files:
        if g and not f.match(g):
            continue
        try:
            if f.stat().st_size > 2_000_000:
                continue
            with open(f, "r", encoding="utf-8", errors="strict") as fh:
                for i, line in enumerate(fh, 1):
                    if rx.search(line):
                        rel = f.relative_to(root) if root.is_dir() else f.name
                        out.append(f"{str(rel).replace(chr(92), '/')}:{i}: {line.strip()[:240]}")
                        if len(out) >= limit:
                            return "\n".join(out) + f"\n[stopped at {limit} matches; narrow the pattern or glob]"
        except (UnicodeDecodeError, OSError):
            continue
    return "\n".join(out) or "No matches."


# ----------------------------------------------------------------------- shell
def kill_tree(p: subprocess.Popen) -> None:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
        else:
            p.kill()
    except OSError:
        pass


def _bg_tail(log: Path, n: int = 6000) -> str:
    try:
        data = log.read_bytes()
    except OSError:
        return ""
    text = data.decode("utf-8", "replace").replace("\r\n", "\n")
    return ("[...]\n" if len(text) > n else "") + text[-n:]


def t_process(ctx: Ctx, a: dict) -> str:
    s, action = ctx.session, str(a.get("action") or "output").lower()
    if action == "list":
        return "\n".join(f"{k}: {'running' if v['p'].poll() is None else 'exited ' + str(v['p'].returncode)} — {v['cmd'][:80]}"
                         for k, v in s.bg.items()) or "No background processes."
    b = s.bg.get(str(a.get("id") or ""))
    if not b:
        raise ToolError(f"unknown process id. Known: {', '.join(s.bg) or '(none)'}")
    if action == "kill":
        kill_tree(b["p"])
        return f"Killed {a['id']}.\n{_bg_tail(b['log'], 1500)}"
    code = b["p"].poll()
    return f"[{'running' if code is None else 'exited with code ' + str(code)}]\n{_bg_tail(b['log'])}"


def t_note(ctx: Ctx, a: dict) -> str:
    ctx.session.add_note(a["text"])
    return "Noted."


def t_shell(ctx: Ctx, a: dict) -> str:
    s, cmd = ctx.session, a["command"]
    if s.cfg["permission"] == "readonly":
        raise ToolError("read-only mode: shell is disabled.")
    if any(rx.search(cmd) for rx in KILL_BY_NAME) and not (
            s.cfg["permission"] in ("ask", "edits") and s.approve("Kill processes BY NAME? " + cmd, tool="shell", args={"command": cmd}, can_always=False)):
        raise ToolError("blocked: this command kills processes by name, which would also kill unrelated programs on this machine. "
                        "The command was NOT run (none of it). Stop a server you started with process(action=\"kill\", id=...) "
                        "— start it with shell background=true — or kill one specific PID that you started.")
    risky = any(rx.search(cmd) for rx in DANGEROUS)
    if risky or s.cfg["permission"] in ("ask", "edits"):
        if not s.approve(f"Run {'RISKY ' if risky else ''}command?\n{cmd}", tool="shell", args={"command": cmd}, can_always=not risky):
            raise ToolError("command not approved" + (f": {s.deny_message}" if s.deny_message else
                            " (matched a destructive-command rule; needs explicit user approval)." if risky else "."))
    timeout = min(600, max(1, int(a.get("timeout") or s.cfg["shell_timeout"])))
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1", "PAGER": "cat", "GIT_PAGER": "cat", "CI": "1",
           # `python -m hangar studio ...` must work from any working directory, and report its spend to this session
           "PYTHONPATH": os.pathsep.join(x for x in (str(PKG_ROOT), os.environ.get("PYTHONPATH", "")) if x),
           "HANGAR_SESSION_DIR": str(s.dir)}
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    if a.get("background"):                              # servers, watchers, long builds: do not block the loop
        s.bg_n += 1
        pid = f"bg{s.bg_n}"
        (s.dir / "bg").mkdir(exist_ok=True)
        log = s.dir / "bg" / f"{pid}.log"
        fh = open(log, "wb")
        p = subprocess.Popen([*s.shell_argv, cmd], cwd=str(s.cwd), stdout=fh, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, env=env, creationflags=flags)
        s.bg[pid] = {"p": p, "log": log, "cmd": cmd, "fh": fh}
        time.sleep(1.5)
        state = "running" if p.poll() is None else f"already exited with code {p.returncode}"
        return (f"Started background process {pid} ({state}).\n{_bg_tail(log, 1500)}\n"
                f"Read its output with process(action=\"output\", id=\"{pid}\"); stop it with process(action=\"kill\", id=\"{pid}\").")
    p = subprocess.Popen([*s.shell_argv, cmd], cwd=str(s.cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, env=env, creationflags=flags)
    s.current_proc = p
    try:
        raw, _ = p.communicate(timeout=timeout)
        tail = f"[exit {p.returncode}]" if not s.abort.is_set() else "[interrupted by the user]"
        s.last_exit = p.returncode
    except subprocess.TimeoutExpired:
        s.last_exit = -1
        kill_tree(p)
        try:
            raw, _ = p.communicate(timeout=5)
        except Exception:
            raw = b""
        tail = f"[timed out after {timeout}s and was killed; for servers or long jobs use background=true and poll with the process tool]"
    s.edits_since_run = False
    return (raw.decode("utf-8", "replace").replace("\r\n", "\n").rstrip() + "\n" + tail).lstrip()


# ------------------------------------------------------------------------- web
class _Text(html.parser.HTMLParser):
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "pre", "section", "article", "table"}

    def __init__(self):
        super().__init__()
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg", "head"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg", "head"):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip and data.strip():
            self.out.append(data.strip() + " ")


def _http_get(url: str, timeout: int = 25) -> tuple[str, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; HangarHarness/0.1)", "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(3_000_000).decode(r.headers.get_content_charset() or "utf-8", "replace"), r.headers.get("Content-Type", "")


def t_web_fetch(ctx: Ctx, a: dict) -> str:
    url = a["url"] if re.match(r"^https?://", a["url"]) else "https://" + a["url"]
    try:
        body, ctype = _http_get(url)
    except Exception as e:
        raise ToolError(f"fetch failed: {e}")
    if "html" in ctype or body.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        p = _Text()
        p.feed(body)
        body = re.sub(r"\n\s*\n+", "\n", "".join(p.out)).strip()
    return body or "[empty response]"


def t_web_search(ctx: Ctx, a: dict) -> str:
    try:
        body, _ = _http_get("https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(a["query"]))
    except Exception as e:
        raise ToolError(f"search failed: {e}")
    out = []
    for m in re.finditer(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>(?:.*?class="result__snippet"[^>]*>(.*?)</a>)?', body, re.S):
        href = m.group(1)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        href = q.get("uddg", [href])[0]
        strip = lambda x: re.sub(r"<[^>]+>", "", x or "").strip()
        out.append(f"{strip(m.group(2))}\n  {href}\n  {strip(m.group(3))}")
        if len(out) >= 8:
            break
    return "\n".join(out) or "No results."


# ------------------------------------------------------------- agentic helpers
def t_perceive(ctx: Ctx, a: dict) -> str:
    return media.describe(ctx.session, _resolve(ctx, a["path"]), a.get("question") or "Describe this in full detail.")


def t_ask_user(ctx: Ctx, a: dict) -> str:
    ans = ctx.session.ask(a["question"], a.get("options") or [])
    if ans is None:
        return "No user is available to answer. Choose the most reasonable assumption, state it in your final answer, and continue."
    return f"User answered: {ans}"


def t_plan(ctx: Ctx, a: dict) -> str:
    items = []
    for it in a["items"]:
        if isinstance(it, str):
            it = {"step": it, "status": "pending"}
        if isinstance(it, dict):
            st = str(it.get("status") or "pending").lower().replace(" ", "_")
            st = {"completed": "done", "complete": "done", "doing": "in_progress", "todo": "pending"}.get(st, st)
            items.append({"step": str(it.get("step") or it.get("content") or it.get("task") or "")[:200],
                          "status": st if st in ("pending", "in_progress", "done") else "pending"})
    ctx.session.plan = items
    ctx.session.bus.emit("plan", items=items, agent=ctx.agent.name)
    return "Plan saved."


def t_task(ctx: Ctx, a: dict) -> str:
    from .agent import Agent
    s = ctx.session
    s.sub_count += 1
    sub = Agent(s, model=ctx.agent.model, role="sub", toolset="all", name=f"sub{s.sub_count}", max_steps=20)
    out = sub.run(a["prompt"] + "\n\nReturn a concise report (under 400 words) with exact paths/values the caller needs.")
    return out[:8000]


def t_skill(ctx: Ctx, a: dict) -> str:
    return skills_mod.load(ctx.session.skills, a["name"])


def t_tool_search(ctx: Ctx, a: dict) -> str:
    hits = ctx.session.mcp.search(a["query"])
    if not hits:
        return "No matching tools."
    return "\n".join(json.dumps({"name": f"{srv}__{t['name']}", "description": (t.get("description") or "")[:300],
                                 "arguments": t.get("inputSchema", {}).get("properties", {}),
                                 "required": t.get("inputSchema", {}).get("required", [])}, ensure_ascii=False) for srv, t in hits)


def t_mcp_call(ctx: Ctx, a: dict) -> str:
    return ctx.session.mcp.call(a["name"], a.get("arguments") or {})


# --------------------------------------------------------------------- registry
def builtin() -> dict[str, Tool]:
    T = [
        Tool("read", "Read a text file with line numbers.", S({"path": STR, "offset": INT, "limit": INT}, ["path"]), t_read, True, 16000),
        Tool("write", "Create or overwrite a file. For files over ~150 lines write the first part, then the rest with append=true.",
             S({"path": STR, "content": STR, "append": BOOL}, ["path", "content"]), t_write),
        Tool("edit", "Replace an exact snippet in a file. `old` must match the file text uniquely.",
             S({"path": STR, "old": STR, "new": STR, "all": BOOL}, ["path", "old", "new"]), t_edit),
        Tool("glob", "Find files by glob pattern (e.g. **/*.py), newest first.", S({"pattern": STR, "path": STR}, ["pattern"]), t_glob, True),
        Tool("grep", "Regex search in file contents. Returns path:line: text.",
             S({"pattern": STR, "path": STR, "glob": STR, "ignore_case": BOOL, "max": INT}, ["pattern"]), t_grep, True),
        Tool("shell", "Run a shell command in the working directory; returns output and exit code. background=true for servers/long jobs.",
             S({"command": STR, "timeout": INT, "background": BOOL}, ["command"]), t_shell),
        Tool("process", "Manage background processes: action = output | kill | list.", S({"action": STR, "id": STR}, ["action"]), t_process),
        Tool("note", "Save a durable fact or decision; notes survive context compaction and resume.", S({"text": STR}, ["text"]), t_note),
        Tool("web_fetch", "Fetch a URL and return its text.", S({"url": STR}, ["url"]), t_web_fetch, True),
        Tool("web_search", "Search the web; returns titles, URLs and snippets.", S({"query": STR}, ["query"]), t_web_search, True),
        Tool("perceive", "Look at / listen to an image, audio, video or PDF file and answer a question about it.",
             S({"path": STR, "question": STR}, ["path", "question"]), t_perceive, True),
        Tool("ask_user", "Ask the user one question when essential information is missing and cannot be found with tools.",
             S({"question": STR, "options": {"type": "array", "items": STR}}, ["question"]), t_ask_user),
        Tool("plan", "Create/update the task plan. Statuses: pending, in_progress, done.",
             S({"items": {"type": "array", "items": S({"step": STR, "status": STR}, ["step", "status"])}}, ["items"]), t_plan),
        Tool("task", "Delegate a self-contained sub-task to a fresh sub-agent; returns only its report.",
             S({"prompt": STR}, ["prompt"]), t_task, True),
    ]
    return {t.name: t for t in T}


READONLY_SET = ("read", "glob", "grep", "web_fetch", "web_search", "perceive", "skill")
ALIASES = {"read_file": "read", "cat": "read", "view": "read", "open": "read", "write_file": "write", "create_file": "write",
           "edit_file": "edit", "str_replace": "edit", "replace": "edit", "apply_patch": "edit", "bash": "shell", "run": "shell",
           "exec": "shell", "execute": "shell", "run_command": "shell", "terminal": "shell", "powershell": "shell", "cmd": "shell",
           "ls": "glob", "list_files": "glob", "find": "glob", "search": "grep", "search_files": "grep", "fetch": "web_fetch",
           "ask": "ask_user", "ask_question": "ask_user", "todo": "plan", "update_plan": "plan", "todo_write": "plan",
           "view_image": "perceive", "see": "perceive", "subagent": "task"}


def select(session, toolset: str, tier: str, role: str) -> list[Tool]:
    """Tool catalog narrowed by role and by model tier (weak models get fewer, simpler tools)."""
    b = builtin()
    names = list(b)
    if toolset == "readonly":
        names = [n for n in names if n in READONLY_SET]
    elif toolset == "verify":
        names = [n for n in names if n in READONLY_SET or n in ("shell", "process")]
    if role != "main":
        names = [n for n in names if n not in ("task", "ask_user", "plan", "note")]
    if tier == "weak":
        names = [n for n in names if n not in ("task", "note")]   # delegation is below the capability floor; fewer tools = fewer mistakes
    if session.interactive == "none" and session.answers is None:
        names = [n for n in names if n != "ask_user"]
    tools = [b[n] for n in names]
    if session.skills and toolset != "verify":
        tools.append(Tool("skill", "Load the full instructions of a listed skill.", S({"name": STR}, ["name"]), t_skill, True, 20000))
    if toolset == "all" and session.mcp.servers:
        every = session.mcp.all_tools()
        if len(every) <= session.cfg["mcp_inline_max"]:
            for srv, t in every:
                q = f"mcp__{srv}__{t['name']}"
                tools.append(Tool(q, (t.get("description") or t["name"])[:240],
                                  t.get("inputSchema") or S({}), (lambda ctx, a, q=q: ctx.session.mcp.call(q, a))))
        elif every:
            tools.append(Tool("tool_search", "Find MCP tools by keyword; returns exact names and argument schemas.",
                              S({"query": STR}, ["query"]), t_tool_search, True))
            tools.append(Tool("mcp_call", "Call an MCP tool by the exact name returned by tool_search.",
                              S({"name": STR, "arguments": {"type": "object"}}, ["name"]), t_mcp_call))
    return tools
