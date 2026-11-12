"""Multimodal input for ANY model.
1. If the working model accepts the modality, attach the file natively (one call, cheapest).
2. Otherwise a cheap perception model turns it into text.
3. If no model takes video, ffmpeg splits it into frames + audio and step 2 runs on the parts."""
from __future__ import annotations

import base64
import hashlib
import mimetypes
import shutil
import subprocess
import tempfile
from pathlib import Path

IMAGE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
AUDIO = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".opus", ".wma"}
VIDEO = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}

PERCEPTION_SYSTEM = ("You are a perception module for another AI agent that cannot see or hear this input. "
                     "Answer the question precisely. Transcribe visible text and speech verbatim, keep numbers exact, "
                     "note order and timing when relevant. No preamble.")


def kind_of(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in IMAGE:
        return "image"
    if ext in AUDIO:
        return "audio"
    if ext in VIDEO:
        return "video"
    if ext == ".pdf":
        return "file"
    return "text"


def _ffmpeg(args: list, timeout: int = 180) -> bool:
    exe = shutil.which("ffmpeg")
    if not exe:
        return False
    try:
        return subprocess.run([exe, "-y", "-loglevel", "error", *args], capture_output=True, timeout=timeout).returncode == 0
    except Exception:
        return False


def _b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def _tmp(suffix: str) -> Path:
    d = Path(tempfile.gettempdir()) / "hangar_media"
    d.mkdir(exist_ok=True)
    return Path(tempfile.mkstemp(suffix=suffix, dir=d)[1])


def part_for(path: Path, kind: str) -> dict:
    """Build an OpenAI/OpenRouter chat content part, shrinking big media with ffmpeg first."""
    path = Path(path)
    if kind == "image":
        src = path
        if path.stat().st_size > 1_500_000 or path.suffix.lower() == ".bmp":
            out = _tmp(".jpg")
            if _ffmpeg(["-i", str(path), "-vf", "scale='min(1568,iw)':-2", "-q:v", "4", str(out)]):
                src = out
        mime = mimetypes.guess_type(src.name)[0] or "image/png"
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{_b64(src)}"}}
    if kind == "audio":
        src, fmt = path, path.suffix.lower().lstrip(".")
        if fmt not in ("wav", "mp3") or path.stat().st_size > 4_000_000:
            out = _tmp(".mp3")
            if _ffmpeg(["-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", str(out)]):
                src, fmt = out, "mp3"
        return {"type": "input_audio", "input_audio": {"data": _b64(src), "format": fmt}}
    if kind == "video":
        src = path
        if path.stat().st_size > 8_000_000 or path.suffix.lower() != ".mp4":
            out = _tmp(".mp4")
            if _ffmpeg(["-i", str(path), "-vf", "scale=-2:480,fps=5", "-c:v", "libx264", "-crf", "32",
                        "-c:a", "aac", "-ac", "1", "-b:a", "32k", str(out)], timeout=600):
                src = out
        return {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{_b64(src)}"}}
    if kind == "file":
        return {"type": "file", "file": {"filename": path.name, "file_data": f"data:application/pdf;base64,{_b64(path)}"}}
    raise ValueError(f"unsupported media kind {kind}")


def supports(info: dict, kind: str) -> bool:
    if kind == "file":
        return info["provider"] == "openrouter"     # OpenRouter parses PDFs for any model
    return kind in (info.get("modalities") or [])


def _split_video(path: Path, frames: int = 6) -> tuple[list[Path], Path | None]:
    d = Path(tempfile.mkdtemp(prefix="hangar_vid_"))
    dur = 0.0
    probe = shutil.which("ffprobe")
    if probe:
        try:
            dur = float(subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                                       capture_output=True, text=True, timeout=30).stdout.strip() or 0)
        except Exception:
            dur = 0.0
    fps = frames / dur if dur > 0 else 1
    _ffmpeg(["-i", str(path), "-vf", f"fps={fps:.4f},scale='min(960,iw)':-2", "-frames:v", str(frames), str(d / "f%02d.jpg")])
    audio = d / "audio.mp3"
    ok = _ffmpeg(["-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", str(audio)])
    return sorted(d.glob("f*.jpg")), (audio if ok and audio.is_file() and audio.stat().st_size > 500 else None)


def describe(session, path: Path, question: str, prefer_model: str | None = None) -> str:
    """Turn a media file into text using whichever configured model can perceive it."""
    path = Path(path)
    if not path.is_file():
        return f"Error: file not found: {path}"
    kind = kind_of(path)
    if kind == "text":
        return "Error: not a media file; use the read tool."
    key = hashlib.sha1(f"{path.resolve()}|{path.stat().st_mtime_ns}|{question}".encode()).hexdigest()
    if key in session.perception_cache:
        return session.perception_cache[key]
    cands = []
    for m in (prefer_model, session.model, session.cfg["perception_model"]):
        if m and m not in cands:
            cands.append(m)

    def ask(model: str, parts: list, q: str) -> str:
        msgs = [{"role": "system", "content": PERCEPTION_SYSTEM},
                {"role": "user", "content": [{"type": "text", "text": q}, *parts]}]
        r = session.llm.chat(model, msgs, max_tokens=2000, agent="perception", reasoning="")
        session.add_usage(r, model, "perception")
        return r.content.strip()

    errors = []
    for m in cands:
        if supports(session.catalog.info(m), kind):
            try:
                out = ask(m, [part_for(path, kind)], question)
                if out:
                    session.perception_cache[key] = out
                    return out
            except Exception as e:
                errors.append(f"{m}: {e}")
    if kind == "video":                                  # decompose: frames + soundtrack
        frames, audio = _split_video(path)
        chunks = []
        img_model = next((m for m in cands if supports(session.catalog.info(m), "image")), None)
        aud_model = next((m for m in cands if supports(session.catalog.info(m), "audio")), None)
        try:
            if frames and img_model:
                chunks.append("FRAMES (evenly spaced, in order): " + ask(
                    img_model, [part_for(f, "image") for f in frames],
                    f"These are {len(frames)} frames sampled in order from a video. {question}"))
            if audio and aud_model:
                chunks.append("AUDIO TRACK: " + ask(aud_model, [part_for(audio, "audio")], f"This is the video's soundtrack. {question}"))
        except Exception as e:
            errors.append(str(e))
        if chunks:
            out = "\n".join(chunks)
            session.perception_cache[key] = out
            return out
    return (f"Error: no configured model can process {kind} input ({'; '.join(errors) or 'none supports it'}). "
            f"Set perception_model to a model with '{kind}' input, e.g. `hangar models omni`.")
