/**
 * Win32 Metadata Parser
 *
 * Parses Win32 API metadata from Microsoft's Win32Metadata repository
 * to automatically generate API descriptors for codegen.
 *
 * Supports JSON format from: https://github.com/microsoft/win32metadata
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from '../api/types';
import * as fs from 'fs';
import * as path from 'path';

export interface Win32Metadata {
    version: string;
    modules: Win32Module[];
}

export interface Win32Module {
    name: string;
    functions: Win32Function[];
    types: Win32Type[];
}

export interface Win32Function {
    name: string;
    dllName: string;
    returnType: Win32TypeRef;
    params: Win32Parameter[];
    callingConvention: 'stdcall' | 'cdecl';
    ordinal?: number;
}

export interface Win32Parameter {
    name: string;
    type: Win32TypeRef;
    direction: 'in' | 'out' | 'inout';
    optional?: boolean;
}

export interface Win32TypeRef {
    kind: 'primitive' | 'pointer' | 'struct' | 'handle' | 'string';
    name: string;
    size?: number;
}

export interface Win32Type {
    name: string;
    kind: 'struct' | 'enum' | 'union';
    size: number;
    fields?: Win32StructField[];
}

export interface Win32StructField {
    name: string;
    type: Win32TypeRef;
    offset: number;
}

export class Win32MetadataParser {
    private types: Map<string, Win32Type> = new Map();

    /**
     * Parse Win32 metadata from JSON file
     */
    parseFromFile(filePath: string): ModuleDescriptor[] {
        const content = fs.readFileSync(filePath, 'utf-8');
        const metadata: Win32Metadata = JSON.parse(content);
        return this.parseMetadata(metadata);
    }

    /**
     * Parse Win32 metadata from JSON string
     */
    parseFromString(jsonContent: string): ModuleDescriptor[] {
        const metadata: Win32Metadata = JSON.parse(jsonContent);
        return this.parseMetadata(metadata);
    }

    /**
     * Parse metadata object
     */
    private parseMetadata(metadata: Win32Metadata): ModuleDescriptor[] {
        const modules: ModuleDescriptor[] = [];

        // Build type registry
        for (const module of metadata.modules) {
            for (const type of module.types) {
                this.types.set(type.name, type);
            }
        }

        // Parse modules
        for (const module of metadata.modules) {
            const moduleDesc = this.parseModule(module);
            modules.push(moduleDesc);
        }

        return modules;
    }

    /**
     * Parse a single module
     */
    private parseModule(module: Win32Module): ModuleDescriptor {
        const functions = module.functions.map(f => this.parseFunction(f));

        return {
            name: module.name.toLowerCase(),
            version: '1.0',
            description: `Win32 ${module.name} API`,
            functions
        };
    }

    /**
     * Parse a function
     */
    private parseFunction(func: Win32Function): FunctionDescriptor {
        const params = func.params.map(p => this.parseParameter(p));

        return {
            name: func.name,
            ordinal: func.ordinal,
            params,
            returnType: this.mapWin32TypeToParameterType(func.returnType),
            callingConvention: func.callingConvention,
            category: this.inferCategory(func.name),
            description: `${func.name} from ${func.dllName}`
        };
    }

    /**
     * Parse a parameter
     */
    private parseParameter(param: Win32Parameter): ParameterDescriptor {
        return {
            name: param.name,
            type: this.mapWin32TypeToParameterType(param.type),
            direction: param.direction,
            optional: param.optional,
            structName: param.type.kind === 'struct' ? param.type.name : undefined,
            structSize: param.type.size
        };
    }

    /**
     * Map Win32 type reference to our parameter type
     */
    private mapWin32TypeToParameterType(typeRef: Win32TypeRef): any {
        switch (typeRef.kind) {
            case 'primitive':
                return this.mapPrimitiveType(typeRef.name);
            case 'pointer':
                return 'ptr';
            case 'handle':
                return 'handle';
            case 'string':
                return typeRef.name && typeRef.name.includes('W') ? 'wstring' : 'string';
            case 'struct':
                return 'struct';
            default:
                return 'u32'; // fallback
        }
    }

    /**
     * Map primitive Win32 types to our types
     */
    private mapPrimitiveType(win32Type: string): any {
        const typeMap: Record<string, any> = {
            'VOID': 'void',
            'BOOL': 'u32',
            'BOOLEAN': 'u8',
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
            'HANDLE': 'handle',
            'HRESULT': 'u32',
            'FLOAT': 'f32',
            'DOUBLE': 'f64',
            'INT8': 'i8',
            'UINT8': 'u8',
            'INT16': 'i16',
            'UINT16': 'u16',
            'INT32': 'i32',
            'UINT32': 'u32',
            'INT64': 'i64',
            'UINT64': 'u64',
            'LONG_PTR': 'ptr',
            'ULONG_PTR': 'ptr',
            'DWORD_PTR': 'ptr',
            'SIZE_T': 'ptr',
            'SSIZE_T': 'ptr'
        };

        return typeMap[win32Type.toUpperCase()] || 'u32';
    }

    /**
     * Infer function category from name
     */
    private inferCategory(functionName: string): string | undefined {
        const name = functionName.toLowerCase();

        if (name.includes('create') || name.includes('open') || name.includes('close') ||
            name.includes('read') || name.includes('write') || name.includes('file')) {
            return 'file-io';
        }

        if (name.includes('alloc') || name.includes('free') || name.includes('memory') ||
            name.includes('heap') || name.includes('virtual')) {
            return 'memory';
        }

        if (name.includes('process') || name.includes('thread') || name.includes('exit')) {
            return 'process';
        }

        if (name.includes('time') || name.includes('tick') || name.includes('performance')) {
            return 'time';
        }

        if (name.includes('window') || name.includes('message') || name.includes('input')) {
            return 'windowing';
        }

        return undefined;
    }

    /**
     * Filter functions by DLL name
     */
    filterByDll(modules: ModuleDescriptor[], dllName: string): ModuleDescriptor[] {
        return modules.map(module => ({
            ...module,
            functions: module.functions.filter(f =>
                f.description?.toLowerCase().includes(dllName.toLowerCase())
            )
        })).filter(module => module.functions.length > 0);
    }

    /**
     * Get statistics about parsed metadata
     */
    getStatistics(modules: ModuleDescriptor[]): Record<string, any> {
        const stats = {
            totalModules: modules.length,
            totalFunctions: modules.reduce((sum, m) => sum + m.functions.length, 0),
            functionsByCategory: {} as Record<string, number>,
            functionsByDll: {} as Record<string, number>
        };

        for (const module of modules) {
            for (const func of module.functions) {
                // Count by category
                const category = func.category || 'uncategorized';
                stats.functionsByCategory[category] = (stats.functionsByCategory[category] || 0) + 1;

                // Extract DLL from description
                const dllMatch = func.description?.match(/from (\w+\.dll)/i);
                if (dllMatch) {
                    const dll = dllMatch[1].toLowerCase();
                    stats.functionsByDll[dll] = (stats.functionsByDll[dll] || 0) + 1;
                }
            }
        }

        return stats;
    }
}

