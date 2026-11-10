// Guest memory of the objects an API allocates on the program's behalf: Direct3D surfaces, volumes, vertex and index
// buffers, D3DX buffers (docs/address-space.md).
//
// Windows' Direct3D runtime keeps the system-memory copy of a resource in its own heap: a texture's small mip levels, a
// 1x1 surface or a 2 KB vertex buffer take a few bytes of address space each. One VMem reservation per resource takes a
// 64 KiB allocation granule instead — a 1024x1024 texture's eleven levels reserved 2.4 MiB for 1.4 MiB of texels, a
// small vertex buffer 64 KiB. A game loading thousands of them (SAGE games: every unit, building and effect) then ran
// out of the 2 GiB guest address space after tens of minutes of play where Windows had room to spare, and the first
// lock that found no memory handed out pBits = 0 (Age of the Ring, 2026-11-10: a 1024x1024 texture's texels written
// from address 0 up over the process heap). Here allocations under RES_HEAP_MAX share one guest heap (heap.js, chunks
// of 1 MiB); larger ones keep a reservation of their own (their sizes are multiples of 64 KiB in practice: no waste).
//
// Every address is 16-byte aligned, as Direct3D's are (SSE code writes locked texels and vertices with MOVAPS).
import { Heap } from './heap.js';
import { PAGE_READWRITE } from './vmem.js';

/** allocations of fewer bytes than this share the resource heap */
export const RES_HEAP_MAX = 0x10000;
const ALIGN = 16;

/**
 * `bytes` (at least 16) of guest memory, 16-byte aligned, not zeroed; 0 when the address space has no room.
 * @param {import('./process.js').Process} proc
 * @param {number} bytes
 * @param {string} tag the reservation's tag (diagnostics: VMem.summary) when it gets one of its own
 */
export function resAlloc(proc, bytes, tag) {
  bytes = Math.max(16, bytes >>> 0);
  if (bytes < RES_HEAP_MAX) {
    const h = (proc.resHeap ??= new Heap(proc, { tag: 'resources' }));
    const raw = h.alloc(bytes + ALIGN - 8); // (heap blocks are 8-aligned)
    if (raw) {
      const a = (raw + ALIGN - 1) & -ALIGN;
      (proc.resBlocks ??= new Map()).set(a, raw);
      return a >>> 0;
    }
    // (no heap chunk to be had: a reservation of its own, if a smaller hole is left)
  }
  return proc.vmem.alloc(bytes, PAGE_READWRITE, tag) >>> 0;
}

/**
 * (diagnostics, `--log vmem`) the blocks in the resource heap: their count, their bytes, and the address space one
 * reservation each would take (the 64 KiB granules: what they took before the heap)
 * @param {import('./process.js').Process} proc
 */
export function resHeapStats(proc) {
  let n = 0, bytes = 0, granules = 0;
  for (const raw of proc.resBlocks?.values() ?? []) { const s = proc.resHeap.size(raw); n++; bytes += s; granules += Math.ceil(s / 0x10000); }
  return `resource heap: ${n} blocks, ${(bytes / 2 ** 20).toFixed(1)} MiB in ${((proc.resHeap?.total ?? 0) / 2 ** 20).toFixed(0)} MiB of chunks (one reservation each: ${(granules / 16).toFixed(0)} MiB)`;
}

/**
 * Release memory from resAlloc.
 * @param {import('./process.js').Process} proc
 * @param {number} addr
 */
export function resFree(proc, addr) {
  addr >>>= 0;
  const raw = proc.resBlocks?.get(addr);
  if (raw !== undefined) { proc.resBlocks.delete(addr); proc.resHeap.free_(raw); return; }
  proc.vmem.release(addr);
}

/**
 * The error a resource's memory that could not be allocated raises where no failure can be returned to the program
 * (a copy, a fill): the process stops with the address space described, instead of the bytes going to address 0.
 * @param {import('./process.js').Process} proc
 */
export function outOfAddressSpace(proc, what, bytes) {
  return new OutOfAddressSpace(`out of guest address space: ${what} of ${bytes} bytes (${proc.vmem.summary?.() ?? '?'})`);
}
export class OutOfAddressSpace extends Error {}
