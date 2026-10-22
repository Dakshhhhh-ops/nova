/* Nova 3D, local build for the landing page.
   Implements the subset of the shared library API (docs/THREE_API.md) that the landing uses:
   createStage, createSky, createEchoShow, createPillBottle, createNovaLogo, createArcCarousel,
   enableDrag, enableOrbit, screenFrame. Same signatures, so the shared simulator/static/three/nova3d.js
   can replace this file with a one-line import change.
   Units: 1 unit = 10 cm, Y up, objects rest on y = 0 and face +Z. Glow is drawn with additive
   sprites rather than a bloom pass, so device screens can stay transparent "holes" onto live HTML. */
import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const VERSION = 'local-1.0.0';
export const COLORS = { ink: '#0A0B10', ink2: '#11131A', ink3: '#191C26', ivory: '#F4EEE6', paper: '#EDE5D8', nova: '#3BD1FF', amber: '#FFB547', coral: '#FF6B57', sage: '#9ED9B0' };
export const RING_STATES = ['off', 'idle', 'listening', 'thinking', 'speaking', 'notify', 'urgent', 'success'];
export const SKY_KEYS = [
  [0, ['#07080D', '#121833', '#1B2347']],
  [5.2, ['#07080D', '#121833', '#1B2347']],
  [6.6, ['#2A2F55', '#8D8FC4', '#F2A97E']],
  [8.2, ['#3E5A8C', '#AFC3E2', '#F6CFAE']],
  [9.4, ['#8FC0EA', '#DCEAF8', '#F6EFE6']],
  [15.8, ['#8FC0EA', '#DCEAF8', '#F6EFE6']],
  [17.6, ['#4A3A7A', '#E0708A', '#FFB27A']],
  [19.2, ['#12131F', '#2B2850', '#6B4C8F']],
  [20.7, ['#07080D', '#121833', '#1B2347']],
  [24, ['#07080D', '#121833', '#1B2347']],
];
const NIGHT_KEYS = [[0, 1], [5.2, 1], [6.8, 0.25], [8.2, 0], [17.8, 0], [19.2, 0.55], [20.7, 1], [24, 1]];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export function isWebGLAvailable() {
  try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); } catch (e) { return false; }
}
export function prefersReducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}

function keyed(keys, h) {
  h = ((h % 24) + 24) % 24;
  for (let i = 1; i < keys.length; i++) if (h <= keys[i][0]) return [keys[i - 1], keys[i], (h - keys[i - 1][0]) / ((keys[i][0] - keys[i - 1][0]) || 1)];
  return [keys[keys.length - 1], keys[keys.length - 1], 0];
}
export function skyAt(hours) {
  const [a, b, t] = keyed(SKY_KEYS, hours);
  const mix = (i) => '#' + new THREE.Color(a[1][i]).lerp(new THREE.Color(b[1][i]), t).getHexString();
  const [na, nb, nt] = keyed(NIGHT_KEYS, hours);
  const sd = sunDir(hours);
  return { top: mix(0), mid: mix(1), horizon: mix(2), sun: clamp(sd.y / 0.6, 0, 1), night: lerp(na[1], nb[1], nt) };
}
function sunDir(h, out = new THREE.Vector3()) {
  h = ((h % 24) + 24) % 24;
  const a = ((h - 6) / 12) * Math.PI;
  return out.set(-Math.cos(a) * 0.95, Math.sin(a) * 0.55, -1).normalize();
}
function moonDir(h, out = new THREE.Vector3()) {
  h = ((h % 24) + 24) % 24;
  const hm = h < 12 ? h + 24 : h;
  const a = ((hm - 18.5) / 12) * Math.PI;
  return out.set(-Math.cos(a) * 0.95, Math.sin(a) * 0.5, -1).normalize();
}

