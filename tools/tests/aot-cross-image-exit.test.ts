import { afterAll, expect, test } from "bun:test";
import { CapstoneDecoder } from "../aot/decoder-capstone";
import { lastRejection, translateFunctionC } from "../aot/x86-to-c";

// A direct jump/branch whose target lies in another image than the entry is a
// tail call, not a block of this function. Without the sameImage predicate the
// walker follows it into the wrong image and rejects with "no instruction";
// with it, the edge exits to the dispatcher at the target address. The two
// images here are one 4 KiB blob at 0x200000 (the "entry image") and everything
// at/after 0x210000 (the "other image", not backed by any bytes).

const BASE = 0x200000;
const OTHER = 0x210000;
const tmp = `/tmp/aot-cross-image-${process.pid}.bin`;

// 0x200000: jmp 0x210000            (E9 rel32, rel = 0x210000-(0x200000+5))
// 0x200005: cmp eax, 1 ; jz 0x210000 ; ret   (a conditional tail call + fall-through)
const rel = (from: number, to: number) => (to - (from + 5)) >>> 0;
const jrel = (from: number, to: number) => (to - (from + 6)) >>> 0;
const blob = new Uint8Array(0x40);
const dv = new DataView(blob.buffer);
blob[0] = 0xe9; dv.setUint32(1, rel(BASE, OTHER), true);                 // jmp 0x210000
blob[5] = 0x83; blob[6] = 0xf8; blob[7] = 0x01;                          // cmp eax, 1
blob[8] = 0x0f; blob[9] = 0x84; dv.setUint32(10, jrel(BASE + 8, OTHER), true); // jz 0x210000
blob[14] = 0xc3;                                                        // ret
await Bun.write(tmp, blob);

const decoder = await CapstoneDecoder.open(tmp, undefined, BASE);
const inEntryImage = (addr: number) => addr < OTHER;

afterAll(() => { try { require("fs").unlinkSync(tmp); } catch {} });

test("a direct jmp into another image becomes an exit, not a rejection", async () => {
    const withPred = await translateFunctionC(decoder, BASE, undefined, inEntryImage);
    expect(withPred).not.toBeNull();
    expect(withPred!.c).toContain(`ip = ${OTHER >>> 0}u; goto exit;`);

    // Default (one image): the walker follows the jmp into unbacked bytes.
    const noPred = await translateFunctionC(decoder, BASE);
    expect(noPred).toBeNull();
    expect(lastRejection).toContain("no instruction");
});

test("a conditional branch taken into another image exits, keeping the fall-through", async () => {
    const t = await translateFunctionC(decoder, BASE + 5, undefined, inEntryImage);
    expect(t).not.toBeNull();
    // The taken edge exits at the target; the fall-through reaches the ret,
    // which pops the return address into ip. Both exits are present.
    expect(t!.c).toContain(`ip = ${OTHER >>> 0}u; goto exit;`);
    expect(t!.c).toContain("ip = LD32(esp);");
});
