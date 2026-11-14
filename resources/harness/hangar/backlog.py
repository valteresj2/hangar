"""Project backlog: work too big for one session, kept on disk as tasks with dependencies and an acceptance command.

A session forgets; the backlog does not. `<project>/.hangar/backlog.json` holds the goal and its tasks. Each task
carries a shell command that proves it is done, and it is the harness, not the model, that runs that command:

  plan   a planner model splits the goal into tasks (validated here: ids, dependencies, no cycles, safe commands)
  run    take the next task whose dependencies are done -> one session works on it -> the harness runs its
         acceptance command, then the acceptance commands of every task already done (nothing may break) ->
         done, or the failure goes back to the same session, up to a number of attempts

A task is never marked done because an agent said so."""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

from . import machine
from .toolcall import repair_json

FILE = "backlog.json"
ATTEMPTS = 3                # acceptance checks per task before it is marked failed
TIMEOUT = 600               # seconds an acceptance command may take, unless the task says otherwise
TAIL = 2500                 # chars of a failed check handed back to the agent

PLAN = """Goal of the project:
{goal}

Look at the working directory with read-only tools (it may be empty), then split the goal into a backlog of tasks.
Each task is done by a separate engineer in a separate session who sees only the goal, the task's own brief and the
titles of the tasks already done. So:

- Small vertical steps, in the order they can be built: 3 to 12 tasks, each a session of focused work.
- "brief": self-contained. Name the files to create or change, the behaviour expected, and the decisions already taken
  that the engineer must follow (names, formats, interfaces shared with other tasks).
- "accept": ONE shell command, run from the project root, non-interactive, that exits 0 only when the task is really
  done, and finishes in a few minutes. Prefer a command that exercises the result (run the tests of that part, build
  and run it, boot it and look for the expected output) over one that only checks a file exists. If the command needs
  a test file or script that does not exist yet, the brief must tell the engineer to create it and what it must check.
  It must keep passing after later tasks, because it is run again after every one of them.
- Every task has its OWN command, one that fails until that task is done: name that task's test file or script
  (`python -m unittest tests.test_lexer`), never the same whole-suite command for every task. A command that already
  passes before the work proves nothing. The checks of earlier tasks are re-run automatically; do not repeat them.
- "deps": ids of the tasks that must be done first.
- The first task sets up whatever the others need to be checked (project skeleton, the way to run tests).

Write titles and briefs in the language of the goal. Reply with ONLY a JSON list:
[{{"id": "short-kebab-id", "title": "...", "brief": "...", "accept": "...", "deps": []}}]"""

WORK = """Project goal (context only; your task is the one below):
{goal}

{done}YOUR TASK ({id}): {title}
{brief}

Acceptance: when you finish, the harness itself runs this command in the project root, and the task only counts if it exits 0:
  {accept}
Run it yourself before you finish. The harness runs it in the user's plain environment: your shell sets PYTHONUTF8=1 and
PYTHONIOENCODING=utf-8, the user's does not, so the result must not depend on them (pass encodings explicitly). After it, the acceptance commands of the tasks already done are run again, so do not
break them. Do not weaken, skip or delete existing checks to make a command pass, and do not start other tasks."""

RETRY = """The harness ran the acceptance checks itself and the task is NOT accepted yet.

{problems}

If a command passes in your shell and fails here, the difference is the environment: the harness runs it without
PYTHONUTF8 and PYTHONIOENCODING, as the user would. Fix the cause (not the check), run the command(s) again yourself,
then give your final answer."""


def path(cwd: Path) -> Path:
    return Path(cwd) / ".hangar" / FILE


def load(cwd: Path) -> dict | None:
    try:
        data = json.loads(path(cwd).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("tasks"), list) else None


def save(cwd: Path, data: dict) -> None:
    p = path(cwd)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for _ in range(5):                                   # a sync client may hold the file for a moment
        try:
            tmp.replace(p)
            return
        except PermissionError:
            time.sleep(0.2)
    tmp.replace(p)


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:40]


