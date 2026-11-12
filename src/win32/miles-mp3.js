// Miles Sound System's MP3 decoder run by the host (DECISIONS.md D122: a library recognised by its content, never a
// game). Games using Miles decode MP3 in an ASI codec provider (mssmp3.asi, mp3dec.asi): a DLL that registers the
// "ASI codec" and "ASI stream" interfaces with mss32.dll (RIB_register_interface) — ASI_stream_open / process / seek /
// close / attribute / set_preference — which mss32's mixer calls for every MP3 sample and stream (music, voices). Its
// decoding is x87 code: 7.5-13 % of the guest instructions of a SAGE game in play (data/proof/guest-speed-2026-11-12),
// 1-2 % of the time in RotWK (cheap instructions), more where many streams play (docs/miles-mp3.md).
//
// When a recognised decoder registers its interfaces, its six stream functions are replaced by host functions (thunks
// of orthros.dll): the MP3 frames are read through the fetch callback mss32 gave the stream, decoded off the emulator's
// thread (src/media/mp3-host.js, mp3-helper.js: the browser's WebCodecs AudioDecoder in a helper worker), and the game's
// thread only copies PCM. Everything else stays the provider's own (DllMain, RIB_Main, startup, shutdown, error text,
// PROVIDER_query_attribute).
//
// Switch: ORTHROS_MP3_HOST (debug global ?dbg=ORTHROS_MP3_HOST=1, or the environment in Node): 1 = the host's decoder
// where one exists (vm.host.mp3: the browser with WebCodecs' mp3; Node with startbench --mp3-host); 0 or unset = the
// guest's (HOST_DEFAULT); 'trace' = the guest's, every call logged (startbench --mp3-capture: every stream's input and
// output kept, for tools/dev/mp3-compare.mjs).
import { snapKnown, snapClass } from '../core/snapshot.js';
import { mpegAudioHeader } from '../media/mpeg-ps.js';
import { ST_DONE, ST_FAILED } from '../media/mp3-ring.js';

/**
 * Recognised decoders: the FNV-1a hash and length of their code sections' raw bytes (the file's, before relocation).
 * Only fingerprints ship. `ORTHROS_MP3_PRINT=1` logs every Miles provider's.
 */
export const KNOWN_DECODERS = [
  { name: 'mssmp3.asi (MSS 7, SAGE games: BFME, BFME II, RotWK, AotR)', fnv: 0x1f3f2615, len: 82649 },
  { name: 'mp3dec.asi (MSS 6, Vice City)', fnv: 0x52ded8df, len: 65858 },
];

/** FNV-1a (32 bits) of the raw bytes of a PE image's executable sections, and their total length. */
export function codeFingerprint(img) {
  let h = 0x811c9dc5, len = 0;
  for (const s of img.sections) {
    if (!(s.characteristics & 0x20000020)) continue; // (IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE)
    const n = Math.min(s.rawSize, s.virtualSize || s.rawSize), b = img.bytes.subarray(s.rawPtr, s.rawPtr + n);
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    len += b.length;
  }
  return { fnv: h >>> 0, len };
}

/**
 * Unset switch: the guest's decoder. The host's saves 6-13 % of the guest instructions in play but no time beyond the
 * measurements' spread on RotWK, BFME II and AotR (its instructions are cheap ones): docs/miles-mp3.md, "Decision".
 */
export const HOST_DEFAULT = 0;

/** The switch: 0 off, 1 on, 'trace', null unset (the debug global first, then the environment). */
export function mp3HostMode() {
  const g = globalThis.ORTHROS_MP3_HOST ?? globalThis.process?.env?.ORTHROS_MP3_HOST;
  if (g === undefined || g === null || g === '') return null; // (default: decided by the decoder's availability)
  if (g === 'trace') return g;
  return Number(g) ? 1 : 0;
}

