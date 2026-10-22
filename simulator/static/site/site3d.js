/* Nova · landing page, WebGL layer.
   Every section with a stage host (.gl-host) becomes a Three.js scene built with the shared
   library (/static/three/nova3d.js). The DOM versions stay in the page for accessibility and
   come back automatically (window.__nova.flat) if anything here fails. */
import * as THREE from 'three';
import * as N from '/static/three/nova3d.js';

const doc = document.documentElement;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const COL = N.COLORS || { ink: '#0A0B10', ivory: '#F4EEE6', nova: '#3BD1FF', amber: '#FFB547', coral: '#FF6B57', sage: '#9ED9B0' };

let NOVA, gsap, ST;
const stages = [];
const triggers = [];
const cleanups = [];

export async function boot() {
  NOVA = window.__nova; gsap = window.gsap; ST = window.ScrollTrigger;
  if (!NOVA || !gsap || !ST) throw new Error('core scripts missing');
  if (N.isWebGLAvailable && !N.isWebGLAvailable()) throw new Error('WebGL unavailable');
  try {
    // Nothing here blocks the page: the DOM version is already on screen. The hero goes first,
    // then each scene is built in an idle slice and its section switches to 3D when ready.
    const T = (window.__nova3dTimings = []);
    let t = performance.now();
    const mark = (name) => { const n = performance.now(); T.push([name, Math.round(n - t)]); t = n; };
    frameHud();
    await hero(); mark('hero');
    document.dispatchEvent(new CustomEvent('nova:gl-hero'));
    // the intro gets the GPU to itself, but only while someone is watching it: scrolling away starts the builds
    await Promise.race([heroSettled, scrolledAway()]); mark('hero settled');
    await fontsReady(); mark('fonts');
    for (const [name, build_] of [['day', day], ['dots', dots], ['sees', sees], ['build', build], ['cta', cta]]) {
      const near = document.getElementById(name === 'cta' ? 'meet' : name);
      await idle(near); mark('idle');
      await build_(); mark(name);
      const st_ = stages[stages.length - 1];
      if (st_ && st_.compileAsync) { await st_.compileAsync(); mark(name + ' compile'); }
      // first frame now (texture uploads, remaining programs), while nobody is scrolling
      if (st_) { await idle(near); warmTextures(st_); st_.render(); mark(name + ' warm'); }
      await idle(near);
      ST.sort();
      ST.refresh(); mark('refresh');
    }
    doc.classList.add('gl-ready');
    window.__nova3d = { stages, N, THREE };
  } catch (err) {
    teardown();
    throw err;
  }
}

let lastScroll = 0;
addEventListener('scroll', () => { lastScroll = performance.now(); }, { passive: true });
addEventListener('wheel', () => { lastScroll = performance.now(); }, { passive: true });
function scrolledAway() {
  return new Promise((resolve) => {
    const on = () => { if (scrollY > innerHeight * 0.2) { removeEventListener('scroll', on); resolve(); } };
    addEventListener('scroll', on, { passive: true });
    on();
  });
}
// wait for a quiet moment, unless the section being built is about to come on screen: then a short hitch
// beats showing its unstyled fallback
function idle(near) {
  return new Promise((resolve) => {
    const check = () => {
      if (near && near.getBoundingClientRect().top < innerHeight * 1.6) { requestAnimationFrame(() => resolve()); return; }
      const quiet = performance.now() - lastScroll;
      if (quiet < 300) { setTimeout(check, 320 - quiet); return; }
      if (window.requestIdleCallback) requestIdleCallback(() => resolve(), { timeout: 200 }); else setTimeout(resolve, 30);
    };
    check();
  });
}

function teardown() {
  doc.classList.remove('gl-frame');
  $$('.is-gl-live, .is-gl-done').forEach((el) => el.classList.remove('is-gl-live', 'is-gl-done'));
  triggers.forEach((t) => { try { t.kill(true); } catch (e) {} });
  cleanups.forEach((f) => { try { f(); } catch (e) {} });
  loopEntries.forEach((e) => { e.on = false; });
  loopEntries.length = 0;
  stages.forEach((s) => { try { s.dispose(); } catch (e) {} });
  $$('.is-gl').forEach((el) => el.classList.remove('is-gl', 'is-pinned', 'is-x'));
}

function fontsReady() {
  if (!document.fonts) return Promise.resolve();
  const loads = ['400 64px "Instrument Serif"', 'italic 400 64px "Instrument Serif"', '400 14px "JetBrains Mono"', '500 14px "JetBrains Mono"', '400 18px "Inter Tight"', '500 18px "Inter Tight"']
    .map((f) => document.fonts.load(f).catch(() => null));
  return Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 2500))]);
}

/* ---------- one render loop for every stage ----------
   A stage renders at most every other frame on a high-refresh display (about 60-72 a second) and
   only one stage renders per animation frame, so two scenes meeting at a section boundary never
   double the GPU work and the scroll never waits behind a queued frame. */
const loopEntries = [];
let loopRaf = 0, lastTick = 0;
// Frame pacing: renders are spaced a whole number of vsyncs apart (2 on a high-refresh display,
// 1 at 60 Hz). When frames start arriving late (a weak or throttled GPU), the spacing grows by a
// vsync; after a calm stretch it comes back.
const ivs = []; let vsync = 16.7, gap = 1, calm = 0;
function pace(iv) {
  ivs.push(iv);
  if (ivs.length < 36) return;
  const a = ivs.splice(0).sort((x, y) => x - y);
  vsync = Math.max(4, a[Math.floor(a.length * 0.1)]);
  const base = vsync < 10 ? 2 : 1;
  const late = a.filter((x) => x > vsync * 1.6).length / a.length;
  if (late > 0.12) { gap = Math.min(gap + 1, base + 1); calm = 0; }
  else if (late < 0.04 && ++calm >= 3) { gap = Math.max(base, gap - 1); calm = 0; }
  if (gap < base) gap = base;
}
function loopTick(now) {
  loopRaf = 0;
  if (lastTick && now - lastTick < 250) pace(now - lastTick);
  lastTick = now;
  const minGap = gap * vsync - vsync * 0.5;
  let pick = null, any = false;
  for (const e of loopEntries) {
    if (!e.on || e.held) continue;
    any = true;
    if (now - e.last >= minGap && (!pick || e.last < pick.last)) pick = e;
  }
  if (!any || document.hidden) { lastTick = 0; return; }
  loopRaf = requestAnimationFrame(loopTick);
  if (!pick) return;
  const dt = pick.last ? (now - pick.last) / 1000 : 1 / 60;
  pick.last = now;
  pick.stage.step(dt);
  if (pick.auto) pick.auto(dt);
}
function loopKick() { if (!loopRaf) loopRaf = requestAnimationFrame(loopTick); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) loopKick(); });

// upload every texture in a scene now (cards and labels that are off camera would otherwise
// upload the first time they turn into view, mid-scroll)
function warmTextures(stage) {
  const seen = new Set();
  stage.scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    mats.forEach((m) => {
      Object.keys(m).forEach((k) => { const t = m[k]; if (t && t.isTexture && !seen.has(t)) { seen.add(t); try { stage.renderer.initTexture(t); } catch (e) {} } });
      if (m.uniforms) Object.values(m.uniforms).forEach((u) => { const t = u && u.value; if (t && t.isTexture && !seen.has(t)) { seen.add(t); try { stage.renderer.initTexture(t); } catch (e) {} } });
    });
  });
}

/* ---------- stage helpers ---------- */
function makeStage(host, opts) {
  const stage = N.createStage(host, Object.assign({ autoStart: false, quality: 'auto', pixelRatioCap: 1.5 }, opts));
  stages.push(stage);
  const entry = { stage, on: false, last: 0, auto: null };
  if ((opts.quality || 'auto') === 'auto') {
    // the library's own check (it runs inside its loop, which the shared loop replaces):
    // drop to low quality when the scene can't hold ~45 fps
    let n = 0, sum = 0;
    entry.auto = (dt) => {
      n++; if (n > 40) sum += dt;
      if (n === 160) { entry.auto = null; if (sum / 120 > 0.022 && stage.getQuality() === 'high') stage.setQuality('low'); }
    };
  }
  loopEntries.push(entry);
  stage.start = () => { if (!entry.on) { entry.on = true; entry.last = 0; } loopKick(); };
  stage.stop = () => { entry.on = false; };
  // hold: keep the last frame on screen and skip rendering, whatever the visibility
  stage.hold = (v) => { v = !!v; if (v === !!entry.held) return; entry.held = v; if (!v) { entry.last = 0; loopKick(); } };
  let visible = false;
  const io = new IntersectionObserver((es) => {
    es.forEach((e) => {
      visible = e.isIntersecting;
      if (visible) stage.start(); else stage.stop();
    });
  }, { rootMargin: '0px' });
  io.observe(host);
  cleanups.push(() => io.disconnect());
  stage.__visible = () => visible;
  return stage;
}

function addTrigger(vars) {
  const t = ST.create(vars);
  triggers.push(t);
  return t;
}

// Per-frame projection without touching the DOM (no forced layout): positions are relative to the
// stage container, whose size is cached and kept current by the stage's resize event.
const _pv = new THREE.Vector3();
function sizeOf(stage) {
  if (!stage.__size) {
    const r = stage.container.getBoundingClientRect();
    stage.__size = { w: r.width || 1, h: r.height || 1 };
    stage.on('resize', (e) => { const b = stage.container.getBoundingClientRect(); stage.__size.w = (e && e.width) || b.width; stage.__size.h = (e && e.height) || b.height; });
  }
  return stage.__size;
}
function projLocal(stage, v) {
  const z = sizeOf(stage);
  _pv.copy(v).project(stage.camera);
  return { x: ((_pv.x + 1) / 2) * z.w, y: ((1 - _pv.y) / 2) * z.h, visible: _pv.z > -1 && _pv.z < 1 };
}

