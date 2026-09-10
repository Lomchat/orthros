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

# shld/shrd: double-precision shifts by an immediate and by CL, counts 1 (OF
# defined), 5, 12 and 0 (flags kept: CF set by stc must survive); CF/OF/SF/ZF/PF
# are read back through setcc into scratch.
    .globl t_shld
t_shld:
    mov edi, [esp+4]
    mov eax, 0x80000001
    mov edx, 0xf0f0f0f0
    shld eax, edx, 1
    mov [edi], eax
    setc byte ptr [edi+4]
    seto byte ptr [edi+5]
    mov eax, 0x12345678
    mov ecx, 5
    shld eax, edx, cl
    mov [edi+8], eax
    setc byte ptr [edi+12]
    sets byte ptr [edi+13]
    mov eax, 0x00000001
    mov edx, 0xdeadbeef
    shrd eax, edx, 1
    mov [edi+16], eax
    setc byte ptr [edi+20]
    seto byte ptr [edi+21]
    setz byte ptr [edi+22]
    mov eax, 0x87654321
    mov cl, 12
    shrd eax, edx, cl
    mov [edi+24], eax
    setc byte ptr [edi+28]
    setp byte ptr [edi+29]
    mov ecx, 0
    stc
    shld eax, edx, cl
    setc byte ptr [edi+30]
    mov [edi+32], eax
    shrd dword ptr [edi+36], edx, 3
    ret

# Half-register SSE moves: movlpd/movhpd/movlps/movhps between memory and an
# xmm keep the other half; movhlps/movlhps move halves between registers. The
# 32 bytes at [edi] are read back as the two full registers.
    .globl t_sse_lohi
t_sse_lohi:
    mov edi, [esp+4]
    mov dword ptr [edi+64], 0x11223344
    mov dword ptr [edi+68], 0x55667788
    mov dword ptr [edi+72], 0x99aabbcc
    mov dword ptr [edi+76], 0xddeeff00
    movups xmm0, [edi+64]
    movlpd xmm1, qword ptr [edi+72]
    movhpd xmm1, qword ptr [edi+64]
    movlps xmm2, qword ptr [edi+64]
    movhps xmm2, qword ptr [edi+72]
    movhlps xmm3, xmm0
    movlhps xmm3, xmm1
    movlpd qword ptr [edi], xmm1
    movhpd qword ptr [edi+8], xmm1
    movhps qword ptr [edi+16], xmm2
    movlps qword ptr [edi+24], xmm2
    movups [edi+32], xmm3
    movups [edi+48], xmm1
    ret

# Interleaves, shuffles, word insert/extract, byte sign mask, packed-64
# add/sub and dword compare: pure bit moves whose results are stored as whole
# registers at [edi], [edi+16] ... and in eax/ecx/edx.
    .globl t_sse_unpck
