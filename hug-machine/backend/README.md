# CV Backend

Webcam → MediaPipe Holistic → hug signals → WebSocket JSON at ~10 Hz.

```sh
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py                # default webcam, ws://localhost:8765
.venv/bin/python main.py --synthetic    # simulated hugger (no camera)
.venv/bin/python main.py --video f.mp4  # video file
```

First run with a real webcam: macOS will ask for camera permission for your
terminal app (System Settings → Privacy & Security → Camera if you missed it).

Requires `data/mannequin_zones.json` from the zone painter (a default is
committed; regenerate with `npm exec tsx scripts/gen_default_zones.ts` in
`frontend/zone-painter`, or paint + export your own).

Smoke test a full session against a running server:

```sh
.venv/bin/python test_client.py --hug-seconds 6 --name Alice
```

## WebSocket protocol

Server → client:

- `hello` — zone names + mannequin detection state (on connect)
- `frame` (~10 Hz) — `tracking`, `squeeze` 0–1, `closing_velocity`,
  `elbow_angle_deg {left,right}`, `zones {name: intensity 0–1}`,
  `classification {style, coordination, tightness, label}`,
  `pose {joint: [u,v]}` (normalized image coords for skeleton overlay),
  `session {active, name, elapsed_ms}`
- `hug_started`, `score` (full hug profile + rank), `leaderboard`, `error`
- `preview` (~2.5 Hz) — small base64 JPEG of the camera for the operator UI
- `detecting`, then `mannequin {detected, anchors {zone: [u,v]}}` — result of
  mannequin detection

Client → server:

- `{"type": "start_hug", "name": "Alice"}`
- `{"type": "end_hug"}` — scores the session, persists, broadcasts `score`
- `{"type": "get_leaderboard"}`
- `{"type": "set_mannequin", "neck": [u,v], "base": [u,v]}` — mark the
  mannequin manually from two operator clicks (neck notch + torso base).
  Built for torso-only tailor's busts, which pose detection can't see; derives
  chest/back/shoulder anchors from bust proportions and skips arm zones.
- `{"type": "detect_mannequin"}` — alternative for full-body person-shaped
  mannequins: with nobody in frame, pose-detects it and pins each zone's
  anchor to the matching joint on its detected skeleton.

Both save to `data/mannequin_anchors.json` and survive restarts. Contact
intensity = hugger wrist/elbow proximity to the anchors, boosted while
squeezing. Coverage scoring normalizes over the zones the mannequin actually
has anchors for, so an armless bust can still score a full 10.

**FRONT sticker (live orientation).** Stick a colored sticky note on the
mannequin's chest (`--sticker blue|green|pink|orange`, default blue). After
manual marking, the backend color-tracks the sticker every frame: the sticker
position becomes the chest anchor, its sideways offset from the torso axis
gives the yaw (shoulder anchors compress, back anchors shift to the far side).
Rotate the mannequin freely — anchors follow. When the hugger occludes the
sticker, the last known orientation holds. Oversized blue regions (clothing)
and blobs away from the torso are rejected. The `frame` message includes
`sticker: [u,v] | null`, shown as a blue ring in the operator camera panel.

## Modules

- `main.py` — capture loop (camera/video/synthetic), signal extraction,
  zone-contact mapping, WebSocket server, session state
- `hug_classifier.py` — rule-based HUG-taxonomy classifier
  (style × coordination × tightness) from pose world landmarks
- `scoring.py` — post-hug scoring: strength 30 / style 25 / coverage 25 /
  warmth 20 (warmth is a fixed 9.0 baseline — no thermal camera)
- `storage.py` — SQLite leaderboard (`data/leaderboard.db`) + per-hug profile
  JSON (`data/profiles/`)

Scoring notes: strength = 0.6·avg + 0.4·peak squeeze; style = classification
stability over engaged frames (squeeze ≥ 0.35); coverage =
importance-weighted share of reachable zones whose contact intensity ever
reached 0.35.

Squeeze = gate × (0.10 + 0.30·hold + 0.50·reach + 0.10·closing), EMA-smoothed:

- **reach** — the "arms actually wrapped" signal: how far the wrists cross
  PAST the mannequin's torso axis to the far side, judged against the
  hugger's approach direction (learned while the bodies are still separated,
  frozen once they overlap in 2D). Wrists that lose tracking visibility
  right next to the bust count as hidden behind it (reach ≥ 0.6). Palms
  resting on the chest — even with bent elbows — score 0 here.
- **hold** — how tight the wrists pull onto the torso segment (1.0 within
  ~10 cm, 0 beyond ~32 cm), measured against the whole neck→base line so
  waist and neck hugs count.
- **gate** — near-binary: wrists within ~50 cm of the mannequin AND the depth
  gate agrees (hugger's apparent torso length vs the mannequin's marked
  scale, `depth_ratio` ≈ 1.0 = standing at the bust; loosens when the hips
  are occluded mid-hug).
- Elbow bend is deliberately NOT in squeeze — palms-on-chest bends elbows
  too. It still feeds the taxonomy's tightness classification.

Calibration: full wrap ≈ 0.9, wrap with hidden wrists ≈ 0.7, palms on chest
≈ 0.4, desk typing / far away = 0. `wrap_reach` is streamed per frame and
shown as its own meter in the operator UI.