// world point on the plane z = planeZ under a client pixel
const _ray = new THREE.Raycaster();
function worldAt(stage, cx, cy, planeZ = 0) {
  const r = stage.container.getBoundingClientRect();
  const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  stage.camera.updateMatrixWorld();
  _ray.setFromCamera(ndc, stage.camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
  const p = new THREE.Vector3();
  _ray.ray.intersectPlane(plane, p);
  return p;
}
function unitsPerPx(stage, planeZ = 0) {
  const r = stage.container.getBoundingClientRect();
  const a = worldAt(stage, r.left + r.width / 2, r.top + r.height / 2, planeZ);
  const b = worldAt(stage, r.left + r.width / 2 + 100, r.top + r.height / 2, planeZ);
  return a.distanceTo(b) / 100;
}

// HTML labels that follow 3D points. They stay inside the frame (48px margin), clear of the chin,
// and are pushed apart when they would overlap. Higher prio is placed first.
function labelSet(stage, layer, minX) {
  const items = [];
  const v = new THREE.Vector3();
  function add(html, pos, cls = '', opts = {}) {
    const el = document.createElement('div');
    el.className = 'gl-label ' + cls;
    el.innerHTML = '<span class="gl-lt">' + html + '</span>';
    layer.appendChild(el);
    const it = { el, inner: el.firstChild, eo: -1, io: -1, pos: pos.clone ? pos.clone() : new THREE.Vector3(...pos), obj: opts.obj || null, dx: opts.dx || 0, dy: opts.dy || 0, align: opts.align || 'left', op: 0, show: opts.show !== false, prio: opts.prio || 1, w: 0, h: 0 };
    items.push(it);
    items.sort((p, q) => q.prio - p.prio);
    return it;
  }
  let sized = false;
  function update() {
    if (!sized) { items.forEach((it) => { it.w = it.el.offsetWidth; it.h = it.el.offsetHeight; }); sized = true; }
    const z = sizeOf(stage);
    stage.camera.updateMatrixWorld();
    const left = minX ? minX() : 8, right = z.w - 48, top = 24, bottom = z.h - 40 - 32;
    const placed = [];
    items.forEach((it) => {
      if (it.obj) it.obj.getWorldPosition(v); else v.copy(it.pos);
      const p = projLocal(stage, v);
      let x = p.x, y = p.y + it.dy;
      let vis = p.visible && it.show && it.op > 0.01 && x >= left;
      if (vis) {
        x += it.dx - (it.align === 'left' ? 0 : it.w * (it.align === 'center' ? 0.5 : 1));
        x = Math.min(Math.max(x, left), right - it.w);
        for (const q of placed) {
          if (x < q.x + q.w + 8 && x + it.w + 8 > q.x && y < q.y + q.h + 6 && y + it.h + 6 > q.y) y = q.y + q.h + 6;
        }
        vis = y >= top && y + it.h <= bottom && x + it.w <= right + 1;
      }
      // the pill reaches full opacity early (so the evidence curves always pass behind it);
      // the text carries the rest of the fade
      const eo = vis ? Math.min(1, it.op * 3) : 0;
      if (Math.abs(eo - it.eo) > 0.004) { it.eo = eo; it.el.style.opacity = eo.toFixed(3); }
      if (!vis) return;
      const io = Math.min(1, it.op / eo);
      if (Math.abs(io - it.io) > 0.004) { it.io = io; it.inner.style.opacity = io.toFixed(3); }
      placed.push({ x, y, w: it.w, h: it.h });
      it.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    });
  }
  return { add, update, items };
}

// the custom cursor says "Drag" over things that can be picked up or turned
function dragLabel(stage, host, list) {
  if (!NOVA.cursorLabel) return;
  let on = false, last = 0;
  host.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - last < 60) return;
    last = now;
    const hit = list ? !!stage.pick(e.clientX, e.clientY, list()) : true;
    if (hit !== on) { on = hit; NOVA.cursorLabel(on ? 'Drag' : null); }
  });
  host.addEventListener('pointerleave', () => { if (on) { on = false; NOVA.cursorLabel(null); } });
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16; // three clamps to the GPU's max; keeps text sharp on planes seen at an angle
  return tex;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/); const lines = []; let line = '';
  words.forEach((w) => { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
  if (line) lines.push(line);
  return lines;
}
function spaced(ctx, text, x, y, spacing) {
  // letter-spaced mono labels
  let cx = x;
  for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
  return cx;
}

/* =========================================================
   FRAME + HUD
   ========================================================= */
function frameHud() {
  doc.classList.add('gl-frame');
  if (N.screenFrame) {
    // grain comes from the page's own static layer (.grain), so it looks the same before and after WebGL starts
    const f = N.screenFrame(document.body, { bezel: true, glare: true, scanlines: false, grain: false, vignette: true, radius: 26, intensity: 0.9, chin: 40 });
    cleanups.push(() => f.dispose && f.dispose());
    // ease the bezel in rather than popping it over a page that's already on screen
    const fr = document.querySelector('.nova-frame');
    if (fr) { fr.style.opacity = '0'; requestAnimationFrame(() => { fr.style.transition = 'opacity .9s ease'; fr.style.opacity = '1'; }); }
  }
  const tc = $('[data-hud-tc]'), ch = $('[data-hud-ch]');
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); } catch (e) { fmt = null; }
  let last = 0;
  const tick = () => {
    const now = performance.now();
    if (now - last < 40) return;
    last = now;
    const d = new Date();
    const fr = Math.floor((d.getMilliseconds() / 1000) * 24);
    const t = fmt ? fmt.format(d) : d.toTimeString().slice(0, 8);
    if (tc) tc.textContent = t + ':' + String(fr).padStart(2, '0');
  };
  gsap.ticker.add(tick);
  cleanups.push(() => gsap.ticker.remove(tick));
  const CH = [['.hero', '00 · Kitchen'], ['#day', '01 · A day'], ['#dots', '02 · Insights'], ['#sees', '03 · Vision'],
    ['#build', '04 · How it works'], ['#meet', '05 · Meet Nova']].map(([sel, label]) => [$(sel), label]).filter((x) => x[0]);
  let lastCh = 0, curCh = '';
  const chTick = () => {
    const now = performance.now();
    if (now - lastCh < 200) return;
    lastCh = now;
    const mid = innerHeight / 2;
    for (const [el, label] of CH) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) { if (label !== curCh && ch) { curCh = label; ch.textContent = label; } break; }
    }
  };
  gsap.ticker.add(chTick);
  cleanups.push(() => gsap.ticker.remove(chTick));
}

/* =========================================================
   HERO: a chrome logo loop resolves into the Echo Show 8
   ========================================================= */
// resolves once the hero's intro has finished (or straight away when there is none)
let heroSettledResolve;
const heroSettled = new Promise((r) => { heroSettledResolve = r; });

async function hero() {
  const host = $('.gl-hero');
  if (!host) { heroSettledResolve(); return; }
  $('.hero').classList.add('is-gl-prep'); // lay the host out (still transparent) so the stage has a real size
  const stage = makeStage(host, {
    background: 'transparent', bloom: true, css3d: true, fov: 30,
    camera: [0, 1.5, 9], target: [0, 0.9, 0], timeOfDay: 18.3,
    fx: { grain: 0, vignette: 0, scanlines: 0, aberration: 0 },
  });
  const REST = { position: [0, 1.5, 9], target: [0, 0.9, 0] };
  let sp = 0, introDone = false;

  // kitchen: counter, wall glow, a window at golden hour
  const counter = makeCounter({ width: 26, depth: 7, fade: 0.22 });
  const win = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 3.4),
    new THREE.MeshBasicMaterial({ map: windowTexture(), transparent: true, opacity: 0.32, toneMapped: false, depthWrite: false })
  );
  stage.scene.add(counter, win);
  const echo = N.createEchoShow({ size: 8, color: 'charcoal', shadow: true });
  stage.add(echo);
  echo.setRing('off');

  // the live screen: a copy of the DOM screen, mapped onto the glass
  const src = $('[data-hero-screen]');
  const scr = src.cloneNode(true);
  scr.classList.add('gl-screen');
  scr.querySelectorAll('.e3-lightbar, .e3-spec').forEach((n) => n.remove());
  scr.setAttribute('aria-hidden', 'true');
  echo.attachScreen(scr, { pxWidth: 1280, pxHeight: 800, className: 'gl-screen-wrap' });
  const wrap = scr.parentElement && scr.parentElement.classList.contains('gl-screen-wrap') ? scr.parentElement : scr;
  wrap.style.pointerEvents = 'none';
  dragLabel(stage, host, () => [echo]);

  const logo = N.createNovaLogo({ finish: 'chrome', core: 'star', size: 1, spin: 0.9, glow: true });
  stage.add(logo);

  // place everything relative to the (hidden) DOM device, so the 3D follows the layout grid
  const anchor = $('.hero-device .echo3d');
  let base = new THREE.Vector3(), S = 1;
  function layout() {
    stage.setCamera(REST);
    const r = anchor.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    origin = `${Math.round(r.left + r.width / 2 - hr.left)}px ${Math.round(r.top + r.height / 2 - hr.top)}px`;
    const upp = unitsPerPx(stage, 0);
    S = (r.width * upp) / 2.0;
    base = worldAt(stage, r.left + r.width / 2, r.bottom, 0);
    echo.group.scale.setScalar(S);
    echo.group.position.copy(base);
    counter.position.set(base.x + 9.6, base.y, 0);
    win.position.set(base.x + 1.75 * S, base.y + 1.05 * S, -4.2);
    win.scale.setScalar(S * 0.62);
    if (!introDone) placeLogoStart();
    applyScroll();
  }
  const LOGO_PEAK = 0.58; // the intro logo peaks at a bit over half the Echo's size, so it never fills the hero
  function placeLogoStart() {
    logo.group.position.set(base.x, base.y + 0.72 * S, 0.4);
    logo.group.scale.setScalar(S * LOGO_PEAK);
    echo.group.position.y = base.y - 1.7 * S;
  }

  // ring follows the hero script; the intro owns it until it finishes
  const RING = { idle: 'idle', speaking: 'speaking', listening: 'listening', thinking: 'thinking', notify: 'notify' };
  NOVA.heroBus.push((s) => {
    wrap.setAttribute('data-state', s.state);
    if (introDone) echo.setRing(RING[s.state] || 'idle');
  });

  echo.group.rotation.y = -0.3;
  const orbit = N.enableOrbit ? N.enableOrbit(stage, echo, { maxYaw: 0.6, maxPitch: 0.16, springBack: true, hover: true }) : null;
  if (orbit && orbit.setEnabled) orbit.setEnabled(false);

  function intro() {
    if (intro.ran) return;
    intro.ran = true;
    const tl = gsap.timeline({ delay: 0.15 });
    const ls = logo.group.scale, lp = logo.group.position, ep = echo.group.position;
    tl.fromTo(ls, { x: S * 0.2, y: S * 0.2, z: S * 0.2 }, { x: S * LOGO_PEAK, y: S * LOGO_PEAK, z: S * LOGO_PEAK, duration: 1.3, ease: 'expo.out' }, 0);
    tl.add(() => { if (logo.spin) logo.spin(3.2); }, 1.25);
    tl.to(ep, { y: base.y, duration: 1.5, ease: 'expo.out' }, 1.55);
    tl.to(lp, { z: 0.12, y: base.y + 0.66 * S, duration: 1.1, ease: 'power3.inOut' }, 1.5);
    tl.to(ls, { x: S * 0.08, y: S * 0.08, z: S * 0.08, duration: 1.0, ease: 'power3.in' }, 1.65);
    tl.add(() => {
      logo.group.visible = false;
      echo.setRing('speaking');
      if (logo.spin) logo.spin(0);
    }, 2.62);
    tl.add(() => {
      introDone = true;
      if (orbit && orbit.setEnabled) orbit.setEnabled(true);
      const s = NOVA.heroState;
      if (s) echo.setRing(RING[s.state] || 'idle');
      setTimeout(heroSettledResolve, 400);
    }, 3.6);
  }
  const heroSec = $('.hero');
  function finalState() {
    intro.ran = true; introDone = true;
    logo.group.visible = false;
    layout();
    if (orbit && orbit.setEnabled) orbit.setEnabled(true);
    const s0 = NOVA.heroState; echo.setRing(s0 ? RING[s0.state] || 'idle' : 'idle');
    heroSettledResolve();
  }
  function goLive() {
    heroSec.classList.add('is-gl', 'is-gl-live');
    setTimeout(() => heroSec.classList.add('is-gl-done'), 1000);
  }
  // which reveal to play is decided now; it starts only once the first frame is ready (see the end)
  function reveal() {
    if (!NOVA.introAt) {
      // ready before the curtain lifts: the logo loop is the reveal
      goLive();
      document.addEventListener('nova:intro', intro, { once: true });
    } else if (NOVA.scrollNow() < innerHeight * 0.6) {
      // the CSS Echo is on screen: cross-fade into the logo loop, which resolves into the 3D Echo
      goLive();
      intro();
    } else {
      goLive();
      finalState();
    }
  }

  // scrolling away: the view sinks and pulls back a little. That is a compositor transform on the
  // rendered layers, and the scene itself holds its last frame, so leaving the hero costs no GPU frames
  // (re-rendering the hero while the next scene comes in was the worst jank on integrated GPUs).
  const layers = [stage.canvas, stage.cssLayer].filter(Boolean);
  let origin = '70% 60%';
  function applyScroll() {
    stage.hold(sp > 0.015);
    const k = smooth(sp);
    const t = k > 0.0005 ? `translate3d(0, ${(k * 12).toFixed(2)}%, 0) scale(${(1 - k * 0.05).toFixed(4)})` : '';
    layers.forEach((el) => { el.style.transformOrigin = origin; el.style.transform = t; });
  }
  addTrigger({ trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true, onUpdate: (s) => { sp = s.progress; applyScroll(); } });

  stage.on('resize', layout);
  layout();
  // all the heavy one-off work (shader programs, texture uploads, the first frame) happens while the
  // CSS Echo is still the one on screen, so the swap itself is a smooth cross-fade
  if (stage.compileAsync) await stage.compileAsync();
  await idleFrame();
  warmTextures(stage);
  await idleFrame();
  stage.render();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  reveal();
}

