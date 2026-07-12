/**
 * masksRom must survive overlay writes — otherwise CREATE_ALWAYS shadow files
 * (GTA III models\txd.img) report ROM zip size while reads mix overlay + ROM.
 */
import { describe, expect, test } from "bun:test";

type OverlayEntry = { size: number; kind: "file"; path: string; masksRom?: boolean };

function patchFileEntrySize(
    entries: Map<string, OverlayEntry>,
    key: string,
    path: string,
    size: number,
): void {
    const existing = entries.get(key);
    const entry: OverlayEntry = { size, kind: "file", path };
    if (existing?.masksRom) {
        entry.masksRom = true;
    }
    entries.set(key, entry);
}

describe("overlay masksRom preservation", () => {
    test("patchFileEntrySize keeps masksRom after size update", () => {
        const entries = new Map<string, OverlayEntry>();
        const key = "c:\\models\\txd.img";
        entries.set(key, { size: 0, kind: "file", path: "C:\\models\\txd.img", masksRom: true });

        patchFileEntrySize(entries, key, "C:\\models\\txd.img", 50_000_000);

        const entry = entries.get(key)!;
        expect(entry.masksRom).toBe(true);
        expect(entry.size).toBe(50_000_000);
    });

    test("patchFileEntrySize does not invent masksRom on legacy overlay entries", () => {
        const entries = new Map<string, OverlayEntry>();
        const key = "c:\\data\\save.dat";
        entries.set(key, { size: 100, kind: "file", path: "C:\\data\\save.dat" });

        patchFileEntrySize(entries, key, "C:\\data\\save.dat", 200);

        expect(entries.get(key)?.masksRom).toBeUndefined();
        expect(entries.get(key)?.size).toBe(200);
    });
});
