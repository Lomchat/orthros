# Native x86-32 reference oracle — assembly part.
# Freestanding: no libc. Provides _start, raw syscalls, and run_case which executes a test
# snippet at CODE_BASE with a fully controlled register/flag/FPU/SSE state, then captures the
# resulting state. See oracle.c for the record layouts and oracle.md for the protocol.

.intel_syntax noprefix
.text

.globl _start
_start:
    call main
    mov ebx, eax
    mov eax, 1              # exit
    int 0x80

# int sys3(int nr, int a, int b, int c)
.globl sys3
sys3:
    push ebx
    mov eax, [esp+8]
    mov ebx, [esp+12]
    mov ecx, [esp+16]
    mov edx, [esp+20]
    int 0x80
    pop ebx
    ret

# int sys6(int nr, int a, int b, int c, int d, int e, int f)
.globl sys6
sys6:
    push ebx
    push esi
    push edi
    push ebp
    mov eax, [esp+20]
    mov ebx, [esp+24]
    mov ecx, [esp+28]
    mov edx, [esp+32]
    mov esi, [esp+36]
    mov edi, [esp+40]
    mov ebp, [esp+44]
    int 0x80
    pop ebp
    pop edi
    pop esi
    pop ebx
    ret

# Signal return trampoline (SA_RESTORER).
.globl sig_restorer
sig_restorer:
    mov eax, 173            # rt_sigreturn
    int 0x80

# Record layouts (must match oracle.c / gen_cases.py):
.set CASE_REGS,   4
.set CASE_EFLAGS, 36
.set CASE_FX,     112
.set RES_REGS,    0
.set RES_EFLAGS,  32
.set RES_FX,      48

.globl code_entry
.globl saved_esp
.data
.align 4
code_entry: .long 0x20000000
saved_esp:  .long 0

.text
# void run_case(void): g_case -> execute -> g_result
.globl run_case
run_case:
    push ebx
    push esi
    push edi
    push ebp
    mov [saved_esp], esp
    fxrstor [g_case + CASE_FX]
    push dword ptr [g_case + CASE_EFLAGS]
    popfd
    mov eax, [g_case + CASE_REGS + 0]
    mov ecx, [g_case + CASE_REGS + 4]
    mov edx, [g_case + CASE_REGS + 8]
    mov ebx, [g_case + CASE_REGS + 12]
    mov ebp, [g_case + CASE_REGS + 20]
    mov esi, [g_case + CASE_REGS + 24]
    mov edi, [g_case + CASE_REGS + 28]
    mov esp, [g_case + CASE_REGS + 16]
    jmp dword ptr [code_entry]

# The snippet is followed by `jmp epilogue` written by main().
.globl epilogue
epilogue:
    mov [g_result + RES_REGS + 0], eax
    mov [g_result + RES_REGS + 4], ecx
    mov [g_result + RES_REGS + 8], edx
    mov [g_result + RES_REGS + 12], ebx
    mov [g_result + RES_REGS + 16], esp
    mov [g_result + RES_REGS + 20], ebp
    mov [g_result + RES_REGS + 24], esi
    mov [g_result + RES_REGS + 28], edi
    mov esp, [saved_esp]
    pushfd
    pop dword ptr [g_result + RES_EFLAGS]
    fxsave [g_result + RES_FX]
    # sanitize flags the snippet may have set (TF, DF, AC) before returning to C code
    pushfd
    and dword ptr [esp], 0xfffbfaff
    popfd
    pop ebp
    pop edi
    pop esi
    pop ebx
    ret

# Reached from the signal handler with esp = saved_esp (registers already captured from the
# signal context by the C handler).
.globl fault_exit
fault_exit:
    fxsave [g_result + RES_FX]
    cld
    pop ebp
    pop edi
    pop esi
    pop ebx
    ret
