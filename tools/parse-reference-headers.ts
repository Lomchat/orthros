#!/usr/bin/env bun

/**
 * Parse Reference Header Files
 * 
 * Extracts interface signatures from COM headers (ddraw.h, d3d.h, etc.)
 * and function signatures from regular headers (mss32, win32, etc.)
 * Generates JSON files with reference signatures for validation.
 */

import * as fs from 'fs';
import * as path from 'path';

interface MethodSignature {
    name: string;
    cParams: number;  // Number of parameters in C++ (excluding this)
    vtableIndex: number;  // Position in vtable (after IUnknown)
    signature: string;  // Full C++ signature
}

interface InterfaceSignature {
    interface: string;
    iid?: string;
    methods: MethodSignature[];
}

interface FunctionSignature {
    name: string;
    argCount: number;  // Number of arguments
    signature: string;  // Full C++ signature
    returnType?: string;
    note?: string;
}

const REFERENCE_DIR = path.join(process.cwd(), 'tools/reference');

// Interfaces we care about (COM interfaces)
// Organized by header file for clarity
const INTERFACES_BY_HEADER: Record<string, string[]> = {
    'ddraw.h': [
        'IDirectDraw',        // v1 - returned by DirectDrawCreate
        'IDirectDraw4',       // v4 (DX6) - Re-Volt uses this
        'IDirectDraw7',       // v7
        'IDirectDrawSurface', // v1
        'IDirectDrawSurface4',// v4 (DX6) - Re-Volt uses this
        'IDirectDrawSurface7',// v7
    ],
    'd3d.h': [
        'IDirect3D7',
        'IDirect3DDevice7',
        'IDirect3D3',
        'IDirect3DDevice3',
        'IDirect3DViewport3',
        'IDirect3DViewport2',
        'IDirect3DTexture',   // DirectX 5
        'IDirect3DTexture2', // DirectX 6
    ],
    'd3d9.h': [
        'IDirect3D9',
        'IDirect3DDevice9',
        'IDirect3DVertexBuffer9',
        'IDirect3DIndexBuffer9',
        'IDirect3DTexture9',
        'IDirect3DSurface9',
    ],
    'dsound.h': [
        'IDirectSound',
        'IDirectSoundBuffer',
        'IDirectSound8',
        'IDirectSoundBuffer8',
    ],
    'dinput.h': [
        'IDirectInputA',
        'IDirectInputDeviceA',
        'IDirectInput7A',
        'IDirectInputDevice7A',
    ],
    'dplay.h': [
        // IDirectPlayLobby3A is not in dplay.h (may be in dplayx.h or later version)
        // Keeping empty for now - interfaces will be parsed if found
    ],
};

