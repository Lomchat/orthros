// Registers every builtin DLL implementation on an ApiRegistry.
import { registerKernel32 } from './kernel32.js';

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerBuiltins(api, vm) {
  registerKernel32(api, vm);
  // Pseudo module bases (HMODULE values) for builtin DLLs: distinct, stable, outside guest allocations.
  let base = 0x7c800000;
  const seen = new Set();
  for (const d of api.dlls.values()) {
    if (seen.has(d)) continue;
    seen.add(d);
    d.base = base;
    base += 0x10000;
  }
}
