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
compare and a branch per load that is not proven safe, which was measured (RotWK, Node, 45 G guest instructions from
the warm profile into a skirmish, `perf stat -e instructions:u` of the whole process, alternated runs):

| variant | host instructions | of which (perf record) |
|---|---|---|
| no checks | 802 / 820 / 834 / 821 G | JIT code 54.1 %, compiler threads 26.5 % |
| reads and writes, a check per access group | 904 / 948 / 946 G (+13 %) | JIT code +7.6 %, compilation +28 % |
| writes only | see the measurements section | |

Most of the cost of reads is not the compare but the code it adds: every check is a cold exit (the region's state
written back), and TurboFan compiles the larger functions more slowly (translation time +12 %).

## How the JIT checks

- **Plain stores** (`NC_STORE_SMC`: MOV, SETcc, the SSE/MMX moves, STMXCSR, FNSTCW) and, in `'writes'` mode,
  **read-modify-writes** (`NC_RMW_SMC`: ALU, shifts, BTS/BTR/BTC) at a small non-negative displacement need no check
  before them: their self-modifying-code check after the store already reads the page's byte in the SMC map, where the
  unmapped pages carry `SMC_NULL`. A store there takes the existing SMC exit, with the instruction's start in
  `ST.EXIT_PC`; `Jit.run` clears the bytes written and lets the interpreter execute the instruction again, which raises
  the fault. Zero instructions on the hot path, a few bytes in an existing cold path.
- **Other writes** (POP to memory, string stores, XCHG/XADD/CMPXCHG, x87 stores that pop, FXSAVE...) and stores at
  negative or large displacements are checked before the instruction: one range test
  (`(addr - 0x10000) >=u 0x7ffe0000 - span`), shared by every access through the same base and index registers
  (unchanged) within 64 KiB of each other in a block (`planNullChecks`); when it fails the region is left before the
  instruction (`stepExit`) and the interpreter executes it, faulting or not.
- With reads checked, an if-converted arm's load in the null page sets `L_SPECF` (the load itself reads address 0); after
  the arms the region restores the state before them and leaves before the JCC, whose arm then runs as a block of its
  own; a float compare is not fused with a following SETcc/CMOVcc that may leave before itself.

Not exact (garbage pointers, as before): a plain store through a register holding an address past 2 GiB traps in
WebAssembly (the process ends); a plain store straddling 0x10000 from below keeps its bytes from 0x10000 on.

## Tests

`tests/null-page.test.js`: 45 instruction forms in both modes, each against the interpreter (EIP, address, read/write,
registers, memory, the null page left zero), sliced and not, with if-conversion everywhere; 300 random programs per mode
(null, small and valid pointers through loads, stores, read-modify-writes, string instructions, null tests and their
mirrors in if-converted arms, loops) in time slices of 1 to 10^6 instructions; mutations of the JIT (no check, no arm
flag) make them fail. `tools/pe/seh.c`: the SEH record of null-page reads and writes, a call through a null vtable, REP
MOVSD from null, `[null - 4]`, 300 times (the JIT's translations included), in both executors.
