// quartz.dll: DirectShow playback through the filter graph manager (CLSID_FilterGraph) — the path Windows games of
// the DirectX 7-9 era use for their movies: IGraphBuilder::RenderFile builds the graph for a file, IMediaControl runs
// it, IMediaEvent(Ex) reports the end (EC_COMPLETE, an event handle, a notification message), IVideoWindow places the
// video renderer's window over the game's, IBasicVideo / IBasicAudio / IMediaSeeking / IMediaPosition tune it.
//
// The file is played by a MoviePlayer (movie-player.js): read from the virtual file system and decoded in src/media —
// MPEG-1 system streams, MPEG audio, WAVE and AVI files with the codecs Windows ships with (docs/media-playback.md).
// Other files fail as on a Windows without the codec (VFW_E_UNKNOWN_FILE_TYPE / VFW_E_UNSUPPORTED_STREAM): a game then
// skips its movie. Pictures are shown on the host display's video layer, above the game's own layers, in the video
// window's rectangle; sound goes through the DirectSound mixer; playback follows the VM clock.
import { readGuid, writeGuid, S_OK, S_FALSE, E_NOTIMPL, E_POINTER, E_INVALIDARG, E_FAIL } from './com.js';
import { MoviePlayer, MediaClock } from './movie-player.js';

const CLSID_FilterGraph = 'e436ebb3-524f-11ce-9f53-0020af0ba770', CLSID_FilterGraphNoThread = 'e436ebb8-524f-11ce-9f53-0020af0ba770';
const IID = {
  IFilterGraph: '56a8689f-0ad4-11ce-b03a-0020af0ba770', IGraphBuilder: '56a868a9-0ad4-11ce-b03a-0020af0ba770', IFilterGraph2: '36b73882-c2c8-11cf-8b46-00805f6cef60',
  IMediaControl: '56a868b1-0ad4-11ce-b03a-0020af0ba770', IMediaPosition: '56a868b2-0ad4-11ce-b03a-0020af0ba770', IBasicAudio: '56a868b3-0ad4-11ce-b03a-0020af0ba770',
  IVideoWindow: '56a868b4-0ad4-11ce-b03a-0020af0ba770', IBasicVideo: '56a868b5-0ad4-11ce-b03a-0020af0ba770', IBasicVideo2: '329bb360-f6ea-11d1-9038-00a0c9697298',
  IMediaEvent: '56a868b6-0ad4-11ce-b03a-0020af0ba770', IMediaEventEx: '56a868c0-0ad4-11ce-b03a-0020af0ba770', IMediaSeeking: '36b73880-c2c8-11cf-8b46-00805f6cef60',
  IDispatch: '00020400-0000-0000-c000-000000000046',
};
const TIME_FORMAT_MEDIA_TIME = '7b785574-8c82-11cf-bc0c-00aa00ac74f6';
export const HR = {
  E_ABORT: 0x80004004, E_NOINTERFACE: 0x80004002, FILE_NOT_FOUND: 0x80070002, VFW_E_UNKNOWN_FILE_TYPE: 0x80040240, VFW_E_UNSUPPORTED_STREAM: 0x80040265,
  VFW_E_NOT_CONNECTED: 0x80040209, VFW_S_AUDIO_NOT_RENDERED: 0x00040258, VFW_S_VIDEO_NOT_RENDERED: 0x00040257, VFW_E_NO_PALETTE_AVAILABLE: 0x80040253, VFW_E_INVALID_FILE_FORMAT: 0x8004022f,
  VFW_E_WRONG_STATE: 0x80040227, VFW_E_ALREADY_CONNECTED: 0x80040204,
};
export const EC_COMPLETE = 0x01, EC_USERABORT = 0x02, EC_ERRORABORT = 0x03;
const State_Stopped = 0, State_Running = 2; // (FILTER_STATE: State_Paused = 1)
const OATRUE = -1, OAFALSE = 0;
const AM_SEEKING_CAPS = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20; // absolute, forwards, backwards, current / stop position, duration
const WS_CHILD = 0x40000000, WS_OVERLAPPEDWINDOW = 0x00cf0000, WS_CLIPSIBLINGS = 0x04000000; // (the video window: its default style)

