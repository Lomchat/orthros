#!/usr/bin/env bun
/**
 * Porsche.zip InstallShield smoke test (MANUAL — do NOT commit the zip).
 *
 * Reads tmp/Porsche.zip (copy your local Porsche.zip there first),
 * pulls out data1.hdr + data1.cab, runs the BROWSER extractor
 * (`extractInstallShield`) with verifySize+verifyMd5, and asserts the full
 * 407-file tree comes through (including Porsche.exe, Drivers/dx7z.dll, and
 * entries under FEDATA/ and GameData/), then that the entrypoint heuristic
 * resolves to Porsche.exe.
 *
 * Run:  bun tools/tests/installshield-porsche.smoke.ts
 *
 * Bun lacks DecompressionStream, so we inject node zlib.inflateRawSync via the
 * `inflateRaw` hook — exactly like tools/tests/installshield.test.ts.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { inflateRawSync } from "zlib";
import { extractInstallShield, detectInstallShieldStem } from "@bottleship/formats/installshield/index.ts";
import { detectExeFromPaths } from "@bottleship/repack/gog-filter";

const nodeInflate = (chunk: Uint8Array) => new Uint8Array(inflateRawSync(Buffer.from(chunk)));

const ZIP_PATH = join(import.meta.dir, "..", "..", "tmp", "Porsche.zip");

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

interface ZEntry {
    name: string;
    compression: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

/** Minimal local-only zip reader (central dir parse + node inflate). */
function readZip(buf: Uint8Array): Map<string, Uint8Array> {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (dv.getUint32(i, true) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("EOCD not found");
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOff = dv.getUint32(eocd + 16, true);

    const entries: ZEntry[] = [];
    let off = cdOff;
    const cdEnd = cdOff + cdSize;
    const dec = new TextDecoder("utf-8");
    while (off + 46 <= cdEnd) {
        if (dv.getUint32(off, true) !== CEN_SIG) break;
        const compression = dv.getUint16(off + 10, true);
        const compressedSize = dv.getUint32(off + 20, true);
        const uncompressedSize = dv.getUint32(off + 24, true);
        const nameLen = dv.getUint16(off + 28, true);
        const extraLen = dv.getUint16(off + 30, true);
        const commentLen = dv.getUint16(off + 32, true);
        const localHeaderOffset = dv.getUint32(off + 42, true);
        const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
        entries.push({ name, compression, compressedSize, uncompressedSize, localHeaderOffset });
        off += 46 + nameLen + extraLen + commentLen;
    }

    const out = new Map<string, Uint8Array>();
    for (const e of entries) {
        if (e.name.endsWith("/")) continue;
        // local header: 30 + nameLen + extraLen, then data
        const lhNameLen = dv.getUint16(e.localHeaderOffset + 26, true);
        const lhExtraLen = dv.getUint16(e.localHeaderOffset + 28, true);
        const dataStart = e.localHeaderOffset + 30 + lhNameLen + lhExtraLen;
        const raw = buf.subarray(dataStart, dataStart + e.compressedSize);
        let data: Uint8Array;
        if (e.compression === 0) data = raw;
        else if (e.compression === 8) data = new Uint8Array(inflateRawSync(Buffer.from(raw)));
        else throw new Error(`unsupported zip compression ${e.compression} for ${e.name}`);
        out.set(e.name, data);
    }
    return out;
}

function basename(p: string): string {
    return p.split(/[\\/]/).pop() ?? p;
}

async function main() {
    const zipBytes = new Uint8Array(readFileSync(ZIP_PATH));
    const files = readZip(zipBytes);

    // Find data1.hdr + data1.cab (and any data2.cab, ...) by basename, case-insensitive.
    const byBase = new Map<string, { key: string; bytes: Uint8Array }>();
    for (const [k, v] of files) byBase.set(basename(k).toLowerCase(), { key: k, bytes: v });

    // The installer zip ships THREE cabinets (data1 + _sys1 + _user1); the
    // detector must pick the game cabinet `data`, not an engine support cabinet.
    const stem = detectInstallShieldStem([...files.keys()]);
    console.log(`detectInstallShieldStem -> ${stem}`);
    if (stem !== "data") {
        console.error(`FAIL: stem detection picked "${stem}", expected "data"`);
        process.exitCode = 1;
    }

    const hdrEntry = byBase.get(`${stem}1.hdr`);
    if (!hdrEntry) throw new Error(`${stem}1.hdr not found in zip`);
    const hdr = hdrEntry;
    const volumes = new Map<number, Uint8Array>();
    const cabRe = new RegExp(`^${stem}(\\d+)\\.cab$`);
    for (const [low, e] of byBase) {
        const m = cabRe.exec(low);
        if (m) volumes.set(Number(m[1]), e.bytes);
    }
    if (!volumes.has(1)) throw new Error(`${stem}1.cab not found in zip`);
    console.log(`zip entries: ${files.size}; cab volumes: ${[...volumes.keys()].sort().join(",")}`);

    const t0 = Date.now();
    const extracted = await extractInstallShield(hdr.bytes, volumes, {
        verifySize: true,
        verifyMd5: true,
        inflateRaw: nodeInflate,
    });
    console.log(`extracted ${extracted.size} files in ${Date.now() - t0}ms`);

    const keys = [...extracted.keys()];
    const assert = (cond: boolean, msg: string) => {
        if (!cond) {
            console.error(`FAIL: ${msg}`);
            process.exitCode = 1;
        } else {
            console.log(`ok: ${msg}`);
        }
    };

    assert(extracted.size === 407, `407 files (got ${extracted.size})`);
    assert(keys.some((k) => /(^|\/)Porsche\.exe$/i.test(k)), "Porsche.exe present");
    assert(keys.some((k) => /(^|\/)Drivers\/dx7z\.dll$/i.test(k)), "Drivers/dx7z.dll present");
    assert(keys.some((k) => /(^|\/)voodoo2z\.dll$/i.test(k)), "voodoo2z.dll present");
    assert(keys.some((k) => /^FEDATA[\\/]/i.test(k)), "FEDATA/ entries present");
    assert(keys.some((k) => /^GameData[\\/]/i.test(k)), "GameData/ entries present");

    const entry = detectExeFromPaths(keys);
    console.log(`detected entrypoint: ${entry}`);
    assert(!!entry && /(^|\/)Porsche\.exe$/i.test(entry), `entrypoint resolves to Porsche.exe (got ${entry})`);

    if (process.exitCode) {
        console.error("\nSMOKE TEST FAILED");
        // Dump a sample of keys to help diagnose.
        console.error("first 20 keys:", keys.slice(0, 20));
    } else {
        console.log("\nSMOKE TEST PASSED");
    }
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
