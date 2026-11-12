"""Model catalog: context window, price, modalities, native tool support and capability tier.
Fetched from OpenRouter once a day; other providers get conservative defaults."""
from __future__ import annotations

import json
import time
import urllib.request

from .config import HOME

CACHE = HOME / "models_cache.json"
TTL = 24 * 3600


class Catalog:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._models: dict | None = None

    def _load(self) -> dict:
        if self._models is not None:
            return self._models
        data = None
        try:
            if CACHE.is_file() and time.time() - CACHE.stat().st_mtime < TTL:
                data = json.loads(CACHE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        if data is None:
            try:
                url = self.cfg["providers"]["openrouter"]["base_url"].rstrip("/") + "/models"
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "hangar-harness"}), timeout=20) as r:
                    raw = json.loads(r.read().decode("utf-8"))["data"]
                data = {}
                for m in raw:
                    p = m.get("pricing") or {}
                    try:
                        pin, pout = float(p.get("prompt") or 0) * 1e6, float(p.get("completion") or 0) * 1e6
                    except ValueError:
                        pin = pout = 0.0
                    data[m["id"]] = {
                        "context": m.get("context_length") or 32000,
                        "price_in": pin, "price_out": pout,
                        "modalities": (m.get("architecture") or {}).get("input_modalities") or ["text"],
                        "tools": "tools" in (m.get("supported_parameters") or []),
                        "name": m.get("name") or m["id"],
                    }
                HOME.mkdir(parents=True, exist_ok=True)
                CACHE.write_text(json.dumps(data), encoding="utf-8")
            except Exception:
                try:
                    data = json.loads(CACHE.read_text(encoding="utf-8"))
                except Exception:
                    data = {}
        self._models = data
        return data

    def provider_of(self, model: str) -> tuple[str, str]:
        """'ollama:qwen3' -> ('ollama', 'qwen3'); OpenRouter ids keep their ':free' style suffixes."""
        head, sep, rest = model.partition(":")
        if sep and "/" not in head and head in self.cfg["providers"]:
            return head, rest
        return self.cfg["default_provider"], model

    def info(self, model: str) -> dict:
        prov, mid = self.provider_of(model)
        known = self._load().get(mid) if prov == "openrouter" else None
        info = dict(known) if known else {
            "context": 32000, "price_in": 0.0, "price_out": 0.0, "modalities": ["text"],
            "tools": prov != "openrouter", "name": mid,
        }
        over = (self.cfg.get("model_info") or {}).get(model) or (self.cfg.get("model_info") or {}).get(mid) or {}
        info.update({k: v for k, v in over.items() if k in ("context", "modalities", "tools", "price_in", "price_out")})
        info["id"], info["provider"], info["known"] = mid, prov, bool(known)
        info["tier"] = self.cfg["tiers"].get(model) or self.cfg["tiers"].get(mid) or self._tier(info, prov)
        return info

    @staticmethod
    def _tier(info: dict, prov: str) -> str:
        """Price is a decent proxy for capability when nothing better is configured."""
        if prov != "openrouter" or not info.get("price_in"):
            return "weak"
        if info["price_in"] >= 1.0:
            return "strong"
        if info["price_in"] <= 0.09:
            return "weak"
        return "standard"

    def search(self, text: str = "", limit: int = 60) -> list[dict]:
        out = []
        for mid, m in self._load().items():
            if text.lower() in mid.lower():
                out.append({"id": mid, **m})
        out.sort(key=lambda m: m["id"])
        return out[:limit]