const DISPATCH = [['GetTypeInfoCount', 1], ['GetTypeInfo', 3], ['GetIDsOfNames', 5], ['Invoke', 8]];
/** IDispatch (dual interfaces): no type information */
const dispatchImpl = {
  GetTypeInfoCount(c) { c.out32(1, 0); return S_OK; },
  GetTypeInfo(c) { c.out32(3, 0); return E_NOTIMPL; },
  GetIDsOfNames() { return E_NOTIMPL; },
  Invoke() { return E_NOTIMPL; },
};

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerQuartz(api, vm) {
  const mem = vm.mem, com = vm.com;
  com.interface('IDispatch', IID.IDispatch, 'IUnknown', DISPATCH);
  com.interface('IFilterGraph', IID.IFilterGraph, 'IUnknown', [['AddFilter', 2], ['RemoveFilter', 1], ['EnumFilters', 1], ['FindFilterByName', 2], ['ConnectDirect', 3], ['Reconnect', 1], ['Disconnect', 1], ['SetDefaultSyncSource', 0]]);
  com.interface('IGraphBuilder', IID.IGraphBuilder, 'IFilterGraph', [['Connect', 2], ['Render', 1], ['RenderFile', 2], ['AddSourceFilter', 3], ['SetLogFile', 1], ['Abort', 0], ['ShouldOperationContinue', 0]]);
  com.interface('IFilterGraph2', IID.IFilterGraph2, 'IGraphBuilder', [['AddSourceFilterForMoniker', 4], ['ReconnectEx', 2], ['RenderEx', 3]]);
  com.interface('IMediaControl', IID.IMediaControl, 'IDispatch', [['Run', 0], ['Pause', 0], ['Stop', 0], ['GetState', 2], ['RenderFile', 1], ['AddSourceFilter', 2], ['get_FilterCollection', 1], ['get_RegFilterCollection', 1], ['StopWhenReady', 0]]);
  com.interface('IMediaEvent', IID.IMediaEvent, 'IDispatch', [['GetEventHandle', 1], ['GetEvent', 4], ['WaitForCompletion', 2], ['CancelDefaultHandling', 1], ['RestoreDefaultHandling', 1], ['FreeEventParams', 3]]);
  com.interface('IMediaEventEx', IID.IMediaEventEx, 'IMediaEvent', [['SetNotifyWindow', 3], ['SetNotifyFlags', 1], ['GetNotifyFlags', 1]]);
  com.interface('IMediaSeeking', IID.IMediaSeeking, 'IUnknown', [['GetCapabilities', 1], ['CheckCapabilities', 1], ['IsFormatSupported', 1], ['QueryPreferredFormat', 1], ['GetTimeFormat', 1], ['IsUsingTimeFormat', 1], ['SetTimeFormat', 1],
    ['GetDuration', 1], ['GetStopPosition', 1], ['GetCurrentPosition', 1], ['ConvertTimeFormat', 5], ['SetPositions', 4], ['GetPositions', 2], ['GetAvailable', 2], ['SetRate', 2], ['GetRate', 1], ['GetPreroll', 1]]);
  com.interface('IMediaPosition', IID.IMediaPosition, 'IDispatch', [['get_Duration', 1], ['put_CurrentPosition', 2], ['get_CurrentPosition', 1], ['get_StopTime', 1], ['put_StopTime', 2], ['get_PrerollTime', 1], ['put_PrerollTime', 2],
    ['put_Rate', 2], ['get_Rate', 1], ['CanSeekForward', 1], ['CanSeekBackward', 1]]);
  com.interface('IVideoWindow', IID.IVideoWindow, 'IDispatch', [['put_Caption', 1], ['get_Caption', 1], ['put_WindowStyle', 1], ['get_WindowStyle', 1], ['put_WindowStyleEx', 1], ['get_WindowStyleEx', 1], ['put_AutoShow', 1], ['get_AutoShow', 1],
    ['put_WindowState', 1], ['get_WindowState', 1], ['put_BackgroundPalette', 1], ['get_BackgroundPalette', 1], ['put_Visible', 1], ['get_Visible', 1], ['put_Left', 1], ['get_Left', 1], ['put_Width', 1], ['get_Width', 1],
    ['put_Top', 1], ['get_Top', 1], ['put_Height', 1], ['get_Height', 1], ['put_Owner', 1], ['get_Owner', 1], ['put_MessageDrain', 1], ['get_MessageDrain', 1], ['get_BorderColor', 1], ['put_BorderColor', 1],
    ['get_FullScreenMode', 1], ['put_FullScreenMode', 1], ['SetWindowForeground', 1], ['NotifyOwnerMessage', 4], ['SetWindowPosition', 4], ['GetWindowPosition', 4], ['GetMinIdealImageSize', 2], ['GetMaxIdealImageSize', 2],
    ['GetRestorePosition', 4], ['HideCursor', 1], ['IsCursorHidden', 1]]);
  com.interface('IBasicVideo', IID.IBasicVideo, 'IDispatch', [['get_AvgTimePerFrame', 1], ['get_BitRate', 1], ['get_BitErrorRate', 1], ['get_VideoWidth', 1], ['get_VideoHeight', 1], ['put_SourceLeft', 1], ['get_SourceLeft', 1],
    ['put_SourceWidth', 1], ['get_SourceWidth', 1], ['put_SourceTop', 1], ['get_SourceTop', 1], ['put_SourceHeight', 1], ['get_SourceHeight', 1], ['put_DestinationLeft', 1], ['get_DestinationLeft', 1], ['put_DestinationWidth', 1],
    ['get_DestinationWidth', 1], ['put_DestinationTop', 1], ['get_DestinationTop', 1], ['put_DestinationHeight', 1], ['get_DestinationHeight', 1], ['SetSourcePosition', 4], ['GetSourcePosition', 4], ['SetDefaultSourcePosition', 0],
    ['SetDestinationPosition', 4], ['GetDestinationPosition', 4], ['SetDefaultDestinationPosition', 0], ['GetVideoSize', 2], ['GetVideoPaletteEntries', 4], ['GetCurrentImage', 2], ['IsUsingDefaultSource', 0], ['IsUsingDefaultDestination', 0]]);
  com.interface('IBasicVideo2', IID.IBasicVideo2, 'IBasicVideo', [['GetPreferredAspectRatio', 2]]);
  com.interface('IBasicAudio', IID.IBasicAudio, 'IDispatch', [['put_Volume', 1], ['get_Volume', 1], ['put_Balance', 1], ['get_Balance', 1]]);

  vm.media ??= new MediaClock(vm);
  const log = (m) => vm.log('video', m);

  // ---------------------------------------------------------------- the filter graph manager
  /** Interface name -> implementation class (one COM object per interface, all sharing the Graph). */
  const PARTS = {};
  /** A filter graph: its COM objects, events and video window; the file played by a MoviePlayer. */
  class Graph {
    constructor(proc) {
      this.proc = proc; this.parts = new Map(); this.live = 0;
      this.events = []; this.eventHandle = 0; this.notify = null; this.notifyFlags = 0;
      this.win = { visible: false, autoShow: true, owner: 0, drain: 0, style: WS_OVERLAPPEDWINDOW | WS_CLIPSIBLINGS, styleEx: 0, left: 0, top: 0, width: 0, height: 0, fullScreen: false, state: 1, border: 0, caption: 'ActiveMovie Window', cursorHidden: false, placed: false };
      this.srcRect = null; this.dstRect = null; // null: the defaults (the whole picture, the whole window)
      this.emptyCompleted = false;
      this.player = new MoviePlayer(vm, proc, {
        log,
        onComplete: () => this.queueEvent(EC_COMPLETE, S_OK, 0),
        onError: () => this.queueEvent(EC_ERRORABORT, 0x80004005, 0),
        rect: () => this.screenRect(), source: () => this.srcRect, visible: () => this.win.visible,
      });
    }
    /** the COM object for interface `name` (made once; the Graph lives while any of its objects does) */
    part(c, name) {
      let p = this.parts.get(name);
      if (p && com.objectAt(p)) { com.addRef(com.objectAt(p)); return p; }
      const impl = new PARTS[name](this);
      p = com.create(c.proc, name, impl);
      this.parts.set(name, p); this.live++;
      return p;
    }
    released() { if (--this.live === 0) this.destroy(); }
    destroy() {
      this.player.close();
      if (this.eventHandle) { const o = this.proc.handles.getAs(this.eventHandle, 'event'); if (o) o.signaled = false; }
      log(`graph released${this.player.path ? ` (${this.player.path}: ${this.player.report()})` : ''}`);
    }
    // (the player's state, as the interfaces read it)
    get src() { return this.player.src; }
    get state() { return this.player.state; }
    get completed() { return this.player.completed || this.emptyCompleted; }
    get hasVideo() { return this.player.hasVideo; }
    get hasAudio() { return this.player.hasAudio; }
    get duration() { return this.player.duration; }
    get stopTime() { return this.player.stopTime; }
    get stopPos() { return this.player.stopPos; }
    set stopPos(v) { this.player.stopPos = v; }
    position() { return this.player.position(); }
    seek(t) { this.player.seek(t); }

    renderFile(c, name) {
      if (this.player.src) return HR.VFW_E_ALREADY_CONNECTED;
      if (!name) return E_POINTER;
      const path = c.proc.path(name);
      const r = this.player.open(path);
      if (!r.ok) {
        const code = r.code === 'not-found' ? HR.FILE_NOT_FOUND : r.code === 'unsupported' ? HR.VFW_E_UNSUPPORTED_STREAM : r.code === 'unknown' ? HR.VFW_E_UNKNOWN_FILE_TYPE : HR.VFW_E_INVALID_FILE_FORMAT;
        if (r.code !== 'not-found') vm.warn(`DirectShow: RenderFile ${path}: ${r.message} -> 0x${code.toString(16)} (not played)`);
        return code;
      }
      if (this.hasVideo) { this.win.width = this.player.width; this.win.height = this.player.height; }
      // (a stream left out: what the filter graph manager says when some streams could not be rendered)
      return r.left === 'video' ? HR.VFW_S_VIDEO_NOT_RENDERED : r.left === 'audio' ? HR.VFW_S_AUDIO_NOT_RENDERED : S_OK;
    }

    // ---- states
    run() {
      if (this.state === State_Running) return S_OK;
      if (this.state === State_Stopped) this.emptyCompleted = false;
      if (this.hasVideo && this.win.autoShow) this.win.visible = true;
      this.player.run();
      if (!this.src && !this.emptyCompleted) { // (nothing rendered — RenderFile failed and the game ran the graph anyway: a movie of no length)
        this.emptyCompleted = true;
        this.queueEvent(EC_COMPLETE, S_OK, 0);
      }
      log(`Run at ${this.player.pos.toFixed(2)} s${this.player.path ? ` (${this.player.path})` : ''}`);
      return S_OK;
    }
    pause() {
      if (this.hasVideo && this.win.autoShow) this.win.visible = true;
      this.player.pause();
      return S_OK;
    }
    stop() { this.player.stop(); return S_OK; }

    // ---- events
    queueEvent(code, p1, p2) {
      this.events.push([code, p1, p2]);
      if (this.eventHandle) { const o = this.proc.handles.getAs(this.eventHandle, 'event'); if (o) { o.signaled = true; vm.sched.signal(); } }
      if (this.notify && !(this.notifyFlags & 1)) {
        const w = vm.wm?.windows.get(this.notify.hwnd);
        if (w) vm.wm.post(w, this.notify.msg, 0, this.notify.data);
      }
      log(`event ${code}${this.player.path ? ` (${this.player.path})` : ''}`);
    }
    eventHandleOf() {
      if (!this.eventHandle) this.eventHandle = this.proc.handles.create({ type: 'event', manual: true, signaled: this.events.length > 0 });
      return this.eventHandle;
    }
    takeEvent() {
      const e = this.events.shift();
      if (!this.events.length && this.eventHandle) { const o = this.proc.handles.getAs(this.eventHandle, 'event'); if (o) o.signaled = false; }
      return e;
    }

    // ---- the video window
    /** the video window's client area on the screen */
    windowRect() {
      const w = this.win;
      if (w.fullScreen) { const sc = vm.wm?.screen ?? { width: 640, height: 480 }; return { x: 0, y: 0, w: sc.width, h: sc.height }; }
      let x = w.left, y = w.top, ww = w.width, hh = w.height;
      const owner = w.owner ? vm.wm?.windows.get(w.owner) : null;
      const area = owner ? { x: owner.client.l, y: owner.client.t, w: owner.client.r - owner.client.l, h: owner.client.b - owner.client.t } : { x: 0, y: 0, w: vm.wm?.screen.width ?? 640, h: vm.wm?.screen.height ?? 480 };
      if (!w.placed) { // (never placed: a child fills its owner's client area; a top-level window is centered)
        if (owner && w.style & WS_CHILD) { x = area.x; y = area.y; ww = area.w; hh = area.h; } else { x = area.x + ((area.w - ww) >> 1); y = area.y + ((area.h - hh) >> 1); }
      } else if (owner && w.style & WS_CHILD) { x += area.x; y += area.y; } // (a child window: in its owner's client area)
      return { x, y, w: ww, h: hh };
    }
    /** where the picture goes on the screen: the destination rectangle in the window (default: all of it) */
    screenRect() {
      const r = this.windowRect(), d = this.dstRect;
      return d ? { x: r.x + d.l, y: r.y + d.t, w: d.w, h: d.h } : r;
    }
    setVisible(v) { this.win.visible = v; this.player.refresh(); }
    windowChanged() { if (this.win.visible) this.player.refresh(); }
  }

  // ---------------------------------------------------------------- the interfaces
  const GRAPH = {
    AddFilter() { return E_NOTIMPL; }, RemoveFilter() { return E_NOTIMPL; }, EnumFilters(c) { c.out32(1, 0); return E_NOTIMPL; },
    FindFilterByName(c) { c.out32(2, 0); return 0x80040216; /* VFW_E_NOT_FOUND */ }, ConnectDirect() { return E_NOTIMPL; }, Reconnect() { return E_NOTIMPL; },
    Disconnect() { return E_NOTIMPL; }, SetDefaultSyncSource() { return S_OK; },
    Connect() { return E_NOTIMPL; }, Render() { return E_NOTIMPL; },
    RenderFile(c) { return this.g.renderFile(c, c.wstr(1)); },
    AddSourceFilter(c) { c.out32(3, 0); return E_NOTIMPL; }, SetLogFile() { return S_OK; }, Abort() { return S_OK; }, ShouldOperationContinue() { return S_OK; },
    AddSourceFilterForMoniker(c) { c.out32(4, 0); return E_NOTIMPL; }, ReconnectEx() { return E_NOTIMPL; }, RenderEx() { return E_NOTIMPL; },
  };
  const CONTROL = {
    ...dispatchImpl,
    Run() { return this.g.run(); }, Pause() { return this.g.pause(); }, Stop() { return this.g.stop(); }, StopWhenReady() { return this.g.stop(); },
    GetState(c) { if (!c.arg(2)) return E_POINTER; mem.write32(c.arg(2), this.g.state); return S_OK; },
    RenderFile(c) { const a = c.arg(1); return this.g.renderFile(c, a ? mem.readWString(a) : null); },
    AddSourceFilter(c) { c.out32(2, 0); return E_NOTIMPL; }, get_FilterCollection(c) { c.out32(1, 0); return E_NOTIMPL; }, get_RegFilterCollection(c) { c.out32(1, 0); return E_NOTIMPL; },
  };
  const EVENT = {
    ...dispatchImpl,
    GetEventHandle(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.eventHandleOf()); return S_OK; },
    GetEvent(c) {
      const g = this.g, pc = c.arg(1), p1 = c.arg(2), p2 = c.arg(3), timeout = c.arg(4);
      if (!pc || !p1 || !p2) return E_POINTER;
      if (!g.events.length && timeout && !vm.sched.block(c.thread, () => g.events.length > 0, timeout, 'IMediaEvent::GetEvent')) return HR.E_ABORT;
      const e = g.events.length ? g.takeEvent() : null;
      if (!e) return HR.E_ABORT;
      mem.write32(pc, e[0]); mem.write32(p1, e[1]); mem.write32(p2, e[2]);
      return S_OK;
    },
    WaitForCompletion(c) {
      const g = this.g, timeout = c.arg(1), pc = c.arg(2);
      if (!pc) return E_POINTER;
      if (g.state !== State_Running) { mem.write32(pc, 0); return 0x80040227; /* VFW_E_WRONG_STATE */ }
      if (!g.completed && !vm.sched.block(c.thread, () => g.completed, timeout, 'IMediaEvent::WaitForCompletion')) { mem.write32(pc, 0); return HR.E_ABORT; }
      mem.write32(pc, EC_COMPLETE);
      return S_OK;
    },
    CancelDefaultHandling() { return S_OK; }, RestoreDefaultHandling() { return S_OK; }, FreeEventParams() { return S_OK; },
    SetNotifyWindow(c) { const h = c.arg(1); this.g.notify = h ? { hwnd: h, msg: c.arg(2), data: c.arg(3) } : null; return S_OK; },
    SetNotifyFlags(c) { const f = c.arg(1); if (f > 1) return E_INVALIDARG; this.g.notifyFlags = f; return S_OK; },
    GetNotifyFlags(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.notifyFlags); return S_OK; },
  };
  const ticks = (sec) => BigInt(Number.isFinite(sec) ? Math.round(sec * 1e7) : 0); // (REFERENCE_TIME: 100 ns units)
  const seconds = (a) => Number(mem.read64(a)) / 1e7;
  const isMediaTime = (a) => !a || readGuid(mem, a) === TIME_FORMAT_MEDIA_TIME;
  const SEEKING = {
    GetCapabilities(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), AM_SEEKING_CAPS); return S_OK; },
    CheckCapabilities(c) { const p = c.arg(1); if (!p) return E_POINTER; const want = mem.read32(p), have = want & AM_SEEKING_CAPS; mem.write32(p, have); return have === want ? S_OK : have ? S_FALSE : E_FAIL; },
    IsFormatSupported(c) { return isMediaTime(c.arg(1)) ? S_OK : S_FALSE; },
    QueryPreferredFormat(c) { if (!c.arg(1)) return E_POINTER; writeGuid(mem, c.arg(1), TIME_FORMAT_MEDIA_TIME); return S_OK; },
    GetTimeFormat(c) { if (!c.arg(1)) return E_POINTER; writeGuid(mem, c.arg(1), TIME_FORMAT_MEDIA_TIME); return S_OK; },
    IsUsingTimeFormat(c) { return isMediaTime(c.arg(1)) ? S_OK : S_FALSE; },
    SetTimeFormat(c) { return isMediaTime(c.arg(1)) ? S_OK : E_INVALIDARG; },
    GetDuration(c) { if (!c.arg(1)) return E_POINTER; mem.write64(c.arg(1), ticks(this.g.duration)); return S_OK; },
    GetStopPosition(c) { if (!c.arg(1)) return E_POINTER; mem.write64(c.arg(1), ticks(this.g.stopTime)); return S_OK; },
    GetCurrentPosition(c) { if (!c.arg(1)) return E_POINTER; mem.write64(c.arg(1), ticks(this.g.position())); return S_OK; },
    ConvertTimeFormat(c) {
      const out = c.arg(1); if (!out) return E_POINTER;
      if (!isMediaTime(c.arg(2)) || !isMediaTime(c.arg(5))) return E_INVALIDARG;
      mem.write64(out, mem.read64(c.sp + 4 + 12)); return S_OK;
    },
    SetPositions(c) {
      const g = this.g, pc = c.arg(1), fc = c.arg(2), ps = c.arg(3), fs = c.arg(4);
      const pos = (p, f, base) => { const m = f & 3; const v = seconds(p); return m === 1 ? v : m === 2 || m === 3 ? base + v : null; };
      if (ps && (fs & 3)) { const v = pos(ps, fs, g.stopTime); g.stopPos = g.duration && v >= g.duration ? null : Math.max(0, v); if (fs & 8) mem.write64(ps, ticks(g.stopTime)); }
      if (pc && (fc & 3)) { g.seek(pos(pc, fc, g.position())); if (fc & 8) mem.write64(pc, ticks(g.position())); }
      return S_OK;
    },
    GetPositions(c) { if (c.arg(1)) mem.write64(c.arg(1), ticks(this.g.position())); if (c.arg(2)) mem.write64(c.arg(2), ticks(this.g.stopTime)); return S_OK; },
    GetAvailable(c) { if (c.arg(1)) mem.write64(c.arg(1), 0n); if (c.arg(2)) mem.write64(c.arg(2), ticks(this.g.duration)); return S_OK; },
    SetRate(c) { return c.argF64(1) === 1 ? S_OK : E_NOTIMPL; },
    GetRate(c) { if (!c.arg(1)) return E_POINTER; mem.writeF64(c.arg(1), 1); return S_OK; },
    GetPreroll(c) { if (!c.arg(1)) return E_POINTER; mem.write64(c.arg(1), 0n); return S_OK; },
  };
  const POSITION = {
    ...dispatchImpl,
    get_Duration(c) { if (!c.arg(1)) return E_POINTER; mem.writeF64(c.arg(1), this.g.duration); return S_OK; },
    put_CurrentPosition(c) { this.g.seek(c.argF64(1)); return S_OK; },
    get_CurrentPosition(c) { if (!c.arg(1)) return E_POINTER; mem.writeF64(c.arg(1), this.g.position()); return S_OK; },
    get_StopTime(c) { if (!c.arg(1)) return E_POINTER; mem.writeF64(c.arg(1), Number.isFinite(this.g.stopTime) ? this.g.stopTime : 0); return S_OK; },
    put_StopTime(c) { const v = c.argF64(1); this.g.stopPos = this.g.duration && v >= this.g.duration ? null : Math.max(0, v); return S_OK; },
    get_PrerollTime(c) { if (!c.arg(1)) return E_POINTER; mem.writeF64(c.arg(1), 0); return S_OK; },
    put_PrerollTime() { return S_OK; },
    put_Rate(c) { return c.argF64(1) === 1 ? S_OK : E_NOTIMPL; },
    get_Rate(c) { if (!c.arg(1)) return E_POINTER; mem.writeF64(c.arg(1), 1); return S_OK; },
    CanSeekForward(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), OATRUE >>> 0); return S_OK; },
    CanSeekBackward(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), OATRUE >>> 0); return S_OK; },
  };
  // IVideoWindow / IBasicVideo of a graph without video: E_NOINTERFACE from every method (the filter graph manager
  // answers for the renderer it does not have)
  const needVideo = (impl) => {
    const out = {};
    for (const [k, fn] of Object.entries(impl)) out[k] = k in dispatchImpl ? fn : function (c) { return this.g.hasVideo ? fn.call(this, c) : HR.E_NOINTERFACE; };
    return out;
  };
  const prop = (get, set, after) => [function (c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), get(this.g) >>> 0); return S_OK; }, function (c) { set(this.g, c.sarg(1)); after?.(this.g); return S_OK; }];
  const placed = (g) => { g.win.placed = true; g.windowChanged(); };
  const [getLeft, putLeft] = prop((g) => g.win.left, (g, v) => { g.win.left = v; }, placed);
  const [getTop, putTop] = prop((g) => g.win.top, (g, v) => { g.win.top = v; }, placed);
  const [getWidth, putWidth] = prop((g) => g.win.width, (g, v) => { g.win.width = v; }, placed);
  const [getHeight, putHeight] = prop((g) => g.win.height, (g, v) => { g.win.height = v; }, placed);
  const WINDOW = needVideo({
    ...dispatchImpl,
    put_Caption(c) { const a = c.arg(1); this.g.win.caption = a ? mem.readWString(a) : ''; return S_OK; },
    get_Caption(c) { c.out32(1, 0); return E_NOTIMPL; },
    put_WindowStyle(c) { this.g.win.style = c.arg(1); this.g.windowChanged(); return S_OK; },
    get_WindowStyle(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.style); return S_OK; },
    put_WindowStyleEx(c) { this.g.win.styleEx = c.arg(1); return S_OK; },
    get_WindowStyleEx(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.styleEx); return S_OK; },
    put_AutoShow(c) { this.g.win.autoShow = c.sarg(1) !== OAFALSE; return S_OK; },
    get_AutoShow(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.autoShow ? OATRUE >>> 0 : 0); return S_OK; },
    put_WindowState(c) { const s = c.arg(1); this.g.win.state = s; this.g.setVisible(s !== 0); return S_OK; }, // (SW_HIDE: hidden; any other: shown)
    get_WindowState(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.visible ? this.g.win.state || 1 : 0); return S_OK; },
    put_BackgroundPalette() { return S_OK; }, get_BackgroundPalette(c) { c.out32(1, 0); return S_OK; },
    put_Visible(c) { this.g.setVisible(c.sarg(1) !== OAFALSE); return S_OK; },
    get_Visible(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.visible ? OATRUE >>> 0 : 0); return S_OK; },
    put_Left: putLeft, get_Left: getLeft, put_Top: putTop, get_Top: getTop, put_Width: putWidth, get_Width: getWidth, put_Height: putHeight, get_Height: getHeight,
    put_Owner(c) { this.g.win.owner = c.arg(1); this.g.windowChanged(); return S_OK; },
    get_Owner(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.owner); return S_OK; },
    put_MessageDrain(c) { this.g.win.drain = c.arg(1); return S_OK; },
    get_MessageDrain(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.drain); return S_OK; },
    get_BorderColor(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.border); return S_OK; },
    put_BorderColor(c) { this.g.win.border = c.arg(1); return S_OK; },
    get_FullScreenMode(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.fullScreen ? OATRUE >>> 0 : 0); return S_OK; },
    put_FullScreenMode(c) { this.g.win.fullScreen = c.sarg(1) !== OAFALSE; this.g.windowChanged(); return S_OK; },
    SetWindowForeground() { return S_OK; },
    NotifyOwnerMessage() { return S_OK; },
    SetWindowPosition(c) { const w = this.g.win; w.left = c.sarg(1); w.top = c.sarg(2); w.width = c.sarg(3); w.height = c.sarg(4); placed(this.g); return S_OK; },
    GetWindowPosition(c) { const [x, y, w, h] = this.position(); c.out32(1, x); c.out32(2, y); c.out32(3, w); c.out32(4, h); return S_OK; },
    GetRestorePosition(c) { const [x, y, w, h] = this.position(); c.out32(1, x); c.out32(2, y); c.out32(3, w); c.out32(4, h); return S_OK; },
    /** the window's position as SetWindowPosition takes it (a child's: in its owner's client area) */
    position() { const g = this.g, r = g.windowRect(), w = g.win, child = w.owner && w.style & WS_CHILD && !w.fullScreen; return w.placed && !w.fullScreen ? [w.left, w.top, r.w, r.h] : child ? [0, 0, r.w, r.h] : [r.x, r.y, r.w, r.h]; },
    GetMinIdealImageSize(c) { c.out32(1, this.g.src.width); c.out32(2, this.g.src.height); return S_OK; },
    GetMaxIdealImageSize(c) { c.out32(1, this.g.src.width); c.out32(2, this.g.src.height); return S_OK; },
    HideCursor(c) { this.g.win.cursorHidden = c.sarg(1) !== OAFALSE; return S_OK; },
    IsCursorHidden(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.win.cursorHidden ? OATRUE >>> 0 : 0); return S_OK; },
  });
  const rectProp = (which, key) => [
    function (c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.rect(which)[key] >>> 0); return S_OK; },
    function (c) { const r = { ...this.rect(which) }; r[key] = c.sarg(1); return this.setRect(which, r); },
  ];
  const VIDEO = needVideo({
    ...dispatchImpl,
    get_AvgTimePerFrame(c) { if (!c.arg(1)) return E_POINTER; mem.writeF64(c.arg(1), 1 / this.g.src.fps); return S_OK; },
    get_BitRate(c) { c.out32(1, this.g.src.bitRate ?? 0); return S_OK; },
    get_BitErrorRate(c) { c.out32(1, 0); return S_OK; },
    get_VideoWidth(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.src.width); return S_OK; },
    get_VideoHeight(c) { if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.src.height); return S_OK; },
    ...Object.fromEntries([['Source', 'src'], ['Destination', 'dst']].flatMap(([n, w]) => [['Left', 'l'], ['Top', 't'], ['Width', 'w'], ['Height', 'h']].flatMap(([p, k]) => { const [g, s] = rectProp(w, k); return [[`get_${n}${p}`, g], [`put_${n}${p}`, s]]; }))),
    SetSourcePosition(c) { return this.setRect('src', { l: c.sarg(1), t: c.sarg(2), w: c.sarg(3), h: c.sarg(4) }); },
    GetSourcePosition(c) { const r = this.rect('src'); c.out32(1, r.l); c.out32(2, r.t); c.out32(3, r.w); c.out32(4, r.h); return S_OK; },
    SetDefaultSourcePosition() { this.g.srcRect = null; this.g.windowChanged(); return S_OK; },
    SetDestinationPosition(c) { return this.setRect('dst', { l: c.sarg(1), t: c.sarg(2), w: c.sarg(3), h: c.sarg(4) }); },
    GetDestinationPosition(c) { const r = this.rect('dst'); c.out32(1, r.l); c.out32(2, r.t); c.out32(3, r.w); c.out32(4, r.h); return S_OK; },
    SetDefaultDestinationPosition() { this.g.dstRect = null; this.g.windowChanged(); return S_OK; },
    GetVideoSize(c) { c.out32(1, this.g.src.width); c.out32(2, this.g.src.height); return S_OK; },
    GetVideoPaletteEntries() { return HR.VFW_E_NO_PALETTE_AVAILABLE; },
    GetCurrentImage() { return E_NOTIMPL; },
    IsUsingDefaultSource() { return this.g.srcRect ? S_FALSE : S_OK; },
    IsUsingDefaultDestination() { return this.g.dstRect ? S_FALSE : S_OK; },
    GetPreferredAspectRatio(c) { c.out32(1, this.g.src.width); c.out32(2, this.g.src.height); return S_OK; },
  });
  const AUDIO = {
    ...dispatchImpl,
    put_Volume(c) { const g = this.g, v = c.sarg(1); if (!g.hasAudio) return E_NOTIMPL; if (v > 0 || v < -10000) return E_INVALIDARG; g.player.setVolume(v); return S_OK; },
    get_Volume(c) { if (!this.g.hasAudio) return E_NOTIMPL; if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.player.volume >>> 0); return S_OK; },
    put_Balance(c) { const g = this.g, v = c.sarg(1); if (!g.hasAudio) return E_NOTIMPL; if (v > 10000 || v < -10000) return E_INVALIDARG; g.player.setBalance(v); return S_OK; },
    get_Balance(c) { if (!this.g.hasAudio) return E_NOTIMPL; if (!c.arg(1)) return E_POINTER; mem.write32(c.arg(1), this.g.player.balance >>> 0); return S_OK; },
  };

  /** the implementation of one interface of a graph; QueryInterface answers with the graph's other interfaces */
  const part = (methods, iids = []) => class {
    constructor(g) { this.g = g; this.iids = iids; }
    queryInterface(c, iid) { const name = BY_IID.get(iid); return name ? this.g.part(c, name) : 0; }
    destroy() { this.g.released(); }
  };
  const define = (name, methods, iids) => { const C = part(methods, iids); Object.assign(C.prototype, methods); PARTS[name] = C; };
  define('IFilterGraph2', GRAPH, [IID.IFilterGraph, IID.IGraphBuilder]);
  define('IMediaControl', CONTROL);
  define('IMediaEventEx', EVENT, [IID.IMediaEvent]);
  define('IMediaSeeking', SEEKING);
  define('IMediaPosition', POSITION);
  define('IVideoWindow', WINDOW);
  define('IBasicVideo2', VIDEO, [IID.IBasicVideo]);
  define('IBasicAudio', AUDIO);
  Object.assign(PARTS.IBasicVideo2.prototype, {
    rect(which) { const g = this.g; return (which === 'src' ? g.srcRect : g.dstRect) ?? (which === 'src' ? { l: 0, t: 0, w: g.src.width, h: g.src.height } : { l: 0, t: 0, w: g.windowRect().w, h: g.windowRect().h }); },
    setRect(which, r) {
      const g = this.g;
      if (r.w <= 0 || r.h <= 0 || r.l < 0 || r.t < 0) return E_INVALIDARG;
      if (which === 'src') { if (r.l + r.w > g.src.width || r.t + r.h > g.src.height) return E_INVALIDARG; g.srcRect = r; } else g.dstRect = r;
      g.windowChanged();
      return S_OK;
    },
  });
  /** IID -> the part answering it */
  const BY_IID = new Map([
    [IID.IFilterGraph, 'IFilterGraph2'], [IID.IGraphBuilder, 'IFilterGraph2'], [IID.IFilterGraph2, 'IFilterGraph2'],
    [IID.IMediaControl, 'IMediaControl'], [IID.IMediaEvent, 'IMediaEventEx'], [IID.IMediaEventEx, 'IMediaEventEx'], [IID.IMediaSeeking, 'IMediaSeeking'],
    [IID.IMediaPosition, 'IMediaPosition'], [IID.IVideoWindow, 'IVideoWindow'], [IID.IBasicVideo, 'IBasicVideo2'], [IID.IBasicVideo2, 'IBasicVideo2'], [IID.IBasicAudio, 'IBasicAudio'],
  ]);

  const factory = (c, iid) => {
    const g = new Graph(c.proc);
    const name = BY_IID.get(iid) ?? 'IFilterGraph2';
    return g.part(c, name);
  };
  com.registerClass(CLSID_FilterGraph, factory);
  com.registerClass(CLSID_FilterGraphNoThread, factory);
}