// Flattened list for backward compatibility
const INTERFACES_TO_EXTRACT = Object.values(INTERFACES_BY_HEADER).flat();

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
     * Extract interface signature (for COM interfaces)
     */
    extractInterface(interfaceName: string): InterfaceSignature | null {
        // Instead of relying on comment markers, extract the whole interface body
        // and let `parseMethods()` pick out all STDMETHOD declarations.
        const declRegex = new RegExp(`DECLARE_INTERFACE_\\(\\s*${interfaceName}\\s*,[^)]+\\)`, 'g');
        const declMatch = declRegex.exec(this.content);
        if (!declMatch) return null;

        // Find the opening brace after DECLARE_INTERFACE_(...)
        let i = declRegex.lastIndex;
        while (i < this.content.length && this.content[i] !== '{') i++;
        if (i >= this.content.length) return null;

        const bodyStart = i + 1;
        let depth = 1;
        i++;
        while (i < this.content.length && depth > 0) {
            const ch = this.content[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        if (depth !== 0) return null;

        const bodyEnd = i - 1; // position of matching '}'
        const methodsBlock = this.content.slice(bodyStart, bodyEnd);
        const methods = this.parseMethods(methodsBlock, interfaceName);
        
        return {
            interface: interfaceName,
            iid: this.iids.get(interfaceName),
            methods
        };
    }

    /**
     * Parse method signatures from interface block
     */
    private parseMethods(methodsBlock: string, interfaceName: string): MethodSignature[] {
        const methods: MethodSignature[] = [];
        
        // Match STDMETHOD or STDMETHOD_ declarations
        // STDMETHOD(CreateDevice)(THIS_ REFCLSID rclsid,LPDIRECTDRAWSURFACE7 lpDDS, LPDIRECT3DDEVICE7 *lplpD3DDevice) PURE;
        // STDMETHOD_(HRESULT,QueryInterface)(THIS_ REFIID riid, void** ppvObject) PURE;
        // Also supports:
        // - STDMETHOD(Compact)(THIS) PURE;
        // - STDMETHOD_(ULONG,AddRef) (THIS) PURE;
        const methodRegex = /(STDMETHOD_\(\s*[^,]+,\s*(\w+)\s*\)|STDMETHOD\(\s*(\w+)\s*\))\s*\(\s*THIS(?:_\s*([^)]+))?\s*\)\s*PURE;/g;
        
        let match;
        let vtableIndex = 0;  // Start after IUnknown (3 methods)
        
        while ((match = methodRegex.exec(methodsBlock)) !== null) {
            const methodName = match[2] || match[3];
            const paramsStr = match[4] || '';
            
            // Skip IUnknown methods (QueryInterface, AddRef, Release)
            if (methodName === 'QueryInterface' || methodName === 'AddRef' || methodName === 'Release') {
                continue;
            }
            
            // Count parameters (split by comma, but be careful with function pointers)
            const params = this.parseParameters(paramsStr);
            const cParams = params.length;
            
            // Build full signature
            const signature = `${interfaceName}::${methodName}(${params.join(', ')})`;
            
            methods.push({
                name: methodName,
                cParams,
                vtableIndex: vtableIndex++,
                signature
            });
        }
        
        return methods;
    }

    /**
     * Extract function signatures (for regular C functions)
     * Supports patterns like:
     * - S32 AIL_startup(void);
     * - HSAMPLE AIL_allocate_sample_handle(HDIGDRIVER);
     * - S32 AIL_file_read(HFILE file, void *buffer, U32 bytes);
     * - WINAPI functions: WINAPI, WINBASEAPI, WINUSERAPI, etc.
     * - DECLSPEC_IMPORT functions
     */
    extractFunctions(functionPrefix?: string, functionNames?: string[]): FunctionSignature[] {
        const functions: FunctionSignature[] = [];
        const foundNames = new Set<string>();
        
        // Pattern 1: WINBASEAPI/WINUSERAPI/WINGDIAPI/WINMMAPI ReturnType WINAPI FunctionName(Params);
        // Pattern 2: DECLSPEC_IMPORT ReturnType WINAPI FunctionName(Params);
        // Pattern 3: ReturnType WINAPI FunctionName(Params);
        // Pattern 4: WINAPI ReturnType FunctionName(Params);
        // Pattern 5: Standard: ReturnType FunctionName(Params);
        
        // More comprehensive regex that handles various Windows API patterns
        const winApiPatterns = [
            // WINBASEAPI ReturnType WINAPI FunctionName(Params);
            /(?:WINBASEAPI|WINUSERAPI|WINGDIAPI|WINMMAPI|STDAPI)\s+(\w+(?:\s+\*|\s+\*\s*\*)?)\s+WINAPI\s+(\w+)\s*\(([^)]*)\)\s*;/g,
            // DECLSPEC_IMPORT ReturnType WINAPI FunctionName(Params);
            /DECLSPEC_IMPORT\s+(\w+(?:\s+\*|\s+\*\s*\*)?)\s+WINAPI\s+(\w+)\s*\(([^)]*)\)\s*;/g,
            // ReturnType WINAPI FunctionName(Params);
            /^(\w+(?:\s+\*|\s+\*\s*\*)?)\s+WINAPI\s+(\w+)\s*\(([^)]*)\)\s*;$/gm,
            // WINAPI ReturnType FunctionName(Params);
            /WINAPI\s+(\w+(?:\s+\*|\s+\*\s*\*)?)\s+(\w+)\s*\(([^)]*)\)\s*;/g,
            // Standard: ReturnType FunctionName(Params);
            /^(\w+(?:\s+\*|\s+\*\s*\*)?)\s+(\w+)\s*\(([^)]*)\)\s*;$/gm,
        ];
        
        for (const pattern of winApiPatterns) {
            let match;
            while ((match = pattern.exec(this.content)) !== null) {
                const returnType = match[1].trim();
                const functionName = match[2];
                const paramsStr = match[3]?.trim() || '';
                
                // Skip if already found
                if (foundNames.has(functionName)) {
                    continue;
                }
                
                // Filter by prefix or explicit list
                if (functionPrefix && !functionName.startsWith(functionPrefix)) {
                    continue;
                }
                if (functionNames && !functionNames.includes(functionName)) {
                    continue;
                }
                
                // Skip if it's a typedef, macro, or function pointer
                if (returnType.includes('typedef') || returnType.includes('#define') || 
                    functionName.includes('(') || functionName.includes(')') ||
                    returnType.includes('CALLBACK') || returnType.includes('(*')) {
                    continue;
                }
                
                // Skip common non-function declarations
                if (['if', 'else', 'for', 'while', 'switch', 'case', 'return', 'break', 'continue'].includes(functionName)) {
                    continue;
                }
                
                // Parse parameters
                const params = this.parseParameters(paramsStr);
                const argCount = params.length;
                
                // Build signature
                const signature = `${returnType} ${functionName}(${params.join(', ')})`;
                
                // Generate decorated name (stdcall convention)
                // For Windows API: _FunctionName@N where N is bytes
                let decoratedName = '';
                if (functionPrefix && functionName.startsWith(functionPrefix)) {
                    const argBytes = argCount * 4; // stdcall: each arg is 4 bytes
                    decoratedName = `_${functionName}@${argBytes}`;
                } else if (functionNames && functionNames.includes(functionName)) {
                    // For explicit function lists, also generate decorated name
                    const argBytes = argCount * 4;
                    decoratedName = `_${functionName}@${argBytes}`;
                }
                
                functions.push({
                    name: decoratedName || functionName,
                    argCount,
                    signature,
                    returnType
                });
                
                foundNames.add(functionName);
            }
        }
        
        return functions;
    }

    /**
     * Parse parameter list, handling function pointers and complex types
     */
    private parseParameters(paramsStr: string): string[] {
        if (!paramsStr.trim() || paramsStr.trim() === 'void') {
            return [];
        }
        
        const params: string[] = [];
        let current = '';
        let depth = 0;
        let inFunctionPtr = false;
        
        for (let i = 0; i < paramsStr.length; i++) {
            const char = paramsStr[i];
            
            if (char === '(') {
                depth++;
                current += char;
                if (current.trim().includes('CALLBACK') || current.trim().includes('*')) {
                    inFunctionPtr = true;
                }
            } else if (char === ')') {
                depth--;
                current += char;
            } else if (char === ',' && depth === 0 && !inFunctionPtr) {
                const param = current.trim();
                if (param) {
                    // Extract just the type part (before parameter name)
                    const typePart = param.split(/\s+\w+\s*$/)[0] || param;
                    params.push(typePart.trim());
                }
                current = '';
                inFunctionPtr = false;
            } else {
                current += char;
                if (depth === 0 && char === ';') {
                    inFunctionPtr = false;
                }
            }
        }
        
        if (current.trim()) {
            const typePart = current.trim().split(/\s+\w+\s*$/)[0] || current.trim();
            params.push(typePart.trim());
        }
        
        return params;
    }
}

