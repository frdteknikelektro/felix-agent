#!/usr/bin/env bash
#
# Subagent dispatcher for the art-of-melancomedy persona.
#
# Spawns a one-shot high-reasoning subagent session to generate a single
# persona reply. Supports both codex and opencode harnesses — detected via
# the HARNESS env var (fallback: auto-detect from available binaries).
#
# Usage (from inside the main agent session shell):
#
#   /home/agent/workspace/skills/art-of-melancomedy/scripts/delegate.sh \
#     'Lix lix, stres nih, bikinin joke tentang kopi dong'
#
#   /home/agent/workspace/skills/art-of-melancomedy/scripts/delegate.sh \
#     '<user message>' \
#     '<optional recent-thread context blob>'
#
# Single-quoted args sidestep the heredoc-on-closed-stdin problem. If the
# user message contains a single quote, escape it: '\''
#
# Stdout: the subagent's reply text (use verbatim).
# Stderr: diagnostic on failure.
# Exit codes:
#   0   subagent produced a non-empty last message
#   1   subagent failed or returned empty (see log path on stderr)

set -euo pipefail

USER_MSG="${1:-}"
THREAD_CONTEXT="${2:-}"

if [[ -z "$USER_MSG" ]]; then
  echo "delegate.sh: missing user message argument (\$1)" >&2
  exit 1
fi

# ── Harness detection ──────────────────────────────────────────────────────

detect_harness() {
  # Explicit HARNESS env var takes priority.
  if [[ "${HARNESS:-}" == "opencode" ]]; then echo "opencode"; return; fi
  if [[ "${HARNESS:-}" == "codex" ]]; then echo "codex"; return; fi
  # Fallback: check which binary is available.
  if command -v opencode &>/dev/null && ! command -v codex &>/dev/null; then
    echo "opencode"; return
  fi
  echo "codex"
}

HARNESS_TYPE="$(detect_harness)"

# ── Auth env vars ──────────────────────────────────────────────────────────

# Codex auth
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-}"
export OPENAI_ORGANIZATION="${OPENAI_ORGANIZATION:-}"
export OPENAI_PROJECT="${OPENAI_PROJECT:-}"

# Opencode auth
export OPENCODE_API_KEY="${OPENCODE_API_KEY:-}"
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"

# ── Per-harness binary & model config ───────────────────────────────────────

WORKSPACE="${WORKSPACE_DIR:-/home/agent/workspace}"
TIMEOUT_SECONDS="${MELANCOMEDY_TIMEOUT_SECONDS:-120}"

if [[ "$HARNESS_TYPE" == "opencode" ]]; then
  OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
  MODEL="${MELANCOMEDY_OPENCODE_MODEL:-deepseek/deepseek-v4-pro}"
  REASONING=""  # opencode has no separate reasoning-effort flag
  OC_VARIANT="${MELANCOMEDY_OPENCODE_VARIANT:-}"
  LOG_DIR="${MELANCOMEDY_LOG_DIR:-${WORKSPACE}/opencode/melancomedy}"
else
  # Ensure codex binary resolves even if PATH lacks node_modules/.bin.
  CODEX_NPM_BIN="/app/node_modules/.bin"
  if [[ -x "$CODEX_NPM_BIN/codex" && ":$PATH:" != *":$CODEX_NPM_BIN:"* ]]; then
    export PATH="$CODEX_NPM_BIN:$PATH"
  fi
  MODEL="${MELANCOMEDY_MODEL:-gpt-5.5}"
  REASONING="${MELANCOMEDY_REASONING:-medium}"
  LOG_DIR="${MELANCOMEDY_LOG_DIR:-${WORKSPACE}/codex/melancomedy}"
fi

mkdir -p "$LOG_DIR"

TS="$(date -u +%Y%m%dT%H%M%S%3N)"
LAST_MSG_FILE="$LOG_DIR/${TS}.last.txt"
LOG_FILE="$LOG_DIR/${TS}.log"
PROMPT_DUMP="$LOG_DIR/${TS}.prompt.txt"

SKILL_DIR="${WORKSPACE}/skills/art-of-melancomedy"

# ── Build focused prompt (shared by both harnesses) ────────────────────────

