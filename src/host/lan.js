// Virtual LAN (D061): every player of a game on this server is on one simulated local network. Each page's worker opens
// a WebSocket to /api/lan?room=<game>; the server gives it an address in 10.77.0.0/16 and relays the packets its
// emulated Winsock sends: UDP datagrams (to one address, or broadcast to every other member of the room) and the frames
// of emulated TCP connections (open, accepted, refused/reset, data, close), routed by destination address. The server
// sets the source address of every frame (no spoofing) and answers an open towards nobody with a reset.
//
// Frame (binary WebSocket message): type u8, source address (4 bytes, a.b.c.d), source port (u16, big-endian),
// destination address, destination port, payload. Control messages (text, JSON) from the server: {type:'hello', ip,
// peers} on joining, {type:'peers', peers} when the room changes.
import crypto from 'node:crypto';
import { LAN } from './lan-proto.js';
export { LAN };
const MAX_FRAME = 256 * 1024;

/** A minimal RFC 6455 server side over the socket of an HTTP upgrade (text/binary messages, ping/pong, close). */
class WsPeer {
  constructor(socket, onMessage, onClose, log = () => {}) {
    this.socket = socket; this.onMessage = onMessage; this.onClose = onClose; this.buf = Buffer.alloc(0); this.parts = []; this.closed = false; this.log = log;
    socket.on('data', (d) => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; try { this.parse(); } catch (e) { this.why = `error: ${e.message}`; this.close(); } });
    socket.on('close', () => { this.why ??= 'connection closed'; this.finish(); }); socket.on('error', (e) => { this.why ??= `socket error: ${e.message}`; this.finish(); });
    socket.setNoDelay(true);
  }
  parse() {
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 15, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 127, o = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); o = 10; }
      if (len > MAX_FRAME) { this.why = `frame of ${len} bytes`; this.close(); return; }
      if (b.length < o + (masked ? 4 : 0) + len) return;
      const mask = masked ? b.subarray(o, o + 4) : null; o += masked ? 4 : 0;
      const data = Buffer.from(b.subarray(o, o + len)); if (mask) for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(o + len);
      if (op === 8) { this.why = `closed by the page (${data.length >= 2 ? data.readUInt16BE(0) : '-'})`; this.close(); return; }
      if (op === 9) { this.sendRaw(10, data); continue; }
      if (op === 10) continue;
      if (op !== 0) this.op = op;
      this.parts.push(data);
      if (fin) { const msg = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts); this.parts = []; this.onMessage(msg, this.op === 1); }
    }
  }
  sendRaw(op, data) {
    if (this.closed) return;
    const n = data.length, head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    try { this.socket.write(Buffer.concat([head, data])); } catch (e) { this.why ??= `write: ${e.message}`; this.finish(); }
  }
  send(msg) { if (typeof msg === 'string') this.sendRaw(1, Buffer.from(msg)); else this.sendRaw(2, msg); }
  close() { if (!this.closed) { try { this.sendRaw(8, Buffer.alloc(0)); } catch { /* gone */ } } this.finish(); try { this.socket.end(); } catch { /* gone */ } }
  finish() { if (this.closed) return; this.closed = true; this.onClose(); }
}

/** Accept WebSocket upgrades on /api/lan: the virtual LAN of each game (room). */
export function attachLan(server, log = () => {}) {
  const rooms = new Map(); // room -> Map(ip string -> peer)
  const ipOf = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/lan' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const roomName = (url.searchParams.get('room') ?? 'default').slice(0, 64);
    const room = rooms.get(roomName) ?? new Map(); rooms.set(roomName, room);
    let n = 2; while (room.has(`10.77.${n >> 8}.${n & 255}`) || (n & 255) === 0 || (n & 255) === 255) n++;
    const ip = `10.77.${n >> 8}.${n & 255}`, ipBytes = ip.split('.').map(Number);
    const announce = () => { for (const p of room.values()) p.ws.send(JSON.stringify({ type: 'peers', peers: room.size })); };
    const peer = { ip, ws: null };
    peer.ws = new WsPeer(socket, (msg, text) => {
      if (text || msg.length < LAN.HEADER) return;
      msg[1] = ipBytes[0]; msg[2] = ipBytes[1]; msg[3] = ipBytes[2]; msg[4] = ipBytes[3]; // (the source is the sender)
      const dst = ipOf(msg, 7), type = msg[0];
      if (type === LAN.UDP && (dst === '255.255.255.255' || dst === '10.77.255.255')) { for (const p of room.values()) if (p !== peer) p.ws.send(msg); return; }
      const to = room.get(dst);
      if (to) { to.ws.send(msg); return; }
      if (type === LAN.UDP) return; // (a datagram to nobody: lost, as on a network)
      if (type === LAN.SYN) { // (nobody there: refused)
        const r = Buffer.from(msg.subarray(0, LAN.HEADER)); r[0] = LAN.RST;
        msg.copy(r, 1, 7, 13); msg.copy(r, 7, 1, 7);
        peer.ws.send(r);
      }
    }, () => { room.delete(ip); if (!room.size) rooms.delete(roomName); else announce(); log(`lan: ${ip} left ${roomName} (${peer.ws.why ?? '?'}; ${room.size} left)`); });
    room.set(ip, peer);
    peer.ws.send(JSON.stringify({ type: 'hello', ip, peers: room.size }));
    announce();
    log(`lan: ${ip} joined ${roomName} (${room.size} in the room)`);
  });
  return { rooms };
}
