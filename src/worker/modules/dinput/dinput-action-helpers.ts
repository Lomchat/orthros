/**
 * Runtime helpers for DI8 action-map poll/build (not generated from dinput.h).
 */

import {
    DIDFT_ABSAXIS,
    DIDFT_AXIS,
    DIDFT_BUTTON,
    DIDFT_POV,
    DIDFT_RELAXIS,
    defaultGamepadObjIdForSemantic,
    defaultKeyboardDikForSemantic,
    defaultMouseObjIdForSemantic,
    didftMakeInstance,
    isMappableGenreSemantic,
} from "./dinput-action-maps";

export const DIDFT_GETTYPE_MASK = 0xff;
export const DIAF_OFS_GUID = 20;
export const DIAF_OFS_GENRE = 36;

export const DIPOV_CENTER = 0xffffffff;
export const DI_AXIS_MIN = -32768;
export const DI_AXIS_MAX = 32767;

export type ActionMapKind = "button" | "axis" | "hat" | "mouse_button" | "mouse_axis" | "gamepad_button" | "gamepad_axis" | "gamepad_hat";

export interface ActionMapEntry {
    uAppData: number;
    semantic: number;
    kind: ActionMapKind;
    dwOfs: number;
    /** Keyboard / gamepad button */
    dik?: number;
    /** Keyboard analog axis negative / positive keys */
    dikNeg?: number;
    dikPos?: number;
    /** Last polled value for axis/hat (change detection) */
    lastValue?: number;
    /** Gamepad axis index (0..3) or button index */
    gpAxis?: number;
    gpButton?: number;
    /** Mouse DIMOFS offset */
    mouseOfs?: number;
}

export function didftGetType(objId: number): number {
    return objId & DIDFT_GETTYPE_MASK;
}

export function didftGetInstance(objId: number): number {
    return (objId >>> 8) & 0xffff;
}

export function semanticControlClass(sem: number): number {
    return ((sem >>> 8) & 0xff) & 0x0f;
}

export function isGenreAxisSemantic(sem: number): boolean {
    if (!isMappableGenreSemantic(sem)) return false;
    const c = semanticControlClass(sem);
    return c === 0x02 || c === 0x0a;
}

export function isGenreHatSemantic(sem: number): boolean {
    if (!isMappableGenreSemantic(sem)) return false;
    return semanticControlClass(sem) === 0x06;
}

/** Keyboard axis as neg/pos DIK pair from semantic channel + name heuristics. */
export function keyboardAxisDikPair(sem: number, semanticName?: string): { neg: number; pos: number } {
    const name = semanticName ?? "";
    if (name.includes("BRAKE") || name.includes("SLOWER") || name.includes("LOWER") || name.includes("BACK")) {
        return { neg: 0xd0, pos: 0xc8 }; // down / up
    }
    if (name.includes("ACCEL") || name.includes("THROTTLE") || name.includes("MOVE") || name.includes("FORWARD") || name.includes("CLIMB")) {
        return { neg: 0xd0, pos: 0xc8 }; // down=release, up=press
    }
    const ch = (sem >>> 16) & 7;
    switch (ch) {
        case 0: return { neg: 0xcb, pos: 0xcd }; // steer / lateral
        case 1: return { neg: 0xd0, pos: 0xc8 }; // Y
        case 2: return { neg: 0x10, pos: 0x12 }; // Q / E rotate
        case 4: return { neg: 0xd0, pos: 0xc8 }; // brake channel
        default: return { neg: 0xcb, pos: 0xcd };
    }
}

/** POV (hundredths of degrees) from arrow-key state. */
export function povFromArrowKeys(up: boolean, down: boolean, left: boolean, right: boolean): number {
    if (up && right && !down && !left) return 4500;
    if (up && left && !down && !right) return 31500;
    if (down && right && !up && !left) return 13500;
    if (down && left && !up && !right) return 22500;
    if (up && !down && !left && !right) return 0;
    if (right && !up && !down && !left) return 9000;
    if (down && !up && !left && !right) return 18000;
    if (left && !up && !down && !right) return 27000;
    return DIPOV_CENTER;
}

