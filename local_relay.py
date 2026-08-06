#!/usr/bin/env python3
"""
Synapse Grid — ZERO-INSTALL local relay (LAN testing only).

Same wire protocol as server/signaling_server.js, but written against the Python STANDARD LIBRARY only — no
`pip install`, no Node. Use it to test the online lobby + device-power host election on two phones over your WiFi
WITHOUT deploying anything to the cloud.

    python local_relay.py            # listens on 0.0.0.0:8080
    python local_relay.py 9000       # custom port

Then on each phone: ONLINE -> INTERNET, set the URL to  ws://<YOUR-PC-LAN-IP>:8080  (e.g. ws://192.168.50.238:8080),
type the SAME room code on both, Connect. The stronger phone is elected host.

NOTE: this is a dev/LAN tool (plain ws://, minimal hardening). For internet play deploy server/ (Node) per
server/README.md and use wss://. Android allows cleartext ws:// only to LAN IPs.
"""

import asyncio
import base64
import hashlib
import itertools
import json
import struct
import sys

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_MAX_ROOM = 12   # online arena: 10 players + 2 spectator headroom (matches signaling_server.js default)

_next_id = itertools.count(1)
_rooms: dict[str, list] = {}   # room_code -> [Client, ...]


class Client:
    def __init__(self, writer):
        self.id = next(_next_id)
        self.writer = writer
        self.room = ""
        self.bench = 0
        self.name = ""

    async def send(self, obj: dict) -> None:
        try:
            self.writer.write(_encode_text(json.dumps(obj)))
            await self.writer.drain()
        except (ConnectionError, RuntimeError):
            pass


def _elect_host(room: list) -> int:
    # Highest bench wins; lowest peer id breaks ties (must match NetMan.elect_host on the client).
    best_id, best_bench = 0, -1
    for c in room:
        if c.bench > best_bench or (c.bench == best_bench and (best_id == 0 or c.id < best_id)):
            best_bench, best_id = c.bench, c.id
    return best_id


async def _broadcast_lobby(code: str) -> None:
    room = _rooms.get(code, [])
    if not room:
        return
    host_id = _elect_host(room)
    peers = [{"id": c.id, "bench": c.bench, "name": c.name, "host": c.id == host_id} for c in room]
    msg = {"t": "lobby", "peers": peers, "hostId": host_id}
    for c in room:
        await c.send(msg)


async def _handle_message(client: Client, data: dict) -> None:
    t = data.get("t", "")
    if t == "join":
        code = str(data.get("room", "")).strip().upper() or "PLAY"
        room = _rooms.setdefault(code, [])
        if len(room) >= _MAX_ROOM:
            await client.send({"t": "error", "msg": "room full"})
            return
        client.room = code
        client.bench = int(data.get("bench", 0))
        client.name = str(data.get("name", "")) or ("Player %d" % client.id)
        room.append(client)
        await client.send({"t": "joined", "peerId": client.id, "host": False, "room": code})
        for c in room:
            if c is not client:
                await c.send({"t": "peer_join", "peerId": client.id})
        await _broadcast_lobby(code)
        print(f"[+] peer {client.id} ({client.name}, bench {client.bench}) joined room {code} "
              f"[{len(room)} in room]")
    elif t == "relay":
        room = _rooms.get(client.room, [])
        out = {"t": "relay", "from": client.id, "data": data.get("data", {})}
        for c in room:
            if c is not client:
                await c.send(out)
    elif t == "pong":
        pass
    elif t == "leave":
        await _drop(client)


async def _drop(client: Client) -> None:
    code = client.room
    room = _rooms.get(code)
    if not room or client not in room:
        return
    room.remove(client)
    print(f"[-] peer {client.id} left room {code} [{len(room)} left]")
    if not room:
        _rooms.pop(code, None)
        return
    new_host = _elect_host(room)
    for c in room:
        await c.send({"t": "peer_left", "peerId": client.id, "hostId": new_host})
    await _broadcast_lobby(code)


# --- Minimal RFC6455 framing (stdlib only) --------------------------------------------------------

async def _handshake(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> bool:
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        return False
    key = ""
    for line in raw.decode("latin-1").split("\r\n"):
        if ":" in line:
            name, _, value = line.partition(":")
            if name.strip().lower() == "sec-websocket-key":
                key = value.strip()
    if not key:
        return False
    accept = base64.b64encode(hashlib.sha1((key + _WS_GUID).encode()).digest()).decode()
    writer.write(("HTTP/1.1 101 Switching Protocols\r\n"
                  "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
    await writer.drain()
    return True


def _encode_text(s: str) -> bytes:
    payload = s.encode("utf-8")
    n = len(payload)
    header = bytearray([0x81])   # FIN + text opcode
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    return bytes(header) + payload   # server->client frames are NOT masked


async def _read_frame(reader: asyncio.StreamReader):
    # Returns (opcode, payload_bytes) or None on close/EOF. Handles client masking + extended lengths.
    try:
        b0, b1 = await reader.readexactly(2)
    except asyncio.IncompleteReadError:
        return None
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if masked else b""
    payload = await reader.readexactly(length) if length else b""
    if masked:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
    return opcode, payload


async def _serve_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    if not await _handshake(reader, writer):
        writer.close()
        return
    client = Client(writer)
    try:
        while True:
            frame = await _read_frame(reader)
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 0x8:           # close
                break
            if opcode == 0x9:           # ping -> pong
                writer.write(b"\x8a\x00")
                await writer.drain()
                continue
            if opcode in (0x1, 0x0):    # text / continuation (small JSON arrives unfragmented)
                try:
                    data = json.loads(payload.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(data, dict):
                    await _handle_message(client, data)
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        await _drop(client)
        writer.close()


async def _main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = await asyncio.start_server(_serve_client, "0.0.0.0", port)
    print(f"Synapse Grid local relay listening on ws://0.0.0.0:{port}")
    print("On each phone (same WiFi): ONLINE -> INTERNET, URL = ws://<this-PC-LAN-IP>:%d, same room code." % port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        print("\nrelay stopped")
