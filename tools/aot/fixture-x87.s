# x87 fixture for verify-c.ts --raw-base 0x200000: one function per shape the
# translator models, each ending in ret, judged against v86 by the
# differential verifier. Build with tools/aot/fixture-x87.sh.
    .intel_syntax noprefix
    .text
    .globl start
start:
    .globl x87_arith
x87_arith:
    mov edi, [esp+4]
    fld qword ptr [c1]
    fld qword ptr [c2]
    faddp st(1), st
    fld dword ptr [c3]
    fmulp st(1), st
    fsub qword ptr [c1]
    fdivr qword ptr [c2]
    fstp qword ptr [edi]
    fld1
    fldz
    fsubp st(1), st
    fstp qword ptr [edi+8]
    fld1
    fldz
    fsubrp st(1), st
    fstp qword ptr [edi+16]
    fld qword ptr [c1]
    fld qword ptr [c2]
    fdivp st(1), st
    fstp qword ptr [edi+24]
    fld qword ptr [c1]
    fld qword ptr [c2]
    fdivrp st(1), st
    fstp qword ptr [edi+32]
    fld qword ptr [c1]
    fld qword ptr [c2]
    fsub st(1), st
    fsubr st, st(1)
    fadd st, st(1)
    fmul st(1), st
    fdiv st, st(1)
    fdivr st(1), st
    fstp qword ptr [edi+40]
    fstp qword ptr [edi+48]
    fld dword ptr [c3]
    fiadd dword ptr [i32v]
    fimul word ptr [i16v]
    fisubr dword ptr [i32v]
    fidiv word ptr [i16v]
    fstp dword ptr [edi+56]
    ret

    .globl x87_compare
x87_compare:
    mov edi, [esp+4]
    xor eax, eax
    xor ecx, ecx
    xor edx, edx
    xor ebx, ebx
    xor esi, esi
    fld qword ptr [c1]
    fld qword ptr [c2]
    fcompp
    fnstsw ax
    sahf
    setb cl
    seta dl
    sete bl
    fld qword ptr [c2]
    fld qword ptr [c1]
    fcomip st, st(1)
    seta ch
    setp dh
    fstp st(0)
    fld qword ptr [nanv]
    fld qword ptr [c1]
    fucomip st, st(1)
    setp bh
    jp 1f
    mov esi, 1
1:
    fstp st(0)
    fld qword ptr [c1]
    fcom qword ptr [c2]
    fnstsw ax
    test ah, 0x41
    jne 2f
    or esi, 2
2:
    ftst
    fnstsw ax
    fucomp st(0)
    fnstsw ax
    fld qword ptr [c2]
    ficomp dword ptr [i32v]
    fnstsw ax
    mov [edi], eax
    mov [edi+4], ecx
    mov [edi+8], edx
    mov [edi+12], ebx
    mov [edi+16], esi
    ret

    .globl x87_int
x87_int:
    mov edi, [esp+4]
    mov esi, [esp+8]
    fild dword ptr [esi]
    fistp dword ptr [edi]
    fild word ptr [esi+4]
    fistp word ptr [edi+4]
    fld qword ptr [big]
    fistp dword ptr [edi+8]
    fld qword ptr [c1]
    fistp word ptr [edi+12]
    fld qword ptr [c2]
    fist dword ptr [edi+16]
    fistp dword ptr [edi+20]
    fld qword ptr [big]
    fistp word ptr [edi+24]
    fild qword ptr [esi]
    fstp qword ptr [edi+28]
    ret

    .globl x87_misc
x87_misc:
    mov edi, [esp+4]
    fld1
    fldpi
    fxch st(1)
    fchs
    fabs
    fld st(1)
    fst st(3)
    fadd st, st(1)
    fstp dword ptr [edi]
    fstp qword ptr [edi+8]
    fstp qword ptr [edi+16]
    fld qword ptr [c1]
    fst qword ptr [edi+24]
    fstp st(0)
    fldl2e
    fldln2
    fldlg2
    fldl2t
    fldz
    fxch st(4)
    ffree st(0)
    fincstp
    fstp qword ptr [edi+32]
    fstp qword ptr [edi+40]
    fstp qword ptr [edi+48]
    fstp qword ptr [edi+56]
    ret

    .globl x87_slow
x87_slow:
    mov edi, [esp+4]
    fld qword ptr [c1]
    fsqrt
    fstp qword ptr [edi]
    fldcw word ptr [cw_single]
    fld qword ptr [c1]
    fmul qword ptr [c2]
    fstp qword ptr [edi+8]
    fld qword ptr [c1]
    fmul qword ptr [c2]
    fldcw word ptr [cw_default]
    fstp qword ptr [edi+16]
    fld dword ptr [c3]
    fsin
    fstp qword ptr [edi+24]
    ret

    .globl x87_fisttp
x87_fisttp:
    mov edi, [esp+4]
    fld qword ptr [c2]
    fisttp dword ptr [edi]
    ret

    # A callee returning its result on the x87 stack, called before the
    # caller's first x87 instruction: the caller must reload TOP after the
    # call or its fstp pops the wrong slot. ret_float is not an entry, so the
    # call is bridged through the nested dispatcher.
    .globl x87_call_before_use
x87_call_before_use:
    mov edi, [esp+4]
    mov eax, 7
    call ret_float
    fstp dword ptr [edi]
    fld dword ptr [edi]
    fadd qword ptr [c1]
    fstp qword ptr [edi+8]
    call ret_float
    fmul qword ptr [c2]
    fstp qword ptr [edi+16]
    ret
ret_float:
    fld qword ptr [c2]
    fadd qword ptr [c1]
    ret

    .balign 16
c1:     .double 3.5
c2:     .double -1.25
c3:     .float 2.5
nanv:   .quad 0x7ff8000000000000
big:    .double 1e10
i32v:   .long -7
i16v:   .short 3
cw_single:  .short 0x007f
cw_default: .short 0x027f
