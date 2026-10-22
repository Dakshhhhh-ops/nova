"""SQLite storage for a Nova care circle.

One database holds one household: the person being cared for, the people in
their care circle, medications and dose events, daily check-ins, messages,
appointments, care notes and alerts.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('elder', 'caregiver', 'provider')),
    relation TEXT,
    location TEXT,
    device TEXT,
    pronoun TEXT DEFAULT 'they'
);
CREATE TABLE IF NOT EXISTS sharing (
    elder_id TEXT NOT NULL,
    category TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (elder_id, category)
);
CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    name TEXT NOT NULL,
    dose TEXT NOT NULL,
    purpose TEXT,
    appearance TEXT,
    times TEXT NOT NULL,          -- JSON list of "HH:MM"
    with_food INTEGER DEFAULT 0,
    instructions TEXT,
    started TEXT,
    changed_on TEXT,
    change_note TEXT
);
CREATE TABLE IF NOT EXISTS dose_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    med_id TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,  -- ISO datetime of the scheduled dose
    status TEXT NOT NULL CHECK (status IN ('taken', 'skipped')),
    logged_at TEXT NOT NULL,
    logged_by TEXT,
    UNIQUE (med_id, scheduled_for)
);
CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    at TEXT NOT NULL,
    mood INTEGER,                 -- 1 (low) .. 5 (great)
    pain INTEGER,                 -- 0 .. 10
    sleep_hours REAL,
    symptoms TEXT,                -- JSON list
    activities TEXT,              -- JSON list
    utterance TEXT,
    summary TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,          -- person id or 'circle'
    body TEXT NOT NULL,
    at TEXT NOT NULL,
    urgent INTEGER DEFAULT 0,
    read_by TEXT DEFAULT '[]'     -- JSON list of person ids
);
CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    title TEXT NOT NULL,
    provider TEXT,
    at TEXT NOT NULL,
    location TEXT,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS care_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    due_at TEXT NOT NULL,          -- household time it should be delivered
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    speech TEXT NOT NULL,
    expects_reply INTEGER DEFAULT 0,
    replies TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'new',   -- new | delivered | acknowledged | dismissed
    related TEXT DEFAULT '{}',
    dedupe TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS vitals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    at TEXT NOT NULL,
    systolic INTEGER NOT NULL,
    diastolic INTEGER NOT NULL,
    pulse INTEGER,
    position TEXT,                 -- sitting | standing
    logged_by TEXT
);
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    at TEXT NOT NULL,
    source TEXT NOT NULL,          -- ring | echo
    kind TEXT NOT NULL,            -- ding | motion | door_open
    who TEXT,
    text TEXT
);
CREATE TABLE IF NOT EXISTS change_sets (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    source TEXT NOT NULL,          -- JSON
    changes TEXT NOT NULL,         -- JSON
    instructions TEXT NOT NULL,    -- JSON
    status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    at TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'watch', 'urgent')),
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    handled_by TEXT,
    handled_at TEXT
);
"""

SHARING_CATEGORIES = ("medications", "wellbeing", "appointments", "messages")


# The household clock. Real time by default; NOVA_CLOCK=HH:MM shifts it so a demo
# can be recorded "at 8:20 in the morning" at any hour, and tests can freeze it.
_FROZEN: datetime | None = None
_ANCHOR_REAL = datetime.now()
_ANCHOR_HOUSE = _ANCHOR_REAL
_SPEED = 1.0


def set_clock(hhmm: str | None = None, speed: float | None = None, *, at: datetime | None = None) -> None:
    """Re-anchor the household clock.

    `hhmm` jumps to that time today, `at` jumps to an exact moment, `speed` sets the
    time-lapse factor (1 = real time, 60 = a minute per second). It keeps ticking.
    """
    global _ANCHOR_REAL, _ANCHOR_HOUSE, _SPEED
    current = now()
    real = datetime.now()
    if at is not None:
        current = at
    elif hhmm:
        hh, mm = (int(v) for v in hhmm.split(":"))
        current = current.replace(hour=hh, minute=mm, second=0)
    _ANCHOR_REAL, _ANCHOR_HOUSE = real, current
    if speed is not None:
        _SPEED = max(0.0, float(speed))