t_sse_unpck:
    mov edi, [esp+4]
    mov dword ptr [edi+128], 0x11223344
    mov dword ptr [edi+132], 0x55667788
    mov dword ptr [edi+136], 0x99aabbcc
    mov dword ptr [edi+140], 0xddeeff00
    mov dword ptr [edi+144], 0x01020304
    mov dword ptr [edi+148], 0x05060708
    mov dword ptr [edi+152], 0x99aabbcc
    mov dword ptr [edi+156], 0x8d0e0f10
    movups xmm0, [edi+128]
    movups xmm1, [edi+144]
    movapd xmm2, xmm0
    unpcklpd xmm2, xmm1
    movups [edi], xmm2
    movapd xmm2, xmm0
    unpckhpd xmm2, xmm1
    movups [edi+16], xmm2
    movapd xmm2, xmm0
    unpcklpd xmm2, xmm2
    movups [edi+32], xmm2
    movapd xmm2, xmm0
    unpckhpd xmm2, xmmword ptr [edi+144]
    movups [edi+48], xmm2
    movaps xmm2, xmm0
    unpcklps xmm2, xmm1
    movups [edi+64], xmm2
    movaps xmm2, xmm0
    unpckhps xmm2, xmm1
    movups [edi+80], xmm2
    movapd xmm2, xmm0
    shufpd xmm2, xmm1, 1
    movups [edi+96], xmm2
    movapd xmm2, xmm0
    shufpd xmm2, xmm1, 2
    movups [edi+112], xmm2
    pshufd xmm3, xmm0, 0x1b
    movups [edi+160], xmm3
    pshufd xmm3, xmmword ptr [edi+144], 0x4e
    movups [edi+176], xmm3
    pextrw eax, xmm0, 3
    pextrw ecx, xmm1, 7
    pinsrw xmm3, eax, 5
    pinsrw xmm3, word ptr [edi+130], 0
    movups [edi+192], xmm3
    pmovmskb edx, xmm1
    movapd xmm4, xmm0
    paddq xmm4, xmm1
    movups [edi+208], xmm4
    movapd xmm4, xmm0
    psubq xmm4, xmmword ptr [edi+144]
    movups [edi+224], xmm4
    movapd xmm4, xmm0
    pcmpeqd xmm4, xmm1
    movups [edi+240], xmm4
    ret

# Packed integer SSE2: every lane form the translator models, applied to two
# constant registers (bytes around the signed and unsigned limits) and stored
# whole at [edi + 16 i]; shifts by immediate, by register count and past the
# lane width; interleaves, saturating packs and byte shifts of the register.
    .macro PI op, off
    movdqa xmm2, xmm0
    \op xmm2, xmm1
    movups [edi+\off], xmm2
    .endm
    .macro PS op, cnt, off
    movdqa xmm2, xmm0
    \op xmm2, \cnt
    movups [edi+\off], xmm2
    .endm
    .globl t_sse_pint
t_sse_pint:
    mov edi, [esp+4]
    mov dword ptr [edi+1024], 0x7f80ff01
    mov dword ptr [edi+1028], 0x80017fff
    mov dword ptr [edi+1032], 0x12345678
    mov dword ptr [edi+1036], 0xfedcba98
    mov dword ptr [edi+1040], 0x7f7f0102
    mov dword ptr [edi+1044], 0x8000ffff
    mov dword ptr [edi+1048], 0x00010002
    mov dword ptr [edi+1052], 0x7ffe8001
    mov dword ptr [edi+1056], 3
    mov dword ptr [edi+1060], 0
    mov dword ptr [edi+1064], 0
    mov dword ptr [edi+1068], 0
    mov dword ptr [edi+1072], 17
    mov dword ptr [edi+1076], 0
    mov dword ptr [edi+1080], 0
    mov dword ptr [edi+1084], 0
    movups xmm0, [edi+1024]
    movups xmm1, [edi+1040]
    movups xmm3, [edi+1056]
    movups xmm4, [edi+1072]
    PI paddb, 0
    PI psubb, 16
    PI paddw, 32
    PI psubw, 48
    PI paddsb, 64
    PI psubsb, 80
    PI paddsw, 96
    PI psubsw, 112
    PI paddusb, 128
    PI psubusb, 144
    PI paddusw, 160
    PI psubusw, 176
    PI pmullw, 192
    PI pmulhw, 208
    PI pmulhuw, 224
    PI pcmpgtb, 240
    PI pcmpgtw, 256
    PI pcmpgtd, 272
    PI pcmpeqb, 288
    PI pcmpeqw, 304
    PI pavgb, 320
    PI pavgw, 336
    PI pmaxsw, 352
    PI pminsw, 368
    PI pmaxub, 384
    PI pminub, 400
    PI pmaddwd, 416
    PI psadbw, 432
    PS psllw, 3, 448
    PS psrlw, 5, 464
    PS psraw, 7, 480
    PS pslld, 9, 496
    PS psrld, 11, 512
    PS psrad, 13, 528
    PS psllw, xmm3, 544
    PS psraw, xmm4, 560
    PS psrld, xmm3, 576
    PS psrad, xmm4, 592
    PS pslldq, 3, 608
    PS psrldq, 5, 624
    PS pslldq, 16, 640
    PI punpcklbw, 656
    PI punpckhbw, 672
    PI punpcklwd, 688
    PI punpckhwd, 704
    PI punpckldq, 720
    PI punpckhdq, 736
    PI punpcklqdq, 752
    PI punpckhqdq, 768
    PI packuswb, 784
    PI packsswb, 800
    PI packssdw, 816
    movdqa xmm2, xmm0
    paddw xmm2, xmmword ptr [edi+1040]
    movups [edi+832], xmm2
    movdqa xmm2, xmm0
    punpcklbw xmm2, xmmword ptr [edi+1040]
    movups [edi+848], xmm2
    movdqa xmm2, xmm0
    psraw xmm2, xmmword ptr [edi+1072]
    movups [edi+864], xmm2
    ret

