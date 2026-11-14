"""hangar CLI: run | chat | ui | backlog | sessions | models | mcp | doctor"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from . import __version__, config, machine
from .models import Catalog

C = {"dim": "\033[2m", "cyan": "\033[36m", "green": "\033[32m", "red": "\033[31m", "yellow": "\033[33m", "bold": "\033[1m", "off": "\033[0m"}


def _printer(quiet: bool):
    """Console view of the same event stream the dashboard reads."""
    state = {"stream": False}
    out = sys.stderr

    def p(rec: dict) -> None:
        t = rec["type"]
        if t == "delta":
            if not quiet and rec["kind"] == "text":
                out.write(rec["text"])
                out.flush()
                state["stream"] = True
            return
        if state["stream"]:
            out.write("\n")
            state["stream"] = False
        if t == "session_start":
            print(f"{C['bold']}hangar{C['off']} {rec['id']}  model={rec['model']} ({rec['tier']})  workflow={rec['workflow']}", file=out)
        elif t == "node_start" and not quiet:
            print(f"{C['cyan']}▶ node {rec['node']}{C['off']}", file=out)
        elif t == "tool_start" and not quiet:
            a = json.dumps(rec.get("args", {}), ensure_ascii=False)
            print(f"{C['cyan']}● {rec['name']}{C['off']} {C['dim']}{a[:160]}{C['off']}", file=out)
        elif t == "tool_end" and not quiet:
            mark = f"{C['green']}✓{C['off']}" if rec["ok"] else f"{C['red']}✗{C['off']}"
            first = rec["preview"].strip().splitlines()[0][:140] if rec["preview"].strip() else ""
            print(f"  {mark} {C['dim']}{rec['ms']}ms · {rec['chars']} chars · {first}{C['off']}", file=out)
        elif t == "notice":
            print(f"{C['yellow']}! {rec['text']}{C['off']}", file=out)
        elif t == "verdict":
            print(f"{C['yellow']}⚖ reviewer: {rec['verdict']}{C['off']} {C['dim']}{rec['feedback'][:200]}{C['off']}", file=out)
        elif t == "hook" and not quiet:
            print(f"{C['yellow']}⚑ hook {rec['event']} {rec['action']}{C['off']} {C['dim']}{rec.get('message', '')[:160]}{C['off']}", file=out)
        elif t == "lessons":
            print(f"{C['dim']}✎ lessons {'used' if rec.get('used') else 'learned'}: {'; '.join(rec.get('used') or rec.get('learned') or [])}{C['off']}", file=out)
        elif t == "memory":
            what = ("remembered: " + ", ".join(rec["saved"]) + (f" — {rec.get('fact', '')}" if rec.get("fact") else "")) if rec.get("saved") \
                else "stale: " + ", ".join(rec.get("stale") or []) + f" ({rec.get('reason', '')})"
            print(f"{C['dim']}◆ memory {what}{C['off']}", file=out)
        elif t == "compact":
            print(f"{C['dim']}~ context compaction tier {rec['tier']}{C['off']}", file=out)
        elif t == "session_end":
            print(f"{C['dim']}— {rec['status']} · {rec['duration_s']}s · {rec['llm_calls']} llm calls · {rec['tool_calls']} tool calls · "
                  f"{rec['prompt']} in ({rec['cached']} cached) / {rec['completion']} out · ${rec['cost']:.5f}{C['off']}", file=out)
            for r in rec.get("by_role") or []:           # who spent it
                print(f"{C['dim']}    {r['role']:11s} ${r['cost']:.5f} · {r['calls']} call{'s' if r['calls'] != 1 else ''} · "
                      f"{', '.join(m.split('/')[-1] for m in r['models'])}{C['off']}", file=out)
    return p


def _overrides(a) -> dict:
    return {"planner_model": a.planner, "verifier_model": a.verifier, "permission": a.permission,
            "max_steps": a.max_steps, "max_cost_usd": a.max_cost, "perception_model": a.perception,
            "reasoning_effort": a.effort, "escalation_model": getattr(a, "escalate", None),
            "context_budget": getattr(a, "context_budget", None),
            "lessons": False if getattr(a, "no_lessons", False) else None,
            "memory": False if getattr(a, "no_memory", False) else None,
            "trust_project": True if getattr(a, "trust_project", False) else None,
            "fallback_models": [m for m in (getattr(a, "fallback", None) or "").split(",") if m] or None}


def cmd_run(a) -> int:
    from .runner import run_task
    cwd = Path(a.cwd or ".").resolve()
    cfg = config.load(cwd, _overrides(a))
    task = a.task if a.task != "-" else sys.stdin.read()
    answers = None
    if a.answers:
        answers = json.loads(Path(a.answers).read_text(encoding="utf-8")) if Path(a.answers).is_file() else [a.answers]
    interactive = "ui" if a.ui else ("tty" if sys.stdin.isatty() and not a.no_interactive and answers is None else "none")
    res = run_task(cfg, task, cwd, model=a.model, workflow=a.workflow, attachments=a.attach, interactive=interactive,
                   answers=answers, on_event=_printer(a.quiet or a.json), sid=a.session_id)
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        print(res["final"])
    return 0 if res["status"] == "done" else 1


def cmd_resume(a) -> int:
    from .runner import resume_task
    from .session import SESSIONS
    sid = a.session
    if sid == "last":
        sid = max((d.name for d in SESSIONS.glob("*") if (d / "meta.json").is_file()), default="")
    if not (SESSIONS / sid / "meta.json").is_file():
        print(f"unknown session '{a.session}' (see `hangar sessions`)", file=sys.stderr)
        return 2
    meta = json.loads((SESSIONS / sid / "meta.json").read_text(encoding="utf-8"))
    cfg = config.load(Path(meta["cwd"]), _overrides(a))
    res = resume_task(cfg, sid, extra=a.message or "", interactive="tty" if sys.stdin.isatty() and not a.json else "none",
                      on_event=_printer(a.json))
    print(json.dumps(res, ensure_ascii=False) if a.json else res["final"])
    return 0 if res["status"] == "done" else 1


def cmd_undo(a) -> int:
    """Restore every file a session changed with write/edit to its original content."""
    import shutil
    from .session import SESSIONS
    d = SESSIONS / a.session / "backup"
    try:
        manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print("nothing to undo for that session")
        return 1
    for path, bak in manifest.items():
        p = Path(path)
        if bak is None:
            p.unlink(missing_ok=True)
            print(f"removed   {p}")
        else:
            shutil.copy2(d / bak, p)
            print(f"restored  {p}")
    print("Note: changes made by shell commands are not tracked.")
    return 0


def cmd_memory(a) -> int:
    from . import memory
    cwd = Path(a.cwd or ".").resolve()
    if a.action in ("rm", "clear"):
        if a.action == "rm" and not a.name:
            print("usage: hangar memory rm <name>")
            return 2
        n = memory.forget(cwd, a.name if a.action == "rm" else "")
        print(f"removed {n}")
        return 0 if n or a.action == "clear" else 1
    facts = memory.load(cwd)
    for f in facts:
        print(f"{f['name']}  [{f['kind']}] {f['fact']}" + (f"  (STALE: {f['_stale']})" if f["_stale"] else ""))
        if f["command"]:
            print(f"    command: {f['command']}")
        if f["paths"]:
            print(f"    paths: {', '.join(f['paths'])}")
        print(f"    verified {f.get('verified', '?')} · confirmed {f['confirmations']}x · {f.get('source', '?')} · session {f.get('session', '?')}")
    print(f"{len(facts)} facts in {memory.folder(cwd)}" if facts else f"no project memory yet ({memory.folder(cwd)})")
    return 0


MARK = {"done": "✓", "failed": "✗", "pending": "·"}


def _backlog_show(cwd: Path) -> int:
    from . import backlog
    data = backlog.load(cwd)
    if data is None:
        print(f"no backlog yet ({backlog.path(cwd)}). Create one with: hangar backlog plan \"<goal>\"")
        return 0
    stuck = {t["id"] for t in backlog.blocked(data)}
    nxt = backlog.ready(data)
    print(f"{C['bold']}{data.get('goal', '')}{C['off']}")
    for t in data["tasks"]:
        note = " (blocked)" if t["id"] in stuck else " (next)" if nxt and t["id"] == nxt["id"] else ""
        cost = f"  ${t['cost']:.4f} · {t['attempts']} check{'s' if t['attempts'] != 1 else ''}" if t["attempts"] else ""
        print(f" {MARK.get(t['status'], '?')} {t['id']:24s} {t['title'][:70]}{note}{C['dim']}{cost}{C['off']}")
        print(f"{C['dim']}     accept: {t['accept'][:110]}" + (f"   after: {', '.join(t['deps'])}" if t["deps"] else "") + C["off"])
    done = sum(t["status"] == "done" for t in data["tasks"])
    print(f"{done}/{len(data['tasks'])} done · ${sum(t['cost'] for t in data['tasks']) + data.get('plan_cost', 0):.4f} spent")
    return 0


def cmd_backlog(a) -> int:
    from . import backlog
    cwd = Path(a.cwd or ".").resolve()
    cfg = config.load(cwd, _overrides(a))
    act = a.action
    if act == "show":
        return _backlog_show(cwd)
    if act == "plan":
        if not a.text:
            print('usage: hangar backlog plan "<goal>"')
            return 2
        if backlog.load(cwd) is not None and not a.replace:
            print("this project already has a backlog; pass --replace to plan it again from scratch")
            return 2
        res = backlog.plan(cfg, cwd, a.text, model=a.model, on_event=_printer(a.quiet))
        if not res["ok"]:
            print("the planner's backlog was not accepted:\n- " + "\n- ".join(res["errors"]), file=sys.stderr)
            return 1
        return _backlog_show(cwd)
    if act == "add":
        if not (a.text and a.accept):
            print('usage: hangar backlog add "<brief>" --accept "<command>" [--id x] [--title t] [--deps a,b]')
            return 2
        data = backlog.load(cwd) or {"goal": "", "created": time.strftime("%Y-%m-%d %H:%M"), "tasks": []}
        new = backlog.clean([{"id": a.id or a.title or a.text[:40], "title": a.title or a.text.splitlines()[0][:80], "brief": a.text,
                              "accept": a.accept, "deps": [d for d in (a.deps or "").split(",") if d]}])
        errors = backlog.validate([*data["tasks"], *new])
        if errors:
            print("not added:\n- " + "\n- ".join(errors), file=sys.stderr)
            return 1
        data["tasks"] += new
        backlog.save(cwd, data)
        return _backlog_show(cwd)
    if act == "reset":                                   # give failed tasks (or one task by id) another go
        data = backlog.load(cwd)
        hit = [t for t in (data or {"tasks": []})["tasks"] if (t["id"] == a.text if a.text else t["status"] == "failed")]
        for t in hit:
            t.update(status="pending", attempts=0)
            t.pop("output", None)
        if hit:
            backlog.save(cwd, data)
        print(f"reset {len(hit)}")
        return 0 if hit else 1
    if act == "check":                                   # no model: is everything marked done still passing?
        rows = backlog.audit(cfg, cwd)
        for t, ok, out in rows:
            print(f" {MARK['done'] if ok else MARK['failed']} {t['id']:24s} {t['accept'][:80]}")
            if not ok:
                print(C["dim"] + "     " + out[-600:].replace("\n", "\n     ") + C["off"])
        print(f"{sum(ok for _, ok, _ in rows)}/{len(rows)} still passing")
        return 0 if all(ok for _, ok, _ in rows) else 1
    res = backlog.run(cfg, cwd, model=a.model, workflow=a.workflow, max_tasks=0 if a.all else max(1, a.tasks or 1),
                      budget=a.budget or 0.0, attempts=a.attempts or backlog.ATTEMPTS, on_event=_printer(a.quiet),
                      log=lambda line: print(f"{C['bold']}{line}{C['off']}", file=sys.stderr))
    if "total" not in res:
        print(res["stop"], file=sys.stderr)
        return 2
    print(f"{res['done']}/{res['total']} done · ran {len(res['ran'])} · ${res['cost']:.4f} · stopped: {res['stop']}"
          + (f" · failed: {', '.join(res['failed'])}" if res["failed"] else "")
          + (f" · blocked: {', '.join(res['blocked'])}" if res["blocked"] else ""))
    return 0 if not res["failed"] and res["stop"] in ("all done", "task limit") else 1


def cmd_lessons(a) -> int:
    from . import lessons
    config.load()
    items = lessons.load(3650)
    if a.action == "clear":
        for d in items:
            d["_file"].unlink(missing_ok=True)
        print(f"removed {len(items)} lessons")
        return 0
    if a.action == "rm":
        hit = [d for d in items if d["_file"].stem == a.id or d["_file"].stem.endswith(a.id or "\0")]
        for d in hit:
            d["_file"].unlink(missing_ok=True)
        print(f"removed {len(hit)}")
        return 0 if hit else 1
    for d in items:
        age = int((time.time() - d.get("created", 0)) / 86400)
        print(f"{d['_file'].stem}  [{d.get('scope')}] {d.get('title')}  ({age}d, used {d.get('uses', 0)}x, confirmed {d.get('confirmations', 1)}x)")
        print(f"    do: {d.get('lesson')}\n    when: {d.get('situation')}\n    evidence: {d.get('evidence')}\n    from: {d.get('session')} · {d.get('model')} · {d.get('project')}")
    print(f"{len(items)} lessons in {lessons.DIR}" if items else f"no lessons yet ({lessons.DIR})")
    return 0


def cmd_hooks(a) -> int:
    from .session import Session
    cwd = Path(a.cwd or ".").resolve()
    s = Session(config.load(cwd, {"trust_project": True if a.trust_project else None}), cwd, task="(hooks)")
    lines = s.hooks.describe()
    print("\n".join(lines) if lines else "no hooks or plugins active for this folder")
    print(f"project trusted: {s.hooks.trusted}")
    s.bus.close()
    import shutil
    shutil.rmtree(s.dir, ignore_errors=True)
    return 0


def cmd_chat(a) -> int:
    from .agent import Agent
    from .session import Session
    cwd = Path(a.cwd or ".").resolve()
    cfg = config.load(cwd, _overrides(a))
    s = Session(cfg, cwd, task="(chat)", model=a.model, interactive="tty")
    s.bus.subscribe(_printer(False))
    s.bus.emit("session_start", id=s.id, task="(chat)", model=s.model, workflow="chat", cwd=str(cwd), tier=s.catalog.info(s.model)["tier"], attachments=[])
    s.mcp.load()
    agent = Agent(s)
    print("Type your request (empty line or Ctrl+C to quit).", file=sys.stderr)
    try:
        while True:
            line = input(f"{C['bold']}you>{C['off']} ").strip()
            if not line:
                break
            agent.steps = 0
            agent.run(line)
            print(file=sys.stderr)
    except (EOFError, KeyboardInterrupt):
        pass
    s.finish("done")
    return 0


def cmd_ui(a) -> int:
    from .server import serve
    return serve(a.port, open_browser=not a.no_open)


def cmd_sessions(a) -> int:
    from .session import SESSIONS
    rows = []
    for d in sorted(SESSIONS.glob("*"), reverse=True)[:a.n]:
        try:
            m = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rows.append(f"{m['id']}  {m.get('status', '?'):8s} ${m.get('totals', {}).get('cost', 0):.4f}  {m['model']:38s} {m['task'][:60]!r}")
    print("\n".join(rows) or "no sessions yet")
    return 0


def cmd_models(a) -> int:
    cat = Catalog(config.load())
    for m in cat.search(a.filter or "", 400):
        mods = ",".join(m["modalities"])
        if a.filter == "omni" or True:
            print(f"{m['id']:52s} in ${m['price_in']:<7.3g} out ${m['price_out']:<7.3g} ctx {m['context']:<8} tools={'y' if m['tools'] else 'n'} {mods}")
    return 0


def cmd_mcp(a) -> int:
    from .mcp import MCPManager
    config.load()
    m = MCPManager(Path(a.cwd or ".").resolve())
    m.load()
    if not m.servers:
        print("No MCP servers. Add them to .mcp.json (same format as Claude Code) or ~/.hangar/mcp.json")
    for s in m.servers.values():
        print(f"{s.name}: " + (f"ERROR {s.error}" if s.error else f"{len(s.tools)} tools"))
        for t in s.tools:
            print(f"  - {t['name']}: {(t.get('description') or '')[:90]}")
    m.stop()
    return 0


def cmd_doctor(a) -> int:
    cfg = config.load()
    info = machine.probe(refresh=True)
    print(f"hangar {__version__}\n" + machine.describe(info, "bash" if info.get("bash") else "powershell"))
    for name, p in cfg["providers"].items():
        env = p.get("api_key_env")
        print(f"- provider {name}: {p['base_url']} " + (("key " + ("set" if os.environ.get(env) else "MISSING") + f" ({env})") if env else "(no key needed)"))
    print(f"- default model: {cfg['model']} · perception: {cfg['perception_model']} · sessions: {config.HOME / 'sessions'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if os.name == "nt":
        os.system("")          # enable ANSI colours in the Windows console
    args = sys.argv[1:] if argv is None else argv
    if args and args[0] == "bridge":                    # engine mode for a host application (stdin/stdout protocol)
        from . import bridge
        return bridge.main(args[1:])
    if args and args[0] == "studio":                    # production commands (screenshot, video, image, pptx)
        from . import studio
        return studio.main(args[1:])
    ap = argparse.ArgumentParser(prog="hangar", description="Hangar Harness — model-agnostic, token-frugal agent harness")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("-m", "--model")
        p.add_argument("--cwd")
        p.add_argument("--planner")
        p.add_argument("--verifier")
        p.add_argument("--perception")
        p.add_argument("--permission", choices=["auto", "ask", "edits", "readonly"])
        p.add_argument("--max-steps", type=int)
        p.add_argument("--max-cost", type=float)
        p.add_argument("--effort", choices=["low", "medium", "high"])
        p.add_argument("--escalate", help="stronger model that takes over if the worker gets stuck")
        p.add_argument("--fallback", help="comma-separated stand-in models if the provider is down")
        p.add_argument("--context-budget", type=int, help="context tokens before compaction kicks in")
        p.add_argument("--no-lessons", action="store_true", help="do not read or write the lesson library")
        p.add_argument("--no-memory", action="store_true", help="do not read or write this project's memory (.hangar/memory)")
        p.add_argument("--trust-project", action="store_true", help="allow this project's hooks/plugins that execute code")

    r = sub.add_parser("run", help="run one task to completion")
    r.add_argument("task", help="the task, or - to read it from stdin")
    common(r)
    r.add_argument("-w", "--workflow", help="loop (default) | verify | pev | custom name")
    r.add_argument("-a", "--attach", action="append", default=[], help="image/audio/video/pdf/text file (repeatable)")
    r.add_argument("--ui", action="store_true", help="questions are answered in the dashboard")
    r.add_argument("--no-interactive", action="store_true")
    r.add_argument("--answers", help="scripted answers: a JSON list file, or one literal answer")
    r.add_argument("--json", action="store_true", help="print the run summary as JSON")
    r.add_argument("--quiet", action="store_true")
    r.add_argument("--session-id")
    r.set_defaults(fn=cmd_run)

    rs = sub.add_parser("resume", help="continue an interrupted session, or give a finished one a follow-up")
    rs.add_argument("session", help="session id, or 'last'")
    rs.add_argument("message", nargs="?", help="optional extra instruction")
    common(rs)
    rs.add_argument("--json", action="store_true")
    rs.set_defaults(fn=cmd_resume)

    un = sub.add_parser("undo", help="restore the files a session changed")
    un.add_argument("session")
    un.set_defaults(fn=cmd_undo)

    ls = sub.add_parser("lessons", help="list or prune the lesson library")
    ls.add_argument("action", nargs="?", default="list", choices=["list", "rm", "clear"])
    ls.add_argument("id", nargs="?")
    ls.set_defaults(fn=cmd_lessons)

    mm = sub.add_parser("memory", help="list or prune this project's memory (.hangar/memory)")
    mm.add_argument("action", nargs="?", default="list", choices=["list", "rm", "clear"])
    mm.add_argument("name", nargs="?")
    mm.add_argument("--cwd")
    mm.set_defaults(fn=cmd_memory)

    bl = sub.add_parser("backlog", help="work bigger than one session: tasks with dependencies and an acceptance command each")
    bl.add_argument("action", nargs="?", default="show", choices=["show", "plan", "run", "add", "reset", "check"])
    bl.add_argument("text", nargs="?", help="plan: the goal · add: the task brief · reset: a task id")
    common(bl)
    bl.add_argument("-w", "--workflow", help="workflow of each task session (loop, verify, pev)")
    bl.add_argument("--all", action="store_true", help="run: keep going until nothing is ready")
    bl.add_argument("--tasks", type=int, help="run: how many tasks to work on (default 1)")
    bl.add_argument("--budget", type=float, help="run: US$ this call may spend across all its tasks")
    bl.add_argument("--attempts", type=int, help="run: acceptance checks per task before it is marked failed (default 3)")
    bl.add_argument("--replace", action="store_true", help="plan: discard the existing backlog")
    bl.add_argument("--accept", help="add: the command that proves the task is done")
    bl.add_argument("--id")
    bl.add_argument("--title")
    bl.add_argument("--deps", help="add: comma-separated ids that must be done first")
    bl.add_argument("--quiet", action="store_true")
    bl.set_defaults(fn=cmd_backlog)

    hk = sub.add_parser("hooks", help="show the hooks and plugins active for a folder")
    hk.add_argument("--cwd")
    hk.add_argument("--trust-project", action="store_true")
    hk.set_defaults(fn=cmd_hooks)

    c = sub.add_parser("chat", help="interactive multi-turn session")
    common(c)
    c.set_defaults(fn=cmd_chat)

    u = sub.add_parser("ui", help="live dashboard")
    u.add_argument("--port", type=int, default=int(os.environ.get("PORT") or 3090))
    u.add_argument("--no-open", action="store_true")
    u.set_defaults(fn=cmd_ui)

    s = sub.add_parser("sessions", help="list recent sessions")
    s.add_argument("-n", type=int, default=20)
    s.set_defaults(fn=cmd_sessions)

    m = sub.add_parser("models", help="search the model catalog")
    m.add_argument("filter", nargs="?")
    m.set_defaults(fn=cmd_models)

    mc = sub.add_parser("mcp", help="list configured MCP servers and tools")
    mc.add_argument("--cwd")
    mc.set_defaults(fn=cmd_mcp)

    d = sub.add_parser("doctor", help="probe this machine and the configuration")
    d.set_defaults(fn=cmd_doctor)

    a = ap.parse_args(argv)
    t0 = time.time()
    try:
        return a.fn(a)
    except KeyboardInterrupt:
        print(f"\ninterrupted after {time.time() - t0:.0f}s", file=sys.stderr)
        return 130
