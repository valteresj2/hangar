"""Quality layer: before an agent's "I'm done" is accepted, the strongest model on the team reads the delivery and either
approves it or sends back up to three concrete improvements.

Why it is cheap: it runs only after the free checks passed (exit codes, hooks, skill gates), it is ONE call without tools
over a digest of the delivery (not the transcript), and it speaks at most `critic_rounds` times per agent. The cheap model
does all the work; the expensive one is paid only for judgement.

Why it is grounded: an opinion is cheap to give and cheap to ignore, and text-only review loops are known to break as
much as they fix. So the critic attaches to each defect a command that fails now and passes once the defect is gone.
The harness runs those commands itself: before the fix (a check that already passes proves nothing and is dropped),
and after it (a failing check goes back to the worker without another paid review). From the second review on, only
defects with such a check count, so the critic stops when what is left cannot be verified. And if the revision leaves
a skill gate failing that the earlier version passed, the earlier version is put back.

Config: critic_model ("" off, "auto" = strongest on the roster, or a model id), critic_rounds (2), critic_scope
("final" = the main agent's answer; "all" = sub-agents and the planner too). A skill loaded in the session adds its own
criteria from a RUBRIC.md next to its SKILL.md."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

from .toolcall import repair_json

DIGEST = 44_000                # chars of delivery shown to the critic (about 12k tokens)
PER_FILE = 16_000
CHECK_TIMEOUT = 90
PUSHES = 2                     # times failing checks go back to the worker between two reviews
SNAPSHOT_MAX = 60_000_000      # bytes of delivery kept so a revision that breaks it can be undone
TEXT = {".html", ".htm", ".md", ".txt", ".json", ".csv", ".tsv", ".py", ".js", ".ts", ".sql", ".yaml", ".yml", ".toml", ".sh", ".ps1",
        ".css", ".xml", ".ipynb", ".r", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".rb", ".php"}
PROSE_FIRST = (".html", ".htm", ".md", ".txt", ".json")
SKIP_DIRS = {".git", ".hangar", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
# a check only looks: anything that writes, deletes, installs or reaches the network is not a check
NOT_A_CHECK = re.compile(r"(^|[\s;&|(])(rm|del|rmdir|mv|move|cp|copy|git|pip|npm|curl|wget|chmod|kill|taskkill|shutdown)\b|>>?\s*[\w./\\~$\"']", re.I)

# a check that greps the write-up is satisfied by rewording it; one that reads a recorded value is satisfied by doing the work
PROSE = re.compile(r"\.(html?|md|markdown|txt|rst)\b", re.I)
EVIDENCE = "evidence.json"

SYSTEM = """You are the quality reviewer of a team of AI agents: the strongest model on the team, called once, after the work already \
passed its mechanical checks. A cheaper model did the work. You judge substance, not form.

Ask what an expert in this domain would object to: Is the method sound for how the result will be used? Do the conclusions follow from \
the evidence shown? Is a number misleading because of how it was computed? Is something the task asked for missing or only gestured at? \
Is there an obvious next question the delivery should have answered?

Rules:
- Report at most 3 defects, ordered by how much they would change a decision made from this work. No polish, no style notes.
- Each defect must quote or point at evidence in the delivery, say exactly what to do, and say how to tell it is fixed.
- Give each defect a `check` whenever one exists: ONE read-only shell command, run from the working directory, that exits non-zero \
NOW and will exit 0 once the defect is fixed. It must not write, delete, install or download anything, and must finish in seconds. \
The harness runs it before and after the fix, and a check that already passes is discarded.
- A check must test the work, not the wording. The harness REJECTS any check that reads the write-up (.html, .md, .txt): looking for \
a word there is satisfied by rephrasing. Assert on VALUES in data files instead. When the number you need is not in a data file yet, \
make the fix say: "have your script write <key> to evidence.json", and check that file, comparing numbers, for example \
`python -c "import json; e=json.load(open('evidence.json')); assert e['auc_temporal'] <= e['auc_aleatoria'] + 0.02"` \
or `assert e['n_treino'] + e['n_teste'] == e['n_total']`. Prefer relations between numbers over mere presence of a key. \
If no such check exists, set "check" to "".
- The worker can run code and edit files but cannot ask you questions: instructions must be self-contained and feasible in a few steps.
- Approve when what remains is polish. In a later round only defects with a check count: approve unless a checked defect is still open \
or the fix broke something you can check.

