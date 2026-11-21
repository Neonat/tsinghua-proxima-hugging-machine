"""SQLite leaderboard persistence + per-hug profile JSON files.

Everything lives under hug-machine/data/ so it survives restarts and is easy
to inspect by hand.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "leaderboard.db"
PROFILE_DIR = DATA_DIR / "profiles"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS hugs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    strength REAL NOT NULL,
    style REAL NOT NULL,
    coverage REAL NOT NULL,
    warmth REAL NOT NULL,
    overall REAL NOT NULL,
    hug_type TEXT NOT NULL,
    profile_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hugs_overall ON hugs (overall DESC);
"""


class Storage:
    def __init__(self, db_path: Path = DB_PATH):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def save_hug(self, profile: dict[str, Any]) -> dict[str, Any]:
        """Persist the profile JSON and add a leaderboard row. Returns the row."""
        meta, scores = profile["metadata"], profile["scoring"]
        slug = re.sub(r"[^a-z0-9]+", "-", meta["hugger_name"].lower()).strip("-") or "anon"
        ts_slug = meta["timestamp"].replace(":", "").replace("-", "")[:15]
        path = PROFILE_DIR / f"{ts_slug}_{slug}.json"
        path.write_text(json.dumps(profile, indent=2))

        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO hugs (name, timestamp, duration_ms, strength, style, coverage,"
                " warmth, overall, hug_type, profile_path)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    meta["hugger_name"], meta["timestamp"], meta["duration_ms"],
                    scores["strength"], scores["style"], scores["coverage"],
                    scores["warmth"], scores["overall"], scores["hug_type"], str(path),
                ),
            )
            self._conn.commit()
        return {"id": cur.lastrowid, "rank": self.rank_of(scores["overall"])}

    def rank_of(self, overall: float) -> int:
        with self._lock:
            (better,) = self._conn.execute(
                "SELECT COUNT(*) FROM hugs WHERE overall > ?", (overall,)
            ).fetchone()
        return better + 1

    def leaderboard(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, name, timestamp, duration_ms, strength, style, coverage,"
                " warmth, overall, hug_type, RANK() OVER (ORDER BY overall DESC)"
                " FROM hugs ORDER BY overall DESC, id ASC LIMIT ?",
                (limit,),
            ).fetchall()
        keys = ("id", "name", "timestamp", "duration_ms", "strength", "style",
                "coverage", "warmth", "overall", "hug_type", "rank")
        return [dict(zip(keys, row)) for row in rows]

    def close(self) -> None:
        self._conn.close()
