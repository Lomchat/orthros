// An Emscripten engine built without JSPI (a pinned third-party binary, unchanged: GoldSrc's), made to suspend while
// it waits for the game's files instead of holding the page's thread (docs/browser-ports.md "Reads that suspend
// GoldSrc's engine"): the page instantiates its WebAssembly itself (Module.instantiateWasm), some of its imports
// replaced —
// - its file reads (WASI fd_read / fd_pread, WebAssembly built here: readsModule) suspend the engine (a
//   WebAssembly.Suspending import, called only then) when a frame asks for bytes not in the page within a few ms (the
//   file's node, emscripten-files.js `orthrosStreamed.soon`) or has held the page's thread BREATH_MS (a turn for the
//   page), then read once here; done at once otherwise;
// - a frame runs under WebAssembly.promising: each main loop iteration (its table entry, looked up by Emscripten's main
//   loop at each iteration: the next ones skipped while one is suspended) and each call of the page's (`exec`: a console
//   command, after the frame under way); the page's event loop runs while a frame waits;
// - its setjmp / C++ exception trampolines (`invoke_<sig>`, Emscripten's JavaScript ones: a JavaScript frame between the
//   promising export and the read, which JSPI cannot suspend through) replaced by WebAssembly ones built here, with the
//   same semantics: the call through the engine's table; a JavaScript number thrown through it (a longjmp, a C++
//   exception) caught — the stack restored, setThrew(1, 0) — anything else thrown on.
// Nothing else of the page's calls into the engine while a frame is suspended (`call`: put off until it is done), nor
// its timers (emscripten_set_timeout); the browser's events reach the engine's SDL as between two frames (they queue).
// A read outside a frame (the engine's main(), an import that runs its code again from JavaScript) waits as before,
// on the page's thread. Engine-agnostic: an Emscripten engine whose imports have these names (fd_read, invoke_*,
// emscripten_set_main_loop[_arg]) and whose module exports its table, stack pointer, setThrew, malloc and free.

/** This browser can suspend a WebAssembly engine: JSPI, and the JavaScript exception tag the trampolines catch with. */
export const canSuspend = () => typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function' && !!WebAssembly.JSTag;

// ---------------------------------------------------------------- the trampolines' WebAssembly (built here)
const uleb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const sleb = (n) => { const out = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); return out; } out.push(b | 0x80); } };
const name = (s) => { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, items) => { const body = vec(items); return [id, ...uleb(body.length), ...body]; };
const code = (locals, body) => { const b = [...vec(locals), ...body, 0x0b]; return [...uleb(b.length), ...b]; };
const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const I32 = 0x7f, EXTERNREF = 0x6f, FUNCREF = 0x70;
/** Emscripten's signature letters (pointers are 32-bit here). */
const TYPE = { i: I32, p: I32, j: 0x7e, f: 0x7d, d: 0x7c };
const ZERO = { [I32]: [0x41, 0x00], 0x7e: [0x42, 0x00], 0x7d: [0x43, 0, 0, 0, 0], 0x7c: [0x44, 0, 0, 0, 0, 0, 0, 0, 0] };
const functype = (params, results) => [0x60, ...vec(params.map((t) => [t])), ...vec(results.map((t) => [t]))];

/** An `invoke_<sig>` signature: { params, results } of the function it calls (its own: the table index first). */
export function invokeSignature(sig) {
  const [r, ...p] = String(sig);
  if (!r || (r !== 'v' && !TYPE[r]) || p.some((c) => !TYPE[c])) return null;
  return { params: p.map((c) => TYPE[c]), results: r === 'v' ? [] : [TYPE[r]] };
}

/**
 * The trampolines the engine imports, instantiated before it: `invoke_<sig>` for each of `sigs`, each a call through
 * its own table `t` (slot k: the handler of sigs[k], set once the engine and the handlers exist).
 */
