---
name: data-analysis
description: Analyse a dataset (CSV/JSON/Excel) rigorously - profile, clean, compute metrics, find insights. Load before any data analysis, report, dashboard or deck built from data.
---

# Data analysis

The numbers are the product. Everything downstream (dashboard, slides, video) must read them from ONE file you computed, never retype them.

## Workflow

1. **Profile first.** Before any metric: row count, columns, types, missing values, duplicates, date range, distinct values of each category, min/max of each number. Print it. Surprises found here change the analysis.
2. **Decide the cleaning rules and write them down** (in the script as comments and in the final answer): what counts as a duplicate, which statuses are excluded, how mixed date/number formats are parsed, what you do with missing values. If the task states rules, follow them exactly.
3. **One script, one output.** Write `analysis.py` that reads the raw data and writes `analysis.json` with every figure you will show: totals, breakdowns, time series, rankings, comparisons. Re-running it must reproduce the file.
4. **Reconcile.** Check that breakdowns sum to the total, shares sum to 100%, row counts after each filter are explainable. A figure that does not reconcile is a bug, not a rounding issue.
5. **Find the story.** For each candidate insight ask: compared to what? (previous period, other segment, target). Keep 3-5 findings that would change a decision; drop trivia.
6. **State limits.** Sample size, missing periods, anything you assumed.

## Rules

- Python standard library (`csv`, `json`, `statistics`, `datetime`, `collections`) is enough for files up to a few hundred thousand rows. Check `python -c "import pandas"` before relying on pandas; do not install packages unless asked.
- Never compute in your head or from a sample: run code over the full file.
- Round only at presentation time; keep full precision in `analysis.json`. Use the user's locale for display (pt-BR: `R$ 1.234,56`, `12,5%`).
- Percent change = (new - old) / old. Say "p.p." for differences between percentages.
- A chart or sentence that cannot be traced to a key in `analysis.json` does not ship.
- If the task also asks for a dashboard, deck, image or video, load those skills too: `dashboard`, `presentation`, `image-generation`, `motion-video`.
