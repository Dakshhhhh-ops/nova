"""Record the Nova demo video: real Chrome, Alexa's real voice replies, a narrator, one MP4.

    uv run --with playwright --with imageio-ffmpeg --with boto3 python scripts/record_demo.py \
        --url http://127.0.0.1:8080 --out demo/nova-demo.mp4

What it does
1. Synthesizes the narration with Amazon Polly (a different voice from Alexa's).
2. Opens the landing page, then the live demo, in headed Chrome (WebGL needs a GPU) at 1920x1080
   and records the screen.
3. Drives the story through `window.NovaDemo` (the Studio's automation hook), falling back to the
   HTTP API if the hook is missing.
4. Captures every `/api/tts` reply the page plays (that's Alexa speaking) with its timestamp.
5. Mixes narration + Alexa audio onto the video with ffmpeg (bundled by imageio-ffmpeg) and caps it at 2:58.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import boto3
import imageio_ffmpeg
from playwright.async_api import Page, async_playwright

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
MAX_SECONDS = 178
NARRATOR = ("Matthew", "generative")

# (narration, action, settle_seconds). The action runs after the narration line finishes.
SCENES: list[tuple[str, str, float]] = [
    ("Rose is eighty-one and lives alone in Columbus, Ohio. Her daughter Maya lives in Seattle. Nova links Rose's "
     "Echo, her Ring doorbell and Maya's Echo, to catch medication mistakes before they happen.", "landing", 1.0),
    ("Nova speaks first. At eight, Rose's Echo reminds her about her morning pills.", "morning", 4.0),
    ("Her knee hurts, so she shows Alexa the ibuprofen. Nova reads the label and checks it against her doctor's "
     "notes.", "pill_avoid", 5.0),
    ("At nine, Nova checks in. Before her family hears about a symptom, Nova asks Rose.", "checkin", 3.0),
    ("In Seattle, Maya asks how Mom is doing. One sentence first, the evidence when she asks.", "briefing", 1.5),
    ("Nova reads the front door from Ring's own API. When Grace, the home aide, rings the bell, Nova knows "
     "she's expected, and gives her today's checklist.", "ring", 4.0),
    ("After the cardiology visit, Maya photographs the summary. Nova reconciles the medication list, and nothing "
     "changes until she approves.", "reconcile", 5.0),
    ("In the evening, the six o'clock pill is missed. Nova reminds Rose, follows up, and only then tells Maya.",
     "evening", 2.0),
    ("Under the hood: twenty-five MCP tools over Streamable HTTP, a token for each person, MCP Apps on the Echo "
     "Show, consent by elicitation, and Ring. Amazon Nova on Bedrock is the brain; this recording runs on Nova's "
     "offline router, because our new AWS account's Bedrock quota is still zero.", "hood", 3.0),
    ("Nova never diagnoses. It notices, shows its evidence, and keeps Rose in charge.", "end", 2.0),
]


def polly_clip(text: str, path: Path) -> float:
    polly = boto3.client("polly")
    voice, engine = NARRATOR
    for eng in (engine, "neural"):
        try:
            audio = polly.synthesize_speech(Text=text, OutputFormat="mp3", VoiceId=voice, Engine=eng)["AudioStream"].read()
            path.write_bytes(audio)
            return duration(path)
        except Exception as exc:  # try the next engine
            last = exc
    raise RuntimeError(f"Polly failed: {last}")


def duration(path: Path) -> float:
    out = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", out)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0


class Recorder:
    def __init__(self, page: Page, base: str, tmp: Path) -> None:
        self.page = page
        self.base = base.rstrip("/")
        self.tmp = tmp
        self.t0 = time.monotonic()
        self.narration: list[tuple[float, Path]] = []
        self.alexa: list[tuple[float, Path]] = []
        self.timeline: list[dict] = []
        self._routed = False

    def now(self) -> float:
        return time.monotonic() - self.t0

    async def capture_tts(self) -> None:
        """Every Alexa reply goes through /api/tts: fetch it here, keep a copy, hand the same bytes to the page."""
        if self._routed:
            return
        self._routed = True

        async def handle(route) -> None:
            try:
                resp = await route.fetch()
                body = await resp.body()
            except Exception:
                await route.continue_()
                return
            if resp.status == 200 and body:
                p = self.tmp / f"alexa_{len(self.alexa):02d}.mp3"
                p.write_bytes(body)
                self.alexa.append((self.now(), p))
            await route.fulfill(response=resp, body=body)

        await self.page.route("**/api/tts", handle)

    async def narrate(self, clip: Path, secs: float) -> None:
        self.narration.append((self.now(), clip))
        await asyncio.sleep(secs + 0.25)

    async def wait_ready(self, timeout: float = 30) -> None:
        try:
            await asyncio.wait_for(self.page.evaluate("async () => { if (window.NovaDemo) await window.NovaDemo.ready; }"), timeout)
        except Exception as exc:
            print(f"  ! stage not ready after {timeout}s: {type(exc).__name__}")

    async def demo(self, expr: str, timeout: float = 25) -> None:
        """Call window.NovaDemo; fall back to the HTTP API when the hook isn't there. Never blocks the take."""
        if self.page.is_closed():
            return
        try:
            has_hook = await self.page.evaluate("() => !!window.NovaDemo")
            body = f"async () => {{ return await {expr}; }}" if has_hook else f"async () => {{ return await ({fallback(expr)}); }}"
            # Fire the call; don't wait longer than `timeout` for it to settle (the page keeps running either way).
            await asyncio.wait_for(asyncio.shield(asyncio.ensure_future(self.page.evaluate(body))), timeout)
        except Exception as exc:
            print(f"  ! {expr[:60]}: {type(exc).__name__} {str(exc)[:80]}")
        self.timeline.append({"t": round(self.now(), 2), "do": expr})

    async def run(self, clips: list[tuple[Path, float]]) -> None:
        page = self.page
        await self.capture_tts()
        for (text, action, settle), (clip, secs) in zip(SCENES, clips):
            print(f"[{self.now():6.1f}s] {action}")
            if action == "landing":
                await page.goto(self.base + "/", wait_until="domcontentloaded")
                await page.wait_for_timeout(2500)
                narr = asyncio.create_task(self.narrate(clip, secs))
                for _ in range(10):
                    await page.mouse.wheel(0, 420)
                    await page.wait_for_timeout(int(secs * 100))
                await narr
                await page.goto(self.base + "/live", wait_until="domcontentloaded")
                await self.wait_ready()
                await self.demo("window.NovaDemo.setClock('07:55', 1)")
                await page.wait_for_timeout(1500)
                continue
            await self.narrate(clip, secs)
            if action == "morning":
                await self.demo("window.NovaDemo.setClock(null, 60)")
                await page.wait_for_timeout(int(settle * 1000))
                await self.demo("window.NovaDemo.setClock(null, 1)")
            elif action == "pill_wrong":
                await self.demo("window.NovaDemo.showSample('kitchen', 'pill-atorvastatin')")
                await self.demo("window.NovaDemo.tapReply('kitchen', 'I took it')")
            elif action == "pill_avoid":
                await self.demo("window.NovaDemo.showSample('kitchen', 'pill-ibuprofen')", timeout=30)
            elif action == "checkin":
                await self.demo("window.NovaDemo.setClock('08:58', 30)")
                await page.wait_for_timeout(4000)
                await self.demo("window.NovaDemo.setClock(null, 1)")
                await self.demo("Promise.race([window.NovaDemo.tapReply('kitchen', 'A bit dizzy again'), new Promise(r => setTimeout(r, 3000))])")
                await page.wait_for_timeout(1500)
                await self.demo("window.NovaDemo.answer('kitchen', true)")
            elif action == "ring":
                # the front door panel: Sync from Ring calls api.amazonvision.com and lists each call
                try:
                    await page.click(".ring-more", timeout=4000)
                    await page.wait_for_timeout(500)
                    await page.click(".rl-sync", timeout=4000)
                    await page.wait_for_timeout(5500)
                    await page.click(".ring-more", timeout=4000)  # close it again
                except Exception as exc:
                    print(f"  ! Ring panel: {type(exc).__name__}")
                await self.demo("window.NovaDemo.ring('ding', 'grace')")
            elif action == "briefing":
                await self.demo("window.NovaDemo.say('maya', \"How's Mom doing?\")")
                await page.wait_for_timeout(7000)  # let the short answer play, then ask for the evidence
                await self.demo("window.NovaDemo.say('maya', \"Tell me more\")")
            elif action == "ring":
                await self.demo("window.NovaDemo.ring('ding', 'grace')")
            elif action == "reconcile":
                await self.demo("window.NovaDemo.showSample('maya', 'after-visit-summary')")
                await page.wait_for_timeout(2500)
                await self.demo("window.NovaDemo.approveChanges()")
            elif action == "pill_old":
                await self.demo("window.NovaDemo.showSample('kitchen', 'pill-lisinopril')")
            elif action == "evening":
                await self.demo("window.NovaDemo.setClock('17:58', 600)")
                await page.wait_for_timeout(12000)
                await self.demo("window.NovaDemo.setClock(null, 1)")
                await self.demo("window.NovaDemo.tapReply('maya', 'Remind Mom again')")
            elif action == "hood":
                await self.demo("window.NovaDemo.toggleInspector(true)")
                await self.demo("window.NovaDemo.scrollTo('hood')")
            elif action == "end":
                await self.demo("window.NovaDemo.toggleInspector(false)")
                await self.demo("window.NovaDemo.scrollTo('stage')")
            await page.wait_for_timeout(int(settle * 1000))


