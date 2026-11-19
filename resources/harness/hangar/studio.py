"""`hangar studio` — production commands the agent runs through its shell tool. They are commands, not tools,
on purpose: tool schemas are paid for on every model call, a command costs nothing until it is used.
(The matching how-to lives in the built-in skills, loaded on demand.)

    python -m hangar studio screenshot <page.html|url> <out.png> [--width 1440 --height 900 --full --at SECONDS --wait MS]
    python -m hangar studio check      <page.html|url>              # console errors + overflow, no image
    python -m hangar studio play       <page.html|url> <shots-dir> --do "wait 500; press Enter; hold ArrowRight 400; shot fight"
    python -m hangar studio video      <page.html> <out.mp4> --duration 12 [--fps 30 --width 1920 --height 1080]
    python -m hangar studio image      "<prompt>" <out.png> [--aspect 16:9 --model ... --ref image.png]
    python -m hangar studio pptx       <spec.json> <out.pptx>"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import config

IMAGE_MODEL = "google/gemini-3.1-flash-image"

LAYOUT_PROBE = """(() => {
  const de = document.documentElement, out = {scrollW: de.scrollWidth, clientW: de.clientWidth, scrollH: de.scrollHeight, clientH: de.clientHeight, clipped: []};
  for (const el of document.querySelectorAll('h1,h2,h3,p,span,div,td,th,li,button,text')) {
    if (!el.childElementCount && el.textContent.trim() && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible')
      out.clipped.push(el.textContent.trim().slice(0, 40));
    if (out.clipped.length >= 5) break;
  }
  out.images = [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.getAttribute('src')).slice(0, 5);
  out.text = document.body ? document.body.innerText.trim().length + document.querySelectorAll('canvas,svg,video,img').length : 0;
  return out;
})()"""


def _usage(kind: str, model: str, cost: float, detail: str) -> None:
    """Let the parent session account for money spent by a studio command."""
    d = os.environ.get("HANGAR_SESSION_DIR")
    if d and Path(d).is_dir():
        with open(Path(d) / "studio_usage.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": time.time(), "kind": kind, "model": model, "cost": cost, "detail": detail[:200]}) + "\n")


def _report(b, layout: dict) -> list[str]:
    notes = []
    errs = list(dict.fromkeys(b.errors))
    if errs:
        notes.append("CONSOLE ERRORS:\n  " + "\n  ".join(errs[:8]))
    if layout.get("scrollW", 0) > layout.get("clientW", 0) + 2:
        notes.append(f"HORIZONTAL OVERFLOW: content is {layout['scrollW']}px wide in a {layout['clientW']}px viewport")
    if layout.get("clipped"):
        notes.append("CLIPPED TEXT: " + " | ".join(layout["clipped"]))
    if layout.get("images"):
        notes.append("BROKEN IMAGES: " + ", ".join(str(i) for i in layout["images"]))
    if not layout.get("text"):
        notes.append("WARNING: the page shows no text and has no canvas, image or drawing at all")
    return notes


def cmd_screenshot(a) -> int:
    from .browser import SEEK, Browser, BrowserError
    try:
        with Browser(a.width, a.height) as b:
            b.goto(a.page, settle_ms=a.wait)
            if a.at is not None:
                b.eval(SEEK % float(a.at))
            layout = b.eval(LAYOUT_PROBE) or {}
            if getattr(a, "out", None):
                Path(a.out).parent.mkdir(parents=True, exist_ok=True)
                Path(a.out).write_bytes(b.screenshot(full_page=a.full))
                print(f"saved {a.out} ({a.width}x{layout.get('scrollH') if a.full else a.height})")
            notes = _report(b, layout)
    except BrowserError as e:
        print(f"error: {e}")
        return 1
    print("\n".join(notes) if notes else "page check: no console errors, no overflow, no clipped text")
    return 0


PLAY_HELP = """steps, separated by ';' or newlines (keys are DOM codes: ArrowLeft, KeyA, Digit7, Numpad7, Enter, Space, Escape):
  wait MS            let the page run
  press KEY [MS]     key down, MS later (default 70) key up
  hold KEY MS        the same, for holding a direction
  down KEY / up KEY  for chords and sequences: down ArrowDown; press KeyJ; up ArrowDown
  seq K1 K2 ... [MS] press the keys one after another, MS apart (default 60): motion inputs
  click X Y          mouse click at viewport pixels
  shot NAME          save <shots-dir>/NAME.png and say what it shows (blank? same as the last shot?)
  eval JS            print the value of a JavaScript expression (game state, a counter)
  expect JS          like eval, but a falsy value fails the run"""


def _steps(text: str) -> list[list[str]]:
    out = []
    for raw in text.replace("\n", ";").split(";"):
        raw = raw.strip()
        if raw and not raw.startswith("#"):
            head, _, rest = raw.partition(" ")
            out.append([head.lower(), rest.strip()])
    return out


def cmd_play(a) -> int:
    """Drive a page like a person would and report what a model cannot see for itself: errors, a blank or frozen screen."""
    from .browser import Browser, BrowserError, differ, keycode, look
    text = a.do or ""
    if a.script:
        text = Path(a.script).read_text(encoding="utf-8")
    steps = _steps(text)
    if not steps:
        print("error: nothing to do. Give --do \"...\" or --script FILE.\n" + PLAY_HELP)
        return 2
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    failed, shots, last, problems = 0, 0, None, []
    try:
        with Browser(a.width, a.height) as b:
            b.goto(a.page, settle_ms=a.wait)
            for n, (op, arg) in enumerate(steps, 1):
                parts = arg.split()
                try:
                    if op == "wait":
                        b.settle(int(parts[0]))
                    elif op in ("press", "hold"):
                        code = keycode(parts[0])
                        b.key(code, True)
                        b.settle(int(parts[1]) if len(parts) > 1 else 70)
                        b.key(code, False)
                        b.settle(30)
                    elif op in ("down", "up"):
                        b.key(keycode(parts[0]), op == "down")
                        b.settle(30)
                    elif op == "seq":
                        gap = int(parts.pop()) if parts and parts[-1].isdigit() and len(parts[-1]) > 1 else 60
                        for k in parts:
                            b.key(keycode(k), True)
                            b.settle(gap)
                            b.key(keycode(k), False)
                    elif op == "click":
                        b.click(float(parts[0]), float(parts[1]))
                        b.settle(60)
                    elif op == "shot":
                        name = (parts[0] if parts else f"shot{shots + 1}").replace(".png", "")
                        (out / f"{name}.png").write_bytes(b.screenshot())
                        shots += 1
                        _, _, rgb = b.thumbnail()
                        seen, note = look(rgb), ""
                        if seen["flat"] > 0.995 or seen["colours"] < 3:
                            note = "  <-- BLANK: almost one flat colour, nothing is being drawn"
                            problems.append(f"{name}: blank screen")
                        elif last is not None and differ(last[1], rgb) < 0.004:
                            note = f"  <-- IDENTICAL to '{last[0]}': the steps in between changed nothing on screen"
                            problems.append(f"{name}: same picture as {last[0]}")
                        last = (name, rgb)
                        print(f"[{n}] shot {out / (name + '.png')}  ({seen['colours']} colours, {seen['flat']:.0%} one colour){note}")
                    elif op in ("eval", "expect"):
                        v = b.eval(arg)
                        shown = json.dumps(v, ensure_ascii=False, default=str)[:600]
                        if op == "expect" and not v:
                            failed += 1
                            problems.append(f"expect failed: {arg[:80]}")
                            print(f"[{n}] EXPECT FAILED: {arg}  ->  {shown}")
                        else:
                            print(f"[{n}] {op} {arg[:90]}  ->  {shown}")
                    else:
                        print(f"error: unknown step '{op}'.\n" + PLAY_HELP)
                        return 2
                except (IndexError, ValueError):
                    print(f"error: bad step {n}: '{op} {arg}'.\n" + PLAY_HELP)
                    return 2
                except BrowserError as e:
                    failed += 1
                    problems.append(f"step {n} ({op}): {e}")
                    print(f"[{n}] ERROR in '{op} {arg[:80]}': {e}")
            errs = list(dict.fromkeys(b.errors))
    except BrowserError as e:
        print(f"error: {e}")
        return 1
    if errs:
        print("CONSOLE ERRORS:\n  " + "\n  ".join(errs[:10]))
    if problems:
        print("PROBLEMS:\n  " + "\n  ".join(problems[:12]))
    if not errs and not problems:
        print(f"play: {len(steps)} steps, {shots} shots, no console errors, no blank or frozen shot. "
              "Now LOOK at the shots (perceive) before you call it working: this only proves that something is drawn and moves.")
    return 1 if errs or failed or problems else 0


def cmd_video(a) -> int:
    from .browser import BrowserError, render_video
    try:
        r = render_video(a.page, a.out, a.duration, a.fps, a.width, a.height,
                         progress=lambda i, n: print(f"  frame {i}/{n}", flush=True))
    except BrowserError as e:
        print(f"error: {e}")
        return 1
    size = Path(a.out).stat().st_size
    print(f"saved {a.out}: {r['frames']} frames at {r['fps']} fps = {a.duration}s, {a.width}x{a.height}, {size / 1e6:.1f} MB, rendered in {r['seconds']}s")
    if r["console_errors"]:
        print("CONSOLE ERRORS:\n  " + "\n  ".join(r["console_errors"][:8]))
    if size < 40_000 * a.duration / 10:
        print("WARNING: the file is very small — the frames may be nearly identical (is the animation actually driven by hangarFrame(t)?)")
    return 0


def cmd_image(a) -> int:
    cfg = config.load()
    prov = cfg["providers"]["openrouter"]
    key = os.environ.get(prov["api_key_env"], "")
    if not key:
        print(f"error: {prov['api_key_env']} is not set")
        return 1
    model = a.model or cfg.get("image_model") or IMAGE_MODEL
    content: list = [{"type": "text", "text": a.prompt}]
    for ref in a.ref or []:
        p = Path(ref)
        mime = "image/jpeg" if p.suffix.lower() in (".jpg", ".jpeg") else "image/png"
        content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()}})
    body = {"model": model, "messages": [{"role": "user", "content": content}], "modalities": ["image", "text"],
            "image_config": {"aspect_ratio": a.aspect}, "usage": {"include": True}}
    req = urllib.request.Request(prov["base_url"].rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}", "X-Title": "Hangar Harness"})
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"error: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:400]}")
        return 1
    except OSError as e:
        print(f"error: {e}")
        return 1
    msg = (data.get("choices") or [{}])[0].get("message", {})
    images = msg.get("images") or []
    if not images:
        print(f"error: the model returned no image. It said: {str(msg.get('content'))[:300]}")
        return 1
    url = images[0].get("image_url", {}).get("url", "")
    raw = base64.b64decode(url.split(",", 1)[1]) if url.startswith("data:") else urllib.request.urlopen(url, timeout=120).read()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    native = ".jpg" if raw[:2] == b"\xff\xd8" else ".png"
    if out.suffix.lower() in (".jpg", ".jpeg", ".png") and (out.suffix.lower() in (".jpg", ".jpeg")) != (native == ".jpg") and shutil.which("ffmpeg"):
        tmp = out.with_name(out.stem + "_src" + native)       # the model picked the other format: convert so the extension tells the truth
        tmp.write_bytes(raw)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(tmp), str(out)], capture_output=True)
        tmp.unlink(missing_ok=True)
    else:
        out.write_bytes(raw)
    cost = float((data.get("usage") or {}).get("cost") or 0)
    _usage("image", model, cost, a.prompt)
    print(f"saved {out} ({out.stat().st_size // 1024} KB) with {model}, cost ${cost:.4f}")
    return 0


def cmd_pptx(a) -> int:
    from . import pptx
    spec_path = Path(a.spec)
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
        r = pptx.build(spec, Path(a.out), base=spec_path.resolve().parent)
    except (ValueError, OSError, KeyError) as e:
        print(f"error: {type(e).__name__}: {e}")
        return 1
    print(f"saved {r['path']}: {r['slides']} slides, {r['images']} images (native editable text, 16:9)")
    return 0


def cmd_report(a) -> int:
    from . import report
    try:
        if a.action == "build":
            spec_path = Path(a.src)
            r = report.build(json.loads(spec_path.read_text(encoding="utf-8-sig")), Path(a.out), base=spec_path.resolve().parent)
            print(f"saved {r['path']}: {r['sections']} sections, {r['tables']} tables, {r['charts']} charts, {r['bytes'] // 1024} KB")
            return 0
        page = Path(a.src).read_text(encoding="utf-8", errors="replace")
        have, gaps = report.check(page, report.columns(Path(a.data)) if a.data else None, a.target or "")
    except (ValueError, OSError, KeyError, TypeError) as e:
        print(f"error: {type(e).__name__}: {e}")
        return 1
    print(", ".join(f"{v} {k}" for k, v in have.items()))
    if gaps:
        print("GAPS (fix every one, then check again):\n- " + "\n- ".join(gaps))
        return 1
    print("ok: the report meets the depth minimum")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(prog="hangar studio", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def page(p, out=True):
        p.add_argument("page")
        if out:
            p.add_argument("out")
        p.add_argument("--width", type=int, default=1440)
        p.add_argument("--height", type=int, default=900)
        p.add_argument("--wait", type=int, default=700, help="ms to let the page settle after load")
        p.add_argument("--at", type=float, help="seek animations to this time (seconds) first")
        p.add_argument("--full", action="store_true", help="capture the whole scrollable page")

    s = sub.add_parser("screenshot")
    page(s)
    s.set_defaults(fn=cmd_screenshot)
    c = sub.add_parser("check")
    page(c, out=False)
    c.set_defaults(fn=cmd_screenshot)
    pl = sub.add_parser("play", help="drive a page with keys and clicks, save screenshots, report errors and dead screens",
                        epilog=PLAY_HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    pl.add_argument("page")
    pl.add_argument("out", help="folder for the screenshots")
    pl.add_argument("--do", help="the steps, inline")
    pl.add_argument("--script", help="the steps, in a file")
    pl.add_argument("--width", type=int, default=1280)
    pl.add_argument("--height", type=int, default=720)
    pl.add_argument("--wait", type=int, default=700, help="ms to let the page settle after load")
    pl.set_defaults(fn=cmd_play)
    v = sub.add_parser("video")
    v.add_argument("page")
    v.add_argument("out")
    v.add_argument("--duration", type=float, required=True)
    v.add_argument("--fps", type=int, default=30)
    v.add_argument("--width", type=int, default=1920)
    v.add_argument("--height", type=int, default=1080)
    v.set_defaults(fn=cmd_video)
    i = sub.add_parser("image")
    i.add_argument("prompt")
    i.add_argument("out")
    i.add_argument("--aspect", default="16:9")
    i.add_argument("--model")
    i.add_argument("--ref", action="append", help="reference image (repeatable)")
    i.set_defaults(fn=cmd_image)
    p = sub.add_parser("pptx")
    p.add_argument("spec")
    p.add_argument("out")
    p.set_defaults(fn=cmd_pptx)
    r = sub.add_parser("report", help="build an analysis report from a JSON spec, or check what a report lacks")
    r.add_argument("action", choices=("build", "check"))
    r.add_argument("src", help="build: the spec .json; check: the report .html")
    r.add_argument("out", nargs="?", help="build: the .html to write")
    r.add_argument("--data", help="check: the raw data file; every column must be covered")
    r.add_argument("--target", help="check: the column being predicted; turns on the modelling checks")
    r.set_defaults(fn=cmd_report)
    a = ap.parse_args(argv)
    if a.cmd == "report" and a.action == "build" and not a.out:
        ap.error("report build needs the output file")
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
