# The shape of translated code: measurements and tools

What the x86→WebAssembly translator (src/cpu/jit/translate.js) produces, where the time goes once V8 has compiled it,
and the instruments used to compare code-generator variants. Measured on BFME1, BFME2, RotWK and Vice City (2026-10-02).

## Instruments

- **Node play** — `tools/bench/startbench.mjs <manifest-id> --games-dir <catalog> --input <scenario> --phases out.json`: a
  harness scenario (tools/scenarios/*.txt, the language of tools/headless.mjs) played in Node on the headless host
  (tools/bench/node-scenario.mjs): mouse, keys, text, `waitframe` / `waitfps` anchors on the Direct3D device's draws and frames,
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
  per guest instruction kind (tools/bench/jit-mix.mjs). `--jit-profile`: transitions by kind (chains, dispatches, returns), the jump exits not chained by
  reason (API thunk, stop address, budget, miss) and the API calls (RotWK play: 1.1 G chained transitions, 43 M
  exits to API thunks, 29 M API calls run in JavaScript, 0.2 M budget exits over 48 G guest instructions).
- **Kernels** — `tools/bench/shape-bench.mjs --opts <json> --vs <json>`: small x86 kernels written for it (binary search, abs,
  array read-modify-write, calls, predictable branches, x87 at 24/53/64-bit precision, a hot loop next to cold code),
  ns per guest instruction of two variants alternated.
- **V8 tiers** — `tools/bench/tierup-bench.mjs`: a small region entered over and over for short runs, its speed as the entries
  accumulate (Liftoff until TurboFan; Liftoff charges the tiering budget by code position).
- **Branch hints in Node** — Node 24's V8 (13.6) ignores WebAssembly branch hints unless
  `--experimental-wasm-branch-hinting` is set; Chrome honours them (since 137). The translator's hints put exits, SMC
  and fault paths, NaN rules... out of line (TurboFan's deferred blocks), so Node measurements made without the flag
  had the cold code inline, unlike the browser (checked on the machine code: the unlikely arm inline without the
  flag, after the function's hot code with it; RotWK play IPC 1.04 → 1.17, instruction fills from beyond L2 14.7 →
  10.6 per 1000 host instructions). The measurement tools (startbench, shape-bench, chain-bench, tierup-bench) set
  it (tools/bench/node-wasm-flags.mjs); earlier Node figures in this document were measured without.
- **Thread CPU** — node phases also report the emulator thread's CPU time (`threadCpuS`, `process.threadCpuUsage`):
  on a loaded machine the categories' wall-clock time grows while the thread waits for a core, its CPU time does not.
- **Instruction fetch** — `perf stat -e cycles:u,instructions:u,ic_fetch_stall.ic_stall_any:u,ic_cache_fill_l2:u,
  ic_cache_fill_sys:u` (AMD Zen 2) around a Node play run, `perf record -e ic_cache_fill_sys:u` with `node --perf-prof`
  and `perf inject --jit` for where the fills land (the region functions are named `r_<entry>`); `startbench
  --blocks-out <file>` (with `dbg:ORTHROS_JIT_AB={"blockCounts":true}`) lists every counted region's blocks and
  counts: how many regions hold a copy of each hot guest block.
- **Deterministic concurrent runs** — `tools/bench/ab-virtual.mjs <manifest-id> --input <scenario> --variant A='{}' --variant
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
  `--perf` (2026-10-22): each run under `perf record -e instructions:u,cycles:u` with TurboFan only (`--no-liftoff`), and
  per variant the whole run's user instructions and cycles in perf's `[JIT]` object (the WASM regions, the runtime
  module, V8's JavaScript code) and in the process; `--jit-opts NAME='{...}'` adds Jit options to one variant
  (`nestLoops`...). The same guest work gives the same counts: on the bfme-vanilla 3D menu scenario below, two runs of
  one build 316.57 / 316.61 G JIT instructions (0.01 %), 1 086.1 / 1 087.2 G process instructions; JIT cycles within
  ~1 % in one batch (load average 4-35), the time measures within ±3-5 %. Instructions resolve a 0.2 % change of the
  code; cycles only what the load leaves (compare a batch's runs only). The process figures include V8's compilation,
  on the emulator thread with `--no-liftoff` (the browser compiles off it).
- **Exit sites** — `startbench --jit-sites [--jit-sites-top n]`: every region exit site (indirect calls through a
  register or a computed address, through an absolute slot, indirect jumps, returns leaving their region, static exits
  — `exitLim`: to a successor discovery left out for the region's size; `...Call`: of a call) counts its executions,
  last target and target changes (translate.js siteProf, three counters per site address in the block-counter area):
  totals by kind, how many sites make 90 % of the exits, the share at sites whose target changes in less than 5 % of
  the exits. `--jit-profile` also lists the fast-path API calls the dispatcher ran in WASM, by API.
- **Code size of x87 regions** — `tools/bench/x87-size.mjs [--ab <root>] [--cw 0x7f,...] [--disasm <case>@<cw>]`: small
  regions shaped like compiler x87 output (the x87loop-bench loops, double and register operands) translated under
  several control words: WASM operations per x87 arithmetic instruction, WASM body bytes and TurboFan machine code bytes
  per region (V8's `--print-wasm-code`, eager TurboFan, branch hints honoured), against another src tree with `--ab`.
  On a game: `startbench --mix` prints the x87 regions apart (`[shape] x87 regions: ...`), and with
  `ORTHROS_X87_DUMP=<dir>` writes every live x87 region's module translated now and with the earlier x87 options
  (`<dir>/new`, `<dir>/old`); `x87-size.mjs --modules <dir>` compiles both sets for their machine code.
- **x87 kernels** — `tools/bench/x87loop-bench.mjs` runs TurboFan code only (`--liftoff`: V8's tiers as they come; see
  "x87 regions: the stack cache by use" for why) and checks only the cases it measures.
- **Hot-path cost of one region** — x87loop-bench's loops under `perf record -e cycles:u,instructions:u` with
  `node --perf-prof --no-liftoff`, `perf inject -j`, the `JS:r_*` symbols' periods divided by the iterations: host
  instructions per iteration are steady on a loaded machine where cycles and wall time are not. x87loop-bench itself
  does not set `--experimental-wasm-branch-hinting`: without it V8 keeps the cold paths inline and a call on one of them
  costs spills on the hot path (one of its loops measured +17-24 % that way, -4 % with the flag) — set the flag
  (tools/bench/node-wasm-flags.mjs) for anything meant to stand for Chrome.

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
  (tools/bench/chain-bench.mjs, everything cached; x87 regions ~36 ns, their stack cache loaded and written back); in play
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
- **What one costs.** tools/bench/chain-bench.mjs: 22.6 ns per call/return pair between integer regions, 36 ns between x87
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
  costs ~275 ns (tools/bench/apicall-bench.mjs). Each is under 1 % of the session: not changed.

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

## BFME1's map load (2026-10-06 / 2026-10-14)

BFME1's skirmish map load (`bfme-phases.txt`, the `loadscreen` phase) runs ~40 G guest instructions on the game's
thread in ~60 s of Node real clock: ~1.4 ns per guest instruction, 95 % of it in translated code, the 10 hottest
regions 63-68 % of the counted instructions (mix: MOV 18-21 %, JCC 9-9.5 %, FLD 6.4-7.7 %, CMP 5.2-5.5 %, FSTP
5.0-5.9 %, FMUL 3.4-3.9 %, CALL 1.5 %, RET 1.2-1.4 %; block counters switched on at the load mark, so only the
regions translated during the load are counted). Part of its x87 code runs under **24-bit precision with rounding
toward zero** (control word 0xc7f-like: code that truncates for its FISTPs sets it for whole computations) — few
regions (`startbench --x87-modes`, new, live regions by mode at the end of the load: none 6 642, 24-bit nearest 1 564,
53-bit 57, 24-bit toward zero 30, 64-bit 4) but, by the A/B below, most of the time this branch saved: the x87
arithmetic of a region specialized for a static directed 24-bit mode was the expensive part:
every FADD / FMUL / FSUB... rounded its f64 result to the 24-bit grid with a vector mask (its constant rebuilt per
instruction), a range test with f64 compares on |s| (two constants, three compares), and results already on the grid
(exact sums of values with few significant bits, x − x) went out of line to an exactness test with f32 round trips of
both operands: ~25 host instructions per arithmetic instruction.

Changes (all generic, exact against the interpreter):

- **Toward-zero rounding on the result's bits** (translate-x87.js `roundTowardZero24`): the f64 result's bit pattern,
  integer tests only — off the 24-bit grid with an exponent field in [2, 0x7fe], masking the 29 low significand bits
  is the x87 result (f64 rounding never crosses a grid point without landing on it); on the grid, a zero as computed
  or the value itself when exact (`pushExactOnGridAt`: TwoSum's error term for sums, the operands' low bits for
  products / quotients / square roots); anything else (denormal, infinite, NaN, the lowest normal binade) leaves the
  region for the interpreter. ~11 host instructions for an off-grid result. The on-grid path is no longer hinted out of
  line (common in that code), and TwoSum of a difference adds instead of negating (same values, no constant).
- **Narrow values** (`Emitter.g24Mask`): registers known at translation time to hold a 24-bit significand (m32 and
  m16 operands, FLD1 / FLDZ, results of 24-bit arithmetic, copies, FCHS / FABS / FXCH of such) — a product or quotient
  of two needs no grid test, only the exponent test. Dropped wherever the f32 shadows are (block entry, fallbacks,
  rotations). FST m32 under a static directed 24-bit mode stores a value that is already a float after one compare.
- **The status word in a local** (`swLocal`, default on; translate.js `L_SW`): x87 regions load it with the stack
  cache and write it back with it; the compares, FNSTSW, FNCLEX, the per-block C1 clear and the exception flags update
  the local instead of a load and a store of the state block each (`FCOM; FNSTSW AX; TEST AH; Jcc` chained three
  store-to-load forwardings, loop-carried). JIT option, so it can be A/B'd: `ORTHROS_JIT_DEFAULTS={"swLocal":false}`.
  The translated-code cache keys on JIT_DEFAULTS: the first session after the change translates again.
- Fidelity found by the new randomized status-word test: unordered FCOM / FICOM / FTST / FCOMI now raise IE as the
  interpreter does (FUCOM / FUCOMI only for a signaling NaN) — in the compare's cold path (C2 / PF set).
- Tools: per-phase `--jit-profile` in scenarios, `--list-top` lists the counted regions with their x87 mode,
  `--x87-modes`, `tools/bench/x87loop-bench.mjs --full / --src` and a 41-instruction sums-of-squares kernel.
- Tests: tests/jit-x87-narrow.test.js (random programs under every precision / rounding control, time slices, a wide
  operand whose product rounds onto the grid while inexact, narrow products / quotients chained past both ends of the
  double range under truncation), tests/jit-x87-sw-local.test.js (random compare / FNSTSW / SAHF / branch / FNCLEX /
  exception / FPREM programs with swLocal on and off, the whole status word compared, time slices).

Results (base ca01ae8 against this branch at e1232f6):

- **Node, concurrent real-clock pairs** (`startbench --input bfme-phases.txt`, the same profile copied for each run,
  launch order alternated; `loadscreen` phase): quiet machine (load average ~20) 60.8 → 47.8 s (1.451 → 1.121 ns per
  guest instruction) and 59.4 → 46.2 s (1.416 → 1.101 ns): **−21 / −22 % map-load time, −23 / −22 % ns per
  instruction**; loaded machine (load average ~40, other projects) 75.7 → 48.8 s and 88.3 → 65.3 s (1.693 → 1.162,
  2.042 → 1.400 ns). The same guest work (40.0-40.9 G instructions in every run).
- **swLocal alone** (this branch, off / on, concurrent pairs, alternated): map load 1.201 → 1.161 and 1.196 → 1.172 ns
  per instruction (−3.3 / −2.0 %), play 2.955 / 2.955 and 2.870 / 2.844 ns: most of the gain is the toward-zero path.
- **Play, no regression**: BFME1 Node play (same pairs, quiet) 2.586 → 2.622 (+1.4 %) and 2.952 → 2.941 ns (−0.4 %),
  thread CPU 74.2 / 75.5 and 85.9 / 85.0 s for the same 6 136 frames — within the spread. (The two loaded pairs showed
  play +15 / +24 % for the branch: it finished its load ~25 s earlier, so its play overlapped the base's map load at full
  CPU and the base played its last 25 s alone; not seen when the machine was quiet, nor with swLocal off / on, whose
  loads end together.) Concurrent `--virtual` pairs (deterministic guest work), play / drive ns per instruction, two
  alternated pairs each: BFME2 2.587 → 2.457 and 2.522 → 2.549, RotWK 2.308 → 2.308 and 2.714 → 2.671, Vice City drive
  2.141 → 2.074 and 2.145 → 2.166 — neutral.
- **Kernels** (`tools/bench/x87loop-bench.mjs 2000000 --pos --ab <base>`, alternated in one process, median ns per
  iteration, control word 0xc7f): sums of squares 83.8 → 34.4, fild + fmul + fstp 21.4 → 12.4, xform 39.9 → 31.6,
  recurrence 18.5 → 15.4, e^x loop 38.1 → 29.8, fcom + fchs + fstp 12.6 → 10.3, fcomp + test ah 13.2 → 11.9.
  Under 0x7f / 0x27f the machine's load (±30 % per run) hid any difference; `perf record` cycles of the translated
  region per iteration (`perf record` on `node --no-liftoff --perf-prof`, as in the tool's header; 2 runs each): arith across blocks at
  0xc7f 109 / 93 → 58 / 55, fcomp + test ah at 0x7f 34 / 28 → 22 / 22, recurrence at 0x7f 15 / 17 → 19 / 22 (the same
  loop, two host instructions shorter — the C1 clear on a register instead of a read-modify-write of the state block —
  sampling noise).
- **Browser**, one concurrent pair (`headless.mjs --gl-discard`, bfme-phases, both browsers started together, the same
  profile and learned data copied for each): loading screen 62.7 → 50.3 s (−20 %), guest 1.413 → 1.135 ns per
  instruction; play 38 / 38 fps, 2.960 → 3.008 ns (+1.6 %, the branch's play phase 318 s against 302 s of the same
  560 s session: within the Node pairs' spread), work p50 14.2 / 14.3 ms, p99 33.8 / 32.5 ms, frames > 40 ms per minute
  9 / 8; menu 1.542 → 1.485 ns.

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

Size (static):

- tools/bench/x87-size.mjs, the 36 synthetic regions (9 loops x control words 0x7f, 0x27f, 0x37f, 0xc7f): WASM bodies
  122 055 → 73 603 bytes (−39.7 %), TurboFan machine code 193 920 → 162 900 bytes (−16.0 %), Liftoff code 318 064 →
  229 952 bytes (−27.7 %). By change: kernels −24.0 % WASM / −8.4 % machine code, unrotated exits −3.1 / −1.4 %
  more, one exit tail −12.6 / −6.2 % more (a constant ~430 bytes of WASM per region: a large share of these small
  regions). Operations per x87 arithmetic instruction: float operands (24-bit, round to nearest) 181 → 64, double
  operands in that mode 301 → 92, 53 / 64-bit precision 126 → 23, 24-bit directed rounding 111 → 81 (its cold tail
  was already shared; only the exits shrank).
- BFME1, the bfme-phases scenario in Node with block counters (`startbench --mix`, `ORTHROS_X87_DUMP`): the 2 970 x87
  regions live at the end of the run (of 17 017), each translated both ways (the same blocks): WASM
  bodies 53 128 → 40 001 KiB (17.9 → 13.5 KiB per region, −24.7 %), operations per guest instruction in x87 regions
  29.9 → 22.6; the 41 086 x87 arithmetic instructions 204.5 → 69.0 operations each, 30.6 % → 13.7 % of the x87
  regions' operations (prologues 6.0 → 7.9 %, epilogues 5.2 → 4.0 %). Modules compiled (TurboFan, eager, hints):
  54.30 → 41.32 MiB (−23.9 %; per region median −18 %, p10 −39 %, p90 −3 %), machine code 79.89 → 69.36 MiB
  (−13.2 %; per region median −11 %, p10 −25 %, p90 −2 %); Liftoff code 121.0 → 96.2 MiB (−20.5 %). Compiling the
  2 970 modules eagerly (`x87-size.mjs --modules <dir> --time`, best of 3 alternated rounds on the loaded machine):
  Liftoff 3.09 → 2.62 s (−15 %), TurboFan 31.3 → 30.3 s (−3 %; rounds 46 / 41 / 31 against 36 / 31 / 30 s).
- How often the cold paths run (BFME1 phases, profiling translations, `startbench --jit-profile`, counters
  `x87Arith` / `x87ColdEntry` / `x87ColdCall`): 18 150 M arithmetic operations on these paths (12 % of the run's
  146 G guest instructions), 1 167 M (6.4 % of them) entering the cold path — zeros and midpoints of float operands, still
  inline —, 4.3 M (0.02 %) calling a kernel.

Hot paths (x87loop-bench loops under `perf record`, branch hints on, host instructions per iteration in the region,
two runs each, base commit → this code; cycles moved with the machine's load, by −10 to +10 % between runs of the same
code, and were lower for the new code in 14 of the 18 pairs): `xform` 215 → 206; `recurrence` 46 → 42;
`arith across blocks` 134.5 → 133; `exp in loop` 233 → 229; `fild+fmul+fstp` 57.4 → 52.3; `fadd m64 midpoints` (a
double operand holding a float, its sums on a 24-bit midpoint 14 % of the time: the warm inline part of roundF32's
cold path) 50.6 → 47.6; `fmul m64 0.9` 69.2 → 62.2; xform at 53-bit precision 157.8 → 155.8, with truncation (0xc7f)
527.8 → 523.6. The machine code shows why: no extra spill on the hot paths, and roundF32's midpoint
test fused into compare-and-branch (`and; cmp; jz` instead of `and; cmp; setz; movzx; test; jnz`, the shared
condition gone from the cold path). Loops over NaN data (every operation calls a kernel; uninitialized memory in
BFME's menus did that): float operands (xform, 9 NaN operations per iteration) region + kernels 411 + 188 = 599
cycles against 739 inline — once the kernels test for a NaN result first (75 cycles per call before, 21 after);
double operands at 24-bit 107 against 100; xform at 53-bit precision 376 + 237 = 613 against 339 (x87NanArith ~26
cycles a call, plus the spills around it): the cost of the call where every operation is a NaN, a case seen in no
game measured (4.3 M kernel calls in the whole BFME1 run above).

Exactness: tests/jit-x87-cold.test.js — operands of every class (zeros, float and double denormals, the float range's
edges, overflowing / underflowing products, infinities, quiet and signaling NaNs of both signs, payloads that fit a
float or not, midpoints from 0.9 / 0.1 / 1/3 / 2^-24+2^-60) through float, double and register operands under
control words 0x7f, 0x47f, 0xc7f, 0x27f, 0x37f and without the float representation (ORTHROS_NO_F32): the kernels
and the inline code give the same bits, status word and interpreter steps, and the interpreter's results; random
floats times / plus / minus non-float doubles in a loop (the Dekker / TwoSum path); exits with a pending shift (SMC
exit, step exit, time slices) against the interpreter and the rotating exits from TOP 0, 3, 7. Mutations caught: the
exit block ignoring L_XSH, the wrong operation code passed to x87RoundF32. With the earlier options the translator
emits the base commit's code (tools/bench/x87-size.mjs: the same WASM and machine-code sizes for all 36 regions).

Whole runs (2026-10-14, base commit ca01ae8 in its own worktree against this code, concurrent pairs, launch order
alternated; Node: `startbench --virtual`, the same guest instructions in both runs of a pair; browser: `--gl-discard`,
copies of the same profile and learned data):

- **CPU of the whole process (Node), the gain that clears the noise**: Vice City (vicecity-drive, 5 pairs) 101-112 s
  → 91-99 s, −9.2 to −11.8 % in every pair; RotWK (rotwk-startup, 5 pairs) −0.4 to −3.3 %, all lower; BFME2
  (bfme2-startup, 5 pairs) −2.0 to +0.5 %, 4 of 5 lower. The emulator thread's CPU over the phases did not move
  (Vice City 9.9-14.3 s on both sides): the saving is in V8's compiler threads compiling the smaller x87 modules —
  perf record (instructions:u, one RotWK pair): V8 compiler 347.6 → 338.5 G host instructions (−2.6 %), translated
  regions 172.0 → 173.7 G (+1.0 %; the same tree under the old and new options: 188.7 → 188.5 G, −0.1 %: per-region
  counts move by ±30 % between runs where a region polls the time stamp counter, so neither is a difference).
  `perf stat` totals: Vice City 485.7 → 435.2 G instructions (−10.4 %), cycles −9.7 %; RotWK −0.4 / −0.6 %; BFME2
  −0.6 / −1.9 %. In a browser the compiler threads run beside the emulator's worker: CPU left to the page and the other
  threads on a client with few cores, not frame time.
- **Emulator thread per phase (Node), within the noise**: guest ns per guest instruction / thread CPU per frame, base →
  this code: RotWK play +1.0 to +4.9 % CPU per frame in the 5 cross-tree pairs, but −0.4 % and −2.1 % (and +1.1 % in
  an earlier one) in same-tree pairs of the old and new options (`tools/bench/ab-virtual.mjs`, which removes the second
  source tree); BFME2 play −2.5 to +3.8 %; Vice City drive −1.8 to +9.1 %, drive-end −0.8 to +18 % (runs of 40 s
  where the same code's pairs differ by as much); menus and loading screens ±5 %, `load` phases ±18 %.
- **BFME1 in the browser (bfme-phases, 3 pairs)**: play 38.3 → 38.3, 36.2 → 36.9 and 38.3 → 38.3 fps, guest
  10.7 → 10.9, 13.9 → 13.8 and 10.8 → 11.0 ms per frame; 3D menu guest +3.0 %, −10.3 %, +3.5 %; map load (load +
  loading screen) 69.5 → 68.1 s, 111.5 → 113.9 s (a loaded machine) and 68.4 → 67.6 s. No frame-rate or map-load
  change beyond the spread: play is not measurably faster for the 16 % less machine code of its x87 regions.
- Exactness and tests: the full suite (`make test`) passes but tests/accounts.test.js (needs data/games in the tree,
  fails on the base commit as well); with ORTHROS_NO_F32 the x87 suites fail the same two tests as on the base commit
  (the 24-bit random sequences and the NaN test written for the float representation), nothing more.

Kept for: 40 % less WASM and 13-16 % less machine code in x87 regions, compilation CPU −10 % on an x87-heavy game,
host instructions per iteration equal or lower on the hot loops; not for frame time, which did not change.

### Integration with the status word in a local and narrow values (2026-10-14)

The two branches were written against the same base and meet in two places, both fixed when they were merged:
- The cold kernels raise IE in the state block's status word, while regions with `swLocal` keep it in `L_SW` and write
  it back at their exits — an IE raised by a kernel would have been overwritten by the stale local (and missed by a
  later FNSTSW in the region). Around each kernel call the region now stores `L_SW` and reloads it (translate-x87.js
  `swOut` / `swIn`, on the cold path only), and the inline form (`x87Cold: 'inline'`) raises into `L_SW` (`emitRaise`'s
  `sw` argument). tests/jit-x87-nan-*.test.js and tests/jit-x87-cold.test.js fail without it; jit-x87-cold.test.js now
  also runs every case with `swLocal` off.
- `x87ExitState` (exits without rotation) did not save `g24Mask`, so `x87Restore` left it undefined after every exit:
  the narrow-value knowledge was lost past the first cold exit of a block (the toward-zero products then took the grid
  test again) and the Emitter field changed type. Saved now; tests/jit-x87-narrow.test.js checks the mask is the same
  after each exit.

### The five branches together (2026-10-14, integ-perf-1014 against main ab5e39a)

perf-heap, perf-mapload-jit, perf-x87-size, perf-draw and perf-d3dx-image merged, measured against a worktree of main
in concurrent pairs, launch order alternated. Warm profiles made for the occasion (one first-launch run per game; the
BFME1 one set to 800 x 600, the resolution its scenario's clicks expect); no learned data copied (none was left), the
same empty learn directory on both sides.

| | main | integ |
|---|---|---|
| BFME1 map load (load + loadscreen), browser `--gl-discard` | 71.8 / 69.8 s | 54.2 / 53.4 s (−25 / −24 %) |
| BFME1 map load, Node real clock | 58.8 / 57.8 s | 44.7 / 46.2 s (−24 / −20 %) |
| BFME1 play, browser | 38.3 / 38.3 fps, work p50 16.0 / 13.4 ms | 38.3 / 38.3 fps, 15.5 / 13.2 ms |
| BFME1 play, Node, emulator thread CPU over 160 s | 78.7 / 75.9 s | 76.5 / 71.9 s (−3 / −5 %) |
| BFME1 menu, Node `--virtual` (identical work), thread CPU | 40.7 s | 39.6 s (−2.7 %; API 3.85 → 2.40 s) |
| BFME1 3D menu fps, browser (4 pairs) | 19.3 / 22.4 / 13.0 / 21.7 | 19.6 / 21.9 / 12.8 / 22.1 |
| BFME2 load + loadscreen, browser | 27.1 / 28.1 s | 25.9 / 24.7 s; loadscreen API 21.1 → 12.9, 27.4 → 15.6 ms per frame |
| BFME2 play, browser | 30.2 / 30.2 fps | 30.2 / 30.2 fps |
| BFME2 `--virtual`, thread CPU menu / loadscreen / play | 17.8 / 20.0 / 31.5 s | 17.9 / 16.5 / 31.1 s |
| RotWK load + loadscreen, browser | 27.7 / 28.5 s | 26.4 / 29.4 s (within the spread) |
| RotWK play, browser | 29.6 / 29.3 fps, API 4.3 / 4.6 ms | 29.6 / 29.5 fps, API 4.0 / 4.1 ms |
| RotWK `--virtual`, thread CPU menu / loadscreen / play | 17.4 / 16.7 / 29.1 s | 16.6 / 15.6 / 28.4 s |
| Vice City drive, Node `--virtual`: thread / process CPU | 9.8 / 21.4 s | 9.1 / 18.4 s |
| Vice City drive, Node real clock: thread / process CPU | 10.5 / 22.0 s | 9.6 / 17.8 s |

Guest nanoseconds per guest instruction rise in menus and play in the browser pairs (BFME2 menu 0.87 → 0.98, BFME1
menu 1.30 → 1.40) while the JavaScript API time falls: the queued draws and the surface GetDesc run in the WebAssembly
fast paths, counted as guest time. The emulator thread's CPU for identical work (`--virtual`) is equal or lower in every
phase. Vice City in the browser did not reach its drive in either tree in 3 of 4 pairs (the start phase ends after
36 000 frames of its intro); its comparison is the Node one. Rendering: `?glworker=compare-worker`, 0 differing frames
(BFME1 menus 500 frames compared, every 10th; BFME2 menu to play 100, every 10th; Vice City menu to drive 80, every
60th). Thin link
(`tools/check/slow-net-check.mjs --bench vicecity-drive --speeds 1m`, nothing learned): menu 161 s, in game 245 s (main 145 /
258 s), the bench done.

## x87 regions: the stack cache by use, truncation in vector registers (2026-10-21)

Measured on this shared server under a load average of 20-60 (other projects): Node only (the one rendered browser run
attempted for bfme1-108 ran its menu at ~5 fps and was useless); medians, concurrent pairs, alternated in-process A/B.

- **The 24-bit precision "gap" was mostly V8's tiers.** x87loop-bench waited 100 ms after its warm-up for TurboFan; the
  24-bit regions (larger: every result tested) were often still partly in Liftoff, so xform measured 24.8 ns at 0x7f
  against 10.7 at 0x27f (the "2.4x" of the 2026-10-21 audit). TurboFan only (`--no-liftoff`, now the tool's default;
  `--liftoff` for the tiers as they come): xform 14.2 vs 10.6 ns, 13.8 vs 12.8 with full 24-bit significands
  (`--full`); sums of squares 17.4 vs 15-19. What remains at round-to-nearest is the exponent test of every f32 result
  (off the dependency chain) and, for values carried across a block boundary, the promotion of the f32 shadow at the
  block's end (dropped at block entry) — a latency-bound recurrence 3.6 vs 2.0 ns. Not changed: keeping f32 shadows
  across blocks needs a dataflow over the region's entries (any block can be entered from the dispatcher with an
  f64 from the state block), for at most a few % of the menu's guest time. The truncating mode (0xc7f), BFME1's map
  load, was the real gap: xform 27.0 vs 12.8 ns at 53-bit.
- **Truncation cut in the XMM register** (`x87VecMask`, default on; translate-x87.js pushCut24): roundTowardZero24
  cleared the 29 low significand bits on the integer pattern — `vmovq` to a general register, `and`, `vmovq` back:
  two domain crossings (~3 cycles each) on the dependency chain of every arithmetic instruction. Now `f64x2.splat ;
  v128.and ; extract_lane 0` (vmovddup + vpand), the bit tests that choose the path still on the integer copy, off the
  chain. The mask is a v128 local set by the prologue (`L_CUT24`, regions translated for mode 0xc00 only): built
  inline at each use, its three-instruction constant ate the gain in the game (one pair: map load +3.7 %).
  x87loop-bench 0xc7f `--full`, mask on vs off in the same tree (11 runs): sums of squares 39.7 -> 30.0 ns, xform 28.2
  -> 23.9, arith across blocks 13.3 -> 12.2, recurrence 4.4 -> 3.5.
- **The stack cache by use** (`x87Live`, default on; Emitter.x87LiveSites): an x87 region loaded all eight stack
  registers at its entry (and after fallbacks) and wrote all eight back at its exits. Code.track records the body's
  gets / sets of the eight locals; once the body is emitted, the loads and stores of the locals it never touches are
  overwritten with `nop`s of the same length (no offset recorded in the body moves: branch hints, the alt slot, visit
  flags). Exact because local L_ST0+k always holds physical register (L_TOP + k) & 7: the locals only move between
  each other in x87Rotate, whose gets and sets mark all eight, and L_TOP otherwise changes only around a write-back
  and reload (fallbacks, FLDENV / FRSTOR, TOP resets). chain-bench x87 call/return 39.3-46.4 -> 29.6-29.9 ns (3
  alternated runs; integer regions 23-26 ns); tools/bench/x87-size.mjs, 27 regions x 3 control words: TurboFan machine code
  124 480 -> 98 020 bytes (-21 %), WASM +0.4 % (the prologue's mask). tests/jit-x87-live.test.js (masks; random
  programs over few registers with every register valued, fallbacks, FNSAVE / FRSTOR, FNSTENV / FLDENV, FDECSTP /
  FINCSTP, slices; it fails when a used register's load is dropped).
- Kernels, this branch against main (x87loop-bench `--full --ab`, 9 alternated runs, medians): 0xc7f xform 27.0 ->
  21.5 ns, sums of squares 36.0 -> 30.4, fild + fmul + fstp 5.4 -> 4.3, recurrence 3.9 -> 3.4, e^x 28.2 -> 25.6, arith
  across blocks 12.2 -> 10.8; 0x7f and 0x27f within the noise (-15 to +15 % on single cases, both directions).
- **BFME1 (bfme-vanilla 2.22, the same lotrbfme.exe as 1.08), Node, concurrent pairs** (startbench, copies of the same
  warm profile, menu 135 s then the map load; guest ns per instruction, map load seconds): both options on vs off —
  loadscreen 1.037 / 1.055 (43.7 / 44.3 s), 1.063 / 1.077 (43.7 / 45.3 s), 1.213 / 1.234 (51.3 / 53.8 s, load 60);
  3D menu 1.340 / 1.346, 1.359 / 1.392, 1.452 / 1.505. Vector mask alone (local mask) on / off: loadscreen 1.009 /
  1.048 (43.2 / 44.7 s), menu 1.303 / 1.296. So -1.5 to -3.7 % on the map load, -0.5 to -3.5 % on the menu: at the
  edge of the noise (single pairs on a machine at load 20-60), every pair in the same direction on the map load.
- The map load's hot loop (region e66cde / e66ecb, mode 0xc00: a sums-of-products fitting loop, 84 guest instructions
  per iteration, 168 M iterations per load: 14 G of the ~40 G instructions) is flat in `perf annotate`: no
  instruction above 1.6 % of the region. Its x87 arithmetic is ~12-14 host instructions an operation (sub / mul,
  bit tests, the cut), its FSTP m32 an exact-demote test and the SMC check. No single pattern left to fuse.
- Not changed: an on-grid but inexact product under truncation (a double operand like 0.9 whose f64 product rounds onto
  the 24-bit grid: x87loop-bench `fmul m64 0.9` at 0xc7f, 21 % of its iterations) leaves the region for the
  interpreter (~57 ns an iteration); the BFME1 map load spent 0.01 s in the interpreter, so it does not happen there.
  A Dekker product's error sign would settle it inline.

## Where BFME1's 3D menu spends its translated code, and eight shorter shapes (2026-10-22)

Measured on this shared server (load average 15-70); Node, `startbench --virtual` on the bfme-vanilla 3D menu (a phase of
6 213 M guest instructions, the same work in every run: `+20:waitframe:300,100000;40:mark:menu;70:mark:end`), real-clock
runs of `bfme-phases.txt` for the map load and play, microbenchmarks. Base: main a36cd74.

- **Profile** (`perf record -F 3999 -k 1` on `node --perf-prof`, `perf inject -j`, samples of the emulator thread in the
  menu phase's window — `--time` from the phase's start / end and the realtime-monotonic offset): translated regions 88 %
  of the thread, flat (the hottest 2.6 %; 2 281 region functions). Over the 200 hottest (69 % of the region samples),
  by instruction: ALU 28 %, guest memory accesses 16 %, stack slots (spills, reloads, stack parameters) 12.3 %, branches
  9.3 %, vector / float 9.3 %, register-to-register moves 8.8 %, the chained-exit tail (exit-kind test to the tail call)
  8.7 %, the f32 exponent tests of 24-bit x87 arithmetic 3.8 %, prologues (to the dispatch loop's stack check) 3.4 %,
  SMC map loads 0.4 %. Menu mix (block counters for that phase only): MOV 21.7 %, JCC 10.5 %, ADD 9.0 %, FLD 7.2 %,
  CMP 6.6 %, FMUL 5.9 %, FSTP 3.9 %, IMUL 2.4 %; 8.2 % of the instructions are checked stores (2.2 per group of the same
  address registers); 10.7 chained transitions per 1 000 instructions, 56 % of them leaving x87 regions. The hottest
  region (10 % of the instructions) is a sound mixer loop (`imul; sar; imul m; add [edi], eax; add [edi+4], ebx`).
- **f32 exponent test** (translate-x87.js arithF32): the result's exponent field in [1, 254] tested as `(bits << 1) -
  2^24 <u 0xfe000000` — `vmovd; lea; cmp; jae` instead of `vmovd; shr; movzx; sub; cmp; jae` on every 24-bit
  round-to-nearest arithmetic instruction with float operands. The double-operand range test (pushFloatRangeTest) and
  the truncating mode's exponent tests (roundTowardZero24's pushOutOfRange, the directed path's) on the pattern shifted
  right by 31 (the significand's top bits under the exponent field move no bound): one mask less each.
  x87loop-bench 0x7f `--pos`, 9 alternated runs at a quiet moment: xform 13.87 → 10.35 ns, sums of squares 17.22 →
  12.33, arith across blocks 8.26 → 8.04; at 0xc7f `--full` (process host instructions, perf stat, the shifted tests
  alone): sums of squares 8.32 → 8.17 G, xform 7.56 → 7.49 G.
- **Chained exits** (emitChain): address 0 and every target from the thunks up (thunks, the private area, past 2 GiB)
  in one unsigned compare (`tv - 1 >= THUNK_BASE - 1`; profiling translations keep the two tests to count them apart);
  JIT_HASH_BASE in the probes' load offsets, no mask on the home slot. chain-bench (5 alternated runs, medians): int
  call/return 24.9 → 24.0 ns, x87 34.6 → 32.6 ns. tests/jit-chain-targets.test.js.
- **x87 tag word** (loadX87Tags / flushX87Tags): the rotation by TOP as one variable shift of the doubled byte (`(tw |
  tw << 8) >> TOP`) instead of two (x64 takes the count in CL) at every x87 region entry and exit. With the previous item:
  chain-bench 1e7 host instructions 27.55 → 25.91 G.
- **Write-back of read-only x87 registers** (`x87LiveStores`): Code tracks sets apart from gets; the exit and fallback
  stores of the stack registers the body reads but never sets become nops like those of untouched ones (such a local
  holds what the cache loaded, the state block is the same). x87-size, 27 regions × 3 control words, with the items
  above: machine code 126 692 → 124 644 B. tests/jit-x87-live.test.js (programs reading the caller's registers; a
  mutation dropping a written register's store fails it).
- **IMUL with dead flags** (`imulDead`): `imul r32, r/m32 (, imm)` whose next instruction in the block writes every
  arithmetic flag (CMP, TEST, ADD, a shift by a constant, another IMUL...) — no exit can lie between them — is a 32-bit
  multiply (no sign extensions and 64-bit product for CF / OF). The mixer loop runs four per iteration.
  tests/jit-imul-dead.test.js.
- **MOVSX m8 / m16** with `i32.load8_s` / `load16_s` (it was a zero-extending load and a `movsx` of the register).
- **Lazy states without a first operand** (`lzaFree`, LZA_FREE in translate.js): ADD, INC, DEC, NEG and a SUB writing
  its destination (a new lazy kind, SUBR; CMP keeps SUB, its first operand being the register the next Jcc reads) leave
  0 in L_LZA; the inline conditions and both flags helpers derive what they need from the result and the second
  operand (ADD: a = res - b, CF = res <u b; SUBR: a = res + b; NEG: a = -res; INC / DEC never read it). The
  destination's old value — `add esi, 4`, `sub ecx, 1`, the word an `add [edi], eax` loaded — no longer lives up to the
  next flag write or to every exit in between (TurboFan kept it in a register or a spill slot for the SMC checks' cold
  paths). The readers ignore the operand for those kinds whatever the option, so regions translated either way exchange
  lazy states. memop-bench `8x add [edi+8], eax` (3 alternated runs): 5.83 / 6.84 / 7.16 → 5.45 / 6.09 / 5.64 ns per
  iteration. tests/jit-lza-free.test.js (randomized programs of every size and destination against the interpreter,
  sliced; the helpers with garbage first operands; mutations of one inline reader and of the JS helper fail it).
  SUBR alone can be turned off (`lzaSub: false`: a SUB keeps the SUB kind and its operand).
- **BFME1 3D menu**, concurrent `--virtual` pairs, guest ns per instruction (load average 15-70 during these):
  - every item but lzaFree, main / branch (4 pairs): 0.940 / 0.923, 1.110 / 1.091, 1.008 / 0.985, 1.080 / 1.066
    (−1.3 to −2.3 %; emulator thread CPU −0.7 to −2.4 %);
  - lzaFree off / on in the same tree (4 sequential pairs, launch order alternated): 1.026 / 0.981, 1.125 / 0.965,
    1.025 / 1.041, 1.077 / 0.997 (−4.4, −14, +1.6, −7.4 %);
  - everything, main / branch (4 more pairs, load 30-70): 1.182 / 1.210, 1.241 / 1.201, 1.110 / 1.038, 1.135 / 1.185
    (+2.4, −3.2, −6.5, +4.4 %) — within this machine's spread.
- **Host instructions of the emulator thread in the menu window** (`perf record -e instructions:u -c 100000`, samples
  counted between the phase's marks; `node --no-liftoff` so that no tier-up timing decides how long code runs in
  Liftoff): main 15.54 G; branch 14.11, 15.50, 15.93 G (three runs of the same build); lzaFree off 14.61, 15.98,
  15.20 G; lzaSub off 16.03 G — the same build's runs differ by up to 12 %: even this count follows the machine's load
  (with Liftoff on it doubled under load: 13.4-14.5 G at load ~15, 23-27 G at load ~60), so it does not resolve a few %
  either. The frames (121) and API calls (295 600-296 400) of the phase are the same in every run. Kept on the
  microbenchmarks, the map-load and play pairs below and the time pairs above; not validated beyond that.
- **BFME1 map load and play** (real clock, `bfme-phases.txt`, concurrent main / branch pairs, the same warm profile
  copied for each, launch order alternated; the same guest work in each phase within 2 %):

  | pair | loadscreen (s) | loadscreen ns / insn | play ns / insn | play thread CPU (s) |
  |---|---|---|---|---|
  | 1, main launched first | 47.8 / 45.2 (−5.4 %) | 1.109 / 1.072 | 2.786 / 2.704 (−2.9 %) | 79.3 / 78.6 |
  | 2, branch launched first | 40.2 / 39.7 (−1.2 %) | 0.987 / 0.970 | 2.872 / 2.728 (−5.0 %) | 80.5 / 78.3 |

  The menu phase of these real-clock runs (its first 135 s, frame-paced) did not move (1.334 / 1.329, 1.667 / 1.674 ns).

## Registers, region exits and loops in BFME1's 3D menu (2026-10-22): five variants, none kept

Base: main ddfd8e8. Scenario: bfme-vanilla, a warm profile (the canonical seed's Options.ini), `startbench --virtual`,
`+20:waitframe:300,100000; 40:mark:menu; 70:mark:end` — a menu phase of 6 228 M guest instructions, 121 frames, the same
in every run; the whole run 43.9 G guest instructions. Measured with `ab-virtual --perf` style counts (above) and
concurrent timed pairs.

- **Where the guest registers live.** Already in WASM locals for a whole region: the 8 registers, EFLAGS, the four lazy
  flag values and the budget are the region function's parameters (block and state block address first), passed from
  region to region by the chained tail call; the state block sees them only at a non-chained exit (to the dispatcher:
  API thunks, the stop address, an exhausted budget, a miss), around an interpreter fallback (written before, reloaded
  after) and at the dispatcher's entry. The x87 stack (by use, x87Live) and the XMM registers the region names are
  loaded at its entry and written back at its exits. Writing back "only the dirty registers" cannot apply to the general
  registers: a region entered by a chain has a state block older than its parameters, so it does not know which values
  the state block lacks. Those exits are rare anyway: over the whole run 397.7 M chained transitions against 13.1 M
  exits to API thunks and 0.1 M budget exits; in the menu no fallback step. Moving values out of the parameters into
  the state block was measured before (below: +17 % per chained call/return), as were the parameters' order and
  packing.
- **Profile** (`perf record -e cycles:u` of the whole run with `--perf-prof`, the emulator thread in the last 40 % of
  the run, samples in region code by host instruction, branch hints on): memory operands 29.0 %, ALU 27.6 %, stack
  slots 14.2 % (most of them 64-bit spill stores), branches 12.2 %, register moves 10.5 %, vector 6.4 %; Liftoff code 8 %
  of the region samples. The two first instructions of the region functions (`push rbp; mov rbp, rsp`) hold 3.3 % of
  the samples: instruction fetch at the entry of a region entered cold. In the hottest region (an msvcr71 helper, 1.3 %
  of the thread) 19 % of the samples are its x87 / XMM prologue and ~27 % its exit (the merge's moves into the shared
  tail, the x87 and XMM write-back, the hash probe's load, the table's bounds and signature checks waiting on it).
- **Dispatches through a region's br_table** (`--jit-profile`, menu phase): 23.5 M against 60.7 M chained transitions —
  backward transfers outside a structured loop 16.1 M, returns to a call site placed earlier 4.5 M, forward into a
  loop elsewhere than at its header 1.7 M, back into a loop 1.3 M. The hottest sites (a counter per site, whole run):
  an msvcr71 function's RET returning to the call in the region's first block, 41 M — its callee is called from two
  places, and the depth-first layout put it after the second call, in the first call's return path; overlapping
  loops whose headers are one block apart (8.8 M, 8.6 M).
  - RET → local return site counted as a back edge by planUnits (`retLoops`): returns through the top 4.49 → 3.32 M,
    but forward entries into loops 1.66 → 3.86 M and all dispatches 23.5 → 24.7 M; JIT instructions +0.7 % (318.8 vs
    316.6 G).
  - Loops nested (`nestLoops`, re-measured): dispatches 23.5 → 15.6 M (back to the top 16.1 → 4.4 M); JIT instructions
    317.99 / 318.34 vs 316.87 / 316.66 G (+0.4 %), JIT cycles 147.10 / 146.80 vs 147.28 / 146.24 G (0.0 %), process
    instructions +1.3 % (compilation). A dispatch costs about what the structured loop's header costs.
- **XMM write-back of read-only registers** (`xmmLiveStores`, as x87LiveStores: Code tracking the XMM locals' sets, the
  stores of the unset ones made `nop`s): JIT instructions 317.02 / 316.58 vs 316.57 / 316.61 G — this menu's x87 code
  hardly uses XMM registers, and 32-bit code rarely reads one it does not write.
- **Hints in the chained exit** (`chainHint`: the first probe's hit likely, the later probes and the miss out of line,
  the target range test unlikely), with the previous item: JIT instructions 316.67 / 316.09 vs 316.43 / 316.29 G, JIT
  cycles 140.25 / 139.23 vs 139.16 / 139.31 G.
- **Regions of 144 blocks / 1 200 instructions**: JIT instructions +1.0 % in two batches, JIT cycles −3.6 % in one
  (149.55 / 148.08 vs 154.30 / 154.66 G) and +1.2 % in the other (127.20 vs 125.73 G), V8's compilation +18 % of the
  process's instructions; not changed.
- Timed pairs (the same tree, the three first variants off / on, 4 concurrent pairs, launch order alternated): menu
  guest ns per instruction 1.161 / 1.111, 1.158 / 1.168, 1.014 / 0.991, 1.042 / 1.071 — within the spread.

## Displacements in the memarg offset (`memarg`, off by default, 2026-11-09)

`Emitter.foldDisp` / `eaOff` / `storeAddr` (translate.js): a `[base + disp]` load with `0 < disp < 0x10000` (no index,
no 16-bit address, no FS/GS base, not in an if-converted arm) pushes the base register and puts `disp` in the load's
memarg offset instead of `i32.const disp ; i32.add`; the same for stores addressed by ESP alone (they have no SMC
check, which needs the whole address in `L_TA`). Every load path takes it (integer, MOVSX, x87 m32/m64/m16/m32 int,
SSE scalar and vector loads); stores: MOV, FST/FSTP m32/m64, MOVSS/MOVSD/MOVLPS, storeVec.

- **V8 does not fold it itself.** TurboFan (Node 24, `--print-wasm-code`) keeps `i32.add` a 32-bit operation (it must
  wrap): `[base+16]` compiles to `leal rcx,[rax+0x10] ; movl rbx,[rbx+rcx*1]`, the memarg form to one
  `movl rbx,[rbx+rcx*1+0x10]` (plus a `movl` zero-extension when V8 does not know the base's upper half is clear). With
  an index register the lea stays either way (`[base + index*s + disp]` is one lea folded or not): not folded. Three
  small regions (a prologue, an x87 dot product, struct loads): 4 672 → 4 659 machine instructions, a field-heavy block
  15 → 9.
- **Exactness.** x86 wraps `base + disp` at 32 bits, the memarg does not: they differ only when `base + disp >= 2^32`
  (base a small negative number), where the folded access traps past the 2 GiB memory instead of reaching
  `base + disp - 2^32 < disp`. With `disp < 0x10000` that address is in the null page, which Windows never maps: the
  access faults there too — imprecisely here (a WebAssembly trap ends the process; docs/null-page.md "Not exact"),
  where an unfolded read in the default `'writes'` mode read zeros. Larger displacements (an absolute address plus a
  possibly negative register: `table[-1]`) could reach real memory and are never folded. ESP-based accesses cannot
  wrap with a real stack. tests/jit-memarg.test.js checks both sides against the interpreter (`[ecx+0x10010]` with
  ECX = −16 still reads 0x10000); the CPU conformance suites (oracle + corpus) pass.
- **Measured** (`dbg:ORTHROS_JIT_AB={"memarg":false}` switches it off in a session):
  `ab-virtual --perf`, same guest work: JIT instructions −0.57 % (RotWK menu, 218.32 vs 219.56 G), −0.16 % (BFME1 1.08
  launcher computation, 119.94 vs 120.13 G), −1.25 % and −0.70 % (Vice City load + drive, 129.62 vs 131.24 G; two
  runs each 130.05 vs 130.96 G); JIT cycles +0.27 %, −1.36 %, −1.95 % / +0.55 % (cycles move ±1 % with the load).
  Vice City drive, two runs each: 4.248 / 4.263 vs 4.280 / 4.297 ns per guest instruction (−0.8 %). Node in-session
  A/B (startbench, real clock, `tools/scenarios/*-memarg-ab.txt`, 25 s phases after a 5 s warm-up), guest ns per
  instruction on / off: BFME1 1.08 play 2.514 / 2.568, 2.844 / 2.892, 2.716 / 2.880 (every pair on, −2 to −6 %);
  RotWK play 2.713 / 2.677, 2.553 / 2.552, 2.745 / 3.066 (within the spread). The browser A/Bs (Chromium,
  SwiftShader) could not resolve it: on a machine at load 30-80 Vice City ran at 8-11 fps with the guest time per
  instruction swinging 7-18 ms per M between phases of the same variant, and BFME1 / RotWK did not reach play (their
  menus at 1-6 fps missed the scenario's clicks; BFME1 1.08's menu also stalls the worker after Solo Play in other
  branches' runs). A gain of about 1 % of the translated code at most, no time gain resolved, and a fault made imprecise in the null
  page: off by default (`?jitopts={"memarg":true}` or `dbg:ORTHROS_JIT_AB={"memarg":true}` to measure again).

## Jump tables in the region (2026-11-09): exact, fewer transitions, no faster — off by default

Where play time goes now (RotWK, Node, `startbench --cpu-prof` over 40 s of play with the background translator):
region code 74 % of the emulator thread's busy time, flat (the hottest region 0.8 %); msvcr71 7.7 % of the region time
(`floor` 1.7 %, `fabs` 1.6 % — its `_ctrlfp` calls switch the control word twice per call, so each call leaves its
x87-mode version twice —, `memcmp` 0.8 %); JavaScript: D3DX effects 4.5 %, vm.js 3.8 %, the dispatcher 2.3 %. Whole
session (`--jit-profile`): 739 M chained transitions, 304 M indirect exits, 1 928 M backward transfers through the
region dispatcher (mostly the startup computation).

`jumpTables` (translate.js jumpTableOf / Emitter.jumpTable): `jmp [index*4 + table]` — a switch, and the C runtime's
memcpy / memset tails — reads its table at translation time (entries while they point within 64 KiB of the jump, at
most 256 entries / 32 targets, cold ones left out by the heat), the targets become successors of the block, and the
jump is a `br_table` on the index register whose arms compare the address actually loaded with the entry seen then:
equal, an in-region transfer; otherwise the region is left as before. Exact whatever the table holds
(tests/jit-jump-tables.test.js: random switch loops with indices past the entries read, entries rewritten while the
loop runs, flags read across the jump, time-sliced; a mutation dropping the compare fails it).

- Vice City drive (Node, `--jit-profile`): 4.9 M jumps stay in their region in 22 s; chained transitions 33.0 → 30.0 M
  (−9 %), indirect exits 11.3 → 7.0 M.
- Node, in-session A/B (`dbg:ORTHROS_JIT_JTAB_OFF`, tools/scenarios/*-jtab-ab.txt: 8 s warm-up after each switch, 22 s
  phases, on1/off1/on2/off2/on3/off3), guest ns per instruction and guest ms per frame, on / off:
  RotWK 2.116/2.245, 2.188/2.240, 2.421/2.233 ns (median 2.188 vs 2.240), 15.6 vs 15.9 ms per frame;
  BFME1 1.08 2.203/2.712, 2.578/2.251, 2.215/2.281 ns (median 2.215 vs 2.281), 11.5 vs 11.1 ms per frame;
  Vice City 2.383/2.179, 2.165/1.888, 2.276/2.301 ns (median 2.276 vs 2.179; fewer instructions per frame on, same
  guest time: 11.7 vs 12.1 ms per frame). Within the spread of the phases (±5-10 %).
- Browser (SwiftShader, this server loaded: Vice City at ~11 fps, render-bound), same scenarios, on / off medians:
  Vice City fps 10.9 / 10.9, frame p50 96.4 / 96.8 ms, p99 213 / 237 ms, guest 37.3 / 35.4 ms per frame, 7.57 / 6.97 ns
  per instruction (the first pair biased by translation after the first switch: on1 jit 39.5 ms per frame).
  BFME1 1.08 and RotWK 2.02 gave no browser figures that day: with the server loaded by other sessions' browsers,
  SwiftShader drew BFME1's menu at 0.7 fps (its skirmish never started in 900 s) and RotWK's loading screen at 1.7 fps
  (play, anchored at 12 fps, never reached in 1 000 s).

Fewer transitions again buy nothing measurable (as the predicted transfers above): the play profile is bound by the
instruction fetch of a large, flat body of translated code, and a jump table adds blocks to the regions holding it.
Off by default (`JIT_DEFAULTS.jumpTables`); `?jitopts={"jumpTables":true}` or `dbg:ORTHROS_JIT_JTAB_OFF=` (empty: on,
`=1`: off; both retranslate everything) for measurement.

## Chrome against Node (2026-11-12): the same code, the test browser starved by its CPU quota

The guest-speed study of 2026-11-12 measured play at ~2-2.7 ns per guest instruction in Node and quoted ~4.8 ns for
AotR in headless Chrome. Measured here on the same scenario in both (RotWK 2.02 `rotwk-quick`: first launch, menu,
skirmish, 120 s of play; Vice City `vicecity-drive`: 60 s of driving), the same learned heat and regions (copies of the
live server's), a fresh profile (`--profile-seed 0`); Node = `startbench --bg --cold --gfx recorder --heat --regions`
(the page's background translator, cold tier and render-worker recorder); Chrome = `tools/headless.mjs` (Playwright's
Chromium 153 headless shell, V8 ~15.3; Node 24 is V8 13.6) through `tools/with-browser-slot.sh`. Guest ns per
instruction is the frame accounting's `guest` time (wall clock) per guest instruction of the play phase; thread CPU is
the emulator thread's own CPU time (Node `threadCpuS`; Chrome: the busiest DedicatedWorker thread in /proc, the
harness's `[cpu]` line), over the same guest instructions.

| run (play phase) | fps | guest instructions | guest ns / insn | thread CPU ns / insn |
|---|---|---|---|---|
| RotWK, Node (4 runs) | 30 | 23.2-24.7 G | 2.06 / 2.54 / 2.09 / 2.12 | 2.59 / 3.04 / 2.61 / 2.66 |
| RotWK, Chrome, quota 400 % alone (the slot's former default) | 3.0 | 4.8 G | **8.78** | 3.15 |
| RotWK, Chrome, quota alone, `--gl-discard` | 13 | 11.3 G | **7.21** | 3.33 |
| RotWK, Chrome, pinned to 4 cores | 5.9 (render-bound: 131 ms per frame waiting for SwiftShader) | 5.5 G | 3.34 | 2.74 |
| RotWK, Chrome, pinned to 4 cores, `--gl-discard` (2 runs) | 28.2 / 28.1 | 24.7 / 23.4 G | **2.51 / 2.52** | 2.67 / 2.62 |
| Vice City, Node | 30 | 7.6 G | 2.64 | 3.48 |
| Vice City, Chrome, quota alone | 9.1 | 1.8 G | **11.56** | 6.55 |
| Vice City, Chrome, pinned to 4 cores | 23.9 | 4.3 G | **2.30** | 2.80 |
| AotR 10 (game.dat), Node, the study's runs (play2) | 30 | — | 1.55-2.38 | ~3.4 |
| AotR, Chrome, quota alone, `--gl-discard` (play / play2) | 8.8 / 10.5 | 3.4 / 6.6 G | **6.29 / 5.46** | 3.11 / 2.90 |
| AotR, Chrome, pinned to 4 cores, `--gl-discard` (play / play2) | 20.4 / 22.4 | 5.7 / 11.8 G | **3.05 / 2.73** | 2.90 / 2.76 |

(AotR: `learn-aotr-skirmish` with its play lengthened to 30 + 60 s; no Node run of this scenario was made here — the
launcher's game.dat child needs the study's preload — so its Node line is the study's, another moment of the game.)

**Why.** The slot's scope capped the browser at 400 % (`CPUQuota`) on this 48-core host. SwiftShader's pool in the GPU
process (16 threads, sized from the host's cores) burns that quota early in each 100 ms period — the GPU process took
3.2-3.5 cores in play even with `--gl-discard` — and CFS then stops the whole scope, the emulator's thread included,
until the next period: 572 of 590 periods throttled in Vice City's play, 595 of 595 in AotR's, the emulator thread
running ~13 % of the wall clock in RotWK's. The page measures its categories on the wall clock, so the stopped time lands in `guest`: 7-12 ns
per instruction for code whose CPU cost is ~3 ns. The 4.8 ns figure is this artifact (docs/render-worker.md 11.1 saw the
same throttling on AotR's loading screens), not the translated code.

**The same code.** `perf record -e cycles:u,instructions:u` of the emulator thread over the whole play phase, symbols
from V8's `--perf-basic-prof` (Chrome names its code mappings `[anon:v8]`, which perf does not look up in
/tmp/perf-<pid>.map: resolved by hand), RotWK pinned + `--gl-discard` against Node, run at the same time (same load):

| per guest instruction | Node: cycles / instructions (IPC) | Chrome: cycles / instructions (IPC) |
|---|---|---|
| translated regions, TurboFan | 4.66 / 6.85 (1.47) | 5.29 / 6.78 (1.28) |
| translated regions, Liftoff | 0.24 / 0.14 | 0.27 / 0.12 |
| runtime module (WASM) | 0.22 / 0.30 | 0.24 / 0.30 |
| JavaScript (optimized + other) | 0.99 / 1.27 | 1.06 / 1.53 |
| native (V8, Node / Chrome, Blink) | 0.50 / 0.68 | 0.94 / 1.31 |
| whole thread (user) | 6.74 / 9.47 (1.40) | 8.05 / 10.38 (1.29) |

The regions execute the same number of host instructions per guest instruction in both (6.78 vs 6.85: V8 15.3 and 13.6
generate equivalent code for the translator's modules; Liftoff ~3.5 % of the cycles in both, so tier-up is not slower
there). Chrome's thread runs ~10 % more instructions outside the regions (Blink and V8 runtime under the page worker's
messages, timers and Atomics: +0.6 per guest instruction) and the regions run at a lower IPC (1.28 vs 1.47, +14 % cycles):
the pinned 4 CPUs are shared with the GPU process's 2.6 busy cores (context switches, the L1/L2 caches shared; 44-47 are
also the SMT siblings of 20-23, which other services use). The thread's clock was higher in Chrome (3.07 GHz vs 2.54 GHz
for Node's floating thread), so its CPU time per guest instruction is the same (2.62 vs 2.66 ns), and its wall-clock
guest time ~19 % higher (2.52 vs 2.12 ns: preempted on the shared cores). With SwiftShader rasterizing (no
`--gl-discard`), RotWK play waits for the render worker (`render` 131 ms per frame) and Liftoff rises to 8 % of the
thread's cycles (tier-up compiles starved on the 4 shared cores) — the server's software GPU, not the player's.

**Ruled out:**
- Explicit bounds checks on a shared memory: V8 keeps the trap handler (guard regions) for a shared
  `WebAssembly.Memory` — Node's TurboFan code for a shared memory's load is a protected `movl` with no compare, and a
  load loop in a Chrome page worker (cross-origin isolated) runs at the same speed on a shared and an unshared memory
  (2.40-2.43 ns per iteration, as in Node 2.41), while `--js-flags=--wasm-enforce-bounds-checks` makes the shared one
  +5 % slower: the default is not explicit checks.
- V8 version and tiering (above: equal region instructions, equal Liftoff share at full speed).
- Headless shell against full Chromium: the same microbenchmark speed (2.40 vs 2.40 ns).
- The DevTools GC artifact (memory "DevTools GC artifact") needs a CPU profile or heap tool attached; none was.

**Changed:** `tools/with-browser-slot.sh` pins each slot's browser to cores of its own by default
(`ORTHROS_BROWSER_CPUS=auto`: as many as the quota gives, counted from the last core per slot — 44-47, 40-43, 36-39;
`ORTHROS_BROWSER_CPUS=` restores the quota alone, a CPU list picks the cores). Before/after on two games (the table:
quota alone → pinned): RotWK 3 → 5.9 fps (`--gl-discard` 13 → 28 fps, guest 7.21 → 2.51 ns), Vice City 9.1 → 23.9 fps
(guest 11.56 → 2.30 ns), AotR (`--gl-discard`) 10.5 → 22.4 fps (guest 5.46 → 2.73 ns); nothing slower. The harness's `[cpu]` mark lines now give the scope's throttled periods
(`CPU quota: throttled in N of M periods`), with a note when more than a tenth were: a phase measured under throttling
does not measure the translated code. Browser numbers taken with the quota alone (the 4.8 ns quoted for AotR among
them) carry this artifact in proportion to the GPU process's activity; compare them only with runs made the same way.

## Self-modifying code: exact invalidation (2026-11-12) — on by default

Age of the Ring's play retranslated code without end (study of 2026-11-12, data/proof/guest-speed-2026-11-12: ~61
invalidations and ~190 regions a second, the jit category 16-32 % of the thread). Why, from a trace of every invalidation
(a preload around `Jit.invalidate` keeping each region's block bytes at registration, one run to the skirmish, 10 278
events): game.dat's `.danetta` section (rva 0xaca000, virtual size 0x8192, read-write-execute — rva 0xad1318 is inside
it, not after it) holds code and the variables that code writes. In play, the code at 0xed0810 / 0xed0816 writes a
counter at 0xed0000 / 0xed0004, on the page of its own code, ~60 times a second; during loading 0xed1664 fills a table
from 0xed1318, and `.angmar` (0xed3000) takes stores too. **None of the 10 278 events overlapped a translated byte**
(10 274 were 256 bytes or more from the nearest translated block). But the SMC map has one byte per 4 KiB page
(translate.js smcCheck), and `Jit.invalidate` dropped every region with a block on the written page — ~3 per event: the
writer's own region and those that had taken a call into `.danetta` —, all translated again within milliseconds.
Vice City's crack does the same at startup (1-byte stores into its writable `.rsrc` stub: 3 632 invalidations in the
first 4 G instructions).

**Change** (jit.js `invalidate`, `smcExact`): only the regions with a block overlapping the written range itself
(`EXIT_ARG`, `EXIT_LEN` — a string store's range or a store wider than 16 bytes; 16 bytes for every other store, whose
width is not recorded: data up to 15 bytes before code still drops it) are dropped.
The translated code is unchanged: a store into a code page still leaves its region (one map byte per page), the
dispatcher resumes after it, and when it overlapped no translated byte nothing is dropped and the page keeps its flag
(`stats.smcKept`). Exact because a region depends only on its blocks' bytes, `[eip, end)` of each run of decoded
instructions (what the translator reads besides — import slots run inline, jump tables — it compares at run time);
the API ranges (VirtualProtect, VirtualFree, FlushInstructionCache) are rounded to whole pages first (Vm.invalidateCode:
the host's own writes into code — WriteProcessMemory, a ReadFile into a code buffer — raise no SMC exit, so those calls
are their only net, and Windows rounds a protection change to pages). Also: a region leaves `Jit.regions` in O(1)
(its index `at`, the last region moved into its place) instead of `indexOf` + `splice` over ~17 000 live regions.
`?jitopts={"smcExact":false}`, `dbg:ORTHROS_JIT_AB={"smcExact":false}` or `dbg:ORTHROS_SMC_PAGE=1`: page-granular as
before, for measurement. Tests: tests/jit-smc-exact.test.js (random programs storing data of every width around their
own code on its page and across into the next code page, rewriting a function's immediate and a branch displacement
that is the last byte of its block, rewriting bytes with their own values, whole and time-sliced, page-granular and
exact against the interpreter; mutations caught: overlap tested on a region's first block only, or missing a block's
last byte); the existing SMC tests unchanged (three that count page-granular drops run with `smcExact: false`).

Measured (Node 24, EPYC 7402P, `tools/bench/startbench.mjs`; AotR as a launcher plus game.dat: `--child`, which
follows the child process; `[jitchurn]` lines per phase):

- AotR, in-session A/B after the skirmish starts (scenario learn-aotr-skirmish then 3 × [exact, 8 s warm-up, 22 s;
  page-granular, 8 s warm-up, 22 s], `dbg:ORTHROS_JIT_AB`; two sessions at once). Thread CPU per frame, exact /
  page-granular: session 1 22.5 / 24.0, 23.7 / 26.1, 26.9 / 36.8 ms; session 2 23.4 / 23.2, 22.2 / 24.6, 32.6 / 36.4 ms
  (mean 25.2 / 28.5 ms, −12 %; 5 pairs of 6 better, one equal). jit category 0.4-1.3 s / 3.4-5.8 s per 22 s (2-6 % /
  16-27 % of the wall time); invalidations 0 / 47-61 per second, regions dropped 0 / 140-180, regions translated 27-87 /
  205-278; data stores kept 44-58 per second (the exits that remain). The guest category is 7-12 % higher in the exact
  phases of the first two pairs of each session (instruction counts ±2 %) but equal over the 400 s below: a matter of
  which moments of play the alternating phases caught.
- AotR, two separate sessions whose scenario waited ~400 s in play for its loading-screen mark (a heavy frame that
  came late): the same work, 102.8 G guest instructions and 11 254 / 11 358 frames at 27-28.6 fps. Page-granular /
  exact: thread CPU 335.5 / 234.8 s, **29.8 / 20.7 ms per frame (−31 %)**; jit category 106.1 / 5.7 s; guest 191.9 /
  188.6 s (1.87 / 1.83 ns per instruction: unchanged); api 38.2 / 37.6 s; waiting (headroom) 80 / 164 s; frames over
  40 ms 1 188 / 294, p99 92 / 55 ms; 54.6 / 0 invalidations a second, 164 / 0 regions dropped, 191 / 16 translated
  (the exact session ran under a preload timing `Jit.invalidate`: 1 150 calls in 20 s took 14 ms, 20 regions and ~1 000
  blocks scanned each).
- Vice City startup (first 4 G instructions, both variants at once): translation 2 262 → 679 ms, regions 4 429 → 841,
  invalidations 3 632 → 4 (3 628 stores kept), wall 5.4 → 3.8 s, process CPU 9.3 → 6.3 s.
- Controls without SMC events (0 invalidations either way), concurrent pairs, thread CPU per frame in play, exact /
  page-granular: RotWK 2.02 (rotwk-skirmish, 60 s) 19.18 / 19.18, 20.52 / 20.55, 20.48 / 20.40 ms (guest 2.32 / 2.26,
  2.37 / 2.46, 2.37 / 2.39 ns per instruction); BFME1 1.08 (bfme1-108-quick, 120 s) 14.89 / 15.66, 15.77 / 16.26 ms.
  Neutral.

Not kept — fine masks in WASM (measured first): stores into the data of a code page did not even leave their region. A
256-bit mask per such page (16-byte granules, 15 slots named by the high nibble of the page's SMC map byte, given to a
page at its first data store) was tested on smcCheck's cold path, by a call to a runtime function or inline. Exact as
well (the same randomized test; mutations caught: a region registered without marking its granules), and AotR's play had
no exit left — but every store's cold path grew: the TurboFan code of the regions compiled in a RotWK boot (`node
--perf-prof` jitdump, the 114 regions compiled in all three runs) 1.389 MB → 1.722 MB with the call (+24 %), 1.743 MB
inline (+26 %), and RotWK's play, bound by instruction fetch, lost 7.8 % guest time per instruction (one pair: 2.203 →
2.375 ns) — to save ~50 exits a second (counted in the runtime function: 41-57 data stores a second into AotR's mixed
pages in play). Exits cost microseconds; code bytes in every store site cost the whole play.

Not done: revalidating a region by comparing the bytes it was translated from (bgInstall compares a background batch's
bytes before installing it): no AotR event overlapped translated code, so there was nothing to keep that way; it would
need every region's block bytes kept. And the `blockMap` / `byFn` Map updates of `register()` and `dropOne()`, 14 % of
the thread in the study's profile, follow the drops: ~190 regions a second before, 5-87 a second with exact
invalidation; left as they are.

## Tier 2 by guest function (2026-11-12): prototype behind a gate — no-go, off by default

The study of 2026-11-12 (data/proof/guest-speed-2026-11-12/plan.md, rank 2c) proposed a second tier: the hot core of
the game translated **once**, by guest function, into one WebAssembly module whose functions call each other with WASM
calls (no copies, no chained transitions, fewer live values at the boundaries), gated on ≥ 20 % faster on the half of
the execution it covers. Prototype: src/cpu/jit/tier2.js, `ORTHROS_JIT_AB={"tier2":true}` (off by default; not a
`JIT_DEFAULTS` key, so the translated-code cache key is unchanged).

- **What it does, automatically at run time** (no per-game data): `{"tier2Profile":true}` or `{"tier2":true}` starts a
  profile window (`tier2Window` guest instructions, default 1 G): every region is translated again with one execution
  counter per block *address* (translate.js CountSlots: per-region counters overflowed the counter area with the ~3
  copies of each block). At its end the hot seeds are the blocks making `tier2Share` (default 0.5) of the counted guest
  instructions; function entries are the direct call targets of the code that ran plus every `call rel32` target and
  aligned dword of the loaded images (code and data: vtables, import slots) that is a block that ran; a function is
  every block that ran reachable from its entry without crossing another entry (cut at 300 blocks); hot seeds no entry
  reaches become entries. The functions holding the most counted instructions are taken up to the share, then the
  functions they call or jump to that ran (≤ 6 000 blocks). Each is translated by the region emitters restricted to its
  blocks (`onlyBlocks`), with: a `call rel32`, or a `call [slot]` whose slot holds a tier-2 function (guarded by the
  slot's value), as a WASM `call` passing and returning the 8 registers, EFLAGS, the 4 lazy-flag values and the budget
  (16 values; x87 / XMM caches written back before and reloaded after); a jump to a tier-2 entry (tail jumps, import
  stubs `jmp [slot]`) a WASM `return_call`; a RET a return of the popped address, which the caller compares with its
  return site — equal, it goes on; else (SEH, longjmp, a replaced return address) it leaves as a jump there. Every other
  exit (cold block, indirect transfer, API thunk, fault, budget, nesting deeper than 48) returns up the WASM calls to the
  function's region-signature entry, which leaves as a region does (chained); budget checked at every call (a recursion
  has no back edge). Every block of every function gets the hash entry (tier-1 regions translated afterwards stop at
  them: discovery boundaries); an x87 function is specialized for its tier-1 region's x87 mode and, entered under
  another, leaves (`EXIT_T2MODE`) and hands its entries back to tier 1. A store into a tier-2 page drops all of tier 2.
  Exact against the reference interpreter: tests/jit-tier2.test.js (random programs of functions — direct calls, calls
  through slots and import stubs, tail jumps, recursion deeper than the nesting bound, loops, early returns, a callee
  moving its return address, flags read after a call, x87 under a precision switched every iteration, SSE,
  interpreter fallbacks — built in the middle of the run, time slices of 5 000 / 97 / 7 instructions; SMC on a tier-2
  page). The whole JIT suite passes unchanged.
- **Measured** (RotWK 2.02 skirmish, Node, `tools/bench/ab-virtual.mjs --perf-phase` with
  tools/scenarios/rotwk-tier2-ab.txt: the same virtual-clock play in both arms, a 2 G-instruction profile window in
  both, then 50 s of play = 7 873 M guest instructions counted by `perf record` only during it, `--no-liftoff`, symbols
  by `--perf-basic-prof`; 2 runs per arm, run together; host instructions (i/g) and cycles (c/g) per guest instruction
  of the phase):

  | | tier-1 regions | tier-2 functions | all translated code | process | guest ns / insn |
  |---|---|---|---|---|---|
  | A (tier 1) | 6.97 / 6.96 i/g, 4.78 / 4.70 c/g, IPC 1.47 | — | 6.97 i/g, 4.74 c/g | 10.44 / 10.22 c/g | 2.849 / 2.790 |
  | B (tier 2, 0.5) | 4.83 / 4.89 i/g, 3.56 / 3.76 c/g, IPC 1.33 | 3.37 / 3.35 i/g, 1.61 / 1.66 c/g, IPC 2.06 | 8.22 i/g (+18 %), 5.29 c/g (+12 %) | 10.62 / 10.94 c/g (+4 %) | 2.918 / 3.001 (+5 %) |

  Tier 2 built 268 functions (29 x87), 2 405 blocks, 783 KB of WASM, 429 direct-call and 10 tail-call sites, in 60 ms
  of translation (+0.7 s of selection, mostly the image scan); it ran **51.8 %** of the phase's guest instructions
  (counted run, ORTHROS_TIER2_COUNT=1: 4 081 M of 7 873 M), entered 56.8 M times from tier 1 (one entry per 72 guest
  instructions run in it; left by a top-level RET 38.8 M, a jump 18.0 M), with 94.4 M WASM calls (one per 43) of which
  6.9 M came back elsewhere than their return site (an exit unwinding them). On what it covers: **3.16 cycles and 6.49
  host instructions per guest instruction** (IPC 2.06, instruction-cache fills per 1 000 host instructions 26 from L2
  and 7 from beyond, against 32 and 14 in tier-1 code). The same half in tier 1: A's translated code minus B's tier-1
  code = **2.08 c/g, 4.07 i/g** — as the study's hottest regions (RotWK play 2.12 c/g, 4.39 i/g at IPC 2.07). So tier 2
  is **~50 % slower** on the half it covers, not ≥ 20 % faster. Earlier variants: only the hot blocks in functions
  (everything else an exit; 177 functions of 1.6 blocks): +24 % guest time; the 0.9 share (6 010 blocks, 65 % of the
  instructions run in tier 2): translated code +19 % cycles.
- **Why.** (1) A tier-1 region already inlines its callees (a call and a RET to an in-region return site cost a push, a
  branch, a pop and a compare): `call f1 → call f2` in a loop costs 3.3 ns per iteration in tier 1 and 14.6 ns with
  the tier-2 WASM calls (~7 ns per call/return pair: 16 values each way, the callee's prologue and dispatch `br_table`,
  not inlined by V8 — functions are large); one call per 43 guest instructions makes that ~0.5 c/g. (2) The covered half
  is not closed: tier-1 code enters and leaves it every ~70 guest instructions (a chained transition plus the entry's
  call and its 16 values each time) — the half that runs is spread over hundreds of functions called from the other
  half. (3) The footprint gain is real but small where tier 2 runs: the hottest half already runs from the caches in
  tier 1 (IPC ~2.1); the fetch-bound flat tail (IPC 1.3-1.4) is the other half, which a 50 % tier 2 does not touch,
  and its tier-1 code got costlier per instruction (7.6 c/g) with the extra transitions at the boundaries.
- **What a tier 2 would need to win** (not built): callees inlined into their callers within a function (as tier 1
  does, a single copy per call tree instead of per region), the boundaries with tier 1 rare (whole call trees, ≥ 90 %
  of the instructions — the tail is where the fetch stall is), and calls with only the live values (per-function
  signatures). That is a region former over the call graph rather than a function translator, i.e. weeks of work for
  an expected gain bounded by the footprint of the tail; the cheaper steps of the plan (hot-only regions, contiguous hot
  code: plan.md 2a / 2b) attack that tail directly and come first.
- Not measured: Age of the Ring (tools/scenarios/aotr-tier2-ab.txt, `--until-api ''`: after 18 min and 90 G guest
  instructions the scenario had not reached the menu's frames — its play runs in game.dat's child process, which this
  tree's startbench does not follow; stopped), Chrome, the other games.
- Tools: `ab-virtual.mjs --perf-phase [--perf-label <phase>]` (perf over one scenario phase, `dbg:ORTHROS_PERF_CTL=1/0`
  through `perf --control`, events by code kind: tier-1 regions `r_*`, tier-2 functions `t2_*` / entries `w2_*`, the
  rest; per guest instruction of the phase), `ORTHROS_TIER2_COUNT=1` (tier 2's entries, exits, calls, tail calls and
  guest instructions, printed by startbench at each `ORTHROS_PERF_CTL` switch; the counters cost time), `ORTHROS_TIER2_LOG=1`
  (the selection and build).

## Library kernels recognised by content (2026-11-12, D122): exact, off by default

The C runtime the SAGE games ship (msvcr71.dll 7.10.3052.4, the same file in BFME1, BFME2, RotWK and AotR) runs 8.7 %
of RotWK's executed guest bytes in play (the study of 2026-11-12: `floor` 3.71 %, `fabs` 0.82 %, `ldexp` 0.81 %, `memcmp`
0.69 %, `memcpy` 0.61 %, `strncpy` 0.40 %, `modf` 0.30 %, `ceil` 0.18 %). The owner allowed recognising such libraries by
their content (DECISIONS.md D122): a library is recognised, never a game.

**Mechanism** (src/cpu/jit/libkernels.js, Jit.libKernel):
- A definition lists the byte ranges a kernel depends on, relative to the function's entry (the function, the helpers
  its path calls, the constants and jump tables it reads), and the absolute addresses among them. Its fingerprint (two
  32-bit hashes) replaces each address by its offset from the entry: the library loaded at another base matches, and
  its data is known to sit at the same offsets. Only fingerprints ship, no library bytes;
  `tools/gen/libkernel-sigs.mjs <dll>` prints a DLL's (export names are used there only, to write the table).
- Recognition happens where the JIT meets an address: a hash miss (before the cold tier), a translation request
  (prewarm, background), and every block a region registers (a caller translating the function with it by a direct
  call would otherwise hold its entry's hash entry). A first-byte and a 12-byte
  quick hash probe come before the fingerprint. Only addresses inside a DLL the process mapped count (Vm.inLibrary:
  never the executable).
- A kernel is a WASM function with the regions' signature, entered through the hash table like a region (its block
  parameter is the entry address); it returns through the chain stub to the caller's address. It reproduces every
  effect of the original path: the result, every register the code leaves (the values its helpers leave in EAX, ECX,
  EDX), the flags of its last flag-setting instruction (lazy), the x87 control / status / tag words, stack top and the
  physical registers it pushed through, the XMM registers and MXCSR, the stack memory the code writes below the
  caller's ESP (dead to the caller, kept all the same), and the guest instructions charged to the budget (the same
  count: `startbench --virtual` runs repeat their guest work exactly with the kernels on or off).
- Anything its path does not cover — an infinity / NaN where the code takes an error path, an x87 push that would
  overflow, an unmasked exception the path raises, DF set, a pointer in the first 64 KiB or near the end of the
  space, a destination page holding translated code (SMC), the overlapping backward copy, MXCSR with DAZ / FTZ — leaves
  with EXIT_STEP at the entry: the interpreter runs the first instruction and translation goes on. A kernel counts its
  calls (LIB_CALLS); one with more than a quarter of its calls off its path is dropped (the translation runs).
- The pages of the fingerprinted bytes are flagged for SMC detection like a region's: a write there drops the kernel,
  and changed code is not recognised again. No state of its own: everything is derived from memory at the next miss
  (a snapshot restores nothing for it).
- Switches: `ORTHROS_LIBKERNELS=0` (debug global or environment), the JIT option `libKernels` (`dbg:ORTHROS_JIT_AB=
  {"libKernels":false}` in a session, `ORTHROS_JIT_DEFAULTS='{"libKernels":false}'` for ab-virtual).

**Kernels** (msvcr71 7.10.3052.4):
- `floor` / `ceil`: the SSE2 path (msvcr71 sets `__sse2_available` under Orthros: IsProcessorFeaturePresent reports
  SSE2) — `stmxcsr` / `fnstcw` probes, the truncation by shifts of xmm1, the ±1.0 adjustment from a compare mask, the
  result stored over the argument and loaded with `fld` — and the x87 path (`__sse2_available` clear: `_ctrlfp` to a
  round-down / up control word, `frndint`, compare, `_ctrlfp` back). NaN (RotWK calls `floor(-NaN)` ~2 300 times in a
  run): the error path, the exact way.
- `fabs`: the x87 path (no SSE2 variant): `_ctrlfp(0x133f)`, the sign cleared through the frame, `_ctrlfp` back.
- `memcmp`: the byte loop and the `repz cmpsd` path, compared 8 bytes at a time; ECX / EDX and the instruction count
  follow from the position of the first difference.
- `memcpy` (a memmove): the forward copy to a 4-aligned destination (rep movsd or the unrolled table, then the byte
  tail), as `memory.copy`; the destination's pages checked first.
- tests/jit-lib-kernels.test.js: each kernel against the reference interpreter running the DLL's own code (from a game
  folder; skipped without), on randomized inputs and machine states, at the DLL's base and relocated, with and without
  chaining; everything compared (registers, flags, x87 and SSE state, the stack around the frame, the buffers, the
  library's data, the instructions charged), and that the kernel ran exactly when its path applies. Also a copy into
  a code page, a write to the fingerprinted code, a direct call translated with its caller, code outside a library.
  Mutations of the kernels (a condition code, a stack word, a register, a count, a tail case) fail it.

**Measurements** (Node 24, EPYC 7402P, the server loaded at 9-24 by other sessions):
- Per call (tools/bench/libkernel-bench.mjs, a guest loop calling through a function pointer, 10 M calls, median of 3,
  `--no-liftoff`), kernel / translation: `floor` 45.0 / 56.7 ns, `ceil` 45.2 / 58.0, `fabs` 43.1 / 140.9 (the two
  control-word switches), `memcmp` (16 equal bytes) 35.6 / 44.6, `memcpy` (64 bytes) 42.0 / 62.8. What remains is
  mostly the two transitions (call and return through the chain stub, ~23 ns a pair) and the loop.
- Calls in a run (`startbench --virtual`, `[libkernels]` with ORTHROS_JIT_STATS=1): RotWK 2.02 bench `rotwk-short`
  (menu, skirmish start, 50 s of play): `memcmp` 19.0 M, `floor` 10.0 M (2 316 off its path: NaN), `fabs` 2.2 M, `ceil`
  0.2 M; BFME1 1.08 `bfme1-108-short` (its 127 G-instruction map load and 40 s of play): `floor` 88.4 M (560 off its
  path), `ceil` 0.9 M, `memcpy` 102. Estimated from the per-call savings: ~0.5 s of RotWK's run, ~1.0 s of BFME1's.
- `tools/bench/ab-virtual.mjs --perf`, 2 runs per variant, on = defaults, off = `{"libKernels":false}`, the same guest
  instructions in every phase. JIT instructions of the whole run (the deterministic measure: two runs of one variant
  agree within ~0.1 %): RotWK −1.6 %, −1.8 %, −1.5 % (three rounds), BFME1 −0.6 %, −0.8 %, −0.6 %. Guest ns per
  instruction, on vs off: RotWK play 2.928 / 3.002 (−2.5 %), 3.068 / 3.085 (−0.6 %), 3.361 / 3.235 (+3.9 %, the round
  run at load 17-24 with the two runs of each variant 1-5 % apart); RotWK load 3.536 / 3.515, 3.622 / 3.589, 3.622 / 3.590;
  BFME1 play 2.010 / 2.030 (−1.0 %), 2.056 / 2.004 (+2.6 %), 2.458 / 2.421 (+1.5 %); BFME1 map load 1.856 / 1.871
  (−0.8 %), 2.016 / 2.008, 2.292 / 2.332 (−1.7 %). JIT cycles −1.9 / −0.9 / +5.1 % (RotWK), −1.0 / +1.2 / −1.4 %
  (BFME1). The time measures do not resolve the ~0.5-1.5 % the instruction counts and the per-call figures predict:
  the spread between rounds on this loaded machine is ±3 %.
- RotWK in-session A/B (startbench, real clock, tools/scenarios/rotwk-libk-ab.txt: 25 s phases after a 5 s warm-up
  following each switch), guest ns per instruction on / off: 2.257 / 2.404, 2.004 / 2.273, 2.295 / 2.254 (medians 2.257
  / 2.273); guest ms per frame 14.4 / 15.9, 15.0 / 17.5, 16.2 / 16.0.
- Off by default (integration of 2026-11-12): fewer host instructions on both games in every round and every kernel
  faster than its translation per call, but no time measure beyond the spread on any game, which the rule for a default
  asks for (`JIT_DEFAULTS.libKernels`; `?jitopts={"libKernels":true}` or `dbg:ORTHROS_JIT_AB={"libKernels":true}` to
  run them). The `memcpy` kernel catches almost nothing (102 calls on BFME1, none seen on RotWK): the study's hot copy is
  most likely `memmove`, a separate function, not recognised. Under exact SMC invalidation a kernel is still dropped
  by page (its fingerprinted ranges span helpers and constants, not blocks).

Not done here: `ldexp` (`_decomp` / `_set_exp`, ~90 instructions with the frame they leave), `modf` (SSE2 path and the
integer part stored through a pointer), `strncpy` (the magic-bits word loop), the MP3 decoder (not a kernel: its
stream functions are the host's, decoding off the thread — docs/miles-mp3.md), and the next lever the per-call
figures show — a kernel called from the caller's region at its `call [slot]` (as the inline fast APIs are) instead of
through two chained transitions.

## The four 2026-11-12 branches combined, measured against main

Merged together: the slot guard's pinning (Chrome against Node), exact SMC invalidation (on), the tier-2 prototype
(off) and library kernels (off). Integration fixes: invalidations from the APIs (VirtualProtect, VirtualFree,
FlushInstructionCache) are rounded to whole pages (`Vm.invalidateCode(addr, len, exact)`; only a store the translated
code caught is exact — host writes into code raise no SMC exit); tier 2's page marker and library kernels are dropped by
page under exact invalidation (neither has blocks to test, a kernel would otherwise never be dropped); the slot guard
pins `floor(quota / 100 %)` cores (rounded up, a 250 % quota on 3 cores throttled again) counted with `nproc --all`;
the harness reads "no quota" from `cpu.max` (cgroup v2 `cpu.stat` has `nr_periods` without a limit too).

Node (startbench, real clock, the live server's learned heat, no background translator; main and combined started
together, pairs alternated, 5 to 3 pairs; load average 5-15). Per play phase: thread CPU and guest category in ms per
frame, `jit` category in s per phase, guest ns per instruction:

| game, phase | thread CPU ms/frame main → combined | guest ms/frame | jit s | guest ns/insn |
|---|---|---|---|---|
| RotWK `rotwk-quick`, 120 s play (5 pairs) | 18.21 → 18.24 (pairs −1.5 … +0.6 %) | 14.70 → 14.67 | 2.69 → 2.65 | 2.029 → 2.059 |
| BFME1 1.08 `bfme1-108-quick`, 120 s play (3 pairs) | 15.41 → 15.47 (−2.4 … +2.2 %) | 12.42 → 12.50 | 1.12 → 1.08 | 2.774 → 2.783 |
| AotR 10 `learn-aotr-skirmish` + 30 s, play2 (3 pairs) | 23.78 / 44.71 / 24.89 → 20.69 / 41.76 / 18.07 (−13 / −7 / −27 %) | 13.93 / 32.34 / 14.72 → 16.45 / 34.28 / 14.91 | 5.80 / 4.27 / 6.11 → 0.14 / 0.10 / 0.09 | 1.521 / 1.241 / 1.577 → 1.755 / 1.254 / 1.909 |

(RotWK's combined runs execute 1-2 % fewer guest instructions for the same frames, hence its higher ns per instruction at
equal guest ms per frame. Pairs 4-5 ran main under the combined tree's startbench: +0.6 / −1.5 % thread CPU — the harness's
`--child` wrapper is not the difference.) AotR's guest category per frame is higher in two of three pairs; a pair of
the combined build with `smcExact` on and off, both with `--jit-profile`, has equal guest ns per instruction in play2
(1.632 vs 1.628) and equal chained transitions per instruction (0.027 vs 0.028): the code runs as fast, the frames
differ in content (one of the pair was CPU-saturated at 16.7 fps, the exact one at 25.6 fps).

Chrome (headless shell, both trees' pages through the combined slot guard: pinned to the slot's 4 cores, `--gl-discard`,
fresh profile, copies of the live learned data; one browser at a time, main and combined alternated):

| game, phase | fps main → combined | worker CPU ms/frame | guest ms/frame | jit ms/frame | guest ns/insn |
|---|---|---|---|---|---|
| RotWK `rotwk-quick` play, run 1 / 2 | 28.2 → 26.9 / 26.8 → 27.0 | 17.66 → 16.80 / 16.59 → 16.74 | 17.6 → 16.6 / 16.1 → 16.4 | 0 | 2.45 → 2.51 / 2.41 → 2.11 |
| AotR play / play2 (pair 2) | 21.5 → 21.7 / 24.1 → 25.3 | 24.13 → 22.64 / 22.36 → 20.32 | 24.1 → 24.1 / 21.6 → 21.5 | 1.5 → 0 / 1.4 → 0 | 2.62 → 2.61 / 2.49 → 2.52 |

(The browser translates in its background worker, so AotR's retranslations cost the emulator thread only their
installation, 1.4-1.5 ms per frame, not the 6-10 ms of Node. AotR pair 1 is not comparable: the combined run waited 380 s
in play for the scenario's 400-draw mark — the flake the SMC work met in both variants (explained 2026-11-12: the start position, random until then — the left marker of Harlindon renders fewer than 400 draws per frame for minutes; the scenarios now pick the right one, docs/aotr-play.md) — and its "play" phase came
six minutes later in the game, at 10 fps with 40 ms per frame of rendering waits; main's: 21.7 / 24.2 fps, 24.5 / 22.5 ms
worker CPU per frame.)

Result: no regression beyond the pairs' spread on RotWK or BFME1 (Node and Chrome); AotR −7 to −27 % thread CPU per
frame in Node and −6 to −9 % in Chrome, all of it the translation that exact invalidation no longer redoes. Defaults:
`smcExact` on, `tier2` off, `libKernels` off, slot pinning on.

## Hot-code footprint (2026-11-12): hot-only regions, one copy per hot block, contiguous layout — no-go, off by default

The study of 2026-11-12 (plan.md, rank 2a / 2b) named the size of the translated code as the first cause of slow play:
~100 KB of hot x86 as 15-30 MB of machine code over ~1 500 regions, the uop queue empty 25-32 % of the cycles. Gate: ≥ 8 %
less guest time per instruction in play on RotWK and AotR, with the instruction-cache fills and the uop-queue-empty
cycles clearly down; fills not dropping would mean the footprint thesis is wrong. Prototype: src/cpu/jit/hotcode.js, in-session
switches only (not `JIT_DEFAULTS` keys; the translated-code cache still starts over once, as at any change of
translate.js: it keys on the modules' source text too).

**Mechanism.** `ORTHROS_JIT_AB={"hotProfile":true,"hotWindow":2000000000}` starts a profile window (counters by block
address, as tier 2's: every region translated again with them); at its end every region is translated again, in every
arm (the control does the same work), under the arm's options (`ORTHROS_JIT_DEFAULTS` of an ab-virtual variant):
- `hotOnly`: the regions are shaped by the window's counts instead of the learned heat — a branch successor that did not
  run in the window (menus, loading, or not taken in play) is a cold exit (discoverRegion), translated at a miss if ever
  reached; `hotRatio: n` also cuts a successor that ran n times less than its branch;
- `hotOwn: n`: a block that ran ≥ n times in the window and that a live region already holds is a boundary for the next
  translations (one copy of each hot block; the new region chains to it; not for x87-mode versions, whose blocks must be
  the first version's); `hotOwnCalls: n`: only direct call targets (the call leaves the region, nothing else is cut);
- `hotHints` (`hotHintRatio`, default 32): guest Jcc hinted from the heat (one side ≥ 32 times rarer, or never run in a
  learned heat), so that TurboFan places the rare side after the function's hot code;
- `hotLayout` (`hotLayoutShare` 0.99, `hotLayoutChunk` 1024): the regions that made 99 % of the window's counted bytes
  translated at once, hottest first, into modules of 1 024 regions, each function called once in that order
  (Jit.translateGroups: as bgCompile, block −1 on JIT_WARM_STATE) so that V8 compiles and places them in that order —
  ~1 450 regions in 2 modules instead of ~12 modules of 128 in translation order.
Exact whatever the counts (only the regions' extent, boundaries and code placement change): tests/jit-tier2.test.js
runs its random programs of functions (calls, slots, stubs, tail jumps, recursion, x87, SSE, SMC) with a window and every
option on (mutation caught: the grouped functions put in the wrong table slots).

**Measured** (Node 24, EPYC 7402P, `tools/bench/ab-virtual.mjs --perf-phase --perf-label hotplay` — every arm's run at
once on the same virtual-clock play: tools/scenarios/rotwk-hot-ab.txt, aotr-hot-ab.txt with `--child --until-api none`
and the profile build/saves/aotr-10; learned heat of the live server; a 2 G-instruction window, a warm-up, then perf
over 50 s of play: RotWK 7 830 M, AotR 9 326 M guest instructions, the same in every arm). ab-virtual now also records
`de_dis_uop_queue_empty_di0` and splits V8's compilers (`v8c`) from the rest. Per guest instruction: host instructions
(i/g), cycles (c/g); fills per 1 000 *guest* instructions (per host instruction they mislead when the instruction count
changes); hot footprint = the region functions making 90 % of the region cycles and their machine code (perf maps).

| RotWK arm | guest ns | regions i/g, c/g | regions + runtime + JS c/g | fills L2 / beyond L2 per kg | uop queue empty | hot footprint |
|---|---|---|---|---|---|---|
| control (batch 1) | 3.010 | 6.99, 4.71 | — | 32.1 / 14.8 per k host | 30.8 % | 1 282 fns, 22.3 MiB |
| `hotOnly` | 3.022 | 6.90, 4.58 | — | 30.3 / 14.1 per k host | 29.9 % | 1 259, 20.5 MiB |
| `hotOnly` + `hotHints` | 3.249 (+8 %) | 6.90, 5.10 | — | 29.7 / 12.5 per k host | 29.9 % | 1 327, 21.2 MiB |
| `hotOnly` + `hotHints` + `hotLayout` | 2.998 | 6.98, 4.84 | — | 29.6 / 13.9 per k host | 31.3 % | 1 274, 20.7 MiB |
| `hotHints` alone (learned heat) | 3.030 | 6.95, 5.15 | — | 31.9 / 13.5 per k host | 30.9 % | 1 294, 21.2 MiB |
| control (batch 2) | 2.922 | 7.00, 4.57 | — | 31.5 / 15.4 per k host | 30.6 % | 1 254, 21.9 MiB |
| `hotOnly` + `hotLayout` | 2.923 | 7.01, 4.68 | — | 32.6 / 14.1 per k host | 28.4 % | 1 250, 19.0 MiB |
| `hotOnly` + `hotRatio` 64 | 2.903 | 6.80, 4.61 | — | 31.2 / 13.6 per k host | 28.5 % | 1 314, 20.4 MiB |
| `hotOnly` + `hotRatio` 64 + `hotLayout` | 2.810 (−3.8 %) | 6.81, 4.43 | — | 31.3 / 14.3 per k host | 29.4 % | 1 268, 19.8 MiB |
| control (batch 3) | 2.921 | 7.00, 4.58 | 6.10 | 220 / 108 | 30.4 % (1.39 c/g) | 1 267, 21.1 MiB |
| `hotOnly` + `hotOwn` 1 000 | 2.870 | 10.73, 5.72 | 7.13 (+17 %) | 276 / 90 | 20.8 % (1.19 c/g) | 701, 8.3 MiB |
| `hotOnly` + `hotOwn` 100 | 2.812 | 10.58, 5.71 | 7.13 (+17 %) | 275 / 83 | 20.3 % (1.16 c/g) | 668, 7.8 MiB |
| `hotOnly` + `hotOwnCalls` 1 000 | 2.986 | 10.30, 5.82 | 7.28 | 282 / 98 | 23.0 % (1.34 c/g) | 840, 10.4 MiB |

| AotR arm | guest ns | regions i/g, c/g | regions + runtime + JS c/g | fills L2 / beyond L2 per kg | uop queue empty | hot footprint |
|---|---|---|---|---|---|---|
| control | 1.707 | 6.51, 4.37 | 5.83 | 167 / 82 | 30.9 % (1.35 c/g) | 1 175 fns, 20.3 MiB |
| `hotOnly` + `hotRatio` 64 + `hotLayout` | 1.704 | 6.43, 4.27 | 5.74 | 156 / 73 | 30.4 % (1.30 c/g) | 1 133, 16.9 MiB |
| `hotOnly` + `hotLayout` | 1.775 (+4 %) | 6.42, 4.47 | 6.00 | 165 / 73 | 30.0 % (1.34 c/g) | 1 135, 16.9 MiB |
| `hotOnly` + `hotOwn` 100 | 2.021 (+18 %) | 9.45, 5.47 | 6.98 (+20 %) | 203 / 63 | 22.0 % (1.20 c/g) | 703, 7.0 MiB |

(Single runs per arm and batch, perf with `--no-liftoff`: every region is compiled by TurboFan on the emulator thread at
its first call, so the guest time of a phase still translating includes V8's compilers — 3.9 c/g in RotWK's control,
2.6-2.7 with `hotOwn`, which makes fewer and smaller new regions; in the browser they compile off that thread. Batch 1
ran at load average 16-20.) Guest time with V8's default tiers (Liftoff, then TurboFan in the background), no perf:
RotWK, 3 runs per arm, control 2.094 ns [2.192 2.090 1.999] vs `hotOnly` + `hotRatio` 64 + `hotLayout` 2.070 [2.072 1.989
2.148] (−1.2 %, thread CPU per frame −0.4 %; the identical pre-window play phase −0.2 %); an earlier batch at load
average 43-48, 2 runs: `hotOwn` 100 +13.5 %, `hotRatio` 64 + layout −4.3 %, `hotOnly` + layout −3.7 % (its identical
pre-window phase spread −11.6 … −1.5 %). AotR, 2 runs per arm: control 1.570 [1.526 1.614], `hotRatio` 64 + layout
1.510 [1.468 1.552] (−3.8 %) — and −4.0 % on the pre-window phases where both arms run the same code: noise.

**Why the gate fails, and what it says about the thesis:**
- **The hot regions hold almost no cold code already.** The learned heat's cold exits (`coldExits`) leave out what never
  ran; cutting also what did not run in play (`hotOnly`), or ran 64 times less than its branch (`hotRatio`), changed the
  hot footprint by ≤ 10 % (22 → 20 MiB): a region stops at 96 blocks, and the room left by cut blocks fills with more hot
  blocks (blocks registered in play: 65 k → 70 k). The machine code is hot code and its copies: the regions making 90 %
  of the window's counted bytes hold 1.05 MB of x86 blocks for 0.38 MB of distinct ones (×2.8 copies, RotWK; AotR 1.04 /
  0.39 MB), at ~13 bytes of WASM per x86 byte (layout: 1.14 MB of x86 → 15.4 MB of WASM in 1 460 regions).
- **Removing the copies cuts the footprint but costs more than it saves.** `hotOwn` (one copy of each hot block) divides
  the hot footprint by 2.7-2.9 (21 → 7.8 MiB, AotR 20 → 7.0 MiB) and the uop-queue-empty cycles by 15 % (1.39 → 1.16 c/g;
  30 → 20 % of the cycles), but fills from beyond L2 drop only 23 % per guest instruction (108 → 83, AotR 82 → 63), fills
  from L2 *rise* 25 % (220 → 275; AotR 167 → 203), and the region code runs 51 % more host instructions (7.0 → 10.6 i/g:
  the chained transitions that the copies avoided — each touches a region prologue and a chained exit, themselves cold
  code): translated code +17 % cycles (RotWK), +20 % (AotR), guest time +13.5 % / +18 % with V8's default tiers. Copies
  only at calls (`hotOwnCalls`) are no better. This is the trade measured by `dedup` and tier 2 before, now with the
  fills: the duplication is what keeps transitions rare, and transitions cost more than the fills they replace.
- **Contiguity does nothing measurable.** `hotLayout` packs the hot regions' TurboFan code into two code spaces (the
  90 % functions within ~150-200 MiB of address space; RotWK's control had them in code spaces spread over the 47-bit
  space, AotR's within ~205 MiB already): fills and cycles unchanged (RotWK `hotOnly` 4.58 → 4.68 c/g with the layout;
  AotR +4 %).
- **Branch hints from the heat are slower** (RotWK region cycles +8-11 % at the same instruction count and fewer fills
  beyond L2): not explored further.
- So the footprint does drive the fills and the empty uop queue (they fall when it falls), but the footprint that can be
  removed without new transitions is small, and the rest is the price of not having transitions. The remaining levers
  are the per-instruction size of the translated code (×13 WASM bytes per x86 byte; plan.md "ce que coûte une
  instruction": register shuffling at TurboFan's merges, x87 precision, SMC checks) and cheaper transitions, not where
  the code sits.

Off by default, kept for measurement: `hotProfile`, `hotOnly`, `hotRatio`, `hotOwn`, `hotOwnCalls`, `hotHints`,
`hotLayout` (`ORTHROS_HOT_LOG=1`: the window's `[hot]` stats). `hotProfile` is refused beside tier 2's window
(`tier2` / `tier2Profile` in the same switch): both count through the same slots, tier 2's would win and the hot window
would count nothing. Not measured (the gate failed on the two games it names):
BFME1, Vice City, Chrome.

## The second round of 2026-11-12 combined (footprint, Miles MP3, code shared by content), measured against main

Merged: the hot-code footprint prototype (hotcode.js, every option off, no-go), Miles' MP3 decoder run by the host
(docs/miles-mp3.md, `ORTHROS_MP3_HOST` off by default) and learned code shared by content (src/server/code-share.js,
docs/startup.md, on by default in the server). Integration fixes: code-share hashes a module file only after a PE header
check and at most 64 MiB (module names come from unauthenticated POSTs: an archive posted as a module was read whole on
the server's thread), a page shared by several small sections is hashed with all of them; `hotProfile` refused beside
tier 2's window; a failed translation in `translateGroups` gives its table index back. With the defaults, the client
runs the same code as main; what changes is the heat and region lists the server serves (own + lent).

Node (startbench, `--gfx recorder`, no background translator; main with the version's own learned heat, the combined
tree with the heat its server now serves — `tools/dev/code-share.mjs` on a copy of the live learn directory; main and
combined started together, pairs alternated; load average 2-17):

| game, phase | thread CPU ms/frame main → combined | guest ms/frame | guest ns/insn | jit s per phase |
|---|---|---|---|---|
| RotWK 2.02 `rotwk-quick` play 120 s, real clock (2 pairs) | 18.21 / 19.57 → 18.16 / 19.49 (−0.3 / −0.4 %) | 13.94 / 14.99 → 14.07 / 15.04 | 1.951 / 1.965 → 1.980 / 2.025 | 2.70 / 3.39 → 1.98 / 2.40 |
| RotWK 2.02 `rotwk-quick` play, `--virtual` (4 rounds; identical guest work) | 12.95 → 13.09 (+1.1 %; own heat on the combined tree 12.98) | 10.34 → 10.50 (own heat 10.38) | 1.853 → 1.884 (rounds +2.4 / +3.6 / −0.1 / +0.8 %; own heat 1.862) | 1.42 → 1.33 |
| BFME 1.08 `bfme1-108-quick` play 120 s (3 pairs) | 16.23 / 15.90 / 16.29 → 16.39 / 16.27 / 16.45 (+1.0 / +2.3 / +1.0 %) | 12.14 / 11.80 / 12.19 → 12.30 / 12.15 / 12.25 | 2.749 / 2.735 / 2.763 → 2.700 / 2.786 / 2.703 | 0.74 / 0.64 / 0.76 → 1.26 / 0.77 / 1.34 |
| Vice City `vc-quick` drive 48 s (3 pairs; nothing lent) | 18.23 / 19.46 / 18.40 → 18.65 / 17.31 / 19.27 | 13.57 / 13.67 / 13.59 → 13.60 / 12.61 / 14.79 | 2.644 / 2.794 / 2.779 → 2.662 / 2.828 / 2.500 | 1.23 / 1.48 / 1.15 → 1.27 / 1.08 / 1.50 |
| AotR 10 `learn-aotr-skirmish` + play2 (3 pairs) | play 38.3 / 22.0 / 29.9 → 26.7 / 26.7 / 27.5 | — | not comparable (2.3-11.1 G instructions in the same 20 s) | — |

(BFME1's combined runs executed 1-3 % more guest instructions per frame in all three pairs at an equal or lower cost
per instruction — the game's content in real time —, plus ~0.5 s more translation per phase in two of three: the lent
heat makes some regions larger. RotWK `--virtual`, the only deterministic comparison: +1.7 % ns per instruction with
the served heat, +0.5 % with the version's own heat on the same tree, within the ±2-3 % spread of the rounds.)

Chrome (headless shell through the slot guard, pinned to the slot's 4 cores, `--gl-discard`, fresh profile, each run
its own copy of the live learn directory without snapshots, the harness's server from each tree — the combined one
lends; one browser at a time, order alternated):

| game, phase | fps main → combined | worker CPU ms/frame | guest ns/insn |
|---|---|---|---|
| RotWK `rotwk-quick` play, runs 2 / 3 (run 1 in bench mode, no CPU report: 26.7 → 26.6 fps, guest 2.31 → 2.22 ns) | 28.8 / 26.8 → 28.0 / 27.9 | 17.12 / 16.83 → 17.94 / 18.53 (per M guest instructions 2.45 / 2.52 → 2.50 / 2.50) | 2.36 / 2.51 → 2.43 / 2.44 |
| AotR play, main runs 1 / 3, combined 1 / 2 / 3 | 20.8 / 19.7 → 20.8 / 21.5 / 20.9 | 24.81 / 24.86 → 26.25 / 23.81 / 24.70 | 2.66 / 2.71 → 2.75 / 2.63 / 2.79 |
| AotR play2 (10 s) | 24.0 / 22.6 → 24.7 / 24.4 / 25.6 | 20.82 / 22.71 → 24.37 / 21.12 / 20.77 | 2.34 / 2.69 → 2.84 / 2.55 / 2.70 |

(AotR main run 2 met the scenario's 400-draw anchor flake (explained 2026-11-12: the start position, random until then — the left marker of Harlindon renders fewer than 400 draws per frame for minutes; the scenarios now pick the right one, docs/aotr-play.md) — 406 s of loading screen, then another game state at
12.6 fps and 22 M instructions per frame —: left out. RotWK's combined runs did 3-11 % more guest work per frame: the
same cost per instruction.)

Startup, Chrome, RotWK 2.02 (a mature version: its own data plus the lent): first Direct3D frame 26 / 26 / 26 s →
29 / 27 / 28 s, menu anchor 49 / 49 s → 51 / 52 s, play starts at the same time (98 → 97 s). AotR: first frame 102-103 s
→ 99-103 s. Most of RotWK's delay is the harness: its server is new at each run, so the first `/api/heat` request
builds the content index (1.3-1.6 s, synchronously) on the start's path, where the live server builds it 20 s after
its start. With a standalone server of each tree started 30 s before the run (2 pairs, `--br-cache off`): first frame
24 / 24 → 25 / 25 s, menu anchor 47 / 47 → 48 / 48 s, play from 92 / 94 → 93 / 94 s; play 28.5 / 28.9 → 28.7 / 28.5 fps,
worker CPU 17.40 / 16.84 → 17.43 / 17.68 ms per frame, guest 2.35 / 2.33 → 2.42 / 2.36 ns per instruction. The second
left is the lent data itself (RotWK 2.02 has 37 435 entries of its own, 2 565 lent fill the 40 000; its heat grows by
the other versions' ranges, regions get larger): a mature version gains nothing from it.

Result: no play regression beyond the pairs' spread on RotWK, BFME1, Vice City (Node) or RotWK, AotR (Chrome); a
mature version's start is ~1 s later in Chrome with a warmed server (RotWK 2.02, two pairs; 1-3 s with the harness's
new server), against 9-18 s gained by a first session (docs/startup.md). Follow-up done at the merge: a module whose
own heat already covers 70 % of the lent bytes gets nothing lent (`OWN_ENOUGH`, code-share.js), so a mature version is
served its own data again (live learn data: RotWK 2.02 37 743 entries served, 37 435 own; BFME 1.08 34 807, all own;
AotR 31 474, 31 367 own); a first session (own 0 %) keeps the whole loan. Defaults: code share on (server), MP3 host off, every hot* option off.

## Targeted fixes and API exits (2026-11-12, plan.md ranks 5 and 6)

Five local changes, each a `JIT_DEFAULTS` key (`ORTHROS_JIT_DEFAULTS` / `?jitopts` / `dbg:ORTHROS_JIT_AB`), exact against the
reference interpreter (tests/jit-fixes.test.js: randomized programs per option, whole and time-sliced, under the VM's SMC
handling; the full depth runs the option off as well). Unlike the variants above (region shapes, transitions, code
placement), none changes what a region holds or where it ends: each shortens the code of one instruction pattern, so
they cannot trade fewer instructions for more transitions — the trap of `dedup`, tier 2 and `hotOwn`.

- **`strSmcOne` — MOVS / STOS without REP.** A single string store writes `size` bytes at the EDI before it whatever DF
  says; it now takes the ordinary store's check (one SMC map byte, Emitter.smcCheck through L_TA) instead of the range
  check written for REP (two direction selects for the range's ends and a loop over its pages).
- **`divFast` — 32-bit DIV / IDIV.** When EDX is the sign extension of EAX (IDIV) or 0 (DIV) — compilers' `cdq ; idiv`,
  `xor edx, edx ; div`, tested at run time since any instruction may set EDX —, one 32-bit division (V8: one `idiv r32`);
  otherwise one 64-bit division (it was `i64.div` and `i64.rem`: two 64-bit divides, each with V8's zero and −1 tests).
  The remainder is EAX − quotient × divisor in 32 bits in both cases. #DE exactly where x86 raises it, before any register
  changes: a zero divisor, a quotient that does not fit, −2^31 / −1 (32-bit path), and −2^63 / −1, which used to trap in
  WebAssembly (an imprecise fault).
- **`mmxTopOnce` — MMX.** Every MM access re-bases the x87 stack on TOP = 0 and sets the tag word (x87SetTop0: a test of
  TOP whose arm writes the eight stack locals back and reloads them) — two or three times per MMX instruction. Once done in
  a block, the block's next MM accesses skip it until an x87 instruction (FPU_OPS: EMMS, FXRSTOR... included) or an
  interpreter fallback runs (`mmClean`, reset at each block's start: a block is entered from anywhere).
- **`smcGroup` — stores of one structure share their SMC check.** Stores of a block through the same base and index
  registers (unchanged between them) whose bytes all lie within 4 KiB (translate.js planSmcGroups) are checked once, after
  the first of them, on the span of the whole group: one SMC map byte read at r + lo (lo the group's lowest displacement),
  whose SMC_NEXT bit covers the second page a 4 KiB span can touch (the page below the null area at the top of the user
  space now carries SMC_NEXT too, jit.js clearTables). Its cold path first decides for the leader's own store as before,
  then, if the span touches translated code, a watch or a page never mapped, leaves the region right after the leader
  (`exitTo(insn.next)`; the rest of the block runs from a region entered there, where its stores are checked again).
  Exact because nothing translates while a region runs, so pages clean after the leader stay clean until the block's last
  store. Different from the fine-mask attempt above (which added code to every store's cold path): fewer checks, the cold
  path once per group. A leader whose handler does not check its store through smcCheck breaks its group (the members
  check themselves).
- **`apiInline` — fast-path APIs reached through a register or a vtable**, run from the region (an imported call to the
  runtime module's `fastApi`, ESP written before, EAX and ESP read back, the CALL going on at its return site locally)
  instead of a region exit, the dispatcher's loop and a region entry at the return site. Off: see the measurements.

API exits in play (`startbench --jit-profile --api-hist`, which now prints each phase's calls per frame, `[apiphase]`):
RotWK 2.02 play (1 399 frames) — the dispatcher's fast paths 7.2 k calls per frame (deferred COM 6 607, AddRef / Release
150, D3DX 132, GetParameterDesc 83, timers 117), JavaScript ~820 (Sleep 112, vertex / index buffer Lock + Unlock 252,
WaitForSingleObject 85, ID3DXEffect::BeginPass 23, ApplyParameterBlock 15); AotR 10 play — fast paths 23.8 k per frame
(deferred COM 22 410, AddRef / Release 1 157), JavaScript ~1 250 (ReadFile 214, IDirect3DTexture9::Release 203, buffer
locks 242, WaitForSingleObject 105, Sleep 89). Menus add DirectInput's Acquire + GetDeviceData (RotWK 2 249 each per frame,
AotR 1 005), loading screens surface LockRect / UnlockRect (RotWK 7 167 each per frame in its load). The JavaScript calls
left in play are a few hundred per frame at ~0.3 µs (under 2 % of a frame); the fast ones are the volume, hence `apiInline`.

**Measured** (Node 24, EPYC 7402P, load average 10-40 from other sessions).

Kernels (tools/bench/fixes-bench.mjs: `--perf` host instructions of the loop's region per iteration — perf samples of the
`r_*` functions, deterministic to ~1 % —; without, median ns per iteration of 7 alternated runs; off → on; the empty
loop is 12.9 instructions):

| loop (one iteration) | host instructions | ns |
|---|---|---|
| 8 × `movsd` (ESI / EDI reset) | 309.6 → 142.7 | 18.67 → 8.75 |
| 8 × `stosd` | 277.5 → 129.8 | 16.58 → 8.46 |
| 8 × `movsb` | 334.9 → 145.0 | 20.79 → 9.37 |
| 4 × (`mov eax, ecx ; cdq ; idiv ebx ; add esi, edx`) | 71.0 → 40.0 | 34.49 → 6.91 |
| 4 × (`mov eax, ecx ; xor edx, edx ; div ebx ; add esi, edx`) | 33.0 → 23.9 | 13.95 → 6.99 |
| 4 × (`cdq ; idiv dword [edi]`, a divisor in memory) | 116.0 → 81.0 | 21.08 → 16.88 |
| 4 × MMX pixel (`movq ; punpcklbw ; pmullw ; psrlw ; packuswb ; movd`) | 225.8 → 165.0 | 18.17 → 16.22 |
| `mov [edi+4k], eax`, k = 1..8 | 70.4 → 36.0 | 8.10 → 5.98 |
| a structure: 2 × (3 stores, one `add [edi+12], ebx`, a byte store) | 73.0 → 36.0 | 8.77 → 6.14 |
| 8 × (`mov [edi+4], eax ; mov edx, [esi+0x100]`) | 69.0 → 40.0 | 10.05 → 8.69 (−13 %, two runs; one run under load +71 %) |
| 4 × (`mov eax, thunk ; call eax`), `apiInline` | — | 81.36 → 63.30 |

Games (`tools/bench/ab-virtual.mjs --perf-phase`, tools/scenarios/fixes-*.txt, both arms at once on the same
virtual-clock work, `--no-liftoff`; per guest instruction of the phase: host instructions (i/g) and cycles (c/g) of the
translated regions and of the whole process, guest ns per instruction and the emulator thread's CPU per frame;
off = the four fixes off, on = `strSmcOne` + `divFast` + `mmxTopOnce` + `smcGroup`):

| phase (guest instructions) | regions i/g | regions c/g | process i/g | process c/g | guest ns | CPU / frame |
|---|---|---|---|---|---|---|
| RotWK 2.02 play (6 131 M) | 7.21 → 7.02 (−2.6 %) | 4.94 → 4.77 | 14.89 → 14.33 | 9.68 → 9.35 | 2.572 → 2.470 (−4.0 %) | −3.4 % |
| AotR 10 play (7 442 M) | 6.59 → 6.39 (−3.0 %) | 4.25 → 4.10 | 10.44 → 10.21 | 6.72 → 6.56 | 1.761 → 1.702 (−3.3 %) | −2.8 % |
| BFME 1.08 play (6 305 M) | 6.00 → 5.82 (−3.0 %) | 3.42 → 3.29 | 13.19 → 12.62 | 7.61 → 7.30 | 2.105 → 2.003 (−4.8 %) | −4.1 % |
| Vice City drive (7 549 M) | 6.55 → 6.26 (−4.4 %) | 3.74 → 3.60 | 17.98 → 17.26 | 9.93 → 9.59 | 2.780 → 2.696 (−3.0 %) | −3.2 % |

Same runs, other phases (guest ns per instruction): BFME1 map load (127 241 M) 1.745 → 1.680 (−3.7 %), menu −4.4 %; Vice
City load −9.6 %, cutscene −5.7 %; RotWK menu −6.6 %, load −6.5 %, loading screen −6.7 %; AotR menu −6.0 %, loading
screen −6.5 % (its load phases do 1-4 % different guest work between arms). A second pair without perf (V8's default
tiers, arms in the other order): RotWK play −7.4 % guest ns (CPU per frame −6.7 %), AotR play −2.8 % (−1.3 %); their
short menu / setup phases swung ±10-48 % in both directions between the two pairs (seconds of work on a loaded machine).

By item (instruction counts compare across batches; time only within one):
- `smcGroup` alone, RotWK play: regions 7.24 → 7.05 i/g, process 14.91 → 14.52 — nearly all of the play gain.
- The three others together (`strSmcOne` + `divFast` + `mmxTopOnce`): RotWK map load (load + loading screen, 4 303 M)
  regions 6.67 → 6.52 i/g, 3.43 → 3.33 c/g, process 65.83 → 64.58 i/g (the load is JavaScript and API work), guest ns
  −0.4 %, CPU per frame −2.0 %; BFME1 map load regions 6.28 → 6.21 i/g, time ±0.1 % — the study's "−0.3 instruction per
  guest instruction" for MOVS was a reading of the hottest regions, not of the whole load; play −0.7 %. Exact, fewer
  instructions where they apply, no loss anywhere: on with the group.
- `apiInline` alone, RotWK play: regions 7.24 → **7.42** i/g, process 14.91 → **15.51** (+4 %), every phase slower than the
  `smcGroup` arm run with it (play +6 %, menu +26 %, map load +31 %). A call in the region function, even on a path
  rarely taken, makes V8 spill the region's live values around it (as noted for the x87 kernels), and every indirect call
  site carries the thunk test and that path; the dispatcher round trip it saves costs ~4 ns in the kernel (20 → 16 ns a
  call). **Off**, kept for measurement. What the exits cost in play is not the dispatcher's loop but the region exit and
  entry, which only a call that does not leave the region and does not sit in its code could save.

Defaults: `strSmcOne`, `divFast`, `mmxTopOnce`, `smcGroup` on (all four games faster in play, −3 to −5 % guest time per
instruction, −2.6 to −4.4 % host instructions in the regions, loads and menus faster too); `apiInline` off. The
translated-code cache keys on JIT_DEFAULTS: the first session after the change translates again. Not measured: Chrome
(the play figures above are the translated code's own; docs "Chrome against Node" found the same code in both), BFME2.
Seen while testing, not investigated: a randomized program whose stores turned its own code into an endless mix of
INC / DEC and stack instructions ended differently in the JIT and the interpreter with every option off as well (the
test's stores now keep the code well-formed).

## x87 truncation without exponent tests: static exponent bounds (`x87Bounds`, 2026-11-12) — exact, off by default

The guest-speed plan's rank 4 (`data/proof/guest-speed-2026-11-12/plan.md`): x87 precision emulation was 3.4 host
instructions per guest instruction in BFME1's map load (42 % of its hot regions' instructions), most of it in truncating
24-bit code (control word 0xc7f). Counters added to profiling translations (`x87DirArith`, `x87DirGrid`,
`x87DirBounded`, `x87DirSt32`; `startbench --jit-profile`) over `bfme1-108-short`'s map load (35 G guest instructions):
5.3 G truncating arithmetic instructions (15 % of all), 1.9 G of them with a result on the 24-bit grid (36 %, the
exactness test), 2.4 G FST m32 under the directed mode — every one of a narrow value. Play runs 3 M of them.

What differs from the earlier x87 work (cold paths as kernels, toward-zero on the bits, the vector cut, narrow values
for products and quotients — "BFME1's map load", "x87 regions: ..." above): those made each test cheaper; this proves
most of them unnecessary at translation time. Three changes behind one switch (`x87Bounds`, JIT_DEFAULTS):

- **Exponent bounds per x87 register** (translate-x87.js `rngOf`, Emitter.rngMask / x87Rng, dropped wherever the narrow
  values are): `2^-lo <= |v| <= 2^hi` for every finite non-zero value — an m32 operand 128 / 149, a 16-bit integer
  16 / 0, a 32-bit one 32 / 0, constants their own; a product adds the bounds, a sum takes max + 1 / max + 23 (narrow
  operands are multiples of 2^(-lo-23); 52 otherwise). Kept for the results of truncating 24-bit arithmetic only
  (truncation never leaves them). An add / sub / subr / mul of narrow operands whose result bounds lie inside the f64
  normal range (hi <= 1023, lo <= 1021) cannot overflow, underflow or land in the lowest binade, so
  `roundTowardZeroBounded` drops the exponent test: a product (exact) is cut unless it is a NaN (`vucomisd ; jp`); a sum
  off the grid is cut (`vmovq ; test ; jnz ; vmovddup ; vpand`, the cut computed before the branch so that no move merges
  the two paths); a sum on the grid is s itself when `(s - x) - y` and `(s - y) - x` are both +0 — their bit patterns
  ORed, one integer branch (Fast2Sum: s - x is exact for the larger operand, so an inexact s fails that side; NaNs and
  infinities give NaNs; zeros included) — else the interpreter. A NaN result of narrow operands has its 29 low bits clear
  (an m32 NaN quieted, or the default NaN), so it always takes the grid path's test.
- **FST m32 of a narrow value** under a directed 24-bit mode: the float is exact when its exponent field is in [2, 254]
  (the value is then at least 2^-126, where every 24-bit value is a float — the lowest binade excluded because f32.demote
  can round 2^-126 - 2^-150 up into it) — `vmovd ; lea ; cmp ; jae` on the demoted bits where the round trip took
  `vcvtss2sd ; vucomisd ; jp ; jnz`; anything else takes the round trip and the directed step as before.

Measured (shared server, load average 10-50 from other projects):

- Static, tools/bench/x87-size.mjs at 0xc7f (10 regions, a `mac` case added: `fld st(i) ; fmul m32 ; fadd m32 ; fstp
  m32`): WASM 24 250 → 22 868 B (−5.7 %), TurboFan machine code 35 564 → 33 936 B (−4.6 %); WASM operations per x87
  arithmetic instruction xform 77 → 53, mac 81 → 63, fild 78 → 54.
- Kernels, x87loop-bench 0xc7f `--full --pos` (`mac to memory` added; host instructions per iteration from `perf stat`
  at two run lengths): sums of squares 378 → 285, xform 315 → 218, mac 155-161 → 131-147. Time against main (7
  alternated runs, medians): xform 20.32 → 17.75 ns (−12.7 %), fild + fmul + fstp −16.6 %, mac −9.8 %, sums of squares
  −9.0 %, arith across blocks −6.6 %, recurrence +0.7 %.
- A replica of the map load's hottest loop (its 65 guest instructions run by the JIT on synthetic data, the branch
  mostly one way; scratch only, not in the tree): 631 → 497 host instructions per iteration (−21 %), 185 → 153-160
  cycles (IPC 3.3). The FST m32 test alone: 167 → 159 cycles at equal instructions (8 alternated `perf stat` runs); the
  ORed exactness test against two f64 compares: 162 / 161 cycles, neutral (kept: one branch instead of four).
- **BFME1 map load, identical guest work** (`ab-virtual --virtual --perf-phase --perf-label load`, new scenario
  `tools/scenarios/bfme1-108-load-ab.txt`, 36.8 G guest instructions; two A/B runs, before and after the FST m32
  change, the same figures within 0.1): region host instructions per guest instruction 7.87 → 7.29 (−7.4 %), region
  cycles 2.84 → 2.75 (−3.4 %), process cycles
  −1.8 %, guest ns per instruction −2.1 %; the hottest region (20 % of the load's region cycles) −14.5 % instructions but
  −4.9 % cycles. The game's IPC in these regions is 2.3 against the replica's 3.3: the map's data, not the arithmetic,
  bounds them, so the instructions removed buy a third of their count in cycles.
- **BFME1 map load, real clock** (`bfme1-108-short` with the canonical first-launch profile and the live learned
  regions / heat, `--cold --gfx recorder`, 5 concurrent pairs, launch order alternated, off → on; load average 10-50):

  | pair | load phase (s) | thread CPU in it (s) | guest ns / insn | play guest ns / insn | play thread CPU (s) |
  |---|---|---|---|---|---|
  | 1 | 50.8 → 44.3 | 34.7 → 32.8 | 0.942 → 0.895 | 2.544 → 2.575 | 19.8 → 20.3 |
  | 2 | 49.8 → 48.8 | 37.0 → 35.2 | 1.005 → 0.958 | 5.564 → 5.663 (a loaded moment) | 25.4 → 24.9 |
  | 3 | 51.3 → 47.8 | 34.4 → 33.1 | 0.936 → 0.897 | 2.472 → 2.501 | 20.0 → 20.2 |
  | 4 | 49.8 → 48.8 | 34.2 → 33.6 | 0.936 → 0.918 | 3.027 → 3.049 | 23.2 → 24.1 |
  | 5 | 50.8 → 47.8 | 34.2 → 33.0 | 0.932 → 0.903 | 2.514 → 2.586 | 19.8 → 19.7 |
  | mean | 50.5 → 47.5 (−5.9 %) | 34.9 → 33.5 (−3.9 %) | −3.8 % | +1.6 % | +1.0 % |

  The load phase also waits (11-17 s of its ~50 s, every run): the guest time saved, 0.6-1.8 s, is the floor of the gain;
  the waits moved by −4.7 to +0.7 s. Play is the same code (3 M truncating instructions in 6.2 G); its +1.6 % may be
  the overlap (the variant on finishes its load first: its play starts while the other still loads), and the
  identical-work runs disagree (play −2.0 % and +1.0 % in the two `--virtual` A/B above).
- RotWK 2.02 (`rotwk-short`, `ab-virtual --perf`, identical guest work): JIT instructions +0.05 %, cycles +0.49 % —
  the same code (no truncating 24-bit arithmetic in that run); per-phase guest ns within ±3 %.
- Exactness: tests/jit-x87-narrow.test.js "bounded narrow arithmetic under truncation" — every pair of 14 special
  operands (zeros, ±1, absorption both ways at 2^-30 / 2^-60 against 1 and 2^24, the float range's ends, a denormal,
  infinity, NaN, 2^-127 x (2 - 2^-23) below the normals) through add / mul / sub / subr in one loop with FNSTSW m16 /
  FNCLEX / FST m32 / FSTP m64 after each; products chained past the bounds' limit with the whole status word compared;
  random straight-line programs (option on, off, time slices); the path counted so that it is known to run. Mutations
  caught: no NaN test on products, on-grid sums accepted, the bounds' limit removed, the FST test's lowest binade
  accepted. Not caught (left as is, sound): the sums' +23 on `lo` — m32 operands' bound 149 is loose enough that no
  float program reaches it.

Gate (the plan's: BFME1 1.08 map load ≥ 10 % faster): **not met** — −5.9 % wall (−3.9 % thread CPU) over five pairs,
−3.4 % region cycles at identical work. The plan's −15-25 % assumed the precision instructions cost their count in
cycles at the load's IPC; removing them left the regions' data-bound cycles (and the per-operation latency of
`vaddsd ; vmovddup ; vpand`, unchanged) in place. Off by default (`ORTHROS_JIT_DEFAULTS=
{"x87Bounds":true}` turns it on): it wins only on BFME1's map load, the one measured game whose hot code truncates at
24 bits, and the rule is two games. Adding the key changes the translated-code cache's key (JIT_DEFAULTS): one
retranslation per player after the update, as for any new option.

## Guest stack slots in WASM locals (2026-11-12): the opportunity measured first — no-go, nothing built

The idea: 32-bit game code spills to `[esp+d]` / `[ebp+d]`; within a region, keep the frame slots whose address is
provably region-entry ESP / EBP + a constant in WASM locals (loaded lazily, written back at exits, stores through other
bases range-checked against the promoted window). Unlike every variant above it would remove guest *memory* accesses
rather than reshape control flow, region extents or the x87 / flags code. Gate: ≥ 6 % less guest time per instruction in
play on two games. The opportunity was measured before writing any translator code, and it is too small.

**What runs.** `startbench --stack-mix` (tools/bench/jit-mix.mjs `stackSlotMix`): the counted regions' blocks are decoded
again and weighted by their execution counts. Each memory access is classified, and the ESP / EBP bases are tracked
relative to the region's entry through ADD / SUB by a constant, PUSH / POP, MOV, LEA and LEAVE, over the region's own jumps
and branches. A call, a return or any other write makes the base unknown. A load counts as one a local could serve when
its slot was accessed earlier in the same block execution, or on every path from the region's entry (must-availability).
A third line estimates loop iterations beyond one per region entry: a region-frame slot loaded in a block that runs more
often than the region's entry block. This estimate leans generous. Node, real clock, the live server's learned heat and
regions, block counters switched on in play (`dbg:ORTHROS_JIT_AB={"blockCounts":true}` 30-46 s into play, then 60-70 s
counted). Shares are per executed guest instruction:

| game (counted) | loads | stores | `[esp+d]` loads | `[ebp+d]` loads | POP | stores, other bases | servable: same block | every path | loop estimate | total servable |
|---|---|---|---|---|---|---|---|---|---|---|
| RotWK 2.02 (8.4 G) | 35.6 % | 18.7 % | 4.7 % | 5.0 % | 4.1 % | 5.7 % | 1.9 % | 0.7 % | 0.1 % | **2.7 %** |
| AotR 10, game.dat (11.5 G) | 35.3 % | 20.3 % | 4.8 % | 4.0 % | 4.3 % | 6.5 % | 1.4 % | 0.8 % | 0.2 % | **2.4 %** |
| BFME1 1.08 (5.9 G) | 35.3 % | 18.3 % | 9.1 % | 1.1 % | 2.6 % | 7.1 % | 3.1 % | 1.2 % | 0.2 % | **4.5 %** |

(A first run of the same scenarios without the every-path line gave the same shares to within 0.1 point: RotWK 1.9 / 0.5,
BFME1 3.1 / 0.7.) Frame loads with an index register, or with an unknown base, are ≤ 0.2 %.

**What a served load would save.** tools/bench/memop-bench.mjs (cases added; Node, branch hints, 7 runs): 8 × `mov edx,
[esp+8]` costs +0.092 ns a load over the loop, 8 × `mov edx, [ebp-8]` +0.084 ns, a register move ~0. `add eax, [esp+8]`
costs the same as `add eax, edx` (0.181 vs 0.183 ns a group): the load is off the dependency chain. On the machine code, a
served load drops the `lea` and the `mov` (2 host instructions out of ~7 a guest instruction in regions; `memarg` above
already measured what removing the `lea` from every `[base+disp]` load buys: −0.2 to −1.3 % JIT instructions, no time
resolved). In play the TurboFan code already spills (stack slots were 12-14 % of the region samples in BFME1's 3D menu, above), so a promoted slot would
often live in a spill slot and save only the `lea`.

**Bound.**
- **Servable loads.** 2.4-4.5 % of guest instructions × 2 host instructions ≈ 0.05-0.09 of ~7 region instructions per
  guest instruction: 0.7-1.3 % of the region code's instructions. In time, at ~0.1-0.3 ns a load against ~2.4 ns a
  guest instruction in play, that is 0.1-0.5 %.
- **The ceiling.** Every frame load with a known base, including POP: 13.8 % RotWK, 13.1 % AotR, 12.8 % BFME1. Serving
  them all, at 2 host instructions each, gives at most ~4 % of region instructions and ~1.7 % of guest time. That is under
  the 6 % gate before any cost.
- **The costs.**
  - Stores through other bases run 5.7-7.1 % of guest instructions, more than the servable loads. With write-back, each
    needs a range compare against the promoted window, and loads through other bases need one too, for pointers to locals.
    With write-through, only the loads gain.
  - Every promoted slot is one more value live to every exit, at the merges where TurboFan's register shuffling is
    already the largest overhead (plan.md: 0.9-1.0 host instruction per guest instruction). Rebuilding the lazy flags at
    exits so they die earlier measured +1-2 %, and moving the registers from the parameters into the state block
    measured +17 % per chained call/return.
  - Write-back adds code at every exit, in a profile bound by instruction fetch.
- **Why the share is small.** The game code here is mostly MSVC release code. A slot is typically loaded once per
  function body, for an argument or a spilled value, not reloaded within the same region. The reuse sits in PUSH / POP
  pairs across calls, and calls leave the frame unknown. Hot loops keep their counters in registers: loop-carried
  re-loads beyond one per region entry are ≤ 0.2 %.

Not built: no translator change, no switch. Kept for measurement: `startbench --stack-mix` (also printed with `--mix`) and
the frame-load cases of memop-bench.

## Cheaper transitions (2026-11-12): what a chained transition waits on, nested region calls, linked exits — no-go, off by default

The study of 2026-11-12 put region transitions at ~7-10 % of guest time in play (RotWK: 22 per 1 000 guest instructions;
returns leaving their region 51 %, static exits 20 %, calls through registers 12 %, IAT jumps 12 %). Gate: the
transition's cost halved in chain-bench **and** ≥ 4 % less guest time per instruction in play on RotWK and AotR, nowhere
worse, without more copies of the code. Earlier attempts made transitions *fewer* (predicted transfers, jump tables, region
size: more copies) or moved the same work elsewhere (return-site records, a shared chain stub, fewer parameters); the two
built here change the transition's mechanism: the return becomes a native WASM return, and a static exit's next function
comes from a constant instead of the hash table.

**What a transition waits on** (tools/bench/transition-floor.mjs: two functions of the region signature in two modules
handing control to each other through the shared table, 20 M times; Node 24, EPYC 7402P):

| handover | ns per transition |
|---|---|
| `return_call_indirect` to a constant table index (`bare`) | 2.70 |
| + the chained exit's checks, one hash probe hitting, EIP store, counter, index and block from the entry (`checks`) | 6.33-6.45 |
| budget + hash probe only (`nocheck`) | 5.41 |
| index and block from a per-site cache in memory instead of the hash (`cache`) | 5.41 |
| index and block as constants of the code, the cache only compared (`linked`) | 3.12 |
| index from a stack in memory whose depth is loaded first (`shadow`, a return-address stack) | 7.56 |
| direct `return_call` within one module (`direct`) | 2.44 |
| `call_indirect` + return, 14 values reloaded from memory (`nested`) | 6.4-7.9 |

The checks and the probe are not what costs: a cache in memory instead of the hash costs the same (5.41). What costs is
that the next function's *instance* (rsi, from the table entry) is a load whose address comes from a load: every
region's prologue reloads its memory base from its instance (`movq rdi,[rsi+0x1f]`), the hash entry (or any cache) is
read through that base, its table index selects the table entry that holds the next instance — a loop-carried chain of
dependent loads (3-5 of them, ~4-5 cycles each, plus the hash's multiply when the target is read from the guest stack)
that each transition waits for before the next region can address memory. With the index a constant of the code
(`bare`, `linked`) the chain is the table and the instance (2 loads): half the time. A stack in memory adds a link
(`shadow`): a return-address prediction stack whose region index is *loaded* is slower than the hash. Return-site records
(above, neutral) loaded their index too.

**Nested region calls** (`nestCalls`, translate.js nestCall): a guest CALL leaving its region whose return site the region
holds becomes a WASM `call_indirect` of the callee's region (found by the same hash probe as a chain, with the budget, the
stop address and the address range checked; at most `NEST_MAX` = 32 deep on a per-thread stack of return sites,
`ST.NEST_STACK`); any region's jump exit to the innermost return site (the callee's RET, or any jump there) writes the
state block and *returns* — a native return, predicted, no hash probe, no 16-value tail call into the caller's prologue
and block dispatch — and the caller goes on at its return site with the registers reloaded. Exact whatever comes back: a
return of that address with the stack depth as pushed and nothing dropped since the call (`NEST_EPOCH`, bumped by
`Jit.dropOne`) is a jump to it; anything else (API thunk, time slice, fault, a RET elsewhere — longjmp, SEH, a moved
return address) is returned on as it is down to the dispatcher, the state block already written by the frame that left.
Measured:
- chain-bench `--local-ret` (the callee's entry the only boundary: the call leaves, the RET comes back into the caller's
  region; int): 16.3-17.2 → 20.0-21.3 ns per call/return (+23 %), host instructions 190 → 229 per iteration. The call
  pushes all ten stack arguments (a tail call rewrites only those that changed), the caller's live values are spilled
  around the call, the return writes 14 values to the state block and the caller reloads them: the native return saves
  less than that costs.
- RotWK play (`ab-virtual --perf-phase`, tools/scenarios/rotwk-nest-ab.txt, the same 7 469 M guest instructions in both
  arms, perf over 50 s of play): region code 7.23 → 7.68 host instructions and 4.88 → 5.21 cycles per guest instruction,
  translated code 6.22 → 6.59 c/g (+6 %), guest time 1.752 → 1.888 ns per instruction (+7.8 %), thread CPU per frame
  +6.3 %. Instruction-cache fills per 1 000 guest instructions 229 / 111 → 245 / 119 (L2 / beyond): the per-site
  call-and-reload code is more code. Not run on AotR (the gate failed in chain-bench and on RotWK).

**Linked exits** (`linkExits`, translate.js linkOf / linkExit): a static exit (a jump, a direct call leaving the region,
an exit for space) whose target is in the hash table when the region is translated sets three locals — the target's
table index, its block and the offset of its hash entry, all constants — before the branch to the shared exit tail;
there the chain checks that the entry still holds that target, index and block (and the budget, the stop address) and
tail-calls the *constant* index: the comparisons only decide a predicted branch, the call's target no longer waits on
the hash entry's load. Exact: an entry that changed (the target dropped, translated again elsewhere, its slot reused)
fails the comparison and the exit takes the ordinary probe (tests/jit-tier2.test.js: random programs with small regions
and SMC, and a target rewritten and translated again while its caller, linked to it, stays — a mutation skipping the
comparison fails it with a null-function trap). Measured:
- chain-bench `--pre` (the callee translated first: the call and the loop's jump back linked, the RET not; int): 22.1-22.3
  → 19.9-20.3 ns per iteration of three transitions (−9 %), host instructions 178 → 191 (+13: the site constants and
  the entry's comparisons); with the return site local, 16.3 → 15.7 ns. Not halved: only static exits can be linked,
  and the return (half of the transitions) cannot — its target is a guest stack value, and any index read from memory
  puts the chain back.
- RotWK play (same scenario, one run per arm, load average 25-35 during the batch): guest time 1.981 → 1.955 ns (−1.3 %,
  thread CPU per frame −2.0 %; the same pre-play phases +2 to +5 % — noise at that load), region code 7.28 → 7.46 host
  instructions per guest instruction (+2.5 %: the constants at every static exit site, executed or not on the way to the
  tail), 5.56 → 5.45 cycles (−2 %), fills from L2 per 1 000 guest instructions 236 → 250.
- AotR play (tools/scenarios/aotr-nest-ab.txt, `--child --until-api none`, the same 9 327 M guest instructions in both
  arms, load average ~30): region code 6.66 → 6.80 host instructions (+2.1 %) and 4.51 → 4.83 cycles per guest
  instruction (+7 %), translated code 5.99 → 6.36 c/g, guest time 1.710 → 1.816 ns (+6.2 %), every earlier phase +0.3 to
  +8.5 %; fills from L2 166 → 176 per 1 000 guest instructions. Slower: the gate's play half fails on both games.

Exactness: tests/jit-tier2.test.js runs its random programs of functions (direct calls, calls through slots and import
stubs, tail jumps, recursion deeper than `NEST_MAX`, return addresses moved by the callee, early returns, x87 under a
switched precision, SSE, SMC) with function entries as region boundaries, both options, slices of 5 000 / 97 / 7
(quick depth in `make test`, full depth passed once; a mutation continuing at the return site without the stack-depth
check fails it), plus the rewritten-target case above. The whole suite under
`ORTHROS_JIT_DEFAULTS='{"nestCalls":true,"linkExits":true}'` passes except jit-site-prof's exit counts (a nested call
does not take the counted exit; its state comparison passes).

Why the gate cannot be met this way: half of the transitions are returns, whose target is data; a native return (nested
calls) breaks the load chain but V8's call protocol (all arguments pushed, everything spilled, 14 values back through
memory) costs more than the chain; static exits linked save ~1 ns each, ~20 % of the transitions, ~1-2 % of the guest
time at best, inside the noise of a single play run. Both off by default (`JIT_DEFAULTS.nestCalls`, `linkExits`;
`ORTHROS_JIT_DEFAULTS` / `?jitopts` / `dbg:ORTHROS_JIT_AB` to measure). Tools kept: transition-floor.mjs, chain-bench
`--opts`, `--local-ret`, `--pre`, `--kinds`.

## Guest registers in the state block (2026-11-12, `regsMem`): fewer host instructions, not fewer cycles — no-go, not merged

*Not in the tree:* the code is on branch `worktree-wf_927ea028-9cd-1` (commit 2cae55c), left out of the 2026-11-12 third-round
integration: a no-go whose default path changes too (the 13 register locals copied from the parameters at every region
entry — the same TurboFan code, Liftoff's not measured), whose modes are not exact (review: `block`, `flow` and `carry`
drop the lazy-flag values at a transfer into a block with `flagsOut === 0`; an SMC exit there that rewrites a JMP into
a JCC — `cmp eax, eax ; jmp t` / `t: mov word [X], 0x0274 ; X: cmp ecx, ecx …` — stores stale flags: eax 5 instead of 1;
the V fixpoint of `flow` / `carry` stops after 64 rounds without a convergence check), and whose locals 115..127 fill the
one-byte LEB local indexes that the merged `linkExits` locals need. The measurements below stand.

The study of 2026-11-12 (plan.md) put TurboFan's register shuffling first among the per-instruction costs (~1.0 host
instruction per guest instruction in the hottest regions): every region exit carries the 16 values (8 registers,
EFLAGS, 4 lazy-flag values, budget) as parameters, so all of them are live to every exit and every merge. Gate: ≥ 8 %
less guest time per instruction in play on RotWK and AotR, host instructions per guest instruction clearly down.

**What differs from the earlier attempts** ("Registers, region exits and loops…", "Measured, not kept": the flags in the
state block, packed or reordered parameters, flags rebuilt at exits): those kept the 13 guest values in locals from a
region's entry to all its exits and only changed how they cross the boundary. Here the *inside* of the region changes:
the guest register file lives in the thread's state block at region boundaries, a value is held in a WASM local only
where the code uses it, and an exit stores only what was set on the way to it. The region signature is unchanged
(16 i32, so the table, dispatcher and x87 versions are untouched); its parameters 2..14 are no longer read — the
chained tail calls pass them on unchanged (no move) — and the register file became 13 declared locals (`L_REG`.. =
115..127; in the default mode the prologue copies the parameters into them: the same machine code, chain-bench
22.7 / 31.5 ns and 6.39 G instructions before and after). Modes (`JIT_DEFAULTS.regsMem`, `ORTHROS_JIT_DEFAULTS` /
`dbg:ORTHROS_JIT_AB={"regsMem":"…"}`; library kernels, tier 2 and the shared chain stub stay off with it, they pass
the registers as parameters):
- `region`: the prologue loads the registers the body reads or sets (13 loads made `nop` otherwise, like x87Live), the
  exit tail stores those it sets before chaining. Only removes unused / read-only registers from the live sets.
- `block`: no guest value crosses a block boundary in a local. Each block loads at its start the registers it reads
  before setting them (or sets inside a conditional, so that a later store writes the right value on every path), and
  where the block is left — any exit, a transfer to another block, the fallthrough, an interpreter fallback — stores
  the ones it has set so far (Code.rfTrack records gets / sets with their control depth; the lazy-flag values are not
  stored where no successor reads the flags, as deadFlagsExit already allows).
- `flow`: `block`, and a register a block reads stays in its local across the transfers straight into it (fallthrough,
  forward branches, a loop's back edge to its header — recorded as emitted) when every such predecessor holds it: a
  backward-dataflow fixpoint at the region's end; forward predecessors at no deeper loop level are made to load it
  (the load moves out of the block, onto a path that runs no more often), back edges and loop exits pass only what they
  hold; a dispatcher entry (a chain, a time slice) loads it in the block's trampoline. A loop's registers then stay in
  locals around the loop, written to the state block at each block's end but never read back on the loop's path.
- `carry`: `flow`, and a register set by the blocks before is not stored on a transfer straight into a block that keeps
  it (that block stores it where it is left instead). Translated twice: a first pass finds what each block needs and
  sets and the transfers, the second emits exactly the loads and stores of that plan.
- Tested (not exact, see above): tests/jit-regs-mem.test.js — random programs (partial registers, a shift by CL whose count 0 sets nothing,
  flags read across blocks, an interpreter fallback (DAA) and an SMC exit in the middle of a block, an overlapping
  `rep movsb` into the code's page, PUSHF / POPF, DF, in-region calls, LOOP) against the interpreter, whole and in time
  slices of 1, 3 and 29 instructions (quick pass: `block` and `carry`; full depth: the four modes). Mutations caught: no
  load for a conditional set, the lazy values never stored at a transfer, a carried register not stored at a backward
  transfer's budget exit, a register carried that the block does not keep, no forced load in a predecessor, no
  trampoline load, `region` storing after the chain. The whole JIT suite passes under each mode but the tests that
  assert library kernels or tier 2 run, a code-shape assertion on the lazy flags at a dead-flags exit, and the code cache's
  eviction counts (the regions' sizes differ).

**Measured** (Node 24, EPYC 7402P, `tools/bench/ab-virtual.mjs --perf-phase --perf-label regsplay`, the arms run
together on the same virtual-clock play: tools/scenarios/rotwk-regs-ab.txt — 40 s of play, 5 901 M guest instructions —
and aotr-regs-ab.txt with `--child --until-api none --profile-dir build/saves/aotr-10` — 50 s of play, 9 341 M; the live
server's learned heat; one run per arm per batch, `--no-liftoff`; regions = the `r_*` functions; per guest instruction):

| RotWK arm | guest ns | regions i/g | regions c/g | IPC | uop queue empty | fills L2 / beyond per k guest | translated + runtime + JS c/g | translation (whole run) |
|---|---|---|---|---|---|---|---|---|
| default (batch 1) | 1.890 | 7.30 | 5.28 | 1.38 | 30.8 % | 243 / 111 | 6.69 | 14.2 s |
| `block` | 1.950 (+3.2 %) | 7.31 | 5.54 | 1.32 | 27.2 % | 236 / 103 | 6.91 | 16.6 s |
| default (batch 2) | 1.816 | 7.33 | 5.00 | 1.47 | 32.2 % | 233 / 119 | 6.37 | 14.0 s |
| `flow` | 1.769 (−2.6 %) | 6.84 | 4.89 | 1.40 | 28.4 % | 222 / 110 | 6.29 | 18.0 s |
| default (batch 3) | 1.815 | 7.35 | 5.04 | 1.46 | 30.4 % | 241 / 114 | 6.39 | 14.3 s |
| `carry` | 1.801 (−0.8 %; 5 947 M guest instructions) | 6.67 | 4.90 | 1.36 | 29.7 % | 218 / 113 | 6.30 | 25.2 s |

| AotR arm | guest ns | regions i/g | regions c/g | IPC | uop queue empty | fills L2 / beyond per k guest | process c/g |
|---|---|---|---|---|---|---|---|
| default | 1.716 | 6.71 | 4.49 | 1.49 | 31.3 % | 170 / 88 | 6.53 |
| `carry` | 1.676 (−2.3 %) | 6.22 | 4.42 | 1.41 | 29.6 % | 162 / 87 | 6.37 |

The phases before play were 7-13 % faster with every mode in these `--no-liftoff` runs (RotWK menu `block` −13 %,
`flow` −10 %, `carry` −11 %; AotR profile −13.5 %): TurboFan compiles the regions on the emulator thread there, and a
function whose guest values are short-lived costs its register allocator much less. With V8's own tiers (Liftoff,
TurboFan in the background, as in the browser; no perf), the same scenario, play phase regsplay, default / `carry`:
1.696 / 1.746 ns (+3.0 %) and 1.727 / 1.718 (−0.5 %) in two batches (order of the arms swapped); the phases before
play +6 to +19 % guest time and +16 to +35 % thread CPU per frame for `carry` — its two translation passes in JavaScript
(24-25 s of translation over the run against 13.5-14 s). Default / `flow`, one batch: regsplay 1.737 / 1.738 ns
(+0.1 %), menu +5.7 %.

**Why it does not pay.** Instruction classes in the regions (RotWK regsplay, `perf record` with `node --perf-prof`,
`perf inject -j`, the samples mapped to the disassembly of each region; per guest instruction, default → `carry`):
register-to-register moves 0.95 → 0.55 i/g (0.77 → 0.47 c/g), spill stores 0.58 → 0.20, spill reloads 0.34 → 0.17,
stack parameter loads 0.22 → 0.04, constants into registers 0.09 → 0.06 — the shuffling falls from 2.17 to 1.01 host
instructions (1.72 → 0.78 cycles) per guest instruction, as intended. But the state block traffic that replaces it
costs nearly as much in cycles: stores 0.16 → 0.73 i/g (0.12 → 0.58 c/g), loads 0.02 → 0.43 i/g (0.02 → 0.37 c/g).
Register moves are cheap in cycles (Zen 2 eliminates many at rename) and spills were partly off the hot paths; a store
of every register a block set and a load after a merge are memory operations on the critical path (store-to-load
forwarding where a loop's value goes through the state block, `block`: IPC 1.38 → 1.32, +5 % cycles at equal
instructions). `flow` keeps the loop-carried values in locals (the cycles finally drop) and `carry` also skips the
stores of values the next block keeps — but a value carried dirty must reach every exit after it, which is the
default's problem again: stores stayed at 0.73 per guest instruction (a block's successor rarely reads every register
it set). Chained transitions pay the memory round trip too (chain-bench int call/return 22.7 → 27.0-27.5 ns, x87 31.5 →
33 ns). Net: regions −7 to −9 % host instructions, −2 to −3 % cycles, guest time −1 to −3 % with `--no-liftoff` and
−0.5 / +3 % with V8's tiers, translation work +30-75 % — far from the 8 % gate on either game, so not measured on BFME1,
Vice City or Chrome.

What it says: the shuffling is the price of keeping guest state in registers across a region, and memory is not a
cheaper home for it on this machine; what removes both is fewer values crossing exits *and* fewer exits that need them
— e.g. lazy flags that never reach the exits (the flag values are 4 of the 13 and are stored at every exit leaving the
region with flags live), or an exit that stores a dirty set only on its cold path while the hot path chains with the
values in parameters. Kept for measurement: `regsMem` (`region`, `block`, `flow`, `carry`), off by default;
tools/scenarios/rotwk-regs-ab.txt, aotr-regs-ab.txt.

## The third round of 2026-11-12 combined (registers, stack slots, x87 bounds, transitions, targeted fixes), measured against main

Merged: the targeted fixes (`strSmcOne`, `divFast`, `mmxTopOnce`, `smcGroup` on; `apiInline` off), x87 exponent bounds
(`x87Bounds`, off), the stack-slot opportunity measurement (tools only), nested region calls and linked exits
(`nestCalls`, `linkExits`, off). Left out: guest registers in the state block (`regsMem`, see its section: a no-go whose
modes were not exact and whose default path changed). Every lever keeps its own `JIT_DEFAULTS` key.

Integration fixes (each with a test that fails without it):
- `smcGroup`: the span's first page is read at `(r + lo) & 0x7fffffff`. With a null pointer and a negative field
  (`mov [ebx+4], … ; mov [ebx-4], …`, ebx = 0) r + lo was below 0, the map byte read lay past the SMC map (0), the
  check never fired: the null page was written and the next store trapped imprecisely instead of the leader's precise
  fault. Wrapped, the address lands on the never-mapped pages above USER_END (SMC_NULL) and the cold path decides as
  before (tests/jit-fixes.test.js "null pointer, negative field").
- `smcGroup` and write watches: `Jit.watchWrites` now sets SMC_NEXT on the page before a watched page (as translated
  code does); unwatching clears it unless the page holds code, dropping a page's code keeps it while the page is
  watched. A group whose span started on the page before a watch missed it.
- `linkExits`: `linkOf` never links a static exit to address 0 (or the thunks and above, emitChain's test): 0 is the
  hash table's empty key, and an empty slot keeps a dropped entry's index and block — the exit ran another region
  instead of faulting (tests/jit-tier2.test.js "a static exit to address 0 faults").
- tools/bench/ab-virtual.mjs `--variant-tree NAME=<dir>`: that arm runs another checkout's startbench (main exported
  with `git archive`), so the combined build and main play the same virtual-clock work at the same time.

Exactness: `make test` green; the JIT, CPU-JIT and x87 interpreter suites at full depth (`ORTHROS_TEST_FULL=1`) with every
kept switch on (`x87Bounds`, `nestCalls`, `linkExits`, `apiInline` plus the four fixes): 587 of 588, the one failure
jit-site-prof's exit counts under `nestCalls` (expected, see "Cheaper transitions"; its state comparison passes).

**Node** (`ab-virtual --virtual --variant-tree main=…`, V8's own tiers, no perf; tools/scenarios/fixes-*.txt, the live
server's learned heat; three arms run together — main, combined, combined + `x87Bounds` — 3 batches, the arms' launch order
rotated; identical guest work in every arm (the phases' guest instruction counts equal); load average 4-9). Mean of 3,
per-batch values in brackets:

| game, phase | guest ns/insn main → combined | guest ms/frame | thread CPU ms/frame |
|---|---|---|---|
| RotWK 2.02 play (`fixplay`, 6 131 M) | 1.827 [1.847 1.820 1.814] → 1.826 [1.808 1.854 1.815] (−0.1 %) | 8.94 → 8.93 | 10.86 → 10.93 (+0.6 %) |
| RotWK map load (`load`, 2 440 M) | 0.864 → 0.791 (−8.4 %) | 175.6 → 160.9 | 263.8 → 251.8 (−4.6 %) |
| AotR 10 play (`fixplay`, 7 443 M) | 1.560 [1.533 1.559 1.588] → 1.543 [1.550 1.524 1.557] (−1.1 %) | 11.07 → 10.95 | 13.40 → 13.26 (−1.0 %) |
| AotR first play seconds (`play`, 1 923 M) | 1.773 → 1.719 (−3.1 %) | 16.08 → 15.59 | 22.15 → 21.86 (−1.3 %) |
| AotR load / loading screen | 0.685 → 0.664 (−3.1 %) / 0.962 → 0.928 (−3.5 %) | | −3.7 % / −1.8 % |
| AotR menu | 2.217 → 2.058 (−7.1 %) | 4.64 → 4.31 | 7.53 → 7.15 (−5.0 %) |
| BFME 1.08 play (`fixplay`, 6 305 M) | 1.226 [1.233 1.232 1.212] → 1.217 [1.208 1.228 1.215] (−0.7 %) | 12.63 → 12.54 | 14.96 → 14.93 (−0.2 %) |
| BFME 1.08 map load (`load`, 127 241 M) | 1.370 [1.371 1.364 1.374] → 1.341 [1.339 1.340 1.345] (−2.1 %) | 9.09 → 8.90 | 10.54 → 10.37; **load 202.2 s → 198.8 s (−1.6 %)** |
| Vice City drive (7 549 M) | 1.379 [1.389 1.332 1.416] → 1.339 [1.348 1.332 1.339] (−2.9 %) | 7.28 → 7.07 | 8.78 → 8.61 (−1.9 %) |
| Vice City load / cutscene | 1.176 → 1.142 (−2.9 %) / 1.909 → 1.851 (−3.1 %) | | −0.3 % / −1.9 % |

Short phases within their spread both ways (RotWK menu +1.2 %, its first play seconds −1.3 %, BFME1's first 1 038 M
of play +2.4 % with batches 1.206-1.307). The play gains are smaller than the targeted-fixes section's −3 to −5 %:
that was `--no-liftoff` (TurboFan only) under perf; here V8 tiers as the browser does. The third arm is an A/A control
for RotWK (no 24-bit truncating code there: the same code as combined): it differs from combined by −1.4 % in play,
the noise floor of these means.

`x87Bounds` against combined (same batches): BFME1 map load 1.341 → 1.338 ns (−0.2 %, 198.8 → 198.5 s), BFME1 play
−0.5 %, AotR play 0.0 %, Vice City drive +2.0 %, RotWK −1.4 % (A/A). The branch's −2.1 % at identical work
(`--no-liftoff`, perf) does not show with V8's tiers: **stays off**.

Interaction of the four fixes (`--perf-phase`, `--no-liftoff`, host instructions per guest instruction of the regions,
two batches per game: off / all / `smcGroup` alone, then the three others alone / all / off):

| phase | off | all | `smcGroup` alone | the three others alone | sum of the two deltas |
|---|---|---|---|---|---|
| RotWK play (6 131 M) | 7.21 / 7.22 | 6.98 / 7.07 | 7.04 | 7.18 | −0.21 (all: −0.15 to −0.23) |
| BFME1 map load (127 241 M) | 6.27 / 6.28 | 6.03 / 6.05 | 6.09 | 6.23 | −0.23 (all: −0.23) |

Additive: the levers touch disjoint instruction patterns (`smcGroup` skips string stores, which `strSmcOne` handles;
`divFast` changes no store, `mmxTopOnce` only the x87 TOP / tag code), so each is kept on its own merits. Process instructions per guest
instruction all on: RotWK play 14.94 → 14.32 (−4.1 %), BFME1 load 10.78 → 10.37 (−3.8 %).

**Chrome** (headless shell through `tools/with-browser-slot.sh`, `--gl-discard`, fresh profile, each run its own copy of
the live learn directory without snapshots, each tree's own harness server; one browser at a time; load average 2-13):

| game, phase | fps main → combined | worker CPU ms/frame | guest ms/frame | guest ns/insn |
|---|---|---|---|---|
| RotWK `rotwk-quick` play (120 s) | 28.4 → 26.5 | 17.26 → 16.57 (−4.0 %) | 16.8 → 16.4 | 2.382 → 2.188 (−8.1 %) |
| RotWK menu / map load / loading screen | 28.7 → 28.8 / 2.0 → 3.2 / 6.7 → 10.8 | 10.52 → 10.41 / 281 → 178 / 71.1 → 50.0 | 8.5 → 8.6 / 185 → 121 / 56 → 40 | 2.43 → 2.50 / 0.89 → 1.00 / 1.28 → 1.16 |
| AotR (fixes-aotr-play) menu / profile / map load, main → combined runs 1, 2 | 27.5 → 28.1, 27.8 / 29.1 → 29.1, 29.0 / 2.5 → 2.1, 2.3 | 11.23 → 11.78, 11.88 / 13.71 → 13.39, 13.15 / 353 → 289, 229 | | 2.73 → 2.67, 2.62 / 2.42 → 2.44, 2.42 / 0.72 → 0.66, 0.66 |

(RotWK, one run each: fewer frames at less CPU per frame — the fps difference is the frames' pacing, not the emulator
thread. AotR play is not comparable: both combined runs met the scenario's 400-draw anchor flake already seen on main
and combined in the earlier rounds (explained 2026-11-12: the start position, random until then — the left marker of Harlindon renders fewer than 400 draws per frame for minutes; the scenarios now pick the right one, docs/aotr-play.md) — after the load the game rendered ~375 draws per frame for 6-7 minutes at 26 fps
before the anchor, then play started in another game state at 10-15 fps; main's run reached the anchor 16 s after the
loading screen: 24.9 fps, 21.0 ms worker CPU per frame, 2.54 ns per instruction. In Node, the same scenario ran
exactly main's guest instruction counts in every phase of all three combined batches: the guest takes the same path.)

Defaults: `strSmcOne`, `divFast`, `mmxTopOnce`, `smcGroup` on; `x87Bounds`, `nestCalls`, `linkExits`, `apiInline` off;
`regsMem` not merged. Deploy: the translated-code cache keys on JIT_DEFAULTS and the translator's source, so every
player translates once again after the update; no server, manifest or data change.

## Measured, not kept

- Region parameters reordered so that the budget rides in a register and the state block's address (the same for
  every region of a thread) on the stack (2026-10-22: block, budget, the 8 registers, state, EFLAGS, the lazy values):
  chain-bench host instructions 25.56 G vs 25.57 G, times equal — the budget's stack store saved, the state block's
  address reloaded where the exits use it (the stop-address test of every chained exit).

- Branch-free x87 condition codes (2026-10-21: compareCC / compareEflags as `(a<b) << 8 | (a==b) << 14 | unordered *
  0x4500` instead of nested ifs): x87loop-bench compares with random signs, one run under load 23-36: fcomp + test ah
  +8.9 %, fcomp + sahf +32 %, fucompp -21.6 %, fcom + fchs + fstp +3.5 % — the nested compares predict as well as the
  guest's own Jcc; not kept.

- Raising ZE / OE for an infinite result of x87 arithmetic at 53 / 64-bit precision in translated code (X87.arith
  does): the test on the arithmetic hot path cost +15 % on the 53-bit sums-of-squares kernel; left unraised by the JIT
  (documented in translate-x87.js).
- Directed rounding up / down on the vector mask as toward zero used to: the sign-dependent step is cheaper as an
  integer add on the bits (kept that way).
- x87 arithmetic cold path (2026-10-06, tools/bench/x87-size.mjs and host instructions per iteration of x87loop-bench's
  `xform` under `perf record`, branch hints on): the inline zero test of a float result on its bit pattern (`x << 1 ==
  0`) instead of float compares — the result's bits, shared with the hot path's exponent test, then stay live past it:
  221 host instructions per iteration against 207; no inline zero test at all (exact zeros through the kernel too):
  203, but every product by zero would be a call. Kept: float compares (207; the earlier code 215).
- Chained exits each with its own chain code (`siteChain`: the hash probe and tail call at every exit site, the probe
  addresses constants for static targets) instead of one shared exit: RotWK +15 %, BFME2 +52 % (Node in-session) —
  every tail-call site pins all sixteen values to the call's argument places, and the code grows.
- Region parameters packed so that none goes through the stack (5 i32 + 6 f64 holding two i32 each, V8's x64 argument
  registers): +4 % in RotWK play, and slower in a calling-convention microbenchmark (the packing costs more than the
  stack arguments it saves).
- 11 i32 region parameters (block, state, 8 registers, budget), EFLAGS and the 4 lazy-flag values in the state block
  (loaded by every region's prologue, stored before every chained tail call) — 2026-10-06, stopped at the gate:
  `tools/bench/chain-bench.mjs` (Node 24 / V8 13.6, alternated with main) int 22.7 → 26.6 ns, x87 36.2 → 43.0 ns per
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
