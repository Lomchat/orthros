// The page's end of a shared world (a game's "MMO": the server's hub, src/host/mmo.js; docs/mmo.md, sections 5 and 6):
// one WebSocket to /api/mmo/<version>/ws, between an engine that builds and reads every record of the world and the
// server that relays them. The page knows no game: it moves whole messages both ways and adds only its own records —
// PING every 15 s (the server closes a peer silent 45 s, the proxies an idle socket), AWAY when the tab is hidden —;
// it reads only REFUSED (no reconnection after it) and WELCOME / LEFT (whether a world is joined, for the page's
// indicators). Any runtime may use it: the engine reaches it through an object of the page (re3: Module.orthrosNet,
// src/ports/re3/play.js) and calls it without waiting (EM_JS).
//
// Wire (little-endian): a client record is `u16 len | u8 type | body` (len counts type + body), a server record
// `u16 len | u8 type | u8 from | body`; one WebSocket binary message holds one or more records.
//
// The link:
//   open()  connects (idempotent while connecting, open or waiting to reconnect); after an unexpected close it connects
//           again by itself after 1, 2, 4, 8 then every 15 s (the count starts over after a connection that lasted
//           10 s), and once a new connection is open it puts the LINK_RESET pseudo-record (`u16 2 | u8 0xFE | u8 255`)
//           in the engine's queue: the engine says HELLO (and joins) again. Until the engine has drained that record,
//           what it sends is dropped (it belongs to the session that ended), and the page's own records wait for the
//           engine's first record on each connection (the protocol opens with the engine's HELLO).
//   state() 0 closed, 1 connecting (the first connection after open()), 2 open, 3 refused (a REFUSED record came: no
//           reconnection until open() again; refusal() its reason, refusalDetail() its text), 4 the connection was
//           lost: waiting to reconnect, or reconnecting.
//   send(bytes, unreliable) one or more client records → true when sent or queued. Unreliable data (states) is
//           dropped while the socket's bufferedAmount is over 256 KB, or when not open; reliable data is sent, or
//           queued while connecting (state 1, 1 MB at most; the queue is dropped if that connection fails). Over 64 KB
//           the bytes go in several messages, cut between records (the server closes on a bigger message).
//   drain(heapU8, ptr, cap) the server's messages received since, into the engine's memory: each as `u32 length |
//           message`, whole messages only (one bigger than `cap` is dropped); returns the bytes written, 0 when none,
//           -1 once after an overflow (over 8 MB waited: everything waiting was dropped — the engine resynchronises).
//   away(bool) the page's source of AWAY (the tab hidden); sent at once, and again with each heartbeat while away (the
//           server takes it as a state, not an event).
//   close() closes and forgets everything waiting (both ways), the refusal included: state 0.
//   drop()  (tests) closes the socket as a network failure would: the link reconnects as after a real one.
//   joined() whether a WELCOME came on the current connection and no LEFT since; stats() counters.
// onState(state, link) is called at every change of state() or joined() (a lost connection: state 4 first, joined()
// still telling whether a world was joined, then joined() false).

/** state() values */
export const LINK = Object.freeze({ CLOSED: 0, CONNECTING: 1, OPEN: 2, REFUSED: 3, WAITING: 4 });
/** record types the page writes or reads (docs/mmo.md, section 5) */
export const RECORD = Object.freeze({ PING: 0x07, AWAY: 0x08, REFUSED: 0x80, WELCOME: 0x85, LEFT: 0x86, LINK_RESET: 0xFE });
/** AWAY's source for the page (the engine's own is 0: its pause menu) */
export const AWAY_SOURCE_PAGE = 1;
export const LIMITS = Object.freeze({
  unreliableBuffered: 256 << 10, // bufferedAmount over which unreliable data is dropped
  connectingQueue: 1 << 20,      // reliable bytes kept while the first connection opens
  inbound: 8 << 20,              // received bytes waiting for the engine before an overflow
  message: 64 << 10,             // the largest message sent (the server's limit)
  heartbeatMs: 15000,
  stableMs: 10000,               // a connection that lasted this long starts the backoff over
});
export const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000]);

/** The LINK_RESET pseudo-record, as the server's records are framed (from 255: the server). */
export const linkResetRecord = () => Uint8Array.of(2, 0, RECORD.LINK_RESET, 255);
/** A client record: `u16 len | u8 type | body`. */
export function clientRecord(type, body = []) {
  const out = new Uint8Array(3 + body.length);
  out[0] = (body.length + 1) & 255; out[1] = (body.length + 1) >> 8; out[2] = type; out.set(body, 3);
  return out;
}
/** PING with the page's clock (the engine's own clock too: performance.now(), so a PONG is a valid sample for it). */
export function pingRecord(clientMs) {
  const out = clientRecord(RECORD.PING, new Uint8Array(8));
  new DataView(out.buffer).setFloat64(3, clientMs, true);
  return out;
}
export const awayRecord = (away) => clientRecord(RECORD.AWAY, [AWAY_SOURCE_PAGE, away ? 1 : 0]);