/* ---------- textures ---------- */
const texCache = {};
function radialTexture(key, stops) {
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d').createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  const ctx = c.getContext('2d'); ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return (texCache[key] = t);
}
const glowTex = () => radialTexture('glow', [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,.55)'], [0.45, 'rgba(255,255,255,.14)'], [1, 'rgba(255,255,255,0)']]);
const shadowTex = () => radialTexture('shadow', [[0, 'rgba(0,0,0,.85)'], [0.5, 'rgba(0,0,0,.42)'], [1, 'rgba(0,0,0,0)']]);
function fabricTexture() {
  if (texCache.fabric) return texCache.fabric;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#7a7a7a'; ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 4) for (let x = 0; x < 256; x += 4) {
    const v = 110 + Math.random() * 40 + ((x / 4 + y / 4) % 2 ? 18 : -18);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath(); ctx.ellipse(x + 2, y + 2, 1.8, 1.4, 0.6, 0, Math.PI * 2); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 6);
  return (texCache.fabric = t);
}
function glowSprite(color, size, opacity = 1) {
  const m = new THREE.SpriteMaterial({ map: glowTex(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const s = new THREE.Sprite(m); s.scale.set(size, size, 1); return s;
}

/* =========================================================
   STAGE
   ========================================================= */
export function createStage(container, options = {}) {
  if (!isWebGLAvailable()) { const e = new Error('Nova3D: WebGL unavailable'); e.code = 'NO_WEBGL'; throw e; }
  const o = Object.assign({ background: 'sky', css3d: true, quality: 'auto', pixelRatioCap: 1.75, fov: 30, camera: [0, 1.4, 11], target: [0, 0.9, 0], timeOfDay: 20.5, exposure: 1.0, autoStart: true, environment: true }, options);
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', premultipliedAlpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.pixelRatioCap));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = o.exposure;
  const canvas = renderer.domElement;
  canvas.className = 'nova3d-gl';
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: 1, pointerEvents: 'none', display: 'block' });

  let cssLayer = null, css3d = null;
  if (o.css3d) {
    css3d = new CSS3DRenderer();
    cssLayer = css3d.domElement;
    cssLayer.className = 'nova3d-css';
    Object.assign(cssLayer.style, { position: 'absolute', inset: '0', zIndex: 0, pointerEvents: 'none' });
    container.appendChild(cssLayer);
  }
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(o.fov, 1, 0.05, 600);
  const target = new THREE.Vector3(...o.target);
  camera.position.set(...o.camera); camera.lookAt(target);

  let envRT = null;
  if (o.environment) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.85;
    pmrem.dispose();
  }

  const hemi = new THREE.HemisphereLight(0xbcc8ff, 0x1a1410, 0.55);
  const key = new THREE.DirectionalLight(0xfff1e0, 1.4); key.position.set(-4, 7, 6);
  const rim = new THREE.DirectionalLight(0x8fb8ff, 0.7); rim.position.set(6, 3, -6);
  scene.add(hemi, key, rim);

  let sky = null;
  const stage = {
    scene, camera, renderer, css3d, container, canvas, cssLayer, sky: null,
    reducedMotion: prefersReducedMotion(), quality: 'high', time: o.timeOfDay,
    handles: new Set(), frames: new Set(), events: {},
  };
  function setBackground(bg) {
    if (bg === 'sky') {
      if (!sky) { sky = createSky({ stars: true }); scene.add(sky.mesh); stage.sky = sky; }
      sky.mesh.visible = true; renderer.setClearColor(0x000000, 1);
    } else {
      if (sky) sky.mesh.visible = false;
      if (bg === 'transparent') renderer.setClearColor(0x000000, 0);
      else renderer.setClearColor(new THREE.Color(bg), 1);
    }
  }
  stage.setBackground = setBackground;
  setBackground(o.background);

  stage.setTimeOfDay = (h) => {
    stage.time = h;
    if (sky) sky.setTime(h);
    const s = skyAt(h);
    hemi.color.set(s.mid).lerp(new THREE.Color('#ffffff'), 0.3);
    hemi.intensity = lerp(0.5, 0.9, s.sun);
    key.color.set(s.horizon).lerp(new THREE.Color('#fff4e6'), 0.5);
    key.intensity = lerp(0.9, 1.7, s.sun);
    emit('time', { hours: h });
  };
  stage.setTimeOfDay(o.timeOfDay);

  stage.add = (h) => {
    const obj = h && h.isObject3D ? h : h.group;
    scene.add(obj);
    stage.handles.add(h);
    obj.userData.__handle = h;
    if (h.__attach) h.__attach(stage);
    return h;
  };
  stage.remove = (h) => { const obj = h && h.isObject3D ? h : h.group; scene.remove(obj); stage.handles.delete(h); };
  stage.onFrame = (fn) => { stage.frames.add(fn); return () => stage.frames.delete(fn); };
  function emit(ev, data) { (stage.events[ev] || []).forEach((f) => f(data)); }
  stage.on = (ev, fn) => { (stage.events[ev] = stage.events[ev] || []).push(fn); return () => { stage.events[ev] = stage.events[ev].filter((f) => f !== fn); }; };
  stage.setCamera = ({ position, target: t, fov } = {}) => {
    if (position) camera.position.set(...position);
    if (t) target.set(...t);
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.lookAt(target);
    camera.updateMatrixWorld();
  };
  stage.getTarget = () => target.clone();
  stage.flyTo = (pose, { duration = 1.2 } = {}) => new Promise((res) => {
    const p0 = camera.position.clone(), t0 = target.clone();
    const p1 = new THREE.Vector3(...(pose.position || p0.toArray())), t1 = new THREE.Vector3(...(pose.target || t0.toArray()));
    if (stage.reducedMotion || duration <= 0) { stage.setCamera({ position: p1.toArray(), target: t1.toArray() }); res(); return; }
    const start = performance.now();
    const un = stage.onFrame(() => {
      const k = clamp((performance.now() - start) / (duration * 1000), 0, 1), e = 1 - Math.pow(1 - k, 4);
      camera.position.lerpVectors(p0, p1, e); target.lerpVectors(t0, t1, e); camera.lookAt(target);
      if (k >= 1) { un(); res(); }
    });
  });
  const _v = new THREE.Vector3();
  stage.project = (v) => {
    const p = v.isObject3D ? v.getWorldPosition(_v) : _v.copy(v);
    p.project(camera);
    const r = container.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, visible: p.z > -1 && p.z < 1 };
  };
  const ray = new THREE.Raycaster();
  stage.pick = (cx, cy, list) => {
    const r = container.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
    const hs = list ? list : Array.from(stage.handles);
    const objs = hs.map((h) => (h.isObject3D ? h : h.group));
    const hits = ray.intersectObjects(objs, true).filter((x) => x.object.visible && !x.object.userData.noPick);
    if (!hits.length) return null;
    let ob = hits[0].object;
    while (ob && !ob.userData.__handle) ob = ob.parent;
    return { handle: ob ? ob.userData.__handle : null, object: hits[0].object, point: hits[0].point, distance: hits[0].distance, uv: hits[0].uv };
  };
  stage.raycaster = ray;

  let w = 1, h = 1;
  stage.resize = () => {
    const r = container.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    if (css3d) css3d.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    emit('resize', { width: w, height: h });
  };
  const ro = new ResizeObserver(() => { stage.resize(); if (!running) stage.render(); });
  ro.observe(container);
  stage.resize();

  let running = false, raf = 0, last = performance.now(), elapsed = 0;
  stage.render = () => {
    renderer.render(scene, camera);
    if (css3d) css3d.render(scene, camera);
  };
  function loop(now) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000); last = now; elapsed += dt;
    stage.frames.forEach((f) => f(dt, elapsed));
    stage.handles.forEach((hd) => hd.update && hd.update(dt, elapsed, stage));
    if (sky) sky.tick(elapsed);
    stage.render();
  }
  stage.start = () => { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(loop); };
  stage.stop = () => { running = false; cancelAnimationFrame(raf); };
  stage.isRunning = () => running;
  // compile every material's shaders without blocking the main thread (KHR_parallel_shader_compile)
  stage.compileAsync = () => (renderer.compileAsync ? renderer.compileAsync(scene, camera).catch(() => null) : Promise.resolve());
  document.addEventListener('visibilitychange', () => { if (document.hidden && running) { cancelAnimationFrame(raf); } else if (!document.hidden && running) { last = performance.now(); raf = requestAnimationFrame(loop); } });
  stage.setQuality = (q) => { stage.quality = q; renderer.setPixelRatio(q === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, o.pixelRatioCap)); stage.resize(); emit('quality', { quality: q }); };
  stage.setFx = () => {};
  stage.dispose = () => {
    stage.stop(); ro.disconnect();
    stage.handles.forEach((hd) => hd.dispose && hd.dispose());
    if (envRT) envRT.dispose(); renderer.dispose();
    canvas.remove(); if (cssLayer) cssLayer.remove();
  };
  if (o.autoStart) stage.start(); else stage.render();
  return stage;
}

/* =========================================================
   SKY DOME
   ========================================================= */
