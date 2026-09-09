#!/usr/bin/env bash
# deploy.sh -- installs/updates the Synapse Grid ALWAYS-ON PARTNER on this Ubuntu 22.04 box.
# docs/steam/REVIEW_2_FIX_PLAN_2026-09-09.md §4a / row 5b.
#
# IDEMPOTENT: safe to re-run for every new build. It only overwrites the install dir, steam_appid.txt, and
# the systemd unit; it never touches /etc/synapse-partner.env or the steamcmd credential cache once created.
#
# Usage (as root, or with sudo):
#   BUILD_SRC="E:/Synapse Grid/build/linux_steam"        # not used remotely -- see step 0 below
#   ./deploy.sh <path-to-linux_steam-build-dir> <app-id> <steam-username>
#
# Example:
#   ./deploy.sh /home/deploy/uploads/linux_steam 3XXXXXX synapsegrid_partner
set -euo pipefail

BUILD_SRC="${1:?usage: deploy.sh <linux_steam build dir> <app_id> <steam_username>}"
APP_ID="${2:?usage: deploy.sh <linux_steam build dir> <app_id> <steam_username>}"
STEAM_USER="${3:?usage: deploy.sh <linux_steam build dir> <app_id> <steam_username>}"

INSTALL_DIR="/opt/synapse-grid-partner"
SERVICE_NAME="synapse-partner"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="/etc/synapse-partner.env"

echo "== 0. sanity =="
if [ ! -d "$BUILD_SRC" ]; then
	echo "ERROR: build dir not found: $BUILD_SRC" >&2
	echo "Copy build/linux_steam from the Windows machine first, e.g.:" >&2
	echo "  scp -r \"build/linux_steam\" deploy@server:/home/deploy/uploads/linux_steam" >&2
	exit 1
fi

echo "== 1. packages (idempotent: apt is a no-op if already installed) =="
apt-get update -y
apt-get install -y xvfb curl ca-certificates lib32gcc-s1 lib32stdc++6 unzip

echo "== 2. install/update the game binary =="
mkdir -p "$INSTALL_DIR"
rsync -a --delete "$BUILD_SRC"/ "$INSTALL_DIR"/
echo "$APP_ID" > "$INSTALL_DIR/steam_appid.txt"
chmod +x "$INSTALL_DIR"/*.x86_64 2>/dev/null || true

echo "== 3. steamcmd (idempotent: installs once, login caches the session once) =="
if [ ! -x /usr/games/steamcmd ] && [ ! -x /usr/bin/steamcmd ]; then
	add-apt-repository -y multiverse || true
	dpkg --add-architecture i386
	apt-get update -y
	echo steam steam/question select "I AGREE" | debconf-set-selections
	echo steam steam/license note '' | debconf-set-selections
	DEBIAN_FRONTEND=noninteractive apt-get install -y steamcmd
fi
STEAMCMD_BIN="$(command -v steamcmd || echo /usr/games/steamcmd)"

if [ ! -f "$ENV_FILE" ]; then
	echo "WARNING: $ENV_FILE does not exist yet -- see README.md 'THE ONE THING ONLY THE OWNER CAN DO'." >&2
	echo "Skipping steamcmd login and Steam-client install until it is created." >&2
else
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	if [ -z "${STEAM_PARTNER_PASSWORD:-}" ]; then
		echo "WARNING: STEAM_PARTNER_PASSWORD not set in $ENV_FILE -- skipping steamcmd login." >&2
	else
		echo "== 3b. one-time steamcmd login (caches Steam Guard session on disk) =="
		"$STEAMCMD_BIN" +login "$STEAM_USER" "$STEAM_PARTNER_PASSWORD" +quit || {
			echo "steamcmd login needs a Steam Guard code the FIRST time -- re-run this script interactively" >&2
			echo "as the service user once: steamcmd +login $STEAM_USER, enter the code when prompted." >&2
		}
	fi
fi

echo "== 4. Steam client under this account, headless (needed for GodotSteam -- it talks to a running" \
     "Steam client, not just steamcmd) =="
if [ ! -d /home/steam/.steam ] && [ ! -d "$HOME/.steam" ]; then
	apt-get install -y steam-launcher || apt-get install -y steam || true
fi

echo "== 5. systemd unit =="
install -m 0644 "$(dirname "$0")/synapse-partner.service" "$SERVICE_FILE"
sed -i "s#__INSTALL_DIR__#${INSTALL_DIR}#g; s#__STEAM_USER__#${STEAM_USER}#g" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME" || systemctl start "$SERVICE_NAME"

echo "== 6. relay keepalive cron =="
CRON_LINE="*/5 * * * * $(dirname "$(readlink -f "$0")")/relay_keepalive.sh >> /var/log/synapse-partner-relay.log 2>&1"
( crontab -l 2>/dev/null | grep -v relay_keepalive.sh ; echo "$CRON_LINE" ) | crontab -

echo "== done =="
echo "Check status with: systemctl status $SERVICE_NAME"
echo "Tail logs with:    journalctl -u $SERVICE_NAME -f"
