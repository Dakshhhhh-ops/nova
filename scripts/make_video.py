"""Make the Nova submission video: record the live demo, then edit it into a narrated, subtitled cut under 3 minutes.

    uv run --with playwright --with imageio-ffmpeg --with boto3 --with pillow --with numpy \
        python scripts/make_video.py all --url http://127.0.0.1:8080

Steps (run one with `python scripts/make_video.py <step>`, or `all`)
  narrate  Narration lines with Amazon Polly (generative "Matthew"; Alexa speaks as "Ruth").
  capture  Drive the live demo in headed Chrome through window.NovaDemo and record the screen, with no narration
           playing. Each beat first holds still for as long as its narration line, then acts. Every Alexa reply is
           logged: its text, which Echo said it, the audio, and when it started and stopped playing.
  landing  Re-render the story-page opening frame by frame on a fake clock (the screencast drops frames on 3D).
  cards    Opening and closing title cards (HTML rendered frame by frame) and the chapter labels.
  edit     Cut the waits (model calls, page loads), lay narration, Alexa and a quiet music bed on the new timeline,
           burn in subtitles and chapter labels, and normalize loudness to -14 LUFS.

Outputs demo/nova-submission.mp4 and demo/nova-submission.srt (captions for YouTube). Work files go to demo/build/.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "demo" / "build"
OUT = ROOT / "demo" / "nova-submission.mp4"
FPS = 30
MAX_SECONDS = 178.0

NARRATOR = ("Matthew", "generative")

# The script. Each key is a beat; the capture holds still for the line's length before the beat's action.
LINES: dict[str, str] = {
    "hook": "Fifty-three million Americans care for a family member, unpaid. Many of them, from far away.",
    "landing": "Rose is eighty-one and lives alone in Columbus, Ohio. Her daughter Maya lives in Seattle. "
               "Nova links Rose's Echo Show, her Ring doorbell and Maya's Echo.",
    "reconcile": "After a cardiology visit, Dr. Patel lowers Rose's lisinopril. In Seattle, Maya photographs the "
                 "after-visit summary, and Nova reads the change.",
    "approve": "Nothing changes until Maya approves. Then Rose hears it, in plain words.",
    "oldbottle": "Later, Rose reaches for her old twenty-milligram bottle.",
    "followup": "Maya hears what happened, and orders the new dose with one tap.",
    "evening": "Nova also speaks first. When a pill is missed, it reminds Rose, follows up, and only then tells Maya.",
    "hood": "Under the hood: an MCP server for Alexa+ with twenty-five tools, a token for each person, and consent "
            "by elicitation, with Amazon Nova on Bedrock for language and vision.",
    "end": "Nova never diagnoses. It notices, shows its evidence, and keeps Rose in charge.",
}

# Chapter label shown at the start of a beat: (kicker, title).
CHAPTERS: dict[str, tuple[str, str]] = {
    "reconcile": ("Maya's Echo · Seattle", "A new prescription, read from paper"),
    "approve": ("Two people, one plan", "Nothing changes until someone approves"),
    "oldbottle": ("Rose's kitchen · Columbus", "It catches the old bottle"),
    "followup": ("Maya's Echo · Seattle", "The family hears, and acts"),
    "evening": ("6:00 PM · Time-lapse", "Remind, follow up, then tell the family"),
    "hood": ("Under the hood", "An MCP server for Alexa+"),
}

# How much idle footage to keep around a cut, per beat: (after the last sound, before the next one).
GAPS: dict[str, tuple[float, float]] = {
    "landing": (1.0, 0.6),
    "reconcile": (1.6, 0.5),
    "approve": (1.2, 0.5),
    "oldbottle": (1.4, 0.5),
    "followup": (1.4, 0.5),
    "evening": (2.0, 0.8),
}
GAP_DEFAULT = (0.4, 0.3)
XF_CUT = 0.3     # dissolve at a cut inside the take
XF_CARD = 0.8    # dissolve between a title card and the take
HOOK_PAD = (0.5, 0.7)
TITLE_SECONDS = 3.3
END_SECONDS = 6.5

# Edit choices for this take: beats left out, replies left out, and spoken tails trimmed where nobody answers them.
DROP_BEATS: set[str] = set()
DROP_REPLIES = [r"^Just checking, Rose: have you taken your 6 PM", r"^Got it, I've logged", r"^Sent to Rose",
                r"^Message from Maya"]
DROP_UTTER: set[str] = set()
KEEP_SENTENCES = {r"^Rose, Dr. Patel changed": 1}
TRIM_TAILS = ["Want the details?"]  # nobody answers it in this story
KEEP_TAILS: list[str] = []

DEVICE_NAMES = {"kitchen": "Rose's Echo", "maya": "Maya's Echo"}


# ----------------------------------------------------------------------------------------------- helpers

def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kw)


def duration(path: Path) -> float:
    out = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", out)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0


def silences(path: Path, noise: str = "-38dB", min_d: float = 0.12) -> list[tuple[float, float]]:
    out = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path), "-af", f"silencedetect=noise={noise}:d={min_d}",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", out)]
    total = duration(path)
    if len(ends) < len(starts):
        ends.append(total)
    return list(zip(starts, ends))


def line_path(key: str) -> Path:
    h = hashlib.sha1((LINES[key] + "|".join(NARRATOR)).encode()).hexdigest()[:8]
    return BUILD / "narration" / f"{key}_{h}.mp3"


def line_seconds() -> dict[str, float]:
    return {k: duration(line_path(k)) for k in LINES}


# ----------------------------------------------------------------------------------------------- narrate

def narrate() -> None:
    import boto3

    polly = boto3.client("polly", region_name="us-east-1")
    (BUILD / "narration").mkdir(parents=True, exist_ok=True)
    total = 0.0
    for key, text in LINES.items():
        p = line_path(key)
        if not p.exists():
            voice, engine = NARRATOR
            audio = polly.synthesize_speech(Text=text, OutputFormat="mp3", VoiceId=voice, Engine=engine,
                                            SampleRate="24000")["AudioStream"].read()
            p.write_bytes(audio)
        d = duration(p)
        total += d
        print(f"  {key:10s} {d:5.1f}s")
    print(f"  narration: {total:.1f}s")


# ----------------------------------------------------------------------------------------------- capture

AUDIO_HOOK = """
(() => {
  const A = window.Audio;
  function Patched(src) {
    const a = new A(src);
    let on = false;
    a.addEventListener('playing', () => { if (!on) { on = true; window.__novaAudio && window.__novaAudio('play', a.duration || 0); } });
    const stop = () => { if (on) { on = false; window.__novaAudio && window.__novaAudio('end', a.duration || 0); } };
    a.addEventListener('ended', stop); a.addEventListener('pause', stop); a.addEventListener('error', stop);
    return a;
  }
  Patched.prototype = A.prototype;
  window.Audio = Patched;
})();
"""


class Take:
    def __init__(self, page, base: str, lines: dict[str, float]) -> None:
        self.page = page
        self.base = base.rstrip("/")
        self.lines = lines
        self.t0 = time.monotonic()
        self.tts: list[dict] = []
        self.plays: list[dict] = []
        self.playing = 0
        self.inflight = 0
        self.last_audio = 0.0
        self.anns: list[dict] = []
        self.beats: list[dict] = []
        self.narr: list[dict] = []
        self.utter: list[dict] = []
        self.keeps: list[tuple[float, float]] = []
        self.tasks: list[asyncio.Task] = []

    def now(self) -> float:
        return time.monotonic() - self.t0

    # -- page callbacks
    def on_audio(self, kind: str, dur: float) -> None:
        t = self.now()
        if kind == "play":
            self.playing += 1
            self.plays.append({"t": t, "dur": dur, "end": None})
        else:
            self.playing = max(0, self.playing - 1)
            for p in reversed(self.plays):
                if p["end"] is None:
                    p["end"] = t
                    break
        self.last_audio = t

    def on_ann(self, device: str, title: str) -> None:
        self.anns.append({"t": self.now(), "device": device, "title": title})

    async def route_tts(self, route) -> None:
        self.inflight += 1
        try:
            try:
                body = route.request.post_data_json or {}
            except Exception:
                body = {}
            try:
                resp = await route.fetch()
                data = await resp.body()
            except Exception:
                await route.continue_()
                return
            if resp.status == 200 and data:
                p = BUILD / "alexa" / f"alexa_{len(self.tts):02d}.mp3"
                p.write_bytes(data)
                self.tts.append({"t": self.now(), "text": body.get("text", ""), "device": body.get("device", ""),
                                 "file": p.name, "dur": duration(p)})
            else:
                print(f"  ! /api/tts answered {resp.status}: the browser voice will speak (not captured)")
            await route.fulfill(response=resp, body=data)
        finally:
            self.inflight -= 1
            self.last_audio = self.now()

    # -- driving
    async def js(self, expr: str, timeout: float = 30) -> object:
        try:
            return await asyncio.wait_for(self.page.evaluate(f"async () => {{ return await {expr}; }}"), timeout)
        except Exception as exc:
            print(f"  ! {expr[:70]}: {type(exc).__name__} {str(exc)[:100]}")
            return None

    def fire(self, expr: str, timeout: float = 200) -> None:
        self.tasks.append(asyncio.ensure_future(self.js(expr, timeout)))

    def mark(self, key: str) -> None:
        print(f"[{self.now():6.1f}s] {key}")
        self.beats.append({"key": key, "t": self.now()})

    async def say_line(self, key: str) -> None:
        """Hold still for as long as the narration line (it is laid in during the edit)."""
        d = self.lines[key]
        self.narr.append({"key": key, "t": self.now(), "dur": d})
        await asyncio.sleep(d + 0.35)

    def user(self, who: str, text: str) -> None:
        self.utter.append({"t": self.now(), "who": who, "text": text})

    async def hold(self, secs: float) -> None:
        t = self.now()
        self.keeps.append((t, t + secs))
        await asyncio.sleep(secs)

    async def settle(self, n0: int, expect: int = 1, timeout: float = 45, quiet: float = 1.0) -> bool:
        """Wait until `expect` new Alexa replies have played and the room has been quiet for `quiet` seconds."""
        t_end = time.monotonic() + timeout
        if expect == 0:
            await asyncio.sleep(2.5)
        while time.monotonic() < t_end:
            if self.page.is_closed():
                raise RuntimeError("page closed")
            if (len(self.plays) >= n0 + expect and self.playing == 0 and self.inflight == 0
                    and self.now() - self.last_audio >= quiet):
                return True
            await asyncio.sleep(0.1)
        print(f"  ! waited {timeout:.0f}s: {len(self.plays) - n0}/{expect} replies played")
        return False

    async def wait_plays(self, n: int, timeout: float = 60) -> bool:
        t_end = time.monotonic() + timeout
        while time.monotonic() < t_end:
            if self.page.is_closed():
                raise RuntimeError("page closed")
            if len(self.plays) >= n:
                return True
            await asyncio.sleep(0.05)
        print(f"  ! waited {timeout:.0f}s for {n - len(self.plays)} more replies to start")
        return False

    async def wait_ann(self, device: str, a0: int, timeout: float = 30) -> bool:
        t_end = time.monotonic() + timeout
        while time.monotonic() < t_end:
            if self.page.is_closed():
                raise RuntimeError("page closed")
            if any(a["device"] == device for a in self.anns[a0:]):
                return True
            await asyncio.sleep(0.05)
        print(f"  ! no announcement on {device} within {timeout:.0f}s")
        return False

    async def story(self) -> None:
        page, js = self.page, self.js
        # A clean household at 7:55 AM, normal speed (the reset re-seeds at the current household time).
        status = await (await page.request.get(self.base + "/api/status")).json()
        mcp = status["mcp"]["url"].rsplit("/mcp", 1)[0]
        await page.request.post(mcp + "/demo/clock", data={"time": "07:55", "speed": 1})
        await page.request.post(mcp + "/demo/reset", data={"time": "07:55"})
        await page.request.post(self.base + "/api/reset", timeout=30_000)

        # The story page: scroll through it while the intro line plays.
        await page.goto(self.base + "/", wait_until="domcontentloaded")
        await page.wait_for_timeout(3500)
        self.mark("landing")
        line = asyncio.ensure_future(self.say_line("landing"))
        steps = 9
        await page.wait_for_timeout(1200)
        for _ in range(steps):
            await page.mouse.wheel(0, 380)
            await page.wait_for_timeout(int((self.lines["landing"] - 1.2) * 1000 / steps))
        await line
        await self.hold(0.8)

        self.mark("load")
        await page.goto(self.base + "/live", wait_until="domcontentloaded")
        await js("window.NovaDemo.ready", 40)
        await js("(window.NovaDemo.onAnnouncement((d, item) => window.__novaAnn(String(d), String((item && (item.title || item.text)) || ''))), true)")
        await page.wait_for_timeout(2500)

        # The main story: a prescription change, from paper to plan to the kitchen and back to Maya.
        self.mark("reconcile")
        await js("window.NovaDemo.focus('maya')")
        await self.say_line("reconcile")
        n0 = len(self.plays)
        self.fire("window.NovaDemo.showSample('maya', 'after-visit-summary')")
        await self.settle(n0, 1, 180)
        await self.hold(2.0)

        self.mark("approve")
        await self.say_line("approve")
        n0 = len(self.plays)
        self.fire("window.NovaDemo.approveChanges()")
        await self.hold(1.6)
        await js("window.NovaDemo.focus('kitchen')")
        await self.settle(n0, 1, 45, quiet=1.5)
        await self.hold(1.0)

        self.mark("oldbottle")
        await self.say_line("oldbottle")
        n0 = len(self.plays)
        self.fire("window.NovaDemo.showSample('kitchen', 'pill-lisinopril')")
        await self.wait_plays(n0 + 2, 120)  # Rose's warning, then Maya's alert starts speaking

        self.mark("followup")
        await js("window.NovaDemo.focus('maya')")  # cut to Maya's Echo as her alert is spoken
        await self.settle(n0, 2, 40, quiet=1.0)
        await self.say_line("followup")
        n0 = len(self.plays)
        self.user("Maya", "Order a 10 mg lisinopril refill")
        self.fire("window.NovaDemo.tapReply('maya', 'Order a 10 mg lisinopril refill')")
        await self.settle(n0, 1, 60)
        await self.hold(1.5)

        # A second, shorter example: 6 PM, a missed pill, follow-up, escalation (time-lapse).
        self.mark("evening")
        await js("window.NovaDemo.focus(null)")
        await js("window.NovaDemo.setClock('17:58', 1)")
        await self.say_line("evening")
        a0 = len(self.anns)
        t_lapse = self.now()
        await js("window.NovaDemo.setClock(null, 300)")
        await self.wait_ann("maya", a0, 60)
        await js("window.NovaDemo.setClock(null, 1)")
        self.keeps.append((t_lapse, self.now()))
        await self.settle(len(self.plays), 0, 30, quiet=1.2)
        await self.hold(2.0)

        # Under the hood.
        self.mark("hood")
        await js("(window.NovaDemo.toggleInspector(true), true)")
        await page.wait_for_timeout(300)
        await self.say_line("hood")
        await self.hold(0.6)

        self.mark("end")
        await js("(window.NovaDemo.toggleInspector(false), true)")
        await page.wait_for_timeout(400)
        await self.say_line("end")
        await self.hold(1.5)
        self.mark("fin")


async def capture_async(url: str) -> None:
    from playwright.async_api import async_playwright

    lines = line_seconds()
    for d in ("alexa", "video"):
        shutil.rmtree(BUILD / d, ignore_errors=True)
        (BUILD / d).mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        # Headless with the real GPU (ANGLE/D3D11): full 3D at 60 fps and no window that can be closed mid-take.
        browser = await pw.chromium.launch(channel="chrome", headless=True,
                                           args=["--headless=new", "--use-angle=d3d11", "--enable-gpu",
                                                 "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required",
                                                 # Alexa's audio is captured from /api/tts, so Chrome needn't play it
                                                 # (audio output crashed Chrome mid-take on this machine)
                                                 "--mute-audio",
                                                 "--disable-backgrounding-occluded-windows",
                                                 "--disable-renderer-backgrounding",
                                                 "--disable-background-timer-throttling",
                                                 "--disable-features=CalculateNativeWinOcclusion"])
        browser.on("disconnected", lambda *_: print("  ! browser disconnected"))
        ctx = await browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1,
                                        record_video_dir=str(BUILD / "video"),
                                        record_video_size={"width": 1920, "height": 1080})
        await ctx.add_init_script(AUDIO_HOOK)
        # the recorder drives the story itself, so the on-page story guide stays out of the shot
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style');"
                                  " s.textContent = '.story { display: none !important; }'; document.head.appendChild(s); });")
        holder: dict = {}
        await ctx.expose_function("__novaAudio", lambda kind, dur: holder["take"].on_audio(kind, dur))
        await ctx.expose_function("__novaAnn", lambda d, title: holder["take"].on_ann(d, title))
        page = await ctx.new_page()
        page.on("crash", lambda *_: print("  ! page crashed"))
        page.on("close", lambda *_: print("  ! page closed"))
        page.on("pageerror", lambda e: print(f"  ! page error: {str(e)[:120]}"))
        take = Take(page, url, lines)
        holder["take"] = take
        await page.route("**/api/tts", take.route_tts)
        try:
            await take.story()
        except Exception as exc:
            print(f"  ! take ended early: {type(exc).__name__}: {str(exc)[:160]}")
            take.mark("fin")
        for t in take.tasks:
            t.cancel()
        video = Path(await page.video.path())
        await ctx.close()
        await browser.close()
    shutil.copyfile(video, BUILD / "raw.webm")
    (BUILD / "take.json").write_text(json.dumps({
        "beats": take.beats, "narr": take.narr, "utter": take.utter, "keeps": take.keeps,
        "tts": take.tts, "plays": take.plays, "anns": take.anns,
    }, indent=1), encoding="utf-8")
    print(f"Captured {take.now():.0f}s · {len(take.tts)} Alexa replies · {len(take.plays)} played")


def capture(url: str) -> None:
    asyncio.run(capture_async(url))


# ----------------------------------------------------------------------------------------------- landing

LANDING_SCROLL = 3000  # px: from the hero to the evening cards of "A day"
LANDING_HOLD = 1.2     # s on the hero before scrolling, as in the take


async def landing_async(url: str, seconds: float) -> None:
    """Re-render the story-page opening frame by frame on Playwright's fake clock.

    The live take records Chrome's screencast, which drops frames while the 3D page renders, so the opening
    stuttered. Here the page clock advances exactly one frame per screenshot, so every frame is complete.
    """
    import math

    from playwright.async_api import async_playwright

    n = round(seconds * FPS)
    span = seconds - LANDING_HOLD - 0.3
    out = BUILD / "landing.mp4"
    enc = subprocess.Popen([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate",
                            str(FPS), "-c:v", "mjpeg", "-i", "-", "-vf", "scale=in_range=pc:out_range=tv,format=yuv420p", "-c:v", "libx264",
                            "-preset", "veryfast", "-crf", "13", "-color_range", "tv", "-r", str(FPS), str(out)], stdin=subprocess.PIPE)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome", headless=True,
                                           args=["--headless=new", "--use-angle=d3d11", "--enable-gpu",
                                                 "--ignore-gpu-blocklist", "--mute-audio"])
        ctx = await browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"  ! page error: {str(e)[:120]}"))
        await page.clock.install()
        await page.goto(url.rstrip("/") + "/", wait_until="domcontentloaded")
        for _ in range(60):  # assets load in real time while the page clock runs through the intro
            await page.clock.run_for(100)
            await asyncio.sleep(0.1)
        for i in range(n):
            x = max(0.0, min(1.0, (i / FPS - LANDING_HOLD) / span))
            y = LANDING_SCROLL * (0.5 - 0.5 * math.cos(math.pi * x))
            await page.evaluate("y => window.__lenis ? window.__lenis.scrollTo(y, {immediate: true, force: true})"
                                " : window.scrollTo(0, y)", y)
            await page.clock.run_for(round((i + 1) * 1000 / FPS) - round(i * 1000 / FPS))
            enc.stdin.write(await page.screenshot(type="jpeg", quality=95))
        await browser.close()
    enc.stdin.close()
    enc.wait()
    print(f"  {out.name}: {n} frames, {duration(out):.2f}s")


def landing(url: str) -> None:
    take = json.loads((BUILD / "take.json").read_text(encoding="utf-8"))
    (a, b), *_ = plan(take, match_plays(take))[0]
    asyncio.run(landing_async(url, b - a))


# ----------------------------------------------------------------------------------------------- cards

FONT_FAMILIES = {
    "InstrumentSerif-Regular": "Instrument+Serif",
    "InstrumentSerif-Italic": "Instrument+Serif:ital@1",
    "InterTight-Medium": "Inter+Tight:wght@500",
    "InterTight-SemiBold": "Inter+Tight:wght@600",
    "JetBrainsMono-Medium": "JetBrains+Mono:wght@500",
}


def fetch_fonts() -> Path:
    d = BUILD / "fonts"
    d.mkdir(parents=True, exist_ok=True)
    for name, fam in FONT_FAMILIES.items():
        p = d / f"{name}.ttf"
        if p.exists():
            continue
        css = urllib.request.urlopen(urllib.request.Request(
            f"https://fonts.googleapis.com/css2?family={fam}", headers={"User-Agent": "curl/8"})).read().decode()
        src = re.search(r"url\((https://[^)]+)\)", css).group(1)
        p.write_bytes(urllib.request.urlopen(src).read())
    return d


def font_css() -> str:
    d = BUILD / "fonts"
    faces = [
        ("Instrument Serif", "normal", 400, "InstrumentSerif-Regular"),
        ("Instrument Serif", "italic", 400, "InstrumentSerif-Italic"),
        ("Inter Tight", "normal", 500, "InterTight-Medium"),
        ("Inter Tight", "normal", 600, "InterTight-SemiBold"),
        ("JetBrains Mono", "normal", 500, "JetBrainsMono-Medium"),
    ]
    return "\n".join(
        f"@font-face{{font-family:'{f}';font-style:{s};font-weight:{w};src:url('{(d / (n + '.ttf')).as_uri()}')}}"
        for f, s, w, n in faces)


CARD_BASE = """
:root{--ivory:#F4EEE6;--mist:#A9B3C7;--cyan:#3BD1FF;--amber:#FFB547}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;overflow:hidden;background:#05070c}
body{font-family:'Inter Tight',sans-serif;color:var(--ivory);-webkit-font-smoothing:antialiased}
.bg{position:absolute;inset:0;background:
  radial-gradient(1100px 720px at 50% 58%, rgba(59,209,255,.10), transparent 62%),
  radial-gradient(1600px 900px at 50% 120%, #1b2440 0%, #0a0e18 55%, #05070c 100%)}
.ring{position:absolute;left:50%;top:50%;width:1500px;height:1500px;margin:-750px 0 0 -750px;opacity:.07;
  animation:spin 14s linear both}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;animation:push var(--dur) linear both}
.up{opacity:0;animation:up 1.1s cubic-bezier(.2,.7,.2,1) both}
.mono{font-family:'JetBrains Mono',monospace;font-weight:500;text-transform:uppercase;letter-spacing:.28em}
@keyframes up{from{opacity:0;transform:translateY(26px);filter:blur(10px)}to{opacity:1;transform:none;filter:none}}
@keyframes push{from{transform:scale(1)}to{transform:scale(1.035)}}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(40deg)}}
@keyframes draw{from{stroke-dashoffset:70}to{stroke-dashoffset:0}}
@keyframes pop{0%{transform:scale(0);opacity:0}70%{transform:scale(1.15);opacity:1}100%{transform:scale(1);opacity:1}}
"""

RING_SVG = """<svg viewBox="0 0 32 32" class="{cls}" style="{style}">
<circle cx="16" cy="16" r="11" fill="none" stroke="#3BD1FF" stroke-width="{sw}" stroke-dasharray="15 2.3"
 style="animation:draw 1.4s cubic-bezier(.2,.7,.2,1) {delay}s both"/>
