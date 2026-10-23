"""Exercise care follow-up and provenance cards in Chrome with an MCP Apps test host.

Run: uv run --with playwright python scripts/check_care_views.py
The regular pytest suite tests the real MCP tools; this checks their browser interactions.
"""
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

HOST = """({html, data, width, height}) => {
  window.calls = []; window.rejectNext = false;
  const view = document.getElementById('view');
  view.style.cssText = `width:${width}px;height:${height}px;border:0`;
  window.addEventListener('message', e => {
    if (e.source !== view.contentWindow || e.data.jsonrpc !== '2.0') return;
    const m = e.data;
    const send = message => e.source.postMessage({jsonrpc:'2.0', ...message}, '*');
    if (m.method === 'ui/initialize') send({id:m.id, result:{hostContext:{containerDimensions:{maxHeight:height, width}}}});
    if (m.method === 'ui/notifications/initialized') send({method:'ui/notifications/tool-result', params:{structuredContent:data}});
    if (m.method === 'tools/call') {
      window.calls.push(m.params);
      if (window.rejectNext) {
        window.rejectNext = false;
        send({id:m.id, result:{structuredContent:{error:true, speech:'Leo is already handling this alert.'}}});
        return;
      }
      const a = data.alerts[0], p = m.params.arguments;
      a.claimed_by = 'maya'; a.owner_name = 'Maya'; a.claimed_at = '2026-10-23T10:00:00';
      a.workflow = p.action === 'record_action' ? 'action_recorded' : 'claimed';
      if (p.note) a.action_note = p.note;
      const action = m.params.name === 'resolve_alert' ? 'resolve' : p.action;
      if (action === 'resolve') { a.status = 'handled'; a.workflow = 'resolved'; }
      a.activity.push({action, note:p.note || '', at:'2026-10-23T10:00:00'});
      send({id:m.id, result:{structuredContent:{speech:'Follow-up updated', alert:a}}});
    }
  });
  view.srcdoc = html;
}"""


async def mount(browser, name, data, width=800, height=480):
    page = await browser.new_page(viewport={"width": width + 20, "height": height + 20})
    await page.route("https://**", lambda route: route.abort())
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    await page.set_content('<iframe id="view" title="Care view"></iframe>')
    await page.evaluate(HOST, {"html": (ROOT / "nova_server/views" / name).read_text(encoding="utf-8"),
                              "data": data, "width": width, "height": height})
    frame = page.frame_locator("#view")
    await frame.locator(".g-head").wait_for()
    return page, frame, errors


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True)
        for width, height in [(800, 480), (560, 380)]:
            data = {"person": {"name": "Rose", "short_name": "Rose"}, "viewer": {"id": "maya"},
                    "status": "watch", "headline": "Rose needs a follow-up", "alerts": [
                        {"id": 1, "message": "Check in with Rose", "status": "open", "severity": "watch",
                         "at": "2026-10-23T10:00:00", "activity": []}]}
            page, frame, errors = await mount(browser, "briefing.html", data, width, height)
            await frame.locator('[data-task-action="claim"]').click()
            await frame.get_by_role("heading", name="Maya is handling this").wait_for()
            assert await frame.locator(".g-body").evaluate("el => el.scrollHeight <= el.clientHeight + 1"), "Follow-up controls are clipped"
            note = frame.get_by_role("textbox", name="Follow-up action")
            await note.fill("Called Rose and checked in")
            await page.evaluate("window.rejectNext = true")
            await frame.get_by_role("button", name="Save action").click()
            await frame.locator("#toast").filter(has_text="Leo is already handling").wait_for()
            assert await note.input_value() == "Called Rose and checked in"
            await frame.get_by_role("button", name="Save action").click()
            await page.wait_for_function("window.calls.length === 3")
            await frame.get_by_role("button", name="Resolve", exact=True).click()
            await frame.get_by_text("Follow-up resolved", exact=True).wait_for()
            calls = await page.evaluate("window.calls")
            assert calls[2]["arguments"]["note"] == "Called Rose and checked in"
            assert not errors, errors
            assert await frame.locator(".g").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
            await page.close()
        pill = {"verdict": "ok_now", "identified": {"name": "Metformin", "strength": "500 mg", "confidence": .99},
                "matched_med": {"name": "Metformin", "dose": "500 mg", "times": ["8 AM"]},
                "generated_by": "Sample photo fixture (offline)", "advice": "Check your current care plan."}
        page, frame, errors = await mount(browser, "pillcheck.html", pill)
        await frame.get_by_text("Sample photo fixture (offline)", exact=True).wait_for()
        assert "% sure" not in await frame.locator("body").inner_text()
        assert not errors, errors
        await page.close()
        doc = {"source": {"title": "After-visit summary"}, "changes": [], "status": "pending",
               "generated_by": "Amazon Nova vision via Amazon Bedrock"}
        page, frame, errors = await mount(browser, "reconcile.html", doc)
        await frame.get_by_text(doc["generated_by"], exact=True).wait_for()
        assert not errors, errors
        await browser.close()
    print("Care views passed: ownership, action notes, rejected updates, resolution, provenance; two screen sizes.")


if __name__ == "__main__":
    asyncio.run(main())
