// Nova · Live Studio (browser side).
// Talks to simulator/app.py (docs/CONTRACT.md incl. "v2 additions") and hosts MCP Apps views
// (ext-apps 2026-01-26) in sandboxed iframes on each Echo Show screen. Art direction: docs/DESIGN.md.
// GSAP + Lenis are loaded lazily as an enhancement; everything works without them.

/* ===================================================================== config */

// Logical screen canvases (CSS px before scaling): Echo Show 8 is 16:10, Echo Show 15 is 16:9.
const LOGICAL = { show8: { w: 720, h: 450 }, show15: { w: 800, h: 450 } };
const IDLE_AFTER_MS = 90_000;
const HINT_EVERY_MS = 8_000;
const VISION_TIMEOUT_MS = 125_000; // local vision models can take a minute
const PERSON_COLORS = { rose: "#F3A9B9", maya: "#A9BEFF", leo: "#A8E0B8", grace: "#F6D27A" };
const UI_TOOLS = new Set(["get_today", "care_briefing", "prepare_visit", "check_pill_photo", "read_care_document"]);
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const CDN = {
  gsap: "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js",
  st: "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/ScrollTrigger.min.js",
  drag: "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/Draggable.min.js",
  inertia: "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/InertiaPlugin.min.js",
  lenis: "https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js",
};

// Household clock presets (time, what happens next on the care engine's schedule).
const JUMPS = [
  ["07:55", "Morning pills"],
  ["08:55", "Check-in"],
  ["17:55", "Dinner pills"],
  ["20:25", "Bedtime pill"],
];

// Shown on screen while a tool runs, so the device feels alive.
const TOOL_STATUS = {
  get_today: "Checking today's plan",
  care_briefing: "Putting the briefing together",
  prepare_visit: "Preparing the visit brief",
  log_medication: "Logging the dose",
  check_medication: "Checking the medicine log",
  daily_checkin: "Saving the check-in",
  send_message: "Sending the message",
  read_messages: "Getting messages",
  ask_care_notes: "Looking through care notes",
  get_help: "Alerting the care circle",
  list_alerts: "Checking alerts",
  resolve_alert: "Updating the alert",
  set_sharing: "Updating sharing settings",
  read_notifications: "Checking notifications",
  snooze_reminder: "Snoozing the reminder",
  recent_activity: "Checking activity at home",
  check_pill_photo: "Reading the label",
  read_care_document: "Reading the document",
  apply_care_changes: "Updating the care plan",
  log_vitals: "Logging the reading",
  request_refill: "Ordering the refill",
};

// Announcement kinds: label + icon.
const ANN_KIND = {
  dose_reminder: ["Medicine reminder", "pill"],
  dose_followup: ["Medicine check", "pill"],
  caregiver_escalation: ["Care alert", "alert"],
  checkin_prompt: ["Check-in", "heart"],
  appointment_reminder: ["Appointment", "cal"],
  wellness_check: ["Wellness check", "heart"],
  care_plan_change: ["Care plan", "doc"],
  message: ["Message", "message"],
  visitor: ["Front door", "ring"],
  info: ["Nova", "nova"],
};
const READ_STATUSES = new Set(["acknowledged", "dismissed", "expired", "resolved", "read"]);

const RING_FALLBACK = {
  "ding:grace": "Grace rang the doorbell",
  "ding:delivery": "A package was delivered",
  "door_open:rose": "Rose went out the front door",
  "motion:unknown": "Motion at the front door",
};

// Used only if /api/status is unreachable, so the page still renders.
const FALLBACK_DEVICES = [
  {
    id: "kitchen", label: "Rose's kitchen",
    person: { id: "rose", name: "Rose Alvarez", short_name: "Rose", role: "elder", location: "Columbus, Ohio", device: "Echo Show 8 · Kitchen" },
    suggestions: ["What's my day look like?", "I just took my pink pill", "I'm feeling a bit dizzy today", "Any messages for me?"],
  },
  {
    id: "maya", label: "Maya's office",
    person: { id: "maya", name: "Maya Alvarez-Chen", short_name: "Maya", role: "caregiver", location: "Seattle, Washington", device: "Echo Show 15 · Home office" },
    suggestions: ["How's Mom doing?", "Prepare a brief for Mom's cardiology visit", "What are my notifications?", "Tell Mom I'll call her Sunday"],
  },
];

// The WebGL stage (stage3d.js) once mounted; null in the 2D layout (?flat=1, no WebGL, CDN down).
let stage3d = null;
const WANT_3D = !/[?&]flat=1\b/.test(location.search);

/* ==================================================================== helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function parseTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The household clock. Runs at `speed` (time-lapse); re-synced from SSE `clock` events,
// /api/status and /api/clock; ticks locally in between. `preview` overrides it while the sun is dragged.
const clock = {
  base: Date.now(),
  at: Date.now(),
  speed: 1,
  preview: null,
  now() { return this.preview ? new Date(this.preview) : new Date(this.base + (Date.now() - this.at) * this.speed); },
  sync(iso, speed) {
    const d = parseTime(iso);
    if (d) { this.base = d.getTime(); this.at = Date.now(); }
    const s = Number(speed);
    if (Number.isFinite(s) && s > 0) {
      if (!d) { this.base = this.now().getTime(); this.at = Date.now(); }
      this.speed = s;
    }
    topbar.render();
  },
};

const fmtTime = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const fmtClockSec = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
const hourOf = (d) => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s` : `${Math.round(n)} ms`;
}
function dayLabel(d) {
  if (!d) return "Earlier";
  const today = clock.now(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff === -1) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function hhmmLabel(t) {
  const [hh, mm] = t.split(":").map(Number);
  return fmtTime(new Date(2000, 0, 1, hh, mm));
}
function hashColor(key) {
  const pal = ["#F3A9B9", "#A9BEFF", "#A8E0B8", "#F6D27A", "#C7B3FF", "#7FE0E8"];
  let h = 0;
  for (const ch of String(key || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
}
// "How's Mom doing?" -> "how's Mom doing?" so it reads naturally after "Alexa, ".
function afterWake(s) {
  s = String(s || "").trim();
  if (!s || /^I\b/.test(s) || /^[A-Z]{2}/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function structuredOf(result) {
  if (!isObj(result)) return null;
  if (isObj(result.structuredContent)) return result.structuredContent;
  for (const b of arr(result.content)) {
    if (b?.type === "text" && typeof b.text === "string") {
      try { const v = JSON.parse(b.text); if (isObj(v)) return v; } catch { /* plain text */ }
    }
  }
  return null;
}
function textOf(result) {
  const b = arr(result?.content).find((c) => c?.type === "text");
  return b ? String(b.text ?? "") : "";
}
// Wrap words in spans for staggered reveals (CSS does the motion).
function splitWords(text, inner = false) {
  return String(text ?? "").split(/(\s+)/).map((w, i) => {
    if (!w.trim()) return w;
    const k = Math.floor(i / 2);
    return inner ? `<span class="w" style="--i:${k}"><span>${esc(w)}</span></span>` : `<span class="w" style="--i:${k}">${esc(w)}</span>`;
  }).join("");
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// fetch wrapper: JSON in/out, timeout, readable errors (FastAPI puts them in `detail`).
// Reads retry once, quietly, on a 5xx or a network blip (e.g. the MCP server restarting).
async function api(path, opts = {}) {
  const method = opts.method || "GET";
  try {
    return await apiOnce(path, opts);
  } catch (err) {
    const transient = !(err instanceof HttpError) || err.status >= 500;
    if (method !== "GET" || !transient || opts.noRetry) throw err;
    await sleep(700);
    return apiOnce(path, opts);
  }
}

async function apiOnce(path, { method = "GET", body, timeout = 120_000, raw = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method,
      signal: ctl.signal,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (raw) return res;
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`.trim();
      try {
        const j = await res.json();
        const d = j?.detail ?? j?.error ?? j?.message;
        if (d) msg = typeof d === "string" ? d : JSON.stringify(d);
      } catch { /* not JSON */ }
      throw new HttpError(res.status, msg);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("The request timed out");
    if (err instanceof TypeError) throw new Error("The simulator backend isn't reachable");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function toast(message, kind = "info", ms = 3800) {
  const box = $("#toasts");
  while (box.children.length >= 3) box.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 360); }, ms);
}

// Syntax-highlighted JSON: tokenize the raw string, escape each piece.
function jsonHTML(value, pretty = true) {
  let s;
  try { s = JSON.stringify(value, null, pretty ? 2 : 0); } catch { s = String(value); }
  if (s === undefined) s = "undefined";
  if (s.length > 30_000) s = s.slice(0, 30_000) + "\n…";
  const re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="j-key">${esc(m[1])}</span>${m[2]}` : `<span class="j-str">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="j-lit">${m[3]}</span>`;
    else out += `<span class="j-num">${m[4]}</span>`;
    last = re.lastIndex;
  }
  return out + esc(s.slice(last));
}

const ICON = {
  x: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  pill: '<svg viewBox="0 0 20 20" aria-hidden="true"><g transform="rotate(-40 10 10)"><rect x="2.5" y="6.5" width="15" height="7" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.5v7" stroke="currentColor" stroke-width="1.6"/></g></svg>',
  heart: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16.5s-6.5-3.8-6.5-8.3A3.6 3.6 0 0 1 10 6a3.6 3.6 0 0 1 6.5 2.2c0 4.5-6.5 8.3-6.5 8.3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  message: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l7.5 13h-15z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8.2v3.6M10 13.9v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  cal: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 2.5v3M13 2.5v3M3 8.5h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  doc: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6.5L15 6v11.5H5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M11 2.5V6.5h4M7.5 10h5M7.5 13h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  ring: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="1.5" width="8" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="6.2" r="1.6" fill="currentColor"/><circle cx="10" cy="13" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  nova: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="15 2.3"/><circle cx="16" cy="16" r="4.2" fill="currentColor"/></svg>',
  camera: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5h3l1.5-2h5l1.5 2h3v9.5H3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="11" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  upload: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3.5M6 7.5l4-4 4 4M4 13.5v3h12v-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shutter: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="10" cy="10" r="4" fill="currentColor"/></svg>',
  dot: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.5" fill="currentColor"/></svg>',
};

/* ======================================================================== sky */

// Time-of-day skies from DESIGN.md (top, middle, horizon), interpolated through the day.
const SKY_KEYS = [
  [0, ["#0A0B10", "#121833", "#1B2347"]],
  [5.2, ["#0A0B10", "#121833", "#1B2347"]],
  [6.6, ["#2A2F55", "#8D8FC4", "#F2A97E"]],
  [8.4, ["#BFDDF5", "#E9F2FB", "#F6EFE6"]],
  [15.6, ["#BFDDF5", "#E9F2FB", "#F6EFE6"]],
  [17.6, ["#4A3A7A", "#E0708A", "#FFB27A"]],
  [19.3, ["#12131F", "#2B2850", "#6B4C8F"]],
  [20.9, ["#0A0B10", "#121833", "#1B2347"]],
  [24, ["#0A0B10", "#121833", "#1B2347"]],
];
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb2css = (c) => `rgb(${c.map((v) => Math.round(v)).join(",")})`;
function skyAt(hour) {
  hour = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1][0] <= hour) i++;
  const [h0, c0] = SKY_KEYS[i], [h1, c1] = SKY_KEYS[i + 1];
  const k = h1 === h0 ? 0 : (hour - h0) / (h1 - h0);
  const e = k * k * (3 - 2 * k); // smoothstep
  const mix = (a, b) => hex2rgb(a).map((v, j) => v + (hex2rgb(b)[j] - v) * e);
  const cols = c0.map((c, j) => mix(c, c1[j]));
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return { top: rgb2css(cols[0]), mid: rgb2css(cols[1]), hor: rgb2css(cols[2]), lum: lum(cols[1]), rgb: cols };
}
const sunElevation = (hour) => Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)); // 0 at 6/18, 1 at noon

// Echo screens stay rich and dark-ish even at noon: pale skies are pulled toward a deep blue.
function screenSkyAt(hour) {
  const s = skyAt(hour);
  const deep = [[16, 28, 58], [24, 44, 86], [38, 62, 104]];
  const k = clamp((s.lum - 0.22) / 0.62, 0, 1) * 0.72;
  const cols = s.rgb.map((c, i) => c.map((v, j) => v * (1 - k) + deep[i][j] * k));
  return { top: rgb2css(cols[0]), mid: rgb2css(cols[1]), hor: rgb2css(cols[2]) };
}

const sky = {
  last: "",
  init() {
    const stars = $("#stars");
    const html = [];
    for (let i = 0; i < 120; i++) {
      const x = Math.random() * 100, y = Math.random() * 92, s = Math.random() < .15 ? 2.5 : Math.random() < .5 ? 1.6 : 1.1;
      html.push(`<i style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;width:${s}px;height:${s}px;opacity:${(.35 + Math.random() * .65).toFixed(2)};animation-delay:${(Math.random() * 4).toFixed(2)}s"></i>`);
    }
    stars.innerHTML = html.join("");
  },
  vars: {},
  render(now) {
    const h = hourOf(now);
    const key = h.toFixed(2);
    if (key === this.last) return;
    this.last = key;
    const s = skyAt(h);
    document.body.classList.toggle("day-bright", s.lum > 0.62);
    // The CSS sky only shows in 2D (WebGL draws its own). Custom properties set high up in the tree
    // restyle everything below them, so set them on the scene, and only when a value changes.
    if (!stage3d) {
      const day = sunElevation(h);
      const night = h < 5.5 || h > 20.5 ? 1 : h < 6.8 ? (6.8 - h) / 1.3 : h > 19.2 ? (h - 19.2) / 1.3 : 0;
      const want = { "--sky-top": s.top, "--sky-mid": s.mid, "--sky-hor": s.hor, "--day": day.toFixed(2), "--night": clamp(night, 0, 1).toFixed(2) };
      const st = $("#scene").style;
      for (const [k, v] of Object.entries(want)) if (this.vars[k] !== v) { this.vars[k] = v; st.setProperty(k, v); }
    }
    arc.place(h);
  },
};

/* ======================================================= the day arc (drag the sun) */

const arc = {
  geom: null,
  mode: "day",    // day: 6 AM → 6 PM with the sun; night: 6 PM → 6 AM with the moon
  dragging: false,
  init() {
    const orb = $("#orb");
    orb.addEventListener("pointerdown", (e) => this.down(e));
    orb.addEventListener("keydown", (e) => this.key(e));
    // In 3D the path and presets appear only while you reach for the sun.
    const arcEl = $("#arc"), presets = $("#arcPresets");
    let hideT = 0;
    this.reveal = (on) => {
      clearTimeout(hideT);
      if (on) arcEl.classList.add("active");
      else hideT = setTimeout(() => { if (!this.dragging) arcEl.classList.remove("active"); }, 1600);
    };
    for (const el of [orb, presets]) {
      el.addEventListener("pointerover", () => this.reveal(true));
      el.addEventListener("pointerout", () => this.reveal(false));
    }
    orb.addEventListener("focus", () => this.reveal(true));
    orb.addEventListener("blur", () => this.reveal(false));
    $("#arcPresets").addEventListener("click", (e) => {
      const b = e.target.closest("[data-jump]");
      if (b) topbar.jump(b.dataset.jump);
    });
  },
  // Geometry follows the layout: the arc sits between the bar and the top of the devices.
  measure(devTop) {
    const scene = $("#scene");
    const W = scene.clientWidth, H = scene.clientHeight;
    const narrow = window.innerWidth <= 900;
    const apex = narrow ? 150 : 104;
    const bottom = narrow ? 250 : clamp(devTop - 26, apex + 40, apex + H * 0.2);
    this.geom = { x0: W * 0.06, x1: W * 0.94, apex, bottom };
    const pts = [];
    for (let i = 0; i <= 48; i++) { const p = this.pt(i / 48); pts.push(`${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`); }
    $("#arcPath").setAttribute("d", pts.join(""));
    this.renderMarks();
    this.place(hourOf(clock.now()), true);
  },
  // Is the sun/moon behind a device screen (or the bar)? Then it lets clicks through.
  overScreen(p) {
    const sr = $("#scene").getBoundingClientRect();
    const x = sr.left + p.x, y = sr.top + p.y, pad = 26;
    if (y < 64) return true;
    for (const d of devices.values()) {
      const r = d.screenRect?.();
      if (r && x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad) return true;
    }
    return false;
  },
  pt(t) {
    if (stage3d) return stage3d.skyPoint(t, this.mode);
    const g = this.geom;
    return { x: g.x0 + (g.x1 - g.x0) * t, y: g.bottom - (g.bottom - g.apex) * Math.sin(Math.PI * t) };
  },
  tOf(hour) {
    const h = ((hour % 24) + 24) % 24;
    if (h >= 6 && h < 18) return { mode: "day", t: (h - 6) / 12 };
    return { mode: "night", t: (((h - 18) + 24) % 24) / 12 };
  },
  hourOf(t, mode) { return ((mode === "day" ? 6 : 18) + 12 * t) % 24; },
  renderMarks() {
    const ticks = this.mode === "day"
      ? [[0, "6 AM"], [.25, "9 AM"], [.5, "Noon"], [.75, "3 PM"], [1, "6 PM"]]
      : [[0, "6 PM"], [.25, "9 PM"], [.5, "Midnight"], [.75, "3 AM"], [1, "6 AM"]];
    $("#arcTicks").innerHTML = ticks.map(([t, l]) => { const p = this.pt(t); return `<span style="left:${p.x}px;top:${p.y}px">${l}</span>`; }).join("");
    $("#arcPresets").innerHTML = JUMPS.map(([time, label]) => {
      const [hh, mm] = time.split(":").map(Number);
      const { mode, t } = this.tOf(hh + mm / 60);
      if (mode !== this.mode) return "";
      const p = this.pt(t);
      return `<button type="button" data-jump="${time}" data-label="${esc(label)} · ${esc(hhmmLabel(time))}" style="left:${p.x}px;top:${p.y}px" aria-label="Jump to ${esc(hhmmLabel(time))}, ${esc(label)}"></button>`;
    }).join("");
  },
  place(hour, force = false) {
    if (!this.geom) return;
    const { mode, t } = this.tOf(hour);
    if (mode !== this.mode || force) {
      this.mode = mode;
      if (!force) this.renderMarks();
    }
    const p = this.pt(t);
    const orb = $("#orb");
    orb.style.setProperty("--ox", `${p.x}px`);
    orb.style.setProperty("--oy", `${p.y}px`);
    orb.classList.toggle("night", mode === "night");
    if (window.scrollY < 40) orb.classList.toggle("tucked", !this.dragging && this.overScreen(p)); // no layout reads while scrolling
    if (!stage3d) {
      const scene = $("#scene");
      const sx = `${(p.x / scene.clientWidth * 100).toFixed(1)}%`, sy = `${(p.y / scene.clientHeight * 100).toFixed(1)}%`;
      if (sx !== this.sunX) { this.sunX = sx; scene.style.setProperty("--sun-x", sx); }
      if (sy !== this.sunY) { this.sunY = sy; scene.style.setProperty("--sun-y", sy); }
    }
    const label = fmtTime(clock.now());
    orb.setAttribute("aria-valuenow", String(Math.round(hour * 60)));
    orb.setAttribute("aria-valuetext", label);
    $("#orbTip").textContent = label;
  },
  down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const orb = $("#orb");
    orb.setPointerCapture(e.pointerId);
    orb.classList.add("dragging");
    this.dragging = true;
    this.reveal?.(true);
    const mode = this.mode;
    const move = (ev) => {
      const rect = $("#scene").getBoundingClientRect();
      const x0 = this.pt(0).x, x1 = this.pt(1).x;
      const t = clamp((ev.clientX - rect.left - x0) / (x1 - x0), 0, 1);
      const h = this.hourOf(t, mode);
      const d = clock.now(); // keep the household date, change the time
      d.setHours(Math.floor(h), Math.round((h % 1) * 60) % 60, 0, 0);
      clock.preview = d.getTime();
      this.previewT = { t, mode };
      const p = this.pt(t);
      orb.style.setProperty("--ox", `${p.x}px`);
      orb.style.setProperty("--oy", `${p.y}px`);
      $("#orbTip").textContent = fmtTime(d);
      tickAll(true);
    };
    const up = () => {
      orb.removeEventListener("pointermove", move);
      orb.removeEventListener("pointerup", up);
      orb.removeEventListener("pointercancel", up);
      orb.classList.remove("dragging");
      this.dragging = false;
      this.reveal?.(false);
      if (clock.preview) {
        const d = new Date(clock.preview);
        const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        topbar.jump(hhmm).finally(() => { clock.preview = null; });
      }
    };
    orb.addEventListener("pointermove", move);
    orb.addEventListener("pointerup", up);
    orb.addEventListener("pointercancel", up);
  },
  key(e) {
    const step = e.shiftKey ? 60 : 15;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const d = clock.now();
    d.setMinutes(d.getMinutes() + (e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : step));
    clock.preview = d.getTime();
    tickAll(true);
    clearTimeout(this.keyTimer);
    this.keyTimer = setTimeout(() => {
      const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      topbar.jump(hhmm).finally(() => { clock.preview = null; });
    }, 650);
  },
};

