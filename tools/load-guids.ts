#!/usr/bin/env bun

/**
 * Load GUIDs for Manual Verification
 * 
 * Loads IID GUIDs from constants.ts and from reference headers,
 * then outputs them in a table format for manual comparison.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

// Import the parser from parse-reference-headers.ts
// We'll extract the IID parsing logic here

interface GuidSource {
    name: string;
    guid: string;
    source: 'constants' | 'headers';
}

class ReferenceHeaderParser {
    private content: string;
    private iids: Map<string, string> = new Map();

    constructor(content: string) {
        this.content = content;
        this.extractIIDs();
    }

    /**
     * Extract IID definitions from DEFINE_GUID macros
     */
    private extractIIDs(): void {
        // DEFINE_GUID(IID_IDirect3D7, 0xf5049e77,0x4861,0x11d2,0xa4,0x07,0x00,0xa0,0xc9,0x06,0x29,0xa8);
        const guidRegex = /DEFINE_GUID\(IID_(\w+),\s*0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+),0x([0-9a-fA-F]+)\);/g;
        
        let match;
        while ((match = guidRegex.exec(this.content)) !== null) {
            const interfaceName = match[1];
            // Format as canonical GUID with zero-padding: 8-4-4-4-12
            const p1 = match[2].toLowerCase().padStart(8, '0');
            const p2 = match[3].toLowerCase().padStart(4, '0');
            const p3 = match[4].toLowerCase().padStart(4, '0');
            const p4 = (match[5].toLowerCase().padStart(2, '0') + match[6].toLowerCase().padStart(2, '0'));
            const p5 = [
                match[7], match[8], match[9], match[10], match[11], match[12],
            ].map(v => v.toLowerCase().padStart(2, '0')).join('');
            const guid = `${p1}-${p2}-${p3}-${p4}-${p5}`;
            this.iids.set(interfaceName, guid);
        }
    }

    /**
     * Get extracted IID GUIDs
     */
    getIIDs(): Map<string, string> {
        return new Map(this.iids); // Return a copy
    }
}

/**
 * Load IID GUIDs from constants.ts
 */
function loadGuidsFromConstants(): Map<string, string> {
    const constantsPath = path.join(process.cwd(), 'src/worker/modules/ddraw/constants.ts');
    const content = fs.readFileSync(constantsPath, 'utf-8');
    const sourceFile = ts.createSourceFile(
        constantsPath,
        content,
        ts.ScriptTarget.Latest,
        true
    );
    
    const guids = new Map<string, string>();
    
    const visit = (node: ts.Node) => {
        // Look for: export const IID_IDirectDraw = "9c595050-1997-11cf-9923-0020afd79762";
        if (ts.isVariableStatement(node)) {
            const declarations = node.declarationList.declarations;
            if (declarations.length > 0) {
                const decl = declarations[0];
                if (decl.name && ts.isIdentifier(decl.name)) {
                    const varName = decl.name.text;
                    
                    // Check if it's an IID_ constant
                    if (varName.startsWith('IID_')) {
                        if (decl.initializer && ts.isStringLiteral(decl.initializer)) {
                            const guid = decl.initializer.text;
                            // Remove 'IID_' prefix to get interface name
                            const interfaceName = varName.substring(4);
                            guids.set(interfaceName, guid);
                        }
                    }
                }
            }
        }
        
        ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);
    return guids;
}

/**
 * Load IID GUIDs from reference headers
 */
function loadGuidsFromHeaders(): Map<string, string> {
    const refDir = path.join(process.cwd(), 'tools/reference/directx');
    const headers = ['ddraw.h', 'd3d.h', 'd3d9.h', 'dsound.h', 'dinput.h', 'dplay.h'];
    
    const allGuids = new Map<string, string>();
    
    for (const header of headers) {
        const headerPath = path.join(refDir, header);
        if (!fs.existsSync(headerPath)) {
            console.log(`  Warning: ${header} not found, skipping...`);
            continue;
        }
        
        const content = fs.readFileSync(headerPath, 'utf-8');
        const parser = new ReferenceHeaderParser(content);
        const iids = parser.getIIDs();
        
        for (const [name, guid] of iids) {
            allGuids.set(name, guid);
        }
    }
    
    return allGuids;
}

