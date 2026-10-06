// dsound.dll: DirectSound 8 — device object, primary/secondary buffers over guest memory, play
// cursor driven by the audio clock (host mixer pull) or by the VM clock (headless), position
// notifications, volume/pan/frequency, software mixing to a float stereo stream for the host.
import { readGuid, S_OK, S_FALSE, E_NOINTERFACE, E_POINTER } from './com.js';

const DS_OK = 0, DSERR_ALLOCATED = 0x8878000a, DSERR_CONTROLUNAVAIL = 0x8878001e, DSERR_INVALIDPARAM = 0x80070057, DSERR_INVALIDCALL = 0x88780032, DSERR_PRIOLEVELNEEDED = 0x88780046, DSERR_OUTOFMEMORY = 0x8007000e, DSERR_BADFORMAT = 0x88780064, DSERR_UNSUPPORTED = 0x80004001, DSERR_NODRIVER = 0x88780078, DSERR_BUFFERLOST = 0x88780096, DSERR_UNINITIALIZED = 0x887800aa;
const IID_IDirectSound = '279afa83-4981-11ce-a521-0020af0be560', IID_IDirectSound8 = 'c50a7e93-f395-4834-9ef6-7fa99de50966';
const IID_IDirectSound3DListener = '279afa84-4981-11ce-a521-0020af0be560', IID_IDirectSound3DBuffer = '279afa86-4981-11ce-a521-0020af0be560';
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
 * Voice table shared with the page's AudioWorklet (audio-worklet.js keeps the same layout): the worklet mixes the
 * playing buffers straight from the (shared) guest memory on the audio thread, following the play cursors published
 * here — the output no longer depends on the game's worker keeping up. Header (int32): 0 the worklet's frame counter,
 * 1 peak level (float bits, reset by the reader), 2 the worklet mixes (1). Voice v at VOICE_BASE + v * VOICE_INTS:
 * state (1 playing), generation (moved by Play / SetCurrentPosition / a new format: the worklet snaps to the cursor),
 * address, size, block align, bits, channels, float samples, frequency, looping, gain L / R (float bits), cursor
 * (bytes), frame counter when the cursor was published.
 */
export const VOICE_BASE = 16, VOICE_INTS = 16, MAX_VOICES = 128, VOICE_TABLE_BYTES = 4 * (VOICE_BASE + VOICE_INTS * MAX_VOICES);

