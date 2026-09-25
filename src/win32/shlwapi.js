// shlwapi.dll: path and string helpers (Path*, Str*) and the registry shortcuts (SHGetValue...). Every function has
// an ANSI and a wide form over the same string logic; functions returning a pointer into their argument return the
// address of the same character (ANSI strings are one byte per character here, see GuestMemory.readCString).
import { E } from './errors.js';
import { Registry } from './registry.js';
import { unshared } from './strings.js';

/** Length of the root of `p`: "C:\" 3, "C:" 2, "\\server\share\" up to after the share, "\" 1, relative 0. */
export function rootLength(p) {
  if (/^[A-Za-z]:\\/.test(p)) return 3;
  if (/^[A-Za-z]:/.test(p)) return 2;
  if (p.startsWith('\\\\')) {
    let i = p.indexOf('\\', 2);
    if (i < 0) return p.length;
    i = p.indexOf('\\', i + 1);
    return i < 0 ? p.length : i + 1;
  }
  if (p.startsWith('\\')) return 1;
  return 0;
}

/** PathRemoveFileSpec: the path without its last component (the root is kept). [result, changed] */
export function removeFileSpec(p) {
  const root = rootLength(p);
  const last = p.lastIndexOf('\\');
  let cut;
  if (last < root) cut = root; // nothing after the root but a name ("C:\foo" -> "C:\", "foo" -> "")
  else cut = last === root - 1 ? root : last;
  if (last >= root && last === p.length - 1 && cut === last) { // a trailing backslash: "C:\a\" -> "C:\a"
    return [p.slice(0, last), true];
  }
  return [p.slice(0, cut), cut !== p.length];
}

/** PathCanonicalize: "." and ".." components resolved (never above the root), an empty result is "\". */
export function canonicalize(p) {
  const root = rootLength(p);
  const head = p.slice(0, root), rest = p.slice(root);
  const out = [];
  const parts = rest.split('\\');
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (s === '.') continue;
    if (s === '..') { if (out.length && out[out.length - 1] !== '') out.pop(); continue; }
    if (s === '' && i !== parts.length - 1 && i !== 0) continue; // (doubled separators)
    out.push(s);
  }
  let r = head + out.join('\\');
  if (rest.endsWith('\\.') || rest.endsWith('\\..')) r = r.replace(/\\+$/, '') || head; // "C:\a\." -> "C:\a"
  if (!r) r = '\\';
  return r;
}

/** PathCombine: `file` appended to `dir` (an absolute `file` replaces it, a rooted one keeps the drive), canonical. */
export function combine(dir, file) {
  if (!file) return canonicalize(dir || '\\');
  if (/^[A-Za-z]:/.test(file) || file.startsWith('\\\\')) return canonicalize(file);
  if (file.startsWith('\\')) return canonicalize(dir.slice(0, Math.max(0, Math.min(rootLength(dir), 2))) + file);
  if (!dir) return canonicalize(file);
  return canonicalize(dir.endsWith('\\') ? dir + file : dir + '\\' + file);
}

/** Index of the last component (PathFindFileName). */
export function fileNameIndex(p) {
  let i = p.length;
  while (i > 0 && p[i - 1] !== '\\' && p[i - 1] !== '/' && p[i - 1] !== ':') i--;
  if (i === p.length && p.length > 0) { // a trailing separator: the component before it
    let j = p.length - 1;
    while (j > 0 && (p[j] === '\\' || p[j] === '/')) j--;
    while (j > 0 && p[j - 1] !== '\\' && p[j - 1] !== '/' && p[j - 1] !== ':') j--;
    return j;
  }
  return i;
}

/** Index of the extension's dot in the last component, or the string's length (PathFindExtension). */
export function extensionIndex(p) {
  let dot = -1;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\' || ch === ' ') dot = -1;
    else if (ch === '.') dot = i;
  }
  return dot < 0 ? p.length : dot;
}

