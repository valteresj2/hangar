---
name: motion-video
description: Create a motion-graphics video (MP4) by coding an HTML animation with three.js / canvas / CSS and rendering it frame by frame. Load before making any animated video, intro, explainer or data story clip.
---

# Motion video (HTML -> MP4)

You write one HTML page whose picture is a pure function of time; the renderer seeks it to every frame and encodes an MP4. No screen recording, no dropped frames.

```bash
python -m hangar studio screenshot video.html shots/v_03.png --width 1920 --height 1080 --at 3     # check a still at t = 3 s
python -m hangar studio video video.html out.mp4 --duration 15 --fps 30 --width 1920 --height 1080
```
Rendering takes roughly 0.1 s per frame (15 s at 30 fps is about 45 s): run it once you are happy with the stills.

## The contract

```html
<script type="importmap">{"imports": {"three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"}}</script>
<script type="module">
import * as THREE from 'three';
// build scene once ...
window.hangarFrame = (t) => {        // t in seconds; may be async
  // set EVERYTHING from t: camera, meshes, uniforms, DOM text, opacity
  renderer.render(scene, camera);
};
window.hangarFrame(0);
</script>
```

- **Deterministic**: no `Date.now()`, `performance.now()`, `requestAnimationFrame` loops, `setTimeout`, or unseeded `Math.random()` driving the picture. Use a seeded PRNG (`mulberry32`) for particles. Frame N must look the same every time.
- CSS animations and Web Animations are seeked automatically, so `@keyframes` with `animation-delay` works for text overlays; anything else goes through `hangarFrame(t)`.
- Fixed stage: `html,body{margin:0;width:1920px;height:1080px;overflow:hidden}`; renderer `setSize(1920,1080,false)`, `setPixelRatio(1)`.
- Load three.js from the pinned CDN URL above (addons: `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/`). Fonts: system fonts, or a web font loaded in `<head>`.

## Make it look directed, not generated

1. **Storyboard first** (write it as a comment): 3-5 scenes with start/end times and one message each, e.g. `0-3 title | 3-8 chart builds | 8-12 highlight the winner | 12-15 closing number`. 12-20 s total.
2. **Timeline helpers**: `const clamp=(x)=>Math.min(1,Math.max(0,x)); const seg=(t,a,b)=>clamp((t-a)/(b-a)); const ease=(x)=>1-Math.pow(1-x,3);` then `const p = ease(seg(t, 3, 4.2))`. Everything moves with easing; nothing pops in. Stagger items by 0.08-0.15 s.
3. **3D with purpose**: data as geometry (bars as boxes that grow, a ribbon for the trend, points for records), slow continuous camera drift (`camera.position.x = Math.sin(t*0.2)*2`), fog and a soft key + rim light, `MeshStandardMaterial` with your palette. A particle field or grid floor gives depth cheaply.
4. **Type on top in the DOM**, not in WebGL: absolutely positioned HTML over the canvas, same fonts and colours as the dashboard/deck, big (64-120px titles), with opacity/translate driven by `p`. Numbers count up: `Math.round(value * p).toLocaleString('pt-BR')`.
5. **Text-safe zone**: decide where text lives (e.g. the left 40%) and keep the 3D subject out of it (offset the camera target, or put a soft
   dark gradient behind the text). Text over busy geometry is unreadable. And **fill the frame**: no scene that is mostly empty space with
   small cards - scale the subject up until it owns the picture.
6. **Count-ups are short** (0.6-0.9 s) and then HOLD the final value: a long count shows wrong numbers for most of the scene, and any
   paused frame becomes a false figure.
7. **Every scene shows a real number** from `analysis.json` (embed the JSON in the page). Cross-fade scenes over ~0.5 s. End on a 1.5-2 s hold of the conclusion.
8. Same palette as the rest of the deliverables; an image from `image-generation` can be a background plate (`THREE.TextureLoader` or a CSS background) with slow parallax.

## Verify

Shoot stills at the middle of every scene (`--at`) and `perceive` them: text readable and inside the frame? nothing overlapping? scene actually different from the previous one? Then render, and confirm with
`ffprobe -v error -show_entries stream=width,height,nb_frames,duration -of csv=p=0 out.mp4`.
The renderer reports console errors and warns if frames look identical: fix both before finishing.
