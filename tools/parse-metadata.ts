#!/usr/bin/env node

/**
 * CLI tool for parsing Win32 metadata and IDL files
 * Generates API descriptors for codegen
 */

import { parseWin32Metadata } from '../src/worker/tools/win32-metadata-parser.js';
import { IDLParser } from '../src/worker/tools/idl-parser.js';
import * as fs from 'fs';
import * as path from 'path';

interface CommandLineArgs {
  command: string;
  inputPath: string;
  outputDir: string;
}

function parseArgs(args: string[]): CommandLineArgs {
  const [command, inputPath, outputDir = './generated'] = args.slice(2);

  if (!command || !inputPath) {
    console.log('Usage:');
    console.log('  tsx tools/parse-metadata.ts <command> <input> [output]');
    console.log('');
    console.log('Commands:');
    console.log('  win32 <metadata.json> [output-dir]  - Parse Win32 metadata JSON');
    console.log('  idl <idl-file> [output-dir]         - Parse IDL file');
    console.log('  test                                 - Run basic tests');
    process.exit(1);
  }

  return { command, inputPath, outputDir };
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function handleWin32Command(inputPath: string, outputDir: string): void {
  console.log(`Parsing Win32 metadata from ${inputPath}...`);
  try {
    ensureDir(outputDir);
    parseWin32Metadata(inputPath, outputDir);
    console.log(`Win32 metadata parsed successfully. Output in ${outputDir}`);
  } catch (error) {
    console.error('Error parsing Win32 metadata:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function handleIdlCommand(inputPath: string, outputDir: string): void {
  console.log(`Parsing IDL from ${inputPath}...`);
  try {
    ensureDir(outputDir);

    const parser = new IDLParser();
    const result = parser.parseFromFile(inputPath);

    // Generate output file
    const outputFile = path.join(outputDir, path.basename(inputPath, '.idl') + '.json');
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

    console.log(`IDL parsed successfully. Output: ${outputFile}`);
  } catch (error) {
    console.error('Error parsing IDL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function handleTestCommand(): void {
  console.log('Running parser tests...');

  // Test IDL parser with simple content
  const parser = new IDLParser();
  const testIdl = `
    [
        uuid(12345678-1234-1234-1234-123456789ABC),
        object
    ]
    interface ITest : IUnknown {
        HRESULT Method1([in] int param);
    }
  `;

  try {
    const result = parser.parseFromString(testIdl);
    console.log('IDL parser test passed:', result.interfaces && result.interfaces.length > 0);
  } catch (error) {
    console.error('IDL parser test failed:', error instanceof Error ? error.message : String(error));
  }

  console.log('Parser tests completed.');
}

function main(): void {
  const { command, inputPath, outputDir } = parseArgs(process.argv);

  switch (command) {
    case 'win32':
      handleWin32Command(inputPath, outputDir);
      break;

    case 'idl':
      handleIdlCommand(inputPath, outputDir);
      break;

    case 'test':
      handleTestCommand();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}