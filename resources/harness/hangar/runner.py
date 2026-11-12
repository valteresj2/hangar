"""run_task: the one entry point used by the CLI, the dashboard and the benchmark."""
from __future__ import annotations

from pathlib import Path

from . import lessons, media
from .graph import load_workflow, run_graph
from .llm import LLMError
from .session import Session, Stopped


def build_input(session: Session, task: str, attachments: list[str]):
    """Attach media natively when the model can take it; otherwise convert it to text first."""
    info = session.catalog.info(session.model)
    parts, notes = [], []
    for a in attachments or []:
        p = Path(a).expanduser()
        p = (p if p.is_absolute() else session.cwd / p).resolve()
        if not p.is_file():
            notes.append(f"[attachment {a}: file not found]")
            continue
        kind = media.kind_of(p)
        if kind == "text":
            notes.append(f"[attached file: {p} — read it with the read tool]")
        elif media.supports(info, kind) and info["provider"] == "openrouter":
            parts.append(media.part_for(p, kind))
            notes.append(f"[attached {kind}: {p.name} (included in this message; path {p})]")
            session.bus.emit("attachment", path=str(p), kind=kind, mode="native")
        else:
            session.bus.emit("attachment", path=str(p), kind=kind, mode="perception")
            desc = media.describe(session, p, "Describe everything in this input that could matter for the task below, "
                                              f"transcribing text and speech verbatim.\nTask: {task}")
            notes.append(f"[attached {kind}: {p} — you cannot perceive it directly; a perception model reports:]\n{desc}\n"
                         "[use the perceive tool on that path to ask follow-up questions about it]")
    text = task + ("\n\n" + "\n".join(notes) if notes else "")
    if session.cfg.get("lessons", True):
        text += lessons.prompt_block(session, task)      # appended to the task, so the system prompt stays cache-stable
    return [{"type": "text", "text": text}, *parts] if parts else text


def run_task(cfg: dict, task: str, cwd: Path, model: str | None = None, workflow: str | None = None,
             attachments: list[str] | None = None, interactive: str = "none", answers: list | None = None,
             on_event=None, sid: str | None = None) -> dict:
    workflow = workflow or cfg["workflow"]
    s = Session(cfg, cwd, task=task, model=model, workflow=workflow, interactive=interactive, answers=answers, sid=sid)
    if on_event:
        s.bus.subscribe(on_event)
    s.bus.emit("session_start", id=s.id, task=task, model=s.model, workflow=workflow, cwd=str(s.cwd),
               tier=s.catalog.info(s.model)["tier"], attachments=attachments or [])
    status, final = "done", ""
    try:
        s.mcp.load()
        wf = load_workflow(workflow, s.cwd)
        final = run_graph(s, wf, build_input(s, task, attachments or []))
        s.bus.emit("final", text=final)
        if s.incomplete:
            status = "incomplete"
    except Stopped:
        status, final = "stopped", "Stopped by the user."
    except KeyboardInterrupt:
        status, final = "stopped", "Interrupted."
    except LLMError as e:
        status, final = "error", f"Model error — {e}"
        s.bus.emit("notice", level="error", text=final)
    except Exception as e:
        status, final = "error", f"{type(e).__name__}: {e}"
        s.bus.emit("notice", level="error", text=final)
    return _close(s, status, final)


def _close(s: Session, status: str, final: str) -> dict:
    """End-of-session duties that must never break the result: learn, run session_end hooks, then finish."""
    try:
        lessons.reflect(s, {"status": status, "final": final})
        s.hooks.session_end({"status": status, "final": final, "session": s.id, "files": sorted(s.files)})
    except Exception as e:
        s.bus.emit("notice", level="warn", text=f"end-of-session step failed: {type(e).__name__}: {e}")
    return s.finish(status, final)


def resume_task(cfg: dict, sid: str, extra: str = "", interactive: str = "none", on_event=None) -> dict:
    """Continue an interrupted session (or give a finished one a follow-up instruction) from its saved state."""
    import json
    from .session import SESSIONS
    meta = json.loads((SESSIONS / sid / "meta.json").read_text(encoding="utf-8"))
    s = Session(cfg, Path(meta["cwd"]), task=meta["task"], model=meta["model"], workflow=meta["workflow"],
                interactive=interactive, sid=sid)
    if on_event:
        s.bus.subscribe(on_event)
    s.bus.emit("session_start", id=s.id, task=meta["task"], model=s.model, workflow=s.workflow, cwd=str(s.cwd),
               tier=s.catalog.info(s.model)["tier"], attachments=[], resumed=True)
    try:
        (s.dir / "stop").unlink()
    except OSError:
        pass
    status, final = "done", ""
    try:
        s.mcp.load()
        final = run_graph(s, load_workflow(s.workflow, s.cwd), meta["task"], resume=True, extra=extra)
        s.bus.emit("final", text=final)
        if s.incomplete:
            status = "incomplete"
    except (Stopped, KeyboardInterrupt):
        status, final = "stopped", "Stopped."
    except LLMError as e:
        status, final = "error", f"Model error — {e}"
        s.bus.emit("notice", level="error", text=final)
    except Exception as e:
        status, final = "error", f"{type(e).__name__}: {e}"
        s.bus.emit("notice", level="error", text=final)
    return _close(s, status, final)
