# Hug Rating Machine — Project Brief

## Overview
People hug a physical mannequin. A CV pipeline measures the hug in real time. After they step back, a score is revealed. Results go on a leaderboard.

## Aesthetic
**Human-centric futuristic** — dark background, warm glows, clean sans-serif type, generous whitespace. Mannequin rendered as wireframe + solid hybrid. Score reveal is cinematic. Leaderboard feels like mission control.

---

## Physical Setup
- A physical mannequin the hugger embraces
- A webcam pointed at the hugger + mannequin
- A laptop (Mac) running everything locally

---

## CV Pipeline (Python backend)
- **MediaPipe Holistic** — 33 3D pose landmarks per frame, ~10fps
- **Derived signals per frame:**
  - `SE` and `EW` vectors (shoulder→elbow, elbow→wrist) per arm
  - Arm closing velocity (Δjoint position / Δt)
  - Wrap depth (elbow angle)
  - Contact zone mapping (landmark proximity to mannequin zones)
- **Hug type classification** from the HUG taxonomy paper (s41598-024-64825-8):
  - Style: criss-cross / neck-loop / waist-loop
  - Coordination: horizontal-parallel / vertical-parallel / perpendicular
  - Tightness: body-hug / air-hug
- **Output**: WebSocket frames (JSON, ~10Hz) → browser

---

## Scoring (post-hug, aggregated over session)
| Dimension | Source | Weight |
|-----------|--------|--------|
| Strength | squeeze_intensity avg + peak | 30% |
| Style | hug_type classification quality | 25% |
| Coverage | % mannequin zones contacted, weighted by zone importance | 25% |
| Warmth | assumed constant (body temp baseline) | 20% |

Final score: weighted 0–10, plus breakdown per dimension.

---

## Mannequin Digital Twin
- **Default**: programmatic anatomical mannequin built in Three.js (no scan needed)
- **Custom**: user can load a `.glb` from LiDAR iPhone scan (Scaniverse app)
- **Zone painter**: browser tool to paint named zones onto mesh, export `mannequin_zones.json`
  - Zones: chest, left_shoulder, right_shoulder, left_upper_arm, right_upper_arm, left_lower_arm, right_lower_arm, upper_back, lower_back
  - Output: `{ face_index → zone_name }` + zone centroids

---

## Frontend (React + Three.js)
- **Operator view (during hug)**: live 3D mannequin heatmap — zones colour from cool blue → orange → hot red by contact intensity. Hugger cannot see this screen.
- **Score reveal screen (post-hug)**: cinematic animated reveal of dimension scores + overall score
- **Leaderboard**: ranked list of all huggers, name + overall score + breakdown + hug type badge
- **Zone painter**: separate setup tool (one-time use)

---

## Hug Profile Schema
```json
{
  "metadata": {
    "hugger_name": "Alice",
    "timestamp": "2026-07-08T10:30:00Z",
    "duration_ms": 4200,
    "schema_version": "1.0"
  },
  "scoring": {
    "strength": 8.2,
    "style": 7.5,
    "coverage": 6.1,
    "warmth": 9.0,
    "overall": 7.7,
    "hug_type": "criss-cross/horizontal-parallel/body-hug"
  },
  "contact_frames": [
    { "t_ms": 0, "zones": { "chest": 0.8, "left_shoulder": 0.6 } }
  ]
}
```

---

## Storage
- SQLite on laptop for leaderboard persistence (survives restarts)
- Each hug saved as a profile JSON

---

## Tech Stack
| Layer | Technology |
|-------|-----------|
| CV backend | Python 3.11, MediaPipe, OpenCV, websockets |
| Frontend | React + Three.js |
| Storage | SQLite (leaderboard), JSON files (profiles) |

---

## Build Order
1. **Zone painter** — Three.js tool, default mannequin, paint + export zones (unblocks everything)
2. **Python CV backend** — MediaPipe → scoring → WebSocket
3. **Hug rater frontend** — live heatmap + score reveal + leaderboard

## File Structure
```
hug-machine/
├── backend/
│   ├── main.py              # WebSocket server + MediaPipe
│   ├── scoring.py           # Hug scoring algorithm
│   ├── hug_classifier.py    # HUG paper decision tree
│   └── storage.py           # SQLite leaderboard
├── frontend/
│   ├── zone-painter/        # One-time setup tool
│   └── hug-rater/           # Main rating + leaderboard app
└── data/
    ├── mannequin.glb        # Default or scanned mesh
    ├── mannequin_zones.json # Painted zone config
    └── leaderboard.db       # SQLite
```

---

## Key References
- HUG taxonomy paper: https://www.nature.com/articles/s41598-024-64825-8
  - 16 hug types across 3 dimensions (style, coordination, tightness)
  - Rule-based classifier using SE×EW vectors, validated at 95-96% accuracy on humanoid robot
- MediaPipe Holistic: landmark indices 11-16 (shoulders/elbows/wrists) are the key joints
- Default mannequin: build programmatically in Three.js using CylinderGeometry + SphereGeometry primitives

## Notes
- Mac only (no Windows/Linux paths needed)
- No hardware experience — avoid soldering, use breadboard + jumper wires
- Temperature is assumed (no thermal camera) — fixed warm baseline in scoring
