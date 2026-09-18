// Test program: DirectSound 8, DirectInput 8 and Direct3D 8 through their COM vtables.
#include "win.h"

typedef long HRESULT;
typedef struct { DWORD a; WORD b, c; BYTE d[8]; } GUID;
#define VT(o) (*(void***)(o))
typedef HRESULT (WINAPI *F0)(void*);
typedef HRESULT (WINAPI *F1)(void*, DWORD);
typedef HRESULT (WINAPI *F2)(void*, DWORD, DWORD);
typedef HRESULT (WINAPI *F3)(void*, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F4)(void*, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F5)(void*, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F6)(void*, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F7)(void*, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *FCLEAR)(void*, DWORD, void*, DWORD, DWORD, float, DWORD);
#define C0(o, i) ((F0)VT(o)[i])(o)
#define C1(o, i, a) ((F1)VT(o)[i])(o, (DWORD)(a))
#define C2(o, i, a, b) ((F2)VT(o)[i])(o, (DWORD)(a), (DWORD)(b))
#define C3(o, i, a, b, c) ((F3)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c))
#define C4(o, i, a, b, c, d) ((F4)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d))
#define C5(o, i, a, b, c, d, e) ((F5)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e))
#define C6(o, i, a, b, c, d, e, f) ((F6)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e), (DWORD)(f))
#define C7(o, i, a, b, c, d, e, f, g) ((F7)VT(o)[i])(o, (DWORD)(a), (DWORD)(b), (DWORD)(c), (DWORD)(d), (DWORD)(e), (DWORD)(f), (DWORD)(g))
#define RELEASE(o) C0(o, 2)

DLLIMPORT HRESULT WINAPI DirectSoundCreate8(const GUID*, void**, void*);
DLLIMPORT HRESULT WINAPI DirectInput8Create(HINSTANCE, DWORD, const GUID*, void**, void*);
DLLIMPORT void* WINAPI Direct3DCreate8(UINT);

int _fltused = 1;
static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void put(HANDLE h, const char* s) { DWORD w; WriteFile(h, s, slen(s), &w, 0); }
static void puthex(HANDLE h, unsigned v) { char b[11] = "0x"; for (int i = 0; i < 8; i++) b[2 + i] = "0123456789abcdef"[(v >> (28 - 4 * i)) & 15]; b[10] = 0; put(h, b); }
static void putnum(HANDLE h, unsigned v) { char buf[12]; int i = 11; buf[i] = 0; if (v == 0) buf[--i] = '0'; while (v) { buf[--i] = '0' + v % 10; v /= 10; } put(h, buf + i); }
static void line(HANDLE h, const char* k, unsigned v, int hex) { put(h, k); put(h, "="); if (hex) puthex(h, v); else putnum(h, v); put(h, "\n"); }
static void pump(void) { MSG m; while (PeekMessageA(&m, 0, 0, 0, 1)) { TranslateMessage(&m); DispatchMessageA(&m); } }

static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }

static const GUID IID_IDirectInput8A = { 0xBF798030, 0x483A, 0x4DA2, { 0xAA, 0x99, 0x5D, 0x64, 0xED, 0x36, 0x97, 0x00 } };
static const GUID GUID_SysKeyboard = { 0x6F1D2B61, 0xD5A0, 0x11CF, { 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00 } };
static const GUID GUID_SysMouse = { 0x6F1D2B60, 0xD5A0, 0x11CF, { 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00 } };

typedef struct { WORD tag, channels; DWORD rate, avg; WORD align, bits, cb; } WAVEFORMATEX;
typedef struct { DWORD size, flags, bytes, reserved; WAVEFORMATEX* fmt; GUID alg; } DSBUFFERDESC;
typedef struct { DWORD size, objSize, flags, dataSize, numObjs; void* objs; } DIDATAFORMAT;
typedef struct { DWORD size, headerSize, obj, how; } DIPROPHEADER;
typedef struct { DIPROPHEADER h; DWORD data; } DIPROPDWORD;
typedef struct { DWORD ofs, data, time, seq, app; } DIDEVICEOBJECTDATA;
typedef struct { UINT w, h, fmt, count, msaa, swap; HWND hwnd; BOOL windowed, autoDepth; UINT depthFmt; DWORD flags; UINT refresh, interval; } D3DPRESENT_PARAMETERS;
typedef struct { int pitch; void* bits; } D3DLOCKED_RECT;

