/**
 * Exact, deterministic instruction supply for the translator, backed by the
 * capstone decode service (decode-service.py) kept alive over stdio.
 *
 * Every request decodes linearly from a caller-supplied boundary — a function
 * entry or a block leader the walk itself established — so no window ever
 * starts inside data, and the same address always decodes the same way. The
 * objdump-window decoder this replaces cached whichever window reached an
 * address first, which made a translation depend on request order.
 */

export interface Insn {
    addr: number;
    mnemonic: string;
    operand: string;
    size: number;
}

const WINDOW_BYTES = 256;
const CACHE_LIMIT = 200_000;

export class CapstoneDecoder {
    private proc: ReturnType<typeof Bun.spawn>;
    private sink: { write(chunk: string): number; flush(): void; end(): void };
    private pending: Array<(lines: string[]) => void> = [];
    private buffer = "";
    private lines: string[] = [];
    private regions: Array<{ base: number; size: number }> = [];
    /** Linear decodes by start address, in insertion order for eviction. */
    private windows = new Map<number, Insn[]>();

    private constructor(exe: string, python: string, rawBase: number | null) {
        const args = [python, new URL("./decode-service.py", import.meta.url).pathname, exe];
        if (rawBase !== null) args.push("--raw", `0x${rawBase.toString(16)}`);
        this.proc = Bun.spawn(args, {
            stdin: "pipe", stdout: "pipe", stderr: "inherit",
        });
        this.sink = this.proc.stdin as unknown as { write(chunk: string): number; flush(): void; end(): void };
        void this.pump();
    }

    /** `rawBase`: treat `exe` as a flat code blob loaded at that address. */
    static async open(exe: string, python = "/srv/bfme/app/orthros/.ghidra-home/venv/bin/python", rawBase: number | null = null): Promise<CapstoneDecoder> {
        const d = new CapstoneDecoder(exe, python, rawBase);
        const lines = await d.request("?");
        d.regions = lines.map((l) => { const [b, s] = l.split(" ").map(Number); return { base: b!, size: s! }; });
        if (d.regions.length === 0) throw new Error("decode service reported no executable region");
        return d;
    }

    private async pump(): Promise<void> {
        const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            this.buffer += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = this.buffer.indexOf("\n")) >= 0) {
                const line = this.buffer.slice(0, nl);
                this.buffer = this.buffer.slice(nl + 1);
                if (line === ".") {
                    const resolve = this.pending.shift();
                    const batch = this.lines;
                    this.lines = [];
                    resolve?.(batch);
                } else {
                    this.lines.push(line);
                }
            }
        }
    }

    private request(line: string): Promise<string[]> {
        return new Promise((resolve) => {
            this.pending.push(resolve);
            this.sink.write(line + "\n");
            this.sink.flush();
        });
    }

    inText(addr: number): boolean {
        return this.regions.some((r) => addr >= r.base && addr < r.base + r.size);
    }

    /** Instructions decoded linearly from `start`, at least `bytes` worth
     *  unless a bad byte or the region end comes first. */
    async linear(start: number, bytes = WINDOW_BYTES): Promise<Insn[]> {
        const hit = this.windows.get(start);
        if (hit) return hit;
        if (!this.inText(start)) return [];
        const lines = await this.request(`${start} ${bytes}`);
        const insns: Insn[] = [];
        for (const l of lines) {
            const sp1 = l.indexOf(" ");
            const sp2 = l.indexOf(" ", sp1 + 1);
            const tab = l.indexOf("\t", sp2 + 1);
            insns.push({
                addr: Number(l.slice(0, sp1)),
                size: Number(l.slice(sp1 + 1, sp2)),
                mnemonic: l.slice(sp2 + 1, tab < 0 ? undefined : tab),
                operand: tab < 0 ? "" : l.slice(tab + 1).trim(),
            });
        }
        if (this.windows.size >= CACHE_LIMIT) {
            const oldest = this.windows.keys().next().value;
            if (oldest !== undefined) this.windows.delete(oldest);
        }
        this.windows.set(start, insns);
        return insns;
    }

    close(): void {
        try { this.sink.end(); } catch { /* already closed */ }
        try { this.proc.kill(); } catch { /* already gone */ }
    }
}

/**
 * Sequential reader over linear windows: reading the instruction that
 * follows the previous one continues the same window (extending it from the
 * last boundary when it runs out); reading anywhere else starts a fresh
 * window at that address. Block leaders therefore always decode from their
 * own boundary.
 */
export class BlockReader {
    private window: Insn[] = [];
    private pos = 0;
    private expected = -1;

    constructor(private decoder: CapstoneDecoder) {}

    async at(pc: number): Promise<Insn | null> {
        if (pc === this.expected && this.pos < this.window.length) {
            const insn = this.window[this.pos++]!;
            this.expected = insn.addr + insn.size;
            return insn;
        }
        // Fresh boundary: either a leader, or the continuation of a block
        // past its window (pc is then the end of the last decoded instruction,
        // itself a valid boundary).
        this.window = await this.decoder.linear(pc);
        this.pos = 0;
        if (this.window.length === 0 || this.window[0]!.addr !== pc) { this.expected = -1; return null; }
        const insn = this.window[this.pos++]!;
        this.expected = insn.addr + insn.size;
        return insn;
    }
}

export function directTarget(operand: string): number | null {
    const m = /^0x([0-9a-f]+)\b/i.exec(operand.trim());
    if (!m) return null;
    const v = parseInt(m[1]!, 16);
    return Number.isFinite(v) ? v : null;
}