/**
 * Format output table
 */
function formatTable(constantsGuids: Map<string, string>, headersGuids: Map<string, string>): void {
    console.log('\n' + '='.repeat(100));
    console.log('GUID Comparison Table');
    console.log('='.repeat(100));
    console.log('');
    
    // Get all interface names (union of both sets)
    const allInterfaces = new Set<string>();
    for (const name of constantsGuids.keys()) allInterfaces.add(name);
    for (const name of headersGuids.keys()) allInterfaces.add(name);
    
    // Sort alphabetically
    const sortedInterfaces = Array.from(allInterfaces).sort();
    
    // Print header
    console.log('Interface Name'.padEnd(35) + ' | constants.ts'.padEnd(40) + ' | headers');
    console.log('-'.repeat(35) + '-+-' + '-'.repeat(40) + '-+-' + '-'.repeat(40));
    
    // Print rows
    for (const interfaceName of sortedInterfaces) {
        const constantsGuid = constantsGuids.get(interfaceName) || '(not found)';
        const headersGuid = headersGuids.get(interfaceName) || '(not found)';
        
        const nameCol = interfaceName.padEnd(35);
        const constantsCol = constantsGuid.padEnd(40);
        const headersCol = headersGuid.padEnd(40);
        
        // Highlight differences
        const match = constantsGuid === headersGuid;
        const prefix = match ? '  ' : '\x1b[33m⚠\x1b[0m '; // Yellow warning for mismatches
        
        console.log(prefix + nameCol + ' | ' + constantsCol + ' | ' + headersCol);
    }
    
    console.log('');
    console.log('='.repeat(100));
    
    // Statistics
    const inConstants = new Set(constantsGuids.keys());
    const inHeaders = new Set(headersGuids.keys());
    
    const matches = sortedInterfaces.filter(name => 
        constantsGuids.get(name) === headersGuids.get(name) && 
        constantsGuids.has(name) && headersGuids.has(name)
    ).length;
    
    const mismatches = sortedInterfaces.filter(name => {
        const c = constantsGuids.get(name);
        const h = headersGuids.get(name);
        return c && h && c !== h;
    }).length;
    
    const onlyInConstants = sortedInterfaces.filter(name => 
        constantsGuids.has(name) && !headersGuids.has(name)
    );
    
    const onlyInHeaders = sortedInterfaces.filter(name => 
        headersGuids.has(name) && !constantsGuids.has(name)
    );
    
    console.log('\nStatistics:');
    console.log(`  Total interfaces: ${sortedInterfaces.length}`);
    console.log(`  ✅ Matches: ${matches}`);
    console.log(`  ❌ Mismatches: ${mismatches}`);
    if (onlyInConstants.length > 0) {
        console.log(`  ⚠️  Only in constants.ts: ${onlyInConstants.length}`);
        onlyInConstants.forEach(name => console.log(`     - ${name}`));
    }
    if (onlyInHeaders.length > 0) {
        console.log(`  ⚠️  Only in headers: ${onlyInHeaders.length}`);
        onlyInHeaders.forEach(name => console.log(`     - ${name}`));
    }
    console.log('');
}

async function main(): Promise<void> {
    console.log('Loading GUIDs from constants.ts...');
    const constantsGuids = loadGuidsFromConstants();
    console.log(`  Found ${constantsGuids.size} IID constants\n`);
    
    console.log('Loading GUIDs from reference headers...');
    const headersGuids = loadGuidsFromHeaders();
    console.log(`  Found ${headersGuids.size} IID definitions\n`);
    
    formatTable(constantsGuids, headersGuids);
}

main().catch(error => {
    console.error('\x1b[31mFatal error:\x1b[0m', error);
    process.exit(1);
});