/* ===================================================================== chime */

// A short, soft two-note chime (WebAudio, no files). Tone follows the light ring color.
// A soft two-note chime for announcements. It is synthesized once per tone into a small WAV and played
// with an <audio> element: no Web Audio graph (an AudioContext alongside the voice crashed Chrome in testing).
const chime = {
  urls: new Map(),
  wav(tone) {
    const notes = tone === "red"
      ? [[880, 0, 0.22], [880, 0.24, 0.22], [1046.5, 0.48, 0.5]]
      : tone === "yellow"
        ? [[1318.5, 0, 1.1], [987.8, 0.17, 1.3]]
        : [[783.99, 0, 1.0], [1174.66, 0.15, 1.3]];
    const rate = 22050;
    const len = Math.ceil(rate * (Math.max(...notes.map(([, dt, dur]) => dt + dur)) + 0.1));
    const data = new Float32Array(len);
    for (const [f, dt, dur] of notes) {
      const s0 = Math.floor(dt * rate), n = Math.floor(dur * rate);
      for (let i = 0; i < n && s0 + i < len; i++) {
        const t = i / rate;
        const env = t < 0.012 ? 0.14 * (t / 0.012) : 0.14 * Math.pow(0.0001 / 0.14, (t - 0.012) / Math.max(0.05, dur - 0.012));
        const w = 2 * Math.PI * f * t;
        data[s0 + i] += env * (Math.sin(w) + 0.22 * Math.sin(2 * w) + 0.06 * Math.sin(3.01 * w));
      }
    }
    const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    const tag = (o, txt) => { for (let i = 0; i < txt.length; i++) v.setUint8(o + i, txt.charCodeAt(i)); };
    tag(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); tag(8, "WAVE"); tag(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, "data"); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) v.setInt16(44 + i * 2, Math.round(clamp(data[i], -1, 1) * 30000), true);
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  },
  play(tone = "cyan") {
    if (speech.muted) return;
    try {
      const key = tone === "red" || tone === "yellow" ? tone : "cyan";
      if (!this.urls.has(key)) this.urls.set(key, this.wav(key));
      new Audio(this.urls.get(key)).play().catch(() => { /* autoplay blocked: silent */ });
    } catch { /* audio unavailable */ }
  },
};

/* ===================================================================== speech */

// Shorten to about `n` characters at a word boundary (CSS clamps the lines as well).
function wordClip(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n + 1).replace(/\s+\S*$/, "").replace(/[\s,;:(\-–—]+$/, "");
  return `${cut || t.slice(0, n)}…`;
}

// Speak and settle: on the audio's (or browser voice's) end event, or at most 3 s past the expected
// length once the voice has started (8 s grace for it to start: queue and TTS fetch). Never hangs.
function sayCapped(text, device, opts = {}) {
  const est = estimateMs(text);
  let onStart = null;
  const cap = new Promise((r) => {
    const pre = setTimeout(r, 8_000 + est + 3_000);
    onStart = (ms) => { clearTimeout(pre); setTimeout(r, Math.max(est, ms || 0) + 3_000); };
  });
  return Promise.race([speech.say(text, device, { ...opts, onStart }), cap]);
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
const estimateMs = (text) => Math.min(45_000, Math.max(1_200, (String(text).split(/\s+/).length / 2.6) * 1000));

// One voice at a time across both devices. Polly via /api/tts first, browser voice as fallback.
// While speaking, the light ring's bloom follows the voice (audio level or word boundaries).
const speech = {
  muted: false,
  queue: [],
  current: null,
  pollyOffUntil: 0,
  _voice: null,
  _utterance: null,

  say(text, device, { tone = "cyan", onStart = null } = {}) {
    text = String(text ?? "").trim();
    if (!text || !device) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push({ text, device, tone, resolve, onStart, stopped: false, cancel: null });
      this.pump();
    });
  },

  async pump() {
    if (this.current || !this.queue.length) return;
    const job = (this.current = this.queue.shift());
    // Hard cap: the queue never stalls on a stuck player (TTS fetch, blocked or stalled audio).
    const cap = new Promise((r) => { job.capTimer = setTimeout(() => { this.halt(job); r(); }, 12_000 + estimateMs(job.text) * 1.5); });
    try { await Promise.race([this.play(job), cap]); } catch { /* never let speech break the page */ }
    clearTimeout(job.capTimer);
    if (this.current === job) this.current = null;
    job.device.setLevel(0);
    job.resolve();
    job.device.settleLight();
    this.pump();
  },

  interrupt(deviceId) {
    this.queue = this.queue.filter((j) => {
      if (j.device.id !== deviceId) return true;
      j.resolve();
      return false;
    });
    if (this.current?.device.id === deviceId) this.halt(this.current);
  },

  stopAll() {
    for (const j of this.queue) j.resolve();
    this.queue = [];
    if (this.current) this.halt(this.current);
  },

  halt(job) {
    job.stopped = true;
    try { job.cancel?.(); } catch { /* already stopped */ }
  },

  setMuted(on) {
    this.muted = on;
    if (on && this.current) this.halt(this.current);
  },

  // Synthetic voice level (muted or browser voice without audio access).
  pulse(job, ms) {
    return new Promise((r) => {
      const t0 = performance.now();
      let raf = 0;
      const end = () => { cancelAnimationFrame(raf); clearTimeout(timer); r(); };
      const timer = setTimeout(end, ms + 50);
      const step = (t) => {
        const k = (t - t0) / 1000;
        job.device.setLevel(Math.max(0, .45 + .35 * Math.sin(k * 11) * Math.sin(k * 3.1)));
        if (t - t0 < ms && !job.stopped) raf = requestAnimationFrame(step);
        else end();
      };
      raf = requestAnimationFrame(step);
      job.cancel = end;
    });
  },

  async play(job) {
    const { text, device } = job;
    let voiced = false;
    const started = (ms) => {
      if (!voiced && !job.stopped && ms > 0) { voiced = true; device.setLight("speaking", job.tone); }
      try { job.onStart?.(ms); } catch { /* caller's problem */ }
      job.onStart = null;
    };
    if (this.muted) { started(0); return; } // muted: nothing to wait for, the status stays Ready
    let blob = null;
    if (Date.now() >= this.pollyOffUntil) {
      try {
        const res = await api("/api/tts", { method: "POST", body: { text, device: device.id }, raw: true, timeout: 8_000 });
        const type = res.headers.get("content-type") || "";
        if (res.status === 200 && type.startsWith("audio")) blob = await res.blob();
        else this.pollyOffUntil = Date.now() + 60_000; // 204: Polly unavailable, skip the round trip for a while
      } catch {
        this.pollyOffUntil = Date.now() + 60_000;
      }
    }
    if (job.stopped) return;
    job.started = started;
    if (blob && blob.size) await this.playBlob(blob, job);
    else await this.speakBrowser(text, job);
    started(0);
  },

  playBlob(blob, job) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      let done = false, raf = 0, safety = 0, pulse = null;
      const arm = (ms) => { clearTimeout(safety); safety = setTimeout(() => finish(), ms); };
      arm(estimateMs(job.text) + 3_000);
      const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : 0);
      audio.onloadedmetadata = () => { if (dur()) arm(dur() + 3_000); };
      audio.onplaying = () => job.started?.(dur() || estimateMs(job.text));
      // The bloom follows a speech-like envelope. (Routing the element through Web Audio for a real
      // level meter crashed Chrome on repeated playback in testing, so the audio plays straight out.)
      try {
        pulse = setInterval(() => {
          if (audio.paused) return;
          const t = performance.now() / 1000;
          job.device.setLevel(clamp(.42 + .3 * Math.sin(t * 11) * Math.sin(t * 3.1) + .12 * Math.sin(t * 23), 0, 1));
        }, 50);
      } catch { /* plays without the level meter */ }
      function finish() {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        clearInterval(pulse);
        clearTimeout(safety);
        try { audio.pause(); } catch { /* ignore */ }
        URL.revokeObjectURL(url);
        resolve();
      }
      audio.onended = finish;
      audio.onerror = finish;
      job.cancel = finish;
      audio.play().catch(finish);
    });
  },

  speakBrowser(text, job) {
    if (!synth) return this.pulse(job, estimateMs(text));
    return new Promise((resolve) => {
      let done = false, level = 0, raf = 0;
      const finish = () => { if (done) return; done = true; clearTimeout(safety); cancelAnimationFrame(raf); resolve(); };
      const u = new SpeechSynthesisUtterance(text);
      const v = this.voice();
      if (v) u.voice = v;
      u.lang = v?.lang || "en-US";
      u.rate = 1;
      u.pitch = 1;
      u.onend = finish;
      u.onerror = finish;
      u.onboundary = () => { level = 1; };
      const decay = () => { level *= 0.9; job.device.setLevel(.25 + level * .75); if (!done) raf = requestAnimationFrame(decay); };
      raf = requestAnimationFrame(decay);
      u.onstart = () => job.started?.(estimateMs(text));
      this._utterance = u; // keep a reference: Chrome can drop onend for collected utterances
      const safety = setTimeout(finish, estimateMs(text) * 1.25 + 3_000);
      job.cancel = () => { try { synth.cancel(); } catch { /* ignore */ } finish(); };
      synth.speak(u);
    });
  },

  voice() {
    const list = synth?.getVoices?.() || [];
    if (!list.length) return null;
    if (this._voice && list.includes(this._voice)) return this._voice;
    const en = list.filter((v) => /^en[-_]US/i.test(v.lang));
    const prefs = [/Aria.*Natural/i, /Jenny.*Natural/i, /Ava.*Natural/i, /Emma.*Natural/i, /Natural/i, /Google US English/i, /Samantha/i, /Ava/i, /Zira/i];
    for (const re of prefs) {
      const v = en.find((x) => re.test(x.name));
      if (v) return (this._voice = v);
    }
    return (this._voice = en[0] || list.find((v) => /^en/i.test(v.lang)) || null);
  },
};
if (synth && "onvoiceschanged" in synth) synth.onvoiceschanged = () => { speech._voice = null; };

// Web Speech API recognition (Chrome/Edge). The mic button is hidden when unsupported.
const mic = {
  rec: null,
  device: null,

  toggle(device) {
    if (!SR) return;
    if (this.rec) { this.rec.stop(); return; }
    speech.interrupt(device.id);
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = "", interim = "";
    this.rec = rec;
    this.device = device;
    device.setMic(true);

    rec.onresult = (e) => {
      finalText = ""; interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      const shown = `${finalText} ${interim}`.trim();
      if (shown) device.showInterim(shown);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone access is blocked. Type instead, or allow the mic for this page.", "error");
      else if (!["no-speech", "aborted"].includes(e.error)) toast(`Voice input stopped (${e.error}).`, "error");
    };
    rec.onend = () => {
      this.rec = null;
      this.device = null;
      device.setMic(false);
      const text = (finalText || interim).trim();
      if (text) device.send(text);
      else device.clearInterim();
    };
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.device = null;
      device.setMic(false);
      toast("Couldn't start the microphone.", "error");
    }
  },

  stop() { try { this.rec?.abort(); } catch { /* ignore */ } },
};

/* ===================================================================== images */

const IMG_MAX_BYTES = 1_500_000;
const IMG_MAX_SIDE = 1600;

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the image"));
    r.readAsDataURL(blob);
  });
}

// Draw any image blob (including SVG) onto a canvas and re-encode as JPEG, downscaled.
function blobToJpeg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const w0 = img.naturalWidth || 1024, h0 = img.naturalHeight || 768;
        const k = Math.min(1, IMG_MAX_SIDE / Math.max(w0, h0));
        const c = document.createElement("canvas");
        c.width = Math.round(w0 * k);
        c.height = Math.round(h0 * k);
        const g = c.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.88));
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image we can read")); };
    img.src = url;
  });
}

// Keep small PNG/JPEG/WebP as-is, re-encode everything else (SVG, large photos).
async function imageToDataURL(blob) {
  const type = String(blob.type || "");
  if (/^image\/(png|jpe?g|webp|gif)$/.test(type) && blob.size <= IMG_MAX_BYTES) return blobToDataURL(blob);
  return blobToJpeg(blob);
}

