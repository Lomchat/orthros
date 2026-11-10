// Reference program for GDI text metrics: registers a font file (AddFontResourceExA, FR_PRIVATE), realizes it at a
// few heights and prints what GDI reports — TEXTMETRIC, GetTextExtentPoint32W of a few strings (accented letters
// included), ABC widths — and the coverage of one drawn string as ASCII art. Run on Windows/Wine and in Orthros to
// compare their text engines.
// Usage: fontmetrics.exe <font file> <face name> <lfHeight>... (face names with spaces: '_' stands for ' ')
#include "win.h"

typedef struct { int abcA; UINT abcB; int abcC; } ABC;
DLLIMPORT int WINAPI AddFontResourceExA(const char*, DWORD, void*);
DLLIMPORT HANDLE WINAPI CreateFontA(int, int, int, int, int, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, const char*);
DLLIMPORT BOOL WINAPI GetTextExtentPoint32W(HDC, const unsigned short*, int, POINT*);
DLLIMPORT BOOL WINAPI GetCharABCWidthsW(HDC, UINT, UINT, ABC*);
DLLIMPORT BOOL WINAPI ExtTextOutW(HDC, int, int, UINT, const RECT*, const unsigned short*, UINT, const int*);
DLLIMPORT int WINAPI GetTextFaceA(HDC, int, char*);
DLLIMPORT DWORD WINAPI GetGlyphIndicesW(HDC, const unsigned short*, int, unsigned short*, DWORD);

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static HANDLE out;
static void put(const char* s) { DWORD w; WriteFile(out, s, slen(s), &w, 0); }
static void putnum(int v) { char buf[12]; int i = 11, neg = v < 0; unsigned u = neg ? -v : v; buf[i] = 0; if (u == 0) buf[--i] = '0'; while (u) { buf[--i] = '0' + u % 10; u /= 10; } if (neg) buf[--i] = '-'; put(buf + i); }
static void kv(const char* k, int v) { put(" "); put(k); put("="); putnum(v); }

static const unsigned short S1[] = { 'M','i','s','t','y',' ','M','o','u','n','t','a','i','n','s',0 };
static const unsigned short S2[] = { 'R','o','y','a','u','m','e',' ','d','e','s',' ','F','o','r',0xea,'t','s',0 };
static const unsigned short S3[] = { 'L','o','t','h','l',0xf3,'r','i','e','n',0 };
static const unsigned short S4[] = { 'M','o','n','t','s',' ','B','r','u','m','e','u','x',0 };
static const unsigned short* STR[] = { S1, S2, S3, S4 };
static const char* NAME[] = { "Misty_Mountains", "Royaume_des_Forets", "Lothlorien", "Monts_Brumeux" };
static int wlen(const unsigned short* s) { int n = 0; while (s[n]) n++; return n; }

static char* next(char* p, char** tok) {
  while (*p == ' ') p++;
  if (*p == '"') { *tok = ++p; while (*p && *p != '"') p++; } else { *tok = p; while (*p && *p != ' ') p++; }
  if (*p) *p++ = 0;
  return p;
}
static int atoi_(const char* s) { int n = 0, neg = 0; if (*s == '-') { neg = 1; s++; } while (*s >= '0' && *s <= '9') n = n * 10 + *s++ - '0'; return neg ? -n : n; }

void start(void) {
  out = GetStdHandle((DWORD)-11);
  char* p = GetCommandLineA(), *tok;
  p = next(p, &tok); // program
  char* file; p = next(p, &file);
  char* face; p = next(p, &face);
  for (char* q = face; *q; q++) if (*q == '_') *q = ' ';
  int n = AddFontResourceExA(file, 0x10 /* FR_PRIVATE */, 0);
  put("add="); putnum(n); put("\n");
  HDC dc = CreateCompatibleDC(0);
  put("logpixelsy="); putnum(GetDeviceCaps(dc, 90)); put("\n");
  BITMAPINFO bi = { { sizeof(BITMAPINFOHEADER), 256, -48, 1, 32, 0, 0, 0, 0, 0, 0 }, { 0 } };
  unsigned* bits = 0;
  HBITMAP bm = CreateDIBSection(dc, &bi, 0, (void**)&bits, 0, 0);
  SelectObject(dc, bm);
  for (;;) {
    p = next(p, &tok);
    if (!*tok) break;
    int h = atoi_(tok);
    for (int weight = 400; weight <= 700; weight += 300) {
      HANDLE f = CreateFontA(h, 0, 0, 0, weight, 0, 0, 0, 0 /* ANSI_CHARSET */, 0, 0, 4 /* ANTIALIASED_QUALITY */, 0, face);
      HANDLE old = SelectObject(dc, f);
      char fn[64]; GetTextFaceA(dc, 64, fn);
      TEXTMETRICA tm; GetTextMetricsA(dc, &tm);
      put("h="); putnum(h); kv("w", weight); put(" face="); put(fn);
      kv("tmHeight", tm.tmHeight); kv("tmAscent", tm.tmAscent); kv("tmDescent", tm.tmDescent); kv("tmInt", tm.tmInternalLeading);
      kv("tmExt", tm.tmExternalLeading); kv("tmAve", tm.tmAveCharWidth); kv("tmMax", tm.tmMaxCharWidth); kv("tmWeight", tm.tmWeight); kv("tmOverhang", tm.tmOverhang);
      put("\n");
      for (int i = 0; i < 4; i++) { POINT sz; GetTextExtentPoint32W(dc, STR[i], wlen(STR[i]), &sz); put("  "); put(NAME[i]); kv("cx", sz.x); kv("cy", sz.y); put("\n"); }
      static const unsigned short CH[] = { 'M', 'o', 0xf3, 'i', 0xea, 'W', ' ', 0 };
      put("  abc");
      for (int i = 0; CH[i]; i++) { ABC a; GetCharABCWidthsW(dc, CH[i], CH[i], &a); put(" "); putnum(CH[i]); put(":"); putnum(a.abcA); put(","); putnum(a.abcB); put(","); putnum(a.abcC); }
      put("\n");
      static const unsigned short GI[] = { 'A', 0xf3, 0x4e00, 0 };
      unsigned short gi[3]; GetGlyphIndicesW(dc, GI, 3, gi, 1 /* GGI_MARK_NONEXISTING_GLYPHS */);
      put("  glyphs"); kv("A", gi[0]); kv("o_acute", gi[1]); kv("u4e00", gi[2]); put("\n");
      if (weight == 400) {
        for (int i = 0; i < 256 * 48; i++) bits[i] = 0;
        SetTextColor(dc, 0xffffff); SetBkMode(dc, 1);
        ExtTextOutW(dc, 2, 2, 0, 0, S3, wlen(S3), 0);
        int maxx = 0; for (int y = 0; y < 48; y++) for (int x = 0; x < 256; x++) if (bits[y * 256 + x] & 0xff) { if (x > maxx) maxx = x; }
        int sum = 0;
        for (int y = 0; y < 48; y++) {
          int any = 0; for (int x = 0; x <= maxx; x++) if (bits[y * 256 + x] & 0xff) any = 1;
          if (!any) continue;
          put("  |");
          for (int x = 0; x <= maxx && x < 160; x++) { int v = bits[y * 256 + x] & 0xff; sum += v; char c[2] = { " .:-=+*#%@"[v * 10 / 256], 0 }; put(c); }
          put("\n");
        }
        kv("ink_sum", sum); kv("ink_right", maxx); put("\n");
      }
      SelectObject(dc, old); DeleteObject(f);
    }
  }
  ExitProcess(0);
}
