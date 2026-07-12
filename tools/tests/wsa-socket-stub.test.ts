import { describe, expect, test } from "bun:test";
import { WsaSocketTable, WSAEWOULDBLOCK, WSAENOTSOCK } from "../../src/worker/modules/wsa-stub-shared";

describe("WsaSocketTable", () => {
    test("socket/connect/send/recv offline semantics", () => {
        const table = new WsaSocketTable();
        const s = table.socket();
        expect(s).toBeGreaterThan(0);
        expect(table.connect(s)).toBe(0);
        expect(table.send(s, 128)).toBe(128);
        expect(table.recv(s)).toBe(-1);
        expect(table.closesocket(s)).toBe(0);
        expect(table.isValid(s)).toBe(false);
    });

    test("invalid socket returns errors via table helpers", () => {
        const table = new WsaSocketTable();
        expect(table.send(999, 4)).toBe(-1);
        expect(table.isValid(999)).toBe(false);
        void WSAEWOULDBLOCK;
        void WSAENOTSOCK;
    });
});
