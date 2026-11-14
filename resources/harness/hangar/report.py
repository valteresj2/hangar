"""Analysis reports: a JSON spec becomes one self-contained HTML file, and a deterministic check says what a report lacks.
The model spends its tokens on the analysis; markup, styling and chart drawing cost it nothing.

Spec: {"title", "subtitle", "summary": [str], "sections": [{"title", "blocks": [block]}], "footer", "locale": "pt-BR"|"en"}
Blocks:
  {"type": "text", "text": "paragraphs split by blank lines; **bold** and `code` are honoured"}
  {"type": "finding", "text": "the claim with its number", "evidence": "compared to what, sample size"}
  {"type": "kpis", "items": [{"label", "value", "note"}]}
  {"type": "table", "title", "columns": [str], "rows": [[...]], "note", "decimals": 2}
  {"type": "bar", "title", "labels": [str], "values": [num], "unit": "%", "note"}
  {"type": "line", "title", "labels": [str], "series": [{"name", "values": [num]}], "unit", "note"}
  {"type": "image", "path": "charts/roc.png", "caption"}          # embedded as base64: the report never depends on files
"""
from __future__ import annotations

import base64
import csv
import html
import mimetypes
import re
from pathlib import Path

CSS = """
:root{--bg:#f6f7f9;--surface:#fff;--line:#e3e6ec;--fg:#1c2330;--muted:#5f6b7c;--accent:#2f5bea;--soft:#eef2fe}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 Inter,"Segoe UI",system-ui,sans-serif}
main{overflow-wrap:anywhere;max-width:1080px;margin:0 auto;padding:40px 24px 80px}h1{font-size:32px;line-height:1.2;margin:0 0 8px}
.sub{color:var(--muted);margin:0 0 24px}h2{font-size:23px;margin:48px 0 16px;padding-top:16px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:24px 0 8px}p{margin:0 0 14px}code{background:var(--soft);padding:1px 5px;border-radius:4px;font-size:.92em}
nav{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 20px;margin:24px 0}
nav a{color:var(--accent);text-decoration:none;margin-right:18px;white-space:nowrap;font-size:14px}
.summary{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:12px;padding:18px 24px}
.summary li{margin:6px 0}.finding{background:var(--soft);border-radius:10px;padding:12px 16px;margin:0 0 14px}
.finding small{display:block;color:var(--muted);margin-top:4px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 18px}
.kpi{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.kpi b{display:block;font-size:26px;line-height:1.2}
.kpi span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.kpi small{color:var(--muted)}
figure{margin:0 0 22px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;overflow-x:auto}
figcaption{color:var(--muted);font-size:13px;margin-top:8px}figure img,figure svg{max-width:100%;height:auto;display:block}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}td.n,th.n{text-align:right}
tr:last-child td{border-bottom:0}footer{color:var(--muted);font-size:13px;margin-top:48px;border-top:1px solid var(--line);padding-top:16px}
svg text{font:12px Inter,"Segoe UI",system-ui,sans-serif;fill:var(--fg)}svg .m{fill:var(--muted)}
@media print{body{background:#fff}figure,nav,.summary{break-inside:avoid}}
"""