# cpuid runs in the interpreter (slow exit at the instruction, native resume
# behind it); the vendor string and the feature words are stored, and the
# flags set before it must survive the round trip.
    .globl t_cpuid
t_cpuid:
    mov edi, [esp+4]
    xor eax, eax
    cpuid
    mov [edi], ebx
    mov [edi+4], edx
    mov [edi+8], ecx
    mov [edi+12], eax
    mov eax, 1
    stc
    cpuid
    setc byte ptr [edi+16]
    mov [edi+20], edx
    mov [edi+24], ecx
    ret

# lahf after add (nibble carry), sub (nibble borrow), inc, dec, and, a negative
# result and a sahf round trip: AH must carry SF:ZF:0:AF:0:PF:1:CF exactly as
# v86 materialises its lazy flags, auxiliary carry included.
    .globl t_lahf
t_lahf:
    mov edi, [esp+4]
    mov eax, 0x0f
    mov ecx, 0x01
    add eax, ecx
    lahf
    mov [edi], eax
    mov eax, 0x10
    sub eax, ecx
    lahf
    mov [edi+4], eax
    mov eax, 0x1f
    inc eax
    lahf
    mov [edi+8], eax
    mov eax, 0x20
    dec eax
    lahf
    mov [edi+12], eax
    mov eax, 0xff
    and eax, 0xf0
    lahf
    mov [edi+16], eax
    mov eax, 0
    sub eax, ecx
    lahf
    mov [edi+20], eax
    mov ah, 0xd7
    sahf
    lahf
    mov [edi+24], eax
    mov eax, 0x7fffffff
    add eax, ecx
    lahf
    mov [edi+28], eax
    ret

# SSE scalar single: integers converted to floats, add/sub/mul/div with
# register and memory sources, min/max (NaN and order rules), sqrt, a compare
# mask, truncating conversions (in range and NaN) and single<->double. Results
# go to scratch and stay in registers: the xmm write-back at ret is checked too.
    .globl t_sse_single
t_sse_single:
    mov edi, [esp+4]
    mov eax, 1234567
    cvtsi2ss xmm0, eax
    mov dword ptr [edi+64], -98765
    cvtsi2ss xmm1, dword ptr [edi+64]
    movss xmm2, xmm0
    addss xmm2, xmm1
    movss dword ptr [edi], xmm2
    movss xmm3, xmm0
    mulss xmm3, xmm1
    movss dword ptr [edi+4], xmm3
    movss xmm4, xmm0
    subss xmm4, dword ptr [edi+4]
    movss dword ptr [edi+8], xmm4
    movss xmm5, xmm0
    divss xmm5, xmm1
    movss dword ptr [edi+12], xmm5
    movss xmm6, xmm0
    minss xmm6, xmm1
    movss dword ptr [edi+16], xmm6
    movss xmm7, xmm1
    maxss xmm7, xmm0
    movss dword ptr [edi+20], xmm7
    sqrtss xmm6, xmm0
    movss dword ptr [edi+24], xmm6
    cvttss2si eax, xmm3
    mov [edi+28], eax
    cvttss2si ecx, dword ptr [edi]
    mov [edi+32], ecx
    xorps xmm7, xmm7
    divss xmm7, xmm7
    movss xmm6, xmm0
    minss xmm6, xmm7
    movss dword ptr [edi+36], xmm6
    cvttss2si edx, xmm7
    mov [edi+40], edx
    movss xmm6, xmm0
    cmpltss xmm6, xmm1
    movss dword ptr [edi+44], xmm6
    cvtss2sd xmm6, xmm0
    movsd qword ptr [edi+48], xmm6
    cvtsd2ss xmm6, xmm6
    movss dword ptr [edi+56], xmm6
    ret