function idleFrame() {
  return new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 120 }) : setTimeout(r, 16)));
}

// a dark stone counter whose left end dissolves, so it never cuts through the copy
function makeCounter({ width = 24, depth = 6, fade = 0.3 } = {}) {
  const g = new THREE.Group();
  const alpha = canvasTexture(256, 4, (ctx, w) => {
    const gr = ctx.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, '#000'); gr.addColorStop(fade, '#fff'); gr.addColorStop(1, '#fff');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, w, 4);
  });
  alpha.colorSpace = THREE.NoColorSpace;
  const topMat = new THREE.MeshLambertMaterial({ color: 0x0f0e12, transparent: true, alphaMap: alpha, depthWrite: true });
  const top = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), topMat);
  top.rotation.x = -Math.PI / 2; top.position.set(0, 0, -depth / 2 + 1.9);
  const front = new THREE.Mesh(new THREE.PlaneGeometry(width, 4), new THREE.MeshBasicMaterial({ color: 0x060608, transparent: true, alphaMap: alpha }));
  front.position.set(0, -2, 1.9);
  const edge = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.014), new THREE.MeshBasicMaterial({ color: 0x8a7462, transparent: true, opacity: 0.5, alphaMap: alpha }));
  edge.position.set(0, -0.007, 1.905);
  [top, front, edge].forEach((m) => { m.userData.noPick = true; });
  g.add(top, front, edge);
  return g;
}

