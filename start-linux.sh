#!/usr/bin/env sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required."; exit 1; }
( sleep 1; xdg-open http://localhost:3000 >/dev/null 2>&1 || true ) &
node server.js
