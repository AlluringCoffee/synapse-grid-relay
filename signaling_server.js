/*
 * Synapse Grid — Signaling + Relay Server
 * ----------------------------------------
 * A tiny WebSocket server that does TWO jobs for the mobile game:
 *
 *   1. SIGNALING / MATCHMAKING
 *      - Two (or more) phones join a "room" by typing a short room code.
 *      - Each phone reports a device-power "benchmark" score on join.
 *      - The server collects scores and tells everyone who should HOST
 *        (highest score wins; deterministic tiebreak by peer id). The host
 *        phone runs the authoritative game simulation.
 *
 *   2. RELAY (the part that makes phone-hosting work through NAT/CGNAT)
 *      - A phone behind carrier NAT cannot accept inbound connections, so the
 *        "host" phone cannot run a listening ENet/WebSocket server that the
 *        other phone dials into. Instead BOTH phones make an OUTBOUND
 *        WebSocket connection to THIS server, and this server forwards game
 *        packets between them. The elected host's simulation is authoritative;
 *        the relay just moves bytes. No STUN/TURN, no extra Godot plugin.
 *
 * Why WebSocket relay instead of WebRTC P2P:
 *      Godot 4.2's built-in WebSocketMultiplayerPeer ships in the stock Android
 *      export templates. WebRTC needs the webrtc-native GDExtension, which is
 *      NOT in stock templates and is an extra build/ship cost on Android. The
 *      relay works for every phone on every network with zero client plugins.
 *      WebRTC remains a documented future upgrade (see docs/MULTIPLAYER.md).
 *
 * Protocol (all messages are JSON text frames):
 *   Client -> Server:
 *     { "t": "join",  "room": "ABCD", "bench": 1234, "name": "optional" }
 *     { "t": "relay", "to": <peerId|0>, "data": <any> }   // 0 = broadcast to room
 *     { "t": "pong" }                                      // reply to our ping
 *     { "t": "leave" }                                     // graceful exit (optional)
 *   Server -> Client:
 *     { "t": "joined",  "peerId": 2, "host": false, "room": "ABCD" }
 *     { "t": "lobby",   "peers": [ {id,bench,name,host} ... ], "hostId": 1 }
 *     { "t": "peer_join","peerId": 3 }
 *     { "t": "peer_left","peerId": 3, "newHostId": 1 }     // newHostId if host changed
 *     { "t": "relay",   "from": <peerId>, "data": <any> }
 *     { "t": "error",   "code": "...", "msg": "..." }
 *     { "t": "ping" }                                      // heartbeat; reply with pong
 *
 * Peer ids: assigned per room starting at 1. They are stable for the life of a
 * connection. Host election picks the highest bench score; ties break to the
 * LOWEST peer id (deterministic, so all clients independently agree).
 *
 * Run:   node signaling_server.js          (PORT env var, default 8080)
 * Deps:  ws  (npm install)  — nothing else.
 */

'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

// ---- Tunables -------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_ROOM_SIZE = parseInt(process.env.MAX_ROOM_SIZE || '12', 10); // 10 for online arena + 2 spectator headroom
const HEARTBEAT_MS = 15000;          // ping every 15s; drop a peer that misses two beats
const ROOM_CODE_RE = /^[A-Z0-9]{2,8}$/; // normalized, short, human-typeable
const EMPTY_ROOM_TTL_MS = 5000;      // grace before deleting an emptied room

// ---- State ----------------------------------------------------------------
// rooms: Map<roomCode, { peers: Map<peerId, peerState>, nextId: number, deleteTimer }>
// peerState: { id, ws, bench, name, alive }
const rooms = new Map();

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

function getOrCreateRoom(code) {
	let room = rooms.get(code);
	if (!room) {
		room = { peers: new Map(), nextId: 1, deleteTimer: null };
		rooms.set(code, room);
		log(`room ${code} created`);
	}
	if (room.deleteTimer) { // someone re-joined before the TTL fired
		clearTimeout(room.deleteTimer);
		room.deleteTimer = null;
	}
	return room;
}

function scheduleRoomCleanup(code) {
	const room = rooms.get(code);
	if (!room || room.peers.size > 0) return;
	if (room.deleteTimer) return;
	room.deleteTimer = setTimeout(() => {
		const r = rooms.get(code);
		if (r && r.peers.size === 0) {
			rooms.delete(code);
			log(`room ${code} deleted (empty)`);
		}
	}, EMPTY_ROOM_TTL_MS);
}

