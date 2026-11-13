"""The model team: with `model = "auto"` the harness itself decides which model does each job, paying for strength
only where it changes the outcome.

The roster below is evidence, not taste: every model in it passed our own benchmark (docs/BENCHMARK.md), and the order
inside a role is cost per solved task. A project or user can override any role in config:

    [team]
    worker = "openai/gpt-6-luna"
    deep = ["openai/gpt-6.1-terra", "anthropic/claude-sonnet-5.5"]

Roles
  worker      the main loop: the cheapest model that solved every task of the quick and the hard suites
  light       sub-agents that only search, read or summarize
  deep        sub-agents asked for hard reasoning, design or debugging
  planner     writes the plan in the `pev` workflow (read-only)
  verifier    the independent reviewer: from another vendor than the worker, so it does not share its blind spots
  escalation  takes over the same conversation when the worker is stuck (two failed gates)
  helper      compaction summaries and lesson reflection
  perception  describes images, audio and video for models that cannot perceive them
"""
from __future__ import annotations

ROSTER: dict[str, list[str]] = {
    "worker": ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5", "deepseek/deepseek-v4.1-flash-1017", "openai/gpt-6.1-terra"],
    "light": ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5", "meta/muse-ember"],
    "deep": ["openai/gpt-6.1-terra", "anthropic/claude-sonnet-5.5"],
    "planner": ["openai/gpt-6.1-terra", "anthropic/claude-sonnet-5.5"],
    "verifier": ["anthropic/claude-haiku-5.5", "openai/gpt-6-luna", "openai/gpt-6.1-terra"],
    "escalation": ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-terra"],
    "helper": ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"],
    "perception": ["meta/muse-ember"],
}
ROLES = tuple(ROSTER)

WHY = {
    "worker": "faz a tarefa: o mais barato que resolveu todas as tarefas dos nossos benchmarks",
    "light": "sub-agentes de busca, leitura e resumo",
    "deep": "sub-agentes de raciocínio difícil, desenho ou depuração",
    "planner": "escreve o plano no modo Planejar, executar e revisar",
    "verifier": "revisor independente, de outro fornecedor que o executor",
    "escalation": "assume a conversa quando o executor trava",
    "helper": "resume o contexto e extrai lições",
    "perception": "descreve imagem, áudio e vídeo",
}


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


def team(cfg: dict, catalog) -> dict[str, str]:
    """Resolve every role to a model id. Raises ValueError when nothing can be chosen."""
    overrides = cfg.get("team") or {}

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
        cands = mine + [m for m in ROSTER[role] if m not in mine]
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


def apply(cfg: dict, catalog) -> dict[str, str]:
    """Pick the team and write it into the session's config (roles the user set explicitly are kept)."""
    t = team(cfg, catalog)
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


def describe(t: dict[str, str]) -> list[dict]:
    return [{"role": r, "model": t[r], "why": WHY[r]} for r in ROLES if r in t]
