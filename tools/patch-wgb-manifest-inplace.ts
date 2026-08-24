#!/usr/bin/env bun
/** Patch the stored manifest.json entry of a large WGB without rewriting its ROM. */
import * as fs from "node:fs";

const [archive, resolution] = process.argv.slice(2);
const match = resolution?.match(/^(\d+)x(\d+)$/);
if (!archive || !match) {
    throw new Error("usage: bun tools/patch-wgb-manifest-inplace.ts <game.wgb> <WxH>");
}

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

const fd = fs.openSync(archive, "r+");
try {
    const stat = fs.fstatSync(fd);
    const tailSize = Math.min(stat.size, 0xffff + 22);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("ZIP EOCD not found (ZIP64 is not supported by this patcher)");
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const entryCount = tail.readUInt16LE(eocd + 10);

    let centralPos = centralOffset;
    let centralManifest = -1;
    let localOffset = -1;
    let storedSize = -1;
    for (let i = 0; i < entryCount; i++) {
        const header = Buffer.alloc(46);
        fs.readSync(fd, header, 0, header.length, centralPos);
        if (header.readUInt32LE(0) !== 0x02014b50) throw new Error(`bad central header at ${centralPos}`);
        const nameLen = header.readUInt16LE(28);
        const extraLen = header.readUInt16LE(30);
        const commentLen = header.readUInt16LE(32);
        const name = Buffer.alloc(nameLen);
        fs.readSync(fd, name, 0, nameLen, centralPos + 46);
        if (name.toString("utf8") === "manifest.json") {
            if (header.readUInt16LE(10) !== 0) throw new Error("manifest.json must be STORE-compressed");
            centralManifest = centralPos;
            localOffset = header.readUInt32LE(42);
            storedSize = header.readUInt32LE(20);
            break;
        }
        centralPos += 46 + nameLen + extraLen + commentLen;
    }
    if (centralManifest < 0) throw new Error("manifest.json not found");

    const local = Buffer.alloc(30);
    fs.readSync(fd, local, 0, local.length, localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("bad manifest local header");
    const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const data = Buffer.alloc(storedSize);
    fs.readSync(fd, data, 0, data.length, dataOffset);
    const manifest = JSON.parse(data.toString("utf8"));
    manifest.emulator ??= {};
    manifest.emulator.screenResolution ??= {};
    manifest.emulator.screenResolution.width = Number(match[1]);
    manifest.emulator.screenResolution.height = Number(match[2]);

    let encoded = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    // A wider resolution can add one or two digits to the pretty-printed
    // manifest. The entry is STORE-compressed and fixed-size, so fall back to
    // semantically identical compact JSON before rejecting the update.
    if (encoded.length > storedSize) {
        encoded = Buffer.from(JSON.stringify(manifest), "utf8");
    }
    if (encoded.length > storedSize) {
        throw new Error(`updated manifest grew from ${storedSize} to ${encoded.length} bytes`);
    }
    const padded = Buffer.alloc(storedSize, 0x20);
    encoded.copy(padded);
    const crc = crc32(padded);
    const crcBytes = Buffer.alloc(4);
    crcBytes.writeUInt32LE(crc, 0);
    fs.writeSync(fd, padded, 0, padded.length, dataOffset);
    fs.writeSync(fd, crcBytes, 0, 4, localOffset + 14);
    fs.writeSync(fd, crcBytes, 0, 4, centralManifest + 16);
    fs.fsyncSync(fd);
    console.log(`Patched ${archive}: screenResolution=${match[1]}x${match[2]}, crc=0x${crc.toString(16)}`);
} finally {
    fs.closeSync(fd);
}
