// Native x86-32 reference oracle — C part (freestanding, no libc).
//
// Protocol: reads fixed-size Case records from stdin, executes each snippet natively on the
// host CPU, writes a Result record to stdout. EOF on stdin ends the run.
//
// Memory map (identical offsets are used inside Orthros' guest memory):
//   SCRATCH 0x10000000  64 KB rw   first MEM_SIZE bytes initialized from Case.mem, returned in Result.mem
//   CODE    0x20000000  64 KB rwx  Case.code followed by `jmp epilogue`
//
// Record layouts (keep in sync with oracle.S and tools/gen/gen_cases.py):
//   Case   (2688 bytes): magic u32 @0, regs[8] @4, eflags @36, codeLen @40, code[64] @48,
//                        fx[512] @112 (FXRSTOR image), mem[2048] @624
//   Result (2624 bytes): regs[8] @0, eflags @32, fault @36, faultEip @40, fx[512] @48 (FXSAVE
//                        image), mem[2048] @560

typedef unsigned int u32;
typedef unsigned char u8;

#define SCRATCH 0x10000000u
#define CODE 0x20000000u
#define REGION 0x10000u
#define MEM_SIZE 2048
#define CODE_MAX 64
#define MAGIC 0x3143524fu /* 'ORC1' */

struct Case {
  u32 magic;
  u32 regs[8];
  u32 eflags;
  u32 codeLen;
  u32 pad0;
  u8 code[CODE_MAX];
  u8 fx[512];
  u8 mem[MEM_SIZE];
  u8 pad1[16];
} __attribute__((aligned(16)));

struct Result {
  u32 regs[8];
  u32 eflags;
  u32 fault;
  u32 faultEip;
  u32 pad0;
  u8 fx[512];
  u8 mem[MEM_SIZE];
  u8 pad1[16];
} __attribute__((aligned(16)));

_Static_assert(sizeof(struct Case) == 2688, "case size");
_Static_assert(sizeof(struct Result) == 2624, "result size");
_Static_assert(__builtin_offsetof(struct Case, fx) == 112, "case fx offset");
_Static_assert(__builtin_offsetof(struct Case, mem) == 624, "case mem offset");
_Static_assert(__builtin_offsetof(struct Result, fx) == 48, "result fx offset");
_Static_assert(__builtin_offsetof(struct Result, mem) == 560, "result mem offset");

struct Case g_case;
struct Result g_result;

extern int sys3(int nr, int a, int b, int c);
extern int sys6(int nr, int a, int b, int c, int d, int e, int f);
extern void run_case(void);
extern void epilogue(void);
extern void fault_exit(void);
extern void sig_restorer(void);
extern u32 saved_esp;

#define SYS_exit 1
#define SYS_read 3
#define SYS_write 4
#define SYS_mmap2 192
#define SYS_rt_sigaction 174

static void die(const char* msg) {
  int n = 0;
  while (msg[n]) n++;
  sys3(SYS_write, 2, (int)msg, n);
  sys3(SYS_exit, 2, 0, 0);
}

static int read_full(void* buf, int len) {
  int got = 0;
  while (got < len) {
    int n = sys3(SYS_read, 0, (int)((u8*)buf + got), len - got);
    if (n == 0) return got; // EOF
    if (n < 0) die("read error\n");
    got += n;
  }
  return got;
}

static void write_full(const void* buf, int len) {
  int done = 0;
  while (done < len) {
    int n = sys3(SYS_write, 1, (int)((const u8*)buf + done), len - done);
    if (n <= 0) die("write error\n");
    done += n;
  }
}

static void memcpy_(void* d, const void* s, u32 n) {
  u8* dd = d;
  const u8* ss = s;
  while (n--) *dd++ = *ss++;
}
static void memset_(void* d, u8 v, u32 n) {
  u8* dd = d;
  while (n--) *dd++ = v;
}

// Kernel's struct sigaction for i386 rt_sigaction.
struct ksigaction {
  void (*handler)(int, void*, void*);
  u32 flags;
  void (*restorer)(void);
  u32 mask[2];
};
#define SA_SIGINFO 4
#define SA_NODEFER 0x40000000
#define SA_RESTORER 0x04000000