def clock_speed() -> float:
    return _SPEED


def freeze(at: datetime | None) -> None:
    global _FROZEN
    _FROZEN = at


def now() -> datetime:
    if _FROZEN is not None:
        return _FROZEN
    elapsed = (datetime.now() - _ANCHOR_REAL) * _SPEED
    return (_ANCHOR_HOUSE + elapsed).replace(microsecond=0)


set_clock(os.getenv("NOVA_CLOCK") or None)


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


@dataclass
class Store:
    path: Path

    def __post_init__(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)

    # -- low level -----------------------------------------------------------
    def q(self, sql: str, args: tuple | list = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def one(self, sql: str, args: tuple | list = ()) -> dict[str, Any] | None:
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql: str, args: tuple | list = ()) -> int:
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return cur.lastrowid or 0

    def is_empty(self) -> bool:
        return self.one("SELECT COUNT(*) AS n FROM people")["n"] == 0  # type: ignore[index]

    def wipe(self) -> None:
        with self._lock:
            for table in (
                "people", "sharing", "medications", "dose_events", "checkins",
                "messages", "appointments", "care_notes", "alerts", "announcements", "signals", "change_sets", "vitals",
            ):
                self._db.execute(f"DELETE FROM {table}")
            self._db.execute("DELETE FROM sqlite_sequence")
            self._db.commit()

    # -- people --------------------------------------------------------------
    def person(self, person_id: str) -> dict[str, Any] | None:
        return self.one("SELECT * FROM people WHERE id = ?", (person_id,))

    def people(self) -> list[dict[str, Any]]:
        return self.q("SELECT * FROM people ORDER BY role DESC, name")

    def elders(self) -> list[dict[str, Any]]:
        return self.q("SELECT * FROM people WHERE role = 'elder'")

    def caregivers(self) -> list[dict[str, Any]]:
        return self.q("SELECT * FROM people WHERE role != 'elder'")

    def find_person(self, text: str) -> dict[str, Any] | None:
        """Resolve 'Maya', 'my daughter', 'mom', 'Leo' to a person."""
        t = text.strip().lower()
        if not t:
            return None
        for p in self.people():
            names = {p["name"].lower(), p["short_name"].lower(), p["id"].lower()}
            if t in names or any(t == n.split()[0] for n in names):
                return p
        for p in self.people():
            rel = (p["relation"] or "").lower()
            if rel and (t == rel or t in rel.split("/") or t.replace("my ", "") in rel):
                return p
        for p in self.people():
            if t in p["name"].lower():
                return p
        return None

    # -- sharing -------------------------------------------------------------
    def sharing(self, elder_id: str) -> dict[str, bool]:
        rows = self.q("SELECT category, shared FROM sharing WHERE elder_id = ?", (elder_id,))
        prefs = {c: True for c in SHARING_CATEGORIES}
        prefs.update({r["category"]: bool(r["shared"]) for r in rows})
        return prefs

    def set_sharing(self, elder_id: str, category: str, shared: bool) -> None:
        self.x(
            "INSERT INTO sharing (elder_id, category, shared) VALUES (?, ?, ?) "
            "ON CONFLICT(elder_id, category) DO UPDATE SET shared = excluded.shared",
            (elder_id, category, int(shared)),
        )

    # -- medications ---------------------------------------------------------
    def medications(self, person_id: str) -> list[dict[str, Any]]:
        rows = self.q("SELECT * FROM medications WHERE person_id = ? ORDER BY name", (person_id,))
        for r in rows:
            r["times"] = json.loads(r["times"])
            r["with_food"] = bool(r["with_food"])
        return rows

    def scheduled_doses(self, person_id: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        """Every scheduled dose between start and end, joined with what was logged."""
        meds = self.medications(person_id)
        events = self.q(
            "SELECT e.* FROM dose_events e JOIN medications m ON m.id = e.med_id "
            "WHERE m.person_id = ? AND e.scheduled_for >= ? AND e.scheduled_for < ?",
            (person_id, iso(start), iso(end)),
        )
        by_key = {(e["med_id"], e["scheduled_for"]): e for e in events}
        doses = []
        day = start.replace(hour=0, minute=0, second=0)
        while day < end:
            for m in meds:
                if m["started"] and day.date() < parse(m["started"]).date():
                    continue
                for t in m["times"]:
                    hh, mm = (int(v) for v in t.split(":"))
                    at = day.replace(hour=hh, minute=mm)
                    if not (start <= at < end):
                        continue
                    ev = by_key.get((m["id"], iso(at)))
                    doses.append({
                        "med_id": m["id"],
                        "name": m["name"],
                        "dose": m["dose"],
                        "appearance": m["appearance"],
                        "scheduled_for": iso(at),
                        "status": ev["status"] if ev else "pending",
                        "logged_at": ev["logged_at"] if ev else None,
                        "logged_by": ev["logged_by"] if ev else None,
                    })
            day += timedelta(days=1)
        doses.sort(key=lambda d: (d["scheduled_for"], d["name"]))
        return doses

    def log_dose(self, med_id: str, scheduled_for: datetime, status: str, by: str, at: datetime | None = None) -> None:
        self.x(
            "INSERT INTO dose_events (med_id, scheduled_for, status, logged_at, logged_by) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(med_id, scheduled_for) DO UPDATE SET status = excluded.status, "
            "logged_at = excluded.logged_at, logged_by = excluded.logged_by",
            (med_id, iso(scheduled_for), status, iso(at or now()), by),
        )

    # -- check-ins -----------------------------------------------------------
    def add_checkin(self, person_id: str, data: dict[str, Any], at: datetime | None = None) -> int:
        return self.x(
            "INSERT INTO checkins (person_id, at, mood, pain, sleep_hours, symptoms, activities, utterance, summary) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                person_id, iso(at or now()), data.get("mood"), data.get("pain"), data.get("sleep_hours"),
                json.dumps(data.get("symptoms") or []), json.dumps(data.get("activities") or []),
                data.get("utterance"), data.get("summary"),
            ),
        )

    def checkins(self, person_id: str, since: datetime) -> list[dict[str, Any]]:
        rows = self.q(
            "SELECT * FROM checkins WHERE person_id = ? AND at >= ? ORDER BY at", (person_id, iso(since))
        )
        for r in rows:
            r["symptoms"] = json.loads(r["symptoms"] or "[]")
            r["activities"] = json.loads(r["activities"] or "[]")
        return rows

    # -- messages ------------------------------------------------------------
    def add_message(self, from_id: str, to_id: str, body: str, urgent: bool = False, at: datetime | None = None) -> int:
        return self.x(
            "INSERT INTO messages (from_id, to_id, body, at, urgent, read_by) VALUES (?, ?, ?, ?, ?, ?)",
            (from_id, to_id, body, iso(at or now()), int(urgent), json.dumps([from_id])),
        )

    def inbox(self, person_id: str, unread_only: bool = True) -> list[dict[str, Any]]:
        rows = self.q(
            "SELECT m.*, p.name AS from_name, p.short_name AS from_short FROM messages m "
            "JOIN people p ON p.id = m.from_id WHERE (m.to_id = ? OR m.to_id = 'circle') AND m.from_id != ? "
            "ORDER BY m.at",
            (person_id, person_id),
        )
        out = []
        for r in rows:
            read_by = json.loads(r["read_by"])
            r["read"] = person_id in read_by
            if unread_only and r["read"]:
                continue
            out.append(r)
        return out

    def mark_read(self, message_ids: list[int], person_id: str) -> None:
        for mid in message_ids:
            row = self.one("SELECT read_by FROM messages WHERE id = ?", (mid,))
            if not row:
                continue
            read_by = set(json.loads(row["read_by"]))
            read_by.add(person_id)
            self.x("UPDATE messages SET read_by = ? WHERE id = ?", (json.dumps(sorted(read_by)), mid))

    def recent_messages(self, since: datetime) -> list[dict[str, Any]]:
        return self.q(
            "SELECT m.*, p.short_name AS from_short FROM messages m JOIN people p ON p.id = m.from_id "
            "WHERE m.at >= ? ORDER BY m.at",
            (iso(since),),
        )

    # -- appointments --------------------------------------------------------
    def appointments(self, person_id: str, start: datetime, end: datetime | None = None) -> list[dict[str, Any]]:
        end = end or start + timedelta(days=365)
        return self.q(
            "SELECT * FROM appointments WHERE person_id = ? AND at >= ? AND at < ? ORDER BY at",
            (person_id, iso(start), iso(end)),
        )

    def add_appointment(self, appt: dict[str, Any]) -> None:
        self.x(
            "INSERT OR REPLACE INTO appointments (id, person_id, title, provider, at, location, notes) "
            "VALUES (:id, :person_id, :title, :provider, :at, :location, :notes)",
            appt,
        )

    # -- care notes ----------------------------------------------------------
    def care_notes(self, person_id: str) -> list[dict[str, Any]]:
        return self.q("SELECT * FROM care_notes WHERE person_id = ? ORDER BY at DESC", (person_id,))

    def add_care_note(self, person_id: str, source: str, text: str, at: datetime | None = None) -> int:
        return self.x(
            "INSERT INTO care_notes (person_id, source, at, text) VALUES (?, ?, ?, ?)",
            (person_id, source, iso(at or now()), text),
        )

    # -- alerts --------------------------------------------------------------
    def add_alert(self, person_id: str, severity: str, kind: str, message: str, at: datetime | None = None) -> int:
        existing = self.one(
            "SELECT id FROM alerts WHERE person_id = ? AND kind = ? AND status = 'open' AND message = ?",
            (person_id, kind, message),
        )
        if existing:
            return existing["id"]
        return self.x(
            "INSERT INTO alerts (person_id, at, severity, kind, message) VALUES (?, ?, ?, ?, ?)",
            (person_id, iso(at or now()), severity, kind, message),
        )

    def alerts(self, person_id: str | None = None, status: str | None = "open") -> list[dict[str, Any]]:
        sql = "SELECT * FROM alerts WHERE 1=1"
        args: list[Any] = []
        if person_id:
            sql += " AND person_id = ?"
            args.append(person_id)
        if status:
            sql += " AND status = ?"
            args.append(status)
        sql += " ORDER BY CASE severity WHEN 'urgent' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, at DESC"
        return self.q(sql, args)

    def handle_alert(self, alert_id: int, by: str) -> dict[str, Any] | None:
        self.x(
            "UPDATE alerts SET status = 'handled', handled_by = ?, handled_at = ? WHERE id = ?",
            (by, iso(now()), alert_id),
        )
        return self.one("SELECT * FROM alerts WHERE id = ?", (alert_id,))


    # -- announcements (Nova speaks first) -------------------------------------
    def announce(self, to_id: str, kind: str, title: str, speech: str, *, due_at: datetime | None = None,
                 severity: str = "info", expects_reply: bool = False, replies: list[str] | None = None,
                 related: dict[str, Any] | None = None, dedupe: str | None = None) -> int | None:
        """Queue an announcement. Returns None if one with the same dedupe key exists."""
        with self._lock:
            try:
                cur = self._db.execute(
                    "INSERT INTO announcements (due_at, to_id, kind, severity, title, speech, expects_reply, replies, related, dedupe) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (iso(due_at or now()), to_id, kind, severity, title, speech, int(expects_reply),
                     json.dumps(replies or []), json.dumps(related or {}), dedupe),
                )
                self._db.commit()
                return cur.lastrowid
            except sqlite3.IntegrityError:
                return None

    def has_dedupe(self, key: str) -> bool:
        return self.one("SELECT 1 AS x FROM announcements WHERE dedupe = ?", (key,)) is not None

    def announcements(self, to_id: str, *, due_by: datetime | None = None, statuses: tuple[str, ...] | None = None,
                      limit: int = 30) -> list[dict[str, Any]]:
        sql = "SELECT * FROM announcements WHERE to_id = ?"
        args: list[Any] = [to_id]
        if due_by is not None:
            sql += " AND due_at <= ?"
            args.append(iso(due_by))
        if statuses:
            sql += f" AND status IN ({','.join('?' * len(statuses))})"
            args.extend(statuses)
        sql += " ORDER BY due_at DESC, id DESC LIMIT ?"
        args.append(limit)
        rows = self.q(sql, args)
        for r in rows:
            r["replies"] = json.loads(r["replies"] or "[]")
            r["related"] = json.loads(r["related"] or "{}")
            r["expects_reply"] = bool(r["expects_reply"])
        return rows

    def set_announcement_status(self, ann_id: int, status: str, to_id: str | None = None) -> None:
        if to_id:
            self.x("UPDATE announcements SET status = ? WHERE id = ? AND to_id = ?", (status, ann_id, to_id))
        else:
            self.x("UPDATE announcements SET status = ? WHERE id = ?", (status, ann_id))

    def cancel_pending(self, to_id: str, kinds: tuple[str, ...]) -> None:
        """Drop scheduled announcements that haven't been delivered (e.g. a snoozed reminder)."""
        self.x(
            f"UPDATE announcements SET status = 'dismissed' WHERE to_id = ? AND status = 'new' AND due_at > ? "
            f"AND kind IN ({','.join('?' * len(kinds))})",
            (to_id, iso(now()), *kinds),
        )

    # -- vitals ------------------------------------------------------------------
    def add_bp(self, person_id: str, systolic: int, diastolic: int, pulse: int | None = None,
               position: str | None = None, by: str | None = None, at: datetime | None = None) -> int:
        return self.x(
            "INSERT INTO vitals (person_id, at, systolic, diastolic, pulse, position, logged_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (person_id, iso(at or now()), systolic, diastolic, pulse, position, by),
        )

    def bp(self, person_id: str, since: datetime) -> list[dict[str, Any]]:
        return self.q("SELECT * FROM vitals WHERE person_id = ? AND at >= ? ORDER BY at", (person_id, iso(since)))

    # -- signals (Ring and other ambient sensors) ------------------------------
    def add_signal(self, person_id: str, source: str, kind: str, who: str | None, text: str, at: datetime | None = None) -> int:
        return self.x(
            "INSERT INTO signals (person_id, at, source, kind, who, text) VALUES (?, ?, ?, ?, ?, ?)",
            (person_id, iso(at or now()), source, kind, who, text),
        )

    def signals(self, person_id: str, since: datetime) -> list[dict[str, Any]]:
        return self.q("SELECT * FROM signals WHERE person_id = ? AND at >= ? ORDER BY at", (person_id, iso(since)))

    # -- change sets (medication reconciliation) -------------------------------
    def add_change_set(self, cs_id: str, person_id: str, by: str, source: dict, changes: list, instructions: list) -> None:
        self.x(
            "INSERT INTO change_sets (id, person_id, created_at, created_by, source, changes, instructions) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (cs_id, person_id, iso(now()), by, json.dumps(source), json.dumps(changes), json.dumps(instructions)),
        )

    def change_set(self, cs_id: str) -> dict[str, Any] | None:
        r = self.one("SELECT * FROM change_sets WHERE id = ?", (cs_id,))
        if r:
            for k in ("source", "changes", "instructions"):
                r[k] = json.loads(r[k])
        return r
