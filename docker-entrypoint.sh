#!/bin/sh
set -e

# ── User identity fix ──────────────────────────────────────────────────────
# Detect the UID/GID from the mounted workspace owner, then create a
# matching /etc/passwd entry if needed and drop privileges via gosu.
# No env vars required — it just works.

WORKSPACE="/home/node"

if [ "$(id -u)" = "0" ]; then
  # Restore /etc from backup if it's empty (read_only container with tmpfs /etc)
  if [ ! -f /etc/passwd ]; then
    cp -a /tmp/etc-init/* /etc/ 2>/dev/null || true
  fi

  # Detect owner of the workspace directory (the bind mount)
  if [ -d "$WORKSPACE" ]; then
    WORKSPACE_UID=$(stat -c '%u' "$WORKSPACE" 2>/dev/null || echo 1000)
    WORKSPACE_GID=$(stat -c '%g' "$WORKSPACE" 2>/dev/null || echo 1000)
  else
    # Workspace doesn't exist yet (e.g. setup stage) — use node defaults
    mkdir -p "$WORKSPACE"
    WORKSPACE_UID=1000
    WORKSPACE_GID=1000
  fi

  # Check if the target UID already has a passwd entry
  if ! getent passwd "$WORKSPACE_UID" > /dev/null 2>&1; then
    # Create a group with the target GID if it doesn't exist
    if ! getent group "$WORKSPACE_GID" > /dev/null 2>&1; then
      groupadd -g "$WORKSPACE_GID" felix 2>/dev/null || true
    fi
    # Create the user with the target UID/GID
    useradd -u "$WORKSPACE_UID" -g "$WORKSPACE_GID" -d "$WORKSPACE" -s /bin/sh \
      -M -N felix 2>/dev/null || \
    echo "felix:x:${WORKSPACE_UID}:${WORKSPACE_GID}::${WORKSPACE}:/bin/sh" >> /etc/passwd
    echo "entrypoint: created user felix (uid=${WORKSPACE_UID}, gid=${WORKSPACE_GID})"
  fi

  # Drop privileges and run the actual command
  exec gosu "$WORKSPACE_UID:$WORKSPACE_GID" "$@"
fi

# Already running as non-root — just exec the command
exec "$@"
