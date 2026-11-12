// A loading loop that yields between units of work (tests/sleep-throttle.test.js): each unit runs ~1 500 guest
// instructions, then Sleep(0) — BFME 1.08's map load does this ~9 000 times a second. Not a spin: the Sleep(0) throttle
// must leave it alone (before 2026-11-12 every call slept 1 ms once 32 had come within 50 µs of each other).
#include "win.h"

#define UNITS 3000

void __stdcall start(void) {
  volatile DWORD sink = 0;
  GetCommandLineA(); // mark: start
  for (int u = 0; u < UNITS; u++) {
    for (int i = 0; i < 300; i++) sink += i ^ u; // the unit's work
    Sleep(0);
  }
  ExitProcess(0);
}
