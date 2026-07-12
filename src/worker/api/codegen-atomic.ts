/**
 * Atomic Module Code Generation
 *
 * Generates auto-index files and supports atomic module organization:
 * - Scans module directories for atomic files
 * - Generates index.ts that aggregates all implementations
 * - Supports category-based file organization
 */

import { ModuleDescriptor, FunctionDescriptor } from './types';
import { generateFunctionShim, generateComMethodShim } from './codegen';
import { capitalizeApiName as capitalize } from './naming';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Atomic module file structure
 */
export interface AtomicModuleFile {
    category: string;
    functions: FunctionDescriptor[];
    fileName: string;
}

/**
 * Scan module directory and generate auto-index
 */
export function generateModuleIndexFromDirectory(moduleName: string, modulePath: string): string {
    const moduleDir = path.dirname(modulePath); // Get directory containing the module
    const atomicFiles: string[] = [];

    // Scan directory for .ts files (excluding index.ts)
    try {
        const files = fs.readdirSync(moduleDir);
        for (const file of files) {
            if (file.endsWith('.ts') && file !== 'index.ts') {
                // Assume the file exports a function called create[Category]Exports
                const category = file.replace('.ts', '');
                atomicFiles.push(category);
            }
        }
    } catch (error) {
        console.warn(`Could not scan directory ${moduleDir}:`, error);
        return `// Error: Could not scan directory ${moduleDir}\n`;
    }

    if (atomicFiles.length === 0) {
        return `// No atomic files found in ${moduleDir}\n`;
    }

    const lines: string[] = [];

    lines.push(`// Auto-generated index for ${moduleName} module`);
    lines.push(`// This file aggregates all atomic implementations`);
    lines.push(`// Generated from directory scan: ${moduleDir}`);
    lines.push("");
    lines.push(`import { IModule } from '../../core/module';`);
    lines.push(`import { Process } from '../../core/process';`);
    lines.push(`import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';`);
    lines.push("");

    // Import all atomic files
    for (const category of atomicFiles) {
        const importName = category.replace(/-/g, '_');
        lines.push(`import { create${capitalize(category)}Exports as ${importName} } from './${category}';`);
    }

    lines.push("");

    // Generate module class
    lines.push(`export class ${capitalize(moduleName)} implements IModule {`);
    lines.push(`    name = '${moduleName}';`);
    lines.push(`    exports: Record<string, ThunkImplementation> = {};`);
    lines.push("");

    lines.push(`    initialize(process: Process): void {`);

    // Aggregate exports from all atomic files
    for (const category of atomicFiles) {
        const importName = category.replace(/-/g, '_');
        lines.push(`        // ${category} functions`);
        lines.push(`        Object.assign(this.exports, ${importName}());`);
    }

    lines.push(`    }`);
    lines.push(`}`);

    return lines.join("\n");
}

/**
 * Generate auto-index for a module with atomic files
 */
export function generateModuleIndex(module: ModuleDescriptor, atomicFiles: AtomicModuleFile[]): string {
    const lines: string[] = [];

    lines.push(`// Auto-generated index for ${module.name} module`);
    lines.push(`// This file aggregates all atomic implementations`);
    lines.push("");
    lines.push(`import { IModule } from '../../core/module';`);
    lines.push(`import { Process } from '../../core/process';`);
    lines.push(`import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';`);
    lines.push("");

    // Import all atomic files
    for (const file of atomicFiles) {
        const importName = file.category.replace(/-/g, '_');
        lines.push(`import { create${capitalize(file.category)}Exports as ${importName} } from './${file.category}';`);
    }

    lines.push("");

    // Generate module class
    lines.push(`export class ${capitalize(module.name)} implements IModule {`);
    lines.push(`    name = '${module.name}';`);
    lines.push(`    exports: Record<string, ThunkImplementation> = {};`);
    lines.push("");
    lines.push(`    initialize(process: Process): void {`);

    // Aggregate exports from all atomic files
    for (const file of atomicFiles) {
        const importName = file.category.replace(/-/g, '_');
        lines.push(`        // ${file.category} functions`);
        lines.push(`        Object.assign(this.exports, ${importName}());`);
    }

    lines.push(`    }`);
    lines.push(`}`);

    return lines.join("\n");
}

