#!/usr/bin/env tsx

/**
 * Import Metadata Tool
 *
 * CLI tool to import Win32 API metadata from Microsoft Win32Metadata repository
 * or IDL files and generate TypeScript API descriptors.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Win32MetadataParser } from '../src/worker/tools/win32-metadata-parser';
import { IDLParser } from '../src/worker/tools/idl-parser';

function generateModuleApiFile(module: any): string {
    const lines: string[] = [];

    lines.push(`/**`);
    lines.push(` * ${module.name} API Descriptor`);
    lines.push(` * Auto-generated from metadata import`);
    lines.push(` */`);
    lines.push(``);
    lines.push(`import { ModuleDescriptor } from "../types";`);
    lines.push(``);
    lines.push(`export const ${module.name}Module: ModuleDescriptor = {`);
    lines.push(`    name: "${module.name}",`);
    if (module.version) lines.push(`    version: "${module.version}",`);
    if (module.description) lines.push(`    description: "${module.description}",`);
    lines.push(`    functions: [`);

    for (const func of module.functions || []) {
        lines.push(`        {`);
        lines.push(`            name: "${func.name}",`);
        if (func.ordinal) lines.push(`            ordinal: ${func.ordinal},`);
        lines.push(`            params: [`);

        for (const param of func.params || []) {
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

    // Add interfaces if present
    if (module.interfaces && module.interfaces.length > 0) {
        lines.push(`,`);
        lines.push(`    interfaces: [`);

        for (const iface of module.interfaces) {
            lines.push(`        {`);
            lines.push(`            name: "${iface.name}",`);
            if (iface.inherits) lines.push(`            inherits: "${iface.inherits}",`);
            if (iface.iid) lines.push(`            iid: "${iface.iid}",`);
            lines.push(`            methods: [`);

            for (const method of iface.methods || []) {
                lines.push(`                {`);
                lines.push(`                    name: "${method.name}",`);
                lines.push(`                    params: [`);

                for (const param of method.params || []) {
                    lines.push(`                        {`);
                    lines.push(`                            name: "${param.name}",`);
                    lines.push(`                            type: "${param.type}",`);
                    lines.push(`                            direction: "${param.direction}",`);
                    lines.push(`                        },`);
                }

                lines.push(`                    ],`);
                lines.push(`                    returnType: "${method.returnType}",`);
                lines.push(`                    callingConvention: "${method.callingConvention}",`);
                if (method.description) lines.push(`                    description: "${method.description}",`);
                lines.push(`                },`);
            }

            lines.push(`            ]`);
            lines.push(`        },`);
        }

        lines.push(`    ]`);
    }

    lines.push(`};`);

    return lines.join('\n');
}

function importWin32Metadata(inputPath: string, outputDir: string): void {
    console.log(`Importing Win32 metadata from ${inputPath}...`);

    const parser = new Win32MetadataParser();
    const modules = parser.parseFromFile(inputPath);
    const stats = parser.getStatistics(modules);

    console.log(`Parsed ${stats.totalModules} modules with ${stats.totalFunctions} functions`);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate API files
    for (const module of modules) {
        const outputPath = path.join(outputDir, `${module.name}.api.ts`);
        const content = generateModuleApiFile(module);
        fs.writeFileSync(outputPath, content, 'utf-8');
        console.log(`Generated ${outputPath}`);
    }

    // Write statistics
    const statsPath = path.join(outputDir, 'metadata-stats.json');
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
    console.log(`Statistics written to ${statsPath}`);
}

function importIDL(inputPath: string, outputPath: string): void {
    console.log(`Importing IDL from ${inputPath}...`);

    const parser = new IDLParser();
    const result = parser.parseFromFile(inputPath);

    console.log(`Parsed IDL with ${result.interfaces.length} interfaces`);

    // Generate interface descriptors
    const content = generateIDLDescriptors(result);
    fs.writeFileSync(outputPath, content, 'utf-8');
    console.log(`Generated ${outputPath}`);
}

function generateIDLDescriptors(parsed: any): string {
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

        for (const method of iface.methods || []) {
            lines.push(`        {`);
            lines.push(`            name: "${method.name}",`);
            lines.push(`            params: [`);

            for (const param of method.params || []) {
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

function generateStubsForModule(module: any, outputDir: string): void {
    console.log(`Generating stubs for module ${module.name}...`);

    // Group functions by category
    const categories: Record<string, any[]> = {};
    for (const func of module.functions || []) {
        const category = func.category || 'misc';
        if (!categories[category]) categories[category] = [];
        categories[category].push(func);
    }

    // Generate stub files for each category
    for (const [category, functions] of Object.entries(categories)) {
        const stubPath = path.join(outputDir, module.name, `${category}.ts`);

        // Ensure module directory exists
        const moduleDir = path.dirname(stubPath);
        if (!fs.existsSync(moduleDir)) {
            fs.mkdirSync(moduleDir, { recursive: true });
        }

        // Special handling for kernel32 (uses exports object)
        const isKernel32 = module.name === 'kernel32';
        const stubContent = generateStubFile(module.name, category, functions, isKernel32);
        fs.writeFileSync(stubPath, stubContent, 'utf-8');
        console.log(`Generated stub ${stubPath}`);
    }
}

function generateStubFile(moduleName: string, category: string, functions: any[], useExportsObject: boolean): string {
    const lines: string[] = [];

    lines.push(`// ${category} functions for ${moduleName}`);
    lines.push(`// Auto-generated stub implementation`);
    lines.push("");
    lines.push(`import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';`);

    if (useExportsObject) {
        lines.push("");
        lines.push(`export const exports: Record<string, ThunkImplementation> = (() => {`);
        lines.push(`    const exports: Record<string, ThunkImplementation> = {};`);
        lines.push("");
    } else {
        lines.push(`import { Logger, LogCategory } from '../../core/logger';`);
        lines.push("");
        lines.push(`export function create${capitalize(category)}Exports(): Record<string, ThunkImplementation> {`);
        lines.push(`    const exports: Record<string, ThunkImplementation> = {};`);
        lines.push("");
    }

    // Generate stub implementations
    for (const func of functions) {
        lines.push(`    exports['${func.name}'] = (ctx, mem, args) => {`);
        if (!useExportsObject) {
            lines.push(`        Logger.verbose(LogCategory.${moduleName.toUpperCase()}, \`${func.name} called with \${args.length} arguments\`);`);
        }
        lines.push(`        // TODO: Implement ${func.name}`);
        lines.push(`        console.log('${func.name} called with', args.length, 'arguments');`);
        lines.push(`        return 0; // Stub implementation`);
        lines.push(`    };`);
        lines.push("");
    }

    if (useExportsObject) {
        lines.push(`    return exports;`);
        lines.push(`})();`);
    } else {
        lines.push(`    return exports;`);
        lines.push(`}`);
    }

    return lines.join('\n');
}

function capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function main(): void {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.error('Usage:');
        console.error('  For Win32 metadata: tsx import-metadata.ts win32 <input.json> <output-dir> [--generate-stubs]');
        console.error('  For IDL: tsx import-metadata.ts idl <input.idl> <output.ts>');
        process.exit(1);
    }

    const [type, inputPath, outputPath, ...options] = args;
    const generateStubs = options.includes('--generate-stubs');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    try {
        if (type === 'win32') {
            importWin32Metadata(inputPath, outputPath);

            if (generateStubs) {
                const parser = new Win32MetadataParser();
                const modules = parser.parseFromFile(inputPath);
                const stubsDir = path.join(path.dirname(outputPath), '..', 'modules');

                for (const module of modules) {
                    generateStubsForModule(module, stubsDir);
                }
            }
        } else if (type === 'idl') {
            importIDL(inputPath, outputPath);
        } else {
            console.error(`Unknown type: ${type}. Use 'win32' or 'idl'`);
            process.exit(1);
        }

        console.log('Import completed successfully!');
    } catch (error) {
        console.error('Import failed:', error);
        process.exit(1);
    }
}

main();