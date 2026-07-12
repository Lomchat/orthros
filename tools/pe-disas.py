#!/usr/bin/env python3
"""Lightweight PE RE helper (Ghidra-down fallback). capstone + pefile.

Commands:
  func  <exe> <va> [maxbytes]   Flow-follow disassemble a function from <va>.
  range <exe> <va> <nbytes>     Linear disassemble a byte range.
  xref  <exe> <va>              Find E8 call sites + dword refs to <va>.
  thunks <exe>                  List import jmp-thunks (FF25) -> IAT name.

VAs are hex (0x...). Import thunks and call targets are annotated.
"""
import sys, struct
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32, CS_OP_MEM, CS_OP_IMM

def load(path):
    pe = pefile.PE(path)
    base = pe.OPTIONAL_HEADER.ImageBase
    data = open(path, 'rb').read()
    secs = [(s.VirtualAddress, s.Misc_VirtualSize, s.PointerToRawData, s.SizeOfRawData,
             s.Name.rstrip(b'\x00').decode(errors='replace')) for s in pe.sections]
    # IAT name map: iat_va -> name
    iat = {}
    try:
        for entry in pe.DIRECTORY_ENTRY_IMPORT:
            dll = entry.dll.decode(errors='replace')
            for imp in entry.imports:
                nm = imp.name.decode() if imp.name else ('ord_%d' % imp.ordinal)
                iat[imp.address] = '%s!%s' % (dll, nm)
    except AttributeError:
        pass
    return pe, base, data, secs, iat

def va2off(va, base, secs):
    for vrva, vs, po, rs, n in secs:
        if base+vrva <= va < base+vrva+max(vs, rs):
            if va-(base+vrva) < rs:
                return po+(va-(base+vrva))
    return None

def off2va(o, base, secs):
    for vrva, vs, po, rs, n in secs:
        if po <= o < po+rs:
            return base+vrva+(o-po)
    return None

# thunk map: thunk_va -> iat name (FF 25 imm32)
def build_thunks(data, base, secs, iat):
    th = {}
    for o in range(len(data)-6):
        if data[o] == 0xFF and data[o+1] == 0x25:
            imm = struct.unpack('<I', data[o+2:o+6])[0]
            if imm in iat:
                va = off2va(o, base, secs)
                if va: th[va] = iat[imm]
    return th

def annotate(ins, base, secs, iat, thunks):
    # call/jmp imm -> thunk or sub
    if ins.mnemonic in ('call', 'jmp') and len(ins.operands) == 1:
        op = ins.operands[0]
        if op.type == CS_OP_IMM:
            t = op.imm
            if t in thunks: return '-> '+thunks[t]
            return '-> sub_%x' % t
        if op.type == CS_OP_MEM and op.mem.base == 0 and op.mem.index == 0:
            disp = op.mem.disp & 0xffffffff
            if disp in iat: return '-> '+iat[disp]
        if op.type == CS_OP_MEM and op.mem.base != 0:
            # vtable / indirect call: call [reg+disp]
            return 'VTBL [+0x%x]' % (op.mem.disp & 0xffffffff)
    return ''

def disas_func(path, start, maxbytes=0x800):
    pe, base, data, secs, iat = load(path)
    thunks = build_thunks(data, base, secs, iat)
    md = Cs(CS_ARCH_X86, CS_MODE_32); md.detail = True
    seen = set(); todo = [start]; out = {}
    while todo:
        va = todo.pop()
        if va in seen: continue
        o = va2off(va, base, secs)
        if o is None: continue
        code = data[o:o+0x400]
        for ins in md.disasm(code, va):
            if ins.address in seen: break
            seen.add(ins.address)
            note = annotate(ins, base, secs, iat, thunks)
            out[ins.address] = "0x%08x  %-7s %-32s %s" % (ins.address, ins.mnemonic, ins.op_str, note)
            m = ins.mnemonic
            if m == 'ret' or m.startswith('ret'): break
            if m == 'jmp':
                op = ins.operands[0]
                if op.type == CS_OP_IMM and abs(op.imm-start) < maxbytes:
                    todo.append(op.imm)
                break
            if m.startswith('j'):
                op = ins.operands[0]
                if op.type == CS_OP_IMM and abs(op.imm-start) < maxbytes:
                    todo.append(op.imm)
            if ins.address-start > maxbytes: break
    for a in sorted(out): print(out[a])

def disas_range(path, start, n):
    pe, base, data, secs, iat = load(path)
    thunks = build_thunks(data, base, secs, iat)
    md = Cs(CS_ARCH_X86, CS_MODE_32); md.detail = True
    o = va2off(start, base, secs)
    for ins in md.disasm(data[o:o+n], start):
        note = annotate(ins, base, secs, iat, thunks)
        print("0x%08x  %-7s %-32s %s" % (ins.address, ins.mnemonic, ins.op_str, note))

def xref(path, target):
    pe, base, data, secs, iat = load(path)
    calls = []; refs = []
    for vrva, vs, po, rs, n in secs:
        if n != '.text': continue
        for o in range(po, po+rs-5):
            if data[o] == 0xE8:
                rel = struct.unpack('<i', data[o+1:o+5])[0]
                src = off2va(o, base, secs)
                if src and src+5+rel == target: calls.append(src)
    tb = struct.pack('<I', target); i = 0
    while True:
        i = data.find(tb, i)
        if i < 0: break
        v = off2va(i, base, secs)
        if v: refs.append(v)
        i += 1
    print("call sites: %s" % [hex(x) for x in calls])
    print("dword refs: %s" % [hex(x) for x in refs])

if __name__ == '__main__':
    cmd = sys.argv[1]; path = sys.argv[2]
    if cmd == 'func': disas_func(path, int(sys.argv[3], 16), int(sys.argv[4], 16) if len(sys.argv) > 4 else 0x800)
    elif cmd == 'range': disas_range(path, int(sys.argv[3], 16), int(sys.argv[4], 16))
    elif cmd == 'xref': xref(path, int(sys.argv[3], 16))
    elif cmd == 'thunks':
        pe, base, data, secs, iat = load(path)
        for va, nm in sorted(build_thunks(data, base, secs, iat).items()): print("0x%08x %s" % (va, nm))