# SSE packed single: four lanes built in scratch, mul/add/div (one lane divides
# by zero) and a compare mask, register and memory sources.
    .globl t_sse_packed_single
t_sse_packed_single:
    mov edi, [esp+4]
    mov dword ptr [edi+64], 0x40400000
    mov dword ptr [edi+68], 0xc0a00000
    mov dword ptr [edi+72], 0x3f000000
    mov dword ptr [edi+76], 0x41200000
    movups xmm0, xmmword ptr [edi+64]
    mov dword ptr [edi+80], 0x3f800000
    mov dword ptr [edi+84], 0x40000000
    mov dword ptr [edi+88], 0x00000000
    mov dword ptr [edi+92], 0xbf800000
    movups xmm1, xmmword ptr [edi+80]
    movaps xmm2, xmm0
    mulps xmm2, xmm1
    movups xmmword ptr [edi], xmm2
    movaps xmm3, xmm0
    addps xmm3, xmmword ptr [edi+80]
    movups xmmword ptr [edi+16], xmm3
    movaps xmm4, xmm0
    divps xmm4, xmm1
    movups xmmword ptr [edi+32], xmm4
    movaps xmm5, xmm0
    cmpleps xmm5, xmm1
    movups xmmword ptr [edi+48], xmm5
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

# Native-call oracle: a caller looping over a small callee, so a bench times
# the call convention (spills, callee entry, memory-base import) and not
# arithmetic. edi = [esp+4] points into scratch; the callee reads through ecx.
    .globl t_callloop
t_callloop:
    mov edi, [esp+4]
    push ebx
    push esi
    mov ebx, 2000
    mov esi, edi
1:
    mov ecx, esi
    call t_callleaf
    add [esi], eax
    dec ebx
    jnz 1b
    pop esi
    pop ebx
    ret

    .globl t_callleaf
t_callleaf:
    mov eax, [ecx]
    add eax, 1
    ret

    # rep movs/stos bulk paths: non-overlapping copy, a destination inside the
    # source (smear, element loop), a destination below the source (memmove),
    # dword and byte fills, and a short fill below the bulk threshold.
    .globl t_movsbulk
t_movsbulk:
    push esi
    push edi
    mov esi, ecx
    lea edi, [ecx + 4096]
    mov ecx, 300
    rep movsd
    lea esi, [edi - 1200]
    lea edi, [esi + 8]
    mov ecx, 50
    rep movsd
    lea edi, [esi - 64]
    mov ecx, 40
    rep movsd
    mov eax, 0
    mov ecx, 100
    rep stosd
    mov al, 0x5a
    mov ecx, 37
    rep stosb
    mov ecx, 3
    rep stosb
    mov eax, 0x12345678
    mov ecx, 20
    rep stosd
    mov eax, edi
    pop edi
    pop esi
    ret

    # repne/repe scasb with their flag consumers, then single stos/movs.
    .globl t_scas
t_scas:
    push edi
    push esi
    mov edi, ecx
    mov byte ptr [ecx + 40], 0x7e
    mov al, 0x7e
    mov ecx, 100
    repne scasb
    jne 1f
    add eax, 1000
