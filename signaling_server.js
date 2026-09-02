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

// ---- BUG REPORT INTAKE (POST /bug) ---------------------------------------
// Owner, 2026-09-01: "where does the bug report go ... use bugs@alluring.coffee
// which would be better and send all data along with it so we can review".
//
// WHY IT LIVES HERE AND NOT IN THE GAME. bug_report.gd's own header already
// states the rule and it has not changed: a credential shipped in a binary is a
// PUBLISHED credential, so the game can never hold a mail password or an API key.
// It can only POST to a public endpoint. This is that endpoint, and the key lives
// in this server's environment where players cannot reach it.
//
// CONFIGURE (Render dashboard -> Environment, or `fly secrets set`):
//   RESEND_API_KEY   the only secret. Without it nothing is emailed - reports are
//                    still accepted and logged, and the client is told plainly it
//                    was not delivered so the player keeps their own copy.
//   BUG_TO           default bugs@alluring.coffee
//   BUG_FROM         default bugs@alluring.coffee - must be on a domain verified
//                    with the mail provider or the provider rejects the send.
// No npm install: Node >= 18 (package.json engines) has global fetch.
const BUG_TO = process.env.BUG_TO || 'bugs@alluring.coffee';
const BUG_FROM = process.env.BUG_FROM || 'Synapse Grid Bugs <bugs@alluring.coffee>';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// The provider endpoint. Overridable ONLY so the test suite can stand a local mock in its place
// (tests/signaling_server.integration.test.js); a deployment never sets it.
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
// A 1080p PNG is ~2 MB, ~2.7 MB once base64'd. 8 MB leaves room for that plus the
// log tail without letting one request exhaust a free-tier instance's memory.
const BUG_MAX_BYTES = parseInt(process.env.BUG_MAX_BYTES || '8388608', 10);
const BUG_RATE_MAX = parseInt(process.env.BUG_RATE_MAX || '5', 10);
const BUG_RATE_WINDOW_MS = parseInt(process.env.BUG_RATE_WINDOW_MS || '600000', 10);

// ip -> {n, start}. Pruned on every check, so a long-lived instance cannot
// accumulate one entry per address that ever touched it.
const bugRate = new Map();

function bugRateAllows(ip) {
	const now = Date.now();
	for (const [k, v] of bugRate) if (now - v.start > BUG_RATE_WINDOW_MS) bugRate.delete(k);
	const e = bugRate.get(ip);
	if (!e) { bugRate.set(ip, { n: 1, start: now }); return true; }
	if (now - e.start > BUG_RATE_WINDOW_MS) { bugRate.set(ip, { n: 1, start: now }); return true; }
	e.n += 1;
	return e.n <= BUG_RATE_MAX;
}

function readJsonBody(req, limit) {
	return new Promise((resolve, reject) => {
		let size = 0;
		let over = false;
		let chunks = [];
		// ⚠ DO NOT req.destroy() ON OVERFLOW. That was the first version, and a live
		// test found it: destroying the request kills the socket before the handler
		// can write its 413, so a client that sent one oversized screenshot sees a
		// connection reset with no status and no reason - and curl reported HTTP 100,
		// because the socket died mid 100-continue. Instead: stop BUFFERING, keep
		// draining so 'end' still fires and the 413 flushes, and only cut the
		// connection if the sender keeps going well past the limit (which is no
		// longer a memory question, since nothing is being kept).
		req.on('data', (c) => {
			size += c.length;
			if (over) {
				if (size > limit * 4) req.destroy();
				return;
			}
			if (size > limit) {
				over = true;
				chunks = [];
				reject(new Error('too_large'));
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			if (over) return;   // already rejected; resolving now would be ignored anyway
			try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
			catch (e) { reject(new Error('bad_json')); }
		});
		req.on('error', () => reject(new Error('io')));
	});
}

function bugSummary(b) {
	// Every field the client sends, in a fixed order so two reports are diffable by
	// eye. UNKNOWN KEYS ARE PRINTED TOO: the client is expected to grow new
	// diagnostics, and a relay that silently dropped them would make the next
	// diagnostic invisible for as long as nobody redeployed this file.
	const known = ['message', 'build', 'flavour', 'scene', 'mission', 'when', 'platform',
		'renderer', 'gpu', 'cpu', 'ram_mb', 'window', 'tier', 'reduced_motion',
		'locale', 'playtime_s', 'tree_paused', 'time_scale', 'clock_latches', 'steam',
		'mods_mounted', 'contact', 'log'];
	const lines = [];
	for (const k of known) {
		if (b[k] === undefined || k === 'log' || k === 'message') continue;
		lines.push(k + ': ' + String(b[k]).slice(0, 400));
	}
	for (const k of Object.keys(b)) {
		if (known.includes(k) || k === 'shot_png_b64') continue;
		lines.push(k + ': ' + String(b[k]).slice(0, 400));
	}
	let out = 'SYNAPSE GRID BUG REPORT\n=======================\n' + lines.join('\n');
	out += '\n\n--- player message ---\n' + String(b.message || '(none)').slice(0, 20000);
	if (b.log) out += '\n\n--- log tail ---\n' + String(b.log).slice(0, 60000);
	return out;
}

async function emailBug(body, shotB64) {
	if (!RESEND_API_KEY) return { emailed: false, why: 'no RESEND_API_KEY configured on the relay' };
	const subject = ('[SG bug] ' + String(body.build || '?') + ' ' + String(body.scene || '')).slice(0, 180);
	const payload = {
		from: BUG_FROM,
		to: [BUG_TO],
		subject: subject,
		text: bugSummary(body),
	};
	// reply_to ONLY when the player volunteered an address and it looks like one: a
	// malformed value makes the provider reject the whole send, which would lose a
	// report over an optional field.
	if (typeof body.contact === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.contact)) {
		payload.reply_to = body.contact;
	}
	if (shotB64) payload.attachments = [{ filename: 'shot.png', content: shotB64 }];
	try {
		const r = await fetch(RESEND_API_URL, {
			method: 'POST',
			headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!r.ok) {
			const t = await r.text().catch(() => '');
			// Never log the key; the provider echoes only the request it saw.
			log('bug email failed ' + r.status + ': ' + t.slice(0, 300));
			return { emailed: false, why: 'mail provider returned ' + r.status };
		}
		return { emailed: true };
	} catch (e) {
		log('bug email threw: ' + (e && e.message));
		return { emailed: false, why: 'mail provider unreachable' };
	}
}

async function handleBugPost(req, res) {
	const fwd = String(req.headers['x-forwarded-for'] || '');
	const ip = fwd.split(',')[0].trim() || req.socket.remoteAddress || '?';
	if (!bugRateAllows(ip)) {
		res.writeHead(429, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
		return;
	}
	let body;
	try {
		body = await readJsonBody(req, BUG_MAX_BYTES);
	} catch (e) {
		const code = e.message === 'too_large' ? 413 : 400;
		// The socket may already be gone (the 4x drain guard, or a client that hung
		// up); writing to a destroyed response throws and would surface as a 500 for
		// what is really a clean refusal.
		if (!res.writableEnded && !res.headersSent) {
			try {
				res.writeHead(code, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: e.message }));
			} catch (_) { /* client vanished mid-refusal; nothing to report to */ }
		}
		return;
	}
	if (!body || typeof body !== 'object') {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: false, error: 'bad_body' }));
		return;
	}
	const shot = typeof body.shot_png_b64 === 'string' ? body.shot_png_b64 : '';
	// ALWAYS log the report, key or no key. Render and Fly both keep stdout, so a
	// misconfigured mailer degrades to "the report is in the logs" rather than to a
	// report that never existed.
	log('bug report from ' + ip + ' build=' + body.build + ' scene=' + body.scene + ' shot=' + shot.length + ' b64 bytes');
	log(bugSummary(body));
	const out = await emailBug(body, shot);
	res.writeHead(out.emailed ? 200 : 202, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(Object.assign({ ok: true, to: BUG_TO }, out)));
}

