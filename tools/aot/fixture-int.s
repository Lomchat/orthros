# Integer fixture for verify-c.ts (build with fixture-asm.sh): parity
# conditions, neg as a flag producer, one-operand imul, repe cmps with a
# mismatch, a full match and ECX = 0 (interpreter case). Every function ends
# in ret; edi = [esp+4] and esi = [esp+8] point into scratch.
    .intel_syntax noprefix
    .text
    .globl start
start:
    .globl t_parity
t_parity:
    mov edi, [esp+4]
    mov eax, [edi]
    test eax, eax
    setp cl
    setnp ch
    jp 1f
    or ecx, 0x10000
1:
    mov edx, [edi+4]
    cmp edx, 3
    jnp 2f
    or ecx, 0x20000
2:
    add edx, 0x77
    setpe dl
    and eax, 0x0f
    jpo 3f
    or ecx, 0x40000
3:
    mov [edi+8], ecx
    ret

    .globl t_neg
t_neg:
    mov edi, [esp+4]
    mov eax, [edi]
    neg eax
    setz cl
    seto ch
    sbb edx, edx
    mov ebx, [edi+4]
    neg ebx
    jb 1f
    or ecx, 0x100
1:
    xor esi, esi
    neg esi
    setc bl
    mov [edi+8], eax
    mov [edi+12], edx
    mov [edi+16], ecx
    ret

    .globl t_imul1
t_imul1:
    mov edi, [esp+4]
    mov eax, [edi]
    mov ecx, [edi+4]
    imul ecx
    mov [edi+8], eax
    mov [edi+12], edx
    mov eax, -7
    imul dword ptr [edi+4]
    mov [edi+16], eax
    mov [edi+20], edx
    ret

    .globl t_cmps_mismatch
t_cmps_mismatch:
    push esi
    push edi
    mov esi, [esp+12]
    mov edi, [esp+16]
    mov ecx, 16
    mov byte ptr [edi+5], 0x11
    mov byte ptr [esi+5], 0x22
    xor eax, eax
    repe cmpsb
    setb al
    seta ah
    jne 1f
    or eax, 0x10000
1:
    mov [edi], eax
    mov [edi+4], ecx
    pop edi
    pop esi
    ret

    .globl t_cmps_equal
t_cmps_equal:
    push esi
    push edi
    mov esi, [esp+12]
    mov edi, [esp+16]
    mov ecx, 4
    mov eax, [esi]
    mov [edi], eax
    repe cmpsd
    sete al
    movzx eax, al
    mov [edi], eax
    mov [edi+4], ecx
    pop edi
    pop esi
    ret

    .globl t_cmps_zero
t_cmps_zero:
    push esi
    push edi
    mov esi, [esp+12]
    mov edi, [esp+16]
    xor ecx, ecx
    cmp ecx, 0
    repe cmpsw
    je 1f
    mov eax, 1
    jmp 2f
1:
    mov eax, 2
2:
    mov [edi], eax
    pop edi
    pop esi
    ret

    .globl t_narrow
t_narrow:
    mov edi, [esp+4]
    xor ecx, ecx
    mov al, 0x80
    cmp al, 0x7f
    sets cl
    seto ch
    setl dl
    setb dh
    mov bl, 0x80
    add bl, 0x80
    setz bh
    setc al
    seto ah
    mov [edi], ecx
    mov [edi+4], edx
    mov [edi+8], eax
    mov ax, 0x7fff
    inc ax
    seto cl
    sets ch
    dec ax
    seto dl
    mov bl, 1
    neg bl
    setc dh
    seto bl
    mov [edi+12], ecx
    mov [edi+16], edx
    mov [edi+20], ebx
    mov eax, 0x7fffffff
    add eax, 1
    jo 1f
    mov ecx, 5
1:
    mov [edi+24], ecx
    ret

    .globl t_callee
t_callee:
    mov eax, [esp+4]
    add eax, [esp+8]
    imul eax, eax, 3
    ret 8

    .globl t_caller
t_caller:
    push esi
    mov esi, [esp+8]
    push 5
    push dword ptr [esi]
    call t_callee
    mov [esi+4], eax
    push eax
    push 7
    call t_callee
    mov [esi+8], eax
    cmp eax, 100
    jl 1f
    mov dword ptr [esi+12], 1
1:
    push 1
    push 2
    call t_callee_slow
    mov [esi+16], eax
    pop esi
    ret

    .globl t_callee_slow
