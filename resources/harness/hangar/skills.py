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
            name, desc = f.parent.name, ""
            m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
            if m:
                for line in m.group(1).splitlines():
                    k, _, v = line.partition(":")
                    if k.strip() == "name" and v.strip():
                        name = v.strip().strip("\"'")
                    elif k.strip() == "description":
                        desc = v.strip().strip("\"'")
            found.setdefault(name, {"path": f, "description": desc[:160]})
    return dict(list(found.items())[:30])


def index(skills: dict) -> str:
    return "\n".join(f"- {n}: {s['description']}" for n, s in skills.items())


def load(skills: dict, name: str) -> str:
    s = skills.get(name)
    if not s:
        return f"Error: unknown skill '{name}'. Available: {', '.join(skills) or '(none)'}"
    text = s["path"].read_text(encoding="utf-8", errors="replace")
    return f"[skill {name} — files in {s['path'].parent}]\n{text}"
