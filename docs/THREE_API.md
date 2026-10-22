# Nova 3D library · API

`simulator/static/three/nova3d.js` is a single ES module (three r170). Everything is procedural (geometry, materials, CanvasTextures), with no model files.
The test page `/static/three/gallery.html` shows every object and every state. Its URL options are `?ui=0` (hide the controls), `?view=devices|objects|logo|carousel`, `?t=18.5` (time of day), `?q=low`, `?bg=transparent`, `?frame=0` and `?screens=0`. Press **H** to toggle the controls. `window.nova` exposes every handle for poking at in the console.

## Setup

Every page that imports the library adds the same import map **before** any module script:

```html
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
<script type="module">
  import * as N from '/static/three/nova3d.js';
  // or: import { createStage, createEchoShow, ... } from '/static/three/nova3d.js';
</script>
```

Always guard for WebGL and keep your 2D layout as the fallback:

```js
let stage;
try { stage = N.createStage(document.querySelector('#stage')); }
catch (err) { document.documentElement.classList.add('no-webgl'); /* keep the 2D layout */ }
```

`createStage` throws `Error('Nova3D: WebGL unavailable')` (with `err.code === 'NO_WEBGL'`) when a WebGL 2 context cannot be created. three r170 needs WebGL 2. `N.isWebGLAvailable()` lets you check up front without creating a stage.

### World conventions
- **Units: 1 unit = 10 cm**, Y up. Every object is real size: Echo Show 8 is 2.0 × 1.36 units, Echo Show 15 is 4.02 × 2.52, the Ring doorbell is 0.62 × 1.28, a pill bottle is about 0.46 × 0.94, and the paper is 2.16 × 2.79 (US letter).
- Every factory returns a **handle** `{ group, kind, …, dispose() }`. `group` is a `THREE.Group` whose origin is the **bottom centre** of the object (it rests on y = 0), facing **+Z** (towards the default camera). Move, rotate and scale `handle.group` freely. Keep handles as direct children of the scene (or of unrotated groups) when you use `enableDrag`.
- `stage.add(handle)` / `stage.remove(handle)` accept a handle or any `Object3D`. A handle added to the stage becomes pickable and gets per-frame animation (light rings, spin and so on). **An Echo's light bar only animates once the Echo is added to a stage.**
- Colours come from `docs/DESIGN.md` and are exported as `COLORS`.

### DOM layering inside the stage container
`createStage(container)` puts two children at the start of `container`, which must have a size. The stage sets `position: relative` if it is `static`, and `isolation: isolate`.

| child | z-index | pointer-events | role |
|---|---|---|---|
| `div.nova3d-css` (CSS3DRenderer) | 0 | `none`, but `auto` on each attached screen | live HTML screens |
| `canvas.nova3d-gl` (WebGL) | 1 | `none` | the 3D scene |

The WebGL canvas sits **above** the HTML screens and cuts a transparent hole exactly where each device's display is. The HTML is visible only through the glass, objects passing in front of a screen (a dragged pill bottle) hide it correctly, and the light bar's bloom and the glass glare spill over the live HTML. Pointer events for the 3D scene (drag, orbit, pick, carousel) are listened to on the **container**; events that start on an attached screen go to the HTML and are ignored by the 3D gestures. Put your own overlays as later siblings with **`z-index >= 2`**. While a 3D gesture is active, `<html>` has the class `nova3d-gesture`, and text selection is disabled so a drag across a live screen doesn't select its text.

---

## Constants and helpers

```js
export const VERSION            // '1.0.0'
export const COLORS             // { ink:'#0A0B10', ink2:'#11131A', ink3:'#191C26', ivory:'#F4EEE6', paper:'#EDE5D8', nova:'#3BD1FF', amber:'#FFB547', coral:'#FF6B57', sage:'#9ED9B0' }
export const SKY_KEYS           // [[hours, [top, mid, horizon]], …] the same keyframes as app.js
export const RING_STATES        // ['off','idle','listening','thinking','speaking','notify','urgent','success']
export function isWebGLAvailable()      // → boolean (WebGL 2)
export function prefersReducedMotion()  // → boolean (live media query)
export function skyAt(hours)            // → { top, mid, horizon: '#RRGGBB', sun: 0..1 (elevation), night: 0..1 }
```

