# BFME1: the intermittent crash at the first SKIRMISH click

The race chased in docs/thread-scheduling.md ("The BFME1 investigation", 2026-10-03/04: exit 666 after an access
violation at `lotrbfme.exe+0x882c67`, a few percent of runs) is not a race. The game reads the first element of an
empty list, an uninitialized word; what that word points to decides between nothing and a double free — and one of
the ways it pointed to a "count" of 0 was Orthros' own: its heap wrote zeros into freed blocks where Windows' heap
never does. Found 2026-11-18 from Orthros' traces (Node `startbench`, a diagnostic preload on the interpreter hook
`Jit.onInterpRange`) and the disassembly of `lotrbfme.exe` (the same executable for the three BFME1 versions:
`base/lotrbfme.exe`, image base 0x400000; addresses below are virtual).

## The code

At the SKIRMISH click the game builds the skirmish menu's object, whose member at +0x3ac holds the skirmish
preferences (`Skirmish.ini` of the profile: `CurrentUserName`, `UserNames` a comma-separated list), read again from
the file (0x97d14b-0x97d1a2). Then (0x97d1a7-0x97d1e1):

```
name = prefs.currentUserName()            // 0x49fa60: the program's empty UnicodeString (0x1336e54) when absent
if (prefs.indexOf(name) < 0)              // 0x49f090: -1 on an empty list
  prefs.select(prefs.firstUserName())     // 0x49fbb0 (by value, released on return) ← 0x49f060
```

`firstUserName` (0x49f060) copies `list.front()` of an STLport `list<UnicodeString>`: `head->next + 8`. On an empty
list `head->next` is the head itself, the list's sentinel node, whose value field (+8) the list never writes. A player
without a skirmish profile — no `Skirmish.ini`: **every new player's first SKIRMISH click**, and every click until a
profile is created — has an empty list: the copy takes the sentinel's third word as a string buffer (count + 1 on
whatever it points to), `select` releases it on return (count - 1, and the program's free when it reaches 0).

The sentinel is a 12-byte node of STLport's node allocator (0xc2e540 / free 0xc2e5f0: 16-byte class, LIFO free list,
nodes handed out with their previous contents): its third word is what the node's last user left there — in the menu,
mostly pointers left by lists of raw pointers (the audio code's event lists and vectors: frees at 0x4d9c93, 0x4febba,
0x6b9b10, 0x7b4886, 0x9a0032, 0x43072d...). Outcomes:

- 0: nothing copied — harmless;
- a block whose first word is not 0 (a live count, a vtable): + 1 then - 1 — harmless;
- **a block whose first word is 0**: + 1 then - 1 frees it — a second time if it was free already. Two kinds:
  - a small block of the program's own pool (`MemoryPool`, 0xc82960 / 0xc82ba0: a 12-byte header before the block,
    its first link cleared on free), e.g. a string buffer freed when its count reached 0 — the program's state, the
    same on Windows. The second free unlinks through the cleared link: a store to address 0;
  - **a block the program freed through `HeapFree`** (the pool's large blocks: `HeapAlloc`ed with the size in their
    first word, the program's pointer at user + 4). Orthros' heap put its free-list links there and ended each list
    with 0: the last block freed of a size class read a "count" of 0 at user + 4, and "size" 0 at user + 0, so the
    pool took it for a small block and unlinked through the heap's own header (its size word, under 0x10000). Windows
    never writes 0 there: its free lists end at their head in the heap's header (Flink / Blink non-zero) and its
    lookaside lists (blocks under 1 KB) write only the first word, leaving the second as the program left it.

  Either way the store lands in the null page: the access violation at `lotrbfme.exe+0x882c67` (docs/null-page.md),
  and the game's crash handler exits with 666.

## Evidence (Node, `startbench`, this machine, one run at a time)

- **Every first click reads the sentinel**: menu → SOLO PLAY → SKIRMISH from a first-launch profile (the server's
  `seedcanon`: `Options.ini` only): `head->next == head` at 0x49f066 in every run, 1.08 and 2.22.
- **What the click copies.** 2.22 (`bfme-vanilla`, the October version), 7 runs: a stale pointer every time, all to
  ~1 KB objects of the pool's large blocks (vtables 0x10f1560 / 0x1090de0) — 5 already given back to the heap
  (coalesced with a free neighbour: their first words intact), 2 live —; none read 0 in these runs. 1.08, 9 runs: the
  sentinel came fresh from a new chunk (0) every time — its click is safe as long as its menu leaves the free list
  empty there. No natural crash in these 16 runs (October, 2.22: 3-10 %).
- **How often such a pointer reads 0** (main-thread 16-byte node allocations, 2.22 menu, 10-s windows): ~0.4 % hold a
  pointer to a freed pool block of count 0 (~400 per window), ~0.3 % to a block given back to the heap — of those, 5-15 %
  (15-63 per window) read 0 with the heap before this fix (`ZERO-COUNT heap-free block`), none after (their words are
  the list end mark). 1.08: pool blocks of count 0 come in bursts ~1.5 s after the pointer reaches a button (115 of
  2 158 and 128 of 2 562 allocations in two windows, 0 in the quiet ones).
- **Forced, the exact signature.** Writing such a value into the sentinel at the click (1.08):
  - a freed pool block of count 0 seen earlier in the run: `t2048 0xc0000005 at lotrbfme.exe+0x882c67 (stack:
    lotrbfme.exe+0x881d39 < +0x888237 < +0x9fc4e < +0x57d1dd < ...)`, `process exit with code 666` — the faulting
    store and stack of every failing run of 2026-10-03/04 (+0x9fc4e: `select`'s release of its argument; +0x57d1dd:
    the handler's call);
  - the last free block of a heap size class, at user + 4: main (3930573): the same exception, stack and exit 666;
    with the heap fix: count = the list end mark, nothing freed, the run goes on to its end.

## The fixes

**Generic (src/win32/heap.js): free lists end at the heap's own mark, not 0.** A list's end (a head's prev, a tail's
next, a cut) is the user address of the heap's first start sentinel (`Heap.end`, never a free block), as Windows' lists
end at their head inside the heap: a freed block's two first words are never 0. Every program reading a stale count
through a pointer into a block it freed now sees what Windows gives it. Cost: Heap alloc/free mix, 2 M operations
(sizes 8-1100, a third frees), 466-487 → 484-505 ms (+~10 ns per operation; BFME's ~300 heap calls per frame: ~3 µs).
`tests/heap-corruption.test.js` "a freed block's first two words are never 0".

**The game's own read (a manifest patch, data outside Git).** The pool case remains whatever the heap does: the D112
mechanism (`patches`, `src/win32/process.js` `applyPatches`), in `data/games/bfme1/manifest.json` `defaults.patches`
(the three versions share `lotrbfme.exe`): the 6 bytes at RVA 0x9f06b (`add ecx, 8; push ecx; mov ecx, esi`, the
address of the front node's value pushed for the copy) become a call to

```
cmp ecx, eax          ; the front node is the head: an empty list
jne +5
mov ecx, 0x1336e4c    ; then the program's empty UnicodeString (0x1336e54, holding 0) - 8
add ecx, 8
xchg [esp], ecx       ; the address under the return address, as the replaced push left it
push ecx
mov ecx, esi
ret
```

```json
{"module": "lotrbfme.exe", "rva": "0x9f06b", "from": "83c108518bce", "call": "39c17505b94c6e330183c108870c24518bcec3",
 "why": "…"}
```

An empty list gives the empty name; a non-empty list is unchanged. Validated (1.08, a flat copy of the version's
manifest with the patch, `bfme1-108-short`): the call in place at 0x49f06b, the forced freed pool block of count 0 in
the sentinel, no fault; the profile dialog, "Orthros" typed, the skirmish loaded, 40 s of play (29.5 fps), `Skirmish.ini`
written with the name. The manifest is part of the snapshot key (src/web/snapshot-key.js): adding the patch gives the
three BFME1 versions new snapshots (the shared ones taken again by the snapshot jobs).

**Installed 2026-11-19** with the owner's agreement, in `data/games/bfme1/manifest.json` `defaults.patches` (restic
snapshot 67211443 taken first). Checked on the installed catalog: the server serves it to `bfme1-108` and `bfme-vanilla`.
In Node `startbench` from a fresh profile (1.08: `bfme1-108-phases.txt`, 2.22: `bfme-phases.txt`, `--coords 800,600`),
both runs logged `lotrbfme.exe+0x9f06b patched`, then went through the first SKIRMISH click and the profile dialog with
no exception. 1.08 reached play and 2.22 its loading screen; both wrote `Skirmish.ini` with the name.

## Diagnostics kept

- `tools/bench/startbench.mjs` prints the exit report of a failure exit (`process exit with code 666`, the exceptions
  raised last with their stacks, the files opened, the threads) as the page sends it with its exit event — a Node run
  ending in the game's crash handler used to print only "exited" ("no Orthros crash report", docs/api-layer.md); it
  passes the manifest's `patches` and `cwd` as the page and the CLI do (Node runs had none of BFME's patches); `--dbg`
  values may hold commas (`ORTHROS_INTERP_RANGES=lo:hi,lo:hi` was cut at its first range).
- `VMem.isCommitted` no longer reads a range wrapping around 4 GB as committed: a register holding 0xffffffff (this
  crash's report) made the dump of the memory at the registers fail ("Offset is outside the bounds of the DataView").
- The method, for a game reading stale memory: `ORTHROS_INTERP_RANGES` over the functions to watch (the program's
  allocators, the reading function) and a preload (`node --import`) wrapping `Vm.prototype.createProcess` to set
  `vm.jit.onInterpRange` (as `ORTHROS_TRACE_EIP` does in vm.js): each arrival there with the registers, the stack and
  memory; records keyed by block (a node's last owner) and counts per window of guest time — what the value the
  program reads points to, how often, left by whom.