def clean(items) -> list[dict]:
    """Model or hand-written tasks -> the stored shape. Unknown keys are dropped; state starts as pending."""
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        deps = it.get("deps") or []
        out.append({"id": slug(it.get("id") or it.get("title") or ""), "title": str(it.get("title") or "").strip()[:160],
                    "brief": str(it.get("brief") or "").strip(), "accept": str(it.get("accept") or "").strip(),
                    "deps": [slug(d) for d in (deps if isinstance(deps, list) else [deps]) if slug(d)],
                    "timeout": int(it.get("timeout") or 0), "status": "pending", "attempts": 0, "cost": 0.0, "sessions": []})
    return out


def validate(tasks: list[dict]) -> list[str]:
    """Everything that would make the backlog unrunnable or unsafe. An empty list means it is good."""
    from .tools import DANGEROUS, KILL_BY_NAME
    errors, ids = [], [t["id"] for t in tasks]
    if not tasks:
        errors.append("no tasks")
    for t in tasks:
        tid = t["id"] or "(no id)"
        if not t["id"]:
            errors.append("a task has no id")
        if ids.count(t["id"]) > 1:
            errors.append(f"{tid}: duplicate id")
        if not t["title"] or not t["brief"]:
            errors.append(f"{tid}: needs a title and a brief")
        if not t["accept"]:
            errors.append(f"{tid}: needs an acceptance command (a task nobody can check is never done)")
        elif any(rx.search(t["accept"]) for rx in (*DANGEROUS, *KILL_BY_NAME)):
            errors.append(f"{tid}: the acceptance command matches a destructive-command rule and will not be run")
        for d in t["deps"]:
            if d not in ids:
                errors.append(f"{tid}: depends on unknown task '{d}'")
            if d == t["id"]:
                errors.append(f"{tid}: depends on itself")
    by = {t["id"]: t for t in tasks}
    state: dict[str, int] = {}

    def visit(i: str) -> bool:                           # True when a cycle passes through i
        if state.get(i) == 1:
            return True
        if state.get(i) == 2 or i not in by:
            return False
        state[i] = 1
        hit = any(visit(d) for d in by[i]["deps"])
        state[i] = 2
        return hit

    if any(visit(i) for i in ids):
        errors.append("the dependencies form a cycle")
    return sorted(set(errors))


def ready(data: dict) -> dict | None:
    """The next task to work on: the first pending one whose dependencies are all done."""
    done = {t["id"] for t in data["tasks"] if t["status"] == "done"}
    return next((t for t in data["tasks"] if t["status"] == "pending" and all(d in done for d in t["deps"])), None)


def blocked(data: dict) -> list[dict]:
    """Pending tasks that can never start as things stand: something they depend on failed."""
    by = {t["id"]: t for t in data["tasks"]}

    def dead(t, seen=()) -> bool:
        return any(by[d]["status"] == "failed" or (d not in seen and dead(by[d], (*seen, d))) for d in t["deps"] if d in by)

    return [t for t in data["tasks"] if t["status"] == "pending" and dead(t)]