/**
 * Generate atomic file for a category
 */
export function generateAtomicFile(
    moduleName: string,
    category: string,
    functions: FunctionDescriptor[]
): string {
    const lines: string[] = [];

    lines.push(`// ${category} functions for ${moduleName}`);
    lines.push(`// Atomic implementation file`);
    lines.push("");
    lines.push(`import { ThunkImplementation } from '../core/thunk-dispatcher';`);
    lines.push(`import { Process } from '../core/process';`);
    lines.push("");

    // Generate implementation stubs
    for (const func of functions) {
        lines.push(`function ${func.name}Impl(ctx: any, mem: Uint8Array, args: number[]): number | Promise<number> {`);
        lines.push(`    // TODO: Implement ${func.name}`);
        lines.push(`    console.log('${func.name} called with', args.length, 'arguments');`);
        lines.push(`    return 0;`);
        lines.push(`}`);
        lines.push("");
    }

    // Export implementations
    lines.push("export const exports: Record<string, ThunkImplementation> = {");
    for (const func of functions) {
        lines.push(`    ${func.name}: ${func.name}Impl,`);
    }
    lines.push("};");

    return lines.join("\n");
}

/**
 * Generate shims for atomic module
 */
export function generateAtomicShims(
    module: ModuleDescriptor,
    atomicFiles: AtomicModuleFile[]
): string {
    const lines: string[] = [];

    lines.push(`// Auto-generated shims for atomic ${module.name} module`);
    lines.push(`// Provides type-safe argument marshaling`);
    lines.push("");
    lines.push(`import { X86Context } from "../../core/thunking/thunk-dispatcher";`);
    lines.push(`import { System } from "../../core/system";`);
    lines.push(`import { Logger, LogCategory } from "../../core/logger";`);

    // Import all atomic implementations
    for (const file of atomicFiles) {
        const importName = file.category.replace(/-/g, '_');
        lines.push(`import { create${capitalize(file.category)}Exports as ${importName} } from "./${file.category}";`);
    }

    lines.push("");

    // Generate function shims
    for (const func of module.functions) {
        // Find which atomic file contains this function
        const atomicFile = atomicFiles.find(f => f.functions.some(f2 => f2.name === func.name));
        if (atomicFile) {
            const importName = atomicFile.category.replace(/-/g, '_');
            const shimCode = generateFunctionShim(func, `${importName}().${func.name}`);
            lines.push(shimCode);
        }
    }

    // Generate COM method shims
    if (module.interfaces) {
        for (const iface of module.interfaces) {
            for (const method of iface.methods) {
                // Find which atomic file contains this method
                const atomicFile = atomicFiles.find(f =>
                    f.functions.some(f2 => f2.name === `${iface.name}_${method.name}`)
                );
                if (atomicFile) {
                    const importName = atomicFile.category.replace(/-/g, '_');
                    const shimCode = generateComMethodShim(iface.name, method, `${importName}().${iface.name}_${method.name}`);
                    lines.push(shimCode);
                }
            }
        }
    }

    // Export shim functions
    lines.push("// Export shims for thunk registration");
    lines.push("export const shims = {");

    for (const func of module.functions) {
        lines.push(`    ${func.name}: ${func.name}Shim,`);
    }

    if (module.interfaces) {
        for (const iface of module.interfaces) {
            for (const method of iface.methods) {
                const fullName = `${iface.name}_${method.name}`;
                lines.push(`    ${fullName}: ${fullName}Shim,`);
            }
        }
    }

    lines.push("};");

    return lines.join("\n");
}

