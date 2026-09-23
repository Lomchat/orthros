#!/usr/bin/env python3
"""Generates the constants hard-coded in src/cpu/jit/fpmath-exp.js (2^x - 1, log2, log2(1 + x)).

Everything is derived from the definitions with Python's decimal module at 60 digits; the
polynomials are least-squares fits on Chebyshev nodes (normal equations solved in Decimal, so the
only rounding is the final conversion of each coefficient to a double). Reference functions:
  * ln 2 = 2 atanh(1/3) (series), log2 e = 1 / ln 2,
  * 2^r - 1 = exp(r ln 2) - 1 with exp as its Taylor series,
  * ln(1 + f) = 2 atanh(s), s = f / (2 + f), atanh as its odd series.

Kernel formulas (see the JS file for the error analysis):
  exp2m1: 2^r - 1 = r ln2 + r^2 R(r), |r| < 1, R fitted on [-1, 1]; the leading term r ln2 is
          computed exactly as a double-double with ln2 split into a 27-bit head and a tail so
          that the head products of the Veltkamp-split r are exact.
  log2:   ln(1 + f) = f - hfsq + s (hfsq + R(z)), hfsq = f^2 / 2, s = f / (2 + f), z = s^2, with
          R(z) = 2 atanh(s) - 2 s written as z G(z), G(z) = 2/3 + 2 z/5 + 2 z^2/7 + ... fitted on
          [0, 0.0295] (f in [sqrt(1/2) - 1, sqrt(2) - 1] gives z <= 0.02944); log2 e split the same
          way for the exact leading product f log2e.

Usage: python3 tools/gen_fpmath_exp.py   (prints the JS constants and the verified error bounds)
"""
import math
import struct
from decimal import Decimal, getcontext

getcontext().prec = 60
ONE = Decimal(1)
EPS = Decimal(10) ** -58


def atanh_dec(x: Decimal) -> Decimal:
    """atanh(x) = sum x^(2k+1) / (2k+1), |x| < 1."""
    s = Decimal(0)
    t = x
    k = 0
    while True:
        term = t / (2 * k + 1)
        if abs(term) < EPS:
            return s
        s += term
        t *= x * x
        k += 1


def exp_dec(t: Decimal) -> Decimal:
    """exp(t) by its Taylor series (|t| <= 1 here, converges fast enough)."""
    s = Decimal(0)
    term = ONE
    n = 0
    while abs(term) > EPS:
        s += term
        n += 1
        term = term * t / n
    return s


LN2 = 2 * atanh_dec(ONE / 3)
LOG2E = ONE / LN2
SQRT2 = Decimal(2).sqrt()


def bits(f: float) -> int:
    return struct.unpack('<Q', struct.pack('<d', f))[0]


def from_bits(b: int) -> float:
    return struct.unpack('<d', struct.pack('<Q', b))[0]


def split27(v: Decimal):
    """(head, tail): head = v rounded to double then truncated to 27 significant bits, tail = round(v - head)."""
    head = from_bits(bits(float(v)) & ~((1 << 26) - 1))
    tail = float(v - Decimal(head))
    return head, tail


def cheb_nodes(n: int, lo: Decimal, hi: Decimal):
    mid, half = (lo + hi) / 2, (hi - lo) / 2
    return [mid + half * Decimal(math.cos((2 * k + 1) * math.pi / (2 * n))) for k in range(n)]


