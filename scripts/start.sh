#!/bin/bash
set -euo pipefail
if command -v node >/dev/null 2>&1; then
  exec node "$(dirname "$0")/start.mjs"
fi
exec /opt/homebrew/bin/node "$(dirname "$0")/start.mjs"
