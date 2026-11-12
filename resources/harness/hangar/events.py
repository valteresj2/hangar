"""Append-only JSONL event log. Everything the harness does goes through here:
the console printer, the live dashboard and post-hoc analysis all read the same stream."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path


class EventBus:
    def __init__(self, session_dir: Path):
        self.dir = Path(session_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._f = open(self.dir / "events.jsonl", "a", encoding="utf-8")
        self._lock = threading.RLock()
        self._seq = 0
        self._subs: list = []
        self._dbuf: dict = {}      # (agent, kind) -> [text]
        self._dlast = 0.0

    def subscribe(self, fn) -> None:
        self._subs.append(fn)

    def emit(self, type: str, **data) -> dict:
        with self._lock:
            if type != "delta":
                self._flush_deltas()
            self._seq += 1
            rec = {"seq": self._seq, "t": round(time.time(), 3), "type": type, **data}
            self._f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
            self._f.flush()
        for fn in self._subs:
            try:
                fn(rec)
            except Exception:
                pass
        return rec

    def delta(self, text: str, kind: str = "text", agent: str = "main") -> None:
        """Streamed tokens are coalesced (~150 ms) so the log stays small."""
        if not text:
            return
        with self._lock:
            self._dbuf.setdefault((agent, kind), []).append(text)
            if time.time() - self._dlast > 0.15:
                self._flush_deltas()

    def _flush_deltas(self) -> None:
        buf, self._dbuf = self._dbuf, {}
        self._dlast = time.time()
        for (agent, kind), parts in buf.items():
            self.emit("delta", text="".join(parts), kind=kind, agent=agent)

    def close(self) -> None:
        with self._lock:
            self._flush_deltas()
            try:
                self._f.close()
            except OSError:
                pass