def check(cfg: dict, cwd: Path, task: dict) -> tuple[bool, str]:
    """Run a task's acceptance command. This is the only thing that can make a task done."""
    from .tools import kill_tree
    _, argv = machine.shell(cfg, machine.probe())
    # the user's own environment, not the friendlier one the agent's shell gets (UTF-8 forced): seen in a real run,
    # a test suite passed for the agent and failed in a plain Windows console
    env = {**os.environ, "PAGER": "cat", "GIT_PAGER": "cat", "CI": "1"}
    timeout = int(task.get("timeout") or TIMEOUT)
    try:
        p = subprocess.Popen([*argv, task["accept"]], cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, env=env,
                             creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
    except OSError as e:
        return False, f"could not start: {e}"
    try:
        raw, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(p)
        try:
            raw, _ = p.communicate(timeout=5)
        except Exception:
            raw = b""
        return False, raw.decode("utf-8", "replace")[-TAIL:] + f"\n[timed out after {timeout}s]"
    out = raw.decode("utf-8", "replace").replace("\r\n", "\n").strip()
    return p.returncode == 0, (("[...]\n" if len(out) > TAIL else "") + out[-TAIL:] + f"\n[exit {p.returncode}]").strip()


def regressions(cfg: dict, cwd: Path, data: dict, task: dict) -> list[tuple[dict, str]]:
    """Acceptance commands of the tasks already done that no longer pass. Each distinct command runs once."""
    broken, seen = [], {task["accept"]}
    for t in data["tasks"]:
        if t["status"] != "done" or t["accept"] in seen:
            continue
        seen.add(t["accept"])
        ok, out = check(cfg, cwd, t)
        if not ok:
            broken.append((t, out))
    return broken


def parse(text: str) -> list[dict]:
    """The planner's reply -> tasks. Tolerates prose or a code fence around the JSON list."""
    a, b = text.find("["), text.rfind("]")
    value, ok = repair_json(text[a:b + 1]) if 0 <= a < b else ([], False)
    return clean(value) if ok else []


def _propose(cfg: dict, cwd: Path, goal: str, model: str | None, on_event) -> tuple[str, dict]:
    """One planner session with read-only tools. Returns its reply and the session summary."""
    from .agent import Agent
    from .session import Session
    s = Session(cfg, cwd, task=f"(backlog) {goal}", model=model, workflow="backlog-plan")
    if on_event:
        s.bus.subscribe(on_event)
    who = (s.team or {}).get("planner") or cfg["planner_model"] or s.model
    s.bus.emit("session_start", id=s.id, task=s.meta["task"], model=who, workflow="backlog-plan", cwd=str(s.cwd),
               tier=s.catalog.info(who)["tier"], attachments=[])
    status, text = "done", ""
    try:
        text = Agent(s, model=who, role="planner", toolset="readonly", name="plan", max_steps=15).run(PLAN.format(goal=goal))
    except Exception as e:                               # the summary must still be written
        status, text = "error", f"{type(e).__name__}: {e}"
    return text, s.finish(status, text)


def repeated(tasks: list[dict]) -> list[str]:
    """Tasks sharing one acceptance command: for all but the first, it would pass before any work is done."""
    first: dict[str, str] = {}
    return [f"{t['id']}: same acceptance command as '{first[t['accept']]}' — it would already pass before this task's work; "
            "give the task a command of its own that fails until the task is done"
            for t in tasks if t["accept"] and first.setdefault(t["accept"], t["id"]) != t["id"]]


def plan(cfg: dict, cwd: Path, goal: str, model: str | None = None, on_event=None) -> dict:
    """Ask the planner for a backlog and store it if it validates; a rejected plan goes back to the planner once.
    Returns {"ok", "errors", "tasks", "cost"}."""
    cost, ask, tasks, errors, summary = 0.0, goal, [], [], {}
    for _ in range(2):
        text, summary = _propose(cfg, cwd, ask, model, on_event)
        cost += summary["cost"]
        tasks = parse(text)
        errors = [text] if summary["status"] != "done" else validate(tasks) + repeated(tasks)
        if not errors or summary["status"] != "done":
            break
        ask = (f"{goal}\n\nYour previous backlog was rejected by the harness:\n- " + "\n- ".join(errors) +
               f"\n\nPrevious backlog:\n{json.dumps([{k: t[k] for k in ('id', 'title', 'brief', 'accept', 'deps')} for t in tasks], ensure_ascii=False)}"
               "\n\nSend the whole corrected list.")
    if not errors:
        save(cwd, {"goal": goal, "created": time.strftime("%Y-%m-%d %H:%M"), "plan_session": summary["session"],
                   "plan_cost": round(cost, 6), "tasks": tasks})
    return {"ok": not errors, "errors": errors, "tasks": tasks, "cost": round(cost, 6), "session": summary.get("session", "")}


def brief(data: dict, task: dict) -> str:
    done = [t for t in data["tasks"] if t["status"] == "done"]
    listing = "Already done by earlier sessions:\n" + "\n".join(f"- {t['id']}: {t['title']}" for t in done) + "\n\n" if done else ""
    return WORK.format(goal=data.get("goal", ""), done=listing, id=task["id"], title=task["title"], brief=task["brief"], accept=task["accept"])


def run(cfg: dict, cwd: Path, model: str | None = None, workflow: str | None = None, max_tasks: int = 0,
        budget: float = 0.0, attempts: int = ATTEMPTS, on_event=None, log=print) -> dict:
    """Work through the backlog until nothing is ready, a limit is hit, or a session cannot run.
    `budget` is the money this call may spend across all its tasks; each session keeps its own max_cost_usd."""
    from .runner import resume_task, run_task
    data = load(cwd)
    if data is None:
        return {"stop": "no backlog", "ran": [], "cost": 0.0}
    errors = validate(data["tasks"])
    if errors:
        return {"stop": "invalid backlog: " + "; ".join(errors), "ran": [], "cost": 0.0}
    spent, ran, stop = 0.0, [], ""
    while not stop:
        task = ready(data)
        if task is None:
            stop = "all done" if all(t["status"] == "done" for t in data["tasks"]) else "nothing ready"
            break
        if max_tasks and len(ran) >= max_tasks:
            stop = "task limit"
            break
        if budget and spent >= budget:
            stop = "budget"
            break
        # a check that passes before any work proves nothing about this task: say so, and still do the work
        task["weak"] = check(cfg, cwd, task)[0]
        log(f"▶ {task['id']}: {task['title']}" + ("  (acceptance already passes before the work: a weak check)" if task["weak"] else ""))
        res = run_task(cfg, brief(data, task), cwd, model=model, workflow=workflow, on_event=on_event)
        task["sessions"].append(res["session"])
        base, ran = task["cost"], [*ran, task["id"]]
        while True:
            task["cost"] = round(base + res["cost"], 6)
            if res["status"] in ("stopped", "error"):    # no verdict on the work: leave the task for the next run
                stop = f"session {res['status']}"
                break
            task["attempts"] += 1
            ok, out = check(cfg, cwd, task)
            broken = regressions(cfg, cwd, data, task) if ok else []
            task["checked"] = time.strftime("%Y-%m-%d %H:%M")
            if ok and not broken:
                task["status"] = "done"
                task.pop("output", None)
                log(f"  ✓ accepted ({task['attempts']} check{'s' if task['attempts'] != 1 else ''}, ${task['cost']:.4f})")
                break
            problems = ([] if ok else [f"`{task['accept']}` failed:\n{out}"]) + [
                f"`{t['accept']}` passed before your work and now fails (task {t['id']}: {t['title']}):\n{o}" for t, o in broken]
            task["output"] = "\n\n".join(problems)[-TAIL * 2:]
            log("  ✗ " + ("acceptance failed" if not ok else "broke: " + ", ".join(t["id"] for t, _ in broken)))
            if task["attempts"] >= attempts or (budget and spent + res["cost"] >= budget):
                task["status"] = "failed"
                log(f"  ✗ {task['id']} failed after {task['attempts']} checks")
                break
            save(cwd, data)
            res = resume_task(cfg, res["session"], extra=RETRY.format(problems="\n\n".join(problems)), on_event=on_event)
        spent += task["cost"] - base
        save(cwd, data)
    return {"stop": stop, "ran": ran, "cost": round(spent, 6), "done": sum(t["status"] == "done" for t in data["tasks"]),
            "failed": [t["id"] for t in data["tasks"] if t["status"] == "failed"],
            "blocked": [t["id"] for t in blocked(data)], "total": len(data["tasks"])}


def audit(cfg: dict, cwd: Path) -> list[tuple[dict, bool, str]]:
    """Run the acceptance command of every task marked done, without any model: is what was built still standing?"""
    data = load(cwd) or {"tasks": []}
    return [(t, *check(cfg, cwd, t)) for t in data["tasks"] if t["status"] == "done"]
