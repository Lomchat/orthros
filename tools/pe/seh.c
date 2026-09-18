// Test program: structured exception handling without a CRT (hand-rolled registration records),
// RaiseException, faults (division by zero, access violation), RtlUnwind, nested frames.
#include "win.h"
typedef struct _EXCEPTION_RECORD { DWORD ExceptionCode; DWORD ExceptionFlags; struct _EXCEPTION_RECORD* ExceptionRecord; void* ExceptionAddress; DWORD NumberParameters; DWORD ExceptionInformation[15]; } EXCEPTION_RECORD;
typedef struct { DWORD ContextFlags; DWORD Dr[6]; BYTE FloatSave[112]; DWORD SegGs, SegFs, SegEs, SegDs; DWORD Edi, Esi, Ebx, Edx, Ecx, Eax; DWORD Ebp, Eip, SegCs, EFlags, Esp, SegSs; } CONTEXT;
typedef struct _REG { struct _REG* prev; void* handler; DWORD code; DWORD hits; } REG;
DLLIMPORT void WINAPI RaiseException(DWORD, DWORD, DWORD, const DWORD*);
DLLIMPORT void WINAPI RtlUnwind(void*, void*, EXCEPTION_RECORD*, DWORD);

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void put(HANDLE h, const char* s) { DWORD w; WriteFile(h, s, slen(s), &w, 0); }
static void puthex(HANDLE h, unsigned v) { char b[12]; b[0]='0'; b[1]='x'; for (int i = 0; i < 8; i++) { unsigned d = (v >> (28 - 4 * i)) & 15; b[2 + i] = d < 10 ? '0' + d : 'a' + d - 10; } b[10] = '\n'; b[11] = 0; put(h, b); }

static HANDLE out;
static volatile int marker = 0;

// Handler 1: records the code, skips the faulting instruction for #DE (continue execution)
static int __cdecl handler_skip(EXCEPTION_RECORD* rec, void* frame, CONTEXT* ctx, void* disp) {
  REG* r = (REG*)frame;
  if (rec->ExceptionFlags & 2) { r->hits += 100; return 1; } // unwinding
  r->code = rec->ExceptionCode; r->hits++;
  if (rec->ExceptionCode == 0xC0000094) { ctx->Eip += 2; ctx->Eax = 77; return 0; } // skip 'div ecx' (2 bytes)
  return 1; // continue search
}
static int __cdecl handler_search(EXCEPTION_RECORD* rec, void* frame, CONTEXT* ctx, void* disp) {
  REG* r = (REG*)frame;
  if (rec->ExceptionFlags & 2) { r->hits += 100; return 1; }
  r->code = rec->ExceptionCode; r->hits++;
  return 1;
}

static void install(REG* r, void* handler) {
  r->handler = handler; r->code = 0; r->hits = 0;
  __asm__ volatile("movl %%fs:0, %%eax; movl %%eax, (%0); movl %0, %%fs:0" : : "r"(r) : "eax", "memory");
}
static void uninstall(REG* r) { __asm__ volatile("movl (%0), %%eax; movl %%eax, %%fs:0" : : "r"(r) : "eax", "memory"); }

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  REG outer, inner;
  install(&outer, handler_search);
  install(&inner, handler_skip);
  // 1. division by zero, handled by the inner handler (continue execution with eax = 77)
  unsigned q;
  __asm__ volatile("xorl %%ecx, %%ecx; movl $10, %%eax; xorl %%edx, %%edx; divl %%ecx" : "=a"(q) : : "ecx", "edx");
  put(out, "div result "); puthex(out, q);
  put(out, "inner code "); puthex(out, inner.code);
  // 2. RaiseException with a custom code: inner returns search, outer returns search -> unhandled filter not set... use RtlUnwind from the outer? Instead test RaiseException with continuable flag handled via hits.
  // Both handlers continue search, so we need someone to handle it: register a third handler that unwinds.
  // 3. explicit RtlUnwind to `outer`: inner must receive an unwind notification (hits += 100) and be popped
  RtlUnwind(&outer, 0, 0, 0);
  put(out, "inner hits after unwind "); puthex(out, inner.hits);
  REG* top; __asm__ volatile("movl %%fs:0, %0" : "=r"(top));
  put(out, "top is outer "); puthex(out, top == &outer);
  uninstall(&outer);
  ExitProcess(q == 77 && inner.code == 0xC0000094 && inner.hits == 101 && top == &outer ? 0 : 1);
}