---

## createStage(container, options) → Stage

```js
const stage = N.createStage(container, {
  background: 'sky',        // 'sky' (living time-of-day sky) | 'transparent' (page shows through) | any CSS colour, e.g. '#0A0B10'
  bloom: true,              // bloom on the light bars, the Ring light, the sun and the brightest highlights only
  css3d: true,              // create the CSS3D layer used by echo.attachScreen()
  quality: 'auto',          // 'auto' | 'high' | 'low'. auto starts high and drops to low once if frames average > 22 ms
  pixelRatioCap: 1.75,
  fov: 30,
  camera: [0, 1.4, 11],     // camera position
  target: [0, 0.9, 0],      // look-at point
  timeOfDay: 20.5,          // hours (0–24, float); drives the sky, sun/moon and scene lights
  exposure: 1.0,
  fx: { grain: 0.035, vignette: 0.22, scanlines: 0, aberration: 0 },  // final-pass film fx on the WebGL image (high quality only)
  autoStart: true,          // start the render loop immediately
  autoPause: true,          // pause while the container is scrolled off-screen (IntersectionObserver) or the tab is hidden
  environment: true,        // shared PMREM studio environment for reflections | false (faster start, flatter metals and glass) | your own THREE.Texture
});
```

**Stage properties**
| property | type | |
|---|---|---|
| `scene` | `THREE.Scene` | |
| `camera` | `THREE.PerspectiveCamera` | |
| `renderer` | `THREE.WebGLRenderer` | |
| `css3d` | `CSS3DRenderer \| null` | |
| `sky` | Sky handle or `null` | present unless `background === 'transparent'` |
| `container`, `canvas`, `cssLayer` | `HTMLElement` | |
| `reducedMotion` | `boolean` | follows `prefers-reduced-motion` live |
| `quality` | `'high' \| 'low'` | current |
| `time` | `number` | current time of day in hours |
| `width`, `height` | `number` | container size in CSS px |

**Stage methods**
| method | returns | |
|---|---|---|
| `add(handleOrObject3D)` | the argument | adds it to the scene and registers it for picking and animation |
| `remove(handleOrObject3D)` | | |
| `onFrame(fn(dt, elapsed))` | `unsubscribe()` | called every frame before render; `dt` in seconds (clamped to 0.1) |
| `on(event, fn)` | `unsubscribe()` | events: `'resize'` `({width, height})`, `'quality'` `({quality})`, `'time'` `({hours})` |
| `resize()` | | called automatically by a ResizeObserver on the container |
| `start()` / `stop()` | | run or pause the render loop. `stop()` is sticky: auto-pause won't restart a loop you stopped |
| `render()` | | render one frame now (useful while stopped) |
| `step(dt = 1/60)` | | advance every animation by `dt` seconds and render once. Call it after `stop()` for deterministic capture (screenshots, recorded demo footage) |
| `compileAsync()` | `Promise` | compile every material in the scene for the stage's render target ahead of time (parallel shader compile where supported), so the first frames don't hitch. Call it after adding your objects, before `start()` |
| `setTimeOfDay(hours)` | | the sky, sun/moon, lights and environment follow. Cheap enough to call every frame for a time-lapse |
| `setBackground(bg)` | | `'sky' \| 'transparent' \| color` |
| `setQuality('high' \| 'low')` | | **high:** DPR up to `pixelRatioCap`, MSAA ×4 (×2 above 1.3 DPR), bloom, physical transmission, fx. **low:** DPR 1, MSAA ×2, no bloom, faked glass, no fx |
| `setBloom(on)` | | |
| `setFx({ grain, vignette, scanlines, aberration })` | | partial update, values 0–1 |
| `setCamera({ position:[x,y,z], target:[x,y,z], fov? })` | | jump instantly |
| `flyTo({ position, target, fov? }, { duration: 1.2 })` | `Promise` | expo-out camera move (instant with reduced motion) |
| `pick(clientX, clientY, list?)` | `{ handle, object, point, distance, uv } \| null` | raycast against handles added to the stage (or only `list`). `handle` is the library handle (or the top-level Object3D you added) |
| `project(vec3OrObject3D)` | `{ x, y, visible }` | world → client pixels (viewport coordinates), handy for HTML labels |
| `dispose()` | | stops the loop, removes the DOM layers, frees GPU memory and disposes added handles |

