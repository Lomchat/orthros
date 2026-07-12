#!/usr/bin/env bun
/**
 * Patch .wgb bundle manifest (VRAM, resolutions, etc.)
 *
 * Usage:
 *   bun tools/patch-wgb-vram.ts <input.wgb> --vram <mb>
 *   bun tools/patch-wgb-vram.ts <input.wgb> --resolution <WxH>
 *   bun tools/patch-wgb-vram.ts <input.wgb> --resolutions <WxH,WxH,...>
 *
 * Examples:
 *   bun tools/patch-wgb-vram.ts public/apps/re-volt.wgb --vram 16
 *   bun tools/patch-wgb-vram.ts public/apps/re-volt.wgb --resolution 320x240
 *   bun tools/patch-wgb-vram.ts public/apps/re-volt.wgb --resolutions 320x240,640x480
 */

import * as fs from "fs";
import JSZip from "jszip";

const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Usage: bun tools/patch-wgb-vram.ts <input.wgb> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --vram <mb>              Set VRAM size in MB");
    console.log("  --resolution <WxH>       Set primary resolution (e.g., 640x480)");
    console.log("  --resolutions <list>     Set supported resolutions (e.g., 320x240,640x480)");
    console.log("  --output <path>          Output file (default: overwrite input)");
    console.log("");
    console.log("Examples:");
    console.log("  bun tools/patch-wgb-vram.ts game.wgb --vram 16 --resolution 320x240");
    console.log("  bun tools/patch-wgb-vram.ts game.wgb --resolutions 320x240,640x480,800x600");
    process.exit(1);
}

const inputPath = args[0];
let outputPath = inputPath;
let vramMb: number | null = null;
let primaryResolution: { width: number; height: number } | null = null;
let supportedResolutions: Array<{ width: number; height: number; bpp: number }> | null = null;

// Parse arguments
for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--vram" && next) {
        vramMb = parseInt(next, 10);
        if (isNaN(vramMb) || vramMb <= 0) {
            console.error("Invalid VRAM size:", next);
            process.exit(1);
        }
        i++;
    } else if (arg === "--resolution" && next) {
        const match = next.match(/^(\d+)x(\d+)$/);
        if (!match) {
            console.error("Invalid resolution format:", next, "(expected WxH, e.g., 640x480)");
            process.exit(1);
        }
        primaryResolution = { width: parseInt(match[1]), height: parseInt(match[2]) };
        i++;
    } else if (arg === "--resolutions" && next) {
        supportedResolutions = next.split(",").map(res => {
            const match = res.trim().match(/^(\d+)x(\d+)(?:x(\d+))?$/);
            if (!match) {
                console.error("Invalid resolution format:", res, "(expected WxH or WxHxBPP)");
                process.exit(1);
            }
            return {
                width: parseInt(match[1]),
                height: parseInt(match[2]),
                bpp: match[3] ? parseInt(match[3]) : 16
            };
        });
        i++;
    } else if (arg === "--output" && next) {
        outputPath = next;
        i++;
    }
}

async function main() {
    // Check that at least one option was provided
    if (vramMb === null && primaryResolution === null && supportedResolutions === null) {
        console.error("No options provided. Use --vram, --resolution, or --resolutions.");
        process.exit(1);
    }

    console.log(`Reading ${inputPath}...`);
    const data = fs.readFileSync(inputPath);
    const zip = await JSZip.loadAsync(data);

    // Read manifest
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile) {
        throw new Error("manifest.json not found in archive");
    }

    const manifestText = await manifestFile.async("string");
    const manifest = JSON.parse(manifestText);

    // Ensure emulator section exists
    if (!manifest.emulator) manifest.emulator = {};

    const changes: string[] = [];

    // Apply VRAM changes
    if (vramMb !== null) {
        const vramBytes = vramMb * 1024 * 1024;

        if (!manifest.emulator.memory) manifest.emulator.memory = {};
        if (!manifest.emulator.ddrawCaps) manifest.emulator.ddrawCaps = {};

        const oldVram = manifest.emulator.memory.vram;
        const oldVidMem = manifest.emulator.ddrawCaps.dwVidMemTotal;

        manifest.emulator.memory.vram = vramBytes;
        manifest.emulator.ddrawCaps.dwVidMemTotal = vramBytes;
        manifest.emulator.ddrawCaps.dwVidMemFree = vramBytes;

        changes.push(`VRAM: ${oldVram ? (oldVram / 1024 / 1024) + "MB" : "unset"} -> ${vramMb}MB`);
        changes.push(`dwVidMemTotal: ${oldVidMem ? (oldVidMem / 1024 / 1024) + "MB" : "unset"} -> ${vramMb}MB`);
    }

    // Apply primary resolution
    if (primaryResolution !== null) {
        if (!manifest.emulator.screenResolution) manifest.emulator.screenResolution = {};

        const oldRes = manifest.emulator.screenResolution;
        const oldResStr = oldRes.width ? `${oldRes.width}x${oldRes.height}` : "unset";

        manifest.emulator.screenResolution.width = primaryResolution.width;
        manifest.emulator.screenResolution.height = primaryResolution.height;

        changes.push(`screenResolution: ${oldResStr} -> ${primaryResolution.width}x${primaryResolution.height}`);
    }

    // Apply supported resolutions
    if (supportedResolutions !== null) {
        const oldModes = manifest.emulator.supportedResolutions;
        const oldModesStr = oldModes?.length
            ? oldModes.map((r: {width: number; height: number; bpp?: number}) => `${r.width}x${r.height}x${r.bpp || 16}`).join(", ")
            : "unset";

        manifest.emulator.supportedResolutions = supportedResolutions;

        const newModesStr = supportedResolutions.map(r => `${r.width}x${r.height}x${r.bpp}`).join(", ");
        changes.push(`supportedResolutions: ${oldModesStr} -> ${newModesStr}`);
    }

    // Print changes
    console.log("\nChanges:");
    for (const change of changes) {
        console.log(`  ${change}`);
    }

    // Update manifest in zip
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));

    // Write output (STORE-only — WGB requires method=0 for range reads)
    console.log(`\nWriting ${outputPath}...`);
    const output = await zip.generateAsync({
        type: "nodebuffer",
        compression: "STORE",
    });

    fs.writeFileSync(outputPath, output);
    console.log("Done!");
}

main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
});
