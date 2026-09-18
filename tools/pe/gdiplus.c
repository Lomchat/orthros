// Test program: GDI+ flat API (image loading, LockBits, HBITMAP export, drawing with alpha).
#include "win.h"

typedef int GpStatus;
typedef struct { DWORD GdiplusVersion; void* DebugEventCallback; BOOL SuppressBackgroundThread; BOOL SuppressExternalCodecs; } GdiplusStartupInput;
typedef struct { UINT Width; UINT Height; int Stride; int PixelFormat; void* Scan0; UINT Reserved; } BitmapData;
typedef struct { int X, Y, Width, Height; } GpRect;
DLLIMPORT GpStatus WINAPI GdiplusStartup(DWORD* token, const GdiplusStartupInput* in, void* out);
DLLIMPORT void WINAPI GdiplusShutdown(DWORD token);
DLLIMPORT GpStatus WINAPI GdipCreateBitmapFromFile(const unsigned short* name, void** bitmap);
DLLIMPORT GpStatus WINAPI GdipGetImageWidth(void* image, UINT* w);
DLLIMPORT GpStatus WINAPI GdipGetImageHeight(void* image, UINT* h);
DLLIMPORT GpStatus WINAPI GdipGetImagePixelFormat(void* image, int* pf);
DLLIMPORT GpStatus WINAPI GdipBitmapLockBits(void* bitmap, const GpRect* rect, UINT flags, int pf, BitmapData* bd);
DLLIMPORT GpStatus WINAPI GdipBitmapUnlockBits(void* bitmap, BitmapData* bd);
DLLIMPORT GpStatus WINAPI GdipDisposeImage(void* image);
DLLIMPORT GpStatus WINAPI GdipCreateHBITMAPFromBitmap(void* bitmap, HBITMAP* hbm, DWORD bg);
DLLIMPORT GpStatus WINAPI GdipCreateFromHDC(HDC hdc, void** graphics);
DLLIMPORT GpStatus WINAPI GdipDrawImageI(void* graphics, void* image, int x, int y);
DLLIMPORT GpStatus WINAPI GdipDrawImageRectI(void* graphics, void* image, int x, int y, int w, int h);
DLLIMPORT GpStatus WINAPI GdipDeleteGraphics(void* graphics);
DLLIMPORT GpStatus WINAPI GdipBitmapGetPixel(void* bitmap, int x, int y, DWORD* argb);
DLLIMPORT GpStatus WINAPI GdipCreateBitmapFromScan0(int w, int h, int stride, int pf, BYTE* scan0, void** bitmap);
DLLIMPORT GpStatus WINAPI GdipCloneImage(void* image, void** clone);
DLLIMPORT GpStatus WINAPI GdipGetImagePaletteSize(void* image, int* size);
DLLIMPORT GpStatus WINAPI GdipGetImageGraphicsContext(void* image, void** graphics);

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void put(HANDLE h, const char* s) { DWORD w; WriteFile(h, s, slen(s), &w, 0); }
static void puthex(HANDLE h, unsigned v) { char b[11] = "0x"; for (int i = 0; i < 8; i++) b[2 + i] = "0123456789abcdef"[(v >> (28 - 4 * i)) & 15]; b[10] = 0; put(h, b); }
static void putnum(HANDLE h, unsigned v) { char buf[12]; int i = 11; buf[i] = 0; if (v == 0) buf[--i] = '0'; while (v) { buf[--i] = '0' + v % 10; v /= 10; } put(h, buf + i); }
static void line(HANDLE h, const char* k, unsigned v, int hex) { put(h, k); put(h, "="); if (hex) puthex(h, v); else putnum(h, v); put(h, "\n"); }

static const unsigned short PNG[] = { 'C', ':', '\\', 'T', 'e', 's', 't', '\\', 'r', 'g', 'b', '.', 'p', 'n', 'g', 0 };
static const unsigned short JPG[] = { 'C', ':', '\\', 'T', 'e', 's', 't', '\\', 'b', 'a', 's', 'e', '.', 'j', 'p', 'g', 0 };
static const unsigned short MISSING[] = { 'C', ':', '\\', 'T', 'e', 's', 't', '\\', 'n', 'o', '.', 'p', 'n', 'g', 0 };

