#!/bin/zsh
# Double-click me in Finder to start the Hug Rating Machine backend with the
# webcam. The first run makes macOS ask "Terminal would like to access the
# camera" — click Allow. (If you ever denied it: System Settings →
# Privacy & Security → Camera → enable Terminal.)
cd "$(dirname "$0")/backend"
if [ ! -d .venv ]; then
  echo "Setting up Python environment (first run only)…"
  /usr/local/bin/python3.12 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
echo "Starting backend on ws://localhost:8765 — Ctrl+C to stop."
exec .venv/bin/python main.py "$@"
