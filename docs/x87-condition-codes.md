# x87 condition codes: what the interpreter and the JIT model

The interpreter (`src/cpu/interp-x87.js`) is the reference for the JIT (`src/cpu/jit/translate-x87.js`); the reference
for the interpreter is the hardware. Where the SDM leaves a condition code undefined, or where the measured CPU differs
from the SDM, both follow the measurement.

## Measuring

`node tools/x87cc-probe.mjs [--only fcomi,fsin] [--scratch DIR]` builds `tools/oracle/x87cc.c` with clang-18 and runs
every case of `tools/x87cc-cases.mjs` on the host FPU, in the interpreter and in the JIT (status word in a local and
not): one x87 instruction executed from known condition codes (none, C1, C3 C2 C0, all four, C0, C3, C2 — set through
FNSTENV / OR / FLDENV) on seven stacks (negative, positive, -0, +inf, 2^64, a QNaN on top, a zero divisor), then
FNSTSW AX. It prints the cases where the interpreter's C0 / C2 / C3, then C1, differ from the hardware, and those where
the JIT's status word differs from the interpreter's. `--table` prints the hardware values; `tests/x87-cc-hw.test.js`
holds the table measured on the reference CPU (AMD EPYC 7402P, Zen 2) and checks both executors against it.

## Facts measured (reference CPU)

| instruction | C0 C2 C3 | C1 | SDM |
|---|---|---|---|
| FCOMI / FUCOMI / FCOMIP / FUCOMIP | unchanged | **unchanged** | C1 cleared |
| FCMOVcc | unchanged | **unchanged** | C1: 0 on underflow, C0 C2 C3 undefined |
| FFREE | unchanged | **cleared** | all undefined |
| FSIN / FCOS / FSINCOS / FPTAN | C2 cleared (set when \|x\| >= 2^63), **C0 C3 unchanged**, every path (NaN, inf included) | cleared (rounding direction when inexact) | C0 C3 undefined |
| FPREM / FPREM1, NaN or invalid operand | C2 cleared, **C0 C3 unchanged** | cleared | undefined |
| FPREM / FPREM1, partial remainder | C2 = 1, **C0 C3 cleared** | **cleared** | C0 C1 C3 undefined |
| FCOM / FUCOM / FICOM / FTST / FXAM / FXCH / loads / stores / arithmetic | as documented | cleared | as measured |

Until 2026-10-14 the interpreter followed the SDM for FCOMI (C1 cleared) and cleared C0..C3 in the trig and FPREM special
paths, while the JIT left C1 after FCOMI: the JIT and the interpreter disagreed (FXAM -> FUCOMI -> FNSTSW: 0x1400 vs
0x1600, found by `tests/jit-x87-sw-local.test.js` seeds 1034 / 1646 / 1921). Both now follow the measurement.

## Not modelled

- C1 as the rounding direction of an inexact result (FIST, FRNDINT, the arithmetic, the transcendentals): always 0.
- The JIT does not raise PE for an inexact FIST / FISTP / FISTTP, nor ZE / OE at 53 / 64-bit precision (the interpreter
  does). It does raise IE for an out-of-range or NaN FIST (the stored integer indefinite), as the interpreter.
- Exception flags against the hardware are the subject of the oracle's `verify_trans` suites (and `verify_trans_known`
  for the known differences, e.g. FYL2XP1 outside its domain), not of this probe.

## In the JIT

C1 is cleared once per block by the first instruction that clears it (`C1_CLEARING` in `translate-x87.js`, then
`E.c1Clear`), again after FXAM or an interpreter fallback; FCOMI-family instructions and FCMOVcc are not in the list
(they keep C1), FFREE is. The trig handlers clear C2 only (`clearC2`): C1 comes from that prologue, C0 and C3 stay.
