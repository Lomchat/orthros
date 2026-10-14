// The page's mouse → the worker's input ring (browser-host.js EV), for every game alike.
//
// Captured (pointer lock): only relative motion exists. Each move goes as EV.MOUSEREL — the device counts
// (movementX/Y, unclamped: DirectInput's relative axes, a mouse-look camera) and the cursor's motion in screen pixels
// (movement / display scale, fractions carried over) — and the worker moves the guest cursor from where *it* is: a
// game re-centering the cursor with SetCursorPos every frame (mouse-look by warping) reads exactly the motion since
// its warp, and the cursor stops at the screen's / ClipCursor's edges (edge scrolling) while the device counts go on.
// The page only draws that cursor (#softcursor): its position is the worker's last report (`cursor-pos`, with the
// sequence number of the last move it had taken) plus the moves sent since.
//
// Free (no capture): the pointer's position over the game, clamped to the game's screen (the page's margins are the
// screen's edges: edge scrolling without capture); the device counts are the position's change only while the pointer
// stays over the game — none when it enters, leaves or moves in the margins (no huge jump after re-entering elsewhere,
// no motion stuck at an edge).
import { EV, BUTTON_AT_CURSOR } from '../browser-host.js';

/**
 * The cursor the page shows over the game: the guest's system cursor and nothing else (a game drawing its own cursor
 * sprite hides the system one — ShowCursor, SetCursor(NULL), an exclusive DirectInput mouse — so the page draws none:
 * never the browser's arrow over the game's sprite). `visible`: the guest's cursor shows (undefined before the worker
 * said: the arrow at start, as Windows). Uncaptured: the guest's shape as the CSS cursor; captured (pointer lock, no
 * CSS cursor exists): the page's soft cursor at the guest cursor's position.
 * @returns {{ css: 'none' | 'guest', soft: boolean }}
 */
export function cursorView(visible, captured) {
  if (visible === false) return { css: 'none', soft: false };
  return captured ? { css: 'none', soft: true } : { css: 'guest', soft: false };
}

const SEQ_MASK = 0xffffff;
const i16 = (v) => Math.max(-32768, Math.min(32767, Math.trunc(v)));
const pack = (x, y) => ((i16(y) & 0xffff) << 16) | (i16(x) & 0xffff);

export class PointerInput {
  /**
   * @param {(type: number, a: number, b: number, c: number) => void} push the input ring's writer
   * @param {() => { width: number, height: number }} mode the game's screen size
   */
  constructor(push, mode) {
    this.push = push; this.mode = mode;
    this.seq = 0; this.pending = []; // (captured moves not yet reported taken by the worker)
    this.fx = 0; this.fy = 0; // (sub-pixel remainders of the captured motion)
    this.vx = 0; this.vy = 0; this.reported = false; // the guest cursor as the page draws it (reported: by the worker once)
    this.lastX = 0; this.lastY = 0; this.inside = false; // (free pointer: the last position, over the game or not)
  }
  clampX(x) { return Math.max(0, Math.min(this.mode().width - 1, x)); }
  clampY(y) { return Math.max(0, Math.min(this.mode().height - 1, y)); }

  /** A captured move: movementX/Y (CSS pixels), the display scale (CSS pixels per screen pixel). */
  lockedMove(mx, my, scale = 1) {
    mx = Math.round(mx) || 0; my = Math.round(my) || 0;
    if (!mx && !my) return;
    const s = scale > 0 ? scale : 1;
    this.fx += mx / s; this.fy += my / s;
    const gdx = Math.trunc(this.fx), gdy = Math.trunc(this.fy);
    this.fx -= gdx; this.fy -= gdy;
    const seq = this.seq = (this.seq + 1) & SEQ_MASK;
    this.push(EV.MOUSEREL | (seq << 8), i16(mx), i16(my), pack(gdx, gdy));
    this.pending.push({ seq, gdx, gdy }); if (this.pending.length > 512) this.pending.shift();
    this.vx = this.clampX(this.vx + gdx); this.vy = this.clampY(this.vy + gdy);
  }
  /** The worker's guest cursor after the captured move `seq` (SetCursorPos warps and clipping included). */
  cursorReport(x, y, seq) {
    // (moves after `seq`: sent, not yet taken — the cursor drawn ahead by them; sequence numbers wrap at 24 bits)
    this.pending = this.pending.filter((p) => ((p.seq - seq) & SEQ_MASK) > 0 && ((p.seq - seq) & SEQ_MASK) < 0x800000);
    let vx = x, vy = y;
    for (const p of this.pending) { vx += p.gdx; vy += p.gdy; }
    this.vx = this.clampX(vx); this.vy = this.clampY(vy); this.reported = true;
  }
  /** Capture starts: the cursor drawn where the guest's is (its last report; else where the free pointer was). */
  locked() { if (!this.reported) { this.vx = this.lastX; this.vy = this.lastY; } this.fx = this.fy = 0; this.inside = false; }
  /** Capture ends: the free pointer's next move carries no motion (it reappears where the capture began). */
  unlocked() { this.inside = false; }

  /**
   * A free move: the pointer at screen pixel (x, y) of the game (unclamped: outside the game in the page's margins).
   * @returns {[number, number]} the clamped position sent
   */
  freeMove(x, y) {
    const inside = x >= 0 && y >= 0 && x < this.mode().width && y < this.mode().height;
    const cx = this.clampX(Math.round(x)), cy = this.clampY(Math.round(y));
    const dx = inside && this.inside ? cx - this.lastX : 0, dy = inside && this.inside ? cy - this.lastY : 0;
    this.inside = inside; this.lastX = cx; this.lastY = cy;
    this.push(EV.MOUSEMOVE, cx, cy, pack(dx, dy));
    return [cx, cy];
  }
  /** The free pointer left the page (or the window): its next move over the game carries no motion. */
  left() { this.inside = false; }

  /** A button (Windows numbering: 0 left, 1 right, 2 middle): captured, where the guest cursor is; else at (x, y). */
  button(down, b, locked, x = 0, y = 0) {
    if (locked) this.push(down ? EV.MOUSEDOWN : EV.MOUSEUP, b | BUTTON_AT_CURSOR, this.vx | 0, this.vy | 0);
    else { const cx = this.clampX(Math.round(x)), cy = this.clampY(Math.round(y)); this.push(down ? EV.MOUSEDOWN : EV.MOUSEUP, b, cx, cy); }
  }
}

/** A DOM MouseEvent's button as Windows numbers them (0 left, 1 right, 2 middle). */
export const winButton = (b) => (b === 2 ? 1 : b === 1 ? 2 : b);
