#!/bin/bash
# MCOP Termux SMS Bridge
# Run this script on your burner phone in Termux
# Requires: termux-api package (pkg install termux-api)
#
# Usage: bash mcop-termux-sms.sh
# Stop with Ctrl+C
#
# PRIMARY / BACKUP PHONES
# -----------------------
# You can run this script on TWO phones for automatic failover:
#   - On the main phone leave DEVICE_ROLE="primary" (or leave the old script
#     as-is — a script with no role is treated as the primary).
#   - On the spare phone set DEVICE_ROLE="backup".
# The MCOP server decides which phone is ACTIVE. The standby phone keeps
# polling (that's its heartbeat) but receives no messages, so the two phones
# can never send the same SMS twice. If the primary stops checking in or its
# sends start failing, the server automatically hands the queue to the backup,
# and hands it back once the primary has been healthy again for a few minutes.

MCOP_URL="https://mcop2.replit.app"
API_KEY="YOUR_MCOP_API_KEY_HERE"
DEVICE_ROLE="primary"   # "primary" or "backup"
POLL_INTERVAL=5
SEND_DELAY=2
SEEN_FILE="$HOME/.mcop_seen_sms"

# Track standby state so we only print the standby notice when it changes.
LAST_STANDBY=""

echo "=== MCOP Termux SMS Bridge ==="
echo "Server: $MCOP_URL"
echo "Role:   $DEVICE_ROLE"
echo "Polling every ${POLL_INTERVAL}s"
echo "Press Ctrl+C to stop"
echo ""

check_deps() {
  if ! command -v termux-sms-send &> /dev/null; then
    echo "ERROR: termux-api not installed. Run: pkg install termux-api"
    exit 1
  fi
  if ! command -v termux-sms-list &> /dev/null; then
    echo "ERROR: termux-api not installed. Run: pkg install termux-api"
    exit 1
  fi
  if ! command -v curl &> /dev/null; then
    echo "ERROR: curl not installed. Run: pkg install curl"
    exit 1
  fi
  if ! command -v jq &> /dev/null; then
    echo "ERROR: jq not installed. Run: pkg install jq"
    exit 1
  fi
}

