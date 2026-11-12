#!/bin/sh
# AL SHAJAR STATIONERY - Smart Print Gateway (Linux / macOS)
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$DIR/server.js" "$@"
