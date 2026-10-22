// Nova Studio · the WebGL stage.
// Built on the shared library (/static/three/nova3d.js). One focal point at a time: by default only
// the two Echo Shows, large, on a satin counter; a small Ring doorbell at the far left; the things to
// show Alexa rise onto a shelf only when asked for. The live device screens (conversation, MCP App
// iframes, announcements, consent) are the same DOM elements app.js drives, attached to the 3D glass
// with CSS3D. Throws if WebGL is unavailable; app.js then keeps the 2D layout.

import * as THREE from "three";
import * as N from "/static/three/nova3d.js";

const RING_MAP = { idle: "idle", listening: "listening", thinking: "thinking", speaking: "speaking" };
const FOV = 28;
const X = 3.3;                                  // devices sit at x = ±X: the centres of the two halves
const FILL8 = 0.36;                             // the most of the view width Rose's Echo Show 8 may take
const S15_PER_S8 = (0.4 / 4.02) / (0.36 / 2.0); // Maya's Show 15 scale relative to Rose's: similar heights
const MAYA_BOOST = 1.12;                        // ...and she may be a little bigger (it is the bigger screen)
const BAR = 58;                                 // the glass bar's bottom edge
const EDGE = 16;                                // side gutter
const RING_EDGE = 72;                           // the doorbell keeps clear of the frame's corner marks
// Local bounding boxes (world units, origin at the bottom centre), from the library's real sizes.
const BOX = {
  show8: { x: 1.0, y0: 0, y1: 1.37, z0: -0.57, z1: 0.47 },
  show15: { x: 2.01, y0: 0, y1: 2.66, z0: -0.72, z1: 0.5 },
  ring: { x: 0.31, y0: 0, y1: 1.36, z0: -0.23, z1: 0.23 },
};
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => 1 - Math.pow(1 - t, 4);

