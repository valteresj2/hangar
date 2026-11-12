"""Lesson library: what earlier sessions learned the hard way, kept with evidence and reused.

Rules that keep it from becoming a pile of confident nonsense:
  - a lesson is only written from a session whose outcome was verified (last command exited 0 after the last edit,
    or an independent reviewer approved) AND that had real friction to learn from;
  - each lesson records where it came from (session, model, date) and the evidence it rests on;
  - lessons expire (default 90 days), near-duplicates merge instead of piling up, and the library is capped;
  - only a handful, picked by relevance to the new task, are shown to the model — as hints, not as instructions."""
from __future__ import annotations

import difflib
import json
import re
import time
from pathlib import Path

from .config import HOME
from .toolcall import repair_json

DIR = HOME / "lessons"
CAP = 200

REFLECT = """You are reviewing a finished agent session to extract lessons for FUTURE sessions.
Write a lesson only if it would have saved real time here AND is likely to apply again. Good lessons are specific and
actionable: an environment quirk, a command that works on this machine, a project convention, a mistake pattern and its fix.
Bad lessons: generic advice ("test your code"), a retelling of this task, anything not backed by the evidence below,
and anything a PROJECT RULE blocked or that works around such a rule (rules are policy, not obstacles to route around).
Write the lesson in the language of the task.

scope "project" = true only for this working folder; scope "general" = true for this machine/toolchain anywhere.

Reply with ONLY a JSON list (at most 2 items, or [] if nothing is worth keeping):
[{"scope": "project" | "general", "title": "<= 10 words", "situation": "when this applies",
  "lesson": "what to do, <= 240 chars", "evidence": "what happened in this session that proves it"}]"""

_WORD = re.compile(r"[a-zA-ZÀ-ÿ_][\w.\-]{2,}")
_STOP = {"the", "and", "for", "com", "que", "para", "uma", "com", "this", "that", "with", "from", "nao", "não", "dos", "das", "use", "file", "arquivo"}


def _words(text: str) -> set[str]:
    return {w.lower() for w in _WORD.findall(text or "")} - _STOP


def load(max_age_days: int = 90) -> list[dict]:
    out, limit = [], time.time() - max_age_days * 86400
    for f in sorted(DIR.glob("*.json")) if DIR.is_dir() else []:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if d.get("created", 0) >= limit and d.get("lesson"):
            d["_file"] = f
            out.append(d)
    return out


def select(session, task: str, limit: int = 5) -> list[dict]:
    """Project lessons first, then general ones ranked by word overlap with the task."""
    cwd, want = str(session.cwd).lower(), _words(task)
    scored = []
    for d in load(int(session.cfg.get("lessons_max_age_days", 90))):
        mine = d.get("scope") == "project"
        if mine and str(d.get("project", "")).lower() != cwd:
            continue
        # the lesson may be written in another language than the task, so also compare against the task it came from
        overlap = (2 * len(want & _words(d.get("title", "") + " " + d.get("situation", "") + " " + d.get("lesson", "")))
                   + len(want & _words(d.get("task", ""))))
        if mine or overlap >= 3:
            scored.append((mine, overlap, d.get("created", 0), d))
    scored.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
    return [d for *_, d in scored[:limit]]


