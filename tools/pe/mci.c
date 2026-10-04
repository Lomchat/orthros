// Test program: MCI digital video (winmm.dll): mciSendString (open with type and alias, window, put, play notify,
// status, seek, play wait, time formats, close, errors) and mciSendCommand (open / play wait / status / close).
// Files (C:\Test): movie.mpg (an MPEG-1 system stream), clip.avi (an AVI).
#include "win.h"

typedef unsigned long MCIERROR;
DLLIMPORT MCIERROR WINAPI mciSendStringA(const char*, char*, UINT, HWND);
DLLIMPORT MCIERROR WINAPI mciSendCommandA(UINT, UINT, DWORD, DWORD);
DLLIMPORT UINT WINAPI mciGetDeviceIDA(const char*);

int _fltused = 1;
static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static HANDLE out;
static void put(const char* s) { DWORD w; WriteFile(out, s, slen(s), &w, 0); }
static void putnum(unsigned v) { char buf[12]; int i = 11; buf[i] = 0; if (v == 0) buf[--i] = '0'; while (v) { buf[--i] = '0' + v % 10; v /= 10; } put(buf + i); }
static void num(const char* k, unsigned v) { put(k); put("="); putnum(v); put("\n"); }
static void str(const char* k, const char* v) { put(k); put("="); put(v); put("\n"); }
static int notified, notifyFlag, notifyId;
#define MM_MCINOTIFY 0x3b9
static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { if (m == MM_MCINOTIFY) { notified++; notifyFlag = w; notifyId = l; } return DefWindowProcA(h, m, w, l); }
static void pump(void) { MSG m; while (PeekMessageA(&m, 0, 0, 0, 1)) { TranslateMessage(&m); DispatchMessageA(&m); } }
static char ret[128];
static MCIERROR mci(const char* cmd, HWND cb) { ret[0] = 0; return mciSendStringA(cmd, ret, sizeof ret, cb); }
static char* cat(char* d, const char* s) { while (*s) *d++ = *s++; *d = 0; return d; }
static char* catnum(char* d, unsigned v) { char b[12]; int i = 11; b[i] = 0; if (!v) b[--i] = '0'; while (v) { b[--i] = '0' + v % 10; v /= 10; } return cat(d, b + i); }

typedef struct { DWORD callback; UINT id; const char* type; const char* element; const char* alias; DWORD style; HWND parent; } OPEN_PARMS;
typedef struct { DWORD callback, from, to; } PLAY_PARMS;
typedef struct { DWORD callback, ret, item, track; } STATUS_PARMS;

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  WNDCLASSA wc = { 0, wndproc, 0, 0, GetModuleHandleA(0), 0, 0, 0, 0, "mcitest" };
  RegisterClassA(&wc);
  HWND hwnd = CreateWindowExA(0, "mcitest", "mci", 0x10cf0000, 40, 30, 400, 300, 0, 0, GetModuleHandleA(0), 0);
  ShowWindow(hwnd, 5); pump();
  // errors first: a missing file, a device type not played here (as before), a name never opened
  num("missing", mci("open nothing.mpg type mpegvideo alias x", 0));
  num("cdaudio", mci("open cdaudio", 0));
  num("unknown name", mci("play bogus", 0));
  // a movie through mciSendString
  num("open", mci("open movie.mpg type mpegvideo alias m", 0)); str("open id", ret);
  num("device id", mciGetDeviceIDA("m"));
  mci("status m length", 0); str("length", ret);
  mci("status m mode", 0); str("mode", ret);
  char cmd[96], *p = cat(cmd, "window m handle "); catnum(p, (unsigned)hwnd);
  num("window", mci(cmd, 0));
  num("put", mci("put m destination at 8 6 128 96", 0));
  mci("where m destination", 0); str("where", ret);
  DWORD t0 = GetTickCount();
  num("play", mci("play m notify", hwnd));
  mci("status m mode", 0); str("mode playing", ret);
  int loops = 0;
  while (!notified && loops++ < 1000) { Sleep(10); pump(); }
  num("elapsed ms", GetTickCount() - t0);
  num("notified", notified); num("notify flag", notifyFlag); num("notify id", notifyId);
  mci("status m mode", 0); str("mode after", ret);
  mci("status m position", 0); str("position", ret);
  num("seek", mci("seek m to start", 0));
  t0 = GetTickCount();
  num("play wait", mci("play m wait", 0));
  num("elapsed wait ms", GetTickCount() - t0);
  num("frames", mci("set m time format frames", 0));
  mci("status m length", 0); str("length frames", ret);
  mci("play m from 10 to 20 notify", hwnd); notified = 0;
  t0 = GetTickCount(); loops = 0;
  while (!notified && loops++ < 1000) { Sleep(10); pump(); }
  num("part ms", GetTickCount() - t0);
  num("close", mci("close m", 0));
  num("closed name", mci("status m mode", 0));
  // an AVI through mciSendCommand
  OPEN_PARMS op = { 0, 0, 0, "clip.avi", 0, 0, 0 };
  num("cmd open", mciSendCommandA(0, 0x803, 0x200, (DWORD)&op));
  PLAY_PARMS pp = { 0, 0, 0 };
  t0 = GetTickCount();
  num("cmd play wait", mciSendCommandA(op.id, 0x806, 2, (DWORD)&pp));
  num("cmd elapsed ms", GetTickCount() - t0);
  STATUS_PARMS sp = { 0, 0, 4, 0 };
  mciSendCommandA(op.id, 0x814, 0x100, (DWORD)&sp); num("cmd mode", sp.ret);
  sp.item = 1; mciSendCommandA(op.id, 0x814, 0x100, (DWORD)&sp); num("cmd length", sp.ret);
  num("cmd close", mciSendCommandA(op.id, 0x804, 0, 0));
  ExitProcess(0);
}
