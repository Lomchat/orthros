/**
 * MSVC C++ name-mangling decoder, scoped to the "data type" grammar used by
 * TypeDescriptor / type_info decorated names (what `type_info::name()` returns).
 *
 * NOT a full symbol demangler — no calling conventions, overloaded-operator names,
 * or throw specs, since those never appear in a TypeDescriptor's name field.
 *
 * Supports: basic + extended (__intN/bool/wchar_t) types, pointers/references with
 * pointee AND outer cv-qualifiers (in MSVC's east-const rendering, e.g. "char
 * const *"), class/struct/union/enum with namespace-qualified names, template
 * instantiations (recursive — including integer non-type args and cv-qualified
 * args), and the compiler's name back-reference compression (digits 0-9), scoped
 * per template argument list the same way the encoder emits it.
 *
 * Deliberately unsupported (parseType returns null, caller falls back to the raw
 * decorated string): function/member-function pointers (P6/P8), pointer-to-member
 * data (Q-T pointee qualifiers), multidimensional arrays, C++/CLI managed handles,
 * rvalue references, MS extended qualifiers (__ptr64/__unaligned/__restrict — moot
 * for a 32-bit target anyway). These essentially only show up inside exotic
 * template arguments, not in a class's own RTTI name, so the fallback is rare.
 */

class MsvcTypeParser {
    private readonly s: string;
    private pos = 0;
    // Qualified-name component back-reference table + its current scope base —
    // reset (and restored) per template, since each template's args get their own
    // fresh backref numbering independent of the enclosing qualified name.
    private names: string[] = [];
    private namesStart = 0;

    constructor(s: string) {
        this.s = s;
    }

    atEnd(): boolean {
        return this.pos >= this.s.length;
    }

    private cur(): string {
        return this.s[this.pos] ?? '';
    }

    private isNameChar(c: string): boolean {
        return /[A-Za-z0-9_$]/.test(c);
    }

    private getNumber(): string | null {
        let sgn = false;
        if (this.cur() === '?') { sgn = true; this.pos++; }
        const c = this.cur();
        if (c >= '0' && c <= '8') {
            this.pos++;
            return (sgn ? '-' : '') + String(c.charCodeAt(0) - 48 + 1);
        }
        if (c === '9') {
            this.pos++;
            return (sgn ? '-' : '') + '10';
        }
        if (c >= 'A' && c <= 'P') {
            let ret = 0;
            while (this.cur() >= 'A' && this.cur() <= 'P') {
                ret = ret * 16 + (this.s.charCodeAt(this.pos) - 65);
                this.pos++;
            }
            if (this.cur() !== '@') return null;
            this.pos++;
            return (sgn ? '-' : '') + String(ret);
        }
        return null;
    }

    // Reads an identifier up to (and consuming) the next '@'; registers it in the
    // current back-reference scope so a later digit token can reuse it.
    private getLiteralString(): string | null {
        const start = this.pos;
        while (!this.atEnd() && this.cur() !== '@') {
            if (!this.isNameChar(this.cur())) return null;
            this.pos++;
        }
        if (this.atEnd()) return null;
        const name = this.s.slice(start, this.pos);
        this.pos++; // consume '@'
        this.names.push(name);
        return name;
    }

    // '?$' was already consumed by the caller. TemplateName '@' ArgList '@' -> "Name<args>".
    // The template's own name/argument parsing gets a FRESH back-reference scope,
    // saved and restored around the call so outer-scope digit tokens are unaffected.
    private getTemplateName(): string | null {
        const savedNames = this.names;
        const savedStart = this.namesStart;
        this.names = [];
        this.namesStart = 0;

        const base = this.getLiteralString();
        if (base === null) {
            this.names = savedNames;
            this.namesStart = savedStart;
            return null;
        }
        const args = this.getArgList('<', '>');
        this.names = savedNames;
        this.namesStart = savedStart;
        if (args === null) return null;
        return `${base}${args}`;
    }

