#!/usr/bin/env bun

/**
 * Metadata Import CLI Tool
 *
 * Imports Win32 API signatures from Microsoft's Win32Metadata
 * and IDL files for COM interfaces.
 *
 * Usage:
 *   bun run tools/metadata-import.ts win32 <input.json> <output-dir>
 *   bun run tools/metadata-import.ts idl <input.idl> <output.ts>
 */

import { parseWin32Metadata } from './win32-metadata-parser';
import { parseIDLFile } from './idl-parser';
import * as path from 'path';

const command = process.argv[2];
const inputPath = process.argv[3];
const outputPath = process.argv[4];

if (!command || !inputPath || !outputPath) {
    console.error('Usage:');
    console.error('  For Win32 metadata: bun run tools/metadata-import.ts win32 <input.json> <output-dir>');
    console.error('  For IDL files: bun run tools/metadata-import.ts idl <input.idl> <output.ts>');
    process.exit(1);
}

try {
    switch (command.toLowerCase()) {
        case 'win32':
            console.log(`Importing Win32 metadata from ${inputPath} to ${outputPath}`);
            parseWin32Metadata(inputPath, outputPath);
            break;

        case 'idl':
            console.log(`Importing IDL from ${inputPath} to ${outputPath}`);
            parseIDLFile(inputPath, outputPath);
            break;

        default:
            console.error(`Unknown command: ${command}`);
            console.error('Supported commands: win32, idl');
            process.exit(1);
    }

    console.log('Import completed successfully!');

} catch (error) {
    console.error('Import failed:', error);
    process.exit(1);
}