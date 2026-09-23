#!/usr/bin/env python3
"""Generates the constants hard-coded in src/cpu/jit/fpmath-trig.js (sin/cos/tan kernels).

Everything is derived from the definitions with Python's decimal module at 700 digits:
  * pi from Machin's formula pi = 16 atan(1/5) - 4 atan(1/239), the arctangents summed as the
    Taylor series atan(t) = sum (-1)^j t^(2j+1) / (2j+1) (t <= 1/5 converges fast). Cross-checked
    against the independent pi/4 = atan(1/2) + atan(1/3) (with atan(1/2) via the half-angle
    formula to keep the series convergent).
  * the binary expansion of 2/pi as 64-bit words: word i holds bits 64 i + 1 .. 64 i + 64 after
    the binary point (the Payne-Hanek reduction reads the first 5 words: bits 1..320).
  * pi/2 = P1 + P2 + P3 + P4 with P1, P2, P3 truncated to 33 significant bits (so k * Pi is exact
    for |k| <= 2^20) and P4 the nearest double of the remainder (Cody-Waite reduction).
  * pi/2 and 2/pi as nearest doubles, pi/2 as a hi/lo double-double, pi/4 as a double.
  * Taylor coefficients of sin (r + r^3 P(r^2), terms to r^17) and cos (1 - r^2/2 + r^4 Q(r^2),
    terms to r^16) with the truncation bounds on |r| <= pi/4.

Usage: python3 tools/gen_pi_bits.py   (prints the JS constants and the check values)
"""
from decimal import Decimal, getcontext
from fractions import Fraction
from math import factorial

getcontext().prec = 700
ONE = Decimal(1)
EPS = Decimal(10) ** -690


def atan_series(t: Decimal) -> Decimal:
    """atan(t) by the Taylor series (|t| <= 1/2 keeps the number of terms reasonable)."""
    s = Decimal(0)
    term = t
    t2 = t * t
    j = 0
    while True:
        d = term / (2 * j + 1)
        if abs(d) < EPS:
            break
        s += d if j % 2 == 0 else -d
        term *= t2
        j += 1
    return s


def machin_pi() -> Decimal:
    return 16 * atan_series(ONE / 5) - 4 * atan_series(ONE / 239)


def check_pi() -> Decimal:
    """pi/4 = atan(1/2) + atan(1/3); atan(1/2) via the half-angle identity
    atan(x) = 2 atan(x / (1 + sqrt(1 + x^2))) so that both series converge quickly."""
    x = ONE / 2
    half = x / (ONE + (ONE + x * x).sqrt())
    return 4 * (2 * atan_series(half) + atan_series(ONE / 3))


def to_double(v: Decimal) -> float:
    """nearest double (float(Decimal) is correctly rounded)."""
    return float(v)


def truncate_bits(v: Decimal, nbits: int) -> Decimal:
    """v truncated to nbits significant binary digits (v > 0), exactly representable as a double
    (nbits <= 53) and as a Decimal."""
    assert v > 0
    # find e with 2^e <= v < 2^(e+1)
    e = 0
    while Decimal(2) ** e > v:
        e -= 1
    while Decimal(2) ** (e + 1) <= v:
        e += 1
    scale = Decimal(2) ** (nbits - 1 - e)
    t = Decimal(int(v * scale)) / scale
    assert t <= v < t + 1 / scale
    return t


def main():
    pi = machin_pi()
    pi2 = check_pi()
    assert abs(pi - pi2) < Decimal(10) ** -680, (pi, pi2)
    half_pi = pi / 2
    two_over_pi = 2 / pi

    print("// pi (first 60 digits): %s" % str(pi)[:62])
    # ---- 2/pi bit table
    # 24 words = 1536 bits: the reduction of x = m 2^e (e <= 971 for finite doubles) reads the
    # 5 words starting at bit max(0, e - 2) + 1, i.e. words 0..4 up to 15..19.
    words = []
    frac = two_over_pi
    for i in range(24):
        frac *= Decimal(2) ** 64
        w = int(frac)
        frac -= w
        words.append(w)
    print("export const TWO_OVER_PI_WORDS = Object.freeze([")
    for i in range(0, 24, 4):
        print("  " + ", ".join("0x%016xn" % w for w in words[i:i + 4]) + ",")
    print("]);")

    # ---- Cody-Waite pieces of pi/2
    pieces = []
    rem = half_pi
    for _ in range(3):
        p = truncate_bits(rem, 33)
        pieces.append(p)
        rem -= p
    p4 = Decimal(to_double(rem))
    pieces.append(p4)
    tail = rem - p4
    print("export const PIO2_PIECES = Object.freeze([%s]);" % ", ".join(repr(float(p)) for p in pieces))
    print("// pi/2 - sum(pieces) = %.3e  (times 2^20: %.3e)" % (tail, tail * 2 ** 20))
    for i, p in enumerate(pieces):
        f = float(p)
        assert Decimal(f) == p, "piece %d not exactly representable" % i
    # each 33-bit piece: the bit pattern has at least 20 trailing zeros in the 53-bit mantissa
    for p in pieces[:3]:
        m, e = Fraction(float(p)).as_integer_ratio()
        # mantissa as odd integer times power of two -> at most 33 bits
        while m % 2 == 0:
            m //= 2
        assert m.bit_length() <= 33, m.bit_length()

    hi = to_double(half_pi)
    lo = to_double(half_pi - Decimal(hi))
    print("export const PIO2_HI = %r, PIO2_LO = %r;" % (hi, lo))
    print("export const INV_PIO2 = %r;" % to_double(two_over_pi))
    print("export const PIO4 = %r;" % to_double(pi / 4))
    print("export const CW_LIMIT = %r; // 2^20 * pi/2 rounded down: |k| <= 2^20 below it" % (float(int(half_pi * 2 ** 20))))

    # ---- Taylor coefficients
    sin_c = [(-1) ** (j + 1) / Fraction(factorial(2 * j + 3)) for j in range(8)]  # r^3 .. r^17
    cos_c = [(-1) ** j / Fraction(factorial(2 * j + 4)) for j in range(7)]  # r^4 .. r^16
    print("export const SIN_POLY = Object.freeze([%s]);" % ", ".join(repr(float(c)) for c in sin_c))
    print("export const COS_POLY = Object.freeze([%s]);" % ", ".join(repr(float(c)) for c in cos_c))
    r = float(pi / 4)
    print("// truncation on |r| <= pi/4: sin r^19/19! = %.3e (relative to r: %.3e); cos r^18/18! = %.3e (relative to cos: %.3e)"
          % (r ** 19 / factorial(19), r ** 18 / factorial(19), r ** 18 / factorial(18), r ** 18 / factorial(18) / 0.7071))


if __name__ == "__main__":
    main()
