/**
 * IDL Parser for COM Interfaces
 *
 * Parses Interface Definition Language (IDL) files to generate
 * COM interface descriptors for codegen.
 *
 * Basic IDL syntax support:
 * - interface definitions
 * - method declarations
 * - type definitions
 * - attributes ([uuid], [object], etc.)
 */

import { InterfaceDescriptor, FunctionDescriptor, ParameterDescriptor } from '../api/types';
import * as fs from 'fs';

export interface ParsedIDL {
    interfaces: InterfaceDescriptor[];
    types: any[];
    library?: string;
}

export class IDLParser {
    private content: string = '';
    private pos: number = 0;
    private line: number = 1;
    private column: number = 1;

    /**
     * Parse IDL from file
     */
    parseFromFile(filePath: string): ParsedIDL {
        this.content = fs.readFileSync(filePath, 'utf-8');
        return this.parse();
    }

    /**
     * Parse IDL from string
     */
    parseFromString(idlContent: string): ParsedIDL {
        this.content = idlContent;
        return this.parse();
    }

    /**
     * Main parsing logic
     */
    private parse(): ParsedIDL {
        this.pos = 0;
        this.line = 1;
        this.column = 1;

        const result: ParsedIDL = {
            interfaces: [],
            types: []
        };

        while (!this.isAtEnd()) {
            this.skipWhitespace();

            if (this.isAtEnd()) break;

            // Look for interface definitions
            if (this.matchKeyword('interface')) {
                const iface = this.parseInterface();
                if (iface) {
                    result.interfaces.push(iface);
                }
            }
            // Look for library definitions
            else if (this.matchKeyword('library')) {
                result.library = this.parseLibrary();
            }
            // Look for typedefs, etc.
            else {
                this.advance(); // Skip unknown tokens
            }
        }

        return result;
    }

    /**
     * Parse interface definition
     */
    private parseInterface(): InterfaceDescriptor | null {
        // Skip attributes like [uuid(...)]
        this.skipAttributes();

        const name = this.parseIdentifier();
        if (!name) return undefined;

        let inherits: string | undefined;
        if (this.match(':')) {
            inherits = this.parseIdentifier() || undefined;
        }

        this.expect('{');

        const methods: FunctionDescriptor[] = [];
        let iid: string | undefined;

        while (!this.check('}') && !this.isAtEnd()) {
            this.skipWhitespace();

            // Check for attributes
            const attrs = this.parseAttributes();
            if (attrs.uuid) {
                iid = attrs.uuid;
            }

            if (this.matchKeyword('HRESULT')) {
                const method = this.parseMethod();
                if (method) {
                    methods.push(method);
                }
            } else {
                this.skipUntil(';');
            }
        }

        this.expect('}');
        this.expect(';');

        return {
            name,
            inherits,
            iid,
            methods
        };
    }

    /**
     * Parse method declaration
     */
    private parseMethod(): FunctionDescriptor | null {
        // Parse return type (already consumed 'HRESULT')
        const returnType = 'u32'; // HRESULT maps to u32

        // Parse method name
        const name = this.parseIdentifier();
        if (!name) return null;

        this.expect('(');

        const params: ParameterDescriptor[] = [];
        while (!this.check(')') && !this.isAtEnd()) {
            const param = this.parseParameter();
            if (param) {
                params.push(param);
            }

            if (!this.match(',')) break;
        }

        this.expect(')');
        this.expect(';');

        return {
            name,
            params,
            returnType,
            callingConvention: 'stdcall',
            description: `COM method ${name}`
        };
    }

    /**
     * Parse parameter
     */
    private parseParameter(): ParameterDescriptor | null {
        // Skip attributes
        this.skipAttributes();

        // Parse direction ([in], [out], etc.)
        let direction: 'in' | 'out' | 'inout' = 'in';
        if (this.matchKeyword('in')) direction = 'in';
        else if (this.matchKeyword('out')) direction = 'out';
        else if (this.matchKeyword('inout')) direction = 'inout';

        // Skip more attributes
        this.skipAttributes();

        // Parse type
        const type = this.parseType();
        if (!type) return null;

        // Parse parameter name
        const name = this.parseIdentifier();
        if (!name) return null;

        return {
            name,
            type,
            direction
        };
    }

    /**
     * Parse type
     */
    private parseType(): any {
        // Skip const
        this.matchKeyword('const');

        // Handle pointers
        if (this.match('*')) {
            return 'ptr';
        }

        // Parse base type
        const typeName = this.parseIdentifier();
        if (!typeName) return 'u32'; // fallback

        // Map common types
        const typeMap: Record<string, any> = {
            'void': 'void',
            'BOOL': 'u32',
            'BYTE': 'u8',
            'CHAR': 'i8',
            'SHORT': 'i16',
            'USHORT': 'u16',
            'WORD': 'u16',
            'INT': 'i32',
            'UINT': 'u32',
            'LONG': 'i32',
            'ULONG': 'u32',
            'DWORD': 'u32',
            'HRESULT': 'u32',
            'FLOAT': 'f32',
            'DOUBLE': 'f64',
            'LPCSTR': 'string',
            'LPCWSTR': 'wstring',
            'LPVOID': 'ptr',
            'HANDLE': 'handle'
        };

        return typeMap[typeName] || (typeName.includes('Interface') ? 'ptr' : 'u32');
    }