// ---- HTTP server (health check + WS upgrade target) -----------------------
// A plain 200 on "/" so platform health checks (Fly/Render/Railway) pass and
// you can eyeball "it's alive" in a browser. WS upgrade is handled by ws below.
const httpServer = http.createServer((req, res) => {
	if (req.method === 'POST' && req.url === '/bug') {
		// handleBugPost owns the response on every path including its own failures,
		// so a rejection reaching here can only be a bug in this file - answer 500
		// rather than leaving the client hanging until its timeout.
		handleBugPost(req, res).catch((e) => {
			log('bug handler threw: ' + (e && e.message));
			if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
			res.end(JSON.stringify({ ok: false, error: 'server_error' }));
		});
		return;
	}
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
function heartbeatTick() {
	for (const ws of wss.clients) {
		if (ws.alive === false) {
			log(`terminating unresponsive peer ${ws.peerId} (room ${ws.roomCode})`);
			ws.terminate(); // fires 'close' -> handleDisconnect
			continue;
		}
		ws.alive = false;
		send(ws, { t: 'ping' });
	}
}
let heartbeat = null;

// BACKLOG 1.15 (2026-09-02): the process used to listen at module load, which made the file
// untestable without spawning it. start() is the same listen + heartbeat, called at the bottom
// only when this file IS the program (`node signaling_server.js`); a test requires the module,
// calls start(0) for an OS-assigned port, and stop() to let the process exit.
function start(port, onListening) {
	heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
	wss.once('close', () => clearInterval(heartbeat));
	httpServer.listen(port, () => {
		const actual = httpServer.address().port;
		log(`Synapse Grid relay listening on :${actual} (max room ${MAX_ROOM_SIZE})`);
		if (onListening) onListening(actual);
	});
	return httpServer;
}

function stop(done) {
	if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
	for (const ws of wss.clients) ws.terminate();
	for (const room of rooms.values()) if (room.deleteTimer) clearTimeout(room.deleteTimer);
	rooms.clear();
	httpServer.close(() => { if (done) done(); });
}

// Clean shutdown on SIGTERM/SIGINT (platforms send SIGTERM on redeploy).
function shutdown(sig) {
	log(`${sig} received, closing...`);
	if (heartbeat) clearInterval(heartbeat);
	for (const ws of wss.clients) ws.close(1001, 'server shutting down');
	httpServer.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref(); // hard exit if sockets hang
}
if (require.main === module) {
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
	start(PORT);
}

// Test seam (BACKLOG 1.15): the pure pieces and the lifecycle, nothing a deployment calls.
module.exports = {
	start, stop, heartbeatTick,
	electHost, bugRateAllows, bugSummary, readJsonBody, bugRate, rooms,
	BUG_TO, BUG_MAX_BYTES, BUG_RATE_MAX, MAX_ROOM_SIZE, ROOM_CODE_RE,
};


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
