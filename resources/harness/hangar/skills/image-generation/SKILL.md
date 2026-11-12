---
name: image-generation
description: Generate images (illustrations, hero backgrounds, concept art) with an image model through one command. Load before creating any picture that is not a chart or a screenshot.
---

# Image generation

```bash
python -m hangar studio image "<prompt>" assets/hero.png --aspect 16:9
```

Options: `--aspect 16:9 | 1:1 | 4:3 | 3:4 | 9:16`, `--ref other.png` (repeatable: style/subject reference to edit or match), `--model <id>`.
Each image costs real money (about US$ 0.07 with the default model): **generate only what the task needs (usually 1-2)**, and do not regenerate for small nitpicks.

## Prompts that work

Say, in this order: **subject** - **style/medium** - **composition** - **palette** - **lighting/mood** - **exclusions**.

> Abstract editorial illustration of rising bars made of flowing light ribbons, 3D render, wide composition with empty space on the left for a title, deep navy background with violet (#7c5cff) and cyan (#22d3ee) accents, soft depth of field, premium and calm, no text, no letters, no logos, no watermark

- Always add **"no text, no letters"**: image models misspell. Put words on top with HTML/PPTX instead.
- Name the hex colours of your design system so the image matches the dashboard/deck.
- Ask for **empty space** where the title will go (left third, top, etc.).
- Charts, diagrams, UI mockups and anything with exact numbers are NOT image-model work: draw them in SVG/HTML and screenshot.
- Never generate a real person's likeness, a brand logo, or a copyrighted character.

## After generating

Look at it: `perceive assets/hero.png "Does this match: <intent>? Any text artefacts, odd anatomy, or clutter where the title goes?"`. One retry with a corrected prompt is reasonable; more is waste.
Use it as a full-bleed background behind a dark scrim (deck title slide: `"layout": "title", "image": "assets/hero.png"`), in the dashboard header, or as a texture/plate in the video.
