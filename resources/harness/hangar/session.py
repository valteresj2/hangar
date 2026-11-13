"""A session = one task run: its directory, event log, budgets, user channel and shared services."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import sys
import threading
import time
from pathlib import Path

from . import machine, skills as skills_mod
from .config import HOME
from .events import EventBus
from .llm import LLM
from .mcp import MCPManager
from .models import Catalog

SESSIONS = HOME / "sessions"


class Stopped(Exception):
    pass


class Session:
    def __init__(self, cfg: dict, cwd: Path, task: str = "", model: str | None = None, workflow: str = "loop",
                 interactive: str = "none", answers: list | None = None, sid: str | None = None):
        self.cfg = cfg
        self.cwd = Path(cwd).resolve()
        self.model = model or cfg["model"]
        self.workflow = workflow
        self.interactive = interactive          # none | tty | ui
        self.answers = list(answers) if answers is not None else None
        self.id = sid or time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
        self.dir = SESSIONS / self.id
        (self.dir / "spill").mkdir(parents=True, exist_ok=True)
        (self.dir / "answers").mkdir(exist_ok=True)
        self.bus = EventBus(self.dir)
        self.catalog = Catalog(cfg)
        self.team: dict[str, str] | None = None
        if self.model == "auto":                   # the harness picks who does what (router.py)
            from . import router
            self.team = router.apply(cfg, self.catalog)
            self.model = self.team["worker"]
            self.bus.emit("team", team=router.describe(self.team))
        self.llm = LLM(cfg, self.catalog, self.bus, session_id=self.id)
        self.machine = machine.probe()
        bash = self.machine.get("bash") if cfg["shell"] in ("auto", "bash") else ""
        if os.name != "nt":
            self.shell_name, self.shell_argv = "bash", [bash or "/bin/sh", "-c"]
        elif bash:
            self.shell_name, self.shell_argv = "bash (Git Bash on Windows; POSIX syntax, forward slashes)", [bash, "-c"]
        else:
            self.shell_name, self.shell_argv = "Windows PowerShell 5.1 (no &&; use ;)", ["powershell", "-NoProfile", "-NonInteractive", "-Command"]
        self.skills = skills_mod.discover(self.cwd, cfg.get("skills_dirs"))
        self.mcp = MCPManager(self.cwd, self.bus)
        self.tool_mode: dict[str, str] = {}
        self.perception_cache: dict[str, str] = {}
        self.plan: list = []
        self.files: set[str] = set()
        self.edits_since_run = False
        self.last_exit: int | None = None
        self.abort = threading.Event()             # set by the host to stop the turn in flight
        self.always: set[str] = set()              # tools the user allowed for the rest of the session
        self.channel = None                        # bridge mode: answers from the host (see bridge.py)
        self.current_proc = None                   # the foreground shell command, so an interrupt can kill it
        self.deny_message = ""
        self.llm.abort = self.abort
        self.incomplete = ""
        self.sub_count = 0
        self.spill_n = 0
        self.q_n = 0
        self.started = time.time()
        self.totals = {"cost": 0.0, "prompt": 0, "completion": 0, "cached": 0, "cache_write": 0, "reasoning": 0,
                       "llm_calls": 0, "tool_calls": 0, "tool_errors": 0, "questions": 0}
        self.by_model: dict[str, dict] = {}
        self.bg: dict[str, dict] = {}
        self.bg_n = 0
        self.notes: list[str] = []
        self.backups: dict[str, str | None] = {}
        self.meta = {"id": self.id, "task": task[:2000], "model": self.model, "workflow": workflow, "cwd": str(self.cwd),
                     "pid": os.getpid(), "started": self.started, "status": "running"}
        self._restore()
        self._save_meta()
        from .hooks import Hooks
        self.hooks = Hooks(self)

    def _restore(self) -> None:
        """Resuming an existing session id: keep its accumulated totals, notes and undo manifest."""
        try:
            old = json.loads((self.dir / "meta.json").read_text(encoding="utf-8"))
            for k, v in (old.get("totals") or {}).items():
                if k in self.totals:
                    self.totals[k] = v
            self.by_model = old.get("by_model") or {}
            self.meta["task"] = old.get("task") or self.meta["task"]
            self.meta["resumed"] = int(old.get("resumed") or 0) + 1
        except (OSError, ValueError):
            return
        try:
            self.backups = json.loads((self.dir / "backup" / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        try:
            self.notes = [n for n in (self.dir / "notes.md").read_text(encoding="utf-8").split("\n- ") if n.strip()]
        except OSError:
            pass

    # ------------------------------------------------------- durable state
    def add_note(self, text: str) -> None:
        self.notes.append(text.strip()[:1000])
        (self.dir / "notes.md").write_text("\n- " + "\n- ".join(self.notes), encoding="utf-8")
        self.bus.emit("note", text=text.strip()[:1000])

    def backup(self, path: Path) -> None:
        """Keep the original of every file the agent changes, once, so `hangar undo` can restore it."""
        key = str(path)
        if key in self.backups:
            return
        d = self.dir / "backup"
        d.mkdir(exist_ok=True)
        if path.is_file():
            name = f"{len(self.backups):04d}_{path.name}"
            try:
                shutil.copy2(path, d / name)
            except OSError:
                return
            self.backups[key] = name
        else:
            self.backups[key] = None                    # did not exist: undo deletes it
        (d / "manifest.json").write_text(json.dumps(self.backups, ensure_ascii=False), encoding="utf-8")

    def sticky(self) -> str:
        """State re-injected after compaction: cheap, deterministic, and never summarised away."""
        parts = []
        if self.plan:
            parts.append("PLAN:\n" + "\n".join(f"- [{i['status']}] {i['step']}" for i in self.plan))
        if self.notes:
            parts.append("NOTES YOU SAVED:\n" + "\n".join(f"- {n}" for n in self.notes[-30:]))
        if self.files:
            parts.append("FILES YOU CHANGED: " + ", ".join(sorted(self.files)[:60]))
        live = [f"{k} ({v['cmd'][:60]})" for k, v in self.bg.items() if v["p"].poll() is None]
        if live:
            parts.append("BACKGROUND PROCESSES STILL RUNNING: " + ", ".join(live))
        return "\n".join(parts)

    # ------------------------------------------------------------- bookkeeping
    def _save_meta(self) -> None:
        (self.dir / "meta.json").write_text(json.dumps({**self.meta, "totals": self.totals, "by_model": self.by_model},
                                                       ensure_ascii=False), encoding="utf-8")

    def add_usage(self, reply, model: str, agent: str) -> None:
        u = reply.usage
        for k in ("cost", "prompt", "completion", "cached", "cache_write", "reasoning"):
            self.totals[k] += u.get(k, 0)
        self.totals["llm_calls"] += 1
        m = self.by_model.setdefault(model, {"cost": 0.0, "prompt": 0, "completion": 0, "cached": 0, "calls": 0})
        for k in ("cost", "prompt", "completion", "cached"):
            m[k] += u.get(k, 0)
        m["calls"] += 1
        self.bus.emit("llm_end", model=model, agent=agent, ms=reply.ms, finish=reply.finish, usage=u,
                      totals={**self.totals, "cost": round(self.totals["cost"], 6)})
        self._save_meta()

    def touched(self, path: Path) -> None:
        try:
            self.files.add(str(path.relative_to(self.cwd)).replace("\\", "/"))
        except ValueError:
            self.files.add(str(path))
        self.edits_since_run = True

    def over_budget(self) -> bool:
        return self.totals["cost"] >= self.cfg["max_cost_usd"]

    def check_stop(self) -> None:
        if self.abort.is_set() or (self.dir / "stop").exists():
            raise Stopped("stopped by user")

    def interrupt(self) -> None:
        """Stop the turn in flight: the model stream, the running command and anything waiting on the user."""
        self.abort.set()
        p = self.current_proc
        if p is not None and p.poll() is None:
            from .tools import kill_tree
            kill_tree(p)

    def cap(self, text: str, tool: str, limit: int = 0) -> str:
        """Tier-0 context economy: keep head+tail in context, park the full output on disk."""
        limit = limit or self.cfg["tool_output_cap"]
        if len(text) <= limit:
            return text
        self.spill_n += 1
        f = self.dir / "spill" / f"{self.spill_n:03d}_{tool}.txt"
        f.write_text(text, encoding="utf-8")
        head, tail = int(limit * 0.6), int(limit * 0.35)
        return (f"{text[:head]}\n[... {len(text) - head - tail} chars omitted. Full output: {f} "
                f"— use grep or read with offset on it for details ...]\n{text[-tail:]}")

    # ------------------------------------------------------------ user channel
    def ask(self, question: str, options: list | None = None, kind: str = "question") -> str | None:
        self.q_n += 1
        qid = f"q{self.q_n}"
        self.totals["questions"] += 1
        self.bus.emit("question", qid=qid, question=question, options=options or [], kind=kind)
        ans: str | None = None
        if self.answers is not None:
            ans = self.answers.pop(0) if self.answers else None
        elif self.interactive == "bridge" and self.channel is not None:
            ans = (self.channel.wait(qid, self.abort) or {}).get("answer")
        elif self.interactive == "tty":
            try:
                print(f"\n\033[33m? {question}\033[0m" + (f"\n  options: {' | '.join(options)}" if options else ""), file=sys.stderr)
                ans = input("> ").strip() or None
            except (EOFError, KeyboardInterrupt):
                ans = None
        elif self.interactive == "ui":
            f, deadline = self.dir / "answers" / f"{qid}.json", time.time() + self.cfg["ask_timeout"]
            self.meta["status"] = "waiting"
            self._save_meta()
            while time.time() < deadline:
                if f.is_file():
                    try:
                        ans = json.loads(f.read_text(encoding="utf-8")).get("answer")
                        break
                    except ValueError:
                        pass
                if (self.dir / "stop").exists():
                    break
                time.sleep(0.4)
            self.meta["status"] = "running"
            self._save_meta()
        self.bus.emit("answer", qid=qid, answer=ans)
        return ans

    def approve(self, what: str, tool: str = "", args: dict | None = None, can_always: bool = True) -> bool:
        """Ask the user before a consequential action. In bridge mode this is a structured permission request."""
        self.deny_message = ""
        if tool and can_always and tool in self.always:
            return True
        if self.interactive == "bridge" and self.channel is not None:
            self.q_n += 1
            qid = f"p{self.q_n}"
            self.bus.emit("permission", qid=qid, tool=tool or "action", args=args or {}, title=what, can_always=bool(tool and can_always))
            resp = self.channel.wait(qid, self.abort) or {"decision": "deny", "message": "interrupted"}
            decision = str(resp.get("decision") or "deny")
            self.bus.emit("permission_result", qid=qid, decision=decision)
            if decision == "allow_always" and tool and can_always:
                self.always.add(tool)
            self.deny_message = str(resp.get("message") or "")
            return decision in ("allow", "allow_always")
        ans = self.ask(what, ["yes", "no"], kind="approval")
        return bool(ans) and ans.strip().lower() in ("y", "yes", "s", "sim", "ok", "approve", "allow")

    def _external_usage(self) -> None:
        """Money spent by `hangar studio` commands the agent ran (image generation) belongs in this session's bill."""
        try:
            rows = [json.loads(l) for l in (self.dir / "studio_usage.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        except (OSError, ValueError):
            return
        for r in rows:
            self.totals["cost"] += float(r.get("cost") or 0)
            m = self.by_model.setdefault(r.get("model", "studio"), {"cost": 0.0, "prompt": 0, "completion": 0, "cached": 0, "calls": 0})
            m["cost"] += float(r.get("cost") or 0)
            m["calls"] += 1
        (self.dir / "studio_usage.jsonl").rename(self.dir / "studio_usage.counted.jsonl")

    def finish(self, status: str, final: str = "") -> dict:
        self._external_usage()
        self.meta.update(status=status, ended=time.time(), final=final[:4000])
        summary = {"session": self.id, "status": status, "model": self.model, "workflow": self.workflow,
                   "duration_s": round(time.time() - self.started, 1), "files": sorted(self.files),
                   **{k: (round(v, 6) if isinstance(v, float) else v) for k, v in self.totals.items()},
                   "by_model": self.by_model, "final": final, "log": str(self.dir / "events.jsonl")}
        self.bus.emit("session_end", **{k: v for k, v in summary.items() if k != "final"})
        self._save_meta()
        (self.dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
        from .tools import kill_tree
        for b in self.bg.values():                      # never leave servers behind
            if b["p"].poll() is None:
                kill_tree(b["p"])
            try:
                b["fh"].close()
            except OSError:
                pass
        self.mcp.stop()
        self.bus.close()
        return summary
