// Nova · Alexa+ simulator, browser side.
// Talks to simulator/app.py (see docs/CONTRACT.md) and hosts MCP Apps views
// (ext-apps 2026-01-26) in sandboxed iframes on each Echo Show screen.

/* ===================================================================== config */

// Logical screen canvases (CSS px before scaling): Echo Show 8 is 16:10, Echo Show 15 is 16:9.
const LOGICAL = { show8: { w: 720, h: 450 }, show15: { w: 800, h: 450 } };
const IDLE_AFTER_MS = 90_000;
const HINT_EVERY_MS = 8_000;
const PERSON_COLORS = { rose: "#F7A1B5", maya: "#9DB8FF", leo: "#8EDBA9", grace: "#F6CF52" };
const UI_TOOLS = new Set(["get_today", "care_briefing", "prepare_visit"]);

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
};

// Used only if /api/status is unreachable, so the page still renders.
const FALLBACK_DEVICES = [
  {
    id: "kitchen", label: "Rose's kitchen",
    person: { id: "rose", name: "Rose Alvarez", short_name: "Rose", role: "elder", location: "Columbus, Ohio", device: "Echo Show 8 · Kitchen" },
    suggestions: ["I took my blood pressure pill", "I'm feeling a bit dizzy today", "Any messages?", "What do I have today?"],
  },
  {
    id: "maya", label: "Maya's office",
    person: { id: "maya", name: "Maya Alvarez-Chen", short_name: "Maya", role: "caregiver", location: "Seattle, Washington", device: "Echo Show 15 · Home office" },
    suggestions: ["How's Mom doing?", "Help me get ready for Mom's cardiology visit", "Tell Mom I love her", "Any alerts?"],
  },
];

/* ==================================================================== helpers */

// The household clock. The server can pin it (NOVA_CLOCK) for a demo recording; when
// /api/status reports it we follow it, otherwise we use the browser's clock.
const clock = {
  skew: 0,
  now() { return new Date(Date.now() + this.skew); },
  sync(iso) {
    const d = iso ? new Date(iso) : null;
    if (d && !Number.isNaN(d.getTime())) this.skew = d.getTime() - Date.now();
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function parseTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const fmtTime = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const fmtClockSec = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
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
function hashColor(key) {
  const pal = ["#F7A1B5", "#9DB8FF", "#8EDBA9", "#F6CF52", "#C7B3FF", "#7FE0E8"];
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

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// fetch wrapper: JSON in/out, timeout, readable errors (FastAPI puts them in `detail`).
async function api(path, { method = "GET", body, timeout = 120_000, raw = false } = {}) {
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
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320); }, ms);
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
  dose: '<svg viewBox="0 0 20 20" aria-hidden="true"><g transform="rotate(-40 10 10)"><rect x="2.5" y="6.5" width="15" height="7" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.5v7" stroke="currentColor" stroke-width="1.6"/></g></svg>',
  checkin: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16.5s-6.5-3.8-6.5-8.3A3.6 3.6 0 0 1 10 6a3.6 3.6 0 0 1 6.5 2.2c0 4.5-6.5 8.3-6.5 8.3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  message: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l7.5 13h-15z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8.2v3.6M10 13.9v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  dot: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.5" fill="currentColor"/></svg>',
};

/* ===================================================================== speech */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
const estimateMs = (text) => Math.min(12_000, Math.max(1_200, (String(text).split(/\s+/).length / 2.6) * 1000));

