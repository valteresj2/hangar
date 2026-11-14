"""The agent loop. One loop serves every model: strong models get native tool calling and
parallel calls; weak ones get a text protocol, argument repair, aliases, nudges and guards."""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

from . import prompts, tools as T
from .context import Context
from .llm import LLMError
from .session import Stopped
from .toolcall import coerce_args, parse_text_calls, repair_json, signature


_GIVE_UP = re.compile(r"(ferramenta|tool|shell|escrita|write)[^.\n]{0,60}(n[ãa]o est[áa]\w* dispon|indispon|not available|unavailable|isn't available)"
                      r"|n[ãa]o (consegui|foi poss[íi]vel|posso) (criar|executar|gravar|escrever|rodar)"
                      r"|(unable|not able) to (create|run|write|execute)|i (cannot|can't) (create|run|write|execute)", re.I)


SPLIT_HINT = ("Split the work: write the first part of the file (up to ~150 lines) with write, then add each following part "
              "with write(append=true), or use several small edits.")
CUT_MSG = "NOT executed: your output hit the length limit in the middle of this call, so its arguments are incomplete. " + SPLIT_HINT

_TRAILING_MARK =re.compile(r"(\s*<\|?[A-Za-z_]{2,24}\|?>)+\s*$")


class Agent:
    def __init__(self, session, model: str | None = None, role: str = "main", toolset: str = "all",
                 name: str | None = None, max_steps: int | None = None, extra_system: str = ""):
        self.s = session
        self.extra_system = extra_system           # a project sub-agent definition (.claude/agents/<name>.md)
        self.model = model or session.model
        self.role, self.toolset = role, toolset
        self.name = name or role
        self.max_steps = max_steps or session.cfg["max_steps"]
        self.messages: list = []
        self.steps = 0
        self.escalated = False
        self.level = ""                            # a routed sub-agent: "light" or "deep"
        self.goal = ""
        self.max_out = session.cfg["max_output_tokens"]
        self.seen: dict[str, int] = {}
        self._setup(self.model)

    def _setup(self, model: str) -> None:
        """(Re)bind the agent to a model: capabilities decide protocol, tool catalog and context budget."""
        s = self.s
        self.model = model
        self.info = s.catalog.info(model)
        self.tier = self.info["tier"]
        self.mode = s.tool_mode.get(model) or ("native" if self.info["tools"] else "text")
        self.tools = T.select(s, self.toolset, self.tier, self.role)
        self.toolmap = {t.name: t for t in self.tools}
        self.schemas = [t.schema() for t in self.tools]
        self.tool_overhead = len(json.dumps(self.schemas)) // 3
        self.ctx = Context(self)

    # ------------------------------------------------------- durability
    @property
    def _file(self):
        return self.s.dir / f"agent_{self.name}.json"

    def save(self) -> None:
        """Called at turn boundaries, so the saved transcript is always consistent and resumable."""
        tmp = self._file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"model": self.model, "escalated": self.escalated, "messages": self.messages},
                                  ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(self._file)

    def load(self) -> bool:
        try:
            d = json.loads(self._file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        if not d.get("messages"):
            return False
        if d.get("model") and d["model"] != self.model:
            self._setup(d["model"])
        self.escalated, self.messages = bool(d.get("escalated")), d["messages"]
        return True

    def resume(self, extra: str = "") -> str:
        self.messages.append({"role": "user", "content": "[harness] This session was interrupted and has just been resumed. Check the current "
                              "state of the work (files, last results) and continue the task until it is complete." + (f"\n{extra}" if extra else "")})
        first = self.messages[1]["content"] if len(self.messages) > 1 else ""
        self.goal = (first if isinstance(first, str) else next((p["text"] for p in first if p.get("type") == "text"), ""))[:400]
        return self._loop()

    @property
    def cost_role(self) -> str:
        """Which line of the bill this agent's calls go to."""
        if self.role == "sub":
            return self.level or "sub"
        if self.role in ("verifier", "planner"):
            return self.role
        return "escalation" if self.escalated else "worker"

    def escalate(self, reason: str) -> bool:
        """Hand the same conversation to a stronger model when this one is stuck (pay for strength only when needed)."""
        s, up = self.s, self.s.cfg.get("escalation_model")
        if not up or self.escalated or up == self.model or self.role == "sub" or s.over_budget():
            return False
        old = self.model
        self.escalated = True
        self._setup(up)
        for m in self.messages:
            m.pop("reasoning_details", None)             # another provider's reasoning blocks are not portable
        self.messages[0]["content"] = prompts.build(s, self)
        self.messages.append({"role": "user", "content": f"[harness] The previous model ({old}) could not finish: {reason} You are a stronger model "
                              "taking over this same session. Review the real state of the work (files, last results), fix what is wrong and complete the task."})
        self.max_steps = self.steps + max(20, s.cfg["max_steps"] // 2)
        s.bus.emit("notice", level="warn", text=f"escalated {old} -> {up}: {reason}", agent=self.name)
        return True

    # ------------------------------------------------------------------- model
    def _chat(self, with_tools: bool = True):
        s = self.s
        on_delta = lambda text, kind: s.bus.delta(text, kind, self.name)
        for _ in range(3):
            try:
                r = s.llm.chat(self.model, self.messages,
                               tools=self.schemas if (with_tools and self.mode == "native" and self.schemas) else None,
                               on_delta=on_delta, agent=self.name, max_tokens=self.max_out)
                s.add_usage(r, getattr(r, "model", "") or self.model, self.name, self.cost_role)
                self.ctx.observe(r.usage["prompt"])
                return r
            except LLMError as e:
                if e.kind == "aborted":
                    raise Stopped("stopped by user") from None
                if e.kind == "no_tools" and self.mode == "native":
                    self.mode = s.tool_mode[self.model] = "text"      # remembered for the whole session
                    self.messages[0]["content"] = prompts.build(s, self)
                    s.bus.emit("notice", level="info", text=f"{self.model}: no native tool calling; switched to text protocol")
                    continue
                if e.kind == "context_overflow":
                    self.ctx.maybe_compact(force=True)
                    continue
                raise
        raise LLMError("bad_request", "could not complete the model call")

    # ------------------------------------------------------------------- tools
    def _exec(self, call: dict) -> tuple[bool, str]:
        s = self.s
        name = call["name"] if call["name"] in self.toolmap else T.ALIASES.get(call["name"].lower(), call["name"])
        tool = self.toolmap.get(name)
        t0 = time.time()
        s.bus.emit("tool_start", id=call["id"], name=name, agent=self.name,
                   args={k: (v if len(str(v)) < 1500 else str(v)[:1500] + "…") for k, v in (call["args"] or {}).items()}
                   if isinstance(call["args"], dict) else {})
        if call.get("cut"):
            ok, out = False, "Error: " + CUT_MSG
        elif tool is None:
            ok, out = False, f"Error: unknown tool '{call['name']}'. Available tools: {', '.join(self.toolmap)}."
        elif not call.get("json_ok", True):
            ok, out = False, f"Error: arguments were not valid JSON. Usage: {signature(name, tool.parameters)} as one JSON object."
        else:
            args, err = coerce_args(name, tool.parameters, call["args"])
            if err:
                ok, out = False, "Error: " + err
            else:
                try:
                    denied = s.hooks.pre_tool(self, name, args)
                    if denied:
                        raise T.ToolError(denied)
                    if name.startswith("mcp") and s.cfg["permission"] in ("ask", "edits") and not s.approve(
                            f"Call {name}?", tool=name, args=args):
                        raise T.ToolError("not approved by the user" + (f": {s.deny_message}" if s.deny_message else "."))
                    raw = str(tool.fn(T.Ctx(s, self), args))
                    ok, out = True, s.cap(raw + s.hooks.post_tool(self, name, args, True, raw), name, tool.cap)
                except T.ToolError as e:
                    ok, out = False, f"Error: {e}"
                except Exception as e:  # tool bugs must never kill the loop
                    ok, out = False, f"Error: {type(e).__name__}: {e}"
        s.totals["tool_calls"] += 1
        s.tool_counts[name] = s.tool_counts.get(name, 0) + 1
        s.totals["tool_errors"] += 0 if ok else 1
        s.bus.emit("tool_end", id=call["id"], name=name, agent=self.name, ok=ok, ms=int((time.time() - t0) * 1000),
                   chars=len(out), preview=out[:1500], **({"output": out[:30000]} if s.interactive == "bridge" else {}))
        return ok, out

    def _run_calls(self, calls: list) -> list[str]:
        def is_ro(c):
            t = self.toolmap.get(c["name"]) or self.toolmap.get(T.ALIASES.get(c["name"].lower(), ""))
            return bool(t and t.readonly)
        if len(calls) > 1 and all(is_ro(c) for c in calls):        # independent reads: use the cores
            with ThreadPoolExecutor(max_workers=self.s.cfg["parallel_tools"]) as ex:
                return [out for _, out in ex.map(self._exec, calls)]
        return [self._exec(c)[1] for c in calls]

    # -------------------------------------------------------------------- loop
    def run(self, user) -> str:
        s = self.s
        if not self.messages:
            self.messages.append({"role": "system", "content": prompts.build(s, self)})
        self._repair()
        self.messages.append({"role": "user", "content": user})
        self.goal = (user if isinstance(user, str) else next((p["text"] for p in user if p.get("type") == "text"), ""))[:400]
        return self._loop()

    def _repair(self) -> None:
        """A turn cut short may leave tool calls without results; providers reject that history, so close them."""
        for i in range(len(self.messages) - 1, -1, -1):
            m = self.messages[i]
            if m.get("role") == "assistant" and m.get("tool_calls"):
                done = {x.get("tool_call_id") for x in self.messages[i + 1:] if x.get("role") == "tool"}
                missing = [tc["id"] for tc in m["tool_calls"] if tc["id"] not in done]
                at = i + 1 + sum(1 for x in self.messages[i + 1:] if x.get("role") == "tool")
                for k, tid in enumerate(missing):
                    self.messages.insert(at + k, {"role": "tool", "tool_call_id": tid, "content": "[interrupted by the user before this tool finished]"})
                return
            if m.get("role") in ("assistant", "user"):
                if m.get("role") == "assistant":
                    return

    def _loop(self) -> str:
        s = self.s
        empty = bad = gates = asked = stale = 0
        verify_nudged = fail_nudged = False
        last_sig, repeats = "", 0
        while True:
            self.save()
            s.check_stop()
            if self.steps >= self.max_steps:
                if self.escalate(f"it used all {self.max_steps} steps."):
                    continue
                return self._wrap_up(f"Step limit ({self.max_steps}) reached.")
            if s.over_budget():
                return self._wrap_up(f"Cost budget (${s.cfg['max_cost_usd']}) reached.")
            self.steps += 1
            self.ctx.maybe_compact()
            r = self._chat()
            text, native_calls, as_text = r.content or "", r.tool_calls, self.mode == "text"
            text = _TRAILING_MARK.sub("", text)        # stray control markers some models append (<CPA_DONE>, <|eot|>)
            if getattr(r, "reasoning", "").strip():
                s.bus.emit("thinking", text=r.reasoning.strip(), agent=self.name)
            calls, shown = [], text
            if native_calls and not as_text:
                for i, tc in enumerate(native_calls):
                    args, ok = repair_json(tc["arguments"])
                    calls.append({"id": tc["id"] or f"call_{self.steps}_{i}", "name": tc["name"], "args": args, "json_ok": ok,
                                  "cut": r.finish == "length" and i == len(native_calls) - 1})
                if r.finish == "length":
                    self.max_out = min(32000, self.max_out * 2)
            elif as_text or "<tool_call" in text or "<function=" in text:
                clean, parsed = parse_text_calls(text)
                if parsed:
                    as_text = True
                    calls = [{"id": f"call_{self.steps}_{i}", **c} for i, c in enumerate(parsed)]
                    if self.tier == "weak":
                        calls = calls[:1]                       # weak models hallucinate follow-up calls
                    shown = clean
                else:
                    shown = text
            if text.strip():
                s.bus.emit("assistant", text=(shown if as_text and calls else text), agent=self.name)

            cut = r.finish == "length" and as_text and calls
            if cut or (not calls and ("<tool_call" in text or "<function=" in text)):
                bad += 1                          # never run a truncated call; never mistake a broken one for the answer
                if bad <= 3:
                    self.messages.append({"role": "assistant", "content": text})
                    self.messages.append({"role": "user", "content": (
                        "Your tool call was cut off by the output limit, so it was NOT executed. Write smaller files or edits."
                        if cut else "Your tool call could not be parsed, so it was NOT executed.") +
                        ' Use exactly this format with valid JSON:\n<tool_call>\n{"name": "TOOL_NAME", "arguments": {"arg": "value"}}\n</tool_call>'})
                    continue
                if self.escalate("it kept producing tool calls that could not be parsed."):
                    bad = 0
                    continue
                calls = []
            if not calls:
                if not text.strip():
                    empty += 1
                    if empty > 2:
                        if self.escalate("it returned empty or cut-off replies three times."):
                            empty = 0
                            continue
                        s.incomplete = "the model returned no usable answer"
                        return "(the model returned no answer)"
                    if r.finish == "length":             # the whole budget went into an unfinished call / reasoning
                        self.max_out = min(32000, self.max_out * 2)
                        self.messages.append({"role": "user", "content": "Your output hit the length limit before you finished a tool call, "
                                              "so nothing was executed. " + SPLIT_HINT})
                    else:
                        self.messages.append({"role": "user", "content": "Your reply was empty. Continue the task: call a tool, or give the final answer."})
                    continue
                self.messages.append({"role": "assistant", "content": text})
                if r.finish == "length":
                    self.messages.append({"role": "user", "content": "Your output was cut off by the length limit. Continue, using tools and smaller pieces."})
                    continue
                # --- a final "answer" that is really a question goes to the user, like an ask_user call
                # (not in bridge mode: there the host is a chat, and the user simply answers in the next message)
                if (self.role == "main" and "ask_user" in self.toolmap and asked < 2 and text.rstrip().endswith("?")
                        and s.interactive != "bridge"):
                    asked += 1
                    ans = s.ask(text.strip()[-800:])
                    if ans:
                        self.messages.append({"role": "user", "content": f"{ans}\n\nNow complete the task with your tools."})
                        continue
                # --- completion gates: cheap deterministic checks before accepting "I'm done"
                if self.role == "main" and _GIVE_UP.search(text) and gates >= 2 and self.escalate("it gave up claiming it could not act."):
                    gates = 0
                    continue
                if self.role == "main" and gates < 2 and _GIVE_UP.search(text):
                    gates += 1
                    self.messages.append({"role": "user", "content": "That is not correct: every tool listed to you IS available and working in "
                                          f"this session ({', '.join(self.toolmap)}). Do the remaining work now by calling them."})
                    continue
                if self.role == "main" and fail_nudged and s.last_exit not in (0, None) and self.escalate(
                        f"it stopped while its last command was still failing (exit {s.last_exit})."):
                    continue
                if self.role == "main" and not fail_nudged and s.last_exit not in (0, None) and "shell" in self.toolmap:
                    fail_nudged = True
                    self.messages.append({"role": "user", "content": f"Your last command ended with exit code {s.last_exit}, so the work is not "
                                          "verified. Fix the cause and run it again until it passes, or explain precisely why that failure is acceptable."})
                    continue
                if (s.cfg["verify_nudge"] and not verify_nudged and self.role == "main" and self.tier != "strong"
                        and s.edits_since_run and "shell" in self.toolmap):
                    verify_nudged = True
                    self.messages.append({"role": "user", "content": "Before finishing: you changed files but did not run anything afterwards. "
                                          "Run a quick check now (tests / the script). If it already passes, repeat your final answer."})
                    continue
                push = s.hooks.pre_finish(self, text) if self.role == "main" else ""
                if push:                                 # project policy decides when "done" is allowed
                    self.messages.append({"role": "user", "content": push})
                    continue
                self.save()
                return text

            # --- record the assistant turn, execute, feed results back
            if as_text:
                self.messages.append({"role": "assistant", "content": text})
            else:
                m = {"role": "assistant", "content": text or None, "tool_calls": [
                    {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"], ensure_ascii=False)}}
                    for c in calls]}
                if r.reasoning_details:
                    m["reasoning_details"] = r.reasoning_details
                self.messages.append(m)
            outs = self._run_calls(calls)
            sigs = [json.dumps((c["name"], c["args"]), sort_keys=True, default=str) for c in calls]
            progress = any((self.toolmap.get(c["name"]) and not self.toolmap[c["name"]].readonly) or s_ not in self.seen
                           for c, s_ in zip(calls, sigs))
            for s_ in sigs:
                self.seen[s_] = self.seen.get(s_, 0) + 1
            stale = 0 if progress else stale + 1
            if stale >= 4 and self.escalate("it kept repeating the same read-only calls without making progress."):
                stale = 0
            elif stale >= 6:
                self._feed(as_text, calls, outs)
                return self._wrap_up("No progress: the same read-only calls were repeated for 6 turns.")
            elif stale >= 2:
                outs[-1] += ("\n[harness] You have already made these exact calls before; the results are in your context and will not "
                             "change. Stop re-reading and take the next concrete step (write or edit a file, or run something).")
            sig = json.dumps([(c["name"], c["args"]) for c in calls], sort_keys=True, default=str)
            repeats = repeats + 1 if sig == last_sig else 0
            last_sig = sig
            if repeats >= 4:
                if self.escalate("it repeated the same tool call 5 times without progress."):
                    repeats, last_sig = 0, ""
                else:
                    self._feed(as_text, calls, outs)
                    return self._wrap_up("You repeated the same tool call 5 times without progress.")
            if repeats == 2:
                outs[-1] += "\n[harness] You have made this exact call 3 times. It will not change. Try a different approach."
            if r.finish == "length":
                outs[-1] += "\n[harness] Your previous output hit the length limit; split large writes into smaller files/edits."
            if self.tier == "weak" and self.role == "main" and self.steps % 4 == 0:
                # weak models drift; a tail reminder is cheap and does not disturb the cached prefix
                outs[-1] += (f"\n[harness] Reminder of the task: {self.goal}\nDo not explore further than needed. "
                             "If you already have what you need, produce the requested result now.")
            self._feed(as_text, calls, outs)

    def _feed(self, as_text: bool, calls: list, outs: list) -> None:
        if as_text:
            body = "\n".join(f'<tool_result name="{c["name"]}">\n{o}\n</tool_result>' for c, o in zip(calls, outs))
            self.messages.append({"role": "user", "content": body + "\nContinue."})
        else:
            for c, o in zip(calls, outs):
                self.messages.append({"role": "tool", "tool_call_id": c["id"], "content": o})

    def _wrap_up(self, reason: str) -> str:
        self.s.bus.emit("notice", level="warn", text=reason, agent=self.name)
        if self.role == "main":
            self.s.incomplete = reason                 # the run must not be reported as done
        self.messages.append({"role": "user", "content": f"{reason} Stop working. Reply with a brief status: what is done, what remains, and where things are."})
        try:
            r = self._chat()     # tools stay declared: some providers reject tool history without them
            text = parse_text_calls(r.content or "")[0] or reason
        except LLMError as e:
            text = f"{reason} ({e})"
        self.s.bus.emit("assistant", text=text, agent=self.name)
        self.save()
        return text
