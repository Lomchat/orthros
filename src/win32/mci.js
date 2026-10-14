// winmm.dll MCI (Media Control Interface): the digital video and wave audio devices (MPEGVideo, AVIVideo,
// digitalvideo, waveaudio) through mciSendString and mciSendCommand — the other way Windows programs play a movie or a
// sound file. Each open device plays its file with a MoviePlayer (movie-player.js: the formats of docs/media-playback.md):
// pictures in the device's window (its own, a window given by `window handle`, a child of `parent`, or full screen),
// sound through the DirectSound mixer, MM_MCINOTIFY to the callback window, `wait` blocking the caller until the end.
// Other device types (cdaudio, sequencer...) answer as before (MCIERR_INVALID_DEVICE_ID), so programs go on without them.
import { snapKnown, snapClass } from '../core/snapshot.js';
import { MoviePlayer, MediaClock, RUNNING, PAUSED } from './movie-player.js';
import { INFINITE } from '../core/sched.js';

const MCIERR = {
  INVALID_DEVICE_ID: 257, UNRECOGNIZED_KEYWORD: 259, UNRECOGNIZED_COMMAND: 261, INVALID_DEVICE_NAME: 263, DEVICE_OPEN: 265, MISSING_PARAMETER: 273,
  UNSUPPORTED_FUNCTION: 274, FILE_NOT_FOUND: 275, OUTOFRANGE: 282, DEVICE_TYPE_REQUIRED: 287, DUPLICATE_ALIAS: 289, BAD_TIME_FORMAT: 293, INVALID_FILE: 296,
  NONAPPLICABLE_FUNCTION: 302, MISSING_DEVICE_NAME: 292, EXTENSION_NOT_FOUND: 281,
};
const MM_MCINOTIFY = 0x3b9, NOTIFY_SUCCESSFUL = 1, NOTIFY_SUPERSEDED = 2, NOTIFY_ABORTED = 4, NOTIFY_FAILURE = 8;
const MODE = { 524: 'not ready', 525: 'stopped', 526: 'playing', 528: 'seeking', 529: 'paused', 530: 'open' };
const MODE_STOP = 525, MODE_PLAY = 526, MODE_PAUSE = 529;
// mciSendCommand messages and flags
const MCI_OPEN = 0x803, MCI_CLOSE = 0x804, MCI_PLAY = 0x806, MCI_SEEK = 0x807, MCI_STOP = 0x808, MCI_PAUSE = 0x809, MCI_INFO = 0x80a, MCI_GETDEVCAPS = 0x80b,
  MCI_SET = 0x80d, MCI_STATUS = 0x814, MCI_CUE = 0x830, MCI_WINDOW = 0x841, MCI_PUT = 0x842, MCI_WHERE = 0x843, MCI_RESUME = 0x855, MCI_SETAUDIO = 0x873;
const F_NOTIFY = 1, F_WAIT = 2, F_FROM = 4, F_TO = 8, F_OPEN_SHAREABLE = 0x100, F_OPEN_ELEMENT = 0x200, F_OPEN_ALIAS = 0x400, F_OPEN_TYPE_ID = 0x1000, F_OPEN_TYPE = 0x2000,
  F_DGV_OPEN_WS = 0x10000, F_DGV_OPEN_PARENT = 0x20000, F_SEEK_START = 0x100, F_SEEK_END = 0x200, F_STATUS_ITEM = 0x100, F_SET_TIME_FORMAT = 0x400,
  F_PLAY_FULLSCREEN = 0x02000000, F_PLAY_REPEAT = 0x10000, F_WINDOW_HWND = 0x10000, F_WINDOW_STATE = 0x40000, F_PUT_RECT = 0x10000, F_PUT_SOURCE = 0x20000,
  F_PUT_DESTINATION = 0x40000, F_PUT_WINDOW = 0x200000;
