// Static inspection of an executable file without mapping it (the compatibility scan, src/server/compat-scan.js):
// its format (PE32, PE32+, .NET, 16-bit NE, LE/LX, DOS), headers, imports (delay-loaded ones too), exports, version
// resource, protection / packer section names and installer signatures. Reads the file through `read(offset, length)`
// so a multi-gigabyte installer costs only its headers and a few windows of its data.

/** @typedef {(offset: number, length: number) => Uint8Array} Reader */

/**
 * @typedef {object} PeImport
 * @property {string} dll lowercase
 * @property {string|null} name
 * @property {number|null} ordinal
 * @property {boolean} [delay] delay-loaded
 */

/**
 * @typedef {object} Inspection
 * @property {'pe32'|'pe32+'|'ne'|'le'|'lx'|'dos'|'msi'|'unknown'} format
 * @property {number} [machine]
 * @property {boolean} [isDll]
 * @property {number} [subsystem] 2 GUI, 3 console
 * @property {string} [linker] major.minor of the linker
 * @property {string} [osVersion] major.minor required
 * @property {{ ilOnly: boolean, x86Required: boolean, preferred32: boolean, runtime: string }|null} [dotnet]
 * @property {PeImport[]} [imports]
 * @property {string[]} [exports] exported names
 * @property {Map<string,string>} [forwards] name -> "dll.name"
 * @property {string[]} [sections]
 * @property {Record<string,string>} [version] StringFileInfo values (ProductName, FileDescription...)
 * @property {string[]} [protections] DRM / packers recognised by their sections or strings
 * @property {string[]} [installer] installer kinds recognised
 * @property {number} [overlay] bytes after the last section's data
 * @property {string} [error]
 */

const MACHINES = { 0x14c: 'x86', 0x8664: 'x64', 0x1c0: 'arm', 0xaa64: 'arm64', 0x200: 'ia64' };
export const machineName = (m) => MACHINES[m] ?? `0x${(m >>> 0).toString(16)}`;

/** section names of protections and packers (lowercase) */
const SECTION_MARKS = [
  [/^\.securom$|^\.dsstext$/, 'SecuROM'], [/^stxt774$|^stxt371$|^\.txt2$|^\.txt$/, 'SafeDisc'], [/^\.bind$/, 'SteamStub'],
  [/^\.themida$|^\.winlice$/, 'Themida'], [/^upx\d$/, 'UPX'], [/^\.aspack$|^\.adata$/, 'ASPack'], [/^\.petite$/, 'Petite'],
  [/^\.enigma\d$/, 'Enigma'], [/^\.vmp\d$/, 'VMProtect'], [/^\.ndata$/, 'NSIS'], [/^\.wixburn$/, 'WiX Burn'], [/^pec2to$|^\.pec2$/, 'PECompact'],
];
/** byte signatures (latin1 strings) of installers, searched in the head of the file and of its overlay */
const INSTALLER_MARKS = [
  ['Inno Setup Setup Data', 'Inno Setup'], ['Inno Setup', 'Inno Setup'], ['NullsoftInst', 'NSIS'], ['Nullsoft Install System', 'NSIS'],
  ['InstallShield', 'InstallShield'], ['Wise Installation', 'Wise'], ['Setup Factory', 'Setup Factory'], ['Smart Install Maker', 'Smart Install Maker'],
  ['7z\xbc\xaf\x27\x1c', '7-Zip archive'], ['Rar!\x1a\x07', 'RAR archive'], ['MSCF\0\0\0\0', 'cabinet'], ['WixBundleManifest', 'WiX Burn'],
  ['Squirrel', 'Squirrel'], ['Clickteam Install Creator', 'Clickteam'], ['InstallAware', 'InstallAware'], ['Ghost Installer', 'Ghost Installer'],
];
/** strings of protections found in the file's data */
const STRING_MARKS = [['SecuROM', 'SecuROM'], ['BoG_ *90.0&!!  Yy>', 'SafeDisc'], ['protect.dll', 'StarForce'], ['GameGuard', 'GameGuard']];