Reply with ONLY this JSON:
{"verdict": "approve" | "revise", "defects": [{"problem": "...", "evidence": "...", "fix": "...", "done_when": "...", "check": "..."}]}"""


def model(session) -> str:
    """The critic's model, or "" when the layer is off."""
    want = str(session.cfg.get("critic_model") or "").strip()
    if want in ("", "off", "none"):
        return ""
    if want not in ("auto", "best"):
        return want
    from . import router
    ranked = router.load()["roles"]
    strong = ranked.get("escalation") or ranked.get("deep") or []
    known = session.catalog._load()
    usable = [m for m in strong if not known or m in known]
    # every model on that list cleared the hardest tasks; the last one is the most capable (and the dearest): judgement is worth it
    return (usable or strong or [session.cfg.get("escalation_model") or session.cfg.get("planner_model") or session.model])[-1]


def enabled(session, agent) -> bool:
    if not model(session):
        return False
    return agent.role == "main" or (str(session.cfg.get("critic_scope", "final")) == "all" and agent.role in ("sub", "planner"))


def applies(session, agent) -> bool:
    """Is another paid review due for this agent?"""
    if not enabled(session, agent) or session.over_budget():
        return False
    rounds = int(session.cfg.get("critic_rounds", 2))
    return agent.critic_rounds < (rounds if agent.role == "main" else min(1, rounds))


# ------------------------------------------------------------------ what was delivered

def delivered(session) -> list[Path]:
    """The files the session wrote, by tool or by a script it ran, prose first and code after."""
    seen: dict[Path, None] = {}
    for rel in sorted(session.files):
        seen[(session.cwd / rel) if not Path(rel).is_absolute() else Path(rel)] = None
    try:
        for p in session.cwd.rglob("*"):                 # files a script produced never went through the write tool
            if SKIP_DIRS & set(p.relative_to(session.cwd).parts):
                continue
            if p.is_file() and p.stat().st_mtime >= session.started - 1:
                seen[p] = None
            if len(seen) > 400:
                break
    except OSError:
        pass
    files = [p for p in seen if p.is_file() and p.suffix.lower() in TEXT and p.stat().st_size <= 8_000_000]
    files.sort(key=lambda p: (p.suffix.lower() not in PROSE_FIRST, p.name))
    return files


