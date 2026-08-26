#!/usr/bin/env bun
/**
 * InstallShield component→destination LAYOUT smoke test (MANUAL — no archives committed).
 *
 * Proves the browser extractor (`extractInstallShield`) places files into their
 * real install layout via the cabinet header's component→destination→file-group
 * mapping (NOT extension heuristics, NOT InstallScript emulation) for a FLAT
 * installer, and that it does NOT regress an installer that uses real cabinet
 * directories.
 *
 *   HP1 demo (InstallShield 6, EVERY file in cabinet dir ""): asserts the game
 *     files land under System/, Maps/, Textures/, Sounds/, Music/, Help/ and the
 *     InstallShield runtime (_IsRes.dll / ikernel.exe / setup.inx) is dropped.
 *   NFS-Porsche (InstallShield 5, real cabinet dirs): asserts the 407-file tree
 *     still comes through with Porsche.exe at root + Drivers/FEDATA/GameData.
 *
 * Setup (do NOT commit the archives):
 *   HP:      "/c/Program Files/7-Zip/7z.exe" x -y -otmp/hp ~/Downloads/hp1_demo.7z
 *            (yields tmp/hp/hp1_demo/{data1.hdr,data1.cab,data2.cab})
 *   Porsche: copy ~/Downloads/Porsche.zip -> tmp/Porsche.zip
 *
 * Run:  bun tools/tests/installshield-layout.smoke.ts
 *
 * Bun lacks DecompressionStream, so node zlib.inflateRawSync is injected via the
 * `inflateRaw` hook — exactly like tools/tests/installshield.test.ts.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { inflateRawSync } from "zlib";
import {
    extractInstallShield,
    parseInstallShieldHeader,
    detectInstallShieldStem,
} from "@orthros/formats/installshield/index.ts";

const nodeInflate = (chunk: Uint8Array) => new Uint8Array(inflateRawSync(Buffer.from(chunk)));

const ROOT = join(import.meta.dir, "..", "..");
const HP_DIR = join(ROOT, "tmp", "hp", "hp1_demo");
const PORSCHE_ZIP = join(ROOT, "tmp", "Porsche.zip");

let failed = false;
function assert(cond: boolean, msg: string) {
    if (!cond) {
        console.error(`  FAIL: ${msg}`);
        failed = true;
    } else {
        console.log(`  ok: ${msg}`);
    }
}

// ----------------------------- HP1 demo (flat IS6) -----------------------------
async function testHp() {
    console.log("\n=== HP1 demo (InstallShield 6, flat cabinet dir) ===");
    if (!existsSync(join(HP_DIR, "data1.hdr"))) {
        console.error(
            `  SKIP: ${HP_DIR}/data1.hdr not found.\n` +
                `        Extract first: "/c/Program Files/7-Zip/7z.exe" x -y -otmp/hp ~/Downloads/hp1_demo.7z`,
        );
        failed = true;
        return;
    }
    const hdr = new Uint8Array(readFileSync(join(HP_DIR, "data1.hdr")));
    const volumes = new Map<number, Uint8Array>([
        [1, new Uint8Array(readFileSync(join(HP_DIR, "data1.cab")))],
        [2, new Uint8Array(readFileSync(join(HP_DIR, "data2.cab")))],
    ]);

    const info = parseInstallShieldHeader(hdr);
    console.log(
        `  parsed: major=${info.major} files=${info.files.length} ` +
            `components=${info.components.length} fileGroups=${info.fileGroups.length} ` +
            `mapped=${info.installDirByIndex.size}`,
    );
    // sanity: the component→destination map must be present and useful here.
    assert(info.components.length > 0, "components parsed");
    assert(info.installDirByIndex.size > 0, "file→destination map non-empty");

    const t0 = Date.now();
    const out = await extractInstallShield(hdr, volumes, {
        verifySize: true,
        verifyMd5: true,
        inflateRaw: nodeInflate,
    });
    console.log(`  extracted ${out.size} files in ${Date.now() - t0}ms`);
    const keys = [...out.keys()];
    const has = (p: string) => keys.some((k) => k.toLowerCase() === p.toLowerCase());

    // Game files at their real install destinations.
    for (const p of [
        "System/HPDemo.exe",
        "System/Engine.dll",
        "System/Core.dll",
        "Maps/startup.unr",
        "Textures/HP_1st.utx",
        "Sounds/AllDialog.uax",
        "Music/Phoenix.umx",
        "Help/Splash0.bmp",
    ]) {
        assert(has(p), `${p} present`);
    }

    // InstallShield runtime files must be ABSENT (anywhere in the tree).
    const baseLower = (k: string) => (k.split("/").pop() ?? k).toLowerCase();
    for (const rt of ["_isres.dll", "ikernel.exe", "setup.inx"]) {
        assert(!keys.some((k) => baseLower(k) === rt), `${rt} dropped`);
    }

    // No file should land flat at the root System-less — spot-check a few dirs exist.
    const dirsSeen = new Set(keys.map((k) => (k.includes("/") ? k.split("/")[0] : "")));
    console.log(`  top-level dirs: ${[...dirsSeen].sort().join(", ")}`);
    for (const d of ["System", "Maps", "Textures", "Sounds", "Music", "Help"]) {
        assert(dirsSeen.has(d), `top-level dir ${d}/ present`);
    }
}

// ----------------------------- Porsche (real dirs, IS5) ------------------------
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

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
    const dec = new TextDecoder("utf-8");
    const out = new Map<string, Uint8Array>();
    let off = cdOff;
    const cdEnd = cdOff + cdSize;
    while (off + 46 <= cdEnd) {
        if (dv.getUint32(off, true) !== CEN_SIG) break;
        const compression = dv.getUint16(off + 10, true);
        const compressedSize = dv.getUint32(off + 20, true);
        const nameLen = dv.getUint16(off + 28, true);
        const extraLen = dv.getUint16(off + 30, true);
        const commentLen = dv.getUint16(off + 32, true);
        const localHeaderOffset = dv.getUint32(off + 42, true);
        const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
        off += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith("/")) continue;
        const lhNameLen = dv.getUint16(localHeaderOffset + 26, true);
        const lhExtraLen = dv.getUint16(localHeaderOffset + 28, true);
        const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compressedSize);
        const data =
            compression === 0
                ? raw
                : new Uint8Array(inflateRawSync(Buffer.from(raw)));
        out.set(name, data);
    }
    return out;
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

async function testPorsche() {
    console.log("\n=== NFS-Porsche (InstallShield 5, real cabinet dirs) ===");
    if (!existsSync(PORSCHE_ZIP)) {
        console.error(`  SKIP: ${PORSCHE_ZIP} not found (copy from ~/Downloads/Porsche.zip).`);
        failed = true;
        return;
    }
    const files = readZip(new Uint8Array(readFileSync(PORSCHE_ZIP)));
    const byBase = new Map<string, Uint8Array>();
    for (const [k, v] of files) byBase.set(basename(k).toLowerCase(), v);

    const stem = detectInstallShieldStem([...files.keys()]);
    assert(stem === "data", `stem detection -> "${stem}" (expect data)`);
    const hdr = byBase.get(`${stem}1.hdr`);
    if (!hdr) throw new Error(`${stem}1.hdr not found`);
    const volumes = new Map<number, Uint8Array>();
    const cabRe = new RegExp(`^${stem}(\\d+)\\.cab$`);
    for (const [low, bytes] of byBase) {
        const m = cabRe.exec(low);
        if (m) volumes.set(Number(m[1]), bytes);
    }

    const out = await extractInstallShield(hdr, volumes, {
        verifySize: true,
        verifyMd5: true,
        inflateRaw: nodeInflate,
    });
    const keys = [...out.keys()];
    console.log(`  extracted ${out.size} files`);
    assert(out.size === 407, `407 files (got ${out.size})`);
    assert(keys.some((k) => /(^|\/)Porsche\.exe$/i.test(k)), "Porsche.exe present");
    assert(keys.some((k) => /(^|\/)Drivers[\\/]/i.test(k)), "Drivers/ present");
    assert(keys.some((k) => /^FEDATA[\\/]/i.test(k)), "FEDATA/ present");
    assert(keys.some((k) => /^GameData[\\/]/i.test(k)), "GameData/ present");
    // Porsche.exe is a root file (cabinet dir "") — must stay at root, not get
    // shoved into a component destination.
    assert(keys.includes("Porsche.exe"), "Porsche.exe at root (not nested)");
}

async function main() {
    await testHp();
    await testPorsche();
    if (failed) {
        console.error("\nLAYOUT SMOKE TEST FAILED");
        process.exit(1);
    }
    console.log("\nLAYOUT SMOKE TEST PASSED");
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
