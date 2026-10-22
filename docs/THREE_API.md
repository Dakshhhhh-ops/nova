# Nova 3D library · API

`simulator/static/three/nova3d.js` is a single ES module. Everything is procedural (geometry, materials, CanvasTextures): no model files.
The test page `/static/three/gallery.html` shows every object with buttons for every state, so you can see how each call behaves.

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

`createStage` throws `Error('Nova3D: WebGL unavailable')` (with `err.code === 'NO_WEBGL'`) when WebGL2/WebGL is not available.

### World conventions
- **Units: 1 unit = 10 cm**, Y up. Every object is real size: Echo Show 8 is 2.0 × 1.36 units, Echo Show 15 is 4.02 × 2.52, the Ring doorbell is 0.62 × 1.28, a pill bottle is about 0.44 × 0.95, the paper is 2.16 × 2.79 (US letter).
- Every factory returns a **handle** `{ group, kind, …, dispose() }`. `group` is a `THREE.Group` whose origin is the **bottom centre** of the object (it rests on y = 0), facing **+Z** (towards the default camera). Move, rotate and scale `handle.group` freely.
- `stage.add(handle)` / `stage.remove(handle)` accept a handle or any `Object3D`. Handles added to the stage become pickable and get per-frame animation.
- Colours come from `docs/DESIGN.md` and are exported as `COLORS`.

### DOM layering inside the stage container
`createStage(container)` appends two children to `container` (which must have a size; the stage sets `position: relative` if it is `static`):

| child | z-index | pointer-events | role |
|---|---|---|---|
| `div.nova3d-css` (CSS3DRenderer) | 0 | `none`, but `auto` on each attached screen | live HTML screens |
| `canvas.nova3d-gl` (WebGL) | 1 | `none` | the 3D scene |

The WebGL canvas sits **above** the HTML screens and cuts a transparent hole exactly where each device's display is. Result: the HTML is visible only through the glass, objects passing in front of a screen (a dragged pill bottle) correctly hide it, and the light bar's bloom and the glass glare spill over the live HTML. Pointer events for the 3D scene (drag, orbit, pick, carousel) are listened to on the **container**; events over an attached screen go to the HTML. Put your own overlays as later siblings with `z-index >= 2`.

---

## Constants and helpers

```js
export const VERSION            // '1.0.0'
export const COLORS             // { ink:'#0A0B10', ink2:'#11131A', ink3:'#191C26', ivory:'#F4EEE6', paper:'#EDE5D8', nova:'#3BD1FF', amber:'#FFB547', coral:'#FF6B57', sage:'#9ED9B0' }
export const SKY_KEYS           // [[hours, [top, mid, horizon]], …] same keyframes as app.js
export const RING_STATES        // ['off','idle','listening','thinking','speaking','notify','urgent','success']
export function isWebGLAvailable()      // → boolean
export function prefersReducedMotion()  // → boolean (live media query)
export function skyAt(hours)            // → { top, mid, horizon: '#rrggbb', sun: 0..1 (elevation), night: 0..1 }
```

---

## createStage(container, options) → Stage

```js
const stage = N.createStage(container, {
  background: 'sky',        // 'sky' (living time-of-day sky) | 'transparent' (page shows through) | any CSS colour, e.g. '#0A0B10'
  bloom: true,              // bloom on emissive light bars, the sun and bright highlights only
  css3d: true,              // create the CSS3D layer used by echo.attachScreen()
  quality: 'auto',          // 'auto' | 'high' | 'low'. auto starts high and drops to low if frames are slow
  pixelRatioCap: 1.75,
  fov: 30,
  camera: [0, 1.4, 11],     // camera position
  target: [0, 0.9, 0],      // look-at point
  timeOfDay: 20.5,          // hours (0–24, float); drives the sky, sun/moon and scene lights
  exposure: 1.0,
  fx: { grain: 0.035, vignette: 0.22, scanlines: 0, aberration: 0 },  // final-pass film fx (high quality only)
  autoStart: true,          // start the render loop immediately
});
```

