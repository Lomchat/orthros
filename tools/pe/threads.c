// Test program: threads, critical sections, events, waits (exercises the green-thread scheduler).
#include "win.h"

static int counter = 0;
static unsigned char cs[24];
static HANDLE evDone;
static LONG finished = 0;

static DWORD WINAPI worker(void* param) {
  int id = (int)param;
  for (int i = 0; i < 1000; i++) {
    EnterCriticalSection(cs);
    counter++;
    LeaveCriticalSection(cs);
    if ((i & 63) == 0) Sleep(0);
  }
  if (InterlockedIncrement(&finished) == 2) SetEvent(evDone);
  return 100 + id;
}

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
  InitializeCriticalSection(cs);
  evDone = CreateEventA(0, 1, 0, 0);
  DWORD tid1, tid2;
  HANDLE t1 = CreateThread(0, 0, worker, (void*)1, 0, &tid1);
  HANDLE t2 = CreateThread(0, 0, worker, (void*)2, 0, &tid2);
  DWORD start = GetTickCount();
  Sleep(30);
  DWORD elapsed = GetTickCount() - start;
  DWORD r = WaitForSingleObject(evDone, 5000);
  WaitForSingleObject(t1, 5000);
  WaitForSingleObject(t2, 5000);
  put(out, "counter="); putnum(out, counter); put(out, "\n");
  put(out, "wait="); putnum(out, r); put(out, "\n");
  put(out, "slept ok="); putnum(out, elapsed >= 30 ? 1 : 0); put(out, "\n");
  put(out, "tids differ="); putnum(out, tid1 != tid2 && tid1 != GetCurrentThreadId() ? 1 : 0); put(out, "\n");
  DeleteCriticalSection(cs);
  ExitProcess(counter == 2000 ? 0 : 1);
}
