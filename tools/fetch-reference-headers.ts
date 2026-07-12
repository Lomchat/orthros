#!/usr/bin/env bun

/**
 * Fetch Reference Header Files
 * 
 * Downloads reference header files from ReactOS GitHub repository
 * and saves them to tools/reference/
 * 
 * Supports:
 * - DirectX headers (ddraw.h, d3d.h, d3d9.h, dsound.h, dinput.h, dplay.h)
 * - Windows API headers (winbase.h, winuser.h, wingdi.h, mmsystem.h, objbase.h)
 */

import * as fs from 'fs';
import * as path from 'path';

const REACTOS_BASE_URL = 'https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk';

interface HeaderFile {
    name: string;
    url: string;
    description: string;
    category: string;  // 'directx', 'mss32', 'win32', etc.
    note?: string;     // Optional note about the source
}

const HEADER_FILES: HeaderFile[] = [
    // DirectX headers
    {
        name: 'ddraw.h',
        url: `${REACTOS_BASE_URL}/ddraw.h`,
        description: 'DirectDraw header (IDirectDraw7, IDirectDrawSurface7, IDirect3DTexture, IDirect3DTexture2)',
        category: 'directx'
    },
    {
        name: 'd3d.h',
        url: `${REACTOS_BASE_URL}/d3d.h`,
        description: 'Direct3D header (IDirect3D7, IDirect3DDevice7, IDirect3D3, etc.)',
        category: 'directx'
    },
    {
        name: 'd3d9.h',
        url: `${REACTOS_BASE_URL}/d3d9.h`,
        description: 'Direct3D 9 header (IDirect3D9, IDirect3DDevice9, IDirect3DVertexBuffer9, etc.)',
        category: 'directx'
    },
    {
        name: 'dsound.h',
        url: `${REACTOS_BASE_URL}/dsound.h`,
        description: 'DirectSound header (IDirectSound8, IDirectSoundBuffer8)',
        category: 'directx'
    },
    {
        name: 'dinput.h',
        url: `${REACTOS_BASE_URL}/dinput.h`,
        description: 'DirectInput header (IDirectInputA, IDirectInputDeviceA)',
        category: 'directx'
    },
    {
        name: 'dplay.h',
        url: `${REACTOS_BASE_URL}/dplay.h`,
        description: 'DirectPlay header (IDirectPlayLobby3A)',
        category: 'directx'
    },
    // Windows API headers
    {
        name: 'winbase.h',
        url: `${REACTOS_BASE_URL}/winbase.h`,
        description: 'Windows Base API header (kernel32, advapi32 functions)',
        category: 'win32'
    },
    {
        name: 'winuser.h',
        url: `${REACTOS_BASE_URL}/winuser.h`,
        description: 'Windows User API header (user32 functions)',
        category: 'win32'
    },
    {
        name: 'wingdi.h',
        url: `${REACTOS_BASE_URL}/wingdi.h`,
        description: 'Windows GDI API header (gdi32 functions)',
        category: 'win32'
    },
    {
        name: 'mmsystem.h',
        url: `${REACTOS_BASE_URL}/mmsystem.h`,
        description: 'Windows Multimedia API header (winmm functions)',
        category: 'win32'
    },
    {
        name: 'objbase.h',
        url: `${REACTOS_BASE_URL}/objbase.h`,
        description: 'OLE Base API header (ole32 functions)',
        category: 'win32'
    }
    // NOTE: mss32 (Miles Sound System) is proprietary — no legal public header source.
    // Its reference facts (tools/reference/mss32/mss32.sig.json) are derived from our own
    // mss32.api.ts, not from any vendored mss.h, so nothing is fetched here.
];

async function fetchFile(url: string): Promise<string> {
    console.log(`Fetching ${url}...`);
    const response = await fetch(url);
    
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    
    return await response.text();
}

async function saveFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
    
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`Saved: ${filePath}`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const category = args[0] || 'directx';
    
    console.log(`Fetching ${category} header files from ReactOS...\n`);
    
    const headersToFetch = HEADER_FILES.filter(h => h.category === category);
    
    if (headersToFetch.length === 0) {
        console.error(`No headers found for category: ${category}`);
        process.exit(1);
    }
    
    const refDir = path.join(process.cwd(), 'tools/reference', category);
    
    // Ensure reference directory exists
    if (!fs.existsSync(refDir)) {
        fs.mkdirSync(refDir, { recursive: true });
        console.log(`Created directory: ${refDir}\n`);
    }
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const header of headersToFetch) {
        try {
            console.log(`[${header.name}] ${header.description}`);
            const content = await fetchFile(header.url);
            const filePath = path.join(refDir, header.name);
            await saveFile(filePath, content);
            
            // Show file stats
            const lines = content.split('\n').length;
            const size = Buffer.byteLength(content, 'utf-8');
            console.log(`  Size: ${(size / 1024).toFixed(2)} KB, Lines: ${lines}\n`);
            
            successCount++;
        } catch (error: any) {
            console.error(`\x1b[31mError fetching ${header.name}:\x1b[0m ${error.message}\n`);
            errorCount++;
        }
    }
    
    // Create README if it doesn't exist
    const readmePath = path.join(refDir, 'README.md');
    if (!fs.existsSync(readmePath)) {
        const readmeContent = `# ${category.toUpperCase()} Reference Headers

This directory contains reference ${category} header files downloaded from ReactOS.

## Source

Headers are fetched from the ReactOS GitHub repository:
- Base URL: \`${REACTOS_BASE_URL}\`
- Repository: https://github.com/reactos/reactos
- Path: \`sdk/include/psdk/\`

## Files

${headersToFetch.map(h => `- **${h.name}**: ${h.description}`).join('\n')}

## Updating

To update these headers, run:

\`\`\`bash
bun run fetch-reference-headers ${category}
\`\`\`

Or manually download from:
${headersToFetch.map(h => `- ${h.name}: ${h.url}`).join('\n')}

## Usage

These headers are used as reference for validating API signatures in \`src/worker/api/\`.
The validator compares interface/function signatures against these reference files to ensure
binary compatibility with Windows implementations.
`;
        fs.writeFileSync(readmePath, readmeContent, 'utf-8');
        console.log(`Created README.md\n`);
    }
    
    // Summary
    console.log('─'.repeat(50));
    if (errorCount === 0) {
        console.log(`\x1b[32m✓ Successfully fetched ${successCount} header file(s)\x1b[0m`);
    } else {
        console.log(`\x1b[33m⚠ Fetched ${successCount} file(s), ${errorCount} error(s)\x1b[0m`);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('\x1b[31mFatal error:\x1b[0m', error);
    process.exit(1);
});
