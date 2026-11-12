"""`hangar bridge` — the harness as an engine for another program (the Hangar desktop app).
One long-lived process per conversation, newline-delimited JSON on stdin/stdout.

    host -> harness                                   harness -> host
    {"type":"start", cwd, model, base_url?,           {"type":"ready", session, resumed, model, tier, context_window}
       permission?, effort?, system_append?,          every event of the session log (delta, thinking, assistant,
       mcp_servers?, model_info?, resume?,            tool_start, tool_end, plan, question, permission, notice, compact...)
       max_steps?, max_cost_usd?}                     {"type":"turn_end", status, cost, prompt, completion, cached,
    {"type":"user", text, attachments?, images?,          cache_write, duration_ms, context_tokens, context_window, model}
       hidden?}
    {"type":"answer", qid, answer}                    Questions and permission requests block the turn until the host
    {"type":"permission_response", qid,               answers them by qid. The API key never travels in a message: the
       decision: allow|allow_always|deny, message?}   host passes it in the HANGAR_BRIDGE_KEY environment variable.
    {"type":"interrupt"}
    {"type":"set_options", model?, permission?, effort?}
    {"type":"close"}

stdout carries the protocol only; anything else the process prints goes to stderr."""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

from . import config, project
from .agent import Agent
from .llm import LLMError
from .runner import build_input
from .session import Session, Stopped

PERMISSIONS = ("auto", "ask", "edits", "readonly")
PLAN_NOTE = ("\n\n# Plan mode\nYou are in plan mode: investigate with read-only tools and present a concrete plan. "
             "Do not create, change or delete anything; writing and shell tools are disabled until the user leaves plan mode.")


class Channel:
    """Answers from the host, matched to the question that is waiting for them."""

    def __init__(self):
        self.cv = threading.Condition()
        self.answers: dict[str, dict] = {}

    def deliver(self, qid: str, payload: dict) -> None:
        with self.cv:
            self.answers[qid] = payload
            self.cv.notify_all()

    def wait(self, qid: str, abort: threading.Event) -> dict | None:
        with self.cv:
            while qid not in self.answers:
                if abort.is_set():
                    return None
                self.cv.wait(0.2)
            return self.answers.pop(qid)


def _configure(start: dict) -> dict:
    cwd = Path(start.get("cwd") or ".").resolve()
    overrides = {"permission": start.get("permission") if start.get("permission") in PERMISSIONS else "ask",
                 "reasoning_effort": start.get("effort"), "max_steps": start.get("max_steps"), "max_cost_usd": start.get("max_cost_usd")}
    cfg = config.load(cwd, overrides)
    cfg["lessons"] = False                               # the host has its own lessons; do not double up
    cfg["helper_model"] = str(start.get("model"))        # compaction runs on the profile's own model: no other is guaranteed
    cfg["system_append"] = str(start.get("system_append") or "")
    cfg["model_info"] = start.get("model_info") or {}
    if start.get("trust_project"):                       # the host vouches for the folder (it is the user's own project)
        cfg["trust_project"] = True
    if isinstance(start.get("allowed_tools"), list):     # restrict this conversation's tools ([] = none, a pure judge)
        cfg["allowed_tools"] = [str(t) for t in start["allowed_tools"]]
    if start.get("confine"):                             # file tools may not leave the working directory (a sandboxed helper)
        cfg["confine"] = True
    base = str(start.get("base_url") or "").rstrip("/")
    if base:
        name = "openrouter" if "openrouter.ai" in base else "bridge"
        cfg["providers"][name] = {"base_url": base, "api_key_env": "HANGAR_BRIDGE_KEY" if os.environ.get("HANGAR_BRIDGE_KEY") else ""}
        cfg["default_provider"] = name
        if name != "openrouter":
            cfg["perception_model"] = str(start.get("model"))
        if name == "bridge":                               # an unknown gateway: assume a capable model unless told otherwise
            cfg["tiers"].setdefault(str(start.get("model")), str(start.get("tier") or "standard"))
            cfg["model_info"].setdefault(str(start.get("model")), {})
            cfg["model_info"][str(start.get("model"))].setdefault("context", int(start.get("context_window") or 128000))
    return cfg