/**
 * Inspect an executable.
 * @param {Reader} read
 * @param {number} size file size
 * @param {{ scanBytes?: number }} [opts] scanBytes: how much of the head and of the overlay is searched for signatures
 * @returns {Inspection}
 */
export function inspectExecutable(read, size, opts = {}) {
  const scanBytes = opts.scanBytes ?? 1 << 20;
  const head = read(0, Math.min(size, 0x1000));
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length >= 8 && dv.getUint32(0, true) === 0xe011cfd0 && dv.getUint32(4, true) === 0xe11ab1a1) return { format: 'msi', installer: ['Windows Installer package (or another OLE compound file)'] };
  if (head.length < 0x40 || dv.getUint16(0, true) !== 0x5a4d) return { format: 'unknown' };
  const lfanew = dv.getUint32(0x3c, true);
  const sig = lfanew + 0x100 <= size ? read(lfanew, 0x108) : new Uint8Array(0);
  const sv = new DataView(sig.buffer, sig.byteOffset, sig.byteLength);
  if (sig.length < 4) return { format: 'dos' };
  const s2 = String.fromCharCode(sig[0], sig[1]);
  if (s2 === 'NE') return { format: 'ne', isDll: (sv.getUint16(0x0c, true) & 0x8000) !== 0 };
  if (s2 === 'LE' || s2 === 'LX') return { format: s2.toLowerCase() };
  if (sv.getUint32(0, true) !== 0x4550) return { format: 'dos' };
  /** @type {Inspection} */
  const r = {};
  try { parsePe(r, read, size, lfanew, scanBytes); } catch (e) { r.error = e.message; r.format ??= 'unknown'; }
  return r;
}

