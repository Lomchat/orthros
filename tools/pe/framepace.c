// Frame pacing against the display (shared/display-pacing.js, measured with tools/headless.mjs and its [pace] line):
// a fullscreen Direct3D 8 device (FLIP, presentation interval DEFAULT: Present waits for the retrace) whose own
// limiter presents every 33 ms of timeGetTime as BFME's 30 fps loop does — Sleep(0) until 33 ms after the previous
// frame's end, so ~33.5 ms a frame, a little slower than two refreshes of a 60 Hz screen —, each frame a clear of
// another colour after a few milliseconds of work that varies. Runs FRAMES frames then exits. A command line holding
// "imm" uses the IMMEDIATE interval (the page then shows the frames as they come); "p<NN>" another limiter period (ms:
// p34, ~34 ms a frame, drifts across the refreshes twice as fast and the other way).
#include "win.h"

DLLIMPORT DWORD WINAPI timeGetTime(void);
DLLIMPORT UINT WINAPI timeBeginPeriod(UINT);
DLLIMPORT void* WINAPI Direct3DCreate8(UINT);

typedef long HRESULT;
#define VT(o) (*(void***)(o))
typedef HRESULT (WINAPI *F0)(void*);
typedef HRESULT (WINAPI *F4)(void*, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *F6)(void*, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD);
typedef HRESULT (WINAPI *FCLEAR)(void*, DWORD, void*, DWORD, DWORD, float, DWORD);
typedef struct { UINT w, h, fmt, count, msaa, swap; HWND hwnd; BOOL windowed, autoDepth; UINT depthFmt; DWORD flags; UINT refresh, interval; } D3DPRESENT_PARAMETERS;

#define FRAMES 900
#define PERIOD 33

int _fltused = 1;
static void pump(void) { MSG m; while (PeekMessageA(&m, 0, 0, 0, 1)) { TranslateMessage(&m); DispatchMessageA(&m); } }
static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }

void __stdcall start(void) {
  const char* cmd = GetCommandLineA();
  int imm = 0; DWORD period = PERIOD;
  for (const char* p = cmd; p[0] && p[1] && p[2]; p++) {
    if (p[0] == 'i' && p[1] == 'm' && p[2] == 'm') imm = 1;
    if (p[0] == ' ' && p[1] == 'p' && p[2] >= '0' && p[2] <= '9') { period = 0; for (const char* q = p + 2; *q >= '0' && *q <= '9'; q++) period = period * 10 + (DWORD)(*q - '0'); }
  }
  WNDCLASSA wc = { 0, wndproc, 0, 0, GetModuleHandleA(0), 0, 0, 0, 0, "framepace" };
  RegisterClassA(&wc);
  HWND hwnd = CreateWindowExA(0, "framepace", "framepace", 0x90000000 /* WS_POPUP | WS_VISIBLE */, 0, 0, 640, 480, 0, 0, GetModuleHandleA(0), 0);
  pump();
  void* d3d = Direct3DCreate8(220);
  D3DPRESENT_PARAMETERS pp = { 640, 480, 22, 1, 0, 2 /* FLIP */, hwnd, 0 /* fullscreen */, 0, 0, 0, 0, imm ? 0x80000000 : 0 };
  void* dev = 0;
  if (((F6)VT(d3d)[15])(d3d, 0, 1, (DWORD)hwnd, 0x20 /* SOFTWARE_VERTEXPROCESSING */, (DWORD)&pp, (DWORD)&dev) || !dev) ExitProcess(2);
  timeBeginPeriod(1);
  volatile DWORD sink = 0;
  DWORD last = timeGetTime();
  for (int f = 0; f < FRAMES; f++) {
    pump();
    for (int i = 0; i < 150000 + (f * 7919 % 13) * 20000; i++) sink += i ^ f; // (the frame's work: a few ms, varying)
    ((F0)VT(dev)[34])(dev); // BeginScene
    ((FCLEAR)VT(dev)[36])(dev, 0, 0, 1, 0xff000000 | ((f * 37) & 0xff) << 16 | ((f * 11) & 0xff) << 8 | ((f * 5) & 0xff), 1.0f, 0);
    ((F0)VT(dev)[35])(dev); // EndScene
    ((F4)VT(dev)[15])(dev, 0, 0, 0, 0); // Present
    DWORD now;
    do { Sleep(0); now = timeGetTime(); } while (now - last < period);
    last = now;
  }
  ExitProcess(sink == 1 ? 1 : 0);
}
