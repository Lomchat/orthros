// Frame limiter without catch-up (tests/host-wait.test.js): per frame a little work, then Sleep(0) + timeGetTime until
// PERIOD ms after the previous frame's start — the next period counted from when the loop ended, as BFME's main loop
// does — beside a thread looping on Sleep(1). On a coarse host timer every host wake-up of the throttled Sleep(0)
// oversleeps, and the last one's overshoot lengthens the frame (core/host-wait.js). The harness times the frames
// (GetVersion marks a frame's start).
#include "win.h"

DLLIMPORT DWORD WINAPI timeGetTime(void);
DLLIMPORT UINT WINAPI timeBeginPeriod(UINT);
DLLIMPORT UINT WINAPI timeEndPeriod(UINT);
DLLIMPORT DWORD WINAPI GetVersion(void);

#define FRAMES 60
#define PERIOD 33

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
  DWORD last = timeGetTime();
  for (int f = 0; f < FRAMES; f++) {
    GetVersion(); // mark: a frame starts
    for (int i = 0; i < 300000; i++) sink += i ^ f; // the frame's work (well under the period)
    for (int i = 0; i < 4; i++) sink += (DWORD)GetCommandLineA(); // (and its API calls: a game's frame renders)
    DWORD now;
    do { Sleep(0); now = timeGetTime(); } while (now - last < PERIOD);
    last = now;
  }
  stop = 1;
  WaitForSingleObject(th, 0xffffffff);
  timeEndPeriod(1);
  ExitProcess(polls > 0 ? 0 : 1);
}
