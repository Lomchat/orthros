// Test program: child processes (docs/processes.md), the launcher/game handshake of a game started by its launcher.
// The parent creates a named mutex, an inheritable paging-file mapping it fills, a named mapping it keeps mapped and
// two named events, then starts itself with the argument "child" (handles inherited). The child finds the mutex
// already there, opens and sets the first event, receives a thread message from its parent carrying the inherited
// mapping's handle, reads the parent's bytes through it and answers in it, writes into the named mapping while the
// parent's view of it stays open, sets the second event and exits with code 42. The parent checks every step:
// the process handle's wait and exit code, what the child wrote. Prints name=value lines; exit code = failures.
#include "win.h"

#define INFINITE 0xffffffff
#define STILL_ACTIVE 0x103
#define MAGIC 0x1234abcd

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

static int isChild(void) {
  const char* c = GetCommandLineA(); int n = slen(c);
  return n >= 5 && c[n - 5] == 'c' && c[n - 4] == 'h' && c[n - 3] == 'i' && c[n - 2] == 'l' && c[n - 1] == 'd';
}

static void child(void) {
  int fails = 0;
  HANDLE m = CreateMutexA(0, 0, "orthros-mp-mutex");
  unsigned exists = GetLastError() == 183; // ERROR_ALREADY_EXISTS: the parent's
  report("child.mutexExists", exists); if (!m || !exists) fails++;
  HANDLE ready = OpenEventA(2, 0, "orthros-mp-ready");
  report("child.openEvent", ready != 0); if (!ready) fails++;
  SetEvent(ready);
  MSG msg; int got = 0;
  for (int i = 0; i < 5000 && !got; i++) { if (PeekMessageA(&msg, 0, 0xbeef, 0xbeef, 1)) got = 1; else Sleep(1); }
  report("child.message", got); if (!got) ExitProcess(1);
  volatile unsigned* v = (volatile unsigned*)MapViewOfFile((HANDLE)msg.lParam, 0xf001f, 0, 0, 0);
  unsigned seen = v ? v[0] : 0;
  report("child.inheritedView", seen == MAGIC); if (seen != MAGIC) fails++;
  if (v) { v[1] = seen + 1; UnmapViewOfFile((void*)v); }
  HANDLE nm = OpenFileMappingA(0xf001f, 0, "orthros-mp-shared");
  volatile unsigned* s = nm ? (volatile unsigned*)MapViewOfFile(nm, 0xf001f, 0, 0, 0) : 0;
  report("child.namedView", s != 0); if (!s) fails++;
  if (s) s[0] = 0xc0ffee;
  SetEvent(OpenEventA(2, 0, "orthros-mp-written"));
  Sleep(20); // (the parent reads the named mapping while this view is still open)
  ExitProcess(fails ? 1 : 42);
}

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  if (isChild()) child();
  int fails = 0;
  HANDLE mtx = CreateMutexA(0, 0, "orthros-mp-mutex");
  SECURITY_ATTRIBUTES sa = { sizeof sa, 0, 1 };
  HANDLE map = CreateFileMappingA((HANDLE)-1, &sa, 4, 0, 4096, 0);
  volatile unsigned* v = (volatile unsigned*)MapViewOfFile(map, 0xf001f, 0, 0, 0);
  v[0] = MAGIC; v[1] = 0;
  UnmapViewOfFile((void*)v);
  HANDLE named = CreateFileMappingA((HANDLE)-1, 0, 4, 0, 4096, "orthros-mp-shared");
  volatile unsigned* s = (volatile unsigned*)MapViewOfFile(named, 0xf001f, 0, 0, 0);
  HANDLE ready = CreateEventA(0, 0, 0, "orthros-mp-ready"), written = CreateEventA(0, 0, 0, "orthros-mp-written");
  STARTUPINFOA si = { sizeof si };
  PROCESS_INFORMATION pi = { 0 };
  char cmd[] = "multiproc.exe child";
  BOOL ok = CreateProcessA(0, cmd, 0, 0, 1, 0, 0, 0, &si, &pi);
  report("created", ok && pi.hProcess && pi.dwThreadId); if (!ok) ExitProcess(100);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  report("stillActive", code == STILL_ACTIVE); if (code != STILL_ACTIVE) fails++;
  HANDLE both[2] = { ready, pi.hProcess };
  DWORD w = WaitForMultipleObjects(2, both, 0, 10000);
  report("readyWait", w); if (w != 0) fails++;
  BOOL posted = PostThreadMessageA(pi.dwThreadId, 0xbeef, 0, (LPARAM)map);
  report("posted", posted); if (!posted) fails++;
  w = WaitForSingleObject(written, 10000);
  report("writtenWait", w); if (w != 0) fails++;
  report("liveView", s[0] == 0xc0ffee); if (s[0] != 0xc0ffee) fails++;
  w = WaitForSingleObject(pi.hProcess, INFINITE);
  report("processWait", w); if (w != 0) fails++;
  GetExitCodeProcess(pi.hProcess, &code);
  report("exitCode", code); if (code != 42) fails++;
  v = (volatile unsigned*)MapViewOfFile(map, 0xf001f, 0, 0, 0);
  report("answered", v[1] == MAGIC + 1); if (v[1] != MAGIC + 1) fails++;
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(mtx);
  report("fails", fails);
  ExitProcess(fails);
}
