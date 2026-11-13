// Compatibility scan (`orthros scan <folder>`, docs/compat-scan.md): static analysis of every executable of a game folder
// — format (32-bit, 64-bit, .NET, 16-bit, DOS), the modules its main programs load, every imported function checked
// against Orthros' builtin DLLs (src/win32) and the folder's own DLLs, the C runtime it needs, the graphics / sound /
// input / video interfaces it uses, protections and installers — and a verdict per program. Nothing runs: the files are
// only read (a multi-gigabyte installer only its headers and the head of its data).
import fs from 'node:fs';
import path from 'node:path';
import { inspectExecutable, machineName } from '../loader/pe-inspect.js';
import { apiSetHost, APISET_FAMILY, VC_RUNTIME, SXS_ASSEMBLY } from '../win32/apiset.js';
import { ApiRegistry } from '../win32/api.js';
import { Vm } from '../core/vm.js';
import { NOT_THE_GAME } from '../shared/folder-manifest.js';
import { loadGameCatalog } from './game-catalog.js';

const PE_EXT = /\.(exe|dll|asi|ocx|cpl|scr|drv|flt|m3d|mix|dat|msi|bin|tmp|ax|acm|mod)$/i;
/** extensions whose files are often not executables: inspected only when they start with "MZ" */
const MAYBE_PE = /\.(dat|bin|tmp|mod|mix)$/i;
const ARCHIVE = /\.(iso|cue|mdf|mds|nrg|ccd|zip|7z|rar|cab|exe\.\d+|bin\.\d+)$/i;
const MAX_FULL_READ = 64 << 20; // (how much of a program is read for the interface GUIDs and probed names: game programs whole)

/** COM classes created by GUID (CoCreateInstance), searched as bytes in the programs (a class referenced, not
 * necessarily created: reported only for an interface no imported or named DLL shows already) */
const CLASS_GUIDS = [
  ['e436ebb3-524f-11ce-9f53-0020af0ba770', 'DirectShow (FilterGraph)'], ['d2ac2881-b39b-11d1-8704-00600893b1bd', 'DirectMusic (Performance)'],
  ['d2ac2892-b39b-11d1-8704-00600893b1bd', 'DirectMusic (Loader)'], ['743f1dc6-5aba-429f-8bdf-c54d03253dc2', 'DirectPlay 8 (Client)'],
  ['d1eb6d20-8923-11d0-9d97-00a0c90a43cb', 'DirectPlay (DirectPlay)'], ['d7b70ee0-4340-11cf-b063-0020afc2cd35', 'DirectDraw (COM)'],
  ['47d4d946-62e8-11cf-93bc-444553540000', 'DirectSound (COM)'], ['25e609e4-b259-11cf-bfc7-444553540000', 'DirectInput (COM)'],
  ['4e3da0b8-3b3a-4abb-8e9a-a4d3c1c32e29', 'DirectX Video Acceleration'], ['0f4ce7bd-6c5c-4bbd-8b42-bdc96d9a1f5c', 'Media Foundation'],
];
/** interfaces by the DLL that provides them */
const DLL_KINDS = [
  [/^ddraw\.dll$/, 'graphics', 'DirectDraw'], [/^d3d8\.dll$/, 'graphics', 'Direct3D 8'], [/^d3d9\.dll$/, 'graphics', 'Direct3D 9'],
  [/^d3dx9_?\d*d?\.dll$/, 'graphics', 'D3DX 9'], [/^d3dx8d?\.dll$/, 'graphics', 'D3DX 8'], [/^d3d(10|11|12)(_\d)?\.dll$|^dxgi\.dll$|^d3dx1[01]_\d+\.dll$/, 'graphics', 'Direct3D 10+ (unsupported)'],
  [/^opengl32\.dll$/, 'graphics', 'OpenGL'], [/^glide[23]?x?\.dll$/, 'graphics', 'Glide'], [/^d3drm\.dll$/, 'graphics', 'Direct3D Retained Mode'], [/^d3dim(700)?\.dll$/, 'graphics', 'Direct3D Immediate Mode'],
  [/^vulkan-1\.dll$/, 'graphics', 'Vulkan (unsupported)'],
  [/^dsound\.dll$/, 'audio', 'DirectSound'], [/^winmm\.dll$/, 'audio', 'winmm'], [/^mss32\.dll$/, 'audio', 'Miles Sound System'], [/^fmod/, 'audio', 'FMOD'],
  [/^openal32\.dll$|^soft_oal\.dll$/, 'audio', 'OpenAL'], [/^xaudio2/, 'audio', 'XAudio2 (unsupported)'], [/^dsetup\.dll$/, 'other', 'DirectSetup'],
  [/^dinput8?\.dll$/, 'input', 'DirectInput'], [/^xinput/, 'input', 'XInput'],
  [/^binkw32\.dll$/, 'video', 'Bink'], [/^smackw32\.dll$/, 'video', 'Smacker'], [/^quartz\.dll$|^strmiids/, 'video', 'DirectShow'], [/^msvfw32\.dll$|^avifil32\.dll$/, 'video', 'Video for Windows'],
  [/^ws2_32\.dll$|^wsock32\.dll$/, 'network', 'Winsock'], [/^dplayx\.dll$|^dpnet\.dll$/, 'network', 'DirectPlay'], [/^steam_api\.dll$/, 'other', 'Steamworks'],
  [/^physxloader\.dll$|^physxcore\.dll$/, 'other', 'PhysX'], [/^gdiplus\.dll$/, 'graphics', 'GDI+'],
];
const CRT_DLL = /^(msvcrt|msvcrt20|msvcrt40|msvcr\d+d?|msvcp\d+d?|ucrtbased?|vcruntime\d+(_\d)?d?|mfc\d+[ud]?|crtdll)\.dll$/;
const VS_OF_LINKER = { 2: 'Borland/Delphi or another non-Microsoft linker', 4: 'VC 4', 5: 'VC 5', 6: 'VC 6', 7: 'VS .NET 2002/2003', 8: 'VS 2005', 9: 'VS 2008', 10: 'VS 2010', 11: 'VS 2012', 12: 'VS 2013', 14: 'VS 2015-2022', 48: '.NET compiler', 80: '.NET compiler' };

