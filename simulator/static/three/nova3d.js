// Nova 3D: shared object library (three@0.170.0). API: docs/THREE_API.md
// Everything here is procedural: geometry, materials and CanvasTextures. No model files.

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';

export const VERSION = '1.0.0';

/* ============================================================== constants */

export const COLORS = Object.freeze({
  ink: '#0A0B10', ink2: '#11131A', ink3: '#191C26',
  ivory: '#F4EEE6', paper: '#EDE5D8',
  nova: '#3BD1FF', amber: '#FFB547', coral: '#FF6B57', sage: '#9ED9B0',
});

export const RING_STATES = Object.freeze(['off', 'idle', 'listening', 'thinking', 'speaking', 'notify', 'urgent', 'success']);

// Time-of-day skies from DESIGN.md (top, middle, horizon); same keyframes as app.js.
export const SKY_KEYS = Object.freeze([
  [0, ['#0A0B10', '#121833', '#1B2347']],
  [5.2, ['#0A0B10', '#121833', '#1B2347']],
  [6.6, ['#2A2F55', '#8D8FC4', '#F2A97E']],
  [8.4, ['#BFDDF5', '#E9F2FB', '#F6EFE6']],
  [15.6, ['#BFDDF5', '#E9F2FB', '#F6EFE6']],
  [17.6, ['#4A3A7A', '#E0708A', '#FFB27A']],
  [19.3, ['#12131F', '#2B2850', '#6B4C8F']],
  [20.9, ['#0A0B10', '#121833', '#1B2347']],
  [24, ['#0A0B10', '#121833', '#1B2347']],
]);

const RING_BLUE = '#3FA6FF';
const SERIF_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.2.8/files/instrument-serif-latin-400-normal.woff';
const SERIF_ITALIC_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.2.8/files/instrument-serif-latin-400-italic.woff';
const HELVETIKER_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json';

/* ================================================================ helpers */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const smooth = (t) => t * t * (3 - 2 * t);
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const groupOf = (x) => (x && x.isObject3D ? x : x && x.group);

const _mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export function prefersReducedMotion() { return !!(_mq && _mq.matches); }

export function isWebGLAvailable() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    return true;
  } catch { return false; }
}

function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

export function skyAt(hours) {
  const h = ((hours % 24) + 24) % 24;
  let i = 0;
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1][0] <= h) i++;
  const [h0, c0] = SKY_KEYS[i], [h1, c1] = SKY_KEYS[i + 1];
  const e = smooth(clamp(h1 === h0 ? 0 : (h - h0) / (h1 - h0), 0, 1));
  const mix = (a, b) => { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(...A.map((v, j) => v + (B[j] - v) * e)); };
  const sun = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
  const night = clamp(h < 5.5 || h > 20.5 ? 1 : h < 6.8 ? (6.8 - h) / 1.3 : h > 19.2 ? (h - 19.2) / 1.3 : 0, 0, 1);
  return { top: mix(c0[0], c1[0]), mid: mix(c0[1], c1[1]), horizon: mix(c0[2], c1[2]), sun, night };
}

// Exact inverse of three's ACES Filmic tone mapping, so the sky shows DESIGN.md colours after tone mapping.
const _acesIn = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777);
const _acesOut = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602);
const _acesInInv = _acesIn.clone().invert();
const _acesOutInv = _acesOut.clone().invert();
const _v3a = new THREE.Vector3();
function inverseACES(color, exposure = 1, out = new THREE.Color()) {
  const v = _v3a.set(clamp(color.r, 0, 0.985), clamp(color.g, 0, 0.985), clamp(color.b, 0, 0.985)).applyMatrix3(_acesOutInv);
  const solve = (y) => {
    y = clamp(y, 0, 0.996);
    const A = 1 - 0.983729 * y, B = 0.0245786 - 0.432951 * y, C = -(0.000090537 + 0.238081 * y);
    return (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
  };
  v.set(solve(v.x), solve(v.y), solve(v.z)).applyMatrix3(_acesInInv).multiplyScalar(0.6 / exposure);
  return out.setRGB(Math.max(0, v.x), Math.max(0, v.y), Math.max(0, v.z), THREE.LinearSRGBColorSpace);
}

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function canvasTexture(canvas, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

const _imgCache = new Map();
function loadImage(src) {
  if (typeof src !== 'string') return Promise.resolve(src);
  if (_imgCache.has(src)) return _imgCache.get(src);
  const p = new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.decoding = 'async';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('Nova3D: could not load ' + src));
    im.src = src;
  });
  _imgCache.set(src, p);
  p.catch(() => _imgCache.delete(src));
  return p;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Rounded rectangle as an explicit, de-duplicated polygon (near-duplicate points from
// lineTo + absarc make ExtrudeGeometry's bevel spike).
function roundedRectShape(w, h, r, seg = 12) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const corners = [[w / 2 - r, -h / 2 + r, -Math.PI / 2], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI]];
  const out = [];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      const p = new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      if (!out.length || out[out.length - 1].distanceTo(p) > 1e-5) out.push(p);
    }
  }
  if (out.length > 2 && out[0].distanceTo(out[out.length - 1]) < 1e-5) out.pop();
  return new THREE.Shape(out);
}

function roundedPolyShape(pts, radii) {
  const s = new THREE.Shape();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const da = new THREE.Vector2().subVectors(a, p), db = new THREE.Vector2().subVectors(b, p);
    const la = da.length(), lb = db.length();
    const r = radii[i];
    const p1 = p.clone().addScaledVector(da, Math.min(r, la * 0.5) / la);
    const p2 = p.clone().addScaledVector(db, Math.min(r, lb * 0.5) / lb);
    if (i === 0) s.moveTo(p1.x, p1.y); else s.lineTo(p1.x, p1.y);
    s.quadraticCurveTo(p.x, p.y, p2.x, p2.y);
  }
  s.closePath();
  return s;
}

// Additive light that leaves the destination alpha alone (keeps the CSS3D screen holes transparent).
function additiveKeepAlpha(mat) {
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.SrcAlphaFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendEquationAlpha = THREE.AddEquation;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  mat.transparent = true;
  mat.depthWrite = false;
  return mat;
}

function noPick(o) { o.userData.noPick = true; o.traverse?.((c) => { c.userData.noPick = true; }); return o; }

function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of ['map', 'emissiveMap', 'roughnessMap', 'bumpMap', 'normalMap', 'alphaMap']) {
        if (m[k] && !m[k].userData?.shared) m[k].dispose();
      }
      m.dispose();
    }
  });
  root.removeFromParent();
}

/* ======================================================= shared textures */

const _texCache = new Map();
function cached(key, make) { if (!_texCache.has(key)) { const t = make(); t.userData.shared = true; _texCache.set(key, t); } return _texCache.get(key); }

function glowTexture() {
  return cached('glow', () => {
    const N = 128, c = makeCanvas(N, N), ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N * 2 - 1, dy = (y + 0.5) / N * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = r >= 1 ? 0 : Math.pow(1 - r, 2.2) * (0.55 + 0.45 * Math.exp(-r * r * 9));
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
    return canvasTexture(c, { srgb: false });
  });
}

function shadowTexture() {
  return cached('shadow', () => {
    const N = 256, c = makeCanvas(N, N), ctx = c.getContext('2d');
    const off = 2000;
    ctx.shadowOffsetX = off;
    ctx.fillStyle = '#000';
    // wide soft penumbra
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 46;
    roundRectPath(ctx, N * 0.2 - off, N * 0.24, N * 0.6, N * 0.52, 40); ctx.fill();
    // tight contact core
    ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 16;
    roundRectPath(ctx, N * 0.27 - off, N * 0.32, N * 0.46, N * 0.36, 26); ctx.fill();
    return canvasTexture(c, { srgb: false });
  });
}

function fabricTextures(base) {
  return cached('fabric' + base, () => {
    const N = 256, c = makeCanvas(N, N), ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    const [r0, g0, b0] = hexToRgb(base);
    const fleck = new Float32Array(N * N);
    for (let i = 0; i < fleck.length; i++) fleck[i] = Math.random();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const cell = ((x >> 3) + (y >> 3)) & 1;
      const fx = (x % 8) - 3.5, fy = (y % 8) - 3.5;
      const weave = cell ? 0.5 + 0.5 * Math.cos(Math.PI * fx / 4.4) : 0.5 + 0.5 * Math.cos(Math.PI * fy / 4.4);
      const heather = fleck[((y >> 1) * N + x) % fleck.length] * 0.5 + fleck[(y * N + (x >> 1)) % fleck.length] * 0.5;
      const k = 0.6 + 0.52 * weave + (heather - 0.5) * 0.2;
      const i = (y * N + x) * 4;
      img.data[i] = clamp(r0 * k, 0, 255); img.data[i + 1] = clamp(g0 * k, 0, 255); img.data[i + 2] = clamp(b0 * k, 0, 255);
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = canvasTexture(c, { repeat: [4.5, 4.5] });
    return t;
  });
}

function fabricBump() {
  return cached('fabricBump', () => {
    const N = 256, c = makeCanvas(N, N), ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const cell = ((x >> 3) + (y >> 3)) & 1;
      const fx = (x % 8) - 3.5, fy = (y % 8) - 3.5;
      const w = cell ? 0.5 + 0.5 * Math.cos(Math.PI * fx / 4.4) : 0.5 + 0.5 * Math.cos(Math.PI * fy / 4.4);
      const v = clamp(w * 220 + Math.random() * 35, 0, 255);
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvasTexture(c, { srgb: false, repeat: [4.5, 4.5] });
  });
}

function brushedTexture() {
  return cached('brushed', () => {
    const W = 64, H = 512, c = makeCanvas(W, H), ctx = c.getContext('2d');
    for (let x = 0; x < W; x++) {
      const v = 120 + Math.random() * 70;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x, 0, 1, H);
    }
    for (let i = 0; i < 400; i++) {
      const v = 90 + Math.random() * 120;
      ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 1, 20 + Math.random() * 160);
    }
    return canvasTexture(c, { srgb: false, repeat: [3, 1] });
  });
}

/* ========================================================== environment */

