// Test program: CRT-free Win32 console app exercising kernel32 basics.
#include "win.h"

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void put(HANDLE h, const char* s) { DWORD w; WriteFile(h, s, slen(s), &w, 0); }
static void putnum(HANDLE h, unsigned v) {
  char buf[12]; int i = 11; buf[i] = 0;
  if (v == 0) buf[--i] = '0';
  while (v) { buf[--i] = '0' + v % 10; v /= 10; }
  put(h, buf + i);
}

void __stdcall start(void) {
  HANDLE out = GetStdHandle((DWORD)-11);
  put(out, "hello from guest\n");
  // heap
  char* p = (char*)HeapAlloc(GetProcessHeap(), 8, 100);
  for (int i = 0; i < 26; i++) p[i] = 'a' + i;
  p[26] = '\n'; p[27] = 0;
  put(out, p);
  p = (char*)HeapReAlloc(GetProcessHeap(), 0, p, 5000);
  put(out, p);
  HeapFree(GetProcessHeap(), 0, p);
  // TLS
  DWORD slot = TlsAlloc();
  TlsSetValue(slot, (void*)1234);
  putnum(out, (unsigned)TlsGetValue(slot)); put(out, "\n");
  // virtual memory
  unsigned* v = (unsigned*)VirtualAlloc(0, 0x10000, 0x3000, 0x04);
  v[0x3fff] = 42;
  putnum(out, v[0x3fff]); put(out, "\n");
  VirtualFree(v, 0, 0x8000);
  // command line & module name
  put(out, GetCommandLineA()); put(out, "\n");
  char name[260];
  GetModuleFileNameA(0, name, 260);
  put(out, name); put(out, "\n");
  // file I/O
  HANDLE f = CreateFileA("C:\\Test\\out.txt", 0x40000000, 0, 0, 2, 0x80, 0);
  if (f != (HANDLE)-1) { put(f, "written by guest"); CloseHandle(f); }
  f = CreateFileA("C:\\Test\\out.txt", 0x80000000, 1, 0, 3, 0x80, 0);
  if (f != (HANDLE)-1) {
    char rb[64]; DWORD r = 0;
    ReadFile(f, rb, 63, &r, 0); rb[r] = 0;
    put(out, "read back: "); put(out, rb); put(out, "\n");
    putnum(out, GetFileSize(f, 0)); put(out, "\n");
    CloseHandle(f);
  } else put(out, "open failed\n");
  // GetLastError round trip
  SetLastError(1234);
  putnum(out, GetLastError()); put(out, "\n");
  // x87 + string ops (exercised by CRT-like code)
  double d = 3.5; d = d * 2.0 + 1.0;
  putnum(out, (unsigned)d); put(out, "\n");
  ExitProcess(42);
}