async function urlToDataURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the sample (${res.status})`);
  return imageToDataURL(await res.blob());
}

const samples = {
  list: [],
  async load() {
    try {
      const res = await api("/api/samples", { timeout: 10_000 });
      this.list = arr(res?.samples).filter((s) => isObj(s) && s.url);
    } catch { this.list = []; }
  },
  of(kind) { return this.list.filter((s) => s.kind === kind); },
};

/* =============================================================== MCP App host */

// One instance per card iframe. Implements the host side of ext-apps 2026-01-26 over postMessage.
class AppHost {
  static all = new Set();

  static dispatch(ev) {
    for (const host of AppHost.all) {
      if (host.iframe.contentWindow && ev.source === host.iframe.contentWindow) {
        host.handle(ev.data);
        return;
      }
    }
  }

  constructor(device, card) {
    this.device = device;
    this.card = card;
    this.ready = false;
    this.seq = 0;
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("title", `${card.tool || "MCP App"} (${card.resource_uri || "ui"})`);
    f.setAttribute("referrerpolicy", "no-referrer");
    f.style.height = `${device.cardMaxHeight()}px`;
    f.srcdoc = card.html;
    this.iframe = f;
    AppHost.all.add(this);
  }

  post(msg) { try { this.iframe.contentWindow?.postMessage(msg, "*"); } catch { /* frame gone */ } }
  reply(id, result) { this.post({ jsonrpc: "2.0", id, result }); }
  fail(id, code, message) { this.post({ jsonrpc: "2.0", id, error: { code, message } }); }
  notify(method, params) { this.post({ jsonrpc: "2.0", method, params }); }

  teardown() {
    if (this.ready) this.post({ jsonrpc: "2.0", id: `teardown-${++this.seq}`, method: "ui/resource-teardown", params: { reason: "closed" } });
    AppHost.all.delete(this);
  }

  handle(m) {
    // Ignore anything that isn't JSON-RPC, and responses to our own requests.
    if (!isObj(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string") return;
    const isRequest = m.id !== undefined && m.id !== null;
    const p = isObj(m.params) ? m.params : {};

    switch (m.method) {
      case "ui/initialize":
        if (!isRequest) return;
        this.reply(m.id, {
          protocolVersion: "2026-01-26",
          hostCapabilities: { serverTools: {}, logging: {} },
          hostInfo: { name: "Nova Alexa+ Simulator", version: "0.3.0" },
          hostContext: {
            theme: "dark",
            displayMode: "inline",
            availableDisplayModes: ["inline"],
            platform: "web",
            locale: "en-US",
            deviceCapabilities: { touch: true, hover: false },
            toolInfo: { tool: { name: this.card.tool } },
            containerDimensions: { width: this.device.ui.cardFrame.clientWidth || this.device.size.w - 28, maxHeight: this.device.cardMaxHeight() },
          },
        });
        return;

      case "ui/notifications/initialized":
        if (this.ready) return;
        this.ready = true;
        this.notify("ui/notifications/tool-input", { arguments: isObj(this.card.input) ? this.card.input : {} });
        this.notify("ui/notifications/tool-result", isObj(this.card.result) ? this.card.result : { content: [] });
        return;

      case "ui/notifications/size-changed": {
        const h = Number(p.height);
        if (Number.isFinite(h) && h > 0) { this.reportedH = Math.ceil(h); this.device.fitCard(); }
        return;
      }

      case "tools/call":
        if (isRequest) this.toolCall(m.id, p);
        return;

      case "ui/message":
        if (isRequest) this.message(m.id, p);
        return;

      case "ping":
        if (isRequest) this.reply(m.id, {});
        return;

      case "notifications/message":
        return; // view logging: nothing to show

      default:
        if (isRequest) this.fail(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  // The view asked the host to call a server tool (e.g. "Mark taken" -> log_medication).
  async toolCall(id, p) {
    const name = String(p.name || "");
    const args = isObj(p.arguments) ? p.arguments : {};
    if (!name) { this.fail(id, -32602, "Missing tool name"); return; }
    const rec = inspector.beginAppCall(this.device.id, name, args, this.card.resource_uri);
    const t0 = performance.now();
    try {
      const result = await api("/api/app-call", { method: "POST", body: { device: this.device.id, name, arguments: args }, timeout: 60_000 });
      this.reply(id, isObj(result) ? result : { content: [] });
      inspector.endAppCall(rec, result, Math.round(performance.now() - t0));
      appCallWaiters = appCallWaiters.filter((w) => (w.name === name ? (w.resolve(result), false) : true));
    } catch (err) {
      this.fail(id, -32000, err.message || "Tool call failed");
      inspector.endAppCall(rec, null, Math.round(performance.now() - t0), err);
    }
  }

  // The view sent a chat message: treat it as a new utterance on this device.
  message(id, p) {
    const blocks = Array.isArray(p.content) ? p.content : [p.content];
    const text = blocks
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!text) { this.fail(id, -32602, "Message has no text"); return; }
    if (this.device.busy) { this.fail(id, -32000, "Alexa is busy, try again in a moment"); return; }
    this.reply(id, {});
    setTimeout(() => this.device.send(text, { source: "app" }), 0);
  }
}
window.addEventListener("message", (ev) => AppHost.dispatch(ev));
let appCallWaiters = []; // NovaDemo: wait for a tools/call made by an MCP App view

/* ==================================================================== devices */

const devices = new Map();

// Light ring color for an announcement on a given device.
function toneFor(item, device) {
  if (str(item?.severity) === "urgent") return "red";
  if (device?.role === "caregiver") return "yellow";
  return "cyan";
}

class Device {
  constructor(def) {
    this.id = def.id;
    this.el = $("#deviceTpl").content.firstElementChild.cloneNode(true);
    const q = (s) => $(s, this.el);
    this.ui = {
      name: q(".pn"), meta: q(".person-meta"),
      state: q(".dev-state"), stateText: q(".dev-state span"), focusBtn: q(".focus-btn"), flipBtn: q(".flip-btn"), visionBtn: q(".vision-btn"),
      bell: q(".bell-btn"), badge: q(".bell-badge"), drawer: q(".drawer"),
      hw: q(".obj-wrap"), obj: q(".obj"), bezel: q(".bezel"), fit: q(".screen-fit"), screen: q(".screen"),
      backList: q(".back-list"), backTitle: q(".back-title"), dropHint: q(".drop-hint"),
      loc: q(".amb-loc"), time: q(".amb-time"), date: q(".amb-date"), hint: q(".amb-hint"), hintText: q(".hint-text"),
      tsLoc: q(".ts-loc"), tsTime: q(".ts-time"), turns: q(".turns"),
      caption: q(".caption-text"), cardFrame: q(".card-frame"), cardClose: q(".card-close"), elicit: q(".elicit-layer"),
      ann: q(".announce-layer"), scanImg: q(".scan-img"), scanText: q(".scan-text"),
      form: q(".composer"), input: q(".say"), send: q(".send"), mic: q(".mic"), chips: q(".chips"), chipsWrap: q(".chips-wrap"),
    };
    this.gen = 0; // bumped on reset so late replies from before the reset are dropped
    this.busy = false;
    this.micOn = false;
    this.light = "idle";
    this.card = null;
    this.elicit = null;
    this.liveTurn = null;
    this.pendingTurn = null;
    this.idleTimer = 0;
    this.hintIdx = 0;
    this.suggestions = [];
    this.announcement = null; // shown on screen
    this.annQueue = [];
    this.annSeen = new Set();
    this.unread = 0;
    this.capture = null;
    this.ring = null;
    this.skyKey = "";
    // 3D object state: orbit drag, flip, cursor tilt.
    this.m = { rx: 0, ry: 0, vx: 0, vy: 0, flip: 0, flipV: 0, flipTo: 0, tx: 0, ty: 0, dragging: false };
    this.applyDef(def);
    this.bind();
  }

  get shortName() {
    const p = this.def.person || {};
    return p.short_name || String(p.name || "").split(" ")[0] || this.id;
  }

  applyDef(def) {
    this.def = def;
    const p = isObj(def.person) ? def.person : {};
    this.role = p.role || (this.id === "kitchen" ? "elder" : "caregiver");
    this.model = /\b15\b/.test(`${p.device || ""} ${def.label || ""}`) ? "show15" : "show8";
    this.size = LOGICAL[this.model];
    this.el.classList.toggle("show15", this.model === "show15");
    this.el.classList.toggle("show8", this.model === "show8");
    this.el.style.setProperty("--lw", `${this.size.w}px`);
    this.el.style.setProperty("--lh", `${this.size.h}px`);
    this.el.dataset.device = this.id;
    this.color = PERSON_COLORS[p.id] || hashColor(p.id || this.id);
    this.el.style.setProperty("--pc", this.color);
    this.visionKind = this.role === "elder" ? "pill" : "document";

    this.ui.name.textContent = p.name || def.label || this.id;
    const roomName = String(p.device || "").split("·")[1]?.trim();
    const cityName = String(p.location || "").split(",")[0].trim();
    this.ui.meta.textContent = [this.shortName, roomName, cityName].filter(Boolean).join(" · ") || def.label || "";
    this.el.classList.toggle("vk-document", this.visionKind === "document");
    this.ui.visionBtn.title = this.visionKind === "pill" ? "Show Alexa a pill bottle" : "Scan paperwork";
    this.ui.visionBtn.setAttribute("aria-label", this.ui.visionBtn.title);
    this.ui.backTitle.textContent = `Under the hood · ${this.shortName}`;
    this.ui.dropHint.textContent = this.visionKind === "pill" ? `Drop to show ${this.shortName}'s Echo` : "Drop to scan";

    const room = String(p.device || "").split("·")[1]?.trim();
    const city = String(p.location || "").split(",")[0].trim();
    const place = [room, city].filter(Boolean).join(" · ") || def.label || "";
    this.ui.loc.textContent = place;
    this.ui.tsLoc.textContent = place;
    // Rose's clock is the household clock (Columbus); Pacific-coast devices run three hours behind it.
    this.clockOffsetH = /Seattle|Washington|Oregon|California|Pacific/i.test(p.location || "") ? -3 : /Texas|Austin|Chicago|Central/i.test(p.location || "") ? -1 : 0;

    this.ui.input.placeholder = `Talk to Alexa as ${this.shortName}…`;
    this.ui.focusBtn.title = `Focus ${this.shortName}'s Echo Show (double-click the bezel)`;
    this.ui.bell.title = `${this.shortName}'s notifications`;
    this.setSuggestions(def.suggestions);

    // Rose's front door gets a Ring Video Doorbell.
    if (this.role === "elder" && !this.ring && $("#ringTpl")) {
      this.ring = new RingPanel(this);
      $("#ringSlot").append(this.ring.el);
    }
    this.fit();
  }

  setSuggestions(list) {
    const items = arr(list).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8);
    if (!items.length && this.suggestions.length) return;
    if (items.join("\n") === this.suggestions.join("\n") && this.ui.chips.children.length) return; // keep buttons (and any click in flight)
    this.suggestions = items;
    this.ui.chips.replaceChildren(...items.map((text) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.text = text;
      b.textContent = text;
      b.title = text;
      b.disabled = this.busy;
      return b;
    }));
    requestAnimationFrame(() => this.fitChips());
    if (!this.ui.hintText.textContent) this.rotateHint(true);
  }

  // A follow-up pill ("Tell me more") leads the row after a reply that offers details.
  setFollowUp(text) {
    this.ui.chips.querySelector(".chip.follow")?.remove();
    if (text) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip follow";
      b.dataset.text = text;
      b.textContent = text;
      b.title = text;
      this.ui.chips.prepend(b);
    }
    requestAnimationFrame(() => this.fitChips());
  }

  // One row: at most three whole pills, then "More" (a popover with the rest).
  fitChips() {
    const box = this.ui.chips;
    this.closeChipMenu();
    const chips = [...box.querySelectorAll(".chip:not(.more)")];
    let more = box.querySelector(".chip.more");
    if (!more) {
      more = document.createElement("button");
      more.type = "button";
      more.className = "chip more";
      more.textContent = "More";
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
    }
    box.append(more);
    for (const c of chips) c.hidden = false;
    more.hidden = true;
    this.hiddenChips = [];
    if (!box.clientWidth || !chips.length) return;
    const top0 = chips[0].offsetTop;
    let hidden = chips.filter((c, i) => i >= 3 || c.offsetTop > top0);
    for (const c of hidden) c.hidden = true;
    if (hidden.length) {
      more.hidden = false;
      const visible = chips.filter((c) => !c.hidden);
      while (more.offsetTop > top0 && visible.length) {
        const last = visible.pop();
        last.hidden = true;
        hidden = [last, ...hidden];
      }
      more.title = hidden.map((c) => c.dataset.text).join("\n");
    }
    this.hiddenChips = hidden;
  }

  toggleChipMenu() {
    if (this.chipMenu) { this.closeChipMenu(); return; }
    const menu = document.createElement("div");
    menu.className = "chip-menu";
    menu.setAttribute("role", "menu");
    for (const c of this.hiddenChips || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = c.dataset.text || c.textContent;
      b.addEventListener("click", () => { this.closeChipMenu(); this.send(c.dataset.text); });
      menu.append(b);
    }
    this.ui.chipsWrap.append(menu);
    this.chipMenu = menu;
    this.ui.chips.querySelector(".chip.more")?.setAttribute("aria-expanded", "true");
  }

  closeChipMenu() {
    this.chipMenu?.remove();
    this.chipMenu = null;
    this.ui.chips.querySelector(".chip.more")?.setAttribute("aria-expanded", "false");
  }

  bind() {
    const { form, input, send, chips, cardClose, focusBtn, flipBtn, fit, bell, ann, hw } = this.ui;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      send.disabled = true;
      this.send(text);
    });
    input.addEventListener("input", () => { send.disabled = !input.value.trim(); });
    chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip || chip.disabled) return;
      if (chip.classList.contains("more")) { e.stopPropagation(); this.toggleChipMenu(); return; }
      this.send(chip.dataset.text);
    });
    magnetic(chips, ".chip");
    this.ui.mic.addEventListener("click", () => mic.toggle(this));
    cardClose.addEventListener("click", () => this.closeCard());
    this.ui.caption.addEventListener("click", () => this.toggleCaption());
    focusBtn.addEventListener("click", () => toggleFocus(this.id));
    flipBtn.addEventListener("click", () => this.flip());
    this.ui.visionBtn.addEventListener("click", (e) => { e.stopPropagation(); shelf.toggle(this); });
    $(".flip-back", this.el).addEventListener("click", () => this.flip(false));
    bell.addEventListener("click", (e) => { e.stopPropagation(); this.toggleDrawer(); });
    this.ui.drawer.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = e.target.closest("[data-ann]");
      if (!row) return;
      const item = this.drawerItems?.find((a) => String(a.id) === row.dataset.ann);
      if (item) { this.closeDrawer(); this.showAnnouncement(item, { speak: false }); }
    });
    ann.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !this.announcement) return;
      if (btn.dataset.reply !== undefined) this.replyAnnouncement(btn.dataset.reply);
      else if (btn.dataset.ok !== undefined) this.hideAnnouncement({ ack: "acknowledged", via: "OK" });
      else if (btn.classList.contains("ann-close")) this.hideAnnouncement({ ack: "dismissed" });
    });
    // Orbit: drag the bezel (not the screen) to turn the device in 3D. Double-click to focus.
    hw.addEventListener("pointerdown", (e) => this.orbitStart(e));
    hw.addEventListener("dblclick", (e) => { if (!e.target.closest(".screen-fit, .back-list, .capture, button")) toggleFocus(this.id); });
    this.el.addEventListener("pointerenter", () => { activeDevice = this; });
    if ("ResizeObserver" in window) new ResizeObserver(() => this.fit()).observe(fit);
  }

  // Scale the logical canvas to the bezel's inner width (in 3D the glass does the scaling).
  fit() {
    if (stage3d) { this.ui.screen.style.setProperty("--scale", "1"); return; }
    const w = this.ui.fit.clientWidth;
    if (w) this.ui.screen.style.setProperty("--scale", (w / this.size.w).toFixed(5));
  }

  /* ---- the 3D object ---- */
  orbitStart(e) {
    if (e.button !== 0 || e.target.closest(".screen-fit, .back-list, .capture, .drawer, button, a, input")) return;
    if (this.m.flipTo && e.target.closest(".back-panel")) return;
    e.preventDefault();
    const m = this.m, hw = this.ui.hw;
    hw.setPointerCapture(e.pointerId);
    hw.classList.add("orbiting");
    m.dragging = true;
    let lx = e.clientX, ly = e.clientY, lt = performance.now();
    const move = (ev) => {
      const now = performance.now(), dt = Math.max(8, now - lt);
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY; lt = now;
      const rubber = (v, lim) => (Math.abs(v) > lim ? Math.sign(v) * (lim + (Math.abs(v) - lim) * 0.25) : v);
      m.ry = rubber(m.ry + dx * 0.28, 25);
      m.rx = rubber(m.rx - dy * 0.18, 10);
      m.vy = (dx * 0.28) / dt * 16;
      m.vx = (-dy * 0.18) / dt * 16;
      kickMotion();
    };
    const up = () => {
      hw.removeEventListener("pointermove", move);
      hw.removeEventListener("pointerup", up);
      hw.removeEventListener("pointercancel", up);
      hw.classList.remove("orbiting");
      m.dragging = false;
      kickMotion();
    };
    hw.addEventListener("pointermove", move);
    hw.addEventListener("pointerup", up);
    hw.addEventListener("pointercancel", up);
    kickMotion();
  }

  flip(to) {
    const want = to === undefined ? !this.m.flipTo : !!to;
    this.m.flipTo = want ? 180 : 0;
    stage3d?.flip(this.id, want);
    this.el.classList.toggle("flipped", want);
    this.ui.flipBtn.title = want ? "Flip back (F)" : "Flip to see under the hood (F)";
    if (want) this.closeDrawer();
    kickMotion();
  }

  // One spring step; returns true while still moving.
  step() {
    const m = this.m;
    let moving = false;
    if (!m.dragging) {
      // inertia, then spring back to rest
      m.vx += -m.rx * 0.05; m.vy += -m.ry * 0.05;
      m.vx *= 0.84; m.vy *= 0.84;
      m.rx += m.vx; m.ry += m.vy;
      if (Math.abs(m.rx) + Math.abs(m.ry) + Math.abs(m.vx) + Math.abs(m.vy) > 0.02) moving = true;
      else { m.rx = 0; m.ry = 0; m.vx = 0; m.vy = 0; }
    } else moving = true;
    // flip spring
    m.flipV += (m.flipTo - m.flip) * 0.06; m.flipV *= 0.8; m.flip += m.flipV;
    if (Math.abs(m.flipTo - m.flip) + Math.abs(m.flipV) > 0.05) moving = true; else { m.flip = m.flipTo; m.flipV = 0; }
    // cursor tilt eases toward its target
    const tx = REDUCED || m.dragging ? 0 : m.ttx || 0, ty = REDUCED || m.dragging ? 0 : m.tty || 0;
    m.tx += (tx - m.tx) * 0.1; m.ty += (ty - m.ty) * 0.1;
    if (Math.abs(tx - m.tx) + Math.abs(ty - m.ty) > 0.01) moving = true; else { m.tx = tx; m.ty = ty; }

    const rx = m.rx + m.tx, ry = m.flip + m.ry + m.ty;
    const flat = Math.abs(rx) < 0.04 && Math.abs(ry) < 0.04 && !m.dragging;
    this.el.classList.toggle("flat", flat);
    this.ui.obj.style.setProperty("--rx", `${rx.toFixed(3)}deg`);
    this.ui.obj.style.setProperty("--ry", `${ry.toFixed(3)}deg`);
    this.ui.bezel.style.setProperty("--gx", (-(m.ry + m.ty) * 2.2).toFixed(2));
    return moving;
  }

  // The light ring follows the voice.
  setLevel(v) {
    const s = v.toFixed(3);
    this.el.style.setProperty("--lvl", s);
    this.ui.screen.style.setProperty("--lvl", s);
    stage3d?.setLevel(this.id, v);
  }

  // Where the display is on screen (the 3D glass, or the 2D object).
  screenRect() {
    return (stage3d && stage3d.rectOf(this.id)) || this.ui.hw.getBoundingClientRect();
  }

  tick(now) {
    const d = new Date(now.getTime() + this.clockOffsetH * 3_600_000);
    const t = fmtTime(d);
    const short = t.replace(/\s?[AP]M$/i, "");
    if (this.ui.time.textContent !== short) this.ui.time.textContent = short;
    if (this.ui.tsTime.textContent !== t) this.ui.tsTime.textContent = t;
    const date = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    if (this.ui.date.textContent !== date) this.ui.date.textContent = date;
    // The idle screen shows this home's own sky.
    const h = hourOf(d);
    const key = h.toFixed(1);
    if (key !== this.skyKey) {
      this.skyKey = key;
      const s = screenSkyAt(h);
      const st = this.ui.screen.style;
      st.setProperty("--s-top", s.top);
      st.setProperty("--s-mid", s.mid);
      st.setProperty("--s-hor", s.hor);
      st.setProperty("--s-glow", `rgba(255, 196, 150, ${(0.12 + sunElevation(h) * 0.35).toFixed(2)})`);
    }
    this.ring?.tick(now);
  }

  rotateHint(immediate = false) {
    const { hint, hintText } = this.ui;
    if (!this.suggestions.length) { hint.hidden = true; return; }
    hint.hidden = false;
    const next = `“Alexa, ${afterWake(this.suggestions[this.hintIdx++ % this.suggestions.length])}”`;
    if (immediate) { hintText.textContent = next; return; }
    if (this.ui.screen.classList.contains("active")) return;
    hint.classList.add("swap");
    setTimeout(() => { hintText.textContent = next; hint.classList.remove("swap"); }, 500);
  }

  /* ---- light ring + state ---- */
  setLight(state, tone = "cyan") {
    this.light = state;
    this.ui.screen.dataset.light = state;
    this.ui.screen.dataset.tone = tone;
    this.el.dataset.light = state;
    this.el.dataset.tone = tone;
    this.ui.state.dataset.state = state;
    this.ui.state.dataset.tone = tone;
    this.ui.stateText.textContent = { idle: "Ready", listening: "Listening", thinking: "Thinking", speaking: "Speaking", notify: "Notification" }[state] || "Ready";
    stage3d?.setLight(this.id, state, tone);
  }

  // Derive the resting light from what the device is doing right now.
  settleLight() {
    if (speech.current?.device === this && this.light === "speaking") return;
    if (this.micOn || this.elicit) this.setLight("listening");
    else if (this.busy) this.setLight("thinking");
    else if (this.announcement) this.setLight("notify", toneFor(this.announcement, this));
    else this.setLight("idle");
  }

  setMic(on) {
    this.micOn = on;
    this.ui.mic.classList.toggle("on", on);
    this.ui.mic.setAttribute("aria-pressed", String(on));
    if (on) { this.wake(); this.setLight("listening"); } else this.settleLight();
  }

  setBusy(on) {
    this.busy = on;
    for (const c of this.ui.chips.children) c.disabled = on;
  }

  wake() {
    clearTimeout(this.idleTimer);
    this.ui.screen.classList.add("active");
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.elicit || this.card || this.announcement || this.micOn || this.light !== "idle") { this.scheduleIdle(); return; }
      this.goIdle();
    }, IDLE_AFTER_MS);
  }

  goIdle() {
    this.ui.screen.classList.remove("active");
    setTimeout(() => { if (!this.ui.screen.classList.contains("active")) this.ui.turns.replaceChildren(); }, 700);
  }

  /* ---- conversation ---- */
  newTurn(text, { interim = false } = {}) {
    let t = this.liveTurn;
    if (!t) {
      for (const old of this.ui.turns.querySelectorAll(".turn.latest")) old.classList.remove("latest");
      t = document.createElement("div");
      t.className = "turn latest";
      t.innerHTML = '<div class="u"></div><div class="a pending"></div>';
      this.ui.turns.append(t);
      while (this.ui.turns.children.length > 5) this.ui.turns.firstElementChild.remove();
    }
    const u = t.querySelector(".u");
    u.textContent = `“${text}”`;
    u.classList.toggle("interim", interim);
    this.liveTurn = interim ? t : null;
    return t;
  }

  showInterim(text) {
    this.wake();
    this.closeCard();
    this.newTurn(text, { interim: true });
  }

  clearInterim() {
    if (this.liveTurn) { this.liveTurn.remove(); this.liveTurn = null; }
    const last = this.ui.turns.lastElementChild;
    if (last) last.classList.add("latest");
    if (!this.ui.turns.children.length) this.goIdle();
    else this.scheduleIdle();
  }

  setThinking(turn) {
    const a = turn.querySelector(".a");
    a.className = "a pending";
    a.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span><div class="tool-status"></div>';
  }

  fillReply(turn, text, error = false) {
    const a = turn.querySelector(".a");
    const n = text.length;
    a.className = `a${n > 200 ? " xlong" : n > 120 ? " long" : ""}${error ? " err" : ""}`;
    // words drift in as the reply arrives
    if (!REDUCED && text.split(/\s+/).length <= 70) a.innerHTML = splitWords(text);
    else a.textContent = text;
  }

  // Live trace events for this device: show which Nova tool is running.
  onTrace(item) {
    if (!this.pendingTurn || !isObj(item)) return;
    if (item.kind === "tool_call" && item.name) {
      const label = `${TOOL_STATUS[item.name] || `Using Nova · ${item.name}`}…`;
      const s = this.pendingTurn.querySelector(".tool-status");
      if (s) s.textContent = label;
      if (this.ui.screen.classList.contains("scanning")) this.ui.scanText.textContent = label;
    }
  }

  send(text, { source = "user" } = {}) {
    text = String(text || "").trim();
    if (!text) return Promise.resolve();
    if (this.elicit) { this.answerElicitByVoice(text); return Promise.resolve(); }
    return this.runTurn({
      text, source,
      request: () => api("/api/chat", { method: "POST", body: { device: this.id, text }, timeout: 180_000 }),
    });
  }

  // A photo for Nova (pill bottle on Rose's Echo, paperwork on Maya's).
  visionTurn(kind, image, label) {
    const say = kind === "pill" ? "Is this the right pill?" : "Can you read this paperwork for me?";
    return this.runTurn({
      text: say, source: "vision", image, label,
      scanText: kind === "pill" ? "Reading the label…" : "Reading the document…",
      request: () => api("/api/vision", { method: "POST", body: { device: this.id, kind, image }, timeout: VISION_TIMEOUT_MS }),
    });
  }

  async runTurn({ text, source = "user", request, image = null, label = "", scanText = "" }) {
    if (this.busy) { toast(`${this.shortName}'s Echo Show is still answering…`); return; }

    speech.interrupt(this.id);
    this.hideAnnouncement({ ack: "acknowledged" }); // speaking up answers whatever was on screen
    this.closeDrawer();
    this.flip(false);
    this.setBusy(true);
    this.wake();
    this.closeCard();
    this.setFollowUp(null);
    const turn = this.newTurn(text);
    this.pendingTurn = turn;
    this.setThinking(turn);
    if (image) this.showScan(image, scanText);
    this.setLight("listening");
    setTimeout(() => { if (this.busy && this.light === "listening" && !this.elicit && !this.micOn) this.setLight("thinking"); }, 450);

    const rec = inspector.beginTurn(this.id, image ? (label || text) : text, source, image);
    const gen = this.gen;
    const t0 = performance.now();
    let reply = "", cards = [], failed = false;
    try {
      const res = (await request()) || {};
      reply = String(res.reply ?? "").trim() || "Sorry, I didn't catch that.";
      cards = arr(res.cards).filter((c) => isObj(c) && typeof c.html === "string" && c.html.trim());
      if (res.brain && source !== "vision" && res.brain !== "more") status.noteBrain(res.brain); // "more" replays the details
      inspector.endTurn(rec, res, Math.round(performance.now() - t0));
    } catch (err) {
      failed = true;
      reply = image ? "Sorry, I couldn't get a good look at that. Please try again." : "Sorry, I'm having trouble reaching Nova right now.";
      inspector.endTurn(rec, null, Math.round(performance.now() - t0), err);
      toast(err.message || "Request failed", "error");
    }

    this.pendingTurn = null;
    this.setBusy(false);
    this.hideScan();
    if (gen !== this.gen) { this.settleLight(); return; } // the demo was reset mid-turn
    this.hideElicit(); // the turn is over, so any open prompt is moot
    this.fillReply(turn, reply, failed);
    this.replySeq = (this.replySeq || 0) + 1;
    if (cards.length) this.showCard(cards[cards.length - 1], reply);
    this.lastReply = reply;
    this.setLight(this.elicit ? "listening" : this.announcement ? "notify" : "idle", this.announcement ? toneFor(this.announcement, this) : "cyan");
    // A short answer that offers more gets a one-tap follow-up.
    this.setFollowUp(/want (the|more) details\??["”']?\s*$/i.test(reply) ? "Tell me more" : null);
    await sayCapped(reply, this);
    this.settleLight();
    this.scheduleIdle();
    if (!this.announcement && !this.busy) this.showNextAnnouncement();
    return reply;
  }

  /* ---- vision ---- */
  showScan(image, text) {
    this.ui.scanImg.src = image;
    this.ui.scanText.textContent = text || "Taking a close look…";
    this.ui.screen.classList.add("scanning");
  }

  hideScan() {
    this.ui.screen.classList.remove("scanning");
    setTimeout(() => { if (!this.ui.screen.classList.contains("scanning")) this.ui.scanImg.removeAttribute("src"); }, 400);
  }

  openCapture() {
    if (this.busy) { toast(`${this.shortName}'s Echo Show is busy`); return; }
    this.closeDrawer();
    this.flip(false);
    if (this.capture) { this.capture.close(); return; }
    this.capture = new CaptureSheet(this, this.visionKind);
    this.capture.open();
  }

  // Where the camera is, for the drag-to-scan drop target and the fly-in animation.
  cameraRect() { return (stage3d && stage3d.cameraRect(this.id)) || $(".camera", this.el).getBoundingClientRect(); }

  /* ---- MCP App card ---- */
  cardMaxHeight() {
    return Math.max(160, this.ui.cardFrame.clientHeight || this.size.h - 84);
  }

  // Fit the card's iframe to the space under the caption; if the view is taller, it scrolls inside
  // and the bottom edge fades with a hint instead of cutting text in half.
  fitCard() {
    const host = this.card;
    if (!host?.reportedH) return;
    const cap = this.cardMaxHeight();
    if (host.lastCap !== cap) {
      host.lastCap = cap;
      host.notify("ui/notifications/host-context-changed", { containerDimensions: { width: this.ui.cardFrame.clientWidth, maxHeight: cap } });
    }
    host.iframe.style.height = `${Math.min(host.reportedH, cap)}px`;
    this.ui.cardFrame.classList.toggle("overflowing", host.reportedH > cap + 4);
  }

  toggleCaption(force) {
    const cap = this.ui.caption, row = cap.closest(".card-caption");
    const open = force === undefined ? !row.classList.contains("expanded") : !!force;
    if (open && cap.scrollHeight <= cap.clientHeight + 1 && !row.classList.contains("expanded")) return; // nothing hidden
    row.classList.toggle("expanded", open);
    cap.setAttribute("aria-expanded", String(open));
    requestAnimationFrame(() => this.fitCard());
  }

  showCard(card, caption) {
    this.closeCard();
    const host = new AppHost(this, card);
    this.card = host;
    this.ui.caption.textContent = caption || "";
    this.ui.caption.closest(".card-caption")?.classList.remove("expanded");
    this.ui.cardFrame.classList.remove("overflowing");
    requestAnimationFrame(() => {
      const c = this.ui.caption;
      c.classList.toggle("clamped", c.scrollHeight > c.clientHeight + 1);
      c.title = c.classList.contains("clamped") ? "Tap to read it all" : "";
    });
    this.ui.cardFrame.replaceChildren(host.iframe);
    this.wake();
    this.ui.screen.classList.add("has-card");
  }

  closeCard() {
    this.ui.screen.classList.remove("has-card");
    if (!this.card) return;
    const host = this.card;
    this.card = null;
    host.teardown();
    setTimeout(() => { if (this.card !== host) host.iframe.remove(); }, 380);
    this.scheduleIdle();
  }

  /* ---- proactive announcements ---- */
  receiveAnnouncement(item) {
    if (!isObj(item)) return;
    const id = str(item.id);
    if (id && this.annSeen.has(id)) return;
    if (id) this.annSeen.add(id);
    if (!READ_STATUSES.has(str(item.status))) { this.unread++; this.renderBadge(); }
    notifications.refreshSoon(this);
    chime.play(toneFor(item, this));
    // Newest wins: in a time-lapse several can land at once; older ones stay unread in the drawer.
    if (!this.busy && !this.elicit) { this.annQueue = []; this.showAnnouncement(item, { speak: true }); }
    else { this.annQueue = [item]; this.renderAnnMore(); }
  }

  showNextAnnouncement() {
    const next = this.annQueue.pop();
    this.annQueue = [];
    if (next) this.showAnnouncement(next, { speak: true });
  }

  showAnnouncement(item, { speak = true } = {}) {
    this.announcement = item;
    this.flip(false);
    const tone = toneFor(item, this);
    let [kindLabel, icon] = ANN_KIND[str(item.kind)] || ANN_KIND.info;
    if (/refill|running low/i.test(str(item.title))) [kindLabel, icon] = ["Pharmacy", "pill"];
    const at = parseTime(item.at ?? item.due_at);
    const replies = arr(item.replies).map(str).filter(Boolean).slice(0, 4);
    const speechText = str(item.speech);
    const title = str(item.title) || kindLabel;
    const layer = this.ui.ann;
    layer.className = `announce-layer tone-${tone}`;
    layer.innerHTML = `<div class="ann">
        <button class="ann-close" type="button" aria-label="Dismiss">${ICON.x}</button>
        <div class="ann-top"><span class="ann-ico">${ICON[icon] || ICON.nova}</span><span>${esc(str(item.severity) === "urgent" ? "Urgent · " + kindLabel : kindLabel)}</span>${at ? `<span class="ann-time">${esc(fmtTime(at))}</span>` : ""}</div>
        <div class="ann-title">${splitWords(title, true)}</div>
        ${speechText ? `<div class="ann-speech${speechText.length > 150 ? " long" : ""}">${esc(speechText)}</div>` : ""}
        <div class="ann-replies">${replies.length
          ? replies.map((r, i) => `<button type="button" class="ann-reply${i === 0 ? " primary" : ""}" data-reply="${esc(r)}">${esc(r)}</button>`).join("")
          : '<button type="button" class="ann-reply primary" data-ok>OK</button>'}</div>
        <div class="ann-more"></div>
      </div>`;
    this.renderAnnMore();
    this.wake();
    this.ui.screen.classList.add("has-ann");
    this.settleLight();
    if (speak) {
      spotlight.on(this);
      speech.say(speechText || title, this, { tone });
    }
  }

  renderAnnMore() {
    const more = $(".ann-more", this.ui.ann);
    if (more) more.textContent = this.annQueue.length ? `+${this.annQueue.length} more notification${this.annQueue.length === 1 ? "" : "s"}` : "";
  }

  hideAnnouncement({ ack = null, via = "" } = {}) {
    const item = this.announcement;
    if (!item) return;
    this.announcement = null;
    this.ui.screen.classList.remove("has-ann");
    spotlight.off(this);
    if (speech.current?.device === this) speech.interrupt(this.id);
    if (ack) this.ackAnnouncement(item, ack, via);
    this.settleLight();
    this.scheduleIdle();
    // Then the next one in line, unless a turn just started (a reply chip starts one synchronously).
    setTimeout(() => { if (!this.announcement && !this.busy && !this.elicit) this.showNextAnnouncement(); }, 450);
  }

  async ackAnnouncement(item, action, via) {
    const id = str(item.id);
    if (!id) return;
    if (!READ_STATUSES.has(str(item.status))) { item.status = action; this.unread = Math.max(0, this.unread - 1); this.renderBadge(); }
    inspector.annAck(this.id, item, action, via);
    try {
      await api(`/api/announcements/${encodeURIComponent(id)}/ack`, { method: "POST", body: { device: this.id, action }, timeout: 10_000 });
    } catch { /* the badge refresh below will correct the count */ }
    notifications.refreshSoon(this);
  }

  replyAnnouncement(text) {
    this.hideAnnouncement({ ack: "acknowledged", via: text });
    return this.send(text, { source: "reply" });
  }

  // Yes/No on a simple consent prompt (same as the on-screen buttons).
  answerYesNo(yes) {
    const ev = this.elicit;
    if (!ev) return Promise.resolve();
    const keys = Object.keys(isObj(ev.schema?.properties) ? ev.schema.properties : {});
    return yes ? this.answerElicit("accept", keys.length ? { [keys[0]]: true } : {}) : this.answerElicit("decline", {});
  }

  dismissAll() {
    this.annQueue = [];
    this.announcement = null;
    this.ui.screen.classList.remove("has-ann");
    spotlight.off(this);
  }

  renderBadge() {
    const b = this.ui.badge;
    b.hidden = this.unread <= 0;
    b.textContent = this.unread > 9 ? "9+" : String(this.unread);
    this.ui.bell.classList.toggle("has-unread", this.unread > 0);
  }

  /* ---- notifications drawer ---- */
  async toggleDrawer() {
    if (!this.ui.drawer.hidden) { this.closeDrawer(); return; }
    for (const d of devices.values()) if (d !== this) d.closeDrawer();
    this.flip(false);
    this.ui.drawer.hidden = false;
    this.ui.bell.setAttribute("aria-expanded", "true");
    this.ui.drawer.innerHTML = '<div class="dr-head"><b>Notifications</b><span>Loading…</span></div>';
    const items = await notifications.fetch(this);
    if (this.ui.drawer.hidden) return;
    this.renderDrawer(items);
  }

  closeDrawer() {
    this.ui.drawer.hidden = true;
    this.ui.bell.setAttribute("aria-expanded", "false");
  }

  renderDrawer(items) {
    this.drawerItems = items;
    const unread = items.filter((a) => !READ_STATUSES.has(str(a.status))).length;
    const rows = items.map((a) => {
      const tone = toneFor(a, this);
      const [kindLabel, icon] = ANN_KIND[str(a.kind)] || ANN_KIND.info;
      const at = parseTime(a.at ?? a.due_at);
      const isUnread = !READ_STATUSES.has(str(a.status));
      return `<button type="button" class="dr-item${isUnread ? " unread" : ""}" data-ann="${esc(str(a.id))}">
        <span class="dr-ico tc-${tone}">${ICON[icon] || ICON.nova}</span>
        <span class="dr-main"><span class="dr-top"><span class="dr-title">${esc(str(a.title) || kindLabel)}</span><span class="dr-time">${at ? esc(`${dayLabel(at) === "Today" ? "" : dayLabel(at) + " "}${fmtTime(at)}`) : ""}</span></span>
        <span class="dr-speech">${esc(str(a.speech))}</span>
        <span class="dr-status">${esc(isUnread ? "New" : str(a.status) || "Read")} · ${esc(kindLabel)}</span></span></button>`;
    }).join("");
    this.ui.drawer.innerHTML = `<div class="dr-head"><b>${esc(this.shortName)}'s notifications</b><span>${unread ? `${unread} new` : "All caught up"}</span></div>
      ${rows || '<div class="dr-empty">No notifications yet. Nova speaks up when something needs attention.</div>'}`;
  }

  /* ---- elicitation ---- */
  showElicit(ev) {
    this.elicit = ev;
    this.flip(false);
    const schema = isObj(ev.schema) ? ev.schema : {};
    const props = isObj(schema.properties) ? schema.properties : {};
    const keys = Object.keys(props);
    const required = new Set(arr(schema.required));
    const simple = keys.length === 0 || (keys.length === 1 && props[keys[0]]?.type === "boolean");

    const card = document.createElement("div");
    card.className = "elicit-card";
    card.innerHTML = `
      <button class="e-close" type="button" aria-label="Dismiss">${ICON.x}</button>
      <div class="elicit-eyebrow"><span class="alexa-orb"></span>Nova is asking</div>
      <div class="elicit-q"></div>
      ${simple ? "" : '<div class="e-fields"></div>'}
      <div class="elicit-actions">${simple
        ? '<button class="e-btn primary" type="button" data-act="yes">Yes</button><button class="e-btn" type="button" data-act="no">No</button>'
        : '<button class="e-btn primary" type="button" data-act="submit">Send</button><button class="e-btn" type="button" data-act="decline">Not now</button>'}</div>`;
    $(".elicit-q", card).textContent = ev.message || "Is that OK?";
    const fields = $(".e-fields", card);
    if (fields) buildFields(fields, props, keys);

    card.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !card.contains(btn)) return;
      if (btn.classList.contains("e-close")) { this.answerElicit("cancel", {}); return; }
      const seg = btn.closest(".e-seg");
      if (seg) {
        for (const b of seg.children) b.classList.toggle("on", b === btn);
        return;
      }
      switch (btn.dataset.act) {
        case "yes": this.answerElicit("accept", keys.length ? { [keys[0]]: true } : {}); break;
        case "no": this.answerElicit("decline", {}); break;
        case "decline": this.answerElicit("decline", {}); break;
        case "submit": {
          const content = collectFields(fields, props, required);
          if (content) this.answerElicit("accept", content);
          break;
        }
        default: break;
      }
    });

    this.ui.elicit.replaceChildren(card);
    this.wake();
    this.ui.screen.classList.add("has-elicit");
    this.setLight("listening");
    speech.say(ev.message, this);
  }

  hideElicit(id) {
    if (!this.elicit) return;
    if (id !== undefined && String(this.elicit.id) !== String(id)) return;
    this.elicit = null;
    this.ui.screen.classList.remove("has-elicit");
    setTimeout(() => { if (!this.elicit) this.ui.elicit.replaceChildren(); }, 300);
    this.settleLight();
  }

  async answerElicit(action, content) {
    const ev = this.elicit;
    if (!ev) return;
    speech.interrupt(this.id);
    this.hideElicit();
    try {
      await api(`/api/elicit/${encodeURIComponent(ev.id)}`, { method: "POST", body: { action, content: content || {} }, timeout: 15_000 });
    } catch (err) {
      toast(`Couldn't send the answer: ${err.message}`, "error");
    }
  }

  // Spoken/typed "yes" or "no" answers a simple yes/no prompt.
  answerElicitByVoice(text) {
    const ev = this.elicit;
    const props = isObj(ev?.schema?.properties) ? ev.schema.properties : {};
    const keys = Object.keys(props);
    const simple = keys.length === 0 || (keys.length === 1 && props[keys[0]]?.type === "boolean");
    if (!simple) { toast("Please answer on the screen."); return; }
    const t = text.toLowerCase().replace(/^alexa[, ]+/, "").trim();
    if (/^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead|of course|absolutely|do it|share|that's fine|fine|correct)\b/.test(t)) {
      this.answerElicit("accept", keys.length ? { [keys[0]]: true } : {});
    } else if (/^(no|nope|nah|don't|do not|not now|never|cancel|stop)\b/.test(t)) {
      this.answerElicit("decline", {});
    } else {
      toast("Say “yes” or “no”, or tap an answer.");
    }
  }

  // Clear what's on screen (used after a reset or a clock jump).
  clearScreen() {
    clearTimeout(this.idleTimer);
    this.closeCard();
    this.hideElicit();
    this.dismissAll();
    this.capture?.close();
    this.hideScan();
    this.liveTurn = null;
    this.ui.screen.classList.remove("active");
    this.ui.turns.replaceChildren();
    this.setLight("idle");
  }

  reset() {
    this.gen++;
    this.clearScreen();
    this.annSeen.clear();
    this.unread = 0;
    this.renderBadge();
    this.closeDrawer();
    this.flip(false);
    this.ring?.reset();
    this.ui.backList.innerHTML = '<p class="back-empty">This Echo\'s turns, tool calls and proactive messages appear here.</p>';
  }
}

