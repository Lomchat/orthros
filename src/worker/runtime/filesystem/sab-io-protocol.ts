// sab-io-protocol.ts
//
// Shared-memory protocol between the GUEST worker (v86) and a dedicated I/O
// worker, used to serve the guest's SYNCHRONOUS file reads without blocking the
// guest thread on a network round-trip.
//
// WHY
// ---
// The guest's ReadFile/getc is synchronous, and our sync fast-path needs a
// synchronous ZipSource.readRangeSync. Backing that with a synchronous XHR on
// the guest worker freezes the whole guest for the full network round-trip AND
// forbids any overlap: while the worker is parked inside xhr.send() no async
// callback (prefetch, readahead) can run. So the guest is stuck doing hundreds
// of serial, latency-bound round-trips — measured ~260 for a Discworld Noir
// boot, ~44 ms each, ~11.5 s wall, at 1/10th of disk bandwidth.
//
// This protocol decouples the sync FACADE from the async I/O: the guest writes a
// request into a SharedArrayBuffer, wakes the I/O worker, and parks cheaply on
// Atomics.wait (NOT holding a network op). The I/O worker — whose event loop is
// never blocked — fetches in parallel, prefetches ahead, fills the SAB, and
// Atomics.notify()s the guest. Cold reads the I/O worker already prefetched
// return in ~a SAB round-trip; the guest's own block cache still serves hot
// reads with no crossing at all.
//
// SAB LAYOUT (single outstanding request — the guest is single-threaded):
//   [0, 32)            control    Int32Array(8)  — Atomics futex + counters
//   [32, 64)           meta       Float64Array(4) — 64-bit request offset/len
//   [64, 64+DATA)      data       Uint8Array     — response payload arena

/** Max payload per request. The guest's largest single read is its block-cache
 *  readahead run (32 × 256 KiB = 8 MiB); 16 MiB leaves headroom (central
 *  directory reads, future larger runs). Requests past this are chunked. */
export const DATA_BYTES = 16 * 1024 * 1024;

export const CTL_BYTES = 32;
export const META_BYTES = 32;
export const META_OFFSET_BYTES = CTL_BYTES;          // 32
export const DATA_OFFSET_BYTES = CTL_BYTES + META_BYTES; // 64
export const SAB_TOTAL_BYTES = DATA_OFFSET_BYTES + DATA_BYTES;

// ---- control Int32Array indices (Atomics) ----
/** Futex word the guest waits on; the I/O worker stores a terminal state + notifies. */
export const CTL_STATE = 0;
/** Response byte count (≤ DATA_BYTES), written before STATE is published. */
export const CTL_RESP_LEN = 1;
/** Non-zero on a failed read (network error / short read). */
export const CTL_ERRNO = 2;
// Diagnostic counters the I/O worker publishes so the guest can read the
// getc↔streaming interplay synchronously (no extra message round-trip).
/** Cold network range fetches driven by a guest request (a real miss). */
export const CTL_IO_NET_FETCHES = 3;
/** Speculative prefetch fetches issued ahead of the guest cursor. */
export const CTL_IO_PREFETCHES = 4;
/** Requests served fully from the I/O worker's cache (prefetch hit — no cold fetch). */
export const CTL_IO_CACHE_SERVES = 5;
/** Total requests the I/O worker has answered. */
export const CTL_REQS = 6;
export const CTL_WORDS = 8;

// ---- meta Float64Array indices (64-bit safe for >2 GB bundles) ----
export const META_REQ_OFF = 0;
export const META_REQ_LEN = 1;
export const META_WORDS = 4;

// ---- STATE values ----
export const ST_IDLE = 0;
export const ST_REQ = 1;
export const ST_DONE = 2;
export const ST_ERR = 3;

/** Guest Atomics.wait slice (ms). A missed notify degrades to a thrown timeout
 *  (caller can fall back) instead of a permanent hang. Generous: a genuine cold
 *  fetch over a slow link can take seconds. */
export const WAIT_TIMEOUT_MS = 30_000;

export interface IoWorkerStats {
    netFetches: number;
    prefetches: number;
    cacheServes: number;
    requests: number;
}
