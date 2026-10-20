// The page's end of a shared world (src/host/web/mmo-link.js, docs/mmo.md section 6): its records, the engine's queue
// (drain), overflow, reconnection with LINK_RESET, refusal, away, backpressure — over a fake WebSocket and a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMmoLink, LINK, RECORD, LIMITS, BACKOFF_MS, clientRecord, pingRecord, awayRecord, linkResetRecord, serverRecords, parseRefused, splitRecords } from '../src/host/web/mmo-link.js';

/** a fake clock: timers fire when the test advances the time */
function clock() {
  let now = 0; const list = [];
  const add = (fn, ms, every) => { const t = { at: now + ms, fn, every }; list.push(t); return t; };
  const remove = (t) => { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); };
  return {
    now: () => now,
    pending: () => list.length,
    timers: { setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: remove, setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: remove },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        list.sort((a, b) => a.at - b.at); const t = list[0];
        if (!t || t.at > end) break;
        now = t.at; if (t.every) t.at += t.every; else list.shift();
        t.fn();
      }
      now = end;
    },
  };
}
/** a fake WebSocket: the test opens, feeds, fails it */
function fakeSockets() {
  const all = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; this.closedWith = null; all.push(this); }
    send(data) {
      if (this.readyState !== 1) throw new Error('InvalidStateError');
      this.sent.push(Uint8Array.from(data));
    }
    close(code = 1000) { if (this.readyState >= 2) return; this.readyState = 3; this.closedWith = code; this.onclose?.({ code, reason: '' }); }
    accept() { this.readyState = 1; this.onopen?.({}); }
    receive(...records) { const bytes = concat(records); this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }); }
    fail(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
    /** every record sent, in order: { type, body } */
    records() { const out = []; for (const m of this.sent) for (let o = 0; o + 3 <= m.length;) { const len = m[o] | (m[o + 1] << 8); out.push({ type: m[o + 2], body: m.subarray(o + 3, o + 2 + len) }); o += 2 + len; } return out; }
  }
  return { all, FakeSocket, last: () => all.at(-1) };
}
const concat = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
/** a server record: u16 len | type | from | body */
const serverRecord = (type, from, body = []) => { const out = new Uint8Array(4 + body.length); out[0] = (body.length + 2) & 255; out[1] = (body.length + 2) >> 8; out[2] = type; out[3] = from; out.set(body, 4); return out; };
const refusedRecord = (reason, detail = '') => serverRecord(RECORD.REFUSED, 255, [reason, detail.length, ...Buffer.from(detail, 'latin1')]);
function setup() {
  const c = clock(), s = fakeSockets(), states = [], logs = [];
  const link = createMmoLink({ url: 'ws://host/api/mmo/v/ws', WebSocketImpl: s.FakeSocket, now: c.now, timers: c.timers, log: (l) => logs.push(l), onState: (st, l) => states.push([st, l.joined()]) });
  return { c, s, link, states, logs };
}
/** the engine's drain into a fresh heap: the messages it got */
function drainAll(link, cap = 1 << 20, ptr = 16) {
  const heap = new Uint8Array(ptr + cap), n = link.drain(heap, ptr, cap);
  if (n <= 0) return n;
  const out = [];
  for (let o = ptr; o < ptr + n;) { const len = heap[o] | (heap[o + 1] << 8) | (heap[o + 2] << 16) | (heap[o + 3] << 24); out.push(heap.slice(o + 4, o + 4 + len)); o += 4 + len; }
  return out;
}
const HELLO = clientRecord(0x01, [1, 0, 0]);

