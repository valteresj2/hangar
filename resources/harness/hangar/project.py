"""The project's own harness surface, in the layout Claude Code established (and the Hangar desktop app edits):

    CLAUDE.md, .claude/CLAUDE.md          instructions           -> system prompt
    .claude/skills/<name>/SKILL.md        skills                 -> skills.py (already)
    .claude/agents/<name>.md              sub-agent definitions  -> task(prompt, agent="name")
    .claude/commands/**/<name>.md         slash commands         -> "/name args" expands to the command's prompt
    .claude/settings.json  "hooks"        PreToolUse / PostToolUse / Stop command hooks -> hooks.py

`.hangar/agents` and `.hangar/commands` work the same and win over `.claude/` on a name clash.
Reading these makes a harness change in a project (or a Lab variant of it) take effect on this engine too."""
from __future__ import annotations

import json
import re
from pathlib import Path

_FRONT = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.S)


def _split(text: str) -> tuple[dict, str]:
    m = _FRONT.match(text)
    meta: dict = {}
    if not m:
        return meta, text
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and k.strip() and not k.startswith((" ", "\t", "-")):
            meta[k.strip()] = v.strip().strip("\"'")
    return meta, text[m.end():]


def instructions(cwd: Path) -> list[tuple[str, str]]:
    """(label, text) of every instruction file that applies: the root one, plus .claude/CLAUDE.md when present."""
    out: list[tuple[str, str]] = []
    for name in ("HANGAR.md", "AGENTS.md", "CLAUDE.md"):
        p = cwd / name
        if p.is_file():
            try:
                out.append((name, p.read_text(encoding="utf-8", errors="replace")[:6000]))
            except OSError:
                pass
            break
    p = cwd / ".claude" / "CLAUDE.md"
    if p.is_file():
        try:
            out.append((".claude/CLAUDE.md", p.read_text(encoding="utf-8", errors="replace")[:6000]))
        except OSError:
            pass
    return out


def agents(cwd: Path) -> dict[str, dict]:
    """Sub-agent definitions: {name: {description, prompt}}. The file body is that agent's system prompt."""
    found: dict[str, dict] = {}
    for root in (cwd / ".hangar" / "agents", cwd / ".claude" / "agents"):
        for f in sorted(root.glob("*.md")) if root.is_dir() else []:
            try:
                meta, body = _split(f.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            name = (meta.get("name") or f.stem).strip()
            if name and body.strip():
                found.setdefault(name, {"description": meta.get("description", "")[:200], "prompt": body.strip()[:12000]})
    return dict(list(found.items())[:20])


def commands(cwd: Path) -> dict[str, dict]:
    """Slash commands: {name: {description, hint, template}}. Sub-folders namespace with ':' (git/commit.md -> git:commit)."""
    found: dict[str, dict] = {}
    for root in (cwd / ".hangar" / "commands", cwd / ".claude" / "commands"):
        for f in sorted(root.rglob("*.md")) if root.is_dir() else []:
            try:
                meta, body = _split(f.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            name = ":".join(f.relative_to(root).with_suffix("").parts)
            if body.strip():
                found.setdefault(name, {"description": meta.get("description", "")[:200], "hint": meta.get("argument-hint", ""),
                                        "template": body.strip()})
    return found


def expand_command(cwd: Path, text: str) -> tuple[str, str | None]:
    """'/name args' -> the command's prompt with $ARGUMENTS, $1.. filled in. Returns (text, command name or None)."""
    m = re.match(r"^\s*/([\w:.\-]+)(?:\s+(.*))?$", text or "", re.S)
    if not m:
        return text, None
    cmd = commands(cwd).get(m.group(1))
    if not cmd:
        return text, None
    args = (m.group(2) or "").strip()
    body = cmd["template"]
    had_placeholder = "$ARGUMENTS" in body or re.search(r"\$\d", body)
    body = body.replace("$ARGUMENTS", args)
    for i, a in enumerate(args.split(), 1):
        body = body.replace(f"${i}", a)
    body = re.sub(r"\$\d+", "", body)
    if args and not had_placeholder:
        body += f"\n\n{args}"
    return body, m.group(1)


# ------------------------------------------------------------ Claude Code hooks

# harness tool name -> the name Claude Code hooks match on
CLAUDE_NAME = {"read": "Read", "write": "Write", "edit": "Edit", "glob": "Glob", "grep": "Grep", "shell": "Bash",
               "web_fetch": "WebFetch", "web_search": "WebSearch", "task": "Task", "plan": "TodoWrite", "ask_user": "AskUserQuestion",
               "skill": "Skill"}


def claude_tool(name: str, args: dict, cwd: Path) -> tuple[str, dict]:
    """A harness tool call as the (tool_name, tool_input) a Claude Code hook script expects."""
    def p(v):
        if not v:
            return v
        q = Path(str(v))
        return str(q if q.is_absolute() else (cwd / q))
    if name in ("read", "write", "edit"):
        inp = {"file_path": p(args.get("path"))}
        if name == "write":
            inp["content"] = args.get("content", "")
        if name == "edit":
            inp.update(old_string=args.get("old", ""), new_string=args.get("new", ""))
        return CLAUDE_NAME[name], inp
    if name == "shell":
        return "Bash", {"command": args.get("command", "")}
    return CLAUDE_NAME.get(name, name), dict(args or {})


def claude_hooks(cwd: Path) -> dict[str, list[dict]]:
    """{'PreToolUse' | 'PostToolUse' | 'Stop': [{matcher, command, timeout}]} from .claude/settings.json."""
    f = cwd / ".claude" / "settings.json"
    try:
        raw = json.loads(f.read_text(encoding="utf-8")).get("hooks") or {}
    except (OSError, ValueError, AttributeError):
        return {}
    out: dict[str, list[dict]] = {}
    for event in ("PreToolUse", "PostToolUse", "Stop"):
        for group in raw.get(event) or []:
            if not isinstance(group, dict):
                continue
            for h in group.get("hooks") or []:
                if isinstance(h, dict) and h.get("type", "command") == "command" and h.get("command"):
                    out.setdefault(event, []).append({"matcher": str(group.get("matcher") or ""), "command": str(h["command"]),
                                                      "timeout": int(h.get("timeout") or 60)})
    return out


def matches(matcher: str, tool: str) -> bool:
    if matcher in ("", "*"):
        return True
    try:
        return re.fullmatch(matcher, tool) is not None
    except re.error:
        return matcher == tool
