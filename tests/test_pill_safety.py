"""Pill-photo safety: Nova says "take it" only when it is sure, and refuses when it can't read the label."""

from __future__ import annotations

import os
import tempfile
from datetime import datetime
from pathlib import Path

os.environ.setdefault("NOVA_LLM", "rules")
os.environ.setdefault("NOVA_DB", str(Path(tempfile.mkdtemp()) / "nova-test.db"))

import pytest  # noqa: E402

from nova_server import server, vision  # noqa: E402
from nova_server import store as store_mod  # noqa: E402
from nova_server.seed import seed  # noqa: E402

MORNING = datetime.now().replace(hour=8, minute=10, second=0, microsecond=0)  # 8 AM doses are due


@pytest.fixture()
def rose(monkeypatch):
    store_mod.freeze(MORNING)
    seed(server.store)
    elder = server.store.elders()[0]

    def read_as(data, by="Amazon Nova 2 Lite vision · Amazon Bedrock"):
        monkeypatch.setattr(vision, "read_image", lambda kind, image, mime: (data, by))
        return vision.check_pill(server.store, elder, b"photo", "image/png")

    return read_as


def test_clear_label_for_the_due_dose_says_take_it(rose):
    out = rose({"name": "Metformin", "strength": "500 mg", "confidence": 0.95})
    assert out["verdict"] == "ok_now" and "take one" in out["speech"].lower()


def test_salt_names_are_the_same_product(rose):
    assert rose({"name": "Metformin HCl", "strength": "500 mg", "confidence": 0.93})["verdict"] == "ok_now"


def test_unreadable_label_is_refused(rose):
    out = rose({"name": None, "strength": None, "confidence": 0.2})
    assert out["verdict"] == "unclear"
    assert "don't take" in out["speech"].lower()


def test_very_low_confidence_is_treated_as_unreadable(rose):
    out = rose({"name": "Metformin", "strength": "500 mg", "confidence": 0.35})
    assert out["verdict"] == "unclear" and "pharmacist" in out["speech"].lower()


def test_unsure_read_means_check_first(rose):
    out = rose({"name": "Metformin", "strength": "500 mg", "confidence": 0.65})
    assert out["verdict"] == "check_first"
    assert "pharmacist" in out["speech"].lower() and "take one" not in out["speech"].lower()


def test_missing_strength_means_check_first(rose):
    out = rose({"name": "Metformin", "strength": None, "confidence": 0.95})
    assert out["verdict"] == "check_first" and any("strength" in r for r in out["reasons"])


@pytest.mark.parametrize("label", ["Metformin ER", "Metformin XR", "Lisinopril and Hydrochlorothiazide", "Lisinopril-HCTZ"])
def test_other_products_are_never_take_it(rose, label):
    strength = "500 mg" if label.startswith("Metformin") else "20 mg"
    out = rose({"name": label, "strength": strength, "confidence": 0.97})
    assert out["verdict"] != "ok_now"


def test_a_model_that_does_not_say_how_sure_it_is_is_unsure(rose):
    assert rose({"name": "Metformin", "strength": "500 mg"})["verdict"] == "check_first"


def test_sample_fixtures_still_work_offline(rose):
    out = rose({"name": "Metformin", "strength": "500 mg"}, by="Sample photo fixture (offline)")
    assert out["verdict"] == "ok_now"


def test_exact_product_rules():
    assert vision.exact_product("Atorvastatin calcium 40 mg", "Atorvastatin")
    assert not vision.exact_product("Atorvastatin and ezetimibe", "Atorvastatin")
    assert not vision.exact_product("Metformin ER", "Metformin")
    assert not vision.exact_product("Metoprolol", "Metformin")
    assert not vision.exact_product(None, "Metformin")


@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), -1, 101])
def test_invalid_model_confidence_never_approves_a_dose(rose, confidence):
    assert rose({"name": "Metformin", "strength": "500 mg", "confidence": confidence})["verdict"] != "ok_now"


def test_another_patients_bottle_is_not_approved(rose):
    out = rose({"name": "Metformin", "strength": "500 mg", "confidence": 0.99, "patient": "Someone Else"})
    assert out["verdict"] == "check_first" and "name" in out["speech"]


def test_image_results_disclose_fixtures_and_confidence_limits(rose):
    label = {"name": "Metformin", "strength": "500 mg", "confidence": 0.99}
    live = rose(label)
    assert live["provenance"]["mode"] == "live_model"
    assert "not measured accuracy" in live["provenance"]["confidence_note"]
    fixture = rose(label, by="Sample photo fixture (offline)")
    assert fixture["provenance"]["mode"] == "sample_fixture" and fixture["provenance"]["simulated"]
