/**
 * PostFX registry — the explicit, ordered list of effects. To add an effect:
 * implement it under effects/, import it here, and insert it in CANONICAL order.
 *
 * Order matters: the LAST active effect is the "final" pass that does the present
 * geometry (scaling / letterbox). `color-grade` is kept LAST so the consolidated
 * gamma/brightness/contrast/sat/FXAA pass is always the finisher.
 *
 * The list is explicit, not auto-discovered.
 */

import { PostEffect } from "./post-effect";
import { QualityConfig } from "../../../core/quality-config";
import { CrtEffect } from "./effects/crt";
import { ScanlinesEffect } from "./effects/scanlines";
import { ColorGradeEffect } from "./effects/color-grade";

const COLOR_GRADE = new ColorGradeEffect();

// Canonical chain order. Pre-effects first; color-grade LAST.
const REGISTRY: readonly PostEffect[] = [
    new CrtEffect(),
    new ScanlinesEffect(),
    COLOR_GRADE,
];

export function listEffects(): readonly PostEffect[] {
    return REGISTRY;
}

/**
 * Return the active effects in canonical order. When a gamma ramp is present the
 * consolidated color-grade pass is forced on (gamma lives inside it) even if the
 * user-color sliders are neutral.
 */
export function getActiveEffects(q: QualityConfig, hasGamma: boolean): PostEffect[] {
    const active = REGISTRY.filter((e) => e.enabled(q));
    if (hasGamma && !active.includes(COLOR_GRADE)) {
        active.push(COLOR_GRADE);
    }
    return active;
}
