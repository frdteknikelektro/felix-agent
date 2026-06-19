#!/usr/bin/env bash
set -euo pipefail

echo "=== Felix Agent Setup ==="
echo ""

# 1. Check Docker
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker is not installed. Install it first: https://docs.docker.com/get-docker/"
  exit 1
fi
echo "[ok] Docker found: $(docker --version)"

# 2. Handle .env — migrate legacy path first, then create from template
MIGRATED=false
if [ ! -f .env ] && [ -f config/.env ]; then
  mv config/.env .env
  MIGRATED=true
  echo "[ok] Migrated config/.env → .env"
  rmdir config 2>/dev/null || true
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "[ok] Created .env from .env.example"
  else
    echo "WARN: .env.example not found. Create .env manually."
  fi
else
  if [ "$MIGRATED" = true ]; then
    echo "[ok] .env ready (migrated from legacy path)"
  else
    echo "[ok] .env already exists"
  fi
fi

# 3. Create workspace directory
if [ ! -d workspace ]; then
  mkdir -p workspace
  echo "[ok] Created workspace/ directory"
else
  echo "[ok] workspace/ already exists"
fi

# 4. Quick validation of critical vars
MISSING=""
if [ -f .env ]; then
  if ! grep -q '^OWNER_UI_SECRET=' .env 2>/dev/null; then
    MISSING="$MISSING  OWNER_UI_SECRET (not set)"
  elif grep -q '^OWNER_UI_SECRET=change-me' .env 2>/dev/null; then
    MISSING="$MISSING  OWNER_UI_SECRET (still 'change-me')"
  fi
  if ! grep -q '^OPENAI_API_KEY=' .env 2>/dev/null; then
    MISSING="$MISSING  OPENAI_API_KEY (not set)"
  elif grep -q '^OPENAI_API_KEY=$' .env 2>/dev/null; then
    MISSING="$MISSING  OPENAI_API_KEY (empty)"
  fi
fi

if [ -n "$MISSING" ]; then
  echo ""
  echo "WARN: Some vars may need attention in .env:"
  echo "$MISSING"
else
  echo "[ok] Required env vars look configured"
fi

echo ""
echo "=== Ready ==="
echo ""
echo "Start the agent:"
echo "  UID=\$(id -u) GID=\$(id -g) docker compose up -d"
echo ""
echo "Check status:"
echo "  docker compose ps"
echo "  curl http://localhost:53318/healthz"
echo ""
echo "View logs:"
echo "  docker compose logs -f"
