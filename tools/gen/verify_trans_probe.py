#!/usr/bin/env python3
"""Probe the native oracle with hand-picked x87 transcendental cases and print the hardware
results (value, f80 bits, status word), i.e. the facts behind suite_verify_trans, suite_verify_trans2
and suite_verify_trans_known in gen_cases.py: trig of +-inf / NaN / 2^63, the trig accuracy at large
arguments, C0-C3 preservation, the FSCALE / FYL2X / FYL2XP1 / FPATAN / F2XM1 special-value tables,
the NaN operand rules, and (hardware-truth verification of D034) the UNMASKED exceptions (abort
of the instruction, ES and B, the post-computation ones), stack overflow on the FSINCOS / FPTAN
push, the sign of two NaNs, F2XM1 at 1 +- ulp, C bits on the exception paths, PC / RC effects.
Run from the repository root after `make tools`: python3 tools/gen/verify_trans_probe.py [build/oracle]"""
import math, os, random, struct, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_cases as G  # noqa: E402

ORACLE = sys.argv[1] if len(sys.argv) > 1 else 'build/oracle'
inf, nan = float('inf'), float('nan')


def run(cases):
    """cases: (asm, ST values in stack order, nvalid, fcw, extra status-word bits[, memory word at
    scratch + 0x100]) -> results (fsw, TOP, tags, ST values and raw f80 bits, EAX, native fault)."""
    rng = random.Random(1)
    g = G.Gen(rng)
    objs = []
    for case in cases:
        asm, values, nvalid, fcw, sw_extra = case[:5]
        c = G.Case()
        vm = sum(1 << i for i in range(nvalid))  # TOP = 0
        vals = list(values) + [0.0] * (8 - len(values))
        c.fx = G.default_fx(rng, top=0, valid_mask=vm, values=vals, fcw=fcw)
        if sw_extra:
            struct.pack_into('<H', c.fx, 2, sw_extra)
        if len(case) > 5:
            c.mem = bytearray(G.MEM_SIZE)
            struct.pack_into('<H', c.mem, 0x100, case[5])
        g.add(c, asm, fpu=True)
        objs.append(c)
    g.assemble_all()
    for c in objs:
        g.finalize(c)
        G.patch_memory(c)
    blob = b''.join(G.pack_case(c) for c in objs)
    p = subprocess.run([ORACLE], input=blob, capture_output=True, timeout=300)
    assert p.returncode == 0 and len(p.stdout) == G.RESULT_SIZE * len(objs), (p.returncode, p.stderr)
    out = []
    for i, c in enumerate(objs):
        r = p.stdout[i * G.RESULT_SIZE:(i + 1) * G.RESULT_SIZE]
        fsw = struct.unpack_from('<H', r, 48 + 2)[0]
        regs = [struct.unpack_from('<QH', r, 48 + 32 + 16 * k) for k in range(8)]
        out.append({'asm': c.asm, 'fsw': fsw, 'top': (fsw >> 11) & 7, 'tw': r[48 + 4], 'eax': struct.unpack_from('<I', r, 0)[0],
                    'fault': struct.unpack_from('<I', r, 36)[0], 'st': [G.f80_to_f64(m, se) for m, se in regs], 'raw': regs})
    return out


def fmt_sw(sw):
    names = [('IE', 0), ('DE', 1), ('ZE', 2), ('OE', 3), ('UE', 4), ('PE', 5), ('SF', 6), ('ES', 7), ('C0', 8), ('C1', 9), ('C2', 10), ('C3', 14), ('B', 15)]
    return '|'.join(n for n, b in names if sw & (1 << b)) or '-'


def nanv(bits):
    """an f64 NaN by bit pattern (struct keeps the payload)"""
    return struct.unpack('<d', struct.pack('<Q', bits))[0]


NAN_NAMES = {}
for _n, _b in [('sN1', 0x7ff0000000000001), ('sN2', 0x7ff0000000000002), ('-sN1', 0xfff0000000000001), ('-sN2', 0xfff0000000000002), ('qN', 0x7ff8000000000000),
               ('-qN', 0xfff8000000000000), ('q1', 0x7ff8000000000001), ('q2', 0x7ff8000000000002), ('-q1', 0xfff8000000000001), ('-q2', 0xfff8000000000002)]:
    NAN_NAMES[_n] = nanv(_b)
NAN_BY_VALUE = {id(v): n for n, v in NAN_NAMES.items()}  # the same float objects flow through run(): identity lookup


def table(title, cases, n=2, fcw=0x027f, sw=0):
    """print a section: cases = (asm, values, nvalid[, memory control word]); fcw may be a list (one per case)"""
    print(f'--- {title}')
    full = []
    for i, case in enumerate(cases):
        cw = fcw[i] if isinstance(fcw, list) else fcw
        full.append((case[0], case[1], case[2], cw, sw) + tuple(case[3:]))
    res = run(full)
    for r, case in zip(res, cases):
        raws = ', '.join(f'{m:016x}:{se:04x}' for m, se in r['raw'][:n])
        vs = ', '.join(NAN_BY_VALUE.get(id(v), repr(v)) for v in case[1])
        extra = f" eax={r['eax']:04x}" if 'fnstsw' in case[0] else ''
        extra += f" FAULT sig {r['fault']}" if r['fault'] else ''
        print(f"{case[0]:<38} in=[{vs}] top={r['top']} tw={r['tw']:08b} sw={fmt_sw(r['fsw']):<16}{extra} raw={raws}")
    return res