    // Comma-joined type/value list until a bare '@' (consumed). Inserts a space before
    // a closing '>' that immediately follows another '>', so a nested template's close
    // never reads as the C++98 "shift" token `>>` — matches real demangler output.
    private getArgList(open: string, close: string): string | null {
        const parts: string[] = [];
        while (!this.atEnd() && this.cur() !== '@') {
            if (this.s.startsWith('$$V', this.pos) || this.s.startsWith('$$Z', this.pos)) {
                this.pos += 3; // empty parameter pack — contributes no argument
                continue;
            }
            const t = this.parseTemplateArg();
            if (t === null) return null;
            parts.push(t);
        }
        if (this.atEnd()) return null;
        this.pos++; // consume '@'
        if (parts.length === 0) return `${open}${close}`;
        const joined = parts.join(',');
        const needsSpace = close === '>' && joined.endsWith('>');
        return `${open}${joined}${needsSpace ? ' ' : ''}${close}`;
    }

    // A template argument is a full type, or a '$'-prefixed non-type/special form.
    private parseTemplateArg(): string | null {
        if (this.cur() === '$') return this.parseDollarForm();
        return this.parseType();
    }

    private parseDollarForm(): string | null {
        this.pos++; // consume '$'
        const c = this.cur();
        if (c === '0') {
            this.pos++;
            return this.getNumber();
        }
        if (c === '$') {
            this.pos++;
            const c2 = this.cur();
            if (c2 === 'T') { this.pos++; return 'std::nullptr_t'; }
            if (c2 === 'C') {
                this.pos++;
                const cv = this.readCvWord();
                if (cv === null) return null;
                const inner = this.parseType();
                if (inner === null) return null;
                return cv ? `${cv} ${inner}` : inner;
            }
            return null; // $$B (array), $$A/$$Q (refs), ... — unsupported
        }
        return null; // $D/$F/$G/$Q (template-parameter placeholders) — unsupported
    }

    // A-D pointee/value cv-qualifier code -> bare word. Null for Q-T (pointer-to-member)
    // or anything else — those are unsupported here and bubble up to a raw fallback.
    private readCvWord(): string | null {
        const c = this.cur();
        if (!'ABCD'.includes(c)) return null;
        this.pos++;
        switch (c) {
            case 'B': return 'const';
            case 'C': return 'volatile';
            case 'D': return 'const volatile';
            default: return '';
        }
    }

    // Qualified name: Component@Component@...@@ — components appear innermost-first
    // in the mangled form, so the parsed parts are reversed before joining with '::'.
    private getClass(): string | null {
        const parts: string[] = [];
        while (!this.atEnd() && this.cur() !== '@') {
            let name: string | null;
            if (this.cur() >= '0' && this.cur() <= '9') {
                const idx = this.s.charCodeAt(this.pos) - 48;
                this.pos++;
                name = this.names[this.namesStart + idx] ?? null;
            } else if (this.cur() === '?' && this.s[this.pos + 1] === '$') {
                this.pos += 2;
                name = this.getTemplateName();
                if (name !== null) this.names.push(name);
            } else if (this.cur() === '?' && this.s[this.pos + 1] === 'A') {
                this.pos += 2;
                while (!this.atEnd() && this.cur() !== '@') this.pos++;
                if (this.atEnd()) return null;
                this.pos++;
                name = "`anonymous namespace'";
            } else {
                name = this.getLiteralString();
            }
            if (name === null) return null;
            parts.push(name);
        }
        if (this.atEnd()) return null;
        this.pos++; // consume the qualified name's terminating '@'
        return parts.reverse().join('::');
    }

