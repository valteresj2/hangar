"""Tool-call robustness layer: JSON repair, argument coercion and a plain-text tool protocol
so that models without (reliable) native function calling can still drive the harness."""
from __future__ import annotations

import ast
import json
import re

KEY_ALIASES = {
    "file_path": "path", "filepath": "path", "filename": "path", "file": "path", "file_name": "path",
    "cmd": "command", "script": "command", "text": "content", "contents": "content", "data": "content",
    "old_string": "old", "old_str": "old", "old_text": "old", "search": "old",
    "new_string": "new", "new_str": "new", "new_text": "new", "replace": "new",
    "regex": "pattern", "query": "pattern", "dir": "path", "directory": "path",
    "replace_all": "all", "args": "arguments", "prompt": "question", "todos": "items", "steps": "items",
}


def _balance(t: str) -> str:
    """Append the closers a truncated JSON document is missing."""
    stack, in_str, esc = [], False, False
    for ch in t:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]" and stack:
            stack.pop()
    return t + ('"' if in_str else "") + "".join(reversed(stack))


def _first_object(t: str) -> str:
    """The first balanced {...} in t (ignores trailing junk such as an extra closing brace)."""
    depth, in_str, esc = 0, False, False
    for i, ch in enumerate(t):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return t[:i + 1]
    return t


def repair_json(s):
    """Best-effort parse of model-emitted JSON. Returns (value, ok)."""
    if isinstance(s, (dict, list)):
        return s, True
    if s is None:
        return {}, True
    t = str(s).strip()
    if not t:
        return {}, True
    for _ in range(3):
        try:
            v = json.loads(t, strict=False)
        except Exception:
            break
        if isinstance(v, str):          # double-encoded arguments
            t = v.strip()
            continue
        return v, True
    t = re.sub(r"^```(?:json|JSON)?\s*|\s*```$", "", t).strip()
    cands = [t]
    i, j = t.find("{"), t.rfind("}")
    if i != -1 and j > i:
        cands.append(t[i:j + 1])
    if i != -1:
        cands.append(_balance(t[i:]))                 # truncated output: close what was left open
    for c in cands:
        for fix in (lambda x: x, lambda x: re.sub(r",\s*([}\]])", r"\1", x)):
            try:
                return json.loads(fix(c), strict=False), True
            except Exception:
                pass
        try:
            v = ast.literal_eval(c)
            if isinstance(v, (dict, list)):
                return v, True
        except Exception:
            pass
    return {}, False


def _coerce(value, spec: dict):
    t = spec.get("type")
    try:
        if t == "integer" and not isinstance(value, bool):
            return int(float(value)) if isinstance(value, (str, float)) else value
        if t == "number" and isinstance(value, str):
            return float(value)
        if t == "boolean" and isinstance(value, str):
            return value.strip().lower() in ("true", "1", "yes", "y", "sim")
        if t == "string" and not isinstance(value, str):
            return json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
        if t == "array" and isinstance(value, str):
            v, ok = repair_json(value)
            return v if ok and isinstance(v, list) else [value]
        if t == "array" and not isinstance(value, list):
            return [value]
        if t == "object" and isinstance(value, str):
            v, ok = repair_json(value)
            return v if ok and isinstance(v, dict) else value
    except (ValueError, TypeError):
        pass
    return value


def signature(name: str, schema: dict) -> str:
    props, req = schema.get("properties", {}), set(schema.get("required", []))
    return f"{name}(" + ", ".join(k if k in req else k + "?" for k in props) + ")"


def coerce_args(name: str, schema: dict, args) -> tuple[dict, str | None]:
    """Forgiving validation: rename common aliases, coerce types, report what is missing."""
    if not isinstance(args, dict):
        return {}, f"Arguments must be a JSON object. Usage: {signature(name, schema)}"
    props = schema.get("properties", {})
    out = {}
    for k, v in args.items():
        if k not in props and KEY_ALIASES.get(k) in props:
            k = KEY_ALIASES[k]
        if k in props:
            out[k] = _coerce(v, props[k])
    missing = [k for k in schema.get("required", []) if k not in out or out[k] is None]
    if missing:
        example = {k: out.get(k, f"<{props.get(k, {}).get('type', 'value')}>") for k in schema.get("required", [])}
        return out, (f"Missing required argument(s): {', '.join(missing)}. Call it again WITH the arguments, like: "
                     + json.dumps({"name": name, "arguments": example}, ensure_ascii=False))
    return out, None


