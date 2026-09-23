#!/usr/bin/env python3
"""Generates the constant tables hard-coded in src/cpu/jit/fpmath-atan.js.

Everything is derived from the definitions with Python's decimal module at 60 digits:
  * atan(x) for |x| <= 1: the argument is halved with tan(a/2) = tan(a) / (1 + sqrt(1 + tan(a)^2))
    until |x| < 1/32, then the Taylor series atan(x) = sum (-1)^j x^(2j+1) / (2j+1) is summed to
    1e-58 and the result multiplied back by 2^halvings.
  * pi = 4 atan(1), cross-checked against Machin's formula pi = 16 atan(1/5) - 4 atan(1/239).

The kernel reduces atan(t), t in [0, 1], to atan(c_k) + atan(u) with c_k = k/8 (k = 0..8) and
folds the quadrant constant of atan2 into the same addition, so the table holds, for every k and
every quadrant case q (q = 0: atan(c_k), 1: pi/2 - atan(c_k), 2: pi - atan(c_k), 3: pi/2 + atan(c_k)),
the double-double split (hi = round(value), lo = round(value - hi)) of that base angle, at
index 4*k + q.

Usage: python3 tools/gen_atan_table.py   (prints the JS array literal and the check values)
"""
from decimal import Decimal, getcontext

getcontext().prec = 60
ONE = Decimal(1)
EPS = Decimal(10) ** -58


def atan_dec(x: Decimal) -> Decimal:
    """arctan of a Decimal, |x| <= 1, to ~58 significant digits."""
    halvings = 0
    while abs(x) > ONE / 32:
        x = x / (ONE + (ONE + x * x).sqrt())
        halvings += 1
    s = Decimal(0)
    term = x
    x2 = x * x
    j = 0
    while True:
        t = term / (2 * j + 1)
        if abs(t) < EPS:
            break
        s += t if j % 2 == 0 else -t
        term *= x2
        j += 1
    return s * (2 ** halvings)


def split(v: Decimal):
    """(hi, lo) doubles with hi = round(v), lo = round(v - hi)."""
    hi = float(v)
    lo = float(v - Decimal(hi))
    return hi, lo


def main():
    pi = 4 * atan_dec(ONE)
    machin = 16 * atan_dec(ONE / 5) - 4 * atan_dec(ONE / 239)
    assert abs(pi - machin) < Decimal(10) ** -55, (pi, machin)
    half_pi = pi / 2

    print("// pi and pi/2 (hi, lo):")
    print("//   pi   =", split(pi))
    print("//   pi/2 =", split(half_pi))
    print("// index 4*k + q, q: 0 atan(k/8), 1 pi/2 - atan(k/8), 2 pi - atan(k/8), 3 pi/2 + atan(k/8)")
    print("export const BASES = [")
    for k in range(9):
        a = atan_dec(Decimal(k) / 8)
        bases = [a, half_pi - a, pi - a, half_pi + a]
        cells = []
        for q, b in enumerate(bases):
            hi, lo = split(b)
            # sanity: the split must represent the value to far below 2^-106 relative
            assert abs(b - (Decimal(hi) + Decimal(lo))) <= abs(b) * Decimal(2) ** -105 + Decimal(0)
            cells.append(f"[{hi!r}, {lo!r}]")
        print(f"  // k = {k}: atan({k}/8) = {a:.20f}")
        print("  " + ", ".join(cells) + ("," if k < 8 else ""))
    print("];")
    print("// Taylor coefficients of atan(u) = u + u^3 * P(u^2), P(v) = sum_{j=1..8} (-1)^j v^(j-1) / (2j+1)")
    print("export const POLY = [" + ", ".join(repr((-1.0) ** j / (2 * j + 1)) for j in range(1, 9)) + "];")
    # truncation bound of the series on |u| <= 1/8 (the widest interval the kernel feeds it):
    # |u^19 / 19| relative to u = (1/8)^18 / 19
    print("// series truncation, relative to u, on |u| <= 1/8: %.3e" % (float(Decimal(1) / (8 ** 18 * 19))))


if __name__ == "__main__":
    main()