export function axisValueFromDikPair(neg: boolean, pos: boolean): number {
    if (neg && pos) return 0;
    if (neg) return DI_AXIS_MIN;
    if (pos) return DI_AXIS_MAX;
    return 0;
}

export function buildKeyboardObjId(sem: number, semanticName?: string): number | null {
    if (isGenreAxisSemantic(sem)) {
        const ch = (sem >>> 16) & 7;
        return (DIDFT_AXIS | didftMakeInstance(ch)) >>> 0;
    }
    if (isGenreHatSemantic(sem)) {
        return (DIDFT_POV | didftMakeInstance(0)) >>> 0;
    }
    const dik = defaultKeyboardDikForSemantic(sem);
    if (dik === null || dik === 0) return null;
    return (DIDFT_BUTTON | didftMakeInstance(dik)) >>> 0;
}

export function buildObjIdForDevice(sem: number, deviceType: string, semanticName?: string): number | null {
    if (deviceType === "mouse") return defaultMouseObjIdForSemantic(sem);
    if (deviceType === "gamepad" || deviceType === "joystick") return defaultGamepadObjIdForSemantic(sem);
    return buildKeyboardObjId(sem, semanticName);
}

export function makeActionMapEntry(
    uAppData: number,
    sem: number,
    objId: number,
    deviceType: string,
    semanticName?: string,
): ActionMapEntry | null {
    const type = didftGetType(objId);
    const inst = didftGetInstance(objId);

    if (deviceType === "mouse") {
        if ((sem >>> 24) === 0x82) {
            const ofs = sem & 0xff;
            if (ofs >= 12) return { uAppData, semantic: sem, kind: "mouse_button", dwOfs: ofs, mouseOfs: ofs, lastValue: 0 };
            return { uAppData, semantic: sem, kind: "mouse_axis", dwOfs: ofs, mouseOfs: ofs, lastValue: 0 };
        }
        if (type & DIDFT_RELAXIS || type & DIDFT_ABSAXIS || type === DIDFT_AXIS) {
            const ofs = inst === 0 ? 0 : inst === 2 ? 8 : 4;
            return { uAppData, semantic: sem, kind: "mouse_axis", dwOfs: ofs, mouseOfs: ofs, lastValue: 0 };
        }
        if (type & DIDFT_BUTTON) {
            const ofs = 12 + Math.min(inst, 7);
            return { uAppData, semantic: sem, kind: "mouse_button", dwOfs: ofs, mouseOfs: ofs, lastValue: 0 };
        }
    }

    if (deviceType === "gamepad" || deviceType === "joystick") {
        if (type & DIDFT_POV) {
            return { uAppData, semantic: sem, kind: "gamepad_hat", dwOfs: 0, lastValue: DIPOV_CENTER };
        }
        if (type & DIDFT_ABSAXIS || type & DIDFT_RELAXIS || type === DIDFT_AXIS) {
            return { uAppData, semantic: sem, kind: "gamepad_axis", dwOfs: inst, gpAxis: inst, lastValue: 0 };
        }
        if (type & DIDFT_BUTTON) {
            return { uAppData, semantic: sem, kind: "gamepad_button", dwOfs: inst, gpButton: inst, lastValue: 0 };
        }
    }

    // Keyboard default path
    if (type & DIDFT_POV || isGenreHatSemantic(sem)) {
        return { uAppData, semantic: sem, kind: "hat", dwOfs: 0, lastValue: DIPOV_CENTER };
    }
    if (type === DIDFT_AXIS || type & DIDFT_ABSAXIS || type & DIDFT_RELAXIS || isGenreAxisSemantic(sem)) {
        const pair = keyboardAxisDikPair(sem, semanticName);
        return {
            uAppData,
            semantic: sem,
            kind: "axis",
            dwOfs: inst,
            dikNeg: pair.neg,
            dikPos: pair.pos,
            lastValue: 0,
        };
    }
    if (type & DIDFT_BUTTON) {
        const dik = inst & 0xff;
        if (dik === 0) return null;
        return { uAppData, semantic: sem, kind: "button", dwOfs: dik, dik, lastValue: 0 };
    }

    const dik = defaultKeyboardDikForSemantic(sem);
    if (dik === null || dik === 0) return null;
    if (isGenreAxisSemantic(sem)) {
        const pair = keyboardAxisDikPair(sem, semanticName);
        return { uAppData, semantic: sem, kind: "axis", dwOfs: inst, dikNeg: pair.neg, dikPos: pair.pos, lastValue: 0 };
    }
    if (isGenreHatSemantic(sem)) {
        return { uAppData, semantic: sem, kind: "hat", dwOfs: 0, lastValue: DIPOV_CENTER };
    }
    return { uAppData, semantic: sem, kind: "button", dwOfs: dik, dik, lastValue: 0 };
}

