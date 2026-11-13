# Compatibility foundation: the scan, kernel32 Vista+, API sets, unknown imports

"Anyone drops their .exe": before a game folder is run, Orthros says what it is and what it lacks; the kernel32
functions newer 32-bit programs and C runtimes import are there; the loader resolves the DLL names newer programs use;
and a call Orthros cannot honour stops with a report instead of corrupting the program's stack.

## `orthros scan <folder | file>`

```
node bin/orthros.mjs scan data/games/bfme1          # a game folder (manifest.json): every version, base + version folder
node bin/orthros.mjs scan data/games                # a library of game folders
node bin/orthros.mjs scan data/installers --each    # any folder; --each: every entry apart (a folder of installers)
node bin/orthros.mjs scan <folder> --json           # the full result; --verbose: every module and import
```

Static only (`src/loader/pe-inspect.js` reads, `src/server/compat-scan.js` judges): nothing runs, files are read through
positioned reads (an 18 GB installer costs its headers and the first megabyte of its data). Per executable:

- **format**: PE32 x86, PE32+ (x64, ARM64...), .NET (IL-only AnyCPU / x86, mixed mode, a framework-dependent app
  `name.dll` + `name.runtimeconfig.json`, a self-contained single-file app: native host with `DOTNET_` / hostfxr
  strings), 16-bit Windows (NE), DOS (MZ), LE/LX (VxD, DOS extenders), Windows Installer packages (OLE file);
- **role**: the manifest's main program, other programs, tools (`manifest.js` `NOT_THE_GAME`: setup, launcher,
  uninstaller...), installers (Inno Setup, NSIS, InstallShield, Wise, WiX Burn, Setup Factory, 7-Zip / RAR / cabinet
  self-extractors...: signatures in the head of the file and of its overlay, section names), redistributables
  (vcredist, DirectX setup, dotnetfx...);
- for a 32-bit x86 program: its **static dependency closure** as the loader builds it (`process.js` `loadModule`:
  builtin DLL first unless the manifest's `dllOverrides` say `native`, else the folder's copy from the module's
  folder, the program's folder or the game's top; VC 2005/2008 runtimes also from `Microsoft.VC*.CRT` private
  assemblies; API set names to their host, below), and **every imported function** checked: implemented by the
  builtin DLL, or not — split by whether the signature database knows its arguments (a call returns 0, stack
  balanced) or not (a call stops the thread, below) —, exported by the folder DLL or not, DLL found nowhere (the loader
  stubs it: its functions count as not implemented; a missing C runtime is reported as blocking);
- **C runtime**: the CRT DLLs of the closure (msvcrt, msvcr70-120, msvcp*, mfc*, vcruntime140, ucrtbase), builtin,
  folder copy or missing (a Visual C++ redistributable on Windows), else "static or none" with the linker version
  (VC 6, VS .NET 2003, VS 2005..., 2.x: Borland/Delphi or another linker);
- **interfaces**: graphics (DirectDraw, Direct3D 8/9, D3DX, OpenGL, Glide, Direct3D 10+ and Vulkan reported
  unsupported), audio (DirectSound, winmm, Miles, FMOD, OpenAL, XAudio2), input, video (Bink, Smacker, DirectShow, VfW),
  network — from the imported DLLs, the DLL names in the program's data (libraries loaded with LoadLibrary: BFME's
  Direct3D 9), and COM class GUIDs in the data (FilterGraph, DirectMusic, DirectPlay...: a class referenced, not
  necessarily created);
- **protections / packers** by section names and strings (SecuROM, SafeDisc, SteamStub, StarForce, Themida, UPX,
  ASPack, VMProtect...), and Vista+ or signature-database API names found as strings in the data that no builtin DLL
  implements ("looked up by name": candidates for GetProcAddress);
- a **verdict**: `ready` (every import implemented), `partial: ...` (what is missing, by kind), `blocked: C runtime not
  found`, `unsupported: x64 / .NET / 16-bit / DOS / Direct3D 10+`, `installer: install it, then scan the installed
  folder`, `redistributable`.

