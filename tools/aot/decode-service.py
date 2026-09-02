#!/usr/bin/env python3
"""Exact x86-32 decoding for the translator, as a line-oriented service.

Reads `addr count` requests on stdin and answers with one line per
instruction — `addr size mnemonic<TAB>operands` — decoded linearly from
`addr` for `count` bytes, then a line containing a single `.`. Decoding from
a caller-supplied boundary with a real decoder is what makes the result
deterministic: no window ever starts in data, and a bad byte simply ends the
answer early.

    python3 decode-service.py <pe-file>
"""
import struct
import sys

from capstone import CS_ARCH_X86, CS_MODE_32, Cs


def text_section(path):
    data = open(path, "rb").read()
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b"PE\0\0":
        raise SystemExit("not a PE file")
    num_sections = struct.unpack_from("<H", data, e_lfanew + 6)[0]
    opt_size = struct.unpack_from("<H", data, e_lfanew + 20)[0]
    image_base = struct.unpack_from("<I", data, e_lfanew + 24 + 28)[0]
    sec = e_lfanew + 24 + opt_size
    sections = []
    for i in range(num_sections):
        off = sec + 40 * i
        name = data[off:off + 8].rstrip(b"\0").decode(errors="replace")
        vsize, va, rawsize, rawptr = struct.unpack_from("<IIII", data, off + 8)
        chars = struct.unpack_from("<I", data, off + 36)[0]
        sections.append((name, va, vsize, rawptr, rawsize, chars))
    # Every executable section, so a function that straddles .text and a
    # second code section still decodes.
    out = []
    for name, va, vsize, rawptr, rawsize, chars in sections:
        if chars & 0x20000000:  # IMAGE_SCN_MEM_EXECUTE
            out.append((image_base + va, data[rawptr:rawptr + min(rawsize, vsize)]))
    return out


def main():
    path = sys.argv[1]
    if len(sys.argv) > 3 and sys.argv[2] == "--raw":
        # A flat code blob at a given base, for synthetic fixtures.
        regions = [(int(sys.argv[3], 0), open(path, "rb").read())]
    else:
        regions = text_section(path)
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = False
    out = sys.stdout
    for line in sys.stdin:
        parts = line.split()
        if parts and parts[0] == "?":
            # Executable regions, so the caller knows what is code at all.
            for base, bytes_ in regions:
                out.write("%d %d\n" % (base, len(bytes_)))
            out.write(".\n")
            out.flush()
            continue
        if len(parts) < 2:
            continue
        addr = int(parts[0], 0)
        count = int(parts[1], 0)
        chunk = None
        for base, bytes_ in regions:
            if base <= addr < base + len(bytes_):
                off = addr - base
                chunk = bytes_[off:off + count]
                break
        if chunk:
            for insn in md.disasm(chunk, addr):
                out.write("%d %d %s\t%s\n" % (insn.address, insn.size, insn.mnemonic, insn.op_str))
        out.write(".\n")
        out.flush()


if __name__ == "__main__":
    main()
