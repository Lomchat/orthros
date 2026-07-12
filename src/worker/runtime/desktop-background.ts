export type DesktopBackgroundKind = "solid" | "pattern" | "wallpaper";
export type DesktopColor = { r: number; g: number; b: number; a: number };

export type DesktopBackgroundSpec =
    | { kind: "solid"; color: DesktopColor }
    | { kind: "pattern"; fallbackColor: DesktopColor; patternId?: string }
    | { kind: "wallpaper"; fallbackColor: DesktopColor; wallpaperId?: string };

const WINDOWS_TEAL: DesktopColor = { r: 0, g: 0.5, b: 0.5, a: 1 };

function cloneColor(color: DesktopColor): DesktopColor {
    return { r: color.r, g: color.g, b: color.b, a: color.a };
}

function colorToColorRef(color: DesktopColor): number {
    const r = Math.max(0, Math.min(255, Math.round(color.r * 255)));
    const g = Math.max(0, Math.min(255, Math.round(color.g * 255)));
    const b = Math.max(0, Math.min(255, Math.round(color.b * 255)));
    return (r | (g << 8) | (b << 16)) >>> 0;
}

export class DesktopBackgroundService {
    private spec: DesktopBackgroundSpec = { kind: "solid", color: cloneColor(WINDOWS_TEAL) };

    set(spec: DesktopBackgroundSpec): void {
        this.spec = spec.kind === "solid"
            ? { kind: "solid", color: cloneColor(spec.color) }
            : { ...spec, fallbackColor: cloneColor(spec.fallbackColor) };
    }

    get(): DesktopBackgroundSpec {
        return this.spec.kind === "solid"
            ? { kind: "solid", color: cloneColor(this.spec.color) }
            : { ...this.spec, fallbackColor: cloneColor(this.spec.fallbackColor) };
    }

    getClearColor(): DesktopColor {
        return this.spec.kind === "solid"
            ? cloneColor(this.spec.color)
            : cloneColor(this.spec.fallbackColor);
    }

    getSolidColorRef(): number {
        return colorToColorRef(this.getClearColor());
    }
}

export const desktopBackground = new DesktopBackgroundService();