// Render simple inputs from a flat JSON schema (MCP elicitation's restricted subset).
function buildFields(container, props, keys) {
  for (const k of keys) {
    const p = isObj(props[k]) ? props[k] : {};
    const f = document.createElement("div");
    f.className = "e-field";
    f.dataset.key = k;
    const label = p.title || k.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    const enumVals = Array.isArray(p.enum) ? p.enum : Array.isArray(p.oneOf) ? p.oneOf.map((o) => o?.const).filter((v) => v !== undefined) : null;
    const enumLabels = Array.isArray(p.enumNames) ? p.enumNames : Array.isArray(p.oneOf) ? p.oneOf.map((o) => o?.title ?? o?.const) : null;

    if (p.type === "boolean") {
      f.dataset.kind = "bool";
      f.innerHTML = '<label class="e-toggle"><input type="checkbox"><span></span></label>';
      $("input", f).checked = !!p.default;
      $("span", f).textContent = label;
    } else if (enumVals && enumVals.length) {
      f.dataset.kind = "enum";
      f._values = enumVals;
      f.innerHTML = '<label></label><div class="e-seg" role="radiogroup"></div>';
      $("label", f).textContent = label;
      const seg = $(".e-seg", f);
      enumVals.forEach((v, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.i = String(i);
        b.textContent = String(enumLabels?.[i] ?? v);
        if (p.default !== undefined && p.default === v) b.classList.add("on");
        seg.append(b);
      });
    } else {
      const numeric = p.type === "number" || p.type === "integer";
      f.dataset.kind = numeric ? "num" : "str";
      f.innerHTML = '<label></label><input>';
      const id = `e-${k}-${Math.random().toString(36).slice(2, 7)}`;
      const lab = $("label", f), inp = $("input", f);
      lab.textContent = label;
      lab.htmlFor = id;
      inp.id = id;
      inp.type = numeric ? "number" : "text";
      if (numeric) {
        if (p.minimum !== undefined) inp.min = p.minimum;
        if (p.maximum !== undefined) inp.max = p.maximum;
        inp.step = p.type === "integer" ? "1" : "any";
      } else if (p.maxLength) inp.maxLength = p.maxLength;
      if (p.default !== undefined) inp.value = p.default;
    }
    if (p.description && f.dataset.kind !== "bool") {
      const d = document.createElement("div");
      d.className = "e-desc";
      d.textContent = p.description;
      f.firstElementChild.after(d);
    }
    container.append(f);
  }
}

