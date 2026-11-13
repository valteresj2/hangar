"""Configuration: defaults < ~/.hangar/config.toml < <cwd>/hangar.toml < CLI overrides."""
from __future__ import annotations

import copy
import os
import tomllib
from pathlib import Path

HOME = Path(os.environ.get("HANGAR_HOME") or (Path.home() / ".hangar"))
PKG_ROOT = Path(__file__).resolve().parent.parent

DEFAULTS: dict = {
    # models -----------------------------------------------------------------
    "model": "openai/gpt-6-luna",          # worker / main loop
    "planner_model": "",                   # graph workflows; "" = same as model
    "verifier_model": "",                  # goldfish reviewer; "" = planner or model
    "helper_model": "openai/gpt-6-luna",   # compaction summaries (cheap)
    "perception_model": "meta/muse-ember", # image/audio/video -> text fallback
    "default_provider": "openrouter",
    "providers": {
        "openrouter": {"base_url": "https://openrouter.ai/api/v1", "api_key_env": "OPENROUTER_API_KEY"},
        "openai": {"base_url": "https://api.openai.com/v1", "api_key_env": "OPENAI_API_KEY"},
        "ollama": {"base_url": "http://localhost:11434/v1", "api_key_env": ""},
        "lmstudio": {"base_url": "http://localhost:1234/v1", "api_key_env": ""},
    },
    "escalation_model": "",                # a stronger model that takes over when the worker is stuck
    "team": {},                            # with model = "auto": per-role overrides of the roster (see router.py)
    "fallback_models": [],                 # stand-ins when a provider is down
    "tiers": {},                           # {"model/id": "strong|standard|weak"} overrides
    # loop limits --------------------------------------------------------------
    "workflow": "loop",
    "max_steps": 60,
    "max_cost_usd": 2.0,
    "max_output_tokens": 16000,            # per call; doubles (up to 32k) after a truncated turn
    "reasoning_effort": "low",             # "", low, medium, high
    # context economy ----------------------------------------------------------
    "context_budget": 120_000,             # tokens; also capped by the model window
    "tool_output_cap": 8000,               # chars kept in context per tool result
    "keep_tool_results": 6,                # newest results never cleared
    "mcp_inline_max": 10,                  # more MCP tools than this -> deferred loading
    "skills_dirs": [],
    # learning and policy -------------------------------------------------------
    "lessons": True,                       # write/reuse verified lessons (see lessons.py)
    "lessons_max_age_days": 90,
    "hooks": [],                           # [[hooks]] rules (see hooks.py)
    "trust_project": False,                # allow project hooks/plugins that execute code
    "trusted_projects": [],                     # extra skill folders, e.g. ["~/.claude/skills"]
    # execution ----------------------------------------------------------------
    "permission": "auto",                  # auto | ask | readonly
    "shell": "auto",                       # auto | bash | powershell
    "shell_timeout": 120,
    "parallel_tools": 0,                   # 0 = min(8, cpu cores)
    "ask_timeout": 1800,
    "verify_nudge": True,
}


def load_env() -> None:
    """Load KEY=VALUE pairs from .env files without overriding the real environment."""
    for p in (Path.cwd() / ".env", PKG_ROOT / ".env", HOME / ".env"):
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except OSError:
            pass


def _merge(base: dict, extra: dict) -> dict:
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def load(cwd: Path | None = None, overrides: dict | None = None) -> dict:
    load_env()
    cfg = copy.deepcopy(DEFAULTS)
    cwd = Path(cwd or Path.cwd())
    hooks: list = []
    for p in (HOME / "config.toml", cwd / "hangar.toml", cwd / ".hangar" / "config.toml"):
        if p.is_file():
            try:
                data = tomllib.loads(p.read_text(encoding="utf-8"))
            except (OSError, tomllib.TOMLDecodeError) as e:
                print(f"[hangar] ignoring bad config {p}: {e}")
                continue
            source = "home" if p.parent == HOME else "project"
            hooks += [{**h, "_source": source} for h in data.pop("hooks", []) if isinstance(h, dict)]   # rules accumulate, never override
            if source == "project":
                for key in ("trust_project", "trusted_projects"):    # a repo cannot declare itself trusted
                    data.pop(key, None)
            _merge(cfg, data)
    cfg["hooks"] = hooks
    _merge(cfg, {k: v for k, v in (overrides or {}).items() if v not in (None, "")})
    if not cfg["parallel_tools"]:
        cfg["parallel_tools"] = min(8, os.cpu_count() or 4)
    return cfg
