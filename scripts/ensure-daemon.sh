#!/bin/bash
# SessionStart hook: ensure the attention-router daemon is running.
# Idempotent — does nothing if already up. Backgrounds otherwise.

PORT="${AR_PORT:-7777}"
HOST="${AR_HOST:-127.0.0.1}"

# Already responsive? exit silently.
if curl -sS -o /dev/null --max-time 1 "http://${HOST}:${PORT}/healthz" 2>/dev/null; then
  exit 0
fi

# Pick API key — prefer THE_ANTHROPIC_API_KEY (Claude Code stomps on ANTHROPIC_API_KEY).
KEY="${THE_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}"
if [ -z "$KEY" ] || [ "$KEY" = "dummy" ]; then
  echo "[attention-router] WARN: no real API key in env (THE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY); council will use MockProvider" >&2
fi

CLI_PATH="${CLAUDE_PLUGIN_ROOT}/src/cli.ts"
DATA_DIR="${AR_DATA_DIR:-${HOME}/.attention-router/data}"
LOG="${AR_LOG:-${HOME}/.attention-router/daemon.log}"
mkdir -p "$(dirname "$LOG")" "$DATA_DIR"

# Background launch — use nohup + setsid to fully detach so the daemon survives this shell.
ANTHROPIC_API_KEY="$KEY" \
AR_DATA_DIR="$DATA_DIR" \
AR_PORT="$PORT" \
AR_HOST="$HOST" \
nohup npx -y tsx "$CLI_PATH" start-server >>"$LOG" 2>&1 &
disown 2>/dev/null || true

# Give it ~1s to come up; don't block the session if it doesn't.
for i in 1 2 3 4 5; do
  if curl -sS -o /dev/null --max-time 1 "http://${HOST}:${PORT}/healthz" 2>/dev/null; then
    echo "[attention-router] daemon up at http://${HOST}:${PORT}" >&2
    exit 0
  fi
  sleep 0.3
done

echo "[attention-router] daemon launched but not yet responsive; check $LOG" >&2
exit 0