function collectFields(container, props, required) {
  const out = {};
  let ok = true;
  for (const f of container.querySelectorAll(".e-field")) {
    const k = f.dataset.key;
    const p = isObj(props[k]) ? props[k] : {};
    let v;
    if (f.dataset.kind === "bool") v = $("input", f).checked;
    else if (f.dataset.kind === "enum") {
      const on = $(".e-seg button.on", f);
      v = on ? f._values[Number(on.dataset.i)] : undefined;
    } else {
      const raw = $("input", f).value.trim();
      if (raw !== "") v = f.dataset.kind === "num" ? (p.type === "integer" ? parseInt(raw, 10) : parseFloat(raw)) : raw;
      if (typeof v === "number" && Number.isNaN(v)) v = undefined;
    }
    const missing = v === undefined && required.has(k);
    f.classList.toggle("invalid", missing);
    if (missing) ok = false;
    if (v !== undefined) out[k] = v;
  }
  return ok ? out : null;
}

/* ============================================================ motion loop */

// One rAF loop springs all devices (orbit, flip, cursor tilt) and sleeps when everything is still.
let motionRaf = 0;
let activeDevice = null;
function kickMotion() {
  if (motionRaf) return;
  const loop = () => {
    let moving = false;
    for (const d of devices.values()) moving = d.step() || moving;
    motionRaf = moving ? requestAnimationFrame(loop) : 0;
  };
  motionRaf = requestAnimationFrame(loop);
}

// Subtle tilt toward the cursor; off while the pointer is over a screen so taps stay precise.
function trackTilt(e) {
  if (stage3d) return;
  for (const d of devices.values()) {
    const r = d.ui.hw.getBoundingClientRect();
    if (!r.width) continue;
    const fit = d.ui.fit.getBoundingClientRect();
    const overScreen = e.clientX >= fit.left && e.clientX <= fit.right && e.clientY >= fit.top && e.clientY <= fit.bottom;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const nx = clamp((e.clientX - cx) / (window.innerWidth / 2), -1, 1), ny = clamp((e.clientY - cy) / (window.innerHeight / 2), -1, 1);
    d.m.tty = overScreen || window.scrollY > 40 ? 0 : nx * 4;
    d.m.ttx = overScreen || window.scrollY > 40 ? 0 : -ny * 2.5;
  }
  kickMotion();
}

// Magnetic hover: elements lean a few pixels toward the cursor.
function magnetic(container, selector) {
  if (REDUCED) return;
  container.addEventListener("pointermove", (e) => {
    const el = e.target.closest(selector);
    if (!el || !container.contains(el)) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${((e.clientX - r.left - r.width / 2) * 0.18).toFixed(1)}px`);
    el.style.setProperty("--my", `${((e.clientY - r.top - r.height / 2) * 0.3).toFixed(1)}px`);
  });
  container.addEventListener("pointerout", (e) => {
    const el = e.target.closest(selector);
    if (el && !el.contains(e.relatedTarget)) { el.style.removeProperty("--mx"); el.style.removeProperty("--my"); }
  });
}

/* ============================================================== spotlight */

// When a device speaks first, the scene dims around it for a few seconds.
const spotlight = {
  timer: 0,
  dev: null,
  on(device) {
    if (REDUCED) return;
    const scene = $("#scene"), r = device.screenRect(), s = scene.getBoundingClientRect();
    scene.style.setProperty("--sx", `${r.left - s.left + r.width / 2}px`);
    scene.style.setProperty("--sy", `${r.top - s.top + r.height / 2}px`);
    for (const d of devices.values()) d.el.classList.toggle("spot", d === device);
    scene.classList.add("spot");
    this.dev = device;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.off(), 5_200);
  },
  off(device) {
    if (device && device !== this.dev) return;
    clearTimeout(this.timer);
    $("#scene").classList.remove("spot");
    for (const d of devices.values()) d.el.classList.remove("spot");
    this.dev = null;
  },
};

/* ============================================================ capture sheet */

// "Show Alexa" / "Scan paperwork": webcam, upload, or a sample photo.
class CaptureSheet {
  constructor(device, kind) {
    this.device = device;
    this.kind = kind;
    this.stream = null;
    this.el = null;
    this.camOK = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false;
  }

  open() {
    const pill = this.kind === "pill";
    const list = samples.of(this.kind);
    const el = document.createElement("div");
    el.className = "capture";
    el.innerHTML = `
      <div class="cap-head">
        <div><div class="cap-title">${pill ? "Show Alexa a pill bottle" : "Scan paperwork"}</div>
        <div class="cap-sub">${pill ? "Nova reads the label and checks it against today's plan." : "Nova reads the document and proposes care-plan changes."}</div></div>
        <button class="icon-btn sm" type="button" data-close title="Close">${ICON.x}</button>
      </div>
      <div class="cap-body${this.camOK ? "" : " no-cam"}">
        ${this.camOK ? `<div class="cap-cam">
          <div class="cap-video"><div class="cap-ph">${ICON.camera}<span>Use this computer's camera</span></div></div>
          <div class="cap-row"><button class="cap-btn" type="button" data-cam>${ICON.camera}Start camera</button>
          <button class="cap-btn primary" type="button" data-shoot hidden>${ICON.shutter}Capture</button></div>
        </div>` : ""}
        <div class="cap-side">
          <span class="cap-k">${list.length ? (pill ? "Sample bottles" : "Sample documents") : "Photos"}</span>
          ${list.length ? `<div class="cap-samples">${list.map((s, i) => `<button class="cap-sample" type="button" data-sample="${i}" title="${esc(str(s.label))}">
            <img src="${esc(str(s.url))}" alt="" loading="lazy"><span>${esc(str(s.label) || "Sample")}</span></button>`).join("")}</div>`
            : '<span class="cap-note">No samples available from the simulator.</span>'}
          <button class="cap-btn" type="button" data-upload>${ICON.upload}Upload photo</button>
          <input type="file" accept="image/*" hidden>
        </div>
      </div>`;
    this.el = el;
    this.list = list;
    el.addEventListener("click", (e) => this.onClick(e));
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    $("input[type=file]", el).addEventListener("change", (e) => this.fromFile(e.target.files?.[0]));
    (stage3d ? this.device.el : this.device.ui.hw).append(el);
  }

  onClick(e) {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-close")) this.close();
    else if (b.hasAttribute("data-cam")) this.startCamera(b);
    else if (b.hasAttribute("data-shoot")) this.shoot();
    else if (b.hasAttribute("data-upload")) $("input[type=file]", this.el).click();
    else if (b.dataset.sample !== undefined) this.fromSample(this.list[Number(b.dataset.sample)]);
  }

  async startCamera(btn) {
    try {
      btn.disabled = true;
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
      if (!this.el) { this.stopCamera(); return; }
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = this.stream;
      $(".cap-video", this.el).replaceChildren(video);
      await video.play();
      btn.hidden = true;
      $("[data-shoot]", this.el).hidden = false;
    } catch {
      btn.disabled = false;
      toast("The camera isn't available. Try a sample or upload a photo.", "error");
    }
  }

  shoot() {
    const video = $("video", this.el);
    if (!video || !video.videoWidth) return;
    const c = document.createElement("canvas");
    const k = Math.min(1, IMG_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.round(video.videoWidth * k);
    c.height = Math.round(video.videoHeight * k);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    this.choose(c.toDataURL("image/jpeg", 0.9), "Camera photo");
  }

  async fromSample(s) {
    if (!s) return;
    try { this.choose(await urlToDataURL(str(s.url)), str(s.label)); } catch (err) { toast(err.message || "Couldn't load that sample", "error"); }
  }

  async fromFile(file) {
    if (!file) return;
    try { this.choose(await imageToDataURL(file), file.name || "Photo"); } catch (err) { toast(err.message || "Couldn't read that photo", "error"); }
  }

  choose(dataURL, label) {
    const device = this.device, kind = this.kind;
    this.close();
    device.visionTurn(kind, dataURL, label);
  }

  stopCamera() {
    for (const t of this.stream?.getTracks?.() || []) t.stop();
    this.stream = null;
  }

  close() {
    this.stopCamera();
    this.el?.remove();
    this.el = null;
    if (this.device.capture === this) this.device.capture = null;
  }
}

/* ================================================================= Ring panel */

function ringHookLine(res) {
  if (!isObj(res) || !res.ring_type) return "";
  const verified = res.signature_verified ?? res.verified ?? !!res.signal;
  return ["Ring Webhook v1.1", str(res.ring_type), verified ? "signature verified" : "unverified"].join(" · ");
}

class RingPanel {
  constructor(device) {
    this.device = device;
    this.el = $("#ringTpl").content.firstElementChild.cloneNode(true);
    this.lastV = $(".rl-v", this.el);
    this.hookV = $(".rp-hook", this.el);
    this.time = $(".rv-time", this.el);
    this.banner = $(".rv-banner", this.el);
    this.timers = [];
    this.openedAt = 0;
    this.pop = $(".ring-pop", this.el);
    this.moreBtn = $(".ring-more", this.el);
    this.el.addEventListener("click", (e) => {
      if (e.target.closest(".ring-more")) { e.stopPropagation(); this.togglePop(); return; }
      const b = e.target.closest("button[data-kind]");
      if (b) { this.togglePop(false); this.trigger(b.dataset.kind, b.dataset.who, b); }
    });
    document.addEventListener("click", (e) => {
      if (!this.pop.hidden && !this.el.contains(e.target) && performance.now() - this.openedAt > 350) this.togglePop(false);
    });
    magnetic($(".ring-btns", this.el), "button");
  }

  togglePop(force) {
    const open = force === undefined ? this.pop.hidden : !!force;
    if (open && this.pop.hidden) this.openedAt = performance.now();
    this.pop.hidden = !open;
    this.moreBtn.setAttribute("aria-expanded", String(open));
  }

  // The porch view shows only while something is happening at the door.
  showLive(ms = 6500) {
    clearTimeout(this.liveT);
    this.el.classList.add("live-on");
    this.liveT = setTimeout(() => this.el.classList.remove("live-on"), ms);
  }

  tick(now) {
    const s = `${now.toLocaleDateString("en-US", { weekday: "short" })} ${fmtClockSec(now)}`;
    if (this.time.textContent !== s) this.time.textContent = s;
    const h = now.getHours() + now.getMinutes() / 60;
    const tod = h >= 7 && h < 17.5 ? "day" : (h >= 17.5 && h < 20) || (h >= 6 && h < 7) ? "dusk" : "night";
    if (this.el.dataset.tod !== tod) this.el.dataset.tod = tod;
  }

  later(fn, ms) { this.timers.push(setTimeout(fn, ms)); }

  clearAnim() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.el.classList.remove("show-grace", "show-courier", "show-rose", "show-cat", "ev-ding", "ev-motion", "banner-on", "flash");
  }

  // Play the event in the illustrated live view.
  animate(kind, who) {
    this.clearAnim();
    void this.el.offsetWidth; // restart CSS animations
    const label = { grace: "Grace", delivery: "Delivery", rose: "Rose", unknown: "Someone" }[who] || "Someone";
    if (kind === "ding") {
      this.el.classList.add("ev-ding", "banner-on", who === "delivery" ? "show-courier" : "show-grace");
      this.banner.textContent = `Ding · ${label} at the front door`;
      if (who === "delivery") this.later(() => { this.el.classList.remove("show-courier"); this.el.classList.add("has-box"); }, 3800);
      else this.later(() => this.el.classList.remove("show-grace"), 9000);
    } else if (kind === "door_open") {
      this.el.classList.remove("has-box");
      this.el.classList.add("show-rose", "banner-on");
      this.banner.textContent = "Front door opened";
    } else {
      this.el.classList.add("ev-motion", "show-cat", "banner-on");
      this.banner.textContent = "Motion detected";
    }
    this.later(() => this.el.classList.remove("banner-on"), 3600);
  }

  // "Ring Webhook v1.1 · button_press · signature verified" when the event came in the partner format.
  setHook(res) {
    if (!this.hookV) return;
    const line = ringHookLine(res);
    this.hookV.textContent = line;
    this.hookV.hidden = !line;
  }

  setLast(text, at) {
    this.lastV.innerHTML = `${esc(text)}${at ? `<time>${esc(fmtTime(at))}</time>` : ""}`;
    this.lastV.title = text;
    this.el.classList.remove("flash");
    void this.el.offsetWidth;
    this.el.classList.add("flash");
  }

  async trigger(kind, who) {
    for (const b of this.el.querySelectorAll(".ring-btns button")) b.disabled = true;
    setTimeout(() => { for (const b of this.el.querySelectorAll(".ring-btns button")) b.disabled = false; }, 1200);
    this.animate(kind, who);
    this.showLive(kind === "door_open" ? 8000 : 6500);
    stage3d?.ringFlash(kind);
    const fallback = RING_FALLBACK[`${kind}:${who}`] || "Front door event";
    const rec = inspector.beginRing(this.device.id, kind, who);
    const t0 = performance.now();
    try {
      const res = await api("/api/ring/event", { method: "POST", body: { kind, who }, timeout: 20_000 });
      const sig = res?.signal;
      const text = typeof sig === "string" ? sig : isObj(sig) ? str(sig.text || sig.summary || sig.label) : "";
      this.setLast(text || fallback, (isObj(sig) && parseTime(sig.at)) || clock.now());
      this.setHook(res);
      inspector.endRing(rec, res, Math.round(performance.now() - t0));
    } catch (err) {
      this.setLast(fallback, clock.now());
      inspector.endRing(rec, null, Math.round(performance.now() - t0), err);
      toast(`Ring event failed: ${err.message}`, "error");
    }
    circleFeed.refreshSoon();
  }

  reset() {
    this.clearAnim();
    this.el.classList.remove("has-box");
    this.lastV.textContent = "Quiet so far";
    this.setHook(null);
  }
}

/* ============================================================ the tray (drag to scan) */

// Small 3D objects: pill bottles for Rose's Echo, the paperwork for Maya's. Drag one onto the
// right device (its camera lights up), or click it as a fallback.
const tray = {
  el: null,
  render(kind = "pill") {
    const slot = $("#sdThings");
    const pills = kind === "pill" ? samples.of("pill") : [], docs = kind === "document" ? samples.of("document") : [];
    if (!pills.length && !docs.length) { slot.innerHTML = ""; return; }
    // Bottle looks: amber Rx bottles; white metformin; ibuprofen is an OTC white bottle with a blue cap.
    const look = (name, i) => (/ibuprofen/i.test(name) ? "white blue otc" : /metformin/i.test(name) ? "white" : i % 3 === 1 ? "blue" : "");
    const bottle = (s, i) => {
      const name = str(s.label).replace(/\s*bottle\s*/i, " ").trim() || "Bottle";
      return `<button class="thing" type="button" data-sample="${esc(str(s.id || s.url))}" data-kind="pill" aria-label="Drag ${esc(name)} onto Rose's Echo">
        <span class="bottle ${look(name, i)}"><span class="cap"></span><span class="body"></span><span class="lab"><span>${esc(name.toUpperCase())}</span></span></span>
        <span class="t-label">${esc(name)}</span></button>`;
    };
    const paper = (s) => `<button class="thing" type="button" data-sample="${esc(str(s.id || s.url))}" data-kind="document" aria-label="Drag ${esc(str(s.label))} onto Maya's Echo">
        <span class="paper"></span><span class="t-label">${esc(str(s.label) || "Paperwork")}</span></button>`;
    slot.innerHTML = `<div class="tray"><div class="shelf">${pills.slice(0, 4).map(bottle).join("")}${docs.slice(0, 2).map(paper).join("")}</div></div>`;
    this.el = $(".tray", slot);
    this.el.addEventListener("pointerdown", (e) => this.down(e));
  },
  sample(id) { return samples.list.find((s) => str(s.id || s.url) === id); },
  target(kind) { return [...devices.values()].find((d) => d.visionKind === kind); },
  down(e) {
    const thing = e.target.closest(".thing");
    if (!thing || e.button !== 0) return;
    e.preventDefault();
    const s = this.sample(thing.dataset.sample);
    const dev = this.target(thing.dataset.kind);
    if (!s || !dev) return;
    const ghost = $("#dragGhost");
    const r = thing.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    let started = false, over = false;
    const sx = e.clientX, sy = e.clientY;
    thing.setPointerCapture(e.pointerId);
    const place = (x, y, rot = -8, sc = 1.18) => { ghost.style.transform = `translate3d(${x - ox}px, ${y - oy}px, 0) rotate(${rot}deg) scale(${sc})`; };
    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        started = true;
        ghost.className = "drag-ghost on";
        ghost.innerHTML = thing.innerHTML;
        ghost.style.width = `${r.width}px`;
        thing.classList.add("lifted");
        dev.el.classList.add("drop-ok");
        if (dev.busy) toast(`${dev.shortName}'s Echo Show is busy`);
      }
      place(ev.clientX, ev.clientY, clamp((ev.clientX - sx) * 0.04, -14, 14) - 6);
      const h = dev.ui.hw.getBoundingClientRect();
      over = ev.clientX > h.left - 30 && ev.clientX < h.right + 30 && ev.clientY > h.top - 40 && ev.clientY < h.bottom + 20;
      dev.el.classList.toggle("drop-over", over);
    };
    const up = async (ev) => {
      thing.removeEventListener("pointermove", move);
      thing.removeEventListener("pointerup", up);
      thing.removeEventListener("pointercancel", up);
      dev.el.classList.remove("drop-ok", "drop-over");
      if (!started) { shelf.close(); this.scan(dev, s); return; } // a plain click
      if (over && !dev.busy && ev.type === "pointerup") {
        // fly into the camera, then scan
        const c = dev.cameraRect();
        ghost.classList.add("fly");
        ghost.style.transform = `translate3d(${c.left + c.width / 2 - ox}px, ${c.top + c.height / 2 - oy}px, 0) rotate(0deg) scale(.12)`;
        ghost.style.opacity = "0";
        setTimeout(() => { ghost.className = "drag-ghost"; ghost.style.opacity = ""; ghost.innerHTML = ""; thing.classList.remove("lifted"); }, 560);
        shelf.close();
        this.scan(dev, s);
      } else {
        // spring back to the shelf
        ghost.classList.add("fly");
        place(r.left + ox, r.top + oy, 0, 1);
        setTimeout(() => { ghost.className = "drag-ghost"; ghost.innerHTML = ""; thing.classList.remove("lifted"); }, 560);
      }
    };
    thing.addEventListener("pointermove", move);
    thing.addEventListener("pointerup", up);
    thing.addEventListener("pointercancel", up);
  },
  async scan(dev, s) {
    if (dev.busy) { toast(`${dev.shortName}'s Echo Show is busy`); return null; }
    try {
      const image = await urlToDataURL(str(s.url));
      return await dev.visionTurn(s.kind === "document" ? "document" : "pill", image, str(s.label));
    } catch (err) {
      toast(err.message || "Couldn't load that sample", "error");
      return null;
    }
  },
  // Scripted version of the drag: the object lifts off the shelf and flies into the camera.
  async flyAndScan(dev, s) {
    if (stage3d) return stage3d.presentSample(s, dev);
    const thing = this.el?.querySelector(`.thing[data-sample="${CSS.escape(str(s.id || s.url))}"]`);
    if (thing && !REDUCED) {
      const ghost = $("#dragGhost");
      const r = thing.getBoundingClientRect(), c = dev.cameraRect();
      ghost.className = "drag-ghost on";
      ghost.innerHTML = thing.innerHTML;
      ghost.style.width = `${r.width}px`;
      ghost.style.transform = `translate3d(${r.left}px, ${r.top}px, 0) rotate(0deg) scale(1)`;
      thing.classList.add("lifted");
      dev.el.classList.add("drop-ok");
      await sleep(30);
      ghost.classList.add("fly");
      ghost.style.transition = "transform 1.1s cubic-bezier(.22,1,.36,1)";
      ghost.style.transform = `translate3d(${(r.left + c.left) / 2}px, ${Math.min(r.top, c.top) - 60}px, 0) rotate(-10deg) scale(1.25)`;
      await sleep(900);
      dev.el.classList.add("drop-over");
      ghost.style.transition = "transform .6s cubic-bezier(.22,1,.36,1), opacity .6s";
      ghost.style.transform = `translate3d(${c.left + c.width / 2 - r.width / 2}px, ${c.top}px, 0) rotate(0deg) scale(.12)`;
      ghost.style.opacity = "0";
      await sleep(600);
      dev.el.classList.remove("drop-ok", "drop-over");
      ghost.className = "drag-ghost"; ghost.style.cssText = ""; ghost.innerHTML = "";
      thing.classList.remove("lifted");
    }
    return this.scan(dev, s);
  },
};