function parsePe(r, read, size, pe, scanBytes) {
  const hdr = read(pe, 24 + 240);
  const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
  r.machine = dv.getUint16(4, true);
  const nsec = dv.getUint16(6, true), optSize = dv.getUint16(20, true), chars = dv.getUint16(22, true);
  r.isDll = (chars & 0x2000) !== 0;
  const magic = dv.getUint16(24, true);
  const plus = magic === 0x20b;
  r.format = plus ? 'pe32+' : 'pe32';
  r.linker = `${hdr[26]}.${String(hdr[27]).padStart(2, '0')}`;
  const o = 24;
  const imageBase = plus ? Number(dv.getBigUint64(o + 24, true)) : dv.getUint32(o + 28, true);
  r.osVersion = `${dv.getUint16(o + 40, true)}.${dv.getUint16(o + 42, true)}`;
  r.subsystem = dv.getUint16(o + 68, true);
  const dirOff = o + (plus ? 112 : 96);
  const ndirs = Math.min(dv.getUint32(o + (plus ? 108 : 92), true), 16);
  const dirs = [];
  for (let i = 0; i < 16; i++) dirs.push(i < ndirs && dirOff + 8 * i + 8 <= hdr.length ? { rva: dv.getUint32(dirOff + 8 * i, true), size: dv.getUint32(dirOff + 8 * i + 4, true) } : { rva: 0, size: 0 });
  const shOff = pe + 24 + optSize;
  const sh = read(shOff, 40 * Math.min(nsec, 96));
  const sdv = new DataView(sh.buffer, sh.byteOffset, sh.byteLength);
  const sections = [];
  for (let i = 0; i < Math.min(nsec, 96) && 40 * i + 40 <= sh.length; i++) {
    let name = '';
    for (let k = 0; k < 8 && sh[40 * i + k]; k++) name += String.fromCharCode(sh[40 * i + k]);
    sections.push({ name, vsize: sdv.getUint32(40 * i + 8, true), rva: sdv.getUint32(40 * i + 12, true), rawSize: sdv.getUint32(40 * i + 16, true), rawPtr: sdv.getUint32(40 * i + 20, true) });
  }
  r.sections = sections.map((s) => s.name);
  let end = 0;
  for (const s of sections) if (s.rawSize) end = Math.max(end, s.rawPtr + s.rawSize);
  const sec = dirs[4]; // (the certificate table is a file offset, after the sections: not an overlay)
  const dataEnd = sec.rva && sec.rva >= end ? sec.rva : size;
  r.overlay = Math.max(0, dataEnd - end);
  const off = (rva) => {
    for (const s of sections) if (rva >= s.rva && rva < s.rva + Math.max(s.vsize, s.rawSize)) return rva - s.rva < s.rawSize ? s.rawPtr + (rva - s.rva) : -1;
    return rva < (sections[0]?.rva ?? 0x1000) ? rva : -1; // (headers)
  };
  // a cache of 64 KB windows: the import tables' strings are scattered but local
  const win = new Map();
  const byte = (fo) => {
    const k = Math.floor(fo / 65536);
    let w = win.get(k);
    if (!w) { if (win.size > 64) win.clear(); w = read(k * 65536, Math.min(65536, size - k * 65536)); win.set(k, w); }
    return w[fo - k * 65536] ?? 0;
  };
  const u16 = (fo) => byte(fo) | (byte(fo + 1) << 8);
  const u32 = (fo) => (byte(fo) | (byte(fo + 1) << 8) | (byte(fo + 2) << 16) | (byte(fo + 3) << 24)) >>> 0;
  const cstr = (rva, max = 512) => { const fo = off(rva); if (fo < 0) return null; let s = ''; for (let i = 0; i < max; i++) { const c = byte(fo + i); if (!c) break; s += String.fromCharCode(c); } return s; };
  const thunkSize = plus ? 8 : 4;
  const readThunk = (fo) => (plus ? { ord: (u32(fo + 4) & 0x80000000) !== 0, v: u32(fo) } : { ord: (u32(fo) & 0x80000000) !== 0, v: u32(fo) & 0x7fffffff });
  const imports = [];
  const thunks = (dll, listRva, delay) => {
    let fo = off(listRva);
    for (let n = 0; fo >= 0 && n < 20000; n++, fo += thunkSize) {
      const t = readThunk(fo);
      if (!t.v && !t.ord) break;
      if (t.ord) imports.push({ dll, name: null, ordinal: t.v & 0xffff, ...(delay ? { delay } : {}) });
      else { const name = cstr(t.v + 2); if (name === null) break; imports.push({ dll, name, ordinal: null, ...(delay ? { delay } : {}) }); }
    }
  };
  if (dirs[1].rva) {
    for (let d = off(dirs[1].rva), n = 0; d >= 0 && n < 1024; d += 20, n++) {
      const oft = u32(d), nameRva = u32(d + 12), ft = u32(d + 16);
      if (!nameRva && !ft) break;
      const dll = (cstr(nameRva, 256) ?? '?').toLowerCase();
      thunks(dll, oft || ft, false);
    }
  }
  if (dirs[13].rva) {
    for (let d = off(dirs[13].rva), n = 0; d >= 0 && n < 1024; d += 32, n++) {
      const attrs = u32(d), nameV = u32(d + 4), intV = u32(d + 16);
      if (!nameV) break;
      const rel = (v) => ((attrs & 1) ? v : v - imageBase); // (VC6's delay-load descriptors hold addresses)
      const dll = (cstr(rel(nameV), 256) ?? '?').toLowerCase();
      if (intV) thunks(dll, rel(intV), true);
    }
  }
  r.imports = imports;
  r.exports = []; r.forwards = new Map();
  if (dirs[0].rva && dirs[0].size) {
    const e = off(dirs[0].rva);
    if (e >= 0) {
      const nNames = Math.min(u32(e + 24), 65536), funcs = u32(e + 28), names = u32(e + 32), ords = u32(e + 36);
      for (let i = 0; i < nNames; i++) {
        const nfo = off(names + 4 * i); if (nfo < 0) break;
        const name = cstr(u32(nfo), 256); if (name === null) continue;
        r.exports.push(name);
        const ofo = off(ords + 2 * i), idx = ofo >= 0 ? u16(ofo) : -1, ffo = idx >= 0 ? off(funcs + 4 * idx) : -1, frva = ffo >= 0 ? u32(ffo) : 0;
        if (frva >= dirs[0].rva && frva < dirs[0].rva + dirs[0].size) r.forwards.set(name, cstr(frva, 256) ?? '');
      }
    }
  }
  r.dotnet = null;
  if (dirs[14].rva) {
    const c = off(dirs[14].rva);
    if (c >= 0) {
      const flags = u32(c + 16);
      r.dotnet = { ilOnly: (flags & 1) !== 0, x86Required: (flags & 2) !== 0, preferred32: (flags & 0x20000) !== 0, runtime: `${u16(c + 4)}.${u16(c + 6)}` };
    }
  }
  r.version = versionStrings(dirs[2], off, u16, u32, byte);
  // protections, packers, installers: section names, then signatures in the head of the file and of the overlay
  const prot = new Set(), inst = new Set();
  for (const s of sections) for (const [re, what] of SECTION_MARKS) if (re.test(s.name.toLowerCase())) (what === 'NSIS' || what === 'WiX Burn' ? inst : prot).add(what);
  const chunks = [read(0, Math.min(size, scanBytes))];
  if (r.overlay > 0) chunks.push(read(end, Math.min(r.overlay, scanBytes)));
  const texts = chunks.map((b) => latin1(b));
  for (const [needle, what] of INSTALLER_MARKS) {
    // (an archive or cabinet counts only at the start of the overlay: a self-extractor; elsewhere it is embedded data)
    if (/archive|cabinet/.test(what)) { if (texts[1] && texts[1].slice(0, 4096).includes(needle)) inst.add(`${what} (self-extracting)`); continue; }
    if (texts.some((t) => t.includes(needle))) inst.add(what);
  }
  if (inst.has('Inno Setup') && !texts.some((t) => t.includes('Inno Setup Setup Data')) && !hasInnoLoader(texts[0])) inst.delete('Inno Setup'); // (a program mentioning Inno Setup is not one)
  if (inst.has('InstallShield') && !/InstallShield.{0,64}(Setup|Self-extracting|Launcher|Engine)|ISSetupStream|_ISMSIDEL/s.test(texts.join(''))) inst.delete('InstallShield');
  if (inst.has('Squirrel') && !texts.some((t) => t.includes('SquirrelSetup') || t.includes('Squirrel.Windows'))) inst.delete('Squirrel');
  for (const [needle, what] of STRING_MARKS) if (texts.some((t) => t.includes(needle))) prot.add(what);
  r.protections = [...prot];
  r.installer = [...inst];
}