function windowTexture() {
  return canvasTexture(512, 384, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2B2850'); g.addColorStop(0.38, '#6B4C8F'); g.addColorStop(0.7, '#E0708A'); g.addColorStop(1, '#FFB27A');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const sun = ctx.createRadialGradient(w * 0.7, h * 0.86, 4, w * 0.7, h * 0.86, h * 0.5);
    sun.addColorStop(0, 'rgba(255,240,210,.95)'); sun.addColorStop(0.2, 'rgba(255,200,140,.5)'); sun.addColorStop(1, 'rgba(255,178,122,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20,14,26,.9)';
    for (let i = 0; i < 9; i++) { const x = (i / 8) * w, r = 26 + ((i * 37) % 30); ctx.beginPath(); ctx.arc(x, h - 10, r, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#0B0B10';
    ctx.fillRect(0, 0, w, 14); ctx.fillRect(0, h - 14, w, 14); ctx.fillRect(0, 0, 14, h); ctx.fillRect(w - 14, 0, 14, h);
    ctx.fillRect(w / 2 - 6, 0, 12, h); ctx.fillRect(0, h * 0.46 - 6, w, 12);
  });
}

/* =========================================================
   A DAY WITH NOVA: arc carousel under a living sky
   ========================================================= */
async function day() {
  const sec = $('.day');
  // the DOM skyline in front of the 3D sky: silhouette tint and lit windows follow the scene's hour
  const SIL = [[7.0, [10, 11, 18]], [8.0, [36, 31, 56]], [10.5, [56, 66, 92]], [16.0, [56, 66, 92]], [18.0, [46, 32, 56]],
    [19.6, [21, 19, 42]], [21.0, [10, 11, 18]]];
  let lastSil = '';
  function skylineAt(hour) {
    const hh = hour % 24;
    let c = SIL[SIL.length - 1][1];
    if (hh <= SIL[0][0]) c = SIL[0][1];
    else for (let i = 1; i < SIL.length; i++) {
      if (hh <= SIL[i][0]) { const [h0, a] = SIL[i - 1], [h1, b] = SIL[i], t = (hh - h0) / (h1 - h0); c = a.map((v, k) => Math.round(lerp(v, b[k], t))); break; }
    }
    const lights = hh < 9 ? clamp((9 - hh) / 1.2, 0, 0.7) : clamp((hh - 17.4) / 1.8, 0, 1);
    const key = c.join(',') + '|' + lights.toFixed(2);
    if (key === lastSil) return;
    lastSil = key;
    sec.style.setProperty('--sil', `rgb(${c.join(',')})`);
    sec.style.setProperty('--lights', lights.toFixed(2));
  }
  const host = $('.gl-day');
  if (!sec || !host) return;
  sec.classList.add('is-gl');
  const stage = makeStage(host, {
    quality: 'low', background: 'sky', bloom: false, css3d: false, fov: 34, environment: false, pixelRatioCap: 1.25,
    camera: [0, 1.75, 10.5], target: [0, 1.65, 0], timeOfDay: 7.9,
    fx: { grain: 0, vignette: 0, scanlines: 0, aberration: 0 },
  });
  const moments = $$('.day-track .moment').filter((m) => !m.classList.contains('moment-intro'));
  const hours = moments.map((m) => parseFloat(m.getAttribute('data-hour')));
  const items = moments.map((m) => {
    const hm = (m.querySelector('.m-hm') || {}).textContent || '';
    const ap = (m.querySelector('.m-ap') || {}).textContent || '';
    const tone = m.getAttribute('data-tone') === 'amber' ? COL.amber : COL.nova;
    return {
      title: (m.querySelector('.m-tag') || {}).textContent || '',
      subtitle: hm + ' ' + ap,
      time: hourLabel(parseFloat(m.getAttribute('data-hour'))),
      color: tone,
      canvasDraw: (ctx, w, h) => drawMoment(ctx, w, h, m),
    };
  });

  let fromScroll = false, target = 0;
  const car = N.createArcCarousel(stage, items, {
    radius: 9, spacing: 0.4, cardWidth: 2.7, cardHeight: 3.75, position: [0, 1.75, 0],
    keyboard: true, wheel: false, drag: true,
    onChange: (i) => { if (!fromScroll) toIndex(i); },
  });

  const clock = $('[data-gl-clock]');
  const sun = $('.gl-sun');
  const n = items.length;
  const FIRST = 0.1; // a little scroll before the first card turns
  const clocks = moments.map((m) => m.getAttribute('data-clock-label'));
  const st = addTrigger({
    trigger: sec, start: 'top top', end: () => '+=' + Math.round(innerHeight * 1.0),
    onToggle: () => {},
    pin: true, anticipatePin: 1, refreshPriority: 3,
    onUpdate: (s) => fromProgress(s.progress),
    onRefresh: (s) => fromProgress(s.progress),
  });

  function idxAt(p) { return clamp((p - FIRST) / (1 - FIRST), 0, 1) * (n - 1); }
  function hourAt(p) {
    if (p < FIRST) return lerp(7.75, hours[0], p / FIRST);
    const f = idxAt(p), i = Math.floor(f);
    return i >= n - 1 ? hours[n - 1] : lerp(hours[i], hours[i + 1], f - i);
  }
  function progressForIndex(i) { return FIRST + (i / (n - 1)) * (1 - FIRST); }
  function fromProgress(p) {
    const i = Math.round(idxAt(p));
    if (i !== car.index) { fromScroll = true; target = i; car.select(i); fromScroll = false; }
    const h = hourAt(p);
    stage.setTimeOfDay(h);
    skylineAt(h);
    const fi = idxAt(p), ci = Math.round(fi);
    if (clock) clock.textContent = (p >= FIRST && Math.abs(fi - ci) < 0.3 && clocks[ci]) ? clocks[ci] : hourLabel(h, true);
    const hh = h % 24; sec.setAttribute('data-fg', hh > 6.6 && hh < 18.9 ? 'dark' : 'light');
    sec.classList.toggle('is-past-intro', p > FIRST * 1.6);
    car.group.position.x = lerp(3.1, 0, smooth(clamp(p / (FIRST * 1.6), 0, 1)));
  }
  function toIndex(i) {
    if (i === target) return;
    target = i;
    NOVA.scrollToY(st.start + progressForIndex(i) * (st.end - st.start), false);
  }

  // the sun handle sits on the sky's sun; dragging it scrubs the time of day
  const tmp = new THREE.Vector3();
  stage.onFrame(() => {
    const sky = stage.sky;
    if (!sun || !sky) return;
    const z = sizeOf(stage);
    let x, y, on, useMoon;
    const U = sky.uniforms;
    if (U && U.uSun) {
      useMoon = (U.uSunVis ? U.uSunVis.value : 1) < 0.05;
      const q = useMoon ? U.uMoon.value : U.uSun.value;
      x = (0.5 + q.x * 0.5) * z.w; y = (0.5 - q.y * 0.5) * z.h;
      on = (useMoon ? (U.uMoonVis ? U.uMoonVis.value : 0) : U.uSunVis.value) > 0.05;
    } else {
      useMoon = sky.sun < 0.05 && !!sky.moonDirection;
      stage.camera.updateMatrixWorld();
      tmp.copy(useMoon ? sky.moonDirection : sky.sunDirection).normalize().multiplyScalar(60).add(stage.camera.position);
      const p = projLocal(stage, tmp); x = p.x; y = p.y; on = p.visible;
    }
    // only where it's clear of the cards (the sun passes behind them for most of the day)
    tmp.set(0, 1.75 + 3.75 * 0.53 + 0.08, 0);
    const bandTop = projLocal(stage, tmp).y;
    on = on && y + 50 < bandTop && y > 40 && x > 40 && x < z.w - 160;
    if (on !== sun.__on) { sun.__on = on; sun.classList.toggle('is-on', on); }
    if (useMoon !== sun.__moon) { sun.__moon = useMoon; sun.classList.toggle('is-moon', useMoon); }
    if (on) sun.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  });
  // drag the sun or the clock: scrub the time of day
  function scrubber(el) {
    let sx = 0, sh = 0, dragging = false;
    const span = 21 - 7.75;
    el.addEventListener('pointerdown', (e) => { dragging = true; sx = e.clientX; sh = hourAt(st.progress); el.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const h = clamp(sh + ((e.clientX - sx) / (innerWidth * 0.75)) * span, 7.75, 21);
      NOVA.scrollToY(st.start + progressForHour(h) * (st.end - st.start), true);
    });
    const end = () => { dragging = false; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  if (clock) { scrubber(clock); clock.setAttribute('data-cursor', 'Drag'); }
  if (sun) {
    scrubber(sun);
    sun.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = clamp((car.index || 0) + (e.key === 'ArrowRight' ? 1 : -1), 0, n - 1);
      toIndex(i);
    });
  }
  function progressForHour(h) {
    if (h <= hours[0]) return clamp(((h - 7.75) / (hours[0] - 7.75)) * FIRST, 0, FIRST);
    for (let i = 1; i < n; i++) if (h <= hours[i]) return progressForIndex(i - 1 + (h - hours[i - 1]) / (hours[i] - hours[i - 1]));
    return 1;
  }
  cleanups.push(() => car.dispose && car.dispose());
  dragLabel(stage, host, null);
  // the faces are drawn after the web fonts loaded (boot waits for them), so they upload once, in the warm-up
  if (car.redraw) car.redraw();
}

function hourLabel(h, withMinutes) {
  const m = Math.round(h * 60), hh = Math.floor(m / 60) % 24, mm = m % 60;
  const ap = hh < 12 ? 'AM' : 'PM', h12 = hh % 12 || 12;
  return withMinutes === false ? h12 + ' ' + ap : h12 + ':' + String(mm).padStart(2, '0') + ' ' + ap;
}

// a moment card face, drawn from the DOM card so the copy has one source
function drawMoment(ctx, w, h, m) {
  const tod = m.getAttribute('data-tod');
  const light = tod === 'day';
  const ink = '#0A0B10', ivory = '#F4EEE6';
  const fg = light ? ink : ivory;
  const mist = light ? 'rgba(10,11,16,.62)' : 'rgba(244,238,230,.66)';
  const faint = light ? 'rgba(10,11,16,.4)' : 'rgba(244,238,230,.4)';
  const line = light ? 'rgba(10,11,16,.12)' : 'rgba(244,238,230,.12)';
  const amber = m.getAttribute('data-tone') === 'amber';
  const tone = light ? (amber ? '#B06A00' : '#0A7FA8') : (amber ? COL.amber : COL.nova);
  const u = w / 100; // 1% of width
  // face
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  if (light) { bg.addColorStop(0, '#FBF8F2'); bg.addColorStop(1, '#EFE8DD'); } else { bg.addColorStop(0, '#16171E'); bg.addColorStop(1, '#0D0E13'); }
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  if (m.classList.contains('moment-alert')) {
    const gl = ctx.createRadialGradient(w * 0.5, h * 1.05, 0, w * 0.5, h * 1.05, h * 0.8);
    gl.addColorStop(0, 'rgba(255,181,71,.28)'); gl.addColorStop(1, 'rgba(255,181,71,0)');
    ctx.fillStyle = gl; ctx.fillRect(0, 0, w, h);
  }
  const pad = 8 * u;
  let y = pad;
  // time
  const hm = (m.querySelector('.m-hm') || {}).textContent || '';
  const ap = (m.querySelector('.m-ap') || {}).textContent || '';
  ctx.fillStyle = fg;
  ctx.font = `400 ${26 * u}px "Instrument Serif"`;
  ctx.textBaseline = 'alphabetic';
  y += 20 * u;
  ctx.fillText(hm, pad - 1.2 * u, y);
  const tw = ctx.measureText(hm).width;
  ctx.fillStyle = mist; ctx.font = `400 ${3.4 * u}px "JetBrains Mono"`;
  spaced(ctx, ap, pad + tw + 2 * u, y, 0.5 * u);
  // tag
  y += 9 * u;
  const tag = ((m.querySelector('.m-tag') || {}).textContent || '').trim().toUpperCase();
  ctx.strokeStyle = tone; ctx.lineWidth = 0.45 * u;
  ctx.beginPath(); ctx.arc(pad + 1.6 * u, y - 1.1 * u, 1.5 * u, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = tone; ctx.font = `500 ${2.9 * u}px "JetBrains Mono"`;
  const tagLines = wrapText(ctx, tag, w - pad * 2 - 6 * u);
  tagLines.slice(0, 2).forEach((l, k) => spaced(ctx, l, pad + 5 * u, y + k * 4.4 * u, 0.32 * u));
  y += (tagLines.length > 1 ? 4.4 * u : 0) + 7.5 * u;
  // context
  const context = (m.querySelector('.m-context') || {}).textContent;
  if (context) {
    ctx.fillStyle = mist; ctx.font = `400 ${3.9 * u}px "Inter Tight"`;
    wrapText(ctx, context.trim(), w - pad * 2).slice(0, 3).forEach((l) => { ctx.fillText(l, pad, y); y += 5.4 * u; });
    y += 2.5 * u;
  }
  // quote
  const quote = ((m.querySelector('.m-quote') || {}).textContent || '').trim();
  ctx.fillStyle = fg; ctx.font = `400 ${7.3 * u}px "Instrument Serif"`;
  y += 4 * u;
  wrapText(ctx, quote, w - pad * 2).forEach((l) => { ctx.fillText(l, pad, y); y += 8 * u; });
  y += 3 * u;
  // extras
  const chips = $$('.m-chips span, .m-consent button', m).map((x) => x.textContent.trim());
  if (chips.length) {
    ctx.font = `500 ${3.2 * u}px "Inter Tight"`;
    let x = pad;
    chips.forEach((c, k) => {
      const cw = ctx.measureText(c).width + 6 * u;
      if (x + cw > w - pad) return;
      roundRect(ctx, x, y, cw, 8 * u, 4 * u);
      if (k === 0) { ctx.fillStyle = fg; ctx.fill(); ctx.fillStyle = light ? ivory : ink; }
      else { ctx.strokeStyle = line; ctx.lineWidth = 0.3 * u; ctx.stroke(); ctx.fillStyle = mist; }
      ctx.fillText(c, x + 3 * u, y + 5.4 * u);
      x += cw + 2 * u;
    });
    y += 12 * u;
  }
  const ladder = $$('.m-ladder b', m);
  if (ladder.length) {
    ctx.font = `500 ${3 * u}px "JetBrains Mono"`;
    let x = pad;
    ladder.forEach((b, k) => {
      const on = b.classList.contains('on'), done = b.classList.contains('done'), amb = b.classList.contains('amber');
      const cw = ctx.measureText(b.textContent).width + 5 * u;
      roundRect(ctx, x, y, cw, 7.4 * u, 3.7 * u);
      if (on) { ctx.fillStyle = amb ? COL.amber : COL.nova; ctx.fill(); ctx.fillStyle = ink; }
      else { ctx.strokeStyle = done ? mist : line; ctx.lineWidth = 0.3 * u; ctx.stroke(); ctx.fillStyle = done ? mist : faint; }
      ctx.fillText(b.textContent, x + 2.5 * u, y + 5 * u);
      x += cw;
      if (k < ladder.length - 1) { ctx.fillStyle = line; ctx.fillRect(x + 1 * u, y + 3.6 * u, 4 * u, 0.3 * u); x += 6 * u; }
    });
    y += 11 * u;
  }
  const rows = $$('.m-evidence li, .m-recon .mr-row', m);
  if (rows.length) {
    rows.forEach((r) => {
      ctx.fillStyle = line; ctx.fillRect(pad, y, w - pad * 2, 0.25 * u);
      const k = (r.querySelector('span') || {}).textContent || '';
      const rest = r.classList.contains('mr-row')
        ? ((r.querySelector('.mr-name') || {}).textContent || '') + '   ' + ((r.querySelector('.mr-dose') || {}).textContent || '').replace(/\s+/g, ' ').trim()
        : r.textContent.replace(k, '').trim();
      ctx.font = `500 ${2.8 * u}px "JetBrains Mono"`; ctx.fillStyle = tone;
      spaced(ctx, k.toUpperCase(), pad, y + 5.4 * u, 0.25 * u);
      ctx.font = `400 ${3.4 * u}px "Inter Tight"`; ctx.fillStyle = mist;
      const ls = wrapText(ctx, rest.replace(/\s+/g, ' '), w - pad * 2 - 18 * u).slice(0, 2);
      ls.forEach((l, k) => ctx.fillText(l, pad + 18 * u, y + 5.4 * u + k * 4.8 * u));
      y += 8 * u + (ls.length - 1) * 4.8 * u;
    });
  }
  const gn = m.querySelector('.m-goodnight');
  if (gn) { ctx.fillStyle = mist; ctx.font = `italic 400 ${10 * u}px "Instrument Serif"`; ctx.fillText(gn.textContent.trim(), pad, Math.min(h - pad, y + 12 * u)); }
}

/* =========================================================
   CONNECTS THE DOTS: the 14 days as a place you move through
   ========================================================= */
async function dots() {
  const sec = $('.dots');
  const host = $('.gl-dots');
  if (!sec || !host) return;
  sec.classList.add('is-gl', 'is-pinned');
  const stage = makeStage(host, {
    quality: 'low', background: 'transparent', bloom: false, css3d: false, fov: 34, environment: false, pixelRatioCap: 1.25,
    camera: [-12, 3, 8], target: [-8, 1.8, 1], timeOfDay: 22,
    fx: { grain: 0, vignette: 0, scanlines: 0, aberration: 0 },
  });
  const scene = stage.scene;
  scene.fog = new THREE.Fog(0x0a0b10, 14, 46);
  // the scene lives right of the text column: scrim, label clipping and framing all follow its edge
  const headEl = $('.dots-head', sec);
  const region = { left: 0, right: 1, width: 1, frac: 0.5, k: 1 };
  function viewOffset() {
    const r = host.getBoundingClientRect();
    const colEnd = headEl.getBoundingClientRect().right - r.left;
    region.left = colEnd + 150;
    region.right = r.width - Math.max(48, (r.width - 1440) / 2 + 48);
    region.width = Math.max(200, region.right - region.left);
    region.frac = region.width / r.width;
    region.k = clamp(980 / region.width, 1, 1.55);
    host.style.setProperty('--scrim', region.left + 'px');
    const dx = (region.left + region.right) / 2 - r.width / 2;
    stage.camera.setViewOffset(r.width, r.height, -dx, 0, r.width, r.height);
    stage.camera.updateProjectionMatrix();
    try { fitOverview(); } catch (e) { /* KEYS not built yet on the first call */ }
  }
  viewOffset();
  stage.on('resize', viewOffset);
  const X = (i) => (i - 6.5) * 1.5;
  const Y = (v) => (v - 40) * 0.032;
  const LANE = { dizz: 1.7, walk: 2.6, eve: 3.5 };
  const NOVAC = new THREE.Color(COL.nova), CORAL = new THREE.Color(COL.coral), SAGE = new THREE.Color(COL.sage), AMBER = new THREE.Color(COL.amber), IVORY = new THREE.Color(COL.ivory);
  const glow = (c, k = 2.2) => new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(k), toneMapped: false });

  // floor grid
  const grid = new THREE.GridHelper(42, 28, 0x2a3140, 0x161a22);
  grid.position.set(0, 0, 1.6);
  grid.material.transparent = true; grid.material.opacity = 0.55;
  scene.add(grid);
  const floorFade = new THREE.Mesh(new THREE.PlaneGeometry(60, 30), new THREE.MeshBasicMaterial({ color: 0x0a0b10, transparent: true, opacity: 0.0 }));
  floorFade.rotation.x = -Math.PI / 2; scene.add(floorFade);

  // BP readings: bars from diastolic to systolic, bright caps on top
  const BP = [[0, 154, 92, 'Oct 9 · Grace'], [2, 150, 90, 'Oct 11 · Grace'], [7, 118, 72, 'Oct 16 · Grace'], [9, 112, 68, 'Oct 18 · Rose'], [10, 104, 62, 'Oct 19 · Grace'], [12, 106, 64, 'Oct 21 · Rose']];
  const bars = BP.map(([i, s, d]) => {
    const g = new THREE.Group();
    const len = Y(s) - Y(d);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 20, 1, true), new THREE.MeshBasicMaterial({ color: NOVAC.clone().multiplyScalar(0.55), transparent: true, opacity: 0.45, toneMapped: false, depthWrite: false }));
    bar.position.y = Y(d) + len / 2;
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 16), glow(i === 10 ? AMBER : NOVAC, 2.6));
    top.position.y = Y(s);
    const bot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 20, 12), glow(NOVAC, 1.1));
    bot.position.y = Y(d);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, Y(d), 6), new THREE.MeshBasicMaterial({ color: 0x3a4658, transparent: true, opacity: 0.6 }));
    stem.position.y = Y(d) / 2;
    g.add(stem, bar, top, bot);
    g.position.set(X(i), 0, 0);
    g.userData = { i, top, appear: 0 };
    g.scale.set(1, 0.001, 1);
    scene.add(g);
    return g;
  });
  // systolic + diastolic curves, drawn as the camera passes
  const curve = (vals) => new THREE.CatmullRomCurve3(BP.map(([i, s, d]) => new THREE.Vector3(X(i), Y(vals === 's' ? s : d), 0)), false, 'centripetal');
  const tubeS = new THREE.Mesh(new THREE.TubeGeometry(curve('s'), 240, 0.022, 8, false), glow(NOVAC, 2.0));
  const tubeD = new THREE.Mesh(new THREE.TubeGeometry(curve('d'), 240, 0.013, 6, false), glow(NOVAC, 0.9));
  scene.add(tubeS, tubeD);
  const tubeCount = (m) => m.geometry.index.count;
  const drawTube = (m, f) => m.geometry.setDrawRange(0, Math.floor((tubeCount(m) / 6) * clamp(f, 0, 1)) * 6);
  drawTube(tubeS, 0); drawTube(tubeD, 0);

  // averages before and after the change
  const dashed = (pts, color, opacity = 0.7) => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const l = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity }));
    l.computeLineDistances(); scene.add(l); return l;
  };
  const avgPre = dashed([new THREE.Vector3(X(0) - 0.4, Y(152), 0), new THREE.Vector3(X(4), Y(152), 0)], 0xcfc8be, 0.55);
  const avgPost = dashed([new THREE.Vector3(X(4), Y(110), 0), new THREE.Vector3(X(13) + 0.4, Y(110), 0)], NOVAC, 0.7);

  // the dose change: a gate of light across every lane
  const gate = new THREE.Group();
  const gatePlane = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.4), new THREE.MeshBasicMaterial({ color: IVORY, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
  gatePlane.rotation.y = Math.PI / 2; gatePlane.position.set(0, 2.2, 1.6);
  const gateEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(4.6, 4.4)), new THREE.LineBasicMaterial({ color: IVORY.clone().multiplyScalar(1.6), toneMapped: false }));
  gateEdges.rotation.y = Math.PI / 2; gateEdges.position.copy(gatePlane.position);
  gate.add(gatePlane, gateEdges);
  gate.position.x = X(4);
  gate.scale.set(1, 0.001, 1);
  scene.add(gate);

  // dizziness: four coral lights, linked
  const DZ = [6, 8, 10, 12];
  const dzMeshes = DZ.map((i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), glow(CORAL, 2.8));
    m.position.set(X(i), 0.35, LANE.dizz); m.scale.setScalar(0.001); scene.add(m); return m;
  });
  const dzLink = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(X(6), 0.35, LANE.dizz), new THREE.Vector3(X(12), 0.35, LANE.dizz)), 64, 0.012, 6), glow(CORAL, 1.2));
  scene.add(dzLink); drawTube(dzLink, 0);
  const lagCurve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(X(4), 0.35, LANE.dizz), new THREE.Vector3(X(5), 1.3, LANE.dizz), new THREE.Vector3(X(6) - 0.2, 0.4, LANE.dizz));
  const lag = new THREE.Mesh(new THREE.TubeGeometry(lagCurve, 48, 0.008, 6), glow(IVORY, 1.0));
  scene.add(lag); drawTube(lag, 0);

  // walks stop, evening doses slip
  const walks = [3, 4, 5].map((i) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), glow(SAGE, 1.6)); m.position.set(X(i), 0.2, LANE.walk); m.scale.setScalar(0.001); scene.add(m); return m; });
  const walkNone = dashed([new THREE.Vector3(X(5) + 0.5, 0.2, LANE.walk), new THREE.Vector3(X(13), 0.2, LANE.walk)], SAGE, 0.0);
  const MISS = [9, 10, 11, 12];
  const eves = Array.from({ length: 13 }, (_, i) => {
    const miss = MISS.includes(i);
    const m = miss
      ? new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.022, 10, 32), glow(CORAL, 2.2))
      : new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), glow(SAGE, 1.1));
    if (miss) m.rotation.x = -Math.PI / 2;
    m.position.set(X(i), 0.12, LANE.eve); m.scale.setScalar(0.001); scene.add(m);
    m.userData.i = i; return m;
  });

  // Grace's note marker
  const graceRing = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.014, 10, 48), glow(AMBER, 2));
  graceRing.position.set(X(10), Y(104), 0); graceRing.scale.setScalar(0.001); scene.add(graceRing);

  // labels
  const L = labelSet(stage, $('.gl-labels', host), () => region.left - 30);
  const days = ['Oct 9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', 'Today'];
  const dayLabels = days.map((d, i) => { const it = L.add(d, [X(i), 0, LANE.eve + 0.8], '', { align: 'center' }); it.op = 1; return it; });
  const lanes = [['Home BP', [X(0) - 1.6, Y(130), 0]], ['Dizziness', [X(0) - 1.6, 0.35, LANE.dizz]], ['Walks, outings', [X(0) - 1.6, 0.2, LANE.walk]], ['Evening doses', [X(0) - 1.6, 0.12, LANE.eve]]]
    .map(([t, p]) => { const it = L.add(t, p, 'is-strong', { align: 'right', prio: 3 }); it.op = 1; return it; });
  const vals = BP.map(([i, s, d, who]) => L.add(`${s}/${d}`, [X(i), Y(s) + 0.42, 0], i === 10 ? 'is-amber' : 'is-strong', { align: 'center', prio: 2 }));
  const doseTag = L.add('Oct 13 · Lisinopril 10 &#8594; 20 mg', [X(4), 4.55, 1.6], 'is-tag', { align: 'center', prio: 4 });
  const lagTag = L.add('+2 days', [X(5), 1.35, LANE.dizz], 'is-strong', { align: 'center' });
  const preTag = L.add('Before · avg 152/91', [X(0) - 0.4, Y(152) + 0.32, 0], '', {});
  const postTag = L.add('Since · avg 110/66 · lowest 104/62', [X(13) + 0.4, Y(110) - 0.36, 0], 'is-strong', { align: 'right' });
  const noneTag = L.add('None since Oct 14', [X(8), 0.2, LANE.walk], 'is-sage', { align: 'center', dy: -22 });
  const missTag = L.add('5 missed in 4 days', [X(12), 0.12, LANE.eve], 'is-coral', { align: 'center', dy: -26 });
  const note = L.add('<b>Grace · Oct 19, 3:00 PM</b>&#8220;Rose was a little unsteady getting up from the couch today. Sitting BP 104/62.&#8221;', [X(10) + 0.5, Y(104) + 0.5, 0], 'is-note', { align: 'left', dx: 18, dy: -10, prio: 5 });

  // DOM overlays: steps and the insight card
  const steps = $$('.ds', sec), insight = $('.insight', sec), links = $('.dots-links', sec);
  host.insertBefore(links, $('.gl-labels', host)); // evidence curves run behind the labels
  function placeColumn() {
    const pr = $('.dots-pin', sec).getBoundingClientRect(), hr = headEl.getBoundingClientRect();
    sec.style.setProperty('--dots-below', Math.round(hr.bottom - pr.top + 32) + 'px');
  }
  placeColumn();
  stage.on('resize', placeColumn);
  gsap.set(insight, { opacity: 0, y: 40, rotationY: 12, transformPerspective: 1100, transformOrigin: '0% 50%' });
  gsap.set($$('.in-title .line-in, .in-ev li, .in-foot', insight), { opacity: 0, y: 16 });
  const insightTl = gsap.timeline({ paused: true })
    .to(insight, { opacity: 1, y: 0, rotationY: 0, duration: 0.9, ease: 'power2.out' }, 0)
    .to($$('.in-title .line-in', insight), { opacity: 1, y: 0, stagger: 0.12, duration: 0.5, ease: 'power2.out' }, 0.25)
    .to($$('.in-ev li', insight), { opacity: 1, y: 0, stagger: 0.22, duration: 0.4, ease: 'power2.out' }, 0.6)
    .to($('.in-foot', insight), { opacity: 1, y: 0, duration: 0.4 }, 1.5);

  // camera path through the fortnight
  const KEYS = [
    { p: 0.0, pos: [X(0) - 4.5, 4.2, 11.5], tgt: [X(2), 1.7, 1.2] },
    { p: 0.18, pos: [X(2) - 1.5, 4.0, 11.0], tgt: [X(4.5), 1.6, 1.4] },
    { p: 0.36, pos: [X(5) - 0.5, 3.8, 11.0], tgt: [X(7.5), 1.5, 1.4] },
    { p: 0.54, pos: [X(8), 3.8, 11.2], tgt: [X(10), 1.4, 1.5] },
    { p: 0.68, pos: [X(10.5), 4.0, 11.6], tgt: [X(12), 1.3, 1.6] },
    { p: 0.82, pos: [0.4, 9.5, 25.5], tgt: [0.2, 1.3, 1.6] },
    { p: 1.0, pos: [4.6, 10.4, 27.5], tgt: [4.2, 1.6, 1.6] },
  ];
  const cam = { p: 0 };
  const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();
  function fitOverview() {
    const asp = stage.camera.aspect || 1.6, tn = Math.tan((34 * Math.PI) / 360);
    const d = 23.5 / (region.frac * 0.82 * 2 * tn * asp);
    KEYS[5].pos = [0.6, d * 0.36, d * 0.93]; KEYS[5].tgt = [0.3, 1.3, 1.6];
    KEYS[6].pos = [0.4, d * 0.36, d * 0.9]; KEYS[6].tgt = [0.3, 1.4, 1.6];
  }
  stage.on('resize', fitOverview);
  fitOverview();
  function pose(p) {
    let a = KEYS[0], b = KEYS[KEYS.length - 1];
    for (let k = 1; k < KEYS.length; k++) if (p <= KEYS[k].p) { a = KEYS[k - 1]; b = KEYS[k]; break; }
    const t = smooth(clamp((p - a.p) / ((b.p - a.p) || 1), 0, 1));
    camPos.set(lerp(a.pos[0], b.pos[0], t), lerp(a.pos[1], b.pos[1], t), lerp(a.pos[2], b.pos[2], t));
    camTgt.set(lerp(a.tgt[0], b.tgt[0], t), lerp(a.tgt[1], b.tgt[1], t), lerp(a.tgt[2], b.tgt[2], t));
    // narrow regions: pull the dolly back so the same days stay in frame
    const kz = p < 0.7 ? region.k : lerp(region.k, 1, clamp((p - 0.7) / 0.12, 0, 1));
    camPos.sub(camTgt).multiplyScalar(kz).add(camTgt);
  }
  // reveal state follows the progress
  const xAt = (p) => lerp(X(-1), X(13) + 1, clamp(p / 0.68, 0, 1));
  const ease = (v, t) => v + (t - v) * 0.14;
  let insightOn = false, curStep = -1;
  const stepAt = [0, 0.16, 0.34, 0.56];

  stage.onFrame((dt, el) => {
    const p = cam.p;
    pose(p);
    stage.setCamera({ position: camPos.toArray(), target: camTgt.toArray() });
    const front = xAt(p);
    bars.forEach((g) => { const on = X(g.userData.i) <= front ? 1 : 0; g.userData.appear = ease(g.userData.appear, on); g.scale.y = Math.max(0.001, g.userData.appear); });
    const reach = clamp((front - X(0)) / (X(12) - X(0)), 0, 1);
    drawTube(tubeS, reach); drawTube(tubeD, reach);
    const gateOn = front >= X(4) ? 1 : 0;
    gate.scale.y = Math.max(0.001, ease(gate.scale.y, gateOn));
    gateEdges.material.color.copy(IVORY).multiplyScalar(1.4 + Math.sin(el * 2) * 0.3);
    dzMeshes.forEach((m, k) => { const on = X(DZ[k]) <= front ? 1 : 0; const s = ease(m.scale.x, on) ; m.scale.setScalar(Math.max(0.001, s) * (1 + (on ? Math.sin(el * 3 + k) * 0.12 : 0))); });
    drawTube(dzLink, clamp((front - X(6)) / (X(12) - X(6)), 0, 1));
    drawTube(lag, clamp((front - X(4)) / (X(6) - X(4)), 0, 1));
    walks.forEach((m, k) => { const on = X(3 + k) <= front ? 1 : 0; m.scale.setScalar(Math.max(0.001, ease(m.scale.x, on))); });
    walkNone.material.opacity = ease(walkNone.material.opacity, front > X(8) ? 0.6 : 0);
    eves.forEach((m) => { const on = X(m.userData.i) <= front ? 1 : 0; m.scale.setScalar(Math.max(0.001, ease(m.scale.x, on))); });
    const graceOn = front >= X(10) ? 1 : 0;
    graceRing.scale.setScalar(Math.max(0.001, ease(graceRing.scale.x, graceOn)));
    graceRing.rotation.z += dt * 0.6;
    avgPre.material.opacity = ease(avgPre.material.opacity, front > X(3) ? 0.55 : 0);
    avgPost.material.opacity = ease(avgPost.material.opacity, front > X(12) ? 0.75 : 0);
    // labels
    vals.forEach((it, k) => { it.op = ease(it.op, X(BP[k][0]) <= front ? 1 : 0); });
    doseTag.op = ease(doseTag.op, gateOn); lagTag.op = ease(lagTag.op, front > X(6) ? 1 : 0);
    preTag.op = ease(preTag.op, front > X(3) ? 1 : 0); postTag.op = ease(postTag.op, front > X(12) ? 1 : 0);
    noneTag.op = ease(noneTag.op, front > X(8) && p < 0.72 ? 1 : 0); missTag.op = ease(missTag.op, front > X(12) && p < 0.72 ? 1 : 0);
    note.op = ease(note.op, graceOn && p < 0.74 ? 1 : 0);
    lanes.forEach((it) => { it.op = ease(it.op, p < 0.72 ? 1 : 0); });
    dayLabels.forEach((it, i) => { it.op = ease(it.op, p < 0.72 || i === 0 || i === 13 ? 1 : 0); });
    L.update();
    // overlays
    let k = 0; stepAt.forEach((s, j) => { if (p >= s - 0.01) k = j; });
    if (k !== curStep) { curStep = k; steps.forEach((s, j) => s.classList.toggle('is-on', j === k)); }
    const showIns = p > 0.84;
    if (showIns !== insightOn) { insightOn = showIns; sec.classList.toggle('show-insight', showIns); showIns ? insightTl.timeScale(1).play() : insightTl.timeScale(2).reverse(); }
    drawLinks();
  });

  // evidence rows reach back to the 3D points they come from
  const NS = 'http://www.w3.org/2000/svg';
  const rows = $$('.in-ev li', insight);
  const targets = [bars[4].userData.top, dzMeshes[0], graceRing, gateEdges];
  const linkEls = rows.map(() => { const g = document.createElementNS(NS, 'g'); const pth = document.createElementNS(NS, 'path'); const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '3.5'); g.append(pth, c); links.appendChild(g); return { g, pth, c }; });
  const wv = new THREE.Vector3();
  let rowsRel = null;
  stage.on('resize', () => { rowsRel = null; });
  function drawLinks() {
    const t0 = insightTl.time();
    if (!insightOn && t0 <= 0) { if (rowsRel !== false) { linkEls.forEach((L2) => { L2.g.style.opacity = 0; }); rowsRel = false; } return; }
    if (!rowsRel || insightTl.isActive()) {
      const hb = host.getBoundingClientRect();
      rowsRel = rows.map((row) => { const a = row.getBoundingClientRect(); return { x: a.right - hb.left + 10, y: a.top - hb.top + a.height / 2 }; });
    }
    stage.camera.updateMatrixWorld();
    rows.forEach((row, i) => {
      const L2 = linkEls[i];
      const t = clamp((t0 - (0.75 + i * 0.22)) / 0.45, 0, 1) * (insightOn ? 1 : 0);
      if (t <= 0) { L2.g.style.opacity = 0; return; }
      targets[i].getWorldPosition(wv);
      if (i === 3) wv.y = 4.2;
      const p = projLocal(stage, wv);
      const x1 = rowsRel[i].x, y1 = rowsRel[i].y;
      const x2 = p.x, y2 = p.y;
      const mx = (x1 + x2) / 2;
      L2.pth.setAttribute('d', `M${x1.toFixed(1)},${y1.toFixed(1)} C${mx.toFixed(1)},${y1.toFixed(1)} ${mx.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`);
      const len = L2.pth.getTotalLength();
      L2.pth.style.strokeDasharray = `${len} ${len + 20}`;
      L2.pth.style.strokeDashoffset = (len * (1 - t)).toFixed(1);
      L2.c.setAttribute('cx', x2.toFixed(1)); L2.c.setAttribute('cy', y2.toFixed(1));
      L2.c.style.opacity = t > 0.95 ? 1 : 0;
      L2.g.style.opacity = 1;
    });
  }

  const pinST = addTrigger({ trigger: sec, start: 'top top', end: () => '+=' + Math.round(innerHeight * 0.25), pin: true, anticipatePin: 1, invalidateOnRefresh: true, refreshPriority: 2 });
  const tl = gsap.timeline({
    scrollTrigger: { trigger: sec, start: 'top 85%', end: () => pinST.end, scrub: 0.8, invalidateOnRefresh: true, refreshPriority: 1 },
  });
  tl.to(cam, { p: 1, ease: 'none', duration: 1 });
  triggers.push(tl.scrollTrigger);
  pose(0);
  stage.setCamera({ position: camPos.toArray(), target: camTgt.toArray() });
}

