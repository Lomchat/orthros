#!/usr/bin/env bun
/**
 * Patch existing WGB bundles: merge goggame-*.script setRegistry actions into registry.json.
 *
 * Usage:
 *   bun tools/patch-wgb-gog-script-registry.ts <archive.wgb> [...]
 *   bun tools/patch-wgb-gog-script-registry.ts --dry-run <archive.wgb>
 *   bun tools/patch-wgb-gog-script-registry.ts --script goggame-123.script <archive.wgb>
 *   bun tools/patch-wgb-gog-script-registry.ts --installer setup_game.exe <archive.wgb>
 *
 * Creates <archive>.wgb.bak before rewriting. Rebuilds the store-only ZIP (slow on multi-GB archives).
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { buildZip } from "@orthros/formats/wgb/zip-build";
import {
    mergeRegistrySeeds,
    parseGogScriptRegistry,
    synthesizeRegistryFromGogScripts,
    type RegistrySeed,
} from "@orthros/repack/gog-script";

interface ZipEntry {
    name: string;
    dataOffset: number;
    size: number;
    compression: number;
}

function parseZipStore(buf: Buffer): ZipEntry[] {
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error("Not a ZIP file (EOCD not found)");

    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const entryCount = buf.readUInt16LE(eocdOffset + 10);
    const entries: ZipEntry[] = [];
    let pos = cdOffset;

    for (let i = 0; i < entryCount; i++) {
        if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error(`Bad CDH at ${pos}`);
        const compression = buf.readUInt16LE(pos + 10);
        const size = buf.readUInt32LE(pos + 24);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const lfhOffset = buf.readUInt32LE(pos + 42);
        const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
        const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
        const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
        const dataOffset = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
        entries.push({ name, dataOffset, size, compression });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function readEntry(buf: Buffer, entry: ZipEntry): Uint8Array {
    if (entry.compression !== 0) {
        throw new Error(`Entry ${entry.name} is compressed (method=${entry.compression}); run: bun tools/wgb.ts repack ${entry.name}`);
    }
    return new Uint8Array(buf.buffer, buf.byteOffset + entry.dataOffset, entry.size);
}

function parseRegistrySeed(raw: string): RegistrySeed | RegistrySeed[] {
    const parsed = JSON.parse(raw) as RegistrySeed | RegistrySeed[];
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && "root" in parsed) return parsed;
    throw new Error("registry.json has unexpected shape");
}

function patchWgb(wgbPath: string, dryRun: boolean, externalScripts: Map<string, Uint8Array>): void {
    console.log(`\n=== ${wgbPath} ===`);
    const buf = readFileSync(wgbPath) as unknown as Buffer;
    const entries = parseZipStore(buf);

    const regEntry = entries.find((e) => e.name.toLowerCase() === "registry.json");
    if (!regEntry) throw new Error("registry.json not found");

    const scriptFiles = new Map<string, Uint8Array>(externalScripts);
    for (const e of entries) {
        const base = basename(e.name.replace(/\\/g, "/"));
        if (!/^goggame-.*\.script$/i.test(base)) continue;
        scriptFiles.set(e.name.replace(/\\/g, "/"), readEntry(buf, e));
    }
    if (scriptFiles.size === 0) {
        console.log("  skip: no rom/goggame-*.script entries");
        return;
    }
    console.log(`  found ${scriptFiles.size} script file(s): ${[...scriptFiles.keys()].join(", ")}`);

    const existing = parseRegistrySeed(new TextDecoder().decode(readEntry(buf, regEntry)));
    const scriptRegistry = synthesizeRegistryFromGogScripts(scriptFiles, "C:\\");
    const merged = mergeRegistrySeeds(existing, scriptRegistry);

    const addedKeys = scriptRegistry.map((s) => `${s.root}\\${s.path}`);
    console.log(`  registry keys after merge: ${merged.length} (+${scriptRegistry.length} from script)`);
    for (const k of addedKeys) console.log(`    + ${k}`);

    const newRegistryJson = JSON.stringify(merged, null, 2);
    if (dryRun) {
        console.log("  dry-run: not writing");
        return;
    }

    const newData = Buffer.from(newRegistryJson, "utf8");
    const rebuilt = entries.map((e) => ({
        name: e.name,
        data: e.name === regEntry.name
            ? newData
            : Buffer.from(buf.subarray(e.dataOffset, e.dataOffset + e.size)),
    }));

    const bak = `${wgbPath}.bak`;
    if (!existsSync(bak)) {
        console.log(`  backup -> ${bak}`);
        copyFileSync(wgbPath, bak);
    } else {
        console.log(`  backup exists, skipping copy: ${bak}`);
    }

    const out = buildZip(new Map(rebuilt.map((e) => [e.name, new Uint8Array(e.data)])));
    writeFileSync(wgbPath, out);
    console.log(`  patched registry.json (${regEntry.size} -> ${newData.length} bytes), archive ${buf.length} -> ${out.byteLength} bytes`);
}

async function loadScriptsFromInstaller(installerPath: string): Promise<Map<string, Uint8Array>> {
    const { BufferSource, extractInnoToMap, parseInnoHeader } = await import("@orthros/formats/inno");
    const { UnpackDecoder } = await import("@orthros/formats/unpack");
    const wasmPath = new URL("../public/unpack-streaming.wasm", import.meta.url);
    const wasmBytes = readFileSync(wasmPath);
    const lzma = new UnpackDecoder();
    await lzma.init(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));

    const source = new BufferSource(readFileSync(installerPath));
    const parsed = await parseInnoHeader(source, lzma);
    const extracted = await extractInnoToMap(source, {
        wantFile: (rel) => /^goggame-.*\.script$/i.test(basename(rel.replace(/\\/g, "/"))),
    }, lzma, parsed);

    const out = new Map<string, Uint8Array>();
    for (const [rel, data] of extracted) {
        out.set(`rom/${rel.replace(/\\/g, "/")}`, data);
    }
    return out;
}

function parseArgs(argv: string[]): {
    dryRun: boolean;
    paths: string[];
    externalScripts: Map<string, Uint8Array>;
    installerPath?: string;
} {
    const dryRun = argv.includes("--dry-run");
    let installerPath: string | undefined;
    const externalScripts = new Map<string, Uint8Array>();
    const paths: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "--dry-run") continue;
        if (arg === "--installer") {
            installerPath = argv[++i];
            continue;
        }
        if (arg === "--script") {
            const scriptPath = argv[++i];
            if (!scriptPath) throw new Error("--script requires a path");
            const data = readFileSync(scriptPath);
            externalScripts.set(`rom/${basename(scriptPath)}`, new Uint8Array(data));
            continue;
        }
        paths.push(arg);
    }

    return { dryRun, paths, externalScripts, installerPath };
}

const { dryRun, paths, externalScripts, installerPath } = parseArgs(process.argv.slice(2));
if (paths.length === 0) {
    console.error("Usage: bun tools/patch-wgb-gog-script-registry.ts [--dry-run] [--script path] [--installer setup.exe] <archive.wgb> [...]");
    process.exit(1);
}

let scripts = externalScripts;
if (installerPath) {
    console.log(`Extracting goggame-*.script from installer: ${installerPath}`);
    const fromInstaller = await loadScriptsFromInstaller(installerPath);
    scripts = new Map([...fromInstaller, ...externalScripts]);
    if (fromInstaller.size === 0) {
        console.warn("  warning: installer contained no goggame-*.script files");
    } else {
        console.log(`  extracted: ${[...fromInstaller.keys()].join(", ")}`);
    }
}

for (const p of paths) {
    patchWgb(p, dryRun, scripts);
}