def _read(path: Path) -> str:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if path.suffix.lower() in (".html", ".htm"):
        from . import report
        raw = report._prose(re.sub(r"</(tr|p|h\d|li|div|section|figcaption)>", "\n", raw, flags=re.I))       # words and cells, no markup or images
        raw = re.sub(r"[ \t]+", " ", raw)
    if len(raw) > PER_FILE:
        raw = raw[:PER_FILE * 3 // 4] + f"\n[... {len(raw) - PER_FILE} chars omitted ...]\n" + raw[-PER_FILE // 4:]
    return raw


def _name(session, p: Path) -> str:
    try:
        return str(p.relative_to(session.cwd)).replace("\\", "/")
    except ValueError:
        return str(p)


def digest(session) -> str:
    files = delivered(session)
    parts, left = [], DIGEST
    for p in files:
        body = _read(p)
        if not body.strip():
            continue
        body = body[:left]
        parts.append(f"=== {_name(session, p)} ===\n{body}")
        left -= len(body)
        if left < 600:
            parts.append(f"[{len(files) - len(parts)} more file(s) not shown]")
            break
    return "\n\n".join(parts) or "(no text files were written)"


def rubrics(session) -> str:
    out = []
    for name in getattr(session, "skills_loaded", ()):
        s = session.skills.get(name) or {}
        f = Path(s["path"]).parent / "RUBRIC.md" if s.get("path") else None
        if f and f.is_file():
            out.append(f"## {name}\n{f.read_text(encoding='utf-8', errors='replace').strip()[:4000]}")
    return "\n\n".join(out)


# ------------------------------------------------------------------ checks the harness runs

def substantive(cmd: str) -> bool:
    """Does the check look at the work rather than at the words describing it? `hangar studio` commands inspect a page as a
    browser would (errors, overflow, structure), so they may read one."""
    return not PROSE.search(cmd or "") or "hangar studio" in cmd


def runnable(session, cmd: str) -> bool:
    """A check may run without asking only where the worker's own commands do, and only if it just looks."""
    from .tools import DANGEROUS, KILL_BY_NAME
    cmd = (cmd or "").strip()
    return bool(cmd) and len(cmd) < 1500 and session.cfg.get("permission") == "auto" and not NOT_A_CHECK.search(cmd) \
        and substantive(cmd) and not any(rx.search(cmd) for rx in (*DANGEROUS, *KILL_BY_NAME))


def run_check(session, cmd: str) -> tuple[bool, str]:
    """(passed, tail of the output)."""
    from .config import PKG_ROOT
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1",
           "PYTHONPATH": os.pathsep.join(x for x in (str(PKG_ROOT), os.environ.get("PYTHONPATH", "")) if x)}
    try:
        p = subprocess.run([*session.shell_argv, cmd], cwd=str(session.cwd), capture_output=True, stdin=subprocess.DEVNULL,
                           timeout=CHECK_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        return False, f"timed out after {CHECK_TIMEOUT}s"
    except OSError as e:
        return False, f"{type(e).__name__}: {e}"
    out = (p.stdout + p.stderr).decode("utf-8", "replace").strip()
    return p.returncode == 0, out[-600:]


def ground(session, defects: list[dict]) -> None:
    """Run each defect's check against the delivery as it stands. Keeps `check` only where it fails now: that is the one
    kind of check whose later success means something."""
    for d in defects:
        cmd = str(d.get("check") or "").strip()
        d["check"] = ""
        if not runnable(session, cmd):
            continue
        passed, out = run_check(session, cmd)
        if not passed:
            d["check"], d["check_out"] = cmd, out


def failing(session, defects: list[dict]) -> list[dict]:
    out = []
    for d in defects:
        if d.get("check"):
            passed, tail = run_check(session, d["check"])
            d["fixed"] = passed
            if not passed:
                out.append({**d, "check_out": tail})
    return out


def pending_checks(session, agent) -> str:
    """The worker says it is done after a review: the harness runs the checks itself. Failing ones go back, for free."""
    if not agent.critic_defects or agent.critic_pushes >= PUSHES:
        return ""
    bad = failing(session, agent.critic_defects)
    if not bad:
        return ""
    agent.critic_pushes += 1
    lines = ["[harness] The quality review is not satisfied yet. I ran its checks on your files and these still fail:"]
    for d in bad:
        lines += [f"- {str(d.get('problem', '')).strip()[:300]}", f"  check: {d['check']}", f"  output: {d.get('check_out') or '(none)'}"]
    lines.append("Fix the work (not the check), then give your final answer. If a check is itself wrong, say exactly why in one line.")
    session.bus.emit("notice", level="info", text=f"quality checks: {len(bad)} still failing, back to the worker", agent=agent.name)
    return "\n".join(lines)


# ------------------------------------------------------------------ undoing a revision that made things worse

def snapshot(session, agent) -> None:
    dest = session.dir / f"critic_snap_{agent.name}"
    shutil.rmtree(dest, ignore_errors=True)
    total, kept = 0, []
    for p in delivered(session):
        total += p.stat().st_size
        if total > SNAPSHOT_MAX:
            break
        try:
            rel = p.relative_to(session.cwd)
        except ValueError:
            continue
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dest / rel)
        kept.append(rel)
    agent.critic_snapshot = dest if kept else None


def settle(session, agent) -> str:
    """Last word before the answer is accepted. If the version the critic reviewed passed its skill gate and the revised one
    does not, the reviewed version comes back: a review must never leave the delivery worse than it found it."""
    from . import skills as skills_mod
    snap = getattr(agent, "critic_snapshot", None)
    if not snap or not skills_mod.gate_pending(session):
        return ""
    for f in Path(snap).rglob("*"):
        if f.is_file():
            target = session.cwd / f.relative_to(snap)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, target)
    for name in session.skill_gates:
        session.skill_gates[name] = True                 # the restored files are the ones that passed
    agent.critic_snapshot = None
    session.bus.emit("notice", level="warn", agent=agent.name,
                     text="the revision asked by the quality review left the skill check failing; restored the version that passed")
    return ("\n\n[harness] The changes made after the quality review left the delivery failing its own check, so the files were restored "
            "to the version that passed. The points raised by the review are still open.")


# ------------------------------------------------------------------ the review