// One voice at a time across both devices. Polly via /api/tts first, browser voice as fallback.
const speech = {
  muted: false,
  queue: [],
  current: null,
  pollyOffUntil: 0,
  _voice: null,
  _utterance: null,

  say(text, device) {
    text = String(text ?? "").trim();
    if (!text || !device) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push({ text, device, resolve, stopped: false, cancel: null });
      this.pump();
    });
  },

  async pump() {
    if (this.current || !this.queue.length) return;
    const job = (this.current = this.queue.shift());
    try { await this.play(job); } catch { /* never let speech break the page */ }
    if (this.current === job) this.current = null;
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

  async play(job) {
    const { text, device } = job;
    if (this.muted) {
      device.setLight("speaking");
      await new Promise((r) => { const t = setTimeout(r, estimateMs(text)); job.cancel = () => { clearTimeout(t); r(); }; });
      return;
    }
    let blob = null;
    if (Date.now() >= this.pollyOffUntil) {
      try {
        const res = await api("/api/tts", { method: "POST", body: { text, device: device.id }, raw: true, timeout: 15_000 });
        const type = res.headers.get("content-type") || "";
        if (res.status === 200 && type.startsWith("audio")) blob = await res.blob();
        else this.pollyOffUntil = Date.now() + 60_000; // 204: Polly unavailable, skip the round trip for a while
      } catch {
        this.pollyOffUntil = Date.now() + 60_000;
      }
    }
    if (job.stopped) return;
    device.setLight("speaking");
    if (blob && blob.size) await this.playBlob(blob, job);
    else await this.speakBrowser(text, job);
  },

  playBlob(blob, job) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { audio.pause(); } catch { /* ignore */ }
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onended = finish;
      audio.onerror = finish;
      job.cancel = finish;
      audio.play().catch(finish);
    });
  },

  speakBrowser(text, job) {
    if (!synth) return new Promise((r) => { const t = setTimeout(r, estimateMs(text)); job.cancel = () => { clearTimeout(t); r(); }; });
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(safety); resolve(); };
      const u = new SpeechSynthesisUtterance(text);
      const v = this.voice();
      if (v) u.voice = v;
      u.lang = v?.lang || "en-US";
      u.rate = 1;
      u.pitch = 1;
      u.onend = finish;
      u.onerror = finish;
      this._utterance = u; // keep a reference: Chrome can drop onend for collected utterances
      const safety = setTimeout(finish, estimateMs(text) * 2 + 4_000);
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
          hostInfo: { name: "Nova Alexa+ Simulator", version: "0.1.0" },
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
        if (Number.isFinite(h) && h > 0) this.iframe.style.height = `${Math.min(Math.ceil(h), this.device.cardMaxHeight())}px`;
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

/* ==================================================================== devices */

const devices = new Map();

class Device {
  constructor(def) {
    this.id = def.id;
    this.el = $("#deviceTpl").content.firstElementChild.cloneNode(true);
    const q = (s) => $(s, this.el);
    this.ui = {
      avatar: q(".avatar"), name: q(".pn"), role: q(".role-tag"), meta: q(".person-meta"),
      state: q(".dev-state"), stateText: q(".dev-state span"), focusBtn: q(".focus-btn"),
      fit: q(".screen-fit"), screen: q(".screen"),
      loc: q(".amb-loc"), time: q(".amb-time"), date: q(".amb-date"), hint: q(".amb-hint"), hintText: q(".hint-text"),
      tsLoc: q(".ts-loc"), tsTime: q(".ts-time"), turns: q(".turns"),
      caption: q(".caption-text"), cardFrame: q(".card-frame"), cardClose: q(".card-close"), elicit: q(".elicit-layer"),
      form: q(".composer"), input: q(".say"), send: q(".send"), mic: q(".mic"), chips: q(".chips"),
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
    this.model = /\b15\b/.test(`${p.device || ""} ${def.label || ""}`) ? "show15" : "show8";
    this.size = LOGICAL[this.model];
    this.el.classList.toggle("show15", this.model === "show15");
    this.el.classList.toggle("show8", this.model === "show8");
    this.el.dataset.device = this.id;
    this.el.dataset.scene = p.role === "elder" ? "warm" : p.role === "caregiver" ? "cool" : this.id === "kitchen" ? "warm" : "cool";
    this.color = PERSON_COLORS[p.id] || hashColor(p.id || this.id);
    this.el.style.setProperty("--pc", this.color);

    this.ui.avatar.textContent = this.shortName.charAt(0).toUpperCase();
    this.ui.name.textContent = p.name || def.label || this.id;
    this.ui.role.textContent = p.role === "elder" ? "Care recipient" : p.role === "caregiver" ? "Caregiver" : String(p.role || "");
    this.ui.role.hidden = !p.role;
    this.ui.meta.textContent = [p.device, p.location].filter(Boolean).join(" · ") || def.label || "";

    const room = String(p.device || "").split("·")[1]?.trim();
    const city = String(p.location || "").split(",")[0].trim();
    const place = [room, city].filter(Boolean).join(" · ") || def.label || "";
    this.ui.loc.textContent = place;
    this.ui.tsLoc.textContent = place;
    // Rose's clock is the story clock (server local time); Pacific-coast devices run three hours behind it.
    this.clockOffsetH = /Seattle|Washington|Oregon|California|Pacific/i.test(p.location || "") ? -3 : /Texas|Austin|Chicago|Central/i.test(p.location || "") ? -1 : 0;

    this.ui.input.placeholder = `Talk to Alexa as ${this.shortName}…`;
    this.ui.focusBtn.title = `Focus ${this.shortName}'s Echo Show`;
    this.setSuggestions(def.suggestions);
    this.fit();
  }

  setSuggestions(list) {
    const items = arr(list).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 6);
    if (!items.length && this.suggestions.length) return;
    if (items.join("\n") === this.suggestions.join("\n")) return; // unchanged: keep the buttons (and any click in flight)
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
    if (!this.ui.hintText.textContent) this.rotateHint(true);
  }

