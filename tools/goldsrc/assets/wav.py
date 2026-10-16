"""PCM WAV writer and a small deterministic synthesis kit (numpy).

Signals are float arrays in [-1, 1] at RATE (22050 Hz, the contract's rate).

    from assets import wav as W
    f0 = W.glide(900, 1400, 0.25) ; f0 = W.concat(f0, W.glide(1400, 700, 0.35))
    cry = W.voice(f0, vowels=[(0, "i"), (0.3, "a"), (0.6, "u")], vibrato=(7, 0.03))
    cry = W.reverb(W.normalize(cry * W.env_points([(0, 0), (0.02, 1), (0.5, 0.8), (0.6, 0)], len(cry))))
    data = W.write(cry)                      # bytes of a 16-bit mono 22050 Hz WAV

Building blocks: seconds(), osc(), glide(), noise(), env_adsr(), env_exp(), env_points(), lowpass(),
highpass(), svf() (time-varying resonant filter), bandpass(), formants(), voice(), distort(),
bitcrush(), ring(), tremolo(), reverb(), echo(), speed(), mix(), concat(), fade(), normalize().
"""
import math
import struct

import numpy as np

RATE = 22050

VOWELS = {  # formant frequencies (F1, F2, F3) and relative gains
    "a": ((800, 1200, 2500), (1.0, 0.5, 0.2)),
    "e": ((500, 1800, 2500), (1.0, 0.4, 0.2)),
    "i": ((300, 2200, 3000), (1.0, 0.3, 0.2)),
    "o": ((500, 850, 2500), (1.0, 0.45, 0.15)),
    "u": ((330, 700, 2400), (1.0, 0.3, 0.1)),
    "ah": ((700, 1100, 2600), (1.0, 0.6, 0.25)),
    "er": ((500, 1350, 1700), (1.0, 0.5, 0.3)),
}


# ---------------------------------------------------------------------------------------------
# file I/O
# ---------------------------------------------------------------------------------------------

def write(x, rate=RATE, bits=16):
    """Mono PCM WAV bytes (8-bit unsigned or 16-bit signed), samples clipped to [-1, 1]."""
    x = np.clip(np.asarray(x, dtype=np.float64), -1.0, 1.0)
    if bits == 16:
        pcm = np.round(x * 32767).astype("<i2").tobytes()
    elif bits == 8:
        pcm = np.round(x * 127 + 128).astype(np.uint8).tobytes()
    else:
        raise ValueError("bits must be 8 or 16")
    block = bits // 8
    fmt = struct.pack("<4sIHHIIHH", b"fmt ", 16, 1, 1, rate, rate * block, block, bits)
    pad = b"\0" if len(pcm) % 2 else b""
    data = struct.pack("<4sI", b"data", len(pcm)) + pcm + pad
    return struct.pack("<4sI4s", b"RIFF", 4 + len(fmt) + len(data), b"WAVE") + fmt + data