// i386 ucontext: uc_flags(4) uc_link(4) uc_stack(12) then sigcontext gregs.
enum { G_GS, G_FS, G_ES, G_DS, G_EDI, G_ESI, G_EBP, G_ESP, G_EBX, G_EDX, G_ECX, G_EAX, G_TRAPNO, G_ERR, G_EIP, G_CS, G_EFL };

static void on_signal(int sig, void* info, void* uctx) {
  (void)info;
  u32* g = (u32*)((u8*)uctx + 20);
  g_result.fault = sig;
  g_result.faultEip = g[G_EIP];
  g_result.regs[0] = g[G_EAX];
  g_result.regs[1] = g[G_ECX];
  g_result.regs[2] = g[G_EDX];
  g_result.regs[3] = g[G_EBX];
  g_result.regs[4] = g[G_ESP];
  g_result.regs[5] = g[G_EBP];
  g_result.regs[6] = g[G_ESI];
  g_result.regs[7] = g[G_EDI];
  g_result.eflags = g[G_EFL];
  g[G_ESP] = saved_esp;
  g[G_EIP] = (u32)fault_exit;
  g[G_EFL] &= ~(0x100u | 0x400u | 0x40000u); // clear TF, DF, AC so the harness itself keeps running
}

static void install(int sig) {
  struct ksigaction sa;
  sa.handler = on_signal;
  sa.flags = SA_SIGINFO | SA_NODEFER | SA_RESTORER;
  sa.restorer = sig_restorer;
  sa.mask[0] = sa.mask[1] = 0;
  if (sys6(SYS_rt_sigaction, sig, (int)&sa, 0, 8, 0, 0) < 0) die("sigaction failed\n");
}

int main(void) {
  // PROT_READ|WRITE|EXEC = 7, MAP_PRIVATE|MAP_FIXED|MAP_ANONYMOUS = 0x32
  if (sys6(SYS_mmap2, (int)SCRATCH, REGION, 3, 0x32, -1, 0) != (int)SCRATCH) die("mmap scratch failed\n");
  if (sys6(SYS_mmap2, (int)CODE, REGION, 7, 0x32, -1, 0) != (int)CODE) die("mmap code failed\n");
  install(4);  // SIGILL
  install(5);  // SIGTRAP
  install(7);  // SIGBUS
  install(8);  // SIGFPE
  install(11); // SIGSEGV

  for (;;) {
    int n = read_full(&g_case, sizeof g_case);
    if (n == 0) break;
    if (n != sizeof g_case) die("short case record\n");
    if (g_case.magic != MAGIC) die("bad magic\n");
    if (g_case.codeLen > CODE_MAX) die("code too long\n");

    memset_((void*)SCRATCH, 0, REGION);
    memcpy_((void*)SCRATCH, g_case.mem, MEM_SIZE);
    u8* code = (u8*)CODE;
    memcpy_(code, g_case.code, g_case.codeLen);
    // jmp rel32 -> epilogue
    u32 at = CODE + g_case.codeLen;
    code[g_case.codeLen] = 0xe9;
    u32 rel = (u32)epilogue - (at + 5);
    memcpy_(code + g_case.codeLen + 1, &rel, 4);
    // fill the rest with int3 so a runaway snippet traps
    memset_(code + g_case.codeLen + 5, 0xcc, REGION - g_case.codeLen - 5);

    memset_(&g_result, 0, sizeof g_result);
    // export the OS's segment selectors so the emulator can mirror them for conformance
    {
      unsigned short* sel = (unsigned short*)g_result.pad1;
      __asm__ volatile("mov %%es, %0" : "=r"(sel[0]));
      __asm__ volatile("mov %%cs, %0" : "=r"(sel[1]));
      __asm__ volatile("mov %%ss, %0" : "=r"(sel[2]));
      __asm__ volatile("mov %%ds, %0" : "=r"(sel[3]));
      __asm__ volatile("mov %%fs, %0" : "=r"(sel[4]));
      __asm__ volatile("mov %%gs, %0" : "=r"(sel[5]));
    }
    run_case();
    memcpy_(g_result.mem, (void*)SCRATCH, MEM_SIZE);
    write_full(&g_result, sizeof g_result);
  }
  return 0;
}