export function trampolinesModule(sigs) {
  const s = sigs.map(invokeSignature);
  return new Uint8Array([...MAGIC,
    ...section(1, s.map((x) => functype([I32, ...x.params], x.results))),
    ...section(3, s.map((_, k) => uleb(k))),
    ...section(4, [[FUNCREF, 0x00, ...uleb(s.length)]]),
    ...section(7, [...sigs.map((sig, k) => [...name(`invoke_${sig}`), 0x00, ...uleb(k)]), [...name('t'), 0x01, 0x00]]),
    ...section(10, s.map((x, k) => code([], [...[...Array(x.params.length + 1).keys()].flatMap((i) => [0x20, ...uleb(i)]), 0x41, ...sleb(k), 0x11, ...uleb(k), 0x00]))),
  ]);
}

/**
 * The handlers (instantiated once the engine is: they import its table `m.t`, its stack pointer `m.sp`, its setThrew
 * `m.threw`, the JavaScript exception tag `m.tag` and `m.num` — 1 for a JavaScript number): `f<k>` for sigs[k], the
 * engine's JavaScript invoke_<sig> in WebAssembly —
 *   sp = stack pointer; try { table[index](args…) } catch (e: JavaScript) { stack pointer = sp; if (!num(e)) rethrow;
 *   setThrew(1, 0); return 0 }
 */
export function handlersModule(sigs) {
  const s = sigs.map(invokeSignature);
  const types = [functype([I32, I32], []), functype([EXTERNREF], [I32]), functype([EXTERNREF], []),
    ...s.flatMap((x) => [functype([I32, ...x.params], x.results), functype(x.params, x.results)])];
  const imports = [
    [...name('m'), ...name('t'), 0x01, FUNCREF, 0x00, 0x00],
    [...name('m'), ...name('sp'), 0x03, I32, 0x01],
    [...name('m'), ...name('threw'), 0x00, 0x00],
    [...name('m'), ...name('num'), 0x00, 0x01],
    [...name('m'), ...name('tag'), 0x04, 0x00, 0x02],
  ];
  const body = (x, k) => {
    const n = x.params.length, sp = n + 1;
    return code([[0x01, I32]], [
      0x23, 0x00, 0x21, ...uleb(sp), // sp = stack pointer
      0x06, x.results.length ? x.results[0] : 0x40, // try
      ...[...Array(n).keys()].flatMap((i) => [0x20, ...uleb(i + 1)]), 0x20, 0x00, 0x11, ...uleb(4 + 2 * k), 0x00, // table[index](args…)
      0x07, 0x00, // catch (the JavaScript tag: the value thrown)
      0x20, ...uleb(sp), 0x24, 0x00, // stack pointer = sp
      0x10, 0x01, 0x45, 0x04, 0x40, 0x09, 0x01, 0x0b, // if (!num(e)) rethrow
      0x41, 0x01, 0x41, 0x00, 0x10, 0x00, // setThrew(1, 0)
      ...(x.results.length ? ZERO[x.results[0]] : []),
      0x0b, // end try
    ]);
  };
  return new Uint8Array([...MAGIC,
    ...section(1, types), ...section(2, imports),
    ...section(3, s.map((_, k) => uleb(3 + 2 * k))),
    ...section(7, s.map((_, k) => [...name(`f${k}`), 0x00, ...uleb(2 + k)])),
    ...section(10, s.map(body)),
  ]);
}

/** WASI's reads on wasm32: fd_read (fd, iovs, iovs_len, nread) and fd_pread (… offset i64 …), their errno back. */
const READS = [['fd_read', [I32, I32, I32, I32]], ['fd_pread', [I32, I32, I32, 0x7e, I32]]];

/**
 * The engine's reads (instantiated before it, its fd_read and fd_pread): each asks `m.<read>` first — the read done at
 * once (its errno), or -1 when it must wait (an iteration under way, its bytes not here) — and then only calls
 * `m.<read>_wait`, the suspending one. A Suspending import called outside WebAssembly.promising throws (the engine's
 * main(), a callback, the page's calls), whatever it returns: only a read that suspends goes through it.
 */