export function createSky(options = {}) {
  const uniforms = {
    top: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3() }, moonDir: { value: new THREE.Vector3() },
    sunAmt: { value: 1 }, moonAmt: { value: 0 }, stars: { value: options.stars === false ? 0 : 1 }, starAmt: { value: 0 }, time: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, toneMapped: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.); gl_Position = p.xyww; }`,
    fragmentShader: `
      uniform vec3 top, mid, horizon, sunDir, moonDir; uniform float sunAmt, moonAmt, stars, starAmt, time; varying vec3 vDir;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      void main(){
        vec3 d = normalize(vDir); float h = d.y;
        vec3 col = mix(horizon, mid, smoothstep(-0.06, 0.24, h));
        col = mix(col, top, smoothstep(0.2, 0.8, h));
        col *= mix(1.0, 0.7, smoothstep(0.0, -0.4, h));
        float s = max(dot(d, normalize(sunDir)), 0.);
        col += vec3(1.0, 0.86, 0.62) * (smoothstep(0.99935, 0.99962, s) * 2.4 + pow(s, 90.) * 0.42 + pow(s, 9.) * 0.10) * sunAmt;
        float m = max(dot(d, normalize(moonDir)), 0.);
        col += vec3(0.86, 0.9, 1.0) * (smoothstep(0.99955, 0.9997, m) * 1.3 + pow(m, 160.) * 0.18) * moonAmt;
        vec2 uv = vec2(atan(d.z, d.x), asin(clamp(d.y, -1., 1.))) * 118.;
        vec2 cell = floor(uv); vec2 f = fract(uv) - 0.5;
        float rnd = hash(cell); vec2 off = vec2(hash(cell + 1.7), hash(cell + 3.1)) - 0.5;
        float st = step(0.982, rnd) * smoothstep(0.13, 0.0, length(f - off * 0.6));
        st *= 0.55 + 0.45 * sin(time * 1.7 + rnd * 90.);
        col += vec3(st) * stars * starAmt * smoothstep(0.02, 0.25, h);
        col += (hash(gl_FragCoord.xy + time) - 0.5) / 255.;
        gl_FragColor = vec4(col, 1.);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.userData.noPick = true;
  const handle = { mesh, kind: 'sky', sunDirection: new THREE.Vector3(), moonDirection: new THREE.Vector3(), colors: { top: uniforms.top.value, mid: uniforms.mid.value, horizon: uniforms.horizon.value }, night: 0, sun: 1 };
  handle.setTime = (h) => {
    const s = skyAt(h);
    uniforms.top.value.set(s.top); uniforms.mid.value.set(s.mid); uniforms.horizon.value.set(s.horizon);
    sunDir(h, handle.sunDirection); moonDir(h, handle.moonDirection);
    uniforms.sunDir.value.copy(handle.sunDirection); uniforms.moonDir.value.copy(handle.moonDirection);
    uniforms.sunAmt.value = clamp((handle.sunDirection.y + 0.04) / 0.12, 0, 1);
    uniforms.moonAmt.value = clamp(s.night * 1.2, 0, 1) * clamp((handle.moonDirection.y + 0.02) / 0.1, 0, 1);
    uniforms.starAmt.value = s.night;
    handle.night = s.night; handle.sun = uniforms.sunAmt.value;
  };
  handle.tick = (t) => { uniforms.time.value = prefersReducedMotion() ? 0 : t; };
  handle.dispose = () => { mesh.geometry.dispose(); mat.dispose(); };
  handle.setTime(12);
  return handle;
}

/* =========================================================
   ECHO SHOW 8
   ========================================================= */
