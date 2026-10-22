// Test program: child processes beyond the launcher/game handshake (docs/processes.md, tests/processes.test.js).
// The parent runs each case with a child it starts as "multiproc2.exe <case> [arg]":
//   relaunch  a game started ten times in a row, each a single instance: its named mutex (owned, never released) is
//             gone with its process — every start finds no other instance;
//   window    the child's top-level window found with FindWindowA, a broadcast and a message posted to it;
//   bigmap    a 1 MiB paging-file mapping (inherited) the child writes a hundred times between sleeps while the parent
//             waits on its process, the parent's view showing every write afterwards;
//   pulse     PulseEvent in the child wakes the parent waiting on the named event;
//   soaw      SignalObjectAndWait(e, e, 0) in the child hands the auto-reset event to the parent waiting on it;
//   dup       DuplicateHandle of an event into the child's process (no inheritance), the child setting it.
// Prints name=value lines; exit code = failures.
#include "win.h"

#define INFINITE 0xffffffff
#define WM_USER 0x400
#define WM_APP 0x8000
#define HWND_BROADCAST ((HWND)0xffff)
#define WS_POPUP 0x80000000

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
static int same(const char* a, const char* b) { while (*a && *a == *b) { a++; b++; } return *a == *b; }
static unsigned hexval(const char* s) { unsigned v = 0; for (; *s; s++) v = v * 16 + (*s <= '9' ? *s - '0' : (*s | 32) - 'a' + 10); return v; }
static void hexstr(char* p, unsigned v) { for (int i = 7; i >= 0; i--) { unsigned d = (v >> (4 * i)) & 15; *p++ = d < 10 ? '0' + d : 'a' + d - 10; } *p = 0; }

// the command line's words after the program's name
static char words[4][32];
static void split(void) {
  const char* c = GetCommandLineA(); int w = -1, n = 0;
  for (; *c; c++) {
    if (*c == ' ') { if (w >= 0 && n) words[w][n] = 0; w++; n = 0; if (w >= 4) break; continue; }
    if (w >= 0 && n < 31) words[w][n++] = *c;
  }
  if (w >= 0 && w < 4) words[w][n] = 0;
}

static PROCESS_INFORMATION spawn(const char* args, BOOL inherit) {
  static const char prog[] = "multiproc2.exe ";
  char cmd[96]; int i = 0;
  for (int k = 0; prog[k]; k++) cmd[i++] = prog[k];
  for (int k = 0; args[k]; k++) cmd[i++] = args[k];
  cmd[i] = 0;
  STARTUPINFOA si = { sizeof si };
  PROCESS_INFORMATION pi = { 0 };
  if (!CreateProcessA(0, cmd, 0, 0, inherit, 0, 0, 0, &si, &pi)) { report("createFailed", GetLastError()); ExitProcess(100); }
  return pi;
}
static DWORD finish(PROCESS_INFORMATION pi) {
  DWORD code = 0;
  WaitForSingleObject(pi.hProcess, INFINITE);
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  return code;
}

// ---------------------------------------------------------------- children
static int gotBroadcast = 0;
static LRESULT WINAPI wndproc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_APP + 5) { gotBroadcast = 1; return 0; }
  if (m == WM_USER + 1) ExitProcess((UINT)w + (gotBroadcast ? 40 : 0));
  return DefWindowProcA(h, m, w, l);
}
static void childWindow(void) {
  WNDCLASSA wc = { 0 };
  wc.lpfnWndProc = wndproc; wc.hInstance = GetModuleHandleA(0); wc.lpszClassName = "OrthrosMp2Win";
  RegisterClassA(&wc);
  CreateWindowExA(0, "OrthrosMp2Win", "mp2 child", WS_POPUP, 0, 0, 64, 64, 0, 0, wc.hInstance, 0);
  MSG msg;
  while (GetMessageA(&msg, 0, 0, 0) > 0) DispatchMessageA(&msg);
  ExitProcess(1);
}
static void child(void) {
  const char* c = words[0];
  if (same(c, "relaunch")) {
    CreateMutexA(0, 1, "orthros-mp2-single");
    ExitProcess(GetLastError() == 183 ? 1 : 20); // (another instance: 1; the mutex left owned — abandoned — at the exit)
  }
  if (same(c, "window")) childWindow();
  if (same(c, "bigmap")) {
    volatile unsigned* v = (volatile unsigned*)MapViewOfFile((HANDLE)hexval(words[1]), 0xf001f, 0, 0, 0);
    if (!v) ExitProcess(1);
    for (int i = 0; i < 100; i++) { v[1 + i] = i + 1; Sleep(1); }
    v[0] = 2;
    ExitProcess(5);
  }
  if (same(c, "pulse")) {
    HANDLE e = OpenEventA(2, 0, "orthros-mp2-pulse");
    Sleep(50);
    PulseEvent(e);
    Sleep(50);
    ExitProcess(e ? 0 : 1);
  }
  if (same(c, "soaw")) {
    HANDLE e = OpenEventA(2, 0, "orthros-mp2-soaw");
    Sleep(50);
    ExitProcess(SignalObjectAndWait(e, e, 0, 0)); // (the waiting parent takes the event: this wait times out, 258)
  }
  if (same(c, "dup")) {
    MSG msg; int got = 0;
    for (int i = 0; i < 5000 && !got; i++) { if (PeekMessageA(&msg, 0, 0xbeef, 0xbeef, 1)) got = 1; else Sleep(1); }
    if (!got) ExitProcess(1);
    ExitProcess(SetEvent((HANDLE)msg.lParam) ? 30 : 2);
  }
  ExitProcess(99);
}

