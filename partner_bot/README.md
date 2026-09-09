# Synapse Grid ALWAYS-ON PARTNER — server setup

docs/steam/REVIEW_2_FIX_PLAN_2026-09-09.md §4a / §3 row 5b. Ubuntu 22.04, run as root (or via sudo) unless
noted. Commands are exact — paste in order.

## THE ONE THING ONLY THE OWNER CAN DO

Everything below can be scripted or run by an agent. This one step cannot: it needs the owner's Steamworks
login.

1. Go to https://partner.steamgames.com/apps/manage_keys (or **Manage Keys** under your app's Steamworks
   page for Synapse Grid, app id from `steam/app_build.vdf`).
2. Generate a **developer key** (a free Steam key that grants ownership of the app to redeem on a second
   account — do NOT reuse the owner's own Steam account for this; the always-on bot needs to occupy its own
   lobby seat separate from any human tester).
3. Create (or reuse) a second, throwaway Steam account for the partner bot. Redeem the developer key on it
   via https://store.steampowered.com/account/registerkey so that account owns Synapse Grid.
4. On the server, create `/etc/synapse-partner.env` (root-only, **never committed — it is not in this
   repo and must never be**):

   ```
   STEAM_PARTNER_PASSWORD=the-second-accounts-password
   ```

   `chmod 600 /etc/synapse-partner.env` after writing it.
5. The first `steamcmd +login <user> <password>` on a NEW machine/account pair asks for a **Steam Guard
   code** by email — run `deploy.sh` once interactively (see step 3 below) and enter the code when
   prompted; after that the session is cached on disk and every later run is silent.

Nobody but the owner can do steps 1–3 (Steamworks org permissions) or step 5 (owns the 2FA email/phone).

## Commands, in order

### 1. Copy the Linux build to the server

From the Windows machine, after `BUILD_ALL_FOR_RELEASE.bat` has produced `build/linux_steam`:

```bash
scp -r "build/linux_steam" deploy@YOUR_SERVER:/home/deploy/uploads/linux_steam
```

### 2. Create the env file (owner only — see above)

```bash
sudo tee /etc/synapse-partner.env >/dev/null <<'EOF'
STEAM_PARTNER_PASSWORD=the-second-accounts-password
EOF
sudo chmod 600 /etc/synapse-partner.env
```

### 3. Run the deploy script

```bash
cd server/partner_bot
sudo ./deploy.sh /home/deploy/uploads/linux_steam <APP_ID> <second-account-steam-username>
```

`<APP_ID>` is Synapse Grid's Steam app id (same one in `steam/app_build.vdf`). The second-account username
is the throwaway account from step 3 above (never the owner's main account).

The FIRST run may pause on a Steam Guard prompt (see "THE ONE THING" step 5) — re-run it once
interactively if so:

```bash
sudo -u steam steamcmd +login <second-account-steam-username> +quit
# enter the Steam Guard code emailed to that account, then Ctrl-D / it exits on its own
sudo ./deploy.sh /home/deploy/uploads/linux_steam <APP_ID> <second-account-steam-username>
```

`deploy.sh` is idempotent — every later build push is the same two commands (scp, then deploy.sh) with no
extra steps, and it never touches `/etc/synapse-partner.env` or the cached login after the first run.

### 4. Verify it's running

```bash
sudo systemctl status synapse-partner
sudo journalctl -u synapse-partner -f
```

You should see lines prefixed `[PartnerBot]`:

```
[PartnerBot] boot lan_mode=False
[PartnerBot] state IDLE -> HOSTING
```

### 5. Relay keepalive

Installed automatically into root's crontab by `deploy.sh` (`*/5 * * * *` running `relay_keepalive.sh`).
Verify with:

```bash
crontab -l | grep relay_keepalive
tail -20 /var/log/synapse-partner-relay.log
```

## Files in this directory

- `deploy.sh` — idempotent install/update script (run for every new build).
- `synapse-partner.service` — systemd unit (`Restart=always`, runs under `xvfb-run` so the Steam client has
  a display to draw its hidden windows on).
- `relay_keepalive.sh` — curls the relay's health endpoint every 5 minutes so the Render free tier never
  cold-starts on the non-Steam fallback path.

## What could not be verified without the owner's Steam login

- That `steamInitEx` actually succeeds under the second account on this server (needs the real Steam
  Guard-verified login from step 5 above).
- That the public lobby the bot creates is actually visible to QUICK MATCH from a third, reviewer-side
  Steam client. This requires two real Steam sessions and cannot be simulated in the engine's headless
  test suite — verify by hand once the server is live: open the game as any other Steam account and press
  QUICK MATCH.
- Whether the second account needs a purchase/ownership review delay before its lobby is publicly
  discoverable (some Steamworks features gate on account age/spend) — ask Steam support if QUICK MATCH
  doesn't find the lobby within a few minutes of first boot.
