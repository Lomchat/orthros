// Registers every builtin DLL implementation on an ApiRegistry.
import { registerKernel32 } from './kernel32.js';
import { registerUser32 } from './user32.js';
import { registerGdi32 } from './gdi32.js';
import { registerDirectXStubs } from './directx-stubs.js';
import { registerMsvcrt } from './msvcrt.js';
import { registerAdvapi32 } from './advapi32.js';
import { registerMiscDlls } from './misc-dlls.js';
import { registerGdiplus } from './gdiplus.js';
import { registerShlwapi } from './shlwapi.js';
import { registerDirectInput } from './dinput8.js';
import { registerDirectSound } from './dsound.js';
import { registerDirect3D8 } from './d3d8.js';
import { registerDirect3D9 } from './d3d9.js';
import { registerD3DX9 } from './d3dx9.js';

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerBuiltins(api, vm) {
  registerKernel32(api, vm);
  registerUser32(api, vm);
  registerGdi32(api, vm);
  registerDirectXStubs(api, vm);
  registerMsvcrt(api, vm);
  registerAdvapi32(api, vm);
  registerMiscDlls(api, vm);
  registerGdiplus(api, vm);
  registerShlwapi(api, vm);
  registerDirectInput(api, vm);
  registerDirectSound(api, vm);
  registerDirect3D8(api, vm);
  registerDirect3D9(api, vm);
  registerD3DX9(api, vm);
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