t_callee_slow:
    fld1
    fsqrt
    fstp st(0)
    mov eax, [esp+4]
    sub eax, [esp+8]
    ret 8

    .globl t_negimm
t_negimm:
    mov edi, [esp+4]
    mov eax, 0x100
    add eax, -0x10
    and eax, -0x100
    sub esp, -0x10
    mov ecx, esp
    add esp, -0x10
    cmp eax, -0x1
    setne dl
    mov [edi], eax
    mov [edi+4], edx
    ret

    .globl t_shifts
t_shifts:
    mov edi, [esp+4]
    mov eax, 0x80000001
    shl eax, 1
    setc cl
    seto ch
    mov edx, 0x80000000
    sar edx, 4
    setc dl
    sets dh
    mov ebx, 3
    shr ebx, 1
    setc bl
    setz bh
    mov [edi], eax
    mov [edi+4], ecx
    mov [edi+8], edx
    mov [edi+12], ebx
    mov al, 0x81
    shl al, 1
    setc ah
    mov cl, 3
    mov si, 0x8000
    shr si, cl
    setz cl
    mov edx, 0x12345678
    shl edx, 0
    setc dl
    mov [edi+16], eax
    mov [edi+20], ecx
    mov [edi+24], esi
    mov [edi+28], edx
    ret

    .globl t_adc_sbb
t_adc_sbb:
    mov edi, [esp+4]
    mov eax, 0xffffffff
    add eax, 1
    mov ecx, 5
    adc ecx, 0
    setc dl
    seto dh
    mov al, 0xff
    add al, 1
    mov bl, 0x7f
    adc bl, 0
    seto bh
    sets al
    mov esi, 3
    cmp esi, 4
    sbb esi, esi
    setc ch
    mov edx, 0x80000000
    sub edx, 1
    mov ebp, 0
    sbb ebp, 0x7fffffff
    seto cl
    mov [edi], eax
    mov [edi+4], ecx
    mov [edi+8], ebx
    mov [edi+12], esi
    mov [edi+16], ebp
    ret

    .globl t_mul_flags
t_mul_flags:
    mov edi, [esp+4]
    mov eax, 0x10000
    mov ecx, 0x10000
    mul ecx
    setc bl
    seto bh
    mov eax, 0x7fffffff
    imul eax, eax, 2
    seto cl
    mov edx, 3
    imul edx, edx, 7
    seto ch
    mov [edi], ebx
    mov [edi+4], ecx
    ret

    .globl t_crossblock
t_crossblock:
    mov edi, [esp+4]
    mov eax, [edi]
    cmp eax, 10
    jmp 1f
1:
    sbb ecx, ecx
    setl dl
    jg 2f
    or ecx, 0x100
2:
    mov [edi+4], ecx
    mov [edi+8], edx
    mov eax, [edi+12]
    shl eax, 3
    jmp 3f
3:
    setc cl
    mov [edi+16], ecx
    ret

# Nested-activation barrier: t_recur bridges a call to a helper the verifier
# never translates. The helper builds a frame like t_recur's and jumps into
# recur_body, which is not a state entry, so that activation runs in v86 under
# the outer bridged call and executes the same call instruction: it returns to
# the same address one frame deeper. The outer call must only end when its own
# frame returns; ending early leaves the inner frames on the stack.
    .globl t_recur
t_recur:
    push ebx
    push esi
    mov esi, [esp+12]
    mov ebx, [esi]
    and ebx, 7
recur_body:
    push ebx
    call recur_helper
    add eax, ebx
    mov [esi+4], eax
    add dword ptr [esi+8], 1
    pop esi
    pop ebx
    ret
recur_helper:
    mov eax, [esp+4]
    test eax, eax
    jz 1f
    dec eax
    push offset recur_ret
    push ebx
    push esi
    mov ebx, eax
    jmp recur_body
recur_ret:
    ret 4
1:
    mov eax, 100
    ret 4

# Native call into a callee whose CFG has a block below its entry: the
# helper block sits before t_lowblock, so it is block 0 of that translation
# while the entry is block 1. t_lowcaller calls t_lowblock natively (both are
# translated together); starting the callee at block 0 would skip its body.
lowblock_tail:
    add eax, 1000
    ret
    .globl t_lowblock
