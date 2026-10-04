// Test program: DirectShow movie playback through the filter graph manager (quartz.dll), as games play their movies:
// CoCreateInstance(CLSID_FilterGraph), IGraphBuilder::RenderFile, IVideoWindow over an owner window, IMediaControl::Run,
// the end reported through IMediaEventEx (event handle + GetEvent) and IMediaEvent::WaitForCompletion, IMediaSeeking.
// Files (C:\Test): movie.mpg (an MPEG-1 system stream), notmedia.bin (anything else).
#include "win.h"

typedef long HRESULT;
typedef struct { DWORD a; WORD b, c; BYTE d[8]; } GUID;
typedef long long LONGLONG;
#define VT(o) (*(void***)(o))
typedef HRESULT (WINAPI *F0)(void*);
typedef HRESULT (WINAPI *F1)(void*, DWORD);
typedef HRESULT (WINAPI *F2)(void*, DWORD, DWORD);
typedef HRESULT (WINAPI *F3)(void*, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F4)(void*, DWORD, DWORD, DWORD, DWORD);
#define C0(o, i) ((F0)VT(o)[i])(o)
#define C1(o, i, a) ((F1)VT(o)[i])(o, (DWORD)(a))
#define C2(o, i, a, b) ((F2)VT(o)[i])(o, (DWORD)(a), (DWORD)(b))
#define C3(o, i, a, b, c) ((F3)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c))
#define C4(o, i, a, b, c, d) ((F4)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d))
#define RELEASE(o) C0(o, 2)

DLLIMPORT HRESULT WINAPI CoInitialize(void*);
DLLIMPORT void WINAPI CoUninitialize(void);
DLLIMPORT HRESULT WINAPI CoCreateInstance(const GUID*, void*, DWORD, const GUID*, void**);

int _fltused = 1;
static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static HANDLE out;
static void put(const char* s) { DWORD w; WriteFile(out, s, slen(s), &w, 0); }
static void puthex(unsigned v) { char b[11] = "0x"; for (int i = 0; i < 8; i++) b[2 + i] = "0123456789abcdef"[(v >> (28 - 4 * i)) & 15]; b[10] = 0; put(b); }
static void putnum(unsigned v) { char buf[12]; int i = 11; buf[i] = 0; if (v == 0) buf[--i] = '0'; while (v) { buf[--i] = '0' + v % 10; v /= 10; } put(buf + i); }
static void hex(const char* k, unsigned v) { put(k); put("="); puthex(v); put("\n"); }
static void num(const char* k, unsigned v) { put(k); put("="); putnum(v); put("\n"); }
static void pump(void) { MSG m; while (PeekMessageA(&m, 0, 0, 0, 1)) { TranslateMessage(&m); DispatchMessageA(&m); } }
static int notified;
#define WM_GRAPHNOTIFY 0x8001
static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { if (m == WM_GRAPHNOTIFY && l == 0x1234) notified++; return DefWindowProcA(h, m, w, l); }