/* ============================================================ shelf drawer */

// "Show Alexa" / "Scan paperwork": a slim shelf slides up with just that device's things.
const shelf = {
  device: null,
  get open() { return !!this.device; },
  toggle(device) { if (this.device === device) this.close(); else this.show(device); },
  show(device) {
    if (device.busy) { toast(`${device.shortName}'s Echo Show is busy`); return; }
    this.close(true);
    this.device = device;
    const kind = device.visionKind;
    $("#sdTitle").textContent = kind === "pill" ? "Show Alexa" : "Scan paperwork";
    $("#sdHint").textContent = kind === "pill" ? `Drag a bottle onto ${device.shortName}'s Echo` : `Drag the paperwork onto ${device.shortName}'s Echo`;
    if (stage3d) stage3d.openShelf(kind);
    else tray.render(kind);
    const d = $("#shelfDrawer");
    d.classList.add("open");
    d.setAttribute("aria-hidden", "false");
    document.body.classList.add("shelf-open");
    device.ui.visionBtn.setAttribute("aria-expanded", "true");
  },
  close(silent) {
    const d = $("#shelfDrawer");
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
    document.body.classList.remove("shelf-open");
    this.device?.ui.visionBtn.setAttribute("aria-expanded", "false");
    this.device = null;
    if (stage3d && !silent) stage3d.closeShelf();
  },
  init() {
    $("#sdClose").addEventListener("click", () => this.close());
    $("#sdCamera").addEventListener("click", () => { const d = this.device; this.close(); d?.openCapture(); });
    $("#sdUpload").addEventListener("click", () => $("#sdFile").click());
    $("#sdFile").addEventListener("change", async (e) => {
      const file = e.target.files?.[0], d = this.device;
      e.target.value = "";
      if (!file || !d) return;
      this.close();
      try { d.visionTurn(d.visionKind, await imageToDataURL(file), file.name || "Photo"); } catch (err) { toast(err.message || "Couldn't read that photo", "error"); }
    });
  },
};

/* =================================================================== layout */

let focusId = null;
function toggleFocus(id) {
  const box = $("#devices");
  focusId = focusId === id || !devices.has(id) ? null : id;
  for (const d of devices.values()) d.el.classList.toggle("focused", d.id === focusId);
  if (focusId) box.dataset.focus = focusId; else delete box.dataset.focus;
  document.body.classList.toggle("focusing", !!focusId);
  if (!stage3d) $("#ringSlot").hidden = focusId === "maya";
  stage3d?.setFocus(focusId);
  layout();
}

// Size both Echo Shows so they read as hero objects of comparable weight and everything fits.
function layout() {
  if (stage3d) {
    stage3d.layout();
    requestAnimationFrame(() => { arc.measure(0); for (const d of devices.values()) d.fitChips(); });
    return;
  }
  const scene = $("#scene");
  const W = scene.clientWidth, H = scene.clientHeight;
  const narrow = window.innerWidth <= 900;
  const list = [...devices.values()].filter((d) => !focusId || d.id === focusId);
  if (!list.length) return;
  const spec = (d) => d.model === "show8"
    ? { aspect: 1.6, bz: 0.028, chin: 0.034, t: 0.075, radius: 0.04, ratio: 1 }
    : { aspect: 1.7778, bz: 0.019, chin: 0, t: 0.036, radius: 0.022, ratio: 1.12 };
  const objH = (d, w) => { const s = spec(d); return (w - 2 * s.bz * w) / s.aspect + 2 * s.bz * w + s.chin * w; };
  const gap = narrow ? 54 : clamp(W * 0.06, 48, 120);
  const pad = narrow ? 32 : 320; // the Ring label lives at the left edge
  let widths;
  if (narrow) {
    widths = list.map(() => Math.min(W - pad, 760));
  } else {
    const ratios = list.map((d) => spec(d).ratio);
    const sum = ratios.reduce((a, b) => a + b, 0);
    const byW = (W - pad - gap * (list.length - 1)) / sum;
    const below = 22 + 52 + 50 + 46 + 40; // name lines, control row, pill row, padding
    const hMax = H - 168 - below;
    // the tallest object at unit width decides the height budget
    const byH = Math.min(...list.map((d, i) => hMax / objH(d, ratios[i])));
    const unit = clamp(Math.min(byW, byH), 220, focusId ? 980 : 820);
    widths = ratios.map((r) => unit * r);
  }
  list.forEach((d, i) => {
    const s = spec(d), w = Math.round(widths[i]);
    const st = d.el.style;
    st.setProperty("--col-w", `${w}px`);
    st.setProperty("--w", `${w}px`);
    st.setProperty("--h", `${Math.round(objH(d, w))}px`);
    st.setProperty("--bz", `${Math.max(9, Math.round(s.bz * w))}px`);
    st.setProperty("--chin", `${Math.round(s.chin * w)}px`);
    st.setProperty("--t", `${Math.max(10, Math.round(s.t * w))}px`);
    st.setProperty("--radius", `${Math.max(12, Math.round(s.radius * w))}px`);
  });
  const stage = $("#stage");
  stage.style.setProperty("--gap", `${gap}px`);
  // foot slots line up under their devices (Ring under Rose, the tray under Maya)
  const rose = devices.get("kitchen"), maya = devices.get("maya");

  for (const d of list) d.fit();
  requestAnimationFrame(() => { for (const d of list) d.fitChips(); });

  // horizon at the bottom of the objects; the arc lives above their tops
  requestAnimationFrame(() => {
    const s = scene.getBoundingClientRect();
    let top = Infinity, bottom = 0;
    for (const d of list) { const r = d.ui.hw.getBoundingClientRect(); top = Math.min(top, r.top - s.top); bottom = Math.max(bottom, r.bottom - s.top); }
    if (!narrow && Number.isFinite(top)) document.documentElement.style.setProperty("--hz", `${(bottom / H * 100).toFixed(2)}%`);
    arc.measure(Number.isFinite(top) ? top : H * 0.3);
  });
}

function mountDevices(defs) {
  const box = $("#devices");
  const list = arr(defs).filter((d) => isObj(d) && d.id);
  for (const def of list) {
    const existing = devices.get(def.id);
    if (existing) { existing.applyDef(def); continue; }
    const dev = new Device(def);
    devices.set(def.id, dev);
    box.append(dev.el);
    dev.tick(clock.now());
    dev.step();
  }
  // Drop placeholder devices that the backend doesn't know about.
  const ids = new Set(list.map((d) => d.id));
  for (const [id, dev] of devices) {
    if (!ids.has(id)) { dev.reset(); dev.el.remove(); devices.delete(id); }
  }
  layout();
}

/* ============================================================= notifications */

const notifications = {
  timers: new Map(),
  async fetch(device) {
    try {
      const res = await api(`/api/announcements?device=${encodeURIComponent(device.id)}`, { timeout: 10_000 });
      const items = arr(res?.items).filter(isObj);
      for (const a of items) if (a.id !== undefined) device.annSeen.add(str(a.id));
      device.unread = items.filter((a) => !READ_STATUSES.has(str(a.status))).length;
      device.renderBadge();
      return items;
    } catch {
      return [];
    }
  },
  refreshSoon(device) {
    clearTimeout(this.timers.get(device.id));
    this.timers.set(device.id, setTimeout(async () => {
      const items = await this.fetch(device);
      if (!device.ui.drawer.hidden) device.renderDrawer(items);
    }, 600));
  },
};

/* ================================================================== top bar */

const FAST_FORWARD = 120; // one minute of household time every half second

// short names for the bar; the full label stays in the tooltip
function shortBrain(label) {
  const s = String(label || "");
  if (/offline router/i.test(s)) return "Offline router";
  return s.replace(/\s*·\s*Amazon Bedrock$/i, "") || "Unknown";
}

const topbar = {
  lastText: "",
  init() {
    // one control: normal time, or fast-forward (the API still takes any speed, e.g. for the recorder)
    $("#ffBtn").addEventListener("click", () => this.setSpeed(clock.speed > 1 ? 1 : FAST_FORWARD));
    this.render();
  },

  render() {
    const now = clock.now();
    const t = fmtTime(now);
    const day = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    if (this.lastText !== t + day) {
      this.lastText = t + day;
      const [hm, ap] = t.split(" ");
      $("#hhTime").textContent = hm;
      $("#hhAmPm").textContent = (ap || "").toLowerCase();
      $("#hhDay").textContent = `${day} · Columbus`;
    }
    const lapse = clock.speed > 1;
    document.body.classList.toggle("lapse", lapse);
    const ff = $("#ffBtn");
    if (ff) {
      ff.setAttribute("aria-pressed", String(lapse));
      ff.title = lapse ? `Fast-forwarding (${Math.round(clock.speed)}×). Click for normal time.` : "Fast-forward the household clock";
    }
  },

  async post(body) {
    const res = await api("/api/clock", { method: "POST", body, timeout: 20_000 });
    if (isObj(res)) clock.sync(res.now, res.speed);
    return res;
  },

  async setSpeed(speed) {
    const prev = clock.speed;
    clock.sync(null, speed); // feels instant; the server confirms
    try { await this.post({ speed }); } catch (err) { clock.sync(null, prev); toast(`Couldn't change the clock: ${err.message}`, "error"); }
  },

  // Jumping the clock can re-seed the household on the server, so start each device fresh.
  async jump(time) {
    speech.stopAll();
    for (const d of devices.values()) d.clearScreen();
    try {
      await this.post({ time });
      circleFeed.load();
      for (const d of devices.values()) { d.annSeen.clear(); notifications.refreshSoon(d); d.ring?.reset(); }
    } catch (err) {
      toast(`Couldn't change the clock: ${err.message}`, "error");
    }
  },
};

/* ================================================================== inspector */

function traceTag(label) { return `<span class="ti-tag">${esc(label)}</span>`; }
function traceName(name, plain = false) { return `<span class="ti-name${plain ? " plain" : ""}">${esc(name)}</span>`; }
function brainName(b) { return typeof b === "string" ? b : isObj(b) ? b.label || b.name || "" : ""; }
function argsHTML(args) {
  if (args === undefined || args === null || (isObj(args) && !Object.keys(args).length)) return '<code class="inline">{}</code>';
  let compact = "";
  try { compact = JSON.stringify(args); } catch { compact = String(args); }
  return compact.length <= 70 ? `<code class="inline">${jsonHTML(args, false)}</code>` : `<pre class="code">${jsonHTML(args)}</pre>`;
}
function jsonDetails(label, value, open = false) {
  return `<details class="json"${open ? " open" : ""}><summary>${esc(label)}</summary><pre class="code">${jsonHTML(value)}</pre></details>`;
}
function compactArgs(a) {
  if (!isObj(a)) return "";
  return Object.entries(a).map(([k, v]) => `${k}: ${clip(JSON.stringify(v) ?? "", 40)}`).join(", ");
}

const TRACE_KINDS = ["user", "llm", "tool_call", "tool_result", "elicit", "elicit_answer", "reply", "error", "app_call",
  "announcement", "ann_ack", "ring", "ring_event", "ring_result", "ring_webhook"];

function renderTraceItem(item, start) {
  const kind = TRACE_KINDS.includes(item.kind) ? item.kind : "other";
  const el = document.createElement("div");
  el.className = `ti k-${kind === "ring" ? "ring_event" : kind}`;
  const at = parseTime(item.at);
  const rel = at && start ? Math.max(0, at - start) : null;
  const relHTML = rel !== null && rel < 3_600_000 ? `<span class="ti-ms">+${(rel / 1000).toFixed(2)}s</span>` : "";
  const msHTML = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? `<span class="ti-ms">${esc(fmtMs(v))}</span>` : relHTML);
  let head = "", body = "";

  switch (kind) {
    case "llm": {
      const calls = arr(item.tool_calls);
      head = traceTag("Model") + traceName(brainName(item.brain) || "LLM", true) + msHTML(item.latency_ms);
      if (item.text) body += `<div class="thought">${esc(clip(item.text, 500))}</div>`;
      if (calls.length) {
        body += `<div class="ti-calls">${calls.map((c) => `<span class="call">${esc(c?.name || "?")}<span class="ca">(${esc(clip(compactArgs(c?.args), 70))})</span></span>`).join("")}</div>`;
      }
      if (!body) body = '<div class="thought">No tool calls</div>';
      break;
    }
    case "tool_call":
      head = traceTag(item.from === "app" ? "App → tools/call" : "MCP tools/call") + traceName(item.name || "?") + relHTML;
      body = (item.from === "app" ? "<div>From the on-screen app, proxied by the host</div>" : "") + argsHTML(item.args);
      break;
    case "app_call":
      head = traceTag("App → host") + traceName(item.name || "?") + relHTML;
      body = `<div>tools/call from the on-screen app, proxied by the host</div>${argsHTML(item.args)}`;
      break;
    case "tool_result": {
      if (item.ok === false) el.classList.add("fail");
      head = traceTag(item.ok === false ? "Failed" : "Result") + traceName(item.name || "?") + (Number(item.ms) > 0 ? msHTML(item.ms) : relHTML);
      if (item.speech) body += `<div class="quote">${esc(item.speech)}</div>`;
      if (item.ui) body += `<div class="tags"><span class="tag-ui"><b>UI</b>${esc(item.ui)}</span></div>`;
      if (item.structured !== undefined && item.structured !== null) body += jsonDetails("structuredContent", item.structured);
      break;
    }
    case "announcement": {
      const sev = ["info", "watch", "urgent"].includes(str(item.severity)) ? str(item.severity) : "info";
      el.classList.add(`sev-${sev}`, `tone-${item._tone || "yellow"}`);
      const [kindLabel] = ANN_KIND[str(item.ann_kind)] || [str(item.ann_kind) || "Announcement"];
      const when = parseTime(item.when);
      head = traceTag("Proactive") + traceName(kindLabel, true) + `<span class="sev-chip ${sev}">${esc(sev)}</span>`
        + (when ? `<span class="ti-ms">${esc(fmtTime(when))}</span>` : "");
      body = `<div class="ann-t">${esc(str(item.title))}</div>${item.speech ? `<div class="quote">${esc(str(item.speech))}</div>` : ""}`;
      const replies = arr(item.replies).map(str).filter(Boolean);
      if (replies.length) body += `<div class="ti-replies">${replies.map((r) => `<span>${esc(r)}</span>`).join("")}</div>`;
      break;
    }
    case "ann_ack":
      head = traceTag(item.action === "dismissed" ? "Dismissed" : "Acknowledged") + traceName(item.via ? `via “${item.via}”` : "on screen", true);
      body = `<div>POST /api/announcements/${esc(str(item.id))}/ack</div>`;
      break;
    case "ring":
      head = traceTag("Ring → Nova webhook") + relHTML;
      body = `${item.text ? `<div class="quote">${esc(str(item.text))}</div>` : ""}`;
      if (arr(item.announced).length) body += `<div class="ti-replies">${arr(item.announced).map((k) => `<span>${esc(str(k))}</span>`).join("")}</div>`;
      break;
    case "ring_event":
      head = traceTag("Ring → Nova webhook") + traceName("POST /integrations/ring/events") + relHTML;
      body = argsHTML(item.args);
      break;
    case "ring_webhook":
      head = traceTag("Ring Webhook v1.1") + traceName(`${str(item.ring_type)} · ${item.verified ? "signature verified" : "unverified"}`, true);
      body = `<div class="ti-replies">${[item.device, item.request_id].filter(Boolean).map((k) => `<span>${esc(str(k))}</span>`).join("")}</div>`;
      break;
    case "ring_result": {
      const sig = item.signal;
      const text = typeof sig === "string" ? sig : isObj(sig) ? str(sig.text) : "";
      head = traceTag("Signal") + traceName(isObj(sig) ? `${str(sig.kind)}${sig.who ? " · " + str(sig.who) : ""}` : "front door", true) + msHTML(item.ms);
      if (text) body += `<div class="quote">${esc(text)}</div>`;
      if (arr(item.announced).length) body += `<div class="ti-replies">${arr(item.announced).map((k) => `<span>${esc(str(k))}</span>`).join("")}</div>`;
      break;
    }
    case "elicit":
      head = traceTag("Elicitation") + relHTML;
      body = `<div class="quote">${esc(item.message || "")}</div>`;
      break;
    case "elicit_answer":
      head = traceTag("Answer") + traceName(item.action || "", true) + relHTML;
      if (isObj(item.content) && Object.keys(item.content).length) body = argsHTML(item.content);
      break;
    case "reply":
      head = traceTag("Alexa says") + relHTML;
      body = `<div class="quote">${esc(item.text || "")}</div>`;
      break;
    case "error":
      head = traceTag("Error") + relHTML;
      body = `<div>${esc(item.message || "Something went wrong")}</div>`;
      break;
    case "user":
      head = traceTag("User") + relHTML;
      body = `<div class="quote">${esc(item.text || "")}</div>`;
      break;
    default:
      head = traceTag(String(item.kind || "event")) + relHTML;
      body = jsonDetails("details", item);
  }
  el.innerHTML = `<div class="ti-head">${head}</div>${body ? `<div class="ti-body">${body}</div>` : ""}`;
  return el;
}

// A turn in the trace. It renders in section 03 and is mirrored onto the back of its device.
class TraceGroup {
  constructor(deviceId, text, { source = null, start = null, uri = "", image = null, badge = null } = {}) {
    const dev = devices.get(deviceId);
    this.device = deviceId;
    this.count = 0;
    this.awaitingUser = false;
    this.source = source;
    this.uri = uri;
    this.start = parseTime(start);
    this.latency = null;
    this.el = document.createElement("div");
    this.el.className = "tg";
    this.el.innerHTML = '<div class="tg-head"><span class="badge"></span><div class="tg-text"></div><div class="tg-meta"></div></div><div class="tg-items"></div>';
    const b = $(".badge", this.el);
    b.textContent = badge?.label || dev?.shortName || deviceId || "?";
    b.style.setProperty("--pc", badge?.color || dev?.color || hashColor(deviceId));
    this.textEl = $(".tg-text", this.el);
    this.metaEl = $(".tg-meta", this.el);
    this.itemsEl = $(".tg-items", this.el);
    if (image) {
      const img = document.createElement("img");
      img.className = "tg-thumb";
      img.src = image;
      img.alt = "";
      this.textEl.before(img);
    }
    this.created = new Date();
    this.setText(text);
    this.renderMeta();
    // mirror on the back of the device
    if (dev) {
      this.mirror = this.el.cloneNode(true);
      const list = dev.ui.backList;
      $(".back-empty", list)?.remove();
      list.prepend(this.mirror);
      while (list.children.length > 24) list.lastElementChild.remove();
    }
  }

  syncHead() { if (this.mirror) $(".tg-head", this.mirror).innerHTML = $(".tg-head", this.el).innerHTML; }

  setText(text) {
    const dev = devices.get(this.device);
    switch (this.source) {
      case "tap": {
        const file = String(this.uri || "").split("/").pop();
        this.textEl.innerHTML = `On-screen tap${file ? ` <span class="via file">${esc(file)}</span>` : ""}`;
        break;
      }
      case "proactive":
        this.textEl.innerHTML = `Nova → ${esc(dev?.shortName || this.device)} <span class="via">proactive</span>`;
        break;
      case "ring":
        this.textEl.innerHTML = `Front door event <span class="via">Ring webhook</span>`;
        break;
      default:
        this.textEl.textContent = text ? `“${text}”` : "Turn";
        if (this.source === "app") this.textEl.insertAdjacentHTML("beforeend", '<span class="via">from MCP App</span>');
        if (this.source === "reply") this.textEl.insertAdjacentHTML("beforeend", '<span class="via">reply to Nova</span>');
        if (this.source === "vision") this.textEl.insertAdjacentHTML("beforeend", '<span class="via">photo · Nova vision</span>');
    }
    this.syncHead();
  }

