// Wire protocol of the shared worlds ("MMO"): constants and framing shared by the server's hub (src/host/mmo.js), the
// page's link (src/host/web/mmo-link.js) and the tests. No Node import: the page loads this file as it is.
//
// All little-endian. One WebSocket binary message = one or more records.
//   client -> server: u16 len | u8 type | body            (len counts type + body)
//   server -> client: u16 len | u8 type | u8 from | body  (len counts type + from + body; from = sender slot, 255 = server)
// Unknown types are ignored by both sides.

export const MMO_PROTOCOL = 1;

/** Client -> server record types. */
export const MMO_C = Object.freeze({
  HELLO: 0x01, CHAR_CREATE: 0x02, CHAR_SKIN: 0x03, CHAR_DELETE: 0x04, JOIN: 0x05, LEAVE: 0x06, PING: 0x07, AWAY: 0x08,
  CHAR_SAVE: 0x09, CHAT: 0x0a, WORLD_SET: 0x0b, WORLD_EVENT: 0x0c, LOCK: 0x0d, STORE: 0x0e, UNLOCK: 0x0f, OWN: 0x10,
  PLAYER_INFO: 0x11,
  // (realtime, relayed with the sender's slot in `from`)
  PLAYER_STATE: 0x20, ENTITY_STATE: 0x21, ENTITY_GONE: 0x22, EVENT: 0x23, TARGETED: 0x24,
});

/** Server -> client record types (0x20-0x24: the relayed client records, `from` = the sender's slot). */
export const MMO_S = Object.freeze({
  REFUSED: 0x80, LOBBY: 0x81, CHAR_RESULT: 0x82, WELCOME: 0x85, LEFT: 0x86, PONG: 0x87, CHAT: 0x8a, WORLD: 0x8b,
  DENIED: 0x8c, WORLD_EVENT: 0x8d, RECORD: 0x8e, OWNER: 0x90, PLAYER_JOIN: 0x91, PLAYER_AWAY: 0x92, PLAYER_LEAVE: 0x93,
  PLAYER_INFO: 0x94,
  // (made by the page's link only, into the engine's queue after a reconnection: u16 len=2 | u8 0xFE | u8 255)
  LINK_RESET: 0xfe,
});

/** REFUSED reasons (the socket closes after it). */
export const MMO_REFUSED = Object.freeze({ SIGN_IN: 1, NO_WORLD: 2, FULL: 3, PROTOCOL: 4, ELSEWHERE: 5, ERROR: 6 });
/** CHAR_RESULT statuses. */
export const MMO_RESULT = Object.freeze({ OK: 0, INVALID_NAME: 1, NAME_TAKEN: 2, TOO_MANY: 3, NOT_FOUND: 4, WORLD_FULL: 5, ERROR: 6, INVALID_SKIN: 7 });
/** DENIED reasons. */
export const MMO_DENIED = Object.freeze({ NOT_ADMIN: 1, RATE: 2, INVALID: 3 });

/** The server's id (`from` of the records it makes) and "nobody" (a free lock, an orphaned entity). */
export const MMO_NOBODY = 255;
/** A player's network id: 0xFFF00000 | slot (entities: (tag << 20) | counter, tag 1..0xFFE). */
export const mmoPlayerId = (slot) => (0xfff00000 | slot) >>> 0;

/** One client record (type, body bytes) framed: u16 len | u8 type | body. */
export function mmoClientRecord(type, body = new Uint8Array(0)) {
  const out = new Uint8Array(3 + body.length);
  const len = 1 + body.length;
  out[0] = len & 255; out[1] = len >> 8; out[2] = type; out.set(body, 3);
  return out;
}

/**
 * The server records of one message: [{ type, from, body }] (body: a view into `bytes`); a truncated last record is
 * left out.
 */
export function mmoServerRecords(bytes) {
  const out = [];
  for (let o = 0; o + 2 <= bytes.length;) {
    const len = bytes[o] | (bytes[o + 1] << 8);
    if (len < 2 || o + 2 + len > bytes.length) break;
    out.push({ type: bytes[o + 2], from: bytes[o + 3], body: bytes.subarray(o + 4, o + 2 + len) });
    o += 2 + len;
  }
  return out;
}
