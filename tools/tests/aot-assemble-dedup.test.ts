import { expect, test } from "bun:test";
import { assembleBatch, type CFunction } from "../aot/x86-to-c";

// A function can reach assembleBatch twice: named as an explicit entry and
// pulled in again by call closure. Both copies used to survive (ownership kept
// one, the call-closure kept the other) and clang saw a redefinition. The
// batch must define each entry once.
function fn(entry: number, callTargets: number[] = []): CFunction {
    return {
        entry,
        name: `fn_${entry.toString(16)}`,
        c: `void fn_${entry.toString(16)}(int b, uint32_t depth) { (void)b; (void)depth; }\n`,
        instructions: 1,
        blocks: 1,
        liveFlagSites: 0,
        calls: callTargets.length,
        callTargets,
        entries: [{ addr: entry, block: 0 }],
        extent: 1,
    };
}

test("a duplicate entry is defined once in the assembled batch", () => {
    // Two copies of 0x44b650, plus a caller that reaches it by closure.
    const batch = assembleBatch([fn(0x401000, [0x44b650]), fn(0x44b650), fn(0x44b650)], 1);
    // The signature appears twice legitimately: one forward declaration
    // (ends ';') and one definition (ends '{'). The definition must be unique.
    const defs = batch.c.split("void fn_44b650(int b, uint32_t depth) {").length - 1;
    expect(defs).toBe(1);
    const decls = batch.c.split("void fn_44b650(int b, uint32_t depth);").length - 1;
    expect(decls).toBe(1);
    // The page module for 0x44b650 lists it once.
    const page = batch.pages.find((p) => p.page === (0x44b650 >>> 12));
    expect(page!.states.filter((s) => s.addr === 0x44b650).length).toBe(1);
});