PROMPT=$(cat <<PROMPT_EOF
You are running as a single-shot subagent for the "art-of-melancomedy" persona inside Felix Agent. You will produce one final reply and exit.

Read these files in full before composing:
1. ${SKILL_DIR}/SKILL.md  — your operating manual. Patterns A/B/C, the self-review checklist, hook requirements, forbidden targets, language rules.
2. ${SKILL_DIR}/references/corpus.md — style reference. Read only if the inline examples in SKILL.md don't give a rhythm match for the user's scene. Never copy a line verbatim.

The user's latest message (verbatim, anchor your punchline to concrete nouns / verbs / scenes from it):

<<<USER_MESSAGE>>>
${USER_MSG}
<<<END_USER_MESSAGE>>>

${THREAD_CONTEXT:+Recent thread context (for continuity only — do not echo back, do not quote):

<<<THREAD_CONTEXT>>>
${THREAD_CONTEXT}
<<<END_THREAD_CONTEXT>>>
}
Hard requirements (also documented in SKILL.md — these are the ones that fail most often, double-check before you ship):
- Bahasa Indonesia gaul Jakarta. Never translate mantan / HTS / gosting / baper / friendzone / LDR / balikan / gebetan / gamon / bucin / slow respon / slip call.
- Anchor MUST come from the user's actual message above, not from corpus, not invented.
- Pick a real hook: rhyme, assonance, pun, unexpected reversal, or verb-echo. Flat literal opposites (rapi → berantakan, panas → dingin, baru → lama, manis → pahit) are NOT punchlines — reject and pick a different analogy.
- 1 punchline default, max 2 if multiple strong hooks. Tight, no sprawl.
- No straight-man interjections ("apaan tuh?", "apaan sih?", "wah", "anjir"), no stage directions, no emoji, no markdown headers, no bullet lists.
- Walk the self-review checklist in SKILL.md silently before emitting. If any box fails, rewrite.

Output: the reply text only. No preamble. No JSON. No "Here is your punchline:". No closing remarks. Just the punchline(s).
PROMPT_EOF
)

printf '%s' "$PROMPT" > "$PROMPT_DUMP"

# ── Dispatch subagent ──────────────────────────────────────────────────────

if [[ "$HARNESS_TYPE" == "opencode" ]]; then
  # === OpenCode path ========================================================
  #
  # opencode has no --output-last-message flag. We use a two-phase approach:
  #   1. opencode run --format json → capture stdout JSON stream → extract sessionID
  #   2. opencode export <sessionID> → parse last assistant message from JSON
  #

  OC_ARGS=(
    run
    --dir "${WORKSPACE}"
    --model "${MODEL}"
    --format json
    --dangerously-skip-permissions
  )
  if [[ -n "$OC_VARIANT" ]]; then
    OC_ARGS+=(--variant "$OC_VARIANT")
  fi
  OC_ARGS+=("$PROMPT")

  if ! timeout "$TIMEOUT_SECONDS" "$OPENCODE_BIN" "${OC_ARGS[@]}" \
        >"$LOG_FILE" 2>&1; then
    echo "delegate.sh: subagent opencode exited non-zero (model=$MODEL). Log: $LOG_FILE" >&2
    exit 1
  fi

  # Extract session ID from the first step_start event in the JSON stream.
  SESSION_ID=$(grep -m1 '"type":"step_start"' "$LOG_FILE" \
    | grep -o '"sessionID":"[^"]*"' \
    | cut -d'"' -f4)

  if [[ -z "$SESSION_ID" ]]; then
    echo "delegate.sh: no sessionID found in opencode output. Log: $LOG_FILE" >&2
    exit 1
  fi

  # Export the session and extract the last assistant message.
  if ! "$OPENCODE_BIN" export "$SESSION_ID" 2>>"$LOG_FILE" \
        | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])
for m in reversed(msgs):
    if m.get('info', {}).get('role') == 'assistant':
        parts = m.get('parts', [])
        text = ''.join(p.get('text', '') for p in parts if p.get('type') == 'text')
        if text:
            sys.stdout.write(text)
            sys.exit(0)
sys.exit(1)
" > "$LAST_MSG_FILE" 2>>"$LOG_FILE"; then
    echo "delegate.sh: failed to extract assistant message from opencode export. Log: $LOG_FILE" >&2
    exit 1
  fi

else
  # === Codex path ==========================================================
  #

  if ! timeout "$TIMEOUT_SECONDS" codex exec \
        --skip-git-repo-check \
        --dangerously-bypass-approvals-and-sandbox \
        --model "$MODEL" \
        -c model_reasoning_effort="$REASONING" \
        --output-last-message "$LAST_MSG_FILE" \
        "$PROMPT" \
        >"$LOG_FILE" 2>&1; then
    echo "delegate.sh: subagent codex exited non-zero (model=$MODEL reasoning=$REASONING). Log: $LOG_FILE" >&2
    exit 1
  fi

fi

# ── Validate and emit ──────────────────────────────────────────────────────

if [[ ! -s "$LAST_MSG_FILE" ]]; then
  echo "delegate.sh: subagent produced no last message. Log: $LOG_FILE" >&2
  exit 1
fi

cat "$LAST_MSG_FILE"
