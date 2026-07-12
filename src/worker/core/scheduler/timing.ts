/**
 * Deterministic scheduler/virtual-time constants.
 *
 * The emulator defines 100k retired guest instructions as one virtual
 * millisecond. This is intentionally a virtual-time contract, not a measured
 * wall-clock rate.
 */
export const TARGET_INSN_PER_MS = 100_000;
export const TARGET_MIPS_PER_US = TARGET_INSN_PER_MS / 1000;
