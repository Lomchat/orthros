// The machine's GPU as the browser's WebGL names it, and its kind — every runtime's (the Windows games' telemetry,
// src/host/web/main.js environment(); an engine page's quality tier, src/ports/openmw/tier.js).

/**
 * The WebGL renderer and vendor (WEBGL_debug_renderer_info's unmasked strings, else the masked ones): { renderer,
 * vendor }, nulls when WebGL is not there. `gl`: a context to ask (else a 1×1 one, made and lost).
 */
export function gpuInfo(gl = null) {
  let own = null;
  try {
    if (!gl) gl = own = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl) return { renderer: null, vendor: null };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? null, vendor: gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? null };
  } catch { return { renderer: null, vendor: null }; } finally { own?.getExtension('WEBGL_lose_context')?.loseContext(); }
}

// (Chrome's ANGLE strings: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)",
// "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU …)", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))",
// "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, …)")
const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|microsoft basic|gdi generic/i;
// (Intel's Arc: the discrete cards by their model, A3xx-A7xx, B5xx, Pro A/B — "Intel(R) Arc(TM) A770 Graphics", "Arc(TM)
// A370M Graphics", "Arc(TM) Pro A60 Graphics"; the laptops' integrated Arc without one or by another — Meteor Lake's
// "Intel(R) Arc(TM) Graphics", Lunar Lake's "Intel(R) Arc(TM) 140V GPU (16GB)", Arrow Lake's "Arc(TM) 130T GPU".
// AMD's APUs "Radeon RX Vega 11 Graphics" and "Radeon(TM) RX Vega 8 Graphics" are integrated, the "Radeon RX Vega" card
// (Vega 56/64) discrete.)
const INTEGRATED = /\bintel\b|iris|uhd graphics|\bhd graphics|\barc\b|apple (m\d|gpu)|\bmali\b|adreno|powervr|videocore|radeon\(tm\) graphics|radeon graphics|radeon (vega )?\d+ graphics|radeon \d{3}m\b|vega \d+ graphics/i;
const DISCRETE = /nvidia|geforce|quadro|\brtx\b|\bgtx\b|radeon (rx(?! vega \d+ graphics)|pro|r9|r7|hd \d)|radeon \d{4}\b|\barc(\(tm\))? (pro )?[ab]\d{2,3}m?\b|firepro/i;

/** The kind of GPU a renderer string names: 'software', 'integrated', 'discrete' or 'unknown'. */
export function gpuClass(renderer) {
  const r = String(renderer ?? '');
  if (!r) return 'unknown';
  if (SOFTWARE.test(r)) return 'software';
  // (a discrete name first: "NVIDIA GeForce …" with an Intel host bridge in the string is the NVIDIA one)
  if (DISCRETE.test(r)) return 'discrete';
  if (INTEGRATED.test(r)) return 'integrated';
  return 'unknown';
}
