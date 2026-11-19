"""Dynamic workflows: the model describes a fan-out as data, the harness runs it.

One tool call (`run_workflow`) carries an ordered list of steps instead of one model turn per delegation:
  map    one fresh sub-agent per item, several at a time; each sees only its own prompt
  agent  one fresh sub-agent that reads what earlier steps produced (a synthesis, a review)
  shell  a command: the deterministic glue (filter, merge, write a file), which costs no tokens

What keeps it bounded and cheap:
  - the plan is validated before anything runs; a mistake in it costs a retry, not a sub-agent;
  - a cap on sub-agent runs per session (`workflow_max_calls`), counted here, on top of the session's cost cap;
  - sub-agents are leaves (no delegation, no workflow of their own) and read-only unless the step asks otherwise;
  - `fields` makes a sub-agent answer with a JSON object, so later steps and the shell can use the values;
  - every step's output is written to the session folder and reachable as {id.path}; the model gets a short
    account of it, not the pile: the intermediate results never enter its context;
  - a finished sub-agent run is cached in the session by what it was asked: running the plan again after a
    failure only redoes what failed;
  - the plan in flight is written to the session folder (workflow_pending.json) and removed when it ends. If the
    process dies in the middle, the next turn of the resumed session is told so, and `resume` runs it again: the
    cache makes that the unfinished part only;
  - every sub-agent has a name the host can stop by itself (session.stop_agent): that item fails, the rest go on."""
from __future__ import annotations

import glob as globmod
import hashlib
import json
import os
import re
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .toolcall import repair_json

MAX_ITEMS, MAX_STEPS = 200, 8
_LOCK = threading.Lock()


class PlanError(Exception):
    """The plan is wrong; nothing was run."""