export function readsModule() {
  const body = (params, k) => {
    const args = params.flatMap((_, i) => [0x20, ...uleb(i)]), r = params.length;
    return code([[0x01, I32]], [...args, 0x10, ...uleb(2 * k), 0x22, ...uleb(r), 0x41, 0x7f, 0x47, // r = read(…); r != -1
      0x04, I32, 0x20, ...uleb(r), 0x05, ...args, 0x10, ...uleb(2 * k + 1), 0x0b]); // ? r : wait(…)
  };
  return new Uint8Array([...MAGIC,
    ...section(1, READS.map(([, p]) => functype(p, [I32]))),
    ...section(2, READS.flatMap(([n], k) => [[...name('m'), ...name(n), 0x00, ...uleb(k)], [...name('m'), ...name(`${n}_wait`), 0x00, ...uleb(k)]])),
    ...section(3, READS.map((_, k) => uleb(k))),
    ...section(7, READS.map(([n], k) => [...name(n), 0x00, ...uleb(2 * READS.length + k)])),
    ...section(10, READS.map(([, p], k) => body(p, k))),
  ]);
}

// ---------------------------------------------------------------- the engine linked
/** A JavaScript exception the engine's own code handles (its main loop's exit, exit()): not an error. */
const quiet = (e) => e === 'unwind' || e?.name === 'ExitStatus';
/**
 * A frame that held the page's thread this long (ms) since the page's last turn (its start, its last suspension) gives
 * it a turn at its next read: a load whose bytes are here or come within the read's spin (the browser's copy, the
 * announced reads already in) would hold it all along otherwise. OpenMW's loads do the same at 100 ms
 * (orthros-r20.patch, orthrosBreath: ~1 ms a turn).
 */
export const BREATH_MS = 100;
/** Imports this link replaces, by module: those the engine's import object has under each. */
const MODULES = ['env', 'wasi_snapshot_preview1'];
/** The engine's imports that may call into it again from JavaScript (EM_ASM, dlopen's constructors, signal handlers). */
const REENTRANT = /^(emscripten_asm_const|_dlopen_js|_emscripten_dlopen_js|__call_sighandler|_emscripten_system)/;

/**
 * The engine's suspension: its `instantiateWasm` (Module.instantiateWasm: the engine's WebAssembly at `o.wasm` compiled
 * and linked as above), `exec(name, text, plain)` (a call of the page's into the engine as a frame of its own),
 * `call(fn)` (fn now, or once the frame under way is done — the page's other calls into the engine), `idle()` (a promise
 * settled once no frame is under way), `waiting` (a frame is suspended now), its counts (`stats`). A link that cannot be
 * made (an engine without these exports, a signature of an unknown kind) instantiates the engine as it is: its reads
 * wait as before (`stats.linked` false, the reason logged).
 * @param {{ wasm: string | WebAssembly.Module, fs: () => object | null | undefined, log?: (text: string) => void,
 *   onError?: (error: unknown) => void, spinMs?: number, breathMs?: number }} o
 *   fs: the engine's FS once it exists (its streams: a file's node); onError: a frame that threw (the engine's main
 *   loop reported it to the page as an uncaught error: reportError by default); spinMs: how long a read waits on the
 *   page's thread before the engine suspends (GameData.soon's default when unset); breathMs: a frame that held the
 *   page's thread this long since its last turn gives it one at its next read (BREATH_MS; 0: never)
 */