#define G(a, b, c, d0, d1) { a, b, c, { d0 >> 8, d0 & 255, (d1 >> 40) & 255, (d1 >> 32) & 255, (d1 >> 24) & 255, (d1 >> 16) & 255, (d1 >> 8) & 255, d1 & 255 } }
static const GUID CLSID_FilterGraph = G(0xe436ebb3, 0x524f, 0x11ce, 0x9f53, 0x0020af0ba770LL);
static const GUID IID_IGraphBuilder = G(0x56a868a9, 0x0ad4, 0x11ce, 0xb03a, 0x0020af0ba770LL);
static const GUID IID_IMediaControl = G(0x56a868b1, 0x0ad4, 0x11ce, 0xb03a, 0x0020af0ba770LL);
static const GUID IID_IMediaEventEx = G(0x56a868c0, 0x0ad4, 0x11ce, 0xb03a, 0x0020af0ba770LL);
static const GUID IID_IVideoWindow = G(0x56a868b4, 0x0ad4, 0x11ce, 0xb03a, 0x0020af0ba770LL);
static const GUID IID_IBasicVideo = G(0x56a868b5, 0x0ad4, 0x11ce, 0xb03a, 0x0020af0ba770LL);
static const GUID IID_IBasicAudio = G(0x56a868b3, 0x0ad4, 0x11ce, 0xb03a, 0x0020af0ba770LL);
static const GUID IID_IMediaSeeking = G(0x36b73880, 0xc2c8, 0x11cf, 0x8b46, 0x00805f6cef60LL);

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  WNDCLASSA wc = { 0, wndproc, 0, 0, GetModuleHandleA(0), 0, 0, 0, 0, "movie" };
  RegisterClassA(&wc);
  HWND hwnd = CreateWindowExA(0, "movie", "movie", 0x10cf0000, 40, 30, 400, 300, 0, 0, GetModuleHandleA(0), 0);
  ShowWindow(hwnd, 5); pump();
  CoInitialize(0);
  void *gb = 0, *gb2 = 0, *mc = 0, *me = 0, *vw = 0, *bv = 0, *ba = 0, *ms = 0;
  hex("create", CoCreateInstance(&CLSID_FilterGraph, 0, 1, &IID_IGraphBuilder, &gb));
  hex("render missing", C2(gb, 13, L"missing.mpg", 0));
  CoCreateInstance(&CLSID_FilterGraph, 0, 1, &IID_IGraphBuilder, &gb2);
  hex("render other", C2(gb2, 13, L"C:\\Test\\notmedia.bin", 0));
  { // run anyway: an empty graph completes at once (the game goes on as after a movie)
    void *mc2 = 0, *me2 = 0; LONG c2 = 0, q1, q2;
    C2(gb2, 0, &IID_IMediaControl, &mc2); C2(gb2, 0, &IID_IMediaEventEx, &me2);
    C0(mc2, 7); hex("empty run event", C4(me2, 8, &c2, &q1, &q2, 0)); num("empty run code", c2);
    C0(mc2, 9); RELEASE(me2); RELEASE(mc2);
  }
  RELEASE(gb2);
  hex("render", C2(gb, 13, L"movie.mpg", 0));
  hex("render again", C2(gb, 13, L"movie.mpg", 0));
  C2(gb, 0, &IID_IMediaControl, &mc); C2(gb, 0, &IID_IMediaEventEx, &me); C2(gb, 0, &IID_IVideoWindow, &vw);
  C2(gb, 0, &IID_IBasicVideo, &bv); C2(gb, 0, &IID_IBasicAudio, &ba); C2(mc, 0, &IID_IMediaSeeking, &ms);
  num("interfaces", !!mc + !!me + !!vw + !!bv + !!ba + !!ms);
  LONG w = 0, h = 0; C2(bv, 34, &w, &h); num("width", w); num("height", h);
  LONGLONG dur = 0; C1(ms, 10, &dur); num("duration ms", (unsigned)dur / 10000);
  hex("volume", C1(ba, 7, -600));
  // the video window: a child of ours, at (8, 6) in its client area
  C1(vw, 29, hwnd); C1(vw, 9, 0x40000000 | 0x04000000); C1(vw, 31, hwnd);
  hex("position", C4(vw, 39, 8, 6, 128, 96));
  HANDLE ev = 0; C1(me, 7, &ev); C3(me, 13, hwnd, WM_GRAPHNOTIFY, 0x1234);
  DWORD t0 = GetTickCount();
  hex("run", C0(mc, 7));
  LONG state = 0; C2(mc, 10, 0, &state); num("state", state);
  int waits = 0;
  while (WaitForSingleObject(ev, 50) != 0) { pump(); if (++waits > 400) break; }
  num("elapsed ms", GetTickCount() - t0);
  pump();
  LONG code = 0, p1 = 0, p2 = 0;
  hex("event", C4(me, 8, &code, &p1, &p2, 0)); num("event code", code);
  hex("next event", C4(me, 8, &code, &p1, &p2, 0));
  num("signaled after", WaitForSingleObject(ev, 0));
  num("notified", notified);
  LONGLONG pos = 0; C1(ms, 12, &pos); num("position ms", (unsigned)pos / 10000);
  // back to the start, played again: WaitForCompletion
  hex("stop", C0(mc, 9));
  LONGLONG zero = 0; hex("rewind", C4(ms, 14, &zero, 1, 0, 0));
  C1(ms, 12, &pos); num("rewound ms", (unsigned)pos / 10000);
  t0 = GetTickCount();
  C0(mc, 7);
  hex("wait", C2(me, 9, 0xffffffff, &code)); num("wait code", code);
  num("elapsed 2 ms", GetTickCount() - t0);
  C4(me, 8, &code, &p1, &p2, 0);
  // a short wait times out while playing
  C0(mc, 9); C4(ms, 14, &zero, 1, 0, 0); C0(mc, 7);
  hex("short wait", C2(me, 9, 10, &code));
  C0(mc, 9);
  // the destination rectangle inside the window, the window's position, a paused graph shows its picture, hidden
  LONG l = 0, t = 0, w2 = 0, h2 = 0;
  hex("destination", C4(bv, 31, 4, 2, 64, 48)); C4(bv, 32, &l, &t, &w2, &h2); num("dest l", l); num("dest t", t); num("dest w", w2); num("dest h", h2);
  C4(vw, 40, &l, &t, &w2, &h2); num("win l", l); num("win t", t); num("win w", w2); num("win h", h2);
  hex("pause", C0(mc, 8)); C2(mc, 10, 0, &state); num("paused state", state);
  hex("hide", C1(vw, 19, 0));
  RELEASE(ms); RELEASE(ba); RELEASE(bv); RELEASE(vw); RELEASE(me); RELEASE(mc);
  num("last release", RELEASE(gb));
  CoUninitialize();
  ExitProcess(0);
}
