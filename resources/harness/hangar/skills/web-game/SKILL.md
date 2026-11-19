---
name: web-game
description: Build a browser game or interactive canvas app, then play it and look at it to prove it. Load before writing any game or animated interactive page.
triggers: game, jogo, jogos, videogame, canvas game, arcade, platformer, fighting game, jogo de luta, joguinho
gate: studio play
gate_hint: python -m hangar studio play index.html shots --do "..." must end without console errors, blank or frozen shots; then look at the shots with perceive
---

# Browser game (canvas) that is actually played and looked at

A game you never ran is not a game. Every stage below ends with a command that plays it and a look at the picture. Code that was only read is not verified.

## 1. Shape of the project (decide before the first line)

- `index.html` + plain scripts in `js/` loaded in order with `<script src>` (NOT ES modules: they do not load from a double-clicked file). One global namespace object, e.g. `const G = {}`; each file adds to it.
- One concern per file, **at most ~350 lines each, formatted normally, never minified, one statement per line**. A 2000-line file or a one-line file cannot be edited reliably later. Typical split: `config.js`, `input.js`, `data/<thing>.js` (pure data), `engine.js` (rules), `render/*.js` (drawing only), `fx.js`, `audio.js`, `ai.js`, `ui.js`, `main.js` (loop and scenes).
- Rules and drawing are separate: the simulation advances in a fixed step (60 Hz, an accumulator in the rAF loop) and never reads the canvas; rendering never changes state.
- Fixed internal resolution (1280x720), scaled to the window with CSS and letterboxed. Never size the world from `innerWidth`.
- Content is data (characters, moves, levels are tables); one interpreter runs them. No copy-pasted code per character.

## 2. Hooks that make it testable (build them first, they cost 30 lines)

- `window.G` exposes the live state (scene, entities, hp, frame counter).
- URL parameters jump straight to a state, so a test does not replay the menus: `index.html?scene=fight&p1=2&p2=5&stage=1&mute=1`, `?scene=select`, `?cpu=off`.
- `?scene=gallery`: a contact sheet drawn by the real renderer: every character in every key pose (idle, walk, crouch, jump, each attack at its hit frame, hurt, fallen), on a neutral ground, with labels. This is how you judge and fix the art without playing for minutes.
- `G.step(n)` advances the simulation n frames when `?manual=1`, so a shot can land on the exact frame of a hit.
- Keyboard handlers use `event.code` and call `preventDefault()` for game keys.

## 3. Build in slices, each one played before the next

Never write the whole game and then test. Order:

1. Loop, input, ONE entity drawn at final quality, moving. Play it, look at it.
2. The core interaction complete for two entities (collision, damage, win/lose) with the HUD.
3. The gallery, then art pass on it until it passes the look test in section 5.
4. Breadth: the rest of the content as data. After every 1-2 additions, run the regression script.
5. Screens, AI, audio, effects, polish.

Keep one `tests/smoke.txt` with the play steps and extend it as features land; run it after every slice:

```bash
python -m hangar studio play "index.html?scene=fight&p1=0&p2=1&cpu=off&mute=1" shots --script tests/smoke.txt
```

```text
# tests/smoke.txt  (keys are DOM codes; lines or ';' separate steps)
wait 600
shot 01_start
expect G.scene === 'fight' && G.fighters.length === 2
hold ArrowRight 900
shot 02_walked
expect G.fighters[0].x > 300
press Numpad7
wait 120
shot 03_punch
expect G.fighters[1].hp < G.fighters[1].maxHp
seq ArrowDown ArrowRight Numpad9
wait 400
shot 04_special
eval ({scene: G.scene, hp: G.fighters.map(f => f.hp)})
```

`play` exits non-zero on a console error, on a failed `expect`, on a blank shot and on a shot identical to the previous one (the keys did nothing). `expect` on state is what proves a rule; a shot proves the picture. Use both. `python -m hangar studio play --help` lists the steps (`down`/`up` for held keys and chords, `click X Y`).

## 4. Art direction for drawn (procedural) graphics

Stick figures and flat rectangles are the default failure. What makes drawn characters read as professional:

- **Size**: a standing character is 40-50% of the screen height. Small characters look cheap and hide the animation.
- **Volume, not lines**: every limb is a tapered capsule (two circles of different radius joined by their outer tangents), drawn as a filled shape; torso and hips are shaped polygons (chest wider than waist); hands and feet are their own shapes; the head has hair, a face plane, an eye and brow that show where it looks.
- **Hierarchy of drawing**: far arm and far leg first and darker, then torso, head, near leg, near arm. Joints overlap, never gap.
- **Light**: one light direction for the whole scene. Each part: base colour, a darker shade on the side away from the light (a clipped offset copy of the shape), a thin highlight on the lit side. A soft elliptical ground shadow that shrinks when the character jumps. Dark outline (2-3 px at 720p) around the whole silhouette.
- **Identity**: each character is recognisable in black silhouette: different build (shoulder width, height, leg length), a distinctive element (hair, coat, weapon, scarf) and a palette of 3-4 colours with one accent. Secondary motion on the loose element (scarf, hair) sells the animation.
- **Poses**: authored keyframes of joint angles, interpolated with easing. Every attack has anticipation (2-4 frames pulling back), a fully extended hit pose held during the active frames, and recovery. Feet stay planted (solve the legs from hip and foot position); the body leans into the move; the head looks at the opponent. Idle breathes (chest and shoulders 2-3 px, 1.5 s loop).
- **Stage**: 3-4 depth layers with parallax, an obvious light source, atmospheric fade (far layers lighter and bluer/desaturated), a ground plane with perspective and a horizon behind the characters' waist line. The background is lower in contrast and saturation than the characters so they pop; nothing bright at the height where they fight.
- **Impact**: hit-stop (freeze 4-10 frames), a spark at the contact point, a 1-frame white flash on the victim, camera shake that decays, dust on landing, motion smear on fast limbs. Without these the hits feel like nothing happened.
- **HUD**: a consistent display font drawn with outline, bars with a frame, a gradient and a delayed damage trail; everything aligned to a grid with equal margins.
- Generated pictures (`python -m hangar studio image "<prompt>" assets/x.png`, see the image-generation skill) fit static art: stage backdrops, portraits, the title. They cost money per image; moving characters stay drawn in code so they animate. Never ship a game that needs a server to load its assets: reference them with relative paths.

## 5. The look test (do it for the gallery, the main scene and every screen)

```bash
python -m hangar studio play "index.html?scene=gallery&mute=1" shots --do "wait 800; shot gallery"
```

Then `perceive` each shot with a question that cannot be answered politely:

> "You are a demanding art director reviewing a 2D game screenshot. Score 1-10 each: character anatomy and volume, silhouette readability, pose and weight, colour and contrast against the background, HUD and typography, overall polish compared with a commercial 2D game. Then list the 6 worst concrete defects with where they are on screen (e.g. 'left character: arms are thin lines crossing the torso'). Do not praise."

Fix the listed defects in the renderer or the pose data, re-shoot, ask again. Stop a screen when no score is under 7, or after 4 rounds: then report the remaining defects honestly. Scores from a first draft are usually 3-5: that is expected, the loop is the work.

Also check by state, not by eye: every character can reach every attack (`expect` on its state name), every special's input is recognised, a round ends, the next round starts, the match ends and returns to the menu.

## 6. Before the final answer

- Run the full `tests/smoke.txt` and one play from the real entry (`index.html`, through the menus with the keys a person presses).
- `README.md` in the project: how to open, the controls as a table, the move list, what is not done.
- Say exactly what was played and seen, what was only read, and what is missing.