/** the secondary buffers of `audio` (the process' mixer, vm.audio) playing now (the primary has no storage: it is the mix) */
export function audioPlaying(audio) {
  let n = 0;
  if (audio) for (const b of audio.buffers) if (b.playing && !b.primary && b.size) n++;
  return n;
}

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
  com.interface('IDirectSound3DListener', IID_IDirectSound3DListener, 'IUnknown', [['GetAllParameters', 1], ['GetDistanceFactor', 1], ['GetDopplerFactor', 1], ['GetOrientation', 2], ['GetPosition', 1], ['GetRolloffFactor', 1], ['GetVelocity', 1], ['SetAllParameters', 2], ['SetDistanceFactor', 2], ['SetDopplerFactor', 2], ['SetOrientation', 7], ['SetPosition', 4], ['SetRolloffFactor', 2], ['SetVelocity', 4], ['CommitDeferredSettings', 0]]);
  com.interface('IDirectSound3DBuffer', IID_IDirectSound3DBuffer, 'IUnknown', [['GetAllParameters', 1], ['GetConeAngles', 2], ['GetConeOrientation', 1], ['GetConeOutsideVolume', 1], ['GetMaxDistance', 1], ['GetMinDistance', 1], ['GetMode', 1], ['GetPosition', 1], ['GetVelocity', 1], ['SetAllParameters', 2], ['SetConeAngles', 3], ['SetConeOrientation', 4], ['SetConeOutsideVolume', 2], ['SetMaxDistance', 2], ['SetMinDistance', 2], ['SetMode', 2], ['SetPosition', 4], ['SetVelocity', 4]]);

  // ---- DirectSound3D: one listener per device (the primary buffer's), 3D parameters per DSBCAPS_CTRL3D buffer.
  // Rendered as DirectSound's software 3D without virtualization: distance attenuation (minimum / maximum distance,
  // rolloff), sound cones, and a stereo pan from the direction relative to the listener; Doppler is not rendered.
  // Settings applied with DS3D_DEFERRED wait for CommitDeferredSettings.
  const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
  // (diagnostic log lines — creation, first plays and unlocks with a sample of the contents — for the first DIAG_BUFFERS
  // buffers only: a game creating or duplicating a buffer per sound played would otherwise log several lines per frame)
  const DIAG_BUFFERS = 32;
  /** a copy of a listener's or a 3D buffer's parameters (numbers and { x, y, z } vectors; structuredClone costs µs) */
  const clone3d = (o) => { const r = {}; for (const k in o) { const v = o[k]; r[k] = typeof v === 'object' && v !== null ? vec(v.x, v.y, v.z) : v; } return r; };
  let diagBuffers = 0;
  const readVec = (a) => vec(mem.readF32(a), mem.readF32(a + 4), mem.readF32(a + 8));
  const writeVec = (a, v) => { mem.writeF32(a, v.x); mem.writeF32(a + 4, v.y); mem.writeF32(a + 8, v.z); };
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const DS3D_DEFERRED = 1, DS3DMODE_NORMAL = 0, DS3DMODE_HEADRELATIVE = 1, DS3DMODE_DISABLE = 2;
  /** the listener state of the device (the committed one, and the pending deferred one) */
  const listener = () => {
    const a = audio();
    return a.listener ??= { now: { pos: vec(), vel: vec(), front: vec(0, 0, 1), top: vec(0, 1, 0), distance: 1, rolloff: 1, doppler: 1 }, deferred: null };
  };
  /** what a 3D buffer contributes to the left / right gains, from the committed listener and buffer parameters */
  const spatialGains = (b) => {
    const p = b.ds3d?.now;
    if (!p || p.mode === DS3DMODE_DISABLE) return [1, 1];
    const L = listener().now;
    const rel = p.mode === DS3DMODE_HEADRELATIVE ? p.pos : vec(p.pos.x - L.pos.x, p.pos.y - L.pos.y, p.pos.z - L.pos.z);
    // listener axes (left-handed: right = top x front); a head-relative position is already in them
    let front = L.front, top = L.top;
    if (p.mode === DS3DMODE_HEADRELATIVE) { front = vec(0, 0, 1); top = vec(0, 1, 0); }
    const right = cross(top, front), rn = Math.hypot(right.x, right.y, right.z) || 1;
    const d = Math.hypot(rel.x, rel.y, rel.z);
    const min = Math.max(p.min, 1e-6), dd = Math.min(Math.max(d, min), Math.max(p.max, min));
    let gain = min / (min + L.rolloff * (dd - min));
    // cone: full volume inside the inner angle, the outside volume beyond the outer one, interpolated in between
    if (p.coneOuter < 360 && d > 0) {
      const co = p.coneOrient, cl = Math.hypot(co.x, co.y, co.z);
      if (cl > 0) {
        const ang = (Math.acos(Math.max(-1, Math.min(1, -dot(co, rel) / (cl * d)))) * 360) / Math.PI; // (the full angle the listener is inside)
        const out = dbToGain(p.coneOutside);
        if (ang > p.coneOuter) gain *= out;
        else if (ang > p.coneInner) gain *= 1 + (out - 1) * (ang - p.coneInner) / Math.max(1e-6, p.coneOuter - p.coneInner);
      }
    }
    const x = d > 0 ? Math.max(-1, Math.min(1, dot(rel, right) / (rn * d))) : 0;
    const th = ((x + 1) * Math.PI) / 4; // equal-power pan, unity at the center
    return [gain * Math.min(1, Math.SQRT2 * Math.cos(th)), gain * Math.min(1, Math.SQRT2 * Math.sin(th))];
  };
  const republish3d = () => { for (const b of audio().buffers) if (b.ds3d) b.publish(); };
  class Listener3D {
    constructor(primary) { this.primary = primary; }
    get st() { const l = listener(); return l.deferred ?? l.now; }
    /** a setter: applied now, or kept until CommitDeferredSettings */
    set(c, applyArg, fn) {
      const l = listener();
      if (c.arg(applyArg) & DS3D_DEFERRED) { l.deferred ??= clone3d(l.now); fn(l.deferred); return DS_OK; }
      fn(l.now); if (l.deferred) fn(l.deferred); republish3d(); return DS_OK;
    }
    GetAllParameters(c) {
      const p = c.arg(1), s = listener().now; if (!p || mem.read32(p) < 64) return DSERR_INVALIDPARAM;
      writeVec(p + 4, s.pos); writeVec(p + 16, s.vel); writeVec(p + 28, s.front); writeVec(p + 40, s.top);
      mem.writeF32(p + 52, s.distance); mem.writeF32(p + 56, s.rolloff); mem.writeF32(p + 60, s.doppler); return DS_OK;
    }
    GetDistanceFactor(c) { if (c.arg(1)) mem.writeF32(c.arg(1), listener().now.distance); return DS_OK; }
    GetDopplerFactor(c) { if (c.arg(1)) mem.writeF32(c.arg(1), listener().now.doppler); return DS_OK; }
    GetOrientation(c) { if (c.arg(1)) writeVec(c.arg(1), listener().now.front); if (c.arg(2)) writeVec(c.arg(2), listener().now.top); return DS_OK; }
    GetPosition(c) { if (c.arg(1)) writeVec(c.arg(1), listener().now.pos); return DS_OK; }
    GetRolloffFactor(c) { if (c.arg(1)) mem.writeF32(c.arg(1), listener().now.rolloff); return DS_OK; }
    GetVelocity(c) { if (c.arg(1)) writeVec(c.arg(1), listener().now.vel); return DS_OK; }
    SetAllParameters(c) {
      const p = c.arg(1); if (!p || mem.read32(p) < 64) return DSERR_INVALIDPARAM;
      return this.set(c, 2, (s) => { s.pos = readVec(p + 4); s.vel = readVec(p + 16); s.front = readVec(p + 28); s.top = readVec(p + 40); s.distance = mem.readF32(p + 52); s.rolloff = mem.readF32(p + 56); s.doppler = mem.readF32(p + 60); });
    }
    SetDistanceFactor(c) { const v = c.argF32(1); if (!(v > 0)) return DSERR_INVALIDPARAM; return this.set(c, 2, (s) => { s.distance = v; }); }
    SetDopplerFactor(c) { const v = c.argF32(1); if (!(v >= 0 && v <= 10)) return DSERR_INVALIDPARAM; return this.set(c, 2, (s) => { s.doppler = v; }); }
    SetOrientation(c) { const f = vec(c.argF32(1), c.argF32(2), c.argF32(3)), t = vec(c.argF32(4), c.argF32(5), c.argF32(6)); return this.set(c, 7, (s) => { s.front = f; s.top = t; }); }
    SetPosition(c) { const v = vec(c.argF32(1), c.argF32(2), c.argF32(3)); return this.set(c, 4, (s) => { s.pos = v; }); }
    SetRolloffFactor(c) { const v = c.argF32(1); if (!(v >= 0 && v <= 10)) return DSERR_INVALIDPARAM; return this.set(c, 2, (s) => { s.rolloff = v; }); }
    SetVelocity(c) { const v = vec(c.argF32(1), c.argF32(2), c.argF32(3)); return this.set(c, 4, (s) => { s.vel = v; }); }
    CommitDeferredSettings() {
      const l = listener();
      if (l.deferred) { l.now = l.deferred; l.deferred = null; }
      for (const b of audio().buffers) if (b.ds3d?.deferred) { b.ds3d.now = b.ds3d.deferred; b.ds3d.deferred = null; }
      republish3d();
      return DS_OK;
    }
  }
  class Buffer3D {
    constructor(buffer) { this.b = buffer; }
    get st() { return this.b.ds3d.deferred ?? this.b.ds3d.now; }
    set(c, applyArg, fn) {
      const d = this.b.ds3d;
      if (c.arg(applyArg) & DS3D_DEFERRED) { d.deferred ??= clone3d(d.now); fn(d.deferred); return DS_OK; }
      fn(d.now); if (d.deferred) fn(d.deferred); this.b.publish(); return DS_OK;
    }
    GetAllParameters(c) {
      const p = c.arg(1), s = this.b.ds3d.now; if (!p || mem.read32(p) < 64) return DSERR_INVALIDPARAM;
      writeVec(p + 4, s.pos); writeVec(p + 16, s.vel); mem.write32(p + 28, s.coneInner); mem.write32(p + 32, s.coneOuter); writeVec(p + 36, s.coneOrient);
      mem.write32(p + 48, s.coneOutside); mem.writeF32(p + 52, s.min); mem.writeF32(p + 56, s.max); mem.write32(p + 60, s.mode); return DS_OK;
    }
    GetConeAngles(c) { c.out32(1, this.b.ds3d.now.coneInner); c.out32(2, this.b.ds3d.now.coneOuter); return DS_OK; }
    GetConeOrientation(c) { if (c.arg(1)) writeVec(c.arg(1), this.b.ds3d.now.coneOrient); return DS_OK; }
    GetConeOutsideVolume(c) { c.out32(1, this.b.ds3d.now.coneOutside); return DS_OK; }
    GetMaxDistance(c) { if (c.arg(1)) mem.writeF32(c.arg(1), this.b.ds3d.now.max); return DS_OK; }
    GetMinDistance(c) { if (c.arg(1)) mem.writeF32(c.arg(1), this.b.ds3d.now.min); return DS_OK; }
    GetMode(c) { c.out32(1, this.b.ds3d.now.mode); return DS_OK; }
    GetPosition(c) { if (c.arg(1)) writeVec(c.arg(1), this.b.ds3d.now.pos); return DS_OK; }
    GetVelocity(c) { if (c.arg(1)) writeVec(c.arg(1), this.b.ds3d.now.vel); return DS_OK; }
    SetAllParameters(c) {
      const p = c.arg(1); if (!p || mem.read32(p) < 64) return DSERR_INVALIDPARAM;
      return this.set(c, 2, (s) => { s.pos = readVec(p + 4); s.vel = readVec(p + 16); s.coneInner = mem.read32(p + 28); s.coneOuter = mem.read32(p + 32); s.coneOrient = readVec(p + 36); s.coneOutside = mem.read32(p + 48) | 0; s.min = mem.readF32(p + 52); s.max = mem.readF32(p + 56); s.mode = mem.read32(p + 60); });
    }
    SetConeAngles(c) { const i = c.arg(1), o = c.arg(2); if (i > 360 || o > 360 || i > o) return DSERR_INVALIDPARAM; return this.set(c, 3, (s) => { s.coneInner = i; s.coneOuter = o; }); }
    SetConeOrientation(c) { const v = vec(c.argF32(1), c.argF32(2), c.argF32(3)); return this.set(c, 4, (s) => { s.coneOrient = v; }); }
    SetConeOutsideVolume(c) { const v = c.sarg(1); if (v > 0 || v < -10000) return DSERR_INVALIDPARAM; return this.set(c, 2, (s) => { s.coneOutside = v; }); }
    SetMaxDistance(c) { const v = c.argF32(1); if (!(v > 0)) return DSERR_INVALIDPARAM; return this.set(c, 2, (s) => { s.max = v; }); }
    SetMinDistance(c) { const v = c.argF32(1); if (!(v > 0)) return DSERR_INVALIDPARAM; return this.set(c, 2, (s) => { s.min = v; }); }
    SetMode(c) { const v = c.arg(1); if (v > 2) return DSERR_INVALIDPARAM; return this.set(c, 2, (s) => { s.mode = v; }); }
    SetPosition(c) { const v = vec(c.argF32(1), c.argF32(2), c.argF32(3)); return this.set(c, 4, (s) => { s.pos = v; }); }
    SetVelocity(c) { const v = vec(c.argF32(1), c.argF32(2), c.argF32(3)); return this.set(c, 4, (s) => { s.vel = v; }); }
  }

  /** Mixer state shared by all DirectSound objects of the process (one audio device). */
  class Audio {
    constructor() {
      this.buffers = new Set();
      this.format = { tag: 1, channels: 2, rate: 22050, bits: 16, align: 4, avg: 88200 };
      vm.audio = this;
    }
    /**
     * Render `frames` stereo float frames at `rate` into `out` (interleaved). Play cursors are driven by
     * the VM clock (see tick), not by what the host consumed: the game must see real-time cursors even
     * when the browser's audio output is suspended or throttled; each buffer keeps its own mix position
     * that follows the cursor.
     */
    render(out, frames, rate = DEVICE_RATE) {
      out.fill(0, 0, frames * 2);
      this.tick();
      for (const b of this.buffers) if (b.playing && b.size) b.mixInto(out, frames, rate); // the primary buffer has no storage: it *is* the mix
      return out;
    }
    /** Advance play cursors to the VM clock (and publish them to the worklet mixer). */
    tick() {
      const now = vm.clock.now() / 1000, v = this.voices;
      for (const b of this.buffers) if (b.playing) { b.advanceTo(now); if (v && b.slot >= 0) { const o = VOICE_BASE + b.slot * VOICE_INTS; v[o + 12] = b.pos; v[o + 13] = v[0]; if (!b.playing) b.publish(); } }
    }
    /** The worklet mixes from now on: `sab` is the voice table (every buffer published). */
    attachVoices(sab) {
      this.voices = new Int32Array(sab); this.voicesF = new Float32Array(sab); this.freeSlots = [];
      for (let i = MAX_VOICES - 1; i >= 0; i--) this.freeSlots.push(i);
      for (const b of this.buffers) b.publish();
    }
    /** the worklet is mixing (it sets the flag at its first quantum with the table) */
    get worklet() { return !!this.voices && this.voices[2] === 1; }
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
      this.mixPos = null; // mixer read position in frames (fractional); null = snap to the play cursor
      this.lastTime = 0; // VM clock seconds at last headless advance
      this.volume = 0; this.pan = 0; this.freq = fmt.rate;
      this.locks = 0; this.notifies = [];
      this.iids = [IID_IDirectSoundBuffer, IID_IDirectSoundBuffer8];
      this.stoppedEvents = [];
      this.slot = -1; this.gen = 0;
      this.diagOn = !this.primary && bytes > 0 && ++diagBuffers <= DIAG_BUFFERS;
      if (diagBuffers === DIAG_BUFFERS + 1 && !this.primary && bytes > 0) vm.log('audio', `dsound: ${DIAG_BUFFERS} buffers created, the next ones not logged`);
      // 3D parameters (DS3DBUFFER defaults) of a DSBCAPS_CTRL3D secondary buffer
      this.ds3d = !this.primary && (flags & DSBCAPS_CTRL3D) ? { now: { pos: vec(), vel: vec(), coneInner: 360, coneOuter: 360, coneOrient: vec(0, 0, 1), coneOutside: 0, min: 1, max: 1e9, mode: DS3DMODE_NORMAL }, deferred: null } : null;
      audio().buffers.add(this);
    }
    destroy() { this.gen++; this.playing = false; this.publish(); const a = audio(); if (this.slot >= 0) { a.freeSlots?.push(this.slot); this.slot = -1; } a.buffers.delete(this); if (this.mem) this.proc.vmem.release(this.mem); }
    /** this buffer's entry in the worklet's voice table (see VOICE_BASE); the generation stored last */
    publish() {
      const a = audio(), v = a.voices; if (!v || this.primary || !this.size) return;
      if (this.slot < 0) { if (!this.playing) return; const s = a.freeSlots.pop(); if (s === undefined) return; this.slot = s; this.gen++; }
      const o = VOICE_BASE + this.slot * VOICE_INTS, f = this.fmt;
      const [gl, gr] = this.gains();
      v[o] = this.playing ? 1 : 0; v[o + 2] = this.mem; v[o + 3] = this.size; v[o + 4] = f.align; v[o + 5] = f.bits; v[o + 6] = f.channels; v[o + 7] = f.tag === WAVE_FORMAT_IEEE_FLOAT ? 1 : 0;
      v[o + 8] = this.freq; v[o + 9] = this.looping ? 1 : 0; a.voicesF[o + 10] = gl; a.voicesF[o + 11] = gr; v[o + 12] = this.pos; v[o + 13] = v[0];
      Atomics.store(v, o + 1, this.gen);
    }
    /** left / right gains: volume, pan, and the 3D rendering of a 3D buffer */
    gains() {
      const gain = dbToGain(this.volume);
      if (this.ds3d) { const [l, r] = spatialGains(this); return [gain * l, gain * r]; }
      return [gain * (this.pan > 0 ? dbToGain(-this.pan) : 1), gain * (this.pan < 0 ? dbToGain(this.pan) : 1)];
    }
    queryInterface(c, iid) {
      // the listener: from a primary buffer created with DSBCAPS_CTRL3D; the 3D parameters: from a 3D secondary buffer
      if (iid === IID_IDirectSound3DListener && this.primary && (this.flags & DSBCAPS_CTRL3D)) return this.ref3d(c, 'IDirectSound3DListener', () => new Listener3D(this));
      if (iid === IID_IDirectSound3DBuffer && this.ds3d) return this.ref3d(c, 'IDirectSound3DBuffer', () => new Buffer3D(this));
      if (iid === IID_IDirectSoundNotify) { if (!this.notifyPtr || !com.objectAt(this.notifyPtr)) this.notifyPtr = com.create(c.proc, 'IDirectSoundNotify', { buffer: this, SetNotificationPositions: (cc) => this.setNotifications(cc) }); else com.addRef(com.objectAt(this.notifyPtr)); return this.notifyPtr; }
      return 0;
    }
    ref3d(c, iface, make) {
      if (this.ptr3d && com.objectAt(this.ptr3d)) { com.addRef(com.objectAt(this.ptr3d)); return this.ptr3d; }
      return (this.ptr3d = com.create(c.proc, iface, make()));
    }
    get bytesPerSec() { return this.fmt.align * this.freq; }
    /** advance the play cursor by `frames` sample frames of this buffer */
    advanceFrames(frames) {
      if (!this.playing || !this.size) return;
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
    /**
     * Mix this buffer into a stereo float stream (linear resampling, volume/pan applied). The mix position
     * follows the play cursor: it advances with the frames rendered and is re-synchronised to the cursor
     * when it drifts (output suspended, or the app moved the cursor).
     */
    mixInto(out, frames, rate) {
      if (!this.size) return;
      const f = this.fmt, step = this.freq / rate;
      const [gl, gr] = this.gains();
      const base = this.mem, size = this.size, align = f.align;
      const totalFrames = Math.floor(size / align);
      const cursor = this.pos / align + this.posFrac;
      if (this.mixPos !== null) { let lag = cursor - this.mixPos; if (this.looping) lag = ((lag % totalFrames) + totalFrames) % totalFrames; if (lag < 0 || lag > this.freq * 0.25) this.mixPos = null; }
      if (this.mixPos === null) this.mixPos = cursor;
      let frame = this.mixPos;
      const sample = (fi, ch) => {
        const a = base + (fi % totalFrames) * align + (f.channels === 1 ? 0 : ch) * (f.bits >> 3);
        if (f.tag === WAVE_FORMAT_IEEE_FLOAT) return mem.readF32(a);
        return f.bits === 8 ? (mem.u8[a] - 128) / 128 : mem.readS16(a) / 32768;
      };
      for (let i = 0; i < frames; i++) {
        const fi = Math.floor(frame), t = frame - fi;
        if (fi >= totalFrames && !this.looping) break; // the cursor logic (advanceTo) stops the buffer
        const l0 = sample(fi, 0), l1 = sample(fi + 1, 0);
        const r0 = f.channels > 1 ? sample(fi, 1) : l0, r1 = f.channels > 1 ? sample(fi + 1, 1) : l1;
        out[2 * i] += (l0 + (l1 - l0) * t) * gl; out[2 * i + 1] += (r0 + (r1 - r0) * t) * gr;
        frame += step;
      }
      this.mixPos = this.looping ? frame % totalFrames : frame;
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
      if (!this.playing) { this.playing = true; this.lastTime = vm.clock.now() / 1000; this.notifyPos = this.pos; this.mixPos = null; this.gen++; }
      this.publish();
      if (this.diagOn && (this.diag = (this.diag ?? 0) + 1) <= 4) vm.log('audio', `dsound: play ${this.size} bytes ${this.looping ? 'looping' : 'once'} volume ${this.volume} freq ${this.freq} pos ${this.pos} nonzero ${this.nonZero()}`);
      return DS_OK;
    }
    SetCurrentPosition(c) { const p = c.arg(1); if (p >= this.size) return DSERR_INVALIDPARAM; this.pos = p - (p % this.fmt.align); this.posFrac = 0; this.mixPos = null; this.notifyPos = this.pos; this.gen++; this.publish(); return DS_OK; }
    SetFormat(c) {
      if (!this.primary) return DSERR_INVALIDCALL;
      if (this.ds.coop < DSSCL_PRIORITY) return DSERR_PRIOLEVELNEEDED;
      const f = readWfx(mem, c.arg(1));
      if (!f.channels || !f.rate || !f.bits) return DSERR_BADFORMAT;
      this.fmt = f; audio().format = f;
      vm.log('audio', `dsound: primary format ${f.rate} Hz ${f.bits}-bit ${f.channels}ch`);
      return DS_OK;
    }
    SetVolume(c) { if (!(this.flags & DSBCAPS_CTRLVOLUME) && !this.primary) return DSERR_CONTROLUNAVAIL; const v = c.sarg(1); if (v > 0 || v < -10000) return DSERR_INVALIDPARAM; this.volume = v; this.publish(); return DS_OK; }
    SetPan(c) { if (!(this.flags & DSBCAPS_CTRLPAN)) return DSERR_CONTROLUNAVAIL; const v = c.sarg(1); if (v > 10000 || v < -10000) return DSERR_INVALIDPARAM; this.pan = v; this.publish(); return DS_OK; }
    SetFrequency(c) { if (!(this.flags & DSBCAPS_CTRLFREQUENCY)) return DSERR_CONTROLUNAVAIL; const v = c.arg(1); if (v && (v < 100 || v > 200000)) return DSERR_INVALIDPARAM; this.cursor(); this.freq = v || this.fmt.rate; this.publish(); return DS_OK; }
    Stop() { if (this.primary) return DS_OK; this.cursor(); if (this.playing) { this.playing = false; this.onStop(); } this.publish(); return DS_OK; }
    Unlock(c) {
      if (this.locks > 0) this.locks--;
      if (this.diagOn && ((this.unlockDiag = (this.unlockDiag ?? 0) + 1) <= 6 || this.unlockDiag % 500 === 0)) vm.log('audio', `dsound: unlock ${c.arg(2)}+${c.arg(4)} bytes at ${(c.arg(1) - this.mem) >>> 0} (playing ${this.playing} pos ${this.pos}) nonzero ${this.nonZero()}`);
      return DS_OK;
    }
    /** Diagnostic: number of non-zero bytes in a 4 KB sample spread over the buffer. */
    nonZero() { let n = 0; const u8 = mem.u8, step = Math.max(1, this.size >> 12); for (let i = 0; i < this.size; i += step) if (u8[this.mem + i] !== 0 && !(this.fmt.bits === 8 && u8[this.mem + i] === 0x80)) n++; return n; }
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
      if (b.diagOn) vm.log('audio', `dsound: buffer ${bytes} bytes ${fmt.rate} Hz ${fmt.bits}-bit ${fmt.channels}ch flags 0x${flags.toString(16)}`);
      return DS_OK;
    }
    GetCaps(c) {
      const p = c.arg(1); if (!p || mem.read32(p) < 96) return DSERR_INVALIDPARAM;
      // a software-mixing device (like every modern Windows driver): no hardware buffers, no hardware memory
      mem.fill(p + 4, 92, 0);
      mem.write32(p + 4, 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x100 | 0x200 | 0x400 | 0x800); // PRIMARY MONO|STEREO|8BIT|16BIT, CONTINUOUSRATE, SECONDARY MONO|STEREO|8BIT|16BIT
      mem.write32(p + 8, 100); mem.write32(p + 12, 200000); mem.write32(p + 16, 1);
      return DS_OK;
    }
    DuplicateSoundBuffer(c) {
      const src = com.implAt(c.arg(1)), pp = c.arg(2);
      if (!(src instanceof Buffer) || !pp || src.primary) return DSERR_INVALIDPARAM;
      const b = new Buffer(c.proc, this, src.flags, src.size, src.fmt);
      if (!b.mem) return DSERR_OUTOFMEMORY;
      mem.copy(b.mem, src.mem, src.size);
      b.volume = src.volume; b.pan = src.pan; b.freq = src.freq; if (src.ds3d) b.ds3d = { now: clone3d(src.ds3d.now), deferred: null };
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
  /**
   * A sound stream of the runtime's own components (the DirectShow audio renderer, quartz.js): a looping 16-bit PCM
   * ring in guest memory mixed like any DirectSound buffer (the same mixer, volume and play cursor clock); its owner
   * writes the samples ahead of the play cursor.
   */
  vm.createAudioStream = (proc, rate, channels, seconds = 1) => {
    const align = 2 * channels, frames = Math.ceil(rate * seconds);
    const fmt = { tag: WAVE_FORMAT_PCM, channels, rate, bits: 16, align, avg: align * rate, cb: 0, raw: null };
    const b = new Buffer(proc, null, DSBCAPS_CTRLVOLUME | DSBCAPS_CTRLPAN, frames * align, fmt);
    return {
      addr: b.mem, frames, channels, rate, buffer: b,
      /** play from the ring's start, looping (the play cursor then advances with the VM clock) */
      start() { b.pos = 0; b.posFrac = 0; b.looping = true; b.playing = true; b.lastTime = vm.clock.now() / 1000; b.mixPos = null; b.notifyPos = 0; b.gen++; b.publish(); },
      stop() { b.cursor(); b.playing = false; b.publish(); },
      setVolume(v) { b.volume = v; b.publish(); },
      setPan(v) { b.pan = v; b.publish(); },
      destroy() { b.destroy(); },
    };
  };
  void readGuid; void S_OK; void E_POINTER; void DSBCAPS_STATIC; void DSBCAPS_LOCHARDWARE; void DSBCAPS_GLOBALFOCUS; void DSBCAPS_GETCURRENTPOSITION2; void DSBSTATUS_BUFFERLOST; void DSSCL_EXCLUSIVE; void DSERR_UNSUPPORTED; void DSERR_BUFFERLOST; void DSERR_UNINITIALIZED;
}