/* =========================================================
   IT SEES: pick up a bottle, hold it to the camera
   ========================================================= */
async function sees() {
  const lab = $('.lab');
  const host = $('.gl-sees');
  if (!lab || !host) return;
  gsap.getTweensOf(lab).forEach((t) => { if (t.scrollTrigger) t.scrollTrigger.kill(); t.kill(); });
  gsap.set(lab, { clearProps: 'transform,opacity' });
  lab.classList.remove('r3d');
  lab.classList.add('is-gl');
  $('#sees').classList.add('is-gl');
  const stage = makeStage(host, {
    quality: 'low', background: 'transparent', bloom: true, css3d: true, fov: 28,
    camera: [0, 1.4, 9], target: [0, 0.75, 0], timeOfDay: 18.1,
    fx: { grain: 0, vignette: 0, scanlines: 0, aberration: 0 },
  });
  const echo = N.createEchoShow({ size: 8, color: 'charcoal', shadow: true });
  stage.add(echo);
  echo.setRing('idle');
  const counter = makeCounter({ width: 40, depth: 8, fade: 0.02 });
  stage.scene.add(counter);

  const camEl = $('.lab-echo .e3-screen').cloneNode(true);
  camEl.classList.add('gl-screen');
  camEl.querySelectorAll('.e3-lightbar, .e3-spec').forEach((n) => n.remove());
  camEl.querySelectorAll('[role], [aria-live]').forEach((n) => { n.removeAttribute('role'); n.removeAttribute('aria-live'); });
  camEl.setAttribute('aria-hidden', 'true');
  echo.attachScreen(camEl, { pxWidth: 1280, pxHeight: 800, className: 'gl-screen-wrap' });

  const IDS = ['ibuprofen', 'atorvastatin', 'lisinopril', 'metformin'];
  const pills = IDS.map((id) => N.createPillBottle({ label: `/samples/pill-${id}.png`, id, pills: true, style: id === 'ibuprofen' ? 'otc' : 'rx' }));
  pills.forEach((p) => stage.add(p));
  await Promise.all(pills.map((p) => p.ready && p.ready.catch(() => null)));
  const byId = Object.fromEntries(pills.map((p) => [p.id, p]));

  // layout from the container's proportions: the Echo on the right, bottles on the left
  function layout() {
    const r = host.getBoundingClientRect();
    const upp = unitsPerPx(stage, 0);
    const S = clamp(Math.min((r.width * 0.34 * upp) / 2.0, (r.height * 0.62 * upp) / 1.36), 0.4, 3);
    const eb = worldAt(stage, r.left + r.width * 0.7, r.top + r.height * 0.84, 0);
    echo.group.scale.setScalar(S);
    echo.group.position.copy(eb);
    echo.group.rotation.y = -0.22;
    counter.position.set(0, eb.y, 0);
    pills.forEach((p, k) => {
      const pb = worldAt(stage, r.left + r.width * (0.1 + k * 0.095), r.top + r.height * 0.84, 0);
      p.group.scale.setScalar(S * 0.95);
      p.group.position.copy(pb);
      p.group.position.z = 0.6;
      p.group.rotation.y = 0.25 - k * 0.12;
      if (drag && drag.setHome) drag.setHome(p, p.group.position.toArray());
    });
  }

  // the scan: a ring of light that passes down the bottle while Nova reads it
  const beam = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.42, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(COL.nova).multiplyScalar(1.4), transparent: true, opacity: 0.22, toneMapped: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.012, 8, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(COL.nova).multiplyScalar(3), toneMapped: false }));
  disc.rotation.x = rim.rotation.x = -Math.PI / 2;
  beam.add(disc, rim);
  beam.visible = false;
  function scanBeam(pill) {
    pill.group.add(beam);
    beam.visible = true;
    beam.position.set(0, 1.0, 0);
    gsap.fromTo(beam.position, { y: 1.02 }, { y: 0.04, duration: 1.15, ease: 'power1.inOut', yoyo: true, repeat: 1, onComplete: () => { beam.visible = false; pill.group.remove(beam); } });
  }

  const zoneLabel = $('.lab-hint');
  const drag = N.enableDrag(stage, pills, {
    plane: 'screen', lift: 0.35, returnHome: true,
    targets: [{
      object: echo.cameraDot, radius: 150, present: true, holdMs: 2400,
      onEnter: (h) => { h.setHighlight && h.setHighlight(true); echo.setRing('listening'); },
      onLeave: (h) => { h.setHighlight && h.setHighlight(false); echo.setRing('idle'); },
      onDrop: (h) => { h.setHighlight && h.setHighlight(false); NOVA.scan(h.id); scanBeam(h); },
    }],
    onDragStart: () => { if (zoneLabel) zoneLabel.classList.add('is-armed'); },
    onDragEnd: () => { if (zoneLabel) zoneLabel.classList.remove('is-armed'); },
  });
  NOVA.onBottle = (kind) => { const p = byId[kind]; if (p) drag.drop(p, 0); };
  dragLabel(stage, host, () => pills);
  cleanups.push(() => { NOVA.onBottle = null; drag.dispose && drag.dispose(); });

  // a plain click on a bottle shows it too
  let down = null;
  host.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  host.addEventListener('click', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const hit = stage.pick(e.clientX, e.clientY, pills);
    if (hit && hit.handle && hit.handle.id) drag.drop(hit.handle, 0);
  });

  NOVA.scanBus.push((phase, kind) => {
    if (phase === 'scan') echo.setRing('thinking');
    else if (phase === 'verdict') echo.setRing(kind === 'metformin' ? 'success' : (kind === 'lisinopril' || kind === 'ibuprofen') ? 'urgent' : 'notify');
    else echo.setRing('idle');
  });

  stage.on('resize', layout);
  layout();
}

