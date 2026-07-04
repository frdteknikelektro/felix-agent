#!/bin/sh
set -e

# ── User identity fix ──────────────────────────────────────────────────────
# Detect the UID/GID from the mounted workspace owner and drop privileges
# via gosu. Git identity is set via env vars in the Dockerfile.

WORKSPACE="/home/node"

if [ "$(id -u)" = "0" ]; then
  # Detect owner of the workspace directory (the bind mount)
  if [ -d "$WORKSPACE" ]; then
    WORKSPACE_UID=$(stat -c '%u' "$WORKSPACE" 2>/dev/null || echo 1000)
    WORKSPACE_GID=$(stat -c '%g' "$WORKSPACE" 2>/dev/null || echo 1000)
  else
    mkdir -p "$WORKSPACE"
    WORKSPACE_UID=1000
    WORKSPACE_GID=1000
  fi

  # Drop privileges and run the actual command
  HOME=/home/node exec gosu "$WORKSPACE_UID:$WORKSPACE_GID" "$@"
fi

# Already running as non-root — just exec the command
exec "$@"
