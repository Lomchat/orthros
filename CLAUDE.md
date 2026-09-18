# Orthros

Browser runtime that executes **unmodified Win32 games** using the client's CPU/RAM/GPU:
x86-32 user-mode emulation (reference interpreter + x86→WebAssembly dynamic recompiler),
PE32 loader, reimplementation of the public Win32/DirectX APIs on top of browser APIs
(WebGL2/WebGPU, WebAudio, DOM input), virtual filesystem served over HTTP.

Validation target: the game in `/srv/bfme/game-source/bfme-vanilla` (`lotrbfme.exe`).
Final goal: it runs in Chrome at a stable 30 fps (p99 frame ≤ 33 ms over 10 min), full game
playable (audio, mouse/keyboard, saves). Then `orthros run <folder>` runs any Win32 game folder.

## Absolute constraints (from the owner — never violate)

- **No reverse engineering of the game**: no disassembling to recode, no reading its data formats,
  no game-specific code anywhere in the runtime. The only per-game artifact is `manifest.json`
  (exe, args, cwd, generic compat flags such as DLL overrides).
- **Game access is limited to running it inside Orthros** and reading Orthros' own traces
  (API calls, registers, instructions around a crash) to fix emulator fidelity. That is the main
  dev loop from M4 on. Do not browse/analyze `/srv/bfme` otherwise.
- **Everything written from scratch here.** No searching for / copying existing projects
  (Wine, v86, Box86, DXVK, ...). No third-party *runtime* dependency. Tooling is fine:
  clang/lld-18, Node, Playwright Chromium (headless), Python 3.
- **The game files are never modified.** Chrome only (WASM SIMD/threads, SAB, JSPI, WebGPU, OPFS ok).
- A fix that only makes sense for this one game is a fidelity bug to be fixed generically.

## Layout

```
src/cpu/      x86-32: memory.js (2 GB identity-mapped guest memory), state.js (thread CPU state),
              decoder.js, interp.js (reference interpreter), flags.js, jit/ (x86→WASM translator)
src/loader/   PE32 loader (sections, imports, relocs, TLS, SEH, resources)
src/win32/    Win32 API reimplementation, one module per DLL; auto-generated tracing stubs
src/gfx/      DirectDraw / D3D7-8-9 → WebGL2 (WebGPU later), shader translation
src/audio/    DirectSound / winmm → WebAudio (AudioWorklet)
src/input/    DirectInput / Win32 messages ← browser events
src/vfs/      virtual FS (C:\, registry, game folder over HTTP range, OPFS saves)
src/host/     Node static server (COOP/COEP), web page, worker, perf HUD, headless harness
tests/        `node --test` unit tests; tests/generated/ is produced by tools (gitignored)
tools/        native x86-32 reference oracle (C), test generators (Python), PE test programs
```

## Conventions

- Plain JavaScript ES modules + JSDoc types, **no build step**: the browser loads `src/` directly,
  Node runs the same files. Code and comments in English; DECISIONS.md / STATUS.md in French.
- Guest address == offset in the single `WebAssembly.Memory` (2 GB, lazily committed).
- JIT'd code never calls into JS: at every API boundary it flushes registers to the thread state
  and returns to the JS dispatcher (WASM stack empty ⇒ trivial thread switching, nested callbacks).
- Threads are green threads on one worker (see DECISIONS.md D003).
- Every milestone has an automated test that must be green before moving on: `make test`.
- Commit at each stable step. Keep STATUS.md current (milestone, works, blockers, next action).
- Blocked > 2 h: work around (stub, fallback, degraded mode), note it, move on, come back later.
- Performance is measured, never assumed: every optimization comes with before/after numbers.

## Commands

- `make test` — all unit tests (Node) + CPU conformance against the native oracle when built.
- `make tools` — builds the native 32-bit reference oracle and test PE programs (clang/lld-18).
- `make serve` — Orthros server on http://localhost:8080 (game folder from manifest).
- `make headless` — Playwright Chromium harness: boots the game, captures frames, measures fps.