const RING_LOOK = {
  off: { c: '#3BD1FF', i: 0 }, idle: { c: '#3BD1FF', i: 0.18 }, listening: { c: '#3BD1FF', i: 0.9 }, thinking: { c: '#3BD1FF', i: 0.75 },
  speaking: { c: '#3BD1FF', i: 1.0 }, notify: { c: '#FFB547', i: 0.95 }, urgent: { c: '#FF6B57', i: 1.0 }, success: { c: '#9ED9B0', i: 0.8 },
};
export function createEchoShow(options = {}) {
  const o = Object.assign({ size: 8, color: 'charcoal', shadow: true }, options);
  const group = new THREE.Group();
  const W = 2.0, H = 1.36, D = 1.04, TILT = 0.07;
  const fabricCol = o.color === 'glacier' ? 0xd9d6d0 : 0x2b2d33;

  // wedge body (side profile extruded across the width)
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.02);
  shape.lineTo(-TILT * H + 0.02, H - 0.05);
  shape.quadraticCurveTo(-TILT * H - 0.04, H + 0.02, -0.2, H - 0.06);
  shape.bezierCurveTo(-0.62, H - 0.3, -1.0, 0.75, -D, 0.16);
  shape.quadraticCurveTo(-D - 0.01, 0.0, -D + 0.12, 0.0);
  shape.lineTo(-0.04, 0.0);
  shape.quadraticCurveTo(0, 0, 0, 0.02);
  const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth: W - 0.08, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 5, curveSegments: 28 });
  bodyGeo.rotateY(-Math.PI / 2);
  bodyGeo.translate((W - 0.08) / 2, 0, -0.07);
  const fabric = fabricTexture();
  const bodyMat = new THREE.MeshStandardMaterial({ color: fabricCol, roughness: 0.96, metalness: 0, bumpMap: fabric, bumpScale: 0.6, map: fabric });
  bodyMat.map.colorSpace = THREE.NoColorSpace;
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  group.add(body);

  // front panel: black glass, slightly tilted back
  const panel = new THREE.Group();
  panel.position.set(0, 0.03, 0.0);
  panel.rotation.x = -TILT;
  group.add(panel);
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.14, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.1 });
  const front = new THREE.Mesh(new RoundedBoxGeometry(W, H - 0.02, 0.08, 4, 0.05), glassMat);
  front.position.set(0, (H - 0.02) / 2, 0.0);
  panel.add(front);

  // display (16:10), a little above centre; becomes a transparent hole when HTML is attached
  const SW = 1.74, SH = 1.08;
  const scrCenter = new THREE.Vector3(0, H / 2 + 0.06, 0.041);
  const idleMat = new THREE.MeshBasicMaterial({ color: 0x06080d, toneMapped: false });
  const holeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, blending: THREE.NoBlending, depthWrite: true });
  const display = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), idleMat);
  display.position.copy(scrCenter);
  panel.add(display);
  const screenAnchor = new THREE.Object3D();
  screenAnchor.position.copy(scrCenter).add(new THREE.Vector3(0, 0, 0.002));
  panel.add(screenAnchor);

  // glass glare over the display (additive, so it also lies over live HTML)
  const glareTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 160; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 256, 160);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.36, 'rgba(255,255,255,0)'); g.addColorStop(0.42, 'rgba(255,255,255,.07)'); g.addColorStop(0.5, 'rgba(255,255,255,.015)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 160);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const glare = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), new THREE.MeshBasicMaterial({ map: glareTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  glare.position.copy(scrCenter).add(new THREE.Vector3(0, 0, 0.004));
  glare.renderOrder = 5;
  glare.userData.noPick = true;
  panel.add(glare);

  // light bar along the bottom of the display
  const barMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { color: { value: new THREE.Color('#3BD1FF') }, amp: { value: 0 }, sweep: { value: -1 }, sweepAmt: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: `uniform vec3 color; uniform float amp, sweep, sweepAmt; varying vec2 vUv;
      void main(){ float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
        float core = exp(-pow((vUv.y - 0.5) * 3.2, 2.));
        float sw = exp(-pow((vUv.x - sweep) * 7., 2.)) * sweepAmt;
        float k = (edge * (1. - sweepAmt * 0.75) + sw) * core * amp;
        vec3 c = mix(color, vec3(1.), core * 0.55 * amp);
        gl_FragColor = vec4(c * k * 1.6, k); }`,
  });
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(SW * 0.98, 0.07), barMat);
  bar.position.set(0, scrCenter.y - SH / 2 + 0.035, 0.046);
  bar.renderOrder = 6; bar.userData.noPick = true;
  panel.add(bar);
  const halo = glowSprite(new THREE.Color('#3BD1FF'), 1, 0);
  halo.scale.set(SW * 1.5, 0.55, 1);
  halo.position.set(0, bar.position.y, 0.09);
  halo.renderOrder = 7; halo.userData.noPick = true;
  panel.add(halo);

  // camera lens, top right of the bezel
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), new THREE.MeshPhysicalMaterial({ color: 0x0b1220, roughness: 0.05, clearcoat: 1, metalness: 0.5 }));
  lens.position.set(0.52, H - 0.065, 0.042);
  panel.add(lens);
  const shutter = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.022), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.5 }));
  shutter.position.set(0.6, H - 0.065, 0.042);
  panel.add(shutter);
  const cameraDot = new THREE.Object3D();
  cameraDot.position.copy(lens.position).add(new THREE.Vector3(0, 0, 0.02));
  panel.add(cameraDot);

  // light from the bar onto whatever is in front
  const light = new THREE.PointLight(0x3bd1ff, 0, 6, 1.6);
  light.position.set(0, bar.position.y + 0.1, 0.6);
  panel.add(light);

  // contact shadow and spill on the surface below
  if (o.shadow) {
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.5, D * 1.9), new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false, opacity: 0.85 }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(0, 0.002, -D / 2); sh.userData.noPick = true; sh.renderOrder = 1;
    group.add(sh);
  }
  const spill = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.9, 1.5), new THREE.MeshBasicMaterial({ map: glowTex(), color: 0x3bd1ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  spill.rotation.x = -Math.PI / 2; spill.position.set(0, 0.004, 0.55); spill.userData.noPick = true; spill.renderOrder = 2;
  group.add(spill);

  const look = { color: new THREE.Color('#3BD1FF'), amp: 0 };
  let state = 'off', css = null, wrapper = null;
  const handle = {
    group, kind: 'echo', size: o.size, ring: 'off', cameraDot, screenAnchor,
    screen: { width: SW, height: SH, aspect: SW / SH, pxWidth: 1280, pxHeight: 800, mesh: display },
  };
  handle.setRing = (s) => { if (!RING_LOOK[s]) s = 'idle'; state = s; handle.ring = s; };
  handle.setSpeechLevel = () => {};
  handle.attachScreen = (el, { pxWidth = 1280, pxHeight = 800, className = '' } = {}) => {
    wrapper = document.createElement('div');
    wrapper.className = ('nova3d-screen ' + className).trim();
    Object.assign(wrapper.style, { width: pxWidth + 'px', height: pxHeight + 'px', overflow: 'hidden', pointerEvents: 'auto', background: '#070A12' });
    wrapper.appendChild(el);
    css = new CSS3DObject(wrapper);
    css.scale.setScalar(SW / pxWidth);
    screenAnchor.add(css);
    display.material = holeMat;
    return css;
  };
  handle.detachScreen = () => {
    if (!css) return null;
    screenAnchor.remove(css); display.material = idleMat;
    const el = wrapper.firstElementChild; wrapper.remove(); css = null; wrapper = null; return el;
  };
  handle.setScreenImage = (src) => {
    if (!src) { display.material = idleMat; return; }
    const t = typeof src === 'string' ? new THREE.TextureLoader().load(src) : new THREE.Texture(src);
    t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
    display.material = new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
    handle.screenTexture = t;
  };
  handle.update = (dt, t, stage) => {
    const L = RING_LOOK[state];
    look.color.lerp(new THREE.Color(L.c), 1 - Math.exp(-6 * dt));
    let a = L.i, sweepAmt = 0;
    const rm = stage && stage.reducedMotion;
    if (!rm) {
      if (state === 'listening') a *= 0.62 + 0.38 * Math.sin(t * 4.2) * 0.5 + 0.19;
      if (state === 'speaking') a *= 0.72 + 0.28 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1));
      if (state === 'notify') a *= 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 3.4));
      if (state === 'urgent') a *= 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 9));
      if (state === 'thinking') sweepAmt = 1;
    }
    look.amp = damp(look.amp, a, 8, dt);
    barMat.uniforms.color.value.copy(look.color);
    barMat.uniforms.amp.value = look.amp;
    barMat.uniforms.sweepAmt.value = damp(barMat.uniforms.sweepAmt.value, sweepAmt, 6, dt);
    barMat.uniforms.sweep.value = ((t * 0.9) % 1.4) - 0.2;
    halo.material.color.copy(look.color);
    halo.material.opacity = look.amp * 0.8;
    spill.material.color.copy(look.color);
    spill.material.opacity = look.amp * 0.55;
    light.color.copy(look.color);
    light.intensity = look.amp * 2.2;
  };
  handle.dispose = () => { group.traverse((m) => { if (m.geometry) m.geometry.dispose(); }); if (css) handle.detachScreen(); };
  return handle;
}

/* =========================================================
   PILL BOTTLE (label cropped from the sample photo)
   ========================================================= */