// ---------------------------------------------------------------- parent
void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  split();
  if (words[0][0]) child();
  int fails = 0;

  int single = 0;
  for (int i = 0; i < 10; i++) if (finish(spawn("relaunch", 0)) == 20) single++;
  report("relaunch", single); if (single != 10) fails++;

  {
    PROCESS_INFORMATION pi = spawn("window", 0);
    HWND h = 0;
    for (int i = 0; i < 3000 && !h; i++) { h = FindWindowA("OrthrosMp2Win", 0); if (!h) Sleep(1); }
    report("window.found", h != 0); if (!h) fails++;
    PostMessageA(HWND_BROADCAST, WM_APP + 5, 0, 0);
    if (h) PostMessageA(h, WM_USER + 1, 33, 0);
    DWORD code = h ? finish(pi) : 0;
    report("window.exit", code); if (code != 73) fails++;
  }

  {
    SECURITY_ATTRIBUTES sa = { sizeof sa, 0, 1 };
    HANDLE map = CreateFileMappingA((HANDLE)-1, &sa, 4, 0, 1 << 20, 0);
    volatile unsigned* v = (volatile unsigned*)MapViewOfFile(map, 0xf001f, 0, 0, 0);
    v[0] = 1;
    char args[16]; args[0] = 'b'; args[1] = 'i'; args[2] = 'g'; args[3] = 'm'; args[4] = 'a'; args[5] = 'p'; args[6] = ' '; hexstr(args + 7, (unsigned)map);
    DWORD code = finish(spawn(args, 1));
    int ok = code == 5 && v[0] == 2 && v[1] == 1 && v[100] == 100;
    report("bigmap", ok); if (!ok) fails++;
  }

  {
    HANDLE e = CreateEventA(0, 0, 0, "orthros-mp2-pulse");
    PROCESS_INFORMATION pi = spawn("pulse", 0);
    DWORD w = WaitForSingleObject(e, 3000);
    report("pulseWait", w); if (w != 0) fails++;
    finish(pi); CloseHandle(e);
  }

  {
    HANDLE e = CreateEventA(0, 0, 0, "orthros-mp2-soaw");
    PROCESS_INFORMATION pi = spawn("soaw", 0);
    DWORD w = WaitForSingleObject(e, 3000);
    DWORD code = finish(pi);
    report("soawWait", w); if (w != 0) fails++;
    report("soawChild", code); if (code != 258) fails++;
    CloseHandle(e);
  }

  {
    HANDLE e = CreateEventA(0, 1, 0, 0); // (unnamed, not inheritable: reaches the child only through DuplicateHandle)
    PROCESS_INFORMATION pi = spawn("dup", 0);
    HANDLE hc = 0;
    BOOL d = DuplicateHandle(GetCurrentProcess(), e, pi.hProcess, &hc, 0, 0, 2); // DUPLICATE_SAME_ACCESS
    report("dup.made", d && hc); if (!d || !hc) fails++;
    PostThreadMessageA(pi.dwThreadId, 0xbeef, 0, (LPARAM)hc);
    DWORD w = WaitForSingleObject(e, 3000);
    DWORD code = finish(pi);
    report("dup.wait", w); if (w != 0) fails++;
    report("dup.child", code); if (code != 30) fails++;
  }

  report("fails", fails);
  ExitProcess(fails);
}