Browser-port versions (GoldSrc, OpenMW, re3) are listed with their files but marked as not run by the emulator.
Archives and disc images (`.iso`, `.zip`, `.7z`, `.rar`, `.cab`...) are listed: to unpack or mount first.

### Results on this server (2026-11-12)

`scan data/games` (6.6 s, 53 programs in 18 versions): BFME1 (both versions), BFME2, RotWK, AotR, Vice City: PE32 x86,
VS .NET 2003 (Vice City: a 2.50 linker header), msvcr71 folder copies, Direct3D 9 loaded by name (Vice City: DirectDraw
+ Direct3D 8 imported, DirectShow's FilterGraph referenced), Miles, DirectInput, `partial` — the unimplemented imports
are winmm's MIDI / wave-in functions Miles imports, ole32/oleaut32/imm32 extras, AVIFile writing, msvcr71's console
input; none is called in the bench runs (startbench `[unknown] 26/27 unimplemented imports; called: none`). WorldBuilder
(MFC 7.1) is `partial` with 174 (printing, metafiles...). The EA uninstallers / patch grabbers are `tool`s, RotWK's
`uninstall02.exe` an NSIS installer. AotR's `zGameDats/game.dat` alone is `blocked` (its msvcr71 is in `rotwk/`, the
folder it is started from). Half-Life / Counter-Strike: browser ports, 5 libraries.
`scan data/installers --each` (4 s): AotR's installer is Inno Setup (with its disk slices `*.bin`), the All-in-One
launcher setups are self-contained .NET single-file x64 programs (unsupported), `aio-launcher/` a .NET application
(`AllInOneLauncher.dll` + runtimeconfig), the Vice City ISO and the mod archives are listed as archives.

## kernel32 Vista+ (`src/win32/kernel32-sync.js`, `kernel32.js`)

Green threads (DECISIONS.md D003): each operation is atomic; a wait parks through `sched.block` and re-executes, so the
waits record what they did before parking on the thread (`cvWait`).

- **SRW locks**: `InitializeSRWLock`, `Acquire/Release/TryAcquireSRWLock{Exclusive,Shared}`. The lock word in Windows'
  layout without waiters: 0 free, 1 exclusive, `(n << 4) | 1` shared by n. A shared request waits while a thread waits
  for exclusive access (no writer starvation). Releasing a lock not held warns (Windows raises
  STATUS_RESOURCE_NOT_OWNED).
- **Condition variables**: `InitializeConditionVariable`, `SleepConditionVariableCS`, `SleepConditionVariableSRW`
  (CONDITION_VARIABLE_LOCKMODE_SHARED), `Wake(All)ConditionVariable`. Waiters by address in arrival order
  (`kernel32.condVars`, a snapshot-known map); a timeout returns FALSE / ERROR_TIMEOUT with the lock held again.
- **One-time initialization**: `InitOnceInitialize`, `InitOnceExecuteOnce` (the callback runs as a guest-level callback,
  `tailCallGuest`: it may wait), `InitOnceBeginInitialize` (CHECK_ONLY, ASYNC flags accepted), `InitOnceComplete`
  (INIT_FAILED). The word: low bits 0 / 1 in progress / 2 done, the context above.
- **SLists**: `InitializeSListHead`, `InterlockedPush/Pop/FlushSList`, `QueryDepthSList` (Next, Depth, Sequence).
- `Encode/DecodePointer`, `Encode/DecodeSystemPointer` (XOR with a cookie and rotation, the cookie fixed per process id
  so a run repeats itself), `Add/RemoveVectoredExceptionHandler`, `Add/RemoveVectoredContinueHandler` (`seh.js`
  `callVectored`: before the frame handlers; the continue handlers after a vectored handler or a frame handler continues
  the execution), `CreateEventEx`, `CreateMutexEx`, `CreateSemaphoreEx`, `CreateWaitableTimerExW`,
  `InitializeCriticalSectionEx`, `GetSystemTimePreciseAsFileTime`, `GetCurrentProcessorNumber`,
  `SetThreadStackGuarantee`, `IsWow64Process`. `GetTickCount64` and `FlsAlloc` were there.

