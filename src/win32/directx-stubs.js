// DirectX entry points (d3d8/d3d9/ddraw/dinput/dsound) — tracing stubs for M4. The real
// implementations arrive with M5 (rendering) and M6 (audio/input).

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerDirectXStubs(api, vm) {
  const trace = (name) => (c) => { vm.log('warn', `${name} called (not implemented yet) from ${c.proc.symbolize(c.retAddr)}`); vm.firstD3DCall ??= { name, from: c.proc.symbolize(c.retAddr), apiCalls: vm.apiCalls }; return 0; };
  api.define('d3d8.dll', { Direct3DCreate8: [1, trace('Direct3DCreate8')], ValidatePixelShader: [4, () => 0], ValidateVertexShader: [4, () => 0] });
  api.define('d3d9.dll', { Direct3DCreate9: [1, trace('Direct3DCreate9')] });
  api.define('ddraw.dll', { DirectDrawCreate: [3, trace('DirectDrawCreate')], DirectDrawCreateEx: [4, trace('DirectDrawCreateEx')], DirectDrawEnumerateA: [2, () => 0], DirectDrawEnumerateExA: [3, () => 0] });
  api.define('dinput8.dll', { DirectInput8Create: [5, trace('DirectInput8Create')] });
  api.define('dinput.dll', { DirectInputCreateA: [4, trace('DirectInputCreateA')], DirectInputCreateW: [4, trace('DirectInputCreateW')], DirectInputCreateEx: [5, trace('DirectInputCreateEx')] });
  api.define('dsound.dll', { DirectSoundCreate: [3, trace('DirectSoundCreate')], DirectSoundCreate8: [3, trace('DirectSoundCreate8')], DirectSoundEnumerateA: [2, () => 0], DirectSoundCaptureCreate: [3, () => 0x88780078] });
}
