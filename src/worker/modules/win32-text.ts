/*
 * Win32 accelerator-prefix handling for control text and DrawText.
 *
 * A single '&' marks the following displayed character as the access key.
 * A doubled '&&' displays one literal ampersand. DT_NOPREFIX/SS_NOPREFIX keep
 * ampersands literal, while DT_HIDEPREFIX strips them without drawing the cue.
 */

export interface ParsedMnemonicText {
    /** Text as displayed after Win32 prefix handling. */
    display: string;
    /** UTF-16 index in display of the access-key character, or -1. */
    underlineIndex: number;
    /** Lowercase access-key code unit, or 0 when none. */
    mnemonicChar: number;
}

export type MnemonicTextContext =
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;

export interface DrawMnemonicTextOptions {
    /** Parse Win32 '&' prefixes. Defaults to true. */
    processPrefix?: boolean;
    /** Draw the access-key underline. Defaults to true. */
    drawUnderline?: boolean;
    /** Draw display text. DT_PREFIXONLY disables this. Defaults to true. */
    drawText?: boolean;
}

export const DT_NOPREFIX = 0x00000800;
export const DT_HIDEPREFIX = 0x00100000;
export const DT_PREFIXONLY = 0x00200000;

export function drawTextPrefixOptions(format?: number): DrawMnemonicTextOptions {
    if (format !== undefined && (format & DT_NOPREFIX) !== 0) {
        return { processPrefix: false, drawUnderline: false, drawText: true };
    }
    if (format !== undefined && (format & DT_PREFIXONLY) !== 0) {
        return { processPrefix: true, drawUnderline: true, drawText: false };
    }
    if (format !== undefined && (format & DT_HIDEPREFIX) !== 0) {
        return { processPrefix: true, drawUnderline: false, drawText: true };
    }
    return { processPrefix: true, drawUnderline: true, drawText: true };
}

export function parseMnemonicText(raw: string, processPrefix = true): ParsedMnemonicText {
    if (!raw || !processPrefix) {
        return { display: raw, underlineIndex: -1, mnemonicChar: 0 };
    }

    let display = "";
    let underlineIndex = -1;
    let mnemonicChar = 0;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch !== "&") {
            display += ch;
            continue;
        }

        const next = raw[i + 1];
        if (next === "&") {
            display += "&";
            i++;
            continue;
        }

        if (next !== undefined) {
            if (underlineIndex < 0) {
                underlineIndex = display.length;
                mnemonicChar = next.toLowerCase().charCodeAt(0);
            }
            display += next;
            i++;
        }
    }

    return { display, underlineIndex, mnemonicChar };
}

export function measureMnemonicText(
    ctx: MnemonicTextContext,
    raw: string,
    processPrefix = true,
): number {
    return ctx.measureText(parseMnemonicText(raw, processPrefix).display).width;
}

function fontPixelSize(ctx: MnemonicTextContext): number {
    const match = /(\d+(?:\.\d+)?)px\b/.exec(ctx.font);
    return match ? Number(match[1]) : 11;
}

function underlineY(ctx: MnemonicTextContext, y: number): number {
    const size = fontPixelSize(ctx);
    switch (ctx.textBaseline) {
        case "top":
        case "hanging":
            return y + Math.max(1, Math.round(size - 1));
        case "middle":
            return y + Math.max(1, Math.round(size * 0.42));
        case "bottom":
        case "ideographic":
            return y - 1;
        case "alphabetic":
        default:
            return y + 1;
    }
}

function leftAlignedX(ctx: MnemonicTextContext, display: string, x: number): number {
    switch (ctx.textAlign) {
        case "center":
            return x - ctx.measureText(display).width / 2;
        case "right":
        case "end":
            return x - ctx.measureText(display).width;
        case "left":
        case "start":
        default:
            return x;
    }
}

function drawMnemonicUnderline(
    ctx: MnemonicTextContext,
    display: string,
    underlineIndex: number,
    x: number,
    y: number,
): void {
    if (underlineIndex < 0 || underlineIndex >= display.length) return;

    const beforeWidth = ctx.measureText(display.slice(0, underlineIndex)).width;
    const throughWidth = ctx.measureText(display.slice(0, underlineIndex + 1)).width;
    const underlineX = Math.round(leftAlignedX(ctx, display, x) + beforeWidth);
    const underlineTop = Math.round(underlineY(ctx, y));
    const underlineW = Math.max(1, Math.round(throughWidth - beforeWidth));

    ctx.fillRect(underlineX, underlineTop, underlineW, 1);
}

export function fillTextWithMnemonic(
    ctx: MnemonicTextContext,
    raw: string,
    x: number,
    y: number,
    processPrefixOrOptions: boolean | DrawMnemonicTextOptions = true,
    drawUnderlineLegacy = true,
): ParsedMnemonicText {
    const options = typeof processPrefixOrOptions === "boolean"
        ? { processPrefix: processPrefixOrOptions, drawUnderline: drawUnderlineLegacy, drawText: true }
        : processPrefixOrOptions;
    const processPrefix = options.processPrefix ?? true;
    const drawUnderline = options.drawUnderline ?? true;
    const drawText = options.drawText ?? true;
    const parsed = parseMnemonicText(raw, processPrefix);

    if (drawText && parsed.display) {
        ctx.fillText(parsed.display, x, y);
    }
    if (processPrefix && drawUnderline && parsed.underlineIndex >= 0) {
        drawMnemonicUnderline(ctx, parsed.display, parsed.underlineIndex, x, y);
    }
    return parsed;
}
