import { describe, expect, test } from "bun:test";
import {
    DI_GENRES,
    DI_SEMANTICS,
    DIDFT_ABSAXIS,
    DIDFT_POV,
    defaultGamepadObjIdForSemantic,
    defaultKeyboardDikForSemantic,
    defaultMouseObjIdForSemantic,
    isMappableGenreSemantic,
} from "../../src/worker/modules/dinput/dinput-action-maps";
import {
    axisValueFromDikPair,
    buildObjIdForDevice,
    didftGetType,
    keyboardAxisDikPair,
    makeActionMapEntry,
    pollActionMapEntries,
    povFromArrowKeys,
} from "../../src/worker/modules/dinput/dinput-action-helpers";

describe("dinput action maps", () => {
    test("all DIVIRTUAL genres from dinput.h", () => {
        expect(DI_GENRES.DIVIRTUAL_DRIVING_RACE).toBe(0x01000000);
        expect(Object.keys(DI_GENRES).length).toBe(41);
    });

    test("DRIVING_RACE semantics and keyboard defaults", () => {
        expect(DI_SEMANTICS.DIAXIS_DRIVINGR_STEER).toBe(0x01008a01);
        expect(defaultKeyboardDikForSemantic(DI_SEMANTICS.DIAXIS_DRIVINGR_STEER)).toBe(0xcb);
        expect(defaultKeyboardDikForSemantic(DI_SEMANTICS.DIBUTTON_DRIVINGR_GLANCE_LEFT_LINK)).toBe(0x10);
        expect(defaultKeyboardDikForSemantic(DI_SEMANTICS.DIHATSWITCH_DRIVINGR_GLANCE)).toBe(0x48); // numpad8
    });

    test("DIKEYBOARD_* uses low-byte DIK", () => {
        expect(defaultKeyboardDikForSemantic(0x81000400 | 0x39)).toBe(0x39);
    });

    test("DIMOUSE_* resolves to mouse object ids", () => {
        expect(DI_SEMANTICS.DIMOUSE_XAXIS).toBe(0x82000300);
        expect(DI_SEMANTICS.DIMOUSE_BUTTON0).toBe(0x8200040c);
        expect(defaultMouseObjIdForSemantic(DI_SEMANTICS.DIMOUSE_XAXIS)).not.toBeNull();
        expect(defaultMouseObjIdForSemantic(DI_SEMANTICS.DIMOUSE_BUTTON0)).not.toBeNull();
    });

    test("100% genre semantic keyboard coverage", () => {
        const unmapped: string[] = [];
        for (const [name, sem] of Object.entries(DI_SEMANTICS)) {
            if (!isMappableGenreSemantic(sem)) continue;
            if (defaultKeyboardDikForSemantic(sem) === null) unmapped.push(name);
        }
        expect(unmapped).toEqual([]);
    });

    test("remote digit buttons map to number row", () => {
        expect(defaultKeyboardDikForSemantic(DI_SEMANTICS.DIBUTTON_REMOTE_DIGIT5)).toBe(0x06);
    });

    test("gamepad defaults for driving race", () => {
        const steer = defaultGamepadObjIdForSemantic(DI_SEMANTICS.DIAXIS_DRIVINGR_STEER);
        expect(steer).not.toBeNull();
        expect(didftGetType(steer!)).toBe(DIDFT_ABSAXIS);
        const glance = defaultGamepadObjIdForSemantic(DI_SEMANTICS.DIHATSWITCH_DRIVINGR_GLANCE);
        expect(didftGetType(glance!)).toBe(DIDFT_POV);
        const accel = defaultGamepadObjIdForSemantic(DI_SEMANTICS.DIAXIS_DRIVINGR_ACCELERATE);
        expect(didftGetType(accel!)).toBe(DIDFT_ABSAXIS);
    });

    test("keyboard axis poll produces analog values", () => {
        const pair = keyboardAxisDikPair(DI_SEMANTICS.DIAXIS_DRIVINGR_STEER);
        expect(pair.neg).toBe(0xcb);
        expect(pair.pos).toBe(0xcd);
        expect(axisValueFromDikPair(true, false)).toBe(-32768);
        expect(axisValueFromDikPair(false, true)).toBe(32767);

        const entry = makeActionMapEntry(1, DI_SEMANTICS.DIAXIS_DRIVINGR_STEER, buildObjIdForDevice(DI_SEMANTICS.DIAXIS_DRIVINGR_STEER, "keyboard")!, "keyboard");
        expect(entry?.kind).toBe("axis");
        const events = pollActionMapEntries(
            [entry!],
            (dik) => (dik === pair.pos ? 0x80 : 0),
            { up: false, down: false, left: false, right: false },
            { dx: 0, dy: 0, dz: 0, buttons: 0, prevButtons: 0 },
            { connected: false, buttons: 0, axes: [0, 0, 0, 0] },
        );
        expect(events.length).toBe(1);
        expect(events[0].dwData).toBe(32767);
    });

    test("hat poll from arrow keys", () => {
        const entry = makeActionMapEntry(2, DI_SEMANTICS.DIHATSWITCH_DRIVINGR_GLANCE, buildObjIdForDevice(DI_SEMANTICS.DIHATSWITCH_DRIVINGR_GLANCE, "keyboard")!, "keyboard");
        expect(entry?.kind).toBe("hat");
        expect(povFromArrowKeys(true, false, false, false)).toBe(0);
        const events = pollActionMapEntries(
            [entry!],
            () => 0,
            { up: true, down: false, left: false, right: false },
            { dx: 0, dy: 0, dz: 0, buttons: 0, prevButtons: 0 },
            { connected: false, buttons: 0, axes: [0, 0, 0, 0] },
        );
        expect(events.length).toBe(1);
        expect(events[0].dwData).toBe(0);
    });
});
