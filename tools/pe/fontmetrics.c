// Reference program for GDI text metrics: registers a font file (AddFontResourceExA, FR_PRIVATE), realizes it at a
// few heights and prints what GDI reports — TEXTMETRIC, GetTextExtentPoint32W of a few strings (accented letters
// included), ABC widths — and the coverage of one drawn string as ASCII art. Run on Windows/Wine and in Orthros to
// compare their text engines.
// Then, at weight 400, what GDI does with characters the font lacks ("missing" section): TEXTMETRICW's first, last,
// default and break characters, per probe character (C1 controls U+0092 / U+0085 among them) GetGlyphIndicesW with and
// without GGI_MARK_NONEXISTING_GLYPHS, GetTextExtentPoint32W, GetCharWidth32W and ABC widths, then "l<X>a" drawn with
// ExtTextOutW for X = U+2019, U+0092, U+0085, U+2026 and glyph 0 drawn with ETO_GLYPH_INDEX, as ASCII art.
// Usage: fontmetrics.exe <font file> <face name> <lfHeight>... (face names with spaces: '_' stands for ' ';
// font file '-': no file registered, the face as the system maps it)
#include "win.h"

typedef struct { int abcA; UINT abcB; int abcC; } ABC;
typedef struct { LONG tmHeight, tmAscent, tmDescent, tmInternalLeading, tmExternalLeading, tmAveCharWidth, tmMaxCharWidth, tmWeight, tmOverhang, tmDigitizedAspectX, tmDigitizedAspectY; unsigned short tmFirstChar, tmLastChar, tmDefaultChar, tmBreakChar; BYTE tmItalic, tmUnderlined, tmStruckOut, tmPitchAndFamily, tmCharSet; } TEXTMETRICW;
DLLIMPORT int WINAPI AddFontResourceExA(const char*, DWORD, void*);
DLLIMPORT HANDLE WINAPI CreateFontA(int, int, int, int, int, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, const char*);
DLLIMPORT BOOL WINAPI GetTextExtentPoint32W(HDC, const unsigned short*, int, POINT*);
DLLIMPORT BOOL WINAPI GetCharABCWidthsW(HDC, UINT, UINT, ABC*);
DLLIMPORT BOOL WINAPI ExtTextOutW(HDC, int, int, UINT, const RECT*, const unsigned short*, UINT, const int*);
DLLIMPORT int WINAPI GetTextFaceA(HDC, int, char*);
DLLIMPORT DWORD WINAPI GetGlyphIndicesW(HDC, const unsigned short*, int, unsigned short*, DWORD);
DLLIMPORT BOOL WINAPI GetTextMetricsW(HDC, TEXTMETRICW*);
DLLIMPORT BOOL WINAPI GetCharWidth32W(HDC, UINT, UINT, int*);

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
static void puthex(unsigned v) { char b[5]; for (int i = 3; i >= 0; i--) { b[i] = "0123456789ABCDEF"[v & 15]; v >>= 4; } b[4] = 0; put(b); }

