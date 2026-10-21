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
export const PROGRAM_GLSL_VERSION = 1;

/**
 * Is this the program key of a fixed-function draw with an FVF layout (`ff:f<fvf>:...|ff:...[|flat]`)? Its sources
 * follow from the key alone (d3d8-shaders.js ffProgramFromKey): learned ones are rebuilt by the current translator.
 */
export function ffKeyRegenerable(key) { return typeof key === 'string' && /^ff:f[^:|]*:[^|]*\|ff:[^|]*(\|flat)?$/.test(key); }

/** The learned-programs route of a manifest, for this translator version (render worker and in-thread backend). */
export function programsUrl(manifestName) { return `/api/programs/${encodeURIComponent(manifestName)}?v=${PROGRAM_GLSL_VERSION}`; }
/** What a session posts there: the programs it built at a draw, the ids of the learned ones it used, its version. */
export function programsPost(programs, used) { return JSON.stringify({ v: PROGRAM_GLSL_VERSION, programs, used }); }
