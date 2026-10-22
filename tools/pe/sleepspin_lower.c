// Frame limiter beside a lower-priority busy thread (tests/sleep-throttle.test.js): the main thread paces 16 ms frames
// with Sleep(0) + timeGetTime as tools/pe/sleepspin.c does, while a THREAD_PRIORITY_BELOW_NORMAL thread computes
// without ever waiting (a loader, a worker set below normal). Sleep(0) does not hand the processor to the lower thread
// (it only yields to equal or higher priorities); the emulator's Sleep(0) throttle must still recognise the spin, and
// the lower thread then runs during its 1 ms waits. Exit code 0 when the worker made progress during the frames.
#include "win.h"

DLLIMPORT DWORD WINAPI timeGetTime(void);
DLLIMPORT UINT WINAPI timeBeginPeriod(UINT);
DLLIMPORT UINT WINAPI timeEndPeriod(UINT);
DLLIMPORT DWORD WINAPI GetVersion(void);
DLLIMPORT BOOL WINAPI SetThreadPriority(HANDLE, int);

#define FRAMES 100
#define PERIOD 16

static volatile LONG stop;
static volatile DWORD work;

static DWORD WINAPI worker(void* p) {
  (void)p;
  while (!stop) { for (int i = 0; i < 1000; i++) work += (DWORD)i; } // (busy: no API call, no wait)
  return 0;
}

void __stdcall start(void) {
  volatile DWORD sink = 0;
  timeBeginPeriod(1);
  HANDLE th = CreateThread(0, 0, worker, 0, 0, 0);
  SetThreadPriority(th, -1); // THREAD_PRIORITY_BELOW_NORMAL
  GetCommandLineA(); // mark: start
  DWORD next = timeGetTime();
  for (int f = 0; f < FRAMES; f++) {
    for (int i = 0; i < 200000; i++) sink += i ^ f; // the frame's work (well under the period)
    GetVersion(); // mark: the frame's work is done
    next += PERIOD;
    while ((LONG)(timeGetTime() - next) < 0) Sleep(0);
  }
  GetCommandLineA(); // mark: end
  DWORD done = work;
  stop = 1;
  WaitForSingleObject(th, 0xffffffff);
  timeEndPeriod(1);
  ExitProcess(done > 0 ? 0 : 1);
}
