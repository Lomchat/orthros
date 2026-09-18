// AudioWorklet output: pulls stereo float frames from the shared ring filled by the worker.
class OrthrosOutput extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions;
    this.ring = new Float32Array(p.audio);
    this.ctl = new Int32Array(p.ctl);
    this.frames = p.frames; this.W = p.write; this.R = p.read; this.U = p.underruns;
  }
  process(inputs, outputs) {
    const out = outputs[0], l = out[0], r = out[1] ?? out[0];
    const n = l.length;
    let rd = Atomics.load(this.ctl, this.R);
    const wr = Atomics.load(this.ctl, this.W);
    let avail = (wr - rd) | 0;
    if (avail < n) { Atomics.add(this.ctl, this.U, 1); l.fill(0); r.fill(0); return true; }
    for (let i = 0; i < n; i++) { const idx = ((rd + i) % this.frames) * 2; l[i] = this.ring[idx]; r[i] = this.ring[idx + 1]; }
    rd = (rd + n) | 0;
    Atomics.store(this.ctl, this.R, rd);
    return true;
  }
}
registerProcessor('orthros-output', OrthrosOutput);