def show(res, n=2):
    for r in res:
        vals = ', '.join(repr(v) for v in r['st'][:n])
        raws = ', '.join(f'{m:016x}:{se:04x}' for m, se in r['raw'][:n])
        print(f"{r['asm']:<34} top={r['top']} tw={r['tw']:08b} sw={fmt_sw(r['fsw']):<16} st={vals}  raw={raws}")


def main():
    print('--- trig of inf / NaN / 2^63 / 1e300 / +-0 (SDM: inf -> IE + indefinite; |x| >= 2^63 -> C2, unchanged)')
    show(run([(op, [x, 7.0], 2, 0x027f, 0) for op in ('fsin', 'fcos', 'fsincos', 'fptan')
              for x in (inf, -inf, nan, 2.0 ** 63, -(2.0 ** 63), 2.0 ** 63 - 1024, 2.0 ** 62, 1e300, 0.0, -0.0)]), 3)
    print('--- hardware trig accuracy vs Python math (absolute error; the reduction carries ~66 bits of pi)')
    xs = [1e5, 1e6, 1647099.0, 1e7, 1e8, 1e9, 1e10, 1e12, 1e15, 2.0 ** 50, 2.0 ** 60, 2.0 ** 62, 2.0 ** 63 - 1024, 100 * math.pi, 1e6 * math.pi, 5419351.0]
    for r, x in zip(run([('fsin', [x], 1, 0x027f, 0) for x in xs] + [('fcos', [x], 1, 0x027f, 0) for x in xs]), xs + xs):
        want = math.sin(x) if r['asm'] == 'fsin' else math.cos(x)
        print(f"{r['asm']} x={x!r:<22} hw={r['st'][0]!r:<24} py={want!r:<24} abs={abs(r['st'][0] - want):.3e}")
    print('--- FPTAN near the poles (|x| <= 100): relative error vs Python math')
    xs = [k * math.pi / 2 + d for k in (1, 3, 11, 31, 63) for d in (0.0, 1e-6)]
    for r, x in zip(run([('fptan', [x], 1, 0x027f, 0) for x in xs]), xs):
        want = math.tan(x)
        print(f"fptan x={x!r:<22} hw={r['st'][1]!r:<24} py={want!r:<24} rel={abs(r['st'][1] - want) / max(1, abs(want)):.3e}")
    print('--- condition codes: initial C0|C1|C2|C3 (0x4700) versus 0 before each op')
    ops = [('f2xm1', [0.5], 1), ('fyl2x', [3.0, 2.0], 2), ('fyl2xp1', [0.1, 2.0], 2), ('fpatan', [1.0, 2.0], 2), ('fscale', [1.5, 3.0], 2),
           ('fsin', [1.0], 1), ('fcos', [1.0], 1), ('fsincos', [1.0], 1), ('fptan', [1.0], 1), ('fsin', [2.0 ** 63], 1), ('fptan', [2.0 ** 63], 1),
           ('fsin', [nan], 1), ('fsin', [inf], 1), ('fptan; fstp st(1)', [2.0 ** 63, 5.0], 2), ('fsin; fld1; faddp st(1), st', [2.0 ** 63, 5.0], 2)]
    show(run([(op, vals, nv, 0x027f, sw) for op, vals, nv in ops for sw in (0x4700, 0)]), 2)
    print('--- masked exceptions through FNSTSW (ES must stay clear)')
    show(run([('fsin; fnstsw ax; and eax, 0x80ff', [nan], 1, 0x027f, 0), ('fsin; fnstsw ax; and eax, 0x80ff', [inf], 1, 0x027f, 0),
              ('fyl2x; fnstsw ax; and eax, 0x80ff', [0.0, 0.0], 2, 0x027f, 0), ('fsqrt; fnstsw ax; and eax, 0x80ff', [-1.0], 1, 0x027f, 0)]), 1)
    print('--- FSCALE specials (ST0 = a, ST1 = b)')
    show(run([('fscale', [a, b], 2, 0x027f, 0) for a, b in [
        (0.0, inf), (-0.0, inf), (inf, inf), (-inf, inf), (3.0, inf), (-3.0, inf), (0.0, -inf), (3.0, -inf), (-3.0, -inf), (inf, -inf), (-inf, -inf),
        (nan, 3.0), (3.0, nan), (nan, nan), (1.5, 1e300), (1.5, -1e300), (1.5, 1023.9), (1.5, -1074.5), (1.5, -1075.0), (2.0 ** -1073, -1.0), (2.0 ** -1073, -2.0),
        (1.25 * 2.0 ** -74, -1001.0), (1.5, 0.9), (1.5, -0.9), (1e308, 1.0), (1e-308, -60.0), (inf, 5.0), (0.0, 5.0), (-0.0, -5.0), (5.0, 0.0), (5.0, -0.0),
        (1.0000000000000002 * 2.0 ** -1022, -1.0), (3 * 2.0 ** -1074, -1.0), (5 * 2.0 ** -1074, -1.0)]]), 2)
    print('--- FYL2X specials (ST0 = x, ST1 = y): result in ST(0) after the pop')
    show(run([('fyl2x', [x, y], 2, 0x027f, 0) for x, y in [
        (0.0, 0.0), (0.0, 5.0), (0.0, -5.0), (-0.0, 5.0), (0.0, inf), (0.0, -inf), (inf, 0.0), (inf, 5.0), (inf, -5.0), (inf, inf), (1.0, inf), (1.0, -inf),
        (1.0, 5.0), (1.0, -5.0), (1.0, 0.0), (-1.0, 5.0), (-inf, 5.0), (nan, 5.0), (5.0, nan), (2.0, 0.0), (2.0, -0.0), (0.5, 0.0), (2.0 ** -1074, 1.0),
        (2.0 ** -1022, 1.0), (1e300, 1e300), (1e300, -1e300), (2.0 ** 1023, 1.0), (1.0000000000000002, 1.0), (0.9999999999999999, 1.0)]]), 1)
    print('--- FYL2XP1 specials (ST0 = x, ST1 = y)')
    show(run([('fyl2xp1', [x, y], 2, 0x027f, 0) for x, y in [
        (0.0, 5.0), (-0.0, 5.0), (0.0, -5.0), (-1.0, 5.0), (-0.5, 5.0), (1.0, 5.0), (-(1 - math.sqrt(2) / 2), 1.0), (math.sqrt(2) - 1, 1.0), (3.0, 1.0),
        (inf, 1.0), (nan, 1.0), (0.1, nan), (2.0 ** -1074, 1.0), (2.0 ** -1074, 1e300), (1e-300, 1.0), (0.1, inf), (0.0, inf), (0.0, nan), (-0.9, 1.0), (1e300, 1.0)]]), 1)
    print('--- FPATAN specials (ST0 = x, ST1 = y) = atan2(y, x)')
    sp = [-inf, -2.0, -0.0, 0.0, 2.0, inf, nan]
    for r, (x, y) in zip(run([('fpatan', [x, y], 2, 0x027f, 0) for x in sp for y in sp]), [(x, y) for x in sp for y in sp]):
        py = nan if math.isnan(x) or math.isnan(y) else math.atan2(y, x)
        print(f"fpatan x={x!r:<6} y={y!r:<6} hw={r['st'][0]!r:<24} py={py!r:<24} sw={fmt_sw(r['fsw'])}")
    print('--- F2XM1 (outside [-1, 1] is undefined by the SDM)')
    xs = [-1.0, 1.0, 0.0, -0.0, 2.0 ** -1074, 1e-300, 2.0 ** -30, 0.5, -0.5, 0.9999999999999999, -0.9999999999999999, 1.5, -1.5, 3.0, 10.0, -70.0, 1024.0, 60.0, 1e300, -1e300, inf, -inf, nan]
    for r, x in zip(run([('f2xm1', [x], 1, 0x027f, 0) for x in xs]), xs):
        want = math.expm1(x * math.log(2)) if math.isfinite(x) and x < 1024 else (inf if x > 0 else -1.0)
        print(f"f2xm1 x={x!r:<22} hw={r['st'][0]!r:<24} py={want!r:<24} sw={fmt_sw(r['fsw'])} raw={r['raw'][0][0]:016x}:{r['raw'][0][1]:04x}")
    print('--- NaN operands: SNaN (IE, quieted), QNaN sign/payload kept, two NaNs (the larger significand wins)')
    # f64 NaNs by bit pattern (struct keeps the payload); f64_to_f80 maps bit 51 (quiet) to bit 62 of the f80 significand
    nb = lambda bits: struct.unpack('<d', struct.pack('<Q', bits))[0]
    SN, SNM, QN, QNM, QP1, QP2, SP2, QNEG_P1 = (nb(0x7ff0000000000001), nb(0xfff0000000000001), nb(0x7ff8000000000000), nb(0xfff8000000000000),
                                              nb(0x7ff8000000000001), nb(0x7ff8000000000002), nb(0x7ff0000000000002), nb(0xfff8000000000001))
    names = {SN: 'sNaN(1)', SNM: '-sNaN(1)', QN: 'qNaN', QNM: '-qNaN', QP1: 'qNaN(1)', QP2: 'qNaN(2)', SP2: 'sNaN(2)', QNEG_P1: '-qNaN(1)'}
    name = lambda v: names.get(v, repr(v))  # the same float objects flow through run(): identity lookup
    unary = [(op, [x, 7.0], 2) for op in ('fsin', 'fcos', 'fsincos', 'fptan', 'f2xm1') for x in (SN, SNM, QN, QNM, QP1, QNEG_P1)]
    for r, (op, vals, nv) in zip(run([(op, vals, nv, 0x027f, 0) for op, vals, nv in unary]), unary):
        raws = ', '.join(f'{m:016x}:{se:04x}' for m, se in r['raw'][:2])
        print(f"{op:<8} x={name(vals[0]):<10} top={r['top']} sw={fmt_sw(r['fsw']):<8} raw={raws}")
    pairs = [(SN, 3.0), (3.0, SN), (SNM, 3.0), (QN, 3.0), (3.0, QNM), (QP1, 3.0), (3.0, QP1), (QP1, QP2), (QP2, QP1), (QN, QNM), (QNM, QN), (QP1, QNEG_P1), (QNEG_P1, QP1),
             (SN, QN), (QN, SN), (SP2, QP1), (QP1, SP2), (SN, SP2), (SP2, SN), (SN, 0.0), (0.0, SN), (QN, 0.0), (QN, inf), (inf, QN), (SN, inf)]
    for op in ('fscale', 'fyl2x', 'fyl2xp1', 'fpatan'):
        for r, (a, b) in zip(run([(op, [a, b], 2, 0x027f, 0) for a, b in pairs]), pairs):
            m, se = r['raw'][0]
            print(f"{op:<8} st0={name(a):<10} st1={name(b):<10} top={r['top']} sw={fmt_sw(r['fsw']):<8} result={m:016x}:{se:04x}")
    print('--- zero divisors: FYL2X(0, y) ZE, FYL2XP1(-1, y) (outside the domain)')
    zs = [('fyl2x', [0.0, y], 2) for y in (5.0, -5.0, inf, -inf, 0.0, 1e300, 2.0 ** -1074)] + [('fyl2x', [-0.0, y], 2) for y in (5.0, -inf)] + \
         [('fyl2xp1', [-1.0, y], 2) for y in (1.0, 5.0, -5.0, inf, 0.0)] + [('fyl2xp1', [inf, y], 2) for y in (0.0, 5.0, -5.0)] + [('fyl2xp1', [x, 1.0], 2) for x in (-1.5, -2.0, -inf, 3.0)]
    for r, (op, vals, nv) in zip(run([(op, vals, nv, 0x027f, 0) for op, vals, nv in zs]), zs):
        m, se = r['raw'][0]
        print(f"{op:<8} st0={vals[0]!r:<8} st1={vals[1]!r:<8} sw={fmt_sw(r['fsw']):<8} st={r['st'][0]!r:<24} raw={m:016x}:{se:04x}")


