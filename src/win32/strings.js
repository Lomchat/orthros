// Code page conversions used by the A/W API pairs and by MultiByteToWideChar & co.
// Supported: CP_ACP/1252 (Windows-1252), 28591 (Latin-1), 437/850 approximated as Latin-1,
// 65001 (UTF-8), 1200 (UTF-16LE).

const CP1252_HIGH = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];
const CP1252_REVERSE = new Map();
for (let i = 0; i < 32; i++) if (CP1252_HIGH[i] !== 0xfffd) CP1252_REVERSE.set(CP1252_HIGH[i], 0x80 + i);

export const CP_ACP = 0, CP_OEMCP = 1, CP_UTF8 = 65001;

/** Bytes (Uint8Array) -> JS string for a code page. */
export function decodeBytes(bytes, cp = CP_ACP) {
  if (cp === CP_UTF8) return new TextDecoder('utf-8').decode(bytes);
  if (cp === 1200) { let s = ''; for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8)); return s; }
  let s = '';
  const win = cp === 0 || cp === 1 || cp === 1252;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += String.fromCharCode(win && b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b);
  }
  return s;
}

/** JS string -> bytes for a code page (unmappable -> '?'). Returns { bytes, lossy }. */
export function encodeString(s, cp = CP_ACP, defaultChar = 0x3f) {
  if (cp === CP_UTF8) return { bytes: new TextEncoder().encode(s), lossy: false };
  if (cp === 1200) { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[2 * i] = c & 0xff; b[2 * i + 1] = c >> 8; } return { bytes: b, lossy: false }; }
  const out = new Uint8Array(s.length);
  let lossy = false;
  const win = cp === 0 || cp === 1 || cp === 1252;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else if (win && CP1252_REVERSE.has(c)) out[i] = CP1252_REVERSE.get(c);
    else if (c >= 0x80 && c < 0xa0 && !win) out[i] = c;
    else { out[i] = defaultChar; lossy = true; }
  }
  return { bytes: out, lossy };
}

export function upperA(s) { return s.toUpperCase(); }
export function lowerA(s) { return s.toLowerCase(); }
