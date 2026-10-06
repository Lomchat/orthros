// Switches of the API-layer optimizations, for measurement within a session (harness dbg:ORTHROS_API_OPT_OFF=1: all of
// them off; dbg:ORTHROS_GL_NOCACHE=1: the WebGL backend's per-draw caches only; dbg:ORTHROS_FX_BIND_OFF=1: the D3DX
// effect binding of d3dx9-effect.js only — raw-word constants, version moves on real changes, resolved device methods,
// slot-indexed handles — back to the path before it). Read from the debug globals when they change (refreshApiOpt), not
// at every call: reading a global property that does not exist is slow.
export const apiOpt = { off: false, glNoCache: false, glCheck: false, fxRef: false };
export function refreshApiOpt() {
  apiOpt.off = globalThis.ORTHROS_API_OPT_OFF === 1;
  apiOpt.glNoCache = apiOpt.off || globalThis.ORTHROS_GL_NOCACHE === 1;
  apiOpt.glCheck = globalThis.ORTHROS_GL_CACHE_CHECK === 1; // (debugging: the backend's per-draw caches checked, see WebGLDevice.cacheMiss)
  apiOpt.fxRef = apiOpt.off || globalThis.ORTHROS_FX_BIND_OFF === 1;
}
refreshApiOpt();
