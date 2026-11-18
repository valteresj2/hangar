"""Lesson library: what earlier sessions learned the hard way, kept with evidence and reused.

Rules that keep it from becoming a pile of confident nonsense:
  - a lesson is only written from a session whose outcome was verified (last command exited 0 after the last edit,
    or an independent reviewer approved) AND that had real friction to learn from;
  - each lesson records where it came from (session, model, date) and the evidence it rests on;
  - lessons expire (default 90 days), near-duplicates merge instead of piling up, and the library is capped;
  - only a handful, picked by relevance to the new task, are shown to the model — as hints, not as instructions;
  - every use is settled when the session ends: did it end verified, and did the failure the lesson predicts it prevents
    (its `signal`, a fragment of the original error) show up again anyway? A lesson that keeps not preventing its own
    problem, or that never accompanies a verified session, is retired; it stays on disk with its record, and is not shown;
  - a lesson remembers the model tier it was learned with: what a weak model needed is not pushed onto a strong one;
  - lessons about the same recurring problem (same signal) merge, and only one of them is shown at a time."""
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
applies "always" = a quirk of the machine, the shell or the agent's own tools that bites whatever the task is;
applies "similar" = only matters for work like this task (the default; choose it when in doubt).

Reply with ONLY a JSON list (at most 2 items, or [] if nothing is worth keeping):
[{"scope": "project" | "general", "applies": "always" | "similar", "title": "<= 10 words", "situation": "when this applies",
  "lesson": "what to do, <= 240 chars", "evidence": "what happened in this session that proves it",
  "signal": "the failure this lesson prevents: a short fragment (8-60 chars) copied LITERALLY from an error line of the log, with no paths, numbers or names that change between runs, and SPECIFIC to this problem (not a message any failure prints, like 'file not found' or an exit code); \"\" if there is none"}]"""

RETIRE_RECURRED = 2         # times the predicted-prevented failure came back anyway
RETIRE_BLANK = 4            # uses without a single verified session
LOOSE = 2                   # at most this many hints that are there only because they claim to apply to any task
_KEEP = lambda d: {k: v for k, v in d.items() if not k.startswith("_")}  # noqa: E731
# messages so many unrelated failures print that seeing one again says nothing about a lesson
_GENERIC = {"file not found", "no such file or directory", "not found", "permission denied", "access is denied", "syntax error",
            "invalid syntax", "command not found", "traceback most recent call last", "command failed", "an error occurred",
            "is not recognized as an internal or external command", "the system cannot find the file specified",
            "the system cannot find the path specified", "non zero exit status", "connection refused", "timed out"}


def _save(d: dict) -> None:
    try:
        d["_file"].write_text(json.dumps(_KEEP(d), ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass


def _sigkey(text) -> str:
    """Signals that differ only in case, spacing or punctuation are the same problem."""
    return " ".join(re.findall(r"[a-z0-9À-ÿ_]+", str(text or "").lower()))


def _signal(text) -> str:
    """The fragment as it is searched for in a log, or "" when it is too short, too long or too common to mean anything."""
    s = " ".join(str(text or "").lower().split())
    key = _sigkey(s)
    if not 8 <= len(s) <= 80 or key in _GENERIC or len(key.split()) < 3 or re.fullmatch(r"(exit|exit code|code|errno|error) ?\d+", key):
        return ""
    return s


_WORD = re.compile(r"[a-zA-ZÀ-ÿ_][\w.\-]{2,}")
# words that say "this is a programming task", not what the task is about
_STOP = {"the", "and", "for", "com", "que", "para", "uma", "this", "that", "with", "from", "nao", "não", "dos", "das", "use", "usar",
         "using", "file", "files", "arquivo", "arquivos", "leia", "read", "implemente", "implement", "teste", "testes", "test",
         "tests", "testar", "código", "codigo", "code", "erro", "erros", "error", "errors", "python", "antes", "before", "todos",
         "todas", "all", "como", "quando", "when", "seu", "sua", "seus", "suas", "your", "deve", "should", "está", "esta", "são",
         "not", "por", "mais", "além", "also", "cada", "each", "run", "rode", "execute", "faça", "make", "crie", "create",
         "tarefa", "task", "você", "you", "are", "ser", "sem", "ele", "ela", "isso", "into", "then", "than", "have", "has",
         "inteira", "atenção", "completo", "completa", "corrija", "fix", "encontre", "find", "dar", "pelo", "pela", "aqui",
         "here", "após", "after", "outro", "outra", "other", "novo", "nova", "new", "ainda", "pode", "can", "may", "must"}


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
    """Project lessons first, then general ones that have something to do with this task.
    A general lesson gets in when its own text shares two meaningful words with the task, when the task it came from is
    mostly the same task, or when it was filed as applying to any task (a few of those at most)."""
    cwd, want, head = str(session.cwd).lower(), _words(task), _words(task[:300])
    tier = session.catalog.info(session.model)["tier"]
    scored = []
    for d in load(int(session.cfg.get("lessons_max_age_days", 90))):
        mine = d.get("scope") == "project"
        if mine and str(d.get("project", "")).lower() != cwd:
            continue
        if d.get("retired") or (not mine and d.get("tier") == "weak" and tier == "strong"):
            continue
        # the lesson may be written in another language than the task, so also compare against the task it came from
        origin = _words(d.get("task", ""))               # stored cut to 300 chars, so compare like with like
        direct = len(want & _words(d.get("title", "") + " " + d.get("situation", "") + " " + d.get("lesson", "")))
        same = len(head & origin) / len(origin) if len(origin) >= 4 else 0.0
        fits = mine or direct >= 2 or same >= 0.5
        if fits or d.get("applies") == "always":
            tried = int(d.get("tried", 0))
            record = (int(d.get("ok", 0)) - int(d.get("recurred", 0))) / tried if tried else 0.0     # what its own history says
            scored.append((mine, fits, 2 * direct + len(head & origin), record, d.get("created", 0), d))
    scored.sort(key=lambda x: x[:5], reverse=True)
    out, seen, loose = [], set(), 0
    for _, fits, *_, d in scored:
        sig = _sigkey(_signal(d.get("signal")))
        if (sig and sig in seen) or (not fits and loose >= LOOSE):     # one hint per recurring problem
            continue
        seen.add(sig)
        loose += not fits
        out.append(d)
    return out[:limit]


def prompt_block(session, task: str) -> str:
    picked = select(session, task, 3 if session.catalog.info(session.model)["tier"] == "weak" else 5)
    if not picked:
        return ""
    for d in picked:
        d["uses"] = int(d.get("uses", 0)) + 1
        _save(d)
    session.lessons_used = [str(d["_file"]) for d in picked]           # settled when the session ends
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


def settle(session, summary: dict) -> list[dict]:
    """Called once when a session ends, before reflect: write down how the lessons it was shown fared.
    Returns the lessons retired by this session. No model call."""
    used = getattr(session, "lessons_used", None) or []
    session.lessons_used = []
    if not used:
        return []
    digest, facts = _digest(session.dir)
    verified = summary.get("status") == "done" and bool(facts["approved"] or (session.last_exit == 0 and not session.edits_since_run))
    tier, log, retired = session.catalog.info(session.model)["tier"], digest.lower(), []
    for path in used:
        try:
            d = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        d["_file"] = Path(path)
        sig = _signal(d.get("signal"))
        back = bool(sig and sig in " ".join(log.split()))
        d["tried"], d["ok"], d["recurred"] = int(d.get("tried", 0)) + 1, int(d.get("ok", 0)) + verified, int(d.get("recurred", 0)) + back
        by = d.setdefault("by_tier", {}).setdefault(tier, [0, 0])
        by[0], by[1] = by[0] + verified, by[1] + 1
        d["last"] = {"session": session.id, "model": session.model, "verified": verified, "recurred": back, "at": time.time()}
        d["models"] = sorted(set(d.get("models", [])) | {session.model})[:12]
        # a model that verifies nothing would retire every lesson it is shown: the blank rule needs a second model
        why = ("the failure it should prevent came back in half of its uses or more" if d["recurred"] >= RETIRE_RECURRED and d["recurred"] * 2 >= d["tried"]
               else f"{d['tried']} uses, no verified session" if d["tried"] >= RETIRE_BLANK and not d["ok"] and len(d["models"]) >= 2 else "")
        if why and not d.get("retired"):
            d["retired"] = why
            retired.append(d)
        _save(d)
    if retired:
        session.bus.emit("lessons", retired=[d.get("title", "") for d in retired])
    return retired


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
                  "applies": "always" if item.get("applies") == "always" else "similar",
                  "task": str(session.meta.get("task", ""))[:300],
                  "session": session.id, "model": session.model, "created": time.time(), "uses": 0,
                  "signal": _signal(item.get("signal")), "tier": session.catalog.info(session.model)["tier"]}
        if lesson["signal"] and lesson["signal"] not in " ".join(digest.lower().split()):
            lesson["signal"] = ""                        # not in the log it claims to quote: a prediction nobody could check
        twin = next((d for d in existing if d.get("scope") == lesson["scope"] and (lesson["scope"] == "general" or d.get("project") == lesson["project"])
                     and ((lesson["signal"] and _sigkey(_signal(d.get("signal"))) == _sigkey(lesson["signal"]))   # the same recurring problem
                          or difflib.SequenceMatcher(None, d.get("lesson", "").lower(), lesson["lesson"].lower()).ratio() > 0.72)), None)
        if twin:                                         # seen again: refresh it instead of storing a twin
            twin.update(created=lesson["created"], confirmations=int(twin.get("confirmations", 1)) + 1)
            if not twin.get("signal") and lesson["signal"]:
                twin["signal"] = lesson["signal"]
            _save(twin)
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