<circle cx="16" cy="16" r="4.2" fill="#3BD1FF" style="transform-origin:16px 16px;animation:pop .7s ease-out {pop}s both"/></svg>"""


def card_html(kind: str, dur: float) -> str:
    big_ring = RING_SVG.format(cls="ring", style="", sw=1.2, delay=0, pop=0.3)
    if kind == "hook":
        body = f"""<div class=bg></div>{big_ring}<div class=wrap>
<div class=up style="animation-delay:.25s;font-family:'Instrument Serif';font-size:230px;line-height:1;letter-spacing:-.02em">53 million</div>
<div class=up style="animation-delay:.85s;font-size:46px;color:var(--ivory);margin-top:26px;font-weight:500">unpaid family caregivers in the U.S.</div>
<div class="up mono" style="animation-delay:1.4s;font-size:18px;color:var(--mist);margin-top:30px">Source · AARP, 2020</div>
</div>"""
    elif kind == "title":
        logo = RING_SVG.format(cls="", style="width:150px;height:150px", sw=2.6, delay=0.05, pop=0.7)
        body = f"""<div class=bg></div>{big_ring}<div class=wrap>
<div class=up style="animation-delay:0s">{logo}</div>
<div class=up style="animation-delay:.25s;font-family:'Instrument Serif';font-size:210px;line-height:.95;margin-top:10px;letter-spacing:-.01em">Nova</div>
<div class=up style="animation-delay:.6s;font-family:'Instrument Serif';font-style:italic;font-size:58px;margin-top:18px">Catches medication mistakes before they happen.</div>
<div class="up mono" style="animation-delay:1.0s;font-size:20px;color:var(--cyan);margin-top:34px">A care circle on Alexa+</div>
</div>"""
    else:
        logo = RING_SVG.format(cls="", style="width:96px;height:96px", sw=2.6, delay=0.05, pop=0.6)
        chip = ("<span class=mono style=\"font-size:17px;letter-spacing:.18em;color:var(--ivory);padding:14px 22px;"
                "border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.04)\">{}</span>")
        chips = "".join(chip.format(c) for c in ("MCP server · 25 tools", "Amazon Nova · Bedrock",
                                                  "Echo Show + Ring", "Amazon Polly"))
        body = f"""<div class=bg></div>{big_ring}<div class=wrap>
