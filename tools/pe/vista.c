// Test program: kernel32's Vista+ functions the newer CRTs and games import (docs/compat-scan.md "kernel32 Vista+"):
// slim reader/writer locks, condition variables (critical section and SRW), one-time initialization, interlocked
// singly linked lists, Encode/DecodePointer, vectored exception and continue handlers, the *Ex creation functions,
// imports through API set names (api-ms-win-*), and an unimplemented import without a known signature called from a
// thread (the thread stops: STATUS_ENTRYPOINT_NOT_FOUND). Prints name=value lines (tests/vista.test.js).
#include "win.h"

#define INFINITE 0xffffffff
typedef struct { DWORD code, flags; void* next; void* addr; DWORD n; DWORD info[15]; } EXCEPTION_RECORD;
typedef struct { EXCEPTION_RECORD* rec; BYTE* ctx; } EXCEPTION_POINTERS;
typedef BOOL (WINAPI *INITFN)(void*, void*, void**);
typedef LONG (WINAPI *VEHFN)(EXCEPTION_POINTERS*);

DLLIMPORT BOOL WINAPI GetExitCodeThread(HANDLE, DWORD*);
DLLIMPORT BOOL WINAPI TryEnterCriticalSection(void*);
DLLIMPORT void WINAPI RaiseException(DWORD, DWORD, DWORD, const DWORD*);
DLLIMPORT void WINAPI InitializeSRWLock(void*);
DLLIMPORT void WINAPI AcquireSRWLockExclusive(void*);
DLLIMPORT void WINAPI AcquireSRWLockShared(void*);
DLLIMPORT void WINAPI ReleaseSRWLockExclusive(void*);
DLLIMPORT void WINAPI ReleaseSRWLockShared(void*);
DLLIMPORT BYTE WINAPI TryAcquireSRWLockExclusive(void*);
DLLIMPORT BYTE WINAPI TryAcquireSRWLockShared(void*);
DLLIMPORT void WINAPI InitializeConditionVariable(void*);
DLLIMPORT BOOL WINAPI SleepConditionVariableCS(void*, void*, DWORD);
DLLIMPORT BOOL WINAPI SleepConditionVariableSRW(void*, void*, DWORD, DWORD);
DLLIMPORT void WINAPI WakeConditionVariable(void*);
DLLIMPORT void WINAPI WakeAllConditionVariable(void*);
DLLIMPORT BOOL WINAPI InitOnceExecuteOnce(void*, INITFN, void*, void**);
DLLIMPORT BOOL WINAPI InitOnceBeginInitialize(void*, DWORD, BOOL*, void**);
DLLIMPORT BOOL WINAPI InitOnceComplete(void*, DWORD, void*);
DLLIMPORT void WINAPI InitializeSListHead(void*);
DLLIMPORT void* WINAPI InterlockedPushEntrySList(void*, void*);
DLLIMPORT void* WINAPI InterlockedPopEntrySList(void*);
DLLIMPORT void* WINAPI InterlockedFlushSList(void*);
DLLIMPORT WORD WINAPI QueryDepthSList(void*);
DLLIMPORT void* WINAPI EncodePointer(void*);
DLLIMPORT void* WINAPI DecodePointer(void*);
DLLIMPORT void* WINAPI AddVectoredExceptionHandler(DWORD, VEHFN);
DLLIMPORT DWORD WINAPI RemoveVectoredExceptionHandler(void*);
DLLIMPORT void* WINAPI AddVectoredContinueHandler(DWORD, VEHFN);
DLLIMPORT HANDLE WINAPI CreateEventExA(void*, const char*, DWORD, DWORD);
DLLIMPORT HANDLE WINAPI CreateMutexExA(void*, const char*, DWORD, DWORD);
DLLIMPORT BOOL WINAPI InitializeCriticalSectionEx(void*, DWORD, DWORD);
DLLIMPORT void WINAPI OrthrosNoSuchFunction(void);
// through API set names (tools/pe/api-ms-win-*.def)
DLLIMPORT unsigned long long WINAPI GetTickCount64(void);
DLLIMPORT BOOL WINAPI OpenProcessToken(HANDLE, DWORD, HANDLE*);

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static HANDLE out;
static void put(const char* s) { DWORD w; WriteFile(out, s, slen(s), &w, 0); }
static void report(const char* name, unsigned v) {
  char buf[12]; int i = 11; buf[i] = 0;
  if (v == 0) buf[--i] = '0';
  while (v) { buf[--i] = '0' + v % 10; v /= 10; }
  put(name); put("="); put(buf + i); put("\n");
}
static HANDLE spawn(DWORD (WINAPI *fn)(void*), void* p) { DWORD id; return CreateThread(0, 0, fn, p, 0, &id); }
static void join(HANDLE h) { WaitForSingleObject(h, INFINITE); CloseHandle(h); }

