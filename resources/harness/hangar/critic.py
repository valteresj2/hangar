"""Quality layer: before an agent's "I'm done" is accepted, the strongest model on the team reads the delivery and either
approves it or sends back up to three concrete improvements.

Why it is cheap: it runs only after the free checks passed (exit codes, hooks, skill gates), it is ONE call without tools
over a digest of the delivery (not the transcript), and it speaks at most `critic_rounds` times per agent. The cheap model
does all the work; the expensive one is paid only for judgement.

Config: critic_model ("" off, "auto" = strongest on the roster, or a model id), critic_rounds (2), critic_scope
("final" = the main agent's answer; "all" = sub-agents and the planner too). A skill loaded in the session adds its own
criteria from a RUBRIC.md next to its SKILL.md."""
from __future__ import annotations

import re
from pathlib import Path

from .toolcall import repair_json

DIGEST = 44_000                # chars of delivery shown to the critic (about 12k tokens)
PER_FILE = 16_000
TEXT = {".html", ".htm", ".md", ".txt", ".json", ".csv", ".tsv", ".py", ".js", ".ts", ".sql", ".yaml", ".yml", ".toml", ".sh", ".ps1",
        ".css", ".xml", ".ipynb", ".r", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".rb", ".php"}
PROSE_FIRST = (".html", ".htm", ".md", ".txt", ".json")
SKIP_DIRS = {".git", ".hangar", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}

SYSTEM = """You are the quality reviewer of a team of AI agents: the strongest model on the team, called once, after the work already \
passed its mechanical checks. A cheaper model did the work. You judge substance, not form.

Ask what an expert in this domain would object to: Is the method sound for how the result will be used? Do the conclusions follow from \
the evidence shown? Is a number misleading because of how it was computed? Is something the task asked for missing or only gestured at? \
Is there an obvious next question the delivery should have answered?

Rules:
- Report at most 3 defects, ordered by how much they would change a decision made from this work. No polish, no style notes.
- Each defect must quote or point at evidence in the delivery, say exactly what to do, and say how to tell it is fixed.
- The worker can run code and edit files but cannot ask you questions: instructions must be self-contained and feasible in a few steps.
- Approve when what remains is polish. In a later round, approve unless a defect you raised is still open or the fix broke something.

Reply with ONLY this JSON:
{"verdict": "approve" | "revise", "defects": [{"problem": "...", "evidence": "...", "fix": "...", "done_when": "..."}]}"""


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


def applies(session, agent) -> bool:
    if not model(session) or session.over_budget():
        return False
    rounds = int(session.cfg.get("critic_rounds", 2))
    if agent.role == "main":
        return agent.critic_rounds < rounds
    return str(session.cfg.get("critic_scope", "final")) == "all" and agent.role in ("sub", "planner") and agent.critic_rounds < min(1, rounds)


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


def digest(session) -> str:
    """What was delivered: the files the session wrote (by tool or by a script it ran), prose first, code after."""
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
    parts, left = [], DIGEST
    for p in files:
        body = _read(p)
        if not body.strip():
            continue
        body = body[:left]
        try:
            name = str(p.relative_to(session.cwd)).replace("\\", "/")
        except ValueError:
            name = str(p)
        parts.append(f"=== {name} ===\n{body}")
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
    lines.append("Change the work itself (rerun the scripts, regenerate the files), run your checks again, then give your final answer. "
                 "If a point is wrong or impossible here, say why in one line instead of faking it.")
    return "\n".join(lines)


def review(session, agent, answer: str) -> str:
    """One review of what `agent` is about to deliver. Returns the message that sends it back to work, or "" to accept."""
    who = model(session)
    first = next((m["content"] for m in agent.messages if m.get("role") == "user"), "")
    task = first if isinstance(first, str) else next((p.get("text", "") for p in first if p.get("type") == "text"), "")
    agent.critic_rounds += 1
    total = int(session.cfg.get("critic_rounds", 2)) if agent.role == "main" else 1
    extra = rubrics(session)
    before = "\n".join(f"- {d.get('problem', '')}" for d in agent.critic_defects)
    user = (f"# Task given to the worker\n{task[:6000]}\n\n"
            + (f"# Criteria for this kind of work\n{extra}\n\n" if extra else "")
            + (f"# Defects you raised in the previous round (check whether each is fixed)\n{before}\n\n" if before else "")
            + f"# The worker's final answer\n{(answer or '')[:4000]}\n\n# What was delivered (digest of the files)\n{digest(session)}")
    session.bus.emit("notice", level="info", text=f"quality review ({who}), round {agent.critic_rounds}", agent=agent.name)
    try:
        r = session.llm.chat(who, [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], agent="critic", max_tokens=3000)
    except Exception as e:                                # the layer is an extra: a provider error must not fail the task
        session.bus.emit("notice", level="warn", text=f"quality review skipped: {type(e).__name__}: {str(e)[:160]}", agent=agent.name)
        return ""
    session.add_usage(r, getattr(r, "model", "") or who, "critic", "critic")
    verdict, defects = parse(r.content)
    session.bus.emit("critic", agent=agent.name, model=who, round=agent.critic_rounds, verdict=verdict,
                     defects=[str(d.get("problem", ""))[:300] for d in defects])
    if verdict == "approve":
        return ""
    agent.critic_defects = defects
    for name in session.skill_gates:                      # the delivery is about to change: its mechanical check must pass again
        session.skill_gates[name] = False
    return feedback(defects, who, agent.critic_rounds, total)
