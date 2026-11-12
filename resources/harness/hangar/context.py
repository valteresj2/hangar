"""Context economy, cheapest tier first:
  tier 0  cap every tool result on entry (stable -> cache stays warm), spill the rest to disk
  tier 1  clear old tool results in ONE batch when the budget fills (one cache rebuild, not one per turn)
  tier 2  summarise old history with a cheap helper model; full transcript stays on disk
History is otherwise append-only so the provider prompt cache keeps hitting."""
from __future__ import annotations

import json

SUMMARY_PROMPT = """Summarise this agent session into a checkpoint the agent can continue from.
Sections: GOAL / DONE / FILES (path + current state) / KEY FACTS (exact values, commands, errors, user answers) / NEXT.
Under 350 words. Keep identifiers, paths and numbers exact. Output only the checkpoint."""


def _chars(messages: list) -> int:
    n = 0
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            n += len(c)
        elif isinstance(c, list):
            n += sum(len(p.get("text", "")) if p.get("type") == "text" else 1200 for p in c)
        for tc in m.get("tool_calls") or []:
            n += len(tc["function"]["arguments"]) + len(tc["function"]["name"]) + 20
    return n


class Context:
    def __init__(self, agent):
        self.a = agent
        s = agent.s
        self.budget = int(min(s.cfg["context_budget"], agent.info["context"] * 0.8))
        self.last_prompt_tokens = 0
        self.chars_at_last = 0
        self.next_clear = 0.6 * self.budget
        self.next_summary = 0.85 * self.budget
        self.compactions = 0
        self._floored = False

    def _floor(self) -> None:
        """A budget smaller than the fixed prefix (system prompt + tool schemas) plus working room can only thrash."""
        if self._floored or not self.a.messages:
            return
        self._floored = True
        fixed = _chars(self.a.messages[:1]) // 3 + self.a.tool_overhead
        if self.budget < fixed + 8000:
            self.budget = fixed + 8000
            self.next_clear, self.next_summary = 0.6 * self.budget, 0.85 * self.budget

    def observe(self, prompt_tokens: int) -> None:
        if prompt_tokens:
            self.last_prompt_tokens = prompt_tokens
            self.chars_at_last = _chars(self.a.messages)

    def estimate(self) -> int:
        if self.last_prompt_tokens:
            return self.last_prompt_tokens + max(0, _chars(self.a.messages) - self.chars_at_last) // 3
        return _chars(self.a.messages) // 3 + self.a.tool_overhead

    def _is_result(self, m: dict) -> bool:
        return m.get("role") == "tool" or (m.get("role") == "user" and isinstance(m.get("content"), str)
                                           and m["content"].startswith("<tool_result"))

    def maybe_compact(self, force: bool = False) -> None:
        self._floor()
        est = self.estimate()
        if not force and est < self.next_clear:
            return
        s, msgs = self.a.s, self.a.messages
        idx = [i for i, m in enumerate(msgs) if self._is_result(m)]
        freed = 0
        for i in idx[:-s.cfg["keep_tool_results"]] if len(idx) > s.cfg["keep_tool_results"] else []:
            c = msgs[i]["content"]
            if isinstance(c, str) and len(c) > 400 and not c.startswith("[cleared"):
                msgs[i]["content"] = f"[cleared to save context: {len(c)} chars. Re-run the tool if you need it again.]"
                freed += len(c)
        if freed:
            est -= freed // 3
            self.last_prompt_tokens, self.chars_at_last = est, _chars(msgs)
            s.bus.emit("compact", tier=1, freed_tokens=freed // 3, agent=self.a.name)
        self.next_clear = est + 0.15 * self.budget
        if force or est >= self.next_summary:
            self._summarise()

    def _summarise(self) -> None:
        s, msgs = self.a.s, self.a.messages
        if len(msgs) < 8:
            return
        # keep a recent tail sized by content, not by message count: a few huge results must not fill the window again
        room, cut = 0.3 * self.budget * 3, len(msgs)
        while cut > 3 and (len(msgs) - cut < 4 or room > 0) and len(msgs) - cut < 14:
            cut -= 1
            room -= _chars([msgs[cut]])
        while cut > 2 and msgs[cut].get("role") == "tool":
            cut -= 1
        if cut <= 2:
            return
        old = msgs[2:cut]
        self.compactions += 1
        dump = s.dir / f"history_{self.a.name}_{self.compactions}.json"
        dump.write_text(json.dumps(msgs, ensure_ascii=False, default=str), encoding="utf-8")
        lines = []
        for m in old:
            c = m.get("content")
            text = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)[:500] if c else ""
            calls = "; ".join(f"{tc['function']['name']}({tc['function']['arguments'][:300]})" for tc in m.get("tool_calls") or [])
            lines.append(f"[{m['role']}] {text[:1500]} {calls}".strip())
        transcript = "\n".join(lines)[-60000:]
        try:
            r = s.llm.chat(s.cfg["helper_model"], [{"role": "system", "content": SUMMARY_PROMPT},
                                                  {"role": "user", "content": transcript}],
                           max_tokens=900, agent="compactor", reasoning="")
            s.add_usage(r, s.cfg["helper_model"], "compactor")
            summary = r.content.strip()
        except Exception as e:
            summary = f"(summary unavailable: {e})"
        sticky = s.sticky()
        note = {"role": "user", "content": f"[Checkpoint of earlier work. Full transcript: {dump}]\n{summary}"
                                           + (f"\n\n[Exact state kept by the harness]\n{sticky}" if sticky else "")}
        self.a.messages = msgs[:2] + [note] + msgs[cut:]
        self.last_prompt_tokens, self.chars_at_last = 0, 0
        after = self.estimate()
        # hysteresis: the next clear/summary needs real growth, otherwise a tight budget compacts on every turn
        self.next_clear = max(0.6 * self.budget, after + 0.2 * self.budget)
        self.next_summary = max(0.85 * self.budget, after + 0.35 * self.budget)
        s.bus.emit("compact", tier=2, dropped_messages=len(old), agent=self.a.name, tokens_after=after)
