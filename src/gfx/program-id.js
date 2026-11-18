// Identity of a GL program by what GL compiles: its two GLSL sources and the attribute names bound to locations
// 0..n-1. Two draw states whose program keys differ (a shader object's handle, which follows the order the game
// creates them in and varies between sessions; a state the key records but the generated GLSL ignores) build the
// same program when these are equal: one GL program serves both, and a program learned in an earlier session is
// found again whatever key it had there.

/** The exact identity (a Map key within a session): the sources and attributes joined by NUL, which GLSL never contains. */
export function programSourceKey(vs, fs, attrs) { return vs + '\0' + fs + '\0' + attrs.join(','); }

/**
 * A compact identity for the server's learned list (16 hex digits: two 32-bit FNV-1a hashes of the source key with
 * different offsets). A collision would only make the server keep one of two programs' sources (the other is built
 * at its first draw, as without the cache): the program a draw uses is always found by the exact source key.
 */
export function programSourceId(vs, fs, attrs) {
  const s = programSourceKey(vs, fs, attrs);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * Version of the GLSL the translators generate (d3d8-shaders.js, d3d9-shaders.js and the backend's edits of their
 * output). Learned programs carry the version of the session that built or used them: the server lists to a session
 * only the programs of its version, and the fixed-function ones it regenerates from their key (ffKeyRegenerable), so
 * that sources an older translator produced are not compiled ahead for nothing. tests/program-version.test.js fails
 * when the GLSL generated for its corpus changes while this stays the same.
 */
export const PROGRAM_GLSL_VERSION = 2;

/**
 * Is this the program key of a fixed-function draw with an FVF layout (`ff:f<fvf>:...|ff:...[|flat]`)? Its sources
 * follow from the key alone (d3d8-shaders.js ffProgramFromKey): learned ones are rebuilt by the current translator.
 */
export function ffKeyRegenerable(key) { return typeof key === 'string' && /^ff:f[^:|]*:[^|]*\|ff:[^|]*(\|flat)?$/.test(key); }

/**
 * A Direct3D 9 shader program's inputs (`r` of a learned program: d3d8-webgl.js programRecipe), from which any later
 * translator rebuilds its sources (recipeSources) — as a fixed-function program's key: a learned shader program then
 * survives a change of the GLSL the translators generate (a PROGRAM_GLSL_VERSION bump, or a change its corpus misses)
 * instead of being built at draws again until relearned. Is `r` such a record (as the server keeps it)?
 */
export function programRecipe(r) {
  return !!r && typeof r === 'object' && typeof r.vs === 'string' && typeof r.ps === 'string' && r.vs.length <= 32768 && r.ps.length <= 32768 && /^[A-Za-z0-9+/=]*$/.test(r.vs + r.ps)
    && typeof r.c === 'string' && r.c.length <= 512 && typeof r.e === 'string' && /^(?:[0-7][124]){0,16}$/.test(r.e) && Number.isInteger(r.fog) && Number.isInteger(r.at) && (r.f === 0 || r.f === 1);
}
/** shader code (32-bit tokens) as base64, and back */
export function codeToText(code) { const b = new Uint8Array(code.buffer, code.byteOffset, code.length * 4); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(s); }
export function codeFromText(text) { const s = atob(text), b = new Uint8Array(s.length & ~3); for (let i = 0; i < b.length; i++) b[i] = s.charCodeAt(i); return new Uint32Array(b.buffer); }

/** The learned-programs route of a manifest, for this translator version (render worker and in-thread backend). */
export function programsUrl(manifestName) { return `/api/programs/${encodeURIComponent(manifestName)}?v=${PROGRAM_GLSL_VERSION}`; }
/** What a session posts there: the programs it built at a draw, the ids of the learned ones it used, its version. */
export function programsPost(programs, used) { return JSON.stringify({ v: PROGRAM_GLSL_VERSION, programs, used }); }