---

## createEchoShow(options) → Echo

```js
const echo = N.createEchoShow({
  size: 8,                 // 8 (Echo Show 8: slanted wedge, fabric back, camera top-right) | 15 (Echo Show 15: slim framed panel, camera top-centre)
  color: 'charcoal',       // 'charcoal' | 'glacier' (white fabric or frame)
  mount: 'stand',          // Echo Show 15 only: 'stand' | 'wall'
  shadow: true,            // soft contact shadow, plus light spill from the ring on the surface below
});
stage.add(echo);
echo.setRing('listening');
```

| member | |
|---|---|
| `group`, `kind: 'echo'`, `size` | |
| `setRing(state)` | `'off' \| 'idle' \| 'listening' \| 'thinking' \| 'speaking' \| 'notify' \| 'urgent' \| 'success'`. Colour and intensity cross-fade. **idle:** faint cyan. **listening:** breathing cyan. **thinking:** two highlights sweeping in and out. **speaking:** bloom pulse from the centre. **notify:** amber pulse. **urgent:** fast coral pulse. **success:** steady sage. The glow also tints the glass and spills on the counter. Returns the echo |
| `ring` | the current state (string) |
| `setSpeechLevel(level)` | optional 0–1 amplitude. While `speaking`, the bloom follows it instead of the built-in pulse; pass `null` to return to the built-in pulse |
| `attachScreen(el, { pxWidth, pxHeight, fit, className })` | moves `el` into the CSS3D layer, exactly on the display glass, and returns the `CSS3DObject`. `el` goes inside a wrapper `div.nova3d-screen` of `pxWidth × pxHeight` CSS px, so give it `width:100%; height:100%` or the same fixed size. Defaults are the panels' native resolutions: Show 8 → **1280×800**, Show 15 → **1920×1080**. Use the same aspect (16:10 and 16:9); smaller CSS sizes such as 960×600 work too and simply scale. `fit: 'cover'` (default; anything outside the glass is hidden by the bezel) \| `'contain'` \| `'stretch'`. `className` is added to the wrapper: the element is **re-parented**, so put the classes your descendant selectors need here, e.g. `className: 'device rose'`. Clicks, inputs, focus, scrolling and iframes all work on the attached element. Requires `css3d: true` on the stage |
| `detachScreen()` | removes the element from the CSS3D layer and returns it; you re-insert it wherever you like |
| `setScreenImage(srcOrNull, { fit })` | shows an image URL, `<img>`, `<canvas>`, `<video>` or `THREE.Texture` on the display as a WebGL texture (no CSS3D needed). Returns a Promise. `fit: 'cover'` (default: crops to the display's aspect, centred sideways and top-anchored for tall images such as documents) \| `'stretch'`. `null` restores the dark idle glass. After redrawing a canvas, set `echo.screenTexture.needsUpdate = true`. An attached HTML screen takes precedence |
| `screenTexture` | the current screen texture or `null` |
| `screen` | `{ width, height, aspect, pxWidth, pxHeight, mesh }`: the display size in world units and the recommended CSS pixel size |
| `screenAnchor` | `Object3D` at the centre of the display, facing out of the glass |
| `cameraDot` | `Object3D` just in front of the camera lens: use it as a drag target (`targets: [{ object: echo.cameraDot }]`) |
| `dispose()` | |

---

## createRingDoorbell(options) → Ring

```js
const ring = N.createRingDoorbell({ finish: 'nickel' /* 'nickel' | 'bronze' | 'black' */, shadow: true });
stage.add(ring);
ring.flash('ding');
```
| member | |
|---|---|
| `group`, `kind: 'ring'` | |
| `setRing(state)` | `'off' \| 'idle'` (faint blue) `\| 'live'` (steady blue) |
| `state` | the current state |
| `flash(kind)` | `'ding'`: a blue arc spins round the button, then the whole ring flares (about 3 s). `'motion'`: two blue pulses (2 s). Returns a Promise that resolves when the flash ends |
| `cameraDot` | `Object3D` in front of the lens |
| `button` | the button `Mesh` (pick it to fake a press) |
| `dispose()` | |

---

## createPillBottle(options) → Pill

```js
const pill = N.createPillBottle({
  label: '/samples/pill-atorvastatin.png', // the sample PNG; the label area is cropped automatically
  id: 'atorvastatin',
  style: 'rx',                            // 'rx' | 'otc' (see below). Default: 'otc' if the label URL contains "ibuprofen" or "otc", else 'rx'
  crop: [252, 212, 396, 306],             // optional: label rectangle [x, y, w, h] in source pixels (the defaults fit the 900×640 samples for each style)
  pills: true,                            // rx only: a few tablets visible through the amber plastic
});
// the four bottles used in the Studio and on the landing:
const bottles = [
  N.createPillBottle({ label: '/samples/pill-atorvastatin.png', id: 'atorvastatin' }),
  N.createPillBottle({ label: '/samples/pill-lisinopril.png',   id: 'lisinopril' }),
  N.createPillBottle({ label: '/samples/pill-metformin.png',    id: 'metformin' }),
  N.createPillBottle({ label: '/samples/pill-ibuprofen.png',    id: 'ibuprofen', style: 'otc' }),
];
```
`{ group, kind: 'pill', id, style, setHighlight(on: boolean), ready: Promise, dispose() }`. The label is cropped from the sample and wrapped round the front (+Z) of the bottle. `ready` resolves once the label texture has loaded; until then, or if the PNG fails to load, a drawn placeholder label is shown.
- `style: 'rx'`: amber translucent prescription vial (physical transmission in high quality, a tinted fake in low) with a white ridged child-resistant cap; about 0.46 × 0.94 units.
- `style: 'otc'`: opaque white HDPE over-the-counter bottle with rounded shoulders and a narrower blue ridged cap; about 0.48 × 0.89 units.

## createPaper(options) → Paper

```js
const paper = N.createPaper({ texture: '/samples/after-visit-summary.png', id: 'avs', curl: 0.12, pose: 'upright' /* | 'flat' */ });
```
`{ group, kind: 'paper', id, setHighlight(on), ready: Promise, dispose() }`. A slightly curled US-letter sheet (2.16 × 2.79 units, so scale it down next to the devices: `paper.group.scale.setScalar(0.42)`), printed on the front and plain on the back. `'upright'` stands on its bottom edge, leaning back slightly; `'flat'` lies on the surface.

## createNovaLogo(options) → Logo

```js
const logo = N.createNovaLogo({
  finish: 'chrome',     // 'chrome' | 'glass' (glass ring with a glowing cyan star) | 'iridescent' (holographic chrome)
  core: 'star',         // 'star' (four-point star) | 'dot' (favicon dot)
  wordmark: false,      // false | 'right' | 'below': extruded "Nova" in Instrument Serif (loaded on demand; helvetiker fallback)
  wordmarkItalic: false,
  size: 1,              // ring outer radius in world units
  spin: 0.5,            // rad/s around Y (none with reduced motion)
  glow: true,           // soft cyan halo behind the mark
});
```
`{ group, kind: 'logo', finish, spin(radPerSec), setFinish(finish), ready: Promise, dispose() }`. The mark is the favicon's four-segment ring with a four-point star whose tips point at the four gaps, extruded with rounded bevels. It turns slowly with a gentle bob; the wordmark sways but does not spin. `ready` resolves when the wordmark font has loaded (immediately if `wordmark: false`). Note: unlike the other objects, the logo's origin is its **centre**, not its base.

## createSky(options) → Sky

```js
const sky = N.createSky({ stars: true, time: 18.2 });   // stage background 'sky' creates one for you as stage.sky
sky.setTime(18.2);
```
`{ mesh, kind: 'sky', hours, sun, night, colors: { top, mid, horizon } (THREE.Color), sunDirection: Vector3, moonDirection: Vector3, setTime(hours), setFlat(color), dispose() }`. `sun` is the sun's elevation 0–1 (0 at night) and `night` is 0–1. `sunDirection` and `moonDirection` are unit vectors in world space pointing towards where the sun and moon are drawn (behind the scene; negative y when set), so you can place a light or a glow sprite with `dir.clone().multiplyScalar(60).add(camera.position)`. The stage's rim light follows whichever of the two is up. A full-screen backdrop (fixed to the camera, like a painted sky): a 3-stop gradient that follows `SKY_KEYS`, displayed **exactly** in the DESIGN.md colours (pre-compensated for ACES tone mapping). It has a sun disc and glow on a day arc (6 AM to 6 PM), a shaded moon at night, sparse twinkling stars that fade in after dusk, and dithering against banding. Only the sun and moon discs bloom; the sky itself never does.

---

## enableDrag(stage, handles, options) → Drag

```js
const drag = N.enableDrag(stage, [pillA, pillB, paper], {
  plane: 'screen',          // 'screen' (moves parallel to the view) | 'floor' (slides on y = floorY + lift)
  floorY: 0,
  lift: 0.35,               // how far the object rises / comes forward when picked up (units)
  targets: [{
    object: echo.cameraDot, // any Object3D (or a handle)
    radius: 120,            // CSS px around the target's projected position
    present: true,          // on drop, glide in front of the target, hold, then return home
    holdMs: 1400,
    distance: 1.1,          // how far in front of the target the object is presented (units)
    offsetY: -0.15,         // where the object's centre is held relative to the target's height (units)
    turn: 0.35,             // 0 = keep facing the viewer … 1 = label turned fully towards the target (default 0 for paper, 0.35 otherwise)
    onEnter: (handle, target) => {},
    onLeave: (handle, target) => {},
    onDrop:  (handle, target) => {},   // fires on release over the target; return false to skip the present animation
  }],
  onDragStart: (handle) => {},
  onDragEnd:   (handle, target /* or null */) => {},
  returnHome: true,         // spring back to where it started after release
});
```
| member | |
|---|---|
| `drop(handle, targetIndex = 0)` | runs the whole pick-up → onEnter → onDrop → present → return sequence without a pointer (keyboard access, scripted demo). Returns a Promise that resolves once the object is home |
| `add(handle)` | make another handle draggable |
| `setHome(handle, [x,y,z]?)` | set the rest position (defaults to the current position) |
| `setEnabled(bool)` | |
| `dispose()` | |

Motion is a spring with inertia and a velocity tilt. While a held object is inside a target radius, it is drawn towards the target, `onEnter` fires and the object glows cyan (`setHighlight`). The cursor shows `grab`/`grabbing`. Dragging takes priority over orbit and the carousel when the pointer starts on a draggable object. The container gets `touch-action: none` (unless you set one).

## enableOrbit(stage, object, options) → Orbit

```js
const orbit = N.enableOrbit(stage, echo, {
  maxYaw: 0.45, maxPitch: 0.18,   // radians (soft limits)
  springBack: true,               // ease back to the rest pose on release
  hover: true,                    // gentle tilt towards the cursor (max 4°) when not dragging
  anywhere: false,                // true: a drag anywhere on the container turns the object, not only on it
});
```
`{ setEnabled(bool), reset(), dispose() }`. Drag to turn, with inertia. It never conflicts with drag or with HTML screens: pointer events that start on an attached screen go to the HTML.

## createArcCarousel(stage, items, options) → Carousel

```js
const car = N.createArcCarousel(stage, [
  { title: 'Speaks first', subtitle: '6:00 PM · Metformin', time: '18:00', color: N.COLORS.amber,
    image: '/samples/pill-metformin.png',        // optional image in the middle of the card
    canvasDraw: (ctx, w, h) => {},              // optional: draw the whole card face yourself (2D canvas, w×h px, on the card background)
    object: pill },                              // optional: a handle / Object3D floating in front of the card (it turns slowly)
], {
  radius: 9, spacing: 0.42,        // arc radius (units) and angle between cards (rad)
  cardWidth: 2.6, cardHeight: 3.6,
  position: [0, 1.6, 0],           // centre of the front card
  keyboard: true,                  // ← → to move, Enter to select (ignored while typing, or when less than half the stage is on screen)
  wheel: true,                     // true: wheel or trackpad in either axis (prevents page scroll over the stage) | 'horizontal': only deltaX
  drag: true,
  onChange: (index, item) => {},   // the front card changed
  onSelect: (index, item) => {},   // the front card was clicked or Enter was pressed
});
```
`{ group, index, select(i, { instant }), next(), prev(), redraw(), setEnabled(bool), dispose() }`. The carousel **adds itself** to the stage; move it with `car.group`. Call `redraw()` to repaint the card faces once the page's web fonts have loaded (it also repaints automatically on `document.fonts.ready`). Arcmarumo-style: cards stand on a convex arc that recedes into depth, and the front card is lit and edged in its colour, with mono labels and serif titles (fonts come from the page: load Instrument Serif and JetBrains Mono). Arrow keys, wheel and drag (with snap and fling) rotate it, and clicking a side card brings it to the front.

## screenFrame(container = document.body, options) → Frame

```js
const frame = N.screenFrame(document.body, { bezel: true, glare: true, scanlines: true, grain: true, vignette: true, radius: 28, thickness: 12, chin: 40, intensity: 1 });
```
`{ el, set(options), setEnabled(bool), dispose() }`. A fixed, full-viewport, `pointer-events: none` overlay (`z-index: 2147483000`) that makes the whole page read as a physical glowing screen: a black bezel with rounded inner corners and a faint cyan edge, curved-glass vignette and glare, fine scanlines and animated film grain. It uses plain alpha compositing only (no blend modes), so its GPU cost is close to zero. The grain stops animating with reduced motion. `thickness` (side and top bezel) defaults to 12px (6px under 720px wide); `chin` is a deeper bottom bezel in px, like a monitor's chin (defaults to `thickness`).

---

## Converging with the landing's local copy
`site/nova3d-local.js` added `screenFrame({ chin })`, `createStage({ environment: false })`, `stage.compileAsync()`, `sky.moonDirection` (plus `sky.sun`) and `carousel.group` / `carousel.redraw()`. All of these now exist in the shared library with the same names, so `site3d.js` can switch its import to `/static/three/nova3d.js`. One difference to check when switching: the shared sky is a camera-fixed backdrop drawn in the exact DESIGN.md colours, and its sun and moon directions describe that backdrop.

## Reduced motion
When `prefersReducedMotion()` is true: no auto-spin or bob on the logo, gentler light-bar animation (no sweep, slow fades), no star twinkle, instant `flyTo`, stiffer springs without tilt, carousel moves without fling, no hover tilt, and static grain. All interactions still work.

## Performance
- Measured in the gallery (everything on screen at once, 1920×1080, DPR 1) on an **Intel UHD integrated GPU** while the machine was under heavy load: about 40 fps in high quality and about 60 fps in low. The biggest costs, in order: physical transmission on the amber bottles, bloom, then the two live HTML screens. A mid-range discrete GPU holds 60 fps in high.
- DPR is capped at 1.75 (1 in low). The canvas itself has no MSAA or depth buffer; the scene renders into one half-float MSAA target, and a single final pass applies bloom, ACES, sRGB and the fx. Bloom runs at quarter resolution, and the transmission pass at half resolution.
- No real-time shadow maps: contact shadows are blurred textured planes. One PMREM studio environment is shared per renderer.
- `quality: 'auto'` measures frames 40–160 and drops to `low` once if they average over 22 ms. Listen with `stage.on('quality', …)`.
- The loop pauses while the tab is hidden and (with `autoPause`) while the container is off-screen.

## Known limitations
- Attached HTML screens are DOM, not textures: post effects (bloom, grain from `fx`) never blur or tint them. The bloom and glass glare are added on top of them, though.
- Text in an attached screen is crisp when the device faces the camera; at steep angles Chrome rasterises the layer at one scale, so it softens slightly.
- `fit: 'cover'` with a different aspect than the glass clips the overflow; prefer the recommended `pxWidth × pxHeight` ratio.
- The sky is a backdrop fixed to the camera (the sun and moon don't move with camera rotation).
- In `background: 'transparent'`, glass (the glass logo, and the amber bottles in high quality) refracts a neutral grey instead of the page behind it, because WebGL can't see the DOM.
