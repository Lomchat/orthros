// Test program: Direct3D 9 through the COM vtables — device creation, textures, vertex
// declaration + buffer, sampler states, a visible textured/colored triangle, back buffer readback.
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
  WNDCLASSA wc = { 0, wndproc, 0, 0, GetModuleHandleA(0), 0, 0, 0, 0, "dx9test" };
  RegisterClassA(&wc);
  HWND hwnd = CreateWindowExA(0, "dx9test", "dx9", 0x10cf0000, 0, 0, 320, 240, 0, 0, GetModuleHandleA(0), 0);
  ShowWindow(hwnd, 5); pump();

  void* d3d = Direct3DCreate9(32);
  line(out, "d3d", d3d != 0, 0);
  line(out, "adapters", C0(d3d, 4), 0);
  DWORD mode[4]; line(out, "dispmode", C2(d3d, 8, 0, mode), 1);
  line(out, "modew", mode[0], 0); line(out, "modefmt", mode[3], 0);
  line(out, "modecount", C2(d3d, 6, 0, 22), 0);
  DWORD caps[76]; line(out, "caps", C3(d3d, 14, 0, 1, caps), 1);
  line(out, "maxtex", caps[22], 0); line(out, "vsver", caps[49], 1); line(out, "psver", caps[51], 1); line(out, "numrts", caps[60], 0);
  line(out, "checktype", C5(d3d, 9, 0, 1, 22, 22, 1), 1);
  line(out, "checkfmt", C6(d3d, 10, 0, 1, 22, 0, 3, 0x31545844), 1);
  line(out, "checkds", C6(d3d, 10, 0, 1, 22, 2, 1, 75), 1);
  D3DPRESENT_PARAMETERS pp = { 320, 240, 22, 1, 0, 0, 1, hwnd, 1, 1, 75, 0, 0, 0x80000000 };
  void* dev = 0; line(out, "device", C6(d3d, 16, 0, 1, hwnd, 0x40, &pp, &dev), 1);
  // texture: 8x8, filled with green (A8R8G8B8 = bytes B,G,R,A)
  void* tex = 0; line(out, "tex", C8(dev, 23, 8, 8, 1, 0, 21, 1, &tex, 0), 1);
  D3DLOCKED_RECT lr; line(out, "lockrect", C4(tex, 19, 0, &lr, 0, 0), 1);
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) ((DWORD*)((BYTE*)lr.bits + y * lr.pitch))[x] = 0xff00ff00;
  line(out, "unlockrect", C1(tex, 20, 0), 1);
  line(out, "levels", C0(tex, 13), 0);
  void* surf = 0; line(out, "surflevel", C2(tex, 18, 0, &surf), 1);
  DWORD desc[8]; C1(surf, 12, desc); line(out, "surfw", desc[6], 0); line(out, "surfms", desc[4], 0); RELEASE(surf);
  // vertex declaration: POSITIONT float4, COLOR d3dcolor, TEXCOORD0 float2
  D3DVERTEXELEMENT9 elems[] = { { 0, 0, 3, 0, 9, 0 }, { 0, 16, 4, 0, 10, 0 }, { 0, 20, 1, 0, 5, 0 }, { 0xff, 0, 17, 0, 0, 0 } };
  void* decl = 0; line(out, "decl", C2(dev, 86, elems, &decl), 1);
  line(out, "setdecl", C1(dev, 87, decl), 1);
  // vertex buffer: a big triangle covering the top-left half of the 320x240 target, textured (green) * diffuse white,
  // wound clockwise on screen (a D3D front face), then a counterclockwise one over the bottom-right half that
  // D3DCULL_CCW must cull
  void* vb = 0; line(out, "vb", C6(dev, 26, 6 * sizeof(VERTEX), 0, 0, 1, &vb, 0), 1);
  VERTEX* v = 0; line(out, "vblock", C4(vb, 11, 0, 0, &v, 0), 1);
  v[0].x = 0; v[0].y = 0; v[1].x = 320; v[1].y = 0; v[2].x = 0; v[2].y = 240;
  v[3].x = 320; v[3].y = 240; v[4].x = 320; v[4].y = 0; v[5].x = 0; v[5].y = 240;
  for (int i = 0; i < 6; i++) { v[i].z = 0.5f; v[i].rhw = 1.0f; v[i].color = 0xffffffff; v[i].u = (i % 3 == 1) ? 1.0f : 0.0f; v[i].v = (i % 3 == 2) ? 1.0f : 0.0f; }
  line(out, "vbunlock", C0(vb, 12), 1);
  line(out, "stream", C4(dev, 100, 0, vb, 0, sizeof(VERTEX)), 1);
  line(out, "begin", C0(dev, 41), 1);
  line(out, "clear", ((FCLEAR)VT(dev)[43])(dev, 0, 0, 3, 0xff0000ff, 1.0f, 0), 1);
  line(out, "rs_cull", C2(dev, 57, 22, 3), 1);
  line(out, "rs_light", C2(dev, 57, 137, 0), 1);
  line(out, "settex", C2(dev, 65, 0, tex), 1);
  line(out, "sampler", C3(dev, 69, 0, 6, 2), 1);
  // state setters may be deferred by the runtime: the matrix is taken at the call (a later change of the
  // caller's copy does not apply) and a getter sees every earlier set, in order
  float wm[16], gm[16]; for (int i = 0; i < 16; i++) wm[i] = (float)i;
  line(out, "settransform", C2(dev, 44, 256, wm), 1);
  wm[5] = 99.0f;
  line(out, "rs_zwrite", C2(dev, 57, 14, 0), 1);
  line(out, "rs_zwrite2", C2(dev, 57, 14, 1), 1);
  line(out, "gettransform", C2(dev, 45, 256, gm), 1);
  line(out, "transform5", (unsigned)gm[5], 0);
  DWORD zw = 7; C2(dev, 58, 14, &zw); line(out, "zwrite", zw, 0);
  { float id[16] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 }; C2(dev, 44, 256, id); }
  line(out, "draw", C3(dev, 81, 4, 0, 2), 1);
  // texel/pixel alignment (D3D9 rasterization rule: pixel centers on integer coordinates): a 4x4 black/white
  // checker drawn over pixels 100..103 with the usual -0.5 offset and bilinear filtering must stay exact
  void* chk = 0; line(out, "chktex", C8(dev, 23, 4, 4, 1, 0, 21, 1, &chk, 0), 1);
  D3DLOCKED_RECT lc; C4(chk, 19, 0, &lc, 0, 0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) ((DWORD*)((BYTE*)lc.bits + y * lc.pitch))[x] = ((x + y) & 1) ? 0xffffffff : 0xff000000;
  C1(chk, 20, 0);
  VERTEX q[4];
  for (int i = 0; i < 4; i++) { q[i].x = (i & 1) ? 103.5f : 99.5f; q[i].y = (i & 2) ? 103.5f : 99.5f; q[i].z = 0.25f; q[i].rhw = 1.0f; q[i].color = 0xffffffff; q[i].u = (i & 1) ? 1.0f : 0.0f; q[i].v = (i & 2) ? 1.0f : 0.0f; }
  C2(dev, 65, 0, chk);
  C3(dev, 69, 0, 5, 2); // MAGFILTER linear (MINFILTER is already linear)
  line(out, "drawup", C4(dev, 83, 5, 2, q, sizeof(VERTEX)), 1);
  C2(dev, 65, 0, tex);
  // hardware instancing (SetStreamSourceFreq): a 20x20 quad (stream 0, INDEXEDDATA | 4: four instances, its vertices
  // from BaseVertexIndex 4 — the first four are a decoy off screen), moved per instance by stream 1 (INSTANCEDATA | 1:
  // an offset each) and colored by stream 2 (INSTANCEDATA | 2: one color per two instances), through vs_2_0 / ps_2_0.
  // Expected: red quads at x 120 and 160, yellow at 200 and 240 (y 208..228); the fifth offset (x 280) is not drawn.
  {
    #define FREQ_INDEXED 0x40000000u
    #define FREQ_INSTANCE 0x80000000u
    static const DWORD vsc[] = { 0xfffe0200, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x0200001f, 0x8000000a, 0x900f0002, // dcl_position v0, dcl_texcoord v1, dcl_color v2
      0x03000002, 0xc00f0000, 0x90e40000, 0x90e40001, 0x02000001, 0xd00f0000, 0x90e40002, 0x0000ffff }; // add oPos, v0, v1; mov oD0, v2
    static const DWORD psc[] = { 0xffff0200, 0x0200001f, 0x80000000, 0x900f0000, 0x02000001, 0x800f0800, 0x90e40000, 0x0000ffff }; // dcl v0; mov oC0, v0
    D3DVERTEXELEMENT9 ie[] = { { 0, 0, 3, 0, 0, 0 }, { 1, 0, 3, 0, 5, 0 }, { 2, 0, 4, 0, 10, 0 }, { 0xff, 0, 17, 0, 0, 0 } };
    void *idecl = 0, *ivs = 0, *ips = 0, *gvb = 0, *ovb = 0, *cvb = 0, *ib = 0;
    line(out, "inst_decl", C2(dev, 86, ie, &idecl), 1);
    line(out, "inst_vs", C2(dev, 91, vsc, &ivs), 1);
    line(out, "inst_ps", C2(dev, 106, psc, &ips), 1);
    float* g = 0; C6(dev, 26, 8 * 16, 0, 0, 1, &gvb, 0); C4(gvb, 11, 0, 0, &g, 0);
    for (int i = 0; i < 8; i++) { int r = i & 1, b = (i >> 1) & 1; float s = i < 4 ? 0.0625f : 0.125f, t = i < 4 ? 0.04f : 0.1666667f;
      g[4 * i] = (i < 4 ? 2.0f : -1.0f) + r * s; g[4 * i + 1] = 1.0f - b * t; g[4 * i + 2] = 0.5f; g[4 * i + 3] = 1.0f; }
    C0(gvb, 12);
    // (the instance data in dynamic buffers, as games refill it each frame: DYNAMIC | WRITEONLY, locked with DISCARD;
    // the offsets' one sized for 2560 instances — a render worker copies what the draw reads of it, not all of it)
    C6(dev, 26, 2560 * 16, 0x208, 0, 0, &ovb, 0);
    DWORD* col = 0; C6(dev, 26, 3 * 4, 0x208, 0, 0, &cvb, 0); C4(cvb, 11, 0, 0, &col, 0x2000);
    col[0] = 0xffff0000; col[1] = 0xffffff00; col[2] = 0xffff00ff;
    C0(cvb, 12);
    WORD* ix = 0; line(out, "inst_ib", C6(dev, 27, 6 * 2, 0, 101, 1, &ib, 0), 1); C4(ib, 11, 0, 0, &ix, 0);
    ix[0] = 0; ix[1] = 1; ix[2] = 2; ix[3] = 2; ix[4] = 1; ix[5] = 3;
    C0(ib, 12);
    line(out, "freq_inst0", C2(dev, 102, 0, FREQ_INSTANCE | 1), 1); // (refused: instance data on stream 0, both flags, 0)
    line(out, "freq_both", C2(dev, 102, 1, FREQ_INSTANCE | FREQ_INDEXED | 1), 1);
    line(out, "freq_zero", C2(dev, 102, 1, 0), 1);
    C1(dev, 87, idecl); C1(dev, 92, ivs); C1(dev, 107, ips); C1(dev, 104, ib);
    C4(dev, 100, 0, gvb, 0, 16); C4(dev, 100, 1, ovb, 0, 16); C4(dev, 100, 2, cvb, 0, 4);
    line(out, "freq0", C2(dev, 102, 0, FREQ_INDEXED | 4), 1);
    line(out, "freq1", C2(dev, 102, 1, FREQ_INSTANCE | 1), 1);
    line(out, "freq2", C2(dev, 102, 2, FREQ_INSTANCE | 2), 1);
    DWORD f2 = 0; C2(dev, 103, 2, &f2); line(out, "getfreq2", f2, 1);
    C2(dev, 57, 22, 1); C2(dev, 57, 7, 0); // CULLMODE none, ZENABLE false
    for (int pass = 0; pass < 2; pass++) { // (a first frame's instances off screen, then the buffer refilled for the second)
      float* o = 0; C4(ovb, 11, 0, 0, &o, 0x2000);
      for (int i = 0; i < 5; i++) { o[4 * i] = (pass ? 120 + 40 * i : 480) / 160.0f; o[4 * i + 1] = -208 / 120.0f; o[4 * i + 2] = 0; o[4 * i + 3] = 0; }
      C0(ovb, 12);
      line(out, pass ? "inst_draw" : "inst_draw0", C6(dev, 82, 4, 4, 0, 4, 0, 2), 1);
    }
    C2(dev, 102, 0, 1); C2(dev, 102, 1, 1); C2(dev, 102, 2, 1); // (back to plain draws, as applications do)
    C1(dev, 92, 0); C1(dev, 107, 0); C1(dev, 87, decl); C1(dev, 104, 0); C4(dev, 100, 0, vb, 0, sizeof(VERTEX)); C4(dev, 100, 1, 0, 0, 0); C4(dev, 100, 2, 0, 0, 0);
    RELEASE(gvb); RELEASE(ovb); RELEASE(cvb); RELEASE(ib); RELEASE(idecl); RELEASE(ivs); RELEASE(ips);
  }
  line(out, "end", C0(dev, 42), 1);
  line(out, "present", C4(dev, 17, 0, 0, 0, 0), 1);
  void* bb = 0; line(out, "backbuffer", C4(dev, 18, 0, 0, 0, &bb), 1);
  C1(bb, 12, desc); line(out, "bbw", desc[6], 0); line(out, "bbh", desc[7], 0);
  // read the rendered frame back through an offscreen surface (checks GetRenderTargetData when a backend exists)
  void* off = 0; line(out, "offscreen", C6(dev, 36, 320, 240, 22, 2, &off, 0), 1);
  line(out, "rtdata", C2(dev, 32, bb, off), 1);
  D3DLOCKED_RECT lr2; line(out, "offlock", C3(off, 13, &lr2, 0, 0x10), 1);
  line(out, "px_tri", ((DWORD*)((BYTE*)lr2.bits + 60 * lr2.pitch))[60] & 0xffffff, 1);
  line(out, "px_clear", ((DWORD*)((BYTE*)lr2.bits + 200 * lr2.pitch))[300] & 0xffffff, 1);
  line(out, "px_chk00", ((DWORD*)((BYTE*)lr2.bits + 100 * lr2.pitch))[100] & 0xffffff, 1);
  line(out, "px_chk10", ((DWORD*)((BYTE*)lr2.bits + 100 * lr2.pitch))[101] & 0xffffff, 1);
  line(out, "px_chk33", ((DWORD*)((BYTE*)lr2.bits + 103 * lr2.pitch))[103] & 0xffffff, 1);
  line(out, "px_chk_out", ((DWORD*)((BYTE*)lr2.bits + 104 * lr2.pitch))[104] & 0xffffff, 1);
  for (int i = 0; i < 5; i++) { char k[] = "px_inst0"; k[7] = (char)('0' + i); line(out, k, ((DWORD*)((BYTE*)lr2.bits + 218 * lr2.pitch))[130 + 40 * i] & 0xffffff, 1); } // (the instances' centers)
  C0(off, 14);
  // gamma ramp halving every channel: applies to what reaches the screen, not to the back buffer
  WORD ramp[768]; for (int i = 0; i < 256; i++) ramp[i] = ramp[256 + i] = ramp[512 + i] = (WORD)(i * 257 / 2);
  C3(dev, 21, 0, 0, ramp);
  line(out, "present2", C4(dev, 17, 0, 0, 0, 0), 1);
  RELEASE(chk);
  RELEASE(off); RELEASE(bb);
  line(out, "texrefs", RELEASE(tex), 0);
  C2(dev, 65, 0, 0);
  line(out, "vbrefs", RELEASE(vb), 0);
  RELEASE(decl);
  line(out, "devrelease", RELEASE(dev), 0);
  line(out, "d3drelease", RELEASE(d3d), 0);
  ExitProcess(0);
}
