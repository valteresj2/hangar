---
name: presentation
description: Build a presentation as an HTML deck and/or an editable PowerPoint (.pptx) with modern design. Load before creating slides, a deck, a pitch or a pptx.
---

# Presentations (HTML deck + PPTX)

## Story first

- 6-10 slides. One idea per slide. **Every title is a conclusion** ("Sudeste puxou metade do crescimento"), never a topic ("Regiões").
- Arc: title -> the answer in one slide (KPIs) -> 3-4 evidence slides (one chart each) -> what to do -> close.
- Body text: at most 3-4 bullets of at most ~14 words. Numbers come from `analysis.json`.
- Charts as images: make a small HTML page per chart (or one page with `?chart=name`), 1600x900, same theme, then
  `python -m hangar studio screenshot chart_receita.html charts/receita.png --width 1600 --height 900`.
  Give chart images the SAME background colour as the slide (`bg`) so they sit flush with no visible box, and let the chart fill the
  frame (little padding): in the deck it is placed at full slide width.
- On a chart slide the chart is the hero: at least 70% of the slide width. Never a small chart beside a large empty area.

## HTML deck (`deck.html`)

Single self-contained file. Each slide is a `<section class="slide">` sized 16:9 (`aspect-ratio:16/9; width:min(100vw, calc(100vh*16/9))`), one per screen with `scroll-snap-type: y mandatory`, arrow keys / PageUp / PageDown to move, a thin progress bar and `n / total` counter. Use the same CSS variables as the dashboard. Big type: titles 56-72px at 1920 wide (use `clamp()`/`vw` units so it scales), body 28-32px. Generous margins (6% of width). Subtle entrance transitions only.
Verify: `python -m hangar studio screenshot deck.html shots/deck.png --width 1600 --height 900 --full`, then `perceive` it.

## PowerPoint (`deck.pptx`) - native, editable text

Write a JSON spec and build it:

```bash
python -m hangar studio pptx deck.json deck.pptx
```

```json
{"title": "Footer text for every slide",
 "theme": {"bg": "0B1020", "fg": "F4F6FB", "muted": "98A2B3", "accent": "7C5CFF", "accent2": "22D3EE", "font": "Segoe UI", "heading_font": "Segoe UI Semibold"},
 "slides": [
  {"layout": "title",   "kicker": "Short label", "title": "The main conclusion", "subtitle": "Scope and period", "image": "hero.png", "footer": "Team - date"},
  {"layout": "kpis",    "title": "...", "kpis": [{"label": "Receita", "value": "R$ 4,2 mi", "delta": "+18% vs T2"}], "takeaway": "One sentence."},
  {"layout": "bullets", "title": "...", "bullets": ["...", "..."], "image": "charts/x.png", "takeaway": "..."},
  {"layout": "image",   "title": "...", "image": "charts/y.png", "caption": "Fonte: ..."},
  {"layout": "two_col", "title": "...", "left": {"heading": "Manter", "bullets": ["..."]}, "right": {"heading": "Mudar", "bullets": ["..."]}},
  {"layout": "section", "kicker": "02", "title": "...", "subtitle": "..."},
  {"layout": "quote",   "text": "...", "by": "..."},
  {"layout": "closing", "title": "...", "subtitle": "..."}]}
```

- Colours are hex without `#`. Light theme works too (`bg: "FFFFFF", fg: "101828"`). Keep the deck, dashboard and video on the same palette.
- Image paths are relative to the spec file; PNG or JPEG only. `"image"` on `title`/`closing` becomes a darkened full-bleed background; on `bullets` it sits on the right half; `{"layout": "image", "full": true}` is edge to edge.
- `delta` starting with `-` is shown as bad (red), anything else as good (green): phrase it accordingly.
- Up to 4 KPIs, up to 7 bullets, titles up to ~2 lines. Long text is shrunk, not wrapped forever: keep it short.
- The file opens in PowerPoint/Keynote/Google Slides with real text boxes the user can edit.