def read(data):
    """Parse a PCM WAV; returns (samples float, rate, bits, channels)."""
    d = bytes(data)
    if d[:4] != b"RIFF" or d[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    o = 12
    fmt = None
    while o + 8 <= len(d):
        cid, size = struct.unpack_from("<4sI", d, o)
        body = d[o + 8:o + 8 + size]
        if cid == b"fmt ":
            fmt = struct.unpack_from("<HHIIHH", body, 0)
        elif cid == b"data":
            if fmt is None or fmt[0] != 1:
                raise ValueError("only PCM supported")
            ch, rate, bits = fmt[1], fmt[2], fmt[5]
            if bits == 16:
                x = np.frombuffer(body, "<i2").astype(np.float64) / 32767
            elif bits == 8:
                x = (np.frombuffer(body, np.uint8).astype(np.float64) - 128) / 127
            else:
                raise ValueError("unsupported bit depth")
            return x, rate, bits, ch
        o += 8 + size + (size & 1)
    raise ValueError("no data chunk")


# ---------------------------------------------------------------------------------------------
# generators
# ---------------------------------------------------------------------------------------------

def seconds(dur):
    return np.arange(int(round(dur * RATE))) / RATE


def _n(dur_or_n):
    return int(dur_or_n) if isinstance(dur_or_n, (int, np.integer)) else int(round(dur_or_n * RATE))


def glide(f0, f1, dur, curve="exp"):
    """Frequency contour from f0 to f1 over dur seconds ("exp" sounds even, "lin", "ease")."""
    n = _n(dur)
    u = np.linspace(0, 1, n, endpoint=False) if n else np.zeros(0)
    if curve == "exp":
        return f0 * (f1 / f0) ** u
    if curve == "ease":
        u = u * u * (3 - 2 * u)
    return f0 + (f1 - f0) * u


def osc(freq, dur=None, shape="sine", duty=0.5, phase=0.0):
    """Oscillator; freq scalar (needs dur) or per-sample array (glides, vibrato).
    shapes: sine, saw, square, triangle, pulse (duty), glottal (soft voice source)."""
    if np.isscalar(freq):
        freq = np.full(_n(dur), float(freq))
    freq = np.asarray(freq, dtype=np.float64)
    ph = (np.cumsum(freq) / RATE + phase) % 1.0
    if shape == "sine":
        return np.sin(2 * np.pi * ph)
    if shape == "saw":
        return 2 * ph - 1
    if shape == "square":
        return np.where(ph < 0.5, 1.0, -1.0)
    if shape == "pulse":
        return np.where(ph < duty, 1.0, -1.0)
    if shape == "triangle":
        return 4 * np.abs(ph - 0.5) - 1
    if shape == "glottal":
        # Rosenberg-like pulse: smooth opening, quick closing, then closed
        op, cl = 0.45, 0.15
        g = np.where(ph < op, 0.5 * (1 - np.cos(np.pi * ph / op)),
                     np.where(ph < op + cl, np.cos(0.5 * np.pi * (ph - op) / cl), 0.0))
        return 2 * (g - g.mean())
    raise ValueError(shape)


def vibrato(freq, rate_hz=6.0, depth=0.02):
    """Multiply a frequency contour by a slow sine (depth as a fraction)."""
    f = np.asarray(freq, dtype=np.float64)
    t = np.arange(len(f)) / RATE
    return f * (1 + depth * np.sin(2 * np.pi * rate_hz * t))


def noise(dur, color="white", seed=0):
    rng = np.random.default_rng(seed)
    n = _n(dur)
    w = rng.standard_normal(n)
    if color == "white":
        x = w
    elif color == "pink":
        x = np.real(np.fft.irfft(np.fft.rfft(w) / np.sqrt(np.maximum(np.arange(n // 2 + 1), 1)), n))
    elif color == "brown":
        x = np.cumsum(w)
        x = x - np.linspace(x[0], x[-1], n)
    else:
        raise ValueError(color)
    return x / max(np.max(np.abs(x)), 1e-9)


# ---------------------------------------------------------------------------------------------
# envelopes
# ---------------------------------------------------------------------------------------------

def env_points(points, n):
    """Piecewise-linear envelope through [(time s, value), ...] sampled on n samples."""
    t = np.arange(_n(n) if not isinstance(n, int) else n) / RATE
    ts, vs = zip(*points)
    return np.interp(t, ts, vs)


def env_adsr(n, a=0.01, d=0.1, s=0.7, r=0.2):
    n = _n(n) if not isinstance(n, int) else n
    t = np.arange(n) / RATE
    dur = n / RATE
    rel_start = max(dur - r, a + d)
    return np.interp(t, [0, a, a + d, rel_start, dur], [0, 1, s, s, 0])


def env_exp(n, decay=0.2, attack=0.003):
    """Fast attack then exponential decay (time constant `decay` seconds)."""
    n = _n(n) if not isinstance(n, int) else n
    t = np.arange(n) / RATE
    return np.minimum(t / max(attack, 1e-6), 1.0) * np.exp(-t / decay)


# ---------------------------------------------------------------------------------------------
# filters (deterministic loops; ~22k samples per second of audio)
# ---------------------------------------------------------------------------------------------

def _arr(v, n):
    return np.full(n, float(v)) if np.isscalar(v) else np.asarray(v, dtype=np.float64)


def lowpass(x, cutoff):
    """One-pole low-pass; cutoff scalar or per-sample array (Hz)."""
    x = np.asarray(x, dtype=np.float64)
    a = (1 - np.exp(-2 * np.pi * _arr(cutoff, len(x)) / RATE)).tolist()
    xs = x.tolist()
    y = [0.0] * len(xs)
    s = 0.0
    for i in range(len(xs)):
        s += a[i] * (xs[i] - s)
        y[i] = s
    return np.array(y)


def highpass(x, cutoff):
    return np.asarray(x, dtype=np.float64) - lowpass(x, cutoff)


def svf(x, cutoff, q=0.7, mode="band"):
    """Chamberlin state-variable filter (2x oversampled) with per-sample cutoff (Hz, up to RATE/4)
    and resonance q (>= 0.5).  mode: "low", "band", "high", "notch"."""
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    f = (2 * np.sin(np.pi * np.minimum(_arr(cutoff, n), RATE / 4) / (2 * RATE))).tolist()
    damp = 1.0 / max(q, 0.5)
    xs = x.tolist()
    low = band = high = 0.0
    out = [0.0] * n
    m = {"low": 0, "band": 1, "high": 2, "notch": 3}[mode]
    for i in range(n):
        fi, xi = f[i], xs[i]
        high = xi - low - damp * band
        band += fi * high
        low += fi * band
        high = xi - low - damp * band
        band += fi * high
        low += fi * band
        out[i] = low if m == 0 else band if m == 1 else high if m == 2 else low + high
    return np.array(out)


def bandpass(x, center, q=4.0):
    return svf(x, center, q, "band")


def formants(src, f1, f2, f3, gains=(1.0, 0.5, 0.2), q=(6.0, 9.0, 12.0)):
    """Sum of three resonances (per-sample formant frequency arrays or scalars)."""
    return (gains[0] * svf(src, f1, q[0]) + gains[1] * svf(src, f2, q[1]) + gains[2] * svf(src, f3, q[2]))


def _vowel_tracks(vowels, n):
    """[(time, vowel), ...] -> three formant tracks and gain tracks of n samples."""
    t = np.arange(n) / RATE
    ts = [v[0] for v in vowels]
    F = np.array([VOWELS[v[1]][0] for v in vowels], dtype=np.float64)
    G = np.array([VOWELS[v[1]][1] for v in vowels], dtype=np.float64)
    return ([np.interp(t, ts, F[:, k]) for k in range(3)], [np.interp(t, ts, G[:, k]) for k in range(3)])


def voice(f0, vowels=((0.0, "a"),), breath=0.08, vibrato_=None, formant_shift=1.0, growl=0.0, seed=1):
    """Formant voice for creature cries.  f0: per-sample pitch contour (Hz).
    vowels: [(time s, vowel name)], interpolated.  formant_shift > 1 = smaller creature.
    growl: amount of sub-harmonic roughness (big creatures).  vibrato_=(rate Hz, depth fraction)."""
    f0 = np.asarray(f0, dtype=np.float64)
    if vibrato_:
        f0 = vibrato(f0, *vibrato_)
    n = len(f0)
    src = osc(f0, shape="glottal") + 0.35 * osc(f0, shape="saw")
    if growl:
        src = src * (1 + growl * osc(f0 * 0.5, shape="sine"))
        src += growl * 0.4 * noise(n, "pink", seed) * np.abs(osc(f0 * 0.5, shape="sine"))
    src += breath * noise(n, "white", seed + 7)
    (F1, F2, F3), (G1, G2, G3) = _vowel_tracks(vowels, n)
    out = (svf(src, F1 * formant_shift, 6.0) * G1 + svf(src, F2 * formant_shift, 9.0) * G2
           + svf(src, F3 * formant_shift, 12.0) * G3)
    return normalize(out)


# ---------------------------------------------------------------------------------------------
# effects
# ---------------------------------------------------------------------------------------------

def distort(x, drive=3.0):
    return np.tanh(np.asarray(x) * drive) / np.tanh(drive)


def bitcrush(x, bits=6, hold=1):
    x = np.asarray(x, dtype=np.float64)
    if hold > 1:
        x = np.repeat(x[::hold], hold)[:len(x)]
    q = 2 ** (bits - 1)
    return np.round(x * q) / q


def ring(x, freq):
    x = np.asarray(x, dtype=np.float64)
    return x * osc(_arr(freq, len(x)))


def tremolo(x, rate_hz=8.0, depth=0.5):
    x = np.asarray(x, dtype=np.float64)
    t = np.arange(len(x)) / RATE
    return x * (1 - depth * 0.5 * (1 + np.sin(2 * np.pi * rate_hz * t)))


def _comb(x, delay, fb, damp):
    xs = np.asarray(x, dtype=np.float64).tolist()
    y = [0.0] * len(xs)
    buf = [0.0] * delay
    s = 0.0
    j = 0
    for i in range(len(xs)):
        out = buf[j]
        s = out * (1 - damp) + s * damp
        buf[j] = xs[i] + s * fb
        y[i] = out
        j = j + 1 if j + 1 < delay else 0
    return np.array(y)


def _allpass(x, delay, g=0.5):
    xs = np.asarray(x, dtype=np.float64).tolist()
    y = [0.0] * len(xs)
    buf = [0.0] * delay
    j = 0
    for i in range(len(xs)):
        b = buf[j]
        y[i] = -xs[i] + b
        buf[j] = xs[i] + b * g
        j = j + 1 if j + 1 < delay else 0
    return np.array(y)


def reverb(x, room=0.5, damp=0.4, wet=0.25, tail=0.6):
    """Small Schroeder reverb (4 combs + 2 all-passes); appends `tail` seconds."""
    x = np.concatenate([np.asarray(x, dtype=np.float64), np.zeros(_n(tail))])
    fb = 0.7 + 0.28 * room
    combs = [1116, 1188, 1277, 1356]
    w = sum(_comb(x, int(d * RATE / 44100), fb, damp) for d in combs) / 4
    for d in (556, 441):
        w = _allpass(w, int(d * RATE / 44100))
    return x * (1 - wet) + w * wet


def echo(x, delay=0.12, feedback=0.35, taps=4):
    x = np.asarray(x, dtype=np.float64)
    d = _n(delay)
    y = np.concatenate([x, np.zeros(d * taps)])
    for k in range(1, taps + 1):
        y[d * k:d * k + len(x)] += x * feedback ** k
    return y


def speed(x, factor):
    """Resample (pitch and speed change together); factor > 1 = faster/higher."""
    x = np.asarray(x, dtype=np.float64)
    n = int(len(x) / factor)
    return np.interp(np.arange(n) * factor, np.arange(len(x)), x)


# ---------------------------------------------------------------------------------------------
# assembly
# ---------------------------------------------------------------------------------------------

def mix(*parts):
    """mix((signal, start_seconds, gain), ...) or plain signals (start 0, gain 1)."""
    items = []
    for p in parts:
        if isinstance(p, tuple):
            sig, start = p[0], p[1] if len(p) > 1 else 0.0
            gain = p[2] if len(p) > 2 else 1.0
        else:
            sig, start, gain = p, 0.0, 1.0
        items.append((np.asarray(sig, dtype=np.float64), _n(start), gain))
    n = max(s + len(sig) for sig, s, _ in items)
    out = np.zeros(n)
    for sig, s, g in items:
        out[s:s + len(sig)] += sig * g
    return out


def concat(*sigs):
    return np.concatenate([np.asarray(s, dtype=np.float64) for s in sigs])


def silence(dur):
    return np.zeros(_n(dur))


def fade(x, fade_in=0.005, fade_out=0.02):
    x = np.asarray(x, dtype=np.float64).copy()
    a, b = min(_n(fade_in), len(x)), min(_n(fade_out), len(x))
    if a:
        x[:a] *= np.linspace(0, 1, a)
    if b:
        x[-b:] *= np.linspace(1, 0, b)
    return x


def normalize(x, peak=0.9):
    x = np.asarray(x, dtype=np.float64)
    x = x - np.mean(x)
    m = np.max(np.abs(x)) if len(x) else 0.0
    return x * (peak / m) if m > 1e-9 else x


def finish(x, peak=0.9, fade_out=0.03, trim=True):
    """Typical last step: trim trailing silence, normalise, fade the edges."""
    x = np.asarray(x, dtype=np.float64)
    if trim and len(x):
        thr = np.max(np.abs(x)) * 1e-3
        nz = np.nonzero(np.abs(x) > thr)[0]
        if len(nz):
            x = x[:nz[-1] + 1]
    return fade(normalize(x, peak), 0.003, fade_out)
