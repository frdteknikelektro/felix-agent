#!/bin/sh
set -e

# ── User identity fix ──────────────────────────────────────────────────────
# When the container runs with --user $(id -u):$(id -g), the UID may not
# exist in /etc/passwd. Tools like SSH and git need a valid passwd entry
# to resolve the current user. This script runs as root, adds the entry
# if missing, then drops privileges via gosu.
TARGET_UID="${UID:-1000}"
TARGET_GID="${GID:-1000}"
TARGET_USER="${USER_NAME:-node}"

if [ "$(id -u)" = "0" ]; then
  # Check if the target UID already has a passwd entry
  if ! getent passwd "$TARGET_UID" > /dev/null 2>&1; then
    # Create a group with the target GID if it doesn't exist
    if ! getent group "$TARGET_GID" > /dev/null 2>&1; then
      groupadd -g "$TARGET_GID" "$TARGET_USER"
    fi
    # Create the user with the target UID/GID
    useradd -u "$TARGET_UID" -g "$TARGET_GID" -d /home/node -s /bin/sh \
      -M -N "$TARGET_USER" 2>/dev/null || \
    echo "${TARGET_USER}:x:${TARGET_UID}:${TARGET_GID}::/home/node:/bin/sh" >> /etc/passwd
    echo "entrypoint: created user ${TARGET_USER} (uid=${TARGET_UID}, gid=${TARGET_GID})"
  fi

  # Drop privileges and run the actual command
  exec gosu "$TARGET_UID:$TARGET_GID" "$@"
fi

# Already running as non-root — just exec the command
exec "$@"