<div class=up style="animation-delay:0s;display:flex;align-items:center;gap:28px">{logo}
<span style="font-family:'Instrument Serif';font-size:150px;line-height:1">Nova</span></div>
<div class=up style="animation-delay:.3s;font-family:'Instrument Serif';font-style:italic;font-size:52px;margin-top:22px">Catches medication mistakes before they happen.</div>
<div class=up style="animation-delay:.6s;display:flex;gap:16px;margin-top:56px">{chips}</div>
<div class=up style="animation-delay:.9s;margin-top:64px;display:flex;gap:64px;font-size:30px;font-weight:500">
<span><span class=mono style="font-size:15px;color:var(--cyan);display:block;margin-bottom:10px">GitHub</span>github.com/Dakshhhhh-ops/nova</span></div>
<div class="up mono" style="animation-delay:1.3s;font-size:16px;color:var(--mist);margin-top:70px">Built for Amazon Build, Ship, Shape · Alexa+ track</div>
</div>"""
    return (f"<!doctype html><html><head><meta charset=utf-8><style>{font_css()}{CARD_BASE}"
            f".wrap{{--dur:{dur}s}}</style></head><body>{body}</body></html>")


LABEL_HTML = """<!doctype html><html><head><meta charset=utf-8><style>{fonts}
*{{margin:0;padding:0;box-sizing:border-box}} html,body{{background:transparent}}
#lab{{display:inline-flex;flex-direction:column;gap:8px;padding:18px 26px 20px 24px;margin:20px;border-radius:18px;
 background:rgba(8,12,21,.80);border:1px solid rgba(255,255,255,.13);box-shadow:0 12px 40px rgba(0,0,0,.30);
 border-left:3px solid #3BD1FF}}