export function createPillBottle(options = {}) {
  const o = Object.assign({ label: null, id: 'pill', crop: null, pills: true, style: 'rx' }, options);
  const otc = o.style === 'otc';
  if (!o.crop) o.crop = otc ? [266, 221, 369, 299] : [252, 212, 396, 306];
  const group = new THREE.Group();
  const R = 0.22, HB = 0.74;
  const pts = [];
  pts.push(new THREE.Vector2(0, 0));
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI / 2; pts.push(new THREE.Vector2(R - 0.035 + Math.sin(a) * 0.035, 0.035 - Math.cos(a) * 0.035)); }
  pts.push(new THREE.Vector2(R, HB - 0.06));
  pts.push(new THREE.Vector2(R - 0.02, HB - 0.02));
  pts.push(new THREE.Vector2(R - 0.025, HB + 0.02));
  const amber = otc
    ? new THREE.MeshPhysicalMaterial({ color: 0xf4f2ec, roughness: 0.38, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2, sheen: 0.3, envMapIntensity: 1.0 })
    : new THREE.MeshPhysicalMaterial({ color: 0xc8641a, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, transparent: true, opacity: 0.9, emissive: 0x3a1500, emissiveIntensity: 0.25, envMapIntensity: 1.2 });
  const bodyM = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), amber);
  group.add(bodyM);
  if (o.pills && !otc) {
    const pm = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.6 });
    for (let i = 0; i < 7; i++) { const p = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.07, 4, 8), pm); p.position.set(Math.sin(i * 2.3) * 0.11, 0.06 + (i % 3) * 0.05, Math.cos(i * 2.3) * 0.11); p.rotation.set(i, i * 0.7, 1.2); group.add(p); }
  }
  // child-proof cap with ridges
  const capTex = (() => { const c = document.createElement('canvas'); c.width = 256; c.height = 32; const x = c.getContext('2d'); x.fillStyle = otc ? '#1f4a9c' : '#f3f0ea'; x.fillRect(0, 0, 256, 32); for (let i = 0; i < 256; i += 8) { x.fillStyle = otc ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.13)'; x.fillRect(i, 0, 3, 32); } const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.018, R + 0.018, 0.2, 48), new THREE.MeshStandardMaterial({ map: capTex, roughness: 0.45, bumpMap: capTex, bumpScale: 1.5 }));
  cap.position.y = HB + 0.1;
  const capTop = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.012, R + 0.018, 0.012, 48), new THREE.MeshStandardMaterial({ color: otc ? 0x22509f : 0xf6f3ee, roughness: 0.35 }));
  capTop.position.y = HB + 0.206;
  group.add(cap, capTop);
  // label, wrapped around the front
  const labelMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62 });
  const label = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.004, R + 0.004, 0.44, 48, 1, true, -Math.PI * 0.4, Math.PI * 0.8), labelMat);
  label.position.y = 0.36;
  group.add(label);
  const ready = new Promise((res) => {
    if (!o.label) { res(); return; }
    const img = new Image();
    img.onload = () => {
      const [sx, sy, sw, sh] = o.crop;
      const c = document.createElement('canvas'); c.width = 1024; c.height = Math.round(1024 * (sh / sw) * 0.86);
      const x = c.getContext('2d');
      x.fillStyle = otc ? '#1c4a9e' : '#fbfaf6'; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, sx, sy, sw, sh, c.width * 0.03, 0, c.width * 0.94, c.height);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      labelMat.map = t; labelMat.needsUpdate = true; res();
    };
    img.onerror = () => res();
    img.src = o.label;
  });
  const hi = glowSprite(new THREE.Color('#3BD1FF'), 1.4, 0);
  hi.position.y = 0.5; hi.renderOrder = 8; hi.userData.noPick = true;
  group.add(hi);
  let hiT = 0;
  const handle = { group, kind: 'pill', id: o.id, ready };
  handle.setHighlight = (on) => { hiT = on ? 1 : 0; };
  handle.update = (dt) => { hi.material.opacity = damp(hi.material.opacity, hiT * 0.45, 8, dt); };
  handle.dispose = () => group.traverse((m) => { if (m.geometry) m.geometry.dispose(); });
  return handle;
}

/* =========================================================
   NOVA LOGO (four-segment ring + four-point star, extruded)
   ========================================================= */
export function createNovaLogo(options = {}) {
  const o = Object.assign({ finish: 'chrome', core: 'star', size: 1, spin: 0.5, glow: true }, options);
  const group = new THREE.Group();
  const inner = new THREE.Group();
  group.add(inner);
  const mats = {
    chrome: () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 1, roughness: 0.07, envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.03 }),
    iridescent: () => new THREE.MeshPhysicalMaterial({ color: 0xdfe8ff, metalness: 0.55, roughness: 0.1, iridescence: 1, iridescenceIOR: 1.8, iridescenceThicknessRange: [180, 820], clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.7 }),
    glass: () => new THREE.MeshPhysicalMaterial({ color: 0xcfefff, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.55, iridescence: 0.5, clearcoat: 1, envMapIntensity: 2 }),
  };
  let mat = (mats[o.finish] || mats.chrome)();
  const R = 1, r = 0.8, gap = 0.2;
  const ext = { depth: 0.16, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.04, bevelSegments: 6, curveSegments: 40 };
  for (let k = 0; k < 4; k++) {
    const a0 = k * Math.PI / 2 - Math.PI / 4 + gap / 2, a1 = a0 + Math.PI / 2 - gap;
    const s = new THREE.Shape();
    s.absarc(0, 0, R, a0, a1, false);
    s.absarc(0, 0, r, a1, a0, true);
    const g = new THREE.ExtrudeGeometry(s, ext); g.translate(0, 0, -0.08);
    inner.add(new THREE.Mesh(g, mat));
  }
  if (o.core === 'star') {
    const s = new THREE.Shape(), n = 4, ro = 0.6, ri = 0.13;
    for (let i = 0; i <= n * 2; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / n, rad = i % 2 === 0 ? ro : ri;
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      i === 0 ? s.moveTo(x, y) : s.lineTo(x, y);
    }
    const g = new THREE.ExtrudeGeometry(s, Object.assign({}, ext, { depth: 0.24, bevelSize: 0.03 })); g.translate(0, 0, -0.12);
    inner.add(new THREE.Mesh(g, mat));
  } else {
    inner.add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 48, 32), mat));
  }
  inner.scale.setScalar(o.size);
  let glowS = null;
  if (o.glow) { glowS = glowSprite(new THREE.Color('#3BD1FF'), o.size * 4.2, 0.35); glowS.position.z = -0.6 * o.size; glowS.userData.noPick = true; group.add(glowS); }
  let speed = prefersReducedMotion() ? 0 : o.spin;
  const handle = { group, kind: 'logo', ready: Promise.resolve() };
  handle.spin = (v) => { speed = v; };
  handle.setFinish = (f) => { mat = (mats[f] || mats.chrome)(); inner.traverse((m) => { if (m.isMesh) m.material = mat; }); };
  handle.update = (dt, t) => { inner.rotation.y += speed * dt; inner.rotation.x = Math.sin(t * 0.6) * 0.12; if (glowS) glowS.material.opacity = 0.28 + Math.sin(t * 1.4) * 0.06; };
  handle.dispose = () => inner.traverse((m) => { if (m.geometry) m.geometry.dispose(); });
  return handle;
}