def parse(text: str) -> tuple[str, list[dict]]:
    """(verdict, defects). An answer that cannot be read approves: a broken reviewer must not hold the work hostage."""
    m = re.search(r"\{.*\}", text or "", re.S)
    data, ok = repair_json(m.group()) if m else ({}, False)
    if not ok or not isinstance(data, dict):
        return "approve", []
    defects = [d for d in (data.get("defects") or []) if isinstance(d, dict) and str(d.get("problem") or "").strip()][:3]
    verdict = "revise" if str(data.get("verdict", "")).lower().startswith("rev") and defects else "approve"
    return verdict, defects


def feedback(defects: list[dict], who: str, n: int, total: int) -> str:
    lines = [f"[quality review by {who}, round {n} of {total}] The work is not accepted yet. Fix these, most important first:"]
    for i, d in enumerate(defects, 1):
        lines.append(f"{i}. {str(d.get('problem', '')).strip()}")
        for label, key in (("Evidence", "evidence"), ("Do", "fix"), ("Done when", "done_when")):
            if str(d.get(key) or "").strip():
                lines.append(f"   {label}: {str(d[key]).strip()}")
        if d.get("check"):
            lines.append(f"   The harness will run this when you say you are done, and it must pass (it fails now): {d['check']}")
    lines.append("Change the work itself (rerun the scripts, regenerate the files), run your checks again, then give your final answer. "
                 "If a point is wrong or impossible here, say why in one line instead of faking it.")
    if any(EVIDENCE in str(d.get("check") or "") for d in defects):
        lines.append(f"The values in {EVIDENCE} must be computed and written by your script in the same run that produces the delivery, "
                     "never typed by hand, and the delivery must show the same numbers.")
    return "\n".join(lines)


def review(session, agent, answer: str) -> str:
    """One review of what `agent` is about to deliver. Returns the message that sends it back to work, or "" to accept."""
    who = model(session)
    first = next((m["content"] for m in agent.messages if m.get("role") == "user"), "")
    task = first if isinstance(first, str) else next((p.get("text", "") for p in first if p.get("type") == "text"), "")
    agent.critic_rounds += 1
    total = int(session.cfg.get("critic_rounds", 2)) if agent.role == "main" else 1
    extra = rubrics(session)
    before = "\n".join(f"- {d.get('problem', '')}" + (" [its check now passes]" if d.get("fixed") else " [its check still fails]" if d.get("check") else
                                                    " [no check]") for d in agent.critic_defects)
    user = (f"# Task given to the worker\n{task[:6000]}\n\n"
            + (f"# Criteria for this kind of work\n{extra}\n\n" if extra else "")
            + (f"# Defects you raised in the previous round\n{before}\n\n" if before else "")
            + f"# Shell the checks run in\n{getattr(session, 'shell_name', 'shell')}, working directory = the delivery folder, python available\n\n"
            + f"# The worker's final answer\n{(answer or '')[:4000]}\n\n# What was delivered (digest of the files)\n{digest(session)}")
    session.bus.emit("notice", level="info", text=f"quality review ({who}), round {agent.critic_rounds}", agent=agent.name)
    try:
        r = session.llm.chat(who, [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], agent="critic", max_tokens=3000)
    except Exception as e:                                # the layer is an extra: a provider error must not fail the task
        session.bus.emit("notice", level="warn", text=f"quality review skipped: {type(e).__name__}: {str(e)[:160]}", agent=agent.name)
        return ""
    session.add_usage(r, getattr(r, "model", "") or who, "critic", "critic")
    verdict, defects = parse(r.content)
    if verdict == "revise":
        ground(session, defects)
        if agent.critic_rounds > 1:                       # the stop rule: past the first review, only what can be verified counts
            defects = [d for d in defects if d.get("check")]
            verdict = "revise" if defects else "approve"
    session.bus.emit("critic", agent=agent.name, model=who, round=agent.critic_rounds, verdict=verdict,
                     defects=[str(d.get("problem", ""))[:300] for d in defects], checks=sum(bool(d.get("check")) for d in defects))
    if verdict == "approve":
        agent.critic_defects = []
        return ""
    agent.critic_defects, agent.critic_pushes = defects, 0
    snapshot(session, agent)                              # the version under review passed its gate: keep it in case the fix breaks it
    for name in session.skill_gates:                      # the delivery is about to change: its mechanical check must pass again
        session.skill_gates[name] = False
    return feedback(defects, who, agent.critic_rounds, total)
