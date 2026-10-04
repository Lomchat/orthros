# The null page: guest accesses near address 0 fault as on Windows

`src/cpu/nullpage.js` (the rule), `src/cpu/interp.js` (`checkNull`, `strAddr`), `src/cpu/jit/translate.js`
(`planNullChecks`, `Emitter.nullCheck`, `NC_STORE_SMC` / `NC_RMW_SMC`), `src/cpu/jit/jit.js` (`run`: the null store exit).

## Semantics

Windows never maps the first 64 KiB of a process (nor the last 64 KiB below 2 GiB, nor the kernel's half above): a read
or a write there raises `EXCEPTION_ACCESS_VIOLATION` at the instruction, nothing of it done, with
`ExceptionInformation = [0 read / 1 write, address]`, which the program's SEH may handle (crash handlers, `__try`
probes). Orthros' guest memory is one flat WebAssembly memory where those bytes exist: before this change a field of a
null pointer read zeros and a store through one was accepted — a corrupted structure then failed much later, far from
its cause (BFME1's allocator, docs/thread-scheduling.md).

Both executors apply the same rule (`nullChecks`), before the instruction:

- every explicit memory operand that is accessed (LEA, the hint NOPs, PREFETCH: none; INS/OUTS fault with #GP first),
  sources before the destination (MOVS reads first: a null source is reported as a read);
- not the operands addressed by ESP alone (the stack: PUSH/POP/CALL/RET are implicit anyway) nor FS/GS-relative ones
  (the TEB);
- a string instruction with a REP prefix and a zero count accesses nothing; the interpreter checks every element (a
  REP STOS walking down into the null page faults at that element, ECX / EDI as they are then);
- the bit-string forms of BTS/BTR/BTC (memory, register offset) and XLAT compute their own address: their handlers check
  it;
- the faulting range is `[0, 0x10000)` and `[0x7fff0000, 4 GiB)` (`unmapped`): `[ecx-4]` with ECX null faults at
  0xfffffffc instead of trapping in WebAssembly.

The exception record is exact (code, address, read/write, EIP at the instruction). Two documented inexactnesses, both
in the JIT and only for the CONTEXT: the arithmetic flags of a read-modify-write caught after its store (below) are the
instruction's own, and dead flags (never read before being written again) may be an older instruction's — as for every
fault in translated code.

## What faults: writes by default, reads on request

`nullPageMode()`: `'writes'` (the default), `true` (reads too, `?dbg=ORTHROS_NULL_READS=1`, the Vm option `nullPage`),
`false` (the old behaviour, `?dbg=ORTHROS_NULL_PAGE_OPEN=1`). With `'writes'`, a read of the null page still returns
zeros (the pages stay zero: nothing can store there) and a read past 2 GiB still traps.

Why: writes are what corrupt; they are checked at no cost on the JIT's hot path (below). Checking every read costs a
compare and a branch per load that is not proven safe. Measured in Node (`tools/startbench.mjs` with the menu-to-skirmish
scenarios, from the warm profiles, `perf stat -e instructions:u` of the whole process — the compilers' threads included
—, the variants run side by side in pairs):

| variant (RotWK, first 45 G guest instructions) | host instructions | perf record |
|---|---|---|
| no checks | 802 / 820 / 834 / 821 G | JIT code 54.1 %, compiler threads 26.5 % |
| reads and writes, a check per access group | 904 / 948 / 946 G (+13 %) | JIT code +7.6 %, compilation +28 % |

| variant (final code) | RotWK, 60 G instructions | BFME1, 50 G instructions | |
|---|---|---|---|
| no checks | 1008 / 1030 G | 717.0 / 715.7 G | |
| writes only (the default) | 1019 / 1053 G (+1.1 / +2.3 %) | 727.1 / 726.9 G (+1.4 / +1.6 %) | translation time +5 % |

Split by `perf record -e instructions:u` (RotWK, 60 G, one pair): the translated code itself +0.6 % (322.8 K against
320.8 K samples of 2 M instructions), the compiler threads +3.1 %, the JavaScript thread +2.9 %, the whole +1.3 %.
Guest time per instruction in RotWK's play (the frame accounting's `guest` per instruction, 30 s phases) is the same
within the spread: 3.57 / 3.66 / 3.51 ns with the checks, 3.57 / 3.66 / 3.74 without; in-session A/B (`dbg:ORTHROS_JIT_AB=
{"nullPage":false}`, tools/scenarios/*-nullpage-ab.txt, three alternations, both orders) gave +1 to +6 % per session
for the checks, but variants with half of the added code removed gave the same +2 % and −3 to −4 % — the phases of one
session differ by ±5 %, more than what is measured. BFME1 in Node (`tools/scenarios/bfme-phases.txt` to a skirmish, four runs side by side, `ORTHROS_NULL_PAGE_OPEN=1` for
the open page; 2026-10-04 evening, main merged): play (160 s, 6 140 frames) 3.153 / 3.163 ns per guest instruction with
the checks, 3.131 / 3.174 without; the loading screen (40 G instructions) 1.529 / 1.447 against 1.437 / 1.445. What is left of the cost in 'writes' mode is
compilation (the explicit checks of string stores, two stores in the SMC cold path of every plain store); the
translated code runs as fast. The cost of reads is mostly the code they add, not the compare: every check is a cold exit
(the region's state written back), and TurboFan compiles the larger functions more slowly.

## How the JIT checks

- **Plain stores** (`NC_STORE_SMC`: MOV, SETcc, the SSE/MMX moves, the x87 stores, STMXCSR, FNSTCW, FNSTSW) and, in
  `'writes'` mode, **read-modify-writes** (`NC_RMW_SMC`: ALU, shifts, BTS/BTR/BTC) need no check before them: their
  self-modifying-code check after the store already reads the page's byte in the SMC map, where the unmapped pages
  carry `SMC_NULL`. A store there takes the existing SMC exit, with the instruction's start in `ST.EXIT_PC`; `Jit.run`
  clears the bytes written (and undoes the pop of FSTP / FISTP / FISTTP: the register is still in its slot) and lets the
  interpreter execute the instruction again, which raises the fault. Zero instructions on the hot path, two stores in
  an existing cold path.
- **Other writes** (POP to memory, string stores, XCHG/XADD/CMPXCHG, FXSAVE, FNSAVE...) are checked before the
  instruction: one range test
  (`(addr - 0x10000) >=u 0x7ffe0000 - span`), shared by every access through the same base and index registers
  (unchanged) within 64 KiB of each other in a block (`planNullChecks`); when it fails the region is left before the
  instruction (`stepExit`) and the interpreter executes it, faulting or not.
- With reads checked, an if-converted arm's load in the null page sets `L_SPECF` (the load itself reads address 0); after
  the arms the region restores the state before them and leaves before the JCC, whose arm then runs as a block of its
  own; a float compare is not fused with a following SETcc/CMOVcc that may leave before itself.

Not exact, as before these checks: a plain store or read-modify-write to an address past 2 GiB (`[null - 4]`, a register
holding garbage) traps in WebAssembly before its check (an imprecise fault: the process ends); a plain store straddling
0x10000 from below keeps its bytes from 0x10000 on.

## Tests

`tests/null-page.test.js`: 45 instruction forms in both modes, each against the interpreter (EIP, address, read/write,
registers, memory, the null page left zero), sliced and not, with if-conversion everywhere; 300 random programs per mode
(null, small and valid pointers through loads, stores, read-modify-writes, string instructions, null tests and their
mirrors in if-converted arms, loops) in time slices of 1 to 10^6 instructions; mutations of the JIT (no check, no arm
flag) make them fail. `tools/pe/seh.c`: the SEH record of null-page reads and writes, a call through a null vtable, REP
MOVSD from null, `[null - 4]`, 300 times (the JIT's translations included), in both executors.
