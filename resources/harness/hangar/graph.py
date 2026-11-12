"""Graph engine: workflows as data. Nodes are bounded units of work, edges hold the routing
and stopping logic, state is a small typed dict checkpointed after every node.

Node types
  agent   an LLM tool loop (keeps its conversation across revisits unless "fresh": true)
  verify  a fresh-context "goldfish" reviewer returning a structured verdict -> routes approve / revise
  shell   a deterministic gate (run a command) -> routes ok / fail      (known rules stay code, not LLM)
  human   ask the user -> answer stored in state

A node's "next" is a node id, "$end", or a {route: target} map. Every node has a visit cap,
so no loop in a graph is unbounded."""
from __future__ import annotations

import json
import subprocess

from .agent import Agent
from .config import HOME
from .toolcall import repair_json

END = "$end"

PLAN_PROMPT = """Task:
{task}

Investigate what you need with read-only tools, then write a plan for the engineer who will implement it.
Output: numbered steps (files to create/change and how), then "ACCEPTANCE:" with concrete checks/commands that prove the task is done.
Be specific and brief (under 250 words). Do not implement."""

EXEC_PROMPT = """Task:
{task}

Plan from the planner (follow it unless you find it is wrong):
{plan}"""

RETRY_PROMPT = """An independent reviewer rejected the work:
{feedback}

Fix these issues, verify, then give your final answer."""

VERIFY_PROMPT = """Task that was given to another agent:
{task}

Files it reports changing: {files}
Its final answer: {result}

Independently check whether the task is truly and completely done: inspect the files and run the code/tests.
Finish with ONLY this JSON on the last line:
{{"verdict": "approve" or "revise", "feedback": "what exactly is wrong (empty if approve)"}}"""

BUILTIN = {
    "loop": {"name": "loop", "start": "work", "nodes": [
        {"id": "work", "type": "agent", "model": "$worker", "tools": "all", "role": "main", "prompt": "{task}", "output": "result", "next": END}]},
    # worker + independent reviewer: for when being wrong is expensive
    "verify": {"name": "verify", "start": "work", "nodes": [
        {"id": "work", "type": "agent", "model": "$worker", "tools": "all", "role": "main", "prompt": "{task}",
         "retry_prompt": RETRY_PROMPT, "output": "result", "next": "review"},
        {"id": "review", "type": "verify", "model": "$verifier", "prompt": VERIFY_PROMPT,
         "next": {"approve": END, "revise": "work"}, "max_visits": 3}]},
    # strong model plans, cheap model executes, fresh reviewer checks ("architect / editor" split)
    "pev": {"name": "pev", "start": "plan", "nodes": [
        {"id": "plan", "type": "agent", "model": "$planner", "tools": "readonly", "role": "planner", "prompt": PLAN_PROMPT,
         "output": "plan", "max_steps": 10, "next": "execute"},
        {"id": "execute", "type": "agent", "model": "$worker", "tools": "all", "role": "main", "prompt": EXEC_PROMPT,
         "retry_prompt": RETRY_PROMPT, "output": "result", "next": "review"},
        {"id": "review", "type": "verify", "model": "$verifier", "prompt": VERIFY_PROMPT,
         "next": {"approve": END, "revise": "execute"}, "max_visits": 3}]},
}


class _Blank(dict):
    def __missing__(self, key):
        return ""


def load_workflow(name: str, cwd) -> dict:
    if name in BUILTIN:
        return BUILTIN[name]
    for root in (cwd / ".hangar" / "workflows", HOME / "workflows"):
        f = root / f"{name}.json"
        if f.is_file():
            return json.loads(f.read_text(encoding="utf-8"))
    raise ValueError(f"unknown workflow '{name}'. Built-in: {', '.join(BUILTIN)}; custom ones live in .hangar/workflows/<name>.json")


def _model(session, ref: str) -> str:
    cfg = session.cfg
    return {"$worker": session.model,
            "$planner": cfg["planner_model"] or session.model,
            "$verifier": cfg["verifier_model"] or cfg["planner_model"] or session.model}.get(ref or "$worker", ref)