def main2():
    """Hardware-truth verification of D034 (the facts behind suite_verify_trans2 and the tags
    unmasked-abort / stack-overflow-push / unmasked-post-computation of suite_verify_trans_known)."""
    SN1, SN2, NSN1, NSN2, QN, NQN, Q1, Q2, NQ1, NQ2 = (NAN_NAMES[k] for k in ('sN1', 'sN2', '-sN1', '-sN2', 'qN', '-qN', 'q1', 'q2', '-q1', '-q2'))
    print('=== unmasked exceptions: control word bit 0 (IE) clear = 0x027e, bit 2 (ZE) clear = 0x027b, bit 5 (PE) clear = 0x025f, OE 0x0277, UE 0x026f, DE 0x027d')
    table('unmasked IE: the instruction is ABORTED (no result, no push / pop, SNaN not quieted), IE | ES (| B in FNSTSW); no #MF here (no waiting FPU instruction follows)', [
        ('fsin', [inf, 7.0], 2), ('fcos', [-inf, 7.0], 2), ('fsincos', [inf, 7.0], 2), ('fptan', [inf, 7.0], 2), ('fsin', [SN1, 7.0], 2), ('fsin', [QN, 7.0], 2), ('fsin', [2.0 ** 63, 7.0], 2), ('fsin', [1.0, 7.0], 2),
        ('fyl2x', [0.0, 0.0], 2), ('fyl2x', [-1.0, 5.0], 2), ('fyl2x', [SN1, 5.0], 2), ('fyl2x', [3.0, SN1], 2), ('fyl2xp1', [SN1, 1.0], 2), ('fyl2xp1', [0.0, inf], 2), ('fscale', [0.0, inf], 2), ('fscale', [SN1, 1.0], 2),
        ('fscale', [1.5, 2.0], 2), ('fpatan', [SN1, 1.0], 2), ('f2xm1', [SN1, 7.0], 2), ('fsqrt', [-1.0, 7.0], 2), ('fsqrt', [SN1, 7.0], 2),
        ('fsin; fnstsw ax; and eax, 0xffff', [inf, 7.0], 2), ('fsin; fnclex', [inf, 7.0], 2), ('fsin; fnclex; fsin', [inf, 7.0], 2), ('fsin; fnstsw ax; and eax, 0x80ff; fnclex', [inf, 7.0], 2)], 3, fcw=0x027e)
    table('unmasked IE with every C bit set beforehand (0x4700): C2 cleared by the trig, all kept by FYL2X', [('fsin', [inf, 7.0], 2), ('fyl2x', [0.0, 0.0], 2), ('fptan', [inf, 7.0], 2)], 3, fcw=0x027e, sw=0x4700)
    table('unmasked IE: stack overflow / underflow: nothing happens but IE | SF | ES (C1 on overflow)', [('fptan', [1.0] * 8, 8), ('fsincos', [1.0] * 8, 8), ('fld1', [1.0] * 8, 8), ('fptan', [2.0 ** 63] * 8, 8), ('fsin', [], 0), ('fyl2x', [1.0], 1), ('fld1; fsin', [], 0)], 3, fcw=0x027e)
    table('masked: stack overflow on the FSINCOS / FPTAN push pre-empts the argument: TOP - 1, the indefinite in ST(0) AND ST(1), IE | SF | C1, C2 clear (FLD1: ST(1) kept)', [
        ('fptan', [1.0] * 8, 8), ('fsincos', [1.0] * 8, 8), ('fld1', [1.0] * 8, 8), ('fptan', [2.0 ** 63] * 8, 8), ('fptan', [inf] * 8, 8), ('fptan', [QN] * 8, 8)], 3)
    table('masked: stack underflow (ST(0) empty): the indefinite written (twice for FPTAN / FSINCOS), IE | SF', [('fsin', [], 0), ('fyl2x', [1.0], 1), ('fptan', [], 0), ('fsincos', [], 0), ('fscale', [1.0], 1), ('fpatan', [1.0], 1)], 2)
    table('unmasked ZE (0x027b): FYL2X(+-0, finite y) aborted, ZE | ES; y = +-inf / IE paths / normal paths unaffected', [('fyl2x', [0.0, 5.0], 2), ('fyl2x', [0.0, -5.0], 2), ('fyl2x', [-0.0, 5.0], 2), ('fyl2x', [0.0, inf], 2), ('fyl2xp1', [-1.0, 5.0], 2), ('fyl2x', [0.0, 0.0], 2), ('fyl2x', [3.0, 2.0], 2)], 2, fcw=0x027b)
    table('unmasked PE (0x025f): post-computation: the result IS written, PE | ES (FSCALE exact and FSIN(0): no flag)', [('fsin', [1.0, 7.0], 2), ('f2xm1', [0.5, 7.0], 2), ('fyl2x', [3.0, 2.0], 2), ('fpatan', [1.0, 2.0], 2), ('fscale', [1.5, 2.0], 2), ('fsincos', [1.0, 7.0], 2), ('fptan', [1.0, 7.0], 2), ('f2xm1', [1.0, 7.0], 2), ('fsin', [0.0, 7.0], 2)], 3, fcw=0x025f)
    table('unmasked OE (0x0277): FSCALE writes the exponent wrapped by -24576 (0x2e1f = 20000 + 16383 - 24576), OE | ES; 1e300 scale: +inf, OE | PE', [('fscale', [1.5, 1e300], 2), ('fscale', [1.5, 20000.0], 2), ('fscale', [1.5, 16400.0], 2)], 2, fcw=0x0277)
    table('unmasked UE (0x026f): exponent wrapped by +24576', [('fscale', [1.5, -1e300], 2), ('fscale', [1.5, -20000.0], 2), ('fscale', [1.5, -16400.0], 2)], 2, fcw=0x026f)
    table('unmasked DE (0x027d): f64 denormals are f80 normals, no DE', [('fsin', [5e-324, 7.0], 2), ('fscale', [5e-324, 1.0], 2), ('f2xm1', [5e-324, 7.0], 2)], 2, fcw=0x027d)
    table('OTHER exceptions unmasked than the one raised: flag only, ES clear, result written (cw per case: 027b, 027e, 025f, 0261, 0261, 0261)', [
        ('fyl2x', [0.0, 0.0], 2), ('fyl2x', [0.0, 5.0], 2), ('fsin', [inf, 1.0], 2), ('fsin', [SN1, 1.0], 2), ('fscale', [0.0, inf], 2), ('fsqrt', [-1.0, 1.0], 2)], 1, fcw=[0x027b, 0x027e, 0x025f, 0x0261, 0x0261, 0x0261])
    table('all six unmasked (0x0240): exact operations raise nothing; FYL2X sets PE even on exact powers of two (2, 8, 0.5, 2^-1074), F2XM1 outside the domain sets PE', [
        ('fscale', [1.5, 2.0], 2), ('fyl2x', [1.0, 5.0], 2), ('fyl2x', [0.0, inf], 2), ('fpatan', [2.0, 0.0], 2), ('fsin', [0.0, 1.0], 2), ('fcos', [0.0, 1.0], 2), ('f2xm1', [0.0, 1.0], 2), ('f2xm1', [-0.0, 1.0], 2), ('fsqrt', [4.0, 1.0], 2),
        ('fscale', [3.0, inf], 2), ('fscale', [3.0, -inf], 2), ('fsin', [QN, 1.0], 2), ('fyl2xp1', [0.0, 5.0], 2), ('fsincos', [0.0, 1.0], 2), ('fptan', [0.0, 1.0], 2), ('fsin', [2.0 ** 63, 1.0], 2), ('fyl2xp1', [inf, 5.0], 2),
        ('f2xm1', [1.5, 1.0], 2), ('f2xm1', [inf, 1.0], 2), ('fyl2x', [2.0, 3.0], 2), ('fyl2x', [8.0, 1.0], 2), ('fyl2x', [0.5, 1.0], 2), ('fyl2x', [2.0 ** -1074, 1.0], 2), ('fscale', [1.5, 1e300], 2)], 1, fcw=0x0240)
    table('FLDCW from memory right before the instruction: the loaded mask rules (memory word at scratch + 0x100)', [
        ('fldcw word ptr [0x10000100]; fsin', [inf, 1.0], 2, 0x027e), ('fldcw word ptr [0x10000100]; fyl2x', [0.0, 0.0], 2, 0x027e), ('fldcw word ptr [0x10000100]; fyl2x', [0.0, 5.0], 2, 0x027e),
        ('fldcw word ptr [0x10000100]; fyl2x', [0.0, 5.0], 2, 0x027b)], 1, fcw=0x027f)
    table('FLDCW masking a previously unmasked control word', [('fldcw word ptr [0x10000100]; fsin', [inf, 1.0], 2, 0x027f)], 1, fcw=0x027e)
    table('B (bit 15) of FNSTSW / FXSAVE reflects ES: preset ES (masked) shows B, FNCLEX clears both, an unmasked IE sets both', [
        ('fnstsw ax; and eax, 0xffff', [1.0], 1), ('fnstsw ax; and eax, 0xffff', [1.0], 1), ('fnstsw ax; and eax, 0xffff', [1.0], 1), ('fnclex; fnstsw ax; and eax, 0xffff', [1.0], 1)], 1, sw=0x0080)
    table('  (preset IE only: no B; preset B only in the image: B stays with ES clear? see fsw)', [('fnstsw ax; and eax, 0xffff', [1.0], 1)], 1, sw=0x0001)
    table('  (preset 0x8000 alone)', [('fnstsw ax; and eax, 0xffff', [1.0], 1)], 1, sw=0x8000)
    table('  (unmasked IE raised)', [('fsin; fnstsw ax; and eax, 0xffff', [inf], 1)], 1, fcw=0x027e)
    table('ES is derived (flags & ~masks) whenever the status / control word changes, not stored: an FXRSTOR image with ES (| IE) and every mask set reads back without ES', [
        ('fnstsw ax; and eax, 0xffff', [1.0], 1), ('fsin; fnstsw ax; and eax, 0xffff', [1.0], 1)], 1, fcw=0x027f, sw=0x0081)
    table('FLDCW unmasking a pending (masked) IE flag: IE | ES | B at once, no fault until the next WAITING instruction (FSIN -> #MF, SIGFPE 8, the snippet is aborted there; FNSTSW / FNCLEX are non-waiting)', [
        ('fldcw word ptr [0x10000100]; fnstsw ax; and eax, 0xffff', [1.0], 1, 0x027e), ('fldcw word ptr [0x10000100]; fnstsw ax; and eax, 0xffff', [1.0], 1, 0x025f),
        ('fldcw word ptr [0x10000100]; fsin; fnstsw ax; and eax, 0xffff', [1.0], 1, 0x027e), ('fldcw word ptr [0x10000100]; fnclex; fsin; fnstsw ax; and eax, 0xffff', [1.0], 1, 0x027e),
        ('fsin; fldcw word ptr [0x10000100]; fnstsw ax; and eax, 0xffff', [inf], 1, 0x027e), ('fsin; fldcw word ptr [0x10000100]; fnstsw ax; and eax, 0xffff; fsin', [inf], 1, 0x027e)], 1, fcw=0x027f, sw=0x0001)
    table('a pending unmasked IE (image IE | ES, IE unmasked): FLDCW is itself a waiting instruction (#MF before it loads the masking word); FNSTSW reads IE | ES | B', [
        ('fldcw word ptr [0x10000100]; fnstsw ax; and eax, 0xffff', [1.0], 1, 0x027f), ('fnstsw ax; and eax, 0xffff', [1.0], 1), ('fsin', [1.0], 1)], 1, fcw=0x027e, sw=0x0081)
    print('=== NaN operands: two NaNs, sign versus significand (the larger significand wins and keeps its sign; positive on a tie; quiet bit included)')
    pairs = [(NQ2, Q1), (Q1, NQ2), (NQ1, NQ2), (NQ2, NQ1), (NQ1, Q2), (Q2, NQ1), (NSN2, Q1), (Q1, NSN2), (NSN1, NSN2), (SN1, NSN2), (NSN2, SN1), (NSN1, SN1), (SN1, NSN1), (NQN, NQ1), (NQ1, NQN), (NQ2, NQ2), (NQN, NQN)]
    for op in ('fscale', 'fyl2x', 'fyl2xp1', 'fpatan'):
        table(f'{op} (st0, st1)', [(op, [a, b], 2) for a, b in pairs], 1)
    table('the NaN rule precedes the domain rule (x < 0, x = 0, inf, 1 with a NaN partner: propagated, IE only for an SNaN)', [
        ('fyl2x', [-1.0, QN], 2), ('fyl2x', [0.0, QN], 2), ('fyl2x', [0.0, SN1], 2), ('fyl2x', [QN, 0.0], 2), ('fyl2x', [-inf, NQ1], 2), ('fyl2x', [1.0, QN], 2), ('fscale', [0.0, QN], 2), ('fscale', [QN, inf], 2), ('fscale', [inf, NQ1], 2),
        ('fscale', [NQ1, -inf], 2), ('fyl2xp1', [-2.0, QN], 2), ('fyl2xp1', [QN, inf], 2), ('fyl2xp1', [-1.0, NQ1], 2), ('fpatan', [QN, 0.0], 2), ('fpatan', [0.0, NQ1], 2), ('fsqrt', [NQ1, 1.0], 2), ('fsqrt', [NSN1, 1.0], 2), ('fsqrt', [-0.0, 1.0], 2)], 1)
    print('=== domain edges')
    xs = [1.0, -1.0, G.ulps_away(1.0, 1), G.ulps_away(-1.0, -1), G.ulps_away(1.0, -1), G.ulps_away(-1.0, 1), 1.0000001, -1.0000001, 2.0, -2.0, 1e300, -1e300, 2.0 ** 63, 1024.0, -1075.0, inf, -inf, QN, NQ1, SN1]
    table('F2XM1 at and beyond +-1 (1 + ulp, -1 - ulp: ST(0) back with PE; +-1: exact values, PE flagged)', [('f2xm1', [x, 7.0], 2) for x in xs], 1)
    table('F2XM1 with every C bit set: kept (0x4700)', [('f2xm1', [x, 7.0], 2) for x in (1.5, inf, QN, SN1, 0.5)], 1, sw=0x4700)
    table('FYL2XP1 at / below -1 (ST(0) back for a finite y, -+inf for y = +-inf, -+0 for y = +-0; -inf: IE), above the domain (computed), +inf', [
        ('fyl2xp1', [-1.0, 1.0], 2), ('fyl2xp1', [-1.0, -1.0], 2), ('fyl2xp1', [-1.0, inf], 2), ('fyl2xp1', [-1.0, -inf], 2), ('fyl2xp1', [-1.0, 0.0], 2), ('fyl2xp1', [-1.0, -0.0], 2), ('fyl2xp1', [-1.5, 1.0], 2), ('fyl2xp1', [-2.0, -3.0], 2),
        ('fyl2xp1', [-inf, 1.0], 2), ('fyl2xp1', [-inf, -inf], 2), ('fyl2xp1', [-1e300, inf], 2), ('fyl2xp1', [G.ulps_away(-1.0, 1), 1.0], 2), ('fyl2xp1', [G.ulps_away(-1.0, -1), 1.0], 2), ('fyl2xp1', [inf, 0.0], 2), ('fyl2xp1', [inf, -0.0], 2),
        ('fyl2xp1', [inf, 5.0], 2), ('fyl2xp1', [inf, -5.0], 2), ('fyl2xp1', [inf, inf], 2), ('fyl2xp1', [inf, -inf], 2), ('fyl2xp1', [3.0, 1.0], 2), ('fyl2xp1', [1e300, -1.0], 2), ('fyl2xp1', [0.5, 1.0], 2), ('fyl2xp1', [5e-324, inf], 2),
        ('fyl2xp1', [-5e-324, inf], 2), ('fyl2xp1', [-5e-324, -inf], 2), ('fyl2xp1', [0.0, 0.0], 2), ('fyl2xp1', [-0.0, -0.0], 2)], 1)
    table('FYL2X zero divides: -+inf of the sign of -y for every finite y (denormal, huge), none for y = +-inf, IE for y = +-0; y = +-0 with x > 0: +-0', [
        ('fyl2x', [0.0, 5.0], 2), ('fyl2x', [0.0, -5.0], 2), ('fyl2x', [-0.0, 5.0], 2), ('fyl2x', [-0.0, -5.0], 2), ('fyl2x', [0.0, 5e-324], 2), ('fyl2x', [0.0, -5e-324], 2), ('fyl2x', [0.0, inf], 2), ('fyl2x', [0.0, -inf], 2), ('fyl2x', [-0.0, -inf], 2),
        ('fyl2x', [-0.0, inf], 2), ('fyl2x', [-5e-324, 1.0], 2), ('fyl2x', [-inf, -inf], 2), ('fyl2x', [inf, 0.0], 2), ('fyl2x', [inf, -0.0], 2), ('fyl2x', [1.0, inf], 2), ('fyl2x', [1.0, -inf], 2), ('fyl2x', [1.0, 0.0], 2), ('fyl2x', [1.0, -0.0], 2),
        ('fyl2x', [0.5, 0.0], 2), ('fyl2x', [0.5, -0.0], 2), ('fyl2x', [2.0, 0.0], 2), ('fyl2x', [5e-324, 0.0], 2), ('fyl2x', [1e300, -0.0], 2)], 1)
    table('signed zeros: FSCALE(-0, -inf), FPATAN(-0, -0), FPATAN(inf, -0)', [('fscale', [-0.0, -inf], 2), ('fscale', [-0.0, 5.0], 2), ('fscale', [0.0, -5.0], 2), ('fpatan', [-0.0, -0.0], 2), ('fpatan', [inf, -0.0], 2)], 1)
    print('=== condition codes on the exception / special paths (initial 0x4700): kept by the non-trig instructions, C2 cleared by the trig on the NaN / inf / in-range paths')
    table('C bits', [('fyl2x', [0.0, 0.0], 2), ('fyl2x', [0.0, 5.0], 2), ('fyl2x', [QN, 1.0], 2), ('fyl2x', [SN1, 1.0], 2), ('fscale', [0.0, inf], 2), ('fscale', [QN, 1.0], 2), ('fscale', [1.5, 1e300], 2), ('fpatan', [QN, 1.0], 2), ('fpatan', [0.0, 0.0], 2),
                     ('fyl2xp1', [0.0, inf], 2), ('fyl2xp1', [-1.0, 1.0], 2), ('fsqrt', [-1.0, 1.0], 2), ('fsqrt', [QN, 1.0], 2), ('fsqrt', [4.0, 1.0], 2), ('fsincos', [inf, 1.0], 2), ('fsincos', [QN, 1.0], 2), ('fsincos', [2.0 ** 63, 1.0], 2),
                     ('fptan', [SN1, 1.0], 2), ('fcos', [0.0, 1.0], 2), ('fsin', [5e-324, 1.0], 2)], 1, sw=0x4700)
    print('=== precision / rounding control')
    table('PC = 24 (0x007f): the transcendentals keep 64-bit results, FSQRT is rounded', [('f2xm1', [0.5, 7.0], 2), ('fsin', [1.0, 7.0], 2), ('fyl2x', [3.0, 2.0], 2), ('fpatan', [1.0, 2.0], 2), ('fscale', [1.5, 2.0], 2), ('fsqrt', [2.0, 7.0], 2), ('fyl2xp1', [0.1, 2.0], 2), ('fptan', [1.0, 7.0], 2)], 1, fcw=0x007f)
    table('RC = down (0x067f): 1 f80-ulp below the nearest results; FSCALE overflow -> the largest finite f80 (+) / -inf (-), underflow -> +0 / the smallest denormal f80 (-)', [
        ('f2xm1', [0.5, 7.0], 2), ('fsin', [1.0, 7.0], 2), ('fyl2x', [3.0, 2.0], 2), ('fscale', [1.5, 1e300], 2), ('fscale', [1.5, 20000.0], 2), ('fscale', [-1.5, 20000.0], 2), ('fscale', [1.5, -20000.0], 2), ('fscale', [-1.5, -20000.0], 2)], 1, fcw=0x067f)
    table('RC = up (0x0a7f)', [('f2xm1', [0.5, 7.0], 2), ('fscale', [1.5, 1e300], 2), ('fscale', [-1.5, 1e300], 2), ('fscale', [1.5, -1e300], 2), ('fscale', [-1.5, -1e300], 2)], 1, fcw=0x0a7f)
    table('RC = trunc (0x0e7f)', [('fscale', [1.5, 1e300], 2), ('fscale', [-1.5, 1e300], 2), ('fscale', [1.5, -1e300], 2), ('fscale', [-1.5, -1e300], 2), ('fsin', [1.0, 7.0], 2)], 1, fcw=0x0e7f)
    table('masked flags of f64-denormal operands (f80 normals: no DE; PE on inexact results, none on exact FSCALE / FSQRT / FYL2X(x, 0))', [
        ('fsin', [5e-324, 7.0], 2), ('fptan', [5e-324, 7.0], 2), ('f2xm1', [5e-324, 7.0], 2), ('fscale', [5e-324, 3.0], 2), ('fscale', [5e-324, -3.0], 2), ('fyl2x', [5e-324, 1.0], 2), ('fyl2xp1', [5e-324, 1.0], 2), ('fpatan', [5e-324, 1.0], 2),
        ('fpatan', [1.0, 5e-324], 2), ('fsqrt', [5e-324, 7.0], 2), ('fscale', [1.5, -1075.0], 2), ('fscale', [1.5, -16445.0], 2), ('fscale', [1.5, -16446.0], 2)], 2)


if __name__ == '__main__':
    main()
    main2()
