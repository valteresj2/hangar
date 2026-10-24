// Authoring guide appended to Claude's instructions when the user picks "Saída: Motion".
// Keep it in sync with spec.ts. Owned by the chief.

export const MOTION_GUIDE = `# Hangar Motion

The user wants a short ANIMATION (explainer, animated chart, product walkthrough). In Hangar an animation is a JSON
document that Hangar's player renders and exports to MP4. You do not generate video: you write data that moves text,
shapes, images, charts and counters. Never claim to produce realistic footage or people.

## Output

- Write ONE file named \`<kebab-name>.motion.json\` in the working directory (or under \`motion/\` if it exists) with the
  Write tool. It opens automatically in Hangar's Artifacts panel.
- When asked to change an existing animation, Edit that file in place: keep every \`id\`, touch only what was asked.
- After writing, reply in 1-3 sentences: what the animation shows, its length, and what is easy to tweak.
- Ask at most one question first only if audience, length or content is truly unclear; otherwise use sensible defaults
  (16:9, 1920x1080, 30 fps, 15-45 s total).

## Format (JSON, no comments)

{
  "version": 1, "title": "…", "width": 1920, "height": 1080, "fps": 30,
  "background": "#ffffff", "fontFamily": "Segoe UI",
  "scenes": [
    { "id": "intro", "name": "Abertura", "duration": 4, "background": "#faf9f5",
      "transition": { "type": "fade", "duration": 0.5 },
      "elements": [ …elements… ] }
  ]
}

Coordinates: pixels, origin top-left, and each element's (x, y) is its CENTER. Times are seconds; element times are
relative to the scene. Scene transitions (none | fade | slide-left | slide-up) blend in at the START of the scene.

Every element has: "id" (unique, stable), "type", "x", "y", optional "start", "end", "opacity" (0-1), "scale",
"rotation" (degrees), "enter": {"type", "duration", "easing"}, "exit": {"type", "duration", "easing"},
"keyframes": [{"t", "x", "y", "scale", "rotation", "opacity", "easing"}] (t is scene-relative; properties you omit keep
the element's base value).
- enter types: fade | slide-up | slide-down | slide-left | slide-right | scale | typewriter (text only) | draw (line/arrow)
- exit types: fade | slide-up | slide-down | slide-left | slide-right | scale
- easing: linear | easeIn | easeOut | easeInOut | backOut

Element types:
- text: "text" (\\n for line breaks), "fontSize", "color", optional "fontWeight", "fontFamily", "align"
  (left|center|right), "maxWidth" (wraps), "lineHeight".
- shape: "shape" rect|circle|line|arrow, "width", "height" (rect/circle), "fill", "stroke", "strokeWidth", "radius".
  line/arrow are horizontal with length = width; rotate them to aim.
- image: "src" (path relative to the .motion.json, absolute path or data: URI; prefer local files — remote https
  images only load if the server sends CORS headers), "width", "height", "fit"
  (contain|cover), "radius".
- chart: "chart" bar|line|pie, "width", "height", "labels": [...], "series": [{"name", "values": [...], "color"}],
  optional "growDuration" (s), "textColor", "axisColor", "fontSize", "showValues", "valuePrefix", "valueSuffix",
  "decimals". Data grows in after "start".
- counter: "from", "to", "fontSize", "color", optional "countDuration" (s), "decimals", "prefix", "suffix",
  "fontWeight", "fontFamily". Counts up after "start".

## Style

- One idea per scene, 3-8 s each, large readable text (titles 80-120 px, body 40-56 px), generous margins (>= 120 px).
- Stagger entrances (start 0, 0.3, 0.6 …), keep motion purposeful, end with a clear closing scene.
- Use the user's data exactly; never invent numbers. Use a consistent palette with good contrast.
- Prefer system fonts (Segoe UI, Arial, Georgia, Consolas).
`
