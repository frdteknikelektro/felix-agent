#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: smoke-candidate-image.sh <image@sha256:digest> <amd64|arm64> <report.json>" >&2
  exit 2
fi

candidate="$1"
architecture="$2"
report="$3"
case "$architecture" in
  amd64|arm64) ;;
  *) echo "unsupported architecture: $architecture" >&2; exit 2 ;;
esac
if [[ ! "$candidate" =~ ^[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$ ]]; then
  echo "candidate must be an immutable image digest" >&2
  exit 2
fi

root="$(mktemp -d)"
container="felix-smoke-${architecture}-${GITHUB_RUN_ID:-local}-$$"
workspace="${root}/workspace"
env_file="${root}/felix.env"
base="http://127.0.0.1:53318"
owner_secret="felix-release-smoke-owner-secret"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT

mkdir -p "$workspace" "$(dirname "$report")"
chmod 0700 "$root"
cat > "$env_file" <<EOF
FELIX_NAME=Felix
OWNER_UI_SECRET=${owner_secret}
HARNESS=codex
EOF
chmod 0600 "$env_file"

wait_for_health() {
  for _ in $(seq 1 90); do
    if curl --fail --silent --show-error "${base}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != true ]; then
      docker logs "$container" >&2 || true
      return 1
    fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  echo "candidate did not become healthy" >&2
  return 1
}

wait_for_log_event() {
  event="$1"
  for _ in $(seq 1 30); do
    if docker logs "$container" 2>&1 | grep -F "\"event\":\"${event}\"" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  echo "missing runtime log event: ${event}" >&2
  return 1
}

docker run --detach \
  --name "$container" \
  --platform "linux/${architecture}" \
  --restart on-failure:2 \
  --user "$(id -u):$(id -g)" \
  --read-only \
  --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid \
  --publish 127.0.0.1:53318:3000 \
  --mount "type=bind,src=${workspace},dst=/home/node" \
  --mount "type=bind,src=${env_file},dst=/run/secrets/.env,readonly" \
  "$candidate" >/dev/null

wait_for_health
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "${base}/api/sessions")" = 401
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "${base}/events/dashboard")" = 401

headers="${root}/login.headers"
test "$(curl --silent --show-error --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "secret=${owner_secret}" \
  "${base}/api/login")" = 303
cookie="$(sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' "$headers" | tr -d '\r' | head -1)"
test -n "$cookie"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "cookie: ${cookie}" "${base}/api/sessions")" = 200

for source in mattermost discord slack whatsapp telegram; do
  wait_for_log_event "${source}.disabled"
done

if docker exec "$container" sh -c "touch /app/release-smoke-rootfs" >/dev/null 2>&1; then
  echo "read-only root filesystem accepted a write" >&2
  exit 1
fi
docker exec "$container" sh -c "printf persisted > /home/node/release-smoke-marker"

docker restart --time 20 "$container" >/dev/null
wait_for_health
test "$(docker exec "$container" cat /home/node/release-smoke-marker)" = persisted

# Docker applies restart policies only after the container has remained up long
# enough to be considered successfully started.
sleep 11
restart_count="$(docker inspect --format '{{.RestartCount}}' "$container")"
set +e
docker exec "$container" sh -c '
  set -- $(cat /proc/1/task/1/children)
  test "$#" -ge 1
  kill -9 "$1"
' >/dev/null 2>&1
set -e
for _ in $(seq 1 60); do
  current="$(docker inspect --format '{{.RestartCount}}' "$container" 2>/dev/null || echo 0)"
  if [ "$current" -gt "$restart_count" ] && wait_for_health; then
    break
  fi
  sleep 1
done
test "$(docker inspect --format '{{.RestartCount}}' "$container")" -gt "$restart_count"
test "$(docker exec "$container" cat /home/node/release-smoke-marker)" = persisted

docker stop --time 20 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0
docker logs "$container" 2>&1 | grep -F '"event":"felix.shutdown"' >/dev/null

REPORT_PATH="$report" CANDIDATE="$candidate" PLATFORM="linux/${architecture}" \
  node --input-type=module <<'NODE'
import { writeFileAtomic } from "./scripts/setup-support.mjs";

const checks = [
  "health",
  "login",
  "unauthenticated_api",
  "unauthenticated_sse",
  "disabled_sources",
  "read_only_rootfs",
  "restart_persistence",
  "graceful_shutdown",
  "crash_restart",
].map((name) => ({ name, passed: true }));
const report = {
  schemaVersion: 1,
  image: process.env.CANDIDATE,
  platform: process.env.PLATFORM,
  checks,
};
writeFileAtomic(process.env.REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 0o600);
NODE
