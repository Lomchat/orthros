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
- process and thread ids (a child's range: `nextPid`, `tidBase`), handle values: every process allocates from blocks
  of 16 384 values of its own (`HandleTable.alloc`, `HANDLE_BLOCK`, handed out by the group: `takeHandles`) — the root
  keeps the block it is in when the group starts, a child starts at a new block, a table that used its block up takes
  another — so a value (a window handle too) names one object in the whole group, and an inherited value never meets a
  child's own;
- the registry, the files, the clock and the host.

**Names.** A named object leaves the namespace with its last handle (`HandleTable.forgetName`, every table knows the
namespace: `named`), as on Windows; a file mapping keeps its name while a view of it is mapped. A game started again by
its launcher, or by itself, creates its single-instance mutex anew (before, the name of an ended process stayed: the
new instance saw ERROR_ALREADY_EXISTS and quit).

**Inherited and duplicated handles.** `bInheritHandle` in `SECURITY_ATTRIBUTES` (events, mutexes, semaphores, file
mappings), `DuplicateHandle(…, bInheritHandle)`, `SetHandleInformation(HANDLE_FLAG_INHERIT)` mark a handle
(`HandleTable.inherit`); `CreateProcess(…, bInheritHandles=TRUE, …)` copies those into the child's table under the
same values. `DuplicateHandle` takes its source and target processes from its process handles (a launcher handing an
event to its game, a child handing one back), `DUPLICATE_CLOSE_SOURCE` closes the source handle.

**Paging-file mappings** (`src/win32/mappings.js`) keep their bytes in the mapping object (`data`, grown to the end of
the furthest view: a 16 GiB section viewed through 64 KiB costs 64 KiB of host memory; a size the host cannot allocate
is ERROR_NOT_ENOUGH_MEMORY): a view is filled from them — a view mapped later, in any process, sees what an earlier one
wrote (before, each view was a private zeroed copy). One process at a time, the mapping's `holder`, may have views ahead
of `data`: the one that runs. Before another process's guest code can touch the mapping — its next slice
(`ProcessGroup.enter`, called by `Vm.runOwn` before a slice, and after a nested wait ran the others), a view it maps or
unmaps — the holder's bytes go into `data` (`releaseMapping`) and that process's views are refreshed (`acquireMapping`),
only those `data` changed since they were filled (the mapping's version `ver`). Processes never run at the same time, so
this is exact; a process that only waits (a launcher in `WaitForSingleObject(hProcess)`) is never synced, a mapping
nobody wrote costs nothing at a switch. The holder's views go into `data` as a difference against the bytes before
(`prev`): a stale view — a second view of the same bytes in one process, which does not see the first one's writes, two
views never alias here — never overwrites a newer byte. When a mapping's views are left in one process only, that
process's views are refreshed at once. File-backed mappings are unchanged (private copies of the file's bytes).

**Waits across processes.** Waits are conditions polled by each scheduler; a `SetEvent`, `ReleaseMutex`,
`ReleaseSemaphore` or the signal of `SignalObjectAndWait` hands the object to the waiters of every process at once
(`ProcessGroup.signal`), and `PulseEvent` checks every process's waiters while the event is signaled. A process handle is the child's
`Process` object: signaled when it exits (`WaitForSingleObject(hProcess)`, `GetExitCodeProcess`, `TerminateProcess`,
`OpenProcess` by id, `GetProcessId`). A wait nested in a JavaScript frame (a window procedure, DllMain) runs the other
processes while it waits (`runOthers`).

**Messages.** `PostThreadMessage` to a thread of another process goes to that thread's queue in its own window manager;
`PostMessage` to a window of another process likewise (window handles are handles: distinct ranges). `FindWindow` and
`FindWindowEx` from the desktop search every live process's top-level windows (the caller's first), and a broadcast
(`HWND_BROADCAST`) reaches them all — posted; `SendMessage`'s broadcast queues it to the other processes' windows, as
`SendNotifyMessage`. `SendMessage` to another process's window is not implemented.

**Running.** `Vm.runFor` of the root is the group's when there is one: each live machine runs in turns of 4 ms
(`runOwn(until, inGroup)`), a machine whose threads all wait hands the wait back to the group instead of sleeping; when
every process waits the group sleeps (Node) or returns the wait to the browser's event loop (cooperative host). A
process ending: its waiters woken, its handles closed (a mutex it owned abandoned), its views written back. The host is
told the exit once every process has ended, with the root's exit code. A crash in any process is the session's crash
report, as before.

