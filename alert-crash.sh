#!/bin/bash
# Alert Penn via Telegram when flock-host-v2 enters failed state
# Called by systemd OnFailure handler

SERVICE="$1"
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
HOSTNAME=$(hostname)
PID=$$

# Load Telegram token from env file
if [ -f /etc/flock-host-v2/env ]; then
  export $(grep TELEGRAM_BOT_TOKEN /etc/flock-host-v2/env | xargs)
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "[alert-crash] TELEGRAM_BOT_TOKEN not set, cannot alert" >&2
  exit 1
fi

# Get recent error from journalctl
LAST_ERROR=$(journalctl -u flock-host-v2.service -n 5 --no-pager | tail -3)

# Build message
MESSAGE="🚨 **FLOCK-HOST CRASH ALERT**
Service: $SERVICE
Host: $HOSTNAME
Time: $TIMESTAMP

Recent error:
\`\`\`
$LAST_ERROR
\`\`\`

Status: Unit in failed state (check systemctl status flock-host-v2.service)"

# Send to Penn via Telegram
# Penn's chat ID is hardcoded (Calle 20 = 7111609127)
PENN_CHAT_ID="7111609127"

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${PENN_CHAT_ID}" \
  -d "text=${MESSAGE}" \
  -d "parse_mode=Markdown" > /dev/null 2>&1

echo "[alert-crash] Alert sent to Penn for service $SERVICE"