def main(argv: list[str] | None = None) -> int:
    out = sys.stdout.buffer
    sys.stdout = sys.stderr                              # stray prints must not corrupt the protocol
    lock = threading.Lock()

    def write(obj: dict) -> None:
        data = (json.dumps(obj, ensure_ascii=False, default=str) + "\n").encode("utf-8")
        with lock:
            try:
                out.write(data)
                out.flush()
            except OSError:
                pass

    stdin = sys.stdin.buffer
    first = stdin.readline()
    try:
        start = json.loads(first.decode("utf-8"))
        if start.get("type") != "start":
            raise ValueError("first message must be {type: start}")
        cfg = _configure(start)
        s = Session(cfg, Path(start.get("cwd") or "."), task=str(start.get("title") or "(app session)"), model=str(start["model"]),
                    interactive="bridge", sid=start.get("resume") or None)
    except Exception as e:
        write({"type": "fatal", "message": f"{type(e).__name__}: {e}"})
        return 2
    s.channel = Channel()
    s.bus.subscribe(write)
    base_append = cfg["system_append"]

    def apply_permission(mode: str) -> None:
        cfg["permission"] = mode if mode in PERMISSIONS else "ask"
        cfg["system_append"] = base_append + (PLAN_NOTE if cfg["permission"] == "readonly" else "")

    apply_permission(cfg["permission"])
    try:
        s.mcp.load(start.get("mcp_servers") or None)
        agent = Agent(s, role="main", name="work")
        resumed = bool(start.get("resume")) and agent.load()
    except Exception as e:
        write({"type": "fatal", "message": f"{type(e).__name__}: {e}"})
        s.finish("error")
        return 2
    write({"type": "ready", "session": s.id, "resumed": resumed, "model": agent.model, "tier": agent.tier,
           "context_window": agent.info["context"], "tools": [t.name for t in agent.tools], "log": str(s.dir / "events.jsonl"),
           "commands": [{"name": n, "description": c["description"], "argumentHint": c["hint"]} for n, c in project.commands(s.cwd).items()]})

    queue: list[dict] = []
    state = {"busy": False, "pending_model": None}
    qlock = threading.Lock()

    def turn(msg: dict) -> None:
        t0, before = time.time(), dict(s.totals)
        s.abort.clear()
        s.incomplete = ""
        status, error, kind = "success", "", ""
        try:
            if state["pending_model"]:
                agent._setup(state["pending_model"])
                state["pending_model"] = None
                s.model = agent.model
            if agent.messages:                           # permission mode / instructions may have changed between turns
                from . import prompts
                agent.messages[0]["content"] = prompts.build(s, agent)
            agent.steps = 0
            agent.max_steps = cfg["max_steps"]
            text, command = project.expand_command(s.cwd, str(msg.get("text") or ""))     # "/name args" -> the command's prompt
            if command:
                s.bus.emit("command", name=command)
            content = build_input(s, text, [str(a) for a in msg.get("attachments") or []])
            parts = content if isinstance(content, list) else [{"type": "text", "text": content}]
            images = [i for i in msg.get("images") or [] if isinstance(i, dict) and i.get("data")]
            if images and "image" in (agent.info.get("modalities") or []):
                parts += [{"type": "image_url", "image_url": {"url": f"data:{i.get('mediaType', 'image/png')};base64,{i['data']}"}} for i in images]
            elif images:
                parts[0]["text"] += f"\n\n[{len(images)} pasted image(s) omitted: this model cannot see images]"
            if msg.get("hidden"):
                parts.append({"type": "text", "text": str(msg["hidden"])})
            agent.run(parts if len(parts) > 1 else parts[0]["text"])
            if s.incomplete:
                status, error = "incomplete", s.incomplete
        except Stopped:
            status = "interrupted"
        except LLMError as e:
            status, error, kind = "error", str(e), e.kind
        except Exception as e:                           # a crash in one turn must not kill the conversation
            status, error = "error", f"{type(e).__name__}: {e}"
        delta = {k: s.totals[k] - before.get(k, 0) for k in ("cost", "prompt", "completion", "cached", "cache_write")}
        try:
            agent.save()
            s._save_meta()
        except OSError:
            pass
        write({"type": "turn_end", "status": status, "error": error, "error_kind": kind, **delta,
               "duration_ms": int((time.time() - t0) * 1000), "context_tokens": agent.ctx.estimate(),
               "context_window": agent.info["context"], "model": agent.model, "steps": agent.steps, "session_cost": s.totals["cost"]})
        with qlock:
            nxt = queue.pop(0) if queue else None
            if not nxt:
                state["busy"] = False
        if nxt:
            turn(nxt)

    for raw in iter(stdin.readline, b""):
        try:
            msg = json.loads(raw.decode("utf-8"))
        except ValueError:
            continue
        t = msg.get("type")
        if t == "user":
            with qlock:
                if state["busy"]:
                    queue.append(msg)
                    continue
                state["busy"] = True
            threading.Thread(target=turn, args=(msg,), daemon=True).start()
        elif t in ("answer", "permission_response"):
            s.channel.deliver(str(msg.get("qid")), msg)
        elif t == "interrupt":
            with qlock:
                queue.clear()
            s.interrupt()
        elif t == "set_options":
            if msg.get("permission"):
                apply_permission(str(msg["permission"]))
            if msg.get("effort"):
                cfg["reasoning_effort"] = str(msg["effort"])
            if msg.get("model") and msg["model"] != agent.model:
                with qlock:
                    if state["busy"]:
                        state["pending_model"] = str(msg["model"])
                    else:
                        agent._setup(str(msg["model"]))
                        s.model = agent.model
            write({"type": "options", "model": state["pending_model"] or agent.model, "permission": cfg["permission"]})
        elif t == "close":
            break
    s.interrupt()
    s.bus._subs.clear()
    s.finish("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