const _envCache = new WeakMap();
function studioEnvironment(renderer) {
  if (_envCache.has(renderer)) return _envCache.get(renderer);
  const scene = new THREE.Scene();
  const bg = new THREE.Mesh(
    new THREE.SphereGeometry(30, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; void main(){
        vec3 d = normalize(vP);
        float h = d.y;
        vec3 floorC = vec3(0.02, 0.018, 0.018);
        vec3 hor = mix(vec3(0.20, 0.17, 0.15), vec3(0.12, 0.15, 0.2), smoothstep(-0.6, 0.6, d.x));
        vec3 top = vec3(0.035, 0.04, 0.06);
        vec3 c = h < 0.0 ? mix(hor, floorC, smoothstep(0.0, -0.35, h)) : mix(hor, top, smoothstep(0.0, 0.55, h));
        c += vec3(0.5) * exp(-abs(h) * 40.0) * 0.25; // thin bright horizon line for chrome
        gl_FragColor = vec4(c, 1.0); }`,
    })
  );
  scene.add(bg);
  const panel = (w, h, pos, color, intensity) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  panel(14, 5, [0, 13, 2], '#ffffff', 2.4);        // overhead softbox
  panel(5, 8, [-10, 3, 8], '#fff6ec', 2.8);        // key softbox, front-left
  panel(3, 9, [11, 2, 5], '#eef4ff', 1.8);         // fill, right
  panel(16, 0.7, [0, 6.5, 14], '#ffffff', 3.0);    // thin bright strip, front-top (chrome catches it as it turns)
  panel(14, 4, [0, 1, 16], '#dfe6f2', 0.3);        // broad, dim front card (soft gradient on front faces)
  panel(0.5, 7, [5, 1, 14], '#ffffff', 2.2);       // narrow vertical strip, front-right
  panel(1.2, 12, [9, 2, -9], '#ffffff', 3.6);      // rim strip, back-right
  panel(0.9, 10, [-11, 1, -6], COLORS.nova, 2.6);  // cyan strip, back-left
  panel(10, 0.7, [0, -1.5, -12], COLORS.amber, 1.4); // warm low strip behind
  panel(16, 16, [0, -9, 0], '#151313', 1.0);       // floor bounce
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.035);
  pmrem.dispose();
  scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  _envCache.set(renderer, rt.texture);
  return rt.texture;
}

/* ================================================================== sky */

const FULLSCREEN_TRI = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
})();

export function createSky(options = {}) {
  const o = { stars: true, exposure: 1, ...options };
  const uniforms = {
    uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uHor: { value: new THREE.Color() },
    uSun: { value: new THREE.Vector2(0, -2) }, uSunVis: { value: 0 }, uSunCol: { value: new THREE.Color('#FFE2B8') },
    uMoon: { value: new THREE.Vector2(0, -2) }, uMoonVis: { value: 0 },
    uNight: { value: 0 }, uStars: { value: o.stars ? 1 : 0 }, uTime: { value: 0 }, uAspect: { value: 16 / 9 },
    uTwinkle: { value: 1 }, uFlat: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }',
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uMid, uHor, uSunCol;
      uniform vec2 uSun, uMoon;
      uniform float uSunVis, uMoonVis, uNight, uStars, uTime, uAspect, uTwinkle, uFlat;
      varying vec2 vUv;
      float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      void main(){
        float y = vUv.y;
        vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.58, y));
        col = mix(col, uTop, smoothstep(0.42, 1.0, y));
        float bloomOk = 0.0;
        if (uFlat < 0.5) {
          vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
          // sun
          vec2 sp = vec2(uSun.x * 0.5 * uAspect, uSun.y * 0.5);
          float d = length(p - sp);
          float disc = smoothstep(0.036, 0.031, d);
          float glow = exp(-d * 7.0) * 0.32 + exp(-d * 22.0) * 0.45;
          col += uSunCol * (disc * 6.0 + glow) * uSunVis;
          bloomOk = max(bloomOk, smoothstep(0.07, 0.03, d) * uSunVis);
          // moon
          vec2 mp = vec2(uMoon.x * 0.5 * uAspect, uMoon.y * 0.5);
          float md = length(p - mp);
          float mdisc = smoothstep(0.0165, 0.0145, md);
          float crater = 0.86 + 0.14 * hash(floor((p - mp) * 380.0));
          float shade = smoothstep(-0.02, 0.012, dot(p - mp, normalize(vec2(-0.7, 0.4))) + 0.008);
          col += vec3(0.92, 0.94, 1.0) * mdisc * 1.5 * crater * mix(0.3, 1.0, shade) * uMoonVis;
          col += vec3(0.55, 0.65, 1.0) * (exp(-md * 22.0) * 0.07) * uMoonVis;
          bloomOk = max(bloomOk, mdisc * uMoonVis * 0.6);
          // stars
          if (uStars * uNight > 0.01) {
            vec2 g = p * 64.0;
            vec2 id = floor(g);
            vec2 f = fract(g) - 0.5;
            float h = hash(id);
            if (h > 0.986) {
              vec2 off = vec2(hash(id + 1.7), hash(id + 3.1)) - 0.5;
              float sd = length(f - off * 0.6);
              float tw = mix(1.0, 0.55 + 0.45 * sin(uTime * (0.8 + h * 2.5) + h * 91.0), uTwinkle);
              float size = 0.06 + 0.06 * fract(h * 37.0);
              float s = smoothstep(size, 0.0, sd) * tw * uNight * smoothstep(0.12, 0.5, y);
              col += vec3(0.86, 0.92, 1.0) * s * (0.6 + 0.9 * fract(h * 113.0));
            }
          }
        }
        // break up banding
        col *= 1.0 + (hash(gl_FragCoord.xy + fract(uTime) * 17.0) - 0.5) * 0.012;
        // alpha 2 marks "sky": the bloom pass ignores it (the final pass clamps alpha to 1)
        gl_FragColor = vec4(col, 2.0 - bloomOk);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(FULLSCREEN_TRI, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1e6;
  mesh.raycast = () => {};
  noPick(mesh);

  const colors = { top: new THREE.Color(), mid: new THREE.Color(), horizon: new THREE.Color() };
  const sunDirection = new THREE.Vector3(0, 1, -1).normalize();
  const moonDirection = new THREE.Vector3(0, 1, -1).normalize();
  let hours = 12, exposure = o.exposure, flatColor = null, sunElev = 0, nightAmt = 1;
  const tmp = new THREE.Color();

  function apply() {
    let s;
    if (flatColor) {
      uniforms.uFlat.value = 1;
      colors.top.set(flatColor); colors.mid.set(flatColor); colors.horizon.set(flatColor);
      s = { sun: 0, night: 0 };
    } else {
      uniforms.uFlat.value = 0;
      s = skyAt(hours);
      colors.top.set(s.top); colors.mid.set(s.mid); colors.horizon.set(s.horizon);
    }
    inverseACES(colors.top, exposure, uniforms.uTop.value);
    inverseACES(colors.mid, exposure, uniforms.uMid.value);
    inverseACES(colors.horizon, exposure, uniforms.uHor.value);
    const h = ((hours % 24) + 24) % 24;
    // sun arc 6 → 18, moon arc 18 → 6
    const ts = (h - 6) / 12;
    const sunUp = ts > 0 && ts < 1;
    const sx = lerp(-0.9, 0.9, clamp(ts, 0, 1));
    const sy = -0.42 + 1.18 * Math.sin(Math.PI * clamp(ts, 0, 1));
    uniforms.uSun.value.set(sx, sy);
    uniforms.uSunVis.value = sunUp ? smooth(clamp(Math.sin(Math.PI * ts) / 0.22, 0, 1)) : 0;
    const warm = 1 - clamp(Math.sin(Math.PI * clamp(ts, 0, 1)) / 0.6, 0, 1);
    uniforms.uSunCol.value.set('#FFF1D6').lerp(tmp.set('#FF9A55'), warm);
    const tm = (((h - 18) + 24) % 24) / 12;
    const moonUp = tm > 0 && tm < 1;
    uniforms.uMoon.value.set(lerp(-0.85, 0.85, clamp(tm, 0, 1)), -0.3 + 1.0 * Math.sin(Math.PI * clamp(tm, 0, 1)));
    uniforms.uMoonVis.value = moonUp ? smooth(clamp(Math.sin(Math.PI * tm) / 0.25, 0, 1)) * s.night : 0;
    uniforms.uNight.value = s.night;
    // world-space directions towards the sun and moon (behind the scene, +y up; below the horizon when set),
    // matching where they are drawn on the backdrop
    const sunArc = Math.sin(Math.PI * ts), moonArc = Math.sin(Math.PI * tm);
    sunDirection.set(sx * 6, 4 * sunArc + 1.2 * (sy + 0.42), -7).normalize();
    moonDirection.set(uniforms.uMoon.value.x * 6, 4 * moonArc + 1.2 * (uniforms.uMoon.value.y + 0.3), -7).normalize();
    sunElev = s.sun; nightAmt = s.night;
  }

  const sky = {
    mesh, kind: 'sky', colors, sunDirection, moonDirection, uniforms,
    get hours() { return hours; },
    get sun() { return sunElev; },     // 0..1 sun elevation (0 at night)
    get night() { return nightAmt; },  // 0..1
    setTime(hh) { hours = hh; flatColor = null; apply(); },
    setFlat(color) { flatColor = color; apply(); },
    setExposure(e) { exposure = e; apply(); },
    setAspect(a) { uniforms.uAspect.value = a; },
    _tick(dt, t) { uniforms.uTime.value = t; uniforms.uTwinkle.value = prefersReducedMotion() ? 0 : 1; },
    dispose() { mat.dispose(); mesh.removeFromParent(); },
  };
  sky.setTime(o.time ?? 20.5);
  return sky;
}

/* ================================================================ stage */

class NovaBloom extends UnrealBloomPass {
  // Same blur/composite as UnrealBloomPass, but it leaves the result in its own target
  // (the final pass adds it) and ignores "sky" pixels marked with alpha > 1.
  constructor(res, strength, radius, threshold) {
    super(res, strength, radius, threshold);
    this.materialHighPassFilter.fragmentShader = /* glsl */`
      uniform sampler2D tDiffuse; uniform vec3 defaultColor; uniform float defaultOpacity;
      uniform float luminosityThreshold; uniform float smoothWidth;
      varying vec2 vUv;
      void main(){
        vec4 texel = texture2D(tDiffuse, vUv);
        float v = dot(texel.rgb, vec3(0.299, 0.587, 0.114));
        float sky = clamp(texel.a - 1.0, 0.0, 1.0);
        float a = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v) * (1.0 - sky);
        gl_FragColor = mix(vec4(defaultColor, defaultOpacity), vec4(min(texel.rgb, vec3(24.0)), 1.0), a);
      }`;
    this.materialHighPassFilter.vertexShader = LuminosityHighPassShader.vertexShader;
    this.materialHighPassFilter.needsUpdate = true;
  }
  get texture() { return this.renderTargetsHorizontal[0].texture; }
  renderBloom(renderer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    renderer.getClearColor(this._oldClearColor);
    const oldAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);
    this.highPassUniforms.tDiffuse.value = readBuffer.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    this.fsQuad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright); renderer.clear(); this.fsQuad.render(renderer);
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      this.fsQuad.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]); renderer.clear(); this.fsQuad.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]); renderer.clear(); this.fsQuad.render(renderer);
      input = this.renderTargetsVertical[i];
    }
    this.fsQuad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]); renderer.clear(); this.fsQuad.render(renderer);
    renderer.setClearColor(this._oldClearColor, oldAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

const FINAL_FRAG = /* glsl */`
  uniform sampler2D tScene; uniform sampler2D tBloom;
  uniform float uBloom, uGrain, uVignette, uScan, uAberr, uTime;
  uniform vec2 uRes;
  varying vec2 vUv;
  float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
  void main(){
    vec4 s = texture2D(tScene, vUv);
    vec3 col = s.rgb;
    if (uAberr > 0.0) {
      vec2 dir = (vUv - 0.5) * uAberr * 0.004;
      col.r = texture2D(tScene, vUv + dir).r;
      col.b = texture2D(tScene, vUv - dir).b;
    }
    float a = clamp(s.a, 0.0, 1.0);
    col += uBloom * texture2D(tBloom, vUv).rgb;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    vec3 c = gl_FragColor.rgb;
    vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float vig = 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
    c *= mix(1.0, vig, a);
    c *= 1.0 - uScan * 0.10 * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159));
    c += (hash(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5) * uGrain * a;
    gl_FragColor = vec4(c, a);
  }`;

export function createStage(container, options = {}) {
  if (!container) throw new Error('Nova3D: createStage needs a container element');
  const o = {
    background: 'sky', bloom: true, css3d: true, quality: 'auto', pixelRatioCap: 1.75,
    fov: 30, camera: [0, 1.4, 11], target: [0, 0.9, 0], timeOfDay: 20.5, exposure: 1.0,
    autoStart: true, autoPause: true, environment: true, ...options,
  };
  o.fx = { grain: 0.035, vignette: 0.22, scanlines: 0, aberration: 0, ...(options.fx || {}) };

  let renderer;
  try {
    // No MSAA or depth on the canvas itself: the scene renders into its own multisampled target.
    renderer = new THREE.WebGLRenderer({ antialias: false, depth: false, stencil: false, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    const e = new Error('Nova3D: WebGL unavailable');
    e.code = 'NO_WEBGL'; e.cause = err;
    throw e;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = o.exposure;
  renderer.setClearColor(0x000000, 0);

  const cs = getComputedStyle(container);
  if (cs.position === 'static') container.style.position = 'relative';
  container.style.isolation = 'isolate';

  const canvas = renderer.domElement;
  canvas.className = 'nova3d-gl';
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', zIndex: '1', pointerEvents: 'none', display: 'block' });

  let css3d = null, cssLayer = null;
  if (o.css3d) {
    css3d = new CSS3DRenderer();
    cssLayer = css3d.domElement;
    cssLayer.className = 'nova3d-css';
    Object.assign(cssLayer.style, { position: 'absolute', left: '0', top: '0', zIndex: '0', pointerEvents: 'none' });
    container.insertBefore(cssLayer, container.firstChild);
    container.insertBefore(canvas, cssLayer.nextSibling);
    // Focusing an input inside a 3D-transformed, overflow:hidden layer can scroll that layer and
    // shift every screen: keep the structural layers pinned at 0,0.
    cssLayer.addEventListener('scroll', (e) => {
      const t = e.target;
      if (t === cssLayer || t.parentNode === cssLayer || t.parentNode?.parentNode === cssLayer || t.classList?.contains('nova3d-screen')) {
        if (t.scrollTop || t.scrollLeft) { t.scrollTop = 0; t.scrollLeft = 0; }
      }
    }, true);
  } else {
    container.insertBefore(canvas, container.firstChild);
  }

  const scene = new THREE.Scene();
  // shared PMREM studio environment (reflections); false skips it (faster start, flatter metals),
  // or pass your own THREE.Texture
  scene.environment = o.environment === false ? null : o.environment?.isTexture ? o.environment : studioEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(o.fov, 1, 0.05, 400);
  camera.position.set(...o.camera);
  const camTarget = new THREE.Vector3(...o.target);
  camera.lookAt(camTarget);

  // lights
  const hemi = new THREE.HemisphereLight('#c8d4ff', '#2a2018', 0.6);
  const key = new THREE.DirectionalLight('#fff3e6', 1.8); key.position.set(4, 7, 9);
  const fill = new THREE.DirectionalLight('#cfe0ff', 0.45); fill.position.set(-7, 2.5, 5);
  const rim = new THREE.DirectionalLight('#ffd2a8', 1.2); rim.position.set(-4, 5, -8);
  scene.add(hemi, key, fill, rim);

  let sky = null;
  const listeners = { resize: new Set(), quality: new Set(), time: new Set() };
  const emit = (type, detail) => listeners[type]?.forEach((fn) => { try { fn(detail); } catch (e) { console.error(e); } });

  const reduced = { value: prefersReducedMotion() };
  const onMq = () => { reduced.value = prefersReducedMotion(); };
  _mq?.addEventListener?.('change', onMq);

  // post-processing
  let quality = o.quality === 'low' ? 'low' : 'high';
  let sceneRT = null, bloom = null;
  const finalMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0 },
      uGrain: { value: o.fx.grain }, uVignette: { value: o.fx.vignette }, uScan: { value: o.fx.scanlines }, uAberr: { value: o.fx.aberration },
      uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FINAL_FRAG,
    depthTest: false, depthWrite: false,
  });
  const finalQuad = new FullScreenQuad(finalMat);

  let width = 1, height = 1, dpr = 1;
  const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blackTex.needsUpdate = true;
  function buildTargets() {
    const bw = Math.max(1, Math.round(width * dpr)), bh = Math.max(1, Math.round(height * dpr));
    // MSAA: 4 samples at ~1x density, 2 when the pixel ratio already smooths edges (or in low quality)
    const samples = quality === 'high' && dpr < 1.3 ? 4 : 2;
    if (!sceneRT || sceneRT.samples !== samples) {
      sceneRT?.dispose();
      sceneRT = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, samples });
    } else {
      sceneRT.setSize(bw, bh);
    }
    // three r170 sizes its transmission target from camera.viewport when set: half resolution is plenty
    camera.viewport = new THREE.Vector4(0, 0, Math.max(1, Math.round(bw / 2)), Math.max(1, Math.round(bh / 2)));
    if (quality === 'high' && o.bloom) {
      if (!bloom) { bloom = new NovaBloom(new THREE.Vector2(256, 256), 0.72, 0.55, 1.35); bloom.highPassUniforms.smoothWidth.value = 0.65; }
      bloom.setSize(Math.max(2, Math.round(bw / 2)), Math.max(2, Math.round(bh / 2)));
    }
  }

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    width = w; height = h;
    dpr = quality === 'high' ? Math.min(window.devicePixelRatio || 1, o.pixelRatioCap) : 1;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    css3d?.setSize(w, h);
    sky?.setAspect(w / h);
    finalMat.uniforms.uRes.value.set(w, h);
    buildTargets();
    emit('resize', { width: w, height: h });
  }

  const ticking = new Set();
  const frameFns = new Set();
  const pickables = new Map(); // Object3D → handle (or the object itself)

  const stage = {
    scene, camera, renderer, css3d, container, canvas, cssLayer,
    get sky() { return sky; },
    get reducedMotion() { return reduced.value; },
    get quality() { return quality; },
    get time() { return timeOfDay; },
    get width() { return width; },
    get height() { return height; },
    _router: null,
  };

  /* ---------------- background and time of day */
  let timeOfDay = o.timeOfDay;
  let bgMode = null;
  function setBackground(bg) {
    bgMode = bg;
    if (bg === 'transparent') {
      if (sky) { sky.mesh.removeFromParent(); ticking.delete(sky); }
    } else {
      if (!sky) { sky = createSky({ time: timeOfDay, exposure: renderer.toneMappingExposure }); }
      if (!sky.mesh.parent) scene.add(sky.mesh);
      ticking.add(sky);
      sky.setAspect(width / height);
      if (bg === 'sky') sky.setTime(timeOfDay); else sky.setFlat(bg);
    }
  }

  const _c1 = new THREE.Color(), _c2 = new THREE.Color();
  function setTimeOfDay(hours) {
    timeOfDay = hours;
    const s = skyAt(hours);
    const day = 1 - s.night;
    const h = ((hours % 24) + 24) % 24;
    const golden = clamp(1 - Math.abs(h - 17.7) / 1.7, 0, 1) + 0.8 * clamp(1 - Math.abs(h - 6.9) / 1.3, 0, 1);
    hemi.color.set(s.mid).lerp(_c1.set('#9fb0ff'), s.night * 0.5);
    hemi.groundColor.set('#2a2018').lerp(_c1.set(s.horizon), 0.25);
    hemi.intensity = lerp(0.45, 0.85, day);
    key.color.set('#aebcff').lerp(_c1.set('#fff3e6'), day).lerp(_c2.set('#ffc38c'), clamp(golden, 0, 1) * 0.6);
    key.intensity = lerp(1.05, 1.9, day);
    fill.intensity = lerp(0.5, 0.4, day);
    rim.color.set(s.horizon).lerp(_c1.set('#ffffff'), 0.25);
    rim.intensity = lerp(0.9, 1.4, day) + golden * 1.4;
    if (sky && bgMode === 'sky') {
      sky.setTime(hours);
      rim.position.copy(sky.sun > 0.02 ? sky.sunDirection : sky.moonDirection).multiplyScalar(10);
      rim.position.z = Math.min(rim.position.z, -3);
    }
    scene.environmentIntensity = lerp(0.75, 1.0, day) + 0.5 * s.sun; // reflections brighten under a bright sky
    emit('time', { hours });
  }

  /* ---------------- quality */
  function setQuality(q) {
    q = q === 'low' ? 'low' : 'high';
    if (q === quality && sceneRT !== undefined) { /* still rebuild below for first call */ }
    const changed = q !== quality;
    quality = q;
    resize();
    for (const h of pickables.values()) h?._setQuality?.(q);
    for (const h of ticking) h?._setQuality?.(q);
    if (changed) emit('quality', { quality: q });
  }

  function setBloom(on) {
    o.bloom = !!on;
    if (o.bloom && !bloom && quality === 'high') buildTargets();
  }

  function setFx(fx = {}) {
    Object.assign(o.fx, fx);
    const u = finalMat.uniforms;
    u.uGrain.value = o.fx.grain; u.uVignette.value = o.fx.vignette; u.uScan.value = o.fx.scanlines; u.uAberr.value = o.fx.aberration;
  }

  /* ---------------- scene graph */
  function add(x) {
    const g = groupOf(x);
    if (!g) return x;
    if (!g.parent) scene.add(g);
    pickables.set(g, x);
    if (x._tick) ticking.add(x);
    x._attach?.(stage);
    x._setQuality?.(quality);
    return x;
  }
  function remove(x) {
    const g = groupOf(x);
    if (!g) return;
    g.removeFromParent();
    pickables.delete(g);
    ticking.delete(x);
    x._detach?.(stage);
  }

  /* ---------------- picking */
  const raycaster = new THREE.Raycaster();
  raycaster.camera = camera;
  const ndc = new THREE.Vector2();
  function toNDC(clientX, clientY) {
    const r = container.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    return ndc;
  }
  function visibleChain(obj) { for (let p = obj; p; p = p.parent) { if (!p.visible || p.userData.noPick) return false; } return true; }
  function pick(clientX, clientY, list) {
    toNDC(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const roots = list ? list.map(groupOf).filter(Boolean) : [...pickables.keys()];
    const hits = raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      if (!visibleChain(hit.object)) continue;
      let root = hit.object;
      while (root && !roots.includes(root)) root = root.parent;
      if (!root) continue;
      return { handle: pickables.get(root) || root, object: hit.object, point: hit.point, distance: hit.distance, uv: hit.uv || null };
    }
    return null;
  }
  const _proj = new THREE.Vector3();
  function project(v) {
    if (v.isObject3D) v.getWorldPosition(_proj); else _proj.copy(v);
    _proj.project(camera);
    const r = container.getBoundingClientRect();
    return { x: r.left + (_proj.x * 0.5 + 0.5) * r.width, y: r.top + (-_proj.y * 0.5 + 0.5) * r.height, visible: _proj.z < 1 && Math.abs(_proj.x) <= 1.05 && Math.abs(_proj.y) <= 1.05 };
  }

  /* ---------------- camera */
  let fly = null;
  function setCamera({ position, target, fov } = {}) {
    fly = null;
    if (position) camera.position.set(...position);
    if (target) camTarget.set(...target);
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.lookAt(camTarget);
  }
  function flyTo({ position, target, fov } = {}, { duration = 1.2 } = {}) {
    if (reduced.value || duration <= 0) { setCamera({ position, target, fov }); return Promise.resolve(); }
    return new Promise((resolve) => {
      fly = {
        t: 0, d: duration, resolve,
        p0: camera.position.clone(), p1: position ? new THREE.Vector3(...position) : camera.position.clone(),
        t0: camTarget.clone(), t1: target ? new THREE.Vector3(...target) : camTarget.clone(),
        f0: camera.fov, f1: fov || camera.fov,
      };
    });
  }

  /* ---------------- loop */
  let running = false, raf = 0, last = 0, elapsed = 0, frames = 0, slowSum = 0, autoDone = o.quality !== 'auto';
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dtRaw = last ? (now - last) / 1000 : 1 / 60;
    last = now;
    const dt = Math.min(dtRaw, 0.1);
    elapsed += dt;
    if (!autoDone) {
      frames++;
      if (frames > 40) slowSum += dtRaw;
      if (frames === 160) {
        autoDone = true;
        if (slowSum / 120 > 0.022 && quality === 'high') setQuality('low');
      }
    }
    advance(dt);
    render();
  }
  function advance(dt) {
    if (fly) {
      fly.t += dt;
      const k = easeOutExpo(clamp(fly.t / fly.d, 0, 1));
      camera.position.lerpVectors(fly.p0, fly.p1, k);
      camTarget.lerpVectors(fly.t0, fly.t1, k);
      camera.fov = lerp(fly.f0, fly.f1, k); camera.updateProjectionMatrix();
      camera.lookAt(camTarget);
      if (fly.t >= fly.d) { const r = fly.resolve; fly = null; r(); }
    }
    for (const h of ticking) h._tick(dt, elapsed, stage);
    for (const fn of frameFns) { try { fn(dt, elapsed); } catch (e) { console.error(e); } }
  }
  // Compile every material's shaders for the scene's render target up front (uses
  // KHR_parallel_shader_compile where available), so the first frames don't hitch.
  function compileAsync() {
    if (!renderer.compileAsync || !sceneRT) return Promise.resolve();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(sceneRT);
    let p;
    try { p = renderer.compileAsync(scene, camera); } catch (e) { p = Promise.resolve(); }
    renderer.setRenderTarget(prev);
    return Promise.resolve(p).then(() => undefined, () => undefined);
  }
  // advance time by dt seconds and render once (deterministic capture while the loop is stopped)
  function step(dt = 1 / 60) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    elapsed += dt;
    advance(dt);
    render();
  }
  function render() {
    finalMat.uniforms.uTime.value = elapsed;
    if (!sceneRT) return;
    const high = quality === 'high';
    renderer.setRenderTarget(sceneRT);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    const useBloom = !!(high && bloom && o.bloom);
    if (useBloom) bloom.renderBloom(renderer, sceneRT);
    const u = finalMat.uniforms;
    u.tScene.value = sceneRT.texture;
    u.tBloom.value = useBloom ? bloom.texture : blackTex;
    u.uBloom.value = useBloom ? 1 : 0;
    u.uGrain.value = high ? o.fx.grain : 0; u.uVignette.value = high ? o.fx.vignette : 0;
    u.uScan.value = high ? o.fx.scanlines : 0; u.uAberr.value = high ? o.fx.aberration : 0;
    renderer.setRenderTarget(null);
    renderer.clear(true, false, false);
    finalQuad.render(renderer);
    if (css3d) css3d.render(scene, camera);
  }
  function start() { if (running) return; running = true; last = 0; raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  let wasRunning = false;
  const onVis = () => {
    if (document.hidden) { wasRunning = running; stop(); }
    else if (wasRunning && !offscreen) start();
  };
  document.addEventListener('visibilitychange', onVis);

  // pause while the container is scrolled out of view (landing page sections)
  let offscreen = false, pausedByView = false;
  const io = o.autoPause && typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    const vis = entries[entries.length - 1].isIntersecting;
    offscreen = !vis;
    if (!vis && running) { pausedByView = true; stop(); }
    else if (vis && pausedByView) { pausedByView = false; start(); }
  }, { rootMargin: '120px' }) : null;
  io?.observe(container);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);
  const onWinResize = () => resize();
  window.addEventListener('resize', onWinResize);

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); });
  canvas.addEventListener('webglcontextrestored', () => { resize(); start(); });

  function dispose() {
    stop();
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onWinResize);
    _mq?.removeEventListener?.('change', onMq);
    ro?.disconnect();
    io?.disconnect();
    stage._router?.dispose();
    for (const x of [...pickables.values()]) x?.dispose?.();
    sky?.dispose();
    sceneRT?.dispose();
    bloom?.dispose();
    finalMat.dispose();
    finalQuad.dispose();
    blackTex.dispose();
    renderer.dispose();
    canvas.remove();
    cssLayer?.remove();
  }

  Object.assign(stage, {
    add, remove, pick, project, resize, start, stop, render, step, compileAsync, dispose,
    setTimeOfDay, setBackground, setQuality, setBloom, setFx, setCamera, flyTo,
    getQuality: () => quality,
    onFrame(fn) { frameFns.add(fn); return () => frameFns.delete(fn); },
    on(type, fn) { (listeners[type] ||= new Set()).add(fn); return () => listeners[type].delete(fn); },
    _toNDC: toNDC, _raycaster: raycaster, _camTarget: camTarget,
  });

  setBackground(o.background);
  resize();
  setTimeOfDay(timeOfDay);
  if (o.autoStart) start();
  return stage;
}

/* ===================================================== pointer routing */

function getRouter(stage) {
  if (stage._router) return stage._router;
  const el = stage.container;
  const items = []; // { priority, enabled, claim(e) → gesture | null, hover(e) → cursor | null }
  let active = null;
  let hoverRaf = 0, lastMove = null;
  const isScreen = (e) => !!(e.target && e.target.closest && e.target.closest('.nova3d-screen'));
  const down = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isScreen(e) || active) return;
    for (const it of items) {
      if (!it.enabled) continue;
      const g = it.claim(e);
      if (g) {
        active = { g, id: e.pointerId };
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();
        // no text selection on the live HTML screens while something is being dragged over them
        try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
        document.documentElement.classList.add('nova3d-gesture');
        el.style.cursor = g.cursor || el.style.cursor;
        break;
      }
    }
  };
  const move = (e) => {
    if (active && e.pointerId === active.id) { active.g.move(e); return; }
    if (active || e.pointerType === 'touch') return;
    lastMove = e;
    if (!hoverRaf) hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (!lastMove) return;
      if (isScreen(lastMove)) { el.style.cursor = ''; return; }
      let cursor = '';
      for (const it of items) { if (!it.enabled) continue; const c = it.hover?.(lastMove); if (c) { cursor = c; break; } }
      el.style.cursor = cursor;
    });
  };
  const up = (e, cancelled) => {
    if (!active || e.pointerId !== active.id) return;
    const g = active.g;
    active = null;
    try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    el.style.cursor = '';
    document.documentElement.classList.remove('nova3d-gesture');
    g.up(e, cancelled);
  };
  const onUp = (e) => up(e, false), onCancel = (e) => up(e, true);
  const noSelect = (e) => { if (active) e.preventDefault(); };
  document.addEventListener('selectstart', noSelect);
  if (!document.getElementById('nova3d-style')) {
    const st = document.createElement('style');
    st.id = 'nova3d-style';
    st.textContent = '.nova3d-gesture, .nova3d-gesture * { user-select: none !important; -webkit-user-select: none !important; }';
    document.head.appendChild(st);
  }
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  const router = {
    add(it) { items.push(it); items.sort((a, b) => b.priority - a.priority); return () => { const i = items.indexOf(it); if (i >= 0) items.splice(i, 1); }; },
    get active() { return active; },
    dispose() {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('selectstart', noSelect);
    },
  };
  stage._router = router;
  return router;
}

/* ========================================================== light ring */

const LIGHTBAR_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uBase, uSweepA, uSweepPos, uSweepW, uCenter, uSpread;
  varying vec2 vUv;
  void main(){
    float x = vUv.x;
    float ends = smoothstep(0.0, 0.07, x) * smoothstep(1.0, 0.93, x);
    float s1 = exp(-pow((x - uSweepPos) / uSweepW, 2.0));
    float s2 = exp(-pow((x - (1.0 - uSweepPos)) / uSweepW, 2.0));
    float c = exp(-pow((x - 0.5) / max(uSpread, 0.001), 2.0));
    float I = (uBase + uSweepA * max(s1, s2) + uCenter * c) * ends;
    float across = 1.0 - pow(abs(vUv.y - 0.5) * 2.0, 4.0);
    vec3 col = uColor * I * mix(0.35, 1.0, across);
    col += vec3(1.0) * max(I - 3.2, 0.0) * 0.10 * across;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const BASIC_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

function lightBarMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(COLORS.nova) }, uBase: { value: 0 }, uSweepA: { value: 0 }, uSweepPos: { value: 0.5 },
      uSweepW: { value: 0.1 }, uCenter: { value: 0 }, uSpread: { value: 0.3 },
    },
    vertexShader: BASIC_VERT, fragmentShader: LIGHTBAR_FRAG,
  });
}

const STATE_COLORS = { off: COLORS.nova, idle: COLORS.nova, listening: COLORS.nova, thinking: COLORS.nova, speaking: COLORS.nova, notify: COLORS.amber, urgent: COLORS.coral, success: COLORS.sage };

// Drives the light-bar uniforms from a state; returns an overall glow level for halos and spill.
function makeRingDriver() {
  const cur = { base: 0.3, sweepA: 0, sweepPos: 0.5, sweepW: 0.1, center: 0, spread: 0.3 };
  const color = new THREE.Color(COLORS.nova);
  const tgtColor = new THREE.Color();
  let state = 'idle', t = 0, level = null, smoothLevel = 0.5;
  return {
    get state() { return state; },
    set(s) { if (!RING_STATES.includes(s)) { console.warn('Nova3D: unknown ring state', s); return; } if (s !== state) { state = s; t = 0; } },
    setLevel(l) { level = l == null ? null : clamp(+l, 0, 1); },
    update(dt, u) {
      t += dt;
      const rm = prefersReducedMotion();
      const tg = { base: 0, sweepA: 0, sweepPos: 0.5, sweepW: 0.1, center: 0, spread: 0.3 };
      const breathe = (period) => 0.5 - 0.5 * Math.cos((TAU * t) / period);
      const pulse = (period) => Math.pow(Math.sin(Math.PI * ((t / period) % 1)), 2);
      switch (state) {
        case 'off': break;
        case 'idle': tg.base = 0.34; break;
        case 'listening': {
          const b = rm ? 0.6 : breathe(2.6);
          tg.base = 0.85 + 1.5 * b; tg.center = 0.9 * b; tg.spread = 0.32; break;
        }
        case 'thinking':
          if (rm) { tg.base = 1.2 + 0.3 * breathe(4); }
          else { tg.base = 0.4; tg.sweepA = 3.8; tg.sweepPos = 0.5 + 0.47 * Math.sin(t * 2.5); tg.sweepW = 0.085; }
          break;
        case 'speaking': {
          const proc = 0.5 + 0.5 * (0.6 * Math.sin(t * 8.7) * Math.sin(t * 3.1 + 1.3) + 0.4 * Math.sin(t * 13.3 + 0.7));
          const l = level != null ? level : rm ? 0.55 : proc;
          smoothLevel = damp(smoothLevel, l, 18, dt);
          tg.base = 0.9; tg.center = 1.2 + 3.6 * smoothLevel; tg.spread = 0.16 + 0.3 * smoothLevel; break;
        }
        case 'notify': { const p = rm ? 0.5 : pulse(1.7); tg.base = 0.6 + 2.6 * p; tg.center = 0.8 * p; tg.spread = 0.4; break; }
        case 'urgent': { const p = rm ? 0.7 : pulse(0.78); tg.base = 0.9 + 3.6 * p; tg.center = 0.6 * p; tg.spread = 0.45; break; }
        case 'success': tg.base = 1.7 + (rm ? 0 : 0.25 * breathe(3.2)); break;
      }
      const k = rm ? 5 : 16;
      for (const key of Object.keys(cur)) cur[key] = damp(cur[key], tg[key], key === 'sweepPos' ? 30 : k, dt);
      tgtColor.set(STATE_COLORS[state]);
      color.lerp(tgtColor, 1 - Math.exp(-dt * 7));
      if (u) {
        u.uColor.value.copy(color); u.uBase.value = cur.base; u.uSweepA.value = cur.sweepA; u.uSweepPos.value = cur.sweepPos;
        u.uSweepW.value = cur.sweepW; u.uCenter.value = cur.center; u.uSpread.value = cur.spread;
      }
      return { color, glow: cur.base + cur.sweepA * 0.22 + cur.center * cur.spread * 0.9 };
    },
  };
}

/* ======================================================= device faces */

const GLARE_VERT = /* glsl */`
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const GLARE_FRAG = /* glsl */`
  uniform float uAmount; uniform vec3 uRing; uniform float uRingAmt;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){
    float fres = pow(1.0 - clamp(dot(vN, vV), 0.0, 1.0), 4.0);
    vec3 r = reflect(-vV, vN);
    float d = vUv.x * 0.62 + vUv.y + r.x * 0.9 + r.y * 0.35;
    float band = exp(-pow((d - 1.02) / 0.11, 2.0)) * 0.55 + exp(-pow((d - 1.24) / 0.028, 2.0)) * 0.35;
    float top = smoothstep(0.55, 1.0, vUv.y) * 0.25;
    vec3 c = vec3(0.86, 0.92, 1.0) * (0.006 + band * 0.03 + top * 0.02 + fres * 0.22) * uAmount;
    c += uRing * uRingAmt * 0.06 * exp(-vUv.y * 7.0);
    gl_FragColor = vec4(c, 1.0);
  }`;
const IDLE_SCREEN_FRAG = /* glsl */`
  uniform vec3 uRing; uniform float uRingAmt;
  varying vec2 vUv;
  void main(){
    vec2 p = vUv - 0.5;
    vec3 c = vec3(0.0035, 0.0045, 0.0075);
    c += vec3(0.010, 0.014, 0.024) * (1.0 - smoothstep(0.0, 0.75, length(p * vec2(1.0, 1.5))));
    c += uRing * uRingAmt * 0.05 * exp(-vUv.y * 6.0);
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function blackGlassMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: '#050608', roughness: 0.14, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.04,
    ior: 1.5, specularIntensity: 1, envMapIntensity: 1.1,
  });
}

function cameraLens(radius = 0.026, { trim = '#23262d', trimWidth = 0.55 } = {}) {
  const g = new THREE.Group();
  const well = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.04, 40), new THREE.MeshBasicMaterial({ color: '#010102' }));
  const bezel = new THREE.Mesh(new THREE.RingGeometry(radius * 1.02, radius * (1.02 + trimWidth), 56), new THREE.MeshPhysicalMaterial({ color: trim, roughness: 0.22, metalness: 1, envMapIntensity: 1.4 }));
  const aperture = new THREE.Mesh(new THREE.RingGeometry(radius * 0.3, radius * 0.62, 40), new THREE.MeshPhysicalMaterial({ color: '#141a3a', roughness: 0.15, metalness: 0.6, iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessRange: [300, 600], envMapIntensity: 1.5 }));
  const lens = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 16, 0, TAU, 0, Math.PI / 2.6),
    new THREE.MeshPhysicalMaterial({ color: '#000000', roughness: 0.02, metalness: 0, transparent: true, opacity: 0.35, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.8, iridescenceIOR: 1.9, iridescenceThicknessRange: [260, 520], envMapIntensity: 2.2, depthWrite: false })
  );
  lens.rotation.x = Math.PI / 2;
  lens.scale.z = 0.5;
  lens.position.z = -radius * 0.55;
  well.position.z = 0.0003; bezel.position.z = 0.0006; aperture.position.z = 0.0008;
  g.add(well, bezel, aperture, lens);
  return g;
}

// A device face: glass front surface at local z = 0, +z out of the glass.
function buildFace({ glassW, glassH, glassD = 0.024, glassR = 0.045, dispW, dispH, dispY = 0, camX = 0, camY, barW, barY, barH = 0.014 }) {
  const face = new THREE.Group();
  const glass = new THREE.Mesh(new RoundedBoxGeometry(glassW, glassH, glassD, 3, Math.min(glassR, glassD / 2 - 0.0005)), blackGlassMaterial());
  glass.position.z = -glassD / 2;
  face.add(glass);

  // the display: idle glass, image, or a transparent hole for the CSS3D screen
  const dispGeo = new THREE.ShapeGeometry(roundedRectShape(dispW, dispH, 0.012), 6);
  // ShapeGeometry UVs are in shape units: normalise to 0..1
  {
    const uv = dispGeo.attributes.uv, pos = dispGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / dispW + 0.5, pos.getY(i) / dispH + 0.5);
  }
  const ringU = { uRing: { value: new THREE.Color(COLORS.nova) }, uRingAmt: { value: 0 } };
  const idleMat = new THREE.ShaderMaterial({ uniforms: ringU, vertexShader: BASIC_VERT, fragmentShader: IDLE_SCREEN_FRAG });
  const holeMat = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0, blending: THREE.NoBlending });
  const imageMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.92, 0.92, 0.92) });
  const display = new THREE.Mesh(dispGeo, idleMat);
  display.position.set(0, dispY, 0.0006);
  face.add(display);

  const glare = new THREE.Mesh(dispGeo, additiveKeepAlpha(new THREE.ShaderMaterial({
    uniforms: { uAmount: { value: 1 }, ...ringU }, vertexShader: GLARE_VERT, fragmentShader: GLARE_FRAG,
  })));
  glare.position.set(0, dispY, 0.0012);
  glare.renderOrder = 2;
  noPick(glare);
  face.add(glare);

  const anchor = new THREE.Object3D();
  anchor.position.set(0, dispY, 0.0008);
  face.add(anchor);

  const barMat = lightBarMaterial();
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(barW, barH), barMat);
  bar.position.set(0, barY, 0.0008);
  face.add(bar);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(barW * 1.25, barH * 16), additiveKeepAlpha(new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(COLORS.nova), opacity: 0 })));
  halo.position.set(0, barY, 0.002);
  halo.renderOrder = 3;
  noPick(halo);
  face.add(halo);

  const cam = cameraLens(0.022);
  cam.position.set(camX, camY, 0.0004);
  face.add(cam);
  const cameraDot = new THREE.Object3D();
  cameraDot.position.set(camX, camY, 0.01);
  face.add(cameraDot);

  return { face, glass, display, glare, anchor, bar, barMat, halo, ringU, idleMat, holeMat, imageMat, cameraDot, dispW, dispH };
}

function contactShadow(w, d, opacity = 0.6) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTexture(), color: 0x000000, transparent: true, opacity, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2;
  m.scale.set(w * 1.6, d * 1.9, 1);
  m.position.y = 0.003;
  m.renderOrder = -10;
  noPick(m);
  return m;
}

function lightSpill(w, d) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additiveKeepAlpha(new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(COLORS.nova), opacity: 0 })));
  m.rotation.x = -Math.PI / 2;
  m.scale.set(w, d, 1);
  m.position.y = 0.005;
  m.renderOrder = -5;
  noPick(m);
  return m;
}

/* ========================================================= Echo Show */

export function createEchoShow(options = {}) {
  const o = { size: 8, color: 'charcoal', mount: 'stand', shadow: true, ...options };
  const size = +o.size === 15 ? 15 : 8;
  const white = o.color === 'glacier';
  const group = new THREE.Group();
  group.name = `EchoShow${size}`;
  let face, faceGroup, spill = null, pxW, pxH;

  if (size === 8) {
    // Side profile (z, y): slanted front, narrow top, rounded fabric back.
    const b = 0.035;
    const pts = [[0.42, 0.0], [0.145, 1.33], [-0.10, 1.27], [-0.38, 0.96], [-0.52, 0.5], [-0.535, 0.0]].map(([z, y]) => new THREE.Vector2(z, y + b));
    const shape = roundedPolyShape(pts, [0.05, 0.06, 0.16, 0.42, 0.42, 0.06]);
    const W = 2.0 - 2 * b;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 4, curveSegments: 12 });
    geo.rotateY(-Math.PI / 2);
    geo.translate(W / 2, 0, 0);
    geo.computeVertexNormals();
    const fabricColor = white ? '#d8d5cf' : '#4a4e56';
    const fabric = new THREE.MeshPhysicalMaterial({
      color: '#ffffff', map: fabricTextures(fabricColor), bumpMap: fabricBump(), bumpScale: 1.6,
      roughness: 0.9, sheen: 1, sheenColor: new THREE.Color(white ? '#ffffff' : '#b4bccc'), sheenRoughness: 0.6, envMapIntensity: 0.75,
    });
    const body = new THREE.Mesh(geo, fabric);
    group.add(body);

    // front glass on the slanted face
    const A = pts[0], B = pts[1];
    const dir = new THREE.Vector2().subVectors(B, A).normalize();
    const n = new THREE.Vector2(dir.y, -dir.x); // outward (towards +z)
    const mid = new THREE.Vector2().addVectors(A, B).multiplyScalar(0.5);
    const off = b + 0.026;
    faceGroup = new THREE.Group();
    faceGroup.position.set(0, mid.y + n.y * off, mid.x + n.x * off);
    faceGroup.rotation.x = -Math.atan2(n.y, n.x);
    group.add(faceGroup);
    face = buildFace({ glassW: 1.985, glassH: 1.31, dispW: 1.72, dispH: 1.075, dispY: 0.018, camX: 0.62, camY: 0.6, barW: 1.58, barY: -0.565 });
    faceGroup.add(face.face);
    pxW = 1280; pxH = 800;
    if (o.shadow) {
      group.add(contactShadow(2.0, 1.0, 0.7));
      spill = lightSpill(2.4, 1.3);
      spill.position.z = 0.95;
      group.add(spill);
    }
  } else {
    const frameMat = new THREE.MeshPhysicalMaterial({
      color: white ? '#e9e7e2' : '#1c1e22', roughness: 0.48, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5, envMapIntensity: 0.8,
    });
    const panel = new THREE.Group();
    const PW = 4.02, PH = 2.52, PD = 0.3;
    const body = new THREE.Mesh(new RoundedBoxGeometry(PW, PH, PD, 4, 0.06), frameMat);
    body.position.y = PH / 2;
    panel.add(body);
    faceGroup = new THREE.Group();
    faceGroup.position.set(0, PH / 2, PD / 2 + 0.024);
    panel.add(faceGroup);
    face = buildFace({ glassW: 3.86, glassH: 2.36, glassR: 0.05, dispW: 3.45, dispH: 1.94, dispY: 0, camX: 0, camY: 1.075, barW: 3.1, barY: -1.07, barH: 0.016 });
    faceGroup.add(face.face);
    pxW = 1920; pxH = 1080;
    if (o.mount === 'wall') {
      group.add(panel);
    } else {
      panel.position.set(0, 0.11, 0.1);
      panel.rotation.x = -0.17;
      group.add(panel);
      const standMat = frameMat;
      const base = new THREE.Mesh(new RoundedBoxGeometry(2.3, 0.06, 1.15, 3, 0.025), standMat);
      base.position.set(0, 0.03, -0.12);
      const lip = new THREE.Mesh(new RoundedBoxGeometry(2.3, 0.16, 0.12, 3, 0.04), standMat);
      lip.position.set(0, 0.1, 0.33);
      const strut = new THREE.Mesh(new RoundedBoxGeometry(1.3, 1.55, 0.08, 3, 0.035), standMat);
      strut.position.set(0, 0.74, -0.42);
      strut.rotation.x = 0.36;
      group.add(base, lip, strut);
      if (o.shadow) {
        group.add(contactShadow(2.5, 1.2, 0.6));
        spill = lightSpill(4.6, 1.6);
        spill.position.z = 1.1;
        group.add(spill);
      }
    }
  }

  const driver = makeRingDriver();
  let cssObj = null, cssEl = null, screenMode = 'idle', screenTexture = null, quality = 'high';
  const screen = { width: face.dispW, height: face.dispH, aspect: face.dispW / face.dispH, pxWidth: pxW, pxHeight: pxH, mesh: face.display };

  function setScreenMode(mode) {
    screenMode = mode;
    face.display.material = mode === 'html' ? face.holeMat : mode === 'image' ? face.imageMat : face.idleMat;
  }

  const echo = {
    group, kind: 'echo', size, screen,
    screenAnchor: face.anchor, cameraDot: face.cameraDot,
    get ring() { return driver.state; },
    get screenTexture() { return screenTexture; },
    setRing(state) { driver.set(state); return echo; },
    setSpeechLevel(level) { driver.setLevel(level); return echo; },
    attachScreen(el, opts = {}) {
      if (!el) throw new Error('Nova3D: attachScreen needs an element');
      echo.detachScreen();
      const pw = opts.pxWidth || pxW, ph = opts.pxHeight || pxH, fit = opts.fit || 'cover';
      const wrap = document.createElement('div');
      wrap.className = ('nova3d-screen ' + (opts.className || '')).trim();
      Object.assign(wrap.style, { width: pw + 'px', height: ph + 'px', overflow: 'hidden', background: '#000', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' });
      wrap.appendChild(el);
      const obj = new CSS3DObject(wrap);
      wrap.style.userSelect = '';
      let sx = face.dispW / pw, sy = face.dispH / ph;
      if (fit === 'cover') { const s = Math.max(sx, sy); sx = sy = s; }
      else if (fit === 'contain') { const s = Math.min(sx, sy); sx = sy = s; }
      obj.scale.set(sx, sy, 1);
      // The canvas above already masks the HTML to the rounded display, so only clip (for hit-testing)
      // when 'cover' actually overflows; clip-path / border-radius would cost an extra mask layer.
      if (fit === 'cover') {
        const ix = Math.max(0, (pw - face.dispW / sx) / 2), iy = Math.max(0, (ph - face.dispH / sy) / 2);
        if (ix > 1 || iy > 1) wrap.style.clipPath = `inset(${iy}px ${ix}px)`;
      }
      face.anchor.add(obj);
      cssObj = obj; cssEl = el;
      setScreenMode('html');
      return obj;
    },
    detachScreen() {
      if (!cssObj) return null;
      const el = cssEl, wrap = cssObj.element;
      cssObj.removeFromParent();
      if (el.parentNode === wrap) wrap.removeChild(el);
      cssObj = null; cssEl = null;
      setScreenMode(screenTexture ? 'image' : 'idle');
      return el;
    },
    setScreenImage(src, { fit = 'cover' } = {}) {
      if (screenTexture && !screenTexture.userData.external) screenTexture.dispose();
      screenTexture = null;
      if (src == null) { if (!cssObj) setScreenMode('idle'); face.imageMat.map = null; face.imageMat.needsUpdate = true; return Promise.resolve(); }
      const assign = (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        // 'cover': crop to the display's aspect (centred sideways, top-anchored for tall images such as
        // documents); 'stretch': fill as-is
        const im = tex.image, iw = im && (im.videoWidth || im.naturalWidth || im.width), ih = im && (im.videoHeight || im.naturalHeight || im.height);
        tex.repeat.set(1, 1); tex.offset.set(0, 0);
        if (fit === 'cover' && iw && ih) {
          const ia = iw / ih, sa = screen.aspect;
          if (ia > sa) { tex.repeat.x = sa / ia; tex.offset.x = (1 - tex.repeat.x) / 2; }
          else { tex.repeat.y = ia / sa; tex.offset.y = 1 - tex.repeat.y; }
        }
        screenTexture = tex;
        face.imageMat.map = tex; face.imageMat.needsUpdate = true;
        if (!cssObj) setScreenMode('image');
      };
      if (src.isTexture) { src.userData.external = true; assign(src); return Promise.resolve(); }
      if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) { assign(new THREE.CanvasTexture(src)); return Promise.resolve(); }
      if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) { assign(new THREE.VideoTexture(src)); return Promise.resolve(); }
      return loadImage(src).then((img) => { const t = new THREE.Texture(img); t.needsUpdate = true; assign(t); });
    },
    _tick(dt) {
      const r = driver.update(dt, face.barMat.uniforms);
      const g = r.glow;
      face.ringU.uRing.value.copy(r.color);
      face.ringU.uRingAmt.value = g;
      face.halo.material.color.copy(r.color);
      face.halo.material.opacity = clamp(g * (quality === 'high' ? 0.06 : 0.16), 0, 0.85);
      if (spill) { spill.material.color.copy(r.color); spill.material.opacity = clamp(g * 0.07, 0, 0.5); }
    },
    _setQuality(q) { quality = q; },
    dispose() { echo.detachScreen(); disposeObject(group); },
  };
  group.userData.novaHandle = echo;
  echo.setRing('idle');
  return echo;
}

/* ===================================================== Ring doorbell */

const RINGLIGHT_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uBase, uArcA, uArcPos, uArcLen;
  varying vec2 vUv;
  void main(){
    vec2 p = vUv - 0.5;
    float ang = atan(p.y, p.x);
    float d = mod(ang - uArcPos + 3.14159265, 6.2831853) - 3.14159265;
    float tail = d <= 0.0 ? exp(d / uArcLen) : smoothstep(0.12, 0.0, d);
    float r = length(p) * 2.0;
    float across = 1.0 - pow(abs(r - 0.9) / 0.1, 2.0);
    float I = (uBase + uArcA * tail) * clamp(across, 0.25, 1.0);
    gl_FragColor = vec4(uColor * I, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function createRingDoorbell(options = {}) {
  const o = { finish: 'nickel', shadow: true, ...options };
  const group = new THREE.Group();
  group.name = 'RingDoorbell';
  const W = 0.62, H = 1.28, D = 0.2, b = 0.035;
  const finishes = {
    nickel: { color: '#d6d9de', roughness: 0.3, metalness: 1 },
    bronze: { color: '#6e5440', roughness: 0.38, metalness: 1 },
    black: { color: '#1a1b1e', roughness: 0.42, metalness: 0.5 },
  };
  const f = finishes[o.finish] || finishes.nickel;
  const plateMat = new THREE.MeshPhysicalMaterial({ ...f, roughnessMap: brushedTexture(), anisotropy: 0.35, anisotropyRotation: Math.PI / 2, clearcoat: 0.2, clearcoatRoughness: 0.35, envMapIntensity: 1.05 });
  const bodyGeo = new THREE.ExtrudeGeometry(roundedRectShape(W - 2 * b, H - 2 * b, 0.21), { depth: D, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 5, curveSegments: 24 });
  bodyGeo.translate(0, H / 2, -D / 2);
  const body = new THREE.Mesh(bodyGeo, plateMat);
  group.add(body);
  const front = D / 2 + b;

  // black glass face (upper)
  const faceGeo = new THREE.ExtrudeGeometry(roundedRectShape(0.47, 0.58, 0.2), { depth: 0.008, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 3, curveSegments: 24 });
  const faceMesh = new THREE.Mesh(faceGeo, blackGlassMaterial());
  faceMesh.position.set(0, 0.89, front - 0.004);
  group.add(faceMesh);
  const lens = cameraLens(0.05, { trim: '#3a3e46', trimWidth: 0.42 });
  lens.position.set(0, 0.98, front + 0.012);
  group.add(lens);
  const cameraDot = new THREE.Object3D();
  cameraDot.position.set(0, 0.98, front + 0.03);
  group.add(cameraDot);
  // IR emitters and motion window
  const ir = new THREE.MeshPhysicalMaterial({ color: '#120608', roughness: 0.2, clearcoat: 1 });
  for (const x of [-0.13, 0.13]) {
    const d = new THREE.Mesh(new THREE.CircleGeometry(0.012, 16), ir);
    d.position.set(x, 0.98, front + 0.0125);
    group.add(d);
  }
  const win = new THREE.Mesh(new THREE.ShapeGeometry(roundedRectShape(0.24, 0.05, 0.025), 6), new THREE.MeshPhysicalMaterial({ color: '#08090c', roughness: 0.3, clearcoat: 1, envMapIntensity: 1 }));
  win.position.set(0, 0.76, front + 0.0125);
  group.add(win);

  // button with light ring
  const by = 0.33;
  const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 64), new THREE.MeshPhysicalMaterial({ color: '#0a0b0e', roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.2 }));
  btn.rotation.x = Math.PI / 2;
  btn.position.set(0, by, front + 0.01);
  group.add(btn);
  const ringU = {
    uColor: { value: new THREE.Color(RING_BLUE) }, uBase: { value: 0.25 }, uArcA: { value: 0 }, uArcPos: { value: 0 }, uArcLen: { value: 1.6 },
  };
  const lightRing = new THREE.Mesh(new THREE.RingGeometry(0.133, 0.162, 96, 1), new THREE.ShaderMaterial({ uniforms: ringU, vertexShader: BASIC_VERT, fragmentShader: RINGLIGHT_FRAG }));
  lightRing.position.set(0, by, front + 0.006);
  group.add(lightRing);
  const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.168, 0.008, 12, 96), new THREE.MeshPhysicalMaterial({ color: f.color, metalness: 1, roughness: 0.2, envMapIntensity: 1.3 }));
  bezel.position.set(0, by, front + 0.004);
  group.add(bezel);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), additiveKeepAlpha(new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(RING_BLUE), opacity: 0 })));
  halo.position.set(0, by, front + 0.03);
  noPick(halo);
  group.add(halo);

  if (o.shadow) group.add(contactShadow(0.7, 0.4, 0.55));

  let state = 'idle', flashKind = null, flashT = 0, flashResolve = null, quality = 'high';
  const cur = { base: 0.25, arcA: 0, arcPos: Math.PI / 2 };
  const ring = {
    group, kind: 'ring', cameraDot, button: btn,
    get state() { return state; },
    setRing(s) { if (['off', 'idle', 'live'].includes(s)) state = s; else console.warn('Nova3D: unknown Ring state', s); return ring; },
    flash(kind = 'ding') {
      if (flashResolve) flashResolve();
      flashKind = kind === 'motion' ? 'motion' : 'ding';
      flashT = 0;
      cur.arcPos = Math.PI / 2;
      return new Promise((r) => { flashResolve = r; });
    },
    _tick(dt) {
      const rm = prefersReducedMotion();
      let base = state === 'off' ? 0 : state === 'live' ? 2.6 : 0.3, arcA = 0;
      if (flashKind) {
        flashT += dt;
        if (flashKind === 'ding') {
          if (flashT < 2.2) { arcA = 9; base = Math.max(base, 0.7); if (!rm) cur.arcPos -= dt * 7.5; }
          else { base = Math.max(base, 6 * (1 - (flashT - 2.2) / 0.9)); }
          if (rm) { arcA = 0; base = Math.max(base, 4 * (1 - flashT / 3.1)); }
          if (flashT > 3.1) { flashKind = null; flashResolve?.(); flashResolve = null; }
        } else {
          const p = flashT < 2 ? Math.pow(Math.sin(Math.PI * ((flashT / 1.0) % 1)), 2) : 0;
          base = Math.max(base, 0.3 + 6 * p * (rm ? 0.6 : 1));
          if (flashT > 2) { flashKind = null; flashResolve?.(); flashResolve = null; }
        }
      }
      cur.base = damp(cur.base, base, 14, dt);
      cur.arcA = damp(cur.arcA, arcA, 10, dt);
      ringU.uBase.value = cur.base; ringU.uArcA.value = cur.arcA; ringU.uArcPos.value = cur.arcPos;
      const g = cur.base + cur.arcA * 0.35;
      halo.material.opacity = clamp(g * (quality === 'high' ? 0.05 : 0.12), 0, 0.8);
    },
    _setQuality(q) { quality = q; },
    dispose() { flashResolve?.(); disposeObject(group); },
  };
  group.userData.novaHandle = ring;
  return ring;
}

/* ========================================================= pill bottle */

// Label rectangles inside the 900×640 sample photos (source pixels).
const SAMPLE_LABEL_CROP = { rx: [252, 212, 396, 306], otc: [266, 221, 368, 298] };

const BOTTLE_STYLES = {
  // amber Rx vial with a white child-resistant cap that overhangs the body
  rx: { R: 0.21, BH: 0.72, neck: 0.188, shoulder: 0.03, CR: 0.228, CH: 0.17, ridges: 144, cap: '#f6f5f1', LH: 0.44, aspect: 396 / 306, labelY: 0.345 },
  // white HDPE over-the-counter bottle with rounded shoulders and a narrower blue ridged cap
  otc: { R: 0.236, BH: 0.74, neck: 0.165, shoulder: 0.1, CR: 0.174, CH: 0.15, ridges: 120, cap: '#1E4696', LH: 0.46, aspect: 368 / 298, labelY: 0.36 },
};

function drawFallbackLabel(ctx, w, h, name, style) {
  if (style === 'otc') {
    ctx.fillStyle = '#1c4aa0'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#c8282f'; ctx.fillRect(0, h * 0.83, w, h * 0.17);
    ctx.fillStyle = '#fff'; ctx.font = `bold ${h * 0.07}px Helvetica, Arial, sans-serif`;
    ctx.fillText('ELM STREET HEALTH', w * 0.05, h * 0.14);
    ctx.font = `bold ${h * 0.17}px Helvetica, Arial, sans-serif`;
    ctx.fillText(String(name || 'IBUPROFEN').toUpperCase(), w * 0.05, h * 0.36);
    return;
  }
  ctx.fillStyle = '#fbfbf7'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#123a7a'; ctx.font = `bold ${h * 0.085}px Helvetica, Arial, sans-serif`;
  ctx.fillText('ELM STREET PHARMACY', w * 0.04, h * 0.12);
  ctx.fillRect(w * 0.03, h * 0.2, w * 0.94, 3);
  ctx.fillStyle = '#111'; ctx.font = `bold ${h * 0.08}px Helvetica, Arial, sans-serif`;
  ctx.fillText('ROSE ALVAREZ', w * 0.04, h * 0.38);
  ctx.font = `bold ${h * 0.095}px Helvetica, Arial, sans-serif`;
  ctx.fillText(String(name || 'PRESCRIPTION').toUpperCase(), w * 0.04, h * 0.55);
  ctx.font = `${h * 0.06}px Helvetica, Arial, sans-serif`; ctx.fillStyle = '#333';
  ctx.fillText('TAKE AS DIRECTED', w * 0.04, h * 0.72);
}

function ridgedCapGeometry(CR, CH, ridges) {
  const geo = new THREE.CylinderGeometry(CR, CR, CH, ridges, 1, false);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.hypot(x, z) < CR * 0.98) continue; // cap centres
    const a = Math.atan2(z, x);
    const k = Math.round((a / TAU) * ridges) % 2 === 0 ? 1.0 : 0.965;
    pos.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

export function createPillBottle(options = {}) {
  const o = { label: null, id: null, crop: null, pills: true, style: null, ...options };
  const style = o.style === 'otc' || o.style === 'rx' ? o.style
    : (typeof o.label === 'string' && /ibuprofen|otc/i.test(o.label) ? 'otc' : 'rx');
  const S = BOTTLE_STYLES[style];
  const group = new THREE.Group();
  group.name = 'PillBottle' + (o.id ? ':' + o.id : '');
  const { R, BH, neck } = S;

  // body (lathe): rounded base, straight wall, shoulder, neck
  const prof = style === 'rx'
    ? [[0.0, 0.0], [0.16, 0.0], [0.195, 0.008], [R, 0.04], [R, BH - 0.06], [R - 0.006, BH - 0.025], [neck, BH - 0.01], [neck, BH + 0.05]]
    : [[0.0, 0.0], [R - 0.05, 0.0], [R - 0.012, 0.012], [R, 0.05], [R, BH - S.shoulder], [R - 0.012, BH - S.shoulder * 0.35], [R - 0.04, BH - 0.012], [neck + 0.01, BH], [neck, BH + 0.008], [neck, BH + 0.05]];
  const bodyGeo = new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), 72);
  let bodyHigh, bodyLow;
  if (style === 'rx') {
    // amber: part diffuse orange (reads as amber even against a dark sky), part transmissive
    bodyHigh = new THREE.MeshPhysicalMaterial({
      color: '#f0862a', roughness: 0.18, metalness: 0, transmission: 0.84, thickness: 0.28, ior: 1.52,
      attenuationColor: new THREE.Color('#f59238'), attenuationDistance: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.08, specularIntensity: 1, envMapIntensity: 1.2,
      emissive: new THREE.Color('#ff7a12'), emissiveIntensity: 0.045,
      side: THREE.DoubleSide,
    });
    bodyLow = new THREE.MeshPhysicalMaterial({
      color: '#e07a1c', roughness: 0.22, metalness: 0, transparent: true, opacity: 0.9, clearcoat: 0.7, clearcoatRoughness: 0.1, envMapIntensity: 1.1,
      emissive: new THREE.Color('#7a3200'), emissiveIntensity: 0.3, depthWrite: true,
    });
  } else {
    bodyHigh = bodyLow = new THREE.MeshPhysicalMaterial({
      color: '#f3f3ef', roughness: 0.36, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.25,
      sheen: 0.5, sheenColor: new THREE.Color('#ffffff'), sheenRoughness: 0.6, envMapIntensity: 0.95,
    });
  }
  const body = new THREE.Mesh(bodyGeo, bodyHigh);
  group.add(body);

  // tablets inside, visible through the amber plastic
  if (o.pills && style === 'rx') {
    const tabMat = new THREE.MeshStandardMaterial({ color: '#f3efe6', roughness: 0.55 });
    const tabGeo = new THREE.SphereGeometry(0.05, 16, 10);
    const n = 14;
    const inst = new THREE.InstancedMesh(tabGeo, tabMat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 0.42, 0.78), p = new THREE.Vector3();
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * (R - 0.07);
      p.set(Math.cos(a) * r, 0.03 + Math.floor(i / 6) * 0.04 + rnd() * 0.02, Math.sin(a) * r);
      e.set(rnd() * 0.8 - 0.4, rnd() * TAU, rnd() * 0.8 - 0.4);
      q.setFromEuler(e);
      m.compose(p, q, s);
      inst.setMatrixAt(i, m);
    }
    group.add(inst);
  }

  // label wrapped round the front (+Z)
  const LH = S.LH, LR = R + 0.0025;
  const thetaLen = (LH * S.aspect) / LR;
  const labelGeo = new THREE.CylinderGeometry(LR, LR, LH, 64, 1, true, -thetaLen / 2, thetaLen);
  const labelCanvas = makeCanvas(1024, Math.round(1024 / S.aspect));
  const lctx = labelCanvas.getContext('2d');
  drawFallbackLabel(lctx, labelCanvas.width, labelCanvas.height, o.id, style);
  const labelTex = canvasTexture(labelCanvas);
  const labelMat = new THREE.MeshStandardMaterial({ map: labelTex, roughness: style === 'otc' ? 0.4 : 0.62, metalness: 0, emissive: new THREE.Color(0, 0, 0) });
  const label = new THREE.Mesh(labelGeo, labelMat);
  label.position.y = S.labelY;
  group.add(label);

  // ridged cap
  const { CR, CH } = S;
  const capMat = new THREE.MeshPhysicalMaterial(style === 'rx'
    ? { color: S.cap, roughness: 0.42, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.4, sheen: 0.4, sheenColor: new THREE.Color('#ffffff'), envMapIntensity: 0.9 }
    : { color: S.cap, roughness: 0.32, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 1.0 });
  const cap = new THREE.Mesh(ridgedCapGeometry(CR, CH, S.ridges), capMat);
  cap.position.y = BH + CH / 2 - 0.005;
  group.add(cap);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(CR * 0.9, CR * 0.965, 0.02, 64), capMat);
  top.position.y = BH + CH - 0.003;
  group.add(top);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(CR * 0.99, 0.008, 8, 96), capMat);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = BH - 0.004;
  group.add(lip);

  group.add(contactShadow(R * 2.4, R * 2.4, 0.55));

  const src = o.label;
  const ready = !src ? Promise.resolve() : loadImage(src).then((img) => {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    let crop = o.crop;
    if (!crop) crop = (iw === 900 && ih === 640) ? SAMPLE_LABEL_CROP[style] : [0, 0, iw, ih];
    const [cx, cy, cw, ch] = crop;
    lctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
    lctx.drawImage(img, cx, cy, cw, ch, 0, 0, labelCanvas.width, labelCanvas.height);
    labelTex.needsUpdate = true;
  }).catch((e) => { console.warn(e.message); });

  let highlight = 0, hTarget = 0;
  const pill = {
    group, kind: 'pill', id: o.id, style, ready,
    setHighlight(on) { hTarget = on ? 1 : 0; return pill; },
    _tick(dt) {
      highlight = damp(highlight, hTarget, 10, dt);
      labelMat.emissive.setRGB(0.05 * highlight, 0.18 * highlight, 0.24 * highlight);
      capMat.emissive.setRGB(0.05 * highlight, 0.16 * highlight, 0.2 * highlight);
    },
    _setQuality(q) { body.material = q === 'high' ? bodyHigh : bodyLow; },
    dispose() { if (bodyLow !== bodyHigh) bodyLow.dispose(); disposeObject(group); },
  };
  group.userData.novaHandle = pill;
  return pill;
}

/* ============================================================== paper */

export function createPaper(options = {}) {
  const o = { texture: null, id: null, curl: 0.12, pose: 'upright', ...options };
  const group = new THREE.Group();
  group.name = 'Paper' + (o.id ? ':' + o.id : '');
  const W = 2.16, H = 2.79;
  const geo = new THREE.PlaneGeometry(W, H, 36, 44);
  {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const u = x / (W / 2), v = y / (H / 2);
      let z = o.curl * 0.9 * u * u;                       // sheet bows towards the viewer at the sides
      z += o.curl * 0.25 * Math.sin((v + 1) * 1.3);        // gentle wave down the page
      const corner = Math.max(0, u + v - 1.25);            // lifted top-right corner
      z += corner * corner * 0.5 * (o.curl / 0.12);
      pos.setZ(i, z);
    }
    geo.computeVertexNormals();
  }
  const canvas = makeCanvas(1100, 1420);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f7f5ef'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#123a6b'; ctx.fillRect(0, 0, canvas.width, 120);
  ctx.fillStyle = '#123a6b'; ctx.font = 'bold 54px Helvetica, Arial, sans-serif'; ctx.fillText('AFTER VISIT SUMMARY', 70, 210);
  ctx.fillStyle = '#c9c4ba';
  for (let i = 0; i < 18; i++) ctx.fillRect(70, 280 + i * 52, 600 + ((i * 97) % 340), 14);
  const tex = canvasTexture(canvas);
  const frontMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88, metalness: 0, side: THREE.FrontSide, emissive: new THREE.Color(0, 0, 0) });
  const backMat = new THREE.MeshStandardMaterial({ color: '#efece5', roughness: 0.92, side: THREE.BackSide });
  const sheet = new THREE.Group();
  sheet.add(new THREE.Mesh(geo, frontMat), new THREE.Mesh(geo, backMat));
  if (o.pose === 'flat') {
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.y = 0.012;
    group.add(contactShadow(W * 0.7, H * 0.62, 0.35));
  } else {
    sheet.position.y = H / 2 + 0.01;
    sheet.rotation.x = -0.06;
    group.add(contactShadow(W * 0.75, 0.35, 0.45));
  }
  group.add(sheet);

  const ready = !o.texture ? Promise.resolve() : loadImage(o.texture).then((img) => {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    // trim the photographed edge a little (the sample is slightly rotated)
    const ix = Math.round(iw * 0.016), iy = Math.round(ih * 0.012);
    ctx.drawImage(img, ix, iy, iw - ix * 2, ih - iy * 2, 0, 0, canvas.width, canvas.height);
    tex.needsUpdate = true;
  }).catch((e) => console.warn(e.message));

  let highlight = 0, hTarget = 0;
  const paper = {
    group, kind: 'paper', id: o.id, ready,
    setHighlight(on) { hTarget = on ? 1 : 0; return paper; },
    _tick(dt) { highlight = damp(highlight, hTarget, 10, dt); frontMat.emissive.setRGB(0.04 * highlight, 0.14 * highlight, 0.2 * highlight); },
    dispose() { disposeObject(group); },
  };
  group.userData.novaHandle = paper;
  return paper;
}

/* ============================================================ the logo */

let _fontPromises = {};
function loadSerifFont(italic) {
  const key = italic ? 'i' : 'r';
  if (_fontPromises[key]) return _fontPromises[key];
  _fontPromises[key] = (async () => {
    const [{ TTFLoader }, { Font, FontLoader }] = await Promise.all([
      import('three/addons/loaders/TTFLoader.js'), import('three/addons/loaders/FontLoader.js'),
    ]);
    try {
      const json = await new TTFLoader().loadAsync(italic ? SERIF_ITALIC_URL : SERIF_URL);
      return new Font(json);
    } catch (e) {
      console.warn('Nova3D: serif font unavailable, using helvetiker', e);
      return new FontLoader().loadAsync(HELVETIKER_URL);
    }
  })();
  return _fontPromises[key];
}

function logoMaterials(finish, quality) {
  if (finish === 'glass') {
    const glass = new THREE.MeshPhysicalMaterial(quality === 'high' ? {
      color: '#ffffff', roughness: 0.04, metalness: 0, transmission: 1, thickness: 0.6, ior: 1.5, dispersion: 5,
      attenuationColor: new THREE.Color('#6fd8ff'), attenuationDistance: 0.7, clearcoat: 1, clearcoatRoughness: 0.02,
      iridescence: 0.35, iridescenceIOR: 1.4, specularIntensity: 1, envMapIntensity: 1.6,
    } : {
      color: '#cfefff', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.42, clearcoat: 1, envMapIntensity: 1.6,
    });
    const core = new THREE.MeshPhysicalMaterial({ color: '#0a2a36', emissive: new THREE.Color(COLORS.nova), emissiveIntensity: 1.25, roughness: 0.15, clearcoat: 1, envMapIntensity: 1.2 });
    return { ring: glass, core };
  }
  if (finish === 'iridescent') {
    // holographic chrome: a view-angle spectral tint on the metal's reflectance, on top of thin-film iridescence
    const m = new THREE.MeshPhysicalMaterial({
      color: '#ffffff', metalness: 1, roughness: 0.08, iridescence: 0.7, iridescenceIOR: 1.6, iridescenceThicknessRange: [160, 520],
      clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.9,
    });
    const shift = { value: 0 };
    m.userData.iriShift = shift;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uIriShift = shift;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uIriShift;')
        .replace('#include <lights_physical_fragment>', `
          {
            float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
            // hue from view angle, surface orientation and position: bands sweep as the mark turns
            float k = (1.0 - nv) * 1.9 + dot(normal, vec3(0.35, 0.55, 0.0)) + (vViewPosition.x + vViewPosition.y) * 0.22 + uIriShift;
            vec3 hue = 0.55 + 0.45 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + k));
            diffuseColor.rgb *= mix(vec3(1.0), hue, 0.78);
          }
          #include <lights_physical_fragment>`);
    };
    m.customProgramCacheKey = () => 'nova-iridescent';
    return { ring: m, core: m };
  }
  const chrome = new THREE.MeshPhysicalMaterial({ color: '#f4f6fa', metalness: 1, roughness: 0.055, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.65 });
  return { ring: chrome, core: chrome };
}