/* =========================================================
   ARC CAROUSEL (arcmarumo-style)
   ========================================================= */
export function createArcCarousel(stage, items, options = {}) {
  const o = Object.assign({ radius: 9, spacing: 0.42, cardWidth: 2.6, cardHeight: 3.6, position: [0, 1.6, 0], keyboard: true, wheel: true, drag: true, onChange: null, onSelect: null }, options);
  const group = new THREE.Group();
  group.position.set(...o.position);
  stage.scene.add(group);
  const center = new THREE.Vector3(0, 0, -o.radius);
  const PX = 720, PY = Math.round(720 * (o.cardHeight / o.cardWidth));
  const cards = items.map((it, k) => {
    const c = document.createElement('canvas'); c.width = PX; c.height = PY;
    const x = c.getContext('2d');
    const rr = 40;
    x.save();
    x.beginPath(); x.moveTo(rr, 0); x.arcTo(PX, 0, PX, PY, rr); x.arcTo(PX, PY, 0, PY, rr); x.arcTo(0, PY, 0, 0, rr); x.arcTo(0, 0, PX, 0, rr); x.closePath(); x.clip();
    if (it.canvasDraw) it.canvasDraw(x, PX, PY);
    else { x.fillStyle = '#14151b'; x.fillRect(0, 0, PX, PY); x.fillStyle = '#F4EEE6'; x.font = '400 64px "Instrument Serif"'; x.fillText(it.title || '', 40, 120); }
    x.restore();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(o.cardWidth, o.cardHeight), mat);
    // edge glow in the card's colour
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(o.cardWidth * 1.08, o.cardHeight * 1.06), new THREE.MeshBasicMaterial({ map: glowTex(), color: new THREE.Color(it.color || COLORS.nova), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    edge.position.z = -0.02;
    // reflection on the floor
    const refl = new THREE.Mesh(new THREE.PlaneGeometry(o.cardWidth, o.cardHeight), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.12, toneMapped: false, depthWrite: false, alphaMap: reflAlpha() }));
    refl.scale.y = -1; refl.position.y = -o.cardHeight - 0.04;
    const holder = new THREE.Group();
    refl.visible = false;
    holder.add(edge, mesh, refl);
    holder.userData.k = k;
    mesh.userData.card = k;
    group.add(holder);
    return { holder, mesh, edge, refl, mat };
  });
  function reflAlpha() {
    if (texCache.refl) return texCache.refl;
    const c = document.createElement('canvas'); c.width = 4; c.height = 128; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, '#000'); g.addColorStop(0.55, '#000'); g.addColorStop(1, '#fff');
    x.fillStyle = g; x.fillRect(0, 0, 4, 128);
    return (texCache.refl = new THREE.CanvasTexture(c));
  }
  let pos = 0, target = 0, vel = 0, dragging = false, lastIndex = 0;
  const n = items.length;
  const car = { group, get index() { return Math.round(clamp(target, 0, n - 1)); }, get position() { return pos; }, get dragging() { return dragging; } };
  function layout() {
    cards.forEach((c, k) => {
      const d = k - pos;
      const th = d * o.spacing;
      c.holder.position.set(center.x + Math.sin(th) * o.radius, -Math.abs(d) * 0.06, center.z + Math.cos(th) * o.radius);
      c.holder.rotation.y = th * 0.92;
      const near = clamp(1 - Math.abs(d), 0, 1);
      const fade = clamp(1.2 - Math.abs(d) * 0.12, 0.3, 1);
      c.mat.color.setScalar(lerp(0.86, 1, near) * lerp(0.8, 1, fade));
      c.mat.opacity = clamp(1.5 - Math.abs(d) * 0.2, 0, 1);
      c.edge.material.opacity = near * 0.5;
      c.refl.material.opacity = 0.1 * fade;
      c.holder.visible = Math.abs(d) < 7;
    });
  }
  car.select = (i, { instant = false } = {}) => { target = clamp(i, 0, n - 1); if (instant || stage.reducedMotion) { pos = target; vel = 0; } };
  car.next = () => car.select(Math.round(target) + 1);
  car.prev = () => car.select(Math.round(target) - 1);
  const unFrame = stage.onFrame((dt) => {
    if (!dragging) {
      const k = 90, c = 2 * Math.sqrt(k) * 0.9;
      const acc = (target - pos) * k - vel * c;
      vel += acc * dt; pos += vel * dt;
      if (Math.abs(target - pos) < 0.0005 && Math.abs(vel) < 0.001) { pos = target; vel = 0; }
    }
    layout();
    const idx = Math.round(clamp(dragging ? pos : target, 0, n - 1));
    if (idx !== lastIndex) { lastIndex = idx; if (o.onChange) o.onChange(idx, items[idx]); }
  });
  layout();

  // drag
  const el = stage.container;
  let sx = 0, sp = 0, lx = 0, lt = 0, moved = false, pid = null;
  const pxPerCard = () => Math.max(160, el.getBoundingClientRect().width * 0.22);
  function down(e) {
    if (!o.drag || e.button > 0 || e.defaultPrevented) return;
    if (e.target.closest && e.target.closest('.nova3d-screen, button, a')) return;
    dragging = true; moved = false; pid = e.pointerId;
    sx = lx = e.clientX; sp = pos; lt = performance.now(); vel = 0;
    el.style.cursor = 'grabbing';
  }
  function move(e) {
    if (!dragging || e.pointerId !== pid) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 4) moved = true;
    const now = performance.now();
    const v = -(e.clientX - lx) / pxPerCard() / Math.max(0.008, (now - lt) / 1000);
    vel = lerp(vel, v, 0.4); lx = e.clientX; lt = now;
    let p = sp - dx / pxPerCard();
    if (p < 0) p *= 0.35; if (p > n - 1) p = n - 1 + (p - (n - 1)) * 0.35;
    pos = p;
  }
  function up(e) {
    if (!dragging || (e && e.pointerId !== pid)) return;
    dragging = false; el.style.cursor = '';
    const proj = pos + (stage.reducedMotion ? 0 : vel * 0.18);
    target = clamp(Math.round(proj), 0, n - 1);
    vel *= 0.3;
    if (!moved && e) click(e);
  }
  function click(e) {
    const hit = stage.pick(e.clientX, e.clientY, cards.map((c) => c.mesh));
    if (!hit) return;
    const k = hit.object.userData.card;
    if (k === Math.round(target)) { if (o.onSelect) o.onSelect(k, items[k]); }
    else car.select(k);
  }
  el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  function wheel(e) {
    if (!o.wheel) return;
    e.preventDefault();
    car.select(Math.round(target) + (e.deltaY + e.deltaX > 0 ? 1 : -1));
  }
  el.addEventListener('wheel', wheel, { passive: false });
  function key(e) {
    if (!o.keyboard) return;
    const t = e.target;
    if (t && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < innerHeight * 0.4 || r.top > innerHeight * 0.6) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); car.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); car.prev(); }
    else if (e.key === 'Enter' && document.activeElement === document.body && o.onSelect) o.onSelect(car.index, items[car.index]);
  }
  window.addEventListener('keydown', key);
  car.dispose = () => {
    unFrame(); stage.scene.remove(group);
    el.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    el.removeEventListener('wheel', wheel); window.removeEventListener('keydown', key);
  };
  return car;
}

