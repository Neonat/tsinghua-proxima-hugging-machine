"""Hug Rating Machine — CV backend.

Webcam -> MediaPipe Holistic -> per-frame hug signals -> WebSocket JSON at
~10 Hz. Clients (operator view / score reveal) drive sessions with:

    {"type": "start_hug", "name": "Alice"}
    {"type": "end_hug"}                       -> scores, persists, broadcasts
    {"type": "get_leaderboard"}
    {"type": "detect_mannequin"}              -> with the frame EMPTY of people,
                                                 pose-detects the mannequin and
                                                 pins zone anchors to its joints

Run:  python main.py                  # default webcam
      python main.py --camera 1      # pick a camera
      python main.py --video f.mp4   # file instead of camera
      python main.py --synthetic     # no camera: simulated hugger for testing
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import websockets

import hug_classifier
import scoring
import storage
from hug_classifier import L_ELBOW, L_SHOULDER, L_WRIST, R_ELBOW, R_SHOULDER, R_WRIST

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
ANCHORS_PATH = DATA_DIR / "mannequin_anchors.json"
ZONES_PATH = DATA_DIR / "mannequin_zones.json"
NOSE = 0
L_HIP, R_HIP = 23, 24

CONTACT_LANDMARKS = {  # hugger joints that can touch the mannequin
    "l_wrist": L_WRIST, "r_wrist": R_WRIST, "l_elbow": L_ELBOW, "r_elbow": R_ELBOW,
}
POSE_OVERLAY = {  # joints streamed for the operator skeleton overlay
    "nose": NOSE,
    "l_shoulder": L_SHOULDER, "r_shoulder": R_SHOULDER,
    "l_elbow": L_ELBOW, "r_elbow": R_ELBOW,
    "l_wrist": L_WRIST, "r_wrist": R_WRIST,
}
SHOULDER_SPAN_M = 0.37  # mannequin shoulder width; converts image units to meters

# HSV ranges (OpenCV H in 0-179) for the FRONT sticker on the mannequin's
# chest. A sticky note works great.
STICKER_PRESETS = {
    "blue": ((95, 90, 90), (130, 255, 255)),
    "green": ((40, 80, 80), (85, 255, 255)),
    "pink": ((145, 70, 90), (175, 255, 255)),
    "orange": ((5, 120, 120), (22, 255, 255)),
}


class ZoneMapper:
    """Zone anchors pinned to the mannequin's own pose-detected joints.

    The operator clears the frame and triggers detect_mannequin; MediaPipe
    picks up the person-shaped mannequin, and each painted zone gets an anchor
    at the matching spot on its detected skeleton. Contact = hugger joint
    proximity to those anchors.
    """

    def __init__(self, zones_path: Path):
        self.zone_names: list[str] = []
        if zones_path.exists():
            data = json.loads(zones_path.read_text())
            self.zone_names = list(data.get("zones", {}))
        else:
            print(f"[warn] {zones_path} not found — zone contact mapping disabled. "
                  "Paint zones in the zone painter and export first.")
        self.anchors: dict[str, tuple[float, float]] = {}
        self.center: tuple[float, float] = (0.5, 0.5)
        self.px_per_m: float = 0.4
        # Frame aspect (w/h), set from the capture source. All geometry runs
        # in aspect-corrected "square" space (x = u * aspect) so offsets and
        # distances are isotropic; normalized (u, v) is only the I/O format.
        self.aspect: float = 16 / 9
        # Torso axis from manual marking (neck, base) — enables live
        # orientation tracking from the FRONT sticker.
        self.axis: tuple[tuple[float, float], tuple[float, float]] | None = None
        self.front: tuple[float, float] | None = None  # smoothed sticker pos
        if ANCHORS_PATH.exists():
            saved = json.loads(ANCHORS_PATH.read_text())
            self.anchors = {z: tuple(uv) for z, uv in saved["anchors"].items()}
            self.center = tuple(saved["center"])
            self.px_per_m = saved["px_per_m"]
            if saved.get("axis"):
                self.axis = (tuple(saved["axis"][0]), tuple(saved["axis"][1]))

    @property
    def detected(self) -> bool:
        return bool(self.anchors)

    def set_from_pose(self, mean_lm: dict[int, tuple[float, float]]) -> None:
        """Derive zone anchors from the mannequin's averaged pose landmarks."""
        def mid(a: int, b: int, t: float = 0.5) -> tuple[float, float]:
            (ax, ay), (bx, by) = mean_lm[a], mean_lm[b]
            return (ax + (bx - ax) * t, ay + (by - ay) * t)

        mid_sh = mid(L_SHOULDER, R_SHOULDER)
        mid_hip = mid(L_HIP, R_HIP)
        lerp = lambda t: (mid_sh[0] + (mid_hip[0] - mid_sh[0]) * t,
                          mid_sh[1] + (mid_hip[1] - mid_sh[1]) * t)
        candidates: dict[str, tuple[float, float]] = {
            # Front/back share 2D anchors — a webcam can't tell them apart,
            # and contact is proximity-based either way.
            "chest": lerp(0.30),
            "upper_back": lerp(0.25),
            "lower_back": lerp(0.85),
            "left_shoulder": mean_lm[L_SHOULDER],
            "right_shoulder": mean_lm[R_SHOULDER],
            "left_upper_arm": mid(L_SHOULDER, L_ELBOW),
            "right_upper_arm": mid(R_SHOULDER, R_ELBOW),
            "left_lower_arm": mid(L_ELBOW, L_WRIST),
            "right_lower_arm": mid(R_ELBOW, R_WRIST),
        }
        self.anchors = {z: uv for z, uv in candidates.items() if z in self.zone_names}
        self.center = lerp(0.5)
        span = math.dist(self._sq(mean_lm[L_SHOULDER]), self._sq(mean_lm[R_SHOULDER]))
        self.px_per_m = max(span / SHOULDER_SPAN_M, 1e-3)
        ANCHORS_PATH.parent.mkdir(parents=True, exist_ok=True)
        ANCHORS_PATH.write_text(json.dumps({
            "detected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "anchors": self.anchors,
            "center": self.center,
            "px_per_m": self.px_per_m,
        }, indent=2))

    def _sq(self, p: tuple[float, float]) -> tuple[float, float]:
        return (p[0] * self.aspect, p[1])

    def _uv(self, p: tuple[float, float]) -> tuple[float, float]:
        return (p[0] / self.aspect, p[1])

    def set_manual(self, neck: tuple[float, float], base: tuple[float, float]) -> None:
        """Anchor zones from two operator clicks: the neck notch and the
        bottom of the torso. Built for torso-only tailor's busts that pose
        detection can't see (no head, no limbs). Arm zones are omitted —
        the bust doesn't have any."""
        n, b = self._sq(neck), self._sq(base)
        ax, ay = b[0] - n[0], b[1] - n[1]  # torso axis, pointing down
        length = math.hypot(ax, ay) or 1e-6
        # Perpendicular pointing to the mannequin's left (viewer's right when
        # it faces the camera) — matches MediaPipe's anatomical labeling.
        px, py = ay / length, -ax / length
        along = lambda t: (n[0] + ax * t, n[1] + ay * t)
        offset = lambda pt, d: (pt[0] + px * d, pt[1] + py * d)
        shoulder_y = along(0.10)
        candidates: dict[str, tuple[float, float]] = {
            "chest": along(0.33),
            "upper_back": along(0.28),
            "lower_back": along(0.72),
            "left_shoulder": offset(shoulder_y, 0.36 * length),
            "right_shoulder": offset(shoulder_y, -0.36 * length),
        }
        self.anchors = {z: self._uv(uv) for z, uv in candidates.items() if z in self.zone_names}
        self.center = self._uv(along(0.5))
        self.px_per_m = length / 0.55  # typical bust torso is ~55cm neck to hem
        self.axis = (tuple(neck), tuple(base))
        self.front = None
        ANCHORS_PATH.parent.mkdir(parents=True, exist_ok=True)
        ANCHORS_PATH.write_text(json.dumps({
            "detected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "method": "manual",
            "anchors": self.anchors,
            "center": self.center,
            "px_per_m": self.px_per_m,
            "axis": self.axis,
        }, indent=2))

    def update_front(self, sticker: tuple[float, float] | None) -> None:
        """Live orientation from the FRONT sticker on the mannequin's chest.

        The sticker position IS the chest anchor; its sideways offset from the
        torso axis gives the yaw, which compresses the shoulder span and pushes
        the back anchors to the opposite side. When the sticker is occluded
        (e.g. by the hugger), the last known orientation holds — the mannequin
        doesn't rotate on its own.
        """
        if self.axis is None or sticker is None:
            return
        (nx, ny) = self._sq(self.axis[0])
        (bx, by) = self._sq(self.axis[1])
        s = self._sq(sticker)
        ax, ay = bx - nx, by - ny
        length = math.hypot(ax, ay) or 1e-6
        px, py = ay / length, -ax / length  # perp toward the mannequin-left side
        along = lambda t: (nx + ax * t, ny + ay * t)

        # Reject blue blobs that aren't on the torso (hugger's clothes etc):
        # the sticker must sit within half a torso-length of the chest region.
        chest_axis = along(0.33)
        if math.dist(s, chest_axis) > 0.5 * length:
            return
        # Smooth so anchors don't jitter (self.front lives in square space).
        self.front = s if self.front is None else (
            self.front[0] + (s[0] - self.front[0]) * 0.3,
            self.front[1] + (s[1] - self.front[1]) * 0.3,
        )

        lateral = (self.front[0] - chest_axis[0]) * px + (self.front[1] - chest_axis[1]) * py
        half_chest = 0.29 * length  # ~16cm chest half-width vs ~55cm torso
        t = max(-1.0, min(1.0, lateral / half_chest))
        cos_yaw = math.sqrt(1 - t * t)

        shoulder_pt = along(0.10)
        span = 0.36 * length * cos_yaw
        updates: dict[str, tuple[float, float]] = {
            "chest": self.front,
            "upper_back": (along(0.28)[0] - px * lateral * 0.8, along(0.28)[1] - py * lateral * 0.8),
            "lower_back": (along(0.72)[0] - px * lateral * 0.6, along(0.72)[1] - py * lateral * 0.6),
            "left_shoulder": (shoulder_pt[0] + px * span, shoulder_pt[1] + py * span),
            "right_shoulder": (shoulder_pt[0] - px * span, shoulder_pt[1] - py * span),
        }
        for zone, sq in updates.items():
            if zone in self.anchors:
                self.anchors[zone] = self._uv(sq)

    def axis_distance(self, uv: tuple[float, float]) -> float:
        """Distance (square space) from a point to the marked torso segment.

        A hug lands wherever the hugger likes — waist, chest, neck — so
        closeness must be measured against the whole torso line, not its
        midpoint, or a waist hug reads as 'far from the mannequin'.
        Falls back to the center point when nothing is marked.
        """
        p = self._sq(uv)
        return math.dist(p, self.closest_axis_point_sq(p))

    def closest_axis_point_sq(self, p_sq: tuple[float, float]) -> tuple[float, float]:
        """Closest point (square space) on the marked torso segment to p."""
        if self.axis is None:
            return self._sq(self.center)
        a, b = self._sq(self.axis[0]), self._sq(self.axis[1])
        abx, aby = b[0] - a[0], b[1] - a[1]
        l2 = abx * abx + aby * aby or 1e-9
        t = max(0.0, min(1.0, ((p_sq[0] - a[0]) * abx + (p_sq[1] - a[1]) * aby) / l2))
        return (a[0] + abx * t, a[1] + aby * t)

    def contact(self, pose_norm, squeeze: float) -> dict[str, float]:
        """Per-zone contact intensity in [0,1] from hugger joint proximity."""
        if not self.anchors or pose_norm is None:
            return {}
        sigma = max(0.22 * self.px_per_m, 1e-3)  # ~22cm effective reach
        gain = 0.4 + 0.6 * squeeze  # touching while squeezing counts for more
        joints = []
        for idx in CONTACT_LANDMARKS.values():
            lm = pose_norm[idx]
            if getattr(lm, "visibility", 1.0) > 0.4:
                joints.append(self._sq((lm.x, lm.y)))
        if not joints:
            return {}
        zones = {}
        for name, uv in self.anchors.items():
            x, y = self._sq(uv)
            d2 = min((jx - x) ** 2 + (jy - y) ** 2 for jx, jy in joints)
            zones[name] = round(gain * math.exp(-d2 / (2 * sigma * sigma)), 3)
        return zones


