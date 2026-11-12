"""Streaming client for any OpenAI-compatible chat endpoint (OpenRouter by default).
Stdlib only. Classifies errors, retries the transient ones, and reports real usage/cost."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field


class LLMError(Exception):
    def __init__(self, kind: str, msg: str, retry: bool = False):
        super().__init__(f"{kind}: {msg}")
        self.kind, self.retry = kind, retry


@dataclass
class Reply:
    content: str = ""
    tool_calls: list = field(default_factory=list)   # [{"id","name","arguments"(str)}]
    reasoning_details: list = field(default_factory=list)
    reasoning: str = ""
    finish: str = ""
    usage: dict = field(default_factory=dict)
    ms: int = 0
    model: str = ""


def _merge_details(acc: list, new: list) -> None:
    """Reassemble streamed reasoning blocks; providers need them echoed back intact on tool turns."""
    for d in new or []:
        if not isinstance(d, dict):
            continue
        key = (d.get("index"), d.get("type"))
        cur = next((x for x in acc if (x.get("index"), x.get("type")) == key), None)
        if cur is None:
            acc.append(dict(d))
            continue
        for k, v in d.items():
            if v is None:
                continue
            if k in ("text", "summary", "data") and isinstance(v, str) and isinstance(cur.get(k), str):
                cur[k] += v
            else:
                cur[k] = v


class LLM:
    def __init__(self, cfg: dict, catalog, bus=None, session_id: str = ""):
        self.cfg, self.catalog, self.bus, self.session_id = cfg, catalog, bus, session_id
        self.timeout = 180
        self.abort = None                                # threading.Event set by the session to cancel a stream

    # ------------------------------------------------------------------ public
    def chat(self, model: str, messages: list, tools: list | None = None, on_delta=None,
             max_tokens: int | None = None, temperature: float | None = None,
             agent: str = "main", reasoning: str | None = None, _fallback: bool = False) -> Reply:
        info = self.catalog.info(model)
        prov = self.cfg["providers"][info["provider"]]
        body: dict = {"model": info["id"], "messages": messages, "stream": True,
                      "max_tokens": max_tokens or self.cfg["max_output_tokens"]}
        if tools:
            body["tools"] = tools
        if temperature is not None:
            body["temperature"] = temperature
        if info["provider"] == "openrouter":
            body["usage"] = {"include": True}
            if self.session_id:
                body["session_id"] = self.session_id          # sticky routing keeps provider caches warm
            effort = self.cfg["reasoning_effort"] if reasoning is None else reasoning
            if effort:
                body["reasoning"] = {"effort": effort}
            if info["id"].startswith("anthropic/"):
                body["cache_control"] = {"type": "ephemeral"}  # automatic prefix caching
        else:
            body["stream_options"] = {"include_usage": True}
        headers = {"Content-Type": "application/json", "X-Title": "Hangar Harness"}
        key = os.environ.get(prov.get("api_key_env") or "", "")
        if key:
            headers["Authorization"] = f"Bearer {key}"
        elif prov.get("api_key_env"):
            raise LLMError("auth", f"environment variable {prov['api_key_env']} is not set")
        url = prov["base_url"].rstrip("/") + "/chat/completions"
        if self.bus:
            self.bus.emit("llm_start", model=model, agent=agent, messages=len(messages))
        last: LLMError | None = None
        for attempt in range(5):
            t0 = time.time()
            try:
                reply = self._once(url, headers, body, on_delta)
                reply.ms = int((time.time() - t0) * 1000)
                reply.model = model
                self._price(reply, info)
                return reply
            except LLMError as e:
                last = e
                if not e.retry or attempt == 4:
                    break
                wait = min(30, 2 ** attempt * 1.5)
                if self.bus:
                    self.bus.emit("notice", level="warn", text=f"{e}; retrying in {wait:.0f}s")
                time.sleep(wait)
        if last and last.kind in ("transient", "network") and not _fallback:     # provider down: try the configured stand-ins
            for fb in self.cfg.get("fallback_models") or []:
                if fb == model:
                    continue
                if self.bus:
                    self.bus.emit("notice", level="warn", text=f"{model} unavailable ({last.kind}); falling back to {fb}")
                try:
                    return self.chat(fb, messages, tools=tools, on_delta=on_delta, max_tokens=max_tokens, temperature=temperature,
                                     agent=agent, reasoning=reasoning, _fallback=True)
                except LLMError as e:
                    last = e
        raise last  # type: ignore[misc]

    # ---------------------------------------------------------------- internal
    @staticmethod
    def _classify(code: int, text: str) -> LLMError:
        low = text.lower()
        msg = text[:600]
        if code in (401, 403):
            return LLMError("auth", msg)
        if code == 402:
            return LLMError("credits", msg)
        if "tool" in low and ("support" in low or "no endpoints" in low):
            return LLMError("no_tools", msg)
        if any(s in low for s in ("context length", "maximum context", "too many tokens", "context_length", "prompt is too long")):
            return LLMError("context_overflow", msg)
        if code in (408, 409, 425, 429) or code >= 500 or "overloaded" in low or "rate limit" in low:
            return LLMError("transient", f"HTTP {code} {msg}", retry=True)
        return LLMError("bad_request", f"HTTP {code} {msg}")

    def _once(self, url: str, headers: dict, body: dict, on_delta) -> Reply:
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        try:
            resp = urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            raise self._classify(e.code, e.read().decode("utf-8", "replace")) from None
        except (urllib.error.URLError, OSError) as e:
            raise LLMError("network", str(e), retry=True) from None
        reply, calls = Reply(), {}
        try:
            with resp:
                for raw in resp:
                    if self.abort is not None and self.abort.is_set():
                        raise LLMError("aborted", "interrupted by the user")
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        ev = json.loads(payload)
                    except ValueError:
                        continue
                    if ev.get("error"):
                        err = ev["error"]
                        raise self._classify(int(err.get("code") or 500) if str(err.get("code", "")).isdigit() else 500,
                                             json.dumps(err)[:600])
                    if ev.get("usage"):
                        reply.usage = ev["usage"]
                    for ch in ev.get("choices") or []:
                        d = ch.get("delta") or {}
                        if d.get("content"):
                            reply.content += d["content"]
                            if on_delta:
                                on_delta(d["content"], "text")
                        r = d.get("reasoning") or d.get("reasoning_content")
                        if r:
                            reply.reasoning += r
                            if on_delta:
                                on_delta(r, "reasoning")
                        _merge_details(reply.reasoning_details, d.get("reasoning_details"))
                        for tc in d.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            cur = calls.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                            fn = tc.get("function") or {}
                            cur["id"] = tc.get("id") or cur["id"]
                            if fn.get("name"):
                                cur["name"] = fn["name"]
                            if fn.get("arguments"):
                                cur["arguments"] += fn["arguments"]
                        if ch.get("finish_reason"):
                            reply.finish = ch["finish_reason"]
        except LLMError:
            raise
        except (OSError, ValueError) as e:
            raise LLMError("network", f"stream interrupted: {e}", retry=True) from None
        reply.tool_calls = [calls[i] for i in sorted(calls) if calls[i]["name"]]
        return reply

    @staticmethod
    def _price(reply: Reply, info: dict) -> None:
        u = reply.usage or {}
        ptd, ctd = u.get("prompt_tokens_details") or {}, u.get("completion_tokens_details") or {}
        pt, ct = int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)
        cost = u.get("cost")
        estimated = cost is None
        if estimated:
            cost = (pt * info["price_in"] + ct * info["price_out"]) / 1e6
        reply.usage = {
            "prompt": pt, "completion": ct,
            "cached": int(ptd.get("cached_tokens") or 0),
            "cache_write": int(ptd.get("cache_write_tokens") or 0),
            "reasoning": int(ctd.get("reasoning_tokens") or 0),
            "cost": float(cost or 0), "estimated": estimated,
        }