// ---- SRW locks
static void* srw;
static volatile int inside, violations, readersNow, readersMax;
static DWORD WINAPI srwWriter(void* p) {
  for (int i = 0; i < 100; i++) {
    AcquireSRWLockExclusive(&srw);
    if (inside || readersNow) violations++;
    inside = 1; Sleep(0); inside = 0;
    ReleaseSRWLockExclusive(&srw);
  }
  return 0;
}
static DWORD WINAPI srwReader(void* p) {
  for (int i = 0; i < 20; i++) {
    AcquireSRWLockShared(&srw);
    if (inside) violations++;
    int n = InterlockedIncrement((LONG*)&readersNow);
    if (n > readersMax) readersMax = n;
    Sleep(1);
    InterlockedDecrement((LONG*)&readersNow);
    ReleaseSRWLockShared(&srw);
  }
  return 0;
}
static void* srw2;
static DWORD WINAPI wantExclusive(void* p) { AcquireSRWLockExclusive(&srw2); ReleaseSRWLockExclusive(&srw2); return 0; }

// ---- condition variables
static unsigned char cs[24];
static void* cv; static void* cv2; static void* cv3;
static volatile int queued, consumed;
static DWORD WINAPI consumer(void* p) {
  for (;;) {
    EnterCriticalSection(cs);
    while (queued == 0 && consumed < 50) SleepConditionVariableCS(&cv, cs, INFINITE);
    if (consumed >= 50) { LeaveCriticalSection(cs); return 0; }
    queued--; consumed++;
    LeaveCriticalSection(cs);
  }
}
static DWORD WINAPI tryEnter(void* p) { BOOL r = TryEnterCriticalSection(cs); if (r) LeaveCriticalSection(cs); return r; }
static void* srw3; static volatile int go, woken;
static DWORD WINAPI srwWaiter(void* p) {
  AcquireSRWLockExclusive(&srw3);
  while (!go) SleepConditionVariableSRW(&cv3, &srw3, INFINITE, 0);
  woken++;
  ReleaseSRWLockExclusive(&srw3);
  return 0;
}
static volatile int wakes;
static void* srw4;
static DWORD WINAPI srwWaiterOnce(void* p) {
  AcquireSRWLockShared(&srw4);
  SleepConditionVariableSRW(&cv2, &srw4, INFINITE, 1 /* CONDITION_VARIABLE_LOCKMODE_SHARED */);
  wakes++;
  ReleaseSRWLockShared(&srw4);
  return 0;
}

// ---- one-time initialization
static void* once; static void* once2; static void* once3;
static volatile int initCalls, failCalls;
static void* gotCtx[3];
static BOOL WINAPI initFn(void* io, void* param, void** ctx) { initCalls++; Sleep(10); *ctx = (void*)0x12340; return 1; }
static BOOL WINAPI failingInit(void* io, void* param, void** ctx) { return ++failCalls >= 2; }
static DWORD WINAPI onceRunner(void* p) { void* c = 0; InitOnceExecuteOnce(&once, initFn, 0, &c); gotCtx[(int)p] = c; return 0; }

// ---- vectored handlers
static char order[8]; static int orderN; static DWORD seenCode; static int continued;
static LONG WINAPI vehA(EXCEPTION_POINTERS* e) { order[orderN++] = 'A'; seenCode = e->rec->code; return -1; }
static LONG WINAPI vehB(EXCEPTION_POINTERS* e) { order[orderN++] = 'B'; return 0; }
static LONG WINAPI vch(EXCEPTION_POINTERS* e) { continued++; return 0; }

static DWORD WINAPI stopper(void* p) { OrthrosNoSuchFunction(); return 7; }
static DWORD WINAPI waitZero(void* h) { return WaitForSingleObject(h, 0); }

