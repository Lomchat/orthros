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


def rnd_xmm_bytes(rng, kind):
    if kind == 'f32':
        return b''.join(struct.pack('<f', f32_or(rng)) for _ in range(4))
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


def rnd_sse_state(g, c, kind='int'):
    rng = g.rng
    xmm = [rnd_xmm_bytes(rng, kind) for _ in range(8)]
    mxcsr = 0x1f80
    c.fx = default_fx(rng, xmm=xmm, mxcsr=mxcsr)
    c.cmp['xmm'] = True


def rnd_mmx_state(g, c):
    rng = g.rng
    # MMX registers alias the x87 mantissas: put random 64-bit patterns, tags valid, top 0
    fx = default_fx(rng, top=0, valid_mask=0xff)
    for i in range(8):
        struct.pack_into('<QH', fx, 32 + 16 * i, rng.getrandbits(64), 0xffff)
    c.fx = fx
    c.cmp['mmx'] = True


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
    for _ in range(n):
        c = Case()
        k = rng.random()
        if k < 0.22:
            op = rng.choice(ps_ops)
            rnd_sse_state(g, c, 'f32')
            d = f'xmm{rng.randrange(8)}'
            if rng.random() < 0.4:
                s, _ = g.mem(c, 16, align=16); c.cmp['patchf32x4'] = s
            else:
                s = f'xmm{rng.randrange(8)}'
            if op in ('movaps', 'movups') and rng.random() < 0.5:
                s, d = d, (g.mem(c, 16, align=16)[0])
            g.add(c, f'{op} {d}, {s}', xmm=True)
        elif k < 0.40:
            op = rng.choice(ss_ops)
            rnd_sse_state(g, c, 'f32')
            d = f'xmm{rng.randrange(8)}'
            if rng.random() < 0.4:
                s, _ = g.mem(c, 4); c.cmp['patchf32'] = s
            else:
                s = f'xmm{rng.randrange(8)}'
            if op == 'movss' and rng.random() < 0.5:
                s, d = d, g.mem(c, 4)[0]
            mask = ALLF if op in ('ucomiss', 'comiss') else ALLF
            g.add(c, f'{op} {d}, {s}', mask, xmm=True)
        elif k < 0.55:
            op = rng.choice(pd_ops)
            rnd_sse_state(g, c, 'f64')
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
        elif k < 0.68:
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
        elif k < 0.85:
            op = rng.choice(int_ops)
            use_mmx = rng.random() < 0.3 and op not in ('movdqa', 'movdqu', 'punpcklqdq', 'punpckhqdq', 'paddq', 'psubq', 'pmuludq')
            if use_mmx:
                rnd_mmx_state(g, c)
                d = f'mm{rng.randrange(8)}'
                if rng.random() < 0.4:
                    s, _ = g.mem(c, 4 if op in ('punpcklbw', 'punpcklwd', 'punpckldq') else 8)
                else:
                    s = f'mm{rng.randrange(8)}'
                if op in ('psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad') and rng.random() < 0.5:
                    s = f'{rng.choice([0, 1, 3, 7, 8, 15, 16, 31, 32, 63, 64, 200])}'
                g.add(c, f'{op} {d}, {s}', mmx=True)
            else:
                rnd_sse_state(g, c, 'int')
                d = f'xmm{rng.randrange(8)}'
                if rng.random() < 0.4:
                    s, _ = g.mem(c, 16, align=16 if op != 'movdqu' else 1)
                else:
                    s = f'xmm{rng.randrange(8)}'
                if op in ('psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad') and rng.random() < 0.5:
                    s = f'{rng.choice([0, 1, 3, 7, 8, 15, 16, 31, 32, 63, 64, 200])}'
                if op in ('movdqa', 'movdqu') and rng.random() < 0.5:
                    s, d = d, g.mem(c, 16, align=16 if op == 'movdqa' else 1)[0]
                g.add(c, f'{op} {d}, {s}', xmm=True)
        else:
            # shuffles, moves between gpr/xmm, conversions with gpr, extract/insert, masks, cmp predicates
            form = rng.random()
            if form < 0.15:
                rnd_sse_state(g, c, 'f32')
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
                rnd_sse_state(g, c, kind)
                op = rng.choice(['cvtsi2ss', 'cvtsi2sd', 'cvtss2si', 'cvtsd2si', 'cvttss2si', 'cvttsd2si'])
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
                kind = rng.choice(['f32', 'f64'])
                rnd_sse_state(g, c, kind)
                op = {'f32': rng.choice(['cmpps', 'cmpss']), 'f64': rng.choice(['cmppd', 'cmpsd'])}[kind]
                g.add(c, f'{op} xmm{rng.randrange(8)}, xmm{rng.randrange(8)}, {rng.randrange(8)}', xmm=True)
            else:
                rnd_sse_state(g, c, 'f32')
                op = rng.choice(['movlps', 'movhps', 'movlhps', 'movhlps', 'movlps_out', 'movhps_out', 'movlpd', 'movhpd'])
                x = f'xmm{rng.randrange(8)}'
                if op in ('movlhps', 'movhlps'):
                    g.add(c, f'{op} {x}, xmm{rng.randrange(8)}', xmm=True)
                elif op.endswith('_out'):
                    m, _ = g.mem(c, 8); g.add(c, f'{op[:-4]} {m}, {x}', xmm=True)
                else:
                    m, _ = g.mem(c, 8); g.add(c, f'{op} {x}, {m}', xmm=True)
    return g


SUITES = {
    'alu': suite_alu,
    'stack': suite_stack,
    'branch': suite_branch,
    'string': suite_string,
    'x87': suite_x87,
    'sse': suite_sse,
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
    if 'patchf32x4' in cmp:
        off = ea(cmp.pop('patchf32x4'))
        if off + 16 <= MEM_SIZE:
            c.mem[off:off + 16] = rnd_xmm_bytes(rng, 'f32')
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
