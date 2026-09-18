// CPU benchmark (CRT-free): integer loops, memory traffic, string ops and x87 math.
// Prints per-phase checksums; the harness measures host wall time per executor.
#include "win.h"
int _fltused = 1; // MSVC-style marker required by the linker when floats are used

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void put(HANDLE h, const char* s) { DWORD w; WriteFile(h, s, slen(s), &w, 0); }
static void puthex(HANDLE h, unsigned v) {
  char buf[12]; buf[0] = '0'; buf[1] = 'x';
  for (int i = 0; i < 8; i++) { unsigned d = (v >> (28 - 4 * i)) & 15; buf[2 + i] = d < 10 ? '0' + d : 'a' + d - 10; }
  buf[10] = '\n'; buf[11] = 0; put(h, buf);
}

static unsigned phase_int(void) {
  // xorshift + mixing, 20M iterations
  unsigned x = 0x12345678u, acc = 0;
  for (int i = 0; i < 20000000; i++) {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    acc += x * 2654435761u;
    if ((i & 7) == 0) acc = (acc << 3) | (acc >> 29);
  }
  return acc;
}

static unsigned phase_sieve(unsigned char* buf) {
  const int N = 2000000;
  for (int i = 0; i < N; i++) buf[i] = 1;
  for (int i = 2; i * i < N; i++) if (buf[i]) for (int j = i * i; j < N; j += i) buf[j] = 0;
  unsigned count = 0;
  for (int i = 2; i < N; i++) count += buf[i];
  return count;
}

static unsigned phase_memory(unsigned* a, unsigned* b) {
  // 1M element arrays: fill, copy (rep-like loops), sum with dependent loads
  const int N = 1 << 20;
  for (int i = 0; i < N; i++) a[i] = i * 7919u;
  for (int r = 0; r < 10; r++) for (int i = 0; i < N; i++) b[i] = a[i] + r;
  unsigned s = 0;
  for (int r = 0; r < 10; r++) for (int i = 0; i < N; i += 16) s += b[i] ^ a[(i * 31) & (N - 1)];
  return s;
}

static unsigned phase_string(char* s) {
  // strlen/strcmp style byte loops
  for (int i = 0; i < 4095; i++) s[i] = 'a' + (i % 26);
  s[4095] = 0;
  unsigned total = 0;
  for (int r = 0; r < 4000; r++) {
    int n = 0; while (s[n]) n++;
    total += n;
    const char* p = s; const char* q = s + 26; int eq = 1;
    while (*p && *q) { if (*p != *q) { eq = 0; break; } p++; q++; }
    total += eq;
  }
  return total;
}

static double fabs_(double v) { return v < 0 ? -v : v; }
static unsigned phase_fpu(void) {
  // x87 math: dot products, a little Newton iteration
  double acc = 0.0;
  double v[64];
  for (int i = 0; i < 64; i++) v[i] = (double)(i + 1) * 0.5;
  for (int r = 0; r < 300000; r++) {
    double d = 0.0;
    for (int i = 0; i < 64; i++) d += v[i] * v[63 - i];
    acc += d * 1e-6;
    double x = acc + 2.0;
    for (int k = 0; k < 3; k++) x = 0.5 * (x + (acc + 2.0) / x);
    acc = fabs_(x) * 0.999;
  }
  return (unsigned)(acc * 1000.0);
}

void __stdcall start(void) {
  HANDLE out = GetStdHandle((DWORD)-11);
  unsigned char* sieve = (unsigned char*)VirtualAlloc(0, 2000000, 0x3000, 4);
  unsigned* a = (unsigned*)VirtualAlloc(0, 4 << 20, 0x3000, 4);
  unsigned* b = (unsigned*)VirtualAlloc(0, 4 << 20, 0x3000, 4);
  char* s = (char*)VirtualAlloc(0, 4096, 0x3000, 4);
  DWORD t0 = GetTickCount();
  put(out, "int "); puthex(out, phase_int());
  DWORD t1 = GetTickCount();
  put(out, "sieve "); puthex(out, phase_sieve(sieve));
  DWORD t2 = GetTickCount();
  put(out, "memory "); puthex(out, phase_memory(a, b));
  DWORD t3 = GetTickCount();
  put(out, "string "); puthex(out, phase_string(s));
  DWORD t4 = GetTickCount();
  put(out, "fpu "); puthex(out, phase_fpu());
  DWORD t5 = GetTickCount();
  put(out, "ms "); puthex(out, t1 - t0); put(out, "ms "); puthex(out, t2 - t1); put(out, "ms "); puthex(out, t3 - t2); put(out, "ms "); puthex(out, t4 - t3); put(out, "ms "); puthex(out, t5 - t4);
  ExitProcess(0);
}