test('mmo link: its records are framed as the protocol says', () => {
  assert.deepEqual([...clientRecord(0x0D, [0x34, 0x12])], [3, 0, 0x0D, 0x34, 0x12]);
  const ping = pingRecord(1234.5);
  assert.deepEqual([...ping.subarray(0, 3)], [9, 0, RECORD.PING]);
  assert.equal(new DataView(ping.buffer).getFloat64(3, true), 1234.5);
  assert.deepEqual([...awayRecord(true)], [3, 0, RECORD.AWAY, 1, 1]);
  assert.deepEqual([...awayRecord(false)], [3, 0, RECORD.AWAY, 1, 0]);
  assert.deepEqual([...linkResetRecord()], [2, 0, 0xFE, 255]);
  const two = concat([serverRecord(0x87, 255, [1, 2, 3]), refusedRecord(2, 'no world'), Uint8Array.of(9, 0, 0x20)]);
  const recs = serverRecords(two);
  assert.equal(recs.length, 2, 'the truncated third record ends the walk');
  assert.deepEqual([recs[0].type, recs[0].from, [...recs[0].body]], [0x87, 255, [1, 2, 3]]);
  assert.deepEqual(parseRefused(recs[1].body), { reason: 2, detail: 'no world' });
  assert.deepEqual(parseRefused(Uint8Array.of(1)), { reason: 1, detail: '' });
});

test('mmo link: bytes over 64 KB are sent in several messages, cut between records', () => {
  const rec = (n, v) => { const r = clientRecord(0x23, new Uint8Array(n - 3).fill(v)); return r; };
  const small = concat([rec(100, 1), rec(200, 2)]);
  const parts = splitRecords(small, 250);
  assert.deepEqual(parts.map((p) => p.length), [100, 200], 'cut at the record boundary');
  const many = concat(Array.from({ length: 40 }, (_, i) => rec(4000, i)));
  const cut = splitRecords(many);
  assert.ok(cut.length === 3 && cut.every((p) => p.length <= LIMITS.message && p.length % 4000 === 0));
  assert.deepEqual(concat(cut), many);
  const huge = concat([rec(10, 1), rec(65000, 2), rec(10, 3)]);
  assert.deepEqual(splitRecords(huge, 1000).map((p) => p.length), [10, 65000, 10], 'a record bigger than the limit goes alone');
  assert.deepEqual(splitRecords(small, 1 << 20), [small]);
});

test('mmo link: reliable data waits for the first connection, unreliable data is dropped meanwhile', () => {
  const { s, link, states } = setup();
  assert.equal(link.state(), LINK.CLOSED);
  assert.equal(link.send(HELLO), false, 'closed: nothing sent');
  assert.equal(link.open(), LINK.CONNECTING);
  assert.equal(link.open(), LINK.CONNECTING, 'idempotent'); assert.equal(s.all.length, 1);
  assert.equal(s.last().url, 'ws://host/api/mmo/v/ws'); assert.equal(s.last().binaryType, 'arraybuffer');
  assert.equal(link.send(HELLO), true);
  assert.equal(link.send(clientRecord(0x20, [1, 2, 3]), true), false, 'unreliable while connecting');
  assert.equal(link.send(new Uint8Array(LIMITS.connectingQueue)), false, 'over the 1 MB kept while connecting');
  s.last().accept();
  assert.equal(link.state(), LINK.OPEN);
  assert.deepEqual(s.last().records().map((r) => r.type), [0x01]);
  assert.equal(link.send(clientRecord(0x0A, [2, 104, 105])), true);
  assert.equal(link.send(clientRecord(0x20, [0]), true), true);
  assert.deepEqual(s.last().records().map((r) => r.type), [0x01, 0x0A, 0x20]);
  assert.deepEqual(states.map(([st]) => st), [LINK.CONNECTING, LINK.OPEN]);
});

test('mmo link: unreliable data is dropped while the socket is backed up, reliable data still goes', () => {
  const { s, link } = setup();
  link.open(); s.last().accept(); link.send(HELLO);
  s.last().bufferedAmount = LIMITS.unreliableBuffered + 1;
  assert.equal(link.send(clientRecord(0x20, [1]), true), false);
  assert.equal(link.send(clientRecord(0x0A, [1, 65])), true);
  s.last().bufferedAmount = 0;
  assert.equal(link.send(clientRecord(0x20, [1]), true), true);
  assert.deepEqual(s.last().records().map((r) => r.type), [0x01, 0x0A, 0x20]);
  assert.equal(link.stats().dropped, 1);
});

