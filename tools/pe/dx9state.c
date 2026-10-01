// Test program: a pseudo-random sequence of Direct3D 9 state calls through the COM vtables — render, texture stage
// and sampler states with many redundant sets (and keys out of range), texture bindings, AddRef/Release, state blocks
// recorded / created / applied, getters and other calls at random points, a Reset in the middle — then every state
// read back. The output (getter values, AddRef/Release results) must not depend on how the calls are executed: run
// under the JIT (deferred setters, issued-state filter, AddRef/Release fast path) and the interpreter, it is compared.
#include "win.h"

typedef long HRESULT;
#define VT(o) (*(void***)(o))
typedef HRESULT (WINAPI *F0)(void*);
typedef HRESULT (WINAPI *F1)(void*, DWORD);
typedef HRESULT (WINAPI *F2)(void*, DWORD, DWORD);
typedef HRESULT (WINAPI *F3)(void*, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F6)(void*, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F8)(void*, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD);
#define C0(o, i) ((F0)VT(o)[i])(o)
#define C1(o, i, a) ((F1)VT(o)[i])(o, (DWORD)(a))
#define C2(o, i, a, b) ((F2)VT(o)[i])(o, (DWORD)(a), (DWORD)(b))
#define C3(o, i, a, b, c) ((F3)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c))
#define C6(o, i, a, b, c, d, e, f) ((F6)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e), (DWORD)(f))
#define C8(o, i, a, b, c, d, e, f, g, h) ((F8)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e), (DWORD)(f), (DWORD)(g), (DWORD)(h))
enum { ADDREF = 1, RELEASE = 2, TESTCOOP = 3, RESET = 16, CREATETEXTURE = 23, SETRS = 57, GETRS = 58, CREATESB = 59, BEGINSB = 60, ENDSB = 61,
  GETTEX = 64, SETTEX = 65, GETTSS = 66, SETTSS = 67, GETSAMP = 68, SETSAMP = 69, SB_APPLY = 5, SB_CAPTURE = 4 };

DLLIMPORT void* WINAPI Direct3DCreate9(UINT);
int _fltused = 1;

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static HANDLE out;
static void put(const char* s) { DWORD w; WriteFile(out, s, slen(s), &w, 0); }
static void puthex(unsigned v) { char b[11] = "0x"; for (int i = 0; i < 8; i++) b[2 + i] = "0123456789abcdef"[(v >> (28 - 4 * i)) & 15]; b[10] = 0; put(b); }
static void line(const char* k, unsigned v) { put(k); put("="); puthex(v); put("\n"); }
static void pump(void) { MSG m; while (PeekMessageA(&m, 0, 0, 0, 1)) { TranslateMessage(&m); DispatchMessageA(&m); } }
static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }

typedef struct { UINT w, h, fmt, count, msaa, msq, swap; HWND hwnd; BOOL windowed, autoDepth; UINT depthFmt; DWORD flags; UINT refresh, interval; } D3DPRESENT_PARAMETERS;

static unsigned seed = 12345, hash = 2166136261u, nvals = 0;
static unsigned rnd(unsigned k) { seed = seed * 1664525u + 1013904223u; return (seed >> 8) % k; }
static void note(unsigned v) { for (int i = 0; i < 4; i++) { hash ^= (v >> (8 * i)) & 0xff; hash *= 16777619u; } nvals++; }

static const DWORD RS[] = { 7, 8, 14, 22, 27, 137, 168, 255, 300 };
static const DWORD VALS[] = { 0, 1, 2, 3, 0xffffffff, 0x3f800000 };
static const DWORD STAGES[] = { 0, 1, 7, 8 };
static const DWORD TSS[] = { 1, 2, 13, 32, 39, 40 };
static const DWORD SAMPS[] = { 0, 3, 15, 257, 260 };
static const DWORD SAMPT[] = { 1, 5, 13, 15, 16 };
#define N(a) (sizeof(a) / sizeof(a[0]))

static void* dev;
static void* tex[3];
static int owned[3] = { 1, 1, 1 };
static void* blocks[8];
static int nblocks;