  setStart(at) {
    const d = parseTime(at);
    if (d) { this.start = d; this.renderMeta(); }
  }

  setLatency(ms) {
    if (ms === undefined || ms === null || !Number.isFinite(Number(ms))) return;
    this.latency = Number(ms);
    this.renderMeta();
  }

  renderMeta() {
    const clockText = fmtClockSec(this.created);
    this.metaEl.innerHTML = this.latency !== null ? `${esc(clockText)}<br><b>${esc(fmtMs(this.latency))}</b>` : esc(clockText);
    this.syncHead();
  }

  add(item) {
    if (!isObj(item)) return;
    this.count++;
    if (!this.start) this.start = parseTime(item.at);
    const el = renderTraceItem(item, this.start);
    this.itemsEl.append(el);
    if (this.mirror) $(".tg-items", this.mirror).append(el.cloneNode(true));
  }
}

const inspector = {
  list: null,
  empty: null,
  current: new Map(),   // device -> TraceGroup receiving events
  turns: new Map(),     // device -> pending chat turn {group, sse}
  appCalls: new Map(),  // device -> pending app call {group, sse}
  rings: new Map(),     // device -> pending ring event {group, sse}
  annGroups: new Map(), // announcement id -> TraceGroup

  init() {
    this.list = $("#traceList");
    this.empty = $("#traceEmpty");
  },

  clear() {
    this.list.replaceChildren();
    this.current.clear();
    this.turns.clear();
    this.appCalls.clear();
    this.rings.clear();
    this.annGroups.clear();
    this.updateEmpty();
  },

  updateEmpty() { this.empty.hidden = this.list.children.length > 0; },

  newGroup(deviceId, text, opts = {}) {
    const g = new TraceGroup(deviceId, text, opts);
    const pane = this.list.parentElement;
    const nearTop = pane.scrollTop < 60;
    this.list.prepend(g.el);
    while (this.list.children.length > 60) this.list.lastElementChild.remove();
    if (opts.setCurrent !== false) this.current.set(deviceId, g);
    this.updateEmpty();
    if (nearTop) pane.scrollTop = 0;
    return g;
  },

  beginTurn(deviceId, text, source, image) {
    const group = this.newGroup(deviceId, text, { source: ["app", "reply", "vision"].includes(source) ? source : null, image });
    group.awaitingUser = true;
    const rec = { device: deviceId, group, sse: 0 };
    this.turns.set(deviceId, rec);
    return rec;
  },

  async endTurn(rec, res, ms, err) {
    const g = rec.group;
    // Normally the SSE stream already delivered every step. If it didn't (stream down),
    // fall back to the trace returned by the request.
    const trace = arr(res?.trace);
    if (res && rec.sse === 0 && trace.length) {
      if (sse.isOpen()) await sleep(350);
      if (rec.sse === 0) for (const item of trace) this.addTo(rec.device, item, g);
    }
    if (err) g.add({ kind: "error", message: err.message || String(err) });
    g.setLatency(res?.latency_ms ?? ms);
    if (this.turns.get(rec.device) === rec) this.turns.delete(rec.device);
  },

  beginAppCall(deviceId, name, args, uri) {
    const group = this.newGroup(deviceId, null, { source: "tap", uri });
    const rec = { device: deviceId, group, sse: 0, name, args };
    this.appCalls.set(deviceId, rec);
    return rec;
  },

  async endAppCall(rec, result, ms, err) {
    if (sse.isOpen()) await sleep(300);
    if (rec.sse === 0) {
      // The backend didn't trace this call, so show it from the host's side.
      rec.group.add({ kind: "app_call", name: rec.name, args: rec.args });
      if (result) {
        const sc = structuredOf(result);
        rec.group.add({ kind: "tool_result", name: rec.name, ok: !result.isError, speech: sc?.speech || textOf(result), structured: sc, ms });
      }
    }
    if (err) rec.group.add({ kind: "error", message: err.message || String(err) });
    rec.group.setLatency(ms);
    if (this.appCalls.get(rec.device) === rec) this.appCalls.delete(rec.device);
  },

  // Ring button pressed: a group of its own, filled by the backend's `ring` trace item or by the response.
  beginRing(deviceId, kind, who) {
    const group = this.newGroup(deviceId, null, { source: "ring", badge: { label: "Ring", color: "#59A9FF" }, setCurrent: false });
    const rec = { device: deviceId, group, sse: 0, kind, who };
    this.rings.set(deviceId, rec);
    return rec;
  },

  async endRing(rec, res, ms, err) {
    if (sse.isOpen()) await sleep(300);
    if (rec.sse === 0) {
      rec.group.add({ kind: "ring_event", args: { kind: rec.kind, who: rec.who } });
      if (res) rec.group.add({ kind: "ring_result", signal: res.signal, announced: res.announced, ms });
    }
    if (isObj(res) && res.ring_type) {
      rec.group.add({ kind: "ring_webhook", ring_type: res.ring_type, device: res.device, request_id: res.request_id,
        verified: res.signature_verified ?? res.verified ?? !!res.signal });
    }
    if (err) rec.group.add({ kind: "error", message: err.message || String(err) });
    rec.group.setLatency(ms);
    if (this.rings.get(rec.device) === rec) this.rings.delete(rec.device);
  },

  announcement(deviceId, item, tone) {
    if (!isObj(item)) return;
    const g = this.newGroup(deviceId, null, { source: "proactive", setCurrent: false });
    g.add({ ...item, kind: "announcement", ann_kind: item.kind, _tone: tone, at: undefined, when: item.at ?? item.due_at });
    if (item.id !== undefined) this.annGroups.set(str(item.id), g);
  },

  annAck(deviceId, item, action, via) {
    const g = this.annGroups.get(str(item?.id));
    if (g) g.add({ kind: "ann_ack", action, via, id: item.id });
  },

  // A trace item from the SSE stream.
  onEvent(deviceId, item) {
    if (!isObj(item)) return;
    if (item.kind === "ring") {
      const r = this.rings.get(deviceId) || [...this.rings.values()][0];
      if (r) { r.sse++; r.group.add(item); }
      else this.newGroup(deviceId, null, { source: "ring", badge: { label: "Ring", color: "#59A9FF" }, setCurrent: false }).add(item);
      return;
    }
    const t = this.turns.get(deviceId);
    if (t) t.sse++;
    const a = this.appCalls.get(deviceId);
    if (a) a.sse++;
    this.addTo(deviceId, item);
  },

  addTo(deviceId, item, forced) {
    if (!isObj(item)) return;
    let g = forced || this.current.get(deviceId);
    if (item.kind === "user") {
      if (g && g.awaitingUser && g.count === 0) {
        g.awaitingUser = false;
        if (item.text && !g.source) g.setText(item.text);
        g.setStart(item.at);
        return;
      }
      if (forced) return; // fallback trace: the group header already shows the words
      this.newGroup(deviceId, item.text, { start: item.at });
      return;
    }
    if (!g) g = this.newGroup(deviceId, null, { start: item.at });
    g.add(item);
  },
};

/* ======================================================= care circle story rail */

const circleFeed = {
  list: null,
  seen: new Set(),
  loaded: false,
  timer: 0,

  init() { this.list = $("#circleList"); this.list.innerHTML = '<div class="rail-empty">Loading the care circle…</div>'; },

  reset() { this.seen.clear(); this.loaded = false; },

  refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 300);
  },

  async load() {
    try {
      const res = await api("/api/timeline", { timeout: 15_000 });
      this.render(arr(res?.items));
    } catch {
      if (!this.loaded) this.list.innerHTML = '<div class="rail-empty">The care circle appears once the simulator backend is running.</div>';
    }
  },

  // A film strip of the household's moments, oldest to newest, each tinted with the sky of its hour.
  render(items) {
    const key = (it) => `${it.at}|${it.kind}|${it.who}|${it.text}`;
    const KIND = { dose: "Medication", checkin: "Check-in", message: "Message", alert: "Alert", ring: "Front door", nova: "Nova" };
    const list = items.filter(isObj).slice(0, 60).reverse();
    const html = [];
    let lastDay = null;
    for (const it of list) {
      const d = parseTime(it.at);
      const day = dayLabel(d);
      if (day !== lastDay) { html.push(`<div class="moment day-card"><span class="m-day">${esc(day)}</span></div>`); lastDay = day; }
      const kind = Object.prototype.hasOwnProperty.call(KIND, it.kind) ? it.kind : "other";
      const sev = ["info", "watch", "urgent"].includes(it.severity) ? it.severity : kind === "alert" ? "watch" : "";
      const s = skyAt(d ? hourOf(d) : 12);
      const light = s.lum > 0.6;
      const t = d ? fmtTime(d).split(" ") : ["", ""];
      const isNew = this.loaded && !this.seen.has(key(it));
      const label = (kind === "alert" || kind === "nova") && sev && sev !== "info" ? `${sev} · ${KIND[kind]}` : KIND[kind] || str(it.kind) || "Update";
      html.push(`<article class="moment${light ? " light" : ""}${sev ? ` m-sev-${sev}` : ""}${isNew ? " fresh" : ""}" style="--m-top:${s.top};--m-mid:${s.mid};--m-hor:${s.hor}">
        <div class="m-top"><span class="m-dot"></span>${esc(label)}</div>
        <div class="m-time">${esc(t[0])}<small>${esc((t[1] || "").toLowerCase())}</small></div>
        <div class="m-who">${esc(str(it.who) || KIND[kind] || "")}</div>
        <div class="m-text">${esc(wordClip(str(it.text), 112))}</div>
      </article>`);
    }
    if (!html.length) html.push('<div class="rail-empty">Nothing in the care circle yet.</div>');
    const markup = html.join("");
    if (markup === this.lastMarkup) { this.loaded = true; return; }
    this.lastMarkup = markup;
    this.list.innerHTML = markup;
    this.seen = new Set(items.filter(isObj).map(key));
    this.loaded = true;
    scrollFx.refreshRail();
  },
};

/* ===================================================================== status */

const status = {
  data: null,
  fails: 0,

  async load() {
    try {
      const s = await api("/api/status", { timeout: 8_000 });
      if (!isObj(s)) throw new Error("Bad status");
      this.data = s;
      this.fails = 0;
      this.render(s);
      return s;
    } catch {
      // a single blip (e.g. a server restart) shouldn't flash an offline state
      if (++this.fails >= 2 || !this.data) this.renderOffline();
      return null;
    }
  },

  render(s) {
    if (!arc.dragging) clock.sync(s.household_now ?? s.now ?? s.clock?.now, s.clock_speed ?? s.clock?.speed);
    const brain = isObj(s.brain) ? s.brain : {};
    const bp = $("#brainPill");
    const name = String(brain.name || "").toLowerCase();
    bp.dataset.state = !name ? "off" : name === "bedrock" ? "bedrock" : name === "rules" || name === "none" ? "rules" : "ok";
    $("#brainLabel").textContent = shortBrain(brain.label || brain.name);
    bp.title = `Agent brain: ${brain.label || brain.name || "unknown"}`;

    const m = isObj(s.mcp) ? s.mcp : {};
    const tools = arr(m.tools);
    const mp = $("#mcpPill");
    mp.dataset.state = m.connected ? "ok" : "off";
    $("#mcpLabel").textContent = m.connected ? `${tools.length} tools` : "Not connected";
    mp.title = m.url ? `Nova MCP server at ${m.url}` : "Nova MCP server";
    this.renderPopover();
  },

  renderOffline() {
    $("#brainPill").dataset.state = "off";
    $("#brainLabel").textContent = "Simulator offline";
    $("#mcpPill").dataset.state = "off";
    $("#mcpLabel").textContent = "Not connected";
    this.renderPopover();
  },

  renderPopover() {
    const m = isObj(this.data?.mcp) ? this.data.mcp : {};
    const tools = arr(m.tools).map(String);
    $("#mcpPopover").innerHTML = `
      <h4>${esc(m.server_name || "Nova MCP server")}</h4>
      <div class="pv-url">${esc(m.url || "Waiting for the simulator backend")}</div>
      <div class="pv-grid">
        <span>Status</span><span>${m.connected ? "Connected" : esc(clip(m.error || "Not connected", 120))}</span>
        <span>Transport</span><span>Streamable HTTP</span>
        <span>Protocol</span><span>${esc(m.protocol_version || "—")}</span>
        <span>Brain</span><span>${esc(brainName(this.data?.brain) || "—")}</span>
      </div>
      ${tools.length ? `<div class="pv-tools">${tools.map((t) => `<code class="${UI_TOOLS.has(t) ? "ui" : ""}">${esc(t)}</code>`).join("")}</div>
      <div class="pv-note">Cyan tools ship an MCP App screen (ui://nova/…).</div>` : ""}`;
  },

  noteBrain(b) {
    const label = brainName(b);
    if (label) $("#brainLabel").textContent = shortBrain(label);
  },
};

/* ======================================================================== SSE */

function setLive(state) {
  const el = $("#liveDot");
  el.dataset.state = state;
  $("span", el).textContent = state === "live" ? "Live" : state === "reconnecting" ? "Reconnecting" : "Connecting";
}

const sse = {
  es: null,
  retry: 1_000,
  open: false,

  connect() {
    try { this.es?.close(); } catch { /* ignore */ }
    const es = new EventSource("/api/events");
    this.es = es;
    es.onopen = () => { this.retry = 1_000; this.open = true; setLive("live"); };
    es.onmessage = (e) => this.handle(e.data);
    // Also accept named events, in case the server sets `event:`.
    for (const name of ["trace", "elicit", "elicit_done", "circle", "reset", "clock", "announcement"]) es.addEventListener(name, (e) => this.handle(e.data, name));
    es.onerror = () => {
      this.open = false;
      setLive("reconnecting");
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 15_000);
      }
    };
  },

  isOpen() { return this.open && this.es?.readyState === EventSource.OPEN; },

  handle(raw, name) {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!isObj(d)) return;
    switch (d.type || name) {
      case "trace":
        inspector.onEvent(d.device, d.item);
        devices.get(d.device)?.onTrace(d.item);
        break;
      case "elicit": {
        const dev = devices.get(d.device) || devices.values().next().value;
        dev?.showElicit(d);
        break;
      }
      case "elicit_done":
        for (const dev of devices.values()) dev.hideElicit(d.id);
        break;
      case "circle":
        circleFeed.refreshSoon();
        break;
      case "clock":
        if (!arc.dragging && !clock.preview) clock.sync(d.now, d.speed);
        break;
      case "announcement": {
        const dev = devices.get(d.device);
        inspector.announcement(d.device, d.item, toneFor(d.item, dev));
        dev?.receiveAnnouncement(d.item);
        for (const cb of announcementCbs) { try { cb(d.device, d.item); } catch { /* recorder callback */ } }
        break;
      }
      case "reset":
        resetUI();
        break;
      default:
        break;
    }
  },
};

/* ========================================================= scroll & reveals */

function loadScript(src, timeout = 6_000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const t = setTimeout(() => { s.remove(); reject(new Error(`timeout ${src}`)); }, timeout);
    s.src = src;
    s.async = false;
    s.crossOrigin = "anonymous";
    s.onload = () => { clearTimeout(t); resolve(); };
    s.onerror = () => { clearTimeout(t); reject(new Error(`failed ${src}`)); };
    document.head.append(s);
  });
}

// Split section headlines into masked words; IntersectionObserver reveals (works without GSAP).
function prepareReveals() {
  for (const h of document.querySelectorAll("[data-split]")) {
    const parts = [];
    let i = 0;
    for (const node of h.childNodes) {
      if (node.nodeType === 3) {
        for (const w of node.textContent.split(/(\s+)/)) parts.push(w.trim() ? `<span class="wd"><span style="--i:${i++}">${esc(w)}</span></span>` : w);
      } else if (node.nodeType === 1) {
        parts.push(`<span class="wd"><span style="--i:${i++}"><em>${esc(node.textContent)}</em></span></span>`);
      }
    }
    h.innerHTML = parts.join("");
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { threshold: 0.2 });
  for (const el of document.querySelectorAll("[data-split], .reveal")) io.observe(el);
}

const scrollFx = {
  gsap: null,
  lenis: null,
  railST: null,
  async init() {
    document.documentElement.classList.add("no-gsap");
    // The bar steps aside while you read further down, and comes back as soon as you scroll up.
    let lastY = window.scrollY;
    window.addEventListener("scroll", () => {
      const y = window.scrollY, deep = y > window.innerHeight * 0.7;
      document.body.classList.toggle("scrolled", y > 30);
      if (!deep || y < lastY - 6) document.body.classList.remove("bar-away");
      else if (y > lastY + 2 && !hoodDrawer.open) document.body.classList.add("bar-away");
      lastY = y;
    }, { passive: true });
    this.nativeRail();
    try {
      await loadScript(CDN.gsap);
      await Promise.all([loadScript(CDN.st), loadScript(CDN.drag), loadScript(CDN.inertia), REDUCED ? Promise.resolve() : loadScript(CDN.lenis).catch(() => {})]);
    } catch {
      return; // CDN unavailable: native scroll + drag fallbacks stay in place
    }
    const g = window.gsap;
    if (!g || !window.ScrollTrigger) return;
    g.registerPlugin(window.ScrollTrigger, window.Draggable, window.InertiaPlugin);
    this.gsap = g;
    document.documentElement.classList.remove("no-gsap");
    if (window.Lenis && !REDUCED) {
      this.lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true, prevent: (node) => !!node.closest?.("[data-lenis-prevent], .chips, .back-list, .trace-scroll, iframe, .drawer, .capture") });
      this.lenis.on("scroll", window.ScrollTrigger.update);
      g.ticker.add((t) => this.lenis.raf(t * 1000));
      g.ticker.lagSmoothing(0);
    }
    if (!REDUCED) {
      // As you leave the scene the devices recede in 3D; they come back when you scroll up.
      // (A shade fades it rather than opacity on the 3D layers, which would flatten them every frame.)
      g.to("#stage, #scene3d, #backLayer", { scale: 0.9, yPercent: -5, force3D: true, ease: "none",
        scrollTrigger: { trigger: "#scene", start: "top top", end: "bottom top", scrub: 0.6 } });
      g.fromTo("#sceneShade", { autoAlpha: 0 }, { autoAlpha: 0.72, ease: "none", immediateRender: false, scrollTrigger: { trigger: "#scene", start: "top top", end: "bottom top", scrub: 0.6 } });
      g.to("#arc", { yPercent: -18, opacity: 0, ease: "none", scrollTrigger: { trigger: "#scene", start: "top top", end: "60% top", scrub: 0.6 } });
      g.to(".flow", { "--fp": 1, ease: "none", scrollTrigger: { trigger: ".flow", start: "top 75%", end: "bottom 60%", scrub: 0.6 } });
    }
    this.refreshRail(true);
  },
  // Without GSAP: the rail scrolls natively and can be dragged.
  nativeRail() {
    const rail = $("#rail");
    let down = null;
    rail.addEventListener("pointerdown", (e) => {
      if (!document.documentElement.classList.contains("no-gsap") || e.button !== 0) return;
      down = { x: e.clientX, s: rail.scrollLeft };
      rail.setPointerCapture(e.pointerId);
      rail.classList.add("dragging");
    });
    rail.addEventListener("pointermove", (e) => { if (down) rail.scrollLeft = down.s - (e.clientX - down.x); });
    const end = () => { down = null; rail.classList.remove("dragging"); };
    rail.addEventListener("pointerup", end);
    rail.addEventListener("pointercancel", end);
    rail.addEventListener("scroll", () => {
      const max = rail.scrollWidth - rail.clientWidth;
      $("#railProgress").style.setProperty("--p", max > 0 ? (rail.scrollLeft / max).toFixed(3) : 0);
    }, { passive: true });
  },
  // Section 02: the strip is pinned and scrubbed by scroll; dragging it scrolls the page.
  refreshRail(first = false) {
    const g = this.gsap;
    if (!g || REDUCED) return;
    const ST = window.ScrollTrigger;
    const track = $("#circleList");
    if (this.railST) { ST.refresh(); return; } // built once; later renders only re-measure
    const dist = () => Math.max(0, track.scrollWidth - window.innerWidth);
    const progress = $("#railProgress");
    let lastTilt = "";
    // A short hold first, so the cards start aligned with the heading before they move.
    this.railTween = g.timeline({
      scrollTrigger: {
        trigger: "#circlePin", start: "top top", end: () => `+=${Math.max(dist() * 1.18, 1)}`, pin: true, scrub: 0.8, invalidateOnRefresh: true,
        onUpdate: (self) => {
          progress.style.setProperty("--p", self.progress.toFixed(3));
          const v = `${clamp(self.getVelocity() / -260, -8, 8).toFixed(1)}deg`;
          if (v !== lastTilt) { lastTilt = v; track.style.setProperty("--tilt", v); }
          clearTimeout(this.tiltT);
          this.tiltT = setTimeout(() => { lastTilt = "0.0deg"; track.style.setProperty("--tilt", "0deg"); }, 160);
        },
      },
    }).to({}, { duration: 0.18 }).to(track, { x: () => -dist(), ease: "none", duration: 1 });
    this.railST = this.railTween.scrollTrigger;
    if (first && window.Draggable) {
      const proxy = document.createElement("div");
      const st = () => this.railST;
      window.Draggable.create(proxy, {
        trigger: "#rail", type: "x", inertia: !!window.InertiaPlugin, dragClickables: true,
        onPress() { this.startScroll = window.scrollY; this.startX = this.x; $("#rail").classList.add("dragging"); },
        onDrag() { const s = st(); if (s) scrollFx.scrollTo(clamp(this.startScroll - (this.x - this.startX), s.start, s.end)); },
        onThrowUpdate() { const s = st(); if (s) scrollFx.scrollTo(clamp(this.startScroll - (this.x - this.startX), s.start, s.end)); },
        onRelease() { $("#rail").classList.remove("dragging"); },
      });
    }
    ST.refresh();
  },
  scrollTo(y, opts = {}) {
    if (this.lenis) this.lenis.scrollTo(y, { immediate: true, ...opts });
    else window.scrollTo(0, y);
  },
  goTo(sel) {
    const el = $(sel);
    if (!el) return Promise.resolve();
    return new Promise((resolve) => {
      const done = setTimeout(resolve, 2_200);
      if (this.lenis) this.lenis.scrollTo(el, { duration: 1.6, onComplete: () => { clearTimeout(done); resolve(); } });
      else el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
    });
  },
};

