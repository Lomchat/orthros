# Child processes — CreateProcess (launcher/game pairs)

Status: implemented 2026-10-22 (`src/core/procs.js`, `kernel32.js` CreateProcess, test `tests/processes.test.js` with
`tools/pe/multiproc.c`). Proposed decision: DECISIONS.md D105 (text in the work report, DECISIONS.md is kept in the
live tree).

## Why

Some games are started by a launcher that is part of the game: it prepares something, starts the real program with
`CreateProcess` and waits for it. The program checks that it was started that way — like Windows' own rule, nothing
specific to one game here. BFME II 1.06 is the first such game in the library: `game.dat` calls `CreateMutexA(name)`
and goes on only if `GetLastError` says the mutex already existed (the launcher `lotrbfme2.exe` created it); it then
opens and sets an event the launcher waits on, and waits for a thread message `0xBEEF` whose `lParam` is a handle of a
paging-file mapping (36 bytes the launcher filled) inherited from the launcher, which it maps with `MapViewOfFileEx`.
The launcher, meanwhile: two named mutexes, the mapping (inheritable, `SECURITY_ATTRIBUTES.bInheritHandle`),
`CreateProcessA(NULL, "game.dat", …, bInheritHandles=TRUE, 0, …)`, maps and fills the mapping, unmaps it, creates the
event, `WaitForMultipleObjects({event, hProcess}, any, 300 s)`, `PostThreadMessageA(pi.dwThreadId, 0xBEEF, 0, hMapping)`,
then `WaitForSingleObject(hProcess, INFINITE)` until the game ends, and exits. Its window is a hidden `WS_POPUP`.

Until now the Win32 runtime refused `CreateProcess` (ERROR_ACCESS_DENIED for an existing image).

## Design

**One machine per process, on the same worker.** A process is a `Vm`: one guest memory (a `WebAssembly.Memory` of its
own — every guest address space starts at the same addresses, images are not relocatable in general), its JIT, its
scheduler, its DLL modules' state, its window manager. `CreateProcess` builds a second `Vm` like the first
(`Vm.ctorOpts`: same files, clock, host, JIT options, shared memory if the first has it) and creates the process in it
(`Vm.spawnProcess`). The machines run on the worker that ran the first one, interleaved: green threads already
(D003); a second worker would have meant a second display, input and audio path and every kernel object shared through
`SharedArrayBuffer` and atomics — far more machinery for programs where one process waits while the other works.

Considered and rejected: a second worker per process (true parallelism — not needed by launcher/game pairs, whose
launcher sleeps; every shared object would need a cross-worker protocol, the display and audio a hand-over between
workers). One `Vm` for both processes in one address space: impossible — both images want 0x400000, their heaps, TEBs
and PEB collide.

**The group** (`ProcessGroup`, created at the first `CreateProcess`, `vm.group`; null otherwise): the machines, the
root first (the host's), and what Windows shares between processes:

- the kernel-object namespace — kernel32's `named` map is the group's: `CreateMutex/Event/Semaphore/FileMapping` with
  a name, `Open*` by name, ERROR_ALREADY_EXISTS, across processes;
- the objects themselves: plain JavaScript objects, the same one behind a handle in each process. A mutex whose state
  lived in the creator's guest memory (the JIT's fast paths, kernel32 `Mutex`) moves to a JavaScript array when a
  second process reaches it (`shared()`), its fast-path entries cleared in every process;
- process and thread ids (a child's range: `nextPid`, `tidBase`), handle values (a child hands out handles above the
  values it inherits: `Process` `handleBase`);
- the registry, the files, the clock and the host.

**Inherited handles.** `bInheritHandle` in `SECURITY_ATTRIBUTES` (events, mutexes, semaphores, file mappings),
`DuplicateHandle(…, bInheritHandle)`, `SetHandleInformation(HANDLE_FLAG_INHERIT)` mark a handle (`HandleTable.inherit`);
`CreateProcess(…, bInheritHandles=TRUE, …)` copies those into the child's table under the same values.

