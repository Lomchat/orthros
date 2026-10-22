// The page and its game worker share these: the control words and the input ring in SharedArrayBuffers, the input
// events' encoding, the audio ring's size and rate. Their own module, without the host's graph (browser-host.js,
// frame accounting, PNG): the page (src/host/web/main.js) imports them at its first load, home included.
export const CTL = { IN_HEAD: 0, IN_TAIL: 1, WAKE: 2, STOP: 3, AUDIO_WRITE: 4, AUDIO_READ: 5, AUDIO_UNDERRUNS: 6, POINTER_LOCK: 7, FOCUS: 8, SIZE: 64 };
export const IN_RING = 4096; // int32 slots (4 per event)
// (MOUSEREL: a captured mouse's motion — a, b the device counts (movementX/Y), c the cursor's motion in screen pixels
// packed as two int16 (y high), the type word's bits 8+ the page's sequence number of the move. A button event's `a`
// with BUTTON_AT_CURSOR: pressed where the guest cursor is — the captured mouse's position is the guest's)
export const EV = { MOUSEMOVE: 1, MOUSEDOWN: 2, MOUSEUP: 3, WHEEL: 4, KEYDOWN: 5, KEYUP: 6, CHAR: 7, FOCUS: 8, MOUSEREL: 9 };
export const BUTTON_AT_CURSOR = 0x100;
/**
 * One input ring entry as the window manager's event (user32.js inputEvent), or null.
 * @param {number} word the type word (type in bits 0-7, a sequence number above)
 */
export function decodeInput(word, a, b, c) {
  switch (word & 0xff) {
    case EV.MOUSEMOVE: return { type: 'mousemove', x: a, y: b, dx: (c << 16) >> 16, dy: c >> 16 };
    case EV.MOUSEREL: return { type: 'mousemove', rel: true, dx: a, dy: b, gdx: (c << 16) >> 16, gdy: c >> 16, seq: word >>> 8 };
    case EV.MOUSEDOWN: case EV.MOUSEUP: { const ev = { type: (word & 0xff) === EV.MOUSEDOWN ? 'mousedown' : 'mouseup', button: a & 0xff, x: b, y: c }; if (a & BUTTON_AT_CURSOR) ev.rel = true; return ev; }
    case EV.WHEEL: return { type: 'wheel', delta: a / 120, x: b, y: c };
    case EV.KEYDOWN: return { type: 'keydown', vk: a, scan: b & 0xff, extended: (b & 0x100) !== 0, repeat: c };
    case EV.KEYUP: return { type: 'keyup', vk: a, scan: b & 0xff, extended: (b & 0x100) !== 0 };
    case EV.CHAR: return { type: 'char', code: a };
    case EV.FOCUS: return { type: 'focus', focused: a !== 0 };
  }
  return null;
}
export const AUDIO_RING_FRAMES = 16384; // stereo frames
export const AUDIO_RATE = 44100;