test('mmo link: the engine drains whole messages as u32 length + bytes, at its pointer, within its room', () => {
  const { s, link } = setup();
  link.open(); s.last().accept();
  assert.equal(link.drain(new Uint8Array(64), 0, 64), 0, 'nothing yet');
  const a = serverRecord(0x81, 255, [1, 8]), b = serverRecord(0x8A, 3, [0, 1, 65, 2, 104, 105]);
  s.last().receive(a); s.last().receive(b);
  const heap = new Uint8Array(100).fill(0xEE), n = link.drain(heap, 10, 90);
  assert.equal(n, 4 + a.length + 4 + b.length);
  assert.equal(heap[9], 0xEE, 'nothing before the pointer');
  assert.deepEqual([...heap.subarray(10, 14)], [a.length, 0, 0, 0]);
  assert.deepEqual([...heap.subarray(14, 14 + a.length)], [...a]);
  assert.deepEqual([...heap.subarray(14 + a.length, 18 + a.length)], [b.length, 0, 0, 0]);
  assert.equal(heap[10 + n], 0xEE, 'nothing after');
  assert.equal(link.drain(heap, 10, 90), 0, 'taken');
  // (a room for the first message only: the second waits for the next drain)
  s.last().receive(a); s.last().receive(b);
  assert.equal(link.drain(heap, 0, 4 + a.length + 4 + b.length - 1), 4 + a.length);
  assert.deepEqual(drainAll(link).map((m) => [...m]), [[...b]]);
  // (a message bigger than the engine's room is dropped, the next ones still come)
  s.last().receive(serverRecord(0x8E, 255, new Array(200).fill(7))); s.last().receive(a);
  assert.deepEqual(drainAll(link, 64).map((m) => [...m]), [[...a]]);
  assert.equal(link.stats().droppedMessages, 1);
  // (a coalesced message stays whole: the engine walks its records)
  s.last().receive(a, b);
  assert.deepEqual(drainAll(link).map((m) => m.length), [a.length + b.length]);
  // (a large length is written little-endian on four bytes)
  const big = serverRecord(0x8E, 255, new Array(70000 - 4).fill(1));
  s.last().receive(big);
  const h = new Uint8Array(80000); assert.equal(link.drain(h, 0, 80000), 70004);
  assert.deepEqual([...h.subarray(0, 4)], [70000 & 255, (70000 >> 8) & 255, 70000 >> 16, 0]);
});

test('mmo link: over 8 MB waiting, everything waiting is dropped and the engine told once (-1)', () => {
  const { s, link, logs } = setup();
  link.open(); s.last().accept();
  const chunk = serverRecord(0x21, 2, new Array(60000).fill(1));
  for (let i = 0; i < Math.ceil(LIMITS.inbound / chunk.length) + 1; i++) s.last().receive(chunk);
  assert.equal(link.stats().overflows, 1);
  assert.ok(logs.some((l) => /resynchronises/.test(l)));
  assert.equal(link.drain(new Uint8Array(16), 0, 16), -1);
  assert.equal(drainAll(link).length, 1, 'only what came after the overflow');
  s.last().receive(serverRecord(0x87, 255, [1]));
  assert.equal(drainAll(link).length >= 1, true);
  assert.equal(link.drain(new Uint8Array(16), 0, 16), 0, 'told once');
});