// Highest bench wins; tie -> lowest peer id. Deterministic so every client agrees.
function electHost(room) {
	let best = null;
	for (const p of room.peers.values()) {
		if (best === null) { best = p; continue; }
		if (p.bench > best.bench || (p.bench === best.bench && p.id < best.id)) {
			best = p;
		}
	}
	return best ? best.id : 0;
}

function send(ws, obj) {
	if (ws.readyState === ws.OPEN) {
		try { ws.send(JSON.stringify(obj)); } catch (_) { /* socket dying; ignore */ }
	}
}

function sendError(ws, code, msg) {
	send(ws, { t: 'error', code, msg });
}

// Broadcast the authoritative lobby snapshot (peer list + elected host) to the whole room.
function broadcastLobby(room) {
	const hostId = electHost(room);
	const peers = [];
	for (const p of room.peers.values()) {
		peers.push({ id: p.id, bench: p.bench, name: p.name, host: p.id === hostId });
	}
	const msg = { t: 'lobby', peers, hostId };
	for (const p of room.peers.values()) send(p.ws, msg);
}

// ---- HTTP server (health check + WS upgrade target) -----------------------
// A plain 200 on "/" so platform health checks (Fly/Render/Railway) pass and
// you can eyeball "it's alive" in a browser. WS upgrade is handled by ws below.
const httpServer = http.createServer((req, res) => {
	if (req.url === '/health' || req.url === '/') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end(`Synapse Grid relay OK — rooms: ${rooms.size}\n`);
		return;
	}
	res.writeHead(404);
	res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
	// Per-connection state. roomCode/peerId are filled in on "join".
	ws.roomCode = null;
	ws.peerId = 0;
	ws.alive = true;

	log(`socket connected from ${req.socket.remoteAddress}`);

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch (_) {
			sendError(ws, 'bad_json', 'message was not valid JSON');
			return;
		}
		if (!msg || typeof msg.t !== 'string') {
			sendError(ws, 'bad_msg', 'missing message type "t"');
			return;
		}

		switch (msg.t) {
			case 'join':   return handleJoin(ws, msg);
			case 'relay':  return handleRelay(ws, msg);
			case 'ladder_submit': return handleLadderSubmit(ws, msg);
			case 'ladder_get':    return handleLadderGet(ws);
			case 'pong':   ws.alive = true; return;
			case 'leave':  ws.close(1000, 'client left'); return;
			default:
				sendError(ws, 'unknown_type', `unknown message type "${msg.t}"`);
		}
	});

	ws.on('close', () => handleDisconnect(ws));
	ws.on('error', (err) => {
		log(`socket error (peer ${ws.peerId} room ${ws.roomCode}): ${err.message}`);
		// 'close' fires after 'error'; cleanup happens there.
	});
});

function handleJoin(ws, msg) {
	if (ws.roomCode) {
		sendError(ws, 'already_joined', 'this socket already joined a room');
		return;
	}
	const code = String(msg.room || '').trim().toUpperCase();
	if (!ROOM_CODE_RE.test(code)) {
		sendError(ws, 'bad_room', 'room code must be 2-8 chars A-Z/0-9');
		return;
	}
	// bench: a non-negative number (higher = more powerful device). Clamp junk to 0.
	let bench = Number(msg.bench);
	if (!Number.isFinite(bench) || bench < 0) bench = 0;
	const name = (typeof msg.name === 'string') ? msg.name.slice(0, 24) : '';

	const room = getOrCreateRoom(code);
	if (room.peers.size >= MAX_ROOM_SIZE) {
		sendError(ws, 'room_full', `room ${code} is full (max ${MAX_ROOM_SIZE})`);
		return;
	}

	const peerId = room.nextId++;
	ws.roomCode = code;
	ws.peerId = peerId;
	const peer = { id: peerId, ws, bench, name, alive: true };
	room.peers.set(peerId, peer);
	log(`peer ${peerId} joined room ${code} (bench ${bench}, "${name}")`);

	const hostId = electHost(room);
	// 1) Tell the joiner its identity + whether it's currently the host.
	send(ws, { t: 'joined', peerId, host: peerId === hostId, room: code });
	// 2) Tell existing peers someone arrived (so they can show the lobby filling).
	for (const p of room.peers.values()) {
		if (p.id !== peerId) send(p.ws, { t: 'peer_join', peerId });
	}
	// 3) Broadcast the full, freshly-elected lobby to everyone (host may have changed).
	broadcastLobby(room);
}

