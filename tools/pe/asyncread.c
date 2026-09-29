// Test program: ReadFile on a file whose data arrives asynchronously (a network-backed game file). The results must
// be the same whether a read waits synchronously or parks its thread (vm.asyncReads): bytes, byte counts, the file
// pointer, OVERLAPPED offsets and EOF. Also: a thread parked on such a read while another thread waits for it inside a
// callback that runs nested (a wait, which cannot let the asynchronous fetch complete).
#include "win.h"

typedef struct { DWORD Internal, InternalHigh, Offset, OffsetHigh; HANDLE hEvent; } OVERLAPPED;
DLLIMPORT BOOL WINAPI EnumWindows(BOOL (WINAPI*)(HWND, LPARAM), LPARAM);

static HANDLE out, hf, evRead;
static unsigned char buf[4][256];
static DWORD got[6], ret[6], err[6], ptr[3];
static OVERLAPPED ov, ov2;

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void put(const char* s) { DWORD w; WriteFile(out, s, slen(s), &w, 0); }
static void putnum(unsigned v) {
  char b[12]; int i = 11; b[i] = 0;
  if (v == 0) b[--i] = '0';
  while (v) { b[--i] = '0' + v % 10; v /= 10; }
  put(b + i);
}
static unsigned sum(const unsigned char* p, int n) { unsigned s = 0; for (int i = 0; i < n; i++) s = s * 31 + p[i]; return s; }

static DWORD WINAPI reader(void* p) {
  SetLastError(0);
  ret[0] = ReadFile(hf, buf[0], 16, &got[0], 0);                     // file pointer 0 -> 16
  ptr[0] = SetFilePointer(hf, 0, 0, 1);
  ov.Offset = 70000; SetLastError(0);
  ret[1] = ReadFile(hf, buf[1], 100, &got[1], &ov);                  // OVERLAPPED offset (synchronous handle)
  err[1] = GetLastError();
  ptr[1] = SetFilePointer(hf, 0, 0, 1);
  SetFilePointer(hf, 200000 - 40, 0, 0);
  ret[2] = ReadFile(hf, buf[2], 100, &got[2], 0);                    // short read at the end of the file
  ptr[2] = SetFilePointer(hf, 0, 0, 1);
  ov2.Offset = 300000; SetLastError(0);
  ret[3] = ReadFile(hf, buf[3], 10, &got[3], &ov2);                  // OVERLAPPED past the end: ERROR_HANDLE_EOF
  err[3] = GetLastError();
  return 0;
}

static DWORD WINAPI lateReader(void* p) {
  SetFilePointer(hf, 150000, 0, 0);
  ret[4] = ReadFile(hf, buf[3], 64, &got[4], 0);
  SetEvent(evRead);
  return 0;
}

static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }
static DWORD enumWait;
// EnumWindows calls it nested (a JavaScript frame in between: its waits cannot unwind) — the parked reader's data
// can only arrive if the wait lets the event loop run
static BOOL WINAPI enumProc(HWND h, LPARAM l) { enumWait = WaitForSingleObject(evRead, 3000); return 0; }

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  hf = CreateFileA("C:\\Net\\data.bin", 0x80000000, 1, 0, 3, 0, 0);
  if (hf == (HANDLE)-1) { put("open failed\n"); ExitProcess(1); }
  HANDLE t = CreateThread(0, 0, reader, 0, 0, 0);
  WaitForSingleObject(t, 20000);
  for (int i = 0; i < 4; i++) {
    put("read "); putnum(i); put(": ret="); putnum(ret[i]); put(" got="); putnum(got[i]);
    put(" sum="); putnum(sum(buf[i], got[i])); if (i < 3) { put(" ptr="); putnum(ptr[i]); }
    if (i == 1 || i == 3) { put(" err="); putnum(err[i]); }
    put("\n");
  }
  put("ovl: "); putnum(ov.Internal); put(" "); putnum(ov.InternalHigh); put(" "); putnum(ov.Offset); put("\n");
  put("ovl2: "); putnum(ov2.Internal); put(" "); putnum(ov2.InternalHigh); put(" "); putnum(ov2.Offset); put("\n");

  WNDCLASSA wc = {0};
  wc.lpfnWndProc = wndproc; wc.hInstance = GetModuleHandleA(0); wc.lpszClassName = "asyncread";
  RegisterClassA(&wc);
  CreateWindowExA(0, "asyncread", "asyncread", 0, 0, 0, 100, 100, 0, 0, wc.hInstance, 0);
  evRead = CreateEventA(0, 1, 0, 0);
  HANDLE t2 = CreateThread(0, 0, lateReader, 0, 0, 0);
  Sleep(10); // (the late reader starts its read, at top level)
  DWORD t0 = GetTickCount();
  EnumWindows(enumProc, 0);
  DWORD w = enumWait;
  DWORD waited = GetTickCount() - t0;
  WaitForSingleObject(t2, 20000);
  put("nested wait="); putnum(w); put(" got="); putnum(got[4]); put(" sum="); putnum(sum(buf[3], got[4])); put(" quick="); putnum(waited < 1000); put("\n");
  ExitProcess(0);
}
