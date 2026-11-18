// Test program: waitable timers (kernel32.js WaitableTimer) and alertable waits (tests/pe.test.js).
//  - a relative one-shot manual-reset timer ends a wait at its due time and stays signaled;
//  - a periodic synchronization timer wakes a waiter once per period, each wait taking the signal;
//  - an absolute due time (a UTC FILETIME from GetSystemTimeAsFileTime);
//  - CancelWaitableTimer before the due time: never signaled;
//  - a completion routine runs as an APC in the setting thread's alertable wait only (SleepEx, WaitForSingleObjectEx,
//    MsgWaitForMultipleObjectsEx with MWMO_ALERTABLE: WAIT_IO_COMPLETION), with the expiry time as a FILETIME, not in a
//    plain Sleep; QueueUserAPC the same way;
//  - WaitForMultipleObjects on two timers: the earlier one;
//  - MsgWaitForMultipleObjectsEx's own argument order (its timeout is the third argument).
#include "win.h"

typedef struct { DWORD lo, hi; } FT;
typedef void (WINAPI *TIMERAPC)(void*, DWORD, DWORD);
DLLIMPORT HANDLE WINAPI CreateWaitableTimerA(void*, BOOL, const char*);
DLLIMPORT BOOL WINAPI SetWaitableTimer(HANDLE, const FT*, LONG, TIMERAPC, void*, BOOL);
DLLIMPORT BOOL WINAPI CancelWaitableTimer(HANDLE);
DLLIMPORT DWORD WINAPI SleepEx(DWORD, BOOL);
DLLIMPORT DWORD WINAPI WaitForSingleObjectEx(HANDLE, DWORD, BOOL);
DLLIMPORT DWORD WINAPI QueueUserAPC(void (WINAPI*)(DWORD), HANDLE, DWORD);
DLLIMPORT void WINAPI GetSystemTimeAsFileTime(FT*);
DLLIMPORT HANDLE WINAPI GetCurrentThread(void);
DLLIMPORT BOOL WINAPI QueryPerformanceCounter(FT*);
DLLIMPORT DWORD WINAPI MsgWaitForMultipleObjectsEx(DWORD, const HANDLE*, DWORD, DWORD, DWORD);
DLLIMPORT UINT WINAPI timeBeginPeriod(UINT);

#define INFINITE 0xffffffff
#define WAIT_TIMEOUT 0x102

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

/** the performance counter (10 MHz) in 0.1 ms units */
static unsigned long long qpc(void) { FT t; QueryPerformanceCounter(&t); return ((unsigned long long)t.hi << 32) | t.lo; }
static unsigned tenths(unsigned long long a, unsigned long long b) { return (unsigned)(b - a) / 1000; } // (32 bits: no CRT division)
/** a relative due time of `ms` milliseconds (100 ns units, negative) */
static FT rel(long ms) { long long v = -(long long)ms * 10000; FT f; f.lo = (DWORD)v; f.hi = (DWORD)(v >> 32); return f; }
static int near(unsigned v, unsigned want, unsigned tol) { return v + tol >= want && v <= want + tol; }

