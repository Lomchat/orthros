#!/usr/bin/env python3
"""Probe the native oracle with hand-picked x87 transcendental cases and print the hardware
results (value, f80 bits, status word), i.e. the facts behind suite_verify_trans in gen_cases.py:
trig of +-inf / NaN / 2^63, the trig accuracy at large arguments, C0-C3 preservation, and the
FSCALE / FYL2X / FYL2XP1 / FPATAN / F2XM1 special-value tables. Run from the repository root
after `make tools`: python3 tools/gen/verify_trans_probe.py [build/oracle]"""
import math, os, random, struct, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_cases as G  # noqa: E402

ORACLE = sys.argv[1] if len(sys.argv) > 1 else 'build/oracle'
inf, nan = float('inf'), float('nan')


def run(cases):
    """cases: (asm, ST values in stack order, nvalid, fcw, extra status-word bits) -> results."""
    rng = random.Random(1)
    g = G.Gen(rng)
    objs = []
    for asm, values, nvalid, fcw, sw_extra in cases:
        c = G.Case()
        vm = sum(1 << i for i in range(nvalid))  # TOP = 0
        vals = list(values) + [0.0] * (8 - len(values))
        c.fx = G.default_fx(rng, top=0, valid_mask=vm, values=vals, fcw=fcw)
        if sw_extra:
            struct.pack_into('<H', c.fx, 2, sw_extra)
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
        out.append({'asm': c.asm, 'fsw': fsw, 'top': (fsw >> 11) & 7, 'tw': r[48 + 4],
                    'st': [G.f80_to_f64(m, se) for m, se in regs], 'raw': regs})
    return out


def fmt_sw(sw):
    names = [('IE', 0), ('DE', 1), ('ZE', 2), ('OE', 3), ('UE', 4), ('PE', 5), ('SF', 6), ('ES', 7), ('C0', 8), ('C1', 9), ('C2', 10), ('C3', 14)]
    return '|'.join(n for n, b in names if sw & (1 << b)) or '-'


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
    xs = [-1.0, 1.0, 0.0, -0.0, 2.0 ** -1074, 1e-300, 2.0 ** -30, 0.5, -0.5, 0.9999999999999999, -0.9999999999999999, 1.5, -1.5, 3.0, 10.0, -70.0, inf, -inf, nan]
    for r, x in zip(run([('f2xm1', [x], 1, 0x027f, 0) for x in xs]), xs):
        want = math.expm1(x * math.log(2)) if math.isfinite(x) else (inf if x > 0 else -1.0)
        print(f"f2xm1 x={x!r:<22} hw={r['st'][0]!r:<24} py={want!r:<24} sw={fmt_sw(r['fsw'])} raw={r['raw'][0][0]:016x}:{r['raw'][0][1]:04x}")


if __name__ == '__main__':
    main()
