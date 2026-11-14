"""Machine probe: tell the agent what this computer can actually do (cores, RAM, GPU, CLIs).
Cached for a day so the system prompt stays byte-stable (prompt-cache friendly)."""
from __future__ import annotations

import ctypes
import json
import os
import platform
import shutil
import subprocess
import time
from pathlib import Path

from .config import HOME

CLIS = ["python", "node", "npm", "git", "ffmpeg", "docker", "rg", "uv", "ollama", "gh", "cargo", "go", "java", "dotnet", "pandoc", "tesseract", "whisper"]


def _ram_gb() -> float:
    try:
        if os.name == "nt":
            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong)] + \
                           [(n, ctypes.c_ulonglong) for n in ("total", "avail", "tpf", "apf", "tv", "av", "aev")]
            ms = MS()
            ms.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
            return round(ms.total / 2**30, 1)
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30, 1)
    except Exception:
        return 0.0


def _gpu() -> str:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return ""
    try:
        out = subprocess.run([exe, "--query-gpu=name,memory.total", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        return "; ".join(l.strip() for l in out.splitlines() if l.strip())
    except Exception:
        return ""


def find_bash() -> str | None:
    """Git Bash on Windows (never the WSL launcher); the system bash elsewhere."""
    if os.name != "nt":
        return shutil.which("bash") or "/bin/sh"
    cands = []
    git = shutil.which("git")
    if git:
        root = Path(git).resolve().parent.parent
        cands += [root / "bin" / "bash.exe", root.parent / "bin" / "bash.exe"]
    cands += [Path(r"C:\Program Files\Git\bin\bash.exe"), Path(r"C:\Program Files (x86)\Git\bin\bash.exe")]
    for c in cands:
        if c.is_file():
            return str(c)
    return None


def probe(refresh: bool = False) -> dict:
    cache = HOME / "machine.json"
    try:
        if not refresh and cache.is_file() and time.time() - cache.stat().st_mtime < 86400:
            return json.loads(cache.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    info = {
        "os": f"{platform.system()} {platform.release()}",
        "arch": platform.machine(),
        "cores": os.cpu_count() or 1,
        "ram_gb": _ram_gb(),
        "gpu": _gpu(),
        "python": platform.python_version(),
        "clis": [c for c in CLIS if shutil.which(c)],
        "bash": find_bash() or "",
    }
    try:
        HOME.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(info), encoding="utf-8")
    except OSError:
        pass
    return info


def shell(cfg: dict, info: dict) -> tuple[str, list[str]]:
    """Which shell runs commands here: its description for the prompt and its argv prefix."""
    bash = info.get("bash") if cfg["shell"] in ("auto", "bash") else ""
    if os.name != "nt":
        return "bash", [bash or "/bin/sh", "-c"]
    if bash:
        return "bash (Git Bash on Windows; POSIX syntax, forward slashes)", [bash, "-c"]
    return "Windows PowerShell 5.1 (no &&; use ;)", ["powershell", "-NoProfile", "-NonInteractive", "-Command"]


def describe(info: dict, shell_name: str) -> str:
    parts = [f"OS: {info['os']} ({info['arch']})", f"shell tool runs: {shell_name}",
             f"CPU cores: {info['cores']}"]
    if info.get("ram_gb"):
        parts.append(f"RAM: {info['ram_gb']} GB")
    parts.append(f"GPU: {info['gpu']}" if info.get("gpu") else "GPU: none detected")
    parts.append("CLIs on PATH: " + ", ".join(info.get("clis") or ["(none probed)"]))
    return "\n".join("- " + p for p in parts)