**Ended processes are released.** At the group's next turn (`reap`, when none of them is inside its own run) an ended
process leaves `group.vms`, and nothing of the group keeps its machine: the handles other processes hold on its process
and threads name a record of its end (`ExitedProcess`, `ExitedThread`: what a wait, `GetExitCodeProcess`,
`GetExitCodeThread`, `GetProcessId` read), mutexes it created and others still hold no longer point into its memory, its
children's parent becomes its own parent, and the host forgets it (`forgetProcess`: the page's worker drops its audio
table, the render worker its guest memory and the devices made from it — `forgetMemory`, a `FORGET` command in the ring,
after everything they recorded). Its guest memory (2 GB reserved), JIT, windows, Direct3D and sound state are then
garbage (`tests/processes.test.js` checks the child's `WebAssembly.Memory` is collected). At most 8 processes run at
once (`MAX_LIVE_PROCESSES`; an ended one does not count): a ninth `CreateProcess` fails with ERROR_NOT_ENOUGH_MEMORY, as
does one whose memory the host cannot reserve; one whose image does not load fails with ERROR_BAD_EXE_FORMAT and leaves
a machine that had no child on its single-process path (no group).

**The display, the input and the audio** belong to one process at a time: the foreground one (`group.foreground`, the
root first). A process takes them when it creates a Direct3D device (8 or 9), sets DirectDraw's exclusive mode, or
shows a top-level window while the foreground process shows none (a launcher's hidden window). The window manager of a
background process neither presents to the display nor reads the host's input. When the foreground process ends, its
parent (or another live process) takes them back. In the page (`worker.js`), `vm` follows the foreground machine —
statistics, audio voices, the regions and heat learned for this game, the background translator (restarted on the
child's memory: `adoptForeground`) — while `rootVm.runFor` runs them all; when the child ends, the page follows its
parent again. The AudioWorklet is handed the voice table of the machine the page follows whenever that changes
(`BrowserHost.pointAudio`; the table it leaves is marked as no longer mixed), so the parent's sound plays again after
its child ended. The render worker is given the child's memory (`useMemory`: a `memory` message, waited for, then a
`MEMORY` command in the ring: devices created after it read that memory); when the child is released it forgets it and
the first memory is current again.

**Not snapshotted.** A machine with a group (`notQuiet`: "several processes") is never captured: its state spans
several machines.

**Unchanged single-process path.** Without a child, `vm.group` is null: `runFor` calls `runOwn` as before, every
other change is a test of `vm.group` at a cross-process operation (signal, post, present, input, mapping views). What
changed for one process too, as Windows does it: a name leaves the namespace with its last handle; a paging-file
mapping's later views see what earlier ones wrote, its bytes kept for what its views cover; `DuplicateHandle` checks
its process handles.

## The manifest

A game started by its launcher names the launcher as its executable: BFME II 1.06 `"exe": "lotrbfme2.exe"` (the game
data's own `game.dat` is started by it).

## Results

- `tests/processes.test.js`, `tools/pe/multiproc2.c` (JIT and interpreter): a single-instance game started ten times
  in a row by its launcher (each finds no other instance), the child's window found with `FindWindowA`, a broadcast and
  a message posted to it, a 1 MiB mapping the child writes a hundred times while the parent waits on its process (1 MiB
  moved in all, once, when the child ended: the old copy in and out at every switch was 4 MiB per turn), `PulseEvent`
  and `SignalObjectAndWait` waking the other process's waiter, an event duplicated into the child; all fifteen children
  released. Beside it: disjoint handle values, names freed (a mapping's with its last view), `DuplicateHandle` both ways
  and `DUPLICATE_CLOSE_SOURCE`, writes through two views of one process never lost, a 16 GiB section viewed through
  64 KiB, a child that does not load, the process cap, the ended child's memory garbage-collected, the render worker's
  `FORGET`, the worklet's table following the foreground. Each of these tests fails with its fix taken out.
- `tests/profile-opfs.test.js` (profile moves, `src/vfs/profile-opfs.js`): the page worker's OPFS flush writes a moved
  save at its new place before it removes the old entry, and keeps what failed for the next flush; the harness's
  profile dump is null until the profile is complete (`--profile-dir` keeps its files when it gets none).
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