def prompt_block(session, task: str) -> str:
    picked = select(session, task, 3 if session.catalog.info(session.model)["tier"] == "weak" else 5)
    if not picked:
        return ""
    for d in picked:
        try:
            d["uses"] = int(d.get("uses", 0)) + 1
            d["_file"].write_text(json.dumps({k: v for k, v in d.items() if not k.startswith("_")}, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            pass
    session.bus.emit("lessons", used=[d["title"] for d in picked])
    lines = [f"- {d['title']}: {d['lesson']}" + (f" (when: {d['situation']})" if d.get("situation") else "") for d in picked]
    return ("\n\n[Hints from earlier verified sessions on this machine — use them if they fit, ignore them if they do not]\n"
            + "\n".join(lines))


def _digest(session_dir: Path) -> tuple[str, dict]:
    """Compact evidence for the reflector: the friction, not the whole transcript."""
    lines, facts = [], {"errors": 0, "approved": False, "rejected": 0, "escalated": False, "gates": 0}
    try:
        events = [json.loads(l) for l in (session_dir / "events.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    except (OSError, ValueError):
        return "", facts
    names = {}
    for e in events:
        t = e.get("type")
        if t == "tool_start":
            names[e["id"]] = f"{e['name']} {json.dumps(e.get('args', {}), ensure_ascii=False)[:160]}"
        elif t == "tool_end" and not e.get("ok"):
            facts["errors"] += 1
            lines.append(f"TOOL ERROR {names.get(e['id'], e.get('name'))} -> {e.get('preview', '')[:300]}")
        elif t == "tool_end" and e.get("name") == "shell" and re.search(r"\[exit (?!0\])-?\d+\]", e.get("preview", "")[-40:]):
            facts["errors"] += 1
            lines.append(f"COMMAND FAILED {names.get(e['id'], '')} -> {e.get('preview', '')[-300:]}")
        elif t == "notice" and e.get("level") in ("warn", "error"):
            facts["gates"] += 1
            facts["escalated"] |= str(e.get("text", "")).startswith("escalated")
            lines.append(f"HARNESS {e.get('text', '')[:240]}")
        elif t == "verdict":
            facts["approved"] |= e.get("verdict") == "approve"
            facts["rejected"] += e.get("verdict") == "revise"
            lines.append(f"REVIEWER {e.get('verdict')}: {e.get('feedback', '')[:300]}")
        elif t == "hook":
            lines.append(f"PROJECT RULE {e.get('event')} {e.get('action')}: {e.get('message', '')[:200]}")
        elif t == "answer":
            lines.append(f"USER ANSWERED: {str(e.get('answer'))[:200]}")
    return "\n".join(lines)[-9000:], facts


def reflect(session, summary: dict) -> list[dict]:
    """Called once when a session ends. Returns the lessons it stored (possibly none)."""
    if not session.cfg.get("lessons", True) or summary.get("status") != "done":
        return []
    digest, facts = _digest(session.dir)
    verified = facts["approved"] or (session.last_exit == 0 and not session.edits_since_run)
    friction = facts["errors"] >= 2 or facts["rejected"] or facts["escalated"] or facts["gates"] >= 2
    if not (verified and friction and digest):
        return []                                        # nothing proven, or nothing to learn: spend no tokens
    user = (f"TASK: {session.meta.get('task', '')[:800]}\nWORKING FOLDER: {session.cwd}\nMODEL: {session.model}\n"
            f"OUTCOME: verified done\n\nFRICTION LOG:\n{digest}\n\nFINAL ANSWER:\n{summary.get('final', '')[:800]}")
    try:
        r = session.llm.chat(session.cfg["helper_model"], [{"role": "system", "content": REFLECT}, {"role": "user", "content": user}],
                             max_tokens=700, agent="reflector", reasoning="")
        session.add_usage(r, session.cfg["helper_model"], "reflector")
    except Exception:
        return []
    text = r.content or ""
    data, ok = repair_json(text[text.find("["): text.rfind("]") + 1] if "[" in text else "[]")
    if not ok or not isinstance(data, list):
        return []
    existing, stored = load(3650), []
    DIR.mkdir(parents=True, exist_ok=True)
    for item in data[:2]:
        if not isinstance(item, dict) or not str(item.get("lesson", "")).strip() or not str(item.get("evidence", "")).strip():
            continue
        lesson = {"title": str(item.get("title", ""))[:80], "situation": str(item.get("situation", ""))[:200],
                  "lesson": str(item["lesson"])[:300], "evidence": str(item["evidence"])[:400],
                  "scope": "project" if item.get("scope") == "project" else "general", "project": str(session.cwd),
                  "task": str(session.meta.get("task", ""))[:300],
                  "session": session.id, "model": session.model, "created": time.time(), "uses": 0}
        twin = next((d for d in existing if d.get("scope") == lesson["scope"] and (lesson["scope"] == "general" or d.get("project") == lesson["project"])
                     and difflib.SequenceMatcher(None, d.get("lesson", "").lower(), lesson["lesson"].lower()).ratio() > 0.72), None)
        if twin:                                         # seen again: refresh it instead of storing a twin
            twin.update(created=lesson["created"], confirmations=int(twin.get("confirmations", 1)) + 1)
            twin["_file"].write_text(json.dumps({k: v for k, v in twin.items() if not k.startswith("_")}, ensure_ascii=False, indent=1), encoding="utf-8")
            continue
        f = DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{len(stored)}-{session.id[-4:]}.json"
        f.write_text(json.dumps(lesson, ensure_ascii=False, indent=1), encoding="utf-8")
        stored.append(lesson)
        existing.append({**lesson, "_file": f})
    for d in sorted(existing, key=lambda d: d.get("created", 0))[:-CAP] if len(existing) > CAP else []:
        try:
            d["_file"].unlink()
        except OSError:
            pass
    if stored:
        session.bus.emit("lessons", learned=[l["title"] for l in stored])
    return stored
