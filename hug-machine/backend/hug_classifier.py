"""Rule-based hug classification from the HUG taxonomy paper
(s41598-024-64825-8): style x coordination x tightness.

Works on MediaPipe pose world landmarks (meters, origin between the hips,
y pointing DOWN in MediaPipe's convention — helpers below convert to y-up).
Landmarks: 11/12 shoulders, 13/14 elbows, 15/16 wrists (L/R).
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass

import numpy as np

L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW, R_ELBOW = 13, 14
L_WRIST, R_WRIST = 15, 16

STYLES = ("criss-cross", "neck-loop", "waist-loop")
COORDINATIONS = ("horizontal-parallel", "vertical-parallel", "perpendicular")
TIGHTNESSES = ("body-hug", "air-hug")


@dataclass
class ArmSignals:
    se: np.ndarray          # shoulder -> elbow vector (y-up, meters)
    ew: np.ndarray          # elbow -> wrist vector
    elbow_angle_deg: float  # angle at the elbow; 180 = straight, small = wrapped
    wrist_up: float         # wrist height relative to own shoulder (m, +up)


@dataclass
class FrameClassification:
    style: str
    coordination: str
    tightness: str
    left: ArmSignals
    right: ArmSignals

    @property
    def label(self) -> str:
        return f"{self.style}/{self.coordination}/{self.tightness}"


def _pt(landmarks, idx) -> np.ndarray:
    """World landmark -> y-up numpy point."""
    lm = landmarks[idx]
    return np.array([lm.x, -lm.y, lm.z], dtype=float)


def _arm(landmarks, shoulder: int, elbow: int, wrist: int) -> ArmSignals:
    s, e, w = _pt(landmarks, shoulder), _pt(landmarks, elbow), _pt(landmarks, wrist)
    se, ew = e - s, w - e
    # Angle at the elbow between upper arm (e->s) and forearm (e->w).
    a, b = s - e, w - e
    denom = float(np.linalg.norm(a) * np.linalg.norm(b)) or 1e-9
    cosang = float(np.clip(np.dot(a, b) / denom, -1.0, 1.0))
    return ArmSignals(se=se, ew=ew, elbow_angle_deg=math.degrees(math.acos(cosang)), wrist_up=float(w[1] - s[1]))


def _forearm_verticality(arm: ArmSignals) -> float:
    """0 = forearm horizontal, 1 = vertical."""
    n = float(np.linalg.norm(arm.ew)) or 1e-9
    return abs(float(arm.ew[1])) / n


def classify_frame(world_landmarks) -> FrameClassification:
    left = _arm(world_landmarks, L_SHOULDER, L_ELBOW, L_WRIST)
    right = _arm(world_landmarks, R_SHOULDER, R_ELBOW, R_WRIST)

    # Style from wrist heights relative to the shoulder line: both arms high
    # loop the neck, both low loop the waist, one high + one low criss-cross.
    HIGH, LOW = 0.02, -0.18
    highs = [arm.wrist_up > HIGH for arm in (left, right)]
    lows = [arm.wrist_up < LOW for arm in (left, right)]
    if all(highs):
        style = "neck-loop"
    elif all(lows):
        style = "waist-loop"
    else:
        style = "criss-cross"

    # Coordination from forearm orientation agreement.
    v_l, v_r = _forearm_verticality(left), _forearm_verticality(right)
    VERT = 0.6
    if v_l < 1 - VERT and v_r < 1 - VERT:
        coordination = "horizontal-parallel"
    elif v_l > VERT and v_r > VERT:
        coordination = "vertical-parallel"
    else:
        coordination = "perpendicular"

    # Tightness from wrap depth: bent elbows mean the arms close around the
    # mannequin's body; straight-ish arms are an air-hug.
    mean_elbow = (left.elbow_angle_deg + right.elbow_angle_deg) / 2
    tightness = "body-hug" if mean_elbow < 115 else "air-hug"

    return FrameClassification(style, coordination, tightness, left, right)


def aggregate(frames: list[FrameClassification]) -> tuple[str, float]:
    """Majority vote per dimension over a session.

    Returns (label, stability) where stability in [0,1] is the mean fraction
    of frames agreeing with the winning class — the paper's classifier is
    per-hug, so a steady hug classifies more confidently than a wobbly one.
    """
    if not frames:
        return "unclassified", 0.0
    dims = []
    stability = []
    for attr in ("style", "coordination", "tightness"):
        counts = Counter(getattr(f, attr) for f in frames)
        winner, n = counts.most_common(1)[0]
        dims.append(winner)
        stability.append(n / len(frames))
    return "/".join(dims), float(np.mean(stability))