/**
 * The server records of one message: { type, from, body } each (a truncated record ends the walk).
 * @param {Uint8Array} bytes
 */
export function serverRecords(bytes) {
  const out = [];
  for (let o = 0; o + 4 <= bytes.length;) {
    const len = bytes[o] | (bytes[o + 1] << 8);
    if (len < 2 || o + 2 + len > bytes.length) break;
    out.push({ type: bytes[o + 2], from: bytes[o + 3], body: bytes.subarray(o + 4, o + 2 + len) });
    o += 2 + len;
  }
  return out;
}
/** REFUSED's body: u8 reason, str8 detail. */
export function parseRefused(body) {
  const reason = body[0] ?? 0, n = body[1] ?? 0;
  let detail = '';
  for (let i = 0; i < n && 2 + i < body.length; i++) detail += String.fromCharCode(body[2 + i]);
  return { reason, detail };
}
/**
 * `bytes` (client records) cut in messages of `max` bytes at most, between records; a record bigger than `max` goes
 * alone; bytes that do not parse as records go whole.
 */
export function splitRecords(bytes, max = LIMITS.message) {
  if (bytes.length <= max) return [bytes];
  const out = [];
  let start = 0, o = 0;
  while (o < bytes.length) {
    const size = o + 2 <= bytes.length ? Math.min(2 + (bytes[o] | (bytes[o + 1] << 8)), bytes.length - o) : bytes.length - o;
    if (o > start && o + size - start > max) { out.push(bytes.subarray(start, o)); start = o; }
    o += size;
  }
  if (o > start) out.push(bytes.subarray(start, o));
  return out;
}

/**
 * @param {{ url: string | URL, log?: (line: string) => void, onState?: (state: number, link: object) => void,
 *   WebSocketImpl?: any, now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function } }} o
 */