/** the builtin DLLs and their functions, from a machine built as the page builds it (no process) */
let builtinApi = null;
function builtins() {
  if (!builtinApi) builtinApi = new Vm({ vfs: { mounts: [] }, jit: false, log: () => {} }).api;
  return builtinApi;
}

/**
 * The files of a game: lowercase relative path ('/'-separated) -> absolute path; later layers override earlier ones
 * (a version folder over its base, case-insensitively, as the server serves them).
 * @param {string[]} layers
 */
function gameFiles(layers) {
  const files = new Map();
  for (const root of layers) {
    const walk = (dir, rel, depth) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const abs = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        let st;
        try { st = e.isSymbolicLink() ? fs.statSync(abs) : e; } catch { continue; }
        if (st.isDirectory()) { if (depth < 10) walk(abs, r, depth + 1); }
        else files.set(r.toLowerCase(), { rel: r, abs });
      }
    };
    walk(root, '', 0);
  }
  return files;
}

/** a file reader for inspectExecutable */
function fileReader(abs) {
  const fd = fs.openSync(abs, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (off, len) => { const n = Math.max(0, Math.min(len, size - off)); const b = Buffer.alloc(n); if (n) fs.readSync(fd, b, 0, n, off); return new Uint8Array(b.buffer, b.byteOffset, n); };
  return { fd, size, read, close: () => fs.closeSync(fd) };
}

const guidBytes = (g) => { const h = g.replace(/-/g, ''); const b = []; const le = (s) => s.match(/../g).reverse(); for (const x of [...le(h.slice(0, 8)), ...le(h.slice(8, 12)), ...le(h.slice(12, 16)), ...h.slice(16).match(/../g)]) b.push(parseInt(x, 16)); return Buffer.from(b); };
const GUID_NEEDLES = CLASS_GUIDS.map(([g, what]) => [guidBytes(g), what]);

/**
 * Inspect one file (null if it is not an executable).
 * @param {string} abs
 * @param {Set<string>} probeNames API names to look for as strings (functions found with GetProcAddress)
 */
function inspectFile(abs, probeNames) {
  let f;
  try { f = fileReader(abs); } catch { return null; }
  try {
    if (f.size < 64) return null;
    const head = f.read(0, 8);
    const mz = head[0] === 0x4d && head[1] === 0x5a, ole = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
    if (!mz && !(ole && /\.msi$/i.test(abs))) return null;
    if (!mz && MAYBE_PE.test(abs)) return null;
    const info = inspectExecutable(f.read, f.size);
    info.size = f.size;
    if ((info.format === 'pe32' || info.format === 'pe32+') && !info.installer?.length) {
      const all = Buffer.from(f.read(0, Math.min(f.size, MAX_FULL_READ)));
      info.classes = GUID_NEEDLES.filter(([b]) => all.includes(b)).map(([, w]) => w);
      const imported = new Set(info.imports.map((i) => i.name));
      const probed = new Set();
      const text = all.toString('latin1');
      for (const m of text.matchAll(/[A-Z][A-Za-z0-9]{5,60}(?=\0)/g)) if (probeNames.has(m[0]) && !imported.has(m[0])) probed.add(m[0]);
      info.probed = [...probed];
      // a .NET application published as one file: the native host with the runtime and assemblies appended
      if (!info.dotnet && text.includes('DOTNET_') && /hostfxr|coreclr/i.test(text)) info.dotnet = { bundle: true, ilOnly: false, x86Required: false, preferred32: false, runtime: 'core' };
      // DLL names in the data: libraries loaded at run time (LoadLibrary), e.g. d3d8.dll by a renderer chosen at start
      const dyn = new Set();
      for (let i = text.indexOf('.dll\0'); i >= 0; i = text.indexOf('.dll\0', i + 5)) {
        let j = i; while (j > i - 40 && j > 0 && /[A-Za-z0-9_.-]/.test(text[j - 1])) j--;
        if (i - j >= 2) dyn.add(text.slice(j, i + 4).toLowerCase());
      }
      info.dynDlls = [...dyn];
    }
    return info;
  } finally { f.close(); }
}

/**
 * Scan one game: its file layers and, when known, its main program.
 * @param {{ name: string, layers: string[], exe?: string|null, dllOverrides?: Record<string,string> }} game
 */
export function scanGame(game) {
  const api = builtins();
  let files = gameFiles(game.layers);
  if (game.only) files = new Map([...files].filter(([k]) => k === game.only));
  const implemented = new Set();
  for (const d of new Set(api.dlls.values())) for (const n of d.funcs.keys()) implemented.add(n);
  // names a program may look up with GetProcAddress that no builtin DLL implements (the signature database's)
  const probeNames = new Set([...api.signatures.keys(), ...VISTA_NAMES].filter((n) => !implemented.has(n)));
  /** @type {Map<string, any>} lowercase rel path -> inspection */
  const pe = new Map();
  for (const [key, f] of files) {
    if (!PE_EXT.test(key)) continue;
    const info = inspectFile(f.abs, probeNames);
    if (info) { info.rel = f.rel; pe.set(key, info); }
  }
  const overrides = new Map(Object.entries(game.dllOverrides ?? {}).map(([k, v]) => [ApiRegistry.norm(k), v]));
  const dirOf = (k) => (k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : '');
  /** directory -> its side-by-side assembly folders (Microsoft.VC80.CRT...: a private assembly of the program) */
  const sxs = new Map();
  for (const k of pe.keys()) { const d = dirOf(k); if (SXS_ASSEMBLY.test(d.split('/').pop())) { const p = dirOf(d); if (!sxs.has(p)) sxs.set(p, new Set()); sxs.get(p).add(d); } }
  /** the folder DLL a module of directory `dir` loads for `dll`, as the loader searches (its folder, SxS folders, the top) */
  const findDll = (dll, dir, exeDir) => {
    const cands = [];
    for (const d of [dir, exeDir, '']) cands.push(d ? `${d}/${dll}` : dll);
    if (VC_RUNTIME.test(dll)) for (const s of sxs.get(exeDir) ?? []) cands.push(`${s}/${dll}`);
    for (const c of cands) if (pe.has(c)) return c;
    return null;
  };
  /** the module of `dll` imported from a module of directory `dir`: builtin, folder copy, API set host, or missing */
  const moduleOf = (dll, dir, exeDir) => {
    const n = ApiRegistry.norm(dll);
    const host = apiSetHost(n);
    if (host) {
      if (api.has(host)) return { kind: 'apiset', name: n, host };
      const f = findDll(host, dir, exeDir);
      return f ? { kind: 'folder', name: n, host, key: f } : { kind: 'missing', name: n, host };
    }
    const f = findDll(n, dir, exeDir);
    if (api.has(n) && overrides.get(n) !== 'native') return { kind: 'builtin', name: n, shadowed: f };
    if (f) return { kind: 'folder', name: n, key: f };
    return { kind: 'missing', name: n };
  };
  const builtinHas = (dll, imp) => (imp.name !== null ? !!api.lookup(dll, imp.name) : !!api.dlls.get(dll)?.ordinals.has(imp.ordinal));
  /** analyse a program: its static dependency closure and every import */
  const analyse = (exeKey) => {
    const exeDir = dirOf(exeKey);
    const modules = new Map(); // name -> { kind, key? }
    const unimplemented = [], missingExports = [], missingDlls = new Set(), delayMissing = new Set();
    let total = 0;
    const visit = (key) => {
      const info = pe.get(key);
      if (!info?.imports) return;
      const dir = dirOf(key);
      for (const imp of info.imports) {
        const m = moduleOf(imp.dll, dir, exeDir);
        if (!modules.has(m.name)) {
          modules.set(m.name, { ...m, delay: !!imp.delay });
          if (m.kind === 'folder' && !imp.delay && !modules.has('@' + m.key)) { modules.set('@' + m.key, null); visit(m.key); }
        } else if (!imp.delay && modules.get(m.name).delay) modules.get(m.name).delay = false;
        total++;
        const fn = imp.name ?? `#${imp.ordinal}`;
        if (m.kind === 'missing') { (imp.delay ? delayMissing : missingDlls).add(m.host ?? m.name); if (!imp.delay) unimplemented.push({ dll: m.host ?? m.name, fn, from: info.rel, delay: false, signature: api.signatures.has(fn) || api.callerPops(m.host ?? m.name, fn), missing: true }); continue; }
        if (m.kind === 'builtin' && !builtinHas(m.name, imp)) unimplemented.push({ dll: m.name, fn, from: info.rel, delay: !!imp.delay, signature: api.signatures.has(fn) || api.callerPops(m.name, fn) });
        else if (m.kind === 'apiset' && ![m.host, ...APISET_FAMILY].some((d) => builtinHas(d, imp))) unimplemented.push({ dll: `${m.name} (${m.host})`, fn, from: info.rel, delay: !!imp.delay, signature: api.signatures.has(fn) || api.callerPops(m.host, fn) });
        else if (m.kind === 'folder') {
          const t = pe.get(m.key);
          if (imp.name !== null && t?.exports && !t.exports.includes(imp.name)) missingExports.push({ dll: m.key, fn, from: info.rel });
        }
      }
    };
    modules.set('@' + exeKey, null);
    visit(exeKey);
    for (const k of [...modules.keys()]) if (k.startsWith('@')) modules.delete(k);
    for (const d of delayMissing) if (missingDlls.has(d)) delayMissing.delete(d);
    return { modules, unimplemented, missingExports, missingDlls: [...missingDlls], delayMissing: [...delayMissing], total };
  };
  const role = (key, info) => {
    const base = key.split('/').pop().replace(/\.[^.]*$/, '');
    if (info.installer?.length || info.format === 'msi') return 'installer';
    if (/^vcredist|^dxsetup|^dxwebsetup|^dotnetfx|^ndp\d|^oalinst|^physx/i.test(base)) return 'redistributable';
    if (info.isDll || !/\.(exe|dat)$/i.test(key)) return 'library';
    if (NOT_THE_GAME.test(base)) return 'tool';
    return 'program';
  };
  const programs = [];
  const exeKey = game.exe ? game.exe.toLowerCase().replace(/\\/g, '/') : null;
  for (const [key, info] of pe) {
    const r = role(key, info);
    const netApp = r === 'library' && info.dotnet && files.has(key.replace(/\.dll$/, '.runtimeconfig.json')); // (a .NET application without its launcher: name.dll + name.runtimeconfig.json)
    if (r === 'library' && !netApp) continue;
    const main = exeKey ? key === exeKey : false;
    const entry = { file: info.rel, role: main ? 'main' : netApp ? 'program' : r, ...describe(info) };
    if (info.format === 'pe32' && info.machine === 0x14c && !info.dotnet && r !== 'installer' && r !== 'redistributable') {
      const a = analyse(key);
      entry.modules = [...a.modules.values()].map((m) => `${m.name}${m.kind === 'builtin' ? '' : m.kind === 'apiset' ? ` -> ${m.host}` : m.kind === 'folder' ? ` (folder: ${pe.get(m.key)?.rel ?? m.key}${m.host ? `, for ${m.host}` : ''})` : ' (MISSING)'}${m.delay ? ' [delay]' : ''}${m.shadowed ? ' [builtin over the folder copy]' : ''}`);
      entry.imports = a.total;
      entry.unimplemented = a.unimplemented;
      entry.missingExports = a.missingExports;
      entry.missingDlls = a.missingDlls;
      entry.delayMissing = a.delayMissing;
      entry.crt = crtOf(a.modules, info, pe);
      entry.interfaces = interfacesOf(a.modules, info, pe);
      entry.probed = [...new Set([...(info.probed ?? []), ...[...a.modules.values()].filter((m) => m.kind === 'folder').flatMap((m) => pe.get(m.key)?.probed ?? [])])];
    }
    entry.verdict = verdict(entry, info);
    programs.push(entry);
  }
  const order = { main: 0, program: 1, tool: 2, installer: 3, redistributable: 4 };
  programs.sort((a, b) => order[a.role] - order[b.role] || a.file.localeCompare(b.file));
  // archives and disc images (installers to unpack or mount first)
  const archives = [...files.values()].filter((f) => ARCHIVE.test(f.rel)).map((f) => f.rel);
  return { name: game.name, layers: game.layers, exe: game.exe ?? null, executables: pe.size, programs, archives };
}

/** format, machine, subsystem, linker, version strings, protections, installer kinds */
function describe(info) {
  const out = { format: formatName(info) };
  if (info.linker) { const major = Number(info.linker.split('.')[0]); out.linker = `${info.linker}${VS_OF_LINKER[major] ? ` (${VS_OF_LINKER[major]})` : ''}`; }
  if (info.subsystem) out.subsystem = info.subsystem === 2 ? 'GUI' : info.subsystem === 3 ? 'console' : `subsystem ${info.subsystem}`;
  if (info.osVersion) out.osVersion = info.osVersion;
  const v = info.version ?? {};
  if (v.ProductName || v.FileDescription) out.product = [v.ProductName ?? v.FileDescription, v.ProductVersion ?? v.FileVersion].filter(Boolean).join(' ');
  if (info.protections?.length) out.protections = info.protections;
  if (info.installer?.length) out.installer = info.installer;
  if (info.overlay > 1 << 20) out.overlayMB = Math.round(info.overlay / 1048576);
  out.sizeMB = Math.round((info.size ?? 0) / 104857.6) / 10;
  return out;
}

function formatName(info) {
  if (info.format === 'pe32+' || info.format === 'pe32') {
    const arch = machineName(info.machine);
    if (info.dotnet?.bundle) return `.NET single-file application ${info.format === 'pe32+' ? 'PE32+' : 'PE32'} ${arch}`;
    if (info.dotnet) return `.NET ${info.dotnet.ilOnly ? (info.dotnet.x86Required || info.dotnet.preferred32 ? '(x86)' : '(AnyCPU)') : '(mixed mode)'} ${info.format === 'pe32+' ? 'PE32+' : 'PE32'} ${arch}`;
    return `${info.format === 'pe32+' ? 'PE32+' : 'PE32'} ${arch}${info.isDll ? ' DLL' : ''}`;
  }
  return { ne: '16-bit Windows (NE)', le: 'LE (VxD / DOS extender)', lx: 'LX (OS/2 / DOS extender)', dos: 'DOS (MZ)', msi: 'Windows Installer package', unknown: 'unknown' }[info.format] ?? info.format;
}

/** the C runtime(s) the program's modules use */
function crtOf(modules, info, pe) {
  const out = [];
  for (const m of modules.values()) {
    const n = m.host ?? m.name;
    if (!CRT_DLL.test(n)) continue;
    out.push(`${n}${m.kind === 'builtin' ? ' (builtin)' : m.kind === 'folder' ? ` (folder copy: ${pe.get(m.key)?.rel})` : m.kind === 'missing' ? ' (MISSING: not in the folder, a Visual C++ redistributable on Windows)' : ''}`);
  }
  if (!out.length) out.push(`static or none (linker ${info.linker})`);
  return [...new Set(out)];
}

/** graphics / audio / input / video / network interfaces of the program's modules and COM classes */
function interfacesOf(modules, info, pe) {
  const kinds = {};
  const add = (k, v) => { (kinds[k] ??= new Set()).add(v); };
  for (const m of modules.values()) for (const [re, k, v] of DLL_KINDS) if (re.test(m.host ?? m.name)) add(k, v);
  const dyn = new Set(info.dynDlls ?? []);
  for (const m of modules.values()) if (m.kind === 'folder') for (const d of pe.get(m.key)?.dynDlls ?? []) dyn.add(d);
  for (const d of dyn) if (!modules.has(d)) for (const [re, k, v] of DLL_KINDS) if (re.test(d) && !kinds[k]?.has(v)) add(k, `${v} (loaded by name)`);
  const classes = new Set(info.classes ?? []);
  for (const m of modules.values()) if (m.kind === 'folder') for (const c of pe.get(m.key)?.classes ?? []) classes.add(c);
  for (const c of classes) if (![...Object.values(kinds)].some((s) => [...s].some((v) => v.startsWith(c.split(' (')[0])))) add(/DirectShow|Video|Media/.test(c) ? 'video' : /Music|Sound/.test(c) ? 'audio' : /Play/.test(c) ? 'network' : /Input/.test(c) ? 'input' : 'graphics', c);
  return Object.fromEntries(Object.entries(kinds).map(([k, s]) => [k, [...s]]));
}

function verdict(e, info) {
  if (e.role === 'installer') return `installer (${(info.installer ?? []).join(', ') || 'MSI'}): install it, then scan the installed folder`;
  if (e.role === 'redistributable') return 'redistributable (not needed: Orthros provides the system DLLs, or loads the folder\'s own copies)';
  if (info.format === 'ne') return 'unsupported: 16-bit Windows program';
  if (info.format === 'dos' || info.format === 'le' || info.format === 'lx') return 'unsupported: DOS program';
  if (info.format === 'unknown') return `unrecognised${info.error ? `: ${info.error}` : ''}`;
  if (info.dotnet) return 'unsupported: .NET program (needs the CLR)';
  if (info.machine !== 0x14c) return `unsupported: ${machineName(info.machine)} program (Orthros runs 32-bit x86)`;
  const gfx = e.interfaces?.graphics ?? [];
  if (gfx.some((g) => /unsupported/.test(g))) return `unsupported: ${gfx.filter((g) => /unsupported/.test(g)).join(', ')}`;
  const stops = e.unimplemented.filter((u) => !u.signature), stubs = e.unimplemented.filter((u) => u.signature);
  const notes = [];
  // (a DLL found nowhere is stubbed by the loader, as Orthros does for the system DLLs it lacks: its functions are
  // among the not implemented ones; a C runtime missing is fatal in practice)
  if (e.missingDlls?.length) notes.push(`DLLs not found (stubbed): ${e.missingDlls.join(', ')}`);
  if (stops.length) notes.push(`${stops.length} imported function(s) not implemented, unknown signature (the thread stops if called)`);
  if (stubs.length) notes.push(`${stubs.length} not implemented, known signature (return 0 if called)`);
  if (e.missingExports?.length) notes.push(`${e.missingExports.length} import(s) not exported by the folder's DLLs`);
  if (e.delayMissing?.length) notes.push(`delay-loaded DLLs missing: ${e.delayMissing.join(', ')}`);
  if (info.protections?.length) notes.push(`protection: ${info.protections.join(', ')}`);
  if (e.missingDlls?.some((d) => CRT_DLL.test(d))) return `blocked: C runtime not found (${e.missingDlls.filter((d) => CRT_DLL.test(d)).join(', ')}; a Visual C++ redistributable on Windows, to copy into the folder); ${notes.join('; ')}`;
  return notes.length ? `partial: ${notes.join('; ')}` : `ready: all ${e.imports} imported functions implemented`;
}

/** Vista+ functions programs commonly find with GetProcAddress (CRT probes), looked for as strings */
const VISTA_NAMES = ['InitializeCriticalSectionEx', 'CreateEventExW', 'CreateSemaphoreExW', 'GetTickCount64', 'FlsAlloc', 'InitOnceExecuteOnce', 'InitializeSRWLock',
  'AcquireSRWLockExclusive', 'InitializeConditionVariable', 'SleepConditionVariableCS', 'SleepConditionVariableSRW', 'WakeConditionVariable', 'WakeAllConditionVariable',
  'CompareStringEx', 'LCMapStringEx', 'GetLocaleInfoEx', 'GetUserDefaultLocaleName', 'IsValidLocaleName', 'GetSystemTimePreciseAsFileTime', 'GetCurrentProcessorNumber',
  'SetThreadStackGuarantee', 'GetFileInformationByHandleEx', 'SetFileInformationByHandle', 'CreateSymbolicLinkW', 'GetLogicalProcessorInformationEx',
  'CreateThreadpoolTimer', 'CreateThreadpoolWait', 'CreateThreadpoolWork', 'SubmitThreadpoolWork', 'AddVectoredExceptionHandler', 'EncodePointer', 'DecodePointer',
  'GetDynamicTimeZoneInformation', 'GetEnabledXStateFeatures', 'GetNativeSystemInfo', 'IsWow64Process', 'GetDpiForWindow', 'SetProcessDPIAware', 'SetProcessDpiAwareness',
  'SetProcessDpiAwarenessContext', 'DwmIsCompositionEnabled', 'DwmEnableComposition', 'XInputGetState', 'RegisterTouchWindow', 'GetTickCount64', 'FlsSetValue'];

/**
 * The games of a folder: a game folder (manifest.json with schemaVersion 1: one entry per Win32 version, its base and
 * version folders), a library of such folders, or a plain folder (one game; `each`: every entry of the folder apart).
 * @param {string} root
 * @param {{ each?: boolean }} [opts]
 */
export function gamesOf(root, opts = {}) {
  const abs = path.resolve(root);
  const st = fs.statSync(abs);
  if (st.isFile()) return [{ name: path.basename(abs), layers: [path.dirname(abs)], only: path.basename(abs).toLowerCase() }];
  const isGame = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')).schemaVersion === 1; } catch { return false; } };
  const fromGame = (d) => {
    const catalog = loadGameCatalog(path.dirname(d));
    // (a browser port's version — GoldSrc, OpenMW, re3: its engine runs the files, not the emulator — scanned all the same)
    return [...catalog.values()].filter((v) => v.gameId === path.basename(d))
      .map((v) => ({ name: `${v.gameId} / ${[...catalog].find(([, x]) => x === v)[0]} (${v.version})${(v.runtime ?? 'win32') !== 'win32' ? ` [browser port: ${v.runtime}, not run by the emulator]` : ''}`,
        layers: [v.baseFolder, v.folder].filter((x, i, a) => x && a.indexOf(x) === i), exe: (v.runtime ?? 'win32') === 'win32' ? v.exe : null, dllOverrides: v.dllOverrides }));
  };
  if (isGame(abs)) return fromGame(abs);
  const ents = fs.readdirSync(abs, { withFileTypes: true });
  if (ents.some((e) => e.isDirectory() && isGame(path.join(abs, e.name)))) return ents.filter((e) => e.isDirectory() && isGame(path.join(abs, e.name))).flatMap((e) => fromGame(path.join(abs, e.name)));
  if (!opts.each) return [{ name: path.basename(abs), layers: [abs] }];
  const out = [];
  const loose = ents.filter((e) => !e.isDirectory()).map((e) => e.name.toLowerCase());
  if (loose.length) for (const f of loose) out.push({ name: f, layers: [abs], only: f });
  for (const e of ents) if (e.isDirectory()) out.push({ name: e.name, layers: [path.join(abs, e.name)] });
  return out;
}

/**
 * Scan a folder (see gamesOf). `only`: an entry restricted to one top-level file (a loose installer).
 * @returns {ReturnType<typeof scanGame>[]}
 */
export function scanFolder(root, opts = {}) {
  return gamesOf(root, opts).map((g) => {
    const r = scanGame(g);
    return r;
  });
}

/** A scan as text (the CLI's report). */
export function formatScan(results, { verbose = false } = {}) {
  const L = [];
  for (const g of results) {
    L.push(`== ${g.name}${g.exe ? ` — main program ${g.exe}` : ''} (${g.executables} executable file(s))`);
    if (!g.programs.length) L.push(g.executables ? `  no program: ${g.executables} libraries` : '  no executable');
    if (g.archives?.length) L.push(`  archives / disc images (${g.archives.length}, to unpack or mount, then scan): ${g.archives.slice(0, 8).join(', ')}${g.archives.length > 8 ? ', ...' : ''}`);
    for (const p of g.programs) {
      L.push(`  ${p.role === 'main' ? '*' : '-'} ${p.file} [${p.role}] ${p.format}${p.subsystem ? ` ${p.subsystem}` : ''}${p.linker ? `, linker ${p.linker}` : ''}${p.product ? `, "${p.product}"` : ''}, ${p.sizeMB} MB`);
      L.push(`      verdict: ${p.verdict}`);
      if (p.crt) L.push(`      C runtime: ${p.crt.join('; ')}`);
      if (p.interfaces && Object.keys(p.interfaces).length) L.push(`      uses: ${Object.entries(p.interfaces).map(([k, v]) => `${k} ${v.join(', ')}`).join(' | ')}`);
      if (p.protections) L.push(`      protection/packer: ${p.protections.join(', ')}`);
      if (p.installer && p.role !== 'installer') L.push(`      installer data: ${p.installer.join(', ')}`);
      if (p.modules && (verbose || p.role === 'main')) L.push(`      modules: ${p.modules.join(', ')}`);
      const show = (title, list, fmt, all) => { if (list?.length) L.push(`      ${title} (${list.length}): ${(verbose || all ? list : list.slice(0, 24)).map(fmt).join(', ')}${!verbose && !all && list.length > 24 ? ', ...' : ''}`); };
      show('not implemented, unknown signature', p.unimplemented?.filter((u) => !u.signature), (u) => `${u.dll}!${u.fn}${u.delay ? ' [delay]' : ''}${u.missing ? ' [DLL not found]' : ''}${u.from !== p.file ? ` (from ${u.from})` : ''}`, p.role === 'main');
      show('not implemented, known signature', p.unimplemented?.filter((u) => u.signature), (u) => `${u.dll}!${u.fn}${u.delay ? ' [delay]' : ''}`);
      show('not exported by the folder DLL', p.missingExports, (u) => `${u.dll}!${u.fn}`);
      show('looked up by name, not implemented', p.probed, (n) => n);
    }
    L.push('');
  }
  return L.join('\n');
}
