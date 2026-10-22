/* Nova · landing page interactions
   GSAP + ScrollTrigger + Draggable/Inertia + Lenis. Content is readable without any of it. */
(function () {
  'use strict';
  window.__novaBooted = true;

  var doc = document.documentElement;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var mq = function (q) { try { return window.matchMedia(q).matches; } catch (e) { return false; } };

  var REDUCED = doc.classList.contains('reduced');
  var FINE = mq('(hover: hover) and (pointer: fine)');
  var gsap = window.gsap;
  var ST = window.ScrollTrigger;
  var HAS_DRAG = !!(gsap && window.Draggable);
  var NOVA = window.__nova = window.__nova || { heroBus: [], scanBus: [] };

  /* ---------- Columbus clock (works with or without GSAP) ---------- */
  function startClock() {
    var els = $$('[data-clock]');
    if (!els.length) return;
    var fmt;
    try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }); } catch (e) { fmt = null; }
    var tick = function () {
      var t = fmt ? fmt.format(new Date()) : new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      els.forEach(function (el) { el.textContent = t; });
    };
    tick();
    setInterval(tick, 15000);
  }

  /* ---------- small UI bits that work without GSAP ---------- */
  function initPlainUI() {
    $$('[data-consent]').forEach(function (b) {
      b.addEventListener('click', function () {
        var out = b.parentNode.querySelector('.mc-out');
        var yes = b.getAttribute('data-consent') === 'yes';
        if (out) out.textContent = yes ? "I've let Maya and Leo know." : "I'll keep it between us for now.";
        b.parentNode.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      });
    });
    $$('[data-approve]').forEach(function (b) {
      b.addEventListener('click', function () {
        b.classList.add('is-done');
        b.textContent = 'Approved';
        var rc = b.closest('.recon');
        if (rc) { rc.classList.remove('is-discarded'); rc.classList.add('is-approved'); }
        var hint = b.parentNode.querySelector('span.mono');
        if (hint && !rc) hint.textContent = "Rose's plan is updated. She hears what changed.";
      });
    });
    $$('[data-discard]').forEach(function (b) {
      b.addEventListener('click', function () {
        var rc = b.closest('.recon');
        if (!rc || rc.classList.contains('is-approved')) return;
        rc.classList.add('is-discarded');
        var after = $('.rc-after', rc);
        if (after) after.innerHTML = '<span class="mono">Nova</span>&#8220;Okay, I discarded those changes. The plan is unchanged.&#8221;';
      });
    });
  }

  startClock();
  initPlainUI();

  if (!gsap || !ST) {
    // CDN failed: plain, fully readable page.
    doc.classList.remove('js');
    doc.classList.add('no-js');
    initHeroCycle();
    return;
  }

  var plugins = [ST];
  if (window.Draggable) plugins.push(window.Draggable);
  if (window.InertiaPlugin) plugins.push(window.InertiaPlugin);
  gsap.registerPlugin.apply(gsap, plugins);
  doc.classList.add(HAS_DRAG ? 'has-drag' : 'no-drag');
  if (!FINE) doc.classList.add('no-drag-hint');

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  /* ---------- Lenis smooth scroll ---------- */
  var lenis = null;
  if (!REDUCED && window.Lenis) {
    lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true, wheelMultiplier: 0.95 });
    lenis.on('scroll', ST.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
    window.__lenis = lenis;
  }
  function scrollNow() { return lenis ? lenis.scroll : window.scrollY; }
  function scrollToY(y, immediate) {
    if (lenis) lenis.scrollTo(y, { immediate: !!immediate, force: true, duration: immediate ? 0 : 1.4 });
    else window.scrollTo(0, y);
  }

  // anchor links through Lenis
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href');
      if (id.length < 2) return;
      var t = $(id);
      if (!t) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(t, { duration: 1.6 });
      else t.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
      if (id === '#top' || id === '#main') { var f = $(id === '#main' ? '#main' : '.nav-logo'); if (f) f.focus({ preventScroll: true }); }
    });
  });

  /* =========================================================
     ECHO SHOW 3D OBJECT
     ========================================================= */
  var LIGHT = (function () { var v = [-0.5, -0.72, 0.6], l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; })();
  var D2R = Math.PI / 180;

  function Echo3D(root, opts) {
    opts = opts || {};
    this.root = root;
    this.obj = $('.e3-obj', root);
    this.spec = $('.e3-spec', root);
    this.faces = {
      left: { el: $('.e3-left', root), n: [-1, 0, 0] },
      right: { el: $('.e3-right', root), n: [1, 0, 0] },
      top: { el: $('.e3-top', root), n: [0, -1, 0] },
      bottom: { el: $('.e3-bottom', root), n: [0, 1, 0] },
      back: { el: $('.e3-back', root), n: [0, -0.416, -0.909] }
    };
    this.base = { rx: opts.rx || 0, ry: opts.ry || 0 };
    this.tilt = { rx: 0, ry: 0 };
    this.tiltT = { rx: 0, ry: 0 };
    this.drag = { rx: 0, ry: 0 };
    this.render();
  }
  Echo3D.prototype.angles = function () {
    return { rx: this.base.rx + this.tilt.rx + this.drag.rx, ry: this.base.ry + this.tilt.ry + this.drag.ry };
  };
  Echo3D.prototype.render = function () {
    var a = this.angles();
    this.obj.style.transform = 'rotateX(' + a.rx.toFixed(3) + 'deg) rotateY(' + a.ry.toFixed(3) + 'deg)';
    shade(this.faces, a.rx, a.ry);
    if (this.spec) this.spec.style.setProperty('--spec', clamp(-wrapDeg(a.ry) * 0.55 + a.rx * 0.25, -28, 28).toFixed(2) + '%');
  };
  Echo3D.prototype.step = function () {
    this.tilt.rx = lerp(this.tilt.rx, this.tiltT.rx, 0.08);
    this.tilt.ry = lerp(this.tilt.ry, this.tiltT.ry, 0.08);
    this.render();
  };
  function wrapDeg(d) { d = ((d + 180) % 360 + 360) % 360 - 180; return d; }
  function shade(faces, rxDeg, ryDeg) {
    var rx = rxDeg * D2R, ry = ryDeg * D2R, cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
    for (var k in faces) {
      var f = faces[k];
      if (!f.el) continue;
      var n = f.n;
      var x = n[0] * cy + n[2] * sy, y = n[1], z = -n[0] * sy + n[2] * cy;
      var y2 = y * cx - z * sx, z2 = y * sx + z * cx;
      var dot = x * LIGHT[0] + y2 * LIGHT[1] + z2 * LIGHT[2];
      var lit = 0.14 + 0.86 * Math.max(0, dot);
      f.el.style.setProperty('--lit', lit.toFixed(3));
    }
  }

  /* ---------- Hero screen cycle ---------- */
  function initHeroCycle() {
    var hero = $('.hero');
    if (!hero) return;
    var states = $$('.hs-list b');
    var script = [
      { scene: 'idle', state: 'idle', time: '5:59 PM', dur: 2600 },
      { scene: 'remind', state: 'speaking', time: '6:00 PM', dur: 5600 },
      { scene: 'listen', state: 'listening', time: '6:00 PM', dur: 2600 },
      { scene: 'think', state: 'thinking', time: '6:00 PM', dur: 1500 },
      { scene: 'reply', state: 'speaking', time: '6:00 PM', dur: 3000 },
      { scene: 'message', state: 'notify', time: '6:04 PM', dur: 5000 }
    ];
    var i = 0, timer = null, running = false;
    function show(k) {
      var s = script[k];
      $$('[data-hero-screen] .scr-scene').forEach(function (el) { el.classList.toggle('is-on', el.getAttribute('data-scene') === s.scene); });
      $$('[data-echo-hero] .echo3d').forEach(function (r) { r.setAttribute('data-state', s.state); });
      $$('[data-echo-time]').forEach(function (el) { el.textContent = s.time; });
      states.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-s') === s.state); });
      NOVA.heroState = s;
      NOVA.heroBus.forEach(function (fn) { try { fn(s); } catch (e) {} });
    }
    function next() {
      show(i);
      timer = setTimeout(function () { i = (i + 1) % script.length; next(); }, script[i].dur * (REDUCED ? 1.6 : 1));
    }
    function start() { if (running) return; running = true; next(); }
    function stop() { running = false; clearTimeout(timer); }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { e.isIntersecting ? start() : stop(); }); }, { threshold: 0.02 }).observe(hero);
    } else start();
  }

  /* =========================================================
     BOOT
     ========================================================= */
  var heroEcho = null, seesEcho = null;
  var heroRoot = $('[data-echo-hero] .echo3d');
  if (heroRoot) heroEcho = new Echo3D(heroRoot, { rx: 6, ry: -18 });
  var seesRoot = $('.echo3d-sees');
  if (seesRoot) seesEcho = new Echo3D(seesRoot, { rx: 4, ry: 14 });

  var GL = function () { return doc.classList.contains('gl'); };
  initHeroCycle();
  initCursor();
  initMagnetic();
  initNav();
  initMarquee();
  initHeroInteractions();
  initSees();
  initAVS();
  initTrace();

  var mm;
  function setupMM() {
    mm = gsap.matchMedia();
    mm.add({
      big: '(min-width: 900px) and (min-height: 560px)',
      reduce: '(prefers-reduced-motion: reduce)'
    }, function (ctx) {
      var c = ctx.conditions;
      var cleanups = [];
      if (!c.reduce) {
        initReveals();
        initProblem();
        if (c.big && !GL()) {
          cleanups.push(initDay());
          cleanups.push(initDots());
          cleanups.push(initBuild());
        } else if (!c.big) {
          initDayMobile();
        }
      } else {
        initReducedFades();
      }
      return function () { cleanups.forEach(function (f) { if (typeof f === 'function') f(); }); };
    });
  }
  setupMM();

  // The WebGL layer calls this if it cannot run: every section goes back to its DOM version.
  NOVA.flat = function () {
    if (!GL()) return;
    doc.classList.remove('gl');
    doc.classList.add('gl-failed');
    document.dispatchEvent(new CustomEvent('nova:gl-hero'));
    mm.revert();
    setupMM();
    gsap.set('.hero-device', { opacity: 1 });
    ST.sort();
    ST.refresh();
  };
  NOVA.gsap = gsap; NOVA.ST = ST; NOVA.lenis = lenis;
  NOVA.scrollToY = function (y, imm) { scrollToY(y, imm); };
  NOVA.scrollNow = function () { return scrollNow(); };
  NOVA.reduced = REDUCED; NOVA.fine = FINE;

  // Preloader and hero reveal are CSS animations that start at first paint (see site.css).
  // Here we only line up the extras with them: the 3D tilt of the CSS Echo, the intro event, Lenis.
  var REVEAL_AT = 1550, DONE_AT = 2100;
  var fontsReady = (document.fonts && document.fonts.ready) ? Promise.race([document.fonts.ready, new Promise(function (r) { setTimeout(r, 1400); })]) : Promise.resolve();
  function withPaintTime(cb) {
    // CSS animations start with the first rendered frame: use the paint entry, or the next frame if there is none yet
    try { var p = performance.getEntriesByType('paint'); if (p && p.length) { cb(p[0].startTime); return; } } catch (e) {}
    requestAnimationFrame(function (t) { cb(t); });
  }
  if (REDUCED) {
    var pl = $('.preloader'); if (pl) pl.remove();
    fontsReady.then(function () { ST.refresh(); });
  } else {
    if (lenis) lenis.stop();
    withPaintTime(function (t0) {
      var since = performance.now() - t0;
      setTimeout(function () { heroIntro(); }, Math.max(0, REVEAL_AT - since));
      setTimeout(function () {
        var pl = $('.preloader'); if (pl) pl.remove();
        NOVA.preloaderDoneAt = performance.now();
        if (lenis) lenis.start();
        ST.refresh();
      }, Math.max(0, DONE_AT - since));
    });
    fontsReady.then(function () { ST.refresh(); });
  }

  function heroIntro() {
    NOVA.introAt = performance.now();
    document.dispatchEvent(new CustomEvent('nova:intro'));
    var tl = gsap.timeline();
    if (heroEcho) {
      var b = heroEcho.base;
      tl.fromTo(b, { rx: 22, ry: -62 }, { rx: 6, ry: -18, duration: 2.1, ease: 'expo.out', onUpdate: function () { heroEcho.render(); } }, 0.1);
      tl.from('[data-echo-hero]', { y: 90, scale: 0.92, duration: 1.8, ease: 'expo.out' }, 0.1);
    }
    return tl;
  }

  /* =========================================================
     CURSOR + MAGNETIC
     ========================================================= */
  function initCursor() {
    if (!FINE || REDUCED) return;
    var c = $('.cursor');
    if (!c) return;
    doc.classList.add('has-cursor');
    var dot = $('.cursor-dot', c), ring = $('.cursor-ring', c), label = $('.cursor-label', c);
    var x = innerWidth / 2, y = innerHeight / 2, rx = x, ry = y;
    var dx = gsap.quickSetter(dot, 'x', 'px'), dy = gsap.quickSetter(dot, 'y', 'px');
    var gx = gsap.quickSetter(ring, 'x', 'px'), gy = gsap.quickSetter(ring, 'y', 'px');
    addEventListener('pointermove', function (e) { x = e.clientX; y = e.clientY; dx(x); dy(y); c.classList.remove('is-hidden'); }, { passive: true });
    document.addEventListener('pointerleave', function () { c.classList.add('is-hidden'); });
    addEventListener('pointerdown', function () { c.classList.add('is-down'); });
    addEventListener('pointerup', function () { c.classList.remove('is-down'); });
    gsap.ticker.add(function () { rx = lerp(rx, x, 0.2); ry = lerp(ry, y, 0.2); gx(rx); gy(ry); });
    var forced = null;
    NOVA.cursorLabel = function (t) {
      forced = t || null;
      c.classList.toggle('is-hover', !!forced);
      if (forced) label.textContent = forced;
    };
    document.addEventListener('pointerover', function (e) {
      if (forced) return;
      var t = e.target.closest('[data-cursor]');
      var l = !t && e.target.closest('a, button');
      c.classList.toggle('is-hover', !!t);
      c.classList.toggle('is-link', !!l);
      label.textContent = t ? t.getAttribute('data-cursor') : '';
    });
  }

  function initMagnetic() {
    if (!FINE || REDUCED) return;
    $$('.magnetic').forEach(function (el) {
      var lab = $('.btn-label', el);
      var xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'power3.out' });
      var yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'power3.out' });
      var lxTo = lab ? gsap.quickTo(lab, 'x', { duration: 0.6, ease: 'power3.out' }) : null;
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var mx = e.clientX - (r.left + r.width / 2), my = e.clientY - (r.top + r.height / 2);
        xTo(mx * 0.32); yTo(my * 0.42);
        if (lxTo) lxTo(mx * 0.12);
        el.style.setProperty('--fx', (e.clientX - r.left) + 'px');
        el.style.setProperty('--fy', (e.clientY - r.top) + 'px');
      });
      el.addEventListener('pointerleave', function () {
        gsap.to(el, { x: 0, y: 0, duration: 1.1, ease: 'elastic.out(1, 0.35)' });
        if (lab) gsap.to(lab, { x: 0, duration: 1.1, ease: 'elastic.out(1, 0.35)' });
      });
    });
  }

  /* ---------- Nav: theme follows the section under it; hides on scroll down ---------- */
  function initNav() {
    var nav = $('.nav');
    if (!nav) return;
    $$('[data-theme]').forEach(function (sec) {
      if (sec === nav || sec.classList.contains('day')) return;
      ST.create({
        trigger: sec, start: 'top 40px', end: 'bottom 40px',
        onToggle: function (self) { if (self.isActive) nav.setAttribute('data-theme', sec.getAttribute('data-theme')); }
      });
    });
    var last = 0;
    ST.create({
      start: 0, end: 'max',
      onUpdate: function (self) {
        var y = self.scroll();
        if (y > innerHeight * 0.9 && self.direction === 1 && y - last > 4) nav.classList.add('is-hidden');
        else if (self.direction === -1 || y < innerHeight * 0.9) nav.classList.remove('is-hidden');
        last = y;
      }
    });
  }

  /* ---------- Marquee: drifts, speeds up with scroll velocity, flips with direction ---------- */
  function initMarquee() {
    var rows = $$('.mq-row');
    if (!rows.length || REDUCED) return;
    var dir = 1, boost = 0;
    var items = rows.map(function (row, i) {
      var track = $('.mq-track', row);
      track.innerHTML += track.innerHTML; // seamless loop
      return { track: track, x: 0, speed: i === 0 ? 0.55 : -0.42, set: gsap.quickSetter(track, 'x', 'px'), half: 0 };
    });
    function measure() { items.forEach(function (it) { it.half = it.track.scrollWidth / 2; }); }
    measure();
    addEventListener('resize', measure);
    if (document.fonts) document.fonts.ready.then(measure);
    var visible = true;
    ST.create({ trigger: '.marquee', start: 'top bottom', end: 'bottom top', onToggle: function (s) { visible = s.isActive; },
      onUpdate: function (s) { var v = s.getVelocity(); dir = v < 0 ? -1 : 1; boost = clamp(Math.abs(v) / 300, 0, 9); } });
    gsap.ticker.add(function (t, dt) {
      if (!visible) return;
      boost *= 0.94;
      var k = (dt / 16.67);
      items.forEach(function (it) {
        it.x -= it.speed * (1 + boost) * dir * k;
        if (it.half) { if (it.x <= -it.half) it.x += it.half; if (it.x > 0) it.x -= it.half; }
        it.set(it.x);
      });
    });
  }

  /* =========================================================
     HERO: tilt toward the cursor, drag to orbit, scroll exit
     ========================================================= */
  var heroInteractionsDone = false;
  function initHeroInteractions() {
    var stage = $('[data-echo-hero]');
    if (!stage || !heroEcho || heroInteractionsDone) return;
    heroInteractionsDone = true;
    var inView = true;
    ST.create({ trigger: '.hero', start: 'top bottom', end: 'bottom top', onToggle: function (s) { inView = s.isActive; } });
    if (FINE && !REDUCED) {
      addEventListener('pointermove', function (e) {
        if (!inView) return;
        heroEcho.tiltT.ry = (e.clientX / innerWidth - 0.5) * 9;
        heroEcho.tiltT.rx = -(e.clientY / innerHeight - 0.5) * 7;
      }, { passive: true });
    }
    if (seesEcho && FINE && !REDUCED) {
      var lab = $('.lab');
      lab.addEventListener('pointermove', function (e) {
        var r = lab.getBoundingClientRect();
        seesEcho.tiltT.ry = ((e.clientX - r.left) / r.width - 0.5) * 10;
        seesEcho.tiltT.rx = -((e.clientY - r.top) / r.height - 0.5) * 7;
      });
      lab.addEventListener('pointerleave', function () { seesEcho.tiltT.rx = 0; seesEcho.tiltT.ry = 0; });
    }
    gsap.ticker.add(function () {
      if (inView) heroEcho.step();
      if (seesEcho) seesEcho.step();
    });

    // drag to orbit, with inertia, settling back to the front
    if (HAS_DRAG) {
      var K = 0.3, STEP = 360 / K;
      var proxy = document.createElement('div');
      var hint = $('.drag-hint');
      window.Draggable.create(proxy, {
        trigger: stage, type: FINE ? 'x,y' : 'x', inertia: !!window.InertiaPlugin,
        allowNativeTouchScrolling: true, minimumMovement: 3,
        snap: { x: function (v) { return Math.round(v / STEP) * STEP; }, y: function () { return 0; } },
        onPress: function () { stage.classList.add('is-grab'); if (hint) gsap.to(hint, { opacity: 0, duration: 0.4 }); },
        onRelease: function () {
          stage.classList.remove('is-grab');
          if (!window.InertiaPlugin) springBack(this);
        },
        onDrag: upd, onThrowUpdate: upd,
        onThrowComplete: function () { springBack(this); }
      });
      function upd() {
        heroEcho.drag.ry = this.x * K;
        heroEcho.drag.rx = clamp(-this.y * 0.22, -32, 32);
      }
      function springBack(d) {
        var target = Math.round(d.x / STEP) * STEP;
        gsap.to(proxy, {
          x: target, y: 0, duration: 1.4, ease: 'elastic.out(1, 0.45)',
          onUpdate: function () { d.update(); upd.call(d); },
          onComplete: function () { gsap.set(proxy, { x: 0 }); d.update(); heroEcho.drag.ry = 0; }
        });
      }
    }

    if (!REDUCED) {
      gsap.to('.hero-copy', { yPercent: -22, opacity: 0.2, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to('.hero-device', { y: -60, rotationX: 10, scale: 0.94, transformPerspective: 1400, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
    }
  }

  /* =========================================================
     REVEALS (3D entrances)
     ========================================================= */
  function initReveals() {
    // section titles: masked line reveal
    $$('.sec-title, .sec-title-s, .cta-title, .avs-title, .pk-big').forEach(function (t) {
      var lines = $$('.line-in', t);
      if (lines.length) {
        gsap.from(lines, { yPercent: 115, duration: 1.2, ease: 'expo.out', stagger: 0.08, scrollTrigger: { trigger: t, start: 'top 88%' } });
      }
    });
    // blocks: arrive from depth with a slight rotateX
    $$('.r3d').forEach(function (el) {
      gsap.fromTo(el, { rotationX: 16, z: -160, y: 90, opacity: 0, transformPerspective: 1200, transformOrigin: '50% 0%' }, {
        rotationX: 0, z: 0, y: 0, opacity: 1, ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 98%', end: 'top 62%', scrub: 0.8 }
      });
    });
    // whole sections tilt back as the next one arrives
    [['.hero-grid', '.hero'], ['.problem > .wrap', '.problem'], ['.principles > .wrap', '.principles']].forEach(function (p) {
      var el = $(p[0]);
      if (!el) return;
      gsap.to(el, { rotationX: -6, scale: 0.96, transformPerspective: 1600, transformOrigin: '50% 100%', ease: 'none',
        scrollTrigger: { trigger: p[1], start: 'bottom 85%', end: 'bottom top', scrub: true } });
    });
    // CTA ring blooms in
    gsap.from('.cta-ring', { scale: 0.6, opacity: 0, rotation: -40, ease: 'power2.out', scrollTrigger: { trigger: '.cta', start: 'top 85%', end: 'top 20%', scrub: 1 } });
    gsap.from('.cta-lede, .cta-actions, .cta .eyebrow', { y: 40, opacity: 0, duration: 1, ease: 'expo.out', stagger: 0.1, scrollTrigger: { trigger: '.cta-title', start: 'top 80%' } });
    // counters
    $$('[data-count]').forEach(function (el) {
      var end = +el.getAttribute('data-count');
      if (end < 5) return;
      var o = { v: 0 };
      ST.create({ trigger: el, start: 'top 90%', once: true, onEnter: function () {
        gsap.to(o, { v: end, duration: 2, ease: 'expo.out', onUpdate: function () { el.textContent = Math.round(o.v); } });
      } });
    });
  }

  function initReducedFades() {
    $$('.r3d, .moment, .insight, .pr, .num').forEach(function (el) {
      gsap.from(el, { opacity: 0, duration: 0.8, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 92%' } });
    });
  }

  /* ---------- 01 Problem ---------- */
  function initProblem() {
    var people = $$('.stat-people i');
    if (people.length) {
      gsap.from(people, { scale: 0, opacity: 0, duration: 0.8, ease: 'back.out(2)', stagger: 0.14, scrollTrigger: { trigger: '.stat-people', start: 'top 88%' } });
    }
    $$('.sig').forEach(function (s) {
      var sp = parseFloat(s.getAttribute('data-speed') || '1');
      gsap.fromTo(s, { y: 140 * sp, rotationY: (sp - 1) * 30 }, { y: -140 * sp, rotationY: 0, transformPerspective: 900, ease: 'none',
        scrollTrigger: { trigger: '.scatter', start: 'top bottom', end: 'bottom top', scrub: true } });
    });
  }

  /* =========================================================
     02 A DAY WITH NOVA: pinned horizontal timeline + living sky
     ========================================================= */
  function initDay() {
    var sec = $('.day');
    if (!sec) return;
    sec.classList.add('is-h');
    var track = $('.day-track', sec), view = $('.day-viewport', sec);
    var moments = $$('.moment', track);
    var skies = $$('.sky', sec);
    var stars = $('.stars', sec);
    var handle = $('.day-handle', sec);
    var clockEl = $('[data-day-clock]', sec);
    var bar = $('.day-progress i', sec);
    var nav = $('.nav');
    var arc = $('.sky-arc', sec);
    buildStars(stars);

    var centers = [], hours = [];
    function measure() {
      centers = moments.map(function (m) { return m.offsetLeft + m.offsetWidth / 2; });
      hours = moments.map(function (m) { return parseFloat(m.getAttribute('data-hour')); });
    }
    function dist() { return Math.max(0, track.scrollWidth - innerWidth); }

    var tween, st;

    function hourAt(p) {
      var c = p * dist() + innerWidth / 2;
      if (c <= centers[0]) return hours[0];
      for (var i = 1; i < centers.length; i++) {
        if (c <= centers[i]) return lerp(hours[i - 1], hours[i], (c - centers[i - 1]) / (centers[i] - centers[i - 1]));
      }
      return hours[hours.length - 1];
    }
    function progressFor(h) {
      h = clamp(h, hours[0], hours[hours.length - 1]);
      var c = centers[0];
      for (var i = 1; i < hours.length; i++) {
        if (h <= hours[i]) { c = lerp(centers[i - 1], centers[i], (h - hours[i - 1]) / ((hours[i] - hours[i - 1]) || 1)); break; }
        c = centers[i];
      }
      return clamp((c - innerWidth / 2) / (dist() || 1), 0, 1);
    }
    // hour -> sky layer position: 0 dawn, 1 day, 2 golden, 3 dusk, 4 night
    var SKY = [[7.6, 0], [8.25, 0], [9.3, 1], [15.9, 1], [17.7, 2], [19.1, 3], [20.6, 4]];
    function skyPos(h) {
      if (h <= SKY[0][0]) return 0;
      for (var i = 1; i < SKY.length; i++) if (h <= SKY[i][0]) return lerp(SKY[i - 1][1], SKY[i][1], (h - SKY[i - 1][0]) / (SKY[i][0] - SKY[i - 1][0]));
      return 4;
    }
    var SIL = [[36, 31, 56], [86, 102, 130], [46, 32, 56], [21, 19, 42], [10, 11, 18]];
    function silMix(A, B, t) { return 'rgb(' + Math.round(lerp(A[0], B[0], t)) + ',' + Math.round(lerp(A[1], B[1], t)) + ',' + Math.round(lerp(A[2], B[2], t)) + ')'; }
    function silAt(f) {
      var i = Math.min(3, Math.floor(f)), t = f - i, A = SIL[i], B = SIL[Math.min(4, i + 1)];
      return 'rgb(' + Math.round(lerp(A[0], B[0], t)) + ',' + Math.round(lerp(A[1], B[1], t)) + ',' + Math.round(lerp(A[2], B[2], t)) + ')';
    }
    function fmt(h) {
      var m = Math.round(h * 60), hh = Math.floor(m / 60) % 24, mm = m % 60;
      var ap = hh < 12 ? 'AM' : 'PM', h12 = hh % 12 || 12;
      return h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ap;
    }
    var lastFg = '';
    function syncNav() { if (nav) nav.setAttribute('data-theme', lastFg === 'dark' ? 'light' : 'dark'); }
    function update() {
      if (!centers.length) measure();
      var p = st ? st.progress : 0;
      var h = hourAt(p);
      var f, wrapT = -1;
      if (h > 21.2) {
        // overnight into Friday: night fades straight into dawn
        wrapT = clamp((h - 29.4) / 2.0, 0, 1);
        f = 4;
        skies.forEach(function (s, i) { s.style.opacity = i === 0 ? 1 : (i === 4 ? (1 - wrapT).toFixed(3) : 0); });
        sec.style.setProperty('--sil', silMix(SIL[4], SIL[0], wrapT));
        stars.style.opacity = (1 - wrapT).toFixed(3);
      } else {
        f = skyPos(h);
        var base = Math.floor(f), frac = f - base;
        skies.forEach(function (s, i) { s.style.opacity = i <= base ? 1 : (i === base + 1 ? frac.toFixed(3) : 0); });
        sec.style.setProperty('--sil', silAt(f));
        stars.style.opacity = clamp((f - 2.7) / 1.3, 0, 1).toFixed(3);
      }
      var sh = h >= 24 ? h - 24 : h;
      var lights = sh < 9 ? clamp((9 - sh) / 1.2, 0, 0.7) : clamp((sh - 17.4) / 1.8, 0, 1);
      sec.style.setProperty('--lights', lights.toFixed(3));
      // sun / moon on the arc (hidden while the night passes)
      var t = clamp((sh - 7.6) / (21.2 - 7.6), 0, 1);
      var bx = 40 + 920 * t, by = (1 - t) * (1 - t) * 360 + 2 * (1 - t) * t * -60 + t * t * 360;
      var ar = arcBox;
      var x = ar.left + bx / 1000 * ar.width, y = ar.top + by / 400 * ar.height;
      handle.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
      handle.style.opacity = h > 21.6 && h < 31.2 ? 0 : 1;
      var sun = 1 - clamp((sh - 18.4) / 0.9, 0, 1);
      handle.style.setProperty('--sun', sun.toFixed(3));
      handle.style.setProperty('--moon-shadow', f > 3.5 ? '#121833' : '#2B2850');
      clockEl.textContent = fmt(h);
      bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
      var fg = (wrapT < 0 && f > 0.55 && f < 1.75) ? 'dark' : 'light';
      if (fg !== lastFg) { lastFg = fg; sec.setAttribute('data-fg', fg); if (st && st.isActive) syncNav(); }
    }
    var arcBox = { left: 0, top: 0, width: 1, height: 1 };
    function measureArc() {
      var pr = $('.day-pin', sec).getBoundingClientRect(), r = arc.getBoundingClientRect();
      arcBox = { left: r.left - pr.left, top: r.top - pr.top, width: r.width, height: r.height };
    }
    measureArc();
    ST.addEventListener('refreshInit', measureArc);
    ST.addEventListener('refresh', measureArc);

    tween = gsap.to(track, {
      x: function () { return -dist(); }, ease: 'none',
      scrollTrigger: {
        trigger: sec, start: 'top top', end: function () { return '+=' + dist(); },
        pin: true, scrub: true, invalidateOnRefresh: true, anticipatePin: 1,
        onRefresh: function () { measure(); update(); },
        onUpdate: update,
        onToggle: function (s) { if (s.isActive) syncNav(); }
      }
    });
    st = tween.scrollTrigger;
    update();

    // cards arrive from depth as the timeline moves
    moments.forEach(function (m, i) {
      if (i === 0) return;
      gsap.fromTo(m, { rotationY: -28, z: -220, opacity: 0.15, transformPerspective: 1300, transformOrigin: '0% 50%' }, {
        rotationY: 0, z: 0, opacity: 1, ease: 'power1.out',
        scrollTrigger: { trigger: m, containerAnimation: tween, start: 'left 102%', end: 'left 58%', scrub: true }
      });
      var tm = $('.m-time', m);
      if (tm) gsap.fromTo(tm, { x: 70 }, { x: -50, ease: 'none', scrollTrigger: { trigger: m, containerAnimation: tween, start: 'left right', end: 'right left', scrub: true } });
    });

    // drag the timeline: grab and throw
    var drags = [];
    if (HAS_DRAG) {
      var proxy = document.createElement('div'), startY = 0;
      drags.push(window.Draggable.create(proxy, {
        trigger: view, type: 'x', inertia: !!window.InertiaPlugin, dragClickables: false, minimumMovement: 6, allowContextMenu: true,
        onPress: function () { gsap.set(proxy, { x: 0 }); this.update(); startY = scrollNow(); },
        onDrag: sync, onThrowUpdate: sync
      })[0]);
      function sync() { scrollToY(clamp(startY - this.x * 1.15, st.start, st.end), true); }

      // drag the sun: scrub the time of day
      var hp = document.createElement('div');
      drags.push(window.Draggable.create(hp, {
        trigger: handle, type: 'x', minimumMovement: 1,
        onPress: function (e) { gsap.set(hp, { x: 0 }); this.update(); handle.classList.add('is-grab'); },
        onRelease: function () { handle.classList.remove('is-grab'); },
        onDrag: function () {
          var pr = $('.day-pin', sec).getBoundingClientRect();
          var px = this.pointerX - pr.left;
          var t = clamp(((px - arcBox.left) / arcBox.width * 1000 - 40) / 920, 0, 1);
          var h = 7.6 + t * (21.2 - 7.6);
          var p = progressFor(h);
          scrollToY(st.start + p * (st.end - st.start), true);
        }
      })[0]);
    }

    return function () {
      drags.forEach(function (d) { d.kill(); });
      ST.removeEventListener('refreshInit', measureArc);
      ST.removeEventListener('refresh', measureArc);
      sec.classList.remove('is-h');
      sec.removeAttribute('data-fg');
      gsap.set(track, { clearProps: 'transform' });
      moments.forEach(function (m) { gsap.set(m, { clearProps: 'all' }); });
    };
  }

  function initDayMobile() {
    $$('.day .moment').forEach(function (m) {
      gsap.from(m.children, { y: 40, opacity: 0, duration: 1, ease: 'expo.out', stagger: 0.06, scrollTrigger: { trigger: m, start: 'top 80%' } });
    });
  }

  function buildStars(el) {
    if (!el || el.__built) return;
    el.__built = true;
    var seed = 7;
    var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    ['.st-a', '.st-b'].forEach(function (sel, k) {
      var s = [];
      for (var i = 0; i < 90; i++) {
        var x = (rnd() * 100).toFixed(2), y = (rnd() * 62).toFixed(2), a = (0.35 + rnd() * 0.65).toFixed(2);
        s.push(x + 'vw ' + y + 'vh 0 ' + (rnd() > 0.92 ? '1px' : '0') + ' rgba(255,255,255,' + a + ')');
      }
      var star = $(sel, el);
      star.style.cssText = 'position:absolute;left:0;top:0;width:' + (k ? 1.6 : 1.1) + 'px;height:' + (k ? 1.6 : 1.1) + 'px;border-radius:50%;box-shadow:' + s.join(',') + ';' + (k ? 'animation:breathe 3.4s ease-in-out infinite;' : '');
    });
  }

  /* =========================================================
     03 CONNECTS THE DOTS: scrubbed data story
     ========================================================= */
  function polyCum(path) {
    var nums = (path.getAttribute('d').match(/-?\d+(\.\d+)?/g) || []).map(Number), pts = [];
    for (var i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    var cum = [0];
    for (var j = 1; j < pts.length; j++) cum.push(cum[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
    return { pts: pts, cum: cum, total: cum[cum.length - 1] };
  }
  function lenAtX(pc, x) {
    for (var i = 1; i < pc.pts.length; i++) {
      var a = pc.pts[i - 1], b = pc.pts[i];
      if (x <= b[0]) { var f = clamp((x - a[0]) / (b[0] - a[0]), 0, 1); return pc.cum[i - 1] + f * (pc.cum[i] - pc.cum[i - 1]); }
    }
    return pc.total;
  }

  function initDots() {
    var sec = $('.dots');
    if (!sec) return;
    sec.classList.add('is-pinned');
    var svg = $('.chart', sec);
    var sys = $('.ch-sys', svg), dia = $('.ch-dia', svg);
    var S = polyCum(sys), D = polyCum(dia);
    [[sys, S], [dia, D]].forEach(function (p) { gsap.set(p[0], { strokeDasharray: (p[1].total + 1) + ' ' + (p[1].total + 20), strokeDashoffset: p[1].total + 1 }); });
    var pts = $$('.ch-pt', svg), dz = $$('.ch-dz', svg);
    var steps = $$('.ds', sec), insight = $('.insight', sec);
    var links = $('.dots-links', sec);
    var chartWrap = $('.dots-chart-wrap', sec);
    var link = $('.ch-dizz-link', svg), lag = $('.ch-lag', svg);
    var linkLen = link.getTotalLength(), lagLen = lag.getTotalLength();
    gsap.set(link, { strokeDasharray: linkLen + ' ' + (linkLen + 20), strokeDashoffset: linkLen });
    gsap.set(lag, { strokeDasharray: '2 4' });

    var hide = function (sel) { return $$(sel, svg); };
    gsap.set(hide('.ch-pt, .ch-dz, .ch-walks circle, .ch-eve circle, .ch-grace circle'), { scale: 0, transformOrigin: '50% 50%' });
    gsap.set(hide('.ch-avg, .ch-vals text, .ch-dose rect, .ch-dose text, .ch-walks text, .ch-eve text, .ch-band, .ch-lag, .ch-lag-t, .ch-grace line, .ch-none'), { opacity: 0 });
    gsap.set($('.ch-dose-line', svg), { scaleY: 0, transformOrigin: '50% 0%' });
    gsap.set($('.ch-grace foreignObject', svg), { opacity: 0, y: 12 });
    gsap.set(insight, { opacity: 0, y: 60, rotationX: -14, transformPerspective: 1100, transformOrigin: '50% 100%' });
    gsap.set($$('.in-title .line-in, .in-ev li, .in-foot', insight), { yPercent: 0, opacity: 0, y: 16 });

    var T = 10;
    var tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: sec, start: 'top top', end: function () { return '+=' + Math.round(innerHeight * 3.4); }, pin: true, scrub: 0.7, invalidateOnRefresh: true, anticipatePin: 1 },
      onUpdate: onTl
    });
    tl.addLabel('start', 0);
    tl.from(hide('.ch-ticks g'), { opacity: 0, y: 6, stagger: 0.03, duration: 0.3 }, 0);
    tl.from(hide('.ch-grid, .ch-lane'), { opacity: 0, stagger: 0.04, duration: 0.4 }, 0);
    // phase 1: before the change
    var p1 = [0.2, 1.3];
    tl.to(sys, { strokeDashoffset: S.total + 1 - S.cum[1], duration: p1[1] - p1[0] }, p1[0]);
    tl.to(dia, { strokeDashoffset: D.total + 1 - D.cum[1], duration: p1[1] - p1[0] }, p1[0]);
    tl.to(pts[0], { scale: 1, duration: 0.15, ease: 'back.out(3)' }, p1[0]);
    tl.to(pts[1], { scale: 1, duration: 0.15, ease: 'back.out(3)' }, p1[1] - 0.1);
    tl.to(hide('.ch-vals text').slice(0, 2), { opacity: 1, stagger: 0.8, duration: 0.2 }, p1[0] + 0.1);
    tl.to(hide('.ch-walks circle'), { scale: 1, stagger: 0.12, duration: 0.15, ease: 'back.out(3)' }, 0.9);
    var eves = hide('.ch-eve circle');
    tl.to(eves.slice(0, 4), { scale: 1, stagger: 0.18, duration: 0.12 }, 0.3);
    tl.to(hide('.ch-avg-pre'), { opacity: 1, duration: 0.4 }, 1.25);
    // phase 2: the dose change
    tl.to($('.ch-dose-line', svg), { scaleY: 1, duration: 0.6, ease: 'power2.out' }, 1.8);
    tl.to(hide('.ch-dose rect, .ch-dose text'), { opacity: 1, duration: 0.35 }, 2.0);
    tl.from(hide('.ch-dose rect, .ch-dose text'), { x: -16, duration: 0.5, ease: 'power2.out' }, 2.0);
    tl.to(eves[4], { scale: 1, duration: 0.12 }, 2.2);
    // phase 3: falling pressure, dizziness
    var p3 = [2.9, 5.6], span = p3[1] - p3[0];
    tl.to(sys, { strokeDashoffset: 1, duration: span }, p3[0]);
    tl.to(dia, { strokeDashoffset: 1, duration: span }, p3[0]);
    tl.to(hide('.ch-band'), { opacity: 1, duration: span }, p3[0]);
    var at = function (x) { return p3[0] + (lenAtX(S, x) - S.cum[1]) / (S.total - S.cum[1]) * span; };
    [2, 3, 4, 5].forEach(function (k) { tl.to(pts[k], { scale: 1, duration: 0.15, ease: 'back.out(3)' }, at(S.pts[k][0]) - 0.08); });
    var dzX = [619.8, 776.5, 933.1, 1089.7];
    tl.to(hide('.ch-lag, .ch-lag-t'), { opacity: 1, duration: 0.3 }, at(dzX[0]) - 0.45);
    dz.forEach(function (g, k) { tl.to(g, { scale: 1, duration: 0.2, ease: 'back.out(3)' }, at(dzX[k]) - 0.05); });
    tl.to(link, { strokeDashoffset: 0, duration: at(dzX[3]) - at(dzX[0]) }, at(dzX[0]));
    [541.5, 619.8, 698.2, 776.5].forEach(function (x, k) { tl.to(eves[5 + k], { scale: 1, duration: 0.12 }, at(x)); });
    // phase 4: the numbers and Grace
    tl.to(hide('.ch-avg-post'), { opacity: 1, duration: 0.4 }, 5.5);
    tl.to(hide('.ch-vals text')[2], { opacity: 1, duration: 0.3 }, 5.6);
    tl.to(hide('.ch-grace circle'), { scale: 1, duration: 0.3, ease: 'back.out(2)' }, 6.2);
    tl.to(hide('.ch-grace line'), { opacity: 1, duration: 0.2 }, 6.35);
    tl.to($('.ch-grace foreignObject', svg), { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }, 6.4);
    tl.to(hide('.ch-none, .ch-walks text'), { opacity: 1, duration: 0.4 }, 6.6);
    tl.to(eves.slice(9), { scale: 1, stagger: 0.1, duration: 0.15, ease: 'back.out(3)' }, 6.7);
    tl.to(hide('.ch-eve text'), { opacity: 1, duration: 0.3 }, 7.0);
    // phase 5: the insight assembles, the chart steps aside
    tl.to(chartWrap, { scale: 0.62, x: 0, transformOrigin: '0% 30%', duration: 1.1, ease: 'power2.inOut' }, 7.3);
    tl.to(insight, { opacity: 1, y: 0, rotationX: 0, duration: 0.9, ease: 'power2.out' }, 7.6);
    tl.to($$('.in-title .line-in', insight), { opacity: 1, y: 0, stagger: 0.12, duration: 0.5, ease: 'power2.out' }, 7.9);
    tl.to($$('.in-ev li', insight), { opacity: 1, y: 0, stagger: 0.25, duration: 0.4, ease: 'power2.out' }, 8.3);
    tl.to($('.in-foot', insight), { opacity: 1, y: 0, duration: 0.4 }, 9.3);
    tl.to({}, { duration: 0.5 }, 9.5);

    // evidence rows connect to their dots
    var targets = [
      $('.ch-pt-low circle', svg),
      $$('.ch-dz circle:not(.glow)', svg)[0],
      $('.ch-grace circle', svg),
      $('.ch-dose rect', svg)
    ];
    var rows = $$('.in-ev li', insight);
    var NS = 'http://www.w3.org/2000/svg';
    var paths = rows.map(function () {
      var g = document.createElementNS(NS, 'g');
      var p = document.createElementNS(NS, 'path'), c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', '3.5');
      g.appendChild(p); g.appendChild(c); links.appendChild(g);
      return { g: g, p: p, c: c };
    });
    var linkStart = [8.35, 8.6, 8.85, 9.1];
    function drawLinks(time) {
      var base = links.getBoundingClientRect();
      rows.forEach(function (row, i) {
        var t = clamp((time - linkStart[i]) / 0.5, 0, 1);
        var L = paths[i];
        if (t <= 0 || !targets[i]) { L.g.style.opacity = 0; return; }
        var a = row.getBoundingClientRect(), b = targets[i].getBoundingClientRect();
        var x1 = a.left - base.left - 10, y1 = a.top - base.top + a.height / 2;
        var x2 = b.left - base.left + b.width / 2, y2 = b.top - base.top + b.height / 2;
        var mx = (x1 + x2) / 2;
        var d = 'M' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' C' + mx.toFixed(1) + ',' + y1.toFixed(1) + ' ' + mx.toFixed(1) + ',' + y2.toFixed(1) + ' ' + x2.toFixed(1) + ',' + y2.toFixed(1);
        L.p.setAttribute('d', d);
        var len = L.p.getTotalLength();
        L.p.style.strokeDasharray = len;
        L.p.style.strokeDashoffset = (len * (1 - t)).toFixed(1);
        L.c.setAttribute('cx', x2.toFixed(1)); L.c.setAttribute('cy', y2.toFixed(1));
        L.c.style.opacity = t > 0.95 ? 1 : 0;
        L.g.style.opacity = 1;
      });
    }

    var stepAt = [0, 1.8, 2.9, 6.2];
    var cur = -1;
    function onTl() {
      var time = tl.time();
      var k = 0;
      for (var i = 0; i < stepAt.length; i++) if (time >= stepAt[i] - 0.05) k = i;
      if (k !== cur) { cur = k; steps.forEach(function (s, j) { s.classList.toggle('is-on', j === k); }); }
      drawLinks(time);
    }
    onTl();

    return function () {
      sec.classList.remove('is-pinned');
      links.innerHTML = '';
      steps.forEach(function (s) { s.classList.add('is-on'); });
    };
  }

  /* =========================================================
     04 IT SEES: drag a bottle onto the Echo's camera
     ========================================================= */
  var BOTTLES = {
    ibuprofen: { name: 'Ibuprofen', strength: '200 mg', dir: 'Pain reliever (NSAID)', ph: 'Elm Street Health', pt: 'Over the counter', style: 'otc', glow: '255, 107, 87', vc: 'var(--coral)',
      tag: 'Not for Rose · from her doctor\'s notes', say: "Please don't take ibuprofen, Rose. Your knee discharge instructions say to avoid it because of blood pressure and kidney function.",
      sub: 'The same notes say: for pain, acetaminophen up to 3,000 mg a day.', src: 'Source: knee discharge instructions · Riverside Orthopedics' },
    atorvastatin: { name: 'Atorvastatin', strength: '40 mg', dir: 'Take 1 tablet at bedtime', glow: '255, 181, 71', vc: 'var(--amber)',
      tag: 'Wrong time · put it back', say: "That's atorvastatin, your bedtime pill. Put it back.", sub: "Right now it's time for your Metformin, the large white oblong pill.", src: 'Plan: Atorvastatin 40 mg · 9 PM' },
    lisinopril: { name: 'Lisinopril', strength: '20 mg', dir: 'Take 1 tablet every morning', glow: '255, 107, 87', vc: 'var(--coral)',
      tag: 'Outdated strength', say: 'Careful, Rose. This bottle is Lisinopril 20 mg, but your plan now says 10 mg.', sub: 'Please use the new 10 mg tablets and set this bottle aside.', src: 'Plan updated after Dr. Patel\'s visit · 10 mg' },
    metformin: { name: 'Metformin', strength: '500 mg', dir: 'Take 1 tablet twice daily with meals', glow: '158, 217, 176', vc: 'var(--sage)',
      tag: 'Right pill · right time', say: "Yes, that's your Metformin 500 mg for blood sugar, and it's due now.", sub: "Take one with something to eat, then tell me when you're done.", src: 'Plan: Metformin 500 mg · 6 PM, with dinner' }
  };

  function initSees() {
    var lab = $('.lab');
    if (!lab) return;
    var zone = $('.drop-zone', lab);
    var seq = null;
    function cams() { return $$('[data-cam]'); }
    function echoState(state, glow) {
      $$('.echo3d-sees').forEach(function (e) {
        e.setAttribute('data-state', state);
        if (glow) e.style.setProperty('--glow', glow); else e.style.removeProperty('--glow');
      });
    }
    function bus(phase, kind, b) { NOVA.scanBus.forEach(function (fn) { try { fn(phase, kind, b); } catch (e) {} }); }
    function scan(kind) {
      var b = BOTTLES[kind];
      if (!b) return;
      if (seq) seq.kill();
      var cs = cams();
      cs.forEach(function (cam) {
        $$('.box', cam).forEach(function (x) { x.classList.remove('on'); });
        $('[data-f="name"]', cam).textContent = b.name;
        $('[data-f="strength"]', cam).textContent = b.strength;
        $('[data-f="dir"]', cam).textContent = b.dir;
        var lab = $('.cv-label', cam);
        if (lab) { lab.setAttribute('data-style', b.style || 'rx'); }
        var ph = $('[data-f-ph]', cam), pt = $('[data-f-pt]', cam);
        if (ph) ph.textContent = b.ph || 'Elm Street Pharmacy';
        if (pt) pt.textContent = b.pt || 'Rose Alvarez';
        cam.setAttribute('data-mode', 'scan');
      });
      echoState('thinking');
      bus('scan', kind, b);
      seq = gsap.timeline();
      cs.forEach(function (cam) {
        var line = $('.cv-scan', cam);
        seq.fromTo(line, { top: '0%', opacity: 1 }, { top: '100%', duration: 1.2, ease: 'power1.inOut' }, 0.15);
        seq.set(line, { opacity: 0 }, 1.35);
      });
      ['name', 'strength', 'dir'].forEach(function (f, k) {
        seq.add(function () { cs.forEach(function (cam) { $('[data-f="' + f + '"]', cam).classList.add('on'); }); }, 0.45 + k * 0.28);
      });
      seq.add(function () {
        cs.forEach(function (cam) {
          var v = $('.cv-verdict', cam);
          v.style.setProperty('--vc', b.vc);
          $('.cvv-tag', cam).textContent = b.tag; $('.cvv-say', cam).textContent = b.say; $('.cvv-sub', cam).textContent = b.sub; $('.cvv-say', cam).classList.toggle('is-long', b.say.length > 90);
          var src = $('.cvv-src', cam); if (src) src.textContent = b.src || '';
          cam.setAttribute('data-mode', 'verdict');
        });
        echoState('speaking', b.glow);
        bus('verdict', kind, b);
      }, 1.55);
      if (!REDUCED) cs.forEach(function (cam) { seq.fromTo($('.cvv-say', cam), { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: 'expo.out' }, 1.6); });
      seq.add(function () { echoState('idle'); bus('idle', kind, b); }, 7);
    }
    NOVA.scan = scan;
    NOVA.bottles = BOTTLES;

    function flyIn(btn, done) {
      var zr = zone.getBoundingClientRect(), br = btn.getBoundingClientRect();
      var dx = zr.left + zr.width / 2 - (br.left + br.width / 2), dy = zr.top + zr.height * 0.42 - (br.top + br.height / 2);
      var cx = gsap.getProperty(btn, 'x'), cy = gsap.getProperty(btn, 'y');
      if (REDUCED) { done(); return; }
      gsap.timeline()
        .to(btn, { x: cx + dx, y: cy + dy, rotation: -6, scale: 1.12, duration: 0.55, ease: 'power3.inOut' })
        .add(done)
        .to(btn, { scale: 0.4, opacity: 0, duration: 0.35, ease: 'power2.in' })
        .set(btn, { x: 0, y: 0, rotation: 0, scale: 1 })
        .to(btn, { opacity: 1, duration: 0.5, ease: 'power2.out', delay: 0.4, onComplete: function () { var d = btn.__drag; if (d) d.update(); } });
    }

    var dragged = false;
    $$('[data-bottle]').forEach(function (btn) {
      var kind = btn.getAttribute('data-bottle');
      btn.addEventListener('click', function (e) {
        if (dragged) { e.preventDefault(); return; }
        if (NOVA.onBottle && GL()) { NOVA.onBottle(kind); return; }
        if (btn.classList.contains('bottle')) flyIn(btn, function () { scan(kind); });
        else scan(kind);
      });
      if (!HAS_DRAG || !btn.classList.contains('bottle')) return;
      var d = window.Draggable.create(btn, {
        type: 'x,y', minimumMovement: 6, zIndexBoost: false, allowContextMenu: true,
        onPress: function () { zone.classList.add('is-armed'); },
        onDragStart: function () { dragged = true; btn.classList.add('is-dragging'); },
        onDrag: function () { zone.classList.toggle('is-hot', this.hitTest(zone, '18%')); },
        onRelease: function () {
          var hot = zone.classList.contains('is-hot');
          zone.classList.remove('is-armed', 'is-hot');
          btn.classList.remove('is-dragging');
          setTimeout(function () { dragged = false; }, 60);
          if (!this.isDragging && !hot) return;
          if (hot) {
            scan(kind);
            gsap.timeline()
              .to(btn, { scale: 0.4, opacity: 0, duration: 0.35, ease: 'power2.in' })
              .set(btn, { x: 0, y: 0, rotation: 0, scale: 1 })
              .to(btn, { opacity: 1, duration: 0.5, delay: 0.3, ease: 'power2.out', onComplete: function () { d.update(); } });
          } else {
            gsap.to(btn, { x: 0, y: 0, duration: 0.9, ease: 'elastic.out(1, 0.55)', onComplete: function () { d.update(); } });
          }
        }
      })[0];
      btn.__drag = d;
    });
  }

  function initAVS() {
    var stage = $('.avs-stage');
    if (!stage || REDUCED) return;
    var paper = $('.avs-paper', stage), recon = $('.recon', stage), scanEl = $('.ap-scan', stage), hit = $('.ap-hit', stage);
    gsap.set(recon, { opacity: 0, x: 80, rotationY: -26, z: -120, transformPerspective: 1400 });
    gsap.set($$('.rc-rows li', recon), { opacity: 0, x: 24 });
    var tl = gsap.timeline({ scrollTrigger: { trigger: stage, start: 'top 72%' } });
    tl.from(paper, { y: 120, rotationX: 28, rotation: -9, opacity: 0, transformPerspective: 1400, duration: 1.3, ease: 'expo.out' })
      .fromTo(scanEl, { top: '0%', opacity: 1 }, { top: '100%', duration: 1.5, ease: 'power1.inOut' }, 0.6)
      .set(scanEl, { opacity: 0 })
      .to(hit, { '--hit': 1, duration: 0.4 }, 1.3)
      .to(recon, { opacity: 1, x: 0, rotationY: 0, z: 0, duration: 1.2, ease: 'expo.out' }, 1.7)
      .to($$('.rc-rows li', recon), { opacity: 1, x: 0, stagger: 0.12, duration: 0.7, ease: 'expo.out' }, 2.0);
  }

  /* =========================================================
     05 UNDER THE HOOD: the Echo turns, and its layers come apart
     ========================================================= */
  function initBuild() {
    var sec = $('.build');
    if (!sec) return;
    sec.classList.add('is-x');
    var root = $('.echo3d-xray', sec), obj = $('.e3-obj', root), front = $('.e3-front', root);
    var planes = $$('.xl-plane', root), body = $$('.e3-back, .e3-left, .e3-right, .e3-top, .e3-bottom', root);
    var packet = $('.xl-packet', root);
    var labels = $$('.layer', sec);
    var marks = $$('.xl-mark', root);
    var lines = $('.xray-lines', sec), stageBox = $('.xray', sec);
    var faces = {
      left: { el: $('.e3-left', root), n: [-1, 0, 0] }, right: { el: $('.e3-right', root), n: [1, 0, 0] },
      top: { el: $('.e3-top', root), n: [0, -1, 0] }, bottom: { el: $('.e3-bottom', root), n: [0, 1, 0] },
      back: { el: $('.e3-back', root), n: [0, -0.416, -0.909] }
    };
    var NS = 'http://www.w3.org/2000/svg';
    var paths = labels.map(function () { var p = document.createElementNS(NS, 'path'); lines.appendChild(p); return p; });
    var dots = labels.map(function () { var c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '3'); lines.appendChild(c); return c; });

    var W = function () { return root.getBoundingClientRect().width || 480; };
    var G = function () { return Math.round(W() * 0.24); };
    gsap.set(obj, { rotationX: 0, rotationY: 0 });
    gsap.set(planes, { z: -24, opacity: 0 });
    gsap.set(labels, { opacity: 0, x: 30 });
    gsap.set(packet, { z: 0, opacity: 0 });

    var tl = gsap.timeline({
      defaults: { ease: 'power2.inOut' },
      scrollTrigger: { trigger: sec, start: 'top top', end: function () { return '+=' + Math.round(innerHeight * 2.6); }, pin: '.build-pin', scrub: 0.8, invalidateOnRefresh: true, anticipatePin: 1 },
      onUpdate: draw
    });
    tl.fromTo(root, { y: 80, scale: 0.86, opacity: 0.4 }, { y: 0, scale: 1, opacity: 1, duration: 0.8, ease: 'power2.out' }, 0);
    tl.to(obj, { rotationY: -52, rotationX: -14, duration: 1.6 }, 0.3);
    tl.to(front, { z: function () { return G() * 3.1; }, duration: 1.6 }, 1.4);
    tl.to(body, { opacity: 0.16, duration: 1.0 }, 1.5);
    planes.forEach(function (p, i) {
      var zs = [2.15, 1.25, 0.3, -0.75][i];
      tl.to(p, { z: function () { return G() * zs; }, opacity: 1, duration: 1.5 }, 1.45 + i * 0.08);
    });
    labels.forEach(function (l, i) { tl.to(l, { opacity: 1, x: 0, duration: 0.5, ease: 'power2.out' }, 2.6 + i * 0.16); });
    tl.to(obj, { rotationY: -44, rotationX: -10, duration: 1.4, ease: 'none' }, 3.4);
    tl.to({}, { duration: 0.4 }, 4.6);

    // a request travels from the screen to Amazon Nova and back
    var loop = gsap.timeline({ repeat: -1, paused: true });
    loop.fromTo(packet, { z: function () { return G() * 3.1; }, opacity: 0 }, { z: function () { return G() * -0.75; }, opacity: 1, duration: 1.6, ease: 'power1.inOut' })
      .to(packet, { z: function () { return G() * 3.1; }, duration: 1.6, ease: 'power1.inOut' })
      .to(packet, { opacity: 0, duration: 0.2 });
    ST.create({ trigger: sec, start: 'top top', end: function () { return '+=' + Math.round(innerHeight * 2.6); },
      onUpdate: function (s) { if (s.progress > 0.55) loop.play(); else { loop.pause(0); gsap.set(packet, { opacity: 0 }); } },
      onLeave: function () { loop.pause(); }, onEnterBack: function () { loop.play(); }, onLeaveBack: function () { loop.pause(0); } });

    function draw() {
      shade(faces, gsap.getProperty(obj, 'rotationX'), gsap.getProperty(obj, 'rotationY'));
      var base = stageBox.getBoundingClientRect();
      labels.forEach(function (l, i) {
        var op = +gsap.getProperty(l, 'opacity');
        var m = marks[i];
        if (!m || op < 0.02) { paths[i].style.opacity = 0; dots[i].style.opacity = 0; return; }
        var a = m.getBoundingClientRect(), b = l.getBoundingClientRect();
        var x1 = a.left - base.left, y1 = a.top - base.top;
        var x2 = b.left - base.left - 14, y2 = b.top - base.top + 26;
        var kx = x1 + Math.max(24, (x2 - x1) * 0.35);
        paths[i].setAttribute('d', 'M' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' L' + kx.toFixed(1) + ',' + y2.toFixed(1) + ' L' + x2.toFixed(1) + ',' + y2.toFixed(1));
        paths[i].style.opacity = op;
        dots[i].setAttribute('cx', x1.toFixed(1)); dots[i].setAttribute('cy', y1.toFixed(1));
        dots[i].style.opacity = op;
      });
    }
    draw();
    addEventListener('resize', draw);

    return function () {
      loop.kill();
      sec.classList.remove('is-x');
      lines.innerHTML = '';
      gsap.set([obj, front].concat(planes, body, labels, root), { clearProps: 'all' });
      removeEventListener('resize', draw);
    };
  }

  /* ---------- MCP trace: lines arrive one by one ---------- */
  function initTrace() {
    var list = $('.tr-lines');
    if (!list || REDUCED) return;
    var items = $$('li', list);
    var i = 0, timer = null;
    function tick() {
      var li = items[i % items.length];
      list.appendChild(li);
      li.classList.remove('is-new'); void li.offsetWidth; li.classList.add('is-new');
      i++;
      timer = setTimeout(tick, 1900);
    }
    ST.create({ trigger: list, start: 'top bottom', end: 'bottom top', onToggle: function (s) { clearTimeout(timer); if (s.isActive) timer = setTimeout(tick, 900); } });
  }
})();
