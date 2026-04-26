#!/bin/bash
# Stop hook (asyncRewake): waits in the background for pending attention-router
# asks to be resolved by the human, then exits 2 to wake the agent with the
# decision payload as a system-reminder.
#
# Idempotent: if there are no pending asks at Stop time, exits 0 immediately.
# Bounded: stops waiting after AR_HOOK_MAX_WAIT_SEC (default 24h).

set -u
PORT="${AR_PORT:-7777}"
HOST="${AR_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"
INTERVAL=$(( ${AR_HOOK_POLL_INTERVAL_SEC:-5} ))
MAX_WAIT=$(( ${AR_HOOK_MAX_WAIT_SEC:-86400} ))

# Discard the hook stdin payload — we don't need it.
cat > /dev/null 2>/dev/null || true

# Snapshot the IDs that were pending at Stop time. We only wait on these,
# not on whatever new asks the human or other agents might create later.
INITIAL=$(curl -sS --max-time 3 "${BASE}/next?max=99" 2>/dev/null \
  | jq -r '.batch[]?.ask.id' 2>/dev/null \
  | sort -u)
[ -z "$INITIAL" ] && exit 0   # nothing to wait for → don't wake

TRACKED="$INITIAL"
DEADLINE=$(( $(date +%s) + MAX_WAIT ))

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep "$INTERVAL"

  RESOLVED=""
  STILL_PENDING=""
  for ID in $TRACKED; do
    REC=$(curl -sS --max-time 3 "${BASE}/asks/${ID}" 2>/dev/null | jq -c '.record' 2>/dev/null)
    if [ -z "$REC" ] || [ "$REC" = "null" ]; then
      STILL_PENDING="$STILL_PENDING $ID"
      continue
    fi

    STATUS=$(echo "$REC" | jq -r '.status // ""')
    TITLE=$(echo "$REC" | jq -r '.ask.title // ""')
    case "$STATUS" in
      decided)
        CHOICE=$(echo "$REC" | jq -r '.decision.choice // ""')
        if [ "$CHOICE" = "override" ]; then
          OVERRIDE=$(echo "$REC" | jq -r '.decision.override_text // ""')
          RESOLVED+="- ${ID}: \"${TITLE}\" → override: ${OVERRIDE}"$'\n'
        else
          LABEL=$(echo "$REC" | jq -r ".ask.options[] | select(.id == \"$CHOICE\") | .label" 2>/dev/null)
          NEXT=$(echo "$REC" | jq -r ".ask.options[] | select(.id == \"$CHOICE\") | .predicted_next_step" 2>/dev/null)
          RESOLVED+="- ${ID}: \"${TITLE}\" → ${CHOICE} (${LABEL})"$'\n'
          [ -n "$NEXT" ] && RESOLVED+="    next: ${NEXT}"$'\n'
        fi
        ;;
      auto_resolved)
        DEFAULT=$(echo "$REC" | jq -r '.safe_default_option_id // ""')
        RESOLVED+="- ${ID}: \"${TITLE}\" → auto-resolved to ${DEFAULT}"$'\n'
        ;;
      expired)
        RESOLVED+="- ${ID}: \"${TITLE}\" → expired (proceed with agent default)"$'\n'
        ;;
      skipped)
        RESOLVED+="- ${ID}: \"${TITLE}\" → human skipped (snoozed)"$'\n'
        ;;
      pending|stale)
        STILL_PENDING="$STILL_PENDING $ID"
        ;;
      *)
        STILL_PENDING="$STILL_PENDING $ID"
        ;;
    esac
  done

  if [ -n "$RESOLVED" ]; then
    # Wake the model. Stdout is appended to the system-reminder by Claude Code.
    printf "%s\n" "Resolutions while you were idle:"
    printf "%s" "$RESOLVED"
    if [ -n "$STILL_PENDING" ]; then
      printf "Still pending (call wait_for_decision or proceed without):%s\n" "$STILL_PENDING"
    fi
    exit 2
  fi

  # Strip trailing/leading spaces and update tracked set
  TRACKED=$(echo "$STILL_PENDING" | xargs)
  [ -z "$TRACKED" ] && exit 0  # all gone, nothing to wake about (race: resolved & cleaned simultaneously)
done

# Hit max wait — exit normally without waking.
exit 0