  bind() {
    const { form, input, send, chips, cardClose, focusBtn, fit } = this.ui;
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
      if (chip && !chip.disabled) this.send(chip.dataset.text);
    });
    this.ui.mic.addEventListener("click", () => mic.toggle(this));
    cardClose.addEventListener("click", () => this.closeCard());
    focusBtn.addEventListener("click", () => toggleFocus(this.id));
    if ("ResizeObserver" in window) new ResizeObserver(() => this.fit()).observe(fit);
  }

  // Scale the logical canvas to the bezel's inner width.
  fit() {
    const w = this.ui.fit.clientWidth;
    if (w) this.ui.screen.style.setProperty("--scale", (w / this.size.w).toFixed(5));
  }

  tick(now) {
    const d = new Date(now.getTime() + this.clockOffsetH * 3_600_000);
    const t = fmtTime(d);
    this.ui.time.textContent = t.replace(/\s?[AP]M$/i, "");
    this.ui.tsTime.textContent = t;
    this.ui.date.textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  }

  rotateHint(immediate = false) {
    const { hint, hintText } = this.ui;
    if (!this.suggestions.length) { hint.hidden = true; return; }
    hint.hidden = false;
    const next = `“Alexa, ${afterWake(this.suggestions[this.hintIdx++ % this.suggestions.length])}”`;
    if (immediate) { hintText.textContent = next; return; }
    if (this.ui.screen.classList.contains("active")) return;
    hint.classList.add("swap");
    setTimeout(() => { hintText.textContent = next; hint.classList.remove("swap"); }, 450);
  }

  /* ---- light bar + state ---- */
  setLight(state) {
    this.light = state;
    this.ui.screen.dataset.light = state;
    this.ui.state.dataset.state = state;
    this.ui.stateText.textContent = { idle: "Ready", listening: "Listening", thinking: "Thinking", speaking: "Speaking" }[state] || "Ready";
  }

  // Derive the resting light from what the device is doing right now.
  settleLight() {
    if (speech.current?.device === this && this.light === "speaking") return;
    this.setLight(this.micOn || this.elicit ? "listening" : this.busy ? "thinking" : "idle");
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
      if (this.busy || this.elicit || this.card || this.micOn || this.light !== "idle") { this.scheduleIdle(); return; }
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
    a.textContent = text;
  }

  // Live trace events for this device: show which Nova tool is running.
  onTrace(item) {
    if (!this.pendingTurn || !isObj(item)) return;
    if (item.kind === "tool_call" && item.name) {
      const s = this.pendingTurn.querySelector(".tool-status");
      if (s) s.textContent = `${TOOL_STATUS[item.name] || `Using Nova · ${item.name}`}…`;
    }
  }

  async send(text, { source = "user" } = {}) {
    text = String(text || "").trim();
    if (!text) return;
    if (this.elicit) { this.answerElicitByVoice(text); return; }
    if (this.busy) { toast(`${this.shortName}'s Echo Show is still answering…`); return; }

    speech.interrupt(this.id);
    this.setBusy(true);
    this.wake();
    this.closeCard();
    const turn = this.newTurn(text);
    this.pendingTurn = turn;
    this.setThinking(turn);
    this.setLight("listening");
    setTimeout(() => { if (this.busy && this.light === "listening" && !this.elicit && !this.micOn) this.setLight("thinking"); }, 450);

    const rec = inspector.beginTurn(this.id, text, source);
    const gen = this.gen;
    const t0 = performance.now();
    let reply = "", cards = [], failed = false;
    try {
      const res = (await api("/api/chat", { method: "POST", body: { device: this.id, text }, timeout: 180_000 })) || {};
      reply = String(res.reply ?? "").trim() || "Sorry, I didn't catch that.";
      cards = arr(res.cards).filter((c) => isObj(c) && typeof c.html === "string" && c.html.trim());
      if (res.brain) status.noteBrain(res.brain);
      inspector.endTurn(rec, res, Math.round(performance.now() - t0));
    } catch (err) {
      failed = true;
      reply = "Sorry, I'm having trouble reaching Nova right now.";
      inspector.endTurn(rec, null, Math.round(performance.now() - t0), err);
      toast(err.message || "Chat failed", "error");
    }

    this.pendingTurn = null;
    this.setBusy(false);
    if (gen !== this.gen) { this.settleLight(); return; } // the demo was reset mid-turn
    this.hideElicit(); // the turn is over, so any open prompt is moot
    this.fillReply(turn, reply, failed);
    if (cards.length) this.showCard(cards[cards.length - 1], reply);
    this.setLight("thinking"); // until the voice starts
    await speech.say(reply, this);
    this.settleLight();
    this.scheduleIdle();
  }

  /* ---- MCP App card ---- */
  cardMaxHeight() {
    return Math.max(160, this.ui.cardFrame.clientHeight || this.size.h - 84);
  }

  showCard(card, caption) {
    this.closeCard();
    const host = new AppHost(this, card);
    this.card = host;
    this.ui.caption.textContent = caption || "";
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

  /* ---- elicitation ---- */
  showElicit(ev) {
    this.elicit = ev;
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

  reset() {
    this.gen++;
    clearTimeout(this.idleTimer);
    this.closeCard();
    this.hideElicit();
    this.liveTurn = null;
    this.ui.screen.classList.remove("active");
    this.ui.turns.replaceChildren();
    this.setLight("idle");
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

function toggleFocus(id) {
  const box = $("#devices");
  const leaving = box.dataset.focus === id;
  for (const d of devices.values()) d.el.classList.toggle("focused", !leaving && d.id === id);
  if (leaving || !devices.has(id)) delete box.dataset.focus;
  else box.dataset.focus = id;
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
    dev.fit();
    dev.tick(clock.now());
  }
  // Drop placeholder devices that the backend doesn't know about.
  const ids = new Set(list.map((d) => d.id));
  for (const [id, dev] of devices) {
    if (!ids.has(id)) { dev.reset(); dev.el.remove(); devices.delete(id); }
  }
}

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
  return Object.entries(a).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? ""}`).join(", ");
}

function renderTraceItem(item, start) {
  const known = ["user", "llm", "tool_call", "tool_result", "elicit", "elicit_answer", "reply", "error", "app_call"];
  const kind = known.includes(item.kind) ? item.kind : "other";
  const el = document.createElement("div");
  el.className = `ti k-${kind}`;
  const at = parseTime(item.at);
  const rel = at && start ? Math.max(0, at - start) : null;
  const relHTML = rel !== null ? `<span class="ti-ms">+${(rel / 1000).toFixed(2)}s</span>` : "";
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

class TraceGroup {
  constructor(deviceId, text, { source = null, start = null, uri = "" } = {}) {
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
    const badge = $(".badge", this.el);
    badge.textContent = dev?.shortName || deviceId || "?";
    badge.style.setProperty("--pc", dev?.color || hashColor(deviceId));
    this.textEl = $(".tg-text", this.el);
    this.metaEl = $(".tg-meta", this.el);
    this.itemsEl = $(".tg-items", this.el);
    this.created = new Date();
    this.setText(text);
    this.renderMeta();
  }

  setText(text) {
    if (this.source === "tap") {
      const file = String(this.uri || "").split("/").pop();
      this.textEl.innerHTML = `On-screen tap${file ? ` <span class="via file">${esc(file)}</span>` : ""}`;
      return;
    }
    this.textEl.textContent = text ? `“${text}”` : "Turn";
    if (this.source === "app") this.textEl.insertAdjacentHTML("beforeend", '<span class="via">from MCP App</span>');
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
    const clock = fmtClockSec(this.created);
    this.metaEl.innerHTML = this.latency !== null ? `${esc(clock)}<br><b>${esc(fmtMs(this.latency))}</b>` : esc(clock);
  }

  add(item) {
    if (!isObj(item)) return;
    this.count++;
    if (!this.start) this.start = parseTime(item.at);
    this.itemsEl.append(renderTraceItem(item, this.start));
  }
}

const inspector = {
  list: null,
  empty: null,
  current: new Map(),   // device -> TraceGroup receiving events
  turns: new Map(),     // device -> pending chat turn {group, sse}
  appCalls: new Map(),  // device -> pending app call {group, sse}

  init() {
    this.list = $("#traceList");
    this.empty = $("#traceEmpty");
  },

  clear() {
    this.list.replaceChildren();
    this.current.clear();
    this.turns.clear();
    this.appCalls.clear();
    this.updateEmpty();
  },

  updateEmpty() { this.empty.hidden = this.list.children.length > 0; },

  newGroup(deviceId, text, opts) {
    const g = new TraceGroup(deviceId, text, opts);
    const pane = this.list.parentElement;
    const nearTop = pane.scrollTop < 60;
    this.list.prepend(g.el);
    while (this.list.children.length > 40) this.list.lastElementChild.remove();
    this.current.set(deviceId, g);
    this.updateEmpty();
    if (nearTop) pane.scrollTop = 0;
    return g;
  },

  beginTurn(deviceId, text, source) {
    const group = this.newGroup(deviceId, text, { source: source === "app" ? "app" : null });
    group.awaitingUser = true;
    const rec = { device: deviceId, group, sse: 0 };
    this.turns.set(deviceId, rec);
    return rec;
  },

  async endTurn(rec, res, ms, err) {
    const g = rec.group;
    // Normally the SSE stream already delivered every step. If it didn't (stream down),
    // fall back to the trace returned by /api/chat.
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

  // A trace item from the SSE stream.
  onEvent(deviceId, item) {
    if (!isObj(item)) return;
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
        if (item.text && g.source !== "app") g.setText(item.text);
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

/* ================================================================ care circle */

const circleFeed = {
  list: null,
  seen: new Set(),
  loaded: false,
  unread: 0,
  timer: 0,

  init() { this.list = $("#circleList"); this.list.innerHTML = '<div class="pane-note">Loading the care circle…</div>'; },

  reset() { this.seen.clear(); this.loaded = false; this.unread = 0; updateBadge(); },

  refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 250);
  },

  async load() {
    try {
      const res = await api("/api/timeline", { timeout: 15_000 });
      this.render(arr(res?.items));
    } catch {
      if (!this.loaded) this.list.innerHTML = '<div class="pane-note">The care circle feed appears once the simulator backend is running.</div>';
    }
  },

  render(items) {
    const key = (it) => `${it.at}|${it.kind}|${it.who}|${it.text}`;
    const html = [];
    let lastDay = null, fresh = 0;
    const KIND = { dose: "Medication", checkin: "Check-in", message: "Message", alert: "Alert" };
    for (const it of items) {
      if (!isObj(it)) continue;
      const isNew = this.loaded && !this.seen.has(key(it));
      if (isNew) fresh++;
      const d = parseTime(it.at);
      const day = dayLabel(d);
      if (day !== lastDay) { html.push(`<div class="circle-day">${esc(day)}</div>`); lastDay = day; }
      const kind = ["dose", "checkin", "message", "alert"].includes(it.kind) ? it.kind : "other";
      const sev = ["info", "watch", "urgent"].includes(it.severity) ? it.severity : "watch";
      const who = String(it.who || "").trim();
      html.push(`<div class="ci k-${kind}${kind === "alert" ? ` sev-${sev}` : ""}${isNew ? " fresh" : ""}">
        <div class="ci-ico">${ICON[kind] || ICON.dot}</div>
        <div class="ci-main">
          <div class="ci-top">${who ? `<span class="ci-who">${esc(who.charAt(0).toUpperCase() + who.slice(1))}</span>` : ""}<span class="ci-kind">${esc(kind === "alert" && it.severity ? `${it.severity} alert` : KIND[kind] || it.kind || "Update")}</span><span class="ci-time">${d ? esc(fmtTime(d)) : ""}</span></div>
          <div class="ci-text">${esc(it.text || "")}</div>
        </div></div>`);
    }
    if (!html.length) html.push('<div class="pane-note">Nothing in the care circle yet.</div>');
    this.list.innerHTML = html.join("");
    this.seen = new Set(items.filter(isObj).map(key));
    this.loaded = true;
    if (fresh) {
      if (activeTab !== "circle") { this.unread += fresh; updateBadge(); }
      setTimeout(() => { for (const el of this.list.querySelectorAll(".ci.fresh")) el.classList.remove("fresh"); }, 4_000);
    }
  },
};

let activeTab = "trace";
function updateBadge() {
  const b = $("#circleBadge");
  b.hidden = !circleFeed.unread;
  b.textContent = circleFeed.unread > 9 ? "9+" : String(circleFeed.unread);
}
function setTab(name) {
  activeTab = name;
  for (const t of document.querySelectorAll(".tab")) {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  }
  $("#tracePane").classList.toggle("active", name === "trace");
  $("#circlePane").classList.toggle("active", name === "circle");
  if (name === "circle") { circleFeed.unread = 0; updateBadge(); circleFeed.load(); }
}

/* ===================================================================== status */

const status = {
  data: null,

  async load() {
    try {
      const s = await api("/api/status", { timeout: 8_000 });
      if (!isObj(s)) throw new Error("Bad status");
      this.data = s;
      this.render(s);
      return s;
    } catch {
      this.renderOffline();
      return null;
    }
  },

  render(s) {
    clock.sync(s.household_now ?? s.now ?? s.clock?.now);
    const brain = isObj(s.brain) ? s.brain : {};
    const bp = $("#brainPill");
    const name = String(brain.name || "").toLowerCase();
    bp.dataset.state = !name ? "off" : name === "bedrock" ? "bedrock" : name === "rules" || name === "none" ? "rules" : "ok";
    $("#brainLabel").textContent = brain.label || brain.name || "Unknown";
    bp.title = `Agent brain: ${brain.label || brain.name || "unknown"}`;

    const m = isObj(s.mcp) ? s.mcp : {};
    const tools = arr(m.tools);
    const mp = $("#mcpPill");
    mp.dataset.state = m.connected ? "ok" : "off";
    $("#mcpLabel").textContent = m.connected
      ? [m.server_name || "nova", m.protocol_version, `${tools.length} tool${tools.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
      : "Not connected";
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
      <div class="pv-note">Teal tools ship an MCP App screen (ui://nova/…).</div>` : ""}`;
  },

  noteBrain(b) {
    const label = brainName(b);
    if (label) $("#brainLabel").textContent = label;
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
    for (const name of ["trace", "elicit", "elicit_done", "circle", "reset"]) es.addEventListener(name, (e) => this.handle(e.data, name));
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
      case "reset":
        resetUI();
        break;
      default:
        break;
    }
  },
};