t_lowblock:
    mov eax, [esp+4]
    add eax, 7
    jmp lowblock_tail
    .globl t_lowcaller
t_lowcaller:
    push esi
    mov esi, [esp+8]
    push dword ptr [esi]
    call t_lowblock
    add esp, 4
    mov [esi+4], eax
    pop esi
    ret

# Indirect call to a translated callee: the batch dispatches it natively when
# the target is one of its entries, and bridges it otherwise.
    .globl t_indirect
t_indirect:
    push esi
    mov esi, [esp+8]
    push dword ptr [esi]
    mov eax, offset t_lowblock
    call eax
    add esp, 4
    mov [esi+4], eax
    push 3
    push 4
    mov eax, offset t_callee
    call eax
    mov [esi+8], eax
    pop esi
    ret

# An Orthros-shaped import stub (mov eax, id ; mov edx, 0xB077 ; out dx, eax ;
# ret 4) called indirectly: the translation performs the port write itself and
# emulates the ret; in this bare guest the port write is a no-op, so parity
# with v86 executing the same stub is the check (stack, EIP, EAX untouched).
stub_b077:
    .byte 0xb8, 0x05, 0x00, 0x00, 0x00
    .byte 0xba, 0x77, 0xb0, 0x00, 0x00
    .byte 0xef
    .byte 0xc2, 0x04, 0x00
    .globl t_stubcall
t_stubcall:
    push esi
    mov esi, [esp+8]
    push dword ptr [esi]
    mov eax, offset stub_b077
    call eax
    mov [esi+4], eax
    add dword ptr [esi+8], 7
    pop esi
    ret

# A direct call to an import thunk (jmp dword ptr [slot]): the translation
# folds it into the call through the slot, and the stub behind it is
# performed in place. The slot lives in .text so the flat image carries it.
    .align 4
import_slot:
    .long stub_b077
thunk_import:
    jmp dword ptr [import_slot]
    .globl t_viathunk
t_viathunk:
    push esi
    mov esi, [esp+8]
    push dword ptr [esi+4]
    call thunk_import
    mov [esi+8], eax
    add dword ptr [esi+12], 11
    pop esi
    ret

# rdtsc: not in the t_ parity set — v86's virtual counter follows the host
# clock in the bare harness, so the two runs read different values. Kept as a
# translation smoke test (x_rdtsc: verify-c ... --entries <addr>).
    .globl x_rdtsc
x_rdtsc:
    mov ecx, [esp+4]
    rdtsc
    mov [ecx], eax
    mov [ecx+4], edx
    ret

# pushfd carries the producer's flags; popfd makes the popped arithmetic
# flags the producer of what follows, over an intervening clobber.
    .globl t_flagsstack
t_flagsstack:
    mov edi, [esp+4]
    mov eax, [edi]
    cmp eax, 5
    pushfd
    xor ecx, ecx
    add eax, 7
    popfd
    jb 1f
    or ecx, 1
1:
    jz 2f
    or ecx, 2
2:
    pushfd
    pop edx
    and edx, 0x8d5
    mov [edi+4], edx
    mov [edi+8], ecx
    ret

# bt family: register and memory forms, a lock prefix, register bit offsets
# past the dword in both directions, and the untouched flags kept.
    .globl t_bitops
t_bitops:
    mov edi, [esp+4]
    mov eax, [edi]
    xor ecx, ecx
    bt eax, 3
    setc cl
    bts eax, 5
    setc ch
    mov edx, 37
    lock bts dword ptr [edi+4], edx
    jnc 1f
    or ecx, 0x100
1:
    btr dword ptr [edi+4], 2
    jc 2f
    or ecx, 0x200
2:
    btc eax, 31
    jnc 3f
    or ecx, 0x400
3:
    mov edx, -3
    bt dword ptr [edi+8], edx
    jnc 4f
    or ecx, 0x800
4:
    cmp eax, 1
    bt eax, 0
    jnz 5f
    or ecx, 0x1000
5:
    mov [edi+12], eax
    mov [edi+16], ecx
    ret

# inc after cmp: the exit's CF is the cmp's, not v86's stale copy.
    .globl t_inccf
t_inccf:
    mov edi, [esp+4]
    mov eax, [edi]
    cmp eax, -1
    inc eax
    mov [edi+4], eax
    ret

# out dx, eax to the hypercall port inside a body, with a compare behind it.
    .globl t_outbody