def _state(session) -> dict:
    st = getattr(session, "_workflow", None)
    if st is None:
        st = session._workflow = {"calls": 0, "runs": 0, "cache": {}, "active": False}
        try:                                             # a resumed session keeps numbering its runs
            st["runs"] = sum(1 for p in (session.dir / "workflow").iterdir() if p.is_dir())
        except OSError:
            pass
        try:
            st["cache"] = json.loads((session.dir / "workflow_cache.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    return st


def pending(session) -> dict | None:
    """The plan this session was running when its process stopped, or None. Not the one running right now."""
    if _state(session)["active"]:
        return None
    try:
        data = json.loads((session.dir / "workflow_pending.json").read_text(encoding="utf-8"))
        return data if isinstance(data.get("steps"), list) and data["steps"] else None
    except (OSError, ValueError, AttributeError):
        return None


def hint(session) -> str:
    p = pending(session)
    if not p:
        return ""
    ids = ", ".join(str(s.get("id")) for s in p["steps"])
    return (f"\nA run_workflow plan of this session (steps: {ids}) was cut off before it finished, because the process stopped. "
            "If the task still needs it, call run_workflow with {\"resume\": true}: the items already done are kept and are not redone.")


def _items(session, step: dict, outputs: dict) -> list:
    over = step.get("over")
    if isinstance(over, str) and over.startswith("$"):
        prev = outputs.get(over[1:])
        if prev is None:
            raise PlanError(f"step '{step['id']}': over refers to '{over[1:]}', which is not an earlier step")
        if isinstance(prev, str):                        # a shell step: a JSON list if it printed one, else one item per line
            try:
                data = json.loads(prev)
            except ValueError:
                data = None
            prev = data if isinstance(data, list) else [l.strip() for l in prev.splitlines() if l.strip()]
        over = prev
    elif isinstance(over, str) and over.startswith("glob:"):
        root = Path(session.cwd)
        over = sorted(Path(p).relative_to(root).as_posix() for p in globmod.glob(str(root / over[5:].strip()), recursive=True) if Path(p).is_file())
    if isinstance(over, dict):
        over = [{"item": k, "result": v} for k, v in over.items()]
    if not isinstance(over, list) or not over:
        raise PlanError(f"step '{step['id']}': `over` must be a non-empty list, \"glob:<pattern>\" matching files, or \"$<earlier step id>\"")
    if len(over) > MAX_ITEMS:
        raise PlanError(f"step '{step['id']}': {len(over)} items, the limit is {MAX_ITEMS}")
    return over


def validate(steps) -> list[dict]:
    if not isinstance(steps, list) or not steps:
        raise PlanError("`steps` must be a non-empty list")
    if len(steps) > MAX_STEPS:
        raise PlanError(f"{len(steps)} steps, the limit is {MAX_STEPS}")
    seen, out = set(), []
    for n, st in enumerate(steps, 1):
        if not isinstance(st, dict):
            raise PlanError(f"step {n} is not an object")
        st = dict(st)
        st["id"] = sid = str(st.get("id") or f"s{n}")
        kind = st.get("type")
        if not sid.replace("_", "").isalnum() or sid in seen:
            raise PlanError(f"step {n}: id '{sid}' must be unique and made of letters, digits and _")
        if kind not in ("map", "agent", "shell"):
            raise PlanError(f"step '{sid}': type must be map, agent or shell")
        if kind == "shell":
            if not str(st.get("command") or "").strip():
                raise PlanError(f"step '{sid}': a shell step needs `command`")
        else:
            if not str(st.get("prompt") or "").strip():
                raise PlanError(f"step '{sid}': needs `prompt`")
            if kind == "map" and "{item}" not in st["prompt"]:
                raise PlanError(f"step '{sid}': a map prompt must contain {{item}}, where each item goes")
            if kind == "map" and "over" not in st:
                raise PlanError(f"step '{sid}': a map step needs `over`")
            f = st.get("fields")
            if f is not None and (not isinstance(f, dict) or not f or not all(isinstance(k, str) and k for k in f)):
                raise PlanError(f"step '{sid}': `fields` must be an object of name -> what the value is")
            if st.get("tools", "readonly") not in ("readonly", "all"):
                raise PlanError(f"step '{sid}': tools must be readonly or all")
            if st.get("level", "standard") not in ("light", "standard", "deep"):
                raise PlanError(f"step '{sid}': level must be light, standard or deep")
        for ref in _refs(str(st.get("prompt") or st.get("command") or "")):
            if ref not in seen:
                raise PlanError(f"step '{sid}': {{{ref}}} refers to a step that does not come before it")
        seen.add(sid)
        out.append(st)
    return out


def _refs(text: str) -> set[str]:
    return {m.group(1) for m in re.finditer(r"\{([A-Za-z0-9_]+)(?:\.path)?\}", text)} - {"item"}


def _fill(text: str, outputs: dict, paths: dict, item=None) -> str:
    for sid, val in outputs.items():
        text = text.replace("{" + sid + ".path}", str(paths[sid]))
        if "{" + sid + "}" in text:
            text = text.replace("{" + sid + "}", (val if isinstance(val, str) else json.dumps(val, ensure_ascii=False))[:20000])
    if item is not None:
        text = text.replace("{item}", item if isinstance(item, str) else json.dumps(item, ensure_ascii=False))
    return text


def _parse(text: str, fields: dict):
    end = text.rfind("}")
    pos = text.find("{")
    tries = 0
    while 0 <= pos < end and tries < 8:
        data, ok = repair_json(text[pos:end + 1])
        if ok and isinstance(data, dict) and all(k in data for k in fields):
            return {k: data[k] for k in fields}
        pos, tries = text.find("{", pos + 1), tries + 1
    return None


def _sub(session, parent, step: dict, prompt: str, item=None):
    """One sub-agent run. Returns its result (a dict when the step has fields, text otherwise); raises on failure."""
    from .agent import Agent
    from .session import Cancelled, Stopped
    st, fields, level = _state(session), step.get("fields"), step.get("level", "standard")
    model = session.team[level] if session.team and level in ("light", "deep") else parent.model
    toolset = step.get("tools", "readonly")
    if fields:
        prompt += ("\n\nFinish with ONLY a JSON object on the last line, with exactly these keys:\n"
                   + "\n".join(f"- {k}: {v}" for k, v in fields.items()))
    else:
        prompt += "\n\nReturn a concise report (under 300 words) with the exact paths and values the caller needs."
    key = hashlib.sha1(json.dumps([model, toolset, prompt], ensure_ascii=False).encode("utf-8")).hexdigest()
    with _LOCK:
        if key in st["cache"]:
            return st["cache"][key]
        if st["calls"] >= int(session.cfg.get("workflow_max_calls", 40)):
            raise RuntimeError("sub-agent budget of this session is spent")
        st["calls"] += 1
        session.sub_count += 1
        name = f"wf{session.sub_count}"
    label = "" if item is None else (item if isinstance(item, str) else json.dumps(item, ensure_ascii=False))[:80]
    session.bus.emit("subagent", agent=name, model=model, level=level if session.team else "standard", by=parent.name, step=step["id"],
                     item=label)
    status = "failed"
    try:
        ag = Agent(session, model=model, role="sub", toolset=toolset, name=name, max_steps=int(step.get("max_steps") or 12))
        ag.level = level if session.team and level in ("light", "deep") else ""
        out = ag.run(prompt)
        result = out[:6000]
        if fields:
            result = _parse(out, fields)
            if result is None:                           # one chance to answer in the agreed shape
                result = _parse(ag.run("Reply with ONLY the JSON object, with exactly these keys: " + ", ".join(fields)), fields)
            if result is None:
                raise RuntimeError("did not answer with the JSON object asked for")
        status = "done"
    except (Cancelled, Stopped):
        status = "stopped"
        raise
    finally:
        session.bus.emit("subagent_end", agent=name, status=status, by=parent.name, step=step["id"])
    with _LOCK:
        st["cache"][key] = result
        try:
            (session.dir / "workflow_cache.json").write_text(json.dumps(st["cache"], ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
    return result


def run(session, parent, steps, save: str = "", resume: bool = False) -> str:
    """Validate and run a plan. Returns the short account the model reads. Raises PlanError before spending anything."""
    from .session import Stopped
    if resume:
        was = pending(session)
        if not was:
            raise PlanError("there is no interrupted plan to resume: send `steps`")
        steps, save = was["steps"], str(was.get("save") or "")
    steps = validate(steps)
    st = _state(session)
    cap = int(session.cfg.get("workflow_max_calls", 40))
    planned = sum(1 if s["type"] == "agent" else len(s["over"]) if s["type"] == "map" and isinstance(s.get("over"), list) else 0 for s in steps)
    if planned > cap:
        raise PlanError(f"this plan needs at least {planned} sub-agent runs and a session may use {cap}. Narrow it, or do the rest yourself.")
    target = None
    if save:
        target = (Path(session.cwd) / save).resolve()
        if Path(session.cwd).resolve() not in target.parents:
            raise PlanError("`save` must be a path inside the working folder")
        if session.cfg.get("permission") == "readonly":
            raise PlanError("this session is read-only: drop `save`")
    st["runs"] += 1
    folder = session.dir / "workflow" / f"run{st['runs']}"
    folder.mkdir(parents=True, exist_ok=True)
    mark = session.dir / "workflow_pending.json"
    try:
        mark.write_text(json.dumps({"steps": steps, "save": save}, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    st["active"] = True
    try:
        text = _execute(session, parent, steps, save, target, folder, st, cap)
    except Stopped:                                      # the user stopped the turn: nothing to pick up later
        mark.unlink(missing_ok=True)
        raise
    finally:
        st["active"] = False
    mark.unlink(missing_ok=True)                         # only a process that died leaves the mark behind
    return text


def _execute(session, parent, steps, save, target, folder, st, cap) -> str:
    from .session import Stopped
    outputs, paths, account = {}, {}, []
    workers = max(1, min(int(session.cfg.get("workflow_parallel", 6)), 16))
    for step in steps:
        session.check_stop()
        sid, kind = step["id"], step["type"]
        session.bus.emit("workflow_step", step=sid, kind=kind, by=parent.name)
        failed = 0
        if kind == "shell":
            # No stdin: under the bridge the harness's own stdin is the host's pipe, and a command that inherits it hangs.
            p = subprocess.Popen([*session.shell_argv, _fill(step["command"], outputs, paths)], cwd=str(session.cwd),
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
            session.current_proc = p                     # an interrupt kills it, like any command the agent runs
            try:
                raw, _ = p.communicate(timeout=int(step.get("timeout", 300)))
            except subprocess.TimeoutExpired:
                p.kill()
                raw = (p.communicate()[0] or b"") + b"\n[timed out]"
            finally:
                session.current_proc = None
            session.check_stop()
            out = raw.decode("utf-8", "replace")[-12000:]
            line = f"{sid} (shell): exit {p.returncode}\n{out[-1500:]}"
            if p.returncode != 0:
                outputs[sid], paths[sid] = out, folder / f"{sid}.json"
                paths[sid].write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
                account.append(line + "\nThe plan stopped here: fix the command and run the plan again (finished sub-agent runs are cached).")
                break
        elif kind == "agent":
            try:
                out = _sub(session, parent, step, _fill(step["prompt"], outputs, paths))
            except Stopped:
                raise
            except Exception as e:
                out, failed = {"error": f"{type(e).__name__}: {e}"[:300]}, 1
            line = f"{sid} (agent): " + (json.dumps(out, ensure_ascii=False) if not isinstance(out, str) else out)[:3000]
        else:
            items = _items(session, step, outputs)

            def one(item, step=step):
                session.check_stop()
                try:
                    return {"item": item, "result": _sub(session, parent, step, _fill(step["prompt"], outputs, paths, item), item)}
                except Stopped:
                    raise
                except Exception as e:
                    return {"item": item, "error": f"{type(e).__name__}: {e}"[:300]}
            with ThreadPoolExecutor(max_workers=workers) as ex:
                out = list(ex.map(one, items))
            failed = sum("error" in r for r in out)
            sample = json.dumps([r for r in out if "error" not in r][:2], ensure_ascii=False)[:700]
            errors = "; ".join(f"{json.dumps(r['item'], ensure_ascii=False)[:80]}: {r['error']}" for r in out if "error" in r)[:1200]
            line = (f"{sid} (map): {len(out) - failed} of {len(out)} items done" + (f", {failed} FAILED ({errors})" if failed else "")
                    + f". First results: {sample}")
        outputs[sid], paths[sid] = out, folder / f"{sid}.json"
        paths[sid].write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        account.append(line + f"\n  full output: {paths[sid]}")
    if target is not None and outputs:
        last = outputs[list(outputs)[-1]]
        if isinstance(last, list) and all(isinstance(r, dict) and isinstance(r.get("item"), str) for r in last):
            last = {r["item"]: r.get("result", {"error": r.get("error")}) for r in last}      # keyed by item: what a reader expects
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(last if isinstance(last, str) else json.dumps(last, ensure_ascii=False, indent=1), encoding="utf-8")
        session.files.add(str(target))
        account.append(f"saved the last step's output to {save}")
    account.append(f"sub-agent runs used in this session: {st['calls']} of {cap}")
    return "\n".join(account)