send_pending() {
  local response
  response=$(curl -s -f -H "X-API-Key: $API_KEY" "$MCOP_URL/api/sms-queue/pending?device=$DEVICE_ROLE" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$response" ]; then
    return
  fi

  # Standby: this phone is not the active sender right now. Keep polling —
  # each poll is our heartbeat — but send nothing.
  local standby
  standby=$(echo "$response" | jq -r '.standby // false' 2>/dev/null)
  if [ "$standby" = "true" ]; then
    if [ "$LAST_STANDBY" != "true" ]; then
      local active
      active=$(echo "$response" | jq -r '.activeDevice // "unknown"' 2>/dev/null)
      echo "[$(date +%H:%M:%S)] STANDBY — active device is '$active'. Waiting..."
    fi
    LAST_STANDBY="true"
    return
  fi
  if [ "$LAST_STANDBY" = "true" ]; then
    echo "[$(date +%H:%M:%S)] ACTIVE — this phone is now sending."
  fi
  LAST_STANDBY="false"

  local count
  count=$(echo "$response" | jq '.messages | length' 2>/dev/null)
  if [ "$count" = "0" ] || [ -z "$count" ]; then
    return
  fi

  echo "[$(date +%H:%M:%S)] $count message(s) to send"

  echo "$response" | jq -c '.messages[]' | while read -r msg; do
    local msg_id to_number body
    msg_id=$(echo "$msg" | jq -r '.id')
    to_number=$(echo "$msg" | jq -r '.toNumber')
    body=$(echo "$msg" | jq -r '.body')

    echo "  Sending to $to_number (${#body} chars)..."
    termux-sms-send -n "$to_number" "$body" 2>/dev/null

    if [ $? -eq 0 ]; then
      curl -s -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
        "$MCOP_URL/api/sms-queue/confirm" \
        -d "{\"id\":\"$msg_id\",\"success\":true,\"device\":\"$DEVICE_ROLE\"}" > /dev/null 2>&1
      echo "  Sent OK: $msg_id"
    else
      curl -s -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
        "$MCOP_URL/api/sms-queue/confirm" \
        -d "{\"id\":\"$msg_id\",\"success\":false,\"error\":\"termux-sms-send failed\",\"device\":\"$DEVICE_ROLE\"}" > /dev/null 2>&1
      echo "  FAILED: $msg_id"
    fi

    sleep $SEND_DELAY
  done
}

is_spam() {
  local from_number="$1"
  local body="$2"

  local clean_num=$(echo "$from_number" | sed 's/[^0-9]//g')
  local clean_len=${#clean_num}
  if [ "$clean_len" -lt 10 ] || [ "$clean_len" -gt 12 ]; then
    return 0
  fi

  local lower_body=$(echo "$body" | tr '[:upper:]' '[:lower:]')
  case "$lower_body" in
    *"voicemail pin"*|*"free message"*|*"free msg"*|*"carrier"*|*"account has been"*|*"data usage"*)
      return 0
      ;;
  esac

  return 1
}

check_inbound() {
  local sms_list
  sms_list=$(termux-sms-list -l 10 -t inbox 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$sms_list" ] || [ "$sms_list" = "[]" ]; then
    return
  fi

  touch "$SEEN_FILE"

  echo "$sms_list" | jq -c '.[]' | while read -r sms; do
    local sms_id from_number body received
    sms_id=$(echo "$sms" | jq -r '._id // .threadid // empty')
    from_number=$(echo "$sms" | jq -r '.number // .address // empty')
    body=$(echo "$sms" | jq -r '.body // empty')
    received=$(echo "$sms" | jq -r '.received // empty')

    if [ -z "$sms_id" ] || [ -z "$from_number" ] || [ -z "$body" ]; then
      continue
    fi

    local unique_key="${sms_id}_${received}"

    if grep -qF "$unique_key" "$SEEN_FILE" 2>/dev/null; then
      continue
    fi

    echo "$unique_key" >> "$SEEN_FILE"

    if is_spam "$from_number" "$body"; then
      continue
    fi

    echo "[$(date +%H:%M:%S)] Inbound from $from_number: ${body:0:60}..."

    local escaped_body
    escaped_body=$(echo "$body" | jq -Rs '.')

    local result
    result=$(curl -s -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
      "$MCOP_URL/api/sms-queue/inbound" \
      -d "{\"from\":\"$from_number\",\"body\":$escaped_body,\"device\":\"$DEVICE_ROLE\"}" 2>/dev/null)

    if echo "$result" | jq -e '.ok' > /dev/null 2>&1; then
      if echo "$result" | jq -e '.duplicate' > /dev/null 2>&1; then
        echo "  Already handled by the other phone (duplicate)"
      else
        echo "  Forwarded to MCOP Bot"
      fi
    else
      echo "  Forward failed: $result"
    fi
  done

  local line_count=$(wc -l < "$SEEN_FILE" 2>/dev/null || echo 0)
  if [ "$line_count" -gt 200 ]; then
    tail -100 "$SEEN_FILE" > "${SEEN_FILE}.tmp" && mv "${SEEN_FILE}.tmp" "$SEEN_FILE"
  fi
}

init_seen() {
  touch "$SEEN_FILE"
  local sms_list
  sms_list=$(termux-sms-list -l 10 -t inbox 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$sms_list" ] && [ "$sms_list" != "[]" ]; then
    local count=$(echo "$sms_list" | jq 'length' 2>/dev/null)
    echo "$sms_list" | jq -c '.[]' | while read -r sms; do
      local sms_id received
      sms_id=$(echo "$sms" | jq -r '._id // .threadid // empty')
      received=$(echo "$sms" | jq -r '.received // empty')
      if [ -n "$sms_id" ]; then
        local unique_key="${sms_id}_${received}"
        if ! grep -qF "$unique_key" "$SEEN_FILE" 2>/dev/null; then
          echo "$unique_key" >> "$SEEN_FILE"
        fi
      fi
    done
    echo "Marked $count existing messages as seen"
  fi
}

check_deps
init_seen
echo "Bridge is running..."
echo ""

while true; do
  send_pending
  check_inbound
  sleep $POLL_INTERVAL
done