t_outbody:
    mov edi, [esp+4]
    mov eax, 0x9999
    mov edx, 0xB077
    out dx, eax
    mov ecx, [edi]
    cmp ecx, 4
    jne 1f
    mov dword ptr [edi+4], 1
1:
    ret

# stmxcsr/ldmxcsr round-trip through the MXCSR field: store the live value,
# reload the default and store it again. Both stores must match v86.
    .globl t_mxcsr
t_mxcsr:
    mov edi, [esp+4]
    stmxcsr [edi]
    mov eax, 0x1f80
    mov [edi+4], eax
    ldmxcsr [edi+4]
    stmxcsr [edi+8]
    ret

# SSE2 low-64 moves and 32-bit extract: load a qword, extract dword, shift,
# store back. edi points to scratch (>= 32 bytes of pointers region).
    .globl t_sse_move
t_sse_move:
    mov edi, [esp+4]
    movq xmm0, qword ptr [edi]
    movd eax, xmm0
    mov [edi+16], eax
    psrlq xmm0, 4
    movq qword ptr [edi+24], xmm0
    ret

# psrlq/psllq by an xmm count, and a 128-bit unaligned move round-trip.
    .globl t_sse_shift
t_sse_shift:
    mov edi, [esp+4]
    movdqu xmm0, xmmword ptr [edi]
    movdqu xmm1, xmmword ptr [edi]
    psrlq xmm1, 5
    psllq xmm0, 3
    movdqu xmmword ptr [edi+16], xmm0
    movdqu xmmword ptr [edi+32], xmm1
    ret

# packed 32-bit subtract and 128-bit bitwise (pand/pxor).
    .globl t_sse_packed
t_sse_packed:
    mov edi, [esp+4]
    movdqu xmm0, xmmword ptr [edi]
    movdqu xmm1, xmmword ptr [edi+16]
    psubd xmm0, xmm1
    movdqu xmmword ptr [edi+32], xmm0
    movdqu xmm2, xmmword ptr [edi]
    pand xmm2, xmm1
    pxor xmm2, xmm1
    movdqu xmmword ptr [edi+48], xmm2
    ret

# ucomisd sets CF/PF/ZF; jb/jz/jnp read them. Compare two doubles from scratch
# and record the branch outcomes, so verify-c checks the flag mapping.
    .globl t_sse_cmp
t_sse_cmp:
    mov edi, [esp+4]
    xor ecx, ecx
    movq xmm0, qword ptr [edi]
    movq xmm1, qword ptr [edi+8]
    ucomisd xmm0, xmm1
    jb 1f
    or ecx, 1
1:
    jz 2f
    or ecx, 2
2:
    jnp 3f
    or ecx, 4
3:
    ucomisd xmm0, xmm0
    jnp 4f
    or ecx, 8
4:
    mov [edi+16], ecx
    ret

# SSE2 double arithmetic: packed and scalar add/sub/mul/div, results to scratch.
# movapd is reg-reg only (no alignment need); loads/stores use movdqu.
    .globl t_sse_fp
t_sse_fp:
    mov edi, [esp+4]
    movdqu xmm0, xmmword ptr [edi]
    movdqu xmm1, xmmword ptr [edi+16]
    movapd xmm2, xmm0
    addpd xmm2, xmm1
    movdqu xmmword ptr [edi+32], xmm2
    movapd xmm3, xmm0
    subsd xmm3, xmm1
    movdqu xmmword ptr [edi+48], xmm3
    movapd xmm4, xmm0
    mulpd xmm4, xmm1
    movdqu xmmword ptr [edi+64], xmm4
    movapd xmm5, xmm0
    divsd xmm5, xmm1
    movdqu xmmword ptr [edi+80], xmm5
    ret

# SSE2 packed double compares producing per-lane masks.
    .globl t_sse_fpcmp
t_sse_fpcmp:
    mov edi, [esp+4]
    movdqu xmm0, xmmword ptr [edi]
    movdqu xmm1, xmmword ptr [edi+16]
    movapd xmm2, xmm0
    cmpltpd xmm2, xmm1
    movdqu xmmword ptr [edi+32], xmm2
    movapd xmm3, xmm0
    cmpeqpd xmm3, xmm1
    movdqu xmmword ptr [edi+48], xmm3
    movapd xmm4, xmm0
    cmpunordpd xmm4, xmm1
    movdqu xmmword ptr [edi+64], xmm4
    ret
