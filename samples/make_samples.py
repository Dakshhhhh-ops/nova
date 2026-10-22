"""Generate the demo photos (pill bottles, after-visit summary) and their fixtures.

    uv run --with pillow python samples/make_samples.py

The fixtures let the vision tools work offline on these exact images. Any other
photo goes to Amazon Nova on Bedrock (or the local vision model).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
FONT_DIRS = [Path("C:/Windows/Fonts"), Path("/usr/share/fonts/truetype/dejavu"), Path("/Library/Fonts")]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = (["arialbd.ttf", "DejaVuSans-Bold.ttf", "Arial Bold.ttf"] if bold else ["arial.ttf", "DejaVuSans.ttf", "Arial.ttf"])
    for d in FONT_DIRS:
        for n in names:
            if (d / n).exists():
                return ImageFont.truetype(str(d / n), size)
    return ImageFont.load_default()


def counter_background(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h), (226, 214, 196))
    d = ImageDraw.Draw(img)
    for y in range(h):  # warm kitchen-counter gradient
        c = int(232 - 40 * y / h)
        d.line([(0, y), (w, y)], fill=(c, c - 12, c - 30))
    return img


def bottle(drug: str, directions: str, prescriber: str, rx: str, filled: str, qty: str, out: str) -> None:
    w, h = 900, 640
    img = counter_background(w, h)
    shadow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([250, 120, 690, 610], radius=46, fill=120)
    img.paste((90, 70, 50), mask=shadow.filter(ImageFilter.GaussianBlur(18)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([230, 40, 670, 130], radius=18, fill=(245, 245, 240), outline=(200, 200, 195), width=3)  # cap
    for x in range(250, 660, 14):
        d.line([(x, 52), (x, 118)], fill=(222, 222, 216), width=4)
    d.rounded_rectangle([220, 110, 680, 600], radius=40, fill=(214, 120, 34))  # amber bottle
    d.rounded_rectangle([238, 128, 300, 580], radius=24, fill=(232, 150, 70))  # highlight
    d.rectangle([250, 210, 650, 520], fill=(252, 252, 248), outline=(180, 180, 175), width=2)  # label
    y = 222
    d.text((266, y), "ELM STREET PHARMACY", font=font(20, True), fill=(20, 60, 120)); y += 28
    d.text((266, y), "41 Elm St, Columbus OH  (614) 555-0142", font=font(15), fill=(60, 60, 60)); y += 26
    d.line([(262, y), (638, y)], fill=(20, 60, 120), width=2); y += 10
    d.text((266, y), f"Rx {rx}", font=font(16), fill=(40, 40, 40))
    d.text((470, y), prescriber, font=font(16), fill=(40, 40, 40)); y += 26
    d.text((266, y), "ROSE ALVAREZ", font=font(22, True), fill=(10, 10, 10)); y += 34
    size = 26
    while size > 14 and d.textlength(drug, font=font(size, True)) > 370:
        size -= 1
    d.text((266, y), drug, font=font(size, True), fill=(10, 10, 10)); y += 40
    for line in directions.split("\n"):
        d.text((266, y), line, font=font(19), fill=(15, 15, 15)); y += 26
    y += 8
    d.text((266, y), f"QTY: {qty}   REFILLS: 2   FILLED {filled}", font=font(15), fill=(70, 70, 70))
    img.save(HERE / out, optimize=True)


def visit_summary(out: str) -> None:
    w, h = 1100, 1420
    img = Image.new("RGB", (w, h), (250, 250, 247))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, 120], fill=(18, 64, 112))
    d.text((60, 30), "Ohio Heart Center", font=font(40, True), fill=(255, 255, 255))
    d.text((60, 80), "Cardiology  ·  3rd floor  ·  (614) 555-0190", font=font(20), fill=(210, 225, 245))
    d.text((60, 160), "AFTER VISIT SUMMARY", font=font(34, True), fill=(18, 64, 112))
    rows = [("Patient", "Rose Alvarez     DOB 03/14/1945"), ("Visit", "Cardiology follow-up with Dr. Anika Patel"),
            ("Date", "10/24/2026"), ("Blood pressure today", "106/64 sitting, 94/58 standing")]
    y = 220
    for k, v in rows:
        d.text((60, y), k, font=font(20, True), fill=(60, 60, 60))
        d.text((330, y), v, font=font(20), fill=(20, 20, 20))
        y += 36
    y += 20
    d.text((60, y), "Your medication changes", font=font(28, True), fill=(18, 64, 112)); y += 50
    meds = [
        ("CHANGE", (196, 98, 0), "Lisinopril 10 mg tablet, once daily in the morning",
         "Was 20 mg. Lowered because of dizziness when standing and low blood pressure."),
        ("CONTINUE", (40, 120, 60), "Metformin 500 mg tablet, twice daily with breakfast and dinner", ""),
        ("CONTINUE", (40, 120, 60), "Atorvastatin 40 mg tablet, once daily at bedtime", ""),
        ("CONTINUE", (40, 120, 60), "Vitamin D3 2,000 IU, once daily with breakfast", ""),
    ]
    for tag, color, text, note in meds:
        d.rounded_rectangle([60, y, 210, y + 38], radius=8, fill=color)
        d.text((74, y + 7), tag, font=font(20, True), fill=(255, 255, 255))
        d.text((232, y + 6), text, font=font(21, True), fill=(20, 20, 20))
        y += 46
        if note:
            d.text((232, y), note, font=font(18), fill=(80, 80, 80))
            y += 34
        y += 10
    d.text((60, y), "New prescription sent to Elm Street Pharmacy (Lisinopril 10 mg, #30).", font=font(18), fill=(60, 60, 60))
    y += 60
    d.text((60, y), "Instructions", font=font(28, True), fill=(18, 64, 112)); y += 50
    for line in [
        "1. Check your blood pressure every morning before your pills and write it down.",
        "2. Stand up slowly. Sit on the edge of the bed for a minute before standing.",
        "3. Stop using the old 20 mg lisinopril tablets.",
        "4. Call us if blood pressure is above 160/100 or below 100/60,",
        "    or if the dizziness does not improve within a week: (614) 555-0190.",
        "5. Follow-up visit in 4 weeks.",
    ]:
        d.text((60, y), line, font=font(20), fill=(25, 25, 25)); y += 36
    y += 40
    d.line([(60, y), (w - 60, y)], fill=(200, 200, 200), width=2); y += 16
    d.text((60, y), "Anika Patel, MD  ·  Electronically signed 10/24/2026 11:42 AM", font=font(17), fill=(90, 90, 90))
    img = img.rotate(-1.2, resample=Image.BICUBIC, expand=False, fillcolor=(235, 232, 225))  # a phone photo is never straight
    img.save(HERE / out, optimize=True)


FIXTURES = {
    "pill-atorvastatin.png": {"kind": "pill", "label": "Atorvastatin bottle", "data": {
        "name": "Atorvastatin", "strength": "40 mg", "directions": "Take 1 tablet by mouth at bedtime",
        "patient": "Rose Alvarez", "pharmacy": "Elm Street Pharmacy", "prescriber": "Dr. James Moore",
        "label_text": "ATORVASTATIN 40 MG TABLET. TAKE 1 TABLET BY MOUTH AT BEDTIME", "confidence": 0.97}},
    "pill-lisinopril.png": {"kind": "pill", "label": "Lisinopril 20 mg bottle", "data": {
        "name": "Lisinopril", "strength": "20 mg", "directions": "Take 1 tablet by mouth every morning",
        "patient": "Rose Alvarez", "pharmacy": "Elm Street Pharmacy", "prescriber": "Dr. Anika Patel",
        "label_text": "LISINOPRIL 20 MG TABLET. TAKE 1 TABLET BY MOUTH EVERY MORNING", "confidence": 0.97}},
    "pill-metformin.png": {"kind": "pill", "label": "Metformin bottle", "data": {
        "name": "Metformin", "strength": "500 mg", "directions": "Take 1 tablet by mouth twice daily with meals",
        "patient": "Rose Alvarez", "pharmacy": "Elm Street Pharmacy", "prescriber": "Dr. James Moore",
        "label_text": "METFORMIN HCL 500 MG TABLET. TAKE 1 TABLET BY MOUTH TWICE DAILY WITH MEALS", "confidence": 0.96}},
    "after-visit-summary.png": {"kind": "document", "label": "After-visit summary (cardiology)", "data": {
        "title": "After Visit Summary", "provider": "Dr. Anika Patel", "facility": "Ohio Heart Center", "date": "10/24/2026",
        "medications": [
            {"name": "Lisinopril", "dose": "10 mg", "frequency": "once daily in the morning", "action": "change",
             "previous_dose": "20 mg", "reason": "dizziness when standing and low blood pressure"},
            {"name": "Metformin", "dose": "500 mg", "frequency": "twice daily with breakfast and dinner", "action": "continue"},
            {"name": "Atorvastatin", "dose": "40 mg", "frequency": "once daily at bedtime", "action": "continue"},
            {"name": "Vitamin D3", "dose": "2,000 IU", "frequency": "once daily with breakfast", "action": "continue"},
        ],
        "instructions": [
            "Check blood pressure every morning before pills and write it down.",
            "Stand up slowly; sit on the edge of the bed for a minute first.",
            "Stop using the old 20 mg lisinopril tablets.",
            "Call (614) 555-0190 if BP is above 160/100 or below 100/60, or if dizziness doesn't improve within a week.",
            "Follow-up visit in 4 weeks.",
        ]}},
}


def main() -> None:
    bottle("ATORVASTATIN 40 MG TABLET", "TAKE 1 TABLET BY MOUTH\nAT BEDTIME", "Dr. James Moore", "4471029",
           "10/01/2026", "30", "pill-atorvastatin.png")
    bottle("LISINOPRIL 20 MG TABLET", "TAKE 1 TABLET BY MOUTH\nEVERY MORNING", "Dr. Anika Patel", "4471107",
           "10/13/2026", "30", "pill-lisinopril.png")
    bottle("METFORMIN HCL 500 MG TABLET", "TAKE 1 TABLET BY MOUTH\nTWICE DAILY WITH MEALS", "Dr. James Moore", "4470981",
           "09/28/2026", "60", "pill-metformin.png")
    visit_summary("after-visit-summary.png")
    fixtures = {}
    for name, meta in FIXTURES.items():
        digest = hashlib.sha256((HERE / name).read_bytes()).hexdigest()
        fixtures[digest] = {"file": name, **meta}
    (HERE / "fixtures.json").write_text(json.dumps(fixtures, indent=2), encoding="utf-8")
    print("wrote", ", ".join(FIXTURES))


if __name__ == "__main__":
    main()
