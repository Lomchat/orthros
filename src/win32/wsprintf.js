// printf-style formatting over guest varargs (wsprintfA, msvcrt printf family later).

/**
 * @param {import('./ctx.js').Ctx} c
 * @param {string} fmt
 * @param {number} argAddr guest address of the first vararg slot
 * @param {{ wide?: boolean, floats?: boolean }} [opts]
 * @returns {string}
 */
export function formatPrintf(c, fmt, argAddr, opts = {}) {
  const mem = c.mem;
  let ap = argAddr;
  const next32 = () => { const v = mem.read32(ap); ap += 4; return v; };
  const next64 = () => { const v = mem.read64(ap); ap += 8; return v; };
  const nextF64 = () => { const v = mem.readF64(ap); ap += 8; return v; };
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; continue; }
    i++;
    if (fmt[i] === '%') { out += '%'; continue; }
    let flags = '';
    while ('-+ #0'.includes(fmt[i])) flags += fmt[i++];
    let width = '';
    if (fmt[i] === '*') { width = String(next32() | 0); i++; } else while (fmt[i] >= '0' && fmt[i] <= '9') width += fmt[i++];
    let prec = null;
    if (fmt[i] === '.') { i++; prec = ''; if (fmt[i] === '*') { prec = String(next32() | 0); i++; } else while (fmt[i] >= '0' && fmt[i] <= '9') prec += fmt[i++]; if (prec === '') prec = '0'; }
    let mod = '';
    while ('hlLqjzt'.includes(fmt[i]) || (fmt[i] === 'I' && (fmt[i + 1] === '6' || fmt[i + 1] === '3'))) { if (fmt[i] === 'I') { mod += fmt.slice(i, i + 3); i += 3; } else mod += fmt[i++]; }
    const conv = fmt[i];
    let s;
    const is64 = mod === 'll' || mod === 'I64' || mod === 'q';
    switch (conv) {
      case 'd': case 'i': { const v = is64 ? BigInt.asIntN(64, next64()) : next32() | 0; s = String(v); if (mod === 'h') s = String((next32 && (v << 16) >> 16)); if (flags.includes('+') && v >= 0) s = '+' + s; else if (flags.includes(' ') && v >= 0) s = ' ' + s; break; }
      case 'u': { const v = is64 ? next64() : next32() >>> 0; s = String(v); break; }
      case 'x': case 'X': { const v = is64 ? next64() : next32() >>> 0; s = v.toString(16); if (conv === 'X') s = s.toUpperCase(); if (flags.includes('#') && v) s = (conv === 'X' ? '0X' : '0x') + s; break; }
      case 'o': { const v = next32() >>> 0; s = v.toString(8); break; }
      case 'p': { s = (next32() >>> 0).toString(16).toUpperCase().padStart(8, '0'); break; }
      case 'c': { const v = next32(); s = String.fromCharCode(v & (opts.wide || mod === 'l' ? 0xffff : 0xff)); break; }
      case 's': case 'S': { const p = next32(); const wide = conv === 'S' ? !opts.wide : (opts.wide || mod === 'l') && mod !== 'h'; s = p ? (wide ? mem.readWString(p) : mem.readCString(p)) : '(null)'; if (prec !== null) s = s.slice(0, +prec); break; }
      case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
        const v = nextF64();
        const p = prec === null ? 6 : +prec;
        if (!Number.isFinite(v)) s = Number.isNaN(v) ? (conv === conv.toUpperCase() ? 'NAN' : 'nan') : (v < 0 ? '-' : '') + (conv === conv.toUpperCase() ? 'INF' : 'inf');
        else if (conv === 'f' || conv === 'F') s = v.toFixed(p);
        else if (conv === 'e' || conv === 'E') { s = v.toExponential(p).replace(/e([+-])(\d)$/, 'e$10$2'); if (conv === 'E') s = s.toUpperCase(); }
        else { const pp = p === 0 ? 1 : p; s = v.toPrecision(pp); if (!flags.includes('#') && s.includes('.') && !s.includes('e')) s = s.replace(/\.?0+$/, ''); if (s.includes('e')) s = s.replace(/e([+-])(\d)$/, 'e$10$2'); if (conv === 'G') s = s.toUpperCase(); }
        if (flags.includes('+') && v >= 0) s = '+' + s; else if (flags.includes(' ') && v >= 0) s = ' ' + s;
        break;
      }
      case 'n': { const p = next32(); mem.write32(p, out.length); s = ''; break; }
      default: s = '%' + mod + (conv ?? ''); break;
    }
    if (prec !== null && 'diuxXo'.includes(conv)) {
      const neg = s.startsWith('-') || s.startsWith('+') || s.startsWith(' ');
      const sign = neg ? s[0] : ''; let digits = neg ? s.slice(1) : s;
      digits = digits.padStart(+prec, '0'); s = sign + digits;
    }
    if (width && s.length < +width) {
      if (flags.includes('-')) s = s.padEnd(+width, ' ');
      else if (flags.includes('0') && conv !== 's' && conv !== 'c' && prec === null) {
        const neg = /^[-+ ]/.test(s) ? s[0] : ''; const rest = neg ? s.slice(1) : s;
        const pre = /^0[xX]/.test(rest) ? rest.slice(0, 2) : '';
        s = neg + pre + rest.slice(pre.length).padStart(+width - neg.length - pre.length, '0');
      } else s = s.padStart(+width, ' ');
    }
    out += s;
  }
  return out;
}
