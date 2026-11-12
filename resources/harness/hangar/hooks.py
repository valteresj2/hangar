"""In-loop middleware: rules and plugins that run around every tool call and before the agent may finish.
This is where project policy lives, so it never has to be argued with the model in a prompt.

Declarative rules (hangar.toml):
    [[hooks]]
    event   = "pre_tool"            # pre_tool | post_tool | pre_finish | session_end
    tool    = "shell"               # optional regex on the tool name
    match   = "git\\s+commit"       # optional regex on the JSON arguments (or on the final answer for pre_finish)
    action  = "deny"                # deny | ask | warn | run
    message = "Commits are made by humans in this repo."
    command = "python -m ruff check ."   # action = "run": non-zero exit blocks (pre_*) or is reported (post_tool)

Python plugins (~/.hangar/plugins/*.py, and <project>/.hangar/plugins/*.py when the project is trusted) may define:
    pre_tool(ctx, name, args)              -> None | str   (a string denies the call with that message)
    post_tool(ctx, name, args, ok, output) -> None | str   (a string is appended to what the model sees)
    pre_finish(ctx, text)                  -> None | str   (a string sends the agent back to work)
    session_end(ctx, summary)              -> None

Trust: rules that only restrict (deny / ask / warn) are always honoured. Anything that executes code from the project
folder (action = "run", Python plugins) needs `--trust-project` or the folder listed in `trusted_projects` in ~/.hangar/config.toml."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace

from .config import HOME

EVENTS = ("pre_tool", "post_tool", "pre_finish", "session_end")
MAX_FINISH_PUSHES = 3


class Hooks:
    def __init__(self, session):
        self.s = session
        cfg = session.cfg
        cwd = str(session.cwd)
        self.trusted = bool(cfg.get("trust_project")) or any(
            os.path.normcase(os.path.abspath(str(p))) == os.path.normcase(cwd) for p in cfg.get("trusted_projects") or [])
        self.rules, skipped = [], 0
        for r in cfg.get("hooks") or []:
            if not isinstance(r, dict) or r.get("event") not in EVENTS:
                continue
            if r.get("action") == "run" and r.get("_source") == "project" and not self.trusted:
                skipped += 1
                continue
            try:
                self.rules.append({**r, "_tool": re.compile(r["tool"]) if r.get("tool") else None,
                                   "_match": re.compile(r["match"], re.I | re.S) if r.get("match") else None})
            except re.error as e:
                session.bus.emit("notice", level="warn", text=f"hook ignored (bad regex): {e}")
        self.plugins = []
        dirs = [HOME / "plugins"] + ([session.cwd / ".hangar" / "plugins"] if self.trusted else [])
        for d in dirs:
            for f in sorted(d.glob("*.py")) if d.is_dir() else []:
                try:
                    spec = importlib.util.spec_from_file_location(f"hangar_plugin_{f.stem}", f)
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)
                    self.plugins.append(mod)
                except Exception as e:
                    session.bus.emit("notice", level="warn", text=f"plugin {f.name} failed to load: {type(e).__name__}: {e}")
        if not self.trusted and (skipped or (session.cwd / ".hangar" / "plugins").is_dir()):
            session.bus.emit("notice", level="info", text="project hooks that execute code were skipped: this folder is not trusted "
                                                         "(use --trust-project or trusted_projects in ~/.hangar/config.toml)")
        self.finish_pushes = 0
        self.active = bool(self.rules or self.plugins)
        self.ctx = SimpleNamespace(cwd=session.cwd, session_id=session.id, model=session.model, session=session,
                                   note=lambda text: session.bus.emit("notice", level="info", text=str(text)))

    # ------------------------------------------------------------------ helpers
    def _hits(self, event: str, name: str, text: str):
        for r in self.rules:
            if r["event"] == event and (not r["_tool"] or r["_tool"].fullmatch(name or "")) and (not r["_match"] or r["_match"].search(text)):
                yield r

    def _run(self, r: dict, extra_env: dict | None = None) -> tuple[int, str]:
        env = {**os.environ, "HANGAR_SESSION": self.s.id, "PYTHONIOENCODING": "utf-8", **(extra_env or {})}
        try:
            p = subprocess.run([*self.s.shell_argv, r["command"]], cwd=str(self.s.cwd), capture_output=True, env=env,
                               stdin=subprocess.DEVNULL, timeout=int(r.get("timeout", 120)))
            out = (p.stdout + p.stderr).decode("utf-8", "replace").replace("\r\n", "\n").strip()
            return p.returncode, out[-3000:]
        except subprocess.TimeoutExpired:
            return -1, f"timed out after {r.get('timeout', 120)}s"
        except OSError as e:
            return -1, str(e)

    def _plugins(self, fn: str, *args):
        for mod in self.plugins:
            f = getattr(mod, fn, None)
            if not callable(f):
                continue
            try:
                out = f(self.ctx, *args)
            except Exception as e:                      # a broken plugin must not break the run
                self.s.bus.emit("notice", level="warn", text=f"plugin {mod.__name__}.{fn} raised {type(e).__name__}: {e}")
                continue
            if isinstance(out, str) and out.strip():
                yield out.strip()

    def _log(self, event: str, action: str, name: str, message: str) -> None:
        self.s.bus.emit("hook", event=event, action=action, tool=name, message=message[:400])

    # ------------------------------------------------------------------- events
    def pre_tool(self, agent, name: str, args: dict) -> str:
        """Returns a denial message, or '' to let the call through."""
        if not self.active:
            return ""
        text = json.dumps(args, ensure_ascii=False, default=str)
        for r in self._hits("pre_tool", name, text):
            act, msg = r.get("action", "deny"), r.get("message") or "blocked by a project rule"
            if act == "deny":
                self._log("pre_tool", "deny", name, msg)
                return f"blocked by project policy: {msg}"
            if act == "ask" and not self.s.approve(f"{msg}\n{name} {text[:600]}", tool=name, args=args, can_always=False):
                self._log("pre_tool", "deny", name, msg)
                return f"not approved by the user: {msg}"
            if act == "run":
                code, out = self._run(r, {"HANGAR_TOOL": name, "HANGAR_ARGS": text[:8000]})
                if code != 0:
                    self._log("pre_tool", "deny", name, out)
                    return f"blocked by project check `{r['command']}` (exit {code}): {out}"
        for msg in self._plugins("pre_tool", name, args):
            self._log("pre_tool", "deny", name, msg)
            return f"blocked by plugin: {msg}"
        return ""

    def post_tool(self, agent, name: str, args: dict, ok: bool, output: str) -> str:
        """Returns text appended to the tool result (what the model reads next)."""
        if not self.active:
            return ""
        text, extra = json.dumps(args, ensure_ascii=False, default=str), []
        for r in self._hits("post_tool", name, text):
            if r.get("action") == "run":
                code, out = self._run(r, {"HANGAR_TOOL": name, "HANGAR_ARGS": text[:8000], "HANGAR_PATH": str(args.get("path", ""))})
                if code != 0 or r.get("always"):
                    extra.append(f"[project check `{r['command']}` exit {code}]\n{out}")
                    self._log("post_tool", "run", name, f"exit {code}")
            elif r.get("message"):
                extra.append(f"[project rule] {r['message']}")
                self._log("post_tool", "warn", name, r["message"])
        extra += [f"[plugin] {m}" for m in self._plugins("post_tool", name, args, ok, output)]
        return ("\n" + "\n".join(extra)) if extra else ""

    def pre_finish(self, agent, text: str) -> str:
        """Returns a message that sends the agent back to work, or '' to accept the final answer."""
        if not self.active:
            return ""
        problems = []
        for r in self._hits("pre_finish", "", text or ""):
            if r.get("action") == "run":
                code, out = self._run(r)
                if code != 0:
                    problems.append(f"Required check `{r['command']}` failed (exit {code}):\n{out}")
            elif r.get("message") and not r.get("_said"):
                r["_said"] = True                         # advisory rules speak once
                problems.append(r["message"])
        problems += list(self._plugins("pre_finish", text))
        if not problems:
            return ""
        self.finish_pushes += 1
        self._log("pre_finish", "push", "", problems[0])
        if self.finish_pushes > MAX_FINISH_PUSHES:
            self.s.incomplete = "a required project check was still failing when the agent stopped"
            return ""
        return ("You may not finish yet — this project requires the following before a task is done:\n"
                + "\n\n".join(problems) + "\n\nFix it, then give your final answer again.")

    def session_end(self, summary: dict) -> None:
        if not self.active:
            return
        for r in self._hits("session_end", "", summary.get("status", "")):
            if r.get("action") == "run":
                code, out = self._run(r, {"HANGAR_STATUS": summary.get("status", "")})
                self._log("session_end", "run", "", f"`{r['command']}` exit {code}: {out[:200]}")
        list(self._plugins("session_end", summary))

    def describe(self) -> list[str]:
        out = [f"{r['event']:11s} {r.get('action', 'deny'):5s} tool={r.get('tool', '*')} match={r.get('match', '*')} "
               f"{r.get('command') or r.get('message') or ''} [{r.get('_source', '?')}]" for r in self.rules]
        return out + [f"plugin      {Path(m.__file__).name}: " + ", ".join(e for e in EVENTS if callable(getattr(m, e, None))) for m in self.plugins]