1:  setz dl
    movzx edx, dl
    lea eax, [edi + ecx*4]
    add eax, edx
    mov al, [edi]
    mov ecx, 20
    repe scasb
    je 2f
    add eax, 7
2:  lea esi, [edi + 64]
    mov al, 0x11
    stosb
    mov eax, 0x22334455
    stosd
    movsb
    movsd
    sub eax, edi
    add eax, esi
    pop esi
    pop edi
    ret

    # rol/ror by immediate and by CL with CF/OF consumers; a rotate by CL
    # whose masked count is zero must leave the flags of the preceding add.
    .globl t_rol
t_rol:
    mov eax, ecx
    rol eax, 5
    setc dl
    ror eax, 1
    seto dh
    mov cl, 3
    rol ax, cl
    jc 1f
    add eax, 7
1:  ror eax, cl
    movzx edx, dx
    add eax, edx
    mov cl, 32
    add eax, 1
    rol eax, cl
    jz 2f
    add eax, 3
2:  rol byte ptr [esp - 4], 1
    ret

    # Backward scan under DF (strrchr's shape), the flag left by cld, a
    # backward single stos/movs, and xlatb through a table at ECX.
    .globl t_std
t_std:
    push edi
    push esi
    lea edi, [ecx + 200]
    mov byte ptr [ecx + 150], 0x33
    mov al, 0x33
    mov ecx, 100
    std
    repne scasb
    cld
    jne 1f
    add eax, 500
1:  mov edx, edi
    lea esi, [edi + 300]
    std
    mov al, 0x44
    stosb
    movsd
    cld
    mov ecx, esi
    mov al, 5
    xlatb
    sub eax, edi
    add eax, edx
    pop esi
    pop edi
    ret

    # The strlen idiom: ECX = -1 must not defeat the scan's range proof.
    .globl t_strlen
t_strlen:
    push edi
    mov edi, ecx
    mov byte ptr [ecx + 77], 0
    or ecx, -1
    xor eax, eax
    repne scasb
    not ecx
    dec ecx
    mov eax, ecx
    jne 1f
    add eax, 100
1:  pop edi
    ret

    # repe cmps with ECX = -1: bounded by memory, stops at the first mismatch.
    .globl t_cmps
t_cmps:
    push esi
    push edi
    mov esi, ecx
    lea edi, [ecx + 1024]
    mov byte ptr [ecx + 30], 0x41
    mov byte ptr [ecx + 1054], 0x42
    mov ecx, -1
    repe cmpsb
    setb al
    sete ah
    movzx eax, ax
    add eax, ecx
    pop edi
    pop esi
    ret

    # repe cmps with ECX = 0 leaves the flags of the previous producer (here a
    # cmp with CF set, then one with ZF set), read by setcc and by the
    # memcmp idiom sbb eax,eax / sbb eax,-1; then a real compare in the same
    # block, consumed the same way.
    .globl t_cmps0
t_cmps0:
    push esi
    push edi
    mov esi, ecx
    lea edi, [ecx + 512]
    mov byte ptr [ecx + 3], 0x41
    mov byte ptr [ecx + 515], 0x42
    cmp ecx, edi
    xor ecx, ecx
    repe cmpsb
    setb al
    sete ah
    movzx edx, ax
    sbb eax, eax
    sbb eax, -1
    lea edx, [edx + eax*4 + 8]
    cmp edi, edi
    xor ecx, ecx
    repe cmpsb
    sete al
    movzx eax, al
    add edx, eax
    mov ecx, 8
    repe cmpsb
    sbb eax, eax
    sbb eax, -1
    lea eax, [edx + eax*2 + 4]
    add eax, ecx
    pop edi
    pop esi
    ret

    # 16-bit imul, two- and three-operand forms, with and without overflow,
    # flags read through setcc (raw producer).
    .globl t_imul16