const ASI_FUNCS = ['ASI_stream_open', 'ASI_stream_process', 'ASI_stream_seek', 'ASI_stream_close', 'ASI_stream_attribute', 'ASI_stream_set_preference'];
const ARGC = { ASI_stream_open: 3, ASI_stream_process: 3, ASI_stream_seek: 2, ASI_stream_close: 1, ASI_stream_attribute: 2, ASI_stream_set_preference: 3 };
const RIB_FUNCTION = 0;

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerMilesMp3(api, vm) {
  const mem = vm.mem;
  // machine state: the recognised providers (by module), the original functions they registered, the streams
  const st = snapKnown(vm, 'mss.mp3', { providers: [], streams: new Map(), nextId: 1, mode: 0, stats: { opens: 0, process: 0, bytes: 0, seeks: 0, fetches: 0, fetchBytes: 0, restarts: 0 } });
  const log = (m) => vm.logFn('mp3', m);

  /** Is `mod` (a module importing mss32!RIB_register_interface) a recognised MP3 decoder? */
  function recognise(mod) {
    if (!mod.image?.bytes) return null;
    const fp = codeFingerprint(mod.image);
    const k = KNOWN_DECODERS.find((d) => d.fnv === fp.fnv && d.len === fp.len);
    if (globalThis.ORTHROS_MP3_PRINT) log(`${mod.name}: code fingerprint fnv 0x${fp.fnv.toString(16)} len ${fp.len}${k ? ` = ${k.name}` : ''}`);
    return k ?? null;
  }

  /**
   * The loader's hook (Process.resolveImports): the address a module's import of dll!name resolves to, or null (the
   * export). A recognised decoder's RIB_register_interface goes through the host's.
   */
  vm.milesMp3Stats = () => st.stats; // (diagnostics: startbench)
  vm.milesImport = (mod, dep, name, addr) => {
    if (name !== 'RIB_register_interface' || dep.builtin) return null;
    const mode = mp3HostMode() ?? HOST_DEFAULT;
    if (!mode) return null;
    if (mode !== 'trace' && !vm.host?.mp3) return null; // (no decoder off this thread: the guest's)
    const k = recognise(mod);
    if (!k) return null;
    st.providers.push({ module: mod.name, base: mod.base, kind: k.name, real: addr, funcs: {}, tokens: {} });
    st.mode = mode;
    log(`${mod.name} at 0x${mod.base.toString(16)}: ${k.name}, decoding by the host (${mode === 1 ? 'host' : mode})`);
    return api.thunkFor('orthros.dll', '__mss_RIB_register_interface');
  };

  /** RIB_register_interface(provider, interface name, count, entries) from a recognised decoder (stdcall) */
  function registerInterface(c) {
    const ret = c.retAddr, prov = st.providers.find((p) => ret >= p.base && ret < p.base + 0x1000000) ?? st.providers[st.providers.length - 1];
    const iname = c.str(1), n = c.arg(2), entries = c.arg(3);
    for (let i = 0; i < n; i++) {
      const e = entries + 16 * i, type = mem.read32(e), name = mem.readCString(mem.read32(e + 4)), value = mem.read32(e + 8);
      if (type === RIB_FUNCTION && ARGC[name] !== undefined) { // (in the "ASI stream" interface)
        prov.funcs[name] = value;
        mem.write32(e + 8, api.thunkFor('orthros.dll', `__mss_${name}`)); // (in the provider's own array, before mss32 reads it)
      } else if (iname === 'ASI stream' && type !== RIB_FUNCTION) prov.tokens[value] = name;
      if (globalThis.ORTHROS_MP3_PRINT) log(`  ${iname}[${i}] type ${type} ${name} = 0x${value.toString(16)} sub ${mem.read32(e + 12)}`);
    }
    return vm.tailCallGuest(c, prov.real, [c.arg(0), c.arg(1), n, entries], { argBytes: 16 });
  }

  const provOf = () => st.providers[st.providers.length - 1];
  const hex = (v) => '0x' + (v >>> 0).toString(16);

  // ---- trace mode: the guest's own functions, called and logged (their fetch callback too: through __mss_fetch, the
  // stream it reads for being the one whose function is running — several streams may share a user value)
  const traceOf = new Map(); // snapshot: diagnostics (trace mode: stream handle -> { id, user, cb, len })
  let cur = null; // snapshot: diagnostics (trace mode: the stream whose guest function runs)
  const verbose = () => !!globalThis.ORTHROS_MP3_TRACE_PROCESS;
  function traced(name) {
    return (c) => {
      const p = provOf(), args = Array.from({ length: ARGC[name] }, (_, i) => c.arg(i)), prev = cur;
      const cap = globalThis.ORTHROS_MP3_CAPTURE; // (tools: startbench --mp3-capture)
      let f;
      if (name === 'ASI_stream_open') { f = { id: st.nextId++, user: args[0], cb: args[1], len: 0 }; args[1] = api.thunkFor('orthros.dll', '__mss_fetch'); }
      else f = traceOf.get(args[0]);
      cur = f;
      let r;
      try { r = vm.callGuest(c.thread, p.funcs[name], args) >>> 0; } finally { cur = prev; }
      if (name === 'ASI_stream_open' && r) { traceOf.set(r, f); if (cap) cap('open', f.id, `${hex(r)} ${f.id}\n`); }
      if (name === 'ASI_stream_close') traceOf.delete(args[0]);
      if (name === 'ASI_stream_process') { st.stats.process++; st.stats.bytes += r; if (cap && r && f) cap('pcm', f.id, mem.u8.slice(args[1], args[1] + r)); if (r < args[2] && globalThis.ORTHROS_MP3_LOG && !verbose()) log(`[t${c.thread.id}] process(${hex(args[0])}, ${args[2]}) -> ${r}`); }
      if (cap && f && (name === 'ASI_stream_seek' || name === 'ASI_stream_close')) cap('log', f.id, `${name} ${args[1] | 0} after ${st.stats.bytes}\n`);
      if (name === 'ASI_stream_attribute') { if (globalThis.ORTHROS_MP3_TRACE_ATTR) log(`[t${c.thread.id}] attribute(${hex(args[0])}, ${p.tokens[args[1]] ?? args[1]}) -> ${hex(r)}`); }
      else if (name !== 'ASI_stream_process' || verbose()) log(`[t${c.thread.id} d${vm.depth}] ${name}(${args.map(hex).join(', ')}) -> ${hex(r)}${name === 'ASI_stream_process' ? ` (${st.stats.process} calls, ${st.stats.bytes} bytes)` : ''}`);
      if (name === 'ASI_stream_process' && st.stats.process % 2000 === 0) log(`process: ${st.stats.process} calls, ${st.stats.bytes} bytes; fetch: ${st.stats.fetches} calls, ${st.stats.fetchBytes} bytes`);
      return r;
    };
  }
  /** (trace) the fetch callback the guest decoder calls: fetch(user, dest, bytes, offset) -> bytes read (stdcall) */
  function tracedFetch(c) {
    const a = [c.arg(0), c.arg(1), c.arg(2), c.arg(3)], f = cur;
    if (!f) return 0;
    const r = vm.callGuest(c.thread, f.cb, a) | 0;
    st.stats.fetches++; st.stats.fetchBytes += Math.max(0, r);
    const cap = globalThis.ORTHROS_MP3_CAPTURE;
    if (cap && r > 0) { if (a[3] !== 0xffffffff) cap('log', f.id, `fetch offset ${a[3] | 0} at ${f.len}\n`); cap('mp3', f.id, mem.u8.slice(a[1], a[1] + r)); f.len += r; }
    if (verbose() && (a[3] !== 0xffffffff || r !== a[2] || globalThis.ORTHROS_MP3_TRACE_FETCH)) log(`[t${c.thread.id}] fetch(${hex(a[0])}, ${a[2]}, off ${a[3] | 0}) -> ${r}`);
    return r >>> 0;
  }

  const defs = { __mss_RIB_register_interface: [4, registerInterface], __mss_fetch: [4, tracedFetch] }; // snapshot: constant
  for (const f of ASI_FUNCS) defs[`__mss_${f}`] = [ARGC[f], (c) => (st.mode === 1 ? hostFns[f](c) : traced(f)(c))];
  api.define('orthros.dll', defs);

  // ---- host mode: the streams decoded off this thread (src/media/mp3-host.js)
  const STREAM_TAG = 0x6d700000; // (stream handles: opaque to mss32)
  /** MP3 bytes asked of the fetch callback at a time (the decoder's own reads are a frame or a byte) */
  const CHUNK = 4096;
  /** PCM kept decoded ahead of the reader (seconds) */
  const AHEAD_S = 0.35;
  /** how long a read waits for the helper before the session is given up (ms), in slices of WAIT_SLICE_MS; after
   *  FLUSH_AFTER_MS with nothing more to send, the session is told its end (a decoder holding back its last frames) */
  const WAIT_MS = 3000, WAIT_SLICE_MS = 20, FLUSH_AFTER_MS = 100;
  const f32 = new Float32Array(1), f32u = new Uint32Array(f32.buffer); // snapshot: scratch

  /**
   * One ASI stream decoded by the host. Machine state: what the guest gave (user value, fetch callback), the stream's
   * format, the MP3 bytes fetched and not yet heard (frames sent to the decoder and not read back, frames parsed and not
   * sent, the bytes after them) — a restored machine sends them to a new decoder — and the counters the attributes
   * report. The decoder session is the host's.
   */
  class Mp3Stream {
    constructor(handle, user, cb, total) {
      this.handle = handle; this.user = user; this.cb = cb; this.total = total;
      this.fmt = null; // { version, rate, ch, spf } of the first header
      this.bitrate = 0;
      this.nextOff = 0; // the next fetch's offset argument (-1: where the last one ended)
      this.pos = 0; // input bytes of the frames read back (the "Position" attribute)
      this.inBuf = new Uint8Array(0); // fetched bytes not parsed into frames yet
      this.inPos = 0; // input offset of inBuf[0]
      this.synced = false; // the last bytes parsed were a frame (else the next one needs a header after it)
      this.parsed = []; // frames parsed, not sent: { bytes, samples, end, bitrate }
      this.sent = []; // frames sent to the session, not wholly read back
      this.headDone = 0; // samples of sent[0] already read
      this.sentSamples = 0; this.readSamples = 0; // (of the session)
      this.skipBytes = 0; // PCM of the session to drop first (frames sent again: what was read of the first one; frames not decodable)
      this.resv = 0; this.decodable = false; // (of the session: main data bytes sent so far, a frame decodable sent)
      this.ended = false; // the session was told its end (the input ran dry when its PCM was needed)
      this.prefs = {};
      this.openBytes = null; // what open read, until the first process call reads the start again (see recheckStart)
      this.carry = null; // PCM kept at a seek(-2): the rest of the frame being read
      this.busy = false; this.failedLogged = false;
      this.session = null; // (the host's)
    }
  }
  snapClass(vm, Mp3Stream, { name: 'mss.Mp3Stream', skip: ['session'], init: (s) => { s.session = null; s.busy = false; } });

  const decoders = () => vm.host?.mp3 ?? null;
  const bps = (s) => 2 * s.fmt.ch;
  const scratch = snapKnown(vm, 'mss.mp3.scratch', { buf: 0 }); // (a guest buffer for the fetches)
  const scratchBuf = () => (scratch.buf ||= vm.proc.processHeap.alloc(CHUNK));

  /** fetch(user, dest, bytes, offset) through the guest's callback: the bytes read, appended to inBuf */
  function fetch(c, s, n = CHUNK) {
    const buf = scratchBuf(), off = s.nextOff;
    const r = vm.callGuest(c.thread, s.cb, [s.user, buf, n, off >>> 0]) | 0;
    st.stats.fetches++;
    if (off !== -1) s.inPos = off - s.inBuf.length;
    s.nextOff = -1;
    if (r > 0) {
      st.stats.fetchBytes += r;
      const nb = new Uint8Array(s.inBuf.length + r); nb.set(s.inBuf); nb.set(mem.u8.subarray(buf, buf + r), s.inBuf.length); s.inBuf = nb;
    }
    return Math.max(0, r);
  }

  /** a Layer III frame header at b[i] matching the stream's first one (any, before it): the header, or null */
  function frameAt(s, b, i) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
    const h = mpegAudioHeader(b, i);
    if (!h || h.layer !== 3 || !h.bytes) return null;
    if (s.fmt && (h.version !== s.fmt.version || h.rate !== s.fmt.rate)) return null;
    return h;
  }

  /**
   * A Layer III frame's main_data_begin (how many bytes of its data lie in the frames before it: the bit reservoir) and
   * the bytes of main data it carries (ISO 11172-3 2.4.1.7; 13818-3 for the lower sampling frequencies).
   */
  function mainData(b, i, h) {
    const crc = h.crc ? 2 : 0, p = i + 4 + crc, mono = h.channels === 1;
    const side = h.version === 1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    return { begin: h.version === 1 ? (b[p] << 1) | (b[p + 1] >> 7) : b[p], bytes: h.bytes - 4 - crc - side };
  }

  /** whole frames out of inBuf into `parsed` */
  function parse(s) {
    const b = s.inBuf;
    let i = 0;
    while (i + 4 <= b.length) {
      const h = frameAt(s, b, i);
      if (!h) { i++; s.synced = false; continue; }
      if (i + h.bytes > b.length) break;
      // (finding the stream — its start, or after bytes that are no frame: a header followed by another one, as a
      // header's 11 sync bits occur in frame data too; a reader started mid-stream would decode noise from a false one)
      if (!s.synced) { if (i + h.bytes + 4 > b.length) break; if (!frameAt(s, b, i + h.bytes)) { i++; continue; } s.synced = true; }
      const m = mainData(b, i, h);
      s.parsed.push({ bytes: b.slice(i, i + h.bytes), samples: h.samples, end: s.inPos + i + h.bytes, bitrate: h.bitrate, mdb: m.begin, main: m.bytes });
      i += h.bytes;
    }
    if (i) { s.inBuf = b.slice(i); s.inPos += i; }
  }

  /** a decoding session for the stream (frames sent to a session gone — a restored machine — are sent again) */
  function ensureSession(s) {
    if (s.session) return s.session;
    const d = decoders();
    if (!d) return null;
    s.session = d.open(s.fmt.rate, s.fmt.ch);
    s.sentSamples = 0; s.readSamples = 0; s.ended = false; s.resv = 0; s.decodable = false;
    if (s.sent.length) {
      const skip = s.headDone, head = s.sent[0];
      s.parsed = s.sent.concat(s.parsed); s.sent = []; s.headDone = 0;
      send(s, Infinity);
      if (s.sent[0] === head) { s.skipBytes += skip * bps(s); s.headDone = skip; } // (unless the frame being read is not decodable now: skipped whole)
    }
    return s.session;
  }

  /** send parsed frames while the PCM sent and not read stays under `ahead` samples and fits the ring */
  function send(s, ahead) {
    const ses = s.session, room = ses.cap / bps(s) - 1152;
    let n = 0, len = 0, out = s.sentSamples - s.readSamples;
    while (n < s.parsed.length && out < ahead && out + s.parsed[n].samples <= room) { out += s.parsed[n].samples; len += s.parsed[n].bytes.length; n++; }
    if (!n) return 0;
    const frames = s.parsed.splice(0, n), bytes = new Uint8Array(len), list = [];
    let at = 0;
    for (const f of frames) {
      bytes.set(f.bytes, at); list.push([s.sentSamples, at, f.bytes.length]); at += f.bytes.length; s.sentSamples += f.samples;
      // (a session starting mid-stream — a buffer switched since open, a seek, a restored machine: the frames whose
      // data begins before the session's first byte are not heard, as the original skips them; they still go to the
      // decoder, which keeps their data for the next frames)
      if (!s.decodable && (f.mdb ?? 0) > s.resv) { s.skipBytes += f.samples * bps(s); s.pos = f.end; s.resv += f.main ?? 0; continue; }
      s.decodable = true; s.sent.push(f);
    }
    ses.send(bytes, list);
    decoders().stats.frames += n;
    return n;
  }

  /** samples read back: frames wholly read leave `sent` (the position moves past them) */
  function consumed(s, samples) {
    s.readSamples += samples;
    let k = s.headDone + samples;
    while (s.sent.length && k >= s.sent[0].samples) { k -= s.sent[0].samples; const f = s.sent.shift(); s.pos = f.end; s.bitrate = f.bitrate; }
    s.headDone = k;
  }

  /**
   * keep the decoder ahead of the reader: send what was parsed, fetch more (at most `fetches` times) while short. Nothing
   * is sent until half of what was ahead has been read (a message costs ~10-100 µs: one per ~0.17 s of sound, not per
   * frame — ~1 ms of every RotWK play frame went to messages in Node at a frame per message, profiled).
   */
  function feed(c, s, fetches, force = false) {
    const ahead = AHEAD_S * s.fmt.rate;
    if (!force && s.sentSamples - s.readSamples >= ahead / 2) return;
    for (;;) {
      send(s, ahead);
      if (s.sentSamples - s.readSamples >= ahead || s.ended || s.parsed.length) return; // (enough ahead, or the ring full)
      if (fetches-- <= 0) return;
      const r = fetch(c, s);
      parse(s);
      if (r < CHUNK) { send(s, ahead); return; } // (the source has no more for now)
    }
  }

  function hostOpen(c) {
    const r = open(c);
    if (globalThis.ORTHROS_MP3_LOG) log(`[t${c.thread.id}] open(${hex(c.arg(0))}, ${hex(c.arg(1))}, ${c.arg(2)}) -> ${hex(r)}`);
    return r;
  }
  function open(c) {
    const user = c.arg(0), cb = c.arg(1), total = c.arg(2);
    if (!decoders()) return 0;
    const handle = (STREAM_TAG + (st.nextId++ & 0xfffff)) >>> 0;
    const s = new Mp3Stream(handle, user, cb, total);
    st.stats.opens++;
    // the first header, in the first 4 KiB (as the original, whose search gives up after 4096 bytes)
    fetch(c, s);
    let h = null;
    for (let i = 0; i + 4 <= s.inBuf.length && !h; i++) h = frameAt(s, s.inBuf, i);
    if (!h) return 0;
    s.fmt = { version: h.version, rate: h.rate, ch: h.channels, spf: h.samples };
    s.bitrate = h.bitrate;
    s.openBytes = s.inBuf.slice();
    st.streams.set(handle, s);
    // decoding starts now: the first PCM is ready when the mixer asks for it (it opens a stream a moment before)
    parse(s); ensureSession(s); send(s, AHEAD_S * s.fmt.rate);
    return handle;
  }

  function hostProcess(c) {
    const s = st.streams.get(c.arg(0)), buf = c.arg(1), n = c.arg(2) | 0;
    if (!s || n <= 0) return 0;
    if (s.busy) { mem.fill(buf, n, 0); return 0; } // (re-entered by another thread during a fetch: never seen)
    s.busy = true;
    let got = 0;
    try { if (s.openBytes) recheckStart(c, s); got = processBody(c, s, buf, n - (n % bps(s))); } finally { s.busy = false; }
    st.stats.process++; st.stats.bytes += got;
    if (got < n) mem.fill(buf + got, n - got, 0); // (the original fills the rest of the request with silence)
    if (got < n && globalThis.ORTHROS_MP3_LOG) log(`[t${c.thread.id}] process(${hex(s.handle)}, ${n}) -> ${got}`);
    return got;
  }
  /**
   * The original's first process call reads its input from offset 0 again: mss32's offsets are within its current
   * buffer, which a streamed sample may have loaded or switched since open. Read the start again; the same bytes: go on
   * with what was sent; other bytes: decode from those (the session started at open is dropped).
   */
  function recheckStart(c, s) {
    const n = s.openBytes.length, buf = scratchBuf();
    const r = vm.callGuest(c.thread, s.cb, [s.user, buf, n, 0]) | 0;
    st.stats.fetches++;
    const now = mem.u8.slice(buf, buf + Math.max(0, r)), was = s.openBytes;
    s.openBytes = null;
    if (r === n && now.every((b, i) => b === was[i])) return;
    st.stats.restarts++;
    s.session?.close(); s.session = null; s.parsed = []; s.sent = []; s.headDone = 0; s.skipBytes = 0;
    s.inBuf = now; s.inPos = 0; s.nextOff = -1; s.pos = 0; s.synced = false;
    parse(s);
  }
  function processBody(c, s, buf, n) {
    const B = bps(s);
    let ses = ensureSession(s), got = 0, fetches = 2, waited = 0;
    if (!ses) return 0;
    const dst = mem.u8.subarray(buf, buf + n);
    if (s.carry) { // (the rest of the frame being read at a seek(-2))
      const k = Math.min(n, s.carry.length); dst.set(s.carry.subarray(0, k)); got = k;
      s.carry = k < s.carry.length ? s.carry.slice(k) : null;
      if (got >= n) return got;
    }
    for (;;) {
      if (s.skipBytes) { const k = ses.skip(s.skipBytes); s.skipBytes -= k; s.readSamples += k / B; }
      if (!s.skipBytes) { const k = ses.take(dst.subarray(got), n - got); if (k) { got += k; consumed(s, k / B); } }
      if (got >= n) break;
      const state = ses.state();
      if (state === ST_FAILED) { failed(s); break; }
      if (state === ST_DONE && ses.available() <= 0) {
        // every frame of the session read: more input since (a source refilled)? a new session for it
        if (!s.parsed.length && fetch(c, s) > 0) parse(s);
        if (!s.parsed.length) break;
        ses.close(); s.session = null; ses = ensureSession(s); send(s, AHEAD_S * s.fmt.rate);
        continue;
      }
      if (s.skipBytes || s.sentSamples > s.readSamples) {
        // PCM sent, not decoded yet: more for the decoder first (one may hold a frame until the next comes), then a
        // short wait; with nothing more to give it, the session is finished (its decoder flushes; later input goes
        // to a new session)
        if (!s.ended) feed(c, s, fetches--, true);
        if (ses.wait(WAIT_SLICE_MS)) { waited = 0; continue; }
        waited += WAIT_SLICE_MS;
        if (!s.ended && !s.parsed.length && waited >= FLUSH_AFTER_MS) { s.ended = true; ses.end(s.sentSamples); }
        if (waited >= WAIT_MS) { failed(s); break; }
        continue;
      }
      // nothing left to read back: more input, or the end of what the source has (the session told to finish)
      if (!s.ended) { feed(c, s, Math.max(1, fetches)); fetches = 0; if (s.sentSamples > s.readSamples) continue; }
      if (!s.ended) { s.ended = true; ses.end(s.sentSamples); }
      if (ses.wait(WAIT_SLICE_MS)) { waited = 0; continue; }
      if ((waited += WAIT_SLICE_MS) >= WAIT_MS) { failed(s); break; }
    }
    if (!s.ended && s.session) feed(c, s, fetches);
    return got;
  }
  function failed(s) {
    if (!s.failedLogged) { s.failedLogged = true; log(`stream 0x${s.handle.toString(16)}: the host decoder failed or did not answer; silence from here`); }
    s.session?.close(); s.session = null; s.sent = []; s.parsed = []; s.inBuf = new Uint8Array(0); s.headDone = 0;
  }

  function hostSeek(c) {
    const s = st.streams.get(c.arg(0)), pos = c.arg(1) | 0;
    if (!s) return 0;
    st.stats.seeks++;
    if (globalThis.ORTHROS_MP3_LOG) log(`[t${c.thread.id}] seek(${hex(c.arg(0))}, ${pos})`);
    // -2: mss32 moved its source on its own (a stream looping, its buffers loaded again): the original clears its
    // decoder's state (bit reservoir, synthesis), keeps the rest of the frame it was reading out, and reads on from the
    // source — whose next bytes are the new ones, not those this host had fetched ahead: those are dropped. Any other
    // value: everything dropped, reading from that offset of the source.
    const ses = s.session, B = s.fmt ? bps(s) : 4;
    const rest = pos === -2 && ses && s.sent.length && s.headDone ? (s.sent[0].samples - s.headDone) * B : 0;
    if (rest && ses.available() >= rest) { const k = new Uint8Array(rest); ses.take(k, rest); s.carry = k; s.pos = s.sent[0].end; }
    ses?.close(); s.session = null;
    s.parsed = []; s.sent = []; s.headDone = 0; s.inBuf = new Uint8Array(0); s.synced = false; s.ended = false; s.skipBytes = 0;
    if (pos !== -2) { s.nextOff = pos; s.pos = pos; s.inPos = pos; s.carry = null; } else s.nextOff = -1;
    return 0;
  }

  function hostClose(c) {
    const s = st.streams.get(c.arg(0));
    if (globalThis.ORTHROS_MP3_LOG) log(`[t${c.thread.id}] close(${hex(c.arg(0))})`);
    if (s) { s.session?.close(); st.streams.delete(c.arg(0)); }
    return 0;
  }

  const PREFS = new Set(['Requested sample rate', 'Requested bit width', 'Requested # of channels']);
  function hostAttribute(c) {
    const r = attribute(c);
    if (globalThis.ORTHROS_MP3_TRACE_ATTR) log(`[t${c.thread.id}] attribute(${hex(c.arg(0))}, ${provOf().tokens[c.arg(1)] ?? c.arg(1)}) -> ${hex(r)}`);
    return r;
  }
  function attribute(c) {
    const s = st.streams.get(c.arg(0)), name = provOf().tokens[c.arg(1)];
    if (!s) return 0xffffffff;
    const { rate, ch, version } = s.fmt, pos = (s.headDone > 0 && s.sent.length ? s.sent[0].end : s.pos) >>> 0; // (as the original's: past the frame being read)
    switch (name) {
      case 'Input bit rate': return s.bitrate;
      case 'Input sample rate': case 'Output sample rate': return rate;
      case 'Input sample width': return (16 / Math.max(1, Math.trunc(rate * ch * 16 / Math.max(1, s.bitrate)))) | 0;
      case 'Input channels': case 'Output channels': return ch;
      case 'Output bit rate': return rate * ch * 16;
      case 'Output sample width': return 16;
      case 'Position': return pos;
      case 'Percent done': { if (!pos || !s.total) return 0; f32[0] = pos * 100 / (s.total >>> 0); return f32u[0]; }
      case 'Minimum input block size': return 0x1000;
      case 'MPEG version': return version === 1 ? 1 : 2;
      case 'MPEG layer': return 3;
      default: return PREFS.has(name) ? (s.prefs[name] ?? -1) >>> 0 : 0xffffffff;
    }
  }
  function hostSetPreference(c) {
    const s = st.streams.get(c.arg(0)), name = provOf().tokens[c.arg(1)];
    if (!s || !PREFS.has(name)) return 0xffffffff;
    const prev = s.prefs[name] ?? -1;
    s.prefs[name] = mem.read32(c.arg(2)) | 0;
    return prev >>> 0;
  }
  const hostFns = { ASI_stream_open: hostOpen, ASI_stream_process: hostProcess, ASI_stream_seek: hostSeek, ASI_stream_close: hostClose, ASI_stream_attribute: hostAttribute, ASI_stream_set_preference: hostSetPreference }; // snapshot: constant
}
