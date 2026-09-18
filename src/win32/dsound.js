// dsound.dll: DirectSound 8 — device object, primary/secondary buffers over guest memory, play
// cursor driven by the audio clock (host mixer pull) or by the VM clock (headless), position
// notifications, volume/pan/frequency, software mixing to a float stereo stream for the host.
import { readGuid, S_OK, S_FALSE, E_NOINTERFACE, E_POINTER } from './com.js';

const DS_OK = 0, DSERR_ALLOCATED = 0x8878000a, DSERR_CONTROLUNAVAIL = 0x8878001e, DSERR_INVALIDPARAM = 0x80070057, DSERR_INVALIDCALL = 0x88780032, DSERR_PRIOLEVELNEEDED = 0x88780046, DSERR_OUTOFMEMORY = 0x8007000e, DSERR_BADFORMAT = 0x88780064, DSERR_UNSUPPORTED = 0x80004001, DSERR_NODRIVER = 0x88780078, DSERR_BUFFERLOST = 0x88780096, DSERR_UNINITIALIZED = 0x887800aa;
const IID_IDirectSound = '279afa83-4981-11ce-a521-0020af0be560', IID_IDirectSound8 = 'c50a7e93-f395-4834-9ef6-7fa99de50966';
const IID_IDirectSoundBuffer = '279afa85-4981-11ce-a521-0020af0be560', IID_IDirectSoundBuffer8 = '6825a449-7524-4d82-920f-50e36ab3ab40', IID_IDirectSoundNotify = 'b0aa1afe-3d0d-11d1-8c6a-00c04f8ef5ad';
const CLSID_DirectSound = '47d4d946-62e8-11cf-93bc-444553540000', CLSID_DirectSound8 = '3901cc3f-84b5-4fa4-ba35-aa8172b8a09b';
const DSBCAPS_PRIMARYBUFFER = 1, DSBCAPS_STATIC = 2, DSBCAPS_LOCHARDWARE = 4, DSBCAPS_LOCSOFTWARE = 8, DSBCAPS_CTRL3D = 0x10, DSBCAPS_CTRLFREQUENCY = 0x20, DSBCAPS_CTRLPAN = 0x40, DSBCAPS_CTRLVOLUME = 0x80, DSBCAPS_CTRLPOSITIONNOTIFY = 0x100, DSBCAPS_GLOBALFOCUS = 0x8000, DSBCAPS_GETCURRENTPOSITION2 = 0x10000;
const DSBSTATUS_PLAYING = 1, DSBSTATUS_BUFFERLOST = 2, DSBSTATUS_LOOPING = 4, DSBSTATUS_LOCSOFTWARE = 0x10;
const DSBPLAY_LOOPING = 1, DSBLOCK_FROMWRITECURSOR = 1, DSBLOCK_ENTIREBUFFER = 2;
const DSSCL_NORMAL = 1, DSSCL_PRIORITY = 2, DSSCL_EXCLUSIVE = 3, DSSCL_WRITEPRIMARY = 4;
const WAVE_FORMAT_PCM = 1, WAVE_FORMAT_IEEE_FLOAT = 3, WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const DEVICE_RATE = 44100;

