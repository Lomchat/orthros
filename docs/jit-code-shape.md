# The shape of translated code: measurements and tools

What the x86→WebAssembly translator (src/cpu/jit/translate.js) produces, where the time goes once V8 has compiled it,
and the instruments used to compare code-generator variants. Measured on BFME1, BFME2, RotWK and Vice City (2026-10-02).

## Instruments

- **Node play** — `tools/startbench.mjs <manifest-id> --games-dir <catalog> --input <scenario> --phases out.json`: a
  harness scenario (tools/scenarios/*.txt, the language of tools/headless.mjs) played in Node on the headless host
  (tools/node-scenario.mjs): mouse, keys, text, `waitframe` / `waitfps` anchors on the Direct3D device's draws and frames,
  `mark:<label>` phases reporting the guest instructions and the frame accounting's guest time per instruction (the
  browser's `guestMsPerMInsn`), `dbg:ORTHROS_JIT_AB=<json>` switching translation options in the session. No browser
  slot, no GPU process: the guest code of a skirmish is the same as in the page, at the same ~4 ns per instruction.
  In-session A/B: alternate variants in phases of ~30 s with a warm-up mark after each switch (everything is
  translated again), 4 rounds; the spread of one variant across rounds is ±3-5 %.
- **Windows of guest work** — `startbench --window a:b` (millions of guest instructions): CPU and guest-category ns per
  instruction between two points of a run (BFME2's first-launch computation: its hot loops alone).
- **Dynamic mix** — `startbench --mix` (with block counters; `--list-top n` lists the hottest regions,
  `dbg:ORTHROS_JIT_AB={"blockCounts":true}` in a scenario counts one phase only): instructions by mnemonic, stores
  checked for self-modifying code and how many share their address registers, region duplication, WASM operations
  per guest instruction kind (tools/jit-mix.mjs). `--jit-profile`: transitions by kind (chains, dispatches, returns), the jump exits not chained by
  reason (API thunk, stop address, budget, miss) and the API calls (RotWK play: 1.1 G chained transitions, 43 M
  exits to API thunks, 29 M API calls run in JavaScript, 0.2 M budget exits over 48 G guest instructions).
- **Kernels** — `tools/shape-bench.mjs --opts <json> --vs <json>`: small x86 kernels written for it (binary search, abs,
  array read-modify-write, calls, predictable branches, x87 at 24/53/64-bit precision, a hot loop next to cold code),
  ns per guest instruction of two variants alternated.
- **V8 tiers** — `tools/tierup-bench.mjs`: a small region entered over and over for short runs, its speed as the entries
  accumulate (Liftoff until TurboFan; Liftoff charges the tiering budget by code position).
- **Branch hints in Node** — Node 24's V8 (13.6) ignores WebAssembly branch hints unless
  `--experimental-wasm-branch-hinting` is set; Chrome honours them (since 137). The translator's hints put exits, SMC
  and fault paths, NaN rules... out of line (TurboFan's deferred blocks), so Node measurements made without the flag
  had the cold code inline, unlike the browser (checked on the machine code: the unlikely arm inline without the
  flag, after the function's hot code with it; RotWK play IPC 1.04 → 1.17, instruction fills from beyond L2 14.7 →
  10.6 per 1000 host instructions). The measurement tools (startbench, shape-bench, chain-bench, tierup-bench) set
  it (tools/node-wasm-flags.mjs); earlier Node figures in this document were measured without.
- **Thread CPU** — node phases also report the emulator thread's CPU time (`threadCpuS`, `process.threadCpuUsage`):
  on a loaded machine the categories' wall-clock time grows while the thread waits for a core, its CPU time does not.
- **Instruction fetch** — `perf stat -e cycles:u,instructions:u,ic_fetch_stall.ic_stall_any:u,ic_cache_fill_l2:u,
  ic_cache_fill_sys:u` (AMD Zen 2) around a Node play run, `perf record -e ic_cache_fill_sys:u` with `node --perf-prof`
  and `perf inject --jit` for where the fills land (the region functions are named `r_<entry>`); `startbench
  --blocks-out <file>` (with `dbg:ORTHROS_JIT_AB={"blockCounts":true}`) lists every counted region's blocks and
  counts: how many regions hold a copy of each hot guest block.
- **Deterministic concurrent runs** — `tools/ab-virtual.mjs <manifest-id> --input <scenario> --variant A='{}' --variant
  B='{...}' [--runs 2] [--heat <file>] [--profile-dir <dir>]`: every run of every variant at once (the same load),
  each under `startbench --virtual` — the virtual clock makes a run repeat its guest work exactly (two runs of the same
  build: the same 47 090 M guest instructions, 3 941 play frames), so a phase compares the same work instead of the
  drifting play of an in-session A/B (±10-20 % per round). Each variant's JSON is the runs' `ORTHROS_JIT_DEFAULTS`. Two
  identical runs differed by 0.4-3 % in play (RotWK); `coldExits` off measured +10 % in play (2.69 / 2.72 vs 2.99 /
  2.99 ns per guest instruction) on a quiet machine, +3 % on one loaded by other projects' browsers and tests — compare
  only runs made together. A variant changing where time slices end (region shapes: the budget is checked at chains and
  backward transfers) can change the interleavings: the guest instructions of each phase are printed to tell (RotWK:
  a few %, BFME2: up to 7 %, Vice City: 10 % fewer instructions in the same virtual time). BFME1's skirmish load never
  reaches its loading screen under `--virtual`.
- **Exit sites** — `startbench --jit-sites [--jit-sites-top n]`: every region exit site (indirect calls through a
  register or a computed address, through an absolute slot, indirect jumps, returns leaving their region, static exits
  — `exitLim`: to a successor discovery left out for the region's size; `...Call`: of a call) counts its executions,
  last target and target changes (translate.js siteProf, three counters per site address in the block-counter area):
  totals by kind, how many sites make 90 % of the exits, the share at sites whose target changes in less than 5 % of
  the exits. `--jit-profile` also lists the fast-path API calls the dispatcher ran in WASM, by API.
- **Code size of x87 regions** — `tools/x87-size.mjs [--ab <root>] [--cw 0x7f,...] [--disasm <case>@<cw>]`: small
  regions shaped like compiler x87 output (the x87loop-bench loops, double and register operands) translated under
  several control words: WASM operations per x87 arithmetic instruction, WASM body bytes and TurboFan machine code bytes
  per region (V8's `--print-wasm-code`, eager TurboFan, branch hints honoured), against another src tree with `--ab`.
  On a game: `startbench --mix` prints the x87 regions apart (`[shape] x87 regions: ...`), and with
  `ORTHROS_X87_DUMP=<dir>` writes every live x87 region's module translated now and with the earlier x87 options
  (`<dir>/new`, `<dir>/old`); `x87-size.mjs --modules <dir>` compiles both sets for their machine code.
- **Hot-path cost of one region** — x87loop-bench's loops under `perf record -e cycles:u,instructions:u` with
  `node --perf-prof --no-liftoff`, `perf inject -j`, the `JS:r_*` symbols' periods divided by the iterations: host
  instructions per iteration are steady on a loaded machine where cycles and wall time are not. x87loop-bench itself
  does not set `--experimental-wasm-branch-hinting`: without it V8 keeps the cold paths inline and a call on one of them
  costs spills on the hot path (one of its loops measured +17-24 % that way, -4 % with the flag) — set the flag
  (tools/node-wasm-flags.mjs) for anything meant to stand for Chrome.

## Where the time goes

- First launch (BFME2's startup computation, ~140 G guest instructions): a few loops (sorts, bit sets, bit packing)
  at 0.4-0.6 ns per guest instruction, 4-5 host instructions each, IPC ~2.3; mispredictions of data-dependent branches
  and memory-carried loop counters bound them. Removing every self-modifying-code check gives 4 % there (upper bound).
- Play (all four games): ~4 ns per guest instruction, a flat profile (the hottest region ~1 %, 500 regions for 90 % of
  the instructions), region code ~52 % of the worker's CPU at ~8 host instructions per guest instruction and IPC ~1.2.
  Of the region code's cycles, ~29 % are register moves and stack spills (TurboFan's allocator at the merges of large
  functions whose every guest register and lazy flag value is live to every exit); dispatches through a region's
  br_table loop cost an indirect jump plus the moves of every live value into the loop header's places.
  The guest category also holds the scheduler's thread switches: RotWK's frame limiter spins on Sleep(0)
  (~100 000 calls per second), so guest time per instruction in play overstates the translated code's own cost.
- Play is bound by **instruction fetch** (RotWK, Node with branch hints, AMD EPYC 7402P: 32 KiB L1i, 512 KiB L2):
  IPC ~1.2, the instruction fetch stalled ~55 % of the cycles, ~31 instruction-cache fills from L2 and ~11 from
  beyond L2 per 1000 host instructions. The translated code run in play is far larger than the caches: half of the
  region samples fall in 234 functions holding 3.5 MiB of machine code, 90 % in 1 300 functions and 15.6 MiB (a region
  is ~12 KiB of machine code for at most 48 blocks). The hot guest code itself is small — 4 800 blocks, 77 KiB of x86,
  run 90 % of the guest bytes — but each hot block is translated in ~3 regions on average (234 KiB of copies that
  run; 85 % of the executions in the most used copy): callees and shared paths copied into every region reaching them.
  Where the fills land (`perf record -e ic_cache_fill_sys`, 300 000 samples): 65 % in region code, of which region
  prologues 16 %, the chained-exit code 26 %, the dispatch loop 5 % and the bodies 52 % — a region's entry and exit
  code is touched once per transition, cold. A chained call/return between two small regions costs ~23 ns
  (tools/chain-bench.mjs, everything cached; x87 regions ~36 ns, their stack cache loaded and written back); in play
  ~1 transition per 43 guest instructions (RotWK, `--jit-profile`: returns ~50 %, indirect jumps ~30 %, static exits
  ~25 % of the chained transitions).

## Changes

- **Blocks in reverse postorder** (`layout`, on): calls followed by their callees and return sites, so that the returns
  of in-region callees, the branches back from code placed out of line and the calls to callees at lower addresses
  are forward branches instead of dispatches. The budget stays checked on the transfers backward in *address* order,
  so that time slices end where they did (thread interleavings unchanged; a check on the emission order's back
  edges preempted sync.exe's main thread inside its critical section). Dispatches halved; guest time per instruction
  in play −3 to −6 % (Node, three games), RotWK in the browser −7 to −11 % per round.
- **x87-mode versions** of a region must number their blocks alike (the guard of one version tail-calls the next with
  its block index): found with the layout, when the background translator and the game thread used different options.
- **If-conversion** (`ifcvt`, off): branches comparing two data values in loops (sorts, searches) over short arms,
  translated with selects; binary search −38 % per instruction, neutral in play and on the first launch, so off.
- The FS base is loaded at a region's entry only when it reads it.
- **Regions shaped by code heat** (`coldExits`, on when a heat is known; src/cpu/jit/heat.js): discovery leaves out a
  branch successor (jump/branch target, fallthrough, callee, return site) when the branch ran and the successor never
  did — that edge becomes an ordinary exit, so a region holds the blocks runs go through (fewer values live across
  merges and exits, less code, room for more hot blocks within 48). Exact whatever the heat (only the extent changes):
  randomized programs against the interpreter (counted, visited and arbitrary heat, sliced, SMC, three threads), and
  the whole JIT / CPU suites under `ORTHROS_JIT_RANDOM_HEAT=<seed>` (a quarter of the addresses "never ran"): every
  result matches, only assertions on region structure differ.
  The heat comes from the translations' **visit flags** (`visit`: one byte per block address not already known to
  have run, `VisitSlots`, set at the block's entry; harvested every 10 s in the page worker by `Jit.harvestVisitsStep`:
  a pass over the regions with flags not seen set yet only — consumed entries leave their region's list, a region with
  none leaves the pass's list — cut into ≤ 1 ms steps run while the guest waits (pump sleeps, nested waits), the
  mapping to module + offset and the posts cut the same way; `RangeHeat.merge` sorts only the new ranges and merges
  them linearly, see below), learned per
  game by the server (`/api/heat/<manifest>`, module + offset ranges, `heat-<manifest>.json` in the learn directory)
  and applied as modules load, to the background translator as well. An x87-mode version repeats its first version's
  blocks (`onlyBlocks`), the heat having possibly grown since. The persistent translated-code cache (docs/startup.md)
  reuses a region where the heat of now gives its extent and it flags every block the heat does not know (its visit
  flags relocated, those of blocks the heat learned since sent to a sink byte); a new shape of the same code
  supersedes the old one, and the shapes of a session's regions are brought up to the heat it taught while the
  background translator is idle. Measurement helpers: `Jit.collectHeat` (block counters),
  `dbg:ORTHROS_JIT_HEAT` / `dbg:ORTHROS_JIT_HARVEST` in Node scenarios, `startbench --heat <file> / --heat-out <file>`.
  - Browser, concurrent session pairs with the same learned heat, cold exits on / off (`?jitopts={"coldExits":false}`),
    guest time per instruction in play (`guestMsPerMInsn`; play + p2 phases, 3 pairs per game, alternated order):
    BFME1 2.84 vs 3.04 ns (−6.6 %), BFME2 3.28 vs 3.42 (−4.0 %), RotWK 3.18 vs 3.41 (−6.7 %), Vice City driving
    3.36 vs 3.74 (−9.9 %, a loaded machine in one pair). Frames > 40 ms per minute: BFME2 29 vs 58, RotWK 80 vs 88,
    BFME1 2 vs 4. BFME2 first launch to the end of the startup computation (heat of an earlier first launch, 3 pairs):
    94.8 vs 96.3 s — no slowdown (the second tier of an earlier attempt cost 35 % there).
    Review re-measurement (one alternated pair per game, same learned heat): RotWK 3.20 vs 3.49 ns (−8 %), frames
    > 40 ms per minute 81 vs 101; BFME2 3.46 vs 3.62 (−4.5 %), 31 vs 59; BFME2 first launch 87.0 vs 97.3 s.
  - Harvest cost (Node micro-benchmark, 100 000 regions of 7 flagged blocks): ~13 ms per call while flags stay pending,
    ~75 ms for a call reporting 230 000 blocks — once per 10 s on the game thread.
    In play that was a 15-50 ms host stall exactly every 10 s in every game (the walk over every region's flags, the
    merge re-sorting all ranges with a closure comparator — 5-15 ms at 26-40 k ranges, paid again by the background
    translator —, the post's JSON). Now incremental (2026-10-06): merge at 40 k ranges + 2 k new 5.2-5.9 → 0.7 ms,
    + 50 new 4.9 → 0.12 ms (Node); a synthetic pass over 30 000 regions × 40 flags 64-82 ms in one call → steps of at
    most 1.2-1.5 ms; in the browser the longest step 0.7-2 ms (pass end, mapping + post up to ~3 ms at load). Browser
    pairs run together (`--gl-discard`, phases scenarios, play phase), main / branch: host-dominated frames > 40 ms at
    a 10.0 s period 3.3-4.4 → 0 per minute (BFME1, 4 pairs), 4.5-5.9 → 0 (BFME2, 4 pairs), 1.8-4.0 → 0 (RotWK, 4
    pairs); frames > 40 ms per minute BFME1 4/6/5/4 → 1/1/0/0 (bound, visit flags off: 1); BFME2 33/15/14/49 →
    16/24/11/60 and RotWK 70/65/168 → 77/99/179 (main with the flags off: 65 vs 80) follow the guest work per frame,
    which varies by up to 15 % between sessions of the same scenario (6.4-7.0 M instructions per frame for main alone).
    Same heat as before once a pass completes (tests/jit-heat-harvest.test.js: randomized against copies of the old
    harvest and merge).
  - The first sessions' heat was learned with one flag per block of each region: ~680 000 blocks for ~200 000 addresses
    exhausted the 320 KB flag area halfway, the heat missed half the code that ran (1.0 instead of 2.0 MiB for RotWK),
    and the next sessions left out edges they do take (RotWK then neutral in the browser). Fixed (one byte per address).
  - Node play, in-session A/B (4-6 rounds of 20 s): heat of 30 s of the same play — RotWK −13 % (visits), −4 / −6 %
    (counters), BFME2 −4 / −5 %, BFME1 −8 % (counters), Vice City −8 % (counters); a whole earlier session's heat:
    BFME2 −4 %, RotWK −7 % without the cold tier, 0 % with it (`--cold`; not seen in the browser, which also
    prewarms the learned regions). Visit flags on every block (a first session): +3 %, within the spread.
  - Open: with heat-cut regions, hot backward transfers through the region dispatcher (`dispatchBackTop`, Node
    `--jit-profile`) tripled (775 M vs 266 M over two minutes of RotWK): the reverse postorder of the cut graph lets
    loops overlap, and planUnits keeps disjoint loops only. A weak topological order (every cycle contiguous) brought
    them back to 264 M but was not faster overall (RotWK +6 %, BFME2 −3 %; not kept, see below).
- **A shared chained exit** (`chainStub`, off since the re-measurement below): a region's jump exits write its x87 / XMM caches back and tail-call the
  runtime module's `chain` function (runtime.js chainStubCode) with the target in place of the block index; `chain`
  checks the budget, API thunks, the stop address and address 0, probes the hash table, and tail-calls the target's
  region at its block, or writes the registers, flags and budget to the state block and returns the target to the
  dispatcher — what every region carried at the end of its body (the checks, four unrolled probes, the indirect
  call's sequence, the non-chained flush: ~300-700 bytes, a quarter of the instruction fills of region code) is one
  function for all of them, which stays in the caches. One more tail call per transition: +3 ns per chained
  call/return when everything is cached (chain-bench: int 22.6 → 28.9 ns, x87 29.6 → 40 ns), but the instruction
  fetch dominates in play. Node in-session A/B (6 rounds of 25 s, x87Top in both): RotWK −5.7 % guest time per
  instruction (emulator thread CPU −6.8 %), BFME2 −5.0 % (thread CPU −5.9 %). Profiling translations (`profile`)
  keep the inline exit (their counters tell chains apart by source). Also tried: one copy of the function in each
  region module (a direct tail call, no instance switch) — 3 % fewer host instructions in chain-bench, not worth the
  copies.
- **x87 regions specialized for the stack top** (`x87Top`, off since the re-measurement below): an x87 region's mode (`fpcAssume`, the versions, the
  learned lists) carries the stack top at its entry (`X87_MODE_TOP | TOP`, translate.js x87ModeOf); the entry guard
  compares the control word and TOP less the entered block's planned shift, and once it passes L_TOP is a constant:
  the eight stack locals, the tag word and TOP are loaded and written back at constant offsets (8 loads / stores
  instead of 8 × (3 ALU + memory), no rotation of the tag word by a run-time amount). chain-bench x87 call/return
  36.2 → 29.7 ns (−18 %, host instructions −10 %). Another top under a control word the region has a top-specialized
  version for: the region is translated again testing the top at run time (`genericTop`, the earlier code; Vice City
  drive: 483 regions of 11 052, 79 versions instead of 848 when every top got a version, which made entries with
  varying tops run a failing guard first). Learned entries without a top (sessions of an earlier build) are
  translated testing the top at run time (assuming TOP 0 made the first browser session drop and translate again,
  on the game's thread, the learned regions entered with another top: `jit` and `interp` time in slow frames); the
  entries a session learns carry their top. Exact: tests/jit-x87-top.test.js (random tops, stack contents including the values
  of empty registers, control words, FDECSTP / FINCSTP, slices down to one instruction, calls into other regions
  returning values on the stack, one JIT re-entered from other tops; fails when the guard ignores the top). Node
  in-session A/B, noisy: Vice City −2.9 %, RotWK −1.2 % (6 rounds; an earlier version policy gave RotWK −3.4 %, BFME2
  −8.6 % over 4 rounds and Vice City +5 %).

- **No dispatch loop when nothing goes back through the dispatcher** (`dispatchBlock`, off since the re-measurement
  below): a region whose backward transfers all stay in structured loops (no `dispatchBackTop` /
  `dispatchRetTop`) has its dispatcher's `loop` turned into a `block` once emitted (one opcode byte: nothing branches
  to its start, so the control flow is the same) — TurboFan then neither aligns a loop header nor checks the stack
  there nor merges every live value into it at each entry. Node in-session A/B (6 rounds): BFME2 −6.0 % (5 rounds of
  6, thread CPU −6.2 %), RotWK 0.0 % (±11 % per round).

- **Re-measurement of the three (2026-10-04): no gain, all off.** The figures above came from 4-6 Node rounds whose
  spread (±10-20 % per round: the game's work drifts during play) is larger than the effects. Measured again with
  longer series and in the browser, each option with the others on (leave-one-out) and all together, guest time per
  instruction in play (`guestMsPerMInsn`), in-session switches (`dbg:ORTHROS_JIT_AB`) with a warm-up phase after each:
  - Node, all three on vs all off, 8 rounds ABBA of 25 s: RotWK +4.8 % (on slower; per round −12 to +23 %), BFME2
    +4.3 % (−6 to +21 %). Leave-one-out, 3 rounds (ns per guest instruction, all on / chainStub off / dispatchBlock off
    / x87Top off / all off): RotWK 3.26 / 2.97 / 3.14 / 3.15 / 3.09, BFME2 3.55 / 3.26 / 2.93 / 2.80 / 2.95; Vice City
    driving (2 rounds, background translator and cold tier as in the page) 4.50 / 4.37 / 4.29 / 4.33 / 4.31.
  - Browser (`--gl-discard`, one session per game alternating the five variants ABCDE / EDCBA, 20 s warm-up + 25 s):
    BFME1, the steadiest (2 sessions), all on 2.93 vs all off 2.70 ns (+8.5 %), one option off 2.78-2.90; Vice City
    driving (2 sessions) all on 2.57 vs all off 2.23 (+15 %), one option off 2.22-2.47; BFME2 (2 sessions) all on 3.13
    vs all off 3.14, x87Top off 3.01; RotWK (2 sessions) all on 3.16
    / 4.07 / 3.46 / 8.90 vs all off 3.21 / 3.07 / 2.86 / 2.91: the variants with x87Top on spent 4.9-77 ms per frame
    translating and interpreting late in the session (versions per stack top, regions dropped for `genericTop` and
    translated again), those without 1.8-1.9 ms; frames > 50 ms per minute 274 (all on) vs 140 (all off).
  - Concurrent browser session pairs (one per game, all on vs all off, same learned data): all off faster in all four
    games (BFME1 p2 phase 2.52 vs 3.07 ns, BFME2 2.75 vs 3.17, RotWK 2.85 vs 3.02, Vice City 2.47 vs 3.00).
  - One Vice City session crashed under chainStub + x87Top during in-session switches (a WASM "null function" trap in
    a region: a table slot reached through a hash entry or an x87 version's slot after its region was dropped); not
    reproduced in Node (same scenario, background translator, 10 switches), not seen with the options off. To look at
    before turning either on again.
  - BFME2 first launch to the end of the startup computation, this build (options off) vs main: browser, 3
    concurrent pairs, guest time per instruction 0.577 vs 0.589 ns (0.61 / 0.54 / 0.59 vs 0.58 / 0.57 / 0.62); Node, 5
    runs each (2 alone, 3 concurrent), process cycles per guest instruction 1.83 vs 1.96. The time to the end is no
    measure of the code there: the main thread's guest work varies from run to run, 124-250 G instructions for the same
    computation (Node and browser alike, all of it on the main thread), so the wall time follows it (73-130 s).
  The code stays (options for measurement, tests/jit-x87-top.test.js and tests/jit-layout.test.js cover them); the
  translated-code cache keys on JIT_DEFAULTS, so the change of defaults starts a new cache.

## Transitions between regions (2026-10-05)

What a chained transition costs, where the transitions come from, and five ways to have fewer or cheaper ones — none
kept: fewer transitions came with more copies of the same code, and the play profile is bound by instruction fetch.

- **Where they come from** (RotWK, Node play with a learned heat, `--jit-profile`: 1 222 M chained transitions over
  54 G guest instructions, 22.6 per 1000; `--jit-sites` over the sites it could count, 750 M exits): returns leaving
  their region 51 % (7 300 sites; 45 % of them at sites that always return to the same place), static exits 20 %
  (`exitLim`, a successor left out for the region's size: 18 %), calls through a register or computed address 12 %
  (2 300 sites, 98 % of the exits at sites whose target never changes: virtual calls are monomorphic), indirect jumps
  12 % (import stubs `jmp [IAT]` into the C runtime, switch tables), calls through an absolute slot 5 % (`call [IAT]`).
  The hottest: the C runtime's memcpy / malloc / free family entered from the game through its import stubs, and
  their returns.
- **What one costs.** tools/chain-bench.mjs: 22.6 ns per call/return pair between integer regions, 36 ns between x87
  regions; `perf stat`: ~150 host instructions per transition at IPC 2.95 — the exit's checks (budget, thunk, stop
  address, address 0), the hash computation and probe, the table's signature check, the tail call moving 16
  parameters (11 on the stack), the callee's frame setup and the br_table to its block; the critical path is a chain
  of dependent loads (return address → hash entry → table entry → indirect jump). In play (`perf record` cycles, a
  hot region annotated) ~12 % of a region's cycles are its prologue (5 %) and chained exit (7.5 %), with region code
  ~60 % of the process's cycles: transitions are ~7-10 % of the guest time. Not data TLB misses (~2 M/s over the
  whole process, 60 % in regions: < 1 % of the cycles), not branch mispredictions (~1.8 M/s in regions).
- **Predicted indirect transfers** (removed): `call/jmp dword [slot]` translated as a direct transfer to the slot's
  value at translation time, guarded by a compare (the callee's blocks join the region, its RET returns locally; any
  other value leaves the region as before), and the same for calls and jumps through registers from a per-site table of
  last targets that their exits updated (predicted after 8 times in a row). Exact (randomized programs whose slots and
  registers change while they run, wrong and stale predictions, sliced, against the interpreter). Transitions −5 %
  (22.6 → 21.4 per 1000): returns leaving 604 → 490 M, indirect exits 373 → 171 M, but static exits 294 → 533 M —
  the C runtime's large functions copied into every caller filled the 48 blocks. Concurrent virtual runs (2 + 2):
  RotWK play +1 % (3.38 / 3.39 vs 3.47 / 3.37 ns), menu +18 %; register predictions alone: play 0 %, menu +4 %. More
  copies of the hot code, in a profile bound by instruction fetch.
- **Callee size limits and call-depth discovery** (removed): a predicted (and direct) callee joining the region only
  when its whole body is at most 8 (16) blocks: 21.0 (22.1) transitions per 1000; discovery taking the entry's own
  function first, then its callees by depth: 28.6 per 1000 (dispatches halved, transitions +25 %).
- **Region size, re-tuned** (kept at 48 blocks / 400 instructions). Concurrent virtual runs, guest ns per instruction:
  RotWK play 64 blocks / 530 instructions −3.3 % and −4.7 % (two batches), 96 / 800 −6.2 %; BFME2 play 64 +3.1 %, 96
  −2.6 % but +10 % thread CPU per frame (more guest instructions per frame); Vice City driving 64 and 96 +8.6 % (10 %
  fewer guest instructions in the same virtual time); menus faster with 96 (RotWK −5 %, BFME2 −10 %, BFME1 −10 %).
  Translation work: BFME2's load phase +38 % process CPU (V8 compiling larger functions). Browser (`--gl-discard`, one
  session per variant, same learned data): RotWK play 3.11 → 2.83 ns (−9 %, frames > 40 ms per minute 100 → 94, > 50 ms
  34 → 41); BFME2 play 3.07 → 3.20 ns (+4 %, > 40 ms 27 → 59, > 50 ms 2 → 7), its first-launch computation 0.64 → 0.61
  ns (228 → 236 s to the menu), its loading screen slower. A gain in one game, a loss in two: not changed. (Those
  browser sessions did not run 96 / 800, and the Node losses were the virtual clock's other interleavings: see "Region
  size" below — 96 / 800 is now the default, with the regions compiled by the background translator.)
- **Return-site records** (removed): a call leaving its region wrote its return site, the region's table index and
  the site's block into the thread's state block (a hash entry's layout; the index a relocated 5-byte constant, the
  records cleared when a region is dropped; not in x87-specialized regions, whose later versions the hash does not
  reach), and a chained transfer to that address skipped the hash probe. 7.5 % of RotWK's chains used it; play
  neutral (2.98 / 3.05 vs 2.98 / 2.90 ns), chain-bench equal (its probes hit L1 anyway).
- **Nested loops** (`nestLoops`) re-measured with heat-shaped regions (where back transfers through the region
  dispatcher tripled, see above): neutral (3.04 / 2.94 vs 3.06 / 3.04 ns).
- **API exits** (RotWK, whole session): the dispatcher's WASM fast paths ran `timeGetTime` 24 M times and deferred COM
  calls 24 M times (a region exit, the dispatcher's loop and a region entry each); in JavaScript `Sleep` 5 M (4.75 M
  `Sleep(0)` from one spinning loop), DirectInput `Acquire` / `GetDeviceData` 2.1 M each; a JavaScript API round trip
  costs ~275 ns (tools/apicall-bench.mjs). Each is under 1 % of the session: not changed.

## Region size (2026-10-05): 96 blocks / 800 instructions, compiled off the game's thread

Why larger regions (96 blocks / 800 instructions instead of 48 / 400) seemed to help RotWK and hurt BFME2 and Vice
City, the per-region size policies tried, and what was kept: **96 / 800 for every region, and the background
translator compiles the regions it sends (`bgCompile`)**. Node: concurrent `--virtual` runs, 2 per variant, `perf
stat -I` per phase, `perf record` of the play phase with the regions dumped at the end; browser: concurrent session
pairs (`--gl-discard`, the same learned data and heat, variant order alternated within a game), play-phase guest ns
per instruction (`guestMsPerMInsn`) and frames > 40 / > 50 ms per minute.

**The earlier browser comparison (bullet "Region size, re-tuned" above) did not run 96 / 800.** A run queue passing
`--jit-opts '{"maxBlocks":96,...}'` through `xargs -I{}` loses the JSON's quotes, the page's `JSON.parse` fails
silently, and every "96" session ran 48 / 400 — the same region and block counts in the `[report] JIT:` line. Check
that line in any variant run. Its BFME2 +4 % and Vice City +8.6 % (Node) are not reproduced below.

### Where the difference comes from

- **The hot code is in regions that stop for their size.** At 48 / 400, 35-38 % of the regions stop at the limit
  (RotWK 8 046 of 21 263, BFME2 7 510 of 20 330, Vice City 2 097 of 5 968) and they run 56 % (RotWK), 48 % (BFME2),
  75 % (Vice City) of the region code's time. At 96 / 800 a quarter still stop at 96 and hold 40-50 %: the hot code is
  in large functions that no fixed size closes.
- **Fewer transitions, fewer instruction-cache fills.** 96 / 800 (profiled runs, play): chained transitions −22 %
  (RotWK 1 137 → 889 M, BFME2 1 657 → 1 293 M), static exits −50 to −67 %, exits for space (`exitLim`) −50 %; but
  dispatches through a region's own br_table +20 % (RotWK) / +46 % (BFME2: backward transfers outside structured loops
  381 → 575 M). Instruction-cache fills from L2 −10 %, from beyond L2 −10 to −30 % per host instruction, IPC +2-4 %:
  the entry and exit code no longer touched outweighs the larger bodies.
- **Per region** (RotWK play, perf samples per guest instruction, regions matched by entry): regions whose shape did not
  change −5 % (less pressure from the others), the grown regions and those they absorbed −13 % together. BFME2: same
  shape +1 %, the changed ones −7 %.
- **V8 tiers, register pressure, translation work**: Liftoff's share of the region samples 5.7 → 5.0 % (RotWK), 8.4 →
  6.9 % (BFME2) — larger functions tier up no later; TurboFan on V8's background threads +13 % (RotWK), −9 % (BFME2);
  translation on the game thread in play lower (fewer misses); the background worker translates more (BFME2 load,
  process CPU +25-30 % in Node).
- **BFME2's apparent loss in Node is the virtual clock**: a region shape moves where time slices end, the deterministic
  interleaving changes, and the 96 run executes 7-8 % more guest instructions for the same frames (more API calls:
  JavaScript 20.6 → 23.8 % of the main thread), so the emulator's CPU per frame rose while every guest instruction
  got cheaper (play −5.5 %, menu −16 %). Vice City likewise (+11 % instructions in the same virtual time).
- **Vice City's slow frames: V8's lazy compilation.** V8 compiles a WebAssembly function at its first call, on the
  calling thread (`--wasm-lazy-compilation`, on in Node 24 and Chrome): a region the background worker translated was
  compiled by the game's thread when it first ran. Liftoff costs ~35 ns per byte of WASM on this machine (eager
  `WebAssembly.Module`: 48 blocks ~20 KiB ≈ 1.5 ms, 96 ~39 KiB ≈ 3.4 ms, 144 ~55 KiB ≈ 4.9 ms), and a frame entering
  new code (Vice City driving into a new area) pays it for each region it enters — the larger the regions, the longer
  each stop. Vice City drive + drive-end, frames > 40 ms per minute: 48 / 400 13-32 (mean 18, 14 sessions), 96 / 800 22,
  26, 33, 39, 41; with Chrome's `--js-flags=--no-wasm-lazy-compilation` (compiled where the background worker builds
  the module): 48 10, 11, 11, 11, 8 (16 and 24 for the lazy session of the same pair), 96 9, 13, 12, 9 (41 lazy);
  96 vs 48, both eager, 9 / 10, 13 / 11, 12 / 8.

### Policies tried

1. **One size for all** (`maxBlocks` / `maxInsns`): 96 / 800.
2. **Growth of hot full regions** (removed; commit ce9b658): the slice ends (every 100 000 guest instructions,
   Vm.sliceEnd) sampled where the threads were; a region that had left code out for its size and collected 16 samples
   in a window of 8 192 was translated again with its limits ×2 or ×3 — by the background worker, installed in place of
   the region if still live — its x87-mode versions at the same limits, the code cache keeping the grown shape apart
   from the region it grows (neither superseding the other). ~420 regions grown in RotWK play (×2, 16 samples), ~1 070
   with 4 samples. A variant admitting past the usual size only successors in recently sampled regions: no better (RotWK
   −4.5 vs −6 %, BFME2 +2 vs 0 %).
3. **Larger off the game's thread** (removed): the background translator's regions (learned regions, cold-tier
   requests) ×2, misses translated on the game's thread at 48 / 400.
4. **Compiled off the game's thread** (`bgCompile`, kept): not a size policy — what makes any size cheap for the game's
   thread. The background worker calls each region of a batch once before sending it (bg-translate.js compileHere):
   block index −1, on a state block no thread uses (memory.js JIT_WARM_STATE); the prologue's loads run, then the
   dispatcher traps (or an x87 region's guard leaves, writing that block, or tail-calls the worker's own empty table: a
   trap). V8 compiled the function on the way, and a module's code is shared by all its instances in every worker.
   Node, Vice City drive with the background translator: V8 compilation on the game's thread 2.2 → 0.7 % of its samples.
   Exact: tests/jit-bg-compile.test.js (randomized programs, x87 modes, SMC, sliced; the code, data, thread state block
   and x87-version slots unchanged by the calls).

### Results

Node (concurrent virtual runs, play-phase guest ns per instruction vs 48 / 400; `--cold`: background translator and
cold tier as in the page):

| variant | RotWK | BFME2 | BFME2 menu | Vice City drive |
|---|---|---|---|---|
| 96 / 800 | −8 to −12 % | −5.5 % | −16 % | −13 to −17 % (other interleaving) |
| grow ×2 | −6 % | | | −8 % |
| grow ×3 | −5 to −6 % | −3 / 0 % | −5 to −8 % | −13 % (other interleaving) |
| 96 / 800 + grow ×2 | −8 % | −5 % | −18 % | −15 % |
| `--cold` 96 / 800 + bgCompile | −7 % | −3.5 % | −12 % | |
| `--cold` background ×2 + bgCompile | −4 % | −6.6 % | −13 % | |

Browser, lazy compilation (no bgCompile), pairs vs 48 / 400 — play ns, frames > 40 ms per minute (variant / 48):

| variant | BFME2 | RotWK | BFME1 | Vice City (drive + drive-end) |
|---|---|---|---|---|
| 96 / 800 | −12.6 %, 10 / 10; −11.7 %, 16 / 7 | −5.5 %, 24 / 55; −6.2 %, 32 / 43 | −3.8 %, −3.5 %; 0-1 / 0-1 | 33 / 14, 26 / 13, 22 / 18, 39 / 32 |
| grow ×3 | −5.9 %, 19 / 11; −1.4 %, 15 / 23 | −1.5 %, 29 / 48; −6.2 %, 23 / 42 | −5.3 %, −6.5 %; 0-1 | 24 / 16, 55 / 20, 21 / 15, 30 / 14 |
| background ×2 | | | | 28 / 23, 17 / 17 |

Browser with bgCompile, pairs vs 48 / 400 without it (the default until now):

| variant | BFME2 | RotWK | BFME1 | Vice City |
|---|---|---|---|---|
| 96 / 800 + bgCompile | −7.9 %, 6 / 8 | −7.7 %, 36 / 65 | −4.3 %, 1 / 1 | 5 / 16, 24 / 58, 10 / 13 |
| background ×2 + bgCompile | −5.9 %, 11 / 15 | −5.4 %, 35 / 56 | −2.6 %, 1 / 0 | 9 / 17 |
| 48 / 400 + bgCompile | −5.5 %, 18 / 20 | −4.7 %, 57 / 41 | +2.6 %, 1 / 1 | 11 / 14, 11 / 17, 6 / 17 |

96 + bgCompile against background ×2 + bgCompile, same pairs: BFME2 2.43 / 2.38 ns, RotWK 2.38 / 2.38, BFME1 2.17 /
2.20, Vice City 13 / 11 frames > 40 ms per minute. Vice City's guest ns per instruction follows its instruction mix
(15-24 G instructions for the same 3 100 frames, the game's frames fully busy), not the code: its guest ms per frame
(drive-end) 11.7 / 13.0, 14.2 / 16.1, 13.0 / 12.6 for 96 + bgCompile / 48. Menus: BFME1 −8 %, RotWK −14 %, BFME2
−21 % (frames > 40 ms per minute 250 / 354). Loading screens: the same length (map loads end on the game's
`waitframe`), the game thread's translation time in RotWK's load phase 22-24 → 35 ms per frame (larger regions at the
misses), its guest time lower. BFME2 first launch (`bfme2-first.txt`, no profile, 560 s — the first-launch
computation did not end within it in any run on this loaded machine): guest ns per instruction 0.600 / 0.585 (48) →
0.445 / 0.447 (96 + bgCompile) and 0.445 / 0.450 (background ×2 + bgCompile), 13 % more guest work done in the same
time, frames > 40 ms per minute ~310 → ~60.

Final build, new defaults against the old ones set through `?jitopts` (`{"maxBlocks":48,"maxInsns":400,
"bgCompile":false}`), one concurrent pair per game (two for Vice City): BFME2 play 2.31 / 2.50 ns (−7.4 %), frames
> 40 ms per minute 7 / 17, menu −19 %; RotWK play 2.26 / 2.48 (−9.1 %), 31 / 40, menu −14 %; BFME1 play 2.13 / 2.25
(−5.7 %), 1 / 1, menu −8 %; Vice City frames > 40 ms per minute 12 / 17 and 12 / 15, guest ms per frame (drive-end)
12.4 / 13.1 and 12.5 / 13.3, p99 35-36 / 37-38 ms (its ns per instruction +13 % and +4 %, with 15.2 / 18.1 and
17.4 / 19.0 G instructions for the same frames: the mix, see above).

**Kept**: 96 / 800 and bgCompile by default (translate.js JIT_DEFAULTS; the translated-code cache keys on them: the
first session after the change translates again). The per-region policies did not beat one larger size once the
compilation left the game's thread; growth stayed short of 96 / 800 in every game and, compiled lazily, cost Vice City
the same slow frames. Residual cost: the misses translated on the game's thread (and the cold tier's hot entries)
compile there lazily, at 96 / 800 (RotWK's load phase above).

Review re-measure (one more concurrent RotWK pair, `--gl-discard`, same learned data and profile; the 48 / 400 run's
`[report] JIT:` line confirms it ran 48 / 400: 692 k blocks, 10 MiB of WASM, against 961 k, 19 MiB): play 2.51 /
2.74 ns per instruction (−8.3 %), frames > 40 ms per minute 40 / 81, p99 47.5 / 57.1 ms; menu 2.71 / 3.07 (−11.5 %).
An unparsable `?jitopts` is now reported (`[warn] jitopts ignored`), and `tools/headless.mjs --jit-opts` refuses
one that is not JSON.

## x87 regions: the size of the arithmetic (2026-10-06)

In BFME1's map load the x87 arithmetic was ~10 % of the instructions executed but ~38 % of the translated code's
weight: 212 WASM operations per FMUL, 177-186 per FSUB / FADD / FADDP, against 15 per MOV. The hot path of an operation
in 24-bit round-to-nearest mode is short (the f32 operation and one exponent test; for double operands the f64
operation, two integer tests and a demotion); the rest was the exact cold paths, inline in every instruction: the x87
NaN rule (nanF32 / nanF64, ~75 operations), the 24-bit midpoint settlement from double operands (TwoSum / Dekker, ~70),
the zero and infinity exactness tests, and a step exit that rotated the eight stack locals. Three changes (translation
options for measurement, defaults on):

- **Cold paths as runtime kernels** (`x87Cold: 'call'`; `'inline'` is the earlier code): fpmath-x87cold.js emits the
  cold code once per operation code in three kernels of the runtime module — `x87ArithF32` (float operands: exact
  zero / infinity, NaN rule), `x87RoundF32` (double operands: infinity, midpoint, NaN that is a float), `x87NanArith`
  (53 / 64-bit precision: NaN rule, IE) — from the same emitters that still produce the inline form, so both run the
  same operations on the same values. The region calls them on the branch-hinted path (TurboFan's deferred code: the
  spills around the call are made there, not on the hot path — checked in the machine code and by host instructions
  per iteration, below); what stays inline is what is frequent: the exponent / midpoint tests, a zero result (a product
  by zero is common in 3D code), and for double operands the midpoints of float operands (sums of floats one exponent
  apart land on one half the time). Removing the duplicated midpoint test from the cold path also lets TurboFan fuse
  the hot path's compare and branch (it materialized the shared condition with setcc / movzx / test before).
- **Exits without rotating the x87 stack** (`x87ExitRotate: false`; Emitter.x87ExitState): local L_ST0+k holds physical
  register (L_TOP + k) & 7 whatever the block's pending shift, so an exit writes the shadows back and applies the tag
  changes but leaves the locals where they are; the shift travels in L_XSH (the unused L_T8 renamed: 0 on every path
  that does not set it, since a path setting it leaves) and the exit block stores TOP = (L_TOP + L_XSH) & 7. An exit in
  the middle of a block that pushed (step exits of the arithmetic, SMC checks after FSTP, budget exits) no longer
  emits the 30-operation rotation.
- **One exit tail** (`exitShare`, every region): the jump exits (chained or not) and the code exits (step, time slice,
  SMC, x87 mode) share one copy of the flushes — the x87 stack was written back three times in each x87 region's
  epilogue (chained path, jump exit, code exit), the registers twice; L_T2 = -1 marks a jump exit, which tries the
  chain first (the hash probe's home slot moves to L_T3 there).

Exactness: tests/jit-x87-cold.test.js — operands of every class (zeros, float and double denormals, the float range's
edges, overflowing / underflowing products, infinities, quiet and signaling NaNs of both signs, payloads that fit a
float or not, midpoints from 0.9 / 0.1 / 1/3 / 2^-24+2^-60) through float, double and register operands under
control words 0x7f, 0x47f, 0xc7f, 0x27f, 0x37f and without the float representation (ORTHROS_NO_F32): the kernels
and the inline code give the same bits, status word and interpreter steps, and the interpreter's results; random
floats times / plus / minus non-float doubles in a loop (the Dekker / TwoSum path); exits with a pending shift (SMC
exit, step exit, time slices) against the interpreter and the rotating exits from TOP 0, 3, 7. Mutations caught: the
exit block ignoring L_XSH, the wrong operation code passed to x87RoundF32. With the earlier options the translator
emits the base commit's code (tools/x87-size.mjs: the same WASM and machine-code sizes for all 36 regions).

## Measured, not kept

- Chained exits each with its own chain code (`siteChain`: the hash probe and tail call at every exit site, the probe
  addresses constants for static targets) instead of one shared exit: RotWK +15 %, BFME2 +52 % (Node in-session) —
  every tail-call site pins all sixteen values to the call's argument places, and the code grows.
- Region parameters packed so that none goes through the stack (5 i32 + 6 f64 holding two i32 each, V8's x64 argument
  registers): +4 % in RotWK play, and slower in a calling-convention microbenchmark (the packing costs more than the
  stack arguments it saves).
- 11 i32 region parameters (block, state, 8 registers, budget), EFLAGS and the 4 lazy-flag values in the state block
  (loaded by every region's prologue, stored before every chained tail call) — 2026-10-06, stopped at the gate:
  `tools/chain-bench.mjs` (Node 24 / V8 13.6, alternated with main) int 22.7 → 26.6 ns, x87 36.2 → 43.0 ns per
  call/return pair. The parameter count itself is worth ~0.3 ns per pair (the same 11-parameter code without the five
  loads and stores — exact for that bench only — 22.2 ns); the prologue loads cost ~3.5 ns per pair and the stores
  ~2.2 ns, so skipping the loads for blocks whose flags are dead cannot pay either. The exactness suite passed on the
  prototype (only the listing / code-shape tests needed their local numbering updated).
- Regions that end where another region already translates the block (`dedup`: an exit chaining into it, no copy): the
  translated code shrinks (process CPU −15 %, less compilation) but the extra transitions cost more: guest time per
  instruction RotWK +6.8 %, BFME2 +10 %.
- Region entry at its first block by a compare instead of the br_table (`entryFast`) and the chained exit's probes
  after the first and its non-chained path hinted out of line (`coldChain`): RotWK −1 %, BFME2 +2.8 %, within the
  noise.

- Heat by time windows (visit flags re-armed every 10 s; a successor cold when it ran in fewer than a quarter of the
  windows its branch ran in): worse than "never ran" (RotWK Node in-session: +4 % vs −7 %, and translation storms).
- Weak topological block order (`layout: 'wto'`, Bourdoncle): Node in-session, RotWK +6 % with heat, +15 % without;
  BFME2 −3 % with heat, +2.5 % without.
- 96-block regions with heat: −3 % in one RotWK run, within the spread, more translation work.

- Dead bytes at a region's start (`tierPad`): small regions tier up to TurboFan ~4x sooner in tierup-bench, nothing in
  play (Liftoff is <1 % of the region samples in Node play).
- Lazy flags rebuilt at exits from the registers the flag instruction read (so that the lazy values die at their
  branch instead of living to every exit): exact (randomized test against the interpreter), +1 to +2 % in play.
- Region size 24 blocks (+6 to +11 % in the browser), 96 blocks (before 2026-10-05: −2.5 % in Node play alone, neutral
  with the layout, slower first launch; see "Region size"), nested loops on top of the layout (neutral), `L_BLK` set before back edges (+3 %).
- Dropping the lazy flags at exits entirely (an inexact experiment to bound the previous one): the games misbehave
  within seconds — exits do resume where flags are read.
