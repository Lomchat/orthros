/**
 * On-demand recursive-descent instruction supply for a PE.
 *
 * Disassembling `.text` linearly desynchronises wherever data sits between
 * functions: every following boundary is wrong until it happens to realign. That
 * is not a theoretical worry — it made the first coverage pass report 0 of 233
 * entries on the hottest page, all blocked by "no instruction at", and it made
 * an earlier analysis overstate straight-line leaves.
 *
 * Decoding from a known-good address instead keeps boundaries correct, so this
 * hands out instructions one address at a time and disassembles a fresh window
 * whenever it is asked for an address it has not seen. Windows are cached, so a
 * call graph walk pays for each region once.
 */

export interface Insn {
    addr: number;
    mnemonic: string;
    operand: string;
    size: number;
}

const WINDOW = 16 * 1024;

export class Decoder {
    private cache = new Map<number, Insn>();
    /** Window start addresses already disassembled, to avoid redoing them. */
    private decoded = new Set<number>();
    private textStart = 0;
    private textEnd = 0;

    private constructor(private exe: string) {}

    static async open(exe: string): Promise<Decoder> {
        const d = new Decoder(exe);
        const hdr = await new Response(Bun.spawn(["objdump", "-h", exe]).stdout).text();
        const row = hdr.split("\n").find((l) => / \.text\s/.test(l));
        if (!row) throw new Error("no .text section");
        const parts = row.trim().split(/\s+/);
        const size = parseInt(parts[2]!, 16);
        d.textStart = parseInt(parts[3]!, 16);
        d.textEnd = d.textStart + size;
        return d;
    }

    inText(addr: number): boolean { return addr >= this.textStart && addr < this.textEnd; }

    /** The instruction at `addr`, decoding from `addr` itself if unseen so the
     *  boundary is right even when the surrounding bytes are data. */
    async at(addr: number): Promise<Insn | null> {
        const hit = this.cache.get(addr);
        if (hit) return hit;
        if (!this.inText(addr)) return null;
        if (!this.decoded.has(addr)) {
            await this.decodeFrom(addr);
            this.decoded.add(addr);
        }
        return this.cache.get(addr) ?? null;
    }

    private async decodeFrom(start: number): Promise<void> {
        const stop = Math.min(start + WINDOW, this.textEnd);
        const proc = Bun.spawn([
            "objdump", "-d", "-M", "intel",
            `--start-address=0x${start.toString(16)}`,
            `--stop-address=0x${stop.toString(16)}`,
            this.exe,
        ], { stdout: "pipe", stderr: "ignore" });
        const out = await new Response(proc.stdout).text();
        for (const line of out.split("\n")) {
            const tab = line.indexOf("\t");
            if (tab < 0) continue;
            const a = line.slice(0, tab).trim();
            if (!a.endsWith(":")) continue;
            const addr = parseInt(a.slice(0, -1), 16);
            if (!Number.isFinite(addr)) continue;
            const rest = line.slice(tab + 1);
            const t2 = rest.indexOf("\t");
            if (t2 < 0) continue;
            const bytes = rest.slice(0, t2).trim();
            const asm = rest.slice(t2 + 1).trim();
            if (!asm || asm.startsWith("(bad)")) continue;
            const sp = asm.indexOf(" ");
            // A window decoded from a good boundary is authoritative for its own
            // start; later addresses may already be known from a better anchor,
            // so an existing entry is never overwritten.
            if (this.cache.has(addr)) continue;
            this.cache.set(addr, {
                addr,
                mnemonic: sp < 0 ? asm : asm.slice(0, sp),
                operand: sp < 0 ? "" : asm.slice(sp + 1).trim(),
                size: bytes.split(/\s+/).length,
            });
        }
    }

    /** Every instruction reachable from `entry` by direct control flow, decoded
     *  from correct boundaries. Returns null if it leaves `.text` or exceeds the
     *  budget — both of which mean this is not a function worth translating. */
    async functionBody(entry: number, budget = 8192): Promise<Insn[] | null> {
        const seen = new Map<number, Insn>();
        const work = [entry];
        while (work.length > 0) {
            let pc = work.pop()!;
            for (;;) {
                if (seen.has(pc)) break;
                const insn = await this.at(pc);
                if (!insn) return null;
                seen.set(pc, insn);
                if (seen.size > budget) return null;
                const { mnemonic, operand } = insn;
                if (mnemonic === "ret" || mnemonic === "retn" || mnemonic === "hlt") break;
                const t = directTarget(operand);
                if (mnemonic === "jmp") {
                    if (t === null) break;              // indirect: ends this path
                    work.push(t);
                    break;
                }
                if (/^j[a-z]+$/.test(mnemonic)) {
                    if (t === null) break;
                    work.push(t);
                    work.push(pc + insn.size);
                    break;
                }
                pc += insn.size;
            }
        }
        return [...seen.values()].sort((a, b) => a.addr - b.addr);
    }
}

export function directTarget(operand: string): number | null {
    const m = /^0?x?([0-9a-f]+)\b/.exec(operand.trim());
    if (!m) return null;
    const v = parseInt(m[1]!, 16);
    return Number.isFinite(v) ? v : null;
}