export function suspendingEngine(o) {
  const log = o.log ?? (() => {});
  // (longestRunMs: the longest the engine held the page's thread at once — an iteration, or its part between two turns
  // of the page's —, longestRunReads its reads: none, the engine's own work, not its files)
  const stats = { linked: false, iterations: 0, suspensions: 0, suspendedMs: 0, longestMs: 0, breaths: 0, skipped: 0, deferred: 0, longestRunMs: 0, longestRunReads: 0 };
  /** inside: a frame's WebAssembly runs now (a read may suspend it); frame: the frame under way, suspended; turnAt: when
   * the page last had its turn (the frame's start, its last resumption) */
  let inside = false, frame = null, memory = null, table = null, loop = null, turnAt = 0, breathing = false;
  /** the reads since the page's last turn; gaveTurn: the frame under way suspended at least once */
  let runReads = 0, gaveTurn = false;
  const runEnd = () => { const ms = performance.now() - turnAt; if (ms > stats.longestRunMs) { stats.longestRunMs = Math.round(ms); stats.longestRunReads = runReads; } runReads = 0; };
  const breathMs = o.breathMs ?? BREATH_MS;
  /** A turn for the page (a message to itself: its events, its painting, then the engine on). */
  const breath = () => new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); resolve(); }; c.port2.postMessage(0); });
  const later = [], idlers = [];
  const tableGet = WebAssembly.Table.prototype.get;

  // (a frame that suspended and went on ran to its end since: its WebAssembly is no longer under way; the calls put off
  // meanwhile, one at a time — one that suspends in its turn holds the next ones)
  const settle = () => {
    if (gaveTurn) runEnd();
    frame = null; inside = false;
    while (!frame && later.length) { const fn = later.shift(); try { fn(); } catch (e) { thrown(e); } }
    if (!frame) for (const r of idlers.splice(0)) r();
  };
  const thrown = (e) => { if (quiet(e)) return; if (o.onError) o.onError(e); else if (typeof reportError === 'function') reportError(e); else setTimeout(() => { throw e; }); };
  const call = (fn) => {
    if (!frame) return fn();
    stats.deferred++; later.push(fn);
    return undefined;
  };
  /**
   * A frame: `run()`, a promising call into the engine (an iteration of its main loop, a call of the page's), its reads
   * free to suspend it; the frame under way until it settles (`frame`). Its promise, or null when it threw at once.
   */
  const asFrame = (run) => {
    inside = true; turnAt = performance.now(); runReads = 0; gaveTurn = false;
    let p;
    try { p = run(); } catch (e) { inside = false; thrown(e); return null; }
    inside = false;
    if (!gaveTurn) runEnd();
    frame = p;
    p.then(settle, (e) => { settle(); thrown(e); });
    return p;
  };
  /** Each iteration of the engine's main loop (`raw`, its table entry) under promising, one at a time. */
  const iterating = (raw) => {
    const run = WebAssembly.promising(raw);
    return (...args) => {
      if (frame) { stats.skipped++; return; }
      stats.iterations++;
      asFrame(() => run(...args));
    };
  };
  /** The engine's exports (once linked), and their promising forms as asked. */
  let exports = null;
  const promised = new Map();

  /** The read's wait: a promise when its bytes are not in the page within spinMs, or the page's turn is due (breathMs
   * since its last one) — the iteration then suspends —, else null. */
  const ahead = (fd, iov, iovcnt, offset, mayBreathe = true) => {
    if (!inside || !memory) return null;
    if (mayBreathe && breathMs > 0 && performance.now() - turnAt >= breathMs) { stats.breaths++; breathing = true; return breath(); }
    try {
      const stream = o.fs?.()?.getStream?.(fd), s = stream?.node?.orthrosStreamed;
      if (!s?.soon) return null;
      const H = new Uint32Array(memory.buffer);
      let length = 0;
      for (let i = 0; i < iovcnt; i++) length += H[(iov >>> 2) + i * 2 + 1];
      if (!(length > 0)) return null;
      return s.soon(offset ?? stream.position, length, o.spinMs) ?? null;
    } catch { return null; } // (a fetch that failed: the read itself, synchronously, says why)
  };
  /** The bytes a read waits for, given up to the suspending import (readsModule: its -1). */
  let pending = null;
  /** A read (`fd_read`, or `fd_pread`: its offset argument at `offsetAt`): done at once, or -1 — its wait kept in `pending`. */
  const tryRead = (read, offsetAt) => (...a) => {
    if (inside) runReads++;
    const wait = ahead(a[0], a[1], a[2], offsetAt === undefined ? undefined : Number(a[offsetAt]));
    if (!wait) return read(...a);
    pending = wait;
    return -1;
  };
  /** The same read once its bytes are here, the iteration suspended meanwhile (called only under promising: tryRead's -1). */
  const waitRead = (read, offsetAt) => new WebAssembly.Suspending((...a) => {
    const t0 = performance.now(), noop = () => {};
    // (resumed after a turn for the page: its bytes asked for then — they may be missing —; after they came: read at once,
    // anything still missing — a fetch that failed — read on the page's thread, which says why)
    const go = (turn) => {
      turnAt = performance.now(); inside = true;
      const again = turn ? ahead(a[0], a[1], a[2], offsetAt === undefined ? undefined : Number(a[offsetAt]), false) : null;
      if (again) { const b = breathing; breathing = false; inside = false; runEnd(); if (!b) stats.suspensions++; return again.then(noop, noop).then(() => go(b)); }
      if (!turn) { const ms = turnAt - t0; stats.suspendedMs += ms; if (ms > stats.longestMs) stats.longestMs = ms; }
      return read(...a);
    };
    const wait = pending, turn = breathing; pending = null; breathing = false; inside = false; gaveTurn = true; runEnd();
    if (!turn) stats.suspensions++;
    return Promise.resolve(wait).then(noop, noop).then(() => go(turn));
  });
  /** An import that may run the engine's code again from JavaScript (REENTRANT): the reads of that code never suspend. */
  const outside = (f) => function (...a) { const was = inside; inside = false; try { return f.apply(this, a); } finally { inside = was; } };

  /** The engine's imports for this link (a copy: the engine's own object, which its side modules resolve from, unchanged). */
  const linkImports = (imports, sigs, tramp, reads) => {
    const out = { ...imports }, done = new Map();
    for (const m of MODULES) {
      const src = imports[m]; if (!src) continue;
      if (done.has(src)) { out[m] = done.get(src); continue; }
      const env = { ...src };
      sigs.forEach((sig) => { if (env[`invoke_${sig}`]) env[`invoke_${sig}`] = tramp.exports[`invoke_${sig}`]; });
      for (const [n] of READS) if (src[n]) env[n] = reads.exports[n];
      for (const k of Object.keys(env)) if (REENTRANT.test(k) && typeof env[k] === 'function') env[k] = outside(env[k]);
      for (const k of ['emscripten_set_main_loop', 'emscripten_set_main_loop_arg']) {
        const set = src[k]; if (!set) continue;
        // (Emscripten's main loop looks its iteration up in the table — every iteration for the _arg form: tableGet below)
        env[k] = (func, ...rest) => { loop = { func, run: iterating(tableGet.call(table, func)) }; return set(func, ...rest); };
      }
      if (src.emscripten_set_timeout) {
        // (Emscripten's: the callback through the table once the time is up; due while an iteration is suspended, it waits
        // for its end — cleared meanwhile, never called)
        const due = new Set();
        env.emscripten_set_timeout = (cb, ms, user) => {
          const id = setTimeout(() => { due.add(id); call(() => { if (due.delete(id)) try { tableGet.call(table, cb)(user); } catch (e) { thrown(e); } }); }, ms);
          return id;
        };
        env.emscripten_clear_timeout = (id) => { clearTimeout(id); due.delete(id); };
      }
      done.set(src, env); out[m] = env;
    }
    return out;
  };

  async function link(module, imports) {
    const names = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
    for (const k of ['__indirect_function_table', '__stack_pointer', 'setThrew', 'memory']) if (!names.has(k)) throw new Error(`the engine does not export ${k}`);
    const sigs = [...new Set(WebAssembly.Module.imports(module).filter((i) => i.kind === 'function' && /^invoke_/.test(i.name)).map((i) => i.name.slice(7)))];
    const odd = sigs.find((s) => !invokeSignature(s)); if (odd) throw new Error(`invoke_${odd}: a signature not known`);
    const tramp = new WebAssembly.Instance(new WebAssembly.Module(trampolinesModule(sigs)));
    const src = imports.wasi_snapshot_preview1 ?? imports.env ?? {}, none = () => 52; // (ENOSYS: a read the engine has not)
    const reads = new WebAssembly.Instance(new WebAssembly.Module(readsModule()), { m: {
      fd_read: tryRead(src.fd_read ?? none), fd_read_wait: waitRead(src.fd_read ?? none),
      fd_pread: tryRead(src.fd_pread ?? none, 3), fd_pread_wait: waitRead(src.fd_pread ?? none, 3) } });
    const instance = await WebAssembly.instantiate(module, linkImports(imports, sigs, tramp, reads));
    const x = instance.exports;
    table = x.__indirect_function_table; memory = x.memory; exports = x;
    const handlers = new WebAssembly.Instance(new WebAssembly.Module(handlersModule(sigs)),
      { m: { t: table, sp: x.__stack_pointer, threw: x.setThrew, num: (e) => (e === e + 0 ? 1 : 0), tag: WebAssembly.JSTag } });
    sigs.forEach((_, k) => tramp.exports.t.set(k, handlers.exports[`f${k}`]));
    // (the main loop's iteration, as Emscripten looks it up: the promising one)
    table.get = function (i, ...rest) { return loop && i === loop.func ? loop.run : tableGet.call(this, i, ...rest); };
    return { instance, sigs };
  }

  async function compile(url) {
    if (url instanceof WebAssembly.Module) return url;
    try { return await WebAssembly.compileStreaming(fetch(url, { credentials: 'same-origin' })); }
    catch { const r = await fetch(url, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return WebAssembly.compile(await r.arrayBuffer()); }
  }

  return {
    stats, call,
    /**
     * The engine's export `name` called with the string `text` (its UTF-8 copy in the engine's heap, malloc / free) as a
     * frame: its reads free to suspend it — a console command that loads a map, say —, after the frame under way if any.
     * `plain()` instead while the engine is not linked (its own way: Emscripten's ccall).
     */
    exec(name, text, plain) {
      const x = exports, f = x?.[name];
      if (!stats.linked || !f || !x.malloc || !x.free) return plain?.();
      return call(() => {
        const bytes = new TextEncoder().encode(String(text)), ptr = x.malloc(bytes.length + 1);
        if (!ptr) return;
        const heap = new Uint8Array(memory.buffer); heap.set(bytes, ptr); heap[ptr + bytes.length] = 0;
        let run = promised.get(name); if (!run) promised.set(name, run = WebAssembly.promising(f));
        const p = asFrame(() => run(ptr)), free = () => x.free(ptr);
        if (p) p.then(free, free); else free();
      });
    },
    /** A promise settled once no iteration is under way (at once when none is). */
    idle: () => (frame ? new Promise((r) => idlers.push(r)) : Promise.resolve()),
    /** An iteration is suspended now (waiting for the game's files). */
    get waiting() { return !!frame; },
    /** Module.instantiateWasm: the engine linked (or, when it cannot be, instantiated as it is). */
    instantiateWasm(imports, done) {
      (async () => {
        const module = await compile(o.wasm);
        let instance;
        try {
          const r = await link(module, imports);
          instance = r.instance; stats.linked = true;
          log(`Engine reads suspend the engine (JSPI; ${r.sigs.length} trampolines)`);
        } catch (e) {
          log(`Engine reads wait on the page: ${e?.message ?? e}`);
          loop = table = memory = null; instance = await WebAssembly.instantiate(module, imports);
        }
        done(instance, module);
      })().catch((e) => thrown(e));
      return {};
    },
  };
}
