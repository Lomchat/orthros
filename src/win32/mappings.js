// The paging file's mappings (CreateFileMapping(INVALID_HANDLE_VALUE): shared memory) — their bytes and their views
// (kernel32-file.js MapViewOfFile / UnmapViewOfFile, core/procs.js across processes; docs/processes.md).
//
// A mapping keeps its bytes in `data` (grown to the end of the furthest view: a large section viewed through small
// windows costs what its views cover). A view is a copy in its process's guest memory, `{ vm, base, off, n, ver }`. One
// process at a time — the mapping's `holder` — may have views ahead of `data`: the process that runs, the only one that
// can write. Before another process's guest code touches the mapping (its turn, a view it maps or unmaps) the holder's
// bytes go into `data` (release), and that process's views are brought up to date (acquire) — only those `data` changed
// since they were filled (`ver`, the mapping's version, moved by every change). A process that only waits, or a mapping
// nobody wrote, costs nothing at a switch.
//
// The holder's views go into `data` as a difference: a byte is taken from a view only where the view differs from what
// `data` held before (`prev`), so a stale view — a second view of the same bytes in one process, which does not see the
// first one's writes (two views never alias here) — never overwrites a newer byte.

/**
 * The bytes of `src` [base, base + n) that differ from `prev` [off, off + n) into `data` [off, off + n).
 * @returns {boolean} whether any byte differed
 */
function merge(data, prev, src, base, off, n) {
  let changed = false, i = 0;
  if (((base | off) & 3) === 0 && n >= 4) {
    const w = n >>> 2;
    const s32 = new Int32Array(src.buffer, src.byteOffset + base, w), p32 = new Int32Array(prev.buffer, prev.byteOffset + off, w);
    if (prev === data) {
      for (let k = 0; k < w; k++) { const x = s32[k]; if (x !== p32[k]) { p32[k] = x; changed = true; } }
    } else {
      for (let k = 0; k < w; k++) {
        if (s32[k] === p32[k]) continue;
        changed = true;
        for (let b = k << 2, e = b + 4; b < e; b++) if (src[base + b] !== prev[off + b]) data[off + b] = src[base + b];
      }
    }
    i = w << 2;
  }
  for (; i < n; i++) if (src[base + i] !== prev[off + i]) { data[off + i] = src[base + i]; changed = true; }
  return changed;
}

/**
 * The holder's views into the mapping's bytes (it stops being ahead of them).
 * @returns {number} bytes compared (diagnostics: ProcessGroup.syncBytes)
 */
export function releaseMapping(m) {
  const h = m.holder;
  if (!h) return 0;
  m.holder = null;
  let views = 0, bytes = 0;
  for (const v of m.views) if (v.vm === h) views++;
  if (!views) return 0;
  const data = m.data, prev = views > 1 ? data.slice() : data; // (several views: each compared to the bytes before any of them)
  let changed = false;
  for (const v of m.views) {
    if (v.vm !== h) continue;
    if (merge(data, prev, h.mem.u8, v.base, v.off, v.n)) changed = true;
    bytes += v.n;
  }
  if (changed) {
    m.ver++;
    if (views === 1) for (const v of m.views) if (v.vm === h) v.ver = m.ver; // (its one view is what the bytes are now)
  }
  return bytes;
}

/**
 * `vm` is about to run guest code that may touch the mapping: the holder's bytes released, `vm`'s views brought up to
 * date, `vm` the holder.
 * @returns {number} bytes moved (diagnostics)
 */
export function acquireMapping(vm, m) {
  if (m.holder === vm) return 0;
  let bytes = m.holder ? releaseMapping(m) : 0;
  for (const v of m.views) {
    if (v.vm !== vm || v.ver === m.ver) continue;
    vm.mem.u8.set(m.data.subarray(v.off, v.off + v.n), v.base); v.ver = m.ver; bytes += v.n;
  }
  m.holder = vm;
  return bytes;
}

/**
 * The bytes [0, end) available in `data` (zeros past what views covered so far); false when the host cannot allocate
 * them (the caller fails with ERROR_NOT_ENOUGH_MEMORY).
 */
export function growMapping(m, end) {
  if (m.data && m.data.length >= end) return true;
  let d;
  try { d = new Uint8Array(end); } catch { return false; }
  if (m.data) d.set(m.data);
  m.data = d;
  return true;
}

/** `vm`'s views of `m` written back and removed (an unmap of all of them, the process ending) */
export function dropViews(vm, m) {
  releaseMapping(m);
  m.views = m.views.filter((x) => x.vm !== vm);
}
