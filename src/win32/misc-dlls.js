// Smaller system DLLs: winmm, ole32, oleaut32, shell32, imm32, comctl32, version,
// ws2_32/wsock32, plus never-needed ones (tapi32, netapi32, avifil32, wintrust, psapi...).
import { E } from './errors.js';
import { CC_CDECL } from './api.js';
import { allocString } from './kernel32.js';
import { TICK_BASE } from '../cpu/jit/runtime.js';

const S_OK = 0, E_FAIL = 0x80004005, E_NOTIMPL = 0x80004001, E_NOINTERFACE = 0x80004002, REGDB_E_CLASSNOTREG = 0x80040154, CLASS_E_NOAGGREGATION = 0x80040110;
const MMSYSERR_NOERROR = 0, MMSYSERR_NODRIVER = 6, MMSYSERR_NOTSUPPORTED = 8, MMSYSERR_BADDEVICEID = 2, JOYERR_UNPLUGGED = 167;

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
import { TS } from './process.js';

export function registerMiscDlls(api, vm) {
  const mem = vm.mem;

  // ---------------------------------------------------------------- winmm
  const W = {};
  W.timeGetTime = [0, () => (TICK_BASE + Math.floor(vm.clock.now())) >>> 0];
  W.timeBeginPeriod = [1, () => MMSYSERR_NOERROR];
  W.timeEndPeriod = [1, () => MMSYSERR_NOERROR];
  W.timeGetDevCaps = [2, (c) => { mem.write32(c.arg(0), 1); mem.write32(c.arg(0) + 4, 1000000); return MMSYSERR_NOERROR; }];
  W.timeGetSystemTime = [2, (c) => { mem.write32(c.arg(0), 1); mem.write32(c.arg(0) + 4, (TICK_BASE + Math.floor(vm.clock.now())) >>> 0); return MMSYSERR_NOERROR; }];
  W.timeSetEvent = [5, (c) => {
    const delay = Math.max(c.arg(0), 1), fn = c.arg(2), user = c.arg(3), flags = c.arg(4);
    const id = c.proc.nextMmTimer = (c.proc.nextMmTimer ?? 0x100) + 1;
    c.proc.timers.push({ kind: 'mm', id, elapse: delay, due: vm.clock.now() + delay, proc: fn, user, periodic: (flags & 1) !== 0, mode: flags & 0x30, thread: c.thread });
    // callbacks run on a dedicated timer thread (like the multimedia timer thread of Windows)
    if (!c.proc.mmThread || c.proc.mmThread.state === TS.DONE) {
      const t = c.proc.createThread({ start: api.thunkFor('orthros.dll', '__mm_timer'), param: 0, stackSize: 0x10000 });
      t.name = 'mmtimer'; t.priority = 15;
      c.proc.mmThread = t;
    } else vm.sched.wakeBlocked();
    return id;
  }];
  W.timeKillEvent = [1, (c) => { const n = c.proc.timers.length; c.proc.timers = c.proc.timers.filter((t) => !(t.kind === 'mm' && t.id === c.arg(0))); return n !== c.proc.timers.length ? MMSYSERR_NOERROR : 96; }];
  W.joyGetNumDevs = [0, () => 0];
  W.joyGetPos = [2, () => JOYERR_UNPLUGGED]; W.joyGetPosEx = [2, () => JOYERR_UNPLUGGED]; W.joyGetDevCapsA = [3, () => MMSYSERR_NODRIVER]; W.joySetCapture = [4, () => JOYERR_UNPLUGGED]; W.joyReleaseCapture = [1, () => MMSYSERR_NOERROR];
  W.mciSendCommandA = [4, () => 0x101]; W.mciSendStringA = [4, (c) => { vm.log('audio', `mciSendString(${c.str(0)})`); return 0x101; }]; W.mciGetErrorStringA = [3, (c) => { mem.writeCString(c.arg(1), 'MCI unsupported', c.arg(2)); return 1; }];
  W.waveOutGetNumDevs = [0, () => 0]; W.waveOutOpen = [6, () => MMSYSERR_NODRIVER]; W.waveOutClose = [1, () => MMSYSERR_NOERROR]; W.waveOutGetDevCapsA = [3, () => MMSYSERR_BADDEVICEID];
  W.waveOutPrepareHeader = [3, () => MMSYSERR_NOERROR]; W.waveOutUnprepareHeader = [3, () => MMSYSERR_NOERROR]; W.waveOutWrite = [3, () => MMSYSERR_NOERROR]; W.waveOutReset = [1, () => MMSYSERR_NOERROR];
  W.waveOutGetPosition = [3, () => MMSYSERR_NOERROR]; W.waveOutSetVolume = [2, () => MMSYSERR_NOERROR]; W.waveOutGetVolume = [2, (c) => { mem.write32(c.arg(1), 0xffffffff); return MMSYSERR_NOERROR; }]; W.waveOutPause = [1, () => MMSYSERR_NOERROR]; W.waveOutRestart = [1, () => MMSYSERR_NOERROR];
  W.waveInGetNumDevs = [0, () => 0]; W.waveInOpen = [6, () => MMSYSERR_NODRIVER];
  W.midiOutGetNumDevs = [0, () => 0]; W.midiOutOpen = [5, () => MMSYSERR_NODRIVER]; W.midiOutClose = [1, () => MMSYSERR_NOERROR]; W.midiStreamOpen = [6, () => MMSYSERR_NODRIVER];
  W.mixerGetNumDevs = [0, () => 0]; W.mixerOpen = [5, () => MMSYSERR_NODRIVER]; W.mixerClose = [1, () => MMSYSERR_NOERROR]; W.mixerGetLineInfoA = [3, () => MMSYSERR_NODRIVER]; W.mixerGetLineControlsA = [3, () => MMSYSERR_NODRIVER]; W.mixerGetControlDetailsA = [3, () => MMSYSERR_NODRIVER]; W.mixerSetControlDetails = [3, () => MMSYSERR_NODRIVER];
  W.auxGetNumDevs = [0, () => 0]; W.auxGetVolume = [2, () => MMSYSERR_NODRIVER]; W.auxSetVolume = [2, () => MMSYSERR_NODRIVER];
  W.PlaySoundA = [3, () => 1]; W.sndPlaySoundA = [2, () => 1];
  W.mmioOpenA = [3, () => 0]; W.mmioClose = [2, () => 0]; W.mmioRead = [3, () => 0xffffffff]; W.mmioDescend = [4, () => 0x100]; W.mmioAscend = [3, () => 0]; W.mmioSeek = [3, () => 0xffffffff];
  W.mmioStringToFOURCCA = [2, (c) => { const s = (c.str(0) ?? '').padEnd(4, ' '); return (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0; }];
  W.mmsystemGetVersion = [0, () => 0x0501];
  api.define('winmm.dll', W);

  // ---------------------------------------------------------------- ole32 / oleaut32
  const O = {};
  O.CoInitialize = [1, () => S_OK]; O.CoInitializeEx = [2, () => S_OK]; O.CoUninitialize = [0, () => {}];
  O.CoInitializeSecurity = [9, () => S_OK];
  O.CoCreateInstance = [5, (c) => {
    const clsid = guidOf(mem, c.arg(0)), iid = guidOf(mem, c.arg(3));
    const r = vm.com?.createInstance?.(c, clsid, iid, c.arg(4));
    if (r !== undefined) return r;
    vm.warn(`CoCreateInstance(${clsid}, ${iid}) -> class not registered`);
    mem.write32(c.arg(4), 0);
    return REGDB_E_CLASSNOTREG;
  }];
  O.CoCreateInstanceEx = [6, () => REGDB_E_CLASSNOTREG];
  O.CoGetClassObject = [5, () => REGDB_E_CLASSNOTREG];
  O.CoTaskMemAlloc = [1, (c) => c.proc.processHeap.alloc(c.arg(0))];
  O.CoTaskMemRealloc = [2, (c) => (c.arg(0) ? c.proc.processHeap.realloc(c.arg(0), c.arg(1)) : c.proc.processHeap.alloc(c.arg(1)))];
  O.CoTaskMemFree = [1, (c) => { if (c.arg(0)) c.proc.processHeap.free_(c.arg(0)); }];
  O.CoFreeUnusedLibraries = [0, () => {}];
  O.CoCreateGuid = [1, (c) => { for (let i = 0; i < 16; i++) mem.write8(c.arg(0) + i, (Math.random() * 256) | 0); return S_OK; }];
  O.CLSIDFromString = [2, (c) => { const s = mem.readWString(c.arg(0)); return parseGuid(mem, s, c.arg(1)) ? S_OK : 0x800401f3; }];
  O.IIDFromString = O.CLSIDFromString;
  O.CLSIDFromProgID = [2, () => 0x800401f3];
  O.StringFromGUID2 = [3, (c) => { const s = '{' + guidOf(mem, c.arg(0)).toUpperCase() + '}'; if (c.arg(2) <= s.length) return 0; mem.writeWString(c.arg(1), s); return s.length + 1; }];
  O.StringFromCLSID = [2, (c) => { const s = '{' + guidOf(mem, c.arg(0)).toUpperCase() + '}'; const p = c.proc.processHeap.alloc(2 * (s.length + 1)); mem.writeWString(p, s); mem.write32(c.arg(1), p); return S_OK; }];
  O.OleInitialize = [1, () => S_OK]; O.OleUninitialize = [0, () => {}];
  O.CoRegisterMessageFilter = [2, (c) => { if (c.arg(1)) mem.write32(c.arg(1), 0); return S_OK; }];
  O.CoSetProxyBlanket = [9, () => S_OK];
  O.CoRevokeClassObject = [1, () => S_OK];
  O.CoRegisterClassObject = [5, (c) => { mem.write32(c.arg(4), 1); return S_OK; }];
  O.CoLockObjectExternal = [3, () => S_OK];
  O.CoDisconnectObject = [2, () => S_OK];
  O.RegisterDragDrop = [2, () => S_OK]; O.RevokeDragDrop = [1, () => S_OK];
  O.CreateStreamOnHGlobal = [3, () => E_NOTIMPL];
  O.GetHGlobalFromStream = [2, () => E_NOTIMPL];
  O.PropVariantClear = [1, () => S_OK];
  O.CoWaitForMultipleHandles = [5, () => 0x80004005];
  api.define('ole32.dll', O);
  const OA = {};
  OA.SysAllocString = [1, (c) => bstrAlloc(c, c.arg(0) ? mem.readWString(c.arg(0)) : '')];
  OA.SysAllocStringLen = [2, (c) => bstrAlloc(c, c.arg(0) ? mem.readWStringN(c.arg(0), c.arg(1)) : '\0'.repeat(c.arg(1)))];
  OA.SysAllocStringByteLen = [2, (c) => { const n = c.arg(1); const p = c.proc.processHeap.alloc(n + 6); mem.write32(p, n); if (c.arg(0)) mem.copy(p + 4, c.arg(0), n); mem.write16(p + 4 + n, 0); return p + 4; }];
  OA.SysFreeString = [1, (c) => { if (c.arg(0)) c.proc.processHeap.free_(c.arg(0) - 4); }];
  OA.SysStringLen = [1, (c) => (c.arg(0) ? mem.read32(c.arg(0) - 4) / 2 : 0)];
  OA.SysStringByteLen = [1, (c) => (c.arg(0) ? mem.read32(c.arg(0) - 4) : 0)];
  OA.SysReAllocString = [2, (c) => { const s = c.arg(1) ? mem.readWString(c.arg(1)) : ''; mem.write32(c.arg(0), bstrAlloc(c, s)); return 1; }];
  OA.VariantInit = [1, (c) => { mem.fill(c.arg(0), 16, 0); }];
  OA.VariantClear = [1, (c) => { mem.fill(c.arg(0), 16, 0); return S_OK; }];
  OA.VariantCopy = [2, (c) => { mem.copy(c.arg(0), c.arg(1), 16); return S_OK; }];
  OA.VariantChangeType = [4, () => E_NOTIMPL];
  OA.SafeArrayCreate = [3, () => 0]; OA.SafeArrayDestroy = [1, () => S_OK]; OA.SafeArrayGetUBound = [3, () => E_FAIL]; OA.SafeArrayGetLBound = [3, () => E_FAIL]; OA.SafeArrayAccessData = [2, () => E_FAIL]; OA.SafeArrayUnaccessData = [1, () => S_OK];
  OA.LoadTypeLib = [2, () => E_FAIL]; OA.RegisterTypeLib = [3, () => E_FAIL];
  OA.OleLoadPicture = [5, () => E_FAIL];
  OA.SystemTimeToVariantTime = [2, (c) => { mem.writeF64(c.arg(1), 38000); return 1; }];
  OA.VariantTimeToSystemTime = [3, () => 1];
  OA.GetErrorInfo = [2, (c) => { mem.write32(c.arg(1), 0); return 1; }];
  OA.SetErrorInfo = [2, () => S_OK];
  api.define('oleaut32.dll', OA);
  api.ordinals('oleaut32.dll', { 2: 'SysAllocString', 4: 'SysAllocStringLen', 6: 'SysFreeString', 7: 'SysStringLen', 8: 'VariantInit', 9: 'VariantClear', 10: 'VariantCopy', 12: 'VariantChangeType', 149: 'SysStringByteLen', 150: 'SysAllocStringByteLen', 200: 'GetErrorInfo', 201: 'SetErrorInfo' });

  // ---------------------------------------------------------------- shell32
  const SH = {};
  const folderPath = (csidl) => {
    switch (csidl & 0xff) {
      case 0x00: case 0x10: return 'C:\\Users\\Player\\Desktop';
      case 0x05: return 'C:\\Users\\Player\\Documents';
      case 0x1a: return 'C:\\Users\\Player\\AppData\\Roaming';
      case 0x1c: return 'C:\\Users\\Player\\AppData\\Local';
      case 0x23: return 'C:\\ProgramData';
      case 0x24: return 'C:\\Windows';
      case 0x25: return 'C:\\Windows\\System32';
      case 0x26: return 'C:\\Program Files';
      case 0x27: return 'C:\\Users\\Player\\Pictures';
      case 0x28: return 'C:\\Users\\Player';
      case 0x2b: return 'C:\\Program Files\\Common Files';
      case 0x2e: return 'C:\\Users\\Public\\Documents';
      case 0x0d: return 'C:\\Users\\Player\\Music';
      case 0x0e: return 'C:\\Users\\Player\\Videos';
      default: return 'C:\\Users\\Player';
    }
  };
  SH.SHGetFolderPathA = [5, (c) => { mem.writeCString(c.arg(4), folderPath(c.arg(1)), 260); return S_OK; }];
  SH.SHGetFolderPathW = [5, (c) => { mem.writeWString(c.arg(4), folderPath(c.arg(1)), 260); return S_OK; }];
  SH.SHGetSpecialFolderPathA = [4, (c) => { mem.writeCString(c.arg(1), folderPath(c.arg(2)), 260); return 1; }];
  SH.SHGetSpecialFolderPathW = [4, (c) => { mem.writeWString(c.arg(1), folderPath(c.arg(2)), 260); return 1; }];
  SH.SHGetSpecialFolderLocation = [3, (c) => { const p = c.proc.processHeap.alloc(8, true); mem.write16(p, 4); mem.write16(p + 2, c.arg(1) & 0xff); mem.write32(c.arg(2), p); return S_OK; }];
  SH.SHGetPathFromIDListA = [2, (c) => { mem.writeCString(c.arg(1), folderPath(mem.read16(c.arg(0) + 2)), 260); return 1; }];
  SH.SHGetPathFromIDListW = [2, (c) => { mem.writeWString(c.arg(1), folderPath(mem.read16(c.arg(0) + 2)), 260); return 1; }];
  SH.SHGetMalloc = [1, (c) => { mem.write32(c.arg(0), 0); return E_FAIL; }];
  SH.SHGetDesktopFolder = [1, () => E_FAIL];
  SH.SHBrowseForFolderA = [1, () => 0];
  SH.ShellExecuteA = [6, (c) => { vm.warn(`ShellExecute(${c.str(2)} ${c.str(3) ?? ''})`); return 33; }];
  SH.ShellExecuteW = [6, (c) => { vm.warn(`ShellExecute(${c.wstr(2)})`); return 33; }];
  SH.ShellExecuteExA = [1, () => 1]; SH.ShellExecuteExW = [1, () => 1];
  SH.SHGetFileInfoA = [5, () => 0];
  SH.SHFileOperationA = [1, () => 0];
  SH.SHCreateDirectoryExA = [3, (c) => (vm.vfs.mkdir(c.proc.path(c.str(1) ?? '')) ? 0 : 183)];
  SH.SHAppBarMessage = [2, () => 0];
  SH.DragAcceptFiles = [2, () => {}]; SH.DragQueryFileA = [4, () => 0]; SH.DragFinish = [1, () => {}];
  SH.Shell_NotifyIconA = [2, () => 1];
  SH.ExtractIconA = [3, () => 0]; SH.ExtractIconExA = [5, () => 0];
  SH.SHAddToRecentDocs = [2, () => {}];
  SH.CommandLineToArgvW = [2, (c) => { const s = c.wstr(0) ?? ''; const parts = s.match(/"[^"]*"|\S+/g) ?? []; const arr = c.proc.processHeap.alloc(4 * (parts.length + 1) + 2 * (s.length + parts.length + 1)); let sp = arr + 4 * (parts.length + 1); parts.forEach((p, i) => { const t = p.replace(/^"|"$/g, ''); mem.write32(arr + 4 * i, sp); mem.writeWString(sp, t); sp += 2 * (t.length + 1); }); mem.write32(c.arg(1), parts.length); return arr; }];
  api.define('shell32.dll', SH);

  // ---------------------------------------------------------------- imm32
  const IM = {};
  IM.ImmGetContext = [1, () => 0]; IM.ImmReleaseContext = [2, () => 1]; IM.ImmAssociateContext = [2, () => 0]; IM.ImmAssociateContextEx = [3, () => 1];
  IM.ImmDisableIME = [1, () => 1]; IM.ImmGetOpenStatus = [1, () => 0]; IM.ImmSetOpenStatus = [2, () => 1]; IM.ImmSetCompositionWindow = [2, () => 1]; IM.ImmSetCandidateWindow = [2, () => 1];
  IM.ImmGetCompositionStringA = [4, () => 0]; IM.ImmGetCompositionStringW = [4, () => 0]; IM.ImmNotifyIME = [4, () => 1]; IM.ImmGetCandidateListA = [4, () => 0]; IM.ImmGetCandidateListCountA = [2, () => 0];
  IM.ImmGetDefaultIMEWnd = [1, () => 0]; IM.ImmIsIME = [1, () => 0]; IM.ImmGetConversionStatus = [3, () => 0]; IM.ImmSetConversionStatus = [3, () => 1]; IM.ImmGetIMEFileNameA = [3, () => 0]; IM.ImmGetProperty = [2, () => 0]; IM.ImmGetVirtualKey = [1, () => 0];
  IM.ImmSetCompositionFontA = [2, () => 1]; IM.ImmGetDescriptionA = [3, () => 0]; IM.ImmSimulateHotKey = [2, () => 0]; IM.ImmEscapeA = [4, () => 0]; IM.ImmCreateContext = [0, () => 0]; IM.ImmDestroyContext = [1, () => 1];
  api.define('imm32.dll', IM);

  // ---------------------------------------------------------------- comctl32
  const CC = {};
  CC.InitCommonControls = [0, () => {}]; CC.InitCommonControlsEx = [1, () => 1];
  CC.ImageList_Create = [5, (c) => c.proc.handles.create({ type: 'imagelist' })]; CC.ImageList_Destroy = [1, () => 1]; CC.ImageList_Add = [3, () => 0]; CC.ImageList_AddMasked = [3, () => 0]; CC.ImageList_ReplaceIcon = [3, () => 0]; CC.ImageList_Draw = [6, () => 1]; CC.ImageList_GetImageCount = [1, () => 0]; CC.ImageList_Remove = [2, () => 1]; CC.ImageList_SetBkColor = [2, () => 0];
  CC.CreateToolbarEx = [13, () => 0]; CC.CreateStatusWindowA = [4, () => 0]; CC.CreatePropertySheetPageA = [1, () => 0]; CC.PropertySheetA = [1, () => 0xffffffff];
  CC._TrackMouseEvent = [1, () => 1];
  CC.DllGetVersion = [1, (c) => { const p = c.arg(0); mem.write32(p + 4, 5); mem.write32(p + 8, 82); mem.write32(p + 12, 0); mem.write32(p + 16, 2); return S_OK; }];
  api.define('comctl32.dll', CC);
  api.ordinals('comctl32.dll', { 17: 'InitCommonControls' });

  // ---------------------------------------------------------------- version
  const V = {};
  V.GetFileVersionInfoSizeA = [2, (c) => { if (c.arg(1)) mem.write32(c.arg(1), 0); return 0; }];
  V.GetFileVersionInfoSizeW = V.GetFileVersionInfoSizeA;
  V.GetFileVersionInfoA = [4, () => 0]; V.GetFileVersionInfoW = [4, () => 0];
  V.VerQueryValueA = [4, () => 0]; V.VerQueryValueW = [4, () => 0];
  V.VerLanguageNameA = [3, (c) => { mem.writeCString(c.arg(1), 'English (United States)', c.arg(2)); return 23; }];
  api.define('version.dll', V);


  // ---------------------------------------------------------------- winsock (no network in v1)
  const WS = {};
  const WSAENETDOWN = 10050, WSAEWOULDBLOCK = 10035, WSANOTINITIALISED = 10093, SOCKET_ERROR = 0xffffffff;
  const wsaErr = (c, e) => { c.proc.wsaLastError = e; return SOCKET_ERROR; };
  WS.WSAStartup = [2, (c) => { const p = c.arg(1); mem.write16(p, 0x0202); mem.write16(p + 2, 0x0202); mem.writeCString(p + 4, 'Orthros WinSock 2.2', 257); mem.writeCString(p + 261, 'Running', 129); mem.write16(p + 390, 0); mem.write16(p + 392, 0); mem.write32(p + 394, 0); return 0; }];
  WS.WSACleanup = [0, () => 0];
  WS.WSAGetLastError = [0, (c) => c.proc.wsaLastError ?? 0];
  WS.WSASetLastError = [1, (c) => { c.proc.wsaLastError = c.arg(0); }];
  WS.socket = [3, (c) => { c.proc.wsaLastError = WSAENETDOWN; return SOCKET_ERROR; }];
  WS.WSASocketA = [6, (c) => { c.proc.wsaLastError = WSAENETDOWN; return SOCKET_ERROR; }];
  WS.closesocket = [1, () => 0];
  for (const n of ['bind', 'connect', 'listen', 'send', 'recv', 'sendto', 'recvfrom', 'select', 'ioctlsocket', 'setsockopt', 'getsockopt', 'getsockname', 'getpeername', 'shutdown', 'accept', 'WSAAsyncSelect', 'WSAEventSelect', 'WSAIoctl', 'WSASend', 'WSARecv', 'WSASendTo', 'WSARecvFrom']) {
    WS[n] = [api.signatures.get(n) ?? 3, (c) => wsaErr(c, WSAENETDOWN)];
  }
  WS.gethostname = [2, (c) => { mem.writeCString(c.arg(0), 'orthros', c.arg(1)); return 0; }];
  WS.gethostbyname = [1, (c) => { c.proc.wsaLastError = 11001; return 0; }];
  WS.gethostbyaddr = [3, (c) => { c.proc.wsaLastError = 11001; return 0; }];
  WS.getaddrinfo = [4, () => 11001]; WS.freeaddrinfo = [1, () => {}];
  WS.inet_addr = [1, (c) => { const p = (c.str(0) ?? '').split('.').map(Number); if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return 0xffffffff; return (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0; }];
  WS.inet_ntoa = [1, (c) => { const v = c.arg(0); const s = `${v & 255}.${(v >> 8) & 255}.${(v >> 16) & 255}.${(v >>> 24) & 255}`; return allocString(c, s); }];
  WS.htons = [1, (c) => ((c.arg(0) & 0xff) << 8) | ((c.arg(0) >> 8) & 0xff)]; WS.ntohs = WS.htons;
  WS.htonl = [1, (c) => { const v = c.arg(0); return ((v >>> 24) | ((v >>> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24)) >>> 0; }]; WS.ntohl = WS.htonl;
  WS.__WSAFDIsSet = [2, () => 0];
  WS.WSACreateEvent = [0, (c) => c.proc.handles.create({ type: 'event', manual: true, signaled: false })];
  WS.WSACloseEvent = [1, (c) => { c.proc.handles.close(c.arg(0)); return 1; }];
  WS.WSAResetEvent = [1, () => 1]; WS.WSASetEvent = [1, () => 1];
  WS.WSAWaitForMultipleEvents = [5, () => 0x102]; WS.WSAEnumNetworkEvents = [3, () => wsaErr];
  WS.WSAEnumProtocolsA = [3, (c) => { mem.write32(c.arg(2), 0); return 0; }];
  api.define('ws2_32.dll', WS);
  api.ordinals('ws2_32.dll', { 1: 'accept', 2: 'bind', 3: 'closesocket', 4: 'connect', 5: 'getpeername', 6: 'getsockname', 7: 'getsockopt', 8: 'htonl', 9: 'htons', 10: 'ioctlsocket', 11: 'inet_addr', 12: 'inet_ntoa', 13: 'listen', 14: 'ntohl', 15: 'ntohs', 16: 'recv', 17: 'recvfrom', 18: 'select', 19: 'send', 20: 'sendto', 21: 'setsockopt', 22: 'shutdown', 23: 'socket', 51: 'gethostbyaddr', 52: 'gethostbyname', 57: 'gethostname', 111: 'WSAGetLastError', 112: 'WSASetLastError', 115: 'WSAStartup', 116: 'WSACleanup', 151: '__WSAFDIsSet' });
  api.define('wsock32.dll', WS);
  api.ordinals('wsock32.dll', { 1: 'accept', 2: 'bind', 3: 'closesocket', 4: 'connect', 5: 'getpeername', 6: 'getsockname', 7: 'getsockopt', 8: 'htonl', 9: 'htons', 10: 'ioctlsocket', 11: 'inet_addr', 12: 'inet_ntoa', 13: 'listen', 14: 'ntohl', 15: 'ntohs', 16: 'recv', 17: 'recvfrom', 18: 'select', 19: 'send', 20: 'sendto', 21: 'setsockopt', 22: 'shutdown', 23: 'socket', 51: 'gethostbyaddr', 52: 'gethostbyname', 57: 'gethostname', 111: 'WSAGetLastError', 112: 'WSASetLastError', 115: 'WSAStartup', 116: 'WSACleanup', 151: '__WSAFDIsSet' });

  // ---------------------------------------------------------------- never-needed: fail gracefully
  const fail = (n, argc, ret = 0xffffffff) => [argc, () => ret];
  api.define('tapi32.dll', { lineInitialize: fail(0, 5, 0x80000048), lineInitializeExA: fail(0, 6, 0x80000048), lineNegotiateAPIVersion: fail(0, 6, 0x80000048), lineOpen: fail(0, 9, 0x80000048), lineClose: fail(0, 1, 0), lineShutdown: fail(0, 1, 0), lineGetDevCaps: fail(0, 5, 0x80000048), lineGetID: fail(0, 6, 0x80000048), lineMakeCall: fail(0, 5, 0x80000048), lineAnswer: fail(0, 3, 0x80000048), lineDrop: fail(0, 3, 0x80000048), lineDeallocateCall: fail(0, 1, 0), lineGetNumRings: fail(0, 3, 0x80000048) });
  api.define('netapi32.dll', { Netbios: [1, () => 0x23], NetApiBufferFree: [1, () => 0], NetWkstaGetInfo: [3, () => 53], NetGetJoinInformation: [3, () => 53] });
  api.define('avifil32.dll', { AVIFileInit: [0, () => {}], AVIFileExit: [0, () => {}], AVIFileOpenA: [4, () => E_FAIL], AVIFileRelease: [1, () => 0], AVIStreamRelease: [1, () => 0], AVIFileGetStream: [4, () => E_FAIL], AVIStreamGetFrameOpen: [2, () => 0], AVIStreamGetFrameClose: [1, () => 0], AVIStreamInfoA: [3, () => E_FAIL], AVIStreamStart: [1, () => 0], AVIStreamLength: [1, () => 0], AVIStreamReadFormat: [4, () => E_FAIL], AVIStreamRead: [7, () => E_FAIL], AVIStreamOpenFromFileA: [6, () => E_FAIL] });
  api.define('psapi.dll', { GetProcessMemoryInfo: [3, (c) => { const p = c.arg(1); mem.write32(p + 12, 0x2000000); return 1; }], EnumProcessModules: [4, (c) => { c.out32(3, 4); if (c.arg(2) >= 4) mem.write32(c.arg(1), c.proc.exe.base); return 1; }], GetModuleFileNameExA: [4, (c) => { const m = c.proc.moduleByHandle(c.arg(1)); const s = c.proc.moduleFileName(m); mem.writeCString(c.arg(2), s, c.arg(3)); return Math.min(s.length, c.arg(3) - 1); }], GetModuleBaseNameA: [4, (c) => { const m = c.proc.moduleByHandle(c.arg(1)); const s = m?.name ?? ''; mem.writeCString(c.arg(2), s, c.arg(3)); return s.length; }], GetModuleInformation: [4, (c) => { const m = c.proc.moduleByHandle(c.arg(1)); if (!m) return 0; mem.write32(c.arg(2), m.base); mem.write32(c.arg(2) + 4, m.size); mem.write32(c.arg(2) + 8, m.entry); return 1; }], EnumProcesses: [3, (c) => { mem.write32(c.arg(0), c.proc.pid); c.out32(2, 4); return 1; }] });
  api.define('wintrust.dll', { WinVerifyTrust: [3, () => 0x800b0100] });
  api.define('secur32.dll', { GetUserNameExA: [3, (c) => { mem.writeCString(c.arg(1), 'Player', mem.read32(c.arg(2))); mem.write32(c.arg(2), 7); return 1; }] });
  api.define('rasapi32.dll', { RasEnumConnectionsA: [3, (c) => { mem.write32(c.arg(2), 0); return 0; }], RasGetConnectStatusA: [2, () => 0] });
  api.define('iphlpapi.dll', { GetAdaptersInfo: [2, (c) => { mem.write32(c.arg(1), 0); return 232; }], GetNetworkParams: [2, () => 232], GetBestInterface: [2, () => 1], GetIfTable: [3, () => 1], GetIpAddrTable: [3, () => 1] });
  api.define('dbghelp.dll', { SymInitialize: [3, () => 1], SymCleanup: [1, () => 1], SymSetOptions: [1, (c) => c.arg(0)], SymGetOptions: [0, () => 0], StackWalk: [9, () => 0], SymFunctionTableAccess: [2, () => 0], SymGetModuleBase: [2, () => 0], SymGetSymFromAddr: [4, () => 0], SymLoadModule: [6, () => 0], SymGetLineFromAddr: [4, () => 0], MiniDumpWriteDump: [7, () => 0], SymFromAddr: [4, () => 0], SymGetModuleInfo: [3, () => 0], SymUnDName: [3, () => 0], UnDecorateSymbolName: [4, () => 0], ImagehlpApiVersion: [0, () => 0], MakeSureDirectoryPathExists: [1, () => 1] });
  api.define('opengl32.dll', { wglCreateContext: [1, () => 0], wglDeleteContext: [1, () => 0], wglMakeCurrent: [2, () => 0], wglGetProcAddress: [1, () => 0], glGetString: [1, () => 0] });
  api.define('setupapi.dll', { SetupDiGetClassDevsA: [4, () => 0xffffffff], SetupDiEnumDeviceInterfaces: [5, () => 0], SetupDiGetDeviceInterfaceDetailA: [6, () => 0], SetupDiDestroyDeviceInfoList: [1, () => 1] });
  api.define('hid.dll', { HidD_GetHidGuid: [1, () => {}], HidD_GetAttributes: [2, () => 0], HidD_GetPreparsedData: [2, () => 0], HidP_GetCaps: [2, () => 0], HidD_FreePreparsedData: [1, () => 1] });
}

/** GUID at address as lowercase "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" */
export function guidOf(mem, a) {
  if (!a) return '00000000-0000-0000-0000-000000000000';
  const h = (v, n) => v.toString(16).padStart(n, '0');
  const b = [];
  for (let i = 8; i < 16; i++) b.push(h(mem.read8(a + i), 2));
  return `${h(mem.read32(a), 8)}-${h(mem.read16(a + 4), 4)}-${h(mem.read16(a + 6), 4)}-${b[0]}${b[1]}-${b.slice(2).join('')}`;
}
export function parseGuid(mem, s, a) {
  const m = s.replace(/[{}]/g, '').toLowerCase().match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/);
  if (!m) return false;
  mem.write32(a, parseInt(m[1], 16)); mem.write16(a + 4, parseInt(m[2], 16)); mem.write16(a + 6, parseInt(m[3], 16));
  const tail = m[4] + m[5];
  for (let i = 0; i < 8; i++) mem.write8(a + 8 + i, parseInt(tail.slice(2 * i, 2 * i + 2), 16));
  return true;
}
export function writeGuid(mem, a, s) { return parseGuid(mem, s, a); }
function bstrAlloc(c, s) {
  const p = c.proc.processHeap.alloc(2 * (s.length + 1) + 4);
  c.mem.write32(p, 2 * s.length);
  c.mem.writeWString(p + 4, s);
  return p + 4;
}
