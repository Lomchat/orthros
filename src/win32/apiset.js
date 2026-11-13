// DLL name redirections of the Windows loader that Orthros reproduces. API sets (Windows 7+): virtual DLL names — api-ms-win-core-synch-l1-2-0.dll, api-ms-win-crt-runtime-l1-1-0.dll,
// ext-ms-win-ntuser-window-l1-1-0.dll... — that the Windows loader resolves through its schema to a host DLL, never
// from a file. Newer CRTs (the UCRT, vcruntime140) and programs linked against the umbrella libraries import them, and
// the CRTs also LoadLibrary them to probe for Vista+ functions. Here each name goes to the builtin DLL that holds the
// contract's functions (Orthros keeps them where Windows XP had them: kernel32, advapi32, user32...), the UCRT ones to
// ucrtbase.dll (a game folder's own copy, loaded as guest code). The loader (win32/process.js) and the compatibility
// scan (server/compat-scan.js) share this table. And the Visual C++ 2005/2008 runtimes, bound by a manifest to a
// side-by-side assembly: a game ships them in a private assembly folder, `<exe dir>\Microsoft.VC80.CRT\msvcr80.dll`.

/** Visual C++ runtime DLLs bound by a manifest to a side-by-side assembly (VC 2005 and 2008) */
export const VC_RUNTIME = /^(msvc[rpm](80|90)d?|mfc(80|90)[ud]*|mfcm(80|90)u?|atl(80|90)|vcomp(90)?d?)\.dll$/;
/** the folder of a private side-by-side assembly */
export const SXS_ASSEMBLY = /^microsoft\.vc\d+\.(crt|mfc|mfcloc|atl|openmp)$/i;

/** contract prefix (after api-ms-win- / ext-ms-win-, without the -lN-N-N version) -> host DLL; first match wins */
const CONTRACTS = [
  ['crt-', 'ucrtbase.dll'],
  ['core-registry', 'advapi32.dll'], ['security-', 'advapi32.dll'], ['eventing-', 'advapi32.dll'], ['service-', 'advapi32.dll'],
  ['core-com-', 'ole32.dll'], ['core-winrt', 'combase.dll'], ['core-shlwapi', 'shlwapi.dll'], ['core-url', 'shlwapi.dll'],
  ['shell-', 'shell32.dll'], ['shcore-', 'shcore.dll'], ['core-path', 'kernel32.dll'],
  ['ntuser-', 'user32.dll'], ['rtcore-ntuser-', 'user32.dll'], ['gdi-', 'gdi32.dll'], ['rtcore-gdi', 'gdi32.dll'],
  ['mm-time', 'winmm.dll'], ['mm-', 'winmm.dll'], ['core-version', 'version.dll'], ['oleacc-', 'oleacc.dll'],
  ['core-', 'kernel32.dll'], ['base-', 'kernel32.dll'],
];
/** downlevel contracts name their DLL: api-ms-win-downlevel-<dll>-l1-1-0 */
const DOWNLEVEL = /^api-ms-win-downlevel-([a-z0-9_]+)-l\d/;
/** where an API set's function may live in Orthros when its first host lacks it (Windows: all in kernelbase.dll) */
export const APISET_FAMILY = ['kernel32.dll', 'advapi32.dll', 'user32.dll', 'shlwapi.dll', 'ole32.dll', 'version.dll'];

/** Is `name` (normalized: lowercase, .dll) an API set name? */
export function isApiSet(name) { return name.startsWith('api-ms-win-') || name.startsWith('ext-ms-win-'); }

/**
 * The host DLL of an API set name, or null if `name` is not one.
 * @param {string} name normalized DLL name
 */
export function apiSetHost(name) {
  if (!isApiSet(name)) return null;
  const dl = DOWNLEVEL.exec(name);
  if (dl) return dl[1] === 'normaliz' ? 'kernel32.dll' : `${dl[1]}.dll`;
  const contract = name.replace(/^(api|ext)-ms-win-/, '').replace(/-l\d+-\d+-\d+\.dll$/, '');
  for (const [prefix, host] of CONTRACTS) if (contract.startsWith(prefix)) return host;
  return 'kernel32.dll';
}
