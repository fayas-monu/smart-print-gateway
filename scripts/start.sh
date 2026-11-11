#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install the LTS build from https://nodejs.org first."
  exit 1
fi
echo "Starting Smart Print Gateway..."
echo "Customer portal:  http://localhost:4173"
echo "Operator console: http://localhost:4173/dashboard"
node server.js "$@"
