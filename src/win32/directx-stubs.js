// DirectX entry points without a module of their own: DirectDraw (ddraw.js).
// d3d8, d3d9, dinput8 and dsound live in their own modules.
import { registerDirectDraw } from './ddraw.js';

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerDirectXStubs(api, vm) {
  registerDirectDraw(api, vm);
}