test('mmo link: an unexpected close reconnects with backoff, then LINK_RESET reaches the engine before anything new', () => {
  const { c, s, link, states } = setup();
  link.open(); s.last().accept(); link.send(HELLO);
  s.last().receive(serverRecord(RECORD.WELCOME, 255, [0]));
  assert.equal(link.joined(), true);
  s.last().fail();
  assert.equal(link.state(), LINK.WAITING); assert.equal(link.joined(), false);
  assert.equal(link.send(clientRecord(0x0A, [1, 65])), false, 'nothing kept for a session that ended');
  c.advance(BACKOFF_MS[0] - 1); assert.equal(s.all.length, 1);
  c.advance(1); assert.equal(s.all.length, 2, 'again after 1 s');
  assert.equal(link.state(), LINK.WAITING, 'reconnecting is still waiting');
  // (failures in a row: 2, 4, 8, then every 15 s)
  for (const [i, ms] of [[3, 2000], [4, 4000], [5, 8000], [6, 15000], [7, 15000]]) {
    s.last().fail(); c.advance(ms - 1); assert.equal(s.all.length, i - 1); c.advance(1); assert.equal(s.all.length, i, `after ${ms} ms`);
  }
  s.last().accept();
  assert.equal(link.state(), LINK.OPEN);
  assert.equal(link.send(clientRecord(0x20, [1]), true), false, 'held until the engine took LINK_RESET');
  assert.equal(link.send(HELLO), false);
  s.last().receive(serverRecord(0x87, 255, [2]));
  c.advance(LIMITS.heartbeatMs); assert.equal(s.last().sent.length, 0, 'no PING before the engine speaks');
  const got = drainAll(link);
  assert.deepEqual(got.map((m) => [...m]), [[...serverRecord(RECORD.WELCOME, 255, [0])], [2, 0, 0xFE, 255], [...serverRecord(0x87, 255, [2])]],
    'the old connection\'s messages not taken yet, LINK_RESET, then the new connection\'s');
  assert.equal(link.send(HELLO), true, 'then the engine speaks');
  assert.deepEqual(s.last().records().map((r) => r.type), [0x01]);
  assert.deepEqual(states, [[LINK.CONNECTING, false], [LINK.OPEN, false], [LINK.OPEN, true], [LINK.WAITING, true], [LINK.WAITING, false], [LINK.OPEN, false]],
    'joined; the connection lost while in the world (told before the world goes); one wait however many attempts; open again');
  // (a connection that lasted starts the backoff over)
  c.advance(LIMITS.stableMs); s.last().fail();
  c.advance(BACKOFF_MS[0]); assert.equal(s.all.length, 8);
});

test('mmo link: the first connection failing reconnects too; its queued HELLO is dropped and LINK_RESET asks again', () => {
  const { c, s, link } = setup();
  link.open(); link.send(HELLO);
  s.last().fail();
  assert.equal(link.state(), LINK.WAITING);
  c.advance(BACKOFF_MS[0]); s.last().accept();
  assert.equal(s.last().sent.length, 0, 'the first connection\'s queue went with it');
  assert.deepEqual(drainAll(link).map((m) => m[2]), [RECORD.LINK_RESET]);
});

test('mmo link: REFUSED stops the reconnection until open() again; the engine still gets the record', () => {
  const { c, s, link } = setup();
  link.open(); s.last().accept(); link.send(HELLO);
  s.last().receive(refusedRecord(1, 'sign-in'));
  assert.equal(link.state(), LINK.REFUSED);
  assert.equal(link.refusal(), 1); assert.equal(link.refusalDetail(), 'sign-in');
  assert.equal(s.last().closedWith, 1000, 'closed from here too');
  c.advance(120000); assert.equal(s.all.length, 1, 'no reconnection');
  const got = drainAll(link);
  assert.deepEqual([got[0][2], got[0][4]], [RECORD.REFUSED, 1]);
  assert.equal(link.send(HELLO), false);
  assert.equal(link.open(), LINK.CONNECTING, 'a new start');
  assert.equal(link.refusal(), 0);
  s.last().accept();
  assert.equal(drainAll(link), 0, 'no LINK_RESET: a first connection');
  // (a refusal after a server restart: the reconnection stops there)
  link.send(HELLO); s.last().fail(); c.advance(BACKOFF_MS[0]); s.last().accept();
  s.last().receive(refusedRecord(5, ''));
  assert.equal(link.state(), LINK.REFUSED); assert.equal(link.refusal(), 5);
  c.advance(60000); assert.equal(s.all.length, 3);
});