const hasInnoLoader = (t) => t.includes('rDlPtS') || t.includes('InnoSetupLdrWindow');
function latin1(b) { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; }

/** StringFileInfo values of the first RT_VERSION resource ({} if none) */
function versionStrings(dir, off, u16, u32, byte) {
  if (!dir.rva) return {};
  const root = off(dir.rva);
  if (root < 0) return {};
  const entry = (tbl, id) => {
    const n = u16(tbl + 12) + u16(tbl + 14);
    for (let i = 0; i < Math.min(n, 4096); i++) { const e = tbl + 16 + 8 * i, k = u32(e); if (id === -1 || k === id) return u32(e + 4); }
    return null;
  };
  const t = entry(root, 16); if (t === null || !(t & 0x80000000)) return {};
  const n = entry(root + (t & 0x7fffffff), -1); if (n === null || !(n & 0x80000000)) return {};
  const l = entry(root + (n & 0x7fffffff), -1); if (l === null || l & 0x80000000) return {};
  const de = root + l, fo = off(u32(de)), len = Math.min(u32(de + 4), 65536);
  if (fo < 0) return {};
  let s = '';
  for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(byte(fo + i) | (byte(fo + i + 1) << 8));
  const out = {};
  for (const key of ['CompanyName', 'FileDescription', 'FileVersion', 'ProductName', 'ProductVersion', 'OriginalFilename', 'InternalName']) {
    const i = s.indexOf(key + '\0');
    if (i < 0) continue;
    let j = i + key.length + 1;
    while (j < s.length && s[j] === '\0') j++; // (padding to a 32-bit boundary)
    const e = s.indexOf('\0', j);
    const v = s.slice(j, e < 0 ? undefined : e).trim();
    if (v && /^[\x20-\x7e -ɏ -⁯]+$/.test(v)) out[key] = v;
  }
  return out;
}
