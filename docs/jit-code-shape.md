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
  per guest instruction kind (tools/jit-mix.mjs). `--jit-profile`: transitions by kind (chains, dispatches, returns).
- **Kernels** — `tools/shape-bench.mjs --opts <json> --vs <json>`: small x86 kernels written for it (binary search, abs,
  array read-modify-write, calls, predictable branches, x87 at 24/53/64-bit precision, a hot loop next to cold code),
  ns per guest instruction of two variants alternated.
- **V8 tiers** — `tools/tierup-bench.mjs`: a small region entered over and over for short runs, its speed as the entries
  accumulate (Liftoff until TurboFan; Liftoff charges the tiering budget by code position).

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
  have run, `VisitSlots`, set at the block's entry; `Jit.harvestVisits` every 10 s in the page worker), learned per
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

## Measured, not kept

- Heat by time windows (visit flags re-armed every 10 s; a successor cold when it ran in fewer than a quarter of the
  windows its branch ran in): worse than "never ran" (RotWK Node in-session: +4 % vs −7 %, and translation storms).
- Weak topological block order (`layout: 'wto'`, Bourdoncle): Node in-session, RotWK +6 % with heat, +15 % without;
  BFME2 −3 % with heat, +2.5 % without.
- 96-block regions with heat: −3 % in one RotWK run, within the spread, more translation work.

- Dead bytes at a region's start (`tierPad`): small regions tier up to TurboFan ~4x sooner in tierup-bench, nothing in
  play (Liftoff is <1 % of the region samples in Node play).
- Lazy flags rebuilt at exits from the registers the flag instruction read (so that the lazy values die at their
  branch instead of living to every exit): exact (randomized test against the interpreter), +1 to +2 % in play.
- Region size 24 blocks (+6 to +11 % in the browser), 96 blocks (−2.5 % in Node play alone, neutral with the layout,
  slower first launch), nested loops on top of the layout (neutral), `L_BLK` set before back edges (+3 %).
- Dropping the lazy flags at exits entirely (an inexact experiment to bound the previous one): the games misbehave
  within seconds — exits do resume where flags are read.
