import { describe, expect, test } from "bun:test";
import { demangleTypeInfoName } from "../../src/worker/core/tools/msvc-demangle";

describe("demangleTypeInfoName", () => {
    test("global-namespace class", () => {
        expect(demangleTypeInfoName(".?AVFoo@@")).toBe("class Foo");
    });

    test("namespace-qualified struct (segments reversed innermost-first)", () => {
        expect(demangleTypeInfoName(".?AUBar@NS2@NS1@@")).toBe("struct NS1::NS2::Bar");
    });

    test("union", () => {
        expect(demangleTypeInfoName(".?ATU@@")).toBe("union U");
    });

    test("int-based enum", () => {
        expect(demangleTypeInfoName(".?AW4Color@@")).toBe("enum Color");
    });

    test("pointer to char, no '?A' wrapper (raw builtin TypeDescriptor form)", () => {
        expect(demangleTypeInfoName(".PAD")).toBe("char *");
    });

    test("pointer to wchar_t (extended type code)", () => {
        expect(demangleTypeInfoName(".PA_W")).toBe("wchar_t *");
    });

    test("pointer to const char renders MSVC east-const style", () => {
        expect(demangleTypeInfoName(".PBD")).toBe("char const *");
    });

    test("const pointer to char (outer cv on the pointer itself)", () => {
        expect(demangleTypeInfoName(".QAD")).toBe("char * const");
    });

    test("const pointer to const char", () => {
        expect(demangleTypeInfoName(".QBD")).toBe("char const * const");
    });

    test("reference to class", () => {
        // References can't themselves be cv-qualified, so there's no "?"-wrapper here —
        // 'A' (reference) is the top-level type code directly.
        expect(demangleTypeInfoName(".AAVFoo@@")).toBe("class Foo &");
    });

    test("template instantiation with a basic-type argument", () => {
        expect(demangleTypeInfoName(".?AV?$vector@H@std@@")).toBe("class std::vector<int>");
    });

    test("nested template gets undname's '> >' spacing", () => {
        // std::vector<std::vector<int>>
        expect(demangleTypeInfoName(".?AV?$vector@V?$vector@H@std@@@std@@"))
            .toBe("class std::vector<class std::vector<int> >");
    });

    test("template with a non-type integer argument ($0)", () => {
        // e.g. a fixed-size array-like template: Array<int, 4>
        expect(demangleTypeInfoName(".?AV?$Array@H$03@@")).toBe("class Array<int,4>");
    });

    test("qualified-name digit back-reference resolves to the earlier component", () => {
        // "Widget@NS@0@" -> components [Widget, NS, <backref 0 = Widget>], reversed.
        // (a backref digit is a single token, not '@'-terminated like a literal component)
        expect(demangleTypeInfoName(".?AVWidget@NS@0@")).toBe("class Widget::NS::Widget");
    });

    test("unsupported construct (member-function pointer) falls back to raw decorated name", () => {
        const decorated = ".?AP8Foo@@AEXXZ";
        expect(demangleTypeInfoName(decorated)).toBe(decorated.slice(1));
    });

    test("never throws on garbage input", () => {
        expect(() => demangleTypeInfoName(".?AV")).not.toThrow();
        expect(() => demangleTypeInfoName("")).not.toThrow();
        expect(() => demangleTypeInfoName(".")).not.toThrow();
    });
});
