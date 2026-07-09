"""Post-hug scoring: aggregates per-frame signals into the four dimensions
from the project brief (strength 30%, style 25%, coverage 25%, warmth 20%),
each 0-10, plus the weighted overall.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

import hug_classifier

WEIGHTS = {"strength": 0.30, "style": 0.25, "coverage": 0.25, "warmth": 0.20}

# Zone importance for coverage, matching the brief's "weighted by zone
# importance". Sums to 1.0.
ZONE_IMPORTANCE = {
    "chest": 0.20,
    "upper_back": 0.20,
    "lower_back": 0.15,
    "left_shoulder": 0.10,
    "right_shoulder": 0.10,
    "left_upper_arm": 0.075,
    "right_upper_arm": 0.075,
    "left_lower_arm": 0.05,
    "right_lower_arm": 0.05,
}

CONTACT_THRESHOLD = 0.35  # zone counts as contacted if intensity ever reaches this
WARMTH_BASELINE = 9.0     # no thermal camera; assumed body-temp constant


@dataclass
class SessionFrames:
    """Everything accumulated between start_hug and end_hug."""

    t_ms: list[int] = field(default_factory=list)
    squeeze: list[float] = field(default_factory=list)
    zones: list[dict[str, float]] = field(default_factory=list)
    classifications: list[tuple[hug_classifier.FrameClassification, float]] = field(default_factory=list)

    def add(self, t_ms: int, squeeze: float, zones: dict[str, float],
            classification: hug_classifier.FrameClassification | None) -> None:
        self.t_ms.append(t_ms)
        self.squeeze.append(squeeze)
        self.zones.append(zones)
        if classification is not None:
            self.classifications.append((classification, squeeze))

    ENGAGED_SQUEEZE = 0.35

    def engaged_classifications(self) -> list[hug_classifier.FrameClassification]:
        """Classify from frames where the hug is actually engaged — approach
        and release frames (arms hanging) would drown out the hug itself."""
        engaged = [c for c, s in self.classifications if s >= self.ENGAGED_SQUEEZE]
        return engaged if len(engaged) >= 5 else [c for c, _ in self.classifications]

    @property
    def duration_ms(self) -> int:
        return (self.t_ms[-1] - self.t_ms[0]) if len(self.t_ms) > 1 else 0


def _score_strength(squeeze: list[float]) -> float:
    if not squeeze:
        return 0.0
    arr = np.asarray(squeeze)
    raw = 0.6 * float(arr.mean()) + 0.4 * float(arr.max())  # brief: avg + peak
    return round(10 * min(raw, 1.0) ** 0.8, 1)  # gentle curve so decent hugs score well


def _score_style(classifications) -> tuple[float, str]:
    label, stability = hug_classifier.aggregate(classifications)
    if label == "unclassified":
        return 0.0, label
    score = 10 * stability
    if label.endswith("body-hug"):
        score = min(10.0, score + 1.0)  # committed hugs deserve it
    return round(score, 1), label


def _score_coverage(zone_frames: list[dict[str, float]]) -> tuple[float, dict[str, float]]:
    """Importance-weighted share of *reachable* zones contacted.

    Normalized over the zones the mannequin actually has anchors for (a
    torso-only bust has no arm zones, so huggers shouldn't be punished for
    not touching arms that don't exist).
    """
    available = {z for frame in zone_frames for z in frame if z in ZONE_IMPORTANCE}
    if not available:
        return 0.0, {}
    peaks: dict[str, float] = {z: 0.0 for z in available}
    for frame in zone_frames:
        for zone, intensity in frame.items():
            if zone in peaks:
                peaks[zone] = max(peaks[zone], intensity)
    total = sum(ZONE_IMPORTANCE[z] for z in available)
    covered = sum(ZONE_IMPORTANCE[z] for z in available if peaks[z] >= CONTACT_THRESHOLD)
    return round(10 * covered / total, 1), peaks


def score_session(session: SessionFrames, hugger_name: str, timestamp_iso: str) -> dict[str, Any]:
    """Build the full hug profile (schema_version 1.0 from the brief)."""
    strength = _score_strength(session.squeeze)
    style, hug_type = _score_style(session.engaged_classifications())
    coverage, zone_peaks = _score_coverage(session.zones)
    warmth = WARMTH_BASELINE

    overall = round(
        WEIGHTS["strength"] * strength
        + WEIGHTS["style"] * style
        + WEIGHTS["coverage"] * coverage
        + WEIGHTS["warmth"] * warmth,
        1,
    )

    contact_frames = [
        {"t_ms": t - session.t_ms[0], "zones": {z: round(v, 3) for z, v in zones.items() if v > 0.05}}
        for t, zones in zip(session.t_ms, session.zones)
    ]

    return {
        "metadata": {
            "hugger_name": hugger_name,
            "timestamp": timestamp_iso,
            "duration_ms": session.duration_ms,
            "schema_version": "1.0",
        },
        "scoring": {
            "strength": strength,
            "style": style,
            "coverage": coverage,
            "warmth": warmth,
            "overall": overall,
            "hug_type": hug_type,
        },
        "zone_peaks": {z: round(v, 3) for z, v in zone_peaks.items()},
        "contact_frames": contact_frames,
    }