t_imul16:
    push ebx
    mov eax, 300
    mov ecx, 300
    imul ax, cx
    seto bl
    setc bh
    movzx edx, bx
    imul cx, cx, 3
    seto bl
    setz bh
    movzx ebx, bx
    lea edx, [edx + ebx*4]
    imul bx, cx, -1000
    seto cl
    sets ch
    movzx ecx, cx
    lea eax, [eax + edx*8]
    add eax, ecx
    movzx ebx, bx
    add eax, ebx
    pop ebx
    ret

    # dec/inc preserve CF: jae/jb/adc after them read the carry of the earlier
    # cmp, through the materialised carry.
    .globl t_decjae
t_decjae:
    mov eax, 5
    mov edx, 7
    cmp eax, edx
    dec edx
    jae 1f
    add eax, 100
1:  cmp edx, eax
    inc eax
    jb 2f
    add eax, 1000
2:  cmp eax, edx
    dec eax
    adc eax, 0
    inc edx
    sbb edx, 0
    lea eax, [eax + edx*4]
    ret

    # int3 padding behind a branch that is never taken: the translation must
    # exist and the taken path stays the interpreter's.
    .globl t_int3pad
t_int3pad:
    mov eax, ecx
    test eax, eax
    jz 3f
    add eax, 17
    ret
3:  int3
    int3

    # rcl/rcr through the carry: 32/16/8-bit, immediate and CL counts, a
    # count of one and larger, a masked zero count; CF and OF read by setcc.
    .globl t_rcl
t_rcl:
    push ebx
    push esi
    mov eax, 0x80000001
    stc
    rcl eax, 1
    setc bl
    seto bh
    movzx esi, bx
    mov ecx, 5
    rcr eax, cl
    setc bl
    seto bh
    movzx ebx, bx
    lea esi, [esi + ebx*4]
    mov dx, 0x8001
    clc
    rcl dx, 3
    setc bl
    seto bh
    movzx ebx, bx
    lea esi, [esi + ebx*8]
    rcr dl, 1
    setc bl
    seto bh
    movzx ebx, bx
    add esi, ebx
    mov cl, 32
    rcl eax, cl
    setc bl
    movzx ebx, bl
    add esi, ebx
    movzx edx, dx
    lea eax, [eax + edx]
    add eax, esi
    pop esi
    pop ebx
    ret

    # jecxz taken and not taken.
    .globl t_jecxz
t_jecxz:
    mov eax, 1
    xor ecx, ecx
    jecxz 1f
    add eax, 100
1:  inc ecx
    jecxz 2f
    add eax, 10
2:  ret

    # pushal/popal round trip with a register changed in between and the
    # pushed ESP read back.
    .globl t_pushal
t_pushal:
    push ebx
    push esi
    mov eax, 11
    mov ebx, 22
    mov esi, 33
    pushad
    mov eax, [esp + 12]
    sub eax, esp
    mov [esp + 16], eax
    mov eax, 44
    popad
    lea eax, [eax + ebx*2]
    add eax, esi
    pop esi
    pop ebx
    ret

    # rotates and shifts by a masked zero count keep the flags of the earlier
    # cmp (CF set), which the following setcc must still read.
    .globl t_rot0
t_rot0:
    push ebx
    mov eax, 5
    cmp eax, 7
    mov cl, 32
    rol eax, cl
    setc bl
    ror eax, cl
    setc bh
    movzx edx, bx
    shl eax, cl
    setc bl
    shr eax, cl
    setc bh
    movzx ebx, bx
    lea edx, [edx + ebx*4]
    sar eax, cl
    setz bl
    movzx ebx, bl
    lea eax, [eax + edx*8 + 1]
    add eax, ebx
    pop ebx
    ret

    # inc on memory whose carry is overwritten by the next add: the loop of
    # a counting pass (histogram build), a bench of dead carry materialization.
    .globl t_incloop
t_incloop:
    push edi
    mov edi, ecx
    xor ecx, ecx
    mov edx, 4096
1:  inc dword ptr [edi]
    add ecx, 8
    cmp ecx, edx
    jb 1b
    mov eax, [edi]
    pop edi
    ret