void start(void) {
  out = GetStdHandle((DWORD)-11);
  InitializeCriticalSection(cs);

  // SRW: two writers and three readers
  HANDLE t[5];
  t[0] = spawn(srwWriter, 0); t[1] = spawn(srwWriter, 0);
  for (int i = 0; i < 3; i++) t[2 + i] = spawn(srwReader, 0);
  for (int i = 0; i < 5; i++) join(t[i]);
  report("srw_violations", violations);
  report("srw_readers_together", readersMax >= 2);
  report("srw_free", (DWORD)srw);
  // layout and Try* while held shared twice
  AcquireSRWLockShared(&srw); AcquireSRWLockShared(&srw);
  report("srw_shared2_word", (DWORD)srw);
  report("srw_try_exclusive_while_shared", TryAcquireSRWLockExclusive(&srw));
  ReleaseSRWLockShared(&srw); ReleaseSRWLockShared(&srw);
  report("srw_try_exclusive", TryAcquireSRWLockExclusive(&srw));
  report("srw_exclusive_word", (DWORD)srw);
  report("srw_try_shared_while_exclusive", TryAcquireSRWLockShared(&srw));
  ReleaseSRWLockExclusive(&srw);
  // a waiting writer keeps new shared requests out
  AcquireSRWLockShared(&srw2);
  HANDLE w = spawn(wantExclusive, 0);
  Sleep(20);
  report("srw_try_shared_writer_waiting", TryAcquireSRWLockShared(&srw2));
  ReleaseSRWLockShared(&srw2);
  join(w);
  report("srw2_free", (DWORD)srw2);

  // condition variable with a critical section: producer / consumer
  InitializeConditionVariable(&cv);
  HANDLE c = spawn(consumer, 0);
  for (int i = 0; i < 50; i++) {
    EnterCriticalSection(cs); queued++; LeaveCriticalSection(cs);
    WakeConditionVariable(&cv);
    if (i % 7 == 0) Sleep(1);
  }
  for (int i = 0; i < 200 && consumed < 50; i++) Sleep(1);
  WakeAllConditionVariable(&cv);
  join(c);
  report("cv_consumed", consumed);
  // timeout: FALSE, ERROR_TIMEOUT, the critical section held again
  EnterCriticalSection(cs);
  DWORD t0 = GetTickCount();
  BOOL r = SleepConditionVariableCS(&cv2, cs, 30);
  DWORD err = GetLastError();
  report("cv_timeout_result", r);
  report("cv_timeout_error", err);
  report("cv_timeout_waited", GetTickCount() - t0 >= 25);
  HANDLE te = spawn(tryEnter, 0); DWORD code = 9; WaitForSingleObject(te, INFINITE); GetExitCodeThread(te, &code); CloseHandle(te);
  report("cv_timeout_cs_held", code == 0);
  LeaveCriticalSection(cs);
  // SRW condition variable (shared mode): Wake wakes one, WakeAll the rest
  HANDLE s1 = spawn(srwWaiterOnce, 0), s2 = spawn(srwWaiterOnce, 0);
  Sleep(20);
  WakeConditionVariable(&cv2); Sleep(20);
  report("cv_wake_one", wakes);
  WakeAllConditionVariable(&cv2);
  join(s1); join(s2);
  report("cv_wake_all", wakes);
  report("srw4_free", (DWORD)srw4);
  // exclusive mode, three waiters
  HANDLE x[3];
  for (int i = 0; i < 3; i++) x[i] = spawn(srwWaiter, 0);
  Sleep(20);
  AcquireSRWLockExclusive(&srw3); go = 1; ReleaseSRWLockExclusive(&srw3);
  WakeAllConditionVariable(&cv3);
  for (int i = 0; i < 3; i++) join(x[i]);
  report("cv_srw_woken", woken);

  // one-time initialization: three threads, one call (it sleeps inside), the same context for all
  HANDLE o[3];
  for (int i = 0; i < 3; i++) o[i] = spawn(onceRunner, (void*)i);
  for (int i = 0; i < 3; i++) join(o[i]);
  report("once_calls", initCalls);
  report("once_ctx_same", gotCtx[0] == (void*)0x12340 && gotCtx[1] == gotCtx[0] && gotCtx[2] == gotCtx[0]);
  report("once_word", (DWORD)once);
  void* ctx = 0;
  report("once_fail_first", InitOnceExecuteOnce(&once2, failingInit, 0, &ctx));
  report("once_fail_word", (DWORD)once2);
  report("once_fail_retry", InitOnceExecuteOnce(&once2, failingInit, 0, 0));
  BOOL pending = 7;
  report("once_check_only", InitOnceBeginInitialize(&once3, 1, &pending, &ctx));
  report("once_begin", InitOnceBeginInitialize(&once3, 0, &pending, &ctx));
  report("once_begin_pending", pending);
  report("once_complete", InitOnceComplete(&once3, 0, (void*)0x400));
  pending = 7; ctx = 0;
  report("once_begin_done", InitOnceBeginInitialize(&once3, 0, &pending, &ctx));
  report("once_done_pending", pending);
  report("once_done_ctx", (DWORD)ctx);

  // interlocked singly linked list
  static __declspec(align(8)) DWORD head[2];
  static __declspec(align(8)) void* entries[3][2];
  InitializeSListHead(head);
  for (int i = 0; i < 3; i++) InterlockedPushEntrySList(head, entries[i]);
  report("slist_depth", QueryDepthSList(head));
  report("slist_pop_lifo", InterlockedPopEntrySList(head) == entries[2]);
  report("slist_depth_after_pop", QueryDepthSList(head));
  void* chain = InterlockedFlushSList(head);
  report("slist_flush_chain", chain == entries[1] && entries[1][0] == entries[0] && entries[0][0] == 0);
  report("slist_depth_flushed", QueryDepthSList(head));
  report("slist_pop_empty", (DWORD)InterlockedPopEntrySList(head));

  // pointer encoding
  void* p = (void*)0x00401234;
  report("encode_roundtrip", DecodePointer(EncodePointer(p)) == p);
  report("encode_changes", EncodePointer(p) != p);
  report("encode_null_roundtrip", DecodePointer(EncodePointer(0)) == 0);

  // vectored handlers: B (added first in the list) then A, which continues; the continue handler runs too
  void* ha = AddVectoredExceptionHandler(0, vehA);
  void* hb = AddVectoredExceptionHandler(1, vehB);
  AddVectoredContinueHandler(0, vch);
  RaiseException(0xe0001234, 0, 0, 0);
  order[orderN] = 0;
  report("veh_order_BA", order[0] == 'B' && order[1] == 'A' && orderN == 2);
  report("veh_code_ok", seenCode == 0xe0001234);
  report("veh_continue_handlers", continued);
  report("veh_remove", RemoveVectoredExceptionHandler(ha) + RemoveVectoredExceptionHandler(hb));
  report("veh_remove_again", RemoveVectoredExceptionHandler(ha));

  // the *Ex creation functions
  HANDLE ev = CreateEventExA(0, 0, 3 /* manual reset | initially set */, 0x1f0003);
  report("event_ex_manual", WaitForSingleObject(ev, 0) == 0 && WaitForSingleObject(ev, 0) == 0);
  HANDLE mx = CreateMutexExA(0, 0, 1 /* initial owner */, 0x1f0001);
  HANDLE mw = spawn(waitZero, mx); code = 9; WaitForSingleObject(mw, INFINITE); GetExitCodeThread(mw, &code); CloseHandle(mw);
  report("mutex_ex_owned", code);
  unsigned char cs2[24];
  report("critsec_ex", InitializeCriticalSectionEx(cs2, 4000, 0));

  // API sets
  report("apiset_tick64", GetTickCount64() > 0);
  HANDLE tok = 0;
  report("apiset_family", OpenProcessToken((HANDLE)-1, 8, &tok) && tok != 0);
  HANDLE k = LoadLibraryA("api-ms-win-core-synch-l1-2-0.dll");
  report("apiset_loadlibrary", k != 0); // (its host: kernelbase.dll on Windows 7+, kernel32.dll here)
  report("apiset_getprocaddress", GetProcAddress(k, "InitializeCriticalSectionEx") != 0);
  report("apiset_getmodulehandle", GetModuleHandleA("api-ms-win-core-synch-l1-2-0.dll") == k);

  // an unimplemented import without a signature: its thread stops, the program goes on
  HANDLE st = spawn(stopper, 0); code = 0; WaitForSingleObject(st, INFINITE); GetExitCodeThread(st, &code); CloseHandle(st);
  report("unknown_import_thread_exit", code);
  ExitProcess(0);
}