/* =========================================================
   UNDER THE HOOD: the Echo turns, its layers come apart
   ========================================================= */
async function build() {
  const sec = $('.build');
  const host = $('.gl-build');
  if (!sec || !host) return;
  sec.classList.add('is-gl', 'is-x');
  const stage = makeStage(host, {
    quality: 'low', crisp: true, background: 'transparent', bloom: false, css3d: false, fov: 30, pixelRatioCap: 2,
    camera: [0, 1.0, 11], target: [0, 0.75, 0], timeOfDay: 22,
    fx: { grain: 0, vignette: 0, scanlines: 0, aberration: 0 },
  });
  const echo = N.createEchoShow({ size: 8, color: 'charcoal', shadow: true });
  stage.add(echo);
  echo.setRing('speaking');
  // the screen as a high-resolution texture (HTML in a CSS3D layer rasterizes soft at this size and angle)
  const scr = $('.echo3d-xray .e3-screen');
  const txt = (sel) => ((scr && $(sel, scr)) ? $(sel, scr).textContent.trim() : '');
  const top = scr ? $$('.scr-top span', scr).map((s) => s.textContent.trim()) : [];
  const screenCanvas = document.createElement('canvas');
  screenCanvas.width = 2048; screenCanvas.height = 1280;
  drawHoodScreen(screenCanvas.getContext('2d'), 2048, 1280, {
    place: top[0] || 'Maya · Seattle', time: top[1] || '10:15 AM',
    kicker: txt('.xr-k') || 'Worth watching · Rose', title: txt('.xr-t') || 'Dizziness began after her lisinopril change.',
    evidence: txt('.xr-e') || '',
  });
  const screenTex = new THREE.CanvasTexture(screenCanvas);
  screenTex.anisotropy = 16;
  echo.setScreenImage(screenTex, { fit: 'stretch' });

  // the layers: glass sheets aligned with the display
  const anchor = echo.screenAnchor;
  const sw = (echo.screen && echo.screen.width) || 1.8, sh = (echo.screen && echo.screen.height) || 1.12;
  const DEF = [
    { name: 'Alexa+ agent', sub: 'Amazon Nova · Converse tool use', color: COL.nova, motif: 'ring' },
    { name: 'MCP', sub: 'Streamable HTTP · bearer token', color: COL.nova, motif: 'lines' },
    { name: 'Nova server', sub: '25 tools · care engine · insights · vision · Ring', color: COL.nova, motif: 'grid' },
    { name: 'Amazon Nova', sub: 'Amazon Bedrock · language + vision', color: COL.amber, motif: 'orb' },
  ];
  const stack = new THREE.Group();
  anchor.add(stack);
  const planes = DEF.map((d) => {
    const tex = canvasTexture(1024, 640, (ctx, w, h) => drawLayer(ctx, w, h, d));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(sw * 1.06, sh * 1.06), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    const edgeAnchor = new THREE.Object3D(); edgeAnchor.position.set(sw * 0.53, 0, 0); m.add(edgeAnchor);
    m.userData.edge = edgeAnchor;
    stack.add(m);
    return m;
  });
  const screenEdge = new THREE.Object3D(); screenEdge.position.set(sw * 0.5, 0, 0.01); anchor.add(screenEdge);
  const packet = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff').multiplyScalar(3), toneMapped: false }));
  packet.visible = false; stack.add(packet);

  const labels = $$('.layer', sec);
  const lines = $('.xray-lines', sec);
  const NS = 'http://www.w3.org/2000/svg';
  const paths = labels.map(() => { const p = document.createElementNS(NS, 'path'); lines.appendChild(p); return p; });
  const dots = labels.map(() => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '3'); lines.appendChild(c); return c; });
  gsap.set(labels, { opacity: 0, x: 30 });

  const st = { p: 0 };
  const GAP = 0.74; // layer spacing: tighter keeps the stack compact, so it can be drawn larger
  const v = new THREE.Vector3();
  let C = new THREE.Vector3(), SC = 1, labelRel = [];
  // one pose for a progress value: the camera swings from the front to the side, the layers come apart
  function pose(p) {
    const turn = smooth(clamp(p / 0.35, 0, 1));
    const spread = smooth(clamp((p - 0.25) / 0.4, 0, 1));
    const ang = lerp(0, 0.88, turn), dist = lerp(11, 12.8, turn);
    const tz = C.z - 2.2 * SC * spread;
    stage.setCamera({ position: [C.x + Math.sin(ang) * dist, C.y + lerp(1.0, 3.4, turn), tz + Math.cos(ang) * dist], target: [C.x - 0.6 * SC * turn, C.y + 0.7 * SC, tz] });
    planes.forEach((m, k) => {
      m.position.z = -(0.2 + (k + 1) * GAP * spread);
      m.material.opacity = clamp(spread * 1.6 - k * 0.12, 0, 1) * 0.95;
    });
    return spread;
  }
  // the 3D lives between the text column and the labels, 48px clear of both
  const head = $('.build-head', sec);
  const corners = [];
  const box = new THREE.Box3(), _solid = new THREE.Box3();
  function bounds() {
    stage.scene.updateMatrixWorld(true);
    corners.length = 0;
    // the Echo's solid parts only: its contact shadow and glow planes are wider than the device and would
    // shrink the whole stack
    box.makeEmpty();
    echo.group.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry) return;
      const m = o.material;
      if (m && m.transparent && m.depthWrite === false) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      _solid.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      box.union(_solid);
    });
    if (box.isEmpty()) box.setFromObject(echo.group);
    for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    planes.forEach((m) => {
      const g = m.geometry.parameters;
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => corners.push(m.localToWorld(new THREE.Vector3(sx * g.width / 2, sy * g.height / 2, 0))));
    });
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    corners.forEach((p) => { const q = stage.project(p); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); });
    return { x0, y0, x1, y1 };
  }
  function layout() {
    const r = host.getBoundingClientRect();
    const textEls = $$('.sec-head, h2, .build-lede, .build-nums', head).map((el) => el.getBoundingClientRect());
    const textRight = Math.max(...textEls.map((b) => b.right));
    const textLeft = Math.min(...textEls.map((b) => b.left));
    const textBottom = Math.max(...textEls.map((b) => b.bottom));
    const labelLeft = Math.min(...labels.map((l) => l.getBoundingClientRect().left - (+gsap.getProperty(l, 'x') || 0)));
    labelRel = labels.map((l) => { const b = l.getBoundingClientRect(); return { x: b.left - r.left - (+gsap.getProperty(l, 'x') || 0), y: b.top - r.top }; });
    // The 3D is big and sits partly behind the text (which keeps a soft dark fade, see site.css): it spans from
    // a third of the way into the text column to the labels. Narrow layouts fall back to beside or under.
    const beside = { x0: textRight + 32, x1: labelLeft - 32, y0: r.top + 96, y1: r.bottom - 40 - 40 };
    const under = { x0: textLeft, x1: labelLeft - 32, y0: textBottom + 40, y1: r.bottom - 40 - 40 };
    function fit(reg) {
      stage.camera.clearViewOffset();
      stage.setCamera({ position: [0, 1.0, 11], target: [0, 0.75, 0] });
      C = worldAt(stage, r.left + r.width * 0.5, r.top + r.height * 0.6, 0);
      SC = 1;
      echo.group.position.copy(C);
      for (let k = 0; k < 3; k++) {
        echo.group.scale.setScalar(SC);
        pose(1);
        const bb = bounds();
        const f = Math.min((reg.x1 - reg.x0) / (bb.x1 - bb.x0), (reg.y1 - reg.y0) / (bb.y1 - bb.y0));
        SC = clamp(SC * f, 0.2, 4);
      }
      return SC;
    }
    const behind = { x0: textLeft + (textRight - textLeft) * 0.32, x1: labelLeft - 32, y0: r.top + 80, y1: r.bottom - 40 - 32 };
    const ok = (g) => g.x1 - g.x0 > 200 && g.y1 - g.y0 > 200;
    let reg;
    if (ok(behind) && innerWidth >= 1180) reg = behind;
    else {
      const sBeside = ok(beside) ? fit(beside) : 0, sUnder = ok(under) ? fit(under) : 0;
      reg = sUnder > sBeside * 1.15 ? under : beside;
    }
    fit(reg);
    echo.group.scale.setScalar(SC);
    pose(1);
    const bb = bounds();
    const dx = (reg.x0 + reg.x1) / 2 - (bb.x0 + bb.x1) / 2, dy = (reg.y0 + reg.y1) / 2 - (bb.y0 + bb.y1) / 2;
    stage.camera.setViewOffset(r.width, r.height, -dx, -dy, r.width, r.height);
    stage.camera.updateProjectionMatrix();
    pose(st.p);
  }
  stage.onFrame((dt, el) => {
    const spread = pose(st.p);
    // a request travels through the stack and back
    if (spread > 0.95) {
      packet.visible = true;
      const t = (el * 0.45) % 2, f = t < 1 ? t : 2 - t;
      packet.position.set(0, 0, -(0.2 + 4 * GAP) * smooth(f));
    } else packet.visible = false;
    // leader lines run right, to the labels only
    stage.camera.updateMatrixWorld();
    labels.forEach((l, i) => {
      const op = +gsap.getProperty(l, 'opacity');
      if (op < 0.02 || !labelRel[i]) { if (paths[i].__op !== 0) { paths[i].style.opacity = 0; dots[i].style.opacity = 0; paths[i].__op = 0; } return; }
      paths[i].__op = op;
      (i === 0 ? screenEdge : planes[i - 1].userData.edge).getWorldPosition(v);
      const a = projLocal(stage, v);
      const x1 = a.x, y1 = a.y, x2 = labelRel[i].x + (+gsap.getProperty(l, 'x') || 0) - 14, y2 = labelRel[i].y + 26;
      const kx = x2 - Math.max(24, (x2 - x1) * 0.3);
      paths[i].setAttribute('d', `M${x1.toFixed(1)},${y1.toFixed(1)} L${kx.toFixed(1)},${y2.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}`);
      paths[i].style.opacity = op; dots[i].setAttribute('cx', x1.toFixed(1)); dots[i].setAttribute('cy', y1.toFixed(1)); dots[i].style.opacity = op;
    });
  });

  const pinST = addTrigger({ trigger: sec, start: 'top top', end: () => '+=' + Math.round(innerHeight * 0.15), pin: '.build-pin', anticipatePin: 1, invalidateOnRefresh: true, refreshPriority: 1 });
  const tl = gsap.timeline({
    scrollTrigger: { trigger: sec, start: 'top 75%', end: () => pinST.end, scrub: 0.8, invalidateOnRefresh: true, refreshPriority: 0 },
  });
  tl.to(st, { p: 1, duration: 1, ease: 'none' }, 0);
  labels.forEach((l, i) => tl.to(l, { opacity: 1, x: 0, duration: 0.08, ease: 'power2.out' }, 0.5 + i * 0.06));
  triggers.push(tl.scrollTrigger);
  stage.on('resize', layout);
  layout();
  if (document.fonts) document.fonts.ready.then(layout);
}

