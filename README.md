# Synapse Grid — Relay / Signaling Server

> **STATUS (2026-08-26):** this relay is an **advanced, off-by-default transport** — deploying it is
> optional. Direct ENet (the default online path since r13) already hosts up to 12 peers with no relay
> involved (`network_manager.gd:43`), so serverless internet play works without anything in this folder.
> Deploy this only if you specifically want relay-hosted rooms (e.g. for a future world-ladder mode).
> See `docs/MULTIPLAYER_NO_SERVER_PLAN.md` and `docs/UNFINISHED.md` ("Relay redeploy").

A tiny Node.js WebSocket server that makes **internet multiplayer** work for two
mobile phones that are both behind NAT/CGNAT (i.e. normal phones on normal
mobile data / home Wi‑Fi). It does two jobs at once:

1. **Signaling / matchmaking** — two phones join the same *room code*, each
   reports a device‑power *benchmark score*, and the server tells everyone who
   should be **host** (highest score = host; ties broken deterministically by
   peer id). The host phone runs the authoritative game simulation.
2. **Relay** — both phones make an **outbound** WebSocket connection to this
   server, and the server forwards game packets between them. This is what lets
   "the phone host" idea work at all: a phone behind carrier NAT cannot accept
   incoming connections, so it can't run a server the other phone dials into.
   Routing everything through this relay sidesteps NAT entirely.

> **Why a relay and not WebRTC P2P?** Godot 4.2's built‑in
> `WebSocketMultiplayerPeer` is in the **stock Android export templates**.
> WebRTC requires the `webrtc-native` GDExtension, which is **not** in stock
> templates and is an extra build/ship cost on Android. The relay needs **zero
> client plugins** and works on every network. WebRTC is documented as an
> optional future upgrade in `docs/MULTIPLAYER.md`.

The full Godot-side integration design lives in **`../docs/MULTIPLAYER.md`**.

---

## ⚡ Fastest test: ZERO-INSTALL local relay (LAN, Python stdlib)

No Node, no `pip`, no cloud account. If your PC + both phones are on the **same Wi‑Fi**, use the pure‑stdlib Python
relay — it speaks the exact same protocol and is verified working (handshake + room join + host election + relay):

```
python local_relay.py            # listens on 0.0.0.0:8080  (python local_relay.py 9000 for another port)
```

Then on **each phone**: **ONLINE → INTERNET**, set the URL box to **`ws://<YOUR-PC-LAN-IP>:8080`**
(e.g. `ws://192.168.50.238:8080`), type the **same room code** on both, **Connect**. The stronger phone is elected
host. No APK rebuild needed — the lobby's URL field is editable at runtime.

This is a **dev/LAN tool** (plain `ws://`, minimal hardening). For internet play across different networks, deploy
the Node server below and use `wss://` (Android blocks cleartext `ws://` except to LAN IPs).

---

## What it speaks

All frames are JSON text. See the header comment in `signaling_server.js` for
the exact message catalog. The short version:

- Client sends `{"t":"join","room":"ABCD","bench":1234,"name":"Tim"}`
- Server replies `{"t":"joined","peerId":2,"host":false,"room":"ABCD"}` and
  broadcasts a `{"t":"lobby",...}` snapshot (peer list + elected `hostId`).
- Client sends `{"t":"relay","to":0,"data":{...}}` (`to:0` = broadcast to room).
- Server forwards as `{"t":"relay","from":2,"data":{...}}`.
- Heartbeat: server sends `{"t":"ping"}`; client must reply `{"t":"pong"}`.

There are **no external dependencies beyond `ws`**, and **no database** — rooms
live in memory and are cleaned up when empty. That's fine for a relay: if the
process restarts, clients just reconnect and re-join their room.

---

## Run it locally

You need Node.js 18+ installed.

```bash
cd server
npm install          # installs the single dependency, "ws"
npm start            # == node signaling_server.js
```

It listens on port **8080** by default. Override with the `PORT` env var:

```bash
PORT=9000 npm start
```

Quick smoke test in a browser: open <http://localhost:8080/health> — you should
see `Synapse Grid relay OK — rooms: 0`.

### Testing two clients on your LAN (before you deploy)

While developing you can point both phones (or the Godot editor + one phone) at
your computer's LAN IP, e.g. `ws://192.168.1.50:8080`. Both devices must be on
the same Wi‑Fi. This proves the game logic without needing a public host yet.
(Real internet play across different networks needs the public deploy below.)

Environment variables you can set:

| Var             | Default | Meaning                                   |
| --------------- | ------- | ----------------------------------------- |
| `PORT`          | `8080`  | TCP port to listen on                     |
| `MAX_ROOM_SIZE` | `4`     | Max peers per room (use `2` for strict 1v1)|