const FORMAT_MS = 0, FORMAT_FRAMES = 3;
const WS_CHILD = 0x40000000;
/** device types played here, and the type of a file by its extension (the [MCI Extensions] of Windows) */
const TYPES = new Set(['mpegvideo', 'avivideo', 'digitalvideo', 'waveaudio']);
const BY_EXT = { avi: 'avivideo', wav: 'waveaudio', mpg: 'mpegvideo', mpeg: 'mpegvideo', mpe: 'mpegvideo', m1v: 'mpegvideo', mpa: 'mpegvideo', mp2: 'mpegvideo', mp3: 'mpegvideo', dat: 'mpegvideo' };

/** split a command string into words ("quoted" words keep their spaces) */
export function mciWords(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '"') { const j = s.indexOf('"', i + 1); out.push(s.slice(i + 1, j < 0 ? s.length : j)); i = j < 0 ? s.length : j + 1; }
    else { let j = i; while (j < s.length && !/\s/.test(s[j])) j++; out.push(s.slice(i, j)); i = j; }
  }
  return out;
}

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerMci(api, vm) {
  const mem = vm.mem;
  vm.media ??= new MediaClock(vm);
  const log = (m) => vm.log('video', `mci: ${m}`);
  /** @type {Map<number, Device>} */
  const devices = snapKnown(vm, 'mci.devices', new Map());
  const ids = snapKnown(vm, 'mci.ids', { next: 1 });

  class Device {
    constructor(proc, type, alias) {
      this.id = 0; this.type = type; this.alias = alias; this.proc = proc; // (the id: once opened)
      this.format = type === 'avivideo' ? FORMAT_FRAMES : FORMAT_MS;
      this.win = { hwnd: 0, parent: 0, style: 0, shown: true, fullScreen: false, at: null };
      this.dst = null; this.srcRect = null;
      this.notify = null; // { hwnd } of the pending play's notification
      this.repeat = false; this.waiting = false;
      this.player = new MoviePlayer(vm, proc, {
        log: (m) => log(`${this.alias ?? this.id}: ${m}`),
        onComplete: () => this.ended(),
        onError: () => this.finishNotify(NOTIFY_FAILURE),
        rect: () => this.screenRect(), source: () => this.srcRect, visible: () => this.visible(),
      });
    }
    get name() { return this.alias ?? String(this.id); }
    visible() { return this.player.hasVideo && (this.win.fullScreen || this.win.shown) && (this.player.state !== 0 || this.player.shown); }
    /** the video's place on the screen: full screen, the destination in the window, or the window's client area at the video's size */
    screenRect() {
      const p = this.player, W = vm.wm?.screen.width ?? 640, H = vm.wm?.screen.height ?? 480;
      if (this.win.fullScreen) return { x: 0, y: 0, w: W, h: H };
      let ox, oy;
      const target = this.win.hwnd ? vm.wm?.windows.get(this.win.hwnd) : this.win.parent ? vm.wm?.windows.get(this.win.parent) : null;
      if (this.win.at) { ox = this.win.at.x; oy = this.win.at.y; if (target && (this.win.hwnd || this.win.style & WS_CHILD)) { ox += target.client.l; oy += target.client.t; } }
      else if (target) { ox = target.client.l; oy = target.client.t; } // (a window given, or a child of the parent at its top left corner)
      else { ox = (W - p.width) >> 1; oy = (H - p.height) >> 1; } // (its own window, centered)
      const d = this.dst ?? (this.win.at && !this.win.hwnd ? { x: 0, y: 0, w: this.win.at.w, h: this.win.at.h } : { x: 0, y: 0, w: p.width, h: p.height });
      return { x: ox + d.x, y: oy + d.y, w: d.w, h: d.h };
    }
    /** a time in the device's format -> seconds, and back */
    toSec(v) { return this.format === FORMAT_FRAMES ? v / (this.player.src?.fps || 25) : v / 1000; }
    fromSec(s) { return Math.round(this.format === FORMAT_FRAMES ? s * (this.player.src?.fps || 25) : s * 1000); }
    get length() { const p = this.player; return this.format === FORMAT_FRAMES && p.hasVideo ? (p.src.vs?.length || Math.round(p.duration * p.src.fps)) : this.fromSec(p.duration); }
    mode() { const p = this.player; return p.state === RUNNING && !p.completed ? MODE_PLAY : p.state === PAUSED ? MODE_PAUSE : MODE_STOP; }
    /** the previous play's notification, if any, with a result; a new one to come */
    finishNotify(flag) {
      const n = this.notify; this.notify = null;
      if (!n) return;
      const w = vm.wm?.windows.get(n.hwnd);
      if (w) vm.wm.post(w, MM_MCINOTIFY, flag, this.id);
    }
    ended() {
      if (this.repeat) { this.player.seek(this.fromTime ?? 0); this.player.completed = false; return; }
      this.player.stop();
      this.finishNotify(NOTIFY_SUCCESSFUL);
    }
    play({ from, to, notify, fullScreen, repeat }) {
      const p = this.player;
      this.finishNotify(NOTIFY_SUPERSEDED);
      if (from !== undefined) p.seek(Math.min(this.toSec(from), p.duration));
      else if (p.completed || p.position() >= p.stopTime) p.seek(0); // (played to the end: from the start again)
      p.stopPos = to !== undefined ? Math.min(this.toSec(to), p.duration) : null;
      this.fromTime = from !== undefined ? this.toSec(from) : 0;
      this.win.fullScreen = !!fullScreen; this.repeat = !!repeat;
      if (notify) this.notify = { hwnd: notify };
      if (p.state !== RUNNING) p.run();
      else { p.completed = false; vm.media.wake(); }
    }
    close() { this.finishNotify(NOTIFY_ABORTED); this.player.close(); devices.delete(this.id); log(`${this.name}: closed`); }
  }
  for (const C of [Device]) snapClass(vm, C, { name: `mci.${C.name}` }); // (snapshots: core/vm-snapshot.js)

  const byName = (n) => {
    if (n === undefined) return null;
    const l = n.toLowerCase();
    for (const d of devices.values()) if ((d.alias && d.alias.toLowerCase() === l) || String(d.id) === l) return d;
    return null;
  };
  /** open a device: { error } or { device } */
  function open(c, { type, element, alias, parent, style, notify }) {
    if (!type && element) {
      const bang = element.indexOf('!');
      if (bang > 0) { type = element.slice(0, bang); element = element.slice(bang + 1); }
      else { const ext = /\.([^.\\/]+)$/.exec(element)?.[1]?.toLowerCase(); type = BY_EXT[ext]; if (!type) return { error: ext ? MCIERR.EXTENSION_NOT_FOUND : MCIERR.INVALID_DEVICE_ID }; }
    }
    type = type?.toLowerCase();
    if (!type || !TYPES.has(type)) return { error: MCIERR.INVALID_DEVICE_ID }; // (cdaudio, sequencer, ...: as before)
    if (!element) return { error: MCIERR.UNSUPPORTED_FUNCTION }; // (a device without a file: recording, not here)
    if (alias && byName(alias)) return { error: MCIERR.DUPLICATE_ALIAS };
    const d = new Device(c.proc, type, alias ?? null);
    const path = c.proc.path(element);
    const r = d.player.open(path);
    if (!r.ok) { d.player.close(); log(`open ${path}: ${r.message}`); return { error: r.code === 'not-found' ? MCIERR.FILE_NOT_FOUND : MCIERR.INVALID_FILE }; }
    d.win.parent = parent ?? 0; d.win.style = style ?? 0;
    d.id = ids.next++; devices.set(d.id, d);
    log(`open ${path} as ${type} ${d.name} (id ${d.id})`);
    if (notify) { const w = vm.wm?.windows.get(notify); if (w) vm.wm.post(w, MM_MCINOTIFY, NOTIFY_SUCCESSFUL, d.id); }
    return { device: d };
  }
  /** wait (the caller's thread) for the end of a play started with `wait` */
  function waitEnd(c, d, started) {
    if (c.thread.wakeResult === undefined && !started) return 0;
    vm.sched.block(c.thread, () => !devices.has(d.id) || d.player.state !== RUNNING || d.player.completed || d.player.failed, INFINITE, 'MCI play wait');
    return 0;
  }

  // ---------------------------------------------------------------- mciSendString
  function sendString(c, cmd, ret, retLen, callback) {
    const w = mciWords(cmd ?? ''), verb = (w.shift() ?? '').toLowerCase();
    const out = (s) => { if (ret && retLen) mem.writeCString(ret, String(s).slice(0, retLen - 1), retLen); return 0; };
    if (ret && retLen) mem.write8(ret, 0);
    if (!verb) return MCIERR.MISSING_DEVICE_NAME;
    const flags = new Set(w.map((x) => x.toLowerCase()));
    const after = (k, n = 1) => { const i = w.findIndex((x) => x.toLowerCase() === k); return i < 0 ? undefined : n === 1 ? w[i + 1] : w.slice(i + 1, i + 1 + n); };
    const notify = flags.has('notify') ? callback : 0;
    if (verb === 'open') {
      const target = w[0];
      if (!target) return MCIERR.MISSING_DEVICE_NAME;
      const typeArg = after('type'), isType = !typeArg && TYPES.has(target.toLowerCase()) && !/[.\\/]/.test(target);
      const r = open(c, { type: typeArg ?? (isType ? target : undefined), element: isType ? after('element') : target, alias: after('alias'), parent: after('parent') !== undefined ? parseInt(after('parent'), 10) >>> 0 : 0, style: flags.has('child') ? WS_CHILD : 0, notify });
      if (r.error) return r.error;
      return out(r.device.id);
    }
    if (verb === 'sysinfo') { if (flags.has('quantity')) return out(devices.size); return out(''); }
    const name = w[0], all = name?.toLowerCase() === 'all';
    if (verb === 'close' && all) { for (const d of [...devices.values()]) d.close(); return 0; }
    const d = byName(name);
    if (!d) {
      // (a device name never opened: "play file.avi" opens it on the fly, as MCI's auto-open)
      if (verb === 'play' && name && /\.[^.\\/]+$/.test(name)) { const r = open(c, { element: name }); if (r.error) return r.error; return sendString(c, cmd.replace(/^\s*play\s+("[^"]*"|\S+)/i, `play ${r.device.id}`), ret, retLen, callback); }
      return name ? MCIERR.INVALID_DEVICE_NAME : MCIERR.MISSING_DEVICE_NAME;
    }
    const p = d.player, num = (v) => (v === undefined ? undefined : parseInt(v, 10));
    switch (verb) {
      case 'play': {
        const resumed = c.thread.wakeResult !== undefined;
        if (!resumed) d.play({ from: num(after('from')), to: num(after('to')), notify, fullScreen: flags.has('fullscreen'), repeat: flags.has('repeat') });
        return flags.has('wait') ? waitEnd(c, d, true) : 0;
      }
      case 'stop':
        d.finishNotify(NOTIFY_ABORTED); p.stop();
        if (notify) { d.notify = { hwnd: notify }; d.finishNotify(NOTIFY_SUCCESSFUL); } // (the stop's own notification)
        return 0;
      case 'pause': p.pause(); return 0;
      case 'resume': if (p.state === PAUSED) p.run(); return 0;
      case 'seek': {
        const to = after('to'); if (to === undefined) return MCIERR.MISSING_PARAMETER;
        d.finishNotify(NOTIFY_ABORTED); p.stop();
        p.seek(to.toLowerCase() === 'start' ? 0 : to.toLowerCase() === 'end' ? p.duration : d.toSec(num(to)));
        return 0;
      }
      case 'close': d.close(); return 0;
      case 'status': {
        const item = w.slice(1).filter((x) => !/^(notify|wait)$/i.test(x)).join(' ').toLowerCase();
        switch (item) {
          case 'mode': return out(MODE[d.mode()]);
          case 'length': return out(d.length);
          case 'position': return out(d.fromSec(p.position()));
          case 'ready': case 'media present': return out('true');
          case 'number of tracks': return out(1);
          case 'time format': return out(d.format === FORMAT_FRAMES ? 'frames' : 'milliseconds');
          case 'window handle': return out(d.win.hwnd || d.win.parent || 0);
          case 'frame rate': return out(Math.round((p.src?.fps || 0) * 1000));
          default: return MCIERR.UNSUPPORTED_FUNCTION;
        }
      }
      case 'set': {
        const tf = after('format');
        if (flags.has('time') && tf) { const f = tf.toLowerCase(); if (f === 'milliseconds' || f === 'ms') d.format = FORMAT_MS; else if (f === 'frames' && p.hasVideo) d.format = FORMAT_FRAMES; else return MCIERR.BAD_TIME_FORMAT; }
        if (flags.has('audio')) p.setVolume(flags.has('off') ? -10000 : 0);
        return 0;
      }
      case 'setaudio': { const v = num(after('to')); if (flags.has('volume') && v !== undefined) p.setVolume(v <= 0 ? -10000 : Math.round(2000 * Math.log10(Math.min(v, 1000) / 1000))); return 0; }
      case 'window': {
        if (!p.hasVideo) return MCIERR.UNSUPPORTED_FUNCTION;
        const h = after('handle'), st = after('state');
        if (h !== undefined) d.win.hwnd = h.toLowerCase() === 'default' ? 0 : parseInt(h, 10) >>> 0;
        if (st !== undefined) d.win.shown = !/^(hide|minimize|minimized)$/i.test(st);
        p.refresh(); return 0;
      }
      case 'put': {
        if (!p.hasVideo) return MCIERR.UNSUPPORTED_FUNCTION;
        const at = after('at', 4)?.map(Number);
        if (!at || at.length < 4 || at.some(Number.isNaN)) return MCIERR.MISSING_PARAMETER;
        const r = { x: at[0], y: at[1], w: at[2], h: at[3] };
        if (flags.has('destination')) d.dst = r; else if (flags.has('source')) d.srcRect = { l: r.x, t: r.y, w: r.w, h: r.h }; else d.win.at = r;
        p.refresh(); return 0;
      }
      case 'where': {
        if (!p.hasVideo) return MCIERR.UNSUPPORTED_FUNCTION;
        const s = d.screenRect();
        if (flags.has('source')) { const r = d.srcRect ?? { l: 0, t: 0, w: p.width, h: p.height }; return out(`${r.l} ${r.t} ${r.w} ${r.h}`); }
        if (flags.has('window')) { const a = d.win.at; return out(a ? `${a.x} ${a.y} ${a.w} ${a.h}` : `0 0 ${p.width} ${p.height}`); }
        const r = d.dst ?? { x: 0, y: 0, w: s.w, h: s.h };
        return out(`${r.x} ${r.y} ${r.w} ${r.h}`);
      }
      case 'info': return out(flags.has('file') ? p.path ?? '' : d.type === 'avivideo' ? 'Video for Windows' : d.type === 'waveaudio' ? 'Sound' : 'DirectShow');
      case 'capability': return out(flags.has('device') && flags.has('type') ? 'digitalvideo' : 'true');
      case 'cue': case 'update': case 'realize': case 'signal': return 0;
      default: return MCIERR.UNRECOGNIZED_COMMAND;
    }
  }

  // ---------------------------------------------------------------- mciSendCommand
  const strArg = (a, wide) => (a ? (wide ? mem.readWString(a) : mem.readCString(a)) : undefined);
  function sendCommand(c, id, msg, flags, parms, wide) {
    const P = parms, cb = P ? mem.read32(P) : 0, notify = flags & F_NOTIFY ? cb : 0;
    if (msg === MCI_OPEN) {
      if (!P) return MCIERR.MISSING_PARAMETER;
      const tp = mem.read32(P + 8);
      // (MCI_OPEN_TYPE_ID: a device type number — the wave / video ones are not told apart by number here: type from the file)
      const type = flags & F_OPEN_TYPE ? (flags & F_OPEN_TYPE_ID ? undefined : strArg(tp, wide)) : undefined;
      const element = flags & F_OPEN_ELEMENT ? strArg(mem.read32(P + 12), wide) : undefined;
      const alias = flags & F_OPEN_ALIAS ? strArg(mem.read32(P + 16), wide) : undefined;
      const r = open(c, { type, element, alias, parent: flags & F_DGV_OPEN_PARENT ? mem.read32(P + 24) : 0, style: flags & F_DGV_OPEN_WS ? mem.read32(P + 20) : 0, notify });
      if (r.error) return r.error;
      mem.write32(P + 4, r.device.id);
      return 0;
    }
    if (id === 0xffff && msg === MCI_CLOSE) { for (const d of [...devices.values()]) d.close(); return 0; } // (MCI_ALL_DEVICE_ID)
    const d = devices.get(id);
    if (!d) return MCIERR.INVALID_DEVICE_ID;
    const p = d.player;
    switch (msg) {
      case MCI_PLAY: {
        const resumed = c.thread.wakeResult !== undefined;
        if (!resumed) d.play({ from: flags & F_FROM ? mem.read32(P + 4) : undefined, to: flags & F_TO ? mem.read32(P + 8) : undefined, notify, fullScreen: flags & F_PLAY_FULLSCREEN, repeat: flags & F_PLAY_REPEAT });
        return flags & F_WAIT ? waitEnd(c, d, true) : 0;
      }
      case MCI_STOP: d.finishNotify(NOTIFY_ABORTED); p.stop(); return 0;
      case MCI_PAUSE: p.pause(); return 0;
      case MCI_RESUME: if (p.state === PAUSED) p.run(); return 0;
      case MCI_CLOSE: d.close(); return 0;
      case MCI_SEEK: d.finishNotify(NOTIFY_ABORTED); p.stop(); p.seek(flags & F_SEEK_START ? 0 : flags & F_SEEK_END ? p.duration : flags & F_TO ? d.toSec(mem.read32(P + 4)) : p.pos); return 0;
      case MCI_STATUS: {
        if (!(flags & F_STATUS_ITEM) || !P) return MCIERR.MISSING_PARAMETER;
        const item = mem.read32(P + 8);
        const v = item === 1 ? d.length : item === 2 ? d.fromSec(p.position()) : item === 3 ? 1 : item === 4 ? d.mode() : item === 5 || item === 7 ? 1 : item === 6 ? d.format : item === 8 ? 1 : null;
        if (v === null) return MCIERR.UNSUPPORTED_FUNCTION;
        mem.write32(P + 4, v >>> 0); return 0;
      }
      case MCI_SET: if (flags & F_SET_TIME_FORMAT) { const f = mem.read32(P + 4); if (f !== FORMAT_MS && !(f === FORMAT_FRAMES && p.hasVideo)) return MCIERR.BAD_TIME_FORMAT; d.format = f; } return 0;
      case MCI_WINDOW:
        if (!p.hasVideo) return MCIERR.UNSUPPORTED_FUNCTION;
        if (flags & F_WINDOW_HWND) d.win.hwnd = mem.read32(P + 4);
        if (flags & F_WINDOW_STATE) d.win.shown = mem.read32(P + 8) !== 0; // (SW_HIDE: hidden)
        p.refresh(); return 0;
      case MCI_PUT: {
        if (!p.hasVideo) return MCIERR.UNSUPPORTED_FUNCTION;
        if (!(flags & F_PUT_RECT)) return 0;
        const r = { x: mem.readS32(P + 4), y: mem.readS32(P + 8), w: mem.readS32(P + 12), h: mem.readS32(P + 16) }; // (RECT fields: left, top, width, height)
        if (flags & F_PUT_DESTINATION) d.dst = r; else if (flags & F_PUT_SOURCE) d.srcRect = { l: r.x, t: r.y, w: r.w, h: r.h }; else if (flags & F_PUT_WINDOW) d.win.at = r;
        p.refresh(); return 0;
      }
      case MCI_WHERE: {
        if (!p.hasVideo) return MCIERR.UNSUPPORTED_FUNCTION;
        const s = d.screenRect(), r = flags & F_PUT_SOURCE ? { x: d.srcRect?.l ?? 0, y: d.srcRect?.t ?? 0, w: d.srcRect?.w ?? p.width, h: d.srcRect?.h ?? p.height } : flags & F_PUT_WINDOW ? (d.win.at ?? { x: 0, y: 0, w: p.width, h: p.height }) : (d.dst ?? { x: 0, y: 0, w: s.w, h: s.h });
        mem.write32(P + 4, r.x); mem.write32(P + 8, r.y); mem.write32(P + 12, r.w); mem.write32(P + 16, r.h); return 0;
      }
      case MCI_SETAUDIO: case MCI_CUE: case MCI_INFO: case MCI_GETDEVCAPS: return MCIERR.UNSUPPORTED_FUNCTION;
      default: return MCIERR.UNRECOGNIZED_COMMAND;
    }
  }

  const errorText = (e) => ({ 0: 'The specified command was carried out.', [MCIERR.INVALID_DEVICE_ID]: 'Invalid MCI device ID. Use the ID returned when opening the MCI device.', [MCIERR.FILE_NOT_FOUND]: 'Cannot find the specified file. Make sure the path and filename are correct.', [MCIERR.INVALID_FILE]: 'The specified file cannot be played on the specified MCI device. The file may be corrupt, or not in the correct format.', [MCIERR.UNRECOGNIZED_COMMAND]: 'The driver cannot recognize the specified command.', [MCIERR.INVALID_DEVICE_NAME]: 'The specified device is not open or is not recognized by MCI.' }[e] ?? `MCI error ${e}.`);
  const traced = (name, f) => (c) => { const r = f(c); vm.log('video', `${name} -> ${r}`); return r; };
  api.define('winmm.dll', {
    mciSendStringA: [4, (c) => { const s = c.str(0); const r = sendString(c, s, c.arg(1), c.arg(2), c.arg(3)); vm.log('video', `mciSendString("${s}") -> ${r}`); return r; }],
    mciSendStringW: [4, (c) => { const s = c.wstr(0); const buf = c.arg(1), n = c.arg(2); const tmp = buf && n ? c.proc.processHeap.alloc(n) : 0; try { const r = sendString(c, s, tmp, n, c.arg(3)); if (tmp) mem.writeWString(buf, mem.readCString(tmp), n); vm.log('video', `mciSendString(W "${s}") -> ${r}`); return r; } finally { if (tmp) c.proc.processHeap.free_(tmp); } }],
    mciSendCommandA: [4, traced('mciSendCommand', (c) => sendCommand(c, c.arg(0), c.arg(1), c.arg(2), c.arg(3), false))],
    mciSendCommandW: [4, traced('mciSendCommandW', (c) => sendCommand(c, c.arg(0), c.arg(1), c.arg(2), c.arg(3), true))],
    mciGetErrorStringA: [3, (c) => { if (c.arg(1) && c.arg(2)) mem.writeCString(c.arg(1), errorText(c.arg(0)), c.arg(2)); return 1; }],
    mciGetErrorStringW: [3, (c) => { if (c.arg(1) && c.arg(2)) mem.writeWString(c.arg(1), errorText(c.arg(0)), c.arg(2)); return 1; }],
    mciGetDeviceIDA: [1, (c) => byName(c.str(0))?.id ?? 0],
    mciGetDeviceIDW: [1, (c) => byName(c.wstr(0))?.id ?? 0],
  });
}