export function createMmoLink({ url, log = () => {}, onState = () => {}, WebSocketImpl = globalThis.WebSocket, now = () => performance.now(), timers = globalThis }) {
  let st = LINK.CLOSED, refusal = 0, detail = '', isJoined = false;
  /** the current socket; sockets made since open() (the first gets no LINK_RESET); failures in a row (the backoff) */
  let ws = null, sockets = 0, failures = 0, openedAt = 0, retryTimer = null, beatTimer = null;
  /** reliable bytes waiting for the first connection */
  let outQueue = [], outBytes = 0;
  /** messages waiting for the engine; whether an overflow is to be told */
  let inQueue = [], inBytes = 0, overflow = false;
  /** the LINK_RESET record waiting in inQueue (the engine's sends are dropped until it takes it) */
  let resetRecord = null;
  /** the engine sent on this connection (the page's records may follow); the page's away; the last PING */
  let spoke = false, awayNow = false, lastBeat = -Infinity;
  const counts = { sent: 0, sentBytes: 0, received: 0, receivedBytes: 0, dropped: 0, droppedMessages: 0, overflows: 0, connections: 0, refusals: 0 };
  let link = null;

  const tell = () => { try { onState(st, link); } catch (e) { log(`state handler: ${e?.message ?? e}`); } };
  const setState = (s) => { if (s === st) return; st = s; tell(); };
  const setJoined = (j) => { if (j === isJoined) return; isJoined = j; tell(); };
  const stopTimers = () => {
    if (retryTimer !== null) { timers.clearTimeout(retryTimer); retryTimer = null; }
    if (beatTimer !== null) { timers.clearInterval(beatTimer); beatTimer = null; }
  };
  function write(bytes) {
    for (const part of splitRecords(bytes)) { ws.send(part); counts.sent++; counts.sentBytes += part.length; }
  }
  function enqueueIn(bytes) {
    inQueue.push(bytes); inBytes += bytes.length;
    if (inBytes <= LIMITS.inbound) return;
    log(`more than ${LIMITS.inbound >> 20} MB waited for the engine: dropped, the engine resynchronises`);
    inQueue = []; inBytes = 0; overflow = true; counts.overflows++;
    if (resetRecord) { inQueue.push(resetRecord); inBytes = resetRecord.length; } // (the engine must still learn the session ended)
  }
  /** the page's own records: PING, and AWAY again while away */
  function beat() {
    if (st !== LINK.OPEN || !ws || !spoke || resetRecord) return;
    lastBeat = now();
    const ping = pingRecord(lastBeat);
    if (!awayNow) { write(ping); return; }
    const both = new Uint8Array(ping.length + 5); both.set(ping); both.set(awayRecord(true), ping.length);
    write(both);
  }

  function connect() {
    const first = sockets === 0;
    sockets++;
    setState(first ? LINK.CONNECTING : LINK.WAITING);
    let socket;
    try { socket = new WebSocketImpl(String(url)); } catch (e) { log(`cannot connect: ${e?.message ?? e}`); ws = null; retry(); return; }
    ws = socket; spoke = false; openedAt = 0;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (socket !== ws) return;
      openedAt = now(); counts.connections++;
      if (!first) { resetRecord = linkResetRecord(); enqueueIn(resetRecord); }
      setState(LINK.OPEN);
      if (outQueue.length) { const q = outQueue; outQueue = []; outBytes = 0; for (const bytes of q) write(bytes); spoke = true; }
      lastBeat = now();
      beatTimer = timers.setInterval(beat, LIMITS.heartbeatMs);
    };
    socket.onmessage = (event) => {
      if (socket !== ws) return;
      const data = event.data;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : null;
      if (!bytes) return; // (text: none in this protocol)
      counts.received++; counts.receivedBytes += bytes.length;
      let refused = null;
      for (const r of serverRecords(bytes)) {
        if (r.type === RECORD.REFUSED) refused = parseRefused(r.body);
        else if (r.type === RECORD.WELCOME) setJoined(true);
        else if (r.type === RECORD.LEFT) setJoined(false);
      }
      enqueueIn(bytes);
      // (a hidden tab's timers may wait a minute: its traffic keeps the beat too)
      if (now() - lastBeat >= LIMITS.heartbeatMs) beat();
      if (refused) {
        refusal = refused.reason || 6; detail = refused.detail; counts.refusals++;
        log(`refused (${refusal}${detail ? `: ${detail}` : ''})`);
        stopTimers(); setState(LINK.REFUSED); setJoined(false);
        try { socket.close(1000); } catch { /* closing */ }
      }
    };
    socket.onerror = () => {}; // (its close follows)
    socket.onclose = (event) => {
      if (socket !== ws) return;
      ws = null;
      if (beatTimer !== null) { timers.clearInterval(beatTimer); beatTimer = null; }
      outQueue = []; outBytes = 0;
      if (st === LINK.REFUSED || st === LINK.CLOSED) { setJoined(false); return; }
      const lasted = openedAt ? now() - openedAt : 0;
      if (lasted >= LIMITS.stableMs) failures = 0;
      log(`connection ${openedAt ? `lost after ${Math.round(lasted / 1000)} s` : 'failed'} (${event?.code ?? '?'}${event?.reason ? ` ${event.reason}` : ''})`);
      retry(); setJoined(false); // (state 4 told while joined() still says whether a world was lost with it)
    };
  }
  function retry() {
    const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
    failures++;
    setState(LINK.WAITING);
    retryTimer = timers.setTimeout(() => { retryTimer = null; if (st === LINK.WAITING && !ws) connect(); }, delay);
  }

  link = {
    open() {
      if (st === LINK.CONNECTING || st === LINK.OPEN || st === LINK.WAITING) return st;
      refusal = 0; detail = ''; sockets = 0; failures = 0;
      connect();
      return st;
    },
    close() {
      stopTimers();
      const socket = ws; ws = null;
      if (socket) { try { socket.close(1000); } catch { /* closing */ } }
      outQueue = []; outBytes = 0; inQueue = []; inBytes = 0; overflow = false; resetRecord = null;
      refusal = 0; detail = ''; spoke = false;
      setState(LINK.CLOSED); setJoined(false);
    },
    drop() { if (ws) { try { ws.close(4000, 'dropped'); } catch { /* closing */ } } },
    state: () => st,
    refusal: () => refusal,
    refusalDetail: () => detail,
    joined: () => isJoined,
    /** @param {Uint8Array} bytes @param {boolean} [unreliable] */
    send(bytes, unreliable = false) {
      if (!bytes?.length) return false;
      if (st === LINK.OPEN && ws) {
        if (resetRecord || (unreliable && ws.bufferedAmount > LIMITS.unreliableBuffered)) { counts.dropped++; return false; }
        write(bytes); spoke = true;
        return true;
      }
      if (st === LINK.CONNECTING && !unreliable && outBytes + bytes.length <= LIMITS.connectingQueue) {
        outQueue.push(bytes.slice()); outBytes += bytes.length;
        return true;
      }
      counts.dropped++;
      return false;
    },
    /** @param {Uint8Array} heap @param {number} ptr @param {number} cap */
    drain(heap, ptr, cap) {
      if (overflow) { overflow = false; return -1; }
      let p = ptr, i = 0;
      const end = ptr + cap;
      for (; i < inQueue.length; i++) {
        const m = inQueue[i], n = m.length;
        if (n + 4 > cap) { log(`a message of ${n} bytes is larger than the engine takes (${cap}): dropped`); counts.droppedMessages++; inBytes -= n; continue; }
        if (p + 4 + n > end) break;
        heap[p] = n & 255; heap[p + 1] = (n >>> 8) & 255; heap[p + 2] = (n >>> 16) & 255; heap[p + 3] = n >>> 24;
        heap.set(m, p + 4);
        p += 4 + n; inBytes -= n;
        if (m === resetRecord) resetRecord = null;
      }
      if (i) inQueue.splice(0, i);
      return p - ptr;
    },
    away(value) {
      const v = !!value;
      if (v === awayNow) return;
      awayNow = v;
      if (st === LINK.OPEN && ws && spoke && !resetRecord) write(awayRecord(v));
    },
    stats: () => ({ ...counts, state: st, queuedBytes: inBytes, queuedMessages: inQueue.length, away: awayNow }),
  };
  return link;
}
