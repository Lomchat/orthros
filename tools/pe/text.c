// Test program: GDI text with an outline font — metrics, extents, per-character widths, antialiased TextOut into
// a 32 bpp DIB section, DrawText word wrapping. Prints key=value lines checked by tests/browser.test.js.
#include "win.h"

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void put(HANDLE h, const char* s) { DWORD w; WriteFile(h, s, slen(s), &w, 0); }
static void putnum(HANDLE h, int v) { char buf[12]; int i = 11, neg = v < 0; unsigned u = neg ? -v : v; buf[i] = 0; if (u == 0) buf[--i] = '0'; while (u) { buf[--i] = '0' + u % 10; u /= 10; } if (neg) buf[--i] = '-'; put(h, buf + i); }
static void line(HANDLE h, const char* k, int v) { put(h, k); put(h, "="); putnum(h, v); put(h, "\n"); }

void start(void) {
  HANDLE out = GetStdHandle((DWORD)-11);
  HDC dc = CreateCompatibleDC(0);
  BITMAPINFO bi = { { sizeof(BITMAPINFOHEADER), 256, -64, 1, 32, 0, 0, 0, 0, 0, 0 }, { 0 } };
  unsigned* bits = 0;
  HBITMAP bm = CreateDIBSection(dc, &bi, 0, (void**)&bits, 0, 0);
  SelectObject(dc, bm);
  for (int i = 0; i < 256 * 64; i++) bits[i] = 0x00ffffff;
  HFONT f = CreateFontA(-20, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 4 /* ANTIALIASED_QUALITY */, 0, "Arial");
  SelectObject(dc, f);
  TEXTMETRICA tm; GetTextMetricsA(dc, &tm);
  line(out, "tm_height", tm.tmHeight); line(out, "tm_ascent", tm.tmAscent); line(out, "tm_descent", tm.tmDescent);
  line(out, "tm_internal", tm.tmInternalLeading); line(out, "tm_ave", tm.tmAveCharWidth); line(out, "tm_pitch", tm.tmPitchAndFamily);
  SIZE sz; GetTextExtentPoint32A(dc, "Hello, World", 12, &sz);
  line(out, "extent_cx", sz.cx); line(out, "extent_cy", sz.cy);
  int wi = 0, ww = 0; GetCharWidth32A(dc, 'i', 'i', &wi); GetCharWidth32A(dc, 'W', 'W', &ww);
  line(out, "width_i", wi); line(out, "width_W", ww);
  SetTextColor(dc, 0); SetBkMode(dc, 1 /* TRANSPARENT */);
  TextOutA(dc, 4, 4, "Hello, World", 12);
  int black = 0, gray = 0, right = 0;
  for (int y = 0; y < 64; y++) for (int x = 0; x < 256; x++) { unsigned p = bits[y * 256 + x] & 0xffffff; if (p == 0) black++; else if (p != 0xffffff) gray++; if (p != 0xffffff && x > right) right = x; }
  line(out, "px_black", black); line(out, "px_gray", gray); line(out, "px_right", right);
  RECT r = { 0, 0, 60, 0 };
  int h = DrawTextA(dc, "one two three four", -1, &r, 0x400 /* DT_CALCRECT */ | 0x10 /* DT_WORDBREAK */);
  line(out, "drawtext_h", h); line(out, "drawtext_w", r.right - r.left);
  ExitProcess(0);
}
