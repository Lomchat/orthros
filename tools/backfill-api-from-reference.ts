#!/usr/bin/env bun

/**
 * Backfill missing API entries from reference .sig.json files.
 *
 * Reads all tools/reference/win32/<mod>/<mod>.sig.json files,
 * compares against src/worker/api/<mod>.api.ts,
 * and appends missing makeFunc() entries before the closing `]`.
 *
 * Usage: bun tools/backfill-api-from-reference.ts [--dry-run] [--module <name>]
 */

import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const moduleFilter = args.includes('--module') ? args[args.indexOf('--module') + 1] : null;

const refDir = path.join(process.cwd(), 'tools/reference/win32');
const apiDir = path.join(process.cwd(), 'src/worker/api');

let totalAdded = 0;

for (const modDir of fs.readdirSync(refDir)) {
    if (moduleFilter && modDir !== moduleFilter) continue;

    const sigPath = path.join(refDir, modDir, `${modDir}.sig.json`);
    if (!fs.existsSync(sigPath)) continue;

    const apiPath = path.join(apiDir, `${modDir}.api.ts`);
    if (!fs.existsSync(apiPath)) {
        console.log(`⚠ ${modDir}: no api file, skipping`);
        continue;
    }

    const sigData = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
    const refFuncs = new Map<string, number>();
    for (const fn of sigData.functions) {
        // Strip decoration: _FuncName@12 -> FuncName
        const name = fn.name.replace(/^_/, '').replace(/@\d+$/, '');
        refFuncs.set(name, fn.argCount);
    }

    let apiText = fs.readFileSync(apiPath, 'utf8');

    // Extract existing function names
    const existingNames = new Set<string>();
    const makeFuncRe = /makeFunc\("([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = makeFuncRe.exec(apiText)) !== null) {
        existingNames.add(m[1]);
    }

    // Find missing
    const missing: Array<[string, number]> = [];
    for (const [name, argCount] of refFuncs) {
        if (!existingNames.has(name)) {
            missing.push([name, argCount]);
        }
    }

    if (missing.length === 0) {
        console.log(`✓ ${modDir}: all ${refFuncs.size} ref functions present`);
        continue;
    }

    // Sort alphabetically for clean output
    missing.sort((a, b) => a[0].localeCompare(b[0]));

    // Generate makeFunc lines
    const lines = missing.map(([name, argCount]) =>
        `        makeFunc("${name}", ${argCount}),`
    );
    const block = `\n        // Auto-generated from reference signatures\n${lines.join('\n')}\n`;

    // Insert before the closing `    ]`
    const closingIdx = apiText.lastIndexOf('    ]');
    if (closingIdx === -1) {
        console.error(`✗ ${modDir}: could not find closing ] in api file`);
        continue;
    }

    apiText = apiText.slice(0, closingIdx) + block + apiText.slice(closingIdx);

    if (dryRun) {
        console.log(`[dry-run] ${modDir}: would add ${missing.length} functions`);
        for (const [name, argCount] of missing) {
            console.log(`  + ${name}(${argCount})`);
        }
    } else {
        fs.writeFileSync(apiPath, apiText, 'utf8');
        console.log(`✓ ${modDir}: added ${missing.length} functions`);
    }

    totalAdded += missing.length;
}

console.log(`\nTotal: ${totalAdded} functions ${dryRun ? 'would be ' : ''}added`);