@dataclass
class FrameSignals:
    t_ms: int
    tracking: bool
    fps: float = 0.0
    squeeze: float = 0.0
    closing_velocity: float = 0.0
    elbow_angle_deg: dict[str, float] = field(default_factory=dict)
    zones: dict[str, float] = field(default_factory=dict)
    classification: hug_classifier.FrameClassification | None = None
    pose: dict[str, tuple[float, float]] = field(default_factory=dict)
    sticker: tuple[float, float] | None = None
    depth_ratio: float | None = None  # hugger scale / mannequin scale; ~1 = at the bust
    wrap_reach: float = 0.0  # how far the wrists wrap past the mannequin's axis

    def to_json(self, session: dict[str, Any]) -> str:
        cls = self.classification
        return json.dumps({
            "type": "frame",
            "t_ms": self.t_ms,
            "tracking": self.tracking,
            "fps": round(self.fps, 1),
            "squeeze": round(self.squeeze, 3),
            "closing_velocity": round(self.closing_velocity, 3),
            "elbow_angle_deg": {k: round(v, 1) for k, v in self.elbow_angle_deg.items()},
            "zones": self.zones,
            "classification": None if cls is None else {
                "style": cls.style, "coordination": cls.coordination,
                "tightness": cls.tightness, "label": cls.label,
            },
            "pose": {k: [round(u, 4), round(v, 4)] for k, (u, v) in self.pose.items()},
            "sticker": None if self.sticker is None else [round(self.sticker[0], 4), round(self.sticker[1], 4)],
            "depth_ratio": None if self.depth_ratio is None else round(self.depth_ratio, 2),
            "wrap_reach": round(self.wrap_reach, 3),
            "session": session,
        })