export async function mount3d(ctx) {
  const { devices, samples, clock, hourOf, scanSample, toast } = ctx;
  if (!N.isWebGLAvailable()) { const e = new Error("Nova3D: WebGL unavailable"); e.code = "NO_WEBGL"; throw e; }
  const host = document.getElementById("scene3d");
  const reduced = N.prefersReducedMotion();

  performance.mark("nova:stage-start");
  const stage = N.createStage(host, {
    background: "sky", bloom: true, css3d: true, quality: "auto", fov: FOV, autoStart: false,
    camera: [0, 2.6, 16], target: [0, 1.2, 0], timeOfDay: hourOf(clock.now()),
    fx: { grain: 0.022, vignette: 0.24, scanlines: 0.04, aberration: 0.1 },
  });
  const tmpV = new THREE.Vector3();
  const rose = [...devices.values()].find((d) => d.role === "elder") || devices.get("kitchen");
  const maya = [...devices.values()].find((d) => d.role !== "elder") || devices.get("maya");
  const echoes = new Map(); // device id -> { echo, holder, base, flip, device, box }
  let focusId = null;

  /* ---- world: a long satin counter that runs out of frame at the front and sides -- */
  // Only its back edge shows, as a soft line behind the devices; the captions sit on its dark top.
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(80, 0.3, 40),
    new THREE.MeshPhysicalMaterial({ color: "#08080b", roughness: 0.62, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.45, envMapIntensity: 0.12 }),
  );
  counter.position.set(0, -0.15, 20 - 2.0); // back edge at z = -2
  counter.raycast = () => {};
  stage.scene.add(counter);
  // a hairline of light along the back edge (the counter's bevel catching the sky)
  const edgeLine = new THREE.Mesh(
    new THREE.BoxGeometry(80, 0.012, 0.012),
    new THREE.MeshBasicMaterial({ color: "#8a93a8", transparent: true, opacity: 0.22, toneMapped: false }),
  );
  edgeLine.position.set(0, 0.002, -2.0);
  edgeLine.raycast = () => {};
  stage.scene.add(edgeLine);

  function placeEcho(device, x, ry) {
    if (!device) return;
    const echo = N.createEchoShow({ size: device.model === "show15" ? 15 : 8, color: "charcoal", mount: "stand", shadow: true });
    const holder = new THREE.Group();
    holder.position.set(x, 0, 0);
    holder.rotation.y = ry;
    stage.scene.add(holder);
    stage.add(echo);
    holder.add(echo.group);
    const el = device.ui.screen;
    el.style.setProperty("--scale", "1");
    el.style.setProperty("--lw", `${device.size.w}px`);
    el.style.setProperty("--lh", `${device.size.h}px`);
    echo.attachScreen(el, { pxWidth: device.size.w, pxHeight: device.size.h, fit: "cover", className: `screen-host ${device.model}` });
    echo.setRing("idle");
    N.enableOrbit(stage, echo, { maxYaw: 0.44, maxPitch: 0.17, springBack: true, hover: !reduced });
    echoes.set(device.id, { echo, holder, base: ry, flip: { cur: 0, to: 0, v: 0 }, device, box: BOX[device.model] || BOX.show8 });
  }
  performance.mark("nova:stage-created");
  placeEcho(rose, -X, 0.07);
  placeEcho(maya, X, -0.06);
  let s8 = (FILL8 * 4 * X) / 2.0, s15 = s8 * S15_PER_S8;
  const setScales = () => {
    for (const e of echoes.values()) e.holder.scale.setScalar(e.device.model === "show15" ? s15 : s8);
  };
  setScales();

  // Rose's front door: a small Ring doorbell on a plinth at the far left
  const ringGroup = new THREE.Group();
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.46),
    new THREE.MeshPhysicalMaterial({ color: "#1c1d22", roughness: 0.5, clearcoat: 0.3, envMapIntensity: 0.5 }));
  plinth.position.y = 0.04;
  plinth.raycast = () => {};
  ringGroup.add(plinth);
  const ring = N.createRingDoorbell({ finish: "nickel", shadow: true });
  ring.group.position.y = 0.08;
  stage.add(ring);
  ringGroup.add(ring.group);
  ringGroup.rotation.y = 0.28;
  stage.scene.add(ringGroup);
  ring.setRing("idle");

  /* ---- the shelf: things to show Alexa (hidden until asked for) ------------- */
  const HIDDEN_Y = -60;
  let things = [], pillThings = [], docThings = [], drag = null, thingsBuilt = false;
  const pending = [...samples];
  function buildThing(s) {
    const doc = s.kind === "document";
    const h = doc
      ? N.createPaper({ texture: s.url, id: String(s.id || s.url), curl: 0.12, pose: "upright" })
      : N.createPillBottle({ label: s.url, id: String(s.id || s.url) });
    h.sample = s;
    h.kind3d = doc ? "document" : "pill";
    h.natH = doc ? 2.79 : 0.95;
    h.group.position.set(0, HIDDEN_Y, 0);
    h.group.visible = false;
    stage.add(h);
    things.push(h);
  }
  function finishThings() {
    if (thingsBuilt) return;
    thingsBuilt = true;
    pillThings = things.filter((h) => h.kind3d === "pill").slice(0, 4);
    docThings = things.filter((h) => h.kind3d === "document").slice(0, 1);
    drag = things.length ? N.enableDrag(stage, things, { plane: "screen", lift: 0.3, targets, returnHome: true }) : null;
  }
  // On demand: build whatever is left right now.
  function ensureThings() {
    while (pending.length) buildThing(pending.shift());
    finishThings();
  }
  // In idle time: one object per idle slice, so building them never stalls a frame for long.
  function buildThingsIdle() {
    return new Promise((resolve) => {
      const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 60));
      const step = () => {
        if (thingsBuilt) { resolve(); return; }
        if (pending.length) buildThing(pending.shift());
        if (!pending.length) { finishThings(); resolve(); return; }
        idle(step, { timeout: 1500 });
      };
      idle(step, { timeout: 1500 });
    });
  }
  const shelfAnims = new Map(); // handle -> { from, to, t, ms, hideAfter }
  let shelfKind = null;

  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane();
  // The host can be scaled by CSS (the inspector drawer, the scroll recede): convert client px to its own px.
  const frameOf = () => {
    const r = host.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / Math.max(1, host.clientWidth) || 1 };
  };
  const lx = (f, x) => (x - f.left) / f.k, ly = (f, y) => (y - f.top) / f.k;
  const ndc = (px, py) => new THREE.Vector2((px / host.clientWidth) * 2 - 1, -(py / host.clientHeight) * 2 + 1);
  // World point under a host-pixel position, on a vertical plane `depth` units in front of the camera.
  function worldAt(px, py, depth) {
    ray.setFromCamera(ndc(px, py), stage.camera);
    const n = new THREE.Vector3();
    stage.camera.getWorldDirection(n);
    n.y = 0;
    n.normalize();
    plane.setFromNormalAndCoplanarPoint(n.clone().negate(), stage.camera.position.clone().addScaledVector(n, depth));
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }
  // World x under a host-pixel position, on the plane z = zPlane.
  function worldXAt(px, py, zPlane) {
    ray.setFromCamera(ndc(px, py), stage.camera);
    plane.set(new THREE.Vector3(0, 0, 1), -zPlane);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out.x : 0;
  }
  // Shelf poses for one device's things: a row on the drawer's line, under that device.
  function shelfPoses(kind) {
    const list = kind === "pill" ? pillThings : docThings;
    const W = host.clientWidth, H = host.clientHeight, f = frameOf();
    const dev = kind === "pill" ? rose : maya;
    const r = dev ? api.rectOf(dev.id) : null;
    const cx = r ? lx(f, (r.left + r.right) / 2) : W / 2;
    const lineY = H - 57;
    const gapPx = kind === "pill" ? 96 : 0;
    const depth = stage.camera.position.z * 0.55;
    return list.map((h, i) => {
      const px = cx + (i - (list.length - 1) / 2) * gapPx;
      const base = worldAt(px, lineY, depth);
      const top = worldAt(px, lineY - (kind === "pill" ? 116 : 126), depth);
      if (!base || !top) return null;
      return { h, pos: base, scale: Math.max(0.03, (top.y - base.y) / h.natH), ry: kind === "pill" ? (i - (list.length - 1) / 2) * 0.16 : -0.12 };
    }).filter(Boolean);
  }
  const hide = (h) => { h.group.visible = false; h.group.position.set(0, HIDDEN_Y, 0); drag?.setHome(h, [0, HIDDEN_Y, 0]); };
  const shelf = {
    openShelf(kind) {
      ensureThings();
      shelf.closeShelf(true);
      shelfKind = kind;
      for (const p of shelfPoses(kind)) {
        p.h.group.visible = true;
        p.h.group.scale.setScalar(p.scale);
        p.h.group.rotation.set(0, p.ry, 0);
        p.h.group.position.copy(p.pos).add(new THREE.Vector3(0, -1.3 * p.scale * p.h.natH, 0));
        shelfAnims.set(p.h, { from: p.h.group.position.clone(), to: p.pos.clone(), t: reduced ? 1 : 0, ms: 760 });
        drag?.setHome(p.h, p.pos.toArray());
      }
    },
    closeShelf(instant = false) {
      if (!shelfKind) return;
      const list = shelfKind === "pill" ? pillThings : docThings;
      shelfKind = null;
      for (const h of list) {
        if (instant || reduced) { shelfAnims.delete(h); hide(h); continue; }
        const to = h.group.position.clone().add(new THREE.Vector3(0, -1.6 * h.group.scale.x * h.natH, 0));
        shelfAnims.set(h, { from: h.group.position.clone(), to, t: 0, ms: 520, hideAfter: true });
      }
    },
  };

  /* ---- drag to scan --------------------------------------------------------- */
  let pendingScan = null;
  const onDrop = (h, device) => {
    if (h.kind3d !== device.visionKind) {
      toast(h.kind3d === "pill" ? "Show pill bottles to Rose's Echo" : "Show the paperwork to Maya's Echo");
      return false;
    }
    if (device.busy) { toast(`${device.shortName}'s Echo Show is busy`); return false; }
    pendingScan = scanSample(device, h.sample);
    setTimeout(() => ctx.onDropScan?.(), 2100); // the drawer closes once the object has been presented
    return true;
  };
  const hint = (device, on) => device?.el.classList.toggle("drop-over", on);
  const targets = [rose, maya].filter(Boolean).map((device) => ({
    object: echoes.get(device.id).echo.cameraDot, radius: 160, present: true, holdMs: 1200,
    onEnter: () => hint(device, true), onLeave: () => hint(device, false),
    onDrop: (h) => { hint(device, false); return onDrop(h, device); },
  }));

  /* ---- click a device to focus it; click the doorbell for its menu ---------- */
  let down = null;
  host.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  host.addEventListener("pointerup", (e) => {
    const d0 = down;
    down = null;
    if (!d0 || Math.hypot(e.clientX - d0.x, e.clientY - d0.y) > 5 || performance.now() - d0.t > 450) return;
    if (e.target.closest?.(".screen, .back3d, button, input, a, iframe")) return; // a click on the live screen, not the hardware
    const hit = stage.pick(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.handle === ring) { ctx.onRingClick?.(); return; }
    for (const [id, en] of echoes) if (hit.handle === en.echo) { ctx.onDeviceClick?.(id); return; }
  });

  /* ---- per frame: clock, flips, shelf motion, overlays ---------------------- */
  const backLayer = document.getElementById("backLayer");
  const backs = new Map();
  for (const d of [rose, maya]) {
    const panel = d?.el.querySelector(".back-panel");
    if (!panel) continue;
    const wrap = document.createElement("div");
    wrap.className = "back3d";
    wrap.dataset.device = d.id;
    wrap.append(panel);
    backLayer.append(wrap);
    backs.set(d.id, wrap);
  }
  let hudUntil = 0, frameNo = 0;
  stage.onFrame((dt) => {
    if (frameNo < 3) performance.mark(`nova:frame${++frameNo}`);
    stage.setTimeOfDay(hourOf(clock.now()));
    for (const [id, e] of echoes) {
      const f = e.flip;
      if (reduced) f.cur = f.to;
      else { f.v += (f.to - f.cur) * 0.07; f.v *= 0.78; f.cur += f.v; if (Math.abs(f.to - f.cur) < 0.0005 && Math.abs(f.v) < 0.0005) f.cur = f.to; }
      e.holder.rotation.y = e.base + f.cur;
      const wrap = backs.get(id);
      if (wrap) {
        const show = f.to > 0 && f.cur > Math.PI * 0.62 && e.holder.visible;
        wrap.classList.toggle("show", show);
        if (show) positionOver(wrap, api.rectOf(id), 0.02);
      }
    }
    for (const [h, a] of shelfAnims) {
      a.t = Math.min(1, a.t + (dt * 1000) / a.ms);
      h.group.position.lerpVectors(a.from, a.to, ease(a.t));
      if (a.t >= 1) { shelfAnims.delete(h); if (a.hideAfter) hide(h); }
    }
    if (performance.now() < hudUntil) layoutHud();
  });
  function positionOver(el, r, pad = 0) {
    if (!r) return;
    const f = frameOf(), w = r.width / f.k, h = r.height / f.k;
    el.style.left = `${lx(f, r.left) - w * pad}px`;
    el.style.top = `${ly(f, r.top) - h * pad}px`;
    el.style.width = `${w * (1 + 2 * pad)}px`;
    el.style.height = `${h * (1 + 2 * pad)}px`;
  }

  /* ---- framing --------------------------------------------------------------- */
  const setCam = (opts) => {
    stage.setCamera(opts);
    stage.camera.updateMatrixWorld(true);
    stage.scene.updateMatrixWorld(true);
  };
  // Projected box (host px) of an object's local bounding box.
  function pxBox(obj, b) {
    obj.updateMatrixWorld(true);
    const f = frameOf();
    let l = Infinity, t = Infinity, r = -Infinity, bt = -Infinity;
    for (const x of [-b.x, b.x]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) {
      tmpV.set(x, y, z).applyMatrix4(obj.matrixWorld);
      const p = stage.project(tmpV);
      l = Math.min(l, p.x); r = Math.max(r, p.x); t = Math.min(t, p.y); bt = Math.max(bt, p.y);
    }
    return { left: lx(f, l), top: ly(f, t), right: lx(f, r), bottom: ly(f, bt), width: (r - l) / f.k, height: (bt - t) / f.k };
  }
  const toClient = (b) => {
    const f = frameOf();
    return { left: f.left + b.left * f.k, top: f.top + b.top * f.k, right: f.left + b.right * f.k, bottom: f.top + b.bottom * f.k, width: b.width * f.k, height: b.height * f.k };
  };
  const hudH = () => Math.max(150, ...[rose, maya].filter(Boolean).map((d) => d.el.offsetHeight || 0));
  const floorPx = () => host.clientHeight - hudH() - 34 - 22; // where the devices stand
  const ringSlot = document.getElementById("ringSlot");
  const labelW = () => Math.max(60, ringSlot?.querySelector(".ring-mini")?.offsetWidth || 96);
  let ringW = 56; // the doorbell's on-screen width, measured when placed
  const ringZone = () => RING_EDGE + Math.max(ringW, labelW() * 0.5) + 26; // the far-left column the Ring owns
  const nudge = (ty, d, errPx, H) => clampN(ty - (errPx / H) * 2 * d * Math.tan((FOV * Math.PI) / 360) * 0.9, -8, 10);

  // Default: Rose centred in the left half, Maya in the right half, both standing on the counter
  // above their controls; Rose sized to leave the far-left column to the Ring.
  function solveDefault() {
    const W = host.clientWidth, H = host.clientHeight, f = frameOf();
    const floor = floorPx();
    const pos = (d, ty) => ({ position: [0, ty + 1.15, d], target: [0, ty, 0] });
    let d = 16, ty = 1.2;
    s8 = (FILL8 * 4 * X) / 2.0;
    s15 = s8 * S15_PER_S8 * MAYA_BOOST;
    for (const e of echoes.values()) e.holder.position.x = e.device === rose ? -X : X;
    setScales();
    // camera: x = ±X lands on the half centres; the floor line lands on `floor`
    for (let i = 0; i < 30; i++) {
      setCam(pos(d, ty));
      const px = lx(f, stage.project(tmpV.set(X, 0, 0)).x);
      d = clampN(d * ((px - W / 2) / (W / 4)), 5, 80);
      setCam(pos(d, ty));
      const fy = ly(f, stage.project(tmpV.set(0, 0, 0)).y);
      ty = nudge(ty, d, fy - floor, H);
    }
    setCam(pos(d, ty));
    // each screen centred on its half
    const centre = () => {
      for (const e of echoes.values()) {
        const r = api.rectOf(e.device.id);
        const want = e.device === rose ? W / 4 : (3 * W) / 4;
        const have = lx(f, (r.left + r.right) / 2), y = ly(f, (r.top + r.bottom) / 2);
        e.holder.position.x += worldXAt(want, y, 0) - worldXAt(have, y, 0);
        e.holder.updateMatrixWorld(true);
      }
    };
    placeRing();
    // size: Rose clears the Ring's column and the middle, Maya the middle and the right edge, both the bar
    const fit = (e, minLeft, maxRight) => {
      if (!e) return 1;
      const b = pxBox(e.holder, e.box), cx = (b.left + b.right) / 2, half = b.width / 2;
      return Math.min(1, (cx - minLeft) / half, (maxRight - cx) / half, (floor - BAR - 44) / Math.max(1, b.height));
    };
    const zone = ringZone();
    const er = rose && echoes.get(rose.id), em = maya && echoes.get(maya.id);
    for (let pass = 0; pass < 8; pass++) {
      centre();
      const fr = fit(er, zone, W / 2 - 28), fm = fit(em, W / 2 + 28, W - EDGE - 28);
      if (fr >= 0.998 && fm >= 0.998) break;
      s8 *= clampN(fr, 0.3, 1);
      s15 = Math.min(s15 * clampN(fm, 0.3, 1), s8 * S15_PER_S8 * MAYA_BOOST);
      setScales();
    }
    centre();
    // stand them exactly on the floor line (their front feet, not their origin)
    for (let i = 0; i < 8; i++) {
      const err = Math.max(...[...echoes.values()].map((e) => pxBox(e.holder, e.box).bottom)) - floor;
      if (Math.abs(err) < 0.5) break;
      ty = nudge(ty, d, err, H);
      setCam(pos(d, ty));
    }
    centre();
    return pos(d, ty);
  }
  // Focus: dolly toward one device so it becomes the single subject.
  function solveFocus(id) {
    const e = echoes.get(id);
    const W = host.clientWidth, H = host.clientHeight;
    const cx = e.holder.position.x;
    const floor = floorPx();
    const pos = (d, ty) => ({ position: [cx, ty + 0.9, d], target: [cx, ty, 0] });
    let d = 12, ty = 1.2;
    for (let i = 0; i < 40; i++) {
      setCam(pos(d, ty));
      const b = pxBox(e.holder, e.box);
      d = clampN(d * Math.max(b.width / (W * 0.64), b.height / (floor - BAR - 48)), 3, 80);
      setCam(pos(d, ty));
      ty = nudge(ty, d, pxBox(e.holder, e.box).bottom - floor, H);
    }
    setCam(pos(d, ty));
    return pos(d, ty);
  }
  // In focus only the focused device is on stage; everything else steps away after the dolly.
  function showOthers(on) {
    for (const [id, e] of echoes) e.holder.visible = on || id === focusId;
    ringGroup.visible = on;
  }
  let current = null; // the camera pose we are at (or flying to)
  let flight = 0;
  function frame({ animate = false } = {}) {
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    if (Math.abs(stage.camera.aspect - W / H) > 0.001) stage.resize();
    const from = current;
    let goal;
    if (focusId && echoes.has(focusId)) goal = solveFocus(focusId);
    else { goal = solveDefault(); placeRing(); }
    current = goal;
    const id = ++flight;
    if (!focusId) showOthers(true);
    if (animate && from && !reduced) {
      setCam(from); // solving moved the camera; start the flight from where we were
      hudUntil = performance.now() + 1400;
      stage.flyTo(goal, { duration: 1.1 }).then(() => {
        if (id !== flight) return;
        if (focusId) showOthers(false);
        layoutHud();
        ctx.onFramed?.();
      });
    } else {
      setCam(goal);
      if (focusId) showOthers(false);
      layoutHud();
      ctx.onFramed?.();
    }
  }
  // The doorbell stands in the far-left column, RING_EDGE from the frame, about a quarter of Rose's height.
  function placeRing() {
    const er = rose && echoes.get(rose.id);
    if (!er) return;
    const floor = floorPx();
    const want = clampN(pxBox(er.holder, er.box).height * 0.26, 64, 104);
    ringGroup.scale.setScalar(1);
    ringGroup.position.set(worldXAt(RING_EDGE + 30, floor, 0.25), 0, 0.25);
    for (let i = 0; i < 4; i++) {
      const b = pxBox(ringGroup, BOX.ring);
      ringGroup.scale.multiplyScalar(clampN(want / Math.max(1, b.height), 0.2, 5));
    }
    for (let i = 0; i < 3; i++) {
      const b = pxBox(ringGroup, BOX.ring);
      ringGroup.position.x += worldXAt(RING_EDGE, floor, 0.25) - worldXAt(b.left, floor, 0.25);
      ringGroup.updateMatrixWorld(true);
    }
    ringW = pxBox(ringGroup, BOX.ring).width;
  }

  function layoutHud() {
    const W = host.clientWidth, f = frameOf();
    for (const d of [rose, maya]) {
      if (!d) continue;
      const r = api.rectOf(d.id);
      if (!r) continue;
      const focused = focusId === d.id;
      const rw = r.width / f.k;
      const w = focused ? clampN(rw * 0.8, 420, Math.min(680, W * 0.5)) : clampN(rw, 340, Math.min(640, W * 0.44));
      const cx = lx(f, r.left + r.width / 2);
      d.el.style.setProperty("--hud-w", `${Math.round(w)}px`);
      d.el.style.setProperty("--hud-x", `${Math.round(clampN(cx - w / 2, EDGE, W - w - EDGE))}px`);
    }
    // the Ring label sits on the counter right under the doorbell, centred on it
    if (ringSlot && ringGroup.visible) {
      const b = pxBox(ringGroup, BOX.ring);
      const x = Math.round(clampN((b.left + b.right) / 2 - labelW() / 2, EDGE, W - 160));
      ringSlot.style.setProperty("--ring-x", `${x}px`);
      ringSlot.style.setProperty("--ring-top", `${Math.round(b.bottom + 10)}px`);
      ringSlot.style.setProperty("--ring-pop-w", `${Math.round(ringZone() - EDGE - 10)}px`);
    }
  }
  stage.on("resize", () => requestAnimationFrame(() => { frame(); if (shelfKind) shelf.openShelf(shelfKind); }));

  // Compile every shader before the first frame, in parallel (KHR_parallel_shader_compile). The first
  // render would otherwise compile ~20 programs one after another and stall the page for seconds.
  async function precompile() {
    const r = stage.renderer;
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType }); // same program keys as the scene target
    const prev = r.getRenderTarget();
    let job = null;
    try {
      r.setRenderTarget(rt);
      job = r.compileAsync(stage.scene, stage.camera);
    } catch { /* the first frame compiles instead */ }
    r.setRenderTarget(prev);
    if (job) await Promise.race([job.catch(() => {}), new Promise((res) => setTimeout(res, 9000))]);
    rt.dispose();
  }
  // After the first frames: upload the shelf objects' textures and compile the back-face variants the
  // transmission pass uses, so the first "Show Alexa" opens without a hitch.
  async function prewarmThings() {
    await buildThingsIdle();
    performance.mark("nova:prewarm-built");
    const r = stage.renderer;
    const flips = [], texs = new Set();
    for (const h of things) {
      h.group.traverse((o) => {
        for (const m of o.material ? [].concat(o.material) : []) {
          for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "alphaMap", "bumpMap", "emissiveMap", "thicknessMap"]) {
            if (m[k]?.isTexture) texs.add(m[k]);
          }
          if (m.transmission > 0 && m.side === THREE.DoubleSide && !flips.includes(m)) flips.push(m);
        }
      });
    }
    // upload the label textures one per idle slice (their images load in the meantime)
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
    await new Promise((res) => setTimeout(res, 800));
    for (const t of texs) {
      await new Promise((res) => idle(res, { timeout: 1500 }));
      if (t.image) { try { r.initTexture(t); } catch { /* uploads on first use instead */ } }
    }
    performance.mark("nova:prewarm-textures");
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
    try {
      const prev0 = r.getRenderTarget();
      r.setRenderTarget(rt);
      const first = r.compileAsync(stage.scene, stage.camera);
      r.setRenderTarget(prev0);
      await Promise.race([first.catch(() => {}), new Promise((res) => setTimeout(res, 9000))]);
    } catch { /* compiled on first use instead */ }
    if (!flips.length) { rt.dispose(); return; }
    const prev = r.getRenderTarget();
    let job = null;
    try {
      for (const m of flips) { m.side = THREE.BackSide; m.needsUpdate = true; }
      r.setRenderTarget(rt);
      job = r.compileAsync(stage.scene, stage.camera);
    } catch { /* compiled on first use instead */ }
    for (const m of flips) { m.side = THREE.DoubleSide; m.needsUpdate = true; }
    r.setRenderTarget(prev);
    if (job) await Promise.race([job.catch(() => {}), new Promise((res) => setTimeout(res, 9000))]);
    rt.dispose();
    performance.mark("nova:prewarm-done");
  }

  /* ---- sky dressing --------------------------------------------------------- */
  // The library's sky is a calm gradient with a sun disc and stars. By day and at golden hour we add a
  // soft glow around the sun, a faint haze on the horizon and a few very slow clouds. All of it rides on
  // the camera at a far depth (screen-fixed, like the sky) and stays behind everything else.
  const SKY_D = 300;
  stage.scene.add(stage.camera);
  const dress = new THREE.Group();
  stage.camera.add(dress);
  const canvasTex = (w, h, paint) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    paint(c.getContext("2d"));
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const radialTex = canvasTex(256, 256, (g) => {
    const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.18, "rgba(255,255,255,.55)");
    gr.addColorStop(0.5, "rgba(255,255,255,.14)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  });
  const hazeTex = canvasTex(4, 128, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.7, "rgba(255,255,255,.55)"); gr.addColorStop(1, "rgba(255,255,255,1)");
    g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
  });
  const cloudTex = (seed) => canvasTex(512, 192, (g) => {
    let r = seed;
    const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 18; i++) {
      const x = 90 + rnd() * 332, y = 100 + (rnd() - 0.5) * 46, rad = 30 + rnd() * 50;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, "rgba(255,255,255,.42)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
  });
  const skyMat = (map, additive = false) => new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, toneMapped: false, opacity: 0,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const quad = new THREE.PlaneGeometry(1, 1);
  const sunGlow = new THREE.Mesh(quad, skyMat(radialTex, true));
  const haze = new THREE.Mesh(quad, skyMat(hazeTex));
  const clouds = [0.12, 0.43, 0.68, 0.9].map((u, i) => {
    const m = new THREE.Mesh(quad, skyMat(cloudTex(17 + i * 101)));
    m.userData = { u, v: [0.18, 0.34, 0.1, 0.26][i], w: [520, 380, 600, 420][i], speed: [3.2, 2.1, 2.6, 1.7][i] };
    return m;
  });
  for (const m of [haze, sunGlow, ...clouds]) { m.raycast = () => {}; m.renderOrder = -5; m.frustumCulled = false; dress.add(m); }
  // host px -> a point on the far plane, in camera space
  const pxToCam = (px, py, out) => {
    const W = host.clientWidth, H = host.clientHeight;
    const hh = SKY_D * Math.tan((stage.camera.fov * Math.PI) / 360), hw = hh * stage.camera.aspect;
    return out.set(((px / W) * 2 - 1) * hw, (1 - (py / H) * 2) * hh, -SKY_D);
  };
  const unitsPerPx = () => (2 * SKY_D * Math.tan((stage.camera.fov * Math.PI) / 360)) / Math.max(1, host.clientHeight);
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clampN((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const dayCol = new THREE.Color("#fff3dc"), goldCol = new THREE.Color("#ffad6b"), peach = new THREE.Color("#ffc2a1");
  let drift = 0;
  function dressSky(dt, hour) {
    const day = smooth(5.6, 7.2, hour) * (1 - smooth(18.2, 19.6, hour)); // 0 at night, 1 by day
    dress.visible = day > 0.01;
    if (!dress.visible) return;
    const W = host.clientWidth, H = host.clientHeight, k = unitsPerPx();
    const gold = Math.max(smooth(5.6, 6.6, hour) * (1 - smooth(7.2, 8.6, hour)), smooth(16.2, 17.6, hour) * (1 - smooth(19, 19.8, hour)));
    // the glow sits where the sky shader draws the sun; after sunset it lingers low on the horizon
    const sp = api.skyPoint(clampN((hour - 6) / 12, 0, 1), "day");
    pxToCam(sp.x, Math.min(sp.y, H * 0.64), sunGlow.position);
    const r = mix(420, 680, gold);
    sunGlow.scale.set(r * k, r * k, 1);
    sunGlow.material.color.copy(dayCol).lerp(goldCol, gold);
    sunGlow.material.opacity = day * mix(0.2, 0.42, gold);
    // haze along the horizon (the counter's back edge)
    const hz = ly(frameOf(), stage.project(tmpV.set(stage.camera.position.x, 0, -2)).y);
    pxToCam(W / 2, hz - 70, haze.position);
    haze.scale.set(W * 1.5 * k, 150 * k, 1);
    haze.material.color.set("#e9eef6").lerp(goldCol, gold * 0.8);
    haze.material.opacity = day * (0.16 + gold * 0.1);
    // clouds: a slow drift, white by day, peach at golden hour
    if (!reduced) drift += dt;
    for (const m of clouds) {
      const d = m.userData, span = W + d.w;
      const x = ((((d.u * span) + drift * d.speed) % span) + span) % span - d.w / 2;
      pxToCam(x, BAR + 50 + d.v * Math.max(80, hz - BAR - 220), m.position);
      m.scale.set(d.w * k, d.w * 0.37 * k, 1);
      m.material.color.set("#ffffff").lerp(peach, gold);
      m.material.opacity = day * mix(0.2, 0.28, gold);
    }
  }
  stage.onFrame((dt) => dressSky(dt, hourOf(clock.now())));

  /* ---- the API app.js uses --------------------------------------------------- */
  const api = {
    stage,
    openShelf: shelf.openShelf,
    closeShelf: shelf.closeShelf,
    setLight(id, state, tone) {
      const e = echoes.get(id);
      if (!e) return;
      e.echo.setRing(state === "notify" ? (tone === "red" ? "urgent" : tone === "yellow" ? "notify" : "listening") : RING_MAP[state] || "idle");
    },
    setLevel(id, v) { echoes.get(id)?.echo.setSpeechLevel(v > 0 ? v : null); },
    flip(id, on) { const e = echoes.get(id); if (e) e.flip.to = on ? Math.PI : 0; },
    setFocus(id) { focusId = id && echoes.has(id) ? id : null; frame({ animate: true }); },
    // client-px rectangle of a device's display (works when turned around too)
    rectOf(id) {
      const e = echoes.get(id);
      if (!e) return null;
      const { width, height } = e.echo.screen;
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        e.echo.screenAnchor.localToWorld(tmpV.set((x * width) / 2, (y * height) / 2, 0));
        const p = stage.project(tmpV);
        l = Math.min(l, p.x); r = Math.max(r, p.x); t = Math.min(t, p.y); b = Math.max(b, p.y);
      }
      return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
    },
    // client-px box of the whole device (bezel and stand); null while it's off stage
    deviceRect(id) {
      const e = echoes.get(id);
      return e && e.holder.visible ? toClient(pxBox(e.holder, e.box)) : null;
    },
    // client-px box around the doorbell (for its label and the overlap check); null while it's off stage
    ringRect() { return ringGroup.visible ? toClient(pxBox(ringGroup, BOX.ring)) : null; },
    cameraRect(id) {
      const e = echoes.get(id);
      if (!e) return null;
      e.echo.cameraDot.getWorldPosition(tmpV);
      const p = stage.project(tmpV);
      return { left: p.x - 4, top: p.y - 4, width: 8, height: 8 };
    },
    ringFlash(kind) { ring.flash(kind === "ding" ? "ding" : "motion").catch?.(() => {}); },
    // Scripted drag (NovaDemo): the sample rises from below the frame, is presented, scanned, and goes back.
    async presentSample(sample, device) {
      ensureThings();
      const h = things.find((x) => x.sample === sample || String(x.sample.id) === String(sample.id));
      const idx = device === rose ? 0 : 1;
      if (!h || !drag) return scanSample(device, sample);
      const wasOpen = shelfKind === h.kind3d;
      if (!wasOpen) {
        const poses = shelfPoses(h.kind3d);
        const pose = poses.find((p) => p.h === h) || poses[0];
        if (pose) {
          h.group.visible = true;
          h.group.scale.setScalar(pose.scale);
          h.group.rotation.set(0, pose.ry, 0);
          const below = pose.pos.clone().add(new THREE.Vector3(0, -2.2 * pose.scale * h.natH, 0));
          h.group.position.copy(below);
          drag.setHome(h, below.toArray());
        }
      }
      pendingScan = null;
      const dropped = drag.drop(h, idx);
      const t0 = Date.now();
      while (!pendingScan && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 60));
      const scan = pendingScan || scanSample(device, sample);
      const [res] = await Promise.all([scan, Promise.race([dropped, new Promise((r) => setTimeout(r, 6000))])]);
      if (!wasOpen && shelfKind !== h.kind3d) hide(h);
      return res;
    },
    // Sun/moon position on the sky, in px within the stage (same formulas as the sky shader).
    skyPoint(t, mode) {
      const W = host.clientWidth, H = host.clientHeight;
      const lerp = (a, b, q) => a + (b - a) * q;
      const sx = mode === "day" ? lerp(-0.9, 0.9, t) : lerp(-0.85, 0.85, t);
      const sy = mode === "day" ? -0.42 + 1.18 * Math.sin(Math.PI * t) : -0.3 + Math.sin(Math.PI * t);
      return { x: W * (0.5 + sx / 2), y: H * (0.5 - sy / 2) };
    },
    layout: () => { frame(); if (shelfKind) shelf.openShelf(shelfKind); },
  };

  frame();
  performance.mark("nova:compile");
  await precompile();
  performance.mark("nova:compiled");
  stage.start();
  setTimeout(() => { prewarmThings().catch(() => {}); }, 2500);
  // Render only while the stage is the page: once you scroll away it holds its last frame (the CSS
  // recede still moves it), so the GPU is free to paint the story below without dropped frames.
  let inView = true;
  const atTop = () => window.scrollY <= 4;
  const sync = () => { if (inView && atTop()) stage.start(); else stage.stop(); };
  window.addEventListener("scroll", sync, { passive: true });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      for (const en of entries) inView = en.isIntersecting;
      sync();
    }, { threshold: 0 }).observe(document.getElementById("scene"));
  }
  sync();
  return api;
}
