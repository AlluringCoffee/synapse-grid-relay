#!/usr/bin/env bash
# relay_keepalive.sh -- curls the relay's health endpoint every 5 minutes (installed into crontab by
# deploy.sh) so the Render free/low tier WebSocket relay (wss://synapse-grid-relay.onrender.com) never
# fully cold-starts, which is the non-Steam fallback path the LAN/relay budget code (§3 of the fix plan)
# still has to cover.
set -euo pipefail

RELAY_HEALTH_URL="https://synapse-grid-relay.onrender.com/healthz"

STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$RELAY_HEALTH_URL" || echo "000")"
TS="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
if [ "$STATUS" = "200" ]; then
	echo "$TS relay_keepalive OK ($RELAY_HEALTH_URL -> 200)"
else
	echo "$TS relay_keepalive WARN ($RELAY_HEALTH_URL -> $STATUS)"
fi