.k{{font-family:'JetBrains Mono';font-weight:500;font-size:15px;letter-spacing:.2em;text-transform:uppercase;color:#3BD1FF}}
.t{{font-family:'Instrument Serif';font-size:42px;line-height:1.05;color:#F4EEE6}}
</style></head><body><div id=lab><div class=k>{k}</div><div class=t>{t}</div></div></body></html>"""


async def cards_async(secs: dict[str, float]) -> None:
    from playwright.async_api import async_playwright

    fetch_fonts()
    cd = BUILD / "cards"
    cd.mkdir(parents=True, exist_ok=True)
    durs = {"hook": HOOK_PAD[0] + secs["hook"] + HOOK_PAD[1], "title": TITLE_SECONDS, "end": END_SECONDS}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome")
        page = await browser.new_page(viewport={"width": 1920, "height": 1080})
        for kind, dur in durs.items():
            html = cd / f"{kind}.html"
            html.write_text(card_html(kind, dur), encoding="utf-8")
            await page.goto(html.as_uri())
            await page.evaluate("document.fonts.ready")
            await page.wait_for_timeout(300)
            n = int(round(dur * FPS))
            enc = subprocess.Popen([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe",
                                    "-framerate", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "12",
                                    "-pix_fmt", "yuv420p", "-r", str(FPS), str(cd / f"{kind}.mp4")], stdin=subprocess.PIPE)
            for i in range(n):
                await page.evaluate("(ms) => document.getAnimations().forEach(a => { a.pause(); a.currentTime = ms; })",
                                    i * 1000 / FPS)
                enc.stdin.write(await page.screenshot(type="png"))
            enc.stdin.close()
            enc.wait()
            print(f"  card {kind}: {dur:.1f}s")
        for key, (k, t) in CHAPTERS.items():
            await page.set_content(LABEL_HTML.format(fonts=font_css(), k=k, t=t))
            await page.evaluate("document.fonts.ready")
            await page.wait_for_timeout(150)
            await page.locator("#lab").screenshot(path=str(cd / f"label_{key}.png"), omit_background=True)
        await browser.close()
    # Bottom gradient that keeps subtitles readable over light and dark parts of the scene.
    from PIL import Image

    g = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0))
    px = g.load()
    for y in range(700, 1080):
        a = int(150 * ((y - 700) / 380) ** 1.6)
        for x in range(1920):
            px[x, y] = (4, 6, 12, a)
    g.save(cd / "shade.png")


def cards() -> None:
    asyncio.run(cards_async(line_seconds()))


# ----------------------------------------------------------------------------------------------- music

def make_music(path: Path, total: float, swells: list[tuple[float, float]]) -> None:
    """A slow, warm pad (D major), with a soft bell now and then. Quiet by design; ducked under speech."""
    import numpy as np

    sr = 48000
    n = int((total + 1) * sr)
    t = np.arange(n) / sr
    out = np.zeros((n, 2))
    hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)  # noqa: E731
    chords = [[50, 57, 61, 64, 66], [47, 54, 57, 62, 64], [43, 50, 54, 57, 59], [45, 52, 54, 59, 62]]
    bar = 8.0
    rng = np.random.default_rng(7)
    k = 0
    start = 0.0
    while start < total + 1:
        notes = chords[k % len(chords)]
        a, b = int(start * sr), min(n, int((start + bar + 3.0) * sr))
        seg = t[a:b] - start
        env = np.minimum(1, seg / 2.2) * np.clip((bar + 3.0 - seg) / 3.0, 0, 1)
        env = env ** 1.5
        for j, m in enumerate(notes):
            f = hz(m)
            for side, det in ((0, -0.0017), (1, 0.0017)):
                ph = rng.uniform(0, 6.28)
                w = (np.sin(2 * np.pi * f * (1 + det) * seg + ph) + 0.22 * np.sin(4 * np.pi * f * seg + ph)
                     + 0.06 * np.sin(6 * np.pi * f * seg))
                out[a:b, side] += w * env * (0.9 if j == 0 else 0.55)
        root = hz(notes[0] - 12)
        out[a:b, :] += (0.5 * np.sin(2 * np.pi * root * seg) * env)[:, None]
        # bells on a slow pentatonic line
        for bt in (1.0, 3.5, 5.0, 7.0):
            if rng.random() < 0.55:
                m = int(rng.choice([74, 76, 78, 81, 83, 86]))
                ba = int((start + bt) * sr)
                bl = min(n - ba, int(2.8 * sr))
                if bl <= 0:
                    continue
                bs = np.arange(bl) / sr
                bell = (np.sin(2 * np.pi * hz(m) * bs) + 0.3 * np.sin(2 * np.pi * hz(m) * 2.01 * bs)) * np.exp(-bs * 2.2)
                bell *= np.minimum(1, bs / 0.01)
                pan = rng.uniform(0.3, 0.7)
                out[ba:ba + bl, 0] += bell * 0.35 * (1 - pan)
                out[ba:ba + bl, 1] += bell * 0.35 * pan
        start += bar
        k += 1
    # reverb (the low-pass happens in ffmpeg): convolve with a decaying noise tail
    ir_len = int(2.6 * sr)
    ir_t = np.arange(ir_len) / sr
    wet = np.zeros_like(out)
    for c in range(2):
        ir = rng.standard_normal(ir_len) * np.exp(-ir_t * 2.4)
        ir[: int(0.02 * sr)] *= np.linspace(0, 1, int(0.02 * sr))
        size = 1 << int(np.ceil(np.log2(n + ir_len)))
        wet[:, c] = np.fft.irfft(np.fft.rfft(out[:, c], size) * np.fft.rfft(ir, size), size)[:n]
    wet /= np.max(np.abs(wet)) + 1e-9
    dry = out / (np.max(np.abs(out)) + 1e-9)
    mixd = 0.55 * dry + 0.6 * wet
    # level automation: quiet bed, louder when nobody speaks (title cards)
    gain = np.full(n, 0.55)
    for s, e in swells:
        a, b = int(s * sr), int(min(e, total + 1) * sr)
        ramp = int(1.0 * sr)
        seg = np.ones(max(0, b - a))
        seg[:ramp] = np.linspace(0, 1, min(ramp, len(seg)))[: len(seg[:ramp])]
        seg[-ramp:] = np.minimum(seg[-ramp:], np.linspace(1, 0, min(ramp, len(seg)))[-len(seg[-ramp:]):])
        gain[a:b] = np.maximum(gain[a:b], 0.55 + 0.45 * seg)
    mixd *= gain[:, None]
    fade_in, fade_out = int(1.5 * sr), int(3.0 * sr)
    mixd[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
    end = int(total * sr)
    mixd[end - fade_out:end] *= np.linspace(1, 0, fade_out)[:, None]
    mixd[end:] = 0
    mixd = mixd / (np.max(np.abs(mixd)) + 1e-9) * 0.5
    pcm = (mixd * 32767).astype(np.int16)
    import wave

    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


# ----------------------------------------------------------------------------------------------- edit

def merge(iv: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for a, b in sorted(iv):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def match_plays(take: dict) -> list[dict]:
    """Pair each audio element that played with the /api/tts reply it came from (order + length)."""
    tts = list(take["tts"])
    used = [False] * len(tts)
    out = []
    for p in take["plays"]:
        best = None
        for i, r in enumerate(tts):
            if used[i] or r["t"] > p["t"] + 0.5:
                continue
            if abs((p["dur"] or r["dur"]) - r["dur"]) < 0.35:
                best = i
                break
        if best is None:
            continue
        used[best] = True
        r = tts[best]
        if any(re.search(rx, r["text"]) for rx in DROP_REPLIES):
            continue
        # ends are attributed loosely when a chime overlaps, so trust the clip length
        out.append({**r, "t": p["t"], "end": p["t"] + r["dur"], "play": r["dur"]})
    for i, r in enumerate(tts):
        if not used[i] and not any(re.search(rx, r["text"]) for rx in DROP_REPLIES):
            print(f"  ! reply fetched but not played (laid in where its card appears): {r['text'][:60]}")
            out.append({**r, "t": r["t"] + 0.3, "end": r["t"] + 0.3 + r["dur"], "play": r["dur"]})
    out.sort(key=lambda r: r["t"])
    for r in out:
        trim_tail(r)
    return out


def keep_sentences(r: dict, n: int) -> None:
    """Keep the first n sentences of a reply: cut the audio at the pause nearest the sentence end."""
    sents = re.split(r"(?<!Dr\.)(?<=[.!?])\s+", r["text"].strip())
    if len(sents) <= n:
        return
    kept = " ".join(sents[:n])
    clip = BUILD / "alexa" / r["file"]
    sil = silences(clip, "-38dB", 0.1)
    s0 = sil[0][1] if sil and sil[0][0] <= 0.05 else 0.0
    est = s0 + (r["dur"] - s0) * len(kept) / len(r["text"])
    cands = [a for a, b in sil if 0.5 < a < r["dur"] - 0.3]
    if not cands:
        return
    cut = min(cands, key=lambda a: abs(a - est)) + 0.12
    r["text"], r["play"], r["end"] = kept, cut, r["t"] + cut


def trim_tail(r: dict) -> None:
    """Cut a closing question nobody answers ("Want the details?") at the pause before it."""
    for rx, n in KEEP_SENTENCES.items():
        if re.search(rx, r["text"]):
            keep_sentences(r, n)
            return
    if any(re.search(rx, r["text"]) for rx in KEEP_TAILS):
        return
    for tail in TRIM_TAILS:
        if not r["text"].rstrip().endswith(tail):
            continue
        clip = BUILD / "alexa" / r["file"]
        cands = [a for a, b in silences(clip, "-38dB", 0.1) if 0.5 < a < r["dur"] - 0.6]
        if not cands:
            return
        cut = cands[-1] + 0.12
        r["text"] = r["text"].rstrip()[: -len(tail)].rstrip()
        r["play"] = cut
        r["end"] = r["t"] + cut
        return


def chimes(take: dict, alexa: list[dict]) -> list[float]:
    """Plays that weren't speech: the app's two-note announcement chime (synthesized in the page)."""
    speech_starts = [a["t"] for a in alexa] + [r["t"] for r in take["tts"]]
    out = []
    for p in take["plays"]:
        if 1.3 < (p["dur"] or 0) < 1.9 and all(abs(p["t"] - s) > 0.2 for s in speech_starts):
            out.append(p["t"])
    return out


def make_chime(path: Path) -> None:
    import wave

    import numpy as np

    rate = 22050
    notes = [(783.99, 0, 1.0), (1174.66, 0.15, 1.3)]
    n = int(rate * 1.55)
    data = np.zeros(n)
    for f, dt, dur in notes:
        s0, k = int(dt * rate), int(dur * rate)
        t = np.arange(min(k, n - s0)) / rate
        env = np.where(t < 0.012, 0.14 * t / 0.012, 0.14 * (0.0001 / 0.14) ** ((t - 0.012) / max(0.05, dur - 0.012)))
        w = 2 * np.pi * f * t
        data[s0:s0 + len(t)] += env * (np.sin(w) + 0.22 * np.sin(2 * w) + 0.06 * np.sin(3.01 * w))
    with wave.open(str(path), "wb") as wv:
        wv.setnchannels(1)
        wv.setsampwidth(2)
        wv.setframerate(rate)
        wv.writeframes((np.clip(data, -1, 1) * 30000).astype(np.int16).tobytes())


def plan(take: dict, alexa: list[dict]) -> tuple[list[tuple[float, float]], dict]:
    beats = take["beats"]
    t_of = {b["key"]: b["t"] for b in beats}
    start, fin = t_of["landing"], t_of["fin"]

    def beat_at(t: float) -> str:
        k = beats[0]["key"]
        for b in beats:
            if b["t"] <= t + 1e-6:
                k = b["key"]
        return k

    secs = line_seconds()
    dropped = lambda t: beat_at(t) in DROP_BEATS  # noqa: E731
    acts = [(n["t"] - 0.15, n["t"] + secs[n["key"]] + 0.25) for n in take["narr"] if n["key"] not in DROP_BEATS]
    acts += [(a["t"] - 0.25, a["end"] + 0.35) for a in alexa if not dropped(a["t"])]
    acts += [(u["t"] - 0.3, u["t"] + 1.5) for u in take["utter"] if not dropped(u["t"]) and u["text"] not in DROP_UTTER]
    # holds are not kept on their own: the gap rules leave a short beat after each reply
    acts = [(max(a, start), min(b, fin)) for a, b in merge(acts) if b > start and a < fin]
    segs: list[tuple[float, float]] = []
    cur_s, cur_e = start, start
    for a, b in acts:
        head, tail = GAPS.get(beat_at(cur_e), GAP_DEFAULT)
        if a - cur_e <= head + tail + 0.2:
            cur_e = max(cur_e, b)
        else:
            segs.append((cur_s, cur_e + head))
            cur_s, cur_e = a - tail, b
    segs.append((cur_s, min(cur_e + 0.4, fin)))
    return segs, t_of


class Timeline:
    """Raw take time -> final video time, through the kept segments and their dissolves."""

    def __init__(self, segs: list[tuple[float, float]], offset: float) -> None:
        self.segs = segs
        self.starts = []
        t = offset
        for i, (a, b) in enumerate(segs):
            if i:
                t -= XF_CUT
            self.starts.append(t)
            t += b - a
        self.end = t

    def __call__(self, t: float) -> float | None:
        for (a, b), s in zip(self.segs, self.starts):
            if a - 1e-6 <= t <= b + 1e-6:
                return s + (t - a)
        return None


def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def srt_time(t: float) -> str:
    ms = int(round(max(0.0, t) * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def chunk_text(text: str, maxlen: int = 84) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    sents = re.split(r"(?<!Dr\.)(?<=[.!?])\s+", text)
    out: list[str] = []
    for s in sents:
        if len(s) <= maxlen:
            out.append(s)
            continue
        cur = ""
        for p in re.split(r"(?<=[,;:])\s+|\s+(?=—)", s):
            if cur and len(cur) + 1 + len(p) > maxlen:
                out.append(cur)
                cur = p
            else:
                cur = f"{cur} {p}".strip()
        if cur:
            out.append(cur)
    final: list[str] = []
    for c in out:
        while len(c) > maxlen + 12:
            cut = c.rfind(" ", 0, maxlen)
            final.append(c[:cut])
            c = c[cut + 1:]
        final.append(c)
    # fold tiny tails into the previous chunk
    merged: list[str] = []
    for c in final:
        if merged and len(c) < 18 and len(merged[-1]) + len(c) < maxlen + 20:
            merged[-1] += " " + c
        else:
            merged.append(c)
    return merged


def timed_chunks(text: str, clip: Path, at: float, limit: float | None = None) -> list[tuple[float, float, str]]:
    """Split a spoken line into subtitle chunks, with boundaries snapped to the pauses in the audio."""
    chunks = chunk_text(text)
    dur = min(duration(clip), limit or 1e9)
    sil = [(a, min(b, dur)) for a, b in silences(clip) if a < dur - 0.05]
    s0 = sil[0][1] if sil and sil[0][0] <= 0.05 else 0.0
    s1 = sil[-1][0] if sil and sil[-1][1] >= dur - 0.05 else dur
    pauses = [(a + b) / 2 for a, b in sil if a > s0 + 0.05 and b < s1 - 0.05]
    total_chars = sum(len(c) for c in chunks) or 1
    bounds = [s0]
    acc = 0
    for c in chunks[:-1]:
        acc += len(c)
        est = s0 + (s1 - s0) * acc / total_chars
        near = min(pauses, key=lambda p: abs(p - est), default=None)
        bounds.append(near if near is not None and abs(near - est) < 0.9 and near > bounds[-1] + 0.4 else est)
    bounds.append(s1)
    out = []
    for i, c in enumerate(chunks):
        a, b = bounds[i], bounds[i + 1]
        out.append((at + a - 0.05, at + max(b, a + 1.0) + (0.15 if i == len(chunks) - 1 else 0.0), c))
    # close small gaps so the text doesn't flicker
    for i in range(len(out) - 1):
        a, b, c = out[i]
        if out[i + 1][0] - b < 0.45:
            out[i] = (a, out[i + 1][0] - 0.02, c)
    return out


ASS_HEAD = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Narr,{sans},46,&H00FFFFFF,&H00FFFFFF,&H78000000,&H96000000,0,0,0,0,100,100,0,0,1,2.2,1.2,2,300,300,58,1
Style: Alexa,{sans},46,&H00FFF4CF,&H00FFFFFF,&H78000000,&H96000000,0,0,0,0,100,100,0,0,1,2.2,1.2,2,300,300,58,1
Style: Person,{serif},54,&H00E6EEF4,&H00FFFFFF,&H78000000,&H96000000,0,1,0,0,100,100,0,0,1,2.2,1.2,2,300,300,56,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def font_family(path: Path) -> str:
    from PIL import ImageFont

    return ImageFont.truetype(str(path), 20).getname()[0]


def edit() -> None:
    take = json.loads((BUILD / "take.json").read_text(encoding="utf-8"))
    secs = line_seconds()
    alexa = match_plays(take)
    segs, t_of = plan(take, alexa)
    cd = BUILD / "cards"
    hook_d, title_d, end_d = duration(cd / "hook.mp4"), duration(cd / "title.mp4"), duration(cd / "end.mp4")
    foot0 = hook_d - XF_CARD + title_d - XF_CARD
    tl = Timeline(segs, foot0)
    end_start = tl.end - XF_CARD
    total = end_start + end_d
    print(f"  {len(segs)} segments · footage {tl.end - foot0:.1f}s · total {total:.1f}s")
    if total > MAX_SECONDS:
        print(f"  ! {total:.1f}s is over {MAX_SECONDS:.0f}s: trim lines or holds")

    # -- the picture: cut segments out of a constant-frame-rate copy of the take
    cfr = BUILD / "raw_cfr.mp4"
    if not cfr.exists() or cfr.stat().st_mtime < (BUILD / "raw.webm").stat().st_mtime:
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(BUILD / "raw.webm"), "-vf", f"fps={FPS}",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-an", str(cfr)])
    sd = BUILD / "segs"
    shutil.rmtree(sd, ignore_errors=True)
    sd.mkdir()
    smooth = BUILD / "landing.mp4"  # the story-page opening, re-rendered frame by frame (see `landing`)
    for i, (a, b) in enumerate(segs):
        if i == 0 and smooth.exists():
            run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(smooth), "-t", f"{b - a:.3f}",
                 "-vf", "tpad=stop_mode=clone:stop_duration=1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "13",
                 "-pix_fmt", "yuv420p", "-r", str(FPS), str(sd / "s00.mp4")])
            continue
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{a:.3f}", "-i", str(cfr), "-t", f"{b - a:.3f}",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "13", "-pix_fmt", "yuv420p", "-r", str(FPS),
             str(sd / f"s{i:02d}.mp4")])
    clips = [cd / "hook.mp4", cd / "title.mp4", *[sd / f"s{i:02d}.mp4" for i in range(len(segs))], cd / "end.mp4"]
    durs = [duration(c) for c in clips]
    xfs = [0.0, XF_CARD, XF_CARD] + [XF_CUT] * (len(segs) - 1) + [XF_CARD]

    # -- subtitles and chapter labels on the final timeline
    fonts = fetch_fonts()
    sans = font_family(fonts / "InterTight-Medium.ttf")
    serif = font_family(fonts / "InstrumentSerif-Italic.ttf")
    mono = font_family(fonts / "JetBrainsMono-Medium.ttf")
    events: list[tuple[float, float, str, str, str]] = []  # start, end, style, text(ass), plain(srt)
    narr_at: dict[str, float] = {"hook": HOOK_PAD[0]}
    for n in take["narr"]:
        if n["key"] in DROP_BEATS:
            continue
        ft = tl(n["t"])
        if ft is None:
            print(f"  ! narration {n['key']} fell in a cut")
            continue
        narr_at[n["key"]] = ft
    for key, at in narr_at.items():
        for a, b, c in timed_chunks(LINES[key], line_path(key), at):
            events.append((a, b, "Narr", ass_escape(c), c))
    alexa_at = []
    for r in alexa:
        ft = tl(r["t"])
        if ft is None:
            print(f"  ! Alexa reply fell in a cut: {r['text'][:50]}")
            continue
        alexa_at.append((ft, r))
        label = DEVICE_NAMES.get(r["device"], "Alexa").upper()
        tag = "{\\fn" + mono + "\\fs24\\fsp3\\c&H00FFD13B&}" + label + "   {\\r}"
        for a, b, c in timed_chunks(r["text"], BUILD / "alexa" / r["file"], ft, r["play"]):
            events.append((a, b, "Alexa", tag + ass_escape(c), f"[{DEVICE_NAMES.get(r['device'], 'Alexa')}] {c}"))
    for u in take["utter"]:
        ft = tl(u["t"])
        if ft is None or u["text"] in DROP_UTTER:
            continue
        tag = "{\\fn" + mono + "\\fs24\\fsp3\\i0\\c&H0047B5FF&}" + u["who"].upper() + "   {\\r}"
        events.append((ft, ft + 1.8, "Person", tag + "“" + ass_escape(u["text"]) + "”", f"[{u['who']}] {u['text']}"))
    events.sort()
    # never let two lines sit on screen at once
    for i in range(len(events) - 1):
        a, b, *rest = events[i]
        if b > events[i + 1][0]:
            events[i] = (a, max(a + 0.3, events[i + 1][0] - 0.02), *rest)
    ass = ASS_HEAD.format(sans=sans, serif=serif) + "".join(
        f"Dialogue: 0,{ass_time(a)},{ass_time(b)},{st},,0,0,0,,{{\\blur0.6}}{tx}\n" for a, b, st, tx, _ in events)
    (BUILD / "subs.ass").write_text(ass, encoding="utf-8")
    srt = "".join(f"{i}\n{srt_time(a)} --> {srt_time(b)}\n{plain}\n\n" for i, (a, b, _, _, plain) in enumerate(events, 1))
    OUT.with_suffix(".srt").write_text(srt, encoding="utf-8")

    labels = []
    for key in CHAPTERS:
        if key in narr_at and (cd / f"label_{key}.png").exists():
            labels.append((narr_at[key] - 0.2, key))

    # -- video pass
    inputs: list[str] = []
    for c in clips:
        inputs += ["-i", str(c)]
    li = len(clips)
    inputs += ["-loop", "1", "-i", str(cd / "shade.png")]
    for _, key in labels:
        inputs += ["-loop", "1", "-t", "4.6", "-i", str(cd / f"label_{key}.png")]
    f = []
    for i in range(len(clips)):
        f.append(f"[{i}:v]fps={FPS},format=yuv420p,setsar=1,settb=1/{FPS * 1000}[c{i}]")
    cur, t = "c0", durs[0]
    for i in range(1, len(clips)):
        off = t - xfs[i]
        f.append(f"[{cur}][c{i}]xfade=transition=fade:duration={xfs[i]}:offset={off:.3f}[x{i}]")
        cur, t = f"x{i}", off + durs[i]
    f.append(f"[{li}:v]format=rgba[shade]")
    f.append(f"[{cur}][shade]overlay=0:0:shortest=1:enable='between(t,{foot0:.2f},{end_start + XF_CARD:.2f})'[v0]")
    cur = "v0"
    for j, (at, key) in enumerate(labels):
        k = li + 1 + j
        f.append(f"[{k}:v]format=rgba,fade=t=in:st=0:d=0.45:alpha=1,fade=t=out:st=4.0:d=0.6:alpha=1,"
                 f"setpts=PTS-STARTPTS+{at:.3f}/TB[l{j}]")
        f.append(f"[{cur}][l{j}]overlay=x=22:y=70:eof_action=pass:enable='between(t,{at:.2f},{at + 4.6:.2f})'[w{j}]")
        cur = f"w{j}"
    f.append(f"[{cur}]subtitles=filename=subs.ass:fontsdir=fonts,fade=t=out:st={total - 0.9:.2f}:d=0.9[vout]")
    video = BUILD / "video.mp4"
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", ";".join(f),
         "-map", "[vout]", "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", "slow", "-crf", "17",
         "-pix_fmt", "yuv420p", "-color_range", "tv", "-r", str(FPS), "-movflags", "+faststart", str(video)], cwd=BUILD)

    # -- sound: narration, Alexa (a touch of 'speaker' EQ), music ducked under both, then loudness
    music = BUILD / "music.wav"
    make_music(music, total, [(hook_d - XF_CARD - 0.5, foot0 + 1.0), (end_start, total)])
    ain: list[str] = []
    af: list[str] = []
    labels_a: list[str] = []
    idx = 0
    for key, at in narr_at.items():
        ain += ["-i", str(line_path(key))]
        ms = int(at * 1000)
        af.append(f"[{idx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms},volume=1.0[a{idx}]")
        labels_a.append(f"[a{idx}]")
        idx += 1
    for ft, r in alexa_at:
        ain += ["-i", str(BUILD / "alexa" / r["file"])]
        ms = int(ft * 1000)
        af.append(f"[{idx}:a]atrim=0:{r['play']:.3f},afade=t=out:st={max(0, r['play'] - 0.08):.3f}:d=0.08,"
                  f"aresample=48000,aformat=channel_layouts=stereo,highpass=f=110,"
                  f"equalizer=f=3200:t=q:w=1.2:g=1.5,adelay={ms}|{ms},volume=0.92[a{idx}]")
        labels_a.append(f"[a{idx}]")
        idx += 1
    chime = BUILD / "chime.wav"
    make_chime(chime)
    for t in chimes(take, alexa):
        ft = tl(t)
        if ft is None or not (foot0 < ft < end_start):
            continue
        ain += ["-i", str(chime)]
        ms = int(ft * 1000)
        af.append(f"[{idx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms},volume=0.55[a{idx}]")
        labels_a.append(f"[a{idx}]")
        idx += 1
    ain += ["-i", str(music)]
    mi = idx
    af.append(f"{''.join(labels_a)}amix=inputs={len(labels_a)}:normalize=0:dropout_transition=0,"
              f"apad,atrim=0:{total:.3f}[speech]")
    af.append("[speech]asplit=2[sp][sc]")
    af.append(f"[{mi}:a]atrim=0:{total:.3f},lowpass=f=3800,lowpass=f=6000,volume=0.22[mus]")
    af.append("[mus][sc]sidechaincompress=threshold=0.015:ratio=5:attack=60:release=700[duck]")
    af.append("[sp][duck]amix=inputs=2:normalize=0:dropout_transition=0[mix]")
    mixwav = BUILD / "mix.wav"
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *ain, "-filter_complex", ";".join(af),
         "-map", "[mix]", "-ar", "48000", "-c:a", "pcm_s16le", str(mixwav)])
    meas = subprocess.run([FFMPEG, "-hide_banner", "-i", str(mixwav), "-af",
                           "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                          capture_output=True, text=True).stderr
    m = json.loads(meas[meas.rfind("{"):meas.rfind("}") + 1])
    norm = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
            f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(video), "-i", str(mixwav),
         "-filter_complex", f"[1:a]{norm},aresample=48000,afade=t=out:st={total - 1.2:.2f}:d=1.2[a]",
         "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}",
         "-movflags", "+faststart", str(OUT)])
    print(f"Done: {OUT} ({duration(OUT):.1f}s) and {OUT.with_suffix('.srt').name}")


# ----------------------------------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["narrate", "capture", "landing", "cards", "edit", "all", "post"])
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    args = ap.parse_args()
    BUILD.mkdir(parents=True, exist_ok=True)
    if args.step in ("narrate", "all"):
        print("Narration…")
        narrate()
    if args.step in ("capture", "all"):
        print("Capture…")
        capture(args.url)
    if args.step in ("landing", "all"):
        print("Landing…")
        landing(args.url)
    if args.step in ("cards", "all", "post"):
        print("Cards…")
        cards()
    if args.step in ("edit", "all", "post"):
        print("Edit…")
        edit()


if __name__ == "__main__":
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")
    main()