class SignalExtractor:
    """Turns MediaPipe results into FrameSignals, tracking frame-to-frame
    velocity of the wrists closing on the mannequin."""

    def __init__(self, mapper: ZoneMapper):
        self.mapper = mapper
        self._dist_ema: float | None = None
        self._prev_t: float | None = None
        self._closing_ema: float = 0.0
        self._squeeze_ema: float = 0.0
        self._toward: tuple[float, float] | None = None  # hugger -> mannequin, sq space

    def extract(self, t_ms: int, fps: float, pose_norm, pose_world) -> FrameSignals:
        if pose_norm is None or pose_world is None:
            self._dist_ema = None
            self._closing_ema = 0.0
            self._squeeze_ema = 0.0
            self._toward = None
            return FrameSignals(t_ms=t_ms, tracking=False, fps=fps)

        cls = hug_classifier.classify_frame(pose_world)

        # Wrist distance to the marked torso segment (waist, chest and neck
        # hugs are all equally "on the mannequin"), in meters via the marked
        # torso's scale.
        now = t_ms / 1000
        dists = []
        wrists_visible = False
        for idx in (L_WRIST, R_WRIST):
            lm = pose_norm[idx]
            dists.append(self.mapper.axis_distance((lm.x, lm.y)))
            if getattr(lm, "visibility", 1.0) > 0.5:
                wrists_visible = True
        dist = float(np.mean(dists))
        dist_m = dist / max(self.mapper.px_per_m, 1e-3)

        # Closing velocity. Raw frame-to-frame differences of a jittery pose
        # estimate spike constantly, so: smooth the distance first, deadband
        # sub-5cm/s motion, smooth the velocity, and freeze the estimate when
        # the wrists aren't confidently visible (occluded mid-hug).
        if wrists_visible and now > (self._prev_t or now):
            dt = now - self._prev_t
            prev_ema = self._dist_ema
            self._dist_ema = dist if prev_ema is None else prev_ema + (dist - prev_ema) * 0.5
            vel = (prev_ema - self._dist_ema) / dt / max(self.mapper.px_per_m, 1e-3) if prev_ema is not None else 0.0
            if vel < 0.05:  # m/s toward the mannequin; ignore jitter and retreat
                vel = 0.0
            self._closing_ema += (float(np.clip(vel, 0, 1)) - self._closing_ema) * 0.35
        elif not wrists_visible:
            self._closing_ema *= 0.9  # decay quietly while occluded
        self._prev_t = now
        closing = round(self._closing_ema, 4)

        # Depth gate: a 2D camera can't tell "wrist on the mannequin" from
        # "wrist on the line of sight to the mannequin". Compare apparent
        # scales instead: the hugger's torso length in image units vs the
        # mannequin's marked scale says whether they're actually standing at
        # the mannequin's distance. Torso length (mid-shoulder to mid-hip)
        # holds up under body yaw, unlike shoulder span.
        depth_ratio = None
        depth_gate = 1.0
        if self.mapper.detected:
            sx = (pose_norm[L_SHOULDER].x + pose_norm[R_SHOULDER].x) / 2
            sy = (pose_norm[L_SHOULDER].y + pose_norm[R_SHOULDER].y) / 2
            hx = (pose_norm[L_HIP].x + pose_norm[R_HIP].x) / 2
            hy = (pose_norm[L_HIP].y + pose_norm[R_HIP].y) / 2
            torso_sq = math.dist(self.mapper._sq((sx, sy)), self.mapper._sq((hx, hy)))
            person_ppm = torso_sq / 0.47  # ~47cm human torso
            depth_ratio = person_ppm / max(self.mapper.px_per_m, 1e-3)
            hips_visible = min(getattr(pose_norm[L_HIP], "visibility", 1.0),
                               getattr(pose_norm[R_HIP], "visibility", 1.0)) > 0.3
            if hips_visible:
                lo, lo_w, hi, hi_w = 0.55, 0.20, 1.8, 0.4
            else:  # hips occluded (deep in the hug) — be lenient, not off
                lo, lo_w, hi, hi_w = 0.40, 0.20, 2.2, 0.4
            depth_gate = float(np.clip(min((depth_ratio - lo) / lo_w, (hi - depth_ratio) / hi_w), 0, 1))

        # Reach-around: the honest "arms wrapped" signal. In a real wrap the
        # wrists cross PAST the mannequin's axis to the far side (away from
        # the hugger's body); palms resting on the chest — even with bent
        # elbows — stay on the hugger's side and earn nothing here. Wrists
        # that lose visibility right next to the bust are hidden BEHIND it,
        # which is wrap evidence too.
        ppm = max(self.mapper.px_per_m, 1e-3)
        hugger_sq = self.mapper._sq(((pose_norm[L_SHOULDER].x + pose_norm[R_SHOULDER].x) / 2,
                                     (pose_norm[L_SHOULDER].y + pose_norm[R_SHOULDER].y) / 2))
        q_h = self.mapper.closest_axis_point_sq(hugger_sq)
        away = (q_h[0] - hugger_sq[0], q_h[1] - hugger_sq[1])
        away_len = math.hypot(*away)
        if away_len > 0.15 * ppm:
            # Only re-learn the approach direction while the bodies are
            # separated; mid-hug they overlap in 2D and the direction is noise.
            self._toward = (away[0] / away_len, away[1] / away_len)
        reach_vals = []
        for idx in (L_WRIST, R_WRIST):
            lm = pose_norm[idx]
            w_sq = self.mapper._sq((lm.x, lm.y))
            r = 0.0
            if self._toward is not None:
                q_w = self.mapper.closest_axis_point_sq(w_sq)
                penetration_m = ((w_sq[0] - q_w[0]) * self._toward[0]
                                 + (w_sq[1] - q_w[1]) * self._toward[1]) / ppm
                r = float(np.clip((penetration_m + 0.02) / 0.10, 0, 1))
            if getattr(lm, "visibility", 1.0) < 0.5 and self.mapper.axis_distance((lm.x, lm.y)) / ppm < 0.25:
                r = max(r, 0.6)  # hand vanished next to the bust: it's behind it
            reach_vals.append(r)
        reach = float(np.mean(reach_vals))

        # GATE is binary-ish — wrists near the mannequin (and at its depth)
        # or it's not a hug at all. HOLD grades how tight the wrists pull
        # onto the torso; REACH grades how far around they wrap. Elbow bend
        # turned out to be ambiguous (palms-on-chest bends elbows too), so
        # wrap depth only feeds the tightness classification, not squeeze.
        gate = depth_gate * float(np.clip((0.50 - dist_m) / 0.15, 0, 1))
        hold = float(np.clip((0.32 - dist_m) / 0.22, 0, 1))
        squeeze_raw = gate * float(np.clip(0.10 + 0.30 * hold + 0.50 * reach + 0.10 * closing, 0, 1))
        # Smooth against pose jitter while the bust occludes the arms.
        self._squeeze_ema += (squeeze_raw - self._squeeze_ema) * 0.45
        squeeze = round(self._squeeze_ema, 4)
        zones = self.mapper.contact(pose_norm, squeeze)
        pose = {}
        for name, idx in POSE_OVERLAY.items():
            lm = pose_norm[idx]
            pose[name] = (lm.x, lm.y)

        return FrameSignals(
            t_ms=t_ms, tracking=True, fps=fps, squeeze=squeeze, closing_velocity=closing,
            elbow_angle_deg={"left": cls.left.elbow_angle_deg, "right": cls.right.elbow_angle_deg},
            zones=zones, classification=cls, pose=pose, depth_ratio=depth_ratio,
            wrap_reach=reach,
        )