/* =========================================================
   DRAG objects onto targets
   ========================================================= */
export function enableDrag(stage, handles, options = {}) {
  const o = Object.assign({ plane: 'screen', floorY: 0, lift: 0.35, targets: [], returnHome: true, onDragStart: null, onDragEnd: null }, options);
  const el = stage.container;
  const state = new Map();
  handles.forEach((h) => state.set(h, { home: h.group.position.clone(), goal: h.group.position.clone(), busy: false, vel: new THREE.Vector3(), tilt: 0 }));
  let held = null, plane = new THREE.Plane(), grabOff = new THREE.Vector3(), inside = -1, pid = null, enabled = true;
  const ray = new THREE.Raycaster(), v = new THREE.Vector3(), camDir = new THREE.Vector3();
  function ndc(e) { const r = el.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
  function targetPoint(t, out) { const ob = t.object && t.object.isObject3D ? t.object : t.object.group; return ob.getWorldPosition(out); }
  function presentPos(h, t) {
    const p = targetPoint(t, new THREE.Vector3());
    camDir.copy(stage.camera.position).sub(p).normalize();
    const s = h.group.scale.y;
    return p.add(camDir.multiplyScalar(0.75 * s)).add(new THREE.Vector3(0, -0.55 * s, 0));
  }
  function down(e) {
    if (!enabled || e.button > 0) return;
    if (e.target.closest && e.target.closest('.nova3d-screen')) return;
    const hit = stage.pick(e.clientX, e.clientY, handles);
    if (!hit || !hit.handle || state.get(hit.handle).busy) return;
    e.preventDefault(); e.stopImmediatePropagation();
    held = hit.handle; pid = e.pointerId;
    const st = state.get(held);
    stage.camera.getWorldDirection(camDir);
    plane.setFromNormalAndCoplanarPoint(camDir.clone().negate(), held.group.position);
    ray.setFromCamera(ndc(e), stage.camera);
    ray.ray.intersectPlane(plane, v);
    grabOff.copy(held.group.position).sub(v);
    st.goal.copy(held.group.position).add(camDir.clone().negate().multiplyScalar(o.lift)).add(new THREE.Vector3(0, o.lift * 0.6, 0));
    el.style.cursor = 'grabbing';
    if (o.onDragStart) o.onDragStart(held);
  }
  function move(e) {
    if (!held) {
      if (e.target && el.contains(e.target)) {
        const hit = enabled && e.target.closest && !e.target.closest('.nova3d-screen') ? stage.pick(e.clientX, e.clientY, handles) : null;
        el.style.cursor = hit ? 'grab' : '';
      }
      return;
    }
    if (e.pointerId !== pid) return;
    const st = state.get(held);
    ray.setFromCamera(ndc(e), stage.camera);
    if (ray.ray.intersectPlane(plane, v)) {
      st.goal.copy(v).add(grabOff).add(new THREE.Vector3(0, o.lift * 0.6, 0));
      stage.camera.getWorldDirection(camDir); st.goal.add(camDir.negate().multiplyScalar(o.lift));
    }
    // targets
    let now = -1;
    o.targets.forEach((t, i) => {
      const p = stage.project(targetPoint(t, new THREE.Vector3()));
      if (Math.hypot(p.x - e.clientX, p.y - e.clientY) < (t.radius || 120)) now = i;
    });
    if (now !== inside) {
      if (inside >= 0 && o.targets[inside].onLeave) o.targets[inside].onLeave(held, o.targets[inside]);
      inside = now;
      if (inside >= 0 && o.targets[inside].onEnter) o.targets[inside].onEnter(held, o.targets[inside]);
    }
    if (inside >= 0) st.goal.lerp(presentPos(held, o.targets[inside]), 0.35);
  }
  function up(e) {
    if (!held || (e && e.pointerId !== pid)) return;
    const h = held; held = null; el.style.cursor = '';
    const t = inside >= 0 ? o.targets[inside] : null;
    inside = -1;
    if (o.onDragEnd) o.onDragEnd(h, t);
    if (t) present(h, t); else if (o.returnHome) state.get(h).goal.copy(state.get(h).home);
  }
  function present(h, t) {
    const st = state.get(h);
    st.busy = true;
    st.goal.copy(presentPos(h, t));
    return new Promise((res) => {
      setTimeout(() => {
        const r = t.onDrop ? t.onDrop(h, t) : undefined;
        setTimeout(() => { st.goal.copy(st.home); st.busy = false; res(); }, r === false ? 0 : (t.holdMs || 1400));
      }, stage.reducedMotion ? 50 : 520);
    });
  }
  el.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  const unFrame = stage.onFrame((dt) => {
    state.forEach((st, h) => {
      const p = h.group.position;
      const k = stage.reducedMotion ? 30 : 14;
      const before = p.clone();
      p.x = damp(p.x, st.goal.x, k, dt); p.y = damp(p.y, st.goal.y, k, dt); p.z = damp(p.z, st.goal.z, k, dt);
      st.vel.copy(p).sub(before).divideScalar(Math.max(dt, 1e-3));
      st.tilt = damp(st.tilt, clamp(-st.vel.x * 0.08, -0.35, 0.35), 10, dt);
      h.group.rotation.z = st.tilt;
    });
  });
  return {
    drop: (h, i = 0) => { const st = state.get(h); if (!st || st.busy) return Promise.resolve(); if (o.onDragStart) o.onDragStart(h); const t = o.targets[i]; if (t.onEnter) t.onEnter(h, t); return present(h, t).then(() => { if (o.onDragEnd) o.onDragEnd(h, t); }); },
    setHome: (h, p) => { const st = state.get(h); if (!st) return; st.home.set(...(p || h.group.position.toArray())); if (!st.busy && held !== h) st.goal.copy(st.home); },
    setEnabled: (b) => { enabled = b; },
    dispose: () => { unFrame(); el.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); },
  };
}