    // P/Q/R/S (pointer) or A/B (reference), each with the outer symbol's own cv-code
    // baked into the qualifier letter itself, followed by the pointee's cv-code (A-D)
    // and then the pointee type. Assembly is "pointee cvword *outerCv" — MSVC's
    // east-const rendering, e.g. "PBD" (pointer to const char) -> "char const *".
    private parsePointerOrRef(qualif: string): string | null {
        let ref: string;
        let outerCv: string;
        switch (qualif) {
            case 'A': ref = '&'; outerCv = ''; break;
            case 'B': ref = '&'; outerCv = ' volatile'; break;
            case 'P': ref = '*'; outerCv = ''; break;
            case 'Q': ref = '*'; outerCv = ' const'; break;
            case 'R': ref = '*'; outerCv = ' volatile'; break;
            case 'S': ref = '*'; outerCv = ' const volatile'; break;
            default: return null;
        }
        const pointeeCv = this.readCvWord();
        if (pointeeCv === null) return null; // P6/P8 (function ptr) or Q-T (member ptr)
        const inner = this.parseType();
        if (inner === null) return null;
        return `${inner}${pointeeCv ? ' ' + pointeeCv : ''} ${ref}${outerCv}`;
    }

    parseType(): string | null {
        if (this.atEnd()) return null;
        const c = this.s[this.pos++];
        switch (c) {
            case 'C': return 'signed char';
            case 'D': return 'char';
            case 'E': return 'unsigned char';
            case 'F': return 'short';
            case 'G': return 'unsigned short';
            case 'H': return 'int';
            case 'I': return 'unsigned int';
            case 'J': return 'long';
            case 'K': return 'unsigned long';
            case 'M': return 'float';
            case 'N': return 'double';
            case 'O': return 'long double';
            case 'X': return 'void';
            case '_': {
                const c2 = this.s[this.pos++] ?? '';
                switch (c2) {
                    case 'D': return '__int8';
                    case 'E': return 'unsigned __int8';
                    case 'F': return '__int16';
                    case 'G': return 'unsigned __int16';
                    case 'H': return '__int32';
                    case 'I': return 'unsigned __int32';
                    case 'J': return '__int64';
                    case 'K': return 'unsigned __int64';
                    case 'N': return 'bool';
                    case 'W': return 'wchar_t';
                    default: return null;
                }
            }
            case 'T': case 'U': case 'V': {
                const name = this.getClass();
                if (name === null) return null;
                const prefix = c === 'T' ? 'union' : c === 'U' ? 'struct' : 'class';
                return `${prefix} ${name}`;
            }
            case 'W': {
                if (this.cur() !== '4') return null;
                this.pos++;
                const name = this.getClass();
                if (name === null) return null;
                return `enum ${name}`;
            }
            case 'A': case 'B': case 'P': case 'Q': case 'R': case 'S':
                return this.parsePointerOrRef(c);
            default:
                if (c >= '0' && c <= '9') {
                    const idx = c.charCodeAt(0) - 48;
                    return this.names[this.namesStart + idx] ?? null;
                }
                return null;
        }
    }
}

/**
 * Demangles a TypeDescriptor decorated name (what's stored at TypeDescriptor+8,
 * e.g. ".?AVFoo@@" or ".PAD") into what `type_info::name()` would actually return
 * ("class Foo" / "char *"). Falls back to the raw decorated name (minus its
 * leading '.') on any unsupported construct or parse failure — never throws,
 * never produces a truncated/garbage string.
 */
export function demangleTypeInfoName(decorated: string): string {
    if (!decorated.startsWith('.')) return decorated;
    let rest = decorated.slice(1);
    let topCv = '';

    // '?' + cv-code is the "qualified value type" wrapper MSVC uses to give a
    // top-level cv-qualifier to a non-pointer/reference type (this is where a
    // class/struct/union/enum's "?A" comes from — 'A' = no qualifier).
    if (rest[0] === '?' && rest[1] && 'ABCD'.includes(rest[1])) {
        switch (rest[1]) {
            case 'B': topCv = 'const '; break;
            case 'C': topCv = 'volatile '; break;
            case 'D': topCv = 'const volatile '; break;
        }
        rest = rest.slice(2);
    }

    const parser = new MsvcTypeParser(rest);
    const result = parser.parseType();
    if (result === null || !parser.atEnd()) return decorated.slice(1);
    return topCv + result;
}