void __stdcall start(void) {
  HANDLE out = GetStdHandle((DWORD)-11);
  // ---- window (focus for DirectInput, device window for D3D)
  WNDCLASSA wc = { 0, wndproc, 0, 0, GetModuleHandleA(0), 0, 0, 0, 0, "dxtest" };
  RegisterClassA(&wc);
  HWND hwnd = CreateWindowExA(0, "dxtest", "dx", 0x10cf0000, 0, 0, 320, 240, 0, 0, GetModuleHandleA(0), 0);
  ShowWindow(hwnd, 5); pump();

  // ---- DirectSound
  void* ds = 0;
  line(out, "dscreate", DirectSoundCreate8(0, &ds, 0), 1);
  line(out, "coop", C2(ds, 6, hwnd, 2), 1);
  WAVEFORMATEX fmt = { 1, 2, 44100, 44100 * 4, 4, 16, 0 };
  DSBUFFERDESC pd = { sizeof(DSBUFFERDESC), 1, 0, 0, 0 };
  void* prim = 0; line(out, "primary", C3(ds, 3, &pd, &prim, 0), 1);
  line(out, "setformat", C1(prim, 14, &fmt), 1);
  DSBUFFERDESC sd = { sizeof(DSBUFFERDESC), 0x80 | 0x20 | 0x10000, 44100 * 4, 0, &fmt };
  void* buf = 0; line(out, "secondary", C3(ds, 3, &sd, &buf, 0), 1);
  void* p1 = 0; DWORD b1 = 0; void* p2 = 0; DWORD b2 = 0;
  line(out, "lock", C7(buf, 11, 0, 0, &p1, &b1, &p2, &b2, 2), 1);
  line(out, "lockbytes", b1, 0);
  for (DWORD i = 0; i < b1 / 2; i++) ((short*)p1)[i] = (short)(i & 0x7fff);
  line(out, "unlock", C4(buf, 19, p1, b1, p2, b2), 1);
  line(out, "play", C3(buf, 12, 0, 0, 0), 1);
  Sleep(250);
  DWORD play = 0, write = 0, status = 0;
  C2(buf, 4, &play, &write); C1(buf, 9, &status);
  line(out, "pos250", play, 0); line(out, "status250", status, 1);
  Sleep(1000);
  C2(buf, 4, &play, &write); C1(buf, 9, &status);
  line(out, "posend", play, 0); line(out, "statusend", status, 1);
  line(out, "playloop", C3(buf, 12, 0, 0, 1), 1);
  Sleep(1500);
  C2(buf, 4, &play, &write); C1(buf, 9, &status);
  line(out, "posloop", play, 0); line(out, "statusloop", status, 1);
  line(out, "setfreq", C1(buf, 17, 22050), 1);
  Sleep(100);
  C2(buf, 4, &play, &write);
  line(out, "posfreq", play, 0);
  line(out, "stop", C0(buf, 18), 1);
  line(out, "setvol", C1(buf, 15, -600), 1);
  DWORD vol = 0; C1(buf, 6, &vol); line(out, "vol", vol, 1);
  RELEASE(buf); RELEASE(prim); line(out, "dsrelease", RELEASE(ds), 0);

  // ---- DirectInput
  void* di = 0;
  line(out, "dicreate", DirectInput8Create(GetModuleHandleA(0), 0x800, &IID_IDirectInput8A, &di, 0), 1);
  void* kb = 0; line(out, "kbdev", C3(di, 3, &GUID_SysKeyboard, &kb, 0), 1);
  DIDATAFORMAT kfmt = { 24, 16, 2, 256, 256, 0 };
  line(out, "kbformat", C1(kb, 11, &kfmt), 1);
  line(out, "kbcoop", C2(kb, 13, hwnd, 2 | 4), 1);
  line(out, "kbacquire", C0(kb, 7), 1);
  Sleep(30); pump(); // scripted key event at t=20ms
  BYTE keys[256];
  line(out, "kbstate", C2(kb, 9, 256, keys), 1);
  line(out, "key_a", keys[0x1e], 1);
  void* ms = 0; line(out, "msdev", C3(di, 3, &GUID_SysMouse, &ms, 0), 1);
  DIDATAFORMAT mfmt = { 24, 16, 1, 16, 7, 0 };
  line(out, "msformat", C1(ms, 11, &mfmt), 1);
  DIPROPDWORD bs = { { 20, 16, 0, 0 }, 16 };
  line(out, "msbuffer", C2(ms, 6, 1, &bs), 1);
  line(out, "msacquire", C0(ms, 7), 1);
  Sleep(30); pump(); // scripted move to (100,100) at t=50ms
  struct { LONG x, y, z; BYTE b[4]; } mstate;
  C2(ms, 9, 16, &mstate);
  Sleep(30); pump(); // scripted move to (110,105) + button at t=80ms
  line(out, "msstate", C2(ms, 9, 16, &mstate), 1);
  line(out, "mx", mstate.x, 0); line(out, "my", mstate.y, 0); line(out, "mb0", mstate.b[0], 1);
  DIDEVICEOBJECTDATA dod[16]; DWORD n = 16;
  line(out, "msdata", C4(ms, 10, 20, dod, &n, 0), 1);
  line(out, "msevents", n, 0);
  line(out, "ev0", dod[0].ofs * 0x10000 + (dod[0].data & 0xffff), 1);
  RELEASE(ms); RELEASE(kb); line(out, "direlease", RELEASE(di), 0);

  // ---- Direct3D 8
  void* d3d = Direct3DCreate8(220);
  line(out, "d3d", d3d != 0, 0);
  line(out, "adapters", C0(d3d, 4), 0);
  DWORD mode[4]; line(out, "dispmode", C2(d3d, 8, 0, mode), 1);
  line(out, "modew", mode[0], 0); line(out, "modefmt", mode[3], 0);
  DWORD caps[53]; line(out, "caps", C3(d3d, 13, 0, 1, caps), 1);
  line(out, "maxtex", caps[22], 0); line(out, "vsver", caps[49], 1);
  line(out, "checktype", C5(d3d, 9, 0, 1, 22, 22, 1), 1);
  line(out, "checkfmt", C6(d3d, 10, 0, 1, 22, 0, 3, 0x31545844), 1);
  D3DPRESENT_PARAMETERS pp = { 320, 240, 22, 1, 0, 1, hwnd, 1, 1, 80, 0, 0, 0x80000000 };
  void* dev = 0; line(out, "device", C6(d3d, 15, 0, 1, hwnd, 0x40, &pp, &dev), 1);
  void* tex = 0; line(out, "tex", C7(dev, 20, 64, 64, 0, 0, 21, 1, &tex), 1);
  line(out, "levels", C0(tex, 13), 0);
  D3DLOCKED_RECT lr; line(out, "lockrect", C4(tex, 16, 0, &lr, 0, 0), 1);
  line(out, "pitch", lr.pitch, 0);
  ((DWORD*)lr.bits)[5] = 0xffff0000;
  line(out, "unlockrect", C1(tex, 17, 0), 1);
  void* surf = 0; line(out, "surflevel", C2(tex, 15, 0, &surf), 1);
  DWORD desc[8]; C1(surf, 8, desc); line(out, "surfw", desc[6], 0); line(out, "surfsize", desc[4], 0);
  D3DLOCKED_RECT lr2; C3(surf, 9, &lr2, 0, 0x10);
  line(out, "surfpix", ((DWORD*)lr2.bits)[5], 1); C0(surf, 10);
  line(out, "surfrelease", RELEASE(surf), 0);
  void* vb = 0; line(out, "vb", C5(dev, 23, 3 * 20, 0, 0x142, 1, &vb), 1);
  void* vp = 0; line(out, "vblock", C4(vb, 11, 0, 0, &vp, 0), 1);
  float* v = (float*)vp; for (int i = 0; i < 15; i++) v[i] = (float)i;
  line(out, "vbunlock", C0(vb, 12), 1);
  line(out, "begin", C0(dev, 34), 1);
  line(out, "clear", ((FCLEAR)VT(dev)[36])(dev, 0, 0, 3, 0xff0000ff, 1.0f, 0), 1);
  line(out, "rs", C2(dev, 50, 7, 1), 1);
  line(out, "settex", C2(dev, 61, 0, tex), 1);
  line(out, "stream", C3(dev, 83, 0, vb, 20), 1);
  line(out, "fvf", C1(dev, 76, 0x142), 1);
  line(out, "draw", C3(dev, 70, 4, 0, 1), 1);
  line(out, "end", C0(dev, 35), 1);
  line(out, "present", C4(dev, 15, 0, 0, 0, 0), 1);
  void* bb = 0; line(out, "backbuffer", C3(dev, 16, 0, 0, &bb), 1);
  C1(bb, 8, desc); line(out, "bbw", desc[6], 0); line(out, "bbh", desc[7], 0); RELEASE(bb);
  line(out, "texrefs", RELEASE(tex), 0); // device still holds it
  C2(dev, 61, 0, 0);
  line(out, "vbrefs", RELEASE(vb), 0);
  line(out, "devrelease", RELEASE(dev), 0);
  line(out, "d3drelease", RELEASE(d3d), 0);
  ExitProcess(0);
}