---

## Deploy it to a free/cheap always‑on host

For internet play you need this server reachable on a public URL. Below are
concrete steps for **three** hosts — pick **one**. I recommend **Render** for
the simplest free path (no CLI, no credit card to start, GitHub‑driven).

> ⚠️ **You must create the account and accept that provider's Terms of Service
> yourself.** I can't and won't sign up for a service on your behalf. The steps
> below assume you have logged in. Everything here is just the config/commands.

> ⚠️ **Free‑tier sleep:** Render/Fly free tiers may *idle the server to sleep*
> after inactivity, so the **first** connection after a quiet period can take
> ~30–60 s to wake. For a hobby/launch that's acceptable; for always‑instant
> play, use a paid "always‑on" instance (a few dollars/month) or Railway.

After deploying you'll get a hostname like `your-app.onrender.com`. The game
connects with the **`wss://`** (TLS) form of it:

```
wss://your-app.onrender.com
```

**This is the single value the game needs.** Put it in the Godot
`NetworkManager` autoload as `DEFAULT_RELAY_URL` (see `docs/MULTIPLAYER.md`,
"Where to put the URL"). Always use `wss://` (secure) for a public host — all
three providers below terminate TLS for you, and Android blocks plain `ws://`
cleartext by default.

---

### Option A — Render (recommended, simplest)

1. Push this repo (or just the `server/` folder) to a GitHub repository.
2. Log in to Render → **New +** → **Web Service** → connect that repo.
3. Set:
   - **Root Directory:** `server`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (or a paid one to avoid sleep)
4. Create the service. Render assigns the `PORT` env var automatically; the
   server already reads `process.env.PORT`, so no extra config is needed.
5. When it's live, your URL is `https://<name>.onrender.com`. The game uses
   `wss://<name>.onrender.com`.

A `render.yaml` is included so you can also use Render's *Blueprint* flow
(point Render at the repo and it reads the config).

---

### Option B — Fly.io (CLI, generous free allowance, global)

1. Install the CLI (`flyctl`) and run `fly auth login` (this opens a browser
   for **you** to sign in / sign up and accept their ToS).
2. From the `server/` directory:
   ```bash
   fly launch --no-deploy        # detects Node, generates an app name
   # When prompted, DO NOT add a database. Keep the suggested internal port or
   # set it to 8080 to match this server's default.
   fly deploy
   ```
3. A `fly.toml` is included as a starting point — `fly launch` will offer to use
   or overwrite it. Make sure `internal_port = 8080` matches the server.
4. Your URL is `https://<app>.fly.dev`; the game uses `wss://<app>.fly.dev`.

---

### Option C — Railway (no sleep on the trial, very fast setup)

1. Log in to Railway → **New Project** → **Deploy from GitHub repo** (select
   this repo). Railway will prompt **you** to authorize GitHub and accept ToS.
2. In the service settings:
   - **Root Directory:** `server`
   - **Start Command:** `npm start` (Railway auto‑detects Node + runs
     `npm install`).
3. Railway injects `PORT` automatically (the server reads it).
4. Under **Settings → Networking → Generate Domain** to get a public URL like
   `your-app.up.railway.app`. The game uses `wss://your-app.up.railway.app`.

> Railway's free trial has usage credits rather than a perpetual free tier;
> check their current pricing. It does **not** sleep, so connections are instant.

---

## Files in this folder

| File                  | Purpose                                                      |
| --------------------- | ----------------------------------------------------------- |
| `signaling_server.js` | The whole server (signaling + relay + heartbeat + cleanup). |
| `package.json`        | `ws` dependency and the `start` script.                     |
| `render.yaml`         | One‑click Render Blueprint config (Option A).               |
| `fly.toml`            | Fly.io app config starting point (Option B).                |
| `Dockerfile`          | Optional container build (works on any of the three, or your own host). |

---

## Operating notes

- **No persistence by design.** Rooms are in memory; an empty room is deleted
  after a short grace period. A process restart just means clients reconnect.
- **Capacity.** One small free instance comfortably relays many simultaneous
  1v1 rooms — game traffic is tiny (a few small JSON frames per physics tick per
  player). If you ever outgrow it, scale the instance up or run several behind a
  load balancer with sticky sessions per room.
- **Security.** This relay does no auth — anyone who knows a room code can join
  it (max `MAX_ROOM_SIZE`). That's fine for casual matchmaking. If you later
  want private matches, add a shared secret to the `join` message and check it
  server‑side, or move room creation behind a lightweight token endpoint.
- **Logs.** The server logs joins/leaves/host changes with timestamps to stdout,
  which all three platforms capture in their dashboards.
