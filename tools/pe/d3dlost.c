// Test program: Direct3D 9 Reset and device loss — the state after Reset (render target 0 = back buffer 0, the automatic
// depth-stencil surface, other render targets unset); a fullscreen device lost while the application is inactive (the
// test's host scripts a focus loss at 3 s and its return at 6 s), then waiting for Reset.
#include "win.h"

typedef long HRESULT;
#define VT(o) (*(void***)(o))
typedef HRESULT (WINAPI *F0)(void*);
typedef HRESULT (WINAPI *F1)(void*, DWORD);
typedef HRESULT (WINAPI *F2)(void*, DWORD, DWORD);
typedef HRESULT (WINAPI *F3)(void*, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F4)(void*, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F5)(void*, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F6)(void*, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F7)(void*, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F8)(void*, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *FCLEAR)(void*, DWORD, void*, DWORD, DWORD, float, DWORD);
#define C0(o, i) ((F0)VT(o)[i])(o)
#define C1(o, i, a) ((F1)VT(o)[i])(o, (DWORD)(a))
#define C2(o, i, a, b) ((F2)VT(o)[i])(o, (DWORD)(a), (DWORD)(b))
#define C3(o, i, a, b, c) ((F3)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c))
#define C4(o, i, a, b, c, d) ((F4)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d))
#define C5(o, i, a, b, c, d, e) ((F5)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e))
#define C6(o, i, a, b, c, d, e, f) ((F6)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e), (DWORD)(f))
#define C7(o, i, a, b, c, d, e, f, g) ((F7)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e), (DWORD)(f), (DWORD)(g))
#define C8(o, i, a, b, c, d, e, f, g, h) ((F8)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e), (DWORD)(f), (DWORD)(g), (DWORD)(h))
#define RELEASE(o) C0(o, 2)

DLLIMPORT void* WINAPI Direct3DCreate9(UINT);
int _fltused = 1;

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void put(HANDLE h, const char* s) { DWORD w; WriteFile(h, s, slen(s), &w, 0); }
static void puthex(HANDLE h, unsigned v) { char b[11] = "0x"; for (int i = 0; i < 8; i++) b[2 + i] = "0123456789abcdef"[(v >> (28 - 4 * i)) & 15]; b[10] = 0; put(h, b); }
static void putnum(HANDLE h, unsigned v) { char buf[12]; int i = 11; buf[i] = 0; if (v == 0) buf[--i] = '0'; while (v) { buf[--i] = '0' + v % 10; v /= 10; } put(h, buf + i); }
static void line(HANDLE h, const char* k, unsigned v, int hex) { put(h, k); put(h, "="); if (hex) puthex(h, v); else putnum(h, v); put(h, "\n"); }
static void pump(void) { MSG m; while (PeekMessageA(&m, 0, 0, 0, 1)) { TranslateMessage(&m); DispatchMessageA(&m); } }
static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }

typedef struct { UINT w, h, fmt, count, msaa, msq, swap; HWND hwnd; BOOL windowed, autoDepth; UINT depthFmt; DWORD flags; UINT refresh, interval; } D3DPRESENT_PARAMETERS;
typedef struct { int pitch; void* bits; } D3DLOCKED_RECT;
typedef struct { WORD stream, offset; BYTE type, method, usage, index; } D3DVERTEXELEMENT9;
typedef struct { float x, y, z, rhw; DWORD color; float u, v; } VERTEX;

void __stdcall start(void) {
  HANDLE out = GetStdHandle((DWORD)-11);
  WNDCLASSA wc = { 0, wndproc, 0, 0, GetModuleHandleA(0), 0, 0, 0, 0, "d3dlost" };
  RegisterClassA(&wc);
  HWND hwnd = CreateWindowExA(0, "d3dlost", "d3dlost", 0x10cf0000, 0, 0, 320, 240, 0, 0, GetModuleHandleA(0), 0);
  ShowWindow(hwnd, 5); pump();
  void* d3d = Direct3DCreate9(32);
  D3DPRESENT_PARAMETERS pp = { 320, 240, 22, 1, 0, 0, 1, hwnd, 1, 1, 75, 0, 0, 0x80000000 };
  void* dev = 0; line(out, "device", C6(d3d, 16, 0, 1, hwnd, 0x40, &pp, &dev), 1);
  line(out, "reset", C1(dev, 16, &pp), 1);
  void* rt0 = 0; line(out, "getrt0", C2(dev, 38, 0, &rt0), 1);
  void* bb = 0; C4(dev, 18, 0, 0, 0, &bb);
  line(out, "rt0isbb", rt0 != 0 && rt0 == bb, 0);
  void* rt1 = (void*)1; line(out, "getrt1", C2(dev, 38, 1, &rt1), 1); line(out, "rt1", (DWORD)rt1, 0);
  void* ds = 0; line(out, "getds", C1(dev, 40, &ds), 1);
  if (rt0) RELEASE(rt0);
  if (bb) RELEASE(bb);
  if (ds) RELEASE(ds);
  D3DPRESENT_PARAMETERS fs = pp; fs.windowed = 0; fs.refresh = 60; fs.interval = 0;
  line(out, "resetfs", C1(dev, 16, &fs), 1);
  line(out, "fs_tcl", C0(dev, 3), 1);
  Sleep(4000); pump();
  line(out, "lost_tcl", C0(dev, 3), 1); line(out, "lost_present", C4(dev, 17, 0, 0, 0, 0), 1); line(out, "lost_reset", C1(dev, 16, &fs), 1);
  Sleep(3000); pump();
  line(out, "back_tcl", C0(dev, 3), 1); line(out, "back_reset", C1(dev, 16, &fs), 1);
  line(out, "ok_tcl", C0(dev, 3), 1); line(out, "ok_present", C4(dev, 17, 0, 0, 0, 0), 1);
  // a windowed device is not lost
  line(out, "resetwin", C1(dev, 16, &pp), 1);
  Sleep(3000); pump(); // (the host scripts another focus loss at 12 s)
  Sleep(3000); pump();
  line(out, "win_tcl", C0(dev, 3), 1); line(out, "win_present", C4(dev, 17, 0, 0, 0, 0), 1);
  line(out, "devrelease", RELEASE(dev), 0);
  line(out, "d3drelease", RELEASE(d3d), 0);
  ExitProcess(0);
}