function drawHoodScreen(ctx, w, h, d) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#1B1A33'); g.addColorStop(0.55, '#121524'); g.addColorStop(1, '#0B1A26');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.15, h * 1.05, 0, w * 0.15, h * 1.05, w * 0.7);
  glow.addColorStop(0, 'rgba(59,209,255,.22)'); glow.addColorStop(1, 'rgba(59,209,255,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(244,238,230,.75)';
  ctx.font = '500 52px Inter, system-ui, sans-serif';
  ctx.fillText(d.place, 110, 150);
  ctx.textAlign = 'right'; ctx.fillText(d.time, w - 110, 150); ctx.textAlign = 'left';
  ctx.fillStyle = '#FFB547';
  ctx.font = '600 44px "JetBrains Mono", monospace';
  spaced(ctx, d.kicker.toUpperCase(), 112, 470, 6);
  ctx.fillStyle = '#F4EEE6';
  ctx.font = '400 150px "Instrument Serif", Georgia, serif';
  const words = d.title.split(' ');
  let line = '', y = 650;
  for (const wd of words) {
    const test = line ? line + ' ' + wd : wd;
    if (ctx.measureText(test).width > w - 240 && line) { ctx.fillText(line, 110, y); line = wd; y += 160; }
    else line = test;
  }
  if (line) ctx.fillText(line, 110, y);
  if (d.evidence) {
    ctx.fillStyle = 'rgba(244,238,230,.78)';
    ctx.font = '500 46px "JetBrains Mono", monospace';
    spaced(ctx, d.evidence.toUpperCase(), 112, y + 130, 3);
  }
}

