// Switches of the API-layer optimizations, for measurement within a session (harness dbg:ORTHROS_API_OPT_OFF=1: all of
// them off; dbg:ORTHROS_GL_NOCACHE=1: the WebGL backend's per-draw caches only). Read from the debug globals when they
// change (refreshApiOpt), not at every call: reading a global property that does not exist is slow.
export const apiOpt = { off: false, glNoCache: false };
export function refreshApiOpt() {
  apiOpt.off = globalThis.ORTHROS_API_OPT_OFF === 1;
  apiOpt.glNoCache = apiOpt.off || globalThis.ORTHROS_GL_NOCACHE === 1;
}
refreshApiOpt();
