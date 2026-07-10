# Arduino — Hug Receiver (space-station robot)

`hug_receiver/hug_receiver.ino` — flash this to the robot's Arduino. It keeps
the original autonomous hug + LED expressions and adds a **parametric
playback** protocol so a recorded Earth hug can be re-enacted.

Design rule: the Arduino is deliberately dumb. All the tunable mapping
(squeeze + wrap_reach → force, replay timing) lives on the computer in Python,
so it can be iterated **without reflashing** (which needs a physical cable).
The only things that live on the Arduino are physical-safety limits.

## Serial protocol (9600 baud, `\n`-terminated)

Computer → robot:

| Command      | Effect |
|--------------|--------|
| `play`       | Start playback: arms slowly seek the astronaut's body via the touch sensors, capturing each arm's **contact angle** (the zero-force point). |
| `s<0-255>`   | Set squeeze strength. Each arm presses to `contact + (s/255)·PRESS_MARGIN°`, slew-limited. Stream these at ~10 Hz to replay a hug. e.g. `s0`, `s128`, `s255`. |
| `end`        | Finish playback, release the arms. |
| `stop`       | Emergency open, from any state. |
| `hug`        | Original autonomous hug (unchanged). |

Robot → computer (status/telemetry, one per line):

`>READY` `>SEEK` `>CONTACT <arm> <angle>` `>STREAM` `>DONE` `>STOP`

## Bench test by hand (no software needed)

Open the Arduino IDE Serial Monitor (9600 baud, newline ending) and type:

```
play      → arms close slowly, stop when they touch something (or at APPROACH_MAX)
s60       → arms press in a little
s200      → arms press harder
s0        → arms ease back to just-touching
end       → arms open, back to idle face
```

If nothing is between the arms, the seek runs to `APPROACH_MAX` and `s` still
presses from there — good enough to watch the motion. If you stop sending `s`
frames, the watchdog (`FRAME_TIMEOUT`) auto-releases after ~0.8 s.

## Single-arm mode (run on USB power, no extra hardware)

Two servos moving at once is the worst case for current draw — more than a
laptop's USB port (~500 mA) can supply, which browns out the board and drops
it off USB ("The device has been lost" in Chrome).

Driving **one arm roughly halves the peak current**, which often fits inside
the USB budget. At the top of the sketch:

```cpp
const bool armEnabled[2] = {true, false};   // arm0 = pin 9, arm1 = pin 10
```

A disabled arm is never `attach()`ed, so it receives no pulses and draws
essentially nothing (it just goes limp — you can leave it plugged in).
Once you have proper servo power, set both to `true`.

## Safety constants (top of the sketch — tune on the bench)

| Constant | Meaning |
|----------|---------|
| `PRESS_MARGIN` (30) | **The main one.** Max degrees the arms press *past* body contact. Larger = tighter/stronger. Start small. |
| `APPROACH_MAX` (165) | Closing-angle cap while seeking, if a touch sensor never fires. |
| `APPROACH_SPEED` (50) | Contact-seek speed, °/s. Slower = less peak current. |
| `SLEW_RATE` (120) | Max servo speed during squeeze, °/s — smooths sudden strength jumps, keeps current down. |
| `FRAME_TIMEOUT` (800) | Auto-release if no frame for this long, ms. |
| `MAX_SAFE_ANGLE` (180) | Hard ceiling; arms never exceed it. |

## How the computer will drive it (Python side, next)

`space_station.py` (to be built) will, on the astronaut's **Receive Hug**:

1. send `play`, wait for `>STREAM`,
2. replay the recording frame-by-frame at its **own timestamps** (so hug speed
   is reproduced), converting each frame to a strength byte:
   `strength = clamp(squeeze · (1 + WRAP_BOOST · wrap_reach), 0, 1) · 255`
   — squeeze sets the base force, wrap_reach firms it up,
3. send `end` when the recording finishes.

`WRAP_BOOST` and the clamp curve live in Python and are free to tune.
