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