**Paging-file mappings** keep their bytes in the mapping object (`data`): a view is filled from them and written back
when unmapped, or when the process ends — a view mapped later, in any process, sees what an earlier one wrote (before,
each view was a private zeroed copy). Views open at the same time in several processes are kept alike at each switch
between processes (`syncIn` before a process's turn, `syncOut` after it): processes never run at the same time, so this
is exact. File-backed mappings are unchanged (private copies of the file's bytes).

**Waits across processes.** Waits are conditions polled by each scheduler; a `SetEvent`, `ReleaseMutex` or
`ReleaseSemaphore` wakes the waiters of every process (`ProcessGroup.signal`). A process handle is the child's
`Process` object: signaled when it exits (`WaitForSingleObject(hProcess)`, `GetExitCodeProcess`, `TerminateProcess`,
`OpenProcess` by id, `GetProcessId`). A wait nested in a JavaScript frame (a window procedure, DllMain) runs the other
processes while it waits (`runOthers`).

**Messages.** `PostThreadMessage` to a thread of another process goes to that thread's queue in its own window manager;
`PostMessage` to a window of another process likewise (window handles are handles: distinct ranges). `SendMessage`
across processes is not implemented.

**Running.** `Vm.runFor` of the root is the group's when there is one: each live machine runs in turns of 4 ms
(`runOwn(until, inGroup)`), a machine whose threads all wait hands the wait back to the group instead of sleeping; when
every process waits the group sleeps (Node) or returns the wait to the browser's event loop (cooperative host). A
process ending: its waiters woken, its handles closed (a mutex it owned abandoned), its views written back. The host is
told the exit once every process has ended, with the root's exit code. A crash in any process is the session's crash
report, as before.

**The display, the input and the audio** belong to one process at a time: the foreground one (`group.foreground`, the
root first). A process takes them when it creates a Direct3D device (8 or 9), sets DirectDraw's exclusive mode, or
shows a top-level window while the foreground process shows none (a launcher's hidden window). The window manager of a
background process neither presents to the display nor reads the host's input. When the foreground process ends, its
parent (or another live process) takes them back. In the page (`worker.js`), `vm` follows the foreground machine —
statistics, audio voices, the regions and heat learned for this game, the background translator (restarted on the
child's memory: `adoptForeground`) — while `rootVm.runFor` runs them all. The render worker is given the child's
memory (`useMemory`: a `memory` message, waited for, then a `MEMORY` command in the ring: devices created after it read
that memory).

**Not snapshotted.** A machine with a group (`notQuiet`: "several processes") is never captured: its state spans
several machines.

**Unchanged single-process path.** Without a child, `vm.group` is null: `runFor` calls `runOwn` as before, every
other change is a test of `vm.group` at a cross-process operation (signal, post, present, input, mapping views).

## The manifest

A game started by its launcher names the launcher as its executable: BFME II 1.06 `"exe": "lotrbfme2.exe"` (the game
data's own `game.dat` is started by it).

## Results

- `tests/processes.test.js`: the handshake of `tools/pe/multiproc.c` (a named mutex already there, an event set across
  processes, a thread message carrying an inherited mapping handle, the parent's bytes read and answered through it, a
  named mapping written by the child while the parent's view is open, the process wait and exit code), JIT and
  interpreter; the single-process path without a group; CreateProcess failures (not a program: 193, missing: 2); the
  input and display following the foreground process.
- BFME II 1.06 through `lotrbfme2.exe` (Node, `src/host/cli.js`): the launcher creates the game's process, the game
  finds the launcher's mutex, sets the launcher's event, receives `0xBEEF` with the mapping handle and maps it, and goes
  on with its start (window, fonts, Miles, Direct3D); the launcher waits on the process.
- In the page (headless Chromium, SwiftShader, render worker): `tools/headless.mjs bfme2-106 --games-dir <scratch with
  the manifest change> --bench bfme2-skirmish` — the launcher starts `game.dat`, the page follows it (`the page follows
  process 1284 (game.dat)`), its splash, the menu at 139 s, the profile dialog, the skirmish's loading screen and one
  minute of play (8.4 fps on that loaded machine, render-bound); the launcher waits on the game throughout and exits
  after it.
