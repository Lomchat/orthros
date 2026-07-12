import { describe, expect, test } from "bun:test";
import { ConsoleScreenBuffer } from "../../src/worker/modules/kernel32/console-screen-buffer";

describe("ConsoleScreenBuffer", () => {
    test("write and read characters at cursor", () => {
        const buf = new ConsoleScreenBuffer(10, 5);
        const mem = new Uint8Array(32);
        const text = new TextEncoder().encode("Hi");
        mem.set(text, 0);
        const written = buf.writeCharactersA(mem, 0, 2, { x: 1, y: 1 });
        expect(written).toBe(2);
        const outMem = new Uint8Array(4);
        const read = buf.readCharactersA(outMem, 0, 2, { x: 1, y: 1 });
        expect(read).toBe(2);
        expect(outMem[0]).toBe("H".charCodeAt(0));
        expect(outMem[1]).toBe("i".charCodeAt(0));
    });

    test("fillScreenBufferInfo writes CONSOLE_SCREEN_BUFFER_INFO", () => {
        const buf = new ConsoleScreenBuffer(80, 25);
        const mem = new Uint8Array(32);
        buf.fillScreenBufferInfo(mem, 0);
        const view = new DataView(mem.buffer);
        expect(view.getInt16(0, true)).toBe(80);
        expect(view.getInt16(2, true)).toBe(25);
    });
});