/* ============================================================ hood drawer */

// The live trace panel lives in section 03; the drawer borrows it so it can sit next to the devices.
const hoodDrawer = {
  open: false,
  toggle(force) {
    const want = force === undefined ? !this.open : !!force;
    if (want === this.open) return;
    this.open = want;
    const panel = $("#tracePanel"), drawer = $("#hoodDrawer");
    const drawerW = Math.min(460, window.innerWidth - 28) + 14;
    const k = clamp((window.innerWidth - drawerW - 40) / Math.max(1, $("#scene").clientWidth), 0.5, 1);
    document.body.style.setProperty("--hood-k", k.toFixed(4));
    if (want) {
      panel.classList.add("in");
      $("#hoodSlot").append(panel);
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
      document.body.classList.add("hood-open");
      document.body.classList.remove("bar-away");
      $("#hoodClose").focus({ preventScroll: true });
    } else {
      if (drawer.contains(document.activeElement)) $("#hoodBtn").focus({ preventScroll: true });
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
      document.body.classList.remove("hood-open");
      setTimeout(() => { if (!this.open) $("#traceHome").append(panel); }, 650);
    }
  },
};

/* ============================================================ ?debug=overlap */

// Every visible box on the stage (bar, each device's screen and its three lines, the Ring, HUD,
// shelf, popovers) should own its space. This finds any two that intersect.
const overlapDebug = {
  on: /[?&]debug=overlap\b/.test(location.search),
  layer: null,
  boxes() {
    const out = [];
    const shown = (el) => {
      if (!el || !el.getClientRects().length) return false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) return false;
      }
      return true;
    };
    const add = (name, el) => { if (shown(el)) out.push({ name, el, r: el.getBoundingClientRect() }); };
    const addRect = (name, r, owner = null) => { if (r && r.width > 0 && r.height > 0) out.push({ name, el: null, r, owner }); };
    add("bar", $("#bar"));
    for (const d of devices.values()) {
      if (!shown(d.el)) continue;
      add(`${d.id} name`, $(".caption", d.el));
      add(`${d.id} controls`, $(".controls", d.el));
      add(`${d.id} pills`, $(".chips", d.el));
      addRect(`${d.id} screen`, stage3d ? stage3d.rectOf(d.id) : d.ui.hw.getBoundingClientRect(), d.id);
      addRect(`${d.id} device`, stage3d ? stage3d.deviceRect(d.id) : $(".obj", d.el)?.getBoundingClientRect(), d.id);
      if (d.chipMenu) add(`${d.id} more-menu`, d.chipMenu);
    }
    add("ring label", $(".ring-mini"));
    if (stage3d) addRect("ring doorbell", stage3d.ringRect(), "ring");
    const ringPop = $(".ring-pop");
    if (ringPop && !ringPop.hidden && shown(ringPop)) out.push({ name: "ring popover", el: ringPop, r: ringPop.getBoundingClientRect(), owner: "ring" });
    add("ring live view", $(".ring.live-on .ring-view"));
    add("hud timecode", $(".hud-l.bl-txt"));
    add("hud coords", $(".hud-l.br-txt"));
    add("scroll cue", $(".scroll-cue"));
    if (shelf.open) { add("shelf copy", $(".sd-copy")); add("shelf actions", $(".sd-actions")); }
    const H = innerHeight;
    return out.filter((b) => b.r.bottom > 0 && b.r.top < H && b.r.width > 0);
  },
  check() {
    const bs = this.boxes(), hits = [];
    const meets = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        if (a.el && b.el && (a.el.contains(b.el) || b.el.contains(a.el))) continue;
        if (a.owner && a.owner === b.owner) continue; // a device and its own screen; the doorbell and its own menu
        if (meets(a.r, b.r)) hits.push([a, b]);
      }
    }
    return { boxes: bs, hits };
  },
  paint() {
    const { boxes, hits } = this.check();
    for (const el of document.querySelectorAll(".overlap-hit")) el.classList.remove("overlap-hit");
    if (!this.layer) {
      this.layer = document.createElement("div");
      this.layer.className = "overlap-layer";
      document.body.append(this.layer);
    }
    const bad = new Set(hits.flat());
    this.layer.innerHTML = boxes.map((b) => `<div class="ob${bad.has(b) ? " hit" : ""}" style="left:${b.r.left}px;top:${b.r.top}px;width:${b.r.width}px;height:${b.r.height}px"><span>${esc(b.name)}</span></div>`).join("");
    for (const b of bad) b.el?.classList.add("overlap-hit");
    const sig = hits.map(([a, b]) => `${a.name} × ${b.name}`).join(", ");
    if (sig !== this.last) { this.last = sig; console.info(`[overlap] ${hits.length ? sig : "none"}`); }
  },
  init() {
    if (!this.on) return;
    document.body.classList.add("debug-overlap");
    setInterval(() => { try { this.paint(); } catch { /* debugging aid only */ } }, 700);
  },
};

/* ======================================================= automation hook */

// window.NovaDemo: a thin, stable API for the demo-video recorder. Every call goes through the
// same functions the UI uses, so a recording shows exactly what a person would see.
let readyResolve;
const demoReady = new Promise((r) => { readyResolve = r; });
const announcementCbs = [];

function deviceFor(name) {
  const k = str(name).toLowerCase();
  if (devices.has(k)) return devices.get(k);
  for (const d of devices.values()) {
    const p = d.def.person || {};
    if ([p.id, str(p.short_name).toLowerCase(), str(p.name).toLowerCase()].includes(k)) return d;
  }
  throw new Error(`Unknown device: ${name}`);
}

async function waitFor(test, timeout = 60_000, every = 150) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > timeout) throw new Error("Timed out waiting");
    await sleep(every);
  }
}

window.NovaDemo = {
  ready: demoReady,
  // Resolves with the reply once it is on screen and the voice has finished (or at most 3 s past the
  // expected speech length). say(device, text, { waitForSpeech: false }) resolves when the reply shows.
  async say(device, text, { waitForSpeech = true } = {}) {
    const d = deviceFor(device);
    await waitFor(() => !d.busy, 60_000);
    const seq = d.replySeq || 0;
    const turn = d.send(text);
    if (waitForSpeech) return turn;
    turn.catch(() => {});
    await Promise.race([waitFor(() => (d.replySeq || 0) > seq, 200_000, 60), turn]);
    return d.lastReply;
  },
  async showSample(device, sampleId) {
    const d = deviceFor(device);
    const s = samples.list.find((x) => str(x.id) === sampleId || str(x.url).includes(sampleId));
    if (!s) throw new Error(`Unknown sample: ${sampleId}`);
    await waitFor(() => !d.busy);
    return tray.flyAndScan(d, s);
  },
  async answer(device, yes) {
    const d = deviceFor(device);
    const t0 = Date.now();
    let sawBusy = d.busy;
    while (!d.elicit) {
      if (d.busy) sawBusy = true;
      else if (sawBusy || Date.now() - t0 > 6_000) throw new Error(`No question on ${d.shortName}'s screen`);
      if (Date.now() - t0 > 30_000) throw new Error("Timed out waiting for a question");
      await sleep(120);
    }
    return d.answerYesNo(!!yes);
  },
  async tapReply(device, text) {
    const d = deviceFor(device);
    await waitFor(() => !!d.announcement, 60_000);
    const want = str(text).toLowerCase();
    const reply = arr(d.announcement.replies).map(str).find((r) => r.toLowerCase() === want) || text;
    return d.replyAnnouncement(reply);
  },
  async approveChanges() {
    const host = [...AppHost.all].find((h) => h.card.tool === "read_care_document");
    if (!host) throw new Error("No care plan update on screen");
    const done = new Promise((resolve) => appCallWaiters.push({ name: "apply_care_changes", resolve }));
    host.notify("nova/demo-action", { action: "approve" }); // reconcile.html presses its own Approve button
    return Promise.race([done, sleep(12_000).then(() => null)]);
  },
  async setClock(time = null, speed = null) {
    if (time) await topbar.jump(time);
    if (speed !== null && speed !== undefined) await topbar.setSpeed(Number(speed));
    return { now: clock.now().toISOString(), speed: clock.speed };
  },
  ring(kind, who = "unknown") {
    const r = [...devices.values()].find((d) => d.ring)?.ring;
    if (!r) return Promise.reject(new Error("No Ring doorbell"));
    return r.trigger(kind, who);
  },
  focus(device) {
    const id = device ? deviceFor(device).id : null;
    if ((focusId || null) !== id) toggleFocus(id || focusId);
  },
  toggleInspector(open) { hoodDrawer.toggle(open === undefined ? undefined : !!open); },
  flip(device, toBack = true) { deviceFor(device).flip(!!toBack); },
  scrollTo(section) {
    return scrollFx.goTo({ stage: "#scene", story: "#circle", hood: "#hood" }[section] || "#scene");
  },
  onAnnouncement(cb) { if (typeof cb === "function") announcementCbs.push(cb); },
  // Debug: which on-screen boxes intersect right now (empty when the layout is clean).
  overlaps() { return overlapDebug.check().hits.map(([a, b]) => `${a.name} × ${b.name}`); },
  get mode() { return stage3d ? "3d" : "flat"; },
  get stage3d() { return stage3d; }, // for tooling (camera, picking)
};

/* ===================================================================== wiring */

let lastReset = 0;
function resetUI() {
  if (Date.now() - lastReset < 1_000) return;
  lastReset = Date.now();
  speech.stopAll();
  mic.stop();
  spotlight.off();
  for (const d of devices.values()) d.reset();
  inspector.clear();
  circleFeed.reset();
  circleFeed.load();
  status.load();
  for (const d of devices.values()) notifications.refreshSoon(d);
}

async function doReset() {
  const btn = $("#resetBtn");
  if (btn.classList.contains("busy")) return;
  btn.classList.add("busy");
  try {
    await api("/api/reset", { method: "POST", timeout: 30_000 });
    resetUI();
    toast("Demo reset. Fresh household loaded.");
  } catch (err) {
    toast(`Reset failed: ${err.message}`, "error");
  } finally {
    btn.classList.remove("busy");
  }
}

function wireChrome() {
  // Mute
  const muteBtn = $("#muteBtn");
  let muted = false;
  try { muted = localStorage.getItem("nova.muted") === "1"; } catch { /* storage blocked */ }
  const applyMute = (on) => {
    speech.setMuted(on);
    muteBtn.setAttribute("aria-pressed", String(on));
    muteBtn.title = on ? "Unmute Alexa's voice" : "Mute Alexa's voice";
  };
  applyMute(muted);
  muteBtn.addEventListener("click", () => {
    const on = muteBtn.getAttribute("aria-pressed") !== "true";
    applyMute(on);
    try { localStorage.setItem("nova.muted", on ? "1" : "0"); } catch { /* storage blocked */ }
  });

  $("#resetBtn").addEventListener("click", doReset);
  const goHood = () => hoodDrawer.toggle();
  $("#hoodBtn").addEventListener("click", goHood);
  $("#hoodClose").addEventListener("click", () => hoodDrawer.toggle(false));
  $(".scroll-cue").addEventListener("click", (e) => { e.preventDefault(); scrollFx.goTo("#circle"); });

  // MCP popover
  const pill = $("#mcpPill"), pop = $("#mcpPopover");
  const closePop = () => { pop.hidden = true; pill.setAttribute("aria-expanded", "false"); };
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    pop.hidden = !open;
    pill.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target)) closePop();
    for (const d of devices.values()) if (d.chipMenu && !d.chipMenu.contains(e.target)) d.closeChipMenu();
    for (const d of devices.values()) if (!d.ui.drawer.hidden && !d.ui.drawer.contains(e.target)) d.closeDrawer();
  });
  $("#clearTrace").addEventListener("click", () => inspector.clear());

  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if (e.key === "Escape") {
      if (!pop.hidden) { closePop(); return; }
      const ringPop = [...devices.values()].find((d) => d.ring && !d.ring.pop.hidden)?.ring;
      if (ringPop) { ringPop.togglePop(false); return; }
      if (hoodDrawer.open) { hoodDrawer.toggle(false); return; }
      if (shelf.open) { shelf.close(); return; }
      for (const d of devices.values()) {
        if (!d.ui.drawer.hidden) { d.closeDrawer(); return; }
        if (d.capture) { d.capture.close(); return; }
        if (d.m.flipTo) { d.flip(false); return; }
      }
      if (focusId) toggleFocus(focusId);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "i" || e.key === "I") { e.preventDefault(); goHood(); }
    if (e.key === "f" || e.key === "F") { e.preventDefault(); (activeDevice || devices.values().next().value)?.flip(); }
    if (e.key === "1" || e.key === "2") {
      const d = [...devices.values()][Number(e.key) - 1];
      if (d) { e.preventDefault(); toggleFocus(d.id); }
    }
  });

  window.addEventListener("pointermove", trackTilt, { passive: true });
  window.addEventListener("resize", () => { clearTimeout(wireChrome.rt); wireChrome.rt = setTimeout(layout, 120); });
  magnetic($(".bar-clock"), ".ff-btn");
  if (!SR) document.body.classList.add("no-speech");
}

// HUD timecode: household time plus a 24 fps frame counter.
function renderHud(now) {
  const tc = $("#hudTc");
  if (!tc) return;
  const p = (n) => String(n).padStart(2, "0");
  const frames = Math.floor((performance.now() / (1000 / 24)) % 24);
  tc.textContent = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}:${p(frames)}`;
}

// Clocks tick locally between server syncs (fast enough for time-lapse).
let lastTickKey = "";
function tickAll(force = false) {
  const now = clock.now();
  renderHud(now);
  topbar.render();
  sky.render(now);
  if (!arc.dragging) arc.place(hourOf(now));
  const key = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
  if (key === lastTickKey && !force) return;
  lastTickKey = key;
  for (const d of devices.values()) d.tick(now);
}

async function main() {
  inspector.init();
  circleFeed.init();
  sky.init();
  arc.init();
  topbar.init();
  wireChrome();
  prepareReveals();

  // Ask for the three type faces now rather than when layout first needs them.
  const fontsP = Promise.all(['400 28px "Instrument Serif"', '400 14px "Inter Tight"', '500 14px "Inter Tight"', '500 10px "JetBrains Mono"']
    .map((f) => (document.fonts?.load ? document.fonts.load(f).catch(() => null) : null)));
  // Start loading the 3D modules at once (they're big), in parallel with the status fetch.
  const stage3dModule = WANT_3D ? import("/static/stage3d.js").catch(() => null) : null;
  const scrollLayer = scrollFx.init(); // GSAP + Lenis load in the background; nothing waits on them

  // Prefer the backend's device list; fall back so the page always renders.
  const statusP = Promise.all([status.load(), samples.load()]);
  // Wake the GPU process while those requests are in flight (the first WebGL context can take a second).
  if (WANT_3D) {
    try { document.createElement("canvas").getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* 3D falls back later */ }
  }
  const [s] = await statusP;
  performance.mark("nova:status");
  shelf.init();
  mountDevices(arr(s?.devices).length ? s.devices : FALLBACK_DEVICES);
  if (s) for (const d of devices.values()) notifications.fetch(d);
  if (document.fonts?.ready) document.fonts.ready.then(() => layout());

  // The WebGL stage: the same live screens on real 3D glass. Any failure keeps the 2D layout.
  let mode = "flat";
  if (WANT_3D) {
    document.body.classList.add("is3d");
    try {
      const m = await stage3dModule;
      performance.mark("nova:module");
      if (!m) throw new Error("3D modules unavailable");
      stage3d = await m.mount3d({
        devices, samples: samples.list, clock, hourOf, toast,
        scanSample: (d, s) => tray.scan(d, s),
        onDropScan: () => shelf.close(),                       // a dropped object starts the scan; the shelf goes away
        onDeviceClick: (id) => toggleFocus(id),                // click an Echo Show to focus it (Esc returns)
        onRingClick: () => [...devices.values()].find((d) => d.ring)?.ring.togglePop(true),
      });
      mode = "3d";
      for (const d of devices.values()) { d.fit(); d.settleLight(); }
      layout();
      performance.mark("nova:mounted");
    } catch {
      stage3d = null;
      document.body.classList.remove("is3d");
      $("#scene3d").replaceChildren();
      for (const d of devices.values()) {
        if (!d.ui.fit.contains(d.ui.screen)) d.ui.fit.append(d.ui.screen);
        d.ui.screen.style.removeProperty("--lw");
        d.ui.screen.style.removeProperty("--lh");
        const back = $(`.back3d[data-device="${d.id}"] .back-panel`);
        if (back) $(".face.back", d.el).append(back);
        d.fit();
      }
      $("#backLayer").replaceChildren();
      layout();
    }
  }

  tickAll(true);
  setInterval(() => tickAll(), 250);
  overlapDebug.init();
  setInterval(() => { for (const d of devices.values()) d.rotateHint(); }, HINT_EVERY_MS);

  sse.connect();
  circleFeed.load();
  setInterval(() => circleFeed.load(), 30_000);
  // Ready as soon as the stage is up and laid out with its fonts (the scroll layer may still be loading).
  Promise.race([fontsP, sleep(1_200)])
    .then(() => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 300); })) // first frames on screen
    .then(() => { layout(); performance.mark("nova:ready"); readyResolve({ mode }); });
  scrollLayer.catch(() => {});

  // Keep the status fresh; poll faster while the backend is down.
  const poll = async () => {
    const st = await status.load();
    if (st && arr(st.devices).length) mountDevices(st.devices);
    if (st && !samples.list.length) await samples.load();
    setTimeout(poll, st ? 20_000 : 4_000);
  };
  setTimeout(poll, s ? 20_000 : 4_000);
}

main();
