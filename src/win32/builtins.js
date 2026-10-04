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
import { registerQuartz } from './quartz.js';
import { registerMci } from './mci.js';

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
  registerQuartz(api, vm);
  registerMci(api, vm);
  // Module images of the builtin DLLs (their HMODULE values) are made on first use in the thunk area (ApiRegistry.window);
  // kernel32's first, at its 1 MB-aligned start, as software locating kernel32 by its address expects an aligned base.
  api.window('kernel32.dll');
}
