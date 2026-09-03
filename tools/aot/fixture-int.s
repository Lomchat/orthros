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
