// Test program: synchronization and shared file objects under every interleaving the scheduler can produce. Several
// threads hammer a critical section, a mutex (infinite and timed waits), an InterlockedExchange spin lock and one file
// object they read without any lock of their own (Windows reads and advances a synchronous handle's file pointer
// atomically: every 4-byte record of the file is read exactly once in all). Inside the locked sections the threads
// yield (Sleep(0), Sleep(1)) and read a network-backed file whose data may arrive asynchronously (the reading thread
// parks). Reports mutual-exclusion violations, lost or duplicated records, wrong record contents and counter totals.
#include "win.h"

#define WAIT_TIMEOUT 0x102
#define WAIT_ABANDONED 0x80
#define INFINITE 0xffffffff
#define THREADS 4
#define ITERS 300
#define RECORDS 4096

DLLIMPORT LONG WINAPI InterlockedExchange(LONG*, LONG);
DLLIMPORT BOOL WINAPI EnumWindows(BOOL (WINAPI*)(HWND, LPARAM), LPARAM);

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static HANDLE out;
static void put(const char* s) { DWORD w; WriteFile(out, s, slen(s), &w, 0); }
static void putnum(unsigned v) {
  char buf[12]; int i = 11; buf[i] = 0;
  if (v == 0) buf[--i] = '0';
  while (v) { buf[--i] = '0' + v % 10; v /= 10; }
  put(buf + i);
}
static void report(const char* name, unsigned v) { put(name); put("="); putnum(v); put("\n"); }

static unsigned char cs[24];
static HANDLE mtx, shared, net[3];
static volatile LONG spin;
static volatile int csInside, mxInside, spInside;
static volatile LONG csViol, mxViol, spViol, csCount, mxCount, spCount, timeouts, badData, readFails;
static unsigned char seen[RECORDS];
static volatile LONG recordsRead;

static unsigned rnd(unsigned* s) { *s = *s * 1103515245u + 12345u; return (*s >> 16) & 0x7fff; }

/** something that lets the other threads run inside a locked section: a yield, a sleep, a read that may park */
static void pause(unsigned* s, int lock) {
  unsigned k = rnd(s) % 6;
  if (k == 0) Sleep(0);
  else if (k == 1) Sleep(1);
  else if (k == 2) { // a read of the network file at a position of its own (an explicit seek under the lock: one file
    // object per lock)
    unsigned rec = rnd(s) % 32768; unsigned v = 0; DWORD got = 0;
    SetFilePointer(net[lock], rec * 4, 0, 0);
    if (!ReadFile(net[lock], &v, 4, &got, 0) || got != 4) readFails++;
    else if (v != rec * 2654435761u) badData++;
  }
}

/** the shared file object read without a lock: each record exactly once over all threads */
static void readShared(void) {
  unsigned v = 0; DWORD got = 0;
  if (!ReadFile(shared, &v, 4, &got, 0)) { readFails++; return; }
  if (got != 4) return; // (end of file)
  unsigned rec = v ^ 0x5a5a0000u;
  if (rec >= RECORDS) { badData++; return; }
  if (seen[rec]++) badData++;
  InterlockedIncrement((LONG*)&recordsRead);
}

static DWORD WINAPI worker(void* p) {
  unsigned s = (unsigned)(DWORD)p * 7919u + 17u;
  for (int i = 0; i < ITERS; i++) {
    EnterCriticalSection(cs);
    if (csInside) csViol++;
    csInside = 1; pause(&s, 0); csCount++; csInside = 0;
    LeaveCriticalSection(cs);

    DWORD r = WaitForSingleObject(mtx, rnd(&s) % 3 ? INFINITE : rnd(&s) % 4);
    if (r == 0 || r == WAIT_ABANDONED) {
      if (mxInside) mxViol++;
      mxInside = 1; pause(&s, 1); mxCount++; mxInside = 0;
      ReleaseMutex(mtx);
    } else if (r == WAIT_TIMEOUT) InterlockedIncrement((LONG*)&timeouts);
    else readFails++;

    while (InterlockedExchange((LONG*)&spin, 1)) Sleep(rnd(&s) & 1);
    if (spInside) spViol++;
    spInside = 1; pause(&s, 2); spCount++; spInside = 0;
    InterlockedExchange((LONG*)&spin, 0);

    readShared(); readShared();
    if (rnd(&s) % 4 == 0) { unsigned k = rnd(&s) & 1; Sleep(k); }
  }
  return 0;
}

// an API callback (EnumWindows calls it from its handler) making API calls of its own and letting the other threads run:
// the handler's own arguments (callback, lParam) must still be its own when the callback returns
static volatile LONG enumCalls, enumBadParam;
static BOOL WINAPI enumProc(HWND h, LPARAM l) {
  if (l != 0x1234) enumBadParam++;
  enumCalls++;
  Sleep(0); Sleep(1); SetLastError(0);
  return 1;
}
static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  InitializeCriticalSection(cs);
  mtx = CreateMutexA(0, 0, 0);
  shared = CreateFileA("C:\\Net\\records.bin", 0x80000000, 1, 0, 3, 0, 0);
  for (int i = 0; i < 3; i++) net[i] = CreateFileA("C:\\Net\\random.bin", 0x80000000, 1, 0, 3, 0, 0);
  if (shared == (HANDLE)-1 || net[0] == (HANDLE)-1 || net[2] == (HANDLE)-1) { put("open failed\n"); ExitProcess(99); }
  HANDLE t[THREADS];
  for (int i = 0; i < THREADS; i++) t[i] = CreateThread(0, 0, worker, (void*)(DWORD)i, 0, 0);
  for (int i = 0; i < THREADS; i++) WaitForSingleObject(t[i], INFINITE);
  WNDCLASSA wc = {0};
  wc.lpfnWndProc = wndproc; wc.hInstance = GetModuleHandleA(0); wc.lpszClassName = "syncstress";
  RegisterClassA(&wc);
  for (int i = 0; i < 3; i++) CreateWindowExA(0, "syncstress", "syncstress", 0, 0, 0, 100, 100, 0, 0, wc.hInstance, 0);
  HANDLE e = CreateThread(0, 0, worker, (void*)7, 0, 0); // (runs while the callbacks wait)
  EnumWindows(enumProc, 0x1234);
  WaitForSingleObject(e, INFINITE);
  report("enum_calls", enumCalls); report("enum_bad_param", enumBadParam);
  report("cs_violations", csViol); report("mutex_violations", mxViol); report("spin_violations", spViol);
  report("cs_count", csCount); report("spin_count", spCount);
  report("mutex_plus_timeouts", mxCount + timeouts);
  report("records_read", recordsRead); report("bad_data", badData); report("read_failures", readFails);
  ExitProcess(csViol + mxViol + spViol + badData + readFails + enumBadParam + (enumCalls < 3));
}