/* ===================================================================== wiring */

let lastReset = 0;
function resetUI() {
  if (Date.now() - lastReset < 1_000) return;
  lastReset = Date.now();
  speech.stopAll();
  mic.stop();
  for (const d of devices.values()) d.reset();
  inspector.clear();
  circleFeed.reset();
  circleFeed.load();
  status.load();
}

async function doReset() {
  const btn = $("#resetBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    await api("/api/reset", { method: "POST", timeout: 30_000 });
    resetUI();
    toast("Demo reset. Fresh household loaded.");
  } catch (err) {
    toast(`Reset failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
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

  // MCP popover
  const pill = $("#mcpPill"), pop = $("#mcpPopover");
  const closePop = () => { pop.hidden = true; pill.setAttribute("aria-expanded", "false"); };
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    pop.hidden = !open;
    pill.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) closePop(); });

  // Inspector: collapsible column on wide screens, bottom drawer on narrow ones
  const stage = $("#stage"), insp = $("#inspector"), toggle = $("#inspectorToggle");
  const narrow = window.matchMedia("(max-width: 1180px)");
  const syncToggle = () => {
    const shown = narrow.matches ? insp.classList.contains("open") : !stage.classList.contains("insp-hidden");
    toggle.setAttribute("aria-pressed", String(shown));
  };
  toggle.addEventListener("click", () => {
    if (narrow.matches) insp.classList.toggle("open");
    else stage.classList.toggle("insp-hidden");
    syncToggle();
  });
  $("#drawerHandle").addEventListener("click", () => { insp.classList.toggle("open"); syncToggle(); });
  narrow.addEventListener?.("change", syncToggle);
  syncToggle();

  for (const t of document.querySelectorAll(".tab")) {
    t.addEventListener("click", () => {
      setTab(t.dataset.tab);
      if (narrow.matches && !insp.classList.contains("open")) { insp.classList.add("open"); syncToggle(); }
    });
  }
  $("#clearTrace").addEventListener("click", () => inspector.clear());

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!pop.hidden) { closePop(); return; }
    const box = $("#devices");
    if (box.dataset.focus) toggleFocus(box.dataset.focus);
  });

  if (!SR) document.body.classList.add("no-speech");
}

async function main() {
  inspector.init();
  circleFeed.init();
  wireChrome();

  // Prefer the backend's device list; fall back so the page always renders.
  const s = await status.load();
  mountDevices(arr(s?.devices).length ? s.devices : FALLBACK_DEVICES);

  // Clocks and idle-screen hints
  const tickAll = () => { const now = clock.now(); for (const d of devices.values()) d.tick(now); };
  tickAll();
  setInterval(tickAll, 5_000);
  setInterval(() => { for (const d of devices.values()) d.rotateHint(); }, HINT_EVERY_MS);

  sse.connect();
  circleFeed.load();
  setInterval(() => circleFeed.load(), 30_000);

  // Keep the status pills fresh; poll faster while the backend is down.
  const poll = async () => {
    const st = await status.load();
    if (st && arr(st.devices).length) mountDevices(st.devices);
    setTimeout(poll, st ? 20_000 : 4_000);
  };
  setTimeout(poll, s ? 20_000 : 4_000);
}

main();