export function createNovaLogo(options = {}) {
  const o = { finish: 'chrome', core: 'star', wordmark: false, wordmarkItalic: false, size: 1, spin: 0.5, glow: true, ...options };
  const group = new THREE.Group();
  group.name = 'NovaLogo';
  const mark = new THREE.Group();   // spins
  const holder = new THREE.Group(); // scales
  holder.scale.setScalar(o.size);
  holder.add(mark);
  group.add(holder);

  const R = 1, r = 0.8, gap = (12 * Math.PI) / 180, depth = 0.16;
  const ringGeos = [];
  for (let k = 0; k < 4; k++) {
    const a0 = k * (Math.PI / 2) + Math.PI / 4 - Math.PI / 4 + gap / 2;
    const a1 = (k + 1) * (Math.PI / 2) - gap / 2;
    const s = new THREE.Shape();
    s.moveTo(Math.cos(a0) * R, Math.sin(a0) * R);
    s.absarc(0, 0, R, a0, a1, false);
    s.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
    s.absarc(0, 0, r, a1, a0, true);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.028, bevelSegments: 6, curveSegments: 48 });
    g.translate(0, 0, -depth / 2);
    ringGeos.push(g);
  }
  let coreGeo;
  if (o.core === 'dot') {
    const s = new THREE.Shape(); s.absarc(0, 0, 0.3, 0, TAU, false);
    coreGeo = new THREE.ExtrudeGeometry(s, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.07, bevelSegments: 8, curveSegments: 48 });
    coreGeo.translate(0, 0, -0.06);
  } else {
    const t = 0.6, c = 0.075;
    const s = new THREE.Shape();
    s.moveTo(0, t);
    s.quadraticCurveTo(c, c, t, 0);
    s.quadraticCurveTo(c, -c, 0, -t);
    s.quadraticCurveTo(-c, -c, -t, 0);
    s.quadraticCurveTo(-c, c, 0, t);
    coreGeo = new THREE.ExtrudeGeometry(s, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.022, bevelSegments: 6, curveSegments: 32 });
    coreGeo.translate(0, 0, -0.07);
  }
  let quality = 'high';
  let finish = o.finish;
  let mats = logoMaterials(finish, quality);
  const ringMeshes = ringGeos.map((g) => new THREE.Mesh(g, mats.ring));
  const coreMesh = new THREE.Mesh(coreGeo, mats.core);
  mark.add(...ringMeshes, coreMesh);

  let halo = null;
  if (o.glow) {
    halo = new THREE.Sprite(additiveKeepAlpha(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(COLORS.nova), opacity: 0.32 })));
    halo.scale.setScalar(4.2);
    halo.position.z = -0.4;
    noPick(halo);
    holder.add(halo);
  }

  let word = null;
  const ready = !o.wordmark ? Promise.resolve() : loadSerifFont(o.wordmarkItalic).then(async (font) => {
    const { TextGeometry } = await import('three/addons/geometries/TextGeometry.js');
    const g = new TextGeometry('Nova', { font, size: 1.15, depth: 0.14, curveSegments: 10, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.014, bevelSegments: 4 });
    g.computeBoundingBox();
    const bb = g.boundingBox;
    g.translate(-bb.min.x, -(bb.max.y + bb.min.y) / 2 + 0.02, -0.07);
    word = new THREE.Mesh(g, mats.ring === mats.core ? mats.ring : logoMaterials(finish === 'glass' ? 'chrome' : finish, quality).ring);
    if (o.wordmark === 'below') {
      word.position.set(-(bb.max.x - bb.min.x) / 2, -1.75, 0);
    } else {
      word.position.set(1.45, -0.02, 0);
    }
    holder.add(word);
  }).catch((e) => console.warn('Nova3D: wordmark failed', e));

  let speed = prefersReducedMotion() ? 0 : o.spin;
  let angle = 0, t = 0;
  function applyMats() {
    for (const m of ringMeshes) m.material = mats.ring;
    coreMesh.material = mats.core;
    if (word) word.material = mats.ring === mats.core ? mats.ring : logoMaterials(finish === 'glass' ? 'chrome' : finish, quality).ring;
  }
  const logo = {
    group, kind: 'logo', ready,
    get finish() { return finish; },
    spin(radPerSec) { speed = radPerSec; return logo; },
    setFinish(fin) { finish = fin; mats = logoMaterials(finish, quality); applyMats(); return logo; },
    _tick(dt) {
      const rm = prefersReducedMotion();
      t += dt;
      angle += (rm ? 0 : speed) * dt;
      mark.rotation.y = angle;
      mark.rotation.x = rm ? 0 : Math.sin(t * 0.6) * 0.06;
      mark.position.y = rm ? 0 : Math.sin(t * 0.9) * 0.03;
      if (mats.ring.userData.iriShift) mats.ring.userData.iriShift.value = rm ? 0 : t * 0.04;
      if (word && !rm) word.rotation.y = Math.sin(t * 0.5) * 0.08;
    },
    _setQuality(q) { if (q !== quality) { quality = q; mats = logoMaterials(finish, quality); applyMats(); } },
    dispose() { disposeObject(group); },
  };
  group.userData.novaHandle = logo;
  return logo;
}

