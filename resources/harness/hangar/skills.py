"""Skills with progressive disclosure: only name + one-line description live in the prompt;
the body is loaded by the `skill` tool when the model decides it needs it.
Compatible with Claude Code / Codex style `<dir>/<name>/SKILL.md` folders."""
from __future__ import annotations

import re
from pathlib import Path

from .config import HOME


BUILTIN = Path(__file__).resolve().parent / "skills"       # shipped with the harness; a project skill of the same name wins


def discover(cwd: Path, extra_dirs: list | None = None) -> dict[str, dict]:
    """Project skills + ~/.hangar/skills. Other global folders (e.g. ~/.claude/skills) are opt-in via
    `skills_dirs`: every listed skill costs prompt tokens and distracts weak models."""
    roots = [cwd / ".hangar" / "skills", cwd / ".claude" / "skills", cwd / ".agents" / "skills", HOME / "skills",
             *[Path(str(d)).expanduser() for d in extra_dirs or []], BUILTIN]
    found: dict[str, dict] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for f in sorted(root.glob("*/SKILL.md")):
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            name, desc, extra = f.parent.name, "", {}
            m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
            if m:
                for line in m.group(1).splitlines():
                    k, _, v = line.partition(":")
                    if k.strip() == "name" and v.strip():
                        name = v.strip().strip("\"'")
                    elif k.strip() == "description":
                        desc = v.strip().strip("\"'")
                    elif k.strip() in GATE_KEYS + ("triggers",) and v.strip():
                        extra[k.strip()] = v.strip().strip("\"'")
            found.setdefault(name, {"path": f, "description": desc[:160], **extra})
    return dict(list(found.items())[:30])


# A skill may name the check that proves its work is done. The harness then refuses "I'm done" until a command containing
# `gate` ran with exit 0 (and without `gate_fail` in its output): the model does not get to skip the check it was told to run.
GATE_KEYS = ("gate", "gate_fail", "gate_hint")


def gate_seen(session, cmd: str, code: int | None, output: str) -> None:
    """Called after every shell command: settles the gate of each loaded skill the command belongs to."""
    for name in session.skill_gates:
        s = session.skills.get(name) or {}
        if s.get("gate") and s["gate"] in cmd:
            session.skill_gates[name] = code == 0 and not (s.get("gate_fail") and s["gate_fail"] in output)


def gate_pending(session) -> str:
    """What to tell an agent that wants to finish while a loaded skill's check has not passed; "" when nothing is owed."""
    owed = [n for n, ok in session.skill_gates.items() if not ok]
    if not owed:
        return ""
    lines = [f"- {n}: {(session.skills.get(n) or {}).get('gate_hint') or (session.skills.get(n) or {}).get('gate')}" for n in owed]
    return ("Not finished: you loaded a skill whose check has not passed yet. Run it, fix everything it reports and run it again until it passes:\n"
            + "\n".join(lines) + "\nIf this task produced nothing that check applies to, say so in one line and give your final answer.")


def matches(skills: dict, task: str, loaded=()) -> list[str]:
    """The skills whose `triggers` appear in the task text and are not loaded yet."""
    low = task.lower()
    return [n for n, s in skills.items() if n not in loaded and any(
        re.search(r"(?<![\w-])" + re.escape(w.strip().lower()) + r"(?![\w-])", low) for w in (s.get("triggers") or "").split(",") if w.strip())]


def suggest(skills: dict, task: str, loaded=()) -> str:
    """A line for the task message when the task plainly is what a skill is for. A skill names its own `triggers` (words or
    phrases, comma separated); the index in the system prompt alone is easy to skip, and a strong model skips it most."""
    hits = matches(skills, task, loaded)
    if not hits:
        return ""
    names = ", ".join(f"`{n}`" for n in hits[:2])
    return (f"\n\n[harness] This task is what the skill {names} is for. Load it with the skill tool BEFORE anything else and follow "
            "it: it holds the way of working and the checks this kind of delivery is held to.")


def index(skills: dict) -> str:
    return "\n".join(f"- {n}: {s['description']}" for n, s in skills.items())


def load(skills: dict, name: str) -> str:
    s = skills.get(name)
    if not s:
        return f"Error: unknown skill '{name}'. Available: {', '.join(skills) or '(none)'}"
    text = s["path"].read_text(encoding="utf-8", errors="replace")
    return f"[skill {name} — files in {s['path'].parent}]\n{text}"
