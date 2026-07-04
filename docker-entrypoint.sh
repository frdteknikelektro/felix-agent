#!/bin/sh
set -e

# ── User identity fix ──────────────────────────────────────────────────────
# Detect the UID/GID from the mounted workspace owner, create a passwd
# entry in /tmp, and use nss_wrapper so getpwuid() resolves it.
# /etc stays read-only.

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

  # Build a writable passwd file in /tmp
  cp /etc/passwd /tmp/passwd
  if ! getent -P passwd "$WORKSPACE_UID" > /dev/null 2>&1; then
    echo "felix:x:${WORKSPACE_UID}:${WORKSPACE_GID}::${WORKSPACE}:/bin/sh" >> /tmp/passwd
    echo "entrypoint: created user felix (uid=${WORKSPACE_UID}, gid=${WORKSPACE_GID})"
  fi

  # Point glibc at the writable copy (nss_wrapper)
  export NSS_WRAPPER_PASSWD=/tmp/passwd
  export NSS_WRAPPER_GROUP=/etc/group
  export LD_PRELOAD=/usr/lib/libnss_wrapper.so

  # Drop privileges and run the actual command
  exec gosu "$WORKSPACE_UID:$WORKSPACE_GID" "$@"
fi

# Already running as non-root — just exec the command
exec "$@"
