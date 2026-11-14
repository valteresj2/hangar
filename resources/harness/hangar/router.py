"""The model team: with `model = "auto"` the harness itself decides which model does each job, paying for strength
only where it changes the outcome.

The roster is evidence, not taste: it is generated from benchmark results by `bench/roster.py` and shipped as
`roster.json` next to this file. A model enters a role only when it solved every run of the tasks that role needs, and
the order inside a role is cost per solved task. Run the benchmark again and the team follows the numbers; a roster of
your own runs in `~/.hangar/roster.json` replaces the shipped one. A project or user can override any role in config:

    [team]
    worker = "openai/gpt-6-luna"
    deep = ["openai/gpt-6.1-terra", "anthropic/claude-sonnet-5.5"]

Roles
  worker      the main loop: the cheapest model that solved every everyday, media and hard task
  light       sub-agents that only search, read or summarize
  deep        sub-agents asked for hard reasoning, design or debugging: the cheapest that solved the hardest task
  planner     writes the plan in the `pev` workflow (read-only)
  verifier    the independent reviewer: from another vendor than the worker, so it does not share its blind spots
  escalation  takes over the same conversation when the worker is stuck (two failed gates)
  helper      compaction summaries and lesson reflection
  perception  describes images, audio and video for models that cannot perceive them
"""
from __future__ import annotations

import json
from pathlib import Path

from .config import HOME

ROLES = ("worker", "light", "deep", "planner", "verifier", "escalation", "helper", "perception")
SHIPPED = Path(__file__).resolve().parent / "roster.json"
# Used only when no roster file can be read (a broken install): the team of the first published benchmark.
FALLBACK: dict[str, list[str]] = {
    "worker": ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"], "light": ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"],
    "deep": ["anthropic/claude-haiku-5.5", "openai/gpt-6.1-terra"], "planner": ["anthropic/claude-haiku-5.5", "openai/gpt-6.1-terra"],
    "verifier": ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"], "escalation": ["anthropic/claude-haiku-5.5", "openai/gpt-6.1-terra"],
    "helper": ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"], "perception": ["meta/muse-ember"],
}

WHY = {
    "worker": "faz a tarefa: o mais barato que resolveu todas as tarefas do dia a dia, de mídia e difíceis",
    "light": "sub-agentes de busca, leitura e resumo",
    "deep": "sub-agentes de raciocínio difícil: o mais barato que resolveu a tarefa mais difícil",
    "planner": "escreve o plano no modo Planejar, executar e revisar",
    "verifier": "revisor independente, de outro fornecedor que o executor",
    "escalation": "assume a conversa quando o executor trava",
    "helper": "resume o contexto e extrai lições",
    "perception": "descreve imagem, áudio e vídeo",
}


def load(paths=None) -> dict:
    """The roster in use: {"roles": {role: [model ids]}, "evidence": {role: {model: row}}, "generated", "source"}.
    The first readable file wins; a file that misses a role is ignored as a whole."""
    for p in (paths if paths is not None else (HOME / "roster.json", SHIPPED)):
        try:
            doc = json.loads(Path(p).read_text(encoding="utf-8"))
            rows = {r: [x for x in doc["roles"][r] if isinstance(x, dict) and x.get("model")] for r in ROLES}
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if all(rows.values()):
            return {"roles": {r: [x["model"] for x in v] for r, v in rows.items()},
                    "evidence": {r: {x["model"]: x for x in v} for r, v in rows.items()},
                    "generated": str(doc.get("generated") or ""), "source": str(p)}
    return {"roles": FALLBACK, "evidence": {}, "generated": "", "source": "builtin"}


def _vendor(model: str) -> str:
    return model.split("/")[0].split(":")[-1]


def _usable(known: dict, model: str, role: str) -> bool:
    if not known:
        return True                                      # offline, no cached catalog: trust the roster
    m = known.get(model)
    if not m:
        return False
    if role == "perception":
        return bool({"image", "audio", "video"} & set(m.get("modalities") or []))
    return bool(m.get("tools"))


def team(cfg: dict, catalog, roster: dict | None = None) -> dict[str, str]:
    """Resolve every role to a model id. Raises ValueError when nothing can be chosen."""
    overrides = cfg.get("team") or {}
    ranked = (roster or load())["roles"]

    def wanted(role: str) -> list[str]:
        v = overrides.get(role)
        return [v] if isinstance(v, str) and v else [str(x) for x in v] if isinstance(v, list) else []

    if cfg["default_provider"] != "openrouter":          # a local or private provider: no roster applies
        base = cfg["model"] if cfg["model"] != "auto" else (wanted("worker") or [""])[0]
        if not base:
            raise ValueError('model = "auto" needs OpenRouter, or a [team] table (at least `worker`) for this provider.')
        return {role: (wanted(role) or [base])[0] for role in ROLES}

    known = catalog._load()
    out: dict[str, str] = {}
    for role in ROLES:
        mine = wanted(role)
        cands = mine + [m for m in ranked[role] if m not in mine]
        usable = [m for m in cands if (m in mine and not known) or _usable(known, m, role) or (m in mine and m not in known and ":" in m)]
        if role == "verifier" and not mine and "worker" in out:
            other = [m for m in usable if _vendor(m) != _vendor(out["worker"])]
            usable = other + [m for m in usable if m not in other]
        if not usable:
            if role in ("perception",):
                out[role] = cfg.get("perception_model") or cands[0]
                continue
            usable = [out["worker"]] if "worker" in out else cands[:1]
        out[role] = usable[0]
    return out


def apply(cfg: dict, catalog, roster: dict | None = None) -> dict[str, str]:
    """Pick the team and write it into the session's config (roles the user set explicitly are kept)."""
    t = team(cfg, catalog, roster)
    for key, role in (("planner_model", "planner"), ("verifier_model", "verifier"), ("escalation_model", "escalation")):
        if cfg.get(key) in ("", None, "auto"):
            cfg[key] = t[role]
        else:
            t[role] = cfg[key]
    cfg["helper_model"] = t["helper"]
    if cfg["default_provider"] == "openrouter" or (cfg.get("team") or {}).get("perception"):
        cfg["perception_model"] = t["perception"]
    else:                                                # a private provider: perception stays whatever the user configured
        t["perception"] = cfg.get("perception_model") or t["perception"]
    if cfg.get("escalation_model") == t["worker"]:
        cfg["escalation_model"] = ""                     # nothing stronger to hand over to
    return t


def describe(t: dict[str, str], roster: dict | None = None) -> list[dict]:
    """The team as rows for a UI: role, model, why that role exists and the benchmark numbers behind the choice."""
    ev = (roster or load())["evidence"]
    out = []
    for r in ROLES:
        if r not in t:
            continue
        e = (ev.get(r) or {}).get(t[r])
        out.append({"role": r, "model": t[r], "why": WHY[r],
                    "evidence": (f"{e['solved']}/{e['runs']} execuções resolvidas · US$ {e['cost_per_solved']:.4f} "
                                 + ("na tarefa mais difícil" if e.get("ranked_on") == ["frontier"] else "por tarefa resolvida")) if e else ""})
    return out
