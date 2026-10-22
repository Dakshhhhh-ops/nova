// Live Ring account panel for the simulator's front-door popover.
// "Sync from Ring" asks the Nova server to call the Ring Partner API (api.amazonvision.com) now,
// then shows the real doorbell (model, online, last check-in), what Nova imported, and every HTTP call it made.
// Kept in its own file so the rest of the simulator doesn't change.

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Ring ids are long; keep a recognizable tail.
const shortPath = (p) => String(p || "").replace(/(ava1\.ring\.[a-z.]+\.)([A-Z0-9]{5})[A-Z0-9]{20,}/g, "$1…$2");
const fmtWhen = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

async function call(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error((isObj(body) && (body.detail || body.error)) || `HTTP ${res.status}`);
  return body;
}

class RingLive {
  constructor(pop) {
    this.pop = pop;
    this.el = document.createElement("div");
    this.el.className = "rl-live";
    this.el.innerHTML = `
      <div class="rl-head">
        <span class="mono rp-k">Ring account</span>
        <span class="rl-src" hidden></span>
      </div>
      <div class="rl-body"><span class="rl-muted">Not synced yet</span></div>
      <ol class="rl-calls" hidden></ol>
      <button type="button" class="rl-sync" role="menuitem">Sync from Ring</button>`;
    pop.prepend(this.el);
    this.body = this.el.querySelector(".rl-body");
    this.src = this.el.querySelector(".rl-src");
    this.calls = this.el.querySelector(".rl-calls");
    this.btn = this.el.querySelector(".rl-sync");
    this.btn.addEventListener("click", (e) => { e.stopPropagation(); this.sync(); });
    this.el.addEventListener("click", (e) => e.stopPropagation()); // keep the popover open while reading
    this.loadStatus();
  }

  async loadStatus() {
    try {
      const s = await call("/api/status");
      const ring = isObj(s?.ring) ? s.ring : {};
      if (!ring.linked) {
        this.body.innerHTML = `<span class="rl-muted">No Ring token on this server. Sync shows the last real sync.</span>`;
        return;
      }
      if (Array.isArray(ring.devices) && ring.devices.length) {
        this.render({ ok: ring.ok, source: "live", devices: ring.devices, at: ring.last_sync }, "Last sync");
      } else {
        this.body.innerHTML = `<span class="rl-muted">Ring account linked. Press Sync to read it now.</span>`;
      }
    } catch { /* the status call is best effort */ }
  }

  async sync() {
    this.btn.disabled = true;
    this.btn.textContent = "Calling the Ring API…";
    this.el.classList.add("busy");
    try {
      const res = await call("/api/ring/sync", { method: "POST" });
      if (res?.ok) this.render(res, "Live Ring API");
      else if (isObj(res?.recorded)) this.render({ ...res.recorded, calls: res.calls, error: res.error, hint: res.hint }, "Recorded · live call failed");
      else this.renderError(res);
    } catch (err) {
      this.renderError({ error: err.message });
    } finally {
      this.btn.disabled = false;
      this.btn.textContent = "Sync from Ring";
      this.el.classList.remove("busy");
    }
  }

  render(res, label) {
    const live = label === "Live Ring API" || label === "Live";
    this.src.textContent = label;
    this.src.className = `rl-src ${live ? "is-live" : "is-recorded"}`;
    this.src.hidden = false;
    const devices = Array.isArray(res.devices) ? res.devices : [];
    const rows = devices.map((d) => {
      const online = d.online === true ? `<span class="rl-dot on"></span>Online` : d.online === false ? `<span class="rl-dot off"></span>Offline` : `<span class="rl-dot"></span>Unknown`;
      const caps = Array.isArray(d.capabilities) && d.capabilities.length ? `<span class="rl-caps">${d.capabilities.map(esc).join(" · ")}</span>` : "";
      const img = typeof d.image_url === "string" && d.image_url.startsWith("https://") ? `<img src="${esc(d.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "";
      return `<div class="rl-dev">${img}<div>
        <strong>${esc(d.name || "Ring device")}</strong>${d.model ? ` <span class="rl-muted">${esc(d.model)}</span>` : ""}
        <span class="rl-state">${online}${d.reported_at ? ` · checked in ${esc(fmtWhen(d.reported_at))}` : ""}</span>${caps}
      </div></div>`;
    }).join("");
    const imported = Array.isArray(res.imported) ? res.imported : [];
    const events = imported.length
      ? `<ul class="rl-events">${imported.slice(0, 4).map((e) => `<li>${esc(e.text || e.event_type)} <span class="rl-muted">${esc(fmtWhen(e.at))}</span></li>`).join("")}</ul>`
      : `<span class="rl-muted">${esc(res.events_note || "No new doorbell or motion events from Ring.")}</span>`;
    const note = res.error ? `<span class="rl-warn">${esc(res.hint || res.error)}</span>` : "";
    this.body.innerHTML = (rows || `<span class="rl-muted">No devices on this Ring account.</span>`) + events + note;
    this.renderCalls(res.calls);
  }

  renderCalls(calls) {
    const list = Array.isArray(calls) ? calls : [];
    this.calls.hidden = !list.length;
    this.calls.innerHTML = list.map((c) => {
      const ok = Number(c.status) < 400;
      return `<li class="${ok ? "" : "bad"}"><span class="rl-mono rl-path">${esc(c.method || "GET")} ${esc(shortPath(c.path))}</span><span class="rl-mono rl-code">${esc(c.status)}${c.ms !== undefined ? ` · ${esc(c.ms)} ms` : ""}</span></li>`;
    }).join("");
  }

  renderError(res) {
    this.src.hidden = true;
    this.body.innerHTML = `<span class="rl-warn">${esc(res?.hint || res?.error || "Ring sync failed")}</span>`;
    this.renderCalls(res?.calls);
  }
}

// The Ring panel is created when the simulator loads its devices; attach once its popover exists.
function attach() {
  const pop = document.querySelector("#ringSlot .ring-pop");
  if (!pop || pop.querySelector(".rl-live")) return Boolean(pop);
  new RingLive(pop);
  return true;
}
if (!attach()) {
  const slot = document.getElementById("ringSlot") || document.body;
  const obs = new MutationObserver(() => { if (attach()) obs.disconnect(); });
  obs.observe(slot, { childList: true, subtree: true });
}