/* ================================================================ drag */

export function enableDrag(stage, handles, options = {}) {
  const o = { plane: 'screen', floorY: 0, lift: 0.35, targets: [], returnHome: true, onDragStart: null, onDragEnd: null, ...options };
  const router = getRouter(stage);
  const cam = stage.camera;
  const items = new Map(); // group → state
  let enabled = true;

  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  const plane = new THREE.Plane();
  const qTmp = new THREE.Quaternion(), qTilt = new THREE.Quaternion(), eTmp = new THREE.Euler();
  const dummy = new THREE.Object3D();

  function reg(h) {
    const g = groupOf(h);
    if (!g || items.has(g)) return;
    if (!stage.scene.getObjectById(g.id)) stage.add(h);
    items.set(g, {
      h, g, home: g.position.clone(), homeQ: g.quaternion.clone(),
      pos: g.position.clone(), vel: new THREE.Vector3(), goal: g.position.clone(), goalQ: g.quaternion.clone(),
      mode: 'rest', over: null, offset: new THREE.Vector3(), seq: 0,
    });
  }
  handles.forEach(reg);

  const targetPos = (t, out) => groupOf(t.object).getWorldPosition(out);
  function targetNormal(t, out) {
    groupOf(t.object).getWorldQuaternion(qTmp);
    return out.set(0, 0, 1).applyQuaternion(qTmp).normalize();
  }
  function presentPose(st, t) {
    const tp = targetPos(t, new THREE.Vector3());
    const n = targetNormal(t, new THREE.Vector3());
    const dist = t.distance ?? 1.1;
    const world = tp.clone().addScaledVector(n, dist);
    // centre the object's body on the lens rather than its base
    const box = new THREE.Box3().setFromObject(st.g);
    const hgt = isFinite(box.max.y) ? (box.max.y - box.min.y) : 0.5;
    world.y += -hgt * 0.5 + (t.offsetY ?? -0.15); // centre the object a little below the lens
    dummy.position.copy(world);
    dummy.lookAt(tp.x, world.y, tp.z);
    const faceTarget = dummy.quaternion.clone();
    // a flat sheet turned towards the device reads as a sliver to the viewer: keep it facing out by default
    const turn = t.turn ?? (st.h.kind === 'paper' ? 0 : 0.35);
    const q = st.homeQ.clone().slerp(faceTarget, turn);
    const parent = st.g.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.worldToLocal(world);
      parent.getWorldQuaternion(qTmp);
      q.premultiply(qTmp.invert());
    }
    return { pos: world, q };
  }

  function screenDist(st, t) {
    const a = stage.project(st.g), b = stage.project(groupOf(t.object));
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function rayPoint(e, out) {
    stage._toNDC(e.clientX, e.clientY);
    stage._raycaster.setFromCamera(stage._toNDC(e.clientX, e.clientY), cam);
    return stage._raycaster.ray.intersectPlane(plane, out);
  }

  function setOver(st, t) {
    if (st.over === t) return;
    if (st.over) st.over.onLeave?.(st.h, st.over);
    st.over = t;
    if (t) t.onEnter?.(st.h, t);
    st.h.setHighlight?.(!!t);
  }

  async function present(st, t, { fireDrop = true } = {}) {
    const seq = ++st.seq;
    let doPresent = t.present !== false;
    if (fireDrop) {
      const r = t.onDrop?.(st.h, t);
      if (r === false) doPresent = false;
    }
    if (doPresent) {
      const pose = presentPose(st, t);
      st.mode = 'present';
      st.goal.copy(pose.pos); st.goalQ.copy(pose.q);
      await new Promise((r) => setTimeout(r, (t.holdMs ?? 1400) + 450));
      if (seq !== st.seq) return;
    }
    st.h.setHighlight?.(false);
    goHome(st);
  }
  function goHome(st) {
    if (o.returnHome) { st.mode = 'return'; st.goal.copy(st.home); st.goalQ.copy(st.homeQ); }
    else { st.mode = 'rest'; st.home.copy(st.goal); }
  }

  const unregister = router.add({
    priority: 30,
    get enabled() { return enabled; },
    hover(e) { return stage.pick(e.clientX, e.clientY, [...items.keys()]) ? 'grab' : null; },
    claim(e) {
      const hit = stage.pick(e.clientX, e.clientY, [...items.keys()]);
      if (!hit) return null;
      const st = items.get(groupOf(hit.handle));
      if (!st || st.mode === 'present') return null;
      st.seq++;
      // drag plane
      st.g.getWorldPosition(v1);
      if (o.plane === 'floor') {
        plane.set(new THREE.Vector3(0, 1, 0), -(o.floorY + o.lift));
        v1.y = o.floorY + o.lift;
      } else {
        cam.getWorldDirection(v2);
        v1.addScaledVector(v2, -o.lift);  // come towards the camera
        v1.y += o.lift * 0.4;
        plane.setFromNormalAndCoplanarPoint(v2.clone().negate(), v1);
      }
      const p = rayPoint(e, v3);
      st.offset.copy(p ? v1.clone().sub(p) : new THREE.Vector3());
      st.offset.multiplyScalar(0.0); // grab by the pointer: object eases under it
      st.mode = 'drag';
      st.goal.copy(v1);
      if (st.g.parent) st.g.parent.worldToLocal(st.goal);
      st.goalQ.copy(st.homeQ);
      o.onDragStart?.(st.h);
      return {
        cursor: 'grabbing',
        move(ev) {
          const q = rayPoint(ev, v3);
          if (!q) return;
          const w = q.add(st.offset);
          // magnet towards a target the object is over
          let best = null, bestD = Infinity;
          for (const t of o.targets) {
            const d = screenDist(st, t);
            if (d < (t.radius ?? 120) && d < bestD) { best = t; bestD = d; }
          }
          setOver(st, best);
          if (best) {
            const pose = presentPose(st, best);
            const wp = pose.pos.clone();
            if (st.g.parent) st.g.parent.localToWorld(wp);
            w.lerp(wp, 0.22 * (1 - bestD / (best.radius ?? 120)));
          }
          st.goal.copy(w);
          if (st.g.parent) st.g.parent.worldToLocal(st.goal);
        },
        up(ev, cancelled) {
          const t = cancelled ? null : st.over;
          setOver(st, null);
          if (t) { st.h.setHighlight?.(true); present(st, t); }
          else goHome(st);
          o.onDragEnd?.(st.h, t);
        },
      };
    },
  });

  const unFrame = stage.onFrame((dt) => {
    const rm = prefersReducedMotion();
    const k = rm ? 260 : 170, c = 2 * Math.sqrt(k) * (rm ? 1 : 0.82);
    for (const st of items.values()) {
      if (st.mode === 'rest') continue;
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        v1.subVectors(st.goal, st.pos).multiplyScalar(k).addScaledVector(st.vel, -c);
        st.vel.addScaledVector(v1, h);
        st.pos.addScaledVector(st.vel, h);
      }
      st.g.position.copy(st.pos);
      // velocity tilt
      const tiltX = clamp(st.vel.y * 0.05, -0.35, 0.35), tiltZ = clamp(-st.vel.x * 0.06, -0.4, 0.4);
      eTmp.set(rm ? 0 : tiltX, 0, rm ? 0 : tiltZ);
      qTilt.setFromEuler(eTmp);
      qTmp.copy(st.goalQ).multiply(qTilt);
      st.g.quaternion.slerp(qTmp, 1 - Math.exp(-dt * 12));
      if (st.mode === 'return' && st.pos.distanceTo(st.home) < 0.002 && st.vel.length() < 0.01) {
        st.mode = 'rest';
        st.g.position.copy(st.home); st.g.quaternion.copy(st.homeQ); st.vel.set(0, 0, 0);
      }
    }
  });

  if (!stage.container.style.touchAction) stage.container.style.touchAction = 'none';

  return {
    async drop(handle, targetIndex = 0) {
      const st = items.get(groupOf(handle));
      const t = o.targets[targetIndex];
      if (!st || !t) return;
      st.pos.copy(st.g.position);
      o.onDragStart?.(st.h);
      st.h.setHighlight?.(true);
      t.onEnter?.(st.h, t);
      o.onDragEnd?.(st.h, t);
      await present(st, t);
      await new Promise((r) => { const iv = setInterval(() => { if (st.mode === 'rest' || st.mode === 'drag') { clearInterval(iv); r(); } }, 50); });
    },
    setHome(handle, pos) {
      const st = items.get(groupOf(handle));
      if (!st) return;
      if (pos) st.home.set(...pos); else st.home.copy(st.g.position);
      st.homeQ.copy(st.g.quaternion);
      if (st.mode === 'rest') { st.pos.copy(st.home); st.g.position.copy(st.home); }
    },
    add(handle) { reg(handle); },
    setEnabled(v) { enabled = !!v; },
    dispose() { unregister(); unFrame(); items.clear(); },
  };
}