/**
 * Get atomic files for a module (static definition)
 * This function defines which atomic files exist for each module
 */
export function getAtomicFilesForModule(moduleName: string): AtomicModuleFile[] {
    // Static definition of atomic files for each module
    const moduleAtomicFiles: Record<string, AtomicModuleFile[]> = {
        'kernel32': [
            {
                category: 'file-io',
                fileName: 'file-io.ts',
                functions: [] // Will be populated by parsing or manual definition
            },
            {
                category: 'memory',
                fileName: 'memory.ts',
                functions: []
            },
            {
                category: 'environment',
                fileName: 'environment.ts',
                functions: []
            },
            {
                category: 'error',
                fileName: 'error.ts',
                functions: []
            },
            {
                category: 'exception',
                fileName: 'exception.ts',
                functions: []
            },
            {
                category: 'tls',
                fileName: 'tls.ts',
                functions: []
            }
        ],
        'user32': [
            {
                category: 'dialog',
                fileName: 'dialog.ts',
                functions: []
            },
            {
                category: 'class',
                fileName: 'class.ts',
                functions: []
            },
            {
                category: 'window',
                fileName: 'window.ts',
                functions: []
            },
            {
                category: 'message',
                fileName: 'message.ts',
                functions: []
            },
            {
                category: 'input',
                fileName: 'input.ts',
                functions: []
            },
            {
                category: 'system',
                fileName: 'system.ts',
                functions: []
            }
        ],
        'd3d9': [
            {
                category: 'factory',
                fileName: 'factory.ts',
                functions: []
            },
            {
                category: 'device',
                fileName: 'device.ts',
                functions: []
            },
            {
                category: 'resources',
                fileName: 'resources.ts',
                functions: []
            },
            {
                category: 'state',
                fileName: 'state.ts',
                functions: []
            }
        ]
    };

    return moduleAtomicFiles[moduleName] || [];
}

/**
 * Validate that all API functions have implementations in atomic files
 */
export function validateAtomicModule(module: ModuleDescriptor, atomicFiles: AtomicModuleFile[]): { valid: boolean; missing: string[] } {
    const implementedFunctions = new Set<string>();

    // Collect all implemented function names
    for (const file of atomicFiles) {
        for (const func of file.functions) {
            implementedFunctions.add(func.name);
        }
    }

    // Check all API functions are implemented
    const missing: string[] = [];
    for (const func of module.functions) {
        if (!implementedFunctions.has(func.name)) {
            missing.push(func.name);
        }
    }

    // Check COM methods if interfaces exist
    if (module.interfaces) {
        for (const iface of module.interfaces) {
            for (const method of iface.methods) {
                const fullName = `${iface.name}_${method.name}`;
                if (!implementedFunctions.has(fullName)) {
                    missing.push(fullName);
                }
            }
        }
    }

    return {
        valid: missing.length === 0,
        missing
    };
}

/**
 * Organize functions into atomic categories
 */
export function organizeFunctionsIntoCategories(
    functions: FunctionDescriptor[]
): Record<string, FunctionDescriptor[]> {
    const categories: Record<string, FunctionDescriptor[]> = {
        'file-io': [],
        'memory': [],
        'process': [],
        'time': [],
        'misc': []
    };

    for (const func of functions) {
        const name = func.name.toLowerCase();

        if (name.includes('file') || name.includes('read') || name.includes('write') || name.includes('open') || name.includes('close')) {
            categories['file-io'].push(func);
        } else if (name.includes('alloc') || name.includes('free') || name.includes('memory') || name.includes('heap')) {
            categories['memory'].push(func);
        } else if (name.includes('process') || name.includes('thread') || name.includes('exit')) {
            categories['process'].push(func);
        } else if (name.includes('time') || name.includes('tick') || name.includes('performance')) {
            categories['time'].push(func);
        } else {
            categories['misc'].push(func);
        }
    }

    return categories;
}