async function parseDirectXHeader(filePath: string, outputDir: string): Promise<void> {
    console.log(`Parsing ${path.basename(filePath)}...`);
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const parser = new ReferenceHeaderParser(content);
    
    const interfaces: InterfaceSignature[] = [];
    const fileName = path.basename(filePath);
    
    // Get interfaces for this specific header file
    const interfacesToExtract = INTERFACES_BY_HEADER[fileName] || INTERFACES_TO_EXTRACT;
    
    for (const interfaceName of interfacesToExtract) {
        const signature = parser.extractInterface(interfaceName);
        if (signature) {
            interfaces.push(signature);
            console.log(`  Found ${interfaceName}: ${signature.methods.length} methods`);
        } else {
            // Only warn if this interface is expected for this header
            if (INTERFACES_BY_HEADER[fileName]?.includes(interfaceName)) {
                console.log(`  Warning: ${interfaceName} not found`);
            }
        }
    }
    
    // Group by source file and save
    const baseFileName = path.basename(filePath, '.h');
    const outputFile = path.join(outputDir, `${baseFileName}.sig.json`);
    
    const output = {
        source: fileName,
        generated: new Date().toISOString(),
        interfaces
    };
    
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`  Saved: ${outputFile}\n`);
}

// Mapping of Windows API modules to their function prefixes/names
// This helps identify which functions belong to which module
const WIN32_MODULE_FUNCTIONS: Record<string, { prefixes?: string[]; names?: string[] }> = {
    'advapi32': {
        prefixes: ['Reg', 'Crypt', 'Event', 'Lookup', 'Lsa', 'Convert'],
        names: ['RegOpenKeyEx', 'RegQueryValueEx', 'RegCloseKey', 'RegSetValueExA', 'RegCreateKeyExA']
    },
    'gdi32': {
        prefixes: ['GetStock', 'Text', 'SetBk', 'SetText', 'Create', 'Select', 'Delete', 'Rectangle', 'Ellipse', 'MoveTo', 'LineTo', 'GetDevice', 'GetText', 'GetObject', 'GetPixel', 'Stretch', 'Bit', 'GetDIB'],
        names: ['GetStockObject', 'TextOut', 'TextOutW', 'SetBkMode', 'SetTextColor', 'CreateSolidBrush', 'SelectObject', 'DeleteObject', 'Rectangle', 'Ellipse', 'MoveToEx', 'LineTo', 'CreatePen', 'CreateFontIndirect', 'CreateFontIndirectW', 'GetDeviceCaps', 'SetBkColor', 'GetTextExtentPoint32', 'CreateFontA', 'CreateFontW', 'DeleteDC', 'CreateCompatibleDC', 'GetObjectA', 'GetPixel', 'StretchBlt', 'BitBlt', 'GetDIBColorTable']
    },
    'kernel32': {
        prefixes: ['Create', 'Read', 'Write', 'Close', 'Get', 'Set', 'Find', 'Load', 'Free', 'Virtual', 'Heap', 'File', 'GetFile', 'SetFile', 'MoveFile', 'DeleteFile', 'CopyFile'],
        names: ['CreateFileA', 'CreateFileW', 'ReadFile', 'WriteFile', 'CloseHandle', 'GetFileSize', 'SetFilePointer', 'FindFirstFileA', 'FindFirstFileW', 'FindNextFileA', 'FindNextFileW', 'FindClose', 'LoadLibraryA', 'LoadLibraryW', 'GetProcAddress', 'FreeLibrary', 'GetModuleHandleA', 'GetModuleHandleW', 'GetModuleFileNameA', 'GetModuleFileNameW', 'VirtualAlloc', 'VirtualFree', 'HeapAlloc', 'HeapFree', 'GetCurrentProcess', 'GetCurrentThread', 'GetTickCount', 'Sleep', 'GetSystemTime', 'GetLocalTime', 'FileTimeToSystemTime', 'SystemTimeToFileTime']
    },
    'user32': {
        prefixes: ['Register', 'Create', 'Show', 'Update', 'Get', 'Translate', 'Dispatch', 'Post', 'DefWindow', 'Load', 'Message', 'Begin', 'End', 'Destroy', 'Peek', 'GetSystem', 'GetClient', 'GetWindow', 'Fill', 'Invalidate', 'Draw', 'GetAsync', 'GetKey', 'wsprintf', 'MapVirtual', 'Find', 'Set', 'SetTimer', 'KillTimer'],
        names: ['RegisterClassExA', 'RegisterClassExW', 'RegisterClassA', 'RegisterClassW', 'CreateWindowExA', 'CreateWindowExW', 'CreateWindowA', 'CreateWindowW', 'ShowWindow', 'UpdateWindow', 'GetMessageA', 'GetMessageW', 'TranslateMessage', 'DispatchMessageA', 'DispatchMessageW', 'PostQuitMessage', 'DefWindowProcA', 'DefWindowProcW', 'LoadCursorA', 'LoadCursorW', 'LoadIconA', 'LoadIconW', 'MessageBoxA', 'MessageBoxW', 'BeginPaint', 'EndPaint', 'DestroyWindow', 'GetDC', 'ReleaseDC', 'PeekMessageA', 'PeekMessageW', 'GetSystemMetrics', 'GetClientRect', 'GetWindowRect', 'FillRect', 'InvalidateRect', 'DrawTextA', 'DrawTextW', 'GetAsyncKeyState', 'GetKeyState', 'wsprintfA', 'LoadImageA', 'MapVirtualKeyA', 'FindWindowA', 'SetCursor', 'SetTimer', 'KillTimer']
    },
    'winmm': {
        prefixes: ['time', 'wave', 'midi', 'mci'],
        names: ['timeGetTime', 'timeBeginPeriod', 'timeEndPeriod', 'timeSetEvent', 'timeKillEvent']
    },
    'ole32': {
        prefixes: ['Co'],
        names: ['CoInitialize', 'CoUninitialize', 'CoCreateInstance']
    }
};

