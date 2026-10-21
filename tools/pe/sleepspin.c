// Frame-limiter benchmark (tools/sleepspin-bench.mjs): the pacing loop many games run between frames — a little work,
// then Sleep(0) + timeGetTime until the next 16 ms boundary — under timeBeginPeriod(1), with a second thread polling
// with Sleep(1) as background threads do. The harness times the frames (GetVersion marks the end of a frame's work) and
// reads the emulator's Sleep counters and the process CPU time: the emulator's cost of the spin, which is pacing.
#include "win.h"

DLLIMPORT DWORD WINAPI timeGetTime(void);
DLLIMPORT UINT WINAPI timeBeginPeriod(UINT);
DLLIMPORT UINT WINAPI timeEndPeriod(UINT);
DLLIMPORT DWORD WINAPI GetVersion(void);

#define FRAMES 150
#define PERIOD 16

static volatile LONG stop;
static volatile DWORD polls;

static DWORD WINAPI poller(void* p) {
  (void)p;
  while (!stop) { Sleep(1); polls++; }
  return 0;
}

void __stdcall start(void) {
  volatile DWORD sink = 0;
  timeBeginPeriod(1);
  HANDLE th = CreateThread(0, 0, poller, 0, 0, 0);
  GetCommandLineA(); // mark: start
  DWORD next = timeGetTime();
  for (int f = 0; f < FRAMES; f++) {
    for (int i = 0; i < 200000; i++) sink += i ^ f; // the frame's work (well under the period)
    GetVersion(); // mark: the frame's work is done
    next += PERIOD;
    while ((LONG)(timeGetTime() - next) < 0) Sleep(0);
  }
  GetCommandLineA(); // mark: end
  stop = 1;
  WaitForSingleObject(th, 0xffffffff);
  timeEndPeriod(1);
  ExitProcess(polls > 0 ? 0 : 1);
}