`tools/pe/vista.c` exercises them under both executors (`tests/vista.test.js`). Run under Wine 11 for reference, the
results agree except: Wine's SRW lock word has its own layout (shared count in the high half: 0x20000 for two readers,
0x10001 exclusive — the values above are Windows'), Wine does not call the continue handlers after a vectored handler
continues the execution, and Wine's API set host is kernelbase (Windows 7+ too: `LoadLibrary("api-ms-win-...")`
returns kernelbase's handle there, kernel32's here).

## API sets (`src/win32/apiset.js`)

`api-ms-win-*` / `ext-ms-win-*` names never load a file: the contract goes to the builtin DLL holding its functions
(`core-*` kernel32, `core-registry` / `security-*` advapi32, `ntuser-*` user32, `gdi-*` gdi32, `core-com-*` ole32,
`api-ms-win-downlevel-<dll>-*` that DLL, `crt-*` ucrtbase.dll — the folder's copy, as guest code). A function the host
lacks is looked for in the family where Windows XP kept it (kernel32, advapi32, user32, shlwapi, ole32, version:
`api-ms-win-core-processthreads-l1-1-1!OpenProcessToken` is advapi32's). `LoadLibrary` / `GetModuleHandle` of an API
set name return its host. The scan uses the same table.

## A game folder's own C runtime

Not builtin, the C runtimes a game ships run as guest code (msvcr71 for every installed game). New: the VC 2005/2008
runtimes (`msvc[rpm]80/90`, `mfc80/90`, `atl80/90`, `vcomp90`) are also found in the program folder's private
side-by-side assemblies (`Microsoft.VC80.CRT\`, `Microsoft.VC90.CRT\`...), as Windows binds them by manifest;
`ucrtbase.dll` and `vcruntime140.dll` from the folder, their `api-ms-win-crt-*` imports through the API set table.
Not done: extracting the runtime from a `vcredist_x86.exe` found in the folder (a cabinet / MSI inside an installer:
LZX decompression); the scan says when a program needs a runtime the folder lacks.

## Unknown imports (`vm.js` `unknownImportStop`)

A call to an imported function no builtin DLL implements used to pop 0 arguments when the signature database
(`signatures.js`) did not know it — the caller's stack left wrong, the program failing far from there. Now such a call
stops its thread with a crash report naming the import and its caller (the main thread: the run ends with the report;
another thread exits with STATUS_ENTRYPOINT_NOT_FOUND, 0xC0000139, and the others run on). Known signatures keep the
stub (stack balanced, 0 or the DLL's stub return). `?dbg=ORTHROS_UNKNOWN_IMPORT=stub`: the former behaviour;
`=strict`: every unimplemented call stops. Windows itself would not have started such a program.

A cdecl DLL's export is not "unknown": the caller pops its arguments, so returning with 0 popped is exact
(`ApiRegistry.callerPops`: a DLL defined with `cc: CC_CDECL` — msvcrt.dll, msvcrt40.dll, crtdll.dll, whose ~1,300
exports are implemented for ~184 — or a C++ free function mangled `?...@@YA`). Those keep the stub, and the scan lists
them as "known signature". (Integration fix, 2026-11-13: the first version stopped them too — a VC6 game linked to the
system msvcrt.dll calling `_mbsnbcpy` would have crashed where it used to run; signatures.js lists stdcall only.)

## Gate (2026-11-12)

No change for the installed games: `startbench bfme1-108 --bench bfme1-108-quick --virtual --until-api NONE` and
`startbench rotwk-202 --bench rotwk-quick --virtual --until-api NONE`, base commit and this branch, same guest
instructions per phase (see the branch's report). None of the installed games imports an API set or a VC 2005/2008
runtime, and their unimplemented imports are not called in these runs.