# ---------------------------------------------------------------- text protocol

_TAG = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|\Z)", re.S)
_FUNC = re.compile(r"<function=([\w.\-]+)>\s*(.*?)\s*</function>", re.S)
_FENCE = re.compile(r"```(?:json|tool_call|tool)?\s*(\{.*?\})\s*```", re.S)


def _as_call(obj):
    if not isinstance(obj, dict):
        return None
    if isinstance(obj.get("function"), dict):
        obj = obj["function"]
    name = obj.get("name") or obj.get("tool") or obj.get("tool_name") or obj.get("function")
    if not isinstance(name, str) or not name:
        return None
    args = obj.get("arguments", obj.get("args", obj.get("parameters", obj.get("input"))))
    if args is None:
        args = {k: v for k, v in obj.items() if k not in ("name", "tool", "tool_name", "function", "id", "type")}
    if isinstance(args, str):
        args, _ = repair_json(args)
    return {"name": name, "args": args if isinstance(args, dict) else {}}


def parse_text_calls(text: str) -> tuple[str, list[dict]]:
    """Extract tool calls written as text. Returns (text without the calls, calls)."""
    calls, clean = [], text or ""
    for m in _TAG.finditer(clean):
        block = m.group(1)
        obj, ok = repair_json(block)
        found = [c for c in (_as_call(o) for o in (obj if isinstance(obj, list) else [obj])) if c] if ok else []
        if not found:                                   # hybrids like {"function=glob", "arguments": {...}}
            h = re.search(r'(?:function|name|tool)["\']?\s*[=:]\s*["\']?([\w.\-]+)', block)
            if h:
                rest = block[h.end():]
                k = rest.find('"arguments"')
                rest = rest[k + 11:] if k != -1 else rest
                args, aok = repair_json(_first_object(rest[rest.find("{"):])) if "{" in rest else ({}, True)
                found = [{"name": h.group(1), "args": args if aok and isinstance(args, dict) else {}}]
        calls += found
    if calls:
        return _TAG.sub("", clean).strip(), calls
    for m in _FUNC.finditer(clean):
        args, _ = repair_json(m.group(2))
        calls.append({"name": m.group(1), "args": args if isinstance(args, dict) else {}})
    if calls:
        return _FUNC.sub("", clean).strip(), calls
    for m in _FENCE.finditer(clean):
        obj, ok = repair_json(m.group(1))
        c = _as_call(obj) if ok and isinstance(obj, dict) and ("arguments" in obj or "args" in obj or "parameters" in obj) else None
        if c:
            calls.append(c)
    if calls:
        return _FENCE.sub("", clean).strip(), calls
    s = clean.strip()
    if s.startswith("{") and s.endswith("}") and '"name"' in s:
        obj, ok = repair_json(s)
        c = _as_call(obj) if ok else None
        if c and isinstance(obj, dict) and any(k in obj for k in ("arguments", "args", "parameters")):
            return "", [c]
    return clean, []


def text_protocol_prompt(tools: list) -> str:
    lines = [
        "# Tools",
        "To use a tool, write exactly this (valid JSON inside the tags):",
        "<tool_call>",
        '{"name": "TOOL_NAME", "arguments": {"arg": "value"}}',
        "</tool_call>",
        "Then STOP and wait. The result comes back inside <tool_result> tags.",
        "Never invent a tool result. When the whole task is done, answer normally with no tool_call.",
        "",
        "Available tools (? = optional argument):",
    ]
    for t in tools:
        lines.append(f"- {signature(t.name, t.parameters)}: {t.description}")
    return "\n".join(lines)
