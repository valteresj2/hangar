---
name: data-analysis
triggers: data analysis, análise de dados, analise de dados, análise exploratória, analise exploratoria, analyse the dataset, analyze the dataset
description: Analyse a dataset (CSV/JSON/Excel) in depth - profile every variable, relate them to the outcome, model, and deliver a report with tables and charts. Load before any data analysis, report, dashboard or deck built from data.
gate: hangar studio report check
gate_fail: GAPS
gate_hint: python -m hangar studio report check <report.html> --data <raw data file> --target <outcome column, if any>
---

# Data analysis

The numbers are the product, and depth is the default: unless the user asks for a quick look, deliver the full report below. Everything downstream (dashboard, slides, video) reads the figures from ONE file you computed, never retyped.

## Deliverable

`analysis.py` reads the raw data and writes, in one run:
- `analysis.json`: every figure shown anywhere, at full precision;
- `charts/*.png`: only the charts the report generator cannot draw (see below);
- `report_spec.json`: the report as data.

Then the harness turns the spec into the HTML and checks it. You never write HTML or CSS by hand:

```bash
python -m hangar studio report build report_spec.json relatorio.html
python -m hangar studio report check relatorio.html --data <raw file> --target <outcome column, if there is one>
```

`check` lists what the report lacks (too few tables or charts, a column never profiled, no baseline, no limits...). Fix every gap in `analysis.py`, rerun, check again. The work is not done while it prints GAPS, and the harness will not accept your final answer before this check passes (it also accepts a report you wrote by hand, but the generator is cheaper). Use the file name the user asked for instead of `relatorio.html`.

Spec: `{"title", "subtitle", "summary": [..], "sections": [{"title", "blocks": [..]}], "footer"}`. Blocks:
- `{"type":"text","text":"..."}` paragraphs split by a blank line; `**bold**` and `` `code` `` work
- `{"type":"finding","text":"claim with its number","evidence":"compared to what; n = ..."}`
- `{"type":"kpis","items":[{"label","value","note"}]}`
- `{"type":"table","title","columns":[..],"rows":[[..]],"note","decimals":2}` pass raw numbers: they are formatted for the reader's locale
- `{"type":"bar","title","labels":[..],"values":[..],"unit":"%"}` drawn for you; sort before passing
- `{"type":"line","title","labels":[..],"series":[{"name","values":[..]}]}` drawn for you
- `{"type":"image","path":"charts/x.png","caption"}` embedded in the file; use it for what bars and lines cannot show (histogram, ROC, gain curve, heatmap)

Build tables and charts in loops over the columns, not one by one: a helper that takes a column and returns its blocks covers twenty variables in ten lines.

## Sections of a full report

1. **Resumo**: 4-6 findings that would change a decision, each with its number. Written last.
2. **Qualidade dos dados**: rows, columns, types, missing values, duplicates, codes that mean "missing" (`unknown`, `-1`, `999`, empty text), outliers, date range. A data dictionary table with EVERY column by its original name: type, distinct values, missing, min/max or top category.
3. **Cada variável**: distribution of every column. Numbers: mean, median, quartiles, min/max, a histogram for the skewed ones. Categories: count and share of each level.
4. **Relação com o resultado** (when there is an outcome column): for every variable, the outcome rate or mean per level or per quantile band, with the group size, sorted by strength. One table that ranks all variables by association.
5. **Relações entre variáveis e segmentos**: correlations, the two or three interactions that matter, the segments where the outcome is far from average and how many rows they hold.
6. **Modelo** (when there is something to predict): see the rules below.
7. **Recomendações**: what to do, for whom, and the expected effect taken from the figures above.
8. **Limites**: what the data cannot say, what you assumed, what would need an experiment.

Every analytical section has at least one table and one chart. A sentence states the number, what it is compared to, and the group size ("estudantes aderem 28,7% contra 11,7% da média; n = 938").

## Modelling rules

- **Only what is known at decision time.** For each candidate predictor ask: is this value available when the prediction is used? A field recorded during or after the outcome (a closing date, a final status, anything measured while the outcome was happening) leaks the answer: leave it out, say why in the report, and show the misleading score it would give.
- **Look at the balance of the outcome first.** With a rare class, accuracy is useless: report AUC, precision and recall at a chosen cut, and keep the split stratified.
- **Always a baseline.** Compare against the trivial rule (overall rate, or the single best variable) and against a simple model (logistic or linear regression) before a stronger one.
- **Hold out data** (stratified split, fixed seed) or cross-validate; report the metric on data the model never saw.
- **Explain it**: importance of the variables (permutation importance or coefficients), and whether it agrees with section 4.
- **Say what it is worth**: a gain table by decile - contacting the top 10%, 20%, 30% reaches what share of the positives, at what rate versus the average.

## Rules

- Never compute in your head or from a sample: run code over the full file. Print the profile before deciding anything; surprises found there change the analysis.
- Write the cleaning rules down (in the script and in section 2): what counts as a duplicate, what is excluded, how odd formats are parsed. If the task states rules, follow them exactly.
- Reconcile: breakdowns sum to the total, shares sum to 100%, row counts after each filter are explainable. A figure that does not reconcile is a bug.
- Check `python -c "import pandas, sklearn, matplotlib"` once and use what is installed (with pandas 3, text columns have dtype `str`, not `object`: select them with `select_dtypes(exclude="number")`). Do not install packages unless asked; the standard library (`csv`, `statistics`, `collections`) handles a few hundred thousand rows.
- Keep full precision in `analysis.json`; the generator formats for display. Percent change = (new - old) / old; say "p.p." for differences between percentages.
- A sentence or chart that cannot be traced to a key in `analysis.json` does not ship.
- Keep the printed output of your scripts short (a profile, not the data): long output costs tokens and teaches nothing.
- If the task also asks for a dashboard, deck, image or video, load those skills too: `dashboard`, `presentation`, `image-generation`, `motion-video`.