export interface ActionPollEvent {
    entry: ActionMapEntry;
    dwData: number;
}

export function pollActionMapEntries(
    entries: ActionMapEntry[],
    dikPressed: (dik: number) => number,
    arrowKeys: { up: boolean; down: boolean; left: boolean; right: boolean },
    mouse: { dx: number; dy: number; dz: number; buttons: number; prevButtons: number },
    gamepad: { axes: Int32Array | number[]; buttons: number; connected: boolean },
): ActionPollEvent[] {
    const out: ActionPollEvent[] = [];

    for (const e of entries) {
        let value = 0;
        switch (e.kind) {
            case "button": {
                if (e.dik === undefined) continue;
                value = dikPressed(e.dik);
                if (value === (e.lastValue ?? 0)) continue;
                e.lastValue = value;
                out.push({ entry: e, dwData: value });
                break;
            }
            case "axis": {
                if (e.dikNeg === undefined || e.dikPos === undefined) continue;
                const neg = dikPressed(e.dikNeg) !== 0;
                const pos = dikPressed(e.dikPos) !== 0;
                value = axisValueFromDikPair(neg, pos);
                if (value === (e.lastValue ?? 0)) continue;
                e.lastValue = value;
                out.push({ entry: e, dwData: value });
                break;
            }
            case "hat": {
                value = povFromArrowKeys(arrowKeys.up, arrowKeys.down, arrowKeys.left, arrowKeys.right);
                if (value === (e.lastValue ?? DIPOV_CENTER)) continue;
                e.lastValue = value;
                out.push({ entry: e, dwData: value });
                break;
            }
            case "mouse_axis": {
                const ofs = e.mouseOfs ?? e.dwOfs;
                if (ofs === 0) value = mouse.dx;
                else if (ofs === 4) value = mouse.dy;
                else if (ofs === 8) value = mouse.dz;
                else value = 0;
                if (value === 0) continue;
                out.push({ entry: e, dwData: value });
                break;
            }
            case "mouse_button": {
                const ofs = e.mouseOfs ?? e.dwOfs;
                const bit = ofs === 12 ? 1 : ofs === 13 ? 2 : ofs === 14 ? 4 : ofs === 15 ? 8 : ofs === 16 ? 16 : 0;
                if (!bit) continue;
                value = (mouse.buttons & bit) ? 0x80 : 0x00;
                const prev = (mouse.prevButtons & bit) ? 0x80 : 0x00;
                if (value === prev) continue;
                out.push({ entry: e, dwData: value });
                break;
            }
            case "gamepad_axis": {
                if (!gamepad.connected || e.gpAxis === undefined) continue;
                value = gamepad.axes[e.gpAxis] ?? 0;
                if (value === (e.lastValue ?? 0)) continue;
                e.lastValue = value;
                out.push({ entry: e, dwData: value });
                break;
            }
            case "gamepad_button": {
                if (!gamepad.connected || e.gpButton === undefined) continue;
                const mask = 1 << e.gpButton;
                value = (gamepad.buttons & mask) ? 0x80 : 0x00;
                if (value === (e.lastValue ?? 0)) continue;
                e.lastValue = value;
                out.push({ entry: e, dwData: value });
                break;
            }
            case "gamepad_hat": {
                if (!gamepad.connected) continue;
                const x = gamepad.axes[0] ?? 0;
                const y = gamepad.axes[1] ?? 0;
                const th = 8000;
                value = povFromArrowKeys(y < -th, y > th, x < -th, x > th);
                if (value === (e.lastValue ?? DIPOV_CENTER)) continue;
                e.lastValue = value;
                out.push({ entry: e, dwData: value });
                break;
            }
        }
    }
    return out;
}