function handleRelay(ws, msg) {
	const room = rooms.get(ws.roomCode);
	if (!room) {
		sendError(ws, 'not_in_room', 'join a room before relaying');
		return;
	}
	const envelope = { t: 'relay', from: ws.peerId, data: msg.data };
	const to = Number(msg.to);
	if (!to || to === 0) {
		// Broadcast to everyone in the room EXCEPT the sender.
		for (const p of room.peers.values()) {
			if (p.id !== ws.peerId) send(p.ws, envelope);
		}
	} else {
		const target = room.peers.get(to);
		if (target) send(target.ws, envelope);
		// Silently drop if the target vanished — sender will learn via peer_left.
	}
}

function handleDisconnect(ws) {
	const code = ws.roomCode;
	if (!code) return; // never joined a room
	const room = rooms.get(code);
	if (!room) return;

	const hadId = ws.peerId;
	const prevHost = electHost(room);
	room.peers.delete(hadId);
	log(`peer ${hadId} left room ${code} (${room.peers.size} remain)`);

	if (room.peers.size === 0) {
		scheduleRoomCleanup(code);
		return;
	}

	const newHost = electHost(room);
	const hostChanged = newHost !== prevHost;
	// Notify survivors. If the host dropped, newHostId tells them who is now authoritative.
	for (const p of room.peers.values()) {
		send(p.ws, { t: 'peer_left', peerId: hadId, newHostId: hostChanged ? newHost : 0 });
	}
	// Always resend the authoritative lobby so client state can't drift.
	broadcastLobby(room);
}

// ---- Heartbeat: drop dead sockets so rooms don't leak ghost peers ----------
// Send a ping every HEARTBEAT_MS. Any socket that hasn't replied (alive flag
// not refreshed by a pong) since the last beat is terminated.
const heartbeat = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.alive === false) {
			log(`terminating unresponsive peer ${ws.peerId} (room ${ws.roomCode})`);
			ws.terminate(); // fires 'close' -> handleDisconnect
			continue;
		}
		ws.alive = false;
		send(ws, { t: 'ping' });
	}
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
	log(`Synapse Grid relay listening on :${PORT} (max room ${MAX_ROOM_SIZE})`);
});

// Clean shutdown on SIGTERM/SIGINT (platforms send SIGTERM on redeploy).
function shutdown(sig) {
	log(`${sig} received, closing...`);
	clearInterval(heartbeat);
	for (const ws of wss.clients) ws.close(1001, 'server shutting down');
	httpServer.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref(); // hard exit if sockets hang
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


// --- b43 WORLD LADDER -----------------------------------------------------------------------------
// A good-faith top-50 board (arcade-initials trust model: no accounts, display names). Kept in memory
// and persisted best-effort to ladder.json so restarts keep the board. One row per name (best rating).
const fs = require('fs');
const LADDER_FILE = process.env.LADDER_FILE || './ladder.json';
let ladder = [];
try { ladder = JSON.parse(fs.readFileSync(LADDER_FILE, 'utf8')); } catch (_) { ladder = []; }

function saveLadder() {
	try { fs.writeFileSync(LADDER_FILE, JSON.stringify(ladder)); } catch (_) { /* best-effort */ }
}

function handleLadderSubmit(ws, msg) {
	const name = String(msg.name || '').slice(0, 24).trim();
	const rating = Math.max(0, Math.min(10000000, Number(msg.rating) | 0));
	if (!name) return;
	const wins = Math.max(0, Number(msg.wins) | 0);
	const elims = Math.max(0, Number(msg.elims) | 0);
	const existing = ladder.find(r => r.name === name);
	if (existing) {
		if (rating > existing.rating) { existing.rating = rating; existing.wins = wins; existing.elims = elims; }
	} else {
		ladder.push({ name, rating, wins, elims });
	}
	ladder.sort((a, b) => b.rating - a.rating);
	ladder = ladder.slice(0, 50);
	saveLadder();
}

function handleLadderGet(ws) {
	try { ws.send(JSON.stringify({ t: 'ladder', rows: ladder.slice(0, 20) })); } catch (_) {}
}
