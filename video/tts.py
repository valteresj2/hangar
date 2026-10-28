"""Narration for the product video, straight from OpenRouter (Python, standard library only).

One clip per scene of script.json through POST https://openrouter.ai/api/v1/audio/speech with the Gemini TTS model and
voice set there (google/gemini-3.8-flash-lite-tts, Orus). Gemini answers raw PCM (24 kHz, 16-bit, mono); each clip is
saved as video/narration/<scene>.wav, which render.cjs picks up.

    python video/tts.py                 # asks for the OpenRouter key (hidden input) if OPENROUTER_API_KEY is not set
    python video/tts.py --only logo,close
    python video/tts.py --voice Orus --model google/gemini-3.8-flash-lite-tts

The key is only sent to openrouter.ai in the Authorization header; it is never printed or written to disk.
"""

import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.request
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENDPOINT = "https://openrouter.ai/api/v1/audio/speech"
SAMPLE_RATE = 24_000


def speak(key: str, model: str, voice: str, text: str, instructions: str) -> bytes:
    body = json.dumps(
        {"model": model, "voice": voice, "input": text, "instructions": instructions, "response_format": "pcm"}
    ).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "X-Title": "Agent Hangar Desktop video",
        },
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def save_wav(path: Path, audio: bytes) -> float:
    """Writes the clip (a WAV as received, or raw PCM wrapped in a WAV header) and returns its length in seconds."""
    if audio[:4] == b"RIFF":
        path.write_bytes(audio)
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / w.getframerate()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(audio)
    return len(audio) / 2 / SAMPLE_RATE


def main() -> int:
    script = json.loads((HERE / "script.json").read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description="Narração do vídeo pelo OpenRouter (Gemini TTS).")
    parser.add_argument("--only", help="cenas separadas por vírgula (padrão: todas)")
    parser.add_argument("--voice", default=script["voice"])
    parser.add_argument("--model", default=script["model"])
    args = parser.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY") or getpass.getpass("Chave do OpenRouter (não aparece ao digitar): ")
    key = key.strip()
    if not key:
        print("Nenhuma chave informada.", file=sys.stderr)
        return 1

    only = set(args.only.split(",")) if args.only else None
    out = HERE / "narration"
    out.mkdir(exist_ok=True)
    total = 0.0
    for scene in script["scenes"]:
        if only and scene["id"] not in only:
            continue
        try:
            audio = speak(key, args.model, args.voice, scene["narration"], script.get("instructions", ""))
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:300]
            print(f"{scene['id']}: HTTP {err.code} {detail}", file=sys.stderr)
            return 1
        seconds = save_wav(out / f"{scene['id']}.wav", audio)
        total += seconds
        print(f"{scene['id']}: {seconds:.1f} s")
    print(f"narração: {total:.1f} s em {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
