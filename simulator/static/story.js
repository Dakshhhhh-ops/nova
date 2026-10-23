/* The story bar: a guided path through Nova's main story, one button per step.
   A prescription change goes from paper to plan to the kitchen and back to the family,
   then a shorter second example (a missed evening dose). Each step drives the same
   window.NovaDemo calls the demo-video recorder uses. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { waitForSpeech: false }; // a step is done when its answer is on screen; the voice keeps playing

const STEPS = [
  {
    title: "A new prescription",
    text: "After a cardiology visit, Maya photographs Dr. Patel's after-visit summary. Nova reads the lisinopril change.",
    action: "Scan the summary",
    async run(D) {
      D.focus("maya");
      await D.showSample("maya", "after-visit-summary", FAST);
    },
  },
  {
    title: "Maya approves",
    text: "Nothing changes until she approves. Then Rose's Echo explains the change in plain words.",
    action: "Approve the change",
    async run(D) {
      await D.approveChanges();
      D.focus("kitchen");
    },
  },
  {
    title: "The old bottle",
    text: "Later, Rose reaches for her old 20 mg lisinopril and holds it up to her Echo Show.",
    action: "Show Alexa the old bottle",
    async run(D) {
      D.focus("kitchen");
      await D.showSample("kitchen", "pill-lisinopril", FAST);
    },
  },
  {
    title: "Maya acts",
    text: "Maya's Echo tells her what happened. She orders the new 10 mg dose in one tap.",
    action: "Order the 10 mg refill",
    async run(D) {
      D.focus("maya");
      await D.tapReply("maya", "Order a 10 mg lisinopril refill", FAST);
    },
  },
  {
    title: "A missed dose",
    text: "Fast-forward to 6 PM. Nova reminds Rose, follows up, and only then tells Maya.",
    action: "Play the evening",
    async run(D, story) {
      D.focus(null);
      await D.setClock("17:59", 1);
      await sleep(300);
      const told = story.nextAnnouncement("maya", 90_000);
      await D.setClock(null, 600); // 6 PM to 7:30 PM in about nine seconds
      await told;
      await D.setClock(null, 1);
    },
  },
];

const ICON_CLOSE = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

class Story {
  constructor(host) {
    this.idx = -1; // -1: not started; STEPS.length: finished
    this.busy = false;
    this.waiters = [];
    this.el = document.createElement("aside");
    this.el.className = "story";
    this.el.setAttribute("aria-label", "The story, step by step");
    this.el.innerHTML = `
      <button class="story-pill" type="button" aria-expanded="false"><i aria-hidden="true"></i><span>The story</span></button>
      <div class="story-card">
        <div class="story-head">
          <span class="mono story-k"></span>
          <button class="icon-btn sm story-min" type="button" title="Hide">${ICON_CLOSE}</button>
        </div>
        <b class="story-title"></b>
        <p class="story-text"></p>
        <div class="story-dots" aria-hidden="true">${STEPS.map(() => "<i></i>").join("")}</div>
        <div class="story-actions">
          <button class="story-go" type="button"></button>
          <button class="text-btn small story-alt" type="button"></button>
        </div>
      </div>`;
    host.appendChild(this.el);
    this.$ = (s) => this.el.querySelector(s);
    this.$(".story-go").addEventListener("click", () => this.go());
    this.$(".story-alt").addEventListener("click", () => (this.idx < 0 ? this.collapse(true) : this.start()));
    this.$(".story-min").addEventListener("click", () => this.collapse(true));
    this.$(".story-pill").addEventListener("click", () => this.collapse(false));
    let collapsed = false;
    try { collapsed = localStorage.getItem("nova.story.collapsed") === "1"; } catch { /* storage blocked */ }
    this.collapse(collapsed, false);
    this.render();
  }

  get demo() { return window.NovaDemo; }

  collapse(on, remember = true) {
    this.el.classList.toggle("is-collapsed", on);
    this.$(".story-pill").setAttribute("aria-expanded", String(!on));
    if (remember) { try { localStorage.setItem("nova.story.collapsed", on ? "1" : "0"); } catch { /* storage blocked */ } }
  }

  onAnnouncement(device) {
    this.waiters = this.waiters.filter((w) => (w.device === device ? (w.resolve(), false) : true));
  }

  nextAnnouncement(device, timeout) {
    return new Promise((resolve) => {
      const w = { device, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(); }, timeout);
    });
  }

  // A clean household at 7:55 AM, so every step works the same at any real time of day.
  async start() {
    if (this.busy) return;
    this.setBusy(true, "Setting up the household…");
    try {
      await this.demo.reset();
      await this.demo.setClock("07:55", 1);
      this.idx = 0;
    } catch (err) {
      this.note(`Couldn't start: ${err.message}`);
    } finally {
      this.setBusy(false);
    }
  }

  async go() {
    if (this.busy) return;
    if (this.idx < 0 || this.idx >= STEPS.length) { await this.start(); if (this.idx === 0) await this.go(); return; }
    const step = STEPS[this.idx];
    this.setBusy(true, `${step.action}…`);
    try {
      await step.run(this.demo, this);
      this.idx += 1;
    } catch (err) {
      this.note(/No care plan update/.test(err.message) ? "Scan the summary first, or start over." : err.message);
    } finally {
      this.setBusy(false);
    }
  }

  setBusy(on, label) {
    this.busy = on;
    this.el.classList.toggle("is-busy", on);
    this.render(on ? label : undefined);
  }

  note(text) {
    this.render();
    this.$(".story-text").textContent = text;
  }

  render(busyLabel) {
    const done = this.idx >= STEPS.length, fresh = this.idx < 0;
    const step = STEPS[Math.max(0, Math.min(this.idx, STEPS.length - 1))];
    this.$(".story-k").textContent = fresh ? "Start here" : done ? "The story" : `Step ${this.idx + 1} of ${STEPS.length}`;
    this.$(".story-title").textContent = fresh ? "A prescription change, start to finish" : done ? "That's the story" : step.title;
    this.$(".story-text").textContent = fresh
      ? "Five steps, about two minutes: Maya scans the new prescription, approves it, Rose shows her old bottle, and Maya orders the right dose."
      : done ? "Now try anything: talk to either Echo, show Alexa another bottle, or open Under the hood to see every MCP call."
        : step.text;
    this.$$dots();
    const go = this.$(".story-go");
    go.textContent = busyLabel || (fresh ? "Start the story" : done ? "Play it again" : step.action);
    go.disabled = !!busyLabel;
    const alt = this.$(".story-alt");
    alt.textContent = fresh ? "Not now" : "Start over";
    alt.hidden = done || !!busyLabel;
  }

  $$dots() {
    [...this.el.querySelectorAll(".story-dots i")].forEach((d, k) => {
      d.className = k < this.idx ? "done" : k === this.idx ? "on" : "";
    });
  }
}

async function mount() {
  const host = document.querySelector("#scene");
  if (!host) return;
  for (let i = 0; i < 200 && !window.NovaDemo; i++) await sleep(50);
  if (!window.NovaDemo) return;
  const story = new Story(host);
  window.NovaDemo.onAnnouncement((device) => story.onAnnouncement(String(device)));
  document.querySelector("#resetBtn")?.addEventListener("click", () => { if (!story.busy) { story.idx = -1; story.render(); } });
}

mount();
