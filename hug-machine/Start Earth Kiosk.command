#!/bin/zsh
# 双击启动地球端 / Double-click me on the EARTH laptop.
# Starts the CV backend (webcam) + the kiosk UI, then opens the browser.
# First run: installs dependencies and macOS asks for camera access — Allow.
# Ctrl+C in this window (or closing it) stops everything.
#
# Rehearsal without a camera:  PROXIMA_SYNTH=1 "./Start Earth Kiosk.command"

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "── PROXIMA · EARTH ──────────────────────────────"

# ---------- 1. Python backend environment ----------
if [ ! -d backend/.venv ]; then
  echo "Setting up Python environment (first run only)…"
  PY=/usr/local/bin/python3.12
  [ -x "$PY" ] || PY=python3
  "$PY" -m venv backend/.venv
  backend/.venv/bin/pip install -r backend/requirements.txt
fi

# ---------- 2. Kiosk UI dependencies ----------
if [ ! -d frontend/hug-rater/node_modules ]; then
  echo "Installing kiosk UI dependencies (first run only)…"
  (cd frontend/hug-rater && npm install)
fi

# ---------- 3. Kiosk UI dev server (port 5200) ----------
VITE_PID=""
if nc -z localhost 5200 2>/dev/null; then
  echo "Kiosk UI already running on :5200 — reusing it."
else
  echo "Starting kiosk UI on http://localhost:5200 …"
  (cd frontend/hug-rater && exec npm run dev -- --port 5200 --strictPort) \
    > /tmp/proxima-kiosk.log 2>&1 &
  VITE_PID=$!
fi

PY_PID=""
cleanup() {
  [ -n "$PY_PID" ] && kill "$PY_PID" 2>/dev/null
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null
  # npm wraps vite in a child process; make sure the real server dies too
  pkill -f "vite --port 5200" 2>/dev/null
}
trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

# wait until the UI answers (npm start can take a few seconds)
for i in {1..60}; do
  nc -z localhost 5200 2>/dev/null && break
  sleep 0.5
done
if ! nc -z localhost 5200 2>/dev/null; then
  echo "Kiosk UI failed to start — see /tmp/proxima-kiosk.log"
  exit 1
fi

# ---------- 4. Open the kiosk in the browser ----------
if [ -z "$PROXIMA_NO_BROWSER" ]; then
  open "http://localhost:5200"
  echo "Kiosk opened — put the browser in fullscreen (⌃⌘F) on the big screen."
fi

# ---------- 5. CV backend ----------
# Runs as a monitored child (not exec, not plain foreground) so the traps
# above stay responsive and stop BOTH servers on Ctrl+C / window close.
echo "Starting camera backend on ws://localhost:8765 — Ctrl+C stops everything."
if [ -n "$PROXIMA_SYNTH" ]; then
  backend/.venv/bin/python backend/main.py --synthetic "$@" &
else
  backend/.venv/bin/python backend/main.py "$@" &
fi
PY_PID=$!
wait $PY_PID
