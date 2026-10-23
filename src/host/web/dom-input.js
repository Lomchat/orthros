// Scripted input for a browser port's page (the bench suite, bench-suite.js): what BenchRun's steps do (bench.js
// ringInput: move, button, key, text — and a port's command, look, glide) as DOM events of the port's own window, those
// its engine listens to (SDL on Emscripten: keys on the window, the mouse on its canvas, a captured mouse's movement),
// constructed in that window's realm. Pointer coordinates are the canvas' CSS pixels (BenchRun scales the scenario's to
// the canvas' size: state.mode). Console commands and the debug teleport go to the port page's hooks
// (page-meter.js benchHooks: command(text), teleport(x, y, z)).
import { domKeyOfVk } from '../../win32/vk-scan.js';
import { benchHooks } from './page-meter.js';

/** the time a typed character's key is held, and between two characters (ms): an engine reading its keys once a frame sees each */
export const TYPE_HOLD_MS = 120, TYPE_GAP_MS = 240;
/** the period of a glide's teleports (ms) */
export const GLIDE_MS = 33;

/**
 * @param {() => Window | null} winOf the port's window now (a frame's page may be replaced)
 * @param {{ canvas?: (win: Window) => Element | null }} [o]
 */
export function domInput(winOf, o = {}) {
  const canvasOf = o.canvas ?? ((w) => w.document.querySelector('canvas'));
  const held = new Set(); let buttons = 0, glide = null, lastXY = [0, 0];
  const ctx = () => { const w = winOf(); if (!w) return null; let c = null; try { c = canvasOf(w); } catch { c = null; } return { w, c, d: w.document }; };
  const hooks = () => { try { return benchHooks(winOf()); } catch { return null; } };
  const keyEvent = (type, vk, extra = {}) => {
    const x = ctx(), k = domKeyOfVk(vk); if (!x || !k) return;
    const init = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true, composed: true, view: x.w, ...extra };
    const ev = new x.w.KeyboardEvent(type, init);
    // (keyCode / which: legacy fields some engines read — set when the constructor ignored them)
    if (ev.keyCode !== init.keyCode) { try { Object.defineProperty(ev, 'keyCode', { get: () => init.keyCode }); Object.defineProperty(ev, 'which', { get: () => init.keyCode }); } catch { /* read-only */ } }
    (x.c ?? x.d.activeElement ?? x.d.body ?? x.d).dispatchEvent(ev);
  };
  const mouseEvent = (type, x0, y0, extra = {}) => {
    const x = ctx(); if (!x?.c) return;
    const r = x.c.getBoundingClientRect(), clientX = r.left + x0, clientY = r.top + y0;
    const init = { clientX, clientY, screenX: clientX, screenY: clientY, bubbles: true, cancelable: true, composed: true, view: x.w, buttons, ...extra };
    const Ctor = type.startsWith('pointer') ? x.w.PointerEvent : x.w.MouseEvent;
    x.c.dispatchEvent(new Ctor(type, type.startsWith('pointer') ? { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init } : init));
  };
  return {
    move(x, y) { const dx = x - lastXY[0], dy = y - lastXY[1]; lastXY = [x, y]; mouseEvent('pointermove', x, y, { movementX: dx, movementY: dy }); mouseEvent('mousemove', x, y, { movementX: dx, movementY: dy }); },
    button(b, down, x, y) {
      this.move(x, y);
      const bit = b === 0 ? 1 : b === 1 ? 2 : 4, button = b === 1 ? 2 : b === 2 ? 1 : 0; // (BenchRun's 0 left, 1 right; the DOM's 0 left, 2 right)
      buttons = down ? buttons | bit : buttons & ~bit;
      mouseEvent(down ? 'pointerdown' : 'pointerup', x, y, { button });
      mouseEvent(down ? 'mousedown' : 'mouseup', x, y, { button });
      if (!down) mouseEvent(b === 1 ? 'contextmenu' : 'click', x, y, { button });
    },
    key(vk, scan, down) {
      if (down) { keyEvent('keydown', vk, { repeat: held.has(vk) }); held.add(vk); const k = domKeyOfVk(vk); if (k?.key.length === 1) keyEvent('keypress', vk, { charCode: k.key.charCodeAt(0) }); }
      else { held.delete(vk); keyEvent('keyup', vk); }
    },
    /** Typed one character after the other (an engine that reads its keys once a frame sees each one). */
    text(s) {
      let at = 0;
      for (const ch of String(s)) {
        const vk = /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : /[0-9]/.test(ch) ? ch.charCodeAt(0) : ch === ' ' ? 0x20 : 0;
        if (!vk) continue;
        setTimeout(() => this.key(vk, 0, true), at); setTimeout(() => this.key(vk, 0, false), at + TYPE_HOLD_MS); at += TYPE_GAP_MS;
      }
    },
    command(text) { hooks()?.command?.(text); },
    /** A captured mouse moved by dx, dy in `n` steps over `ms`. */
    look(dx, dy, n = 1, ms = 0) {
      const steps = Math.max(1, n | 0);
      for (let i = 0; i < steps; i++) setTimeout(() => mouseEvent('mousemove', lastXY[0], lastXY[1], { movementX: dx / steps, movementY: dy / steps }), (ms / steps) * i);
    },
    /** [x0, y0, vx, vy, z]: the player carried in a straight line by the port's teleport hook, until the next glide (none: stop). */
    glide(args) {
      if (glide) { clearInterval(glide); glide = null; }
      if (!args?.length) return;
      const [x0, y0, vx, vy, z] = args, t0 = performance.now();
      glide = setInterval(() => { const t = (performance.now() - t0) / 1000; try { hooks()?.teleport?.(x0 + vx * t, y0 + vy * t, z); } catch { /* the engine not there yet */ } }, GLIDE_MS);
    },
    /** Every key still held let go, the glide stopped (the bench ended). */
    release() { for (const vk of [...held]) this.key(vk, 0, false); if (glide) { clearInterval(glide); glide = null; } },
  };
}