void __stdcall start(void) {
  HANDLE out = GetStdHandle((DWORD)-11);
  DWORD token = 0; GdiplusStartupInput in = { 1, 0, 0, 0 };
  line(out, "startup", GdiplusStartup(&token, &in, 0), 0);
  void* png = 0; void* jpg = 0; void* nope = 0;
  line(out, "missing", GdipCreateBitmapFromFile(MISSING, &nope), 0);
  line(out, "png", GdipCreateBitmapFromFile(PNG, &png), 0);
  UINT w = 0, h = 0; int pf = 0;
  GdipGetImageWidth(png, &w); GdipGetImageHeight(png, &h); GdipGetImagePixelFormat(png, &pf);
  line(out, "w", w, 0); line(out, "h", h, 0); line(out, "pf", pf, 1);
  DWORD argb = 0; GdipBitmapGetPixel(png, 2, 0, &argb); line(out, "px(2,0)", argb, 1);
  GdipBitmapGetPixel(png, 30, 30, &argb); line(out, "px(30,30)", argb, 1);
  // LockBits read as 24bpp
  BitmapData bd; GpRect r = { 0, 0, (int)w, (int)h };
  line(out, "lock", GdipBitmapLockBits(png, &r, 1, 0x21808, &bd), 0);
  line(out, "stride", bd.Stride, 0);
  BYTE* p = (BYTE*)bd.Scan0 + 2 * 3;
  line(out, "bgr", p[0] | (p[1] << 8) | (p[2] << 16), 1);
  line(out, "unlock", GdipBitmapUnlockBits(png, &bd), 0);
  // LockBits write as 32bpp ARGB: paint pixel (5,5) opaque green
  line(out, "lockw", GdipBitmapLockBits(png, 0, 2, 0x26200a, &bd), 0);
  ((DWORD*)((BYTE*)bd.Scan0 + 5 * bd.Stride))[5] = 0xff00ff00;
  GdipBitmapUnlockBits(png, &bd);
  GdipBitmapGetPixel(png, 5, 5, &argb); line(out, "px(5,5)", argb, 1);
  // JPEG
  line(out, "jpg", GdipCreateBitmapFromFile(JPG, &jpg), 0);
  GdipGetImageWidth(jpg, &w); GdipGetImagePixelFormat(jpg, &pf); line(out, "jw", w, 0); line(out, "jpf", pf, 1);
  GdipBitmapGetPixel(jpg, 80, 30, &argb); line(out, "jpx(80,30)", argb, 1); // inside the green rectangle
  int palsize = -1; GdipGetImagePaletteSize(jpg, &palsize); line(out, "palsize", palsize, 0);
  // HBITMAP export and GDI readback
  HBITMAP hbm = 0; line(out, "hbm", GdipCreateHBITMAPFromBitmap(png, &hbm, 0xffffffff), 0);
  HDC dc = CreateCompatibleDC(0); SelectObject(dc, hbm);
  line(out, "gdi(2,0)", GetPixel(dc, 2, 0), 1);
  // alpha drawing: a 2x2 half-transparent red bitmap over the image, then read back
  static BYTE buf[2 * 2 * 4];
  for (int i = 0; i < 4; i++) { buf[i * 4] = 0; buf[i * 4 + 1] = 0; buf[i * 4 + 2] = 255; buf[i * 4 + 3] = 128; }
  void* small = 0; line(out, "scan0", GdipCreateBitmapFromScan0(2, 2, 8, 0x26200a, buf, &small), 0);
  void* g = 0; line(out, "gctx", GdipGetImageGraphicsContext(png, &g), 0);
  line(out, "draw", GdipDrawImageI(g, small, 5, 5), 0);
  GdipDeleteGraphics(g);
  GdipBitmapGetPixel(png, 5, 5, &argb); line(out, "blend(5,5)", argb, 1);
  // draw scaled into a GDI DC through a graphics
  void* gd = 0; line(out, "gdc", GdipCreateFromHDC(dc, &gd), 0);
  line(out, "drawrect", GdipDrawImageRectI(gd, jpg, 0, 0, 40, 40), 0);
  GdipDeleteGraphics(gd);
  line(out, "gdi(35,12)", GetPixel(dc, 35, 12), 1); // (35,12) in the 40x40 scaled jpeg = source (~85,~18): green rect
  void* clone = 0; line(out, "clone", GdipCloneImage(png, &clone), 0);
  GdipBitmapGetPixel(clone, 2, 0, &argb); line(out, "cpx(2,0)", argb, 1);
  GdipDisposeImage(clone); GdipDisposeImage(small); GdipDisposeImage(jpg); GdipDisposeImage(png);
  DeleteDC(dc); DeleteObject(hbm);
  GdiplusShutdown(token);
  ExitProcess(0);
}
