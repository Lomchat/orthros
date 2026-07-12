#!/usr/bin/env bun
/**
 * PackageForTheWeb (MSCF cabinet) smoke test (MANUAL — do NOT commit the exe).
 *
 * Exercises the full container chain on an InstallShield "PackageForTheWeb"
 * self-extractor: MSCF cabinet (appended to `stub32i.exe`) → InstallShield disk
 * images → real game files. Ground truth: a local Max Payne Demo installer.
 *
 * Stage 1 (the new `@bottleship/formats/cab` core): find + unwrap the appended
 * MSZIP cabinet and assert it yields the 9 InstallShield disk-image files
 * (data1.hdr + data1.cab + data2.cab + Setup.exe + setup.inx …).
 *
 * Stage 2 (`extractInstallerFromFiles`): recurse into the cabinet and assert the
 * chain resolves `via === "pftw"` and produces the game tree (MaxPayneDemo.exe +
 * x_demodatas.ras + x_demolevels.ras).
 *
 * Run:  BOTTLESHIP_PFTW_EXE=/path/to/MaxPayneDemo.exe bun tools/tests/cab-pftw.smoke.ts
 *
 * Bun lacks a dictionary-capable DecompressionStream, so we inject node
 * zlib.inflateRawSync (with the MSZIP preset dictionary) via the hooks — exactly
 * like tools/tests/installshield-porsche.smoke.ts.
 */
import { readFileSync } from "fs";
import { inflateRawSync } from "zlib";
import { findCabinet, parseCabHeader, extractCabToMap } from "@bottleship/formats/cab/index.ts";
import { extractInstallerFromFiles } from "@bottleship/repack/container-extract";

const EXE = process.env.BOTTLESHIP_PFTW_EXE ?? "G:/Games/MaxPayneDemo.exe";
const buf = new Uint8Array(readFileSync(EXE));
console.log(`Read ${EXE} (${buf.length} bytes)`);

let fail = 0;
const expect = (cond: boolean, msg: string) => { console.log(`  ${cond ? "OK  " : "FAIL"} ${msg}`); if (!cond) fail++; };

// ---- Stage 1: MSCF unwrap ----
const off = findCabinet(buf);
expect(off != null, `findCabinet located an appended MSCF (offset ${off})`);
const info = parseCabHeader(buf, off!)!;
expect(info != null, "parseCabHeader succeeded");
expect((info.folders[0]!.typeCompress & 0x0f) === 1, "folder compression is MSZIP");

const cabFiles = await extractCabToMap(buf, {
    inflateBlock: (chunk, dict) => new Uint8Array(inflateRawSync(chunk, dict ? { dictionary: dict } : undefined)),
}, info);
const cabNames = new Set([...cabFiles.keys()].map((n) => n.toLowerCase()));
console.log(`  cabinet files: ${[...cabFiles.keys()].join(", ")}`);
for (const n of ["data1.hdr", "data1.cab", "data2.cab", "setup.inx"]) {
    expect(cabNames.has(n), `cabinet contains ${n}`);
}

// ---- Stage 2: full chain (PFTW → InstallShield → game files) ----
const res = await extractInstallerFromFiles(new Map([["MaxPayneDemo.exe", buf]]), {
    inflateRaw: (chunk) => new Uint8Array(inflateRawSync(chunk)),
    cabInflateBlock: (chunk, dict) => new Uint8Array(inflateRawSync(chunk, dict ? { dictionary: dict } : undefined)),
});
console.log(`  chain: via=${res.via}  note="${res.note}"  files=${res.gameFiles.size}`);
expect(res.via === "pftw", 'chain resolves via === "pftw"');
const gameNames = new Set([...res.gameFiles.keys()].map((n) => n.toLowerCase().replace(/\\/g, "/")));
for (const n of ["maxpaynedemo.exe", "x_demodatas.ras", "x_demolevels.ras"]) {
    expect(gameNames.has(n), `game tree contains ${n}`);
}
// InstallShield engine scaffolding must NOT leak into the game tree.
for (const n of ["ikernel.exe", "isrt.dll", "_isres.dll"]) {
    expect(!gameNames.has(n), `game tree excludes InstallShield engine file ${n}`);
}

console.log(fail === 0 ? "\nPASS" : `\nFAIL: ${fail} problem(s).`);
process.exit(fail === 0 ? 0 : 1);
