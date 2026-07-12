import { describe, expect, test } from "bun:test";
import { drawTextPrefixOptions, parseMnemonicText } from "../../src/worker/modules/win32-text";

describe("parseMnemonicText", () => {
    test("strips a single access-key prefix", () => {
        expect(parseMnemonicText("&Play")).toEqual({
            display: "Play",
            underlineIndex: 0,
            mnemonicChar: "p".charCodeAt(0),
        });
    });

    test("underlines only the first access key", () => {
        expect(parseMnemonicText("&Video &Settings")).toEqual({
            display: "Video Settings",
            underlineIndex: 0,
            mnemonicChar: "v".charCodeAt(0),
        });
    });

    test("collapses doubled ampersands to one literal", () => {
        expect(parseMnemonicText("D3D Hardware T&&L")).toEqual({
            display: "D3D Hardware T&L",
            underlineIndex: -1,
            mnemonicChar: 0,
        });
    });

    test("handles literal ampersand followed by an access key", () => {
        expect(parseMnemonicText("Save && E&xit")).toEqual({
            display: "Save & Exit",
            underlineIndex: 8,
            mnemonicChar: "x".charCodeAt(0),
        });
    });

    test("drops a trailing lone ampersand", () => {
        expect(parseMnemonicText("Options&")).toEqual({
            display: "Options",
            underlineIndex: -1,
            mnemonicChar: 0,
        });
    });

    test("honours DT_NOPREFIX-style passthrough", () => {
        expect(parseMnemonicText("&Play", false)).toEqual({
            display: "&Play",
            underlineIndex: -1,
            mnemonicChar: 0,
        });
    });

    test("maps DrawText prefix flags", () => {
        expect(drawTextPrefixOptions()).toEqual({
            processPrefix: true,
            drawUnderline: true,
            drawText: true,
        });
        expect(drawTextPrefixOptions(0x00000800)).toEqual({
            processPrefix: false,
            drawUnderline: false,
            drawText: true,
        });
        expect(drawTextPrefixOptions(0x00100000)).toEqual({
            processPrefix: true,
            drawUnderline: false,
            drawText: true,
        });
        expect(drawTextPrefixOptions(0x00200000)).toEqual({
            processPrefix: true,
            drawUnderline: true,
            drawText: false,
        });
    });
});
