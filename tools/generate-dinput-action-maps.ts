#!/usr/bin/env bun
/**
 * Parse dinput.h action-map constants and emit keyboard/mouse default mappings for
 * IDirectInputDevice8::BuildActionMap.
 *
 * Sources: tools/reference/directx/dinput.h + dinput-genres.h (DX9 SDK)
 * Output:  src/worker/modules/dinput/dinput-action-maps.ts
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const DINPUT_H = path.join(ROOT, "tools/reference/directx/dinput.h");
const GENRES_H = path.join(ROOT, "tools/reference/directx/dinput-genres.h");
const OUT = path.join(ROOT, "src/worker/modules/dinput/dinput-action-maps.ts");

const DI_KEYBOARD_TAG = 0x81000400;
const DI_MOUSE_TAG = 0x82000400;

type Rule = { test: (name: string) => boolean; dik: string };

// Name-based rules (most-specific patterns first). DIK names must exist in dinput.h.
const NAME_RULES: Rule[] = [
    { test: (n) => n.includes("_ACCELERATE_LINK") || n.includes("_FASTER_LINK") || n.includes("_FORWARD_LINK"), dik: "DIK_UP" },
    { test: (n) => n.includes("_SLOWER_LINK") || n.includes("_BACKWARD_LINK") || n.includes("_BACK_LINK"), dik: "DIK_DOWN" },
    { test: (n) => n.includes("_GLANCE_LEFT_LINK") || n.endsWith("_GLANCEL"), dik: "DIK_Q" },
    { test: (n) => n.includes("_GLANCE_RIGHT_LINK") || n.endsWith("_GLANCER"), dik: "DIK_E" },
    { test: (n) => n.startsWith("DIHATSWITCH_"), dik: "DIK_NUMPAD8" },
    { test: (n) => n.includes("_STEER_LEFT_LINK") || n.endsWith("_STEPLEFT") || n.endsWith("_SHIFTIN"), dik: "DIK_LEFT" },
    { test: (n) => n.includes("_STEER_RIGHT_LINK") || n.endsWith("_STEPRIGHT") || n.endsWith("_SHIFTOUT"), dik: "DIK_RIGHT" },
    { test: (n) => n.includes("_GLANCE_UP_LINK") || n.endsWith("_LOOKUP"), dik: "DIK_UP" },
    { test: (n) => n.includes("_GLANCE_DOWN_LINK") || n.endsWith("_LOOKDOWN"), dik: "DIK_DOWN" },
    { test: (n) => n.includes("_BARREL_UP_LINK") || n.endsWith("_FLAPSUP") || n.endsWith("_RAISE"), dik: "DIK_UP" },
    { test: (n) => n.includes("_BARREL_DOWN_LINK") || n.endsWith("_FLAPSDOWN") || n.endsWith("_LOWER") || n.endsWith("_SHOOTLOW"), dik: "DIK_DOWN" },
    { test: (n) => n.includes("_BRAKE_LINK"), dik: "DIK_SPACE" },
    { test: (n) => n.startsWith("DIAXIS_") && n.endsWith("_STEER"), dik: "DIK_LEFT" },
    { test: (n) => n.startsWith("DIAXIS_") && (n.endsWith("_LATERAL") || n.endsWith("_STRAFE") || n.endsWith("_SIDESTEP") || n.endsWith("_TURN")), dik: "DIK_Z" },
    { test: (n) => n.startsWith("DIAXIS_") && n.endsWith("_ACCEL_AND_BRAKE"), dik: "DIK_UP" },
    { test: (n) => n.startsWith("DIAXIS_") && n.endsWith("_ACCELERATE"), dik: "DIK_UP" },
    { test: (n) => n.startsWith("DIAXIS_") && (n.endsWith("_THROTTLE") || n.endsWith("_COLLECTIVE") || n.endsWith("_BARREL") || n.endsWith("_CLIMB")), dik: "DIK_UP" },
    { test: (n) => n.startsWith("DIAXIS_") && (n.endsWith("_MOVE") || n.endsWith("_FORWARD") || n.endsWith("_LOOKUPDOWN")), dik: "DIK_UP" },
    { test: (n) => n.startsWith("DIAXIS_") && (n.endsWith("_BRAKE") || n.endsWith("_BANK")), dik: "DIK_DOWN" },
    { test: (n) => n.startsWith("DIAXIS_") && (n.endsWith("_PITCH") || n.endsWith("_TILT") || n.endsWith("_TORSO")), dik: "DIK_UP" },
    { test: (n) => n.startsWith("DIAXIS_") && (n.endsWith("_ROTATE") || n.endsWith("_RUDDER") || n.endsWith("_TORQUE")), dik: "DIK_Q" },
    { test: (n) => n.startsWith("DIAXIS_") && n.endsWith("_FLAPS"), dik: "DIK_G" },
    { test: (n) => n.endsWith("_MENU"), dik: "DIK_ESCAPE" },
    { test: (n) => n.endsWith("_PAUSE") || n.endsWith("_TIMEOUT"), dik: "DIK_ESCAPE" },
    { test: (n) => n.endsWith("_DEVICE"), dik: "DIK_F2" },
    { test: (n) => n.endsWith("_SHIFTUP") || n.endsWith("_SHOULDER") || n.endsWith("_TURBO") || n.endsWith("_BOOST") || n.endsWith("_BURST"), dik: "DIK_LSHIFT" },
    { test: (n) => n.endsWith("_SHIFTDOWN") || n.endsWith("_SWIM"), dik: "DIK_LCONTROL" },
    { test: (n) => n.endsWith("_VIEW") || n.endsWith("_LOOK"), dik: "DIK_C" },
    { test: (n) => n.endsWith("_DASHBOARD") || n.endsWith("_DISPLAY") || n.endsWith("_STRATEGY") || n.endsWith("_SUBSTITUTE"), dik: "DIK_TAB" },
    { test: (n) => n.endsWith("_AIDS"), dik: "DIK_F1" },
    { test: (n) => n.endsWith("_MAP"), dik: "DIK_M" },
    { test: (n) => n.endsWith("_PIT") || n.endsWith("_PLAY"), dik: "DIK_P" },
    { test: (n) => n.endsWith("_FIRESECONDARY") || n.endsWith("_SPECIAL2"), dik: "DIK_F" },
    { test: (n) => n.endsWith("_FIRE") || n.endsWith("_PUNCH") || n.endsWith("_ACTION") || n.endsWith("_CONTACT"), dik: "DIK_SPACE" },
    { test: (n) => n.endsWith("_WEAPONS"), dik: "DIK_TAB" },
    { test: (n) => n.endsWith("_TARGET"), dik: "DIK_T" },
    { test: (n) => n.endsWith("_GEAR") || n.endsWith("_FLAPS"), dik: "DIK_G" },
    { test: (n) => n.endsWith("_JUMP"), dik: "DIK_SPACE" },
    { test: (n) => n.endsWith("_CROUCH") || n.endsWith("_KICK") || n.endsWith("_DODGE") || n.endsWith("_BLOCK"), dik: "DIK_LCONTROL" },
    { test: (n) => n.endsWith("_RUN") || n.endsWith("_STRAFE"), dik: "DIK_Z" },
    { test: (n) => n.endsWith("_USE") || n.endsWith("_APPLY"), dik: "DIK_E" },
    { test: (n) => n.endsWith("_SELECT") || n.endsWith("_RETURN"), dik: "DIK_RETURN" },
    { test: (n) => n.endsWith("_BRAKE"), dik: "DIK_SPACE" },
    { test: (n) => n.endsWith("_REVERSE") || n.endsWith("_RECORD"), dik: "DIK_R" },
    { test: (n) => n.endsWith("_ZOOM"), dik: "DIK_Z" },
    { test: (n) => n.endsWith("_CENTER"), dik: "DIK_HOME" },
    { test: (n) => n.endsWith("_COUNTER") || n.endsWith("_FAKESNAP"), dik: "DIK_X" },
    { test: (n) => n.endsWith("_MOTION") || n.endsWith("_CALL"), dik: "DIK_C" },
    { test: (n) => n.endsWith("_SLIDE") || n.endsWith("_SPIN"), dik: "DIK_Q" },
    { test: (n) => n.endsWith("_SPECIAL1") || n.endsWith("_SPECIAL"), dik: "DIK_R" },
    { test: (n) => n.endsWith("_FOUL"), dik: "DIK_F" },
    { test: (n) => n.endsWith("_DIGIT0"), dik: "DIK_0" },
    { test: (n) => n.endsWith("_DIGIT1"), dik: "DIK_1" },
    { test: (n) => n.endsWith("_DIGIT2"), dik: "DIK_2" },
    { test: (n) => n.endsWith("_DIGIT3"), dik: "DIK_3" },
    { test: (n) => n.endsWith("_DIGIT4"), dik: "DIK_4" },
    { test: (n) => n.endsWith("_DIGIT5"), dik: "DIK_5" },
    { test: (n) => n.endsWith("_DIGIT6"), dik: "DIK_6" },
    { test: (n) => n.endsWith("_DIGIT7"), dik: "DIK_7" },
    { test: (n) => n.endsWith("_DIGIT8"), dik: "DIK_8" },
    { test: (n) => n.endsWith("_DIGIT9"), dik: "DIK_9" },
    { test: (n) => n.endsWith("_CHANNEL1"), dik: "DIK_1" },
    { test: (n) => n.endsWith("_CHANNEL2"), dik: "DIK_2" },
    { test: (n) => n.endsWith("_CHANNEL3"), dik: "DIK_3" },
    { test: (n) => n.endsWith("_CHANNEL4"), dik: "DIK_4" },
    { test: (n) => n.endsWith("_CHANNEL5"), dik: "DIK_5" },
    { test: (n) => n.endsWith("_CHANNEL6"), dik: "DIK_6" },
    { test: (n) => n.endsWith("_CHANNEL7"), dik: "DIK_7" },
    { test: (n) => n.endsWith("_CHANNEL8"), dik: "DIK_8" },
];

function parseHexValue(raw: string, known: Map<string, number>): number | null {
    const s = raw.trim();
    const direct = /^0x[0-9a-f]+$/i.exec(s);
    if (direct) return parseInt(direct[0], 16);
    const pipe = /^\(?\s*(0x[0-9a-f]+|DIK_\w+|DIMOFS_\w+)\s*\|\s*(0x[0-9a-f]+|DIK_\w+|DIMOFS_\w+)\s*\)?$/i.exec(s);
    if (pipe) {
        const a = known.get(pipe[1]) ?? (/^0x/i.test(pipe[1]) ? parseInt(pipe[1], 16) : null);
        const b = known.get(pipe[2]) ?? (/^0x/i.test(pipe[2]) ? parseInt(pipe[2], 16) : null);
        if (a === null || b === null) return null;
        return (a | b) >>> 0;
    }
    const symOnly = /^(DIK_\w+|DIMOFS_\w+)$/.exec(s);
    if (symOnly) return known.get(s) ?? null;
    return null;
}

function parseDefines(content: string): Map<string, number> {
    const out = new Map<string, number>([
        // dinput.h DIMOFS_* use FIELD_OFFSET — bootstrap numeric values for DIMOUSE_* parsing.
        ["DIMOFS_X", 0],
        ["DIMOFS_Y", 4],
        ["DIMOFS_Z", 8],
        ["DIMOFS_BUTTON0", 12],
        ["DIMOFS_BUTTON1", 13],
        ["DIMOFS_BUTTON2", 14],
        ["DIMOFS_BUTTON3", 15],
        ["DIMOFS_BUTTON4", 16],
        ["DIMOFS_BUTTON5", 17],
        ["DIMOFS_BUTTON6", 18],
        ["DIMOFS_BUTTON7", 19],
    ]);
    // Multi-pass: resolve DIK_/DIMOFS_ before composite DIKEYBOARD_/DIMOUSE_ defines.
    const re = /^#define\s+(\w+)\s+(.+?)(?:\s*\/\*.*)?$/gm;
    const pending: Array<{ name: string; raw: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        pending.push({ name: m[1], raw: m[2] });
    }
    for (let pass = 0; pass < 8; pass++) {
        let progress = false;
        for (const { name, raw } of pending) {
            if (out.has(name)) continue;
            const val = parseHexValue(raw, out);
            if (val !== null) {
                out.set(name, val >>> 0);
                progress = true;
            }
        }
        if (!progress) break;
    }
    return out;
}

function isDeviceSemantic(sem: number): boolean {
    const hi = sem >>> 24;
    return hi === 0x81 || hi === 0x82 || hi === 0x83;
}

function isGenreSemantic(sem: number): boolean {
    if (isDeviceSemantic(sem)) return false;
    if ((sem >>> 24) === 0xff) return false;
    return true;
}

function main(): void {
    const dinputContent = fs.readFileSync(DINPUT_H, "utf8");
    const genresContent = fs.readFileSync(GENRES_H, "utf8");
    const combined = dinputContent + "\n" + genresContent;

    const allDefines = parseDefines(combined);
    const dikOnly = allDefines;

    const genres: Array<{ name: string; value: number }> = [];
    const semantics: Array<{ name: string; value: number }> = [];
    for (const [name, value] of allDefines) {
        if (name.startsWith("DIVIRTUAL_")) {
            genres.push({ name, value });
            continue;
        }
        if (!/^(DIAXIS_|DIBUTTON_|DIHATSWITCH_|DIPOV_|DIMOUSE_|DIKEYBOARD_|DIVOICE_)/.test(name)) continue;
        if (name.startsWith("DIPOV_") || name.startsWith("DIVOICE_")) continue;
        semantics.push({ name, value });
    }
    genres.sort((a, b) => a.value - b.value);
    semantics.sort((a, b) => a.value - b.value);

    const keyboardDefaults = new Map<number, { name: string; dikName: string; dik: number }>();
    for (const { name, value } of semantics) {
        if (!isGenreSemantic(value)) continue;
        for (const rule of NAME_RULES) {
            if (!rule.test(name)) continue;
            const dik = dikOnly.get(rule.dik);
            if (dik === undefined) throw new Error(`Missing ${rule.dik} for ${name}`);
            keyboardDefaults.set(value, { name, dikName: rule.dik, dik });
            break;
        }
    }

    const lines: string[] = [
        "// AUTO-GENERATED by tools/generate-dinput-action-maps.ts — do not edit.",
        "// Parsed from tools/reference/directx/dinput.h + dinput-genres.h (DX9 SDK).",
        "",
        "/** DI8 raw keyboard semantics: (DIK_<key> | 0x81000400); low byte is DIK (dinput.h). */",
        "export const DI_KEYBOARD_SEMANTIC_MASK = 0xffffff00;",
        "export const DI_KEYBOARD_SEMANTIC_TAG = 0x81000400;",
        "/** DI8 raw mouse semantics: (DIMOFS_* | 0x82000?00); high byte 0x82 (dinput.h). */",
        "export const DI_MOUSE_SEMANTIC_HI = 0x82;",
        "",
        "export const DIDFT_BUTTON = 0x0000000c;",
        "export const DIDFT_RELAXIS = 0x00000001;",
        "export const DIDFT_ABSAXIS = 0x00000002;",
        "export const DIDFT_AXIS = 0x00000003;",
        "export const DIDFT_POV = 0x00000010;",
        "export const didftMakeInstance = (n: number): number => ((n & 0xffff) << 8) >>> 0;",
        "",
        "/** Application genres from dinput.h (DIACTIONFORMAT.dwGenre). */",
        "export const DI_GENRES = {",
    ];
    for (const { name, value } of genres) {
        lines.push(`    ${name}: 0x${value.toString(16).toUpperCase().padStart(8, "0")},`);
    }
    lines.push("} as const;");
    lines.push("");
    lines.push("/** Genre / device semantic constants from dinput.h. */");
    lines.push("export const DI_SEMANTICS = {");
    for (const { name, value } of semantics) {
        lines.push(`    ${name}: 0x${value.toString(16).toUpperCase().padStart(8, "0")},`);
    }
    lines.push("} as const;");
    lines.push("");
    lines.push("/** Name-rule keyboard defaults (explicit dinput.h control names). */");
    lines.push("export const DI_KEYBOARD_DEFAULTS: Record<number, number> = {");
    for (const [value, { name, dikName, dik }] of [...keyboardDefaults.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push(`    0x${value.toString(16).toUpperCase().padStart(8, "0")}: 0x${dik.toString(16).padStart(2, "0")}, // ${name} -> ${dikName}`);
    }
    lines.push("};");
    lines.push("");
    lines.push(`// dinput.h link-button suffix bytes (low byte of *_LINK / MENU / PAUSE / DEVICE).`);
    lines.push("const LINK_LOW_BYTE: Record<number, number> = {");
    lines.push("    0xE0: 0xC8, 0xE4: 0xCB, 0xE8: 0xD0, 0xEC: 0xCD, // up/left/down/right");
    lines.push("    0xFC: 0x01, 0xFD: 0x01, 0xFE: 0x3C, // pause/menu/device");
    lines.push("};");
    lines.push("// Priority-1/2 virtual button ordinals (low byte) when name rules miss.");
    lines.push("const BUTTON_ORDINAL: Record<number, number> = {");
    lines.push("    0x01: 0x39, 0x02: 0x1D, 0x03: 0x2A, 0x04: 0x2E, 0x05: 0x0F, 0x06: 0x3B, 0x07: 0x32, 0x08: 0x19,");
    lines.push("    0x09: 0x12, 0x0A: 0x10, 0x0B: 0x13, 0x0C: 0x21, 0x0D: 0x2D, 0x0E: 0x2C, 0x0F: 0x2F, 0x10: 0x1C,");
    lines.push("    0x11: 0x03, 0x12: 0x04, 0x13: 0x05, 0x14: 0x06, 0x15: 0x07, 0x16: 0x08, 0x17: 0x09, 0x18: 0x0A,");
    lines.push("};");
    lines.push("// Virtual axis channel ((semantic >> 16) & 7) for DIAXIS_* when name rules miss.");
    lines.push("const AXIS_CHANNEL: Record<number, number> = {");
    lines.push("    0: 0xCB, 1: 0xC8, 2: 0xCB, 3: 0xC8, 4: 0xD0, 5: 0xC8, 6: 0xC8, 7: 0xC8,");
    lines.push("};");
    lines.push("");
    lines.push("function genericGenreKeyboardDik(sem: number): number | null {");
    lines.push("    const low = sem & 0xff;");
    lines.push("    const link = LINK_LOW_BYTE[low];");
    lines.push("    if (link !== undefined) return link;");
    lines.push("    const controlClass = ((sem >>> 8) & 0xff) & 0x0f;");
    lines.push("    if (controlClass === 0x06) return 0x10; // DIHATSWITCH_* -> Q");
    lines.push("    if (controlClass === 0x02 || controlClass === 0x0a) {");
    lines.push("        return AXIS_CHANNEL[(sem >>> 16) & 7] ?? 0xC8;");
    lines.push("    }");
    lines.push("    if (controlClass === 0x04 || controlClass === 0x0c) {");
    lines.push("        return BUTTON_ORDINAL[low] ?? null;");
    lines.push("    }");
    lines.push("    return null;");
    lines.push("}");
    lines.push("");
    lines.push("export function defaultKeyboardDikForSemantic(semantic: number): number | null {");
    lines.push("    const sem = semantic >>> 0;");
    lines.push("    if (((sem & DI_KEYBOARD_SEMANTIC_MASK) >>> 0) === DI_KEYBOARD_SEMANTIC_TAG) {");
    lines.push("        const dik = sem & 0xff;");
    lines.push("        return dik !== 0 ? dik : null;");
    lines.push("    }");
    lines.push("    if (!isGenreSemantic(sem)) return null;");
    lines.push("    return DI_KEYBOARD_DEFAULTS[sem] ?? genericGenreKeyboardDik(sem);");
    lines.push("}");
    lines.push("");
    lines.push("function isGenreSemantic(sem: number): boolean {");
    lines.push("    const hi = sem >>> 24;");
    lines.push("    if (hi === 0x81 || hi === 0x82 || hi === 0x83) return false;");
    lines.push("    if (hi === 0xff) return false;");
    lines.push("    return true;");
    lines.push("}");
    lines.push("");
    lines.push("/** Mouse object id for genre / DIMOUSE_* semantics (BuildActionMap on SysMouse). */");
    lines.push("export function defaultMouseObjIdForSemantic(semantic: number): number | null {");
    lines.push("    const sem = semantic >>> 0;");
    lines.push("    if ((sem >>> 24) === DI_MOUSE_SEMANTIC_HI) {");
    lines.push("        const ofs = sem & 0xff;");
    lines.push("        const mid = (sem >>> 8) & 0xff;");
    lines.push("        if (mid === 0x04 || ofs >= 12) return (DIDFT_BUTTON | didftMakeInstance(ofs >= 12 ? ofs - 12 : 0)) >>> 0;");
    lines.push("        const inst = ofs === 0 ? 0 : ofs === 8 ? 2 : 1;");
    lines.push("        const type = mid === 0x02 ? DIDFT_ABSAXIS : DIDFT_RELAXIS;");
    lines.push("        return (type | didftMakeInstance(inst)) >>> 0;");
    lines.push("    }");
    lines.push("    if (!isGenreSemantic(sem)) return null;");
    lines.push("    const low = sem & 0xff;");
    lines.push("    const link = LINK_LOW_BYTE[low];");
    lines.push("    if (link !== undefined) {");
    lines.push("        if (link === 0xCB) return (DIDFT_RELAXIS | didftMakeInstance(0)) >>> 0;");
    lines.push("        if (link === 0xCD) return (DIDFT_RELAXIS | didftMakeInstance(0)) >>> 0;");
    lines.push("        if (link === 0xC8) return (DIDFT_RELAXIS | didftMakeInstance(1)) >>> 0;");
    lines.push("        if (link === 0xD0) return (DIDFT_RELAXIS | didftMakeInstance(1)) >>> 0;");
    lines.push("        if (low === 0xFC || low === 0xFD) return (DIDFT_BUTTON | didftMakeInstance(1)) >>> 0;");
    lines.push("        return (DIDFT_BUTTON | didftMakeInstance(2)) >>> 0;");
    lines.push("    }");
    lines.push("    const controlClass = ((sem >>> 8) & 0xff) & 0x0f;");
    lines.push("    if (controlClass === 0x02 || controlClass === 0x0a) {");
    lines.push("        const ch = (sem >>> 16) & 7;");
    lines.push("        const inst = ch === 2 ? 2 : ch === 4 ? 2 : ch & 1;");
    lines.push("        return (DIDFT_RELAXIS | didftMakeInstance(inst)) >>> 0;");
    lines.push("    }");
    lines.push("    if (controlClass === 0x04 || controlClass === 0x0c) {");
    lines.push("        const btn = BUTTON_ORDINAL[low];");
    lines.push("        const idx = btn !== undefined ? Math.min(4, (low - 1) & 7) : 0;");
    lines.push("        return (DIDFT_BUTTON | didftMakeInstance(idx)) >>> 0;");
    lines.push("    }");
    lines.push("    if (controlClass === 0x06) return (DIDFT_BUTTON | didftMakeInstance(2)) >>> 0;");
    lines.push("    return null;");
    lines.push("}");
    lines.push("");
    lines.push("/** Gamepad/joystick object id for genre semantics (BuildActionMap on SysJoystick). */");
    lines.push("export function defaultGamepadObjIdForSemantic(semantic: number): number | null {");
    lines.push("    const sem = semantic >>> 0;");
    lines.push("    if (!isGenreSemantic(sem)) return null;");
    lines.push("    const low = sem & 0xff;");
    lines.push("    const link = LINK_LOW_BYTE[low];");
    lines.push("    if (link !== undefined) {");
    lines.push("        if (link === 0xCB || link === 0xCD) return (DIDFT_ABSAXIS | didftMakeInstance(0)) >>> 0;");
    lines.push("        if (link === 0xC8 || link === 0xD0) return (DIDFT_ABSAXIS | didftMakeInstance(1)) >>> 0;");
    lines.push("        return (DIDFT_BUTTON | didftMakeInstance(Math.min(15, low & 0x0f))) >>> 0;");
    lines.push("    }");
    lines.push("    const controlClass = ((sem >>> 8) & 0xff) & 0x0f;");
    lines.push("    if (controlClass === 0x06) return (DIDFT_POV | didftMakeInstance(0)) >>> 0;");
    lines.push("    if (controlClass === 0x02 || controlClass === 0x0a) {");
    lines.push("        const ch = (sem >>> 16) & 7;");
    lines.push("        const inst = ch === 3 ? 2 : ch === 4 ? 3 : ch & 1;");
    lines.push("        return (DIDFT_ABSAXIS | didftMakeInstance(inst)) >>> 0;");
    lines.push("    }");
    lines.push("    if (controlClass === 0x04 || controlClass === 0x0c) {");
    lines.push("        const idx = low >= 1 && low <= 0x10 ? low - 1 : 0;");
    lines.push("        return (DIDFT_BUTTON | didftMakeInstance(idx)) >>> 0;");
    lines.push("    }");
    lines.push("    return null;");
    lines.push("}");
    lines.push("");
    lines.push("export function isMappableGenreSemantic(semantic: number): boolean {");
    lines.push("    const sem = semantic >>> 0;");
    lines.push("    return isGenreSemantic(sem);");
    lines.push("}");

    fs.writeFileSync(OUT, lines.join("\n") + "\n");

    let genreTotal = 0;
    let genreMapped = 0;
    for (const { value } of semantics) {
        if (!isGenreSemantic(value)) continue;
        genreTotal++;
        // simulate resolver
        const explicit = keyboardDefaults.get(value);
        if (explicit !== undefined) { genreMapped++; continue; }
        // generic check inline
        const sem = value;
        const low = sem & 0xff;
        const link = { 0xE0:1,0xE4:1,0xE8:1,0xEC:1,0xFC:1,0xFD:1,0xFE:1 }[low];
        const cls = ((sem >>> 8) & 0xff) & 0x0f;
        if (link || cls === 0x06 || cls === 0x02 || cls === 0x0a || cls === 0x04 || cls === 0x0c) genreMapped++;
    }

    console.log(`Wrote ${OUT}`);
    console.log(`  genres: ${genres.length}, semantics: ${semantics.length}`);
    console.log(`  explicit keyboard defaults: ${keyboardDefaults.size}`);
    console.log(`  genre coverage (explicit+generic): ${genreMapped}/${genreTotal}`);
}

main();
