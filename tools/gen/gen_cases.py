#!/usr/bin/env python3
"""Random x86-32 conformance case generator.

For each suite, generates snippets (assembled with llvm-mc, or hand-encoded for branches),
random initial register/flag/FPU/SSE/memory state, runs the native oracle (build/oracle) and
writes:
  <out>/<suite>.cases.bin    Case records (see tools/oracle/oracle.c)
  <out>/<suite>.results.bin  Result records from the oracle
  <out>/<suite>.meta.json    per-case metadata: asm, flags mask, what to compare

Layouts must match tools/oracle/oracle.c.
"""
import argparse, json, os, random, struct, subprocess, sys, math

SCRATCH = 0x10000000
CODE = 0x20000000
MEM_SIZE = 2048
DATA_LIMIT = 0x400          # memory operands land in [0, 0x400)
STACK_TOP = 0x600           # initial ESP (pushes go down, [esp+disp] reads go up to 0x800)
CASE_SIZE = 2688
RESULT_SIZE = 2624
MAGIC = 0x3143524F

CF, PF, AF, ZF, SF, DF, OF = 1, 4, 0x10, 0x40, 0x80, 0x400, 0x800
ARITH = CF | PF | AF | ZF | SF | OF
ALLF = ARITH | DF

R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']
R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di']
R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh']
DATA_REGS = [0, 1, 2, 3, 5, 6, 7]  # not esp
PTR = {1: 'byte ptr', 2: 'word ptr', 4: 'dword ptr', 8: 'qword ptr', 10: 'tbyte ptr', 16: 'xmmword ptr'}

LLVM_MC = os.environ.get('LLVM_MC', 'llvm-mc-18')


def rnd32(rng):
    k = rng.random()
    if k < 0.15:
        return rng.choice([0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000,
                           0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe, 0x80000001])
    if k < 0.35:
        return rng.randrange(0, 256)
    if k < 0.5:
        return (-rng.randrange(0, 256)) & 0xffffffff
    return rng.getrandbits(32)


def rnd_flags(rng):
    return (rng.getrandbits(12) & ARITH) | 2


class Case:
    def __init__(self):
        self.regs = [None] * 8
        self.eflags = None
        self.code = b''
        self.asm = ''
        self.mask = ALLF
        self.mem = None
        self.fx = None
        self.cmp = {}
        self.df = None

    def fix(self, r, v):
        """Constrain register r to value v (first constraint wins)."""
        if self.regs[r] is None:
            self.regs[r] = v & 0xffffffff
        return self.regs[r]


class Gen:
    def __init__(self, rng):
        self.rng = rng
        self.cases = []
        self.pending_asm = []  # (case, asm-text) to assemble

    # ---- operand builders -------------------------------------------------------------
    def reg(self, size, exclude=()):
        pool = [r for r in (DATA_REGS if size != 1 else range(8)) if r not in exclude]
        r = self.rng.choice(pool)
        name = {1: R8, 2: R16, 4: R32}[size][r]
        return name, r

    def mem(self, c, size, limit=DATA_LIMIT, align=1):
        """Random memory operand within scratch; constrains base/index registers on case c."""
        rng = self.rng
        form = rng.random()
        off = rng.randrange(0, limit - 16)
        off -= off % align
        if form < 0.15:
            return f'{PTR[size]} [0x{SCRATCH + off:x}]', []
        if form < 0.30:
            # [esp+disp]
            disp = off - STACK_TOP
            if disp < -0x80 or disp > 0x7f:
                disp = rng.randrange(0, 0x100) & ~(align - 1)
            c.fix(4, SCRATCH + STACK_TOP)
            return f'{PTR[size]} [esp{disp:+#x}]', [4]
        base = rng.choice(DATA_REGS)
        if form < 0.65:
            disp = rng.choice([0, rng.randrange(-0x40, 0x40), rng.randrange(-0x200, 0x200)])
            base_v = SCRATCH + off - disp
            c.fix(base, base_v)
            # if the register was already fixed, recompute disp to stay in range
            disp = SCRATCH + off - c.regs[base]
            if disp < -0x80000000 or disp > 0x7fffffff:
                disp = 0
            s = f'[{R32[base]}{disp:+#x}]' if disp else f'[{R32[base]}]'
            return f'{PTR[size]} {s}', [base]
        # index register: one that is still free or already holds a small value (multi-operand
        # snippets would otherwise combine a large fixed base with a scaled index and leave scratch)
        candidates = [r for r in DATA_REGS if r != base and (c.regs[r] is None or c.regs[r] < 0x1000)]
        if not candidates:
            disp = SCRATCH + off - c.fix(base, SCRATCH + off)
            s = f'[{R32[base]}{disp:+#x}]' if disp else f'[{R32[base]}]'
            return f'{PTR[size]} {s}', [base]
        index = rng.choice(candidates)
        scale = rng.choice([1, 2, 4, 8])
        idx_v = rng.randrange(0, 0x10)
        c.fix(index, idx_v)
        idx_v = c.regs[index]
        disp = rng.randrange(-0x20, 0x20)
        base_v = SCRATCH + off - disp - idx_v * scale
        c.fix(base, base_v)
        disp = SCRATCH + off - c.regs[base] - c.regs[index] * scale
        if disp < -0x80000000 or disp > 0x7fffffff:
            disp = 0
        s = f'[{R32[base]}+{R32[index]}*{scale}{disp:+#x}]' if disp else f'[{R32[base]}+{R32[index]}*{scale}]'
        return f'{PTR[size]} {s}', [base, index]

    def rm(self, c, size, exclude=()):
        if self.rng.random() < 0.45:
            return self.mem(c, size)
        name, r = self.reg(size, exclude)
        return name, [r]

    def imm(self, size, signed_byte=False):
        rng = self.rng
        if signed_byte:
            return rng.choice([rng.randrange(-128, 128), rng.choice([0, 1, -1, 0x7f, -0x80])])
        k = rng.random()
        if size == 1:
            return rng.randrange(0, 256)
        if size == 2:
            return rng.choice([rng.randrange(0, 0x10000), rng.choice([0, 1, 0x7fff, 0x8000, 0xffff])])
        return rng.choice([rng.getrandbits(32), rnd32(rng)])

    # ---- case assembly ----------------------------------------------------------------
    def add(self, c, asm, mask=ALLF, **cmp):
        c.asm = asm
        c.mask = mask
        c.cmp.update(cmp)
        self.pending_asm.append((c, asm))
        self.cases.append(c)
        return c

    def add_raw(self, c, asm, code, mask=ALLF, **cmp):
        c.asm = asm
        c.code = code
        c.mask = mask
        c.cmp.update(cmp)
        self.cases.append(c)
        return c

    def assemble_all(self):
        if not self.pending_asm:
            return
        lines = ['.intel_syntax noprefix']
        for _, asm in self.pending_asm:
            for ins in asm.split(';'):
                lines.append(ins.strip())
            lines.append('int3')  # separator marker
        src = '\n'.join(lines) + '\n'
        p = subprocess.run([LLVM_MC, '-triple=i386', '-show-encoding', '-output-asm-variant=1'],
                           input=src, capture_output=True, text=True)
        if p.returncode != 0:
            sys.stderr.write(p.stderr)
            raise SystemExit('llvm-mc failed')
        encs = []
        cur = []
        for line in p.stdout.splitlines():
            if '# encoding:' in line:
                enc = line.split('# encoding:')[1].strip()
                data = bytes(int(x, 16) for x in enc.strip('[]').split(','))
                if line.strip().startswith('int3') and data == b'\xcc':
                    encs.append(b''.join(cur))
                    cur = []
                else:
                    cur.append(data)
        if len(encs) != len(self.pending_asm):
            raise SystemExit(f'assembled {len(encs)} snippets, expected {len(self.pending_asm)}')
        for (c, _), code in zip(self.pending_asm, encs):
            c.code = code
        self.pending_asm = []

    def finalize(self, c):
        rng = self.rng
        for i in range(8):
            if c.regs[i] is None:
                c.regs[i] = rnd32(rng) if i != 4 else SCRATCH + STACK_TOP
        if c.eflags is None:
            c.eflags = rnd_flags(rng)
        if c.df:
            c.eflags |= DF
        if c.mem is None:
            c.mem = bytearray(rng.getrandbits(8) for _ in range(MEM_SIZE))
        if c.fx is None:
            c.fx = default_fx(rng)
        assert len(c.code) <= 64, c.asm


# ---- FPU/SSE initial state ------------------------------------------------------------
def f64_to_f80(x):
    bits = struct.unpack('<Q', struct.pack('<d', x))[0]
    sign = bits >> 63
    exp = (bits >> 52) & 0x7ff
    mant = bits & ((1 << 52) - 1)
    if exp == 0:
        if mant == 0:
            return 0, sign << 15
        e = -1022
        while not (mant & (1 << 52)):
            mant <<= 1
            e -= 1
        mant &= (1 << 52) - 1
        return (1 << 63) | (mant << 11), (sign << 15) | (e + 16383)
    if exp == 0x7ff:
        return (1 << 63) | (mant << 11), (sign << 15) | 0x7fff
    return (1 << 63) | (mant << 11), (sign << 15) | (exp - 1023 + 16383)


def f80_to_f64(mant, se):
    sign = -1.0 if se & 0x8000 else 1.0
    exp = se & 0x7fff
    if exp == 0 and mant == 0:
        return sign * 0.0
    if exp == 0x7fff:
        return sign * float('inf') if (mant & ((1 << 63) - 1)) == 0 else float('nan')
    try:
        return sign * math.ldexp(mant, exp - 16383 - 63)
    except OverflowError:
        return sign * float('inf')


def rnd_double(rng, special=True):
    k = rng.random()
    if special and k < 0.12:
        return rng.choice([0.0, -0.0, 1.0, -1.0, 2.0, 0.5, float('inf'), float('-inf'), float('nan'),
                           1e-310, 3.0, 1e300, -1e300, 65536.0, 0.1, 1e-5, 2147483647.0, -2147483648.0])
    if k < 0.45:
        return rng.uniform(-1000, 1000)
    if k < 0.7:
        return float(rng.randrange(-100000, 100000))
    if k < 0.85:
        return rng.uniform(-1, 1)
    m = rng.uniform(1, 2) * rng.choice([1, -1])
    return math.ldexp(m, rng.randrange(-200, 200))


def default_fx(rng, top=None, valid_mask=None, values=None, xmm=None, fcw=0x027f, mxcsr=0x1f80):
    fx = bytearray(512)
    if top is None:
        top = 0
    struct.pack_into('<HHB', fx, 0, fcw, (top & 7) << 11, valid_mask if valid_mask is not None else 0)
    struct.pack_into('<II', fx, 24, mxcsr, 0xffff)
    for i in range(8):
        v = values[i] if values else 0.0
        m, se = f64_to_f80(v)
        struct.pack_into('<QH', fx, 32 + 16 * i, m, se)
    for i in range(8):
        data = xmm[i] if xmm else bytes(16)
        fx[160 + 16 * i:176 + 16 * i] = data
    return fx


def rnd_fpu_state(g, c, need_free=0, fcw=None, st0=None):
    """Random x87 state: TOP random, at least need_free empty slots above ST(0).
    st0: optional callable returning a value for ST(0) (to keep arguments in a defined range)."""
    rng = g.rng
    top = rng.randrange(0, 8)
    nvalid = rng.randrange(1, 9 - need_free) if need_free < 8 else 0
    # ST(0)..ST(nvalid-1) valid; physical reg of ST(i) = (top+i)&7
    valid_mask = 0
    values = [0.0] * 8  # in ST order for FXSAVE (slot i = ST(i))
    for i in range(nvalid):
        valid_mask |= 1 << ((top + i) & 7)
        values[i] = rnd_double(rng)
    if st0 is not None and nvalid >= 1:
        values[0] = st0()
    if fcw is None:
        k = rng.random()
        if k < 0.6:
            fcw = 0x027f
        elif k < 0.78:
            fcw = rng.choice([0x007f, 0x047f, 0x087f, 0x0c7f])   # single precision, any RC
        elif k < 0.9:
            fcw = 0x037f                                        # extended precision
        else:
            fcw = rng.choice([0x067f, 0x0a7f, 0x0e7f, 0x127f])   # double precision, directed RC
    pc = (fcw >> 8) & 3
    rc = (fcw >> 10) & 3
    if pc == 3 or (pc == 2 and rc != 0):
        c.cmp['tol'] = max(c.cmp.get('tol') or 0, 4e-16)       # f64 emulation cannot be bit-exact here
    c.fx = default_fx(rng, top=top, valid_mask=valid_mask, values=values, fcw=fcw)
    c.cmp['fpu'] = True
    return top, nvalid


# f32 lane specials as raw bit patterns (canonical NaN only: the interpreter is known to differ
# from hardware when two *distinct* NaN payloads meet, so payload variety is deliberately absent)
F32_SPECIAL_BITS = [0x00000000, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000,
                    0x4f000000,   # 2^31
                    0xcf000001,   # -2^31-256 (first f32 below -2^31)
                    0x4effffff]   # 2^31-128 (last f32 below 2^31)
F32_DENORMAL_BITS = [0x00000001, 0x007fffff, 0x80000001, 0x807fffff]


def rnd_f32_bits(rng, denormals=False):
    """One f32 lane as u32 bits. kind 'f32x' (denormals=True) adds f32 denormals: only for
    templates whose semantics do not depend on DAZ/FTZ (moves/logic/compares/unpack/shuffle)."""
    k = rng.random()
    if k < 0.10:
        return rng.choice(F32_SPECIAL_BITS)
    if denormals and k < 0.16:
        return rng.choice(F32_DENORMAL_BITS)
    return struct.unpack('<I', struct.pack('<f', f32_or(rng)))[0]


def rnd_xmm_bytes(rng, kind):
    if kind == 'f32':
        return b''.join(struct.pack('<I', rnd_f32_bits(rng)) for _ in range(4))
    if kind == 'f32x':
        return b''.join(struct.pack('<I', rnd_f32_bits(rng, denormals=True)) for _ in range(4))
    if kind == 'f64':
        return b''.join(struct.pack('<d', rnd_double(rng)) for _ in range(2))
    k = rng.random()
    if k < 0.3:
        return bytes(rng.choice([0, 1, 0x7f, 0x80, 0xff]) for _ in range(16))
    return bytes(rng.getrandbits(8) for _ in range(16))


def f32_or(rng):
    v = rnd_double(rng)
    if math.isfinite(v):
        v = struct.unpack('<f', struct.pack('<f', max(-3e38, min(3e38, v))))[0]
    return v


# Values around the int32 range for float->int conversions (rounding-mode sensitive ones too)
CONV_F32 = [2147483648.0, -2147483904.0, 2147483520.0, -2147483648.0, float('nan'), float('inf'),
            float('-inf'), 0.5, -0.5, 1.5, 2.5, -2.5, 0.0, -0.0, 1e10, -1e10, 123.75, -0.25,
            8388609.0, 16777217.0, 3.0, -7.0, 2147483392.0]
CONV_F64 = [2147483647.0, 2147483648.0, -2147483648.0, -2147483649.0, 2147483647.5, -2147483648.5,
            2147483646.5, -2147483647.5, float('nan'), float('inf'), float('-inf'), 0.5, -0.5, 1.5,
            2.5, -2.5, 0.49999999999999994, 1e300, 0.0, -0.0, 4503599627370497.0, 123.75, -0.25,
            2147483647.9999998, -2147483648.9999995]


def conv_f32(rng):
    return rng.choice(CONV_F32) if rng.random() < 0.7 else f32_or(rng)


def conv_f64(rng):
    return rng.choice(CONV_F64) if rng.random() < 0.7 else rnd_double(rng)


# MXCSR values: default, RC=down/up/trunc (only for float->int conversions: arithmetic ignores RC
# in the emulator), plus DAZ/FTZ combos for LDMXCSR/STMXCSR round trips. Bits >= 16 must stay 0
# (FXRSTOR #GP in the oracle).
MXCSR_RC = [0x1f80, 0x3f80, 0x5f80, 0x7f80]
MXCSR_ALL = [0x1f80, 0x3f80, 0x5f80, 0x7f80, 0x9fc0, 0x1fc0]


def rnd_sse_state(g, c, kind='int', mxcsr=0x1f80):
    rng = g.rng
    xmm = [rnd_xmm_bytes(rng, kind) for _ in range(8)]
    c.fx = default_fx(rng, xmm=xmm, mxcsr=mxcsr)
    c.cmp['xmm'] = True
    c.cmp['mxcsr'] = True


def rnd_mmx_state(g, c):
    rng = g.rng
    # MMX registers alias the x87 mantissas: put random 64-bit patterns, tags valid, top 0
    fx = default_fx(rng, top=0, valid_mask=0xff)
    for i in range(8):
        struct.pack_into('<QH', fx, 32 + 16 * i, rng.getrandbits(64), 0xffff)
    c.fx = fx
    c.cmp['mmx'] = True
    c.cmp['fpu'] = True   # TOP=0 / TW=all-valid side effects of MMX use are compared too


def rnd_mixed_state(g, c, kind='int', mxcsr=0x1f80):
    """MMX + XMM state for the MMX<->XMM instructions (cvtpi2ps, movq2dq, ...)."""
    rng = g.rng
    xmm = [rnd_xmm_bytes(rng, kind) for _ in range(8)]
    fx = default_fx(rng, top=0, valid_mask=0xff, xmm=xmm, mxcsr=mxcsr)
    for i in range(8):
        struct.pack_into('<QH', fx, 32 + 16 * i, rng.getrandbits(64), 0xffff)
    c.fx = fx
    c.cmp['xmm'] = True
    c.cmp['mmx'] = True
    c.cmp['fpu'] = True
    c.cmp['mxcsr'] = True


def set_xmm(c, i, data):
    assert len(data) == 16
    c.fx[160 + 16 * i:176 + 16 * i] = data


def set_mm(c, i, u64):
    struct.pack_into('<Q', c.fx, 32 + 16 * i, u64 & 0xffffffffffffffff)


def patch_bytes(c, operand, data):
    """Queue raw bytes to be written at the address of a memory operand after finalize."""
    c.cmp.setdefault('patchbytes', []).append((operand, data.hex()))


# ======================================================================================
# Suites