async function parseFunctionHeader(filePath: string, outputDir: string, functionPrefix: string, moduleName: string): Promise<void> {
    console.log(`Parsing ${path.basename(filePath)} (functions with prefix ${functionPrefix})...`);
    
    if (!fs.existsSync(filePath)) {
        console.log(`  File not found, skipping...\n`);
        return;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const parser = new ReferenceHeaderParser(content);
    
    const functions = parser.extractFunctions(functionPrefix);
    
    if (functions.length === 0) {
        console.log(`  No functions found with prefix ${functionPrefix}\n`);
        return;
    }
    
    console.log(`  Found ${functions.length} functions`);
    
    // Save to module-specific directory
    const moduleDir = path.join(outputDir, moduleName);
    if (!fs.existsSync(moduleDir)) {
        fs.mkdirSync(moduleDir, { recursive: true });
    }
    
    const outputFile = path.join(moduleDir, `${moduleName}.sig.json`);
    
    const output = {
        source: path.basename(filePath),
        generated: new Date().toISOString(),
        module: moduleName,
        functions
    };
    
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`  Saved: ${outputFile}\n`);
}

async function parseWin32Header(filePath: string, outputDir: string, moduleName: string): Promise<void> {
    console.log(`Parsing ${path.basename(filePath)} for module ${moduleName}...`);
    
    if (!fs.existsSync(filePath)) {
        console.log(`  File not found, skipping...\n`);
        return;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const parser = new ReferenceHeaderParser(content);
    
    const moduleConfig = WIN32_MODULE_FUNCTIONS[moduleName];
    if (!moduleConfig) {
        console.log(`  No configuration found for module ${moduleName}, skipping...\n`);
        return;
    }
    
    // Extract functions by prefixes and explicit names
    const allFunctions: FunctionSignature[] = [];
    
    if (moduleConfig.prefixes) {
        for (const prefix of moduleConfig.prefixes) {
            const functions = parser.extractFunctions(prefix);
            allFunctions.push(...functions);
        }
    }
    
    if (moduleConfig.names) {
        const functions = parser.extractFunctions(undefined, moduleConfig.names);
        allFunctions.push(...functions);
    }
    
    // Remove duplicates (by name)
    const uniqueFunctions = new Map<string, FunctionSignature>();
    for (const func of allFunctions) {
        const key = func.name;
        if (!uniqueFunctions.has(key)) {
            uniqueFunctions.set(key, func);
        }
    }
    
    const functions = Array.from(uniqueFunctions.values());
    
    if (functions.length === 0) {
        console.log(`  No functions found for module ${moduleName}\n`);
        return;
    }
    
    console.log(`  Found ${functions.length} functions`);
    
    // Save to module-specific directory
    const moduleDir = path.join(outputDir, moduleName);
    if (!fs.existsSync(moduleDir)) {
        fs.mkdirSync(moduleDir, { recursive: true });
    }
    
    const outputFile = path.join(moduleDir, `${moduleName}.sig.json`);
    
    const output = {
        source: path.basename(filePath),
        generated: new Date().toISOString(),
        module: moduleName,
        functions
    };
    
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`  Saved: ${outputFile}\n`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const mode = args[0] || 'directx';
    
    if (mode === 'directx') {
        console.log('Parsing DirectX header files...\n');
        
        const directxDir = path.join(REFERENCE_DIR, 'directx');
        if (!fs.existsSync(directxDir)) {
            console.error(`Reference directory not found: ${directxDir}`);
            console.error('Run: bun run fetch-reference-headers directx');
            process.exit(1);
        }
        
        const ddrawPath = path.join(directxDir, 'ddraw.h');
        const d3dPath = path.join(directxDir, 'd3d.h');
        const d3d9Path = path.join(directxDir, 'd3d9.h');
        const dsoundPath = path.join(directxDir, 'dsound.h');
        const dinputPath = path.join(directxDir, 'dinput.h');
        const dplayPath = path.join(directxDir, 'dplay.h');
        
        if (fs.existsSync(ddrawPath)) await parseDirectXHeader(ddrawPath, directxDir);
        if (fs.existsSync(d3dPath)) await parseDirectXHeader(d3dPath, directxDir);
        if (fs.existsSync(d3d9Path)) await parseDirectXHeader(d3d9Path, directxDir);
        if (fs.existsSync(dsoundPath)) await parseDirectXHeader(dsoundPath, directxDir);
        if (fs.existsSync(dinputPath)) await parseDirectXHeader(dinputPath, directxDir);
        if (fs.existsSync(dplayPath)) await parseDirectXHeader(dplayPath, directxDir);
        
        console.log('✓ DirectX parsing complete!');
    } else if (mode === 'mss32') {
        console.log('Parsing MSS32 header files...\n');
        
        // MSS32 headers might not be available, but we can parse if they exist
        const mss32Dir = path.join(REFERENCE_DIR, 'mss32');
        const ailPath = path.join(mss32Dir, 'ail.h');
        
        await parseFunctionHeader(ailPath, REFERENCE_DIR, 'AIL_', 'mss32');
        
        console.log('✓ MSS32 parsing complete!');
    } else if (mode === 'win32') {
        console.log('Parsing Windows API header files...\n');
        
        const win32Dir = path.join(REFERENCE_DIR, 'win32');
        if (!fs.existsSync(win32Dir)) {
            console.error(`Reference directory not found: ${win32Dir}`);
            console.error('Run: bun run fetch-reference-headers win32');
            process.exit(1);
        }
        
        const winbasePath = path.join(win32Dir, 'winbase.h');
        const winuserPath = path.join(win32Dir, 'winuser.h');
        const wingdiPath = path.join(win32Dir, 'wingdi.h');
        const mmsystemPath = path.join(win32Dir, 'mmsystem.h');
        const objbasePath = path.join(win32Dir, 'objbase.h');
        
        // Parse each module from appropriate header
        // advapi32 and kernel32 from winbase.h
        if (fs.existsSync(winbasePath)) {
            await parseWin32Header(winbasePath, win32Dir, 'advapi32');
            await parseWin32Header(winbasePath, win32Dir, 'kernel32');
        }
        
        // user32 from winuser.h
        if (fs.existsSync(winuserPath)) {
            await parseWin32Header(winuserPath, win32Dir, 'user32');
        }
        
        // gdi32 from wingdi.h
        if (fs.existsSync(wingdiPath)) {
            await parseWin32Header(wingdiPath, win32Dir, 'gdi32');
        }
        
        // winmm from mmsystem.h
        if (fs.existsSync(mmsystemPath)) {
            await parseWin32Header(mmsystemPath, win32Dir, 'winmm');
        }
        
        // ole32 from objbase.h
        if (fs.existsSync(objbasePath)) {
            await parseWin32Header(objbasePath, win32Dir, 'ole32');
        }
        
        console.log('✓ Windows API parsing complete!');
    } else {
        console.error(`Unknown mode: ${mode}`);
        console.error('Usage: bun run parse-reference-headers [directx|mss32|win32]');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