/**
 * CLI utility for parsing Win32 metadata
 */
export function parseWin32Metadata(inputPath: string, outputDir: string): void {
    const parser = new Win32MetadataParser();

    try {
        const modules = parser.parseFromFile(inputPath);
        const stats = parser.getStatistics(modules);

        console.log('Parsed Win32 metadata:');
        console.log(`- ${stats.totalModules} modules`);
        console.log(`- ${stats.totalFunctions} functions`);

        // Write each module to separate file
        for (const module of modules) {
            const outputPath = path.join(outputDir, `${module.name}.api.ts`);
            const content = generateModuleApiFile(module);
            fs.writeFileSync(outputPath, content);
            console.log(`Generated ${outputPath}`);
        }

        // Write statistics
        const statsPath = path.join(outputDir, 'metadata-stats.json');
        fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));

    } catch (error) {
        console.error('Failed to parse Win32 metadata:', error);
        process.exit(1);
    }
}

/**
 * Generate API descriptor file content
 */
function generateModuleApiFile(module: ModuleDescriptor): string {
    const lines: string[] = [];

    lines.push(`/**`);
    lines.push(` * ${module.name} API Descriptor`);
    lines.push(` * Auto-generated from Win32 Metadata`);
    lines.push(` */`);
    lines.push(``);
    lines.push(`import { ModuleDescriptor } from "../types";`);
    lines.push(``);
    lines.push(`export const ${module.name}Module: ModuleDescriptor = {`);
    lines.push(`    name: "${module.name}",`);
    if (module.version) lines.push(`    version: "${module.version}",`);
    if (module.description) lines.push(`    description: "${module.description}",`);
    lines.push(`    functions: [`);

    for (const func of module.functions) {
        lines.push(`        {`);
        lines.push(`            name: "${func.name}",`);
        if (func.ordinal) lines.push(`            ordinal: ${func.ordinal},`);
        lines.push(`            params: [`);

        for (const param of func.params) {
            lines.push(`                {`);
            lines.push(`                    name: "${param.name}",`);
            lines.push(`                    type: "${param.type}",`);
            if (param.direction !== 'in') lines.push(`                    direction: "${param.direction}",`);
            if (param.optional) lines.push(`                    optional: true,`);
            if (param.structName) lines.push(`                    structName: "${param.structName}",`);
            if (param.structSize) lines.push(`                    structSize: ${param.structSize},`);
            lines.push(`                },`);
        }

        lines.push(`            ],`);
        lines.push(`            returnType: "${func.returnType}",`);
        lines.push(`            callingConvention: "${func.callingConvention}",`);
        if (func.category) lines.push(`            category: "${func.category}",`);
        if (func.description) lines.push(`            description: "${func.description}",`);
        lines.push(`        },`);
    }

    lines.push(`    ]`);
    lines.push(`};`);

    return lines.join('\n');
}