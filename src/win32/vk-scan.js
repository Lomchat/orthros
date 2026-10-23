// Virtual key -> keyboard scan code (PC AT set 1) for events that carry only a VK: DirectInput (dinput8.js) and the
// scripted input of the harness and of the page's bench player (src/host/scenario.js). No dependency: the page loads it.

/** virtual key -> scan code (bit 7: extended key) */
export const VK_TO_SCAN = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 9; i++) t[0x31 + i] = 0x02 + i; t[0x30] = 0x0b; // ('1'..'9' = 02..0A, '0' = 0B)
  const q = 'QWERTYUIOP'; for (let i = 0; i < q.length; i++) t[q.charCodeAt(i)] = 0x10 + i;
  const a = 'ASDFGHJKL'; for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = 0x1e + i;
  const z = 'ZXCVBNM'; for (let i = 0; i < z.length; i++) t[z.charCodeAt(i)] = 0x2c + i;
  Object.assign(t, { 0x1b: 0x01, 0x08: 0x0e, 0x09: 0x0f, 0x0d: 0x1c, 0x11: 0x1d, 0x10: 0x2a, 0x12: 0x38, 0x20: 0x39, 0x14: 0x3a, 0x70: 0x3b, 0x71: 0x3c, 0x72: 0x3d, 0x73: 0x3e, 0x74: 0x3f, 0x75: 0x40, 0x76: 0x41, 0x77: 0x42, 0x78: 0x43, 0x79: 0x44, 0x7a: 0x57, 0x7b: 0x58, 0x90: 0x45, 0x91: 0x46, 0x26: 0xc8, 0x28: 0xd0, 0x25: 0xcb, 0x27: 0xcd, 0x24: 0xc7, 0x23: 0xcf, 0x21: 0xc9, 0x22: 0xd1, 0x2d: 0xd2, 0x2e: 0xd3, 0xbd: 0x0c, 0xbb: 0x0d, 0xdb: 0x1a, 0xdd: 0x1b, 0xba: 0x27, 0xde: 0x28, 0xc0: 0x29, 0xdc: 0x2b, 0xbc: 0x33, 0xbe: 0x34, 0xbf: 0x35, 0xa0: 0x2a, 0xa1: 0x36, 0xa2: 0x1d, 0xa3: 0x9d, 0xa4: 0x38, 0xa5: 0xb8, 0x60: 0x52, 0x61: 0x4f, 0x62: 0x50, 0x63: 0x51, 0x64: 0x4b, 0x65: 0x4c, 0x66: 0x4d, 0x67: 0x47, 0x68: 0x48, 0x69: 0x49, 0x6a: 0x37, 0x6b: 0x4e, 0x6d: 0x4a, 0x6e: 0x53, 0x6f: 0xb5, 0x5b: 0xdb, 0x5c: 0xdc, 0x5d: 0xdd, 0x13: 0xc5, 0x2c: 0xb7 });
  return t;
})();

/**
 * The keyboard's scan code for a virtual key, as the key down / up events carry it (bit 8: extended key, E0 prefix);
 * 0 for keys without one. Scripted input (the harness) models a physical keyboard with it: DirectInput reads scan
 * codes only, so a key event without one is invisible to it (as synthesized input without a scan code on Windows).
 * @param {number} vk
 */
export function scanCodeOfVk(vk) { const d = VK_TO_SCAN[vk & 0xff]; return d >= 0x80 ? 0x100 | (d & 0x7f) : d; }

/** DOM KeyboardEvent.code -> virtual key, for the codes that are not a letter, a digit, a numpad digit or F1-F24 */
export const CODE_TO_VK = { Escape: 0x1b, Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5, Pause: 0x13, CapsLock: 0x14, Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e, MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d, NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f, NumLock: 0x90, ScrollLock: 0x91, Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde };

/** The virtual key of a DOM KeyboardEvent.code (the page's keys to the guest), 0 for an unknown one. */
export function vkOfCode(c) {
  if (CODE_TO_VK[c] !== undefined) return CODE_TO_VK[c];
  if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3);
  if (/^Digit[0-9]$/.test(c)) return c.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(c)) return 0x60 + Number(c[6]);
  if (/^F([0-9]+)$/.test(c)) return 0x70 + Number(c.slice(1)) - 1;
  return 0;
}

const KEY_NAMES = { Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter', Space: ' ', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowRight: 'ArrowRight', ArrowDown: 'ArrowDown', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete', Pause: 'Pause', CapsLock: 'CapsLock' };
/**
 * A virtual key as a DOM keyboard event's fields (the scripted input of the browser ports' bench, dom-input.js):
 * { code, key, keyCode } — keyCode the generic virtual key (VK_SHIFT for either Shift, as browsers report it); null for
 * a virtual key without a DOM code here.
 */
export function domKeyOfVk(vk) {
  const generic = { 0x10: 'ShiftLeft', 0x11: 'ControlLeft', 0x12: 'AltLeft' }[vk];
  let code = generic ?? null;
  if (!code) for (const [c, v] of Object.entries(CODE_TO_VK)) if (v === vk) { code = c; break; }
  if (!code && vk >= 0x41 && vk <= 0x5a) code = 'Key' + String.fromCharCode(vk);
  if (!code && vk >= 0x30 && vk <= 0x39) code = 'Digit' + String.fromCharCode(vk);
  if (!code && vk >= 0x60 && vk <= 0x69) code = 'Numpad' + (vk - 0x60);
  if (!code && vk >= 0x70 && vk <= 0x87) code = 'F' + (vk - 0x6f);
  if (!code) return null;
  const key = KEY_NAMES[code] ?? (/^Key/.test(code) ? code[3].toLowerCase() : /^Digit|^Numpad[0-9]/.test(code) ? code.slice(-1) : code);
  const keyCode = vk >= 0xa0 && vk <= 0xa5 ? 0x10 + ((vk - 0xa0) >> 1) : vk;
  return { code, key, keyCode };
}
