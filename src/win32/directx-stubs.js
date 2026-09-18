// DirectX entry points without an implementation yet (d3d9, ddraw): tracing stubs.
// d3d8, dinput8 and dsound live in their own modules.

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerDirectXStubs(api, vm) {
  const trace = (name) => (c) => { vm.log('warn', `${name} called (not implemented yet) from ${c.proc.symbolize(c.retAddr)}`); vm.firstD3DCall ??= { name, from: c.proc.symbolize(c.retAddr), apiCalls: vm.apiCalls }; return 0; };
  api.define('d3d9.dll', { Direct3DCreate9: [1, trace('Direct3DCreate9')] });
  api.define('ddraw.dll', { DirectDrawCreate: [3, trace('DirectDrawCreate')], DirectDrawCreateEx: [4, trace('DirectDrawCreateEx')], DirectDrawEnumerateA: [2, () => 0], DirectDrawEnumerateExA: [3, () => 0] });
}