**Stage properties**
| property | type | |
|---|---|---|
| `scene` | `THREE.Scene` | |
| `camera` | `THREE.PerspectiveCamera` | |
| `renderer` | `THREE.WebGLRenderer` | |
| `css3d` | `CSS3DRenderer \| null` | |
| `sky` | Sky handle or `null` | present when `background === 'sky'` |
| `container`, `canvas`, `cssLayer` | `HTMLElement` | |
| `reducedMotion` | `boolean` | `prefers-reduced-motion` at creation; also updates live |
| `quality` | `'high' \| 'low'` | current |
| `time` | `number` | current time of day in hours |

**Stage methods**
| method | returns | |
|---|---|---|
| `add(handleOrObject3D)` | the argument | adds to the scene, registers for picking and animation |
| `remove(handleOrObject3D)` | | |
| `onFrame(fn(dt, elapsed))` | `unsubscribe()` | called every frame before render; `dt` in seconds (clamped to 0.1) |
| `on(event, fn)` | `unsubscribe()` | events: `'resize'` `({width, height})`, `'quality'` `({quality})`, `'time'` `({hours})` |
| `resize()` | | called automatically through a ResizeObserver on the container |
| `start()` / `stop()` | | run or pause the render loop (also pauses automatically while the tab is hidden) |
| `render()` | | render a single frame now |
| `setTimeOfDay(hours)` | | sky, sun/moon, lights and exposure follow. Smooth if you call it every frame |
| `setBackground(bg)` | | `'sky' \| 'transparent' \| color` |
| `setQuality('high' \| 'low')` | | low: DPR 1, no MSAA, no bloom, no transmission (fake glass), no fx |
| `setFx({ grain, vignette, scanlines, aberration })` | | partial update, values 0–1 |
| `setCamera({ position:[x,y,z], target:[x,y,z], fov? })` | | jump instantly |
| `flyTo({ position, target, fov? }, { duration: 1.2 })` | `Promise` | expo-out camera move (instant with reduced motion) |
| `pick(clientX, clientY, list?)` | `{ handle, object, point, distance, uv } \| null` | raycast against handles added to the stage (or only `list`). `handle` is the library handle (or the top-level Object3D you added) |
| `project(vec3OrObject3D)` | `{ x, y, visible }` | world → client pixels (viewport coordinates), handy for HTML labels |
| `dispose()` | | stops, removes the DOM layers, frees GPU memory |

---

## createEchoShow(options) → Echo

```js
const echo = N.createEchoShow({
  size: 8,                 // 8 (Echo Show 8: slanted wedge, fabric back) | 15 (Echo Show 15: slim panel)
  color: 'charcoal',       // 'charcoal' | 'glacier' (white fabric/frame)
  mount: 'stand',          // Echo Show 15 only: 'stand' | 'wall'
  shadow: true,            // soft contact shadow + light spill on the surface below
});
stage.add(echo);
echo.setRing('listening');
```

