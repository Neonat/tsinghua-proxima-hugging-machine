#!/bin/zsh
# 双击启动太空站端 / Double-click me on the SPACE laptop.
# Serves the astronaut UI and opens it in Chrome (Web Serial needs Chrome).
# Then: plug in the robot via USB, click the link icon (top right), pick the
# port, and wait for hugs. Ctrl+C in this window stops the server.

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "── PROXIMA · SPACE STATION ──────────────────────"

SRV_PID=""
if nc -z localhost 5201 2>/dev/null; then
  echo "Astronaut UI already running on :5201 — reusing it."
else
  echo "Serving astronaut UI on http://localhost:5201 …"
  python3 -m http.server 5201 --directory frontend/space-station \
    > /tmp/proxima-space.log 2>&1 &
  SRV_PID=$!
  sleep 1
fi

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

if [ -z "$PROXIMA_NO_BROWSER" ]; then
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "http://localhost:5201"
  else
    open "http://localhost:5201"
    echo "⚠ Chrome not found — the robot link (Web Serial) only works in Chrome/Edge."
  fi
fi

echo ""
echo "Astronaut UI is up. Checklist:"
echo "  1. robot plugged in via USB (hug_receiver.ino flashed)"
echo "  2. click the link icon top-right, pick the robot's port"
echo "  3. wait for the '!' face — then RECEIVE HUG"
echo ""
echo "Ctrl+C here stops the server."
wait
