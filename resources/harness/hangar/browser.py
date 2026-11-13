"""Headless Chrome/Edge driven over the DevTools protocol with nothing but the standard library
(a ~60-line WebSocket client is enough). Used for screenshots, page checks and frame-accurate video capture."""
from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


class BrowserError(Exception):
    pass


def find_browser() -> str | None:
    env = os.environ.get("HANGAR_BROWSER")
    if env and Path(env).is_file():
        return env
    cands = []
    if os.name == "nt":
        for base in (os.environ.get("PROGRAMFILES", r"C:\Program Files"), os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
                     os.environ.get("LOCALAPPDATA", "")):
            cands += [Path(base) / "Google/Chrome/Application/chrome.exe", Path(base) / "Microsoft/Edge/Application/msedge.exe"]
    else:
        cands += [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")]
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"):
            w = shutil.which(name)
            if w:
                cands.append(Path(w))
    return next((str(c) for c in cands if c.is_file()), None)


class _WS:
    """Minimal RFC 6455 client: text frames, masking, fragmentation, ping/pong. Enough for DevTools."""

    def __init__(self, url: str, timeout: float = 30):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        self.f = self.sock.makefile("rb")
        status = self.f.readline()
        if b"101" not in status:
            raise BrowserError(f"websocket handshake failed: {status!r}")
        while self.f.readline() not in (b"\r\n", b""):
            pass

    def send(self, text: str) -> None:
        data = text.encode("utf-8")
        n, mask = len(data), os.urandom(4)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536
                                else bytes([0x80 | 127]) + struct.pack(">Q", n))
        key = (mask * (n // 4 + 1))[:n]
        masked = (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big") if n else b""
        self.sock.sendall(head + mask + masked)

    def _read(self, n: int) -> bytes:
        buf = self.f.read(n)
        if buf is None or len(buf) < n:
            raise BrowserError("browser connection closed")
        return buf

    def recv(self) -> str:
        chunks = []
        while True:
            b0, b1 = self._read(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n) if n else b""
            if op == 0x9:                                   # ping -> pong
                self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                continue
            if op == 0x8:
                raise BrowserError("browser closed the connection")
            if op in (0x0, 0x1, 0x2):
                chunks.append(payload)
                if b0 & 0x80:
                    return b"".join(chunks).decode("utf-8", "replace")

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class Browser:
    def __init__(self, width: int = 1440, height: int = 900, scale: float = 1.0, extra_args: list[str] | None = None):
        exe = find_browser()
        if not exe:
            raise BrowserError("no Chrome/Edge/Chromium found (set HANGAR_BROWSER to the executable)")
        self.width, self.height = width, height
        self.profile = tempfile.mkdtemp(prefix="hangar_browser_")
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.proc = subprocess.Popen(
            [exe, "--headless=new", f"--remote-debugging-port={self.port}", f"--user-data-dir={self.profile}", "--remote-allow-origins=*",
             "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", f"--window-size={width},{height}",
             "--force-device-scale-factor=1", "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
             "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--disable-background-timer-throttling",
             "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", *(extra_args or []), "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        target = None
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/list", timeout=2) as r:
                    target = next((t for t in json.loads(r.read()) if t.get("type") == "page"), None)
                if target:
                    break
            except OSError:
                pass
            time.sleep(0.1)
        if not target:
            self.close()
            raise BrowserError("browser did not start")
        self.ws = _WS(target["webSocketDebuggerUrl"])
        self._id, self.events, self.errors = 0, [], []
        for m in ("Page.enable", "Runtime.enable", "Log.enable"):
            self.cmd(m)
        self.cmd("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": scale, "mobile": False})

    # ------------------------------------------------------------- protocol
    def _note(self, msg: dict) -> None:
        m, p = msg.get("method"), msg.get("params", {})
        if m == "Runtime.exceptionThrown":
            d = p.get("exceptionDetails", {})
            self.errors.append((d.get("exception", {}).get("description") or d.get("text") or "exception").splitlines()[0][:300])
        elif m == "Runtime.consoleAPICalled" and p.get("type") == "error":
            self.errors.append(" ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))[:300])
        elif m == "Log.entryAdded" and p.get("entry", {}).get("level") == "error":
            e = p["entry"]
            self.errors.append(f"{e.get('text', '')} {e.get('url', '')}"[:300])
        self.events.append(m)

    def cmd(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        self._id += 1
        rid = self._id
        self.ws.send(json.dumps({"id": rid, "method": method, "params": params or {}}))
        self.ws.sock.settimeout(timeout)
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == rid:
                if "error" in msg:
                    raise BrowserError(f"{method}: {msg['error'].get('message')}")
                return msg.get("result", {})
            self._note(msg)

    def wait_event(self, name: str, timeout: float = 30) -> bool:
        if name in self.events:
            return True
        self.ws.sock.settimeout(timeout)
        end = time.time() + timeout
        try:
            while time.time() < end:
                msg = json.loads(self.ws.recv())
                self._note(msg)
                if msg.get("method") == name:
                    return True
        except (TimeoutError, socket.timeout):
            pass
        return False

    # ----------------------------------------------------------------- page
    def goto(self, target: str, settle_ms: int = 600, timeout: float = 45) -> None:
        url = target if "://" in target else Path(target).resolve().as_uri()
        self.events.clear()
        self.cmd("Page.navigate", {"url": url})
        self.wait_event("Page.loadEventFired", timeout)
        try:                                                  # web fonts change layout: wait for them
            self.eval("document.fonts ? document.fonts.ready.then(() => 1) : 1", timeout=15)
        except BrowserError:
            pass
        self.settle(settle_ms)

    def settle(self, ms: int) -> None:
        self.eval(f"new Promise(r => setTimeout(r, {int(ms)}))", timeout=ms / 1000 + 20)

    def eval(self, expr: str, timeout: float = 60):
        r = self.cmd("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, timeout=timeout)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise BrowserError((d.get("exception", {}).get("description") or d.get("text") or "script error").splitlines()[0][:300])
        return r.get("result", {}).get("value")

    def screenshot(self, fmt: str = "png", quality: int = 92, full_page: bool = False) -> bytes:
        params: dict = {"format": fmt, "captureBeyondViewport": bool(full_page)}
        if fmt == "jpeg":
            params["quality"] = quality
        if full_page:
            size = self.cmd("Page.getLayoutMetrics").get("cssContentSize") or {}
            params["clip"] = {"x": 0, "y": 0, "width": max(self.width, int(size.get("width", self.width))),
                              "height": min(20000, max(self.height, int(size.get("height", self.height)))), "scale": 1}
        return base64.b64decode(self.cmd("Page.captureScreenshot", params)["data"])

    def close(self) -> None:
        try:
            self.cmd("Browser.close", timeout=5)
        except Exception:
            pass
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()                              # our own child, by handle — never by name
            except OSError:
                pass
        shutil.rmtree(self.profile, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


# deterministic time: the page may define window.hangarFrame(t); CSS/WAAPI animations are seeked for free
SEEK = """(async (t) => {
  for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = t * 1000; } catch (e) {} }
  for (const v of document.querySelectorAll('video')) { try { v.pause(); v.currentTime = t; } catch (e) {} }
  if (typeof window.hangarFrame === 'function') await window.hangarFrame(t);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return 1;
})(%s)"""


def render_video(html: str, out: str, duration: float, fps: int = 30, width: int = 1920, height: int = 1080, crf: int = 18,
                 progress=None) -> dict:
    """Frame-accurate capture: seek the page to each timestamp, screenshot, pipe to ffmpeg. Slow machines do not drop frames."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise BrowserError("ffmpeg not found on PATH (needed to encode the video)")
    frames = max(1, int(round(duration * fps)))
    with Browser(width, height) as b:
        b.goto(html, settle_ms=800)
        has_fn = b.eval("typeof window.hangarFrame === 'function'")
        anims = b.eval("document.getAnimations().length")
        if not has_fn and not anims:
            raise BrowserError("the page has no window.hangarFrame(t) and no CSS/WAAPI animations: nothing to seek, the video would be a still image")
        enc = subprocess.Popen([ffmpeg, "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
                                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf), "-movflags", "+faststart",
                                "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", str(out)], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        t0 = time.time()
        try:
            for i in range(frames):
                b.eval(SEEK % (i / fps), timeout=60)
                enc.stdin.write(b.screenshot("jpeg", 93))
                if progress and i % max(1, frames // 10) == 0:
                    progress(i, frames)
            enc.stdin.close()
            err = enc.stderr.read().decode("utf-8", "replace")
            if enc.wait(timeout=300) != 0:
                raise BrowserError("ffmpeg failed: " + err[-400:])
        finally:
            if enc.poll() is None:
                enc.kill()
        errors = list(dict.fromkeys(b.errors))
    return {"frames": frames, "fps": fps, "seconds": round(time.time() - t0, 1), "console_errors": errors, "hangarFrame": bool(has_fn)}
