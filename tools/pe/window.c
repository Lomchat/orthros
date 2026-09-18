// Test program: a GDI window with a paint handler, timers, GetPixel readback, message loop.
#include "win.h"

#define WM_CREATE 1
#define WM_DESTROY 2
#define WM_PAINT 0xF
#define WM_TIMER 0x113
#define WM_KEYDOWN 0x100
#define WM_LBUTTONDOWN 0x201

static int paints = 0, timers = 0, result = 0, keys = 0, clicks = 0;

static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_CREATE:
      SetTimer(h, 1, 20, 0);
      return 0;
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(h, &ps);
      RECT r = { 10, 10, 110, 60 };
      HBRUSH b = CreateSolidBrush(0x000000FF); // COLORREF red
      FillRect(dc, &r, b);
      DeleteObject(b);
      SetPixel(dc, 200, 100, 0x00FF0000); // blue
      TextOutA(dc, 20, 100, "Orthros", 7);
      paints++;
      EndPaint(h, &ps);
      return 0;
    }
    case WM_KEYDOWN: keys += (int)w; return 0;
    case WM_LBUTTONDOWN: clicks += (int)(l & 0xffff) + (int)(l >> 16); return 0;
    case WM_TIMER:
      timers++;
      if (timers == 3) {
        HDC dc = GetDC(h);
        COLORREF c1 = GetPixel(dc, 50, 30);
        COLORREF c2 = GetPixel(dc, 200, 100);
        ReleaseDC(h, dc);
        result = (c1 == 0x000000FF && c2 == 0x00FF0000) ? 7 : 1;
        InvalidateRect(h, 0, 0);
      }
      if (timers == 6) DestroyWindow(h);
      return 0;
    case WM_DESTROY:
      PostQuitMessage(result + paints * 10 + keys * 1000 + clicks * 100000);
      return 0;
  }
  return DefWindowProcA(h, m, w, l);
}

void __stdcall start(void) {
  WNDCLASSA wc;
  wc.style = 3; wc.lpfnWndProc = wndproc; wc.cbClsExtra = 0; wc.cbWndExtra = 0; wc.hInstance = GetModuleHandleA(0);
  wc.hIcon = 0; wc.hCursor = LoadCursorA(0, (const char*)32512); wc.hbrBackground = (HBRUSH)(1 + 5); // COLOR_WINDOW+1
  wc.lpszMenuName = 0; wc.lpszClassName = "OrthrosTest";
  if (!RegisterClassA(&wc)) ExitProcess(200);
  HWND h = CreateWindowExA(0, "OrthrosTest", "Orthros test window", 0x00CF0000 | 0x10000000, 100, 100, 320, 240, 0, 0, wc.hInstance, 0);
  if (!h) ExitProcess(201);
  UpdateWindow(h);
  MSG msg;
  while (GetMessageA(&msg, 0, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessageA(&msg);
  }
  ExitProcess((UINT)msg.wParam);
}
