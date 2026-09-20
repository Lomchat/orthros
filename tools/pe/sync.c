// Test program: wait satisfaction semantics of the green-thread scheduler.
//  - a released mutex / left critical section goes to the parked waiter even when the releaser re-acquires
//    it immediately in a tight loop (Windows hands the object over at release time: no starvation),
//  - and never to two threads (no double ownership when the waiter runs later),
//  - an auto-reset event / a semaphore unit wakes exactly one waiter,
//  - the "wait until another thread holds the mutex" handshake: WaitForSingleObject(m, 1) times out while
//    the holder sleeps,
//  - a mutex owned by an exiting thread is reported abandoned to the next waiter.
#include "win.h"

#define WAIT_TIMEOUT 0x102
#define WAIT_ABANDONED 0x80
#define INFINITE 0xffffffff

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

// ---- 1. mutex hand-off under a re-acquiring releaser, mutual exclusion
static HANDLE mtx;
static volatile int inside, violations, workerDone;
static DWORD WINAPI mutexWorker(void* p) {
  for (int i = 0; i < 200; i++) {
    WaitForSingleObject(mtx, INFINITE);
    if (inside) violations++;
    inside = 1; Sleep(0); inside = 0;
    ReleaseMutex(mtx);
  }
  workerDone = 1;
  return 0;
}

// ---- 2. critical section hand-off
static unsigned char cs[24];
static volatile int csInside, csViolations, csDone;
static DWORD WINAPI csWorker(void* p) {
  for (int i = 0; i < 200; i++) {
    EnterCriticalSection(cs);
    if (csInside) csViolations++;
    csInside = 1; Sleep(0); csInside = 0;
    LeaveCriticalSection(cs);
  }
  csDone = 1;
  return 0;
}

// ---- 3/4. one wake-up per auto-reset event signal / semaphore unit
static HANDLE ev, sem;
static LONG evWakes, semWakes;
static DWORD WINAPI evWaiter(void* p) { WaitForSingleObject(ev, INFINITE); InterlockedIncrement(&evWakes); return 0; }
static DWORD WINAPI semWaiter(void* p) { WaitForSingleObject(sem, INFINITE); InterlockedIncrement(&semWakes); return 0; }

// ---- 5. handshake: A signals "worker alive" by being held, B (owned by main) signals "stop" when released
static HANDLE mA, mB;
static DWORD WINAPI aliveWorker(void* p) {
  WaitForSingleObject(mA, INFINITE);
  for (;;) { Sleep(5); if (WaitForSingleObject(mB, 0) != WAIT_TIMEOUT) break; }
  ReleaseMutex(mB);
  ReleaseMutex(mA);
  return 0;
}

// ---- 6. abandonment
static HANDLE mX;
static DWORD WINAPI abandoner(void* p) { WaitForSingleObject(mX, INFINITE); return 0; }

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  int fails = 0;

  mtx = CreateMutexA(0, 0, 0);
  HANDLE t = CreateThread(0, 0, mutexWorker, 0, 0, 0);
  unsigned spins = 0, releaseFailures = 0;
  while (!workerDone && spins < 5000000) { spins++; WaitForSingleObject(mtx, INFINITE); if (!ReleaseMutex(mtx)) releaseFailures++; }
  DWORD r = WaitForSingleObject(t, 5000);
  report("mutex_handoff", workerDone); report("mutex_join", r); report("mutex_violations", violations); report("mutex_release_failures", releaseFailures);
  if (!workerDone || r != 0 || violations || releaseFailures) fails++;

  InitializeCriticalSection(cs);
  t = CreateThread(0, 0, csWorker, 0, 0, 0);
  spins = 0;
  while (!csDone && spins < 5000000) { spins++; EnterCriticalSection(cs); LeaveCriticalSection(cs); }
  r = WaitForSingleObject(t, 5000);
  report("cs_handoff", csDone); report("cs_join", r); report("cs_violations", csViolations);
  if (!csDone || r != 0 || csViolations) fails++;

  ev = CreateEventA(0, 0, 0, 0);
  HANDLE e1 = CreateThread(0, 0, evWaiter, 0, 0, 0), e2 = CreateThread(0, 0, evWaiter, 0, 0, 0);
  Sleep(10);
  SetEvent(ev); Sleep(20); LONG w1 = evWakes;
  SetEvent(ev); Sleep(20); LONG w2 = evWakes;
  WaitForSingleObject(e1, 5000); WaitForSingleObject(e2, 5000);
  report("event_first", w1); report("event_second", w2);
  if (w1 != 1 || w2 != 2) fails++;

  sem = CreateSemaphoreA(0, 0, 10, 0);
  HANDLE s1 = CreateThread(0, 0, semWaiter, 0, 0, 0), s2 = CreateThread(0, 0, semWaiter, 0, 0, 0);
  Sleep(10);
  ReleaseSemaphore(sem, 1, 0); Sleep(20); LONG sw1 = semWakes;
  ReleaseSemaphore(sem, 1, 0); Sleep(20); LONG sw2 = semWakes;
  WaitForSingleObject(s1, 5000); WaitForSingleObject(s2, 5000);
  report("sem_first", sw1); report("sem_second", sw2);
  if (sw1 != 1 || sw2 != 2) fails++;

  mA = CreateMutexA(0, 0, 0);
  mB = CreateMutexA(0, 1, 0);
  t = CreateThread(0, 0, aliveWorker, 0, 0, 0);
  unsigned iters = 0;
  for (;;) {
    r = WaitForSingleObject(mA, 1);
    iters++;
    if (r == 0) { ReleaseMutex(mA); if (iters > 200000) break; continue; }
    if (r != WAIT_TIMEOUT) continue;
    break;
  }
  report("handshake", r == WAIT_TIMEOUT); report("handshake_bounded", iters <= 200000);
  ReleaseMutex(mB);
  DWORD j = WaitForSingleObject(t, 5000);
  DWORD a = WaitForSingleObject(mA, 0);
  report("handshake_join", j); report("handshake_A_free", a);
  if (r != WAIT_TIMEOUT || j != 0 || a != 0) fails++;

  mX = CreateMutexA(0, 0, 0);
  t = CreateThread(0, 0, abandoner, 0, 0, 0);
  WaitForSingleObject(t, 5000);
  DWORD ab = WaitForSingleObject(mX, 1000);
  report("abandoned", ab);
  if (ab != WAIT_ABANDONED) fails++;

  ExitProcess(fails);
}