/* =========================================================
   ORBIT: drag to turn, spring back, hover tilt
   ========================================================= */
export function enableOrbit(stage, object, options = {}) {
  const o = Object.assign({ maxYaw: 0.45, maxPitch: 0.18, springBack: true, hover: true, anywhere: false }, options);
  const obj = object.isObject3D ? object : object.group;
  const el = stage.container;
  const rest = obj.rotation.clone();
  let yaw = 0, pitch = 0, vy = 0, vp = 0, dragging = false, enabled = true, sx = 0, sy = 0, sYaw = 0, sPitch = 0, lx = 0, lt = 0, pid = null;
  let hy = 0, hp = 0;
  const rubber = (v, m) => (Math.abs(v) <= m ? v : Math.sign(v) * (m + (Math.abs(v) - m) * 0.25));
  function down(e) {
    if (!enabled || e.button > 0 || e.defaultPrevented) return;
    if (e.target.closest && e.target.closest('.nova3d-screen, button, a')) return;
    if (!o.anywhere) { const hit = stage.pick(e.clientX, e.clientY, [object]); if (!hit) return; }
    dragging = true; pid = e.pointerId; sx = lx = e.clientX; sy = e.clientY; sYaw = yaw; sPitch = pitch; lt = performance.now(); vy = vp = 0;
    el.style.cursor = 'grabbing';
  }
  function move(e) {
    const r = el.getBoundingClientRect();
    if (o.hover && !dragging) {
      hy = (((e.clientX - r.left) / r.width) - 0.5) * 0.14;
      hp = (((e.clientY - r.top) / r.height) - 0.5) * 0.08;
    }
    if (!dragging || e.pointerId !== pid) return;
    const now = performance.now();
    vy = lerp(vy, ((e.clientX - lx) / 260) / Math.max(0.008, (now - lt) / 1000), 0.4);
    lx = e.clientX; lt = now;
    yaw = rubber(sYaw + (e.clientX - sx) / 260, o.maxYaw);
    pitch = rubber(sPitch + (e.clientY - sy) / 420, o.maxPitch);
  }
  function up(e) { if (!dragging || (e && e.pointerId !== pid)) return; dragging = false; el.style.cursor = ''; }
  el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  const unFrame = stage.onFrame((dt) => {
    if (!dragging) {
      yaw += vy * dt; vy = damp(vy, 0, 5, dt);
      if (o.springBack) { yaw = damp(yaw, 0, 3.2, dt); pitch = damp(pitch, 0, 3.2, dt); }
      yaw = clamp(yaw, -o.maxYaw * 1.2, o.maxYaw * 1.2);
    }
    const k = stage.reducedMotion ? 0 : 1;
    obj.rotation.y = rest.y + yaw + (dragging ? 0 : hy * k);
    obj.rotation.x = rest.x + pitch + (dragging ? 0 : hp * k);
  });
  return {
    setEnabled: (b) => { enabled = b; if (!b) dragging = false; },
    reset: () => { yaw = pitch = vy = vp = 0; },
    setRest: () => { rest.copy(obj.rotation); yaw = pitch = 0; },
    dispose: () => { unFrame(); el.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); },
  };
}

/* =========================================================
   SCREEN FRAME: the page as a physical glowing screen
   ========================================================= */
export function screenFrame(container = document.body, options = {}) {
  const o = Object.assign({ bezel: true, glare: true, scanlines: true, grain: true, vignette: true, radius: 28, intensity: 1, chin: 10 }, options);
  const el = document.createElement('div');
  el.className = 'nova3d-frame';
  el.setAttribute('aria-hidden', 'true');
  const R = o.radius, B = 10, C = Math.max(B, o.chin);
  el.innerHTML = `
    <div class="nf-vignette"></div><div class="nf-scan"></div><div class="nf-grain"></div><div class="nf-glare"></div><div class="nf-bezel"></div>`;
  const css = document.createElement('style');
  css.textContent = `
    .nova3d-frame{position:fixed;inset:0;z-index:2147483000;pointer-events:none}
    .nova3d-frame>div{position:absolute;inset:0;pointer-events:none}
    .nova3d-frame>.nf-bezel{inset:${B}px ${B}px ${C}px ${B}px;border-radius:${R}px;box-shadow:0 0 0 ${C + 40}px #030305, inset 0 0 0 1px rgba(59,209,255,.16), inset 0 0 0 2px rgba(0,0,0,.6), inset 0 0 90px rgba(0,0,0,.55), inset 0 30px 60px -40px rgba(255,255,255,.08)}
    .nova3d-frame>.nf-vignette{inset:${B}px ${B}px ${C}px ${B}px;border-radius:${R}px;background:radial-gradient(130% 115% at 50% 45%, transparent 58%, rgba(0,0,0,.42) 100%)}
    .nova3d-frame>.nf-scan{inset:${B}px ${B}px ${C}px ${B}px;border-radius:${R}px;opacity:${0.28 * o.intensity};background:repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 1px, transparent 1px 3px);mix-blend-mode:multiply}
    .nova3d-frame>.nf-glare{inset:${B}px ${B}px ${C}px ${B}px;border-radius:${R}px;overflow:hidden;background:linear-gradient(118deg, rgba(255,255,255,.055) 0%, rgba(255,255,255,0) 22%), radial-gradient(70% 22% at 50% 0%, rgba(255,255,255,.05), transparent 70%)}
    .nova3d-frame>.nf-grain{inset:-60px;opacity:${0.06 * o.intensity};mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");animation:nfGrain 1s steps(5) infinite}
    @keyframes nfGrain{0%{transform:translate(0,0)}20%{transform:translate(-30px,18px)}40%{transform:translate(20px,-34px)}60%{transform:translate(-12px,40px)}80%{transform:translate(36px,10px)}}
    @media (prefers-reduced-motion: reduce){.nf-grain{animation:none}}`;
  if (!o.bezel) el.querySelector('.nf-bezel').remove();
  if (!o.scanlines) el.querySelector('.nf-scan').remove();
  if (!o.grain) el.querySelector('.nf-grain').remove();
  if (!o.glare) el.querySelector('.nf-glare').remove();
  if (!o.vignette) el.querySelector('.nf-vignette').remove();
  document.head.appendChild(css);
  container.appendChild(el);
  return { el, set: () => {}, setEnabled: (b) => { el.style.display = b ? '' : 'none'; }, dispose: () => { el.remove(); css.remove(); } };
}