def _num(v, locale: str, decimals: int = 2) -> str:
    """A number the way the reader writes it; anything else untouched."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return "" if v is None else str(v)
    s = f"{v:,}" if isinstance(v, int) else f"{v:,.{decimals}f}"
    return s.replace(",", "\0").replace(".", ",").replace("\0", ".") if locale.lower().startswith("pt") else s


def _inline(text: str) -> str:
    t = html.escape(str(text))
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    return re.sub(r"`(.+?)`", r"<code>\1</code>", t)


def _figure(body: str, title: str = "", note: str = "") -> str:
    head = "<h3>" + _inline(title) + "</h3>" if title else ""
    foot = "<figcaption>" + _inline(note) + "</figcaption>" if note else ""
    return f"<figure>{head}{body}{foot}</figure>"


def _table(b: dict, locale: str) -> str:
    cols, rows, dec = b.get("columns") or [], b.get("rows") or [], int(b.get("decimals", 2))
    numeric = [all(isinstance(r[i], (int, float)) and not isinstance(r[i], bool) for r in rows if i < len(r) and r[i] is not None) and bool(rows)
               for i in range(len(cols))]
    head = "".join(f"<th{' class=n' if numeric[i] else ''}>{html.escape(str(c))}</th>" for i, c in enumerate(cols))
    body = "".join("<tr>" + "".join(f"<td{' class=n' if i < len(numeric) and numeric[i] else ''}>{html.escape(_num(v, locale, dec))}</td>"
                                    for i, v in enumerate(r)) + "</tr>" for r in rows)
    return _figure(f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>", b.get("title", ""), b.get("note", ""))


def _bar(b: dict, locale: str) -> str:
    labels, values, unit = [str(x) for x in b.get("labels") or []], [float(v or 0) for v in b.get("values") or []], str(b.get("unit", ""))
    n = min(len(labels), len(values))
    if not n:
        raise ValueError("bar block needs labels and values")
    left = min(260, 14 + 7 * max(len(x) for x in labels[:n]))
    width, row = 760, 26
    lo, hi = min(0.0, min(values[:n])), max(0.0, max(values[:n])) or 1.0
    span, room = hi - lo, width - left - 90
    zero = left + room * (0 - lo) / span                                   # bars start at zero, negatives grow to the left
    shown = [html.escape(_num(v, locale, int(b.get("decimals", 1))) + unit) for v in values[:n]]
    out = [f'<svg class="chart" viewBox="0 0 {width} {n * row + 8}" role="img">']
    for i in range(n):
        w, y = room * abs(values[i]) / span, 4 + i * row
        x = zero if values[i] >= 0 else zero - w
        out.append(f'<text class="m" x="{left - 8}" y="{y + 15}" text-anchor="end">{html.escape(labels[i])}</text>'
                   f'<rect x="{x:.1f}" y="{y}" width="{max(w, 1):.1f}" height="{row - 8}" rx="3" fill="#2f5bea"/>'
                   f'<text x="{(x + w + 6 if values[i] >= 0 else zero + 6):.1f}" y="{y + 15}">{shown[i]}</text>')
    return _figure("".join(out) + "</svg>", b.get("title", ""), b.get("note", ""))


def _line(b: dict, locale: str) -> str:
    labels, series = [str(x) for x in b.get("labels") or []], b.get("series") or []
    if not labels or not series:
        raise ValueError("line block needs labels and series")
    vals = [float(v) for s in series for v in s.get("values") or [] if v is not None]
    lo, hi = min(0.0, min(vals)), max(vals) or 1.0
    width, height, left, top = 760, 300, 56, 16
    w, h, colours = width - left - 20, height - top - 40, ("#2f5bea", "#e8590c", "#0f9d58", "#9b51e0", "#00a3bf", "#c2255c")
    px = lambda i: left + (w * i / (len(labels) - 1) if len(labels) > 1 else w / 2)       # noqa: E731
    py = lambda v: top + h - h * (v - lo) / ((hi - lo) or 1)                             # noqa: E731
    out = [f'<svg class="chart" viewBox="0 0 {width} {height}" role="img">']
    for k in range(5):
        v = lo + (hi - lo) * k / 4
        out.append(f'<line x1="{left}" x2="{left + w}" y1="{py(v):.1f}" y2="{py(v):.1f}" stroke="#e3e6ec"/>'
                   f'<text class="m" x="{left - 6}" y="{py(v) + 4:.1f}" text-anchor="end">{html.escape(_num(round(v, 2), locale, 1))}</text>')
    step = max(1, len(labels) // 12)
    out += [f'<text class="m" x="{px(i):.1f}" y="{height - 18}" text-anchor="middle">{html.escape(labels[i])}</text>' for i in range(0, len(labels), step)]
    for k, s in enumerate(series):
        pts = [(px(i), py(float(v))) for i, v in enumerate((s.get("values") or [])[:len(labels)]) if v is not None]
        c = colours[k % len(colours)]
        out.append(f'<polyline fill="none" stroke="{c}" stroke-width="2.2" points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in pts)}"/>')
        out.append(f'<rect x="{left + 8 + k * 150}" y="{height - 10}" width="10" height="3" fill="{c}"/>'
                   f'<text x="{left + 22 + k * 150}" y="{height - 4}">{html.escape(str(s.get("name", "")))}</text>')
    return _figure("".join(out) + "</svg>", b.get("title", ""), b.get("note", "") or (f"unidade: {b['unit']}" if b.get("unit") else ""))


def _image(b: dict, base: Path) -> str:
    p = (base / str(b.get("path", ""))).resolve()
    if not p.is_file():
        raise ValueError(f"image not found: {b.get('path')}")
    mime = mimetypes.guess_type(p.name)[0] or "image/png"
    return _figure(f'<img alt="{html.escape(str(b.get("caption", "")))}" src="data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}">',
                   b.get("title", ""), b.get("caption", ""))


def _block(b: dict, base: Path, locale: str) -> str:
    kind = b.get("type")
    if kind == "text":
        return "".join(f"<p>{_inline(p.strip())}</p>" for p in re.split(r"\n\s*\n", str(b.get("text", ""))) if p.strip())
    if kind == "finding":
        evidence = "<small>" + _inline(b["evidence"]) + "</small>" if b.get("evidence") else ""
        return f'<div class="finding">{_inline(b.get("text", ""))}{evidence}</div>'
    if kind == "kpis":
        return '<div class="kpis">' + "".join(
            f'<div class="kpi"><span>{html.escape(str(k.get("label", "")))}</span><b>{html.escape(_num(k.get("value"), locale))}</b>'
            f'<small>{html.escape(str(k.get("note", "")))}</small></div>' for k in b.get("items") or []) + "</div>"
    if kind == "table":
        return _table(b, locale)
    if kind == "bar":
        return _bar(b, locale)
    if kind == "line":
        return _line(b, locale)
    if kind == "image":
        return _image(b, base)
    raise ValueError(f"unknown block type: {kind!r} (text, finding, kpis, table, bar, line, image)")


def build(spec: dict, out: Path, base: Path) -> dict:
    locale = str(spec.get("locale") or "pt-BR")
    sections = spec.get("sections") or []
    if not sections:
        raise ValueError("spec has no sections")
    for s in sections:                                   # the page numbers the sections: drop a number the author already typed
        s["title"] = re.sub(r"^\s*\d+\s*[.)\-:]\s*", "", str(s.get("title", "")))
    parts, counts = [], {"sections": len(sections), "tables": 0, "charts": 0}
    for i, s in enumerate(sections):
        blocks = s.get("blocks") or []
        counts["tables"] += sum(b.get("type") == "table" for b in blocks)
        counts["charts"] += sum(b.get("type") in ("bar", "line", "image") for b in blocks)
        parts.append(f'<section id="s{i + 1}"><h2>{i + 1}. {html.escape(str(s.get("title", "")))}</h2>'
                     + "".join(_block(b, base, locale) for b in blocks) + "</section>")
    nav = "<nav>" + "".join(f'<a href="#s{i + 1}">{i + 1}. {html.escape(str(s.get("title", "")))}</a>' for i, s in enumerate(sections)) + "</nav>"
    summary = ('<div class="summary"><ul>' + "".join(f"<li>{_inline(x)}</li>" for x in spec["summary"]) + "</ul></div>") if spec.get("summary") else ""
    title = html.escape(str(spec.get("title") or "Relatório"))
    sub = '<p class="sub">' + _inline(spec["subtitle"]) + "</p>" if spec.get("subtitle") else ""
    foot = "<footer>" + _inline(spec["footer"]) + "</footer>" if spec.get("footer") else ""
    page = (f'<!doctype html><html lang="{html.escape(locale)}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>{CSS}</style></head>'
            f'<body><main><h1>{title}</h1>{sub}{summary}{nav}{"".join(parts)}{foot}</main></body></html>')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8", newline="\n")
    return {"path": str(out), "bytes": len(page.encode("utf-8")), **counts}


# ------------------------------------------------------------------ check

def columns(data: Path) -> list[str]:
    """Header of a delimited file, whatever the separator."""
    with data.open(encoding="utf-8-sig", errors="replace", newline="") as f:
        first = f.readline()
    sep = max(";,\t|", key=first.count)
    return [c.strip() for c in next(csv.reader([first], delimiter=sep)) if c.strip()]


def _prose(page: str) -> str:
    t = re.sub(r"data:[\w/+.-]+;base64,[A-Za-z0-9+/=\s]+", "", page)
    t = re.sub(r"<(style|script)\b.*?</\1>", " ", t, flags=re.S | re.I)
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t)))


def _charts(part: str) -> int:
    return (len(re.findall(r"<img[^>]+src=[\"']data:image", part, re.I)) + len(re.findall(r"<svg[\s>]", part, re.I))
            + len(re.findall(r"<canvas[\s>]", part, re.I)))


def check(page: str, cols: list[str] | None = None, target: str = "", minimum: dict | None = None) -> tuple[dict, list[str]]:
    """(what the report has, what it lacks). Counts and word lists only: a check a model cannot argue with."""
    small = bool(cols) and len(cols) < 6
    need = {"sections": 4 if small else 6, "tables": 3 if small else 6, "charts": 4 if small else 8, "words": 350 if small else 700, **(minimum or {})}
    pieces = re.split(r"<h2[\s>]", page, flags=re.I)[1:]
    text = _prose(page)
    low = text.lower()
    prose = _prose(re.sub(r"<(table|svg)\b.*?</\1>", " ", page, flags=re.S | re.I))      # words that explain, not cells and axis labels
    have = {"sections": len(pieces), "tables": len(re.findall(r"<table[\s>]", page, re.I)), "charts": _charts(page),
            "words": len(re.findall(r"\w+", prose))}
    gaps = [f"{k}: {have[k]}, minimum {need[k]}" for k in need if have[k] < need[k]]
    bare = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", p.split("</h2>")[0].split(">", 1)[-1])).strip()[:50] for p in pieces
            if not re.search(r"<table[\s>]", p, re.I) and not _charts(p)]
    # a summary, the recommendations and the method notes are prose by nature: evidence belongs in the sections they point to
    bare = [t for t in bare if not re.search(r"resumo|sum[áa]rio|summary|recomenda|recommend|limit|m[ée]todo|metodolog|method|ap[êe]ndice|appendix|conclus", t.lower())]
    if bare:
        gaps.append("sections with neither a table nor a chart: " + "; ".join(bare))
    external = re.findall(r"<img[^>]+src=[\"'](?!data:)([^\"']+)", page, re.I)
    if external:
        gaps.append("images not embedded (the report must open alone): " + ", ".join(external[:5]))
    if cols:
        missing = [c for c in cols if not re.search(r"(?<![\w-])" + re.escape(c.lower()) + r"(?![\w-])", low)]
        if missing:
            gaps.append("columns never mentioned by their name (profile every one, at least in the data dictionary): " + ", ".join(missing))
    wanted = {"data quality (missing values, duplicates, odd codes)": r"nul[oa]s|ausentes|faltantes|missing|duplicad|duplicate",
              "limits of the analysis": r"limita|limites|limitation|caveat|ressalva",
              "recommendations": r"recomenda|próximos passos|proximos passos|recommend|next steps"}
    if target:
        wanted.update({"class balance or distribution of the target": r"desbalance|desequil|imbalanc|distribui[çc][ãa]o d[aeo] (alvo|vari[áa]vel[- ]alvo|target)|balancead",
                       "a baseline the model is compared to": r"linha de base|baseline|modelo de refer[êe]ncia|ing[êe]nuo|dummy",
                       "how the model was validated": r"valida[çc][ãa]o|conjunto de teste|holdout|cross[- ]valid|treino e teste|train/test",
                       "a model quality metric": r"\bauc\b|roc|f1|precis[ãa]o|recall|revoca|rmse|\bmae\b|r²|acur[áa]cia|accuracy",
                       "which variables drive the model": r"import[âa]ncia|importance|coeficiente|shap",
                       "what the model is worth in practice (gain or lift)": r"lift|ganho|gain|decil|top \d+ ?%|\d+ ?% (primeiros|melhores|superiores)"})
    gaps += [f"missing: {what}" for what, pat in wanted.items() if not re.search(pat, low)]
    return have, gaps