# ---------------------------------------------------------------- sources

class CameraSource:
    """Webcam/video -> MediaPipe Holistic at ~10 Hz."""

    def __init__(self, camera: int, video: str | None, sticker_hsv=STICKER_PRESETS["blue"]):
        import cv2
        import mediapipe as mp

        self.cv2 = cv2
        self.sticker_hsv = sticker_hsv
        self.last_sticker: tuple[float, float] | None = None  # normalized (u, v)
        self.aspect = 16 / 9  # refined from the first real frame
        self.cap = cv2.VideoCapture(video if video else camera)
        if not self.cap.isOpened():
            src = video or f"camera {camera}"
            raise RuntimeError(
                f"Could not open {src}. On macOS, grant camera access to your "
                "terminal in System Settings → Privacy & Security → Camera."
            )
        self.holistic = mp.solutions.holistic.Holistic(
            model_complexity=1, enable_segmentation=False, refine_face_landmarks=False,
        )
        self.last_jpeg: str | None = None  # small base64 frame for the operator UI
        self._frame_no = 0

    def read(self):
        """Returns (pose_norm, pose_world) landmark lists or (None, None)."""
        ok, frame = self.cap.read()
        if not ok:
            return None, None
        self._frame_no += 1
        # Live preview at full capture rate — local WS, so bandwidth is cheap.
        h, w = frame.shape[:2]
        self.aspect = w / h
        small = self.cv2.resize(frame, (560, max(1, int(h * 560 / w))))
        ok2, buf = self.cv2.imencode('.jpg', small, [self.cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok2:
            self.last_jpeg = base64.b64encode(buf.tobytes()).decode()
        self.last_sticker = self._detect_sticker(small)
        rgb = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        res = self.holistic.process(rgb)
        if res.pose_landmarks is None or res.pose_world_landmarks is None:
            return None, None
        return res.pose_landmarks.landmark, res.pose_world_landmarks.landmark

    def _detect_sticker(self, frame_bgr) -> tuple[float, float] | None:
        """Find the FRONT sticker: largest roughly-square blob in the
        configured color range, returned in normalized image coords."""
        cv2 = self.cv2
        h, w = frame_bgr.shape[:2]
        hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, np.array(self.sticker_hsv[0]), np.array(self.sticker_hsv[1]))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        best, best_area = None, 0.0
        frame_area = float(w * h)
        for c in contours:
            area = cv2.contourArea(c)
            frac = area / frame_area
            if not (0.0004 < frac < 0.05):  # sticky-note-sized, not a blue shirt
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            aspect = bw / max(bh, 1)
            if not (0.4 < aspect < 2.5):
                continue
            if area > best_area:
                best_area = area
                best = (x + bw / 2, y + bh / 2)
        if best is None:
            return None
        return (best[0] / w, best[1] / h)

    def close(self):
        self.cap.release()
        self.holistic.close()


class SyntheticSource:
    """Simulated hugger for development without a camera: an 8s loop of
    approach -> deep criss-cross squeeze -> release, emitting landmark lists
    shaped like MediaPipe's (x, y, z, visibility)."""

    PERIOD = 8.0
    aspect = 560 / 315

    def __init__(self):
        self.t0 = time.monotonic()
        # Placeholder camera frame (with a bust-ish blob) so the operator UI's
        # camera panel and manual marking flow work in synthetic mode too.
        self.last_jpeg: str | None = None
        try:
            import cv2
            img = np.full((203, 360, 3), 20, np.uint8)
            cv2.ellipse(img, (180, 120), (52, 78), 0, 0, 360, (72, 66, 60), -1)
            cv2.ellipse(img, (180, 52), (18, 14), 0, 0, 360, (72, 66, 60), -1)
            cv2.putText(img, "SYNTHETIC FEED", (10, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (110, 100, 90), 1)
            ok, buf = cv2.imencode(".jpg", img)
            if ok:
                self.last_jpeg = base64.b64encode(buf.tobytes()).decode()
        except Exception:
            pass

    @staticmethod
    def _lm(x, y, z=0.0):
        return SimpleNamespace(x=x, y=y, z=z, visibility=1.0)

    def read(self):
        t = (time.monotonic() - self.t0) % self.PERIOD
        # phase: 0 open, 1 fully wrapped
        if t < 3:
            phase = t / 3 * 0.2
        elif t < 6:
            phase = 0.2 + 0.8 * min(1.0, (t - 3) / 1.2) - 0.1 * math.sin((t - 3) * 6) * 0.3
        else:
            phase = max(0.0, 1.0 - (t - 6) / 1.5)
        phase = float(np.clip(phase, 0, 1))

        world = [self._lm(0, 0) for _ in range(33)]
        norm = [self._lm(0.5, 0.5) for _ in range(33)]

        # World space (y down, meters, origin between hips).
        sh_y, sh_x = -0.55, 0.18
        world[L_SHOULDER] = self._lm(+sh_x, sh_y, 0)
        world[R_SHOULDER] = self._lm(-sh_x, sh_y, 0)
        # Elbows bend as phase rises; elbow angle goes ~170° -> ~75°.
        world[L_ELBOW] = self._lm(+sh_x + 0.22, sh_y + 0.22 - 0.05 * phase, -0.10 * phase)
        world[R_ELBOW] = self._lm(-sh_x - 0.22, sh_y + 0.22 - 0.05 * phase, -0.10 * phase)
        # Criss-cross: left wrist ends high (shoulder line), right ends low.
        lw_open = (+sh_x + 0.42, sh_y + 0.44, 0.0)
        rw_open = (-sh_x - 0.42, sh_y + 0.44, 0.0)
        lw_hug = (-0.05, sh_y + 0.05, -0.30)   # reaches across to upper back
        rw_hug = (+0.05, sh_y + 0.42, -0.30)   # wraps low around the waist
        mix = lambda a, b: tuple(a[i] + (b[i] - a[i]) * phase for i in range(3))
        world[L_WRIST] = self._lm(*mix(lw_open, lw_hug))
        world[R_WRIST] = self._lm(*mix(rw_open, rw_hug))
        world[NOSE] = self._lm(0, sh_y - 0.12, 0)

        # Image space: hugger drifts from the right edge onto the mannequin
        # anchor at the frame center as the hug closes.
        cx = 0.5 + 0.35 * (1 - phase)
        norm[NOSE] = self._lm(cx, 0.22)
        norm[L_SHOULDER] = self._lm(cx + 0.08, 0.35)
        norm[R_SHOULDER] = self._lm(cx - 0.08, 0.35)
        norm[L_ELBOW] = self._lm(cx + 0.13 - 0.06 * phase, 0.47)
        norm[R_ELBOW] = self._lm(cx - 0.13 + 0.03 * phase, 0.50)
        # Wrists land on chest height (v ~ .45) and waist (v ~ .55) at center.
        norm[L_WRIST] = self._lm(cx + 0.18 - (cx + 0.18 - 0.50) * phase, 0.55 - 0.10 * phase)
        norm[R_WRIST] = self._lm(cx - 0.18 + (0.50 - (cx - 0.18)) * phase, 0.48 + 0.07 * phase)
        return norm, world

    def close(self):
        pass


# ---------------------------------------------------------------- server

class HugServer:
    def __init__(self, source, mapper: ZoneMapper, store: storage.Storage, target_fps: float = 10.0):
        self.source = source
        self.mapper = mapper
        self.store = store
        self.extractor = SignalExtractor(mapper)
        self.target_dt = 1.0 / target_fps
        self.clients: set = set()
        self.latest: FrameSignals | None = None
        self.session: scoring.SessionFrames | None = None
        self.session_name = ""
        self.session_started_ms = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.t0 = time.monotonic()
        self._events: list[dict] = []  # capture thread -> broadcast loop
        self._detect_until: float | None = None
        self._detect_samples: dict[int, list[tuple[float, float]]] = {}

    DETECT_FRAMES = 6
    DETECT_TIMEOUT = 6.0

    # capture thread ------------------------------------------------------
    def capture_loop(self):
        fps = 0.0
        while not self._stop.is_set():
            started = time.monotonic()
            norm, world = self.source.read()
            t_ms = int((time.monotonic() - self.t0) * 1000)
            if self._detect_until is not None:
                self._run_detection(norm)
            self.mapper.aspect = getattr(self.source, "aspect", 16 / 9)
            sticker = getattr(self.source, "last_sticker", None)
            self.mapper.update_front(sticker)
            sig = self.extractor.extract(t_ms, fps, norm, world)
            sig.sticker = sticker
            with self._lock:
                self.latest = sig
                if self.session is not None and sig.tracking:
                    self.session.add(t_ms, sig.squeeze, sig.zones, sig.classification)
            elapsed = time.monotonic() - started
            fps = 1.0 / max(elapsed, self.target_dt)
            time.sleep(max(0.0, self.target_dt - elapsed))

    def _run_detection(self, pose_norm) -> None:
        """Accumulate a few stable pose frames of the (empty) scene and pin
        the zone anchors to the detected mannequin skeleton."""
        if pose_norm is not None:
            for idx in {L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_WRIST, R_WRIST, L_HIP, R_HIP}:
                lm = pose_norm[idx]
                self._detect_samples.setdefault(idx, []).append((lm.x, lm.y))
        samples = self._detect_samples
        done = samples and min(len(v) for v in samples.values()) >= self.DETECT_FRAMES
        if done:
            mean_lm = {idx: (float(np.mean([p[0] for p in pts])), float(np.mean([p[1] for p in pts])))
                       for idx, pts in samples.items()}
            self.mapper.set_from_pose(mean_lm)
            self._detect_until = None
            self._detect_samples = {}
            with self._lock:
                self._events.append({"type": "mannequin", "detected": True,
                                     "anchors": self.mapper.anchors})
            print(f"[hug-machine] mannequin detected: {len(self.mapper.anchors)} zone anchors", flush=True)
        elif time.monotonic() > self._detect_until:
            self._detect_until = None
            self._detect_samples = {}
            with self._lock:
                self._events.append({
                    "type": "error",
                    "message": "No mannequin detected — make sure it fills the frame and nobody else is visible.",
                })

    # websocket side ------------------------------------------------------
    def _session_state(self) -> dict[str, Any]:
        with self._lock:
            active = self.session is not None
            t_ms = self.latest.t_ms if self.latest else 0
        return {
            "active": active,
            "name": self.session_name if active else None,
            "elapsed_ms": (t_ms - self.session_started_ms) if active else 0,
        }

    async def broadcast_loop(self):
        last_preview: str | None = None
        last_anchors: dict[str, tuple[float, float]] = {}
        last_anchor_push = 0.0
        while True:
            await asyncio.sleep(self.target_dt)
            with self._lock:
                sig = self.latest
            if sig is None or not self.clients:
                continue
            msg = sig.to_json(self._session_state())
            websockets.broadcast(self.clients, msg)
            with self._lock:
                events, self._events = self._events, []
            for ev in events:
                websockets.broadcast(self.clients, json.dumps(ev))
            # Sticker tracking moves anchors live — push updates, throttled.
            now = time.monotonic()
            anchors = self.mapper.anchors
            if anchors != last_anchors and now - last_anchor_push > 0.4:
                moved = any(
                    z not in last_anchors or math.dist(uv, last_anchors[z]) > 0.006
                    for z, uv in anchors.items()
                )
                if moved or set(anchors) != set(last_anchors):
                    websockets.broadcast(self.clients, json.dumps(
                        {"type": "mannequin", "detected": self.mapper.detected, "anchors": anchors}))
                last_anchors = dict(anchors)
                last_anchor_push = now
            jpeg = getattr(self.source, "last_jpeg", None)
            if jpeg is not None and jpeg is not last_preview:
                last_preview = jpeg
                websockets.broadcast(self.clients, json.dumps(
                    {"type": "preview", "jpeg_b64": jpeg}))

    async def _send(self, ws, payload: dict) -> None:
        await ws.send(json.dumps(payload))

    async def handle(self, ws):
        self.clients.add(ws)
        try:
            await self._send(ws, {"type": "hello", "zones": self.mapper.zone_names,
                                  "mannequin": {"detected": self.mapper.detected,
                                                "anchors": self.mapper.anchors}})
            await self._send(ws, {"type": "leaderboard", "rows": self.store.leaderboard()})
            jpeg = getattr(self.source, "last_jpeg", None)
            if jpeg is not None:
                await self._send(ws, {"type": "preview", "jpeg_b64": jpeg})
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self.on_message(ws, msg)
        finally:
            self.clients.discard(ws)

    async def on_message(self, ws, msg: dict):
        kind = msg.get("type")
        if kind == "start_hug":
            with self._lock:
                self.session = scoring.SessionFrames()
                self.session_name = str(msg.get("name") or "Anonymous")[:40]
                self.session_started_ms = self.latest.t_ms if self.latest else 0
            websockets.broadcast(self.clients, json.dumps(
                {"type": "hug_started", "name": self.session_name}))

        elif kind == "end_hug":
            with self._lock:
                session, name = self.session, self.session_name
                self.session = None
            if session is None:
                await self._send(ws, {"type": "error", "message": "no active hug"})
                return
            profile = scoring.score_session(
                session, name, datetime.now(timezone.utc).isoformat(timespec="seconds"))
            row = self.store.save_hug(profile)
            websockets.broadcast(self.clients, json.dumps(
                {"type": "score", "profile": profile, "rank": row["rank"]}))
            websockets.broadcast(self.clients, json.dumps(
                {"type": "leaderboard", "rows": self.store.leaderboard()}))

        elif kind == "get_leaderboard":
            await self._send(ws, {"type": "leaderboard", "rows": self.store.leaderboard()})

        elif kind == "detect_mannequin":
            self._detect_samples = {}
            self._detect_until = time.monotonic() + self.DETECT_TIMEOUT
            websockets.broadcast(self.clients, json.dumps({"type": "detecting"}))

        elif kind == "set_mannequin":
            try:
                neck = (float(msg["neck"][0]), float(msg["neck"][1]))
                base = (float(msg["base"][0]), float(msg["base"][1]))
            except (KeyError, TypeError, ValueError, IndexError):
                await self._send(ws, {"type": "error", "message": "set_mannequin needs neck:[u,v] and base:[u,v]"})
                return
            self.mapper.set_manual(neck, base)
            print(f"[hug-machine] mannequin marked manually: {len(self.mapper.anchors)} zone anchors", flush=True)
            websockets.broadcast(self.clients, json.dumps(
                {"type": "mannequin", "detected": True, "anchors": self.mapper.anchors}))

    async def run(self, host: str, port: int):
        thread = threading.Thread(target=self.capture_loop, daemon=True)
        thread.start()
        async with websockets.serve(self.handle, host, port):
            print(f"[hug-machine] ws://{host}:{port} — "
                  f"{len(self.mapper.zone_names)} zones loaded, "
                  f"mannequin {'detected' if self.mapper.detected else 'NOT detected — use Detect Mannequin'}, "
                  f"source={type(self.source).__name__}",
                  flush=True)
            try:
                await self.broadcast_loop()
            finally:
                self._stop.set()


def main():
    ap = argparse.ArgumentParser(description="Hug Rating Machine CV backend")
    ap.add_argument("--camera", type=int, default=0, help="webcam index (default 0)")
    ap.add_argument("--video", type=str, default=None, help="video file instead of webcam")
    ap.add_argument("--synthetic", action="store_true", help="simulated hugger, no camera")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--zones", type=Path, default=ZONES_PATH, help="mannequin_zones.json path")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--sticker", choices=sorted(STICKER_PRESETS), default="blue",
                    help="color of the FRONT sticker on the mannequin's chest")
    args = ap.parse_args()

    mapper = ZoneMapper(args.zones)
    source = (SyntheticSource() if args.synthetic
              else CameraSource(args.camera, args.video, STICKER_PRESETS[args.sticker]))
    store = storage.Storage()
    server = HugServer(source, mapper, store, target_fps=args.fps)
    try:
        asyncio.run(server.run(args.host, args.port))
    except KeyboardInterrupt:
        pass
    finally:
        source.close()
        store.close()


if __name__ == "__main__":
    main()