function readWfx(mem, a) {
  const tag = mem.read16(a), channels = mem.read16(a + 2), rate = mem.read32(a + 4), avg = mem.read32(a + 8), align = mem.read16(a + 12), bits = mem.read16(a + 14), cb = mem.read16(a + 16);
  let subTag = tag;
  if (tag === WAVE_FORMAT_EXTENSIBLE && cb >= 22) subTag = mem.read32(a + 24) === 3 ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
  return { tag: subTag, channels, rate, avg: avg || align * rate, align: align || (channels * bits) >> 3, bits, cb, raw: mem.bytes(a, 18 + Math.min(cb, 64)).slice() };
}
function writeWfx(mem, a, f) {
  mem.write16(a, f.tag === WAVE_FORMAT_IEEE_FLOAT ? 3 : 1); mem.write16(a + 2, f.channels); mem.write32(a + 4, f.rate); mem.write32(a + 8, f.align * f.rate); mem.write16(a + 12, f.align); mem.write16(a + 14, f.bits); mem.write16(a + 16, 0);
}
const dbToGain = (v) => (v <= -10000 ? 0 : Math.pow(10, v / 2000));

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerDirectSound(api, vm) {
  const mem = vm.mem, com = vm.com;
  com.interface('IDirectSound', IID_IDirectSound, 'IUnknown', [['CreateSoundBuffer', 3], ['GetCaps', 1], ['DuplicateSoundBuffer', 2], ['SetCooperativeLevel', 2], ['Compact', 0], ['GetSpeakerConfig', 1], ['SetSpeakerConfig', 1], ['Initialize', 1]]);
  com.interface('IDirectSound8', IID_IDirectSound8, 'IDirectSound', [['VerifyCertification', 1]]);
  com.interface('IDirectSoundBuffer', IID_IDirectSoundBuffer, 'IUnknown', [['GetCaps', 1], ['GetCurrentPosition', 2], ['GetFormat', 3], ['GetVolume', 1], ['GetPan', 1], ['GetFrequency', 1], ['GetStatus', 1], ['Initialize', 2], ['Lock', 7], ['Play', 3], ['SetCurrentPosition', 1], ['SetFormat', 1], ['SetVolume', 1], ['SetPan', 1], ['SetFrequency', 1], ['Stop', 0], ['Unlock', 4], ['Restore', 0]]);
  com.interface('IDirectSoundBuffer8', IID_IDirectSoundBuffer8, 'IDirectSoundBuffer', [['SetFX', 3], ['AcquireResources', 3], ['GetObjectInPath', 4]]);
  com.interface('IDirectSoundNotify', IID_IDirectSoundNotify, 'IUnknown', [['SetNotificationPositions', 2]]);

  /** Mixer state shared by all DirectSound objects of the process (one audio device). */
  class Audio {
    constructor() {
      this.buffers = new Set();
      this.format = { tag: 1, channels: 2, rate: 22050, bits: 16, align: 4, avg: 88200 };
      this.audioClock = null; // seconds rendered by the host mixer (null: headless, VM clock drives cursors)
      vm.audio = this;
    }
    /** Render `frames` stereo float frames at `rate` into `out` (interleaved), advancing the buffers. */
    render(out, frames, rate = DEVICE_RATE) {
      out.fill(0, 0, frames * 2);
      const dt = frames / rate;
      for (const b of this.buffers) if (b.playing) b.mixInto(out, frames, rate);
      this.audioClock = (this.audioClock ?? 0) + dt;
      for (const b of this.buffers) b.checkNotifications();
      return out;
    }
    /** Headless: advance cursors from the VM clock. */
    tick() { if (this.audioClock === null) for (const b of this.buffers) if (b.playing) b.advanceTo(vm.clock.now() / 1000); }
  }
  const audio = () => vm.audio ?? new Audio();
  const signalEvent = (h) => { const o = vm.proc.handles.getAs(h, 'event'); if (o) o.signaled = true; };

  class Buffer {
    constructor(proc, ds, flags, bytes, fmt) {
      this.proc = proc; this.ds = ds; this.flags = flags; this.size = bytes; this.fmt = fmt;
      this.primary = (flags & DSBCAPS_PRIMARYBUFFER) !== 0;
      this.mem = bytes ? proc.vmem.alloc(Math.max(bytes, 4096), 4, 'dsound') : 0;
      if (this.mem) mem.fill(this.mem, bytes, fmt.bits === 8 ? 0x80 : 0);
      this.playing = false; this.looping = false;
      this.pos = 0; // play cursor in bytes (fractional frames kept in posFrac)
      this.posFrac = 0;
      this.lastTime = 0; // VM clock seconds at last headless advance
      this.volume = 0; this.pan = 0; this.freq = fmt.rate;
      this.locks = 0; this.notifies = [];
      this.iids = [IID_IDirectSoundBuffer, IID_IDirectSoundBuffer8];
      this.stoppedEvents = [];
      audio().buffers.add(this);
    }
    destroy() { audio().buffers.delete(this); if (this.mem) this.proc.vmem.release(this.mem); }
    queryInterface(c, iid) {
      if (iid === IID_IDirectSoundNotify) { if (!this.notifyPtr || !com.objectAt(this.notifyPtr)) this.notifyPtr = com.create(c.proc, 'IDirectSoundNotify', { buffer: this, SetNotificationPositions: (cc) => this.setNotifications(cc) }); else com.addRef(com.objectAt(this.notifyPtr)); return this.notifyPtr; }
      return 0;
    }
    get bytesPerSec() { return this.fmt.align * this.freq; }
    /** advance the play cursor by `frames` sample frames of this buffer */
    advanceFrames(frames) {
      if (!this.playing) return;
      let p = this.pos + frames * this.fmt.align;
      if (p >= this.size) { if (this.looping) p %= this.size; else { p = 0; this.playing = false; this.onStop(); } }
      this.pos = p;
    }
    advanceTo(nowSec) {
      const dt = Math.max(0, nowSec - this.lastTime); this.lastTime = nowSec;
      const f = dt * this.freq + this.posFrac; const whole = Math.floor(f); this.posFrac = f - whole;
      this.advanceFrames(whole);
      this.checkNotifications();
    }
    cursor() { audio().tick(); return this.pos; }
    writeCursor() { if (!this.playing) return this.pos; const lead = Math.ceil(this.bytesPerSec * 0.015 / this.fmt.align) * this.fmt.align; return (this.pos + lead) % this.size; }
    onStop() { for (const n of this.notifies) if (n.offset === 0xffffffff) signalEvent(n.event); }
    checkNotifications() {
      if (!this.notifies.length) return;
      const prev = this.notifyPos ?? 0, cur = this.pos;
      for (const n of this.notifies) {
        if (n.offset === 0xffffffff) continue;
        const hit = prev <= cur ? (n.offset > prev && n.offset <= cur) : (n.offset > prev || n.offset <= cur);
        if (hit && this.playing) signalEvent(n.event);
      }
      this.notifyPos = cur;
    }
    setNotifications(c) {
      const n = c.arg(1), p = c.arg(2);
      if (!(this.flags & DSBCAPS_CTRLPOSITIONNOTIFY)) return DSERR_CONTROLUNAVAIL;
      if (this.playing) return DSERR_INVALIDCALL;
      this.notifies = [];
      for (let i = 0; i < n; i++) this.notifies.push({ offset: mem.read32(p + 8 * i), event: mem.read32(p + 8 * i + 4) });
      this.notifyPos = this.pos;
      return DS_OK;
    }
    /** mix this buffer into a stereo float stream (linear resampling, volume/pan applied) */
    mixInto(out, frames, rate) {
      const f = this.fmt, step = this.freq / rate;
      const gain = dbToGain(this.volume), gl = gain * (this.pan > 0 ? dbToGain(-this.pan) : 1), gr = gain * (this.pan < 0 ? dbToGain(this.pan) : 1);
      const base = this.mem, size = this.size, align = f.align;
      const totalFrames = Math.floor(size / align);
      let frame = this.pos / align + this.posFrac;
      const sample = (fi, ch) => {
        const a = base + (fi % totalFrames) * align + (f.channels === 1 ? 0 : ch) * (f.bits >> 3);
        if (f.tag === WAVE_FORMAT_IEEE_FLOAT) return mem.readF32(a);
        return f.bits === 8 ? (mem.u8[a] - 128) / 128 : mem.readS16(a) / 32768;
      };
      for (let i = 0; i < frames; i++) {
        const fi = Math.floor(frame), t = frame - fi;
        if (fi >= totalFrames && !this.looping) { this.pos = 0; this.posFrac = 0; this.playing = false; this.onStop(); return; }
        const l0 = sample(fi, 0), l1 = sample(fi + 1, 0);
        const r0 = f.channels > 1 ? sample(fi, 1) : l0, r1 = f.channels > 1 ? sample(fi + 1, 1) : l1;
        out[2 * i] += (l0 + (l1 - l0) * t) * gl; out[2 * i + 1] += (r0 + (r1 - r0) * t) * gr;
        frame += step;
      }
      const whole = Math.floor(frame);
      this.posFrac = frame - whole;
      this.pos = (this.looping ? whole % totalFrames : Math.min(whole, totalFrames)) * align;
      if (!this.looping && whole >= totalFrames) { this.pos = 0; this.playing = false; this.onStop(); }
    }
    // ---- IDirectSoundBuffer
    GetCaps(c) { const p = c.arg(1); if (!p || mem.read32(p) < 20) return DSERR_INVALIDPARAM; mem.write32(p + 4, this.flags | DSBCAPS_LOCSOFTWARE); mem.write32(p + 8, this.size); mem.write32(p + 12, 0); mem.write32(p + 16, 0); return DS_OK; }
    GetCurrentPosition(c) { const cur = this.cursor(); if (c.arg(1)) mem.write32(c.arg(1), cur); if (c.arg(2)) mem.write32(c.arg(2), this.writeCursor()); return DS_OK; }
    GetFormat(c) {
      const p = c.arg(1), size = c.arg(2), pw = c.arg(3);
      const need = 18;
      if (pw) mem.write32(pw, need);
      if (p) { if (size < 16) return DSERR_INVALIDPARAM; writeWfx(mem, p, this.fmt); if (size >= 18) mem.write16(p + 16, 0); }
      return DS_OK;
    }
    GetVolume(c) { if (!(this.flags & DSBCAPS_CTRLVOLUME)) return DSERR_CONTROLUNAVAIL; c.out32(1, this.volume); return DS_OK; }
    GetPan(c) { if (!(this.flags & DSBCAPS_CTRLPAN)) return DSERR_CONTROLUNAVAIL; c.out32(1, this.pan); return DS_OK; }
    GetFrequency(c) { if (!(this.flags & DSBCAPS_CTRLFREQUENCY)) return DSERR_CONTROLUNAVAIL; c.out32(1, this.freq); return DS_OK; }
    GetStatus(c) { this.cursor(); c.out32(1, (this.playing ? DSBSTATUS_PLAYING : 0) | (this.looping && this.playing ? DSBSTATUS_LOOPING : 0) | DSBSTATUS_LOCSOFTWARE); return DS_OK; }
    Initialize() { return DSERR_ALLOCATED; }
    Lock(c) {
      let offset = c.arg(1), bytes = c.arg(2); const pp1 = c.arg(3), pb1 = c.arg(4), pp2 = c.arg(5), pb2 = c.arg(6), flags = c.arg(7);
      if (this.primary && this.ds.coop < DSSCL_WRITEPRIMARY) return DSERR_PRIOLEVELNEEDED;
      if (!pp1 || !pb1) return DSERR_INVALIDPARAM;
      if (flags & DSBLOCK_FROMWRITECURSOR) offset = this.writeCursor();
      if (flags & DSBLOCK_ENTIREBUFFER) bytes = this.size;
      if (offset >= this.size || bytes > this.size) return DSERR_INVALIDPARAM;
      const first = Math.min(bytes, this.size - offset), second = bytes - first;
      mem.write32(pp1, this.mem + offset); mem.write32(pb1, first);
      if (pp2) mem.write32(pp2, second ? this.mem : 0); if (pb2) mem.write32(pb2, second);
      this.locks++;
      return DS_OK;
    }
    Play(c) {
      const flags = c.arg(3);
      if (this.primary) { this.playing = true; this.looping = true; return DS_OK; }
      this.looping = (flags & DSBPLAY_LOOPING) !== 0;
      if (!this.playing) { this.playing = true; this.lastTime = vm.clock.now() / 1000; this.notifyPos = this.pos; }
      return DS_OK;
    }
    SetCurrentPosition(c) { const p = c.arg(1); if (p >= this.size) return DSERR_INVALIDPARAM; this.pos = p - (p % this.fmt.align); this.posFrac = 0; this.notifyPos = this.pos; return DS_OK; }
    SetFormat(c) {
      if (!this.primary) return DSERR_INVALIDCALL;
      if (this.ds.coop < DSSCL_PRIORITY) return DSERR_PRIOLEVELNEEDED;
      const f = readWfx(mem, c.arg(1));
      if (!f.channels || !f.rate || !f.bits) return DSERR_BADFORMAT;
      this.fmt = f; audio().format = f;
      vm.log('audio', `dsound: primary format ${f.rate} Hz ${f.bits}-bit ${f.channels}ch`);
      return DS_OK;
    }
    SetVolume(c) { if (!(this.flags & DSBCAPS_CTRLVOLUME) && !this.primary) return DSERR_CONTROLUNAVAIL; const v = c.sarg(1); if (v > 0 || v < -10000) return DSERR_INVALIDPARAM; this.volume = v; return DS_OK; }
    SetPan(c) { if (!(this.flags & DSBCAPS_CTRLPAN)) return DSERR_CONTROLUNAVAIL; const v = c.sarg(1); if (v > 10000 || v < -10000) return DSERR_INVALIDPARAM; this.pan = v; return DS_OK; }
    SetFrequency(c) { if (!(this.flags & DSBCAPS_CTRLFREQUENCY)) return DSERR_CONTROLUNAVAIL; const v = c.arg(1); if (v && (v < 100 || v > 200000)) return DSERR_INVALIDPARAM; this.cursor(); this.freq = v || this.fmt.rate; return DS_OK; }
    Stop() { if (this.primary) return DS_OK; this.cursor(); if (this.playing) { this.playing = false; this.onStop(); } return DS_OK; }
    Unlock() { if (this.locks > 0) this.locks--; return DS_OK; }
    Restore() { return DS_OK; }
    SetFX() { return DSERR_CONTROLUNAVAIL; }
    AcquireResources() { return DS_OK; }
    GetObjectInPath(c) { c.out32(4, 0); return E_NOINTERFACE; }
  }

  class DirectSound {
    constructor(v8) { this.v8 = v8; this.coop = DSSCL_NORMAL; this.primary = null; this.iids = [IID_IDirectSound, IID_IDirectSound8]; this.initialized = true; }
    CreateSoundBuffer(c) {
      const desc = c.arg(1), pp = c.arg(2);
      if (!desc || !pp) return DSERR_INVALIDPARAM;
      mem.write32(pp, 0);
      const size = mem.read32(desc), flags = mem.read32(desc + 4), bytes = mem.read32(desc + 8), pwfx = mem.read32(desc + 16);
      if (size < 20) return DSERR_INVALIDPARAM;
      if (flags & DSBCAPS_PRIMARYBUFFER) {
        if (bytes || pwfx) return DSERR_INVALIDPARAM;
        if (!this.primary || !com.objectAt(this.primary)) {
          const b = new Buffer(c.proc, this, flags, 0, audio().format);
          this.primary = com.create(c.proc, 'IDirectSoundBuffer', b);
        } else com.addRef(com.objectAt(this.primary));
        mem.write32(pp, this.primary);
        return DS_OK;
      }
      if (!pwfx || bytes < 4) return DSERR_INVALIDPARAM;
      const fmt = readWfx(mem, pwfx);
      if ((fmt.tag !== WAVE_FORMAT_PCM && fmt.tag !== WAVE_FORMAT_IEEE_FLOAT) || !fmt.channels || !fmt.rate || !fmt.align) return DSERR_BADFORMAT;
      const b = new Buffer(c.proc, this, flags, bytes - (bytes % fmt.align), fmt);
      if (!b.mem) return DSERR_OUTOFMEMORY;
      mem.write32(pp, com.create(c.proc, this.v8 ? 'IDirectSoundBuffer8' : 'IDirectSoundBuffer', b));
      vm.log('audio', `dsound: buffer ${bytes} bytes ${fmt.rate} Hz ${fmt.bits}-bit ${fmt.channels}ch flags 0x${flags.toString(16)}`);
      return DS_OK;
    }
    GetCaps(c) {
      const p = c.arg(1); if (!p || mem.read32(p) < 96) return DSERR_INVALIDPARAM;
      mem.fill(p + 4, 92, 0);
      mem.write32(p + 4, 0x1 | 0x20 | 0x40 | 0x80 | 0x100 | 0x400); // PRIMARYMONO|STEREO|8BIT|16BIT|CONTINUOUSRATE|SECONDARY*
      mem.write32(p + 8, 100); mem.write32(p + 12, 200000); mem.write32(p + 16, 1);
      mem.write32(p + 76, 0x7fffffff); mem.write32(p + 80, 0x7fffffff); // free hw memory
      return DS_OK;
    }
    DuplicateSoundBuffer(c) {
      const src = com.implAt(c.arg(1)), pp = c.arg(2);
      if (!(src instanceof Buffer) || !pp || src.primary) return DSERR_INVALIDPARAM;
      const b = new Buffer(c.proc, this, src.flags, src.size, src.fmt);
      if (!b.mem) return DSERR_OUTOFMEMORY;
      mem.copy(b.mem, src.mem, src.size);
      b.volume = src.volume; b.pan = src.pan; b.freq = src.freq;
      mem.write32(pp, com.create(c.proc, this.v8 ? 'IDirectSoundBuffer8' : 'IDirectSoundBuffer', b));
      return DS_OK;
    }
    SetCooperativeLevel(c) { this.coop = c.arg(2); vm.log('audio', `dsound: cooperative level ${this.coop}`); return DS_OK; }
    Compact() { return DS_OK; }
    GetSpeakerConfig(c) { c.out32(1, 4 /* DSSPEAKER_STEREO */); return DS_OK; }
    SetSpeakerConfig() { return DS_OK; }
    Initialize() { return this.initialized ? DSERR_ALLOCATED : DS_OK; }
    VerifyCertification(c) { c.out32(1, 0 /* DS_UNCERTIFIED */); return DS_OK; }
  }

  const create = (c, outArg, v8) => {
    const pp = c.arg(outArg);
    if (!pp) return DSERR_INVALIDPARAM;
    if (c.arg(2) && outArg === 1) return 0x80040110; // aggregation
    const ds = new DirectSound(v8);
    mem.write32(pp, com.create(c.proc, v8 ? 'IDirectSound8' : 'IDirectSound', ds));
    vm.firstD3DCall ??= { name: v8 ? 'DirectSoundCreate8' : 'DirectSoundCreate', from: c.proc.symbolize(c.retAddr), apiCalls: vm.apiCalls };
    vm.log('audio', `DirectSoundCreate${v8 ? '8' : ''} from ${c.proc.symbolize(c.retAddr)}`);
    return DS_OK;
  };
  const enumerate = (c, w) => {
    const cb = c.arg(0), ctx = c.arg(1);
    if (!cb) return DSERR_INVALIDPARAM;
    const buf = c.proc.processHeap.alloc(0x200);
    const desc = buf, mod = buf + 0x100;
    if (w) { mem.writeWString(desc, 'Primary Sound Driver', 120); mem.writeWString(mod, '', 4); } else { mem.writeCString(desc, 'Primary Sound Driver', 120); mem.writeCString(mod, '', 4); }
    try { vm.callGuest(c.thread, cb, [0, desc, mod, ctx]); } finally { c.proc.processHeap.free_(buf); }
    return DS_OK;
  };
  api.define('dsound.dll', {
    DirectSoundCreate: [3, (c) => create(c, 1, false)],
    DirectSoundCreate8: [3, (c) => create(c, 1, true)],
    DirectSoundEnumerateA: [2, (c) => enumerate(c, false)],
    DirectSoundEnumerateW: [2, (c) => enumerate(c, true)],
    DirectSoundCaptureCreate: [3, (c) => { c.out32(1, 0); return DSERR_NODRIVER; }],
    DirectSoundCaptureCreate8: [3, (c) => { c.out32(1, 0); return DSERR_NODRIVER; }],
    DirectSoundCaptureEnumerateA: [2, () => DS_OK], DirectSoundCaptureEnumerateW: [2, () => DS_OK],
    DirectSoundFullDuplexCreate: [10, () => DSERR_NODRIVER],
    GetDeviceID: [2, (c) => { if (c.arg(1)) mem.fill(c.arg(1), 16, 0); return DS_OK; }],
    DllGetClassObject: [3, () => 0x80040111], DllCanUnloadNow: [0, () => S_FALSE],
  });
  const factory = (v8) => (c) => { const ds = new DirectSound(v8); ds.initialized = false; return com.create(c.proc, v8 ? 'IDirectSound8' : 'IDirectSound', ds); };
  com.registerClass(CLSID_DirectSound, factory(false));
  com.registerClass(CLSID_DirectSound8, factory(true));
  void readGuid; void S_OK; void E_POINTER; void DSBCAPS_STATIC; void DSBCAPS_LOCHARDWARE; void DSBCAPS_CTRL3D; void DSBCAPS_GLOBALFOCUS; void DSBCAPS_GETCURRENTPOSITION2; void DSBSTATUS_BUFFERLOST; void DSSCL_EXCLUSIVE; void DSERR_UNSUPPORTED; void DSERR_BUFFERLOST; void DSERR_UNINITIALIZED;
}