def solve(a, b):
    """Gaussian elimination with partial pivoting on Decimal matrices (small systems)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        for r in range(col + 1, n):
            f = m[r][col] / m[col][col]
            for c in range(col, n + 1):
                m[r][c] -= f * m[col][c]
    x = [Decimal(0)] * n
    for r in range(n - 1, -1, -1):
        s = m[r][n] - sum(m[r][c] * x[c] for c in range(r + 1, n))
        x[r] = s / m[r][r]
    return x


def fit(func, lo: Decimal, hi: Decimal, degree: int, n_nodes: int = 1500):
    """Least-squares monomial coefficients (low to high, doubles) of func on [lo, hi].

    The system is built in the scaled variable u = x / scale (scale = max(|lo|, |hi|)) so that
    the normal equations stay well conditioned; the conversion back to x happens in Decimal before
    the single rounding of each coefficient to a double.
    """
    scale = max(abs(lo), abs(hi))
    xs = cheb_nodes(n_nodes, lo, hi)
    us = [x / scale for x in xs]
    ys = [func(x) for x in xs]
    n = degree + 1
    ata = [[Decimal(0)] * n for _ in range(n)]
    aty = [Decimal(0)] * n
    for u, y in zip(us, ys):
        pw = [ONE]
        for _ in range(degree):
            pw.append(pw[-1] * u)
        for i in range(n):
            aty[i] += pw[i] * y
            for j in range(n):
                ata[i][j] += pw[i] * pw[j]
    c = solve(ata, aty)
    return [float(c[k] / scale ** k) for k in range(n)]


def poly_dec(coefs, x: Decimal) -> Decimal:
    acc = Decimal(0)
    for c in reversed(coefs):
        acc = acc * x + Decimal(c)
    return acc


def max_err(func, coefs, lo: Decimal, hi: Decimal, weight=lambda x: ONE, n: int = 8001):
    """Max of weight(x) * |poly(x) - func(x)| on a dense grid (double coefficients, exact evaluation)."""
    worst, at = Decimal(0), None
    for i in range(n):
        x = lo + (hi - lo) * i / (n - 1)
        e = weight(x) * abs(poly_dec(coefs, x) - func(x))
        if e > worst:
            worst, at = e, x
    return worst, at


# ---- 2^r - 1 = r ln2 + r^2 R(r), |r| <= 1
def r_exp(r: Decimal) -> Decimal:
    if r == 0:
        return LN2 * LN2 / 2
    return (exp_dec(r * LN2) - 1 - r * LN2) / (r * r)


# ---- ln(1 + f) = f - hfsq + s (hfsq + z G(z)), G(z) = (2 atanh(s) - 2 s) / s^3, z = s^2
def g_log(z: Decimal) -> Decimal:
    if z == 0:
        return Decimal(2) / 3
    s = z.sqrt()
    return (2 * atanh_dec(s) - 2 * s) / (s * s * s)


def main():
    ln2_hi, ln2_lo = split27(LN2)
    l2e_hi, l2e_lo = split27(LOG2E)
    print('// generated by tools/gen_fpmath_exp.py')
    print('// ln 2   = %s' % LN2)
    print('// log2 e = %s' % LOG2E)
    print('export const LN2_HI = %r, LN2_LO = %r;' % (ln2_hi, ln2_lo))
    print('export const LOG2E_HI = %r, LOG2E_LO = %r, LOG2E = %r;' % (l2e_hi, l2e_lo, float(LOG2E)))
    print('export const SQRT2_MANT = 0x%013xn;' % (bits(float(SQRT2)) & ((1 << 52) - 1)))
    lo_f, hi_f = float(1 / SQRT2 - 1), float(SQRT2 - 1)
    print('// f = m - 1 in [%r, %r]; z = (f / (2 + f))^2 <= %.6f' % (lo_f, hi_f, ((SQRT2 - 1) / (SQRT2 + 1)) ** 2))
    print('export const LOG2P1_LO = %r, LOG2P1_HI = %r;' % (lo_f, hi_f))

    print()
    print('// R(r) = (2^r - 1 - r ln2) / r^2 on [-1, 1]; error weighted by r^2 / |2^r - 1| (relative to the result):')
    weight_exp = lambda r: (r * r / abs(exp_dec(r * LN2) - 1)) if r != 0 else Decimal(0)
    for degree in range(10, 15):
        coefs = fit(r_exp, Decimal(-1), Decimal(1), degree)
        err, at = max_err(r_exp, coefs, Decimal(-1), Decimal(1), weight_exp, 4001)
        print('//   degree %2d: max relative contribution %.3e at r = %.4f' % (degree, err, at))
        if err < Decimal(2) ** -56:
            print('export const EXP_R = [%s];' % ', '.join(repr(c) for c in coefs))
            print('// degree %d chosen: relative error of r^2 R(r) in 2^r - 1 <= %.3e (%.3f ulp)' % (degree, err, err / Decimal(2) ** -52))
            break

    print()
    zmax = Decimal('0.0295')
    print('// G(z) = (2 atanh(s) - 2 s) / s^3, z = s^2 on [0, 0.0295]; error of s z G(z) relative to ln(1 + f) ~ 2 s: |z dG| / 2')
    for degree in range(4, 9):
        coefs = fit(g_log, Decimal(0), zmax, degree)
        err, at = max_err(g_log, coefs, Decimal(0), zmax, lambda z: z / 2, 4001)
        print('//   degree %d: max relative contribution %.3e at z = %.5f' % (degree, err, at))
        if err < Decimal(2) ** -57:
            print('export const LOG_G = [%s];' % ', '.join(repr(c) for c in coefs))
            print('// degree %d chosen: relative error of the series tail in ln(1 + f) <= %.3e (%.4f ulp)' % (degree, err, err / Decimal(2) ** -52))
            break


if __name__ == '__main__':
    main()
