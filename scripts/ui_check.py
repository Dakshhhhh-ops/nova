"""Visual QA for the Nova pages: console errors, overlapping text/controls, clipped elements, screenshots.

    uv run --no-project --with playwright python scripts/ui_check.py --url http://127.0.0.1:8080 --out qa

For each page and viewport it loads the page in headed Chrome (WebGL needs a GPU), waits for the
stage, scrolls through, and reports:
  * console errors and page errors,
  * pairs of visible text or interactive elements whose boxes intersect (the "clutter" check),
  * visible text clipped by the viewport edge,
and saves a screenshot per state.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from playwright.async_api import Page, async_playwright

VIEWPORTS = [(1920, 930), (1440, 900)]

# Collect visible leaf text and controls, then find intersecting pairs that aren't nested.
OVERLAP_JS = r"""
() => {
  const vw = innerWidth, vh = innerHeight;
  const isVisible = (el, r) => {
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.15) return false;
    // something else drawn on top at the centre (e.g. a covering modal) means it isn't really visible
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    return top && (top === el || el.contains(top) || top.contains(el));
  };
  const pick = [];
  const all = document.querySelectorAll('button, a, input, textarea, select, [role=button], h1, h2, h3, h4, p, span, li, label, small, strong, em, time, div');
  for (const el of all) {
    if (el.closest('[aria-hidden=true], canvas, svg, iframe, [data-qa-ignore]')) continue;
    const interactive = el.matches('button, a, input, textarea, select, [role=button]');
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!interactive && !ownText) continue;
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) continue;
    pick.push({ el, r, label: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40), tag: el.tagName.toLowerCase(), interactive });
  }
  const out = [];
  for (let i = 0; i < pick.length; i++) for (let j = i + 1; j < pick.length; j++) {
    const a = pick[i], b = pick[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const ha = a.el.closest('h1,h2,h3,h4,[data-qa-group]'), hb = b.el.closest('h1,h2,h3,h4,[data-qa-group]');
    if (ha && ha === hb) continue;  // lines of one display headline may touch (tight leading)
    const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (ix > 6 && iy > 6) {
      const area = ix * iy, small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (area / small > 0.15) out.push({ a: `${a.tag}:"${a.label}"`, b: `${b.tag}:"${b.label}"`, at: [Math.round(Math.max(a.r.left, b.r.left)), Math.round(Math.max(a.r.top, b.r.top))] });
    }
  }
  const inScroller = (el) => { for (let n = el.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true; } return false; };
  const clipped = pick.filter(p => (p.r.left < -2 || p.r.right > vw + 2) && !inScroller(p.el)).map(p => `${p.tag}:"${p.label}"`);
  return { overlaps: out.slice(0, 40), clipped: clipped.slice(0, 20), checked: pick.length };
}
"""


async def check(page: Page, name: str, out: Path, report: dict) -> None:
    res = await page.evaluate(OVERLAP_JS)
    await page.screenshot(path=str(out / f"{name}.png"))
    report[name] = res
    flag = "OK " if not res["overlaps"] and not res["clipped"] else "!! "
    print(f"{flag}{name}: {len(res['overlaps'])} overlaps, {len(res['clipped'])} clipped ({res['checked']} elements)")
    for o in res["overlaps"][:6]:
        print(f"     overlap {o['a']}  ×  {o['b']}  @ {o['at']}")
    for c in res["clipped"][:4]:
        print(f"     clipped {c}")


async def main() -> None:
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--out", default="qa")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report: dict = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome", headless=False, args=["--window-position=-2400,0"])
        for w, h in VIEWPORTS:
            tag = f"{w}x{h}"
            for path in ("/", "/live"):
                page = await browser.new_page(viewport={"width": w, "height": h})
                errors: list[str] = []
                page.on("pageerror", lambda e, errors=errors: errors.append(f"pageerror: {str(e)[:160]}"))
                page.on("console", lambda m, errors=errors: errors.append(m.text[:160]) if m.type == "error" else None)
                await page.goto(args.url + path, wait_until="domcontentloaded")
                try:
                    await asyncio.wait_for(page.evaluate("async () => { if (window.NovaDemo) await window.NovaDemo.ready; }"), 30)
                except Exception:
                    pass
                await page.wait_for_timeout(3500)
                base = ("landing" if path == "/" else "live") + f"-{tag}"
                await check(page, f"{base}-0", out, report)
                for i in range(1, 6):
                    await page.mouse.wheel(0, int(h * 0.9))
                    await page.wait_for_timeout(1600)
                    await check(page, f"{base}-{i}", out, report)
                if path == "/live":
                    await page.evaluate("() => window.scrollTo(0, 0)")
                    await page.wait_for_timeout(800)
                    for label, expr in (("focus-rose", "window.NovaDemo && window.NovaDemo.focus('kitchen')"),
                                        ("inspector", "window.NovaDemo && (window.NovaDemo.focus(null), window.NovaDemo.toggleInspector(true))")):
                        try:
                            await page.evaluate(f"() => {{ {expr}; }}")
                        except Exception:
                            pass
                        await page.wait_for_timeout(1500)
                        await check(page, f"{base}-{label}", out, report)
                report[f"{base}-errors"] = errors
                print(f"   console errors on {path} @ {tag}: {len(errors)}" + (f" → {errors[:3]}" if errors else ""))
                await page.close()
        await browser.close()
    (out / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(f"Screenshots and report.json in {out.resolve()}")


if __name__ == "__main__":
    asyncio.run(main())