static void randomSet(void) {
  unsigned r = rnd(3);
  if (r == 0) C2(dev, SETRS, RS[rnd(N(RS))], VALS[rnd(N(VALS))]);
  else if (r == 1) C3(dev, SETTSS, STAGES[rnd(N(STAGES))], TSS[rnd(N(TSS))], VALS[rnd(N(VALS))]);
  else C3(dev, SETSAMP, SAMPS[rnd(N(SAMPS))], SAMPT[rnd(N(SAMPT))], VALS[rnd(N(VALS))]);
}

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  WNDCLASSA wc = { 0, wndproc, 0, 0, GetModuleHandleA(0), 0, 0, 0, 0, "dx9state" };
  RegisterClassA(&wc);
  HWND hwnd = CreateWindowExA(0, "dx9state", "dx9state", 0x10cf0000, 0, 0, 320, 240, 0, 0, GetModuleHandleA(0), 0);
  ShowWindow(hwnd, 5); pump();
  void* d3d = Direct3DCreate9(32);
  D3DPRESENT_PARAMETERS pp = { 320, 240, 22, 1, 0, 0, 1, hwnd, 1, 1, 75, 0, 0, 0x80000000 };
  line("device", C6(d3d, 16, 0, 1, hwnd, 0x40, &pp, &dev));
  for (int i = 0; i < 3; i++) line("tex", C8(dev, CREATETEXTURE, 8, 8, 1, 0, 21, 1, &tex[i], 0));

  for (int i = 0; i < 6000; i++) {
    unsigned r = rnd(100);
    if (r < 55) randomSet();
    else if (r < 63) { const DWORD st[] = { 0, 1, 257 }; void* t = rnd(4) ? tex[rnd(3)] : 0; C2(dev, SETTEX, st[rnd(3)], t); }
    else if (r < 69) { int k = rnd(3); note(C0(tex[k], ADDREF)); owned[k]++; }
    else if (r < 75) { int k = rnd(3); if (owned[k] > 1) { note(C0(tex[k], RELEASE)); owned[k]--; } }
    else if (r < 79) { DWORD v = 0xdeadbeef; C2(dev, GETRS, RS[rnd(N(RS) - 1)], &v); note(v); }
    else if (r < 82) { DWORD v = 0xdeadbeef; C3(dev, GETTSS, STAGES[rnd(3)], TSS[rnd(N(TSS) - 1)], &v); note(v); }
    else if (r < 85) { DWORD v = 0xdeadbeef; C3(dev, GETSAMP, SAMPS[rnd(N(SAMPS))], SAMPT[rnd(N(SAMPT) - 1)], &v); note(v); }
    else if (r < 88 && nblocks < 8) { // a recorded state block
      C0(dev, BEGINSB); int n = 1 + rnd(6); for (int k = 0; k < n; k++) randomSet();
      void* sb = 0; if (C1(dev, ENDSB, &sb) == 0 && sb) blocks[nblocks++] = sb;
    }
    else if (r < 92 && nblocks) C0(blocks[rnd(nblocks)], SB_APPLY);
    else if (r < 93 && nblocks) C0(blocks[rnd(nblocks)], SB_CAPTURE);
    else if (r < 94 && nblocks < 8) { void* sb = 0; if (C2(dev, CREATESB, 1 + rnd(3), &sb) == 0 && sb) blocks[nblocks++] = sb; }
    else if (r < 97) note(C0(dev, TESTCOOP));
    else if (r < 98) Sleep(0);
    if (i == 3000) { // Reset: the default states again (state blocks survive: they are not D3DPOOL_DEFAULT resources)
      for (int s = 0; s < 8; s++) C2(dev, SETTEX, s, 0);
      C2(dev, SETTEX, 257, 0);
      line("reset", C1(dev, RESET, &pp));
    }
  }
  line("trace", hash); line("values", nvals);
  hash = 2166136261u;
  for (DWORD s = 0; s < 256; s++) { DWORD v = 0xdeadbeef; C2(dev, GETRS, s, &v); note(v); }
  line("rs", hash); hash = 2166136261u;
  for (DWORD st = 0; st < 8; st++) for (DWORD t = 0; t < 40; t++) { DWORD v = 0xdeadbeef; C3(dev, GETTSS, st, t, &v); note(v); }
  line("tss", hash); hash = 2166136261u;
  for (DWORD si = 0; si < N(SAMPS); si++) for (DWORD t = 0; t < 16; t++) { DWORD v = 0xdeadbeef; C3(dev, GETSAMP, SAMPS[si], t, &v); note(v); }
  line("samp", hash); hash = 2166136261u;
  { const DWORD st[] = { 0, 1, 257 }; for (int k = 0; k < 3; k++) { void* t = 0; C2(dev, GETTEX, st[k], &t); unsigned w = 9; for (int j = 0; j < 3; j++) if (t == tex[j]) w = j; note(w); if (t) C0(t, RELEASE); } }
  for (int k = 0; k < 3; k++) { note(C0(tex[k], ADDREF)); note(C0(tex[k], RELEASE)); }
  line("refs", hash);
  for (int k = 0; k < 3; k++) C2(dev, SETTEX, k == 2 ? 257 : k, 0);
  for (int k = 0; k < 3; k++) { unsigned last = 0; while (owned[k]--) last = C0(tex[k], RELEASE); line("texlast", last); }
  for (int k = 0; k < nblocks; k++) C0(blocks[k], RELEASE);
  line("devrelease", C0(dev, RELEASE));
  ExitProcess(0);
}
