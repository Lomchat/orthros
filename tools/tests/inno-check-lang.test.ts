/**
 * Language-aware Inno extraction (packages/formats/src/inno/check-lang.ts).
 *
 * GOG multi-language installers (e.g. XIII) gate per-language file variants with an Inno
 * `Check: check_if_install('<locale>#', ...)`. The extractor must keep only the chosen
 * locale's variant, else last-write-wins picks the wrong language (XIII shipped Italian
 * because it-IT's Default.ini was last). These check the parsing/filtering/detection.
 */
import { describe, expect, test } from "bun:test";
import {
    localesOfCheck,
    checkAllowsLanguage,
    detectInstallerLanguages,
    defaultLanguage,
} from "@bottleship/formats/inno/check-lang";

const EN = "check_if_install('en-US#','32#64#','')";
const IT = "check_if_install('it-IT#','32#64#','')";
const MULTI = "check_if_install('es-ES#it-IT#fr-FR#en-US#','32#64#','')";

describe("localesOfCheck", () => {
    test("single locale", () => expect(localesOfCheck(EN)).toEqual(["en-US"]));
    test("multi locale", () => expect(localesOfCheck(MULTI)).toEqual(["es-ES", "it-IT", "fr-FR", "en-US"]));
    test("empty / non-language check → null", () => {
        expect(localesOfCheck("")).toBeNull();
        expect(localesOfCheck(undefined)).toBeNull();
        expect(localesOfCheck("SomeOtherCheck()")).toBeNull();
        expect(localesOfCheck("check_if_install('','32#','')")).toBeNull();
    });
});

describe("checkAllowsLanguage", () => {
    test("single-locale file installs only for its locale", () => {
        expect(checkAllowsLanguage(EN, "en-US")).toBe(true);
        expect(checkAllowsLanguage(EN, "it-IT")).toBe(false);
        expect(checkAllowsLanguage(IT, "en-US")).toBe(false);
    });
    test("multi-locale file installs for any listed locale", () => {
        expect(checkAllowsLanguage(MULTI, "en-US")).toBe(true);
        expect(checkAllowsLanguage(MULTI, "it-IT")).toBe(true);
        expect(checkAllowsLanguage(MULTI, "de-DE")).toBe(false);
    });
    test("no language gate → always installs", () => {
        expect(checkAllowsLanguage("", "en-US")).toBe(true);
        expect(checkAllowsLanguage("OtherCheck()", "de-DE")).toBe(true);
    });
    test("collapses the 5 XIII Default.ini to one per language", () => {
        const variants = ["en-US", "fr-FR", "de-DE", "es-ES", "it-IT"]
            .map((l) => `check_if_install('${l}#','32#64#','')`);
        expect(variants.filter((c) => checkAllowsLanguage(c, "en-US"))).toHaveLength(1);
        expect(variants.filter((c) => checkAllowsLanguage(c, "it-IT"))).toHaveLength(1);
    });
});

describe("detectInstallerLanguages + defaultLanguage", () => {
    test("gathers distinct locales (sorted), prefers English", () => {
        const files = [{ check: EN }, { check: IT }, { check: MULTI }, { check: "" }];
        const langs = detectInstallerLanguages(files);
        expect(langs).toEqual(["en-US", "es-ES", "fr-FR", "it-IT"]);
        expect(defaultLanguage(langs)).toBe("en-US");
    });
    test("single-language installer → empty set, undefined default", () => {
        expect(detectInstallerLanguages([{ check: "" }, { check: "OtherCheck()" }])).toEqual([]);
        expect(defaultLanguage([])).toBeUndefined();
    });
    test("default falls back to first when no English", () => {
        expect(defaultLanguage(["de-DE", "fr-FR"])).toBe("de-DE");
        expect(defaultLanguage(["fr-FR", "en-GB"])).toBe("en-GB"); // any en-*
    });
});
