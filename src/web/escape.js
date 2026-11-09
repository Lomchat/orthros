// Escape and the captured mouse, the same for every game's page (the Windows runtime, the browser ports): the first
// Escape goes to the game, the next one frees the mouse (the owner's rule: a game's own Escape — its menu, closing a
// window — must not cost the mouse).
// In full screen the keyboard is locked (shell.js lockKeys): Escape reaches the page while the mouse stays captured, so
// the page decides — the first press passes to the game, the next is kept from it and frees the mouse (a press with the
// mouse free goes to the game; holding Escape still leaves full screen). Out of full screen the browser frees the mouse
// at the first press and keeps the key from the page — a rule no page can change (checked with real key presses,
// Chrome 153): the game is sent that Escape all the same, and a click in the game captures the mouse again.

const KEY = { key: 'Escape', code: 'Escape', keyCode: 27 };

/**
 * Escape's rule for the game in `win` (this page's window, or a same-origin frame's: the engine page of a port).
 * @param {Window} win
 * @returns {{ sent: number }} (how many Escapes were sent to the game for the browser — for tests)
 */
export function escapeToGame(win = window) {
  const doc = win.document, out = { sent: 0 };
  if (win.__orthrosEscape) return win.__orthrosEscape;
  win.__orthrosEscape = out;
  let armed = false, keepUp = false, lastDown = -1e9, ours = -1e9, screenChange = -1e9;
  // (the mouse freed by a page's own code — the game's menu, a question of the page — is no Escape)
  const proto = win.Document.prototype, exit = proto.exitPointerLock;
  proto.exitPointerLock = function (...args) { ours = win.performance.now(); return exit.apply(this, args); };
  win.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !e.isTrusted) return;
    lastDown = win.performance.now();
    if (e.repeat) return;
    if (!doc.pointerLockElement) { armed = false; return; }
    if (!armed) { armed = true; return; }   // (the first: the game's)
    e.preventDefault(); e.stopImmediatePropagation();
    armed = false; keepUp = true;
    doc.exitPointerLock();
  }, true);
  win.addEventListener('keyup', (e) => {
    if (e.key !== 'Escape' || !keepUp) return;
    keepUp = false; e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  const screen = () => { screenChange = win.performance.now(); };
  doc.addEventListener('fullscreenchange', screen);
  try { if (win.top !== win) win.top.document.addEventListener('fullscreenchange', screen); } catch { /* another origin */ }
  doc.addEventListener('pointerlockchange', () => {
    if (doc.pointerLockElement) { armed = false; return; }
    const at = win.performance.now();
    if (at - ours < 500) return;
    // (the browser freed it: an Escape it kept from the page — unless the page got the key, the window lost the focus,
    // the tab was left or full screen was left by holding Escape)
    setTimeout(() => {
      let full = false; try { full = !!(doc.fullscreenElement || win.top.document.fullscreenElement); } catch { /* another origin */ }
      if (doc.pointerLockElement || full || lastDown > at - 400 || screenChange > at - 1500 || doc.visibilityState !== 'visible' || !doc.hasFocus()) return;
      press(win); out.sent++;
    }, 120);
  });
  return out;
}

/** An Escape press and release, as the game's keyboard handlers read them. */
function press(win) {
  const target = win.document.activeElement ?? win.document.body;
  for (const [type, delay] of [['keydown', 0], ['keyup', 80]]) {
    setTimeout(() => {
      const e = new win.KeyboardEvent(type, { key: KEY.key, code: KEY.code, bubbles: true, cancelable: true, view: win });
      for (const name of ['keyCode', 'which']) Object.defineProperty(e, name, { get: () => KEY.keyCode });
      target.dispatchEvent(e);
    }, delay);
  }
}
