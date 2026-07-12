# RE layer — warm pyGhidra service

The static (reverse-engineering) half of the bring-up loop, packaged as a warm
local service with a contract that mirrors `harness_rpc` (`{cmd,args} -> {ok,result|error}`,
clean POJO). Consolidates the ~100 one-off Java GhidraScripts + `ghidra_*.py` glue
into ~10 commands; fixes the two real pains (Java→Python ergonomics, cold-headless→warm
latency) while preserving the project's Ghidra capital. Capstone (`tools/pe-disas.py`)
is the zero-dep fallback.

## Setup
```
pip install pyghidra capstone
export GHIDRA_INSTALL_DIR=/path/to/ghidra   # required for the Ghidra backend
bun tools/re/re.ts doctor                    # verify backend availability
```
`re doctor` reports pyghidra/JVM/capstone/GHIDRA_INSTALL_DIR. Without Ghidra the
service still answers `disasm` via capstone; decompile/xrefs report a clear error.

## Use
```
bun tools/re/re.ts start tmp/hl_real.exe     # launch warm service + open binary
bun tools/re/re.ts decompile 0x401000
bun tools/re/re.ts symbols
bun tools/re/re.ts callers 0x401000
```
Project cache is keyed by binary SHA-256 in `tmp/ghidra_project/<hash>/` → analysis
is done once and reused (warm).

## Static ↔ dynamic bridge (the point)
1. **Wild EIP → which function.** The harness emits `fault`/`breakHit` with a live
   EIP; relocate it against the live module base from `harness.state(['modules'])`:
   ```
   bun tools/re/re.ts resolve 0xb077ba00 --base 0x10000000
   ```
2. **C++-symbol breakpoints.** Export a sidecar map the harness loads:
   ```
   bun tools/re/re.ts exportSymbolMap --out core.symbols.json --module core
   # then in a harness script:  .call('loadSymbols','core', <symbols>)  .breakOnSymbol('core!UInput::ReadInput')
   ```
   Store `<game>.symbols.json` as a per-game sidecar (rides on container-vfs metadata).

## Boundary
RE stays a **separate, adjacent process** — heavy, offline — NOT embedded in the
live browser harness. The symmetric CLI gives one mental model: static and dynamic
are driven the same way.
