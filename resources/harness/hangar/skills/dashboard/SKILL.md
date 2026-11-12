---
name: dashboard
description: Build a modern, self-contained HTML dashboard from computed data (KPIs, charts, insights) and verify it visually. Load before writing any dashboard or data-visualisation page.
---

# HTML dashboard

One file, opens by double-click, no build step. Data embedded as JSON (`<script type="application/json" id="data">`), copied from your `analysis.json`.

## Structure (top to bottom)

1. **Header**: title that says what this is, period covered, one-line context. No logo walls.
2. **KPI row**: 3-5 cards. Each: label (small caps), big number, comparison (`+12% vs trimestre anterior`) coloured by meaning, optional sparkline.
3. **Main chart**: the single most important trend, wide.
4. **Breakdowns**: 2-3 smaller charts in a grid (by segment, ranking, composition).
5. **Insights**: 3-5 sentences, each a finding with its number. This is what people actually read.
6. **Footer**: data source, row count, cleaning rules, date generated.

## Design system (define as CSS variables, use everywhere)

- Neutral surface + ONE accent + one secondary; semantic green/red only for good/bad. Dark or light, never both half-done. Example dark: `--bg:#0b1020; --surface:#141a2e; --line:#232b45; --fg:#f4f6fb; --muted:#98a2b3; --accent:#7c5cff; --accent2:#22d3ee; --good:#34d399; --bad:#f87171`.
- Type: system stack (`Inter, "Segoe UI", system-ui, sans-serif`), numbers with `font-variant-numeric: tabular-nums`. Scale: 12 / 14 / 16 / 20 / 28 / 44. Big numbers are 600-700 weight, labels 500 and muted.
- Spacing on an 8px grid; cards with 16-20px radius, 24px padding, 1px hairline border OR a soft shadow, not both.
- Layout: CSS grid, `max-width: 1320px`, centred, 24px gutters; collapses to one column under 900px. No horizontal scroll at 1440px.

## Charts

- Draw them yourself in inline SVG from the data (a 40-line helper for bars and lines is enough) - crisp, no dependency, full control. A pinned CDN library (ECharts, Chart.js from cdn.jsdelivr.net) is fine when you need many chart types.
- One message per chart, stated in its title ("Sudeste lidera com 38% da receita"), not "Receita por região".
- Bars start at zero. Sort rankings. At most 5-6 series; otherwise small multiples or "others".
- Label directly (value at bar end, series name at line end) instead of legends when possible. Light gridlines, no chart borders, no 3D, no gradients-for-decoration.
- Format numbers for people: `R$ 1,2 mi`, `12,5%`, months as `jan`, `fev`.
- Add `<title>` tooltips or a simple hover readout; it must still make sense without hover.

## Verify before you finish (always)

```bash
python -m hangar studio screenshot dashboard.html shots/dashboard.png --width 1440 --height 900 --full
```
It prints console errors, horizontal overflow and clipped text: fix every one. Then look at the image with `perceive` and ask: "List concrete visual defects: overlapping or cut-off text, unreadable contrast, misaligned cards, empty charts, crowded labels." Fix and re-shoot until it is clean. Check a narrow viewport too (`--width 420`).
