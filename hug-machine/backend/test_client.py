"""Smoke test: connect to the backend, run a hug session, print the score.

    python test_client.py [--port 8765] [--hug-seconds 5] [--name Alice]
"""

from __future__ import annotations

import argparse
import asyncio
import json

import websockets


async def run(port: int, name: str, hug_seconds: float) -> None:
    async with websockets.connect(f"ws://localhost:{port}") as ws:
        frames = 0
        tracked = 0
        peak_squeeze = 0.0
        hot_zones: dict[str, float] = {}
        started = False
        scored = False
        deadline = asyncio.get_event_loop().time() + hug_seconds + 15

        await ws.send(json.dumps({"type": "start_hug", "name": name}))
        end_at = asyncio.get_event_loop().time() + hug_seconds

        while asyncio.get_event_loop().time() < deadline:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            kind = msg.get("type")
            if kind == "hello":
                print(f"hello: zones={msg['zones']}")
            elif kind == "hug_started":
                started = True
                print(f"hug started for {msg['name']}")
            elif kind == "frame":
                frames += 1
                if msg["tracking"]:
                    tracked += 1
                    peak_squeeze = max(peak_squeeze, msg["squeeze"])
                    for z, v in msg["zones"].items():
                        hot_zones[z] = max(hot_zones.get(z, 0), v)
                if started and asyncio.get_event_loop().time() >= end_at:
                    started = False
                    await ws.send(json.dumps({"type": "end_hug"}))
            elif kind == "score":
                s = msg["profile"]["scoring"]
                m = msg["profile"]["metadata"]
                print(f"\nframes={frames} tracked={tracked} peak_squeeze={peak_squeeze:.2f}")
                print("zone peaks:", {z: round(v, 2) for z, v in sorted(hot_zones.items(), key=lambda kv: -kv[1])[:5]})
                print(f"\nSCORE for {m['hugger_name']} ({m['duration_ms']} ms): "
                      f"overall {s['overall']}  rank #{msg['rank']}")
                print(f"  strength {s['strength']}  style {s['style']}  "
                      f"coverage {s['coverage']}  warmth {s['warmth']}")
                print(f"  hug_type: {s['hug_type']}")
                scored = True
            elif kind == "leaderboard" and scored:
                rows = msg["rows"][:5]
                if rows:
                    print("\nleaderboard:")
                    for r in rows:
                        print(f"  #{r['rank']} {r['name']:<20} {r['overall']:>4}  {r['hug_type']}")
                    return
        raise SystemExit("timed out without receiving a score")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--name", default="Test Hugger")
    ap.add_argument("--hug-seconds", type=float, default=5.0)
    args = ap.parse_args()
    asyncio.run(run(args.port, args.name, args.hug_seconds))