// Characters a font may lack: C1 controls as a Windows-1252 file zero-extended to UTF-16 gives them (U+0092 for ’,
// U+0085 for …, U+008E for Ž), their real code points, a C0 control, DEL and a CJK ideograph.
static const unsigned short PROBE[] = { ' ', '\'', 0x2019, 0x2026, 0x153, 0x92, 0x85, 0x8e, 0x09, 0x7f, 0x4e00, 0 };
// "l<X>a" for X in { ’, U+0092, U+0085, … } drawn into a 512x96 DIB; glyph 0 drawn by index
static const unsigned short DRAW[4][4] = { { 'l', 0x2019, 'a', 0 }, { 'l', 0x92, 'a', 0 }, { 'l', 0x85, 'a', 0 }, { 'l', 0x2026, 'a', 0 } };
enum { DW = 512, DH = 96 };
static void art(unsigned* px, const char* label) {
  int maxx = 0, minx = DW, sum = 0;
  for (int y = 0; y < DH; y++) for (int x = 0; x < DW; x++) if (px[y * DW + x] & 0xff) { if (x > maxx) maxx = x; if (x < minx) minx = x; }
  put("  draw "); put(label); put("\n");
  for (int y = 0; y < DH; y++) {
    int any = 0; for (int x = 0; x <= maxx; x++) if (px[y * DW + x] & 0xff) any = 1;
    if (!any) continue;
    put("  |");
    for (int x = 0; x <= maxx && x < 200; x++) { int v = px[y * DW + x] & 0xff; sum += v; char c[2] = { " .:-=+*#%@"[v * 10 / 256], 0 }; put(c); }
    put("\n");
  }
  kv("ink_sum", sum); kv("ink_left", minx < DW ? minx : -1); kv("ink_right", maxx); put("\n");
}
static void missing(HDC dc, unsigned* px) {
  TEXTMETRICW tm; GetTextMetricsW(dc, &tm);
  put("  missing: tmFirstChar=U+"); puthex(tm.tmFirstChar); put(" tmLastChar=U+"); puthex(tm.tmLastChar);
  put(" tmDefaultChar=U+"); puthex(tm.tmDefaultChar); put(" tmBreakChar=U+"); puthex(tm.tmBreakChar); kv("tmCharSet", tm.tmCharSet); put("\n");
  for (int i = 0; PROBE[i]; i++) {
    unsigned short ch = PROBE[i], g1 = 0, g0 = 0; POINT sz; int w = 0; ABC a;
    GetGlyphIndicesW(dc, &ch, 1, &g1, 1 /* GGI_MARK_NONEXISTING_GLYPHS */);
    GetGlyphIndicesW(dc, &ch, 1, &g0, 0);
    GetTextExtentPoint32W(dc, &ch, 1, &sz);
    GetCharWidth32W(dc, ch, ch, &w);
    GetCharABCWidthsW(dc, ch, ch, &a);
    put("  U+"); puthex(ch); kv("gi_mark", g1); kv("gi", g0); kv("cx", sz.x); kv("width", w);
    put(" abc="); putnum(a.abcA); put(","); putnum(a.abcB); put(","); putnum(a.abcC); put("\n");
  }
  static const char* LBL[] = { "l_U+2019_a", "l_U+0092_a", "l_U+0085_a", "l_U+2026_a" };
  for (int k = 0; k < 5; k++) {
    for (int i = 0; i < DW * DH; i++) px[i] = 0;
    if (k < 4) { POINT sz; GetTextExtentPoint32W(dc, DRAW[k], 3, &sz); ExtTextOutW(dc, 4, 4, 0, 0, DRAW[k], 3, 0); put("  extent "); put(LBL[k]); kv("cx", sz.x); put("\n"); art(px, LBL[k]); }
    else { static const unsigned short g[] = { 0 }; ExtTextOutW(dc, 4, 4, 0x10 /* ETO_GLYPH_INDEX */, 0, g, 1, 0); art(px, "glyph_0"); }
  }
}

void start(void) {
  out = GetStdHandle((DWORD)-11);
  char* p = GetCommandLineA(), *tok;
  p = next(p, &tok); // program
  char* file; p = next(p, &file);
  char* face; p = next(p, &face);
  for (char* q = face; *q; q++) if (*q == '_') *q = ' ';
  int n = file[0] == '-' && !file[1] ? 0 : AddFontResourceExA(file, 0x10 /* FR_PRIVATE */, 0);
  put("add="); putnum(n); put("\n");
  HDC dc = CreateCompatibleDC(0), dc2 = CreateCompatibleDC(0);
  put("logpixelsy="); putnum(GetDeviceCaps(dc, 90)); put("\n");
  BITMAPINFO bi = { { sizeof(BITMAPINFOHEADER), 256, -48, 1, 32, 0, 0, 0, 0, 0, 0 }, { 0 } };
  unsigned* bits = 0;
  HBITMAP bm = CreateDIBSection(dc, &bi, 0, (void**)&bits, 0, 0);
  SelectObject(dc, bm);
  BITMAPINFO bi2 = { { sizeof(BITMAPINFOHEADER), DW, -DH, 1, 32, 0, 0, 0, 0, 0, 0 }, { 0 } };
  unsigned* bits2 = 0;
  SelectObject(dc2, CreateDIBSection(dc2, &bi2, 0, (void**)&bits2, 0, 0));
  SetTextColor(dc2, 0xffffff); SetBkMode(dc2, 1);
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
        HANDLE old2 = SelectObject(dc2, f);
        missing(dc2, bits2);
        SelectObject(dc2, old2);
      }
      SelectObject(dc, old); DeleteObject(f);
    }
  }
  ExitProcess(0);
}
