"""Diagnostics right after a write or edit: what an editor would underline, handed back in the same tool result.

No language server and no dependency: Python is checked in-process (syntax, then names that are never assigned or imported
anywhere in the file), JSON and TOML are parsed, JavaScript goes through `node --check` when node is on PATH. The point is
the cost: a broken file is found in the turn that broke it, not after a test run that pays for the whole context again."""
from __future__ import annotations

import ast
import builtins
import json
import shutil
import subprocess
import symtable
import tomllib
from pathlib import Path

MAX_BYTES = 400_000
MAX_LINES = 6
IMPLICIT = {"__file__", "__name__", "__doc__", "__spec__", "__builtins__", "__path__", "__package__", "__loader__", "__debug__",
            "__annotations__", "__dict__", "__class__", "__qualname__", "__module__", "WindowsError", "reveal_type"}
# a module that builds its own namespace cannot be judged by reading it
DYNAMIC = ("globals()", "exec(", "eval(", "__getattr__", "setattr(", "vars()", "locals()")


def _python(path: Path, src: str) -> list[str]:
    try:
        tree = ast.parse(src, filename=path.name)
        top = symtable.symtable(src, path.name, "exec")
    except SyntaxError as e:
        return [f"{path.name}:{e.lineno or 0}:{e.offset or 0}: syntax error: {e.msg}"]
    except (ValueError, RecursionError) as e:
        return [f"{path.name}: cannot be parsed: {e}"]
    if any(d in src for d in DYNAMIC) or any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree)):
        return []
    defined, used = set(dir(builtins)) | IMPLICIT, set()

    def walk(t) -> None:
        for s in t.get_symbols():
            name = s.get_name()
            if s.is_assigned() or s.is_imported() or s.is_namespace() or s.is_parameter():
                if t is top or s.is_global():            # only what lands in the module namespace
                    defined.add(name)
            if s.is_referenced() and (s.is_global() if t is not top else True) and not (s.is_parameter() or (t is not top and s.is_local())):
                used.add(name)
        for c in t.get_children():
            walk(c)
    walk(top)
    missing = used - defined
    if not missing:
        return []
    first: dict[str, int] = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id in missing:
            first[n.id] = min(first.get(n.id, n.lineno), n.lineno)
    return [f"{path.name}:{line}: undefined name '{name}' (never assigned or imported in this file)"
            for name, line in sorted(first.items(), key=lambda kv: kv[1])]


def _node(path: Path) -> list[str]:
    exe = shutil.which("node")
    if not exe:
        return []
    try:
        r = subprocess.run([exe, "--check", str(path)], capture_output=True, text=True, timeout=10, encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return []
    if r.returncode == 0:
        return []
    lines = [l for l in r.stderr.splitlines() if l.strip()]
    where = next((l.rsplit(":", 1)[-1] for l in lines if l.strip().startswith(str(path)) or path.name + ":" in l), "0")
    msg = next((l.strip() for l in lines if "Error" in l), "syntax error")
    return [f"{path.name}:{where.strip()}: {msg}"]


def check(path: Path) -> list[str]:
    """Problems in the file as `name:line: message` lines; empty when it is fine or cannot be judged."""
    path = Path(path)
    suffix = path.suffix.lower()
    try:
        if suffix not in (".py", ".pyw", ".json", ".toml", ".js", ".mjs", ".cjs") or path.stat().st_size > MAX_BYTES:
            return []
        src = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return []
    try:
        if suffix in (".py", ".pyw"):
            out = _python(path, src)
        elif suffix == ".json":
            try:
                json.loads(src)
                out = []
            except ValueError as e:
                out = [f"{path.name}:{getattr(e, 'lineno', 0)}:{getattr(e, 'colno', 0)}: invalid JSON: {getattr(e, 'msg', e)}"]
        elif suffix == ".toml":
            try:
                tomllib.loads(src)
                out = []
            except tomllib.TOMLDecodeError as e:
                out = [f"{path.name}: invalid TOML: {e}"]
        else:
            out = _node(path)
    except Exception:                                    # a checker must never break the tool it rides on
        return []
    return out[:MAX_LINES] + ([f"... and {len(out) - MAX_LINES} more"] if len(out) > MAX_LINES else [])


def note(session, path: Path, partial: bool = False) -> str:
    """The text appended to a write/edit result, or "" when there is nothing to say."""
    if not session.cfg.get("diagnostics", True):
        return ""
    found = check(path)
    if not found:
        return ""
    session.bus.emit("notice", level="info", text=f"diagnostics: {Path(path).name}: {len(found)} problem{'s' if len(found) != 1 else ''}")
    return ("\n[diagnostics] " + "\n[diagnostics] ".join(found)
            + ("\nIf you are still writing this file in parts, finish it; otherwise fix this before running anything." if partial
               else "\nFix this before running anything."))