static volatile unsigned apcCalls, apcArg;
static volatile FT apcTime;
static void WINAPI timerApc(void* arg, DWORD lo, DWORD hi) { apcCalls++; apcArg = (unsigned)arg; apcTime.lo = lo; apcTime.hi = hi; }
static volatile unsigned userApcs;
static void WINAPI userApc(DWORD v) { userApcs += v; }

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  timeBeginPeriod(1);
  FT d;

  // 1. relative one-shot, manual reset
  HANDLE m = CreateWaitableTimerA(0, 1, 0);
  report("manual_untouched", WaitForSingleObject(m, 0));
  unsigned long long t0 = qpc();
  d = rel(50); SetWaitableTimer(m, &d, 0, 0, 0, 0);
  report("oneshot", WaitForSingleObject(m, INFINITE));
  report("oneshot_on_time", near(tenths(t0, qpc()), 505, 6)); // (50 ms, at the next 1 ms clock interrupt)
  report("manual_stays", WaitForSingleObject(m, 0));

  // 2. periodic synchronization timer: one wake-up per period, each wait takes the signal
  HANDLE p = CreateWaitableTimerA(0, 0, 0);
  d = rel(10); SetWaitableTimer(p, &d, 20, 0, 0, 0);
  unsigned waits = 0; unsigned long long first = 0;
  for (int i = 0; i < 5; i++) { if (WaitForSingleObject(p, 1000) == 0) waits++; if (i == 0) first = qpc(); }
  report("periodic_waits", waits);
  report("periodic_spacing", near(tenths(first, qpc()), 800, 10)); // (4 periods of 20 ms)
  report("periodic_taken", WaitForSingleObject(p, 0));
  CancelWaitableTimer(p);

  // 3. absolute due time: 30 ms from the system time
  FT now; GetSystemTimeAsFileTime(&now);
  unsigned long long abs = (((unsigned long long)now.hi << 32) | now.lo) + 300000;
  d.lo = (DWORD)abs; d.hi = (DWORD)(abs >> 32);
  t0 = qpc(); SetWaitableTimer(p, &d, 0, 0, 0, 0);
  report("absolute", WaitForSingleObject(p, 1000));
  report("absolute_on_time", near(tenths(t0, qpc()), 305, 6));

  // 4. cancelled before its due time
  d = rel(30); SetWaitableTimer(p, &d, 0, 0, 0, 0); CancelWaitableTimer(p);
  report("cancelled", WaitForSingleObject(p, 100));

  // 5. completion routine: an APC of this thread, in its alertable waits only
  HANDLE a = CreateWaitableTimerA(0, 0, 0);
  d = rel(20); SetWaitableTimer(a, &d, 0, timerApc, (void*)0x1234, 0);
  report("apc_sleepex", SleepEx(INFINITE, 1));
  FT after; GetSystemTimeAsFileTime(&after);
  unsigned long long late = (((unsigned long long)after.hi << 32) | after.lo) - (((unsigned long long)apcTime.hi << 32) | apcTime.lo);
  report("apc_calls", apcCalls); report("apc_arg", apcArg); report("apc_time", late < 20000); // (the expiry's time, within 2 ms)
  report("apc_timer_signaled", WaitForSingleObject(a, 0));
  d = rel(10); SetWaitableTimer(a, &d, 0, timerApc, (void*)7, 0);
  Sleep(30);
  report("apc_not_in_sleep", apcCalls);
  report("apc_queued_at_once", SleepEx(0, 1));
  report("apc_calls_after", apcCalls);
  d = rel(10); SetWaitableTimer(a, &d, 0, timerApc, (void*)8, 0);
  Sleep(20);
  report("apc_waitex_object_first", WaitForSingleObjectEx(m, INFINITE, 1)); // (m is signaled: the object wins, the APC waits)
  report("apc_waitex_pending", apcCalls);
  report("apc_waitex_alertable", WaitForSingleObjectEx(p, INFINITE, 1));
  report("apc_calls_last", apcCalls);
  QueueUserAPC(userApc, GetCurrentThread(), 5);
  report("user_apc", SleepEx(1000, 1)); report("user_apc_ran", userApcs);

  // 6. two timers, the earlier one first
  HANDLE two[2] = { CreateWaitableTimerA(0, 0, 0), CreateWaitableTimerA(0, 0, 0) };
  d = rel(30); SetWaitableTimer(two[0], &d, 0, 0, 0, 0);
  d = rel(10); SetWaitableTimer(two[1], &d, 0, 0, 0, 0);
  report("multi", WaitForMultipleObjects(2, two, 0, 1000));
  report("multi_next", WaitForMultipleObjects(2, two, 0, 1000));

  // 7. MsgWaitForMultipleObjectsEx(n, handles, timeout, wake mask, flags)
  t0 = qpc();
  report("msgwait_timeout", MsgWaitForMultipleObjectsEx(1, &p, 30, 0x4ff, 0));
  report("msgwait_timeout_on_time", near(tenths(t0, qpc()), 305, 6));
  d = rel(10); SetWaitableTimer(a, &d, 0, timerApc, (void*)9, 0);
  report("msgwait_alertable", MsgWaitForMultipleObjectsEx(1, &p, 1000, 0x4ff, 2 /* MWMO_ALERTABLE */));
  report("msgwait_apc_calls", apcCalls);
  CloseHandle(m); CloseHandle(p); CloseHandle(a); CloseHandle(two[0]); CloseHandle(two[1]);
  ExitProcess(0);
}