test('mmo link: PING every 15 s once the engine spoke, with the page clock; from traffic too when timers lag', () => {
  const { c, s, link } = setup();
  link.open(); s.last().accept();
  c.advance(LIMITS.heartbeatMs * 2); assert.equal(s.last().sent.length, 0, 'the engine opens the protocol');
  link.send(HELLO);
  c.advance(LIMITS.heartbeatMs);
  const pings = () => s.last().records().filter((r) => r.type === RECORD.PING);
  assert.equal(pings().length, 1);
  assert.equal(new DataView(pings()[0].body.buffer, pings()[0].body.byteOffset).getFloat64(0, true), c.now());
  c.advance(LIMITS.heartbeatMs * 2); assert.equal(pings().length, 3);
  // (timers that never fire — a hidden tab's: the server's messages carry the beat)
  const s2 = fakeSockets(); let now = 0;
  const lagging = createMmoLink({ url: 'ws://x', WebSocketImpl: s2.FakeSocket, now: () => now, timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} } });
  lagging.open(); s2.last().accept(); lagging.send(HELLO);
  now = 10000; s2.last().receive(serverRecord(0x20, 1, [0]));
  assert.equal(s2.last().records().length, 1);
  now = 15000; s2.last().receive(serverRecord(0x20, 1, [0]));
  assert.deepEqual(s2.last().records().map((r) => r.type), [0x01, RECORD.PING]);
  link.close(); assert.equal(c.pending(), 0, 'no timer left after close');
});

test('mmo link: away is sent at once, again with each beat while away, and never before the engine spoke', () => {
  const { c, s, link } = setup();
  link.open(); s.last().accept();
  link.away(true);
  assert.equal(s.last().sent.length, 0);
  link.send(HELLO);
  c.advance(LIMITS.heartbeatMs);
  const beat = s.last().records();
  assert.deepEqual(beat.map((r) => r.type), [0x01, RECORD.PING, RECORD.AWAY], 'the beat: PING then AWAY again');
  assert.deepEqual([...beat[2].body], [1, 1], 'source 1 (the page), away');
  assert.equal(s.last().sent.length, 2, 'PING and AWAY in one message');
  link.away(true); assert.equal(s.last().records().length, 3, 'unchanged: not sent again at once');
  link.away(false);
  assert.deepEqual([...s.last().sent.at(-1)], [3, 0, RECORD.AWAY, 1, 0]);
  c.advance(LIMITS.heartbeatMs);
  assert.equal(s.last().records().at(-1).type, RECORD.PING, 'not away: PING alone');
  link.away(true);
  assert.deepEqual([...s.last().sent.at(-1)], [3, 0, RECORD.AWAY, 1, 1]);
  assert.equal(link.stats().away, true);
});

test('mmo link: WELCOME and LEFT tell whether a world is joined', () => {
  const { s, link, states } = setup();
  link.open(); s.last().accept(); link.send(HELLO);
  s.last().receive(serverRecord(0x81, 255, [0]), serverRecord(RECORD.WELCOME, 255, [3]));
  assert.equal(link.joined(), true);
  s.last().receive(serverRecord(RECORD.LEFT, 255));
  assert.equal(link.joined(), false);
  assert.deepEqual(states, [[LINK.CONNECTING, false], [LINK.OPEN, false], [LINK.OPEN, true], [LINK.OPEN, false]]);
});