def fallback(expr: str) -> str:
    """Translate the few hook calls we need into plain HTTP calls."""
    post = "(p, b) => fetch(p, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)})"
    m = re.match(r"window\.NovaDemo\.say\('(\w+)', \"(.+)\"\)", expr)
    if m:
        return f"({post})('/api/chat', {{device: '{m.group(1)}', text: \"{m.group(2)}\"}})"
    m = re.match(r"window\.NovaDemo\.setClock\((.+), (.+)\)", expr)
    if m:
        t = m.group(1).strip("'") if m.group(1) != "null" else None
        body = {"speed": float(m.group(2))} if m.group(2) != "null" else {}
        if t:
            body["time"] = t
        return f"({post})('/api/clock', {json.dumps(body)})"
    m = re.match(r"window\.NovaDemo\.ring\('(\w+)', '(\w+)'\)", expr)
    if m:
        return f"({post})('/api/ring/event', {{kind: '{m.group(1)}', who: '{m.group(2)}'}})"
    return "Promise.resolve(null)"


def mix(video: Path, narration: list[tuple[float, Path]], alexa: list[tuple[float, Path]], out: Path) -> None:
    narration = [(t, c) for t, c in narration if c.exists() and c.stat().st_size > 0]
    alexa = [(t, c) for t, c in alexa if c.exists() and c.stat().st_size > 0]
    inputs = ["-i", str(video)]
    filters, labels = [], []
    for i, (at, clip) in enumerate([*narration, *alexa], start=1):
        inputs += ["-i", str(clip)]
        vol = 1.0 if i <= len(narration) else 0.85
        ms = int(at * 1000)
        filters.append(f"[{i}:a]adelay={ms}|{ms},volume={vol}[a{i}]")
        labels.append(f"[a{i}]")
    if labels:
        filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0[aout]")
        maps = ["-map", "0:v", "-map", "[aout]"]
    else:
        maps = ["-map", "0:v"]
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *inputs]
    if filters:
        cmd += ["-filter_complex", ";".join(filters)]
    cmd += [*maps, "-t", str(MAX_SECONDS), "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--out", default="demo/nova-demo.mp4")
    ap.add_argument("--headless", action="store_true", help="faster, but WebGL may fall back to 2D")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    tmp = out.parent / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)

    print("Synthesizing narration with Amazon Polly…")
    clips = []
    for i, (text, _, _) in enumerate(SCENES):
        p = tmp / f"narr_{i:02d}.mp3"
        clips.append((p, polly_clip(text, p)))
    print(f"  {len(clips)} lines, {sum(s for _, s in clips):.0f}s of narration")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome", headless=args.headless,
                                           args=["--window-position=-2400,0", "--autoplay-policy=no-user-gesture-required"])
        ctx = await browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1,
                                        record_video_dir=str(tmp), record_video_size={"width": 1920, "height": 1080})
        page = await ctx.new_page()
        rec = Recorder(page, args.url, tmp)
        try:
            await rec.run(clips)
        except Exception as exc:  # e.g. the browser closed: keep what was recorded
            print(f"  ! take ended early: {type(exc).__name__}: {str(exc)[:120]}")
        video_path = Path(await page.video.path())
        try:
            await ctx.close()
            await browser.close()
        except Exception:
            pass

    (tmp / "timeline.json").write_text(json.dumps({"timeline": rec.timeline,
                                                   "narration": [(t, p.name) for t, p in rec.narration],
                                                   "alexa": [(t, p.name) for t, p in rec.alexa]}, indent=1))
    print(f"Recorded {rec.now():.0f}s · {len(rec.alexa)} Alexa replies captured · mixing…")
    mix(video_path, rec.narration, rec.alexa, out)
    print(f"Done: {out}  ({duration(out):.0f}s)")
    if rec.now() > MAX_SECONDS:
        print(f"Note: the take ran {rec.now():.0f}s; the video was cut at {MAX_SECONDS}s. Trim scenes or speeds.")


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(main())