def _checkpoint(session, wf: dict, **data) -> None:
    tmp = session.dir / "checkpoint.tmp"
    tmp.write_text(json.dumps({"workflow": wf["name"], **data}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(session.dir / "checkpoint.json")


def run_graph(session, wf: dict, task, resume: bool = False, extra: str = "") -> str:
    """Run (or resume) a workflow. State is checkpointed when a node starts and when it ends, and every
    agent saves its transcript each turn, so a crash or Ctrl+C loses at most the turn in flight."""
    nodes = {n["id"]: n for n in wf["nodes"]}
    task_text = task if isinstance(task, str) else next((p["text"] for p in task if p.get("type") == "text"), "")
    state = {"task": task_text, "plan": "", "result": "", "feedback": "", "files": ""}
    agents: dict[str, Agent] = {}
    visits: dict[str, int] = {}
    start, resumed_node = wf["start"], None
    if resume:
        try:
            ck = json.loads((session.dir / "checkpoint.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            ck = None
        if ck:
            state, visits = ck["state"], ck["visits"]
            if ck.get("done"):
                start = ck["next"]
            else:
                start = resumed_node = ck["current"]
                visits[start] = max(0, visits.get(start, 1) - 1)
            if start == END:                             # the graph had ended: keep talking to the worker
                extra = extra or "Continue the task: finish whatever is still incomplete, verify the result, then give the final answer."
                last = next((n for n in reversed(wf["nodes"]) if n["type"] == "agent" and n.get("output", "result") == "result"), None)
                if last:
                    ag = Agent(session, model=_model(session, last.get("model", "")), role=last.get("role", "main"),
                               toolset=last.get("tools", "all"), name=last["id"], max_steps=last.get("max_steps"))
                    if ag.load():
                        state["result"] = ag.run(extra)
                        return state["result"]
    edges = []
    for n in wf["nodes"]:
        nx = n.get("next", END)
        edges += [{"from": n["id"], "to": t, "label": lbl} for lbl, t in (nx.items() if isinstance(nx, dict) else [("", nx)])]
    session.bus.emit("graph", name=wf["name"], nodes=[{"id": n["id"], "type": n["type"], "model": _model(session, n.get("model", ""))
                                                       if n["type"] in ("agent", "verify") else ""} for n in wf["nodes"]], edges=edges)
    cur, first_agent = start, not resume
    while cur != END:
        session.check_stop()
        node = nodes[cur]
        visits[cur] = visits.get(cur, 0) + 1
        if visits[cur] > int(node.get("max_visits", 3)):
            session.bus.emit("notice", level="warn", text=f"node '{cur}' hit its visit cap; ending the graph")
            break
        session.bus.emit("node_start", node=cur, visit=visits[cur])
        _checkpoint(session, wf, current=cur, done=False, visits=visits, state=state)
        route, kind = "", node["type"]
        fmt = _Blank(state)
        if kind == "agent":
            ag = agents.get(cur)
            if ag is None or node.get("fresh"):
                ag = agents[cur] = Agent(session, model=_model(session, node.get("model", "")), role=node.get("role", "main"),
                                         toolset=node.get("tools", "all"), name=cur, max_steps=node.get("max_steps"))
                if resume and not node.get("fresh"):
                    ag.load()                                  # pick the conversation back up from disk
            if resumed_node == cur and ag.messages:
                resumed_node = None
                out = ag.resume(extra)
            else:
                prompt = (node.get("retry_prompt", node["prompt"]) if ag.messages else node["prompt"]).format_map(fmt)
                if first_agent and not isinstance(task, str):  # attachments ride along with the first agent node
                    prompt = [{"type": "text", "text": prompt}, *[p for p in task if p.get("type") != "text"]]
                out = ag.run(prompt)
            first_agent = False
            state[node.get("output", "result")] = out
            state["files"] = ", ".join(sorted(session.files)) or "(none reported)"
        elif kind == "verify":
            rev = Agent(session, model=_model(session, node.get("model", "$verifier")), role="verifier", toolset="verify",
                        name=f"{cur}{visits[cur]}", max_steps=node.get("max_steps", 15))
            out = rev.run(node["prompt"].format_map(fmt))
            verdict, ok = repair_json(out[out.rfind("{"):] if "{" in out else "")
            route = str(verdict.get("verdict", "")).lower() if ok and isinstance(verdict, dict) else ""
            if route not in ("approve", "revise"):
                route = "revise" if "revise" in out.lower()[-300:] else "approve"
            state["feedback"] = str(verdict.get("feedback", "") if isinstance(verdict, dict) else "") or out[-1500:]
            session.bus.emit("verdict", node=cur, verdict=route, feedback=state["feedback"][:1500])
            target = node.get("next", {}).get("revise") if isinstance(node.get("next"), dict) else None
            if route == "revise" and visits[cur] >= 2 and target in agents:
                agents[target].escalate("an independent reviewer rejected its work twice.")
        elif kind == "shell":
            p = subprocess.run([*session.shell_argv, node["command"].format_map(fmt)], cwd=str(session.cwd), capture_output=True,
                               timeout=int(node.get("timeout", 300)))
            out = (p.stdout + p.stderr).decode("utf-8", "replace")
            state[node.get("output", "feedback")] = out[-3000:]
            route = "ok" if p.returncode == 0 else "fail"
        elif kind == "human":
            state[node.get("output", "answer")] = session.ask(node["prompt"].format_map(fmt), node.get("options")) or ""
        else:
            raise ValueError(f"unknown node type '{kind}'")
        nx = node.get("next", END)
        nxt = nx.get(route, nx.get("default", END)) if isinstance(nx, dict) else nx
        session.bus.emit("node_end", node=cur, route=route, next=nxt)
        _checkpoint(session, wf, current=cur, done=True, next=nxt, visits=visits, state=state)
        cur = nxt
    return state.get("result", "")
