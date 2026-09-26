// AudioWorklet output. Two modes:
// - ring: stereo float frames produced by the game's worker (its DirectSound mixer) are pulled from a shared ring;
// - direct (once the worker sends the voice table and the guest memory, both shared): the DirectSound buffers are
//   mixed here, on the audio thread, straight from guest memory, following the play cursors the worker publishes
//   (dsound.js, VOICE_BASE): a busy game worker (loading, a long frame) no longer starves the output — like a sound
//   card reading its buffers by DMA while the program does something else.
const VOICE_BASE = 16, VOICE_INTS = 16, MAX_VOICES = 128; // (dsound.js: the same layout)

class OrthrosOutput extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions;
    this.ring = new Float32Array(p.audio);
    this.ctl = new Int32Array(p.ctl);
    this.frames = p.frames; this.W = p.write; this.R = p.read; this.U = p.underruns;
    this.direct = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'voices') return;
      this.u8 = new Uint8Array(m.memory); this.i16 = new Int16Array(m.memory); this.f32 = new Float32Array(m.memory);
      this.v = new Int32Array(m.voices); this.vf = new Float32Array(m.voices);
      this.pos = new Float64Array(MAX_VOICES); this.gens = new Int32Array(MAX_VOICES).fill(-1); this.done = new Uint8Array(MAX_VOICES);
      this.direct = true;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], l = out[0], r = out[1] ?? out[0];
    const n = l.length;
    if (this.direct) { this.mix(l, r, n); return true; }
    let rd = Atomics.load(this.ctl, this.R);
    const wr = Atomics.load(this.ctl, this.W);
    let avail = (wr - rd) | 0;
    if (avail < n) { if (wr !== 0) Atomics.add(this.ctl, this.U, 1); l.fill(0); r.fill(0); return true; } // (before the first write the game has no sound yet: not an underrun)
    for (let i = 0; i < n; i++) { const idx = ((rd + i) % this.frames) * 2; l[i] = this.ring[idx]; r[i] = this.ring[idx + 1]; }
    rd = (rd + n) | 0;
    Atomics.store(this.ctl, this.R, rd);
    return true;
  }
  mix(l, r, n) {
    l.fill(0); r.fill(0);
    const V = this.v;
    for (let i = 0; i < MAX_VOICES; i++) if (V[VOICE_BASE + i * VOICE_INTS] === 1) this.voice(i, l, r, n);
    let peak = this.vf[1];
    for (let k = 0; k < n; k++) { const a = Math.max(Math.abs(l[k]), Math.abs(r[k])); if (a > peak) peak = a; }
    this.vf[1] = peak;
    V[0] = (V[0] + n) | 0; // (frame counter: the worker publishes cursors with its value)
    V[2] = 1;
  }
  voice(i, l, r, n) {
    const V = this.v, o = VOICE_BASE + i * VOICE_INTS;
    const gen = Atomics.load(V, o + 1);
    const addr = V[o + 2], size = V[o + 3], align = V[o + 4], bits = V[o + 5], ch = V[o + 6], isF = V[o + 7], freq = V[o + 8], loop = V[o + 9];
    const gl = this.vf[o + 10], gr = this.vf[o + 11], cursor = V[o + 12], pub = V[o + 13];
    if (Atomics.load(V, o + 1) !== gen || !size || !align || !freq) return; // (being rewritten: next quantum)
    const total = Math.floor(size / align), step = freq / sampleRate;
    if (this.gens[i] !== gen) { this.gens[i] = gen; this.pos[i] = cursor / align; this.done[i] = 0; } // (started, moved: from the cursor)
    else {
      // follow the cursor when it was published recently (a worker that stalls publishes nothing: the mix goes on)
      const age = (V[0] - pub) | 0;
      if (age >= 0 && age < sampleRate * 0.2) {
        let expected = cursor / align + age * step;
        if (loop) expected %= total;
        let lag = expected - this.pos[i];
        if (loop) { lag = ((lag % total) + total) % total; if (lag > total / 2) lag -= total; }
        if (Math.abs(lag) > Math.min(freq * 0.08, total * 0.25)) { this.pos[i] = expected; this.done[i] = 0; } // (80 ms, a quarter of a short loop)
      }
    }
    if (this.done[i] || (gl === 0 && gr === 0 && !loop)) { if (!this.done[i]) this.pos[i] += n * step; return; }
    const bytes = bits >> 3, u8 = this.u8, i16 = this.i16, f32 = this.f32;
    const sample = (fi, c) => {
      const a = addr + fi * align + (ch === 1 ? 0 : c * bytes);
      return isF ? f32[a >> 2] : bits === 8 ? (u8[a] - 128) / 128 : i16[a >> 1] / 32768;
    };
    let frame = this.pos[i];
    for (let k = 0; k < n; k++) {
      let fi = Math.floor(frame);
      if (fi >= total) { if (!loop) { this.done[i] = 1; break; } frame -= total; fi -= total; }
      const t = frame - fi, fj = fi + 1 < total ? fi + 1 : loop ? 0 : fi;
      const l0 = sample(fi, 0), l1 = sample(fj, 0), r0 = ch > 1 ? sample(fi, 1) : l0, r1 = ch > 1 ? sample(fj, 1) : l1;
      l[k] += (l0 + (l1 - l0) * t) * gl; r[k] += (r0 + (r1 - r0) * t) * gr;
      frame += step;
    }
    this.pos[i] = loop ? frame % total : frame;
  }
}
registerProcessor('orthros-output', OrthrosOutput);