def suite_alu(g, n):
    rng = g.rng
    ops2 = ['add', 'adc', 'sub', 'sbb', 'and', 'or', 'xor', 'cmp', 'test']
    for _ in range(n):
        c = Case()
        k = rng.random()
        if k < 0.30:
            op = rng.choice(ops2)
            mask = ALLF if op not in ('and', 'or', 'xor', 'test') else ALLF & ~AF
            size = rng.choice([1, 2, 4, 4, 4])
            form = rng.random()
            if form < 0.25:
                d, _ = g.rm(c, size)
                s, _ = g.reg(size)
                g.add(c, f'{op} {d}, {s}', mask)
            elif form < 0.5 and op != 'test':
                d, _ = g.reg(size)
                s, _ = g.rm(c, size)
                g.add(c, f'{op} {d}, {s}', mask)
            elif form < 0.65:
                d = {1: 'al', 2: 'ax', 4: 'eax'}[size]
                g.add(c, f'{op} {d}, {g.imm(size):#x}', mask)
            elif form < 0.85:
                d, _ = g.rm(c, size)
                g.add(c, f'{op} {d}, {g.imm(size):#x}', mask)
            else:
                d, _ = g.rm(c, 4 if size == 1 else size)
                g.add(c, f'{op} {d}, {g.imm(0, signed_byte=True)}', mask)
        elif k < 0.40:
            op = rng.choice(['inc', 'dec', 'neg', 'not'])
            size = rng.choice([1, 2, 4])
            d, _ = g.rm(c, size)
            g.add(c, f'{op} {d}', ALLF)
        elif k < 0.50:
            # mov / movzx / movsx / lea / xchg / bswap / cmov / setcc
            form = rng.random()
            if form < 0.3:
                size = rng.choice([1, 2, 4])
                if rng.random() < 0.5:
                    d, _ = g.rm(c, size); s, _ = g.reg(size)
                else:
                    d, _ = g.reg(size); s, _ = g.rm(c, size)
                if rng.random() < 0.3:
                    s = f'{g.imm(size):#x}'
                g.add(c, f'mov {d}, {s}')
            elif form < 0.45:
                op = rng.choice(['movzx', 'movsx'])
                dsize = rng.choice([2, 4]); ssize = rng.choice([1, 2]) if dsize == 4 else 1
                d, _ = g.reg(dsize); s, _ = g.rm(c, ssize)
                g.add(c, f'{op} {d}, {s}')
            elif form < 0.55:
                d, _ = g.reg(4); s, _ = g.mem(c, 4)
                g.add(c, f'lea {d}, {s.split("ptr ")[1]}')
            elif form < 0.65:
                size = rng.choice([1, 2, 4])
                d, _ = g.rm(c, size); s, _ = g.reg(size)
                g.add(c, f'xchg {d}, {s}')
            elif form < 0.72:
                d, _ = g.reg(4)
                g.add(c, f'bswap {d}')
            elif form < 0.85:
                cc = rng.choice(['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'])
                size = rng.choice([2, 4]); d, _ = g.reg(size); s, _ = g.rm(c, size)
                g.add(c, f'cmov{cc} {d}, {s}')
            else:
                cc = rng.choice(['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'])
                d, _ = g.rm(c, 1)
                g.add(c, f'set{cc} {d}')
        elif k < 0.62:
            # shifts / rotates
            op = rng.choice(['shl', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr', 'sal'])
            size = rng.choice([1, 2, 4, 4])
            d, _ = g.rm(c, size, exclude=(1,))
            form = rng.random()
            if form < 0.3:
                cnt = 1; cs = '1'
            elif form < 0.7:
                cnt = rng.choice([rng.randrange(0, 32), rng.randrange(0, size * 8 + 1)]); cs = f'{cnt}'
            else:
                cnt = rng.choice([rng.randrange(0, 32), rng.randrange(0, size * 8 + 1)]); cs = 'cl'
                if c.regs[1] is None:
                    c.fix(1, (rnd32(rng) & 0xffffff00) | cnt)
                else:
                    cs = f'{cnt}'
            mcnt = cnt & 31
            if mcnt == 0:
                mask = ALLF
            elif op in ('rol', 'ror', 'rcl', 'rcr'):
                mask = (ALLF & ~OF) if mcnt != 1 else ALLF
            else:
                mask = ALLF & ~AF
                if mcnt != 1:
                    mask &= ~OF
                if mcnt > size * 8:
                    mask &= ~CF  # hardware-specific for over-wide shifts
            g.add(c, f'{op} {d}, {cs}', mask)
        elif k < 0.68:
            op = rng.choice(['shld', 'shrd'])
            size = rng.choice([2, 4, 4])
            d, _ = g.rm(c, size, exclude=(1,)); s, _ = g.reg(size, exclude=(1,))
            cnt = rng.randrange(0, size * 8 + 1) if rng.random() < 0.8 else rng.randrange(0, 32)
            if cnt > size * 8:
                cnt = size * 8
            if rng.random() < 0.5 or c.regs[1] is not None:
                cs = f'{cnt}'
            else:
                cs = 'cl'; c.fix(1, (rnd32(rng) & 0xffffff00) | cnt)
            mask = ALLF if cnt == 0 else (ALLF & ~AF & (~OF if cnt != 1 else ALLF))
            g.add(c, f'{op} {d}, {s}, {cs}', mask)
        elif k < 0.80:
            # mul / imul / div / idiv
            op = rng.choice(['mul', 'imul', 'imul2', 'imul3', 'div', 'idiv'])
            size = rng.choice([1, 2, 4, 4])
            if op in ('mul', 'imul'):
                s, _ = g.rm(c, size)
                g.add(c, f'{op} {s}', CF | OF | DF)
            elif op == 'imul2':
                d, _ = g.reg(rng.choice([2, 4])); s, _ = g.rm(c, 2 if d in R16 else 4)
                g.add(c, f'imul {d}, {s}', CF | OF | DF)
            elif op == 'imul3':
                sz = rng.choice([2, 4]); d, _ = g.reg(sz); s, _ = g.rm(c, sz)
                immv = g.imm(0, signed_byte=True) if rng.random() < 0.5 else g.imm(sz)
                g.add(c, f'imul {d}, {s}, {immv:#x}', CF | OF | DF)
            else:
                s, regs = g.rm(c, size)
                # choose dividend so that quotient fits (mostly)
                divisor = rng.choice([rng.randrange(1, 1 << (size * 8)), rng.randrange(1, 64)])
                if rng.random() < 0.06:
                    divisor = 0
                if op == 'idiv' and rng.random() < 0.5:
                    divisor = (-divisor) & ((1 << (size * 8)) - 1)
                if regs and regs[0] < 8 and s in R8 + R16 + R32:
                    # register divisor: fix its value (low bits)
                    r = regs[0]
                    if size == 1:
                        base = rnd32(rng)
                        if r >= 4:
                            c.fix(r - 4, (base & 0xffff00ff) | (divisor << 8))
                        else:
                            c.fix(r, (base & 0xffffff00) | divisor)
                    elif size == 2:
                        c.fix(r, (rnd32(rng) & 0xffff0000) | divisor)
                    else:
                        c.fix(r, divisor)
                else:
                    c.cmp['divisor'] = (divisor, size)  # patched into memory after finalize
                # dividend: pick quotient q and remainder to build a valid dividend most of the time
                bits = size * 8
                if op == 'div':
                    q = rng.randrange(0, 1 << bits); rem = rng.randrange(0, max(1, divisor))
                    dividend = q * divisor + rem if divisor else rng.getrandbits(bits * 2)
                    if rng.random() < 0.1:
                        dividend = rng.getrandbits(bits * 2)
                else:
                    sdiv = divisor - (1 << bits) if divisor >= (1 << (bits - 1)) else divisor
                    q = rng.randrange(-(1 << (bits - 1)), 1 << (bits - 1))
                    rem = rng.randrange(0, abs(sdiv)) if sdiv else 0
                    if q < 0:
                        rem = -rem
                    dividend = (q * sdiv + rem) & ((1 << (bits * 2)) - 1) if sdiv else rng.getrandbits(bits * 2)
                    if rng.random() < 0.1:
                        dividend = rng.getrandbits(bits * 2)
                if size == 1:
                    c.fix(0, (rnd32(rng) & 0xffff0000) | (dividend & 0xffff))
                elif size == 2:
                    c.fix(0, (rnd32(rng) & 0xffff0000) | (dividend & 0xffff))
                    c.fix(2, (rnd32(rng) & 0xffff0000) | ((dividend >> 16) & 0xffff))
                else:
                    c.fix(0, dividend & 0xffffffff); c.fix(2, (dividend >> 32) & 0xffffffff)
                g.add(c, f'{op} {s}', DF)
        elif k < 0.88:
            # bit ops
            op = rng.choice(['bt', 'bts', 'btr', 'btc', 'bsf', 'bsr'])
            size = rng.choice([2, 4, 4])
            if op in ('bsf', 'bsr'):
                d, _ = g.reg(size); s, _ = g.rm(c, size)
                g.add(c, f'{op} {d}, {s}', ZF | DF)
            else:
                if rng.random() < 0.5:
                    d, regs = g.rm(c, size)
                    g.add(c, f'{op} {d}, {rng.randrange(0, 256):#x}', CF | DF)
                else:
                    d, regs = g.rm(c, size, exclude=())
                    s, sr = g.reg(size, exclude=regs)
                    # keep bit offsets modest for memory forms so the address stays in scratch
                    c.fix(sr, rng.choice([rng.randrange(0, 64), rng.randrange(-64, 64) & 0xffffffff, rnd32(rng) & 0x1f]))
                    g.add(c, f'{op} {d}, {s}', CF | DF)
        elif k < 0.94:
            # conversions & flag ops
            form = rng.random()
            if form < 0.4:
                g.add(c, rng.choice(['cbw', 'cwde', 'cwd', 'cdq']))
            elif form < 0.6:
                g.add(c, rng.choice(['lahf', 'sahf', 'clc', 'stc', 'cmc', 'cld', 'std']))
            elif form < 0.8:
                # xlat
                c.fix(3, SCRATCH + rng.randrange(0, 0x200)); c.fix(0, rnd32(rng))
                g.add(c, 'xlatb')
            else:
                g.add(c, rng.choice(['daa', 'das', 'aaa', 'aas']), ALLF & ~OF if rng.random() < 2 else ALLF)
                if c.asm in ('aaa', 'aas'):
                    c.mask = CF | AF | DF
        else:
            # xadd / cmpxchg / cmpxchg8b
            form = rng.random()
            size = rng.choice([1, 2, 4])
            if form < 0.4:
                d, _ = g.rm(c, size); s, _ = g.reg(size)
                g.add(c, f'xadd {d}, {s}')
            elif form < 0.8:
                d, dr = g.rm(c, size); s, _ = g.reg(size)
                if rng.random() < 0.5 and dr and dr[0] < 8 and d in R8 + R16 + R32:
                    # make it equal to the accumulator sometimes
                    v = rnd32(rng)
                    c.fix(0, v); c.fix(dr[0], v)
                g.add(c, f'cmpxchg {d}, {s}')
            else:
                m, _ = g.mem(c, 8)
                if rng.random() < 0.5:
                    # equal case: patch memory after finalize
                    c.cmp['cx8eq'] = True
                g.add(c, f'cmpxchg8b {m}', ZF | DF)
    return g


def suite_stack(g, n):
    rng = g.rng
    for _ in range(n):
        c = Case()
        k = rng.random()
        c.fix(4, SCRATCH + STACK_TOP)
        if k < 0.25:
            size = rng.choice([2, 4, 4])
            form = rng.random()
            if form < 0.4:
                s, _ = g.reg(size) if rng.random() < 0.8 else ('esp', 4)
                g.add(c, f'push {s}')
            elif form < 0.6:
                s, _ = g.mem(c, size)
                g.add(c, f'push {s}')
            elif form < 0.8:
                g.add(c, f'push {g.imm(0, signed_byte=True)}' if rng.random() < 0.5 else f'push {g.imm(4):#x}')
            else:
                g.add(c, f'push {rng.choice(["es", "ds", "ss", "fs", "gs", "cs"])}')
        elif k < 0.45:
            size = rng.choice([2, 4, 4])
            form = rng.random()
            if form < 0.5:
                d, _ = g.reg(size) if rng.random() < 0.8 else ('esp', 4)
                g.add(c, f'pop {d}')
            else:
                d, _ = g.mem(c, size)
                g.add(c, f'pop {d}')
        elif k < 0.55:
            g.add(c, rng.choice(['pushad', 'popad', 'pushfd', 'popfd', 'pushfw', 'popfw', 'pushaw', 'popaw']))
            if c.asm.startswith('popf'):
                c.mask = ALLF
                c.cmp['popf'] = True  # memory at [esp] is sanitized after finalize (no TF/AC)
        elif k < 0.70:
            lvl = rng.choice([0, 0, 0, 1, 2, 3])
            alloc = rng.choice([0, 4, 8, 0x10, 0x40])
            c.fix(5, SCRATCH + STACK_TOP - 0x80 + rng.randrange(0, 0x40) * 4)
            g.add(c, f'enter {alloc}, {lvl}')
        elif k < 0.80:
            c.fix(5, SCRATCH + STACK_TOP - rng.randrange(0, 0x40) * 4)
            g.add(c, 'leave')
        elif k < 0.90:
            # call rel to a ret inside snippet: call L; jmp E; L: ret [imm]; E:
            imm = rng.choice([0, 0, 4, 8, 0x10])
            ret = b'\xc3' if imm == 0 else b'\xc2' + struct.pack('<H', imm)
            code = b'\xe8\x02\x00\x00\x00' + b'\xeb' + bytes([len(ret)]) + ret
            g.add_raw(c, f'call L; jmp E; L: ret {imm}; E:', code)
        else:
            # call via register / memory to a ret inside the snippet
            # mov reg, CODE+len ; call reg ; ret   (call at offset 5, ret at offset 7)
            r = rng.choice(DATA_REGS)
            code = bytes([0xb8 + r]) + struct.pack('<I', CODE + 9) + bytes([0xff, 0xd0 + r]) + b'\xeb\x01' + b'\xc3'
            g.add_raw(c, f'mov {R32[r]}, L; call {R32[r]}; jmp E; L: ret; E:', code)
    return g


def suite_branch(g, n):
    rng = g.rng
    ccs = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g']
    for _ in range(n):
        c = Case()
        k = rng.random()
        r = rng.choice(DATA_REGS)
        inc = bytes([0x40 + r])  # inc r32 (1 byte)
        if k < 0.4:
            cc = rng.randrange(16)
            # jcc +1 ; inc r ; inc r   (short) or near form
            if rng.random() < 0.5:
                code = bytes([0x70 + cc, 1]) + inc + inc
                g.add_raw(c, f'j{ccs[cc]} L; inc {R32[r]}; L: inc {R32[r]}', code)
            else:
                code = bytes([0x0f, 0x80 + cc]) + struct.pack('<i', 1) + inc + inc
                g.add_raw(c, f'j{ccs[cc]} near L; inc {R32[r]}; L: inc {R32[r]}', code)
        elif k < 0.55:
            # jmp short / near forward and backward:  jmp L; inc; L: inc  |  jmp A; B: inc; jmp E; A: dec; jmp B; E:
            if rng.random() < 0.5:
                code = b'\xeb\x01' + inc + inc
                g.add_raw(c, f'jmp L; inc {R32[r]}; L: inc {R32[r]}', code)
            else:
                dec = bytes([0x48 + r])
                # 0: jmp +3 (to A at 5) ; 2: B: inc ; 3: jmp E (+3) ; 5: A: dec ; 6: jmp B (-6) ; 8: E:
                code = b'\xeb\x03' + inc + b'\xeb\x03' + dec + b'\xeb\xfa'
                g.add_raw(c, f'jmp A; B: inc {R32[r]}; jmp E; A: dec {R32[r]}; jmp B; E:', code)
        elif k < 0.7:
            # loop / loope / loopne / jecxz with small ecx
            op = rng.choice([0xe0, 0xe1, 0xe2, 0xe3])
            if op == 0xe3:
                c.fix(1, rng.choice([0, 1, 2, 5, 0x10000, 0x10001, 0xffffffff]))
                code = bytes([0xe3, 1]) + inc + inc
                g.add_raw(c, f'jecxz L; inc {R32[r]}; L: inc {R32[r]}', code)
            else:
                # L: inc r ; loop L   (loop back, ecx small; r must not be ecx)
                if r == 1:
                    r = 0; inc = bytes([0x40])
                c.fix(1, rng.choice([1, 2, 5, 7]))
                # add: inc r, cmp r, imm? keep simple: inc r ; op L(-3)
                code = inc + bytes([op, 0xfd])
                g.add_raw(c, f'L: inc {R32[r]}; {["loopne", "loope", "loop", ""][op - 0xe0]} L', code, ALLF)
        elif k < 0.85:
            # jmp/call via register / memory table
            r2 = rng.choice([x for x in DATA_REGS if x != r])
            # mov r2, CODE+7 ; jmp r2 ; inc r ; inc r  -> target the second inc
            code = bytes([0xb8 + r2]) + struct.pack('<I', CODE + 8) + bytes([0xff, 0xe0 + r2]) + inc + inc
            g.add_raw(c, f'mov {R32[r2]}, L; jmp {R32[r2]}; inc {R32[r]}; L: inc {R32[r]}', code)
        else:
            # jmp dword ptr [mem]
            m, regs = g.mem(c, 4)
            c.cmp['jmptarget'] = True
            # encode via llvm-mc: jmp dword ptr [..]; inc r; inc r  and patch memory target = CODE+len-1
            g.add(c, f'jmp {m}; inc {R32[r]}; inc {R32[r]}')
    return g


def suite_string(g, n):
    rng = g.rng
    for _ in range(n):
        c = Case()
        size = rng.choice([1, 2, 4])
        sfx = {1: 'b', 2: 'w', 4: 'd'}[size]
        op = rng.choice(['movs', 'stos', 'lods', 'scas', 'cmps'])
        rep = rng.choice(['', '', 'rep ', 'repe ', 'repne ']) if op in ('scas', 'cmps') else rng.choice(['', 'rep '])
        c.df = rng.random() < 0.4
        cnt = rng.choice([0, 1, 2, 3, 8, 16])
        c.fix(1, cnt)
        span = 0x40
        if c.df:
            c.fix(6, SCRATCH + rng.randrange(span, DATA_LIMIT))
            c.fix(7, SCRATCH + rng.randrange(span, DATA_LIMIT))
        else:
            c.fix(6, SCRATCH + rng.randrange(0, DATA_LIMIT - span))
            c.fix(7, SCRATCH + rng.randrange(0, DATA_LIMIT - span))
        mask = ALLF if op in ('scas', 'cmps') else ALLF
        if rng.random() < 0.3:
            # make some data equal so repe/repne terminate at different points
            c.mem = bytearray(rng.getrandbits(8) for _ in range(MEM_SIZE))
            src = (c.regs[6] - SCRATCH) & 0x7ff
            dst = (c.regs[7] - SCRATCH) & 0x7ff
            ln = rng.randrange(0, 12)
            if not c.df and src + ln < MEM_SIZE and dst + ln < MEM_SIZE:
                c.mem[dst:dst + ln] = c.mem[src:src + ln]
            if op == 'scas':
                c.fix(0, struct.unpack('<I', c.mem[dst:dst + 4])[0] if dst + 4 <= MEM_SIZE else 0)
        g.add(c, f'{rep}{op}{sfx}', mask)
    return g


def suite_x87(g, n):
    rng = g.rng
    for _ in range(n):
        c = Case()
        k = rng.random()
        if k < 0.25:
            # register arithmetic
            op = rng.choice(['fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr'])
            top, nvalid = rnd_fpu_state(g, c)
            i = rng.randrange(0, 8)
            form = rng.random()
            if form < 0.4:
                asm = f'{op} st, st({i})'
            elif form < 0.7:
                asm = f'{op} st({i}), st'
            else:
                asm = f'{op}p st({i}), st'
            g.add(c, asm, fpu=True)
        elif k < 0.40:
            # memory arithmetic / integer arithmetic
            op = rng.choice(['fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr', 'fcom', 'fcomp'])
            top, nvalid = rnd_fpu_state(g, c)
            kind = rng.choice(['m32', 'm64', 'i16', 'i32'])
            if kind == 'm32':
                m, _ = g.mem(c, 4); c.cmp['patchf32'] = m
            elif kind == 'm64':
                m, _ = g.mem(c, 8); c.cmp['patchf64'] = m
            elif kind == 'i16':
                m, _ = g.mem(c, 2); op = 'fi' + op[1:]
            else:
                m, _ = g.mem(c, 4); op = 'fi' + op[1:]
            g.add(c, f'{op} {m}', fpu=True, fpucc=op.endswith('com') or op.endswith('comp'))
        elif k < 0.55:
            # loads / stores
            form = rng.random()
            if form < 0.3:
                top, nvalid = rnd_fpu_state(g, c, need_free=1)
                kind = rng.choice(['m32', 'm64', 'm80', 'i16', 'i32', 'i64', 'st'])
                if kind == 'st':
                    g.add(c, f'fld st({rng.randrange(0, 8)})', fpu=True)
                elif kind == 'm32':
                    m, _ = g.mem(c, 4); c.cmp['patchf32'] = m; g.add(c, f'fld {m}', fpu=True)
                elif kind == 'm64':
                    m, _ = g.mem(c, 8); c.cmp['patchf64'] = m; g.add(c, f'fld {m}', fpu=True)
                elif kind == 'm80':
                    m, _ = g.mem(c, 10); c.cmp['patchf80'] = m; g.add(c, f'fld {m}', fpu=True)
                else:
                    sz = {'i16': 2, 'i32': 4, 'i64': 8}[kind]
                    m, _ = g.mem(c, sz); g.add(c, f'fild {m}', fpu=True)
            elif form < 0.7:
                top, nvalid = rnd_fpu_state(g, c)
                kind = rng.choice(['m32', 'm64', 'm80', 'i16', 'i32', 'i64', 'st', 'stp', 'tt16', 'tt32', 'tt64'])
                if kind in ('st', 'stp'):
                    g.add(c, f'fst{"p" if kind == "stp" else ""} st({rng.randrange(0, 8)})', fpu=True)
                elif kind in ('m32', 'm64'):
                    m, _ = g.mem(c, 4 if kind == 'm32' else 8)
                    g.add(c, f'{rng.choice(["fst", "fstp"])} {m}', fpu=True)
                elif kind == 'm80':
                    m, _ = g.mem(c, 10); g.add(c, f'fstp {m}', fpu=True)
                elif kind.startswith('tt'):
                    sz = {'tt16': 2, 'tt32': 4, 'tt64': 8}[kind]
                    m, _ = g.mem(c, sz); g.add(c, f'fisttp {m}', fpu=True)
                else:
                    sz = {'i16': 2, 'i32': 4, 'i64': 8}[kind]
                    m, _ = g.mem(c, sz)
                    op = 'fistp' if sz == 8 else rng.choice(['fist', 'fistp'])
                    g.add(c, f'{op} {m}', fpu=True)
            else:
                # constants
                top, nvalid = rnd_fpu_state(g, c, need_free=1)
                g.add(c, rng.choice(['fld1', 'fldz', 'fldpi', 'fldl2e', 'fldl2t', 'fldlg2', 'fldln2']), fpu=True, tol=1e-15)
        elif k < 0.70:
            # unary / transcendental
            op = rng.choice(['fchs', 'fabs', 'fsqrt', 'frndint', 'f2xm1', 'fyl2x', 'fyl2xp1', 'fsin', 'fcos',
                             'fsincos', 'fptan', 'fpatan', 'fscale', 'fxtract', 'fprem', 'fprem1', 'ftst', 'fxam',
                             'fxch', 'fincstp', 'fdecstp', 'ffree', 'fnop', 'fucom', 'fucomp', 'fucompp', 'fcompp',
                             'fcomi', 'fucomi', 'fcomip', 'fucomip'])
            need_free = 1 if op in ('fsincos', 'fptan', 'fxtract') else 0
            st0 = None
            if op == 'f2xm1':
                st0 = lambda: rng.uniform(-1, 1)
            elif op == 'fyl2xp1':
                st0 = lambda: rng.uniform(-0.29, 0.41)
            elif op == 'fyl2x':
                st0 = lambda: abs(rnd_double(rng, special=False)) + 1e-300
            elif op in ('fsin', 'fcos', 'fsincos', 'fptan'):
                st0 = lambda: rng.choice([rng.uniform(-10, 10), rng.uniform(-1e6, 1e6), 1e300, 0.0])
            top, nvalid = rnd_fpu_state(g, c, need_free=need_free, st0=st0)
            if op in ('fprem', 'fprem1') and nvalid >= 2:
                # keep the exponent difference below 64: the partial-remainder chunking (N) is
                # implementation-dependent on real hardware
                st1 = struct.unpack_from('<QH', c.fx, 48)
                v1 = f80_to_f64(*st1)
                if v1 == 0 or not math.isfinite(v1):
                    v1 = 1.5
                v0 = v1 * rng.uniform(-1e15, 1e15)
                m, se = f64_to_f80(v0)
                struct.pack_into('<QH', c.fx, 32, m, se)
            tol = 1e-13 if op in ('f2xm1', 'fyl2x', 'fyl2xp1', 'fsin', 'fcos', 'fsincos', 'fptan', 'fpatan', 'fsqrt', 'fscale', 'fprem', 'fprem1') else None
            fpucc = op in ('ftst', 'fxam', 'fucom', 'fucomp', 'fucompp', 'fcompp', 'fprem', 'fprem1')
            if op in ('fxch', 'ffree', 'fucom', 'fucomp'):
                asm = f'{op} st({rng.randrange(0, 8)})'
            elif op in ('fcomi', 'fucomi', 'fcomip', 'fucomip'):
                asm = f'{op} st, st({rng.randrange(0, 8)})'
            else:
                asm = op
            if op in ('fsin', 'fcos', 'fsincos', 'fptan'):
                # keep arguments in a sane range (|x| < 2^63 else C2 set / unchanged)
                pass
            g.add(c, asm, ALLF if op in ('fcomi', 'fucomi', 'fcomip', 'fucomip') else ALLF, fpu=True, tol=tol, fpucc=fpucc)
        elif k < 0.80:
            # control word / status word
            top, nvalid = rnd_fpu_state(g, c)
            form = rng.random()
            if form < 0.3:
                m, _ = g.mem(c, 2); c.cmp['patchcw'] = m
                g.add(c, f'fldcw {m}', fpu=True)
            elif form < 0.5:
                m, _ = g.mem(c, 2); g.add(c, f'fnstcw {m}', fpu=True)
            elif form < 0.7:
                m, _ = g.mem(c, 2); g.add(c, f'fnstsw {m}', fpu=True, fpusw=True)
            elif form < 0.85:
                g.add(c, 'fnstsw ax', fpu=True, fpusw=True)
            else:
                g.add(c, rng.choice(['fninit', 'fnclex']), fpu=True)
        elif k < 0.90:
            # fcmovcc
            top, nvalid = rnd_fpu_state(g, c)
            cc = rng.choice(['b', 'e', 'be', 'u', 'nb', 'ne', 'nbe', 'nu'])
            g.add(c, f'fcmov{cc} st, st({rng.randrange(0, 8)})', fpu=True)
        else:
            # sequences: fild; fmul; fistp  (common codegen)
            top, nvalid = rnd_fpu_state(g, c, need_free=2)
            m1, _ = g.mem(c, 4); m2, _ = g.mem(c, 4); c.cmp['patchf32'] = m2
            m3, _ = g.mem(c, 4)
            g.add(c, f'fild {m1}; fmul {m2}; fistp {m3}', fpu=True)
    return g


def suite_sse(g, n):
    rng = g.rng
    ps_ops = ['addps', 'subps', 'mulps', 'divps', 'minps', 'maxps', 'sqrtps', 'andps', 'andnps', 'orps', 'xorps',
              'unpcklps', 'unpckhps', 'movaps', 'movups', 'cvtdq2ps', 'cvtps2dq', 'cvttps2dq']
    ss_ops = ['addss', 'subss', 'mulss', 'divss', 'minss', 'maxss', 'sqrtss', 'movss', 'ucomiss', 'comiss', 'cvtss2sd']
    pd_ops = ['addpd', 'subpd', 'mulpd', 'divpd', 'minpd', 'maxpd', 'sqrtpd', 'andpd', 'andnpd', 'orpd', 'xorpd',
              'unpcklpd', 'unpckhpd', 'movapd', 'movupd', 'cvtpd2ps', 'cvtps2pd', 'cvtdq2pd', 'cvtpd2dq', 'cvttpd2dq']
    sd_ops = ['addsd', 'subsd', 'mulsd', 'divsd', 'minsd', 'maxsd', 'sqrtsd', 'movsd', 'ucomisd', 'comisd', 'cvtsd2ss']
    int_ops = ['paddb', 'paddw', 'paddd', 'paddq', 'psubb', 'psubw', 'psubd', 'psubq', 'paddsb', 'paddsw', 'paddusb',
               'paddusw', 'psubsb', 'psubsw', 'psubusb', 'psubusw', 'pand', 'pandn', 'por', 'pxor', 'pcmpeqb', 'pcmpeqw',
               'pcmpeqd', 'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'pmullw', 'pmulhw', 'pmulhuw', 'pmuludq', 'pmaddwd', 'psadbw',
               'pavgb', 'pavgw', 'pminub', 'pmaxub', 'pminsw', 'pmaxsw', 'punpcklbw', 'punpcklwd', 'punpckldq',
               'punpckhbw', 'punpckhwd', 'punpckhdq', 'packsswb', 'packssdw', 'packuswb', 'psllw', 'pslld', 'psllq',
               'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad', 'movdqa', 'movdqu', 'punpcklqdq', 'punpckhqdq']
    shift_ops = ('psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad')
    # ops that do not go through the DAZ/FTZ-sensitive arithmetic path: they may see f32 denormals
    f32x_ops = {'andps', 'andnps', 'orps', 'xorps', 'unpcklps', 'unpckhps', 'movaps', 'movups', 'movss',
                'ucomiss', 'comiss'}
    # shift counts for the register/memory count forms (full 64-bit count semantics)
    shift_counts = [0, 1, 7, 15, 16, 31, 32, 63, 64, 65, 255, 256, 1 << 32, 1 << 40]

    def rc_for(op, nontrunc_ops):
        # MXCSR rounding control is honoured by the emulator only for the non-truncating
        # float->int conversions; arithmetic always rounds to nearest (WASM cannot honour RC there)
        if op in nontrunc_ops and rng.random() < 0.5:
            return rng.choice(MXCSR_RC)
        return 0x1f80

    def xmm_with_prefix(c, i, prefix):
        """Overwrite the low bytes of xmm i with prefix, keep the rest random."""
        cur = bytearray(c.fx[160 + 16 * i:176 + 16 * i])
        cur[0:len(prefix)] = prefix
        set_xmm(c, i, bytes(cur))
        return f'xmm{i}'

    # ---- extension templates (MMX, SSE3, conversions, MXCSR, streaming stores, ...) ----------
    def t_pshufw(c):
        rnd_mmx_state(g, c)
        s = g.mem(c, 8)[0] if rng.random() < 0.4 else f'mm{rng.randrange(8)}'
        g.add(c, f'pshufw mm{rng.randrange(8)}, {s}, {rng.randrange(256):#x}')

    def t_pxdq(c):
        rnd_sse_state(g, c, 'int')
        g.add(c, f'{rng.choice(["psrldq", "pslldq"])} xmm{rng.randrange(8)}, {rng.randrange(18)}')

    def t_movq_mm(c):
        rnd_mmx_state(g, c)
        d, s = rng.randrange(8), rng.randrange(8)
        form = rng.random()
        if form < 0.3:
            g.add(c, f'movq mm{d}, mm{s}')                                   # 0F 6F /r
        elif form < 0.55:
            g.add(c, f'movq mm{d}, {g.mem(c, 8)[0]}')
        elif form < 0.8:
            g.add(c, f'movq {g.mem(c, 8)[0]}, mm{s}')
        else:
            # 0F 7F /r register form (MOVQ Qq,Pq): llvm-mc always picks 0F 6F for mm,mm
            g.add_raw(c, f'movq mm{d}, mm{s} # 0f 7f', bytes([0x0f, 0x7f, 0xc0 | (s << 3) | d]))

    def t_movq_xmm(c):
        rnd_sse_state(g, c, 'int')
        d, s = rng.randrange(8), rng.randrange(8)
        form = rng.random()
        if form < 0.3:
            g.add(c, f'movq xmm{d}, xmm{s}')                                 # F3 0F 7E /r
        elif form < 0.55:
            g.add(c, f'movq xmm{d}, {g.mem(c, 8)[0]}')                      # F3 0F 7E
        elif form < 0.8:
            g.add(c, f'movq {g.mem(c, 8)[0]}, xmm{s}')                      # 66 0F D6
        else:
            # 66 0F D6 /r register form (MOVQ Wq,Vq): zero-extends the destination
            g.add_raw(c, f'movq xmm{d}, xmm{s} # 66 0f d6', bytes([0x66, 0x0f, 0xd6, 0xc0 | (s << 3) | d]))

    def t_emms(c):
        rnd_mmx_state(g, c)
        g.add(c, 'emms')

    def t_movnt(c):
        op = rng.choice(['movntq', 'movntps', 'movntpd', 'movntdq', 'movnti'])
        if op == 'movntq':
            rnd_mmx_state(g, c)
            g.add(c, f'movntq {g.mem(c, 8)[0]}, mm{rng.randrange(8)}')
        elif op == 'movnti':
            r, _ = g.reg(4)
            g.add(c, f'movnti {g.mem(c, 4)[0]}, {r}')
        else:
            rnd_sse_state(g, c, {'movntps': 'f32x', 'movntpd': 'f64', 'movntdq': 'int'}[op])
            g.add(c, f'{op} {g.mem(c, 16, align=16)[0]}, xmm{rng.randrange(8)}')

    def t_cvt_pi(c):
        op = rng.choice(['cvtpi2ps', 'cvtpi2pd', 'cvtps2pi', 'cvttps2pi', 'cvtpd2pi', 'cvttpd2pi'])
        mxcsr = rc_for(op, ('cvtps2pi', 'cvtpd2pi'))
        use_mem = rng.random() < 0.4
        if op.startswith('cvtpi'):
            rnd_mixed_state(g, c, 'f32' if op == 'cvtpi2ps' else 'f64', mxcsr)
            s = g.mem(c, 8)[0] if use_mem else f'mm{rng.randrange(8)}'
            g.add(c, f'{op} xmm{rng.randrange(8)}, {s}')
        elif op.endswith('ps2pi'):
            rnd_mixed_state(g, c, 'f32', mxcsr)
            if use_mem:
                s = g.mem(c, 8)[0]
                patch_bytes(c, s, b''.join(struct.pack('<f', conv_f32(rng)) for _ in range(2)))
            else:
                s = xmm_with_prefix(c, rng.randrange(8), b''.join(struct.pack('<f', conv_f32(rng)) for _ in range(4)))
            g.add(c, f'{op} mm{rng.randrange(8)}, {s}')
        else:
            rnd_mixed_state(g, c, 'f64', mxcsr)
            data = b''.join(struct.pack('<d', conv_f64(rng)) for _ in range(2))
            if use_mem:
                s = g.mem(c, 16, align=16)[0]
                patch_bytes(c, s, data)
            else:
                s = xmm_with_prefix(c, rng.randrange(8), data)
            g.add(c, f'{op} mm{rng.randrange(8)}, {s}')

    def t_movq2dq(c):
        rnd_mixed_state(g, c, 'int')
        if rng.random() < 0.5:
            g.add(c, f'movq2dq xmm{rng.randrange(8)}, mm{rng.randrange(8)}')
        else:
            g.add(c, f'movdq2q mm{rng.randrange(8)}, xmm{rng.randrange(8)}')

    def t_mm_gpr(c):
        rnd_mmx_state(g, c)
        op = rng.choice(['pextrw', 'pinsrw', 'pmovmskb', 'movd', 'movd_out'])
        r, _ = g.reg(4)
        m = rng.randrange(8)
        # PEXTRW/PINSRW on mm use imm8[1:0]; a few cases probe the masking of higher bits
        imm = rng.randrange(4) if rng.random() < 0.8 else rng.randrange(4, 8)
        if op == 'pextrw':
            g.add(c, f'pextrw {r}, mm{m}, {imm}')
        elif op == 'pinsrw':
            s, _ = g.rm(c, 4)
            if s not in R32:
                s = s.replace('dword ptr', 'word ptr')
            g.add(c, f'pinsrw mm{m}, {s}, {imm}')
        elif op == 'pmovmskb':
            g.add(c, f'pmovmskb {r}, mm{m}')
        elif op == 'movd':
            g.add(c, f'movd mm{m}, {g.rm(c, 4)[0]}')
        else:
            g.add(c, f'movd {g.rm(c, 4)[0]}, mm{m}')

    def t_mxcsr(c):
        v = rng.choice(MXCSR_ALL)
        if rng.random() < 0.5:
            rnd_sse_state(g, c, 'int', mxcsr=rng.choice(MXCSR_ALL))
            m, _ = g.mem(c, 4)
            patch_bytes(c, m, struct.pack('<I', v))
            g.add(c, f'ldmxcsr {m}')
        else:
            rnd_sse_state(g, c, 'int', mxcsr=v)
            g.add(c, f'stmxcsr {g.mem(c, 4)[0]}')

    def t_sse3(c):
        op = rng.choice(['addsubps', 'addsubpd', 'haddps', 'haddpd', 'hsubps', 'hsubpd', 'movsldup', 'movshdup',
                         'movddup', 'lddqu'])
        kind = {'movsldup': 'f32x', 'movshdup': 'f32x', 'movddup': 'f64', 'lddqu': 'int'}.get(
            op, 'f32' if op.endswith('ps') else 'f64')
        rnd_sse_state(g, c, kind)
        d = f'xmm{rng.randrange(8)}'
        if op == 'lddqu' or rng.random() < 0.45:   # lddqu is memory-source only
            if op == 'lddqu':
                s, _ = g.mem(c, 16, align=1)
            elif op == 'movddup':
                s, _ = g.mem(c, 8); c.cmp['patchf64'] = s
            elif kind == 'f64':
                s, _ = g.mem(c, 16, align=16); c.cmp['patchf64x2'] = s
            else:
                s, _ = g.mem(c, 16, align=16); c.cmp['patchf32x4x' if kind == 'f32x' else 'patchf32x4'] = s
        else:
            s = f'xmm{rng.randrange(8)}'
        g.add(c, f'{op} {d}, {s}')

    def t_psadbw_mm(c):
        rnd_mmx_state(g, c)
        s = g.mem(c, 8)[0] if rng.random() < 0.4 else f'mm{rng.randrange(8)}'
        g.add(c, f'psadbw mm{rng.randrange(8)}, {s}')

    def t_movhl(c):
        rnd_sse_state(g, c, 'f32x')
        op = rng.choice(['movlps', 'movhps', 'movlhps', 'movhlps', 'movlps_out', 'movhps_out', 'movlpd', 'movhpd',
                         'movlpd_out', 'movhpd_out'])
        x = f'xmm{rng.randrange(8)}'
        if op in ('movlhps', 'movhlps'):
            g.add(c, f'{op} {x}, xmm{rng.randrange(8)}')
        elif op.endswith('_out'):
            g.add(c, f'{op[:-4]} {g.mem(c, 8)[0]}, {x}')
        else:
            g.add(c, f'{op} {x}, {g.mem(c, 8)[0]}')

    def t_punpck_mm(c):
        rnd_mmx_state(g, c)
        op = rng.choice(['punpcklbw', 'punpcklwd', 'punpckldq', 'punpckhbw', 'punpckhwd', 'punpckhdq'])
        if rng.random() < 0.7:
            s, _ = g.mem(c, 4 if op.startswith('punpckl') else 8)   # low forms take Qd (4 bytes)
        else:
            s = f'mm{rng.randrange(8)}'
        g.add(c, f'{op} mm{rng.randrange(8)}, {s}')

    def t_shift_cnt(c):
        op = rng.choice(shift_ops)
        cnt = rng.choice(shift_counts)
        use_mem = rng.random() < 0.4
        if rng.random() < 0.4:
            rnd_mmx_state(g, c)
            if use_mem:
                s, _ = g.mem(c, 8)
                patch_bytes(c, s, struct.pack('<Q', cnt))
            else:
                i = rng.randrange(8); set_mm(c, i, cnt); s = f'mm{i}'
            g.add(c, f'{op} mm{rng.randrange(8)}, {s}')
        else:
            rnd_sse_state(g, c, 'int')
            # only the low qword of the count operand matters: keep the high qword random
            if use_mem:
                s, _ = g.mem(c, 16, align=16)
                patch_bytes(c, s, struct.pack('<Q', cnt) + bytes(rng.getrandbits(8) for _ in range(8)))
            else:
                s = xmm_with_prefix(c, rng.randrange(8), struct.pack('<Q', cnt))
            g.add(c, f'{op} xmm{rng.randrange(8)}, {s}')

    def t_cvt_si(c):
        op = rng.choice(['cvtss2si', 'cvtsd2si', 'cvttss2si', 'cvttsd2si'])
        single = 'ss' in op
        rnd_sse_state(g, c, 'f32' if single else 'f64', rc_for(op, ('cvtss2si', 'cvtsd2si')))
        r, _ = g.reg(4)
        data = struct.pack('<f', conv_f32(rng)) if single else struct.pack('<d', conv_f64(rng))
        if rng.random() < 0.4:
            s, _ = g.mem(c, len(data))
            patch_bytes(c, s, data)
        else:
            s = xmm_with_prefix(c, rng.randrange(8), data)
        g.add(c, f'{op} {r}, {s}')

    def t_cvt_pdq(c):
        op = rng.choice(['cvtps2dq', 'cvttps2dq', 'cvtpd2dq', 'cvttpd2dq'])
        single = 'ps' in op
        rnd_sse_state(g, c, 'f32' if single else 'f64', rc_for(op, ('cvtps2dq', 'cvtpd2dq')))
        if single:
            data = b''.join(struct.pack('<f', conv_f32(rng)) for _ in range(4))
        else:
            data = b''.join(struct.pack('<d', conv_f64(rng)) for _ in range(2))
        if rng.random() < 0.4:
            s, _ = g.mem(c, 16, align=16)
            patch_bytes(c, s, data)
        else:
            s = xmm_with_prefix(c, rng.randrange(8), data)
        g.add(c, f'{op} xmm{rng.randrange(8)}, {s}')

    ext_templates = [(2, t_pshufw), (2, t_pxdq), (3, t_movq_mm), (3, t_movq_xmm), (1, t_emms), (3, t_movnt),
                     (6, t_cvt_pi), (2, t_movq2dq), (3, t_mm_gpr), (2, t_mxcsr), (8, t_sse3), (1, t_psadbw_mm),
                     (3, t_movhl), (3, t_punpck_mm), (5, t_shift_cnt), (4, t_cvt_si), (4, t_cvt_pdq)]
    ext_weights = [w for w, _ in ext_templates]

    for _ in range(n):
        c = Case()
        k = rng.random()
        if k < 0.12:
            op = rng.choice(ps_ops)
            kind = 'f32x' if op in f32x_ops else 'f32'
            rnd_sse_state(g, c, kind, rc_for(op, ('cvtps2dq',)))
            d = f'xmm{rng.randrange(8)}'
            if rng.random() < 0.4:
                s, _ = g.mem(c, 16, align=16); c.cmp['patchf32x4x' if kind == 'f32x' else 'patchf32x4'] = s
            else:
                s = f'xmm{rng.randrange(8)}'
            if op in ('movaps', 'movups') and rng.random() < 0.5:
                s, d = d, (g.mem(c, 16, align=16)[0])
            g.add(c, f'{op} {d}, {s}', xmm=True)
        elif k < 0.21:
            op = rng.choice(ss_ops)
            rnd_sse_state(g, c, 'f32x' if op in f32x_ops else 'f32')
            d = f'xmm{rng.randrange(8)}'
            if rng.random() < 0.4:
                s, _ = g.mem(c, 4); c.cmp['patchf32'] = s
            else:
                s = f'xmm{rng.randrange(8)}'
            if op == 'movss' and rng.random() < 0.5:
                s, d = d, g.mem(c, 4)[0]
            mask = ALLF if op in ('ucomiss', 'comiss') else ALLF
            g.add(c, f'{op} {d}, {s}', mask, xmm=True)
        elif k < 0.32:
            op = rng.choice(pd_ops)
            rnd_sse_state(g, c, 'f64', rc_for(op, ('cvtpd2dq',)))
            d = f'xmm{rng.randrange(8)}'
            if rng.random() < 0.4:
                if op in ('cvtdq2pd', 'cvtps2pd'):
                    s, _ = g.mem(c, 8)
                else:
                    s, _ = g.mem(c, 16, align=16); c.cmp['patchf64x2'] = s
            else:
                s = f'xmm{rng.randrange(8)}'
            if op in ('movapd', 'movupd') and rng.random() < 0.5:
                s, d = d, g.mem(c, 16, align=16)[0]
            g.add(c, f'{op} {d}, {s}', xmm=True)
        elif k < 0.40:
            op = rng.choice(sd_ops)
            rnd_sse_state(g, c, 'f64')
            d = f'xmm{rng.randrange(8)}'
            if rng.random() < 0.4:
                s, _ = g.mem(c, 8); c.cmp['patchf64'] = s
            else:
                s = f'xmm{rng.randrange(8)}'
            if op == 'movsd' and rng.random() < 0.5:
                s, d = d, g.mem(c, 8)[0]
            g.add(c, f'{op} {d}, {s}', xmm=True)
        elif k < 0.60:
            op = rng.choice(int_ops)
            use_mmx = rng.random() < 0.3 and op not in ('movdqa', 'movdqu', 'punpcklqdq', 'punpckhqdq', 'paddq', 'psubq', 'pmuludq')
            if use_mmx:
                rnd_mmx_state(g, c)
                d = f'mm{rng.randrange(8)}'
                if rng.random() < 0.4:
                    s, _ = g.mem(c, 4 if op in ('punpcklbw', 'punpcklwd', 'punpckldq') else 8)
                else:
                    s = f'mm{rng.randrange(8)}'
                if op in shift_ops and rng.random() < 0.5:
                    s = f'{rng.choice([0, 1, 3, 7, 8, 15, 16, 31, 32, 63, 64, 200])}'
                g.add(c, f'{op} {d}, {s}', mmx=True)
            else:
                rnd_sse_state(g, c, 'int')
                d = f'xmm{rng.randrange(8)}'
                if rng.random() < 0.4:
                    s, _ = g.mem(c, 16, align=16 if op != 'movdqu' else 1)
                else:
                    s = f'xmm{rng.randrange(8)}'
                if op in shift_ops and rng.random() < 0.5:
                    s = f'{rng.choice([0, 1, 3, 7, 8, 15, 16, 31, 32, 63, 64, 200])}'
                if op in ('movdqa', 'movdqu') and rng.random() < 0.5:
                    s, d = d, g.mem(c, 16, align=16 if op == 'movdqa' else 1)[0]
                g.add(c, f'{op} {d}, {s}', xmm=True)
        elif k < 0.71:
            # shuffles, moves between gpr/xmm, conversions with gpr, extract/insert, masks, cmp predicates
            form = rng.random()
            if form < 0.15:
                rnd_sse_state(g, c, 'f32x')
                op = rng.choice(['shufps', 'pshufd', 'pshuflw', 'pshufhw'])
                g.add(c, f'{op} xmm{rng.randrange(8)}, xmm{rng.randrange(8)}, {rng.randrange(256):#x}', xmm=True)
            elif form < 0.25:
                rnd_sse_state(g, c, 'f64')
                g.add(c, f'shufpd xmm{rng.randrange(8)}, xmm{rng.randrange(8)}, {rng.randrange(4)}', xmm=True)
            elif form < 0.4:
                rnd_sse_state(g, c, 'int')
                op = rng.choice(['movd', 'movq', 'movd_out', 'movq_out', 'pextrw', 'pinsrw', 'pmovmskb', 'movmskps', 'movmskpd'])
                x = f'xmm{rng.randrange(8)}'
                r, rn = g.reg(4)
                if op == 'movd':
                    s, _ = g.rm(c, 4); g.add(c, f'movd {x}, {s}', xmm=True)
                elif op == 'movq':
                    s, _ = g.mem(c, 8) if rng.random() < 0.5 else (f'xmm{rng.randrange(8)}', None)
                    g.add(c, f'movq {x}, {s}', xmm=True)
                elif op == 'movd_out':
                    d, _ = g.rm(c, 4); g.add(c, f'movd {d}, {x}', xmm=True)
                elif op == 'movq_out':
                    d, _ = g.mem(c, 8); g.add(c, f'movq {d}, {x}', xmm=True)
                elif op == 'pextrw':
                    g.add(c, f'pextrw {r}, {x}, {rng.randrange(8)}', xmm=True)
                elif op == 'pinsrw':
                    s, _ = g.rm(c, 4)
                    if s in R32:
                        pass
                    else:
                        s = s.replace('dword ptr', 'word ptr')
                    g.add(c, f'pinsrw {x}, {s}, {rng.randrange(8)}', xmm=True)
                elif op == 'pmovmskb':
                    g.add(c, f'pmovmskb {r}, {x}', xmm=True)
                elif op == 'movmskps':
                    g.add(c, f'movmskps {r}, {x}', xmm=True)
                else:
                    g.add(c, f'movmskpd {r}, {x}', xmm=True)
            elif form < 0.6:
                kind = rng.choice(['f32', 'f64'])
                op = rng.choice(['cvtsi2ss', 'cvtsi2sd', 'cvtss2si', 'cvtsd2si', 'cvttss2si', 'cvttsd2si'])
                rnd_sse_state(g, c, kind, rc_for(op, ('cvtss2si', 'cvtsd2si')))
                x = f'xmm{rng.randrange(8)}'
                r, rn = g.reg(4)
                if op.startswith('cvtsi'):
                    s, _ = g.rm(c, 4)
                    g.add(c, f'{op} {x}, {s}', xmm=True)
                else:
                    if rng.random() < 0.4:
                        s, _ = g.mem(c, 4 if 'ss' in op else 8)
                        c.cmp['patchf32' if 'ss' in op else 'patchf64'] = s
                    else:
                        s = x
                    g.add(c, f'{op} {r}, {s}', xmm=True)
            elif form < 0.8:
                kind = rng.choice(['f32x', 'f64'])
                rnd_sse_state(g, c, kind)
                op = {'f32x': rng.choice(['cmpps', 'cmpss']), 'f64': rng.choice(['cmppd', 'cmpsd'])}[kind]
                g.add(c, f'{op} xmm{rng.randrange(8)}, xmm{rng.randrange(8)}, {rng.randrange(8)}', xmm=True)
            else:
                rnd_sse_state(g, c, 'f32x')
                op = rng.choice(['movlps', 'movhps', 'movlhps', 'movhlps', 'movlps_out', 'movhps_out', 'movlpd', 'movhpd'])
                x = f'xmm{rng.randrange(8)}'
                if op in ('movlhps', 'movhlps'):
                    g.add(c, f'{op} {x}, xmm{rng.randrange(8)}', xmm=True)
                elif op.endswith('_out'):
                    m, _ = g.mem(c, 8); g.add(c, f'{op[:-4]} {m}, {x}', xmm=True)
                else:
                    m, _ = g.mem(c, 8); g.add(c, f'{op} {x}, {m}', xmm=True)
        else:
            rng.choices(ext_templates, weights=ext_weights)[0][1](c)
    return g


def suite_verify_int(g, n):
    """Adversarial coverage for the packed-integer / MMX translator (translate-sse-int.js):
    forms that suite_sse does not exercise — MASKMOVQ/MASKMOVDQU (real stores to [EDI]),
    PADDQ/PSUBQ/PMULUDQ on mm, PEXTRW/PINSRW immediates beyond the lane count, PSHUF* with a
    memory source, same-register forms (shift by itself, pack/unpack/psadbw of a register with
    itself), wide immediate shift counts, and multi-instruction regions where lazy ALU flags
    must survive the vector handlers."""
    rng = g.rng
    int_ops = ['paddb', 'paddw', 'paddd', 'paddq', 'psubb', 'psubw', 'psubd', 'psubq', 'paddsb', 'paddsw', 'paddusb',
               'paddusw', 'psubsb', 'psubsw', 'psubusb', 'psubusw', 'pand', 'pandn', 'por', 'pxor', 'pcmpeqb', 'pcmpeqw',
               'pcmpeqd', 'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'pmullw', 'pmulhw', 'pmulhuw', 'pmuludq', 'pmaddwd', 'psadbw',
               'pavgb', 'pavgw', 'pminub', 'pmaxub', 'pminsw', 'pmaxsw', 'punpcklbw', 'punpcklwd', 'punpckldq',
               'punpckhbw', 'punpckhwd', 'punpckhdq', 'packsswb', 'packssdw', 'packuswb', 'psllw', 'pslld', 'psllq',
               'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad']
    shift_ops = ('psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad')
    mm_only_xmm = ('punpcklqdq', 'punpckhqdq')
    # flag-defining ALU ops (all of CF PF AF ZF SF OF written) for the lazy-flags sequences
    alu_ops = ['add', 'sub', 'xor', 'and', 'or', 'cmp']

    def mask_bytes(n):
        k = rng.random()
        if k < 0.2:
            return bytes([0x80] * n)
        if k < 0.35:
            return bytes(n)
        if k < 0.5:
            return bytes(0x80 if i & 1 else 0x7f for i in range(n))
        return bytes(rng.getrandbits(8) for _ in range(n))

    def t_maskmov(c):
        off = rng.randrange(0, DATA_LIMIT - 16)
        c.fix(7, SCRATCH + off)
        d, m = rng.randrange(8), rng.randrange(8)
        if rng.random() < 0.5:
            rnd_mmx_state(g, c)
            set_mm(c, m, int.from_bytes(mask_bytes(8), 'little'))
            g.add(c, f'maskmovq mm{d}, mm{m}')
        else:
            rnd_sse_state(g, c, 'int')
            set_xmm(c, m, mask_bytes(16))
            g.add(c, f'maskmovdqu xmm{d}, xmm{m}')

    def t_mm_q(c):
        rnd_mmx_state(g, c)
        op = rng.choice(['paddq', 'psubq', 'pmuludq'])
        s = g.mem(c, 8)[0] if rng.random() < 0.4 else f'mm{rng.randrange(8)}'
        g.add(c, f'{op} mm{rng.randrange(8)}, {s}')

    def t_extr_imm(c):
        op = rng.choice(['pextrw', 'pinsrw'])
        r, _ = g.reg(4)
        imm = rng.choice([rng.randrange(8, 256), rng.choice([8, 9, 15, 16, 0x7f, 0x80, 0xff])])
        if rng.random() < 0.5:
            rnd_mmx_state(g, c)
            x = f'mm{rng.randrange(8)}'
            imm = rng.choice([imm, rng.randrange(4, 8)])
        else:
            rnd_sse_state(g, c, 'int')
            x = f'xmm{rng.randrange(8)}'
        if op == 'pextrw':
            g.add(c, f'pextrw {r}, {x}, {imm}')
        else:
            s, _ = g.rm(c, 4)
            if s not in R32:
                s = s.replace('dword ptr', 'word ptr')
            g.add(c, f'pinsrw {x}, {s}, {imm}')

    def t_pshuf_mem(c):
        if rng.random() < 0.3:
            rnd_mmx_state(g, c)
            g.add(c, f'pshufw mm{rng.randrange(8)}, {g.mem(c, 8)[0]}, {rng.randrange(256):#x}')
        else:
            rnd_sse_state(g, c, 'int')
            op = rng.choice(['pshufd', 'pshuflw', 'pshufhw'])
            g.add(c, f'{op} xmm{rng.randrange(8)}, {g.mem(c, 16, align=16)[0]}, {rng.randrange(256):#x}')

    def t_same_reg(c):
        op = rng.choice(int_ops + list(mm_only_xmm))
        if rng.random() < 0.4 and op not in mm_only_xmm:
            rnd_mmx_state(g, c)
            x = f'mm{rng.randrange(8)}'
        else:
            rnd_sse_state(g, c, 'int')
            x = f'xmm{rng.randrange(8)}'
        g.add(c, f'{op} {x}, {x}')

    def t_shift_imm(c):
        op = rng.choice(shift_ops + ('pslldq', 'psrldq'))
        cnt = rng.choice([rng.randrange(0, 256), rng.choice([0, 1, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 255])])
        if op in ('pslldq', 'psrldq') or rng.random() < 0.5:
            rnd_sse_state(g, c, 'int')
            g.add(c, f'{op} xmm{rng.randrange(8)}, {cnt}')
        else:
            rnd_mmx_state(g, c)
            g.add(c, f'{op} mm{rng.randrange(8)}, {cnt}')

    def t_movd_mem(c):
        if rng.random() < 0.5:
            rnd_mmx_state(g, c)
            x = f'mm{rng.randrange(8)}'
        else:
            rnd_sse_state(g, c, 'int')
            x = f'xmm{rng.randrange(8)}'
        m, _ = g.mem(c, 4)
        if rng.random() < 0.5:
            g.add(c, f'movd {m}, {x}')
        else:
            g.add(c, f'movd {x}, {m}')

    def t_seq(c):
        """2-4 instruction regions: ALU op (lazy flags) + vector ops + gpr extraction."""
        form = rng.random()
        # the memory operand (if any) is built first so the ALU op never rewrites its base/index
        m, mregs = (g.mem(c, 8) if form < 0.8 else g.mem(c, 16, align=16)) if form >= 0.6 else (None, [])
        r1, a = g.reg(4, exclude=tuple(mregs))
        r2, b = g.reg(4, exclude=(a, *mregs))
        r3, _ = g.reg(4, exclude=(a, b, *mregs))
        alu = rng.choice(alu_ops)
        if form < 0.35:
            rnd_mmx_state(g, c)
            d, s = rng.randrange(8), rng.randrange(8)
            op = rng.choice(['paddd', 'pxor', 'pcmpeqb', 'psubw', 'pmaddwd', 'packssdw', 'punpcklbw'])
            g.add(c, f'{alu} {r1}, {r2}; movd mm{d}, {r1}; {op} mm{d}, mm{s}; movd {r3}, mm{d}')
        elif form < 0.6:
            rnd_sse_state(g, c, 'int')
            d, s = rng.randrange(8), rng.randrange(8)
            op = rng.choice(['paddd', 'pxor', 'pcmpeqb', 'psubw', 'pmaddwd', 'packssdw', 'punpcklbw', 'pshufd'])
            imm = f', {rng.randrange(256):#x}' if op == 'pshufd' else ''
            g.add(c, f'{alu} {r1}, {r2}; movd xmm{d}, {r1}; {op} xmm{d}, xmm{s}{imm}; pextrw {r3}, xmm{d}, {rng.randrange(8)}')
        elif form < 0.8:
            rnd_mmx_state(g, c)
            d, s = rng.randrange(8), rng.randrange(8)
            cnt = rng.choice([0, 3, 8, 16, 31, 32, 63, 64, 200])
            g.add(c, f'movq mm{d}, mm{s}; {rng.choice(shift_ops)} mm{d}, {cnt}; movq {m}, mm{d}; pmovmskb {r1}, mm{d}; {alu} {r1}, {r2}')
        else:
            rnd_sse_state(g, c, 'int')
            d, s = rng.randrange(8), rng.randrange(8)
            g.add(c, f'{alu} {r1}, {r2}; movdqa xmm{d}, xmm{s}; {rng.choice(["psrldq", "pslldq"])} xmm{d}, {rng.randrange(17)}; '
                     f'movdqa {m}, xmm{d}; pmovmskb {r3}, xmm{d}')

    def t_branch(c):
        """Two-block regions (hand-encoded): cmp eax, ebx; jcc over a vector op; tail reads the
        result. The vector handler runs with the lazy-flag state unknown at translate time."""
        d, s = rng.randrange(8), rng.randrange(8)
        modrm = 0xc0 | (d << 3) | s
        v = rnd32(rng)
        c.fix(0, v)
        c.fix(3, v if rng.random() < 0.5 else rnd32(rng))
        cmp_ = bytes([0x39, 0xd8])                                       # cmp eax, ebx
        jcc = rng.choice([(0x75, 'jne'), (0x74, 'je'), (0x77, 'ja'), (0x7c, 'jl')])
        form = rng.random()
        if form < 0.4:
            rnd_mmx_state(g, c)
            body = bytes([0x0f, 0xfc, modrm]); body_asm = f'paddb mm{d}, mm{s}'
            tail = bytes([0x0f, 0x7e, 0xc0 | (d << 3) | 1]); tail_asm = f'movd ecx, mm{d}'
        elif form < 0.7:
            rnd_sse_state(g, c, 'int')
            body = bytes([0x66, 0x0f, 0xef, modrm]); body_asm = f'pxor xmm{d}, xmm{s}'
            imm = rng.randrange(256)
            tail = bytes([0x66, 0x0f, 0xc5, 0xc0 | (2 << 3) | d, imm]); tail_asm = f'pextrw edx, xmm{d}, {imm}'
        else:
            rnd_mmx_state(g, c)
            body = bytes([0x0f, 0x77]); body_asm = 'emms'
            tail = bytes([0x0f, 0xfc, modrm]); tail_asm = f'paddb mm{d}, mm{s}'
        if rng.random() < 0.3:
            tail = b''; tail_asm = ''                                        # jump straight to the end
        code = cmp_ + bytes([jcc[0], len(body)]) + body + tail
        asm = f'cmp eax, ebx; {jcc[1]} +{len(body)}; {body_asm}' + (f'; {tail_asm}' if tail_asm else '')
        g.add_raw(c, asm, code)

    def t_top(c):
        """MMX use with an initial x87 TOP != 0: the instruction resets TOP to 0 and marks all
        tags valid; fnstsw before/after observes TOP. All MM registers hold the same value because
        the conformance runner seeds mm_k from FXSAVE slot k irrespective of TOP."""
        top = rng.randrange(1, 8)
        fx = default_fx(rng, top=top, valid_mask=0xff)
        val = rng.getrandbits(64)
        for i in range(8):
            struct.pack_into('<QH', fx, 32 + 16 * i, val, 0xffff)
        c.fx = fx
        c.cmp['mmx'] = True
        c.cmp['fpu'] = True
        d, s = rng.randrange(8), rng.randrange(8)
        op = rng.choice(['paddb', 'pxor', 'pcmpeqw', 'psrlq', 'movq', 'emms', 'pmovmskb', 'movd'])
        if op == 'emms':
            ins = 'emms'
        elif op == 'pmovmskb':
            ins = f'pmovmskb ecx, mm{d}'
        elif op == 'movd':
            ins = f'movd mm{d}, edx' if rng.random() < 0.5 else f'movd edx, mm{d}'
        elif op == 'psrlq':
            ins = f'psrlq mm{d}, {rng.choice([0, 5, 64])}'
        else:
            ins = f'{op} mm{d}, mm{s}'
        k = rng.random()
        if k < 0.4:
            g.add(c, f'{ins}; fnstsw ax')
        elif k < 0.7:
            g.add(c, f'fnstsw ax; {ins}')
        else:
            # absolute address: the snippet rewrites eax/ecx/edx, so no register-based operand
            g.add(c, f'fnstsw ax; {ins}; fnstsw word ptr [0x{SCRATCH + rng.randrange(0, DATA_LIMIT - 2):x}]')

    templates = [(5, t_maskmov), (2, t_mm_q), (3, t_extr_imm), (3, t_pshuf_mem), (4, t_same_reg), (3, t_shift_imm),
                 (2, t_movd_mem), (5, t_seq), (4, t_branch), (3, t_top)]
    weights = [w for w, _ in templates]
    for _ in range(n):
        rng.choices(templates, weights=weights)[0][1](Case())
    return g


# ======================================================================================
# verify_float: adversarial coverage for the SSE float translator (translate-sse-float.js):
# register-form store encodings (0F 11 / 0F 29 / F3 0F 11 / F2 0F 11 with a register rm),
# COMIS* between lazy ALU flags and flag consumers, MIN/MAX/CMP with special lanes on both
# sides, arithmetic on f32/f64 denormals (MXCSR default), float->int conversions at the range
# and tie boundaries under every RC (including MXCSR loaded at run time), float<->float and
# int->float conversions on overflow/underflow/NaN/rounding, SSE3 with specials, memory forms of
# the shuffles/logic and multi-instruction sequences chaining XMM state, GPRs and flags.

VF_F32 = [0.0, -0.0, float('inf'), float('-inf'), float('nan'), 1.0, -1.0, 0.5, 2.0, 1e-40, -1e-40,
          1e-45, 1.17549435e-38, 3.4028235e38, -3.4028235e38, 123.5, 16777217.0]
VF_F64 = [0.0, -0.0, float('inf'), float('-inf'), float('nan'), 1.0, -1.0, 0.5, 2.0, 5e-324, -5e-324,
          2.2250738585072014e-308, 1e-310, 1e300, -1e300, 1.7976931348623157e308, 123.5,
          9007199254740993.0]
# magnitudes whose sums/products/quotients land in the denormal range (or overflow)
VF_TINY32 = [1e-20, -1e-20, 1e-38, 3e-39, 1e-40, 1.4e-45, 2e-19, 1e19, 3e38, -3e38, 1.17549435e-38, 5.877472e-39]
VF_TINY64 = [1e-160, -1e-160, 1e-308, 5e-324, 2.2250738585072014e-308, 1e-310, 1e160, 1e308, -1e308, 3e-308]
# f64 values whose f32 rounding is interesting (overflow, underflow to denormal/zero, ties)
VF_D2S = [3.5e38, -3.5e38, 3.4028235677973366e38, 3.4028234663852886e38, 1e-40, 1e-46, 7e-46, 1.5e-45,
          1.00000005960464477539, 1.0000000596046448, 0.99999997019767761, 16777217.0, 16777219.0,
          -16777217.0, 2.2250738585072014e-308, 5e-324]
VF_INTS = [16777217, 0x7fffffff, 0x80000000, 33554433, -16777217, 0x7ffffffe, 1, 0, 0x00ffffff, 0x01000001,
           -1, 0x7fffff80, 0x7fffffc0, 0x7fffff40]


def vf_f32(rng, p=0.5):
    return rng.choice(VF_F32) if rng.random() < p else f32_or(rng)


def vf_f64(rng, p=0.5):
    return rng.choice(VF_F64) if rng.random() < p else rnd_double(rng)


def vf_pack32(vals):
    return b''.join(struct.pack('<f', v) for v in vals)


def vf_pack64(vals):
    return b''.join(struct.pack('<d', v) for v in vals)


def vf_pack_i32(vals):
    return b''.join(struct.pack('<i', v - (1 << 32) if v >= (1 << 31) else v) for v in vals)


def suite_verify_float(g, n):
    rng = g.rng

    def rc_for_cvt(op):
        # MXCSR.RC is honoured by the emulator only for the non-truncating float->int conversions
        return rng.choice(MXCSR_RC) if op in ('cvtps2pi', 'cvtpd2pi') else 0x1f80

    def lanes32(p=0.5):
        return [vf_f32(rng, p) for _ in range(4)]

    def lanes64(p=0.5):
        return [vf_f64(rng, p) for _ in range(2)]

    def src_operand(c, single, packed, data=None):
        """Random source: xmm register with special lanes, or memory (m32/m64/m128) holding them.
        Returns (operand, regs, lane0 value bytes)."""
        size = 16 if packed else (4 if single else 8)
        if data is None:
            data = vf_pack32(lanes32()) if single else vf_pack64(lanes64())
        if rng.random() < 0.4:
            s, regs = g.mem(c, size, align=16 if size == 16 else 1)
            patch_bytes(c, s, data[:size])
            return s, regs, data
        i = rng.randrange(8)
        set_xmm(c, i, data)
        return f'xmm{i}', [], data

    def t_store_form(c):
        rnd_sse_state(g, c, 'f32x')
        d, s = rng.randrange(8), rng.randrange(8)
        name, code = rng.choice([
            ('movups', b'\x0f\x11'), ('movupd', b'\x66\x0f\x11'), ('movaps', b'\x0f\x29'), ('movapd', b'\x66\x0f\x29'),
            ('movss', b'\xf3\x0f\x11'), ('movsd', b'\xf2\x0f\x11')])
        g.add_raw(c, f'{name} xmm{d}, xmm{s} # store-form encoding', code + bytes([0xc0 | (s << 3) | d]))

    def t_comis(c):
        op = rng.choice(['comiss', 'ucomiss', 'comisd', 'ucomisd'])
        single = op.endswith('ss')
        rnd_sse_state(g, c, 'f32' if single else 'f64')
        d = rng.randrange(8)
        a = vf_f32(rng, 0.7) if single else vf_f64(rng, 0.7)
        set_xmm(c, d, vf_pack32([a] + lanes32()[:3]) if single else vf_pack64([a, vf_f64(rng)]))
        data = None
        if rng.random() < 0.3:   # equal lane 0 (ZF path)
            data = vf_pack32([a] + lanes32()[:3]) if single else vf_pack64([a, vf_f64(rng)])
        s, mregs, _ = src_operand(c, single, False, data)
        r1, a1 = g.reg(4, exclude=tuple(mregs))
        r2, a2 = g.reg(4, exclude=(a1, *mregs))
        r3, a3 = g.reg(4, exclude=(a1, a2, *mregs))
        b8, _ = g.reg(1)
        pre = rng.choice(['', '', f'add {r1}, {r2}; ', f'sub {r1}, {r2}; ', f'and {r1}, {r2}; ', f'inc {r1}; ',
                          f'cmp {r1}, {r2}; ', f'shl {r1}, 3; '])
        post = rng.choice(['', '', f'; sbb {r3}, {r3}', f'; adc {r3}, {r1}', f'; setb {b8}', f'; sete {b8}',
                           f'; setp {b8}', f'; seta {b8}', f'; setbe {b8}', f'; cmovb {r3}, {r1}',
                           f'; cmove {r3}, {r2}', f'; cmovp {r3}, {r1}', f'; cmovae {r3}, {r2}', '; lahf'])
        g.add(c, f'{pre}{op} xmm{d}, {s}{post}')

    def t_minmax(c):
        op = rng.choice(['minps', 'maxps', 'minss', 'maxss', 'minpd', 'maxpd', 'minsd', 'maxsd'])
        single = op.endswith('ps') or op.endswith('ss')
        packed = op[-2] == 'p'
        rnd_sse_state(g, c, 'f32' if single else 'f64')
        d = rng.randrange(8)
        set_xmm(c, d, vf_pack32(lanes32(0.6)) if single else vf_pack64(lanes64(0.6)))
        s = f'xmm{d}' if rng.random() < 0.1 else src_operand(c, single, packed)[0]
        g.add(c, f'{op} xmm{d}, {s}')

    def t_cmp(c):
        op = rng.choice(['cmpps', 'cmppd', 'cmpss', 'cmpsd'])
        single = op.endswith('ps') or op.endswith('ss')
        packed = op[-2] == 'p'
        rnd_sse_state(g, c, 'f32' if single else 'f64')
        d = rng.randrange(8)
        set_xmm(c, d, vf_pack32(lanes32(0.6)) if single else vf_pack64(lanes64(0.6)))
        s = f'xmm{d}' if rng.random() < 0.1 else src_operand(c, single, packed)[0]
        g.add(c, f'{op} xmm{d}, {s}, {rng.randrange(8)}')

    def t_arith(c):
        op = rng.choice(['add', 'sub', 'mul', 'div', 'sqrt']) + rng.choice(['ps', 'ss', 'pd', 'sd'])
        single = op.endswith('ps') or op.endswith('ss')
        packed = op[-2] == 'p'
        rnd_sse_state(g, c, 'f32' if single else 'f64')
        tiny = VF_TINY32 if single else VF_TINY64
        spec = VF_F32 if single else VF_F64

        def lane():
            k = rng.random()
            if k < 0.6:
                return rng.choice(tiny)
            if k < 0.75:
                return rng.choice(spec)
            return f32_or(rng) if single else rnd_double(rng)
        d = rng.randrange(8)
        if single:
            set_xmm(c, d, vf_pack32([lane() for _ in range(4)]))
            data = vf_pack32([lane() for _ in range(4)])
        else:
            set_xmm(c, d, vf_pack64([lane() for _ in range(2)]))
            data = vf_pack64([lane() for _ in range(2)])
        s = f'xmm{d}' if rng.random() < 0.1 else src_operand(c, single, packed, data)[0]
        g.add(c, f'{op} xmm{d}, {s}')

    def t_cvt_rc(c):
        op = rng.choice(['cvtss2si', 'cvtsd2si', 'cvttss2si', 'cvttsd2si', 'cvtps2dq', 'cvtpd2dq', 'cvttps2dq',
                         'cvttpd2dq', 'cvtps2pi', 'cvtpd2pi', 'cvttps2pi', 'cvttpd2pi'])
        single = 'ss' in op or 'ps' in op
        mxcsr = rng.choice(MXCSR_RC)
        to_mm = op.endswith('pi')
        scalar = '2si' in op
        if to_mm:
            rnd_mixed_state(g, c, 'f32' if single else 'f64', mxcsr)
        else:
            rnd_sse_state(g, c, 'f32' if single else 'f64', mxcsr)
        vals = [conv_f32(rng) for _ in range(4)] if single else [conv_f64(rng) for _ in range(2)]
        data = vf_pack32(vals) if single else vf_pack64(vals)
        size = (4 if single else 8) if scalar else (8 if (to_mm and single) else 16)
        mregs = []
        if rng.random() < 0.4:
            s, mregs = g.mem(c, size, align=16 if size == 16 else 1)
            patch_bytes(c, s, data[:size])
        else:
            i = rng.randrange(8)
            set_xmm(c, i, data)
            s = f'xmm{i}'
        pre = ''
        if rng.random() < 0.3:
            # MXCSR loaded at run time: RC must be read after LDMXCSR, not assumed from the entry state
            m, mr = g.mem(c, 4)
            mregs = mregs + mr
            patch_bytes(c, m, struct.pack('<I', rng.choice(MXCSR_RC)))
            pre = f'ldmxcsr {m}; '
        if scalar:
            dst = g.reg(4, exclude=tuple(mregs))[0]
        elif to_mm:
            dst = f'mm{rng.randrange(8)}'
        else:
            dst = f'xmm{rng.randrange(8)}'
        g.add(c, f'{pre}{op} {dst}, {s}')

    def t_cvt_fp(c):
        op = rng.choice(['cvtss2sd', 'cvtsd2ss', 'cvtps2pd', 'cvtpd2ps', 'cvtsi2ss', 'cvtsi2sd', 'cvtdq2ps',
                         'cvtdq2pd', 'cvtpi2ps', 'cvtpi2pd'])
        d = rng.randrange(8)
        if op in ('cvtss2sd', 'cvtps2pd'):
            rnd_sse_state(g, c, 'f32x')
            data = vf_pack32(lanes32(0.7))
            s = src_operand(c, True, False, data)[0] if op == 'cvtss2sd' else src_operand(c, False, False, data)[0]
        elif op in ('cvtsd2ss', 'cvtpd2ps'):
            rnd_sse_state(g, c, 'f64')
            vals = [rng.choice(VF_D2S) if rng.random() < 0.5 else vf_f64(rng, 0.5) for _ in range(2)]
            s = src_operand(c, False, op == 'cvtpd2ps', vf_pack64(vals))[0]
        elif op in ('cvtsi2ss', 'cvtsi2sd'):
            rnd_sse_state(g, c, 'f32' if op == 'cvtsi2ss' else 'f64')
            v = rng.choice(VF_INTS) if rng.random() < 0.7 else rnd32(rng)
            if rng.random() < 0.4:
                s, _ = g.mem(c, 4)
                patch_bytes(c, s, vf_pack_i32([v]))
            else:
                s, r = g.reg(4)
                c.fix(r, v)
        elif op in ('cvtdq2ps', 'cvtdq2pd'):
            rnd_sse_state(g, c, 'f32' if op == 'cvtdq2ps' else 'f64')
            ints = [rng.choice(VF_INTS) if rng.random() < 0.7 else rnd32(rng) for _ in range(4)]
            s = src_operand(c, False, op == 'cvtdq2ps', vf_pack_i32(ints))[0]
        else:
            rnd_mixed_state(g, c, 'f32' if op == 'cvtpi2ps' else 'f64')
            ints = [rng.choice(VF_INTS) if rng.random() < 0.7 else rnd32(rng) for _ in range(2)]
            if rng.random() < 0.4:
                s, _ = g.mem(c, 8)
                patch_bytes(c, s, vf_pack_i32(ints))
            else:
                i = rng.randrange(8)
                set_mm(c, i, struct.unpack('<Q', vf_pack_i32(ints))[0])
                s = f'mm{i}'
        g.add(c, f'{op} xmm{d}, {s}')

    def t_sse3(c):
        op = rng.choice(['haddps', 'hsubps', 'addsubps', 'haddpd', 'hsubpd', 'addsubpd', 'movddup', 'movsldup',
                         'movshdup'])
        single = op.endswith('ps') or op in ('movsldup', 'movshdup')
        rnd_sse_state(g, c, 'f32x' if single else 'f64')
        d = rng.randrange(8)
        set_xmm(c, d, vf_pack32(lanes32(0.6)) if single else vf_pack64(lanes64(0.6)))
        if op == 'movddup':
            s = src_operand(c, False, False)[0]
        else:
            s = f'xmm{d}' if rng.random() < 0.15 else src_operand(c, single, True)[0]
        g.add(c, f'{op} xmm{d}, {s}')

    def t_shuf_mem(c):
        op = rng.choice(['shufps', 'shufpd', 'unpcklps', 'unpckhps', 'unpcklpd', 'unpckhpd', 'andnps', 'andnpd',
                         'orps', 'xorpd', 'andps', 'movlhps', 'movhlps'])
        single = op.endswith('ps')
        rnd_sse_state(g, c, 'f32x' if single else 'f64')
        d = rng.randrange(8)
        if op in ('movlhps', 'movhlps'):
            g.add(c, f'{op} xmm{d}, xmm{rng.randrange(8)}')
            return
        s, _ = g.mem(c, 16, align=16)
        c.cmp['patchf32x4x' if single else 'patchf64x2'] = s
        imm = f', {rng.randrange(256):#x}' if op == 'shufps' else (f', {rng.randrange(4)}' if op == 'shufpd' else '')
        g.add(c, f'{op} xmm{d}, {s}{imm}')

    def t_mxcsr_rt(c):
        rnd_sse_state(g, c, 'int', mxcsr=rng.choice(MXCSR_ALL))
        v = rng.choice([0x0000, 0x1f80, 0xffff, 0x7f80, 0x9fc0, 0x1fc0, 0x0040, 0x8000, 0x6000, 0x1f80 | 0x3f])
        m1, r1 = g.mem(c, 4)
        m2, _ = g.mem(c, 4)
        patch_bytes(c, m1, struct.pack('<I', v))
        g.add(c, f'ldmxcsr {m1}; stmxcsr {m2}')

    def t_seq(c):
        form = rng.random()
        if form < 0.15:
            rnd_sse_state(g, c, 'f32')
            m1, _ = g.mem(c, 16, align=16)
            patch_bytes(c, m1, vf_pack32(lanes32(0.3)))
            m2, _ = g.mem(c, 16, align=16)
            patch_bytes(c, m2, vf_pack32(lanes32(0.3)))
            m3, _ = g.mem(c, 16, align=16)
            d, s = rng.randrange(8), rng.randrange(8)
            g.add(c, f'movaps xmm{d}, {m1}; mulps xmm{d}, xmm{s}; addps xmm{d}, {m2}; movups {m3}, xmm{d}')
        elif form < 0.3:
            rnd_sse_state(g, c, 'f32')   # default RC: CVTSI2SS honours RC on hardware but not in the emulator
            a, b = rng.randrange(8), rng.randrange(8)
            set_xmm(c, a, vf_pack32([conv_f32(rng) for _ in range(4)]))
            r1, a1 = g.reg(4)
            r2, _ = g.reg(4, exclude=(a1,))
            g.add(c, f'cvttss2si {r1}, xmm{a}; add {r1}, {r2}; cvtsi2ss xmm{b}, {r1}')
        elif form < 0.45:
            rnd_sse_state(g, c, 'f64')   # default RC (ADDSD would honour RC on hardware only)
            m4, mr = g.mem(c, 4)
            patch_bytes(c, m4, vf_pack_i32([rng.choice(VF_INTS) if rng.random() < 0.5 else rnd32(rng)]))
            m8, mr2 = g.mem(c, 8)
            patch_bytes(c, m8, vf_pack64([conv_f64(rng)]))
            r1, a1 = g.reg(4, exclude=tuple(mr + mr2))
            r2, _ = g.reg(4, exclude=(a1, *mr, *mr2))
            a = rng.randrange(8)
            g.add(c, f'mov {r1}, {m4}; cvtsi2sd xmm{a}, {r1}; addsd xmm{a}, {m8}; cvtsd2si {r2}, xmm{a}')
        elif form < 0.6:
            rnd_sse_state(g, c, 'f32x')
            a, b = rng.randrange(8), rng.randrange(8)
            set_xmm(c, b, vf_pack32(lanes32(0.6)))
            m4, mr = g.mem(c, 4)
            patch_bytes(c, m4, vf_pack32([vf_f32(rng, 0.6)]))
            b8, _ = g.reg(1)
            r3, _ = g.reg(4, exclude=tuple(mr))
            g.add(c, f'sqrtss xmm{a}, xmm{b}; ucomiss xmm{a}, {m4}; setnb {b8}; movmskps {r3}, xmm{a}')
        elif form < 0.75:
            rnd_sse_state(g, c, 'f64')
            a, b, x = rng.randrange(8), rng.randrange(8), rng.randrange(8)
            set_xmm(c, a, vf_pack64(lanes64(0.6)))
            set_xmm(c, b, vf_pack64(lanes64(0.6)))
            m16, mr = g.mem(c, 16, align=16)
            c.cmp['patchf64x2'] = m16
            r1, a1 = g.reg(4, exclude=tuple(mr))
            r2, _ = g.reg(4, exclude=(a1, *mr))
            g.add(c, f'comisd xmm{a}, xmm{b}; cmovb {r1}, {r2}; movapd xmm{x}, xmm{a}; unpcklpd xmm{x}, {m16}')
        elif form < 0.88:
            rnd_sse_state(g, c, 'f32', rng.choice(MXCSR_RC))
            a, b, x = rng.randrange(8), rng.randrange(8), rng.randrange(8)
            set_xmm(c, b, vf_pack32([conv_f32(rng) for _ in range(4)]))
            m16, _ = g.mem(c, 16, align=16)
            patch_bytes(c, m16, vf_pack32([conv_f32(rng) for _ in range(4)]))
            g.add(c, f'shufps xmm{a}, {m16}, {rng.randrange(256):#x}; minps xmm{a}, xmm{b}; cvtps2dq xmm{x}, xmm{a}')
        else:
            rnd_sse_state(g, c, 'f32x')
            a, b = rng.randrange(8), rng.randrange(8)
            set_xmm(c, b, vf_pack32(lanes32(0.6)))
            m4, mr = g.mem(c, 4)
            patch_bytes(c, m4, vf_pack32([vf_f32(rng, 0.6)]))
            m4b, mr2 = g.mem(c, 4)
            r1, _ = g.reg(4, exclude=tuple(mr + mr2))
            g.add(c, f'movss xmm{a}, {m4}; addss xmm{a}, xmm{b}; movss {m4b}, xmm{a}; comiss xmm{a}, xmm{b}; sbb {r1}, {r1}')

    def t_unaligned(c):
        op = rng.choice(['movups', 'movupd', 'lddqu', 'movdqu', 'movss', 'movsd', 'movlps', 'movhps', 'movlpd',
                         'movhpd', 'movddup', 'cvtps2pd', 'cvtdq2pd', 'comisd', 'cvtsd2si'])
        rnd_sse_state(g, c, 'f32x' if op in ('movups', 'movss', 'movlps', 'movhps', 'cvtps2pd') else 'f64')
        x = f'xmm{rng.randrange(8)}'
        size = 16 if op in ('movups', 'movupd', 'lddqu', 'movdqu') else 4 if op in ('movss',) else 8
        # odd offsets, including 16-byte accesses straddling a 16-byte boundary
        m, _ = g.mem(c, size, align=1)
        if size == 8:
            patch_bytes(c, m, vf_pack64([vf_f64(rng)]))
        if op == 'cvtsd2si':
            g.add(c, f'{op} {g.reg(4)[0]}, {m}')
        elif op not in ('lddqu', 'movddup', 'cvtps2pd', 'cvtdq2pd', 'comisd') and rng.random() < 0.5:
            g.add(c, f'{op} {m}, {x}')
        else:
            g.add(c, f'{op} {x}, {m}')

    def t_branch(c):
        # a conditional branch splits the region (hand-encoded: llvm-mc -show-encoding leaves branch
        # fixups unresolved): the SSE handlers see E.lz === null at the target block entry
        rnd_sse_state(g, c, 'f32')
        a, b = rng.randrange(8), rng.randrange(8)
        set_xmm(c, a, vf_pack32(lanes32(0.6)))
        set_xmm(c, b, vf_pack32(lanes32(0.6)))
        r1, a1 = g.reg(4)
        r2, a2 = g.reg(4, exclude=(a1,))
        b8, a8 = g.reg(1)
        mod = lambda reg, rm: 0xc0 | (reg << 3) | rm
        form = rng.random()
        if form < 0.25:
            code = bytes([0x0f, 0x2f, mod(a, b), 0x72, 0x03, 0x0f, 0x58, mod(a, b), 0x0f, 0x50, mod(a1, a), 0x19, mod(a2, a2)])
            asm = f'comiss xmm{a}, xmm{b}; jb 1f; addps xmm{a}, xmm{b}; 1: movmskps {r1}, xmm{a}; sbb {r2}, {r2}'
        elif form < 0.5:
            cc, ccb = rng.choice([('b', 0x92), ('e', 0x94), ('p', 0x9a), ('a', 0x97)])
            code = bytes([0x85, mod(a1, a1), 0x74, 0x03, 0x0f, 0x2e, mod(a, b), 0x0f, ccb, mod(0, a8)])
            asm = f'test {r1}, {r1}; jz 1f; ucomiss xmm{a}, xmm{b}; 1: set{cc} {b8}'
        elif form < 0.75:
            code = bytes([0x39, mod(a2, a1), 0x75, 0x04, 0xf3, 0x0f, 0x5d, mod(a, b), 0x0f, 0x2f, mod(a, b), 0x0f, 0x42, mod(a1, a2)])
            asm = f'cmp {r1}, {r2}; jne 1f; minss xmm{a}, xmm{b}; 1: comiss xmm{a}, xmm{b}; cmovb {r1}, {r2}'
        else:
            code = bytes([0x0f, 0x2f, mod(a, b), 0x73, 0x03, 0x0f, 0x59, mod(a, b), 0x0f, 0x51, mod(a, a), 0x0f, 0x50, mod(a1, a), 0x0f, 0x9a, mod(0, a8)])
            asm = f'comiss xmm{a}, xmm{b}; jae 1f; mulps xmm{a}, xmm{b}; 1: sqrtps xmm{a}, xmm{a}; movmskps {r1}, xmm{a}; setp {b8}'
        g.add_raw(c, asm, code)

    def t_x87_mix(c):
        # MMX-coupled conversions after x87 pushes: TOP := 0 and all tags valid (the JIT's cached
        # TOP local must be reset). No x87 push/pop afterwards: a push would overflow (stack fault,
        # skipped by the JIT harness) and a pop rotates the FXSAVE MM slots the runner compares at TOP 0.
        # (The mixed state has all 8 x87 slots valid, so no x87 push may precede the MMX op; a pop
        # afterwards would rotate the FXSAVE MM slots the runner compares at TOP 0; STMXCSR after a
        # conversion would expose the exception flags the emulator never sets.)
        op = rng.choice(['cvtpi2ps', 'cvtpi2pd', 'cvtps2pi', 'cvttps2pi', 'cvtpd2pi', 'cvttpd2pi'])
        single = 'ps' in op
        rnd_mixed_state(g, c, 'f32' if single else 'f64', rc_for_cvt(op))
        x, m = rng.randrange(8), rng.randrange(8)
        vals = [conv_f32(rng) for _ in range(4)] if single else [conv_f64(rng) for _ in range(2)]
        set_xmm(c, x, vf_pack32(vals) if single else vf_pack64(vals))
        dst, src = (f'xmm{x}', f'mm{m}') if op.startswith('cvtpi') else (f'mm{m}', f'xmm{x}')
        pre = rng.choice(['', 'fnclex; ', 'fnstsw ax; '])
        post = rng.choice(['; emms', '', '; fnstsw ax'])
        g.add(c, f'{pre}{op} {dst}, {src}{post}')

    templates = [(2, t_store_form), (6, t_comis), (5, t_minmax), (5, t_cmp), (6, t_arith), (7, t_cvt_rc),
                 (6, t_cvt_fp), (3, t_sse3), (3, t_shuf_mem), (1, t_mxcsr_rt), (6, t_seq), (3, t_unaligned),
                 (3, t_branch), (2, t_x87_mix)]
    weights = [w for w, _ in templates]
    for _ in range(n):
        rng.choices(templates, weights=weights)[0][1](Case())
    return g


def suite_verify_float_known(g, n):
    """Probes for documented fidelity gaps of the emulator (interpreter and/or JIT vs hardware):
    MXCSR.RC on arithmetic and int->float / double->single conversions, DAZ/FTZ, NaN payload
    propagation. Kept out of the default test suites; run on demand to measure the gap."""
    rng = g.rng
    NAN32 = [0x7fc00001, 0xffc00002, 0x7f800001, 0xff800001, 0x7fc00000, 0xffc00000, 0x7fffffff]
    NAN64 = [0x7ff8000000000001, 0xfff8000000000002, 0x7ff0000000000001, 0x7ff8000000000000, 0xfff8000000000000]

    def t_rc_arith(c):
        op = rng.choice(['add', 'sub', 'mul', 'div', 'sqrt']) + rng.choice(['ps', 'ss', 'pd', 'sd'])
        single = op.endswith('ps') or op.endswith('ss')
        rnd_sse_state(g, c, 'f32' if single else 'f64', rng.choice(MXCSR_RC[1:]))
        g.add(c, f'{op} xmm{rng.randrange(8)}, xmm{rng.randrange(8)}', tag='rc-arith')

    def t_rc_cvt(c):
        op = rng.choice(['cvtdq2ps', 'cvtsi2ss', 'cvtpd2ps', 'cvtsd2ss', 'cvtpi2ps'])
        mxcsr = rng.choice(MXCSR_RC[1:])
        d = rng.randrange(8)
        if op == 'cvtpi2ps':
            rnd_mixed_state(g, c, 'f32', mxcsr)
            i = rng.randrange(8)
            set_mm(c, i, struct.unpack('<Q', vf_pack_i32([rng.choice(VF_INTS) for _ in range(2)]))[0])
            s = f'mm{i}'
        elif op == 'cvtsi2ss':
            rnd_sse_state(g, c, 'f32', mxcsr)
            s, r = g.reg(4)
            c.fix(r, rng.choice(VF_INTS))
        elif op == 'cvtdq2ps':
            rnd_sse_state(g, c, 'f32', mxcsr)
            i = rng.randrange(8)
            set_xmm(c, i, vf_pack_i32([rng.choice(VF_INTS) for _ in range(4)]))
            s = f'xmm{i}'
        else:
            rnd_sse_state(g, c, 'f64', mxcsr)
            i = rng.randrange(8)
            set_xmm(c, i, vf_pack64([rng.choice(VF_D2S) for _ in range(2)]))
            s = f'xmm{i}'
        g.add(c, f'{op} xmm{d}, {s}', tag='rc-cvt')

    def t_dazftz(c):
        arith = rng.random() < 0.6
        if arith:
            op = rng.choice(['add', 'sub', 'mul', 'div', 'sqrt', 'min', 'max']) + rng.choice(['ps', 'ss', 'pd', 'sd'])
        else:
            op = rng.choice(['comiss', 'cmpps', 'cvtps2dq', 'cvttps2dq', 'cvtps2pd', 'ucomisd', 'cmppd', 'cvtpd2ps'])
        single = 'ss' in op or 'ps' in op
        mxcsr = rng.choice([0x9fc0, 0x1fc0, 0x9f80])
        rnd_sse_state(g, c, 'f32' if single else 'f64', mxcsr)
        tiny = VF_TINY32 if single else VF_TINY64
        d, s = rng.randrange(8), rng.randrange(8)
        for i in (d, s):
            vals = [rng.choice(tiny) for _ in range(4 if single else 2)]
            set_xmm(c, i, vf_pack32(vals) if single else vf_pack64(vals))
        imm = f', {rng.randrange(8)}' if op.startswith('cmp') else ''
        g.add(c, f'{op} xmm{d}, xmm{s}{imm}', tag='daz-ftz-' + ('arith' if arith else 'other'))

    def t_nan(c):
        op = rng.choice(['addps', 'mulss', 'subpd', 'divsd', 'minps', 'maxsd', 'sqrtps', 'cvtsd2ss', 'cvtps2pd',
                         'haddps', 'addsubpd'])
        single = op.endswith('ps') or op.endswith('ss')
        rnd_sse_state(g, c, 'f32' if single else 'f64')
        d, s = rng.randrange(8), rng.randrange(8)
        while s == d:
            s = rng.randrange(8)
        for i in (d, s):
            if single:
                set_xmm(c, i, b''.join(struct.pack('<I', rng.choice(NAN32) if rng.random() < 0.7 else
                                                   struct.unpack('<I', struct.pack('<f', f32_or(rng)))[0]) for _ in range(4)))
            else:
                set_xmm(c, i, b''.join(struct.pack('<Q', rng.choice(NAN64) if rng.random() < 0.7 else
                                                   struct.unpack('<Q', struct.pack('<d', rnd_double(rng)))[0]) for _ in range(2)))
        g.add(c, f'{op} xmm{d}, xmm{s}', tag='nan-payload')

    templates = [(3, t_rc_arith), (3, t_rc_cvt), (3, t_dazftz), (3, t_nan)]
    weights = [w for w, _ in templates]
    for _ in range(n):
        rng.choices(templates, weights=weights)[0][1](Case())
    return g


# ======================================================================================
# verify_mech: JIT mechanics around the SSE/MMX translators, as oracle-backed multi-instruction
# snippets: lazy EFLAGS preserved across vector ops (including the handlers with internal control
# flow: MXCSR.RC br_table, register shift counts, CMPPS, MASKMOV, vector stores), COMIS* folding
# pending flags (also right after a block boundary), x87 TOP/tag coupling with MMX use, an
# interpreter fallback (xlatb) between native SSE ops, segment overrides, vector store followed
# by a scalar reload in the same block, MOVD/PEXTRW round trips through the GPRs.

CC_CODES = {'o': 0, 'no': 1, 'b': 2, 'ae': 3, 'z': 4, 'nz': 5, 'be': 6, 'a': 7,
            's': 8, 'ns': 9, 'p': 10, 'np': 11, 'l': 12, 'ge': 13, 'le': 14, 'g': 15}
ALU_RR = {'add': 0x01, 'sub': 0x29, 'cmp': 0x39, 'xor': 0x31, 'and': 0x21, 'or': 0x09, 'adc': 0x11, 'sbb': 0x19}


def suite_verify_mech(g, n):
    rng = g.rng

    def modrm(reg, rm):
        return 0xc0 | (reg << 3) | rm

    def flag_producer(c, exclude=()):
        """ALU instruction leaving lazy flags in the JIT: (asm, defined-flags mask, usable ccs)."""
        op = rng.choice(['add', 'sub', 'cmp', 'and', 'xor', 'or', 'inc', 'dec', 'shl', 'shr', 'sar', 'neg', 'imul', 'test'])
        d, dn = g.reg(4, exclude)
        ccs = list(CC_CODES)
        if op in ('inc', 'dec', 'neg'):
            return f'{op} {d}', ALLF, ccs
        if op in ('shl', 'shr', 'sar'):
            # OF is undefined for counts > 1: no consumer may read it (o/no/l/ge/le/g)
            return f'{op} {d}, {rng.choice([1, 3, 7, 31])}', ALLF & ~(AF | OF), [cc for cc in ccs if cc not in ('o', 'no', 'l', 'ge', 'le', 'g')]
        if op == 'imul':
            s, _ = g.reg(4, exclude)
            return f'imul {d}, {s}', CF | OF | DF, ['o', 'no', 'b', 'ae']
        mask = ALLF & ~AF if op in ('and', 'xor', 'or', 'test') else ALLF
        if rng.random() < 0.5:
            s, _ = g.reg(4, exclude)
            return f'{op} {d}, {s}', mask, ccs
        return f'{op} {d}, {rnd32(rng):#x}', mask, ccs

    def flag_consumer(c, ccs, exclude=()):
        k = rng.random()
        if k < 0.6:
            r, _ = g.reg(1, exclude)
            return f'set{rng.choice(ccs)} {r}'
        if k < 0.8:
            r, _ = g.reg(4, exclude)
            return f'{rng.choice(["adc", "sbb"])} {r}, 0'
        r, _ = g.reg(4, exclude)
        s, _ = g.reg(4, exclude)
        return f'cmov{rng.choice(ccs)} {r}, {s}'

    def small_count_xmm(c, i):
        """Force the low qword of xmm i to a shift count (mixes in >= width counts)."""
        cnt = rng.choice([0, 1, 5, 15, 16, 31, 32, 63, 64, 200, 1 << 33])
        cur = bytearray(c.fx[160 + 16 * i:176 + 16 * i])
        struct.pack_into('<Q', cur, 0, cnt)
        set_xmm(c, i, bytes(cur))

    def victim(c):
        """A vector instruction that must leave EFLAGS untouched; sets up the case state."""
        k = rng.random()
        x = lambda: f'xmm{rng.randrange(8)}'
        m = lambda: f'mm{rng.randrange(8)}'
        if k < 0.12:
            op = rng.choice(['cvtps2dq', 'cvttps2dq', 'cvtpd2dq', 'cvttpd2dq', 'cvtdq2ps', 'cvtps2pd'])
            # RC != nearest only for the float->int forms (the emulator rounds int->float / float->float to nearest)
            rnd_mixed_state(g, c, 'f64' if 'pd2' in op else 'f32', rng.choice(MXCSR_RC) if op.endswith('dq') else 0x1f80)
            return f'{op} {x()}, {x()}'
        if k < 0.22:
            op = rng.choice(['cvtss2si', 'cvttss2si', 'cvtsd2si', 'cvttsd2si', 'cvtps2pi', 'cvttpd2pi'])
            rnd_mixed_state(g, c, 'f64' if 'sd' in op or 'pd' in op else 'f32', rng.choice(MXCSR_RC))
            d = g.reg(4)[0] if op.endswith('si') else m()
            return f'{op} {d}, {x()}'
        if k < 0.34:
            op = rng.choice(['psllw', 'psrlw', 'psraw', 'pslld', 'psrld', 'psrad', 'psllq', 'psrlq'])
            rnd_mixed_state(g, c, 'int')
            if rng.random() < 0.5:
                s = rng.randrange(8); small_count_xmm(c, s)
                return f'{op} {x()}, xmm{s}'
            s = rng.randrange(8); set_mm(c, s, rng.choice([0, 3, 15, 16, 31, 32, 63, 64, 300, 1 << 40]))
            return f'{op} {m()}, mm{s}'
        if k < 0.42:
            rnd_mixed_state(g, c, 'f32x')
            return f'{rng.choice(["cmpps", "cmpss"])} {x()}, {x()}, {rng.randrange(8)}'
        if k < 0.52:
            rnd_mixed_state(g, c, 'f32')
            op = rng.choice(['minps', 'maxss', 'addps', 'mulps', 'sqrtps', 'divss', 'andnps', 'shufps'])
            return f'{op} {x()}, {x()}' + (f', {rng.randrange(256)}' if op == 'shufps' else '')
        if k < 0.62:
            rnd_mixed_state(g, c, 'int')
            op = rng.choice(['movaps', 'movups', 'movdqu', 'movntps', 'movq', 'movlps', 'movhps', 'movss', 'movd', 'movntq'])
            size = {'movaps': 16, 'movups': 16, 'movdqu': 16, 'movntps': 16, 'movq': 8, 'movlps': 8, 'movhps': 8, 'movss': 4, 'movd': 4, 'movntq': 8}[op]
            mo, _ = g.mem(c, size, align=16 if op in ('movaps', 'movntps') else 1)
            src = m() if op == 'movntq' else x()
            return f'{op} {mo}, {src}'
        if k < 0.70:
            rnd_mixed_state(g, c, 'int')
            c.fix(7, SCRATCH + rng.randrange(0, 0x300))
            if rng.random() < 0.5:
                s = rng.randrange(8); set_mm(c, s, rng.getrandbits(64) | 0x8000000000000080)
                return f'maskmovq {m()}, mm{s}'
            return f'maskmovdqu {x()}, {x()}'
        if k < 0.82:
            rnd_mixed_state(g, c, 'int')
            r, _ = g.reg(4)
            op = rng.choice(['pextrw', 'pmovmskb', 'movd_out', 'movd_in', 'pinsrw', 'movmskps'])
            v = x() if op == 'movmskps' else rng.choice([m(), x()])
            if op == 'pextrw':
                return f'pextrw {r}, {v}, {rng.randrange(8)}'
            if op == 'pmovmskb':
                return f'pmovmskb {r}, {v}'
            if op == 'movd_out':
                return f'movd {r}, {v}'
            if op == 'movd_in':
                return f'movd {v}, {r}'
            if op == 'pinsrw':
                return f'pinsrw {v}, {r}, {rng.randrange(8)}'
            return f'movmskps {r}, {v}'
        if k < 0.92:
            rnd_mixed_state(g, c, 'int')
            op = rng.choice(['packssdw', 'punpcklbw', 'pshufw', 'paddsw', 'pmaddwd', 'psadbw', 'pmulhw', 'emms'])
            if op == 'emms':
                return 'emms'
            if op == 'punpcklbw' and rng.random() < 0.5:
                return f'punpcklbw {m()}, {g.mem(c, 4)[0]}'
            if op == 'pshufw':
                return f'pshufw {m()}, {m()}, {rng.randrange(256)}'
            return f'{op} {m()}, {m()}'
        rnd_mixed_state(g, c, 'f32')
        if rng.random() < 0.5:
            mo, _ = g.mem(c, 4)
            patch_bytes(c, mo, struct.pack('<I', rng.choice(MXCSR_ALL)))
            return f'ldmxcsr {mo}'
        return f'stmxcsr {g.mem(c, 4)[0]}'

    def mmx_x87_state(c, valid_mask=0xff, empty_mant=None):
        """MMX state with TOP=0; slots outside valid_mask are empty and hold `empty_mant`
        (the mantissa an x87 push will produce there, so that the MM view stays comparable)."""
        fx = default_fx(rng, top=0, valid_mask=valid_mask)
        for i in range(8):
            if (valid_mask >> i) & 1:
                struct.pack_into('<QH', fx, 32 + 16 * i, rng.getrandbits(64), 0xffff)
            else:
                struct.pack_into('<QH', fx, 32 + 16 * i, empty_mant or 0, 0)
        c.fx = fx
        c.cmp['mmx'] = True
        c.cmp['fpu'] = True

    for _ in range(n):
        c = Case()
        k = rng.random()
        if k < 0.42:
            # producer ; vector op ; consumer (flags must survive the vector handler); the
            # vector op comes first so that its address registers are excluded from the producer
            mid = victim(c)
            fixed = tuple(r for r in range(8) if c.regs[r] is not None)
            prod, mask, ccs = flag_producer(c, exclude=fixed)
            cons = flag_consumer(c, ccs, exclude=fixed)
            g.add(c, f'{prod} ; {mid} ; {cons}', mask)
        elif k < 0.55:
            # producer ; comis ; consumer(s): pending flags folded before COMIS* rewrites them
            op = rng.choice(['comiss', 'ucomiss', 'comisd', 'ucomisd'])
            rnd_sse_state(g, c, 'f64' if op.endswith('d') else 'f32x')
            a = rng.randrange(8)
            if rng.random() < 0.35:
                s, used = g.mem(c, 8 if op.endswith('d') else 4)
                c.cmp['patchf64' if op.endswith('d') else 'patchf32'] = s
            else:
                s, used = f'xmm{rng.randrange(8)}', []
            prod, mask, ccs = flag_producer(c, exclude=tuple(used))
            cons = ' ; '.join(flag_consumer(c, list(CC_CODES), exclude=tuple(used)) for _ in range(rng.randrange(1, 3)))
            g.add(c, f'{prod} ; {op} xmm{a}, {s} ; {cons}', ALLF)
        elif k < 0.65:
            # hand-encoded: alu r,r ; jmp/jcc +0 (block boundary) ; comis xmm,xmm ; setcc r8
            op = rng.choice(list(ALU_RR))
            dn = rng.choice(DATA_REGS); sn = rng.choice(DATA_REGS)
            cop = rng.choice(['comiss', 'ucomiss', 'comisd', 'ucomisd'])
            rnd_sse_state(g, c, 'f64' if cop.endswith('d') else 'f32x')
            a, b = rng.randrange(8), rng.randrange(8)
            cc = rng.choice(list(CC_CODES)); r8 = rng.randrange(8)
            jmp = rng.choice([(b'\xeb\x00', 'jmp +0'), (b'\x74\x00', 'jz +0'), (b'\x75\x00', 'jnz +0'), (b'', '')])
            code = bytes([ALU_RR[op], modrm(sn, dn)]) + jmp[0]
            code += (b'\x66' if cop.endswith('d') else b'') + bytes([0x0f, 0x2f if cop.startswith('c') else 0x2e, modrm(a, b)])
            code += bytes([0x0f, 0x90 + CC_CODES[cc], modrm(0, r8)])
            g.add_raw(c, f'{op} {R32[dn]}, {R32[sn]} ; {jmp[1]} ; {cop} xmm{a}, xmm{b} ; set{cc} {R8[r8]}', code, ALLF, xmm=True)
        elif k < 0.80:
            # x87 TOP/tags around MMX use
            form = rng.random()
            X, Y = rng.randrange(7), rng.randrange(7)   # never mm7 (the slot the x87 pushes write)
            mop = rng.choice([f'paddw mm{X}, mm{Y}', f'movq mm{X}, mm{Y}', f'pxor mm{X}, mm{Y}', f'pshufw mm{X}, mm{Y}, 0x1b'])
            if form < 0.3:
                mmx_x87_state(c)
                g.add(c, f'{mop} ; fstp st(0) ; fincstp ; fdecstp ; fstp st(0)')
            elif form < 0.5:
                mmx_x87_state(c)
                g.add(c, f'fincstp ; {mop} ; fstp st(0)')
            elif form < 0.7:
                mmx_x87_state(c, valid_mask=0x7f, empty_mant=0x8000000000000000)
                g.add(c, f'fld1 ; {mop} ; emms')
            elif form < 0.85:
                mmx_x87_state(c, valid_mask=0x7f, empty_mant=0x8000000000000000)
                g.add(c, f'fld1 ; {mop} ; fstp st(0)')
            else:
                mmx_x87_state(c, valid_mask=0x7f, empty_mant=0x8000000000000000)
                g.add(c, f'emms ; fld1 ; {mop} ; emms ; fld1')
        elif k < 0.88:
            # interpreter fallback (xlatb) between native vector ops, with or without pending flags
            rnd_mixed_state(g, c, 'f32')
            c.fix(3, SCRATCH + rng.randrange(0, 0x200))
            a, b = f'xmm{rng.randrange(8)}', f'xmm{rng.randrange(8)}'
            mm = f'mm{rng.randrange(8)}', f'mm{rng.randrange(8)}'
            if rng.random() < 0.5:
                prod, mask, ccs = flag_producer(c, exclude=(3,))
                cons = flag_consumer(c, ccs, exclude=(3,))
                g.add(c, f'{prod} ; addps {a}, {b} ; xlatb ; {cons} ; paddw {mm[0]}, {mm[1]}', mask)
            else:
                g.add(c, f'addps {a}, {b} ; xlatb ; mulps {a}, {b} ; paddw {mm[0]}, {mm[1]} ; xlatb ; movq {mm[1]}, {mm[0]}')
        elif k < 0.94:
            # segment overrides (flat segments) on vector loads and stores
            rnd_mixed_state(g, c, 'int')
            seg = rng.choice(['ds', 'es', 'ss', 'cs'])
            op = rng.choice(['movaps', 'movups', 'movq_mm', 'movq_xmm', 'movd'])
            if op in ('movaps', 'movups'):
                mo, _ = g.mem(c, 16, align=16)
                mo = mo.replace('[', f'{seg}:[')
                if seg == 'cs' or rng.random() < 0.5:
                    g.add(c, f'{op} xmm{rng.randrange(8)}, {mo}')
                else:
                    g.add(c, f'{op} {mo}, xmm{rng.randrange(8)}')
            else:
                mo, _ = g.mem(c, 8 if op != 'movd' else 4)
                mo = mo.replace('[', f'{seg}:[')
                reg = f'mm{rng.randrange(8)}' if op == 'movq_mm' else f'xmm{rng.randrange(8)}'
                if seg == 'cs' or rng.random() < 0.5:
                    g.add(c, f'{op[:4]} {reg}, {mo}')
                else:
                    g.add(c, f'{op[:4]} {mo}, {reg}')
        else:
            # vector store then scalar reload of the same bytes in one block; MOVD round trips
            rnd_mixed_state(g, c, 'int')
            form = rng.random()
            if form < 0.5:
                op = rng.choice(['movups', 'movaps', 'movq', 'movd', 'movlps', 'stmxcsr'])
                size = {'movups': 16, 'movaps': 16, 'movq': 8, 'movd': 4, 'movlps': 8, 'stmxcsr': 4}[op]
                mo, used = g.mem(c, size, align=16 if op == 'movaps' else 1)
                r, _ = g.reg(4, exclude=used)
                off = rng.randrange(0, size - 3)
                reload = mo.replace(PTR[size], 'dword ptr').replace(']', f'+{off:#x}]')
                src = '' if op == 'stmxcsr' else (f', mm{rng.randrange(8)}' if op == 'movq' and rng.random() < 0.5 else f', xmm{rng.randrange(8)}')
                g.add(c, f'{op} {mo}{src} ; mov {r}, {reload}')
            else:
                r1, n1 = g.reg(4); r2, _ = g.reg(4)
                v = rng.choice([f'mm{rng.randrange(8)}', f'xmm{rng.randrange(8)}'])
                w = rng.choice([f'mm{rng.randrange(8)}', f'xmm{rng.randrange(8)}'])
                g.add(c, f'movd {r1}, {v} ; add {r1}, {r2} ; movd {w}, {r1} ; pextrw {r2}, {w}, {rng.randrange(4)}')
    return g


# ======================================================================================
# verify_trans: the x87 transcendentals (F2XM1, FSCALE, FYL2X, FYL2XP1, FSIN, FCOS, FSINCOS,
# FPTAN, FPATAN) against the native FPU at the documented domain edges and special values, the
# condition codes compared (fpucc: C0/C2/C3; C1 is the rounding-direction bit, not emulated).
# Facts measured on the oracle machine (AMD EPYC 7402P) that shape the cases:
#   - the hardware trig reduction carries ~66 bits of pi: its absolute error grows like
#     1.3e-21 |x|, so values are only comparable at 1e-13 for |x| <~ 1e7 (sin/cos) and away from
#     the poles of tan (|x| <= 100, reduced argument >= 1e-6). At 2^62 or 2^63 - 1024 the hardware
#     value is meaningless: those cases only check that a value in [-1, 1] was produced (C2 = 0,
#     the push happened) by comparing |result| with 1 and dropping it;
#   - +-inf trig arguments raise IE and give the indefinite (with the push for FSINCOS/FPTAN);
#     the emulator takes the C2 path instead: verify_trans_known;
#   - a QNaN argument propagates without IE on hardware (the emulator raises IE): the exception
#     bits are not compared here, verify_trans_known exposes them through FNSTSW;
#   - C0/C3 are preserved by the hardware transcendentals (undefined by the SDM) while the
#     emulator's trig clears them: the initial condition codes are 0 in every case so both agree;
#   - F2XM1 outside [-1, 1] and FYL2XP1 outside its domain are undefined (this CPU returns ST(0)
#     unchanged for F2XM1): not generated (F2XM1 outside the domain is in verify_trans_known);
#   - the classic exp idiom stays within 2.2e-14 of the hardware for |x| <= 200 (the FMUL by
#     log2 e is rounded to 53 bits on both sides when PC = 53, to 64 bits on hardware otherwise).

TRANS_TOL = 1e-13
# e^x (ST(0) = x): x log2 e split into an integer n and f in [-0.5, 0.5], 2^f = F2XM1 + 1, FSCALE by n
TRANS_EXP_IDIOM = 'fldl2e; fmulp st(1), st; fld st(0); frndint; fsub st(1), st; fxch st(1); f2xm1; fld1; faddp st(1), st; fscale; fstp st(1)'
# 2^ST(0), same split (x^y = 2^(y log2 x) after FYL2X)
TRANS_POW2_IDIOM = 'fld st(0); frndint; fsub st(1), st; fxch st(1); f2xm1; fld1; faddp st(1), st; fscale; fstp st(1)'


def ulps_away(x, n):
    """x moved by n ulps along the real line (n > 0: toward +inf), clamped to +-inf."""
    u = struct.unpack('<Q', struct.pack('<d', x))[0]
    o = -(u & ((1 << 63) - 1)) if u >> 63 else u
    o = max(-0x7ff0000000000000, min(0x7ff0000000000000, o + n))
    u = o if o >= 0 else (1 << 63) | (-o)
    return struct.unpack('<d', struct.pack('<Q', u))[0]


def trans_state(g, c, values, need_free=0):
    """x87 state with ST(0..k-1) = values (k = len(values)), random TOP, random extra valid
    registers below them (at most 8 - need_free valid in total) and the control-word distribution
    of rnd_fpu_state (default, single precision with any RC, extended, double with directed RC)."""
    rng = g.rng
    top = rng.randrange(0, 8)
    k = len(values)
    nvalid = rng.randrange(k, 9 - need_free)
    valid_mask = 0
    vals = [0.0] * 8
    for i in range(nvalid):
        valid_mask |= 1 << ((top + i) & 7)
        vals[i] = values[i] if i < k else rnd_double(rng)
    r = rng.random()
    if r < 0.6:
        fcw = 0x027f
    elif r < 0.78:
        fcw = rng.choice([0x007f, 0x047f, 0x087f, 0x0c7f])
    elif r < 0.9:
        fcw = 0x037f
    else:
        fcw = rng.choice([0x067f, 0x0a7f, 0x0e7f, 0x127f])
    c.fx = default_fx(rng, top=top, valid_mask=valid_mask, values=vals, fcw=fcw)
    c.cmp['fpu'] = True


def suite_verify_trans(g, n):
    rng = g.rng
    inf, nan = float('inf'), float('nan')
    MIN_DEN, MIN_NORM, MAX = 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308
    PIO2 = math.pi / 2
    # FYL2XP1 domain: -(1 - sqrt(2)/2) <= x <= sqrt(2) - 1
    LO, HI = -(1 - math.sqrt(2) / 2), math.sqrt(2) - 1

    def sgn():
        return rng.choice([1.0, -1.0])

    def logu(lo, hi):
        return 10.0 ** rng.uniform(lo, hi)

    def denormal():
        return math.ldexp(float(rng.randrange(1, 1 << 52)), -1074) * sgn()

    def full_bits(lo, hi):
        """uniform in [lo, hi] with the low 20 mantissa bits re-randomized (any 53-bit pattern)."""
        v = rng.uniform(lo, hi)
        b = struct.unpack('<Q', struct.pack('<d', v))[0] ^ rng.getrandbits(20)
        return struct.unpack('<d', struct.pack('<Q', b))[0]

    def near(x, span=8):
        return ulps_away(x, rng.randrange(-span, span + 1))

    def y_value():
        k = rng.random()
        if k < 0.45:
            return rnd_double(rng)
        if k < 0.7:
            return rng.choice([0.0, -0.0, inf, -inf, nan, 1.0, -1.0, 1e300, -1e300, MIN_DEN, -MIN_DEN, MIN_NORM, 2.0, 0.5, -3.0])
        return sgn() * logu(-300, 300)

    def t_f2xm1(c):
        k = rng.random()
        if k < 0.3:
            x = rng.uniform(-1, 1)
        elif k < 0.45:
            x = full_bits(-1, 1)
        elif k < 0.57:
            x = rng.choice([0.0, -0.0, 1.0, -1.0, 0.5, -0.5, 0.25, -0.75, 1 - 2 ** -53, -(1 - 2 ** -53), 1 - 2 ** -52,
                            2 ** -52, -2 ** -52, 2 ** -27, -2 ** -27, 2 ** -30, 2 ** -1022])
        elif k < 0.7:
            x = sgn() * logu(-300, 0)
        elif k < 0.8:
            x = denormal()
        elif k < 0.9:
            x = sgn() * (1 - logu(-16, -3))
        elif k < 0.95:
            x = sgn() * MIN_NORM
        else:
            x = nan
        trans_state(g, c, [x])
        g.add(c, 'f2xm1', fpu=True, tol=TRANS_TOL, fpucc=True)

    def t_fscale(c):
        ka = rng.random()
        if ka < 0.35:
            a = rnd_double(rng)
        elif ka < 0.5:
            a = math.ldexp(sgn() * full_bits(0.5, 1), rng.randrange(-1073, 1025))
        elif ka < 0.62:
            a = denormal()
        elif ka < 0.75:
            a = rng.choice([0.0, -0.0, inf, -inf, nan, MIN_DEN, -MIN_DEN, MIN_NORM, -MIN_NORM, MAX, -MAX, 1e300, 1e-300, 1.0, -1.0, 1.5, 3.0])
        else:
            a = sgn() * logu(-308, 308)
        kb = rng.random()
        if kb < 0.25:
            b = float(rng.randrange(-1100, 1101))
        elif kb < 0.4:
            b = rng.uniform(-1100, 1100)
        elif kb < 0.55:
            b = rng.choice([0.0, -0.0, inf, -inf, nan, 0.9, -0.9, 0.5, -0.5, 1.0, -1.0, 1e300, -1e300, 2.0 ** 63, -(2.0 ** 63),
                            2.0 ** 31, -(2.0 ** 31), 1023.0, 1024.0, -1022.0, -1074.0, -1075.0, 2000.0, -2000.0, 2100.0, -2100.0, 1e10, -1e10])
        elif a == 0 or not math.isfinite(a):
            b = float(rng.randrange(-1100, 1101))
        else:
            # cross the denormal / overflow boundaries of the f64 range: the exponent of a 2^b lands
            # in [-1080, -1020] or [1010, 1030] (a = m 2^ea, m in [0.5, 1))
            ea = math.frexp(abs(a))[1]
            target = rng.choice([rng.randrange(-1080, -1019), rng.randrange(1010, 1031)])
            b = float(target - ea) + rng.choice([0.0, 0.0, rng.uniform(-0.99, 0.99)])
        trans_state(g, c, [a, b])
        g.add(c, 'fscale', fpu=True, tol=TRANS_TOL, fpucc=True)

    def t_fyl2x(c):
        k = rng.random()
        if k < 0.15:
            x = 2.0 ** rng.randrange(-1074, 1024)
        elif k < 0.25:
            x = abs(denormal())
        elif k < 0.3:
            x = 1.0
        elif k < 0.42:
            x = ulps_away(1.0, rng.choice([1, -1, 2, -2, 3, -3, rng.randrange(-64, 65), rng.randrange(-(1 << 20), 1 << 20), rng.randrange(-(1 << 40), 1 << 40)]))
        elif k < 0.5:
            x = logu(200, 308.2)
        elif k < 0.65:
            x = logu(-323, 308)
        elif k < 0.75:
            x = full_bits(0.5, 2)
        elif k < 0.85:
            x = rng.choice([math.sqrt(2), math.sqrt(0.5)]) * (1 + sgn() * logu(-16, -6))
        elif k < 0.95:
            x = rng.choice([0.0, -0.0, inf, nan, -1.0, -inf, -MIN_DEN, -0.5, MIN_DEN, MIN_NORM, MAX])
        else:
            x = near(rng.choice([math.sqrt(2), math.sqrt(0.5), 2.0, 0.5, 4.0]), 3)
        trans_state(g, c, [x, y_value()])
        g.add(c, 'fyl2x', fpu=True, tol=TRANS_TOL, fpucc=True)

    def t_fyl2xp1(c):
        k = rng.random()
        if k < 0.3:
            x = rng.uniform(LO, HI)
        elif k < 0.42:
            x = min(max(full_bits(LO, HI), LO), HI)
        elif k < 0.55:
            x = sgn() * logu(-300, math.log10(0.29))
        elif k < 0.63:
            x = denormal()
        elif k < 0.75:
            x = rng.choice([0.0, -0.0, LO, HI, 2 ** -52, -2 ** -52, 2 ** -53, -2 ** -53, MIN_DEN, -MIN_DEN, MIN_NORM, -MIN_NORM,
                            0.25, -0.25, 2 ** -27, -2 ** -27, 0.4, -0.29])
        elif k < 0.85:
            e = rng.choice([LO, HI])
            x = ulps_away(e, rng.randrange(0, 6) * (1 if e < 0 else -1))   # the edges, inward
        elif k < 0.95:
            x = rng.choice([LO, HI]) * logu(-8, 0)
        else:
            x = nan
        trans_state(g, c, [x, y_value()])
        g.add(c, 'fyl2xp1', fpu=True, tol=TRANS_TOL, fpucc=True)

    def t_trig(c):
        op = rng.choice(['fsin', 'fcos', 'fsincos', 'fptan'])
        two = op in ('fsincos', 'fptan')
        tan = op == 'fptan'
        asm, need_free = op, 1 if two else 0
        k = rng.random()
        if k < 0.18:
            x = rng.uniform(-10, 10)
        elif k < 0.28:
            x = rng.uniform(-100, 100) if tan else rng.uniform(-1e6, 1e6)
        elif k < 0.34:
            x = rng.uniform(-10, 10) if tan else rng.uniform(-1e7, 1e7)
        elif k < 0.48:
            # near m pi/2 (the poles of tan excluded: even m and |x| <= 100 for fptan)
            if tan:
                m = 2 * rng.randrange(1, 32)
            else:
                m = rng.choice([rng.randrange(1, 64), rng.randrange(1, 1000), rng.randrange(1000, 1 << 20)])
            x = sgn() * near(m * PIO2, 8)
        elif k < 0.58:
            x = rng.choice([0.0, -0.0, MIN_DEN, -MIN_DEN, MIN_NORM, 1e-300, -1e-300, 2 ** -27, -(2 ** -27), 2 ** -26, -(2 ** -26), 2 ** -25,
                            math.pi / 4, -math.pi / 4, math.pi / 2, -math.pi / 2, math.pi, -math.pi, 2 * math.pi, 3 * math.pi / 2, 1e-10, 0.5, 1.0, -1.0])
            if tan and abs(x) in (math.pi / 2, 3 * math.pi / 2):
                x = math.pi
        elif k < 0.64:
            x = denormal()
        elif k < 0.76:
            # out of range: C2 set, ST(0) unchanged, no push (also read back through FNSTSW)
            x = rng.choice([2.0 ** 63, -(2.0 ** 63), ulps_away(2.0 ** 63, rng.randrange(1, 100)), 1e300, -1e300, MAX, -MAX, 2.0 ** 64, 1e19, -1e20])
            if rng.random() < 0.5:
                asm = f'{op}; fnstsw ax; and eax, 0x4500'
        elif k < 0.86:
            # largest arguments below 2^63: a value must be produced (C2 = 0, the push done); the
            # hardware value is meaningless there (see the header), so only |v| <= 1 is checked
            x = sgn() * rng.choice([2.0 ** 62, 2.0 ** 63 - 1024, ulps_away(2.0 ** 63, -rng.randrange(1, 64)), 2.0 ** 61 * 1.5, 1e18, 3e17])
            if tan:
                asm = 'fptan; fstp st(1)'
            elif op == 'fsincos':
                asm = 'fsincos; fabs; fld1; fcompp; fnstsw ax; and eax, 0x4500; mov edx, eax; fabs; fld1; fcompp; fnstsw ax; and eax, 0x4500'
                need_free = 2
            else:
                asm = f'{op}; fabs; fld1; fcompp; fnstsw ax; and eax, 0x4500'
                need_free = 1
        elif k < 0.92:
            x = nan
        else:
            x = sgn() * logu(-8, 1 if tan else 6)
        trans_state(g, c, [x], need_free)
        g.add(c, asm, fpu=True, tol=TRANS_TOL, fpucc=True)

    def t_fpatan(c):
        def mag():
            k = rng.random()
            if k < 0.35:
                return logu(-300, 300)
            if k < 0.55:
                return rng.uniform(0, 10)
            if k < 0.65:
                return abs(denormal())
            if k < 0.8:
                return rng.choice([0.0, inf, 1.0, MIN_DEN, MIN_NORM, MAX, 1e300, 1e-300, 2.0, 0.5])
            return logu(-3, 3)

        k = rng.random()
        if k < 0.6:
            x, y = sgn() * mag(), sgn() * mag()
        elif k < 0.75:
            # |y/x| near the table boundaries m/8 (m = 1..8; 1/8 is also the k = 0 threshold)
            t = rng.randrange(1, 9) / 8
            if rng.random() < 0.8:
                t *= 1 + sgn() * logu(-16, -3)
            base = sgn() * mag()
            if not math.isfinite(base) or base == 0:
                base = sgn() * 3.0
            if rng.random() < 0.5:
                x, y = base, base * t * sgn()
            else:
                y, x = base, base * t * sgn()
        elif k < 0.85:
            base = sgn() * mag()
            if not math.isfinite(base):
                base = 2.0
            x, y = base, near(base, 4) * sgn()   # |y| ~ |x|
        elif k < 0.93:
            x, y = rng.choice([nan, sgn() * mag()]), rng.choice([nan, sgn() * mag()])
        else:
            x, y = rng.choice([0.0, -0.0, inf, -inf]), rng.choice([0.0, -0.0, inf, -inf, 2.0, -2.0])
        trans_state(g, c, [x, y])
        g.add(c, 'fpatan', fpu=True, tol=TRANS_TOL, fpucc=True)

    def t_seq(c):
        form = rng.random()
        if form < 0.15:
            x = rng.choice([rng.uniform(-200, 200), rng.uniform(-5, 5), 0.0, -0.0, 1.0, -1.0, 1e-10, -1e-10, 100.0, -100.0, MIN_DEN, 0.5, -0.5])
            trans_state(g, c, [x], 2)
            asm = TRANS_EXP_IDIOM
        elif form < 0.27:
            # x^y = 2^(y log2 x), |y log2 x| <= ~700
            x = rng.choice([logu(-10, 10), 2.0, 10.0, 0.5, 1.0, 1e-5, 1e5])
            y = rng.choice([rng.uniform(-8, 8), 0.5, -0.5, 2.0, -3.0, 0.0, 10.0, 20.0])
            trans_state(g, c, [x, y], 2)
            asm = 'fyl2x; ' + TRANS_POW2_IDIOM
        elif form < 0.37:
            x = rng.choice([logu(-300, 300), 1.0, 2.0, 0.5, MIN_DEN, MAX, 1e-300, 3.0, 10.0])
            trans_state(g, c, [x], 1)
            asm = rng.choice(['fld1; fxch st(1); fyl2x', 'fldln2; fxch st(1); fyl2x', 'fldlg2; fxch st(1); fyl2x'])
        elif form < 0.47:
            x = rng.uniform(-10, 10)
            trans_state(g, c, [x], 1)
            asm = rng.choice(['fsincos; fdivp st(1), st', 'fptan; fstp st(0)', 'fptan; fdivrp st(1), st'])
        elif form < 0.57:
            x = rng.choice([rng.uniform(-10, 10), rng.uniform(-1e6, 1e6), 0.0, MIN_DEN])
            trans_state(g, c, [x], 1)
            asm = rng.choice(['fld st(0); fsin; fxch st(1); fcos', 'fld st(0); fcos; fxch st(1); fsin', 'fsin; fsin', 'fcos; fsin; fcos'])
        elif form < 0.67:
            x = sgn() * rng.choice([logu(-300, 300), rng.uniform(0, 10), 0.0, inf, 1.0, MIN_DEN])
            trans_state(g, c, [x], 1)
            asm = rng.choice(['fld1; fpatan', 'fld1; fxch st(1); fpatan'])
        elif form < 0.77:
            x = rng.uniform(-1, 1)
            trans_state(g, c, [x], 1)
            asm = rng.choice(['f2xm1; fld1; faddp st(1), st', 'fchs; f2xm1', 'fabs; f2xm1; fsqrt'])
        elif form < 0.85:
            a, b = rnd_double(rng), float(rng.randrange(-1100, 1100))
            trans_state(g, c, [a, b])
            asm = rng.choice(['fscale; fstp st(1)', 'fxch st(1); fscale', 'fscale; fscale'])
        elif form < 0.93:
            # out-of-range trig inside a longer block: the JIT leaves the region on the C2 path and
            # resumes at the next instruction, with the pending stack shift materialized
            x = rng.choice([2.0 ** 63, -(2.0 ** 63), 1e300, ulps_away(2.0 ** 63, 3)])
            op = rng.choice(['fsin', 'fcos', 'fsincos', 'fptan'])
            trans_state(g, c, [x, 5.0], 2)
            asm = rng.choice([f'fld st(0); {op}; fstp st(1)', f'{op}; fld1; faddp st(1), st', f'fxch st(1); fxch st(1); {op}; fstp st(1)',
                              f'{op}; fnstsw ax; and eax, 0x4500; fstp st(0)'])
        else:
            # two-operand ops under a pending stack shift (pushes earlier in the block)
            x, y = abs(rnd_double(rng)) + 1e-300, rnd_double(rng)
            trans_state(g, c, [x, y], 2)
            asm = rng.choice(['fld st(1); fld st(1); fyl2x', 'fld st(0); fld st(2); fpatan', 'fld st(1); fscale', 'fld st(1); fld st(1); fyl2xp1'])
            if asm.endswith('fyl2xp1'):
                x = rng.uniform(LO, HI)
                trans_state(g, c, [x, y], 2)
        g.add(c, asm, fpu=True, tol=TRANS_TOL, fpucc=True)

    templates = [(4, t_f2xm1), (4, t_fscale), (5, t_fyl2x), (4, t_fyl2xp1), (8, t_trig), (5, t_fpatan), (4, t_seq)]
    weights = [w for w, _ in templates]
    for _ in range(n):
        rng.choices(templates, weights=weights)[0][1](Case())
    return g


def suite_verify_trans_known(g, n):
    """Measured gaps of the x87 transcendentals (interpreter and JIT alike) against the oracle
    machine, kept out of the default suites; `tag` names the gap:
      trig-inf: FSIN/FCOS/FSINCOS/FPTAN of +-inf raise IE and give the indefinite (FSINCOS/FPTAN
        still push); the emulator takes the |x| >= 2^63 path (C2 = 1, ST(0) unchanged, no push);
      trig-qnan-ie: a QNaN argument propagates without IE on hardware, the emulator raises IE;
      masked-es: masked exceptions set only their flag on hardware (ES is for unmasked ones), the
        emulator sets ES too;
      fscale-denormal-double-rounding: results in the denormal range reached through the 2^-1000
        scaling step are rounded twice by the emulator (e.g. 1.25 2^-74 by -1001: 0 instead of
        2^-1074);
      f2xm1-outside-domain: undefined by the SDM; this CPU returns ST(0) unchanged, the emulator
        2^x - 1."""
    rng = g.rng
    inf, nan = float('inf'), float('nan')

    def full_bits(lo, hi):
        v = rng.uniform(lo, hi)
        b = struct.unpack('<Q', struct.pack('<d', v))[0] ^ rng.getrandbits(20)
        return struct.unpack('<d', struct.pack('<Q', b))[0]

    def t_trig_inf(c):
        op = rng.choice(['fsin', 'fcos', 'fsincos', 'fptan'])
        trans_state(g, c, [rng.choice([inf, -inf])], 1)
        g.add(c, op, fpu=True, tol=TRANS_TOL, fpucc=True, tag='trig-inf')

    def t_trig_qnan(c):
        op = rng.choice(['fsin', 'fcos', 'fsincos', 'fptan'])
        trans_state(g, c, [nan], 1)
        g.add(c, f'{op}; fnstsw ax; and eax, 0x80ff', fpu=True, tol=TRANS_TOL, tag='trig-qnan-ie')

    def t_es(c):
        form = rng.random()
        if form < 0.4:
            trans_state(g, c, [0.0, 0.0])
            asm = 'fyl2x; fnstsw ax; and eax, 0x80ff'
        elif form < 0.7:
            trans_state(g, c, [-1.0])
            asm = 'fsqrt; fnstsw ax; and eax, 0x80ff'
        else:
            trans_state(g, c, [0.0, inf])
            asm = 'fscale; fnstsw ax; and eax, 0x80ff'
        g.add(c, asm, fpu=True, tol=TRANS_TOL, tag='masked-es')

    def t_fscale_denormal(c):
        if rng.random() < 0.2:
            a, b = 1.25 * 2.0 ** -74, -1001.0
        else:
            a = math.ldexp(full_bits(1, 2), rng.randrange(-90, -60)) * rng.choice([1.0, -1.0])
            b = -float(1001 + rng.randrange(0, 30)) - rng.choice([0.0, rng.random()])
        trans_state(g, c, [a, b], 0)
        g.add(c, 'fscale', fpu=True, tol=None, tag='fscale-denormal-double-rounding')

    def t_f2xm1_outside(c):
        x = rng.choice([1.5, -1.5, 3.0, -3.0, 10.0, -70.0, rng.uniform(1, 60), rng.uniform(-60, -1)])
        trans_state(g, c, [x])
        g.add(c, 'f2xm1', fpu=True, tol=TRANS_TOL, tag='f2xm1-outside-domain')

    templates = [(3, t_trig_inf), (2, t_trig_qnan), (2, t_es), (3, t_fscale_denormal), (1, t_f2xm1_outside)]
    weights = [w for w, _ in templates]
    for _ in range(n):
        rng.choices(templates, weights=weights)[0][1](Case())
    return g


SUITES = {
    'alu': suite_alu,
    'stack': suite_stack,
    'branch': suite_branch,
    'string': suite_string,
    'x87': suite_x87,
    'sse': suite_sse,
    'verify_int': suite_verify_int,
    'verify_float': suite_verify_float,
    'verify_float_known': suite_verify_float_known,
    'verify_mech': suite_verify_mech,
    'verify_trans': suite_verify_trans,
    'verify_trans_known': suite_verify_trans_known,
}


# ======================================================================================
def mem_offset_of(operand):
    """Best effort: compute the scratch offset addressed by a memory operand string given regs."""
    return None


def patch_memory(c):
    """Apply post-finalize memory patches (float operands, divisors, cmpxchg8b equality...)."""
    def ea(opstr):
        # parse "[...]" -> offset in scratch using c.regs
        inner = opstr[opstr.index('[') + 1:opstr.index(']')]
        total = 0
        for term in inner.replace('-', '+-').split('+'):
            term = term.strip()
            if not term:
                continue
            neg = term.startswith('-')
            if neg:
                term = term[1:]
            if '*' in term:
                r, s = term.split('*')
                v = c.regs[R32.index(r)] * int(s)
            elif term in R32:
                v = c.regs[R32.index(term)]
            else:
                v = int(term, 0)
            total += -v if neg else v
        return (total - SCRATCH) & 0xffffffff

    rng = random.Random(c.code + bytes(c.regs[0] & 0xff for _ in range(1)))
    cmp = c.cmp
    if 'patchf32' in cmp:
        off = ea(cmp.pop('patchf32'))
        if off + 4 <= MEM_SIZE:
            struct.pack_into('<f', c.mem, off, f32_or(rng))
    if 'patchf64' in cmp:
        off = ea(cmp.pop('patchf64'))
        if off + 8 <= MEM_SIZE:
            struct.pack_into('<d', c.mem, off, rnd_double(rng))
    if 'patchf80' in cmp:
        off = ea(cmp.pop('patchf80'))
        if off + 10 <= MEM_SIZE:
            m, se = f64_to_f80(rnd_double(rng))
            struct.pack_into('<QH', c.mem, off, m, se)
    for key, kind in (('patchf32x4', 'f32'), ('patchf32x4x', 'f32x')):
        if key in cmp:
            off = ea(cmp.pop(key))
            if off + 16 <= MEM_SIZE:
                c.mem[off:off + 16] = rnd_xmm_bytes(rng, kind)
    if 'patchbytes' in cmp:
        for operand, hexdata in cmp.pop('patchbytes'):
            off = ea(operand)
            data = bytes.fromhex(hexdata)
            if off + len(data) <= MEM_SIZE:
                c.mem[off:off + len(data)] = data
    if 'patchf64x2' in cmp:
        off = ea(cmp.pop('patchf64x2'))
        if off + 16 <= MEM_SIZE:
            c.mem[off:off + 16] = rnd_xmm_bytes(rng, 'f64')
    if 'patchcw' in cmp:
        off = ea(cmp.pop('patchcw'))
        cw = rng.choice([0x027f, 0x037f, 0x007f, 0x0e7f, 0x0c7f, 0x0a7f, 0x087f, 0x127f, 0x1f7f, 0x0000])
        cw |= 0x3f  # keep exceptions masked
        struct.pack_into('<H', c.mem, off, cw)
    if 'divisor' in cmp:
        divisor, size = cmp.pop('divisor')
        # the divisor memory operand is the only memory operand of the snippet
        s = c.asm.split(' ', 1)[1]
        off = ea(s)
        if off + size <= MEM_SIZE:
            c.mem[off:off + size] = divisor.to_bytes(size, 'little')
    if 'cx8eq' in cmp:
        cmp.pop('cx8eq')
        off = ea(c.asm.split(' ', 1)[1])
        if off + 8 <= MEM_SIZE:
            struct.pack_into('<II', c.mem, off, c.regs[0], c.regs[2])
    if 'popf' in cmp:
        cmp.pop('popf')
        off = (c.regs[4] - SCRATCH) & 0x7ff
        if off + 4 <= MEM_SIZE:
            v = struct.unpack_from('<I', c.mem, off)[0] & ~(0x100 | 0x40000 | 0x30000 | 0x180000)
            struct.pack_into('<I', c.mem, off, v)
    if 'jmptarget' in cmp:
        cmp.pop('jmptarget')
        first = c.asm.split(';')[0]
        off = ea(first.split(' ', 1)[1])
        if off + 4 <= MEM_SIZE:
            struct.pack_into('<I', c.mem, off, CODE + len(c.code) - 1)


def pack_case(c):
    b = bytearray(CASE_SIZE)
    struct.pack_into('<I', b, 0, MAGIC)
    struct.pack_into('<8I', b, 4, *c.regs)
    struct.pack_into('<I', b, 36, c.eflags)
    struct.pack_into('<I', b, 40, len(c.code))
    b[48:48 + len(c.code)] = c.code
    b[112:624] = c.fx
    b[624:624 + MEM_SIZE] = c.mem
    return bytes(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--suite', required=True, choices=list(SUITES) + ['all'])
    ap.add_argument('--count', type=int, default=2000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--out', default='tests/generated')
    ap.add_argument('--oracle', default='build/oracle')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    suites = list(SUITES) if args.suite == 'all' else [args.suite]
    for name in suites:
        rng = random.Random(f'{args.seed}:{name}')
        g = Gen(rng)
        SUITES[name](g, args.count)
        g.assemble_all()
        for c in g.cases:
            g.finalize(c)
            patch_memory(c)
        blob = b''.join(pack_case(c) for c in g.cases)
        with open(os.path.join(args.out, f'{name}.cases.bin'), 'wb') as f:
            f.write(blob)
        p = subprocess.run([args.oracle], input=blob, capture_output=True, timeout=300)
        if p.returncode != 0 or len(p.stdout) != RESULT_SIZE * len(g.cases):
            sys.stderr.write(p.stderr.decode(errors='replace'))
            raise SystemExit(f'oracle failed for suite {name}: rc={p.returncode} out={len(p.stdout)}')
        with open(os.path.join(args.out, f'{name}.results.bin'), 'wb') as f:
            f.write(p.stdout)
        meta = [{'asm': c.asm, 'mask': c.mask, **c.cmp} for c in g.cases]
        with open(os.path.join(args.out, f'{name}.meta.json'), 'w') as f:
            json.dump(meta, f)
        faults = sum(1 for i in range(len(g.cases)) if struct.unpack_from('<I', p.stdout, i * RESULT_SIZE + 36)[0])
        print(f'{name}: {len(g.cases)} cases, {faults} faulted natively')


if __name__ == '__main__':
    main()
