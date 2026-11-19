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
import zlib
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
        if "://" in target:
            url = target
        else:                                                 # a local page may carry ?scene=fight or #section: keep it out of the path
            cut = min((i for i in (target.find("?"), target.find("#")) if i >= 0), default=len(target))
            if not Path(target[:cut]).is_file():
                raise BrowserError(f"page not found: {target[:cut]}")
            url = Path(target[:cut]).resolve().as_uri() + target[cut:]
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

    # ---------------------------------------------------------------- input
    def key(self, code: str, down: bool = True) -> None:
        """Press or release one key, named by its DOM `code` (ArrowLeft, KeyA, Digit7, Numpad7, Enter, Space, F3...)."""
        key, vk, text = keyinfo(code)
        p = {"type": "keyDown" if down else "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
        if code.startswith("Numpad"):
            p["location"] = 3
        if down and text:
            p["text"] = text
        self.cmd("Input.dispatchKeyEvent", p)

    def click(self, x: float, y: float) -> None:
        for kind in ("mousePressed", "mouseReleased"):
            self.cmd("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})

    def thumbnail(self, width: int = 160) -> tuple[int, int, bytes]:
        """The viewport shrunk to `width` pixels across, as raw RGB: small enough to compare and count colours in pure Python."""
        scale = width / self.width
        png = base64.b64decode(self.cmd("Page.captureScreenshot", {"format": "png", "clip": {
            "x": 0, "y": 0, "width": self.width, "height": self.height, "scale": scale}})["data"])
        return png_rgb(png)

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


_KEYS = {"Enter": ("Enter", 13, "\r"), "Space": (" ", 32, " "), "Escape": ("Escape", 27, ""), "Tab": ("Tab", 9, ""),
         "Backspace": ("Backspace", 8, ""), "ArrowLeft": ("ArrowLeft", 37, ""), "ArrowUp": ("ArrowUp", 38, ""),
         "ArrowRight": ("ArrowRight", 39, ""), "ArrowDown": ("ArrowDown", 40, ""), "ShiftLeft": ("Shift", 16, ""),
         "ShiftRight": ("Shift", 16, ""), "ControlLeft": ("Control", 17, ""), "ControlRight": ("Control", 17, ""),
         "AltLeft": ("Alt", 18, ""), "NumpadEnter": ("Enter", 13, "\r")}
_ALIAS = {"Return": "Enter", "Esc": "Escape", "Left": "ArrowLeft", "Right": "ArrowRight", "Up": "ArrowUp", "Down": "ArrowDown",
          "Shift": "ShiftLeft", "Control": "ControlLeft", "Ctrl": "ControlLeft", " ": "Space"}


def keycode(name: str) -> str:
    """Accept what people type (`a`, `7`, `left`, `enter`) and return the DOM code (`KeyA`, `Digit7`, `ArrowLeft`, `Enter`)."""
    name = _ALIAS.get(name[:1].upper() + name[1:], name)
    if len(name) == 1 and name.isalpha():
        return "Key" + name.upper()
    if len(name) == 1 and name.isdigit():
        return "Digit" + name
    for known in list(_KEYS) + ["Numpad", "Digit", "Key", "F"]:
        if name.lower() == known.lower():
            return known
        if known in ("Numpad", "Digit", "Key", "F") and name.lower().startswith(known.lower()) and len(name) > len(known):
            return known + name[len(known):].upper()
    return name


def keyinfo(code: str) -> tuple[str, int, str]:
    """(key, Windows virtual key code, text typed) for a DOM code."""
    if code in _KEYS:
        return _KEYS[code]
    if code.startswith("Key") and len(code) == 4:
        return code[3].lower(), ord(code[3]), code[3].lower()
    if code.startswith("Digit") and len(code) == 6:
        return code[5], ord(code[5]), code[5]
    if code.startswith("Numpad") and code[6:].isdigit():
        return code[6:], 96 + int(code[6:]), code[6:]
    if code.startswith("F") and code[1:].isdigit():
        return code, 111 + int(code[1:]), ""
    raise BrowserError(f"unknown key '{code}' (use DOM codes: ArrowLeft, KeyA, Digit7, Numpad7, Enter, Space, Escape, F3)")


def png_rgb(png: bytes) -> tuple[int, int, bytes]:
    """Decode an 8-bit RGB/RGBA PNG (what Chrome writes) into raw RGB. Meant for thumbnails: pure Python, a few ms each."""
    pos, w, h, ctype, data = 8, 0, 0, 6, b""
    while pos < len(png):
        n, kind = struct.unpack(">I4s", png[pos:pos + 8])
        body = png[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, _, ctype = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            data += body
        pos += 12 + n
    bpp = 4 if ctype == 6 else 3
    raw, stride = zlib.decompress(data), w * bpp
    prev, out = bytearray(stride), bytearray()
    for y in range(h):
        f = raw[y * (stride + 1)]
        row = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = row[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                row[i] = (row[i] + a) & 255
            elif f == 2:
                row[i] = (row[i] + b) & 255
            elif f == 3:
                row[i] = (row[i] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                row[i] = (row[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = row
        out += row if bpp == 3 else bytes(v for i, v in enumerate(row) if i % 4 != 3)
    return w, h, bytes(out)


def look(rgb: bytes) -> dict:
    """What a thumbnail says without a model: how many distinct colours, and how much of it is the commonest one."""
    counts: dict = {}
    for i in range(0, len(rgb), 3):
        k = (rgb[i] >> 4, rgb[i + 1] >> 4, rgb[i + 2] >> 4)
        counts[k] = counts.get(k, 0) + 1
    total = max(1, len(rgb) // 3)
    return {"colours": len(counts), "flat": max(counts.values(), default=0) / total}


def differ(a: bytes, b: bytes) -> float:
    """Share of pixels that changed visibly between two thumbnails of the same size."""
    if len(a) != len(b) or not a:
        return 1.0
    n = sum(1 for i in range(0, len(a), 3) if abs(a[i] - b[i]) + abs(a[i + 1] - b[i + 1]) + abs(a[i + 2] - b[i + 2]) > 36)
    return n / (len(a) // 3)


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