function drawLayer(ctx, w, h, d) {
  const c = d.color;
  ctx.clearRect(0, 0, w, h);
  roundRect(ctx, 6, 6, w - 12, h - 12, 26);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, hexA(c, 0.16)); g.addColorStop(0.6, hexA(c, 0.04)); g.addColorStop(1, hexA(c, 0.1));
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = hexA(c, 0.75); ctx.stroke();
  ctx.save();
  ctx.strokeStyle = hexA(c, 0.5); ctx.fillStyle = hexA(c, 0.75);
  if (d.motif === 'ring') { ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(w / 2, h * 0.4, h * 0.2, 0, Math.PI * 2); ctx.stroke(); }
  if (d.motif === 'lines') { ctx.lineWidth = 2; for (let y = 70; y < h * 0.66; y += 34) { ctx.beginPath(); ctx.moveTo(80, y); ctx.lineTo(w - 80, y); ctx.stroke(); } }
  if (d.motif === 'grid') { for (let r = 0; r < 3; r++) for (let k = 0; k < 7; k++) { ctx.beginPath(); ctx.arc(170 + k * 114, 110 + r * 80, 9, 0, Math.PI * 2); ctx.fill(); } }
  if (d.motif === 'orb') { const o = ctx.createRadialGradient(w / 2, h * 0.38, 0, w / 2, h * 0.38, h * 0.32); o.addColorStop(0, hexA(c, 0.7)); o.addColorStop(1, hexA(c, 0)); ctx.fillStyle = o; ctx.fillRect(0, 0, w, h); }
  ctx.restore();
  // big, high-contrast type: these planes are small on screen and seen at an angle
  ctx.fillStyle = '#FFFFFF';
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 10;
  ctx.font = '400 128px "Instrument Serif"';
  ctx.fillText(d.name, 60, h - 120);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(244,238,230,.9)';
  ctx.font = '600 30px "JetBrains Mono"';
  spaced(ctx, d.sub.split(' · ')[0].toUpperCase(), 64, h - 62, 3);
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* =========================================================
   CTA: the logo loop
   ========================================================= */
async function cta() {
  const host = $('.gl-cta');
  if (!host) return;
  $('.cta').classList.add('is-gl');
  const stage = makeStage(host, {
    quality: 'low', background: 'transparent', bloom: false, css3d: false, fov: 30, pixelRatioCap: 1.25,
    camera: [0, 0, 12], target: [0, 0, 0], timeOfDay: 22,
    fx: { grain: 0, vignette: 0, scanlines: 0, aberration: 0 },
  });
  const logo = N.createNovaLogo({ finish: 'iridescent', core: 'star', size: 0.85, spin: 0.5, glow: true });
  stage.scene.environmentIntensity = 1.25;
  stage.add(logo);
  if (logo.ready) await logo.ready.catch(() => null);
  logo.group.position.set(0, 2.3, -2.5);
  if (N.enableOrbit) N.enableOrbit(stage, logo, { maxYaw: 1.2, maxPitch: 0.45, springBack: true, hover: true, anywhere: true });
  dragLabel(stage, host, () => [logo]);
  const s = { k: 0.55 };
  const apply = () => logo.group.scale.setScalar(s.k);
  apply();
  const tl = gsap.timeline({ scrollTrigger: { trigger: '.cta', start: 'top bottom', end: 'top top', scrub: 1 } });
  tl.to(s, { k: 1, ease: 'none', onUpdate: apply });
  triggers.push(tl.scrollTrigger);
}