| member | |
|---|---|
| `group`, `kind: 'echo'`, `size` | |
| `setRing(state)` | `'off' \| 'idle' \| 'listening' \| 'thinking' \| 'speaking' \| 'notify' \| 'urgent' \| 'success'`. Colour and intensity cross-fade. idle: faint cyan · listening: breathing cyan · thinking: a sweeping highlight · speaking: bloom pulse from the centre · notify: amber pulse · urgent: fast coral pulse · success: steady sage |
| `ring` | current state (string) |
| `setSpeechLevel(level)` | optional 0–1 amplitude; while `speaking`, the bloom follows it instead of the built-in pulse. Pass `null` to return to the built-in pulse |
| `attachScreen(el, { pxWidth, pxHeight, fit, className })` | moves `el` into the CSS3D layer, exactly on the display glass. Returns the `CSS3DObject`. `pxWidth/pxHeight` are the CSS pixel size the element is laid out at (defaults: Show 8 → 1280×800, Show 15 → 1920×1080, the panels' native resolutions). `fit: 'cover'` (default; anything outside the glass is clipped by the bezel) \| `'contain'` \| `'stretch'`. `className` is put on a wrapper div so descendant selectors keep working (the element is re-parented). Pointer events, inputs, scrolling and iframes work on the attached element. Requires `css3d: true` |
| `detachScreen()` | removes the element from the CSS3D layer and returns it (you re-insert it wherever you like) |
| `setScreenImage(srcOrCanvasOrNull)` | shows an image URL, `<img>`, `<canvas>` or `<video>` on the display as a WebGL texture (works without CSS3D; `null` restores the dark idle glass). Call `echo.screenTexture.needsUpdate = true` after redrawing a canvas |
| `screen` | `{ width, height, aspect, pxWidth, pxHeight, mesh }`: display size in world units and the recommended CSS pixel size |
| `screenAnchor` | `Object3D` at the centre of the display, facing out of the glass |
| `cameraDot` | `Object3D` at the camera lens: use it as a drag target (`targets: [{ object: echo.cameraDot }]`) |
| `dispose()` | |

---

## createRingDoorbell(options) → Ring

```js
const ring = N.createRingDoorbell({ finish: 'nickel' /* 'nickel' | 'bronze' | 'black' */, shadow: true });
ring.flash('ding');
```
| member | |
|---|---|
| `group`, `kind: 'ring'` | |
| `setRing(state)` | `'off' \| 'idle'` (faint blue) `\| 'live'` (steady blue) |
| `flash(kind)` | `'ding'`: blue arc spins round the button (about 3 s) · `'motion'`: two blue pulses. Returns a Promise that resolves when the flash ends |
| `cameraDot` | `Object3D` at the lens |
| `button` | the button `Mesh` (pick it to fake a press) |
| `dispose()` | |

---

## createPillBottle(options) → Pill

```js
const pill = N.createPillBottle({
  label: '/samples/pill-atorvastatin.png', // the sample PNG; the label area is cropped automatically
  id: 'atorvastatin',
  crop: [250, 210, 400, 310],             // optional: label rectangle in the source image's pixels (default fits the samples)
  pills: true,                            // a few tablets visible through the amber plastic
});
```
`{ group, kind: 'pill', id, setHighlight(on: boolean), ready: Promise, dispose() }`. Amber translucent body (physical transmission in high quality, a convincing tinted fake in low), white ridged child-proof cap, paper label wrapped around the front. `ready` resolves once the label texture is loaded.

## createPaper(options) → Paper

```js
const paper = N.createPaper({ texture: '/samples/after-visit-summary.png', id: 'avs', curl: 0.12, pose: 'upright' /* | 'flat' */ });
```
`{ group, kind: 'paper', id, setHighlight(on), ready: Promise, dispose() }`. A slightly curled US-letter sheet, printed front and plain back.

## createNovaLogo(options) → Logo

```js
const logo = N.createNovaLogo({
  finish: 'chrome',     // 'chrome' | 'glass' | 'iridescent'
  core: 'star',         // 'star' (four-point star) | 'dot' (favicon dot)
  wordmark: false,      // false | 'right' | 'below': extruded "Nova" in Instrument Serif
  size: 1,              // ring outer radius in world units
  spin: 0.5,            // rad/s around Y (0 with reduced motion)
  glow: true,           // soft cyan halo behind the mark
});
```
`{ group, kind: 'logo', spin(radPerSec), setFinish(finish), ready: Promise, dispose() }`. The mark is the favicon's four-segment ring with a four-point star whose tips point at the four gaps, extruded with rounded bevels. `ready` resolves when the wordmark font is loaded (immediately if `wordmark: false`). Note: unlike other objects the logo's origin is its **centre**, not its base.

## createSky(options) → Sky

```js
const sky = N.createSky({ stars: true });   // stage.background 'sky' creates one for you as stage.sky
sky.setTime(18.2);
```
`{ mesh, kind: 'sky', setTime(hours), sunDirection: Vector3, colors: { top, mid, horizon } (THREE.Color), dispose() }`. Smooth 3-stop shader gradient that follows `SKY_KEYS`, a sun disc with glow on a day arc (6 AM to 6 PM), a moon at night, twinkling stars fading in after dusk, subtle dithering against banding.

---

## enableDrag(stage, handles, options) → Drag

```js
const drag = N.enableDrag(stage, [pillA, pillB, paper], {
  plane: 'screen',          // 'screen' (moves parallel to the view) | 'floor' (slides on y = floorY)
  floorY: 0,
  lift: 0.35,               // how far the object rises / comes forward when picked up (units)
  targets: [{
    object: echo.cameraDot, // any Object3D (or a handle)
    radius: 120,            // CSS px around the target's projected position
    present: true,          // on drop, glide to just in front of the target, hold, then return home
    holdMs: 1400,
    onEnter: (handle, target) => {},
    onLeave: (handle, target) => {},
    onDrop:  (handle, target) => {},   // return false to skip the present animation
  }],
  onDragStart: (handle) => {},
  onDragEnd:   (handle, target /* or null */) => {},
  returnHome: true,         // spring back to where it started after release
});
```
| member | |
|---|---|
| `drop(handle, targetIndex = 0)` | runs the full pick-up → present → onDrop → return animation programmatically (keyboard access, scripted demo). Returns a Promise |
| `setHome(handle, [x,y,z]?)` | set the rest position (defaults to the current position) |
| `setEnabled(bool)` | |
| `dispose()` | |

Motion is a critically damped spring with inertia and a velocity tilt. While a held object is inside a target radius, it is drawn towards the target and `onEnter` fires; the cursor shows `grab`/`grabbing`. Dragging takes priority over orbit and the carousel when the pointer starts on a draggable object.

## enableOrbit(stage, object, options) → Orbit

```js
const orbit = N.enableOrbit(stage, echo, {
  maxYaw: 0.45, maxPitch: 0.18,   // radians
  springBack: true,               // ease back to the rest pose on release
  hover: true,                    // gentle tilt towards the cursor (max 4°) when not dragging
  anywhere: false,                // true: a drag anywhere on the container turns the object, not only on it
});
```
`{ setEnabled(bool), reset(), dispose() }`. Drag to turn with inertia; it never fights with drag or with HTML screens (pointer events on an attached screen go to the HTML).

## createArcCarousel(stage, items, options) → Carousel

```js
const car = N.createArcCarousel(stage, [
  { title: 'Speaks first', subtitle: '6:00 PM · Metformin', time: '18:00', color: N.COLORS.amber,
    image: '/samples/pill-metformin.png',        // optional image on the card
    canvasDraw: (ctx, w, h) => {},              // optional: draw your own card face (2D canvas, w×h px)
    object: pill },                              // optional: a handle / Object3D floating in front of the card
], {
  radius: 9, spacing: 0.42,        // arc radius (units) and angle between cards (rad)
  cardWidth: 2.6, cardHeight: 3.6,
  position: [0, 1.6, 0],           // centre of the front card
  keyboard: true, wheel: true, drag: true,
  onChange: (index, item) => {},   // the front card changed
  onSelect: (index, item) => {},   // the front card was clicked or Enter was pressed
});
```
`{ group, index, select(i, { instant }), next(), prev(), dispose() }`. Arcmarumo-style: cards stand on a convex arc that recedes into depth, the front card is lit and edged with its colour, mono labels on every card. Arrow keys, wheel and drag (with snap) rotate it; clicking a side card brings it to the front.

## screenFrame(container = document.body, options) → Frame

```js
const frame = N.screenFrame(document.body, { bezel: true, glare: true, scanlines: true, grain: true, vignette: true, radius: 28, intensity: 1 });
```
`{ el, set(options), setEnabled(bool), dispose() }`. A fixed, full-viewport, `pointer-events: none` overlay (`z-index: 2147483000`) that makes the whole page read as a physical glowing screen: a rounded black bezel with a faint inner cyan edge, curved-glass vignette and glare, fine scanlines and animated film grain. Pure CSS + one small noise canvas; it costs almost nothing per frame. Grain stops animating with reduced motion.

---

## Reduced motion
`prefersReducedMotion()` true → no auto-spin on the logo, gentler light-bar animation (no sweep, slow fades), no star twinkle, instant `flyTo`, springs settle faster, carousel moves without inertia. All interactions still work.

## Performance
- DPR capped at 1.75 (1 in low quality). MSAA ×4 on high. Bloom runs at quarter resolution.
- No real-time shadow maps: contact shadows are blurred textured planes.
- One shared PMREM studio environment for all reflections, created once per stage.
- `quality: 'auto'` measures the first ~2 s of frames and drops to `low` if the average frame takes longer than 22 ms. Listen with `stage.on('quality', …)`.
- The loop pauses while the tab is hidden. Call `stage.stop()` when the 3D section is off-screen (an IntersectionObserver on the landing page).