/* =============================================================== orbit */

export function enableOrbit(stage, object, options = {}) {
  const o = { maxYaw: 0.45, maxPitch: 0.18, springBack: true, hover: true, anywhere: false, ...options };
  const g = groupOf(object);
  const router = getRouter(stage);
  const rest = g.rotation.clone();
  let rawYaw = 0, rawPitch = 0, vYaw = 0, vPitch = 0, dragging = false, enabled = true;
  let hx = 0, hy = 0, px = 0, py = 0, lastX = 0, lastY = 0, lastT = 0;

  const onMove = (e) => {
    const r = stage.container.getBoundingClientRect();
    px = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    py = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  const unregister = router.add({
    priority: 20,
    get enabled() { return enabled; },
    hover(e) { return !o.anywhere && stage.pick(e.clientX, e.clientY, [g]) ? 'grab' : null; },
    claim(e) {
      if (!o.anywhere && !stage.pick(e.clientX, e.clientY, [g])) return null;
      dragging = true; lastX = e.clientX; lastY = e.clientY; lastT = performance.now(); vYaw = vPitch = 0;
      return {
        cursor: 'grabbing',
        move(ev) {
          const now = performance.now(), dtm = Math.max(1, now - lastT) / 1000;
          const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
          lastX = ev.clientX; lastY = ev.clientY; lastT = now;
          const dyaw = dx * 0.0065, dpitch = dy * 0.0045;
          rawYaw += dyaw; rawPitch += dpitch;
          vYaw = lerp(vYaw, dyaw / dtm, 0.5); vPitch = lerp(vPitch, dpitch / dtm, 0.5);
        },
        up() { dragging = false; },
      };
    },
  });

  const unFrame = stage.onFrame((dt) => {
    const rm = prefersReducedMotion();
    if (!dragging) {
      if (!rm) { rawYaw += vYaw * dt; rawPitch += vPitch * dt; }
      vYaw *= Math.exp(-dt * 5); vPitch *= Math.exp(-dt * 5);
      if (o.springBack) { rawYaw = damp(rawYaw, 0, 2.6, dt); rawPitch = damp(rawPitch, 0, 2.6, dt); }
      else { rawYaw = clamp(rawYaw, -o.maxYaw * 2, o.maxYaw * 2); rawPitch = clamp(rawPitch, -o.maxPitch * 2, o.maxPitch * 2); }
    }
    const yaw = o.maxYaw * Math.tanh(rawYaw / o.maxYaw);
    const pitch = o.maxPitch * Math.tanh(rawPitch / o.maxPitch);
    const H = 0.07;
    const wantX = o.hover && !rm && !dragging ? px * H : 0, wantY = o.hover && !rm && !dragging ? py * H * 0.6 : 0;
    hx = damp(hx, wantX, 3, dt); hy = damp(hy, wantY, 3, dt);
    g.rotation.set(rest.x + pitch + hy, rest.y + yaw + hx, rest.z);
  });

  if (!stage.container.style.touchAction) stage.container.style.touchAction = 'pan-y';

  return {
    setEnabled(v) { enabled = !!v; },
    reset() { rawYaw = rawPitch = vYaw = vPitch = 0; },
    dispose() { unregister(); unFrame(); window.removeEventListener('pointermove', onMove); g.rotation.copy(rest); },
  };
}

/* ============================================================ carousel */

function drawCardFace(ctx, w, h, item, index, img) {
  const R = 40;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, R);
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#1b1e29'); g.addColorStop(1, '#0c0d13');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const color = item.color || COLORS.nova;
  const rg = ctx.createRadialGradient(w * 0.5, h * 0.42, 10, w * 0.5, h * 0.42, w * 0.85);
  rg.addColorStop(0, rgba(color, 0.26)); rg.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
  if (item.canvasDraw) {
    item.canvasDraw(ctx, w, h);
  } else {
    const pad = 54;
    ctx.fillStyle = 'rgba(244,238,230,.62)';
    ctx.font = '500 25px "JetBrains Mono", ui-monospace, Menlo, monospace';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${String(index + 1).padStart(2, '0')} — ${String(item.time || '').toUpperCase()}`, pad, 84);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(w - pad - 8, 76, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(244,238,230,.14)'; ctx.fillRect(pad, 114, w - pad * 2, 2);
    const mid = { x: pad, y: 150, w: w - pad * 2, h: h * 0.47 };
    if (img) {
      ctx.save();
      roundRectPath(ctx, mid.x, mid.y, mid.w, mid.h, 22); ctx.clip();
      const s = Math.max(mid.w / img.width, mid.h / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, mid.x + (mid.w - dw) / 2, mid.y + (mid.h - dh) / 2, dw, dh);
      ctx.restore();
    } else {
      ctx.fillStyle = '#F4EEE6';
      ctx.font = 'italic 230px "Instrument Serif", Georgia, serif';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '-4px';
      ctx.textAlign = 'center';
      ctx.fillText(String(item.time || ''), w / 2, mid.y + mid.h * 0.66);
      ctx.textAlign = 'left';
    }
    if ('letterSpacing' in ctx) ctx.letterSpacing = '-1px';
    ctx.fillStyle = '#F4EEE6';
    ctx.font = '400 82px "Instrument Serif", Georgia, serif';
    const words = String(item.title || '').split(' ');
    let line = '', y = h - 230;
    const lines = [];
    for (const wd of words) { const test = line ? line + ' ' + wd : wd; if (ctx.measureText(test).width > w - pad * 2 && line) { lines.push(line); line = wd; } else line = test; }
    if (line) lines.push(line);
    y = h - 130 - (lines.length - 1) * 76;
    for (const l of lines) { ctx.fillText(l, pad, y); y += 76; }
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2.5px';
    ctx.fillStyle = 'rgba(244,238,230,.55)';
    ctx.font = '400 23px "JetBrains Mono", ui-monospace, Menlo, monospace';
    ctx.fillText(String(item.subtitle || '').toUpperCase(), pad, h - 64);
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(244,238,230,.16)'; ctx.lineWidth = 2;
  roundRectPath(ctx, 1, 1, w - 2, h - 2, R - 1); ctx.stroke();
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

function bendToArc(geo, radius) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const a = x / radius;
    pos.setXYZ(i, Math.sin(a) * (radius + z), pos.getY(i), Math.cos(a) * (radius + z) - radius);
  }
  geo.computeVertexNormals();
  return geo;
}

const EDGE_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uAmt; uniform vec2 uSize;
  varying vec2 vUv;
  float sdRoundBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main(){
    vec2 p = (vUv - 0.5) * uSize;
    float d = sdRoundBox(p, uSize * 0.5 - 0.06, 0.14);
    float line = smoothstep(0.012, 0.0, abs(d));
    float glow = exp(-max(d, 0.0) * 22.0) * step(0.0, d) * 0.5;
    gl_FragColor = vec4(uColor * (line * 2.6 + glow) * uAmt, 1.0);
  }`;

export function createArcCarousel(stage, items, options = {}) {
  const o = {
    radius: 9, spacing: 0.42, cardWidth: 2.6, cardHeight: 3.6, position: [0, 1.6, 0],
    keyboard: true, wheel: true, drag: true, onChange: null, onSelect: null, ...options,
  };
  const group = new THREE.Group();
  group.name = 'ArcCarousel';
  group.position.set(o.position[0], o.position[1], o.position[2] - o.radius);
  const R = o.radius;
  const cards = [];
  const texW = 768, texH = Math.round(768 * (o.cardHeight / o.cardWidth));

  items.forEach((item, i) => {
    const pivot = new THREE.Group();
    const card = new THREE.Group();
    card.position.z = R;
    pivot.add(card);
    const canvas = makeCanvas(texW, texH);
    const ctx = canvas.getContext('2d');
    const tex = canvasTexture(canvas);
    const faceGeo = bendToArc(new THREE.PlaneGeometry(o.cardWidth, o.cardHeight, 24, 1), R);
    faceGeo.translate(0, 0, R);
    // bendToArc shifts the plane to the arc around the pivot; undo the card offset so the card group can sit at z=R
    faceGeo.translate(0, 0, -R);
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.5, roughness: 0.32, metalness: 0, alphaTest: 0.5 });
    const face = new THREE.Mesh(faceGeo, mat);
    const backGeo = bendToArc(new THREE.PlaneGeometry(o.cardWidth * 0.985, o.cardHeight * 0.99, 24, 1), R);
    const back = new THREE.Mesh(backGeo, new THREE.MeshPhysicalMaterial({ color: '#0d0f15', roughness: 0.3, clearcoat: 1, side: THREE.BackSide }));
    back.position.z = -0.035;
    const edgeGeo = bendToArc(new THREE.PlaneGeometry(o.cardWidth + 0.28, o.cardHeight + 0.28, 24, 1), R);
    const edgeMat = additiveKeepAlpha(new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(item.color || COLORS.nova) }, uAmt: { value: 0 }, uSize: { value: new THREE.Vector2(o.cardWidth + 0.28, o.cardHeight + 0.28) } },
      vertexShader: BASIC_VERT, fragmentShader: EDGE_FRAG,
    }));
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    edge.position.z = 0.004;
    noPick(edge);
    card.add(back, face, edge);
    card.userData.cardIndex = i;
    if (item.object) {
      const og = groupOf(item.object);
      og.position.set(0, -o.cardHeight * 0.18, 0.75);
      card.add(og);
      if (item.object._tick) cards.ticks = (cards.ticks || []).concat(item.object);
    }
    group.add(pivot);
    const entry = { item, pivot, card, face, mat, edgeMat, ctx, tex, img: null };
    const redraw = () => { drawCardFace(ctx, texW, texH, item, i, entry.img); tex.needsUpdate = true; };
    entry.redraw = redraw;
    redraw();
    if (item.image) loadImage(item.image).then((im) => { entry.img = im; redraw(); }).catch(() => {});
    cards.push(entry);
  });
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => cards.forEach((c) => c.redraw()));
    Promise.all([
      document.fonts.load?.('400 82px "Instrument Serif"'), document.fonts.load?.('italic 230px "Instrument Serif"'), document.fonts.load?.('500 25px "JetBrains Mono"'),
    ]).then(() => cards.forEach((c) => c.redraw())).catch(() => {});
  }

  let pos = 0, target = 0, vel = 0, index = 0, enabled = true, dragging = false;
  const n = items.length;
  function select(i, { instant = false } = {}) {
    target = clamp(Math.round(i), 0, n - 1);
    if (instant || prefersReducedMotion()) pos = target;
  }
  const router = getRouter(stage);
  const pickCards = () => cards.map((c) => c.face);
  const unregister = router.add({
    priority: 10,
    get enabled() { return enabled && o.drag; },
    hover(e) { return stage.pick(e.clientX, e.clientY, pickCards()) ? 'pointer' : null; },
    claim(e) {
      const hit = stage.pick(e.clientX, e.clientY, pickCards());
      if (!hit) return null;
      const hitIndex = cards.findIndex((c) => c.face === groupOf(hit.handle) || c.face === hit.object);
      const sx = e.clientX;
      let lastX = e.clientX, lastT = performance.now(), moved = 0;
      dragging = true; vel = 0;
      const pxPerCard = Math.max(160, stage.width * 0.22);
      return {
        cursor: 'grabbing',
        move(ev) {
          const now = performance.now(), dtm = Math.max(1, now - lastT) / 1000;
          const dx = ev.clientX - lastX;
          lastX = ev.clientX; lastT = now; moved = Math.max(moved, Math.abs(ev.clientX - sx));
          const d = -dx / pxPerCard;
          pos = clamp(pos + d, -0.4, n - 0.6);
          target = pos;
          vel = lerp(vel, d / dtm, 0.5);
        },
        up() {
          dragging = false;
          if (moved < 6) {
            if (hitIndex === Math.round(pos)) o.onSelect?.(hitIndex, items[hitIndex]);
            else if (hitIndex >= 0) select(hitIndex);
            return;
          }
          const fling = prefersReducedMotion() ? 0 : vel * 0.18;
          select(pos + fling);
        },
      };
    },
  });

  let wheelAcc = 0, wheelLock = 0;
  const onWheel = (e) => {
    if (!enabled || !o.wheel) return;
    const horizontalOnly = o.wheel === 'horizontal';
    const d = horizontalOnly ? e.deltaX : (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    if (!d) return;
    e.preventDefault();
    const now = performance.now();
    wheelAcc += d;
    if (now > wheelLock && Math.abs(wheelAcc) > 40) {
      select(target + Math.sign(wheelAcc));
      wheelAcc = 0; wheelLock = now + 260;
    }
  };
  stage.container.addEventListener('wheel', onWheel, { passive: false });

  const onKey = (e) => {
    if (!enabled || !o.keyboard) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    const r = stage.container.getBoundingClientRect();
    const vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / Math.max(1, r.height);
    if (vis < 0.5) return;
    if (e.key === 'ArrowRight') { select(target + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { select(target - 1); e.preventDefault(); }
    else if (e.key === 'Enter' && (!a || a === document.body || stage.container.contains(a))) { o.onSelect?.(index, items[index]); }
  };
  window.addEventListener('keydown', onKey);

  const car = {
    group, kind: 'carousel',
    get index() { return index; },
    select, next() { select(target + 1); }, prev() { select(target - 1); },
    setEnabled(v) { enabled = !!v; },
    // repaint every card face (e.g. once the page's web fonts have loaded)
    redraw() { cards.forEach((c) => c.redraw()); },
    _tick(dt, t) {
      const rm = prefersReducedMotion();
      if (!dragging) pos = rm ? damp(pos, target, 14, dt) : damp(pos, target, 7, dt);
      const ni = clamp(Math.round(pos), 0, n - 1);
      if (ni !== index) { index = ni; o.onChange?.(index, items[index]); }
      cards.forEach((c, i) => {
        const rel = i - pos;
        const a = rel * o.spacing;
        c.pivot.rotation.y = a;
        const near = 1 - clamp(Math.abs(rel), 0, 1);
        const fade = 1 - clamp((Math.abs(rel) - 1) / 3, 0, 0.75);
        c.mat.emissiveIntensity = 0.16 + 0.42 * near;
        c.mat.color.setScalar(0.35 + 0.65 * fade);
        c.edgeMat.uniforms.uAmt.value = damp(c.edgeMat.uniforms.uAmt.value, i === index ? 1 : 0, 6, dt);
        const s = 1 + 0.06 * near;
        c.card.scale.setScalar(s);
        c.card.position.y = rm ? 0 : Math.sin(t * 0.8 + i) * 0.02;
        const obj = c.item.object;
        if (obj) {
          const og = groupOf(obj);
          if (!rm) og.rotation.y += dt * (0.25 + 0.35 * near);
          obj._tick?.(dt, t);
        }
      });
    },
    _attach() {},
    dispose() {
      unregister(); window.removeEventListener('keydown', onKey); stage.container.removeEventListener('wheel', onWheel);
      stage.remove(car);
      disposeObject(group);
    },
  };
  group.userData.novaHandle = car;
  stage.add(car);
  if (!stage.container.style.touchAction) stage.container.style.touchAction = 'pan-y';
  car._tick(0, 0);
  o.onChange?.(0, items[0]);
  return car;
}

/* ========================================================= screen frame */

// A fixed, full-viewport "glass screen" overlay. Plain alpha compositing only (no mix-blend-mode, no
// oversized layers): blend modes over a WebGL canvas force full-screen render surfaces and cost
// hundreds of MB of GPU memory.
let _frameStyle = false;
export function screenFrame(container = document.body, options = {}) {
  const o = { bezel: true, glare: true, scanlines: true, grain: true, vignette: true, radius: 28, intensity: 1, thickness: null, chin: null, ...options };
  if (!_frameStyle) {
    _frameStyle = true;
    const st = document.createElement('style');
    st.textContent = `
      .nova-frame{position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden}
      .nova-frame>div{position:absolute;pointer-events:none}
      .nova-frame .nf-grain{inset:-8%;background-size:180px 180px;will-change:transform;animation:nf-grain .9s steps(6) infinite}
      .nova-frame .nf-glass{border-radius:var(--nf-r)}
      .nova-frame .nf-bezel{border-radius:var(--nf-r);box-shadow:0 0 0 calc(var(--nf-t) + 6px) #040507,inset 0 0 0 1px rgba(59,209,255,.16),inset 0 0 22px rgba(59,209,255,.06),inset 0 1px 0 rgba(255,255,255,.07)}
      @keyframes nf-grain{0%{transform:translate(0,0)}17%{transform:translate(-4%,2%)}33%{transform:translate(3%,-3%)}50%{transform:translate(-2%,4%)}67%{transform:translate(4%,1%)}83%{transform:translate(-3%,-2%)}100%{transform:translate(0,0)}}
      @media (prefers-reduced-motion: reduce){.nova-frame .nf-grain{animation:none}}
    `;
    document.head.appendChild(st);
  }
  // grain tile: black or white specks with random alpha (neutral on average, no blend mode needed)
  const N = 180, c = makeCanvas(N, N), ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = Math.round(Math.random() * Math.random() * 255);
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');

  const el = document.createElement('div');
  el.className = 'nova-frame';
  el.setAttribute('aria-hidden', 'true');
  const grain = document.createElement('div'); grain.className = 'nf-grain';
  const glass = document.createElement('div'); glass.className = 'nf-glass';
  const bezel = document.createElement('div'); bezel.className = 'nf-bezel';
  el.append(grain, glass, bezel);
  grain.style.backgroundImage = `url(${url})`;
  container.appendChild(el);

  function apply() {
    const I = clamp(o.intensity, 0, 2);
    const th = o.bezel ? (o.thickness ?? (innerWidth < 720 ? 6 : 12)) : 0;
    const chin = o.bezel ? Math.max(th, o.chin ?? th) : 0; // a deeper bottom bezel, like a monitor's chin
    el.style.setProperty('--nf-r', (o.bezel ? o.radius : 0) + 'px');
    el.style.setProperty('--nf-t', Math.max(th, chin) + 'px');
    glass.style.inset = bezel.style.inset = `${th}px ${th}px ${chin}px ${th}px`;
    bezel.style.display = o.bezel ? '' : 'none';
    grain.style.display = o.grain ? '' : 'none';
    grain.style.opacity = String(0.16 * I);
    const layers = [];
    if (o.glare) {
      layers.push(`radial-gradient(70% 55% at 16% -6%, rgba(255,255,255,${0.07 * I}), rgba(255,255,255,0) 62%)`);
      layers.push(`linear-gradient(115deg, rgba(255,255,255,0) 40%, rgba(255,255,255,${0.025 * I}) 47%, rgba(255,255,255,0) 54%)`);
    }
    if (o.scanlines) layers.push(`repeating-linear-gradient(180deg, rgba(0,0,0,${0.13 * I}) 0 1px, rgba(0,0,0,0) 1px 3px)`);
    if (o.vignette) layers.push(`radial-gradient(130% 120% at 50% 45%, rgba(0,0,0,0) 58%, rgba(0,0,0,${Math.min(0.85, 0.5 * I)}) 100%)`);
    glass.style.backgroundImage = layers.join(',');
    glass.style.display = layers.length ? '' : 'none';
  }
  apply();
  const onResize = () => apply();
  window.addEventListener('resize', onResize);
  return {
    el,
    set(opts) { Object.assign(o, opts); apply(); },
    setEnabled(v) { el.style.display = v ? '' : 'none'; },
    dispose() { window.removeEventListener('resize', onResize); el.remove(); },
  };
}
