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

// Handler 3: an execution fault (a call through a bad pointer): records the exception, resumes at the caller (the
// return address the call pushed)
static DWORD exec_code, exec_addr, exec_info1;
static int __cdecl handler_exec(EXCEPTION_RECORD* rec, void* frame, CONTEXT* ctx, void* disp) {
  if (rec->ExceptionFlags & 2) return 1;
  exec_code = rec->ExceptionCode; exec_addr = (DWORD)rec->ExceptionAddress; exec_info1 = rec->ExceptionInformation[1];
  ctx->Eip = *(DWORD*)ctx->Esp; ctx->Esp += 4;
  return 0;
}

// Handler 4: an exception raised while it runs (a nested dispatch): it installs a frame of its own, divides by zero
// (skipped by handler_skip, eax = 77), removes the frame, then continues the first exception with eax = 55
static void install(REG* r, void* handler);
static void uninstall(REG* r);
static DWORD nested_q, nested_code;
static int __cdecl handler_nested(EXCEPTION_RECORD* rec, void* frame, CONTEXT* ctx, void* disp) {
  if (rec->ExceptionFlags & 2) return 1;
  REG r2; install(&r2, handler_skip);
  unsigned q2;
  __asm__ volatile("xorl %%ecx, %%ecx; movl $10, %%eax; xorl %%edx, %%edx; divl %%ecx" : "=a"(q2) : : "ecx", "edx");
  uninstall(&r2);
  nested_q = q2; nested_code = r2.code;
  ctx->Eip += 2; ctx->Eax = 55;
  return 0;
}

// Handler 5: a data access in the null page (or past the user address space): records the exception and resumes after
// the faulting instruction (av_skip bytes, measured by the case)
static DWORD av_code, av_info0, av_info1, av_addr, av_ecx, av_faults, av_skip;
static int __cdecl handler_av(EXCEPTION_RECORD* rec, void* frame, CONTEXT* ctx, void* disp) {
  if (rec->ExceptionFlags & 2) return 1;
  av_code = rec->ExceptionCode; av_info0 = rec->ExceptionInformation[0]; av_info1 = rec->ExceptionInformation[1];
  av_addr = (DWORD)rec->ExceptionAddress == ctx->Eip ? ctx->Eip : 0; av_ecx = ctx->Ecx; av_faults++;
  ctx->Eip += av_skip;
  return 0;
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
  // 4. calls through bad pointers (null, past the address space, the last byte): access violations at the target
  REG ex; install(&ex, handler_exec);
  static const DWORD targets[3] = { 0, 0xfffffff0, 0xffffffff };
  for (int i = 0; i < 3; i++) {
    void (*volatile fp)(void) = (void (*)(void))targets[i];
    exec_code = 0; fp();
    put(out, "exec code "); puthex(out, exec_code); put(out, "exec addr "); puthex(out, exec_addr); put(out, "exec info "); puthex(out, exec_info1);
  }
  uninstall(&ex);
  // 5. nested dispatch: the handler of a division by zero raises and handles another one before continuing the first
  REG n; install(&n, handler_nested);
  unsigned qn;
  __asm__ volatile("xorl %%ecx, %%ecx; movl $10, %%eax; xorl %%edx, %%edx; divl %%ecx" : "=a"(qn) : : "ecx", "edx");
  uninstall(&n);
  put(out, "nested inner "); puthex(out, nested_q); put(out, "nested inner code "); puthex(out, nested_code); put(out, "nested outer "); puthex(out, qn);
  // 6. data accesses through null pointers: read, write, a call through a null vtable, a string copy from null, a
  // negative offset from null (past the user address space), and LEA (no access). Repeated so that the JIT translates
  // the code (the last round printed): each faults at the instruction (EIP and ExceptionAddress at its label, ECX as
  // before it) with [0 read / 1 write, address].
  REG av; install(&av, handler_av);
  DWORD at[6], ecxs[6], codes[6], i0[6], i1[6], pc[6], faults0 = 0;
  static DWORD buf[4];
  for (int round = 0; round < 300; round++) {
    DWORD e, x, y;
#define AV_BEGIN() av_code = 0; av_addr = 1; av_info0 = av_info1 = 0xeeeeeeee; e = 0
#define AV_END(k) codes[k] = av_code; i0[k] = av_info0; i1[k] = av_info1; pc[k] = av_addr; ecxs[k] = e
#define AV_ASM(text) "movl $2f-1f, %[skip]\n\tmovl $1f, %[at]\n1:\t" text "\n2:"
    AV_BEGIN(); __asm__ volatile(AV_ASM("movl 8(%%ecx), %%eax") : [skip] "=m"(av_skip), [at] "=m"(at[0]), "+c"(e), "=a"(x) : : "memory"); AV_END(0);
    AV_BEGIN(); __asm__ volatile(AV_ASM("movl %%eax, 0x7ffc(%%ecx)") : [skip] "=m"(av_skip), [at] "=m"(at[1]), "+c"(e) : "a"(5) : "memory"); AV_END(1);
    AV_BEGIN(); __asm__ volatile(AV_ASM("call *0x10(%%ecx)") : [skip] "=m"(av_skip), [at] "=m"(at[2]), "+c"(e) : : "eax", "edx", "memory"); AV_END(2);
    AV_BEGIN(); e = 4; __asm__ volatile(AV_ASM("rep movsl") : [skip] "=m"(av_skip), [at] "=m"(at[3]), "+c"(e), "=S"(x), "=D"(y) : "S"(0), "D"(buf) : "memory"); AV_END(3);
    AV_BEGIN(); __asm__ volatile(AV_ASM("movl -4(%%ecx), %%eax") : [skip] "=m"(av_skip), [at] "=m"(at[4]), "+c"(e), "=a"(x) : : "memory"); AV_END(4);
    AV_BEGIN(); __asm__ volatile(AV_ASM("leal 8(%%ecx), %%eax") : [skip] "=m"(av_skip), [at] "=m"(at[5]), "+c"(e), "=a"(x) : : "memory"); AV_END(5);
    if (round == 0) faults0 = av_faults;
  }
  uninstall(&av);
  for (int k = 0; k < 6; k++) {
    put(out, "av code "); puthex(out, codes[k]); put(out, "av info "); puthex(out, i0[k]); put(out, "av addr "); puthex(out, i1[k]);
    put(out, "av at insn "); puthex(out, codes[k] ? pc[k] == at[k] : pc[k]); put(out, "av ecx "); puthex(out, ecxs[k]);
  }
  put(out, "av faults "); puthex(out, av_faults); put(out, "av faults per round "); puthex(out, faults0);
  ExitProcess(q == 77 && inner.code == 0xC0000094 && inner.hits == 101 && top == &outer ? 0 : 1);
}