test('mmo link: close() forgets everything and stays closed; drop() reconnects as after a network failure', () => {
  const { c, s, link } = setup();
  link.open(); s.last().accept(); link.send(HELLO);
  s.last().receive(serverRecord(0x81, 255, [0]));
  link.drop();
  assert.equal(link.state(), LINK.WAITING);
  c.advance(BACKOFF_MS[0]); s.last().accept();
  assert.equal(link.state(), LINK.OPEN);
  link.close();
  assert.equal(link.state(), LINK.CLOSED);
  assert.equal(s.last().closedWith, 1000);
  assert.equal(link.drain(new Uint8Array(64), 0, 64), 0, 'nothing waits after close');
  c.advance(120000); assert.equal(s.all.length, 2, 'no reconnection');
  assert.equal(link.send(HELLO), false);
  link.close(); assert.equal(link.state(), LINK.CLOSED, 'twice: harmless');
  assert.equal(link.open(), LINK.CONNECTING); assert.equal(s.all.length, 3);
});

test('mmo link: a socket that cannot be made is retried like a failed connection', () => {
  const c = clock(); let made = 0;
  class Throwing { constructor() { made++; throw new Error('bad url'); } }
  const link = createMmoLink({ url: 'ws://x', WebSocketImpl: Throwing, now: c.now, timers: c.timers });
  link.open(); assert.equal(link.state(), LINK.WAITING); assert.equal(made, 1);
  c.advance(BACKOFF_MS[0]); assert.equal(made, 2);
  link.close(); c.advance(60000); assert.equal(made, 2);
});

test('mmo link: over a real WebSocket to the server\'s own socket code (lan.js acceptWebSocket)', async (t) => {
  const http = await import('node:http');
  const { acceptWebSocket } = await import('../src/host/lan.js');
  const peers = [], got = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const peer = acceptWebSocket(req, socket, (msg) => {
      got.push([...msg]);
      if (msg[2] === 0x01) peer.send(Buffer.from(concat([serverRecord(0x81, 255, [0, 8]), serverRecord(RECORD.WELCOME, 255, [1])])));
    }, () => {}, () => {});
    peers.push(peer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const p of peers) p.close(); server.close(); });
  const link = createMmoLink({ url: `ws://127.0.0.1:${server.address().port}/api/mmo/x/ws` });
  t.after(() => link.close());
  const waitFor = async (what, ms = 5000) => { const end = Date.now() + ms; while (!what()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
  const take = () => drainAll(link) || [];
  link.open(); link.send(HELLO);
  await waitFor(() => link.joined());
  assert.deepEqual(got[0], [...HELLO], 'the HELLO queued while connecting went first');
  assert.deepEqual(take().map((m) => m.length), [11], 'one message, its two records');
  // (a large send cut between records: the server takes each part)
  const big = concat(Array.from({ length: 20 }, (_, i) => clientRecord(0x23, new Uint8Array(4000).fill(i))));
  assert.equal(link.send(big), true);
  await waitFor(() => got.length >= 3);
  assert.equal(got.slice(1).reduce((n, m) => n + m.length, 0), big.length); assert.ok(got.slice(1).every((m) => m.length <= LIMITS.message));
  // (the server's side gone: the page reconnects after 1 s, LINK_RESET reaches the engine, the engine says HELLO again)
  peers[0].socket.destroy();
  await waitFor(() => link.state() === LINK.WAITING);
  await waitFor(() => link.state() === LINK.OPEN, 4000);
  assert.deepEqual(take().map((m) => m[2]), [RECORD.LINK_RESET]);
  link.send(HELLO);
  await waitFor(() => link.joined());
  // (a refusal: the socket closes, no reconnection)
  peers[1].send(Buffer.from(refusedRecord(5, 'joined elsewhere')));
  await waitFor(() => link.state() === LINK.REFUSED);
  assert.equal(link.refusalDetail(), 'joined elsewhere');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(peers.length, 2, 'no new connection after the refusal');
  link.close();
});
