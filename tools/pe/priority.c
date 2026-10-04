// Test program: thread priorities. A THREAD_PRIORITY_TIME_CRITICAL thread (an audio mixer's) wakes up and does work
// spanning several time slices while a normal-priority thread is ready (it spins): as on Windows, the normal thread
// does not run before the high-priority work is done — it never observes that work half done. Then a normal thread
// that waits for a lower-priority one with Sleep(0) still gets it to run (priorities do not starve it forever).
#include "win.h"

#define INFINITE 0xffffffff
#define THREAD_PRIORITY_TIME_CRITICAL 15
#define THREAD_PRIORITY_IDLE (-15)
DLLIMPORT BOOL WINAPI SetThreadPriority(HANDLE, int);
DLLIMPORT DWORD WINAPI ResumeThread(HANDLE);
DLLIMPORT int WINAPI GetThreadPriority(HANDLE);

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

static volatile int inWork, stop, spins, seenMidWork, workDone, idleRan;
static volatile unsigned sink;

static DWORD WINAPI mixer(void* p) {
  Sleep(10); // (the normal thread spins meanwhile)
  inWork = 1;
  for (unsigned i = 0; i < 60000; i++) sink += i * 7; // (several time slices of work)
  inWork = 0;
  workDone = 1;
  return 0;
}
static DWORD WINAPI spinner(void* p) {
  while (!stop) { spins++; if (inWork) seenMidWork++; }
  return 0;
}
static DWORD WINAPI idler(void* p) { idleRan = 1; return 0; }

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  HANDLE s = CreateThread(0, 0, spinner, 0, 0, 0);
  HANDLE m = CreateThread(0, 0, mixer, 0, 0, 0);
  SetThreadPriority(m, THREAD_PRIORITY_TIME_CRITICAL);
  WaitForSingleObject(m, INFINITE);
  stop = 1;
  WaitForSingleObject(s, INFINITE);
  report("work_done", workDone); report("spinner_ran", spins > 0); report("seen_mid_work", seenMidWork);
  // a lower-priority thread the main thread waits for by polling
  HANDLE i = CreateThread(0, 0, idler, 0, 4 /* CREATE_SUSPENDED */, 0);
  SetThreadPriority(i, THREAD_PRIORITY_IDLE);
  ResumeThread(i);
  unsigned polls = 0;
  while (!idleRan && polls < 10000000) { polls++; Sleep(0); }
  report("idle_ran", idleRan);
  // values outside the priority levels are rejected (THREAD_MODE_BACKGROUND_BEGIN is accepted for the calling thread
  // without changing its level: stored, it would have outranked every thread)
  HANDLE self = (HANDLE)-2;
  int bad = SetThreadPriority(self, 99) || SetThreadPriority(self, -16) || !SetThreadPriority(self, 0x10000)
    || GetThreadPriority(self) != 0 || !SetThreadPriority(self, 0x20000) || !SetThreadPriority(self, 2) || GetThreadPriority(self) != 2;
  report("bad_levels_rejected", !bad);
  ExitProcess(seenMidWork || !workDone || !idleRan || bad ? 1 : 0);
}
