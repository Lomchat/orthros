import { describe, expect, test } from "bun:test";
import {
    createMilesPreferences,
    MILES_PREFERENCE_DEFAULTS,
} from "../../src/worker/modules/mss32/context";

describe("Miles preference defaults", () => {
    test("contains every Miles 6.x preference", () => {
        expect(MILES_PREFERENCE_DEFAULTS).toHaveLength(46);
        expect(MILES_PREFERENCE_DEFAULTS[1]).toBe(64); // DIG_MIXER_CHANNELS
        expect(MILES_PREFERENCE_DEFAULTS[31]).toBe(1); // DIG_ENABLE_RESAMPLE_FILTER
        expect(MILES_PREFERENCE_DEFAULTS[34]).toBe(8); // DIG_DS_FRAGMENT_SIZE
        expect(MILES_PREFERENCE_DEFAULTS[35]).toBe(96); // DIG_DS_FRAGMENT_CNT
        expect(MILES_PREFERENCE_DEFAULTS[45]).toBe(100); // DIG_MIN_CHAIN_ELEMENT_TIME
    });

    test("creates an independent mutable table for each process", () => {
        const first = createMilesPreferences();
        const second = createMilesPreferences();

        first[34] = 12;
        expect(second[34]).toBe(8);
        expect(MILES_PREFERENCE_DEFAULTS[34]).toBe(8);
    });
});