    /**
     * Parse library definition
     */
    private parseLibrary(): string | undefined {
        const name = this.parseIdentifier();
        if (!name) return undefined;
        this.expect('{');

        // Skip library contents for now
        let braceCount = 1;
        while (!this.isAtEnd() && braceCount > 0) {
            if (this.match('{')) braceCount++;
            else if (this.match('}')) braceCount--;
            else this.advance();
        }

        return name;
    }

    /**
     * Parse attributes like [uuid(...)]
     */
    private parseAttributes(): Record<string, string> {
        const attrs: Record<string, string> = {};

        while (this.match('[')) {
            while (!this.check(']') && !this.isAtEnd()) {
                const attrName = this.parseIdentifier();
                if (attrName && this.match('(')) {
                    const attrValue = this.parseString();
                    if (attrValue) {
                        attrs[attrName] = attrValue;
                    }
                    this.match(')');
                }
                this.match(',');
            }
            this.expect(']');
        }

        return attrs;
    }

    /**
     * Skip attributes
     */
    private skipAttributes(): void {
        while (this.match('[')) {
            while (!this.check(']') && !this.isAtEnd()) {
                this.advance();
            }
            this.expect(']');
        }
    }

    /**
     * Parse string literal
     */
    private parseString(): string | null {
        if (this.match('"')) {
            let result = '';
            while (!this.check('"') && !this.isAtEnd()) {
                result += this.current();
                this.advance();
            }
            this.expect('"');
            return result;
        }
        return null;
    }

    /**
     * Parse identifier
     */
    private parseIdentifier(): string | null {
        this.skipWhitespace();

        let result = '';
        while (!this.isAtEnd() && /\w/.test(this.current())) {
            result += this.current();
            this.advance();
        }

        return result || null;
    }

    /**
     * Utility methods
     */
    private current(): string {
        return this.content[this.pos] || '';
    }

    private advance(): string {
        const char = this.current();
        this.pos++;
        this.column++;
        if (char === '\n') {
            this.line++;
            this.column = 1;
        }
        return char;
    }

    private match(expected: string): boolean {
        if (this.check(expected)) {
            this.advance();
            return true;
        }
        return false;
    }

    private matchKeyword(keyword: string): boolean {
        this.skipWhitespace();
        if (this.content.substr(this.pos, keyword.length) === keyword &&
            !/\w/.test(this.content[this.pos + keyword.length] || '')) {
            for (let i = 0; i < keyword.length; i++) {
                this.advance();
            }
            return true;
        }
        return false;
    }

    private check(expected: string): boolean {
        return this.content.substr(this.pos, expected.length) === expected;
    }

    private expect(expected: string): void {
        if (!this.match(expected)) {
            throw new Error(`Expected '${expected}' at line ${this.line}, column ${this.column}`);
        }
    }

    private skipWhitespace(): void {
        while (!this.isAtEnd() && /\s/.test(this.current())) {
            this.advance();
        }
    }

    private skipUntil(char: string): void {
        while (!this.check(char) && !this.isAtEnd()) {
            this.advance();
        }
        if (!this.isAtEnd()) {
            this.advance();
        }
    }

    private isAtEnd(): boolean {
        return this.pos >= this.content.length;
    }
}

/**
 * CLI utility for parsing IDL files
 */
export function parseIDLFile(inputPath: string, outputPath: string): void {
    const parser = new IDLParser();

    try {
        const result = parser.parseFromFile(inputPath);

        console.log(`Parsed IDL file: ${inputPath}`);
        console.log(`- ${result.interfaces.length} interfaces`);
        console.log(`- ${result.types.length} types`);

        // Generate interface descriptors
        const content = generateInterfaceDescriptors(result);
        fs.writeFileSync(outputPath, content);

        console.log(`Generated ${outputPath}`);

    } catch (error) {
        console.error('Failed to parse IDL file:', error);
        process.exit(1);
    }
}

/**
 * Generate TypeScript interface descriptors from parsed IDL
 */
function generateInterfaceDescriptors(parsed: ParsedIDL): string {
    const lines: string[] = [];

    lines.push(`/**`);
    lines.push(` * COM Interface Descriptors`);
    lines.push(` * Auto-generated from IDL`);
    lines.push(` */`);
    lines.push(``);
    lines.push(`import { InterfaceDescriptor } from "../types";`);
    lines.push(``);

    for (const iface of parsed.interfaces) {
        lines.push(`export const ${iface.name}: InterfaceDescriptor = {`);
        lines.push(`    name: "${iface.name}",`);
        if (iface.inherits) lines.push(`    inherits: "${iface.inherits}",`);
        if (iface.iid) lines.push(`    iid: "${iface.iid}",`);
        lines.push(`    methods: [`);

        for (const method of iface.methods) {
            lines.push(`        {`);
            lines.push(`            name: "${method.name}",`);
            lines.push(`            params: [`);

            for (const param of method.params) {
                lines.push(`                {`);
                lines.push(`                    name: "${param.name}",`);
                lines.push(`                    type: "${param.type}",`);
                lines.push(`                    direction: "${param.direction}",`);
                lines.push(`                },`);
            }

            lines.push(`            ],`);
            lines.push(`            returnType: "${method.returnType}",`);
            lines.push(`            callingConvention: "${method.callingConvention}",`);
            if (method.description) lines.push(`            description: "${method.description}",`);
            lines.push(`        },`);
        }

        lines.push(`    ]`);
        lines.push(`};`);
        lines.push(``);
    }

    return lines.join('\n');
}