/** DOS wildcard match (PathMatchSpec: several patterns separated by ';'), case-insensitive. */
export function matchSpec(name, spec) {
  const one = (pat) => new RegExp('^' + pat.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(name);
  return spec.split(';').some((s) => s.trim() && (s.trim() === '*.*' || one(s)));
}

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerShlwapi(api, vm) {
  const mem = vm.mem;
  const S = {};
  // string access for the two character widths
  const forms = [
    { sfx: 'A', read: (c, i) => c.str(i) ?? '', write: (a, s, max) => mem.writeCString(a, s, max), size: 1 },
    { sfx: 'W', read: (c, i) => c.wstr(i) ?? '', write: (a, s, max) => mem.writeWString(a, s, max), size: 2 },
  ];
  const MAX_PATH = 260;
  for (const F of forms) {
    const { sfx, read, write, size } = F;
    S['PathRemoveFileSpec' + sfx] = [1, (c) => { if (!c.arg(0)) return 0; const [r, changed] = removeFileSpec(read(c, 0)); write(c.arg(0), r); return changed ? 1 : 0; }];
    S['PathCanonicalize' + sfx] = [2, (c) => { if (!c.arg(0) || !c.arg(1)) return c.fail(E.INVALID_PARAMETER); write(c.arg(0), canonicalize(read(c, 1)), MAX_PATH); return 1; }];
    S['PathAppend' + sfx] = [2, (c) => {
      if (!c.arg(0)) return 0;
      let more = c.arg(1) ? read(c, 1) : '';
      if (more.startsWith('\\') && !more.startsWith('\\\\')) more = more.replace(/^\\+/, ''); // (a leading backslash: still relative)
      write(c.arg(0), combine(read(c, 0), more), MAX_PATH); return 1;
    }];
    S['PathCombine' + sfx] = [3, (c) => { if (!c.arg(0) || (!c.arg(1) && !c.arg(2))) return 0; write(c.arg(0), combine(c.arg(1) ? read(c, 1) : '', c.arg(2) ? read(c, 2) : ''), MAX_PATH); return c.arg(0); }];
    S['PathFileExists' + sfx] = [1, (c) => (c.arg(0) && vm.vfs.stat(c.proc.path(read(c, 0))) ? 1 : 0)];
    S['PathIsDirectory' + sfx] = [1, (c) => (c.arg(0) && vm.vfs.stat(c.proc.path(read(c, 0)))?.isDir ? 0x10 : 0)];
    S['PathFindFileName' + sfx] = [1, (c) => (c.arg(0) ? c.arg(0) + size * fileNameIndex(read(c, 0)) : 0)];
    S['PathFindExtension' + sfx] = [1, (c) => (c.arg(0) ? c.arg(0) + size * extensionIndex(read(c, 0)) : 0)];
    S['PathStripPath' + sfx] = [1, (c) => { if (c.arg(0)) { const p = read(c, 0); write(c.arg(0), p.slice(fileNameIndex(p))); } }];
    S['PathRemoveExtension' + sfx] = [1, (c) => { if (c.arg(0)) { const p = read(c, 0); write(c.arg(0), p.slice(0, extensionIndex(p))); } }];
    S['PathRenameExtension' + sfx] = [2, (c) => { if (!c.arg(0)) return 0; const p = read(c, 0); const r = p.slice(0, extensionIndex(p)) + (c.arg(1) ? read(c, 1) : ''); if (r.length >= MAX_PATH) return 0; write(c.arg(0), r); return 1; }];
    S['PathAddExtension' + sfx] = [2, (c) => { if (!c.arg(0)) return 0; const p = read(c, 0); if (extensionIndex(p) < p.length) return 0; const r = p + (c.arg(1) ? read(c, 1) : '.exe'); if (r.length >= MAX_PATH) return 0; write(c.arg(0), r); return 1; }];
    S['PathAddBackslash' + sfx] = [1, (c) => { if (!c.arg(0)) return 0; let p = read(c, 0); if (p.length && !p.endsWith('\\')) { if (p.length + 1 >= MAX_PATH) return 0; p += '\\'; write(c.arg(0), p); } return c.arg(0) + size * p.length; }];
    S['PathRemoveBackslash' + sfx] = [1, (c) => { if (!c.arg(0)) return 0; let p = read(c, 0); if (p.endsWith('\\') && p.length > rootLength(p)) { p = p.slice(0, -1); write(c.arg(0), p); } return c.arg(0) + size * Math.max(0, p.length - 1); }];
    S['PathIsRelative' + sfx] = [1, (c) => (!c.arg(0) || rootLength(read(c, 0)) === 0 ? 1 : 0)];
    S['PathIsRoot' + sfx] = [1, (c) => { const p = c.arg(0) ? read(c, 0) : ''; return p.length > 0 && rootLength(p) === p.length && (p.endsWith('\\') || p.startsWith('\\\\')) ? 1 : 0; }];
    S['PathStripToRoot' + sfx] = [1, (c) => { if (!c.arg(0)) return 0; const p = read(c, 0), r = rootLength(p); write(c.arg(0), p.slice(0, r)); return r > 0 ? 1 : 0; }];
    S['PathSkipRoot' + sfx] = [1, (c) => { if (!c.arg(0)) return 0; const r = rootLength(read(c, 0)); return r ? c.arg(0) + size * r : 0; }];
    S['PathIsFileSpec' + sfx] = [1, (c) => (c.arg(0) && !/[\\:]/.test(read(c, 0)) ? 1 : 0)];
    S['PathMatchSpec' + sfx] = [2, (c) => (c.arg(0) && c.arg(1) && matchSpec(read(c, 0).slice(fileNameIndex(read(c, 0))), read(c, 1)) ? 1 : 0)];
    S['PathFindNextComponent' + sfx] = [1, (c) => { if (!c.arg(0)) return 0; const p = read(c, 0); if (!p.length) return 0; const i = p.indexOf('\\'); return c.arg(0) + size * (i < 0 ? p.length : i + 1); }];
    S['PathGetArgs' + sfx] = [1, (c) => { if (!c.arg(0)) return 0; const p = read(c, 0); let q = false, i = 0; for (; i < p.length; i++) { if (p[i] === '"') q = !q; else if (p[i] === ' ' && !q) { i++; break; } } return c.arg(0) + size * Math.min(i, p.length); }];
    S['PathRemoveArgs' + sfx] = [1, (c) => { if (!c.arg(0)) return; const p = read(c, 0); let q = false, i = 0; for (; i < p.length; i++) { if (p[i] === '"') q = !q; else if (p[i] === ' ' && !q) break; } write(c.arg(0), p.slice(0, i)); }];
    S['PathRemoveBlanks' + sfx] = [1, (c) => { if (c.arg(0)) write(c.arg(0), read(c, 0).trim()); }];
    S['PathUnquoteSpaces' + sfx] = [1, (c) => { if (!c.arg(0)) return; const p = read(c, 0); if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) write(c.arg(0), p.slice(1, -1)); }];
    S['PathQuoteSpaces' + sfx] = [1, (c) => { if (!c.arg(0)) return 0; const p = read(c, 0); if (p.includes(' ') && !p.startsWith('"')) { if (p.length + 3 > MAX_PATH) return 0; write(c.arg(0), `"${p}"`); return 1; } return 0; }];
    S['PathIsUNC' + sfx] = [1, (c) => (c.arg(0) && read(c, 0).startsWith('\\\\') ? 1 : 0)];
    S['PathIsURL' + sfx] = [1, (c) => (c.arg(0) && /^[a-z][a-z0-9+.-]*:\/\//i.test(read(c, 0)) ? 1 : 0)];
    S['PathCommonPrefix' + sfx] = [3, (c) => { const a = c.arg(0) ? read(c, 0) : '', b = c.arg(1) ? read(c, 1) : ''; let n = 0, i = 0; while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) { i++; if (a[i] === '\\' || i === a.length || i === b.length) n = i; } if (c.arg(2)) write(c.arg(2), a.slice(0, n)); return n; }];
    // strings
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    S['StrCmpI' + sfx] = [2, (c) => cmp(read(c, 0).toLowerCase(), read(c, 1).toLowerCase()) >>> 0];
    S['StrCmpNI' + sfx] = [3, (c) => { const n = c.sarg(2); return cmp(read(c, 0).slice(0, n).toLowerCase(), read(c, 1).slice(0, n).toLowerCase()) >>> 0; }];
    S['StrCmpN' + sfx] = [3, (c) => { const n = c.sarg(2); return cmp(read(c, 0).slice(0, n), read(c, 1).slice(0, n)) >>> 0; }];
    S['StrCmp' + sfx] = [2, (c) => cmp(read(c, 0), read(c, 1)) >>> 0];
    S['StrStr' + sfx] = [2, (c) => { const i = read(c, 0).indexOf(read(c, 1)); return i < 0 ? 0 : c.arg(0) + size * i; }];
    S['StrStrI' + sfx] = [2, (c) => { const i = read(c, 0).toLowerCase().indexOf(read(c, 1).toLowerCase()); return i < 0 ? 0 : c.arg(0) + size * i; }];
    S['StrChr' + sfx] = [2, (c) => { const i = read(c, 0).indexOf(String.fromCharCode(c.arg(1) & (size === 1 ? 0xff : 0xffff))); return i < 0 ? 0 : c.arg(0) + size * i; }];
    S['StrChrI' + sfx] = [2, (c) => { const i = read(c, 0).toLowerCase().indexOf(String.fromCharCode(c.arg(1) & (size === 1 ? 0xff : 0xffff)).toLowerCase()); return i < 0 ? 0 : c.arg(0) + size * i; }];
    S['StrRChr' + sfx] = [3, (c) => { const s = read(c, 0), end = c.arg(1) ? (c.arg(1) - c.arg(0)) / size : s.length; const i = s.slice(0, end).lastIndexOf(String.fromCharCode(c.arg(2) & (size === 1 ? 0xff : 0xffff))); return i < 0 ? 0 : c.arg(0) + size * i; }];
    S['StrToInt' + sfx] = [1, (c) => (parseInt(read(c, 0), 10) || 0) >>> 0];
    S['StrToIntEx' + sfx] = [3, (c) => { const s = read(c, 0).trim(); const v = (c.arg(1) & 1) && /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10); if (Number.isNaN(v)) return 0; c.out32(2, v >>> 0); return 1; }];
    S['StrDup' + sfx] = [1, (c) => { const s = read(c, 0); const p = c.proc.processHeap.alloc((s.length + 1) * size); if (p) write(p, s); return p; }];
    S['StrCpyN' + sfx] = [3, (c) => { const n = c.sarg(2); if (n > 0) write(c.arg(0), read(c, 1), n); return c.arg(0); }];
    S['StrCatBuff' + sfx] = [3, (c) => { const n = c.sarg(2); if (n > 0) write(c.arg(0), read(c, 0) + read(c, 1), n); return c.arg(0); }];
    S['StrTrim' + sfx] = [2, (c) => { const s = read(c, 0), t = read(c, 1); let a = 0, b = s.length; while (a < b && t.includes(s[a])) a++; while (b > a && t.includes(s[b - 1])) b--; if (a === 0 && b === s.length) return 0; write(c.arg(0), s.slice(a, b)); return 1; }];
    S['StrRStrI' + sfx] = [3, (c) => { const s = read(c, 0).toLowerCase(), end = c.arg(1) ? (c.arg(1) - c.arg(0)) / size : s.length; const i = s.slice(0, end).lastIndexOf(read(c, 2).toLowerCase()); return i < 0 ? 0 : c.arg(0) + size * i; }];
  }
  S.StrCpyW = [2, (c) => { mem.writeWString(c.arg(0), c.wstr(1) ?? ''); return c.arg(0); }];
  S.StrCatW = [2, (c) => { mem.writeWString(c.arg(0), (c.wstr(0) ?? '') + (c.wstr(1) ?? '')); return c.arg(0); }];
  // registry shortcuts: (hkey, subkey, value, *type, data, *size) through advapi32's registry
  const shValue = (c, wide) => {
    const reg = vm.registry; if (!reg) return E.FILE_NOT_FOUND;
    const base = Registry.rootName(c.arg(0)) ?? c.proc.handles.getAs(c.arg(0), 'regkey')?.path;
    if (!base) return E.INVALID_HANDLE;
    const sub = (wide ? c.wstr(1) : c.str(1)) ?? '', name = (wide ? c.wstr(2) : c.str(2)) ?? '';
    const v = reg.getValue(sub ? base + '\\' + sub : base, name);
    if (!v) return E.FILE_NOT_FOUND;
    if (c.arg(3)) mem.write32(c.arg(3), v.type);
    const pSize = c.arg(5), cap = pSize ? mem.read32(pSize) : 0;
    let data = v.data;
    if (wide && (v.type === 1 || v.type === 2)) { const str = new TextDecoder('latin1').decode(unshared(data)).replace(/\0+$/, '') + '\0'; data = new Uint8Array(str.length * 2); for (let i = 0; i < str.length; i++) { data[2 * i] = str.charCodeAt(i) & 0xff; data[2 * i + 1] = str.charCodeAt(i) >> 8; } }
    if (pSize) mem.write32(pSize, data.length);
    if (c.arg(4)) { if (cap < data.length) return 234; mem.writeBytes(c.arg(4), data); } // (ERROR_MORE_DATA)
    return 0;
  };
  S.SHGetValueA = [6, (c) => shValue(c, false)];
  S.SHGetValueW = [6, (c) => shValue(c, true)];
  S.SHSetValueA = [6, () => 5]; // (ERROR_ACCESS_DENIED)
  S.SHDeleteKeyA = [2, () => 0]; S.SHDeleteKeyW = [2, () => 0];
  api.define('shlwapi.dll', S);
}
