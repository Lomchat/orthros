#!/usr/bin/env bun
/**
 * Generate the integrity descriptor consumed by the browser WGB cache.
 *
 * The raw-file SHA-256 is the stable bundle identity / HTTP ETag. Per-chunk
 * hashes let the browser validate and repair a resumable OPFS copy without
 * rereading or redownloading the entire multi-gigabyte bundle.
 */
import { createHash } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
if (!input) {
    console.error("usage: bun tools/generate-wgb-integrity.ts <bundle.wgb> [output.json] [chunkMiB] [segmentMiB]");
    process.exit(2);
}

const output = process.argv[3] ?? `${input}.integrity.json`;
const chunkSize = Math.max(1, Number(process.argv[4] ?? "2")) * 1024 * 1024;
const segmentSize = Math.max(chunkSize, Number(process.argv[5] ?? "64") * 1024 * 1024);
if (!Number.isSafeInteger(chunkSize) || !Number.isSafeInteger(segmentSize) || segmentSize % chunkSize !== 0) {
    throw new Error("chunkMiB and segmentMiB must be positive integers, with segmentMiB divisible by chunkMiB");
}

const info = await stat(input);
const globalHash = createHash("sha256");
let segmentHash = createHash("sha256");
let segmentBytes = 0;
const chunks: string[] = [];
const segments: string[] = [];

const inputHandle = await open(input, "r");
try {
    for (let position = 0; position < info.size; position += chunkSize) {
        const length = Math.min(chunkSize, info.size - position);
        const bytes = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
            const { bytesRead } = await inputHandle.read(bytes, filled, length - filled, position + filled);
            if (bytesRead <= 0) throw new Error(`short read at ${position + filled}/${info.size}`);
            filled += bytesRead;
        }
        globalHash.update(bytes);
        chunks.push(createHash("sha256").update(bytes).digest("hex"));

        let offset = 0;
        while (offset < bytes.byteLength) {
            const take = Math.min(segmentSize - segmentBytes, bytes.byteLength - offset);
            segmentHash.update(bytes.subarray(offset, offset + take));
            segmentBytes += take;
            offset += take;
            if (segmentBytes === segmentSize) {
                segments.push(segmentHash.digest("hex"));
                segmentHash = createHash("sha256");
                segmentBytes = 0;
            }
        }
    }
} finally {
    await inputHandle.close();
}
if (segmentBytes > 0) segments.push(segmentHash.digest("hex"));

const descriptor = {
    version: 1,
    algorithm: "sha256",
    file: path.basename(input),
    size: info.size,
    sha256: globalHash.digest("hex"),
    chunkSize,
    chunks,
    segmentSize,
    segments,
};

await writeFile(output, `${JSON.stringify(descriptor, null, 2)}\n`);
console.log(JSON.stringify({ output, size: info.size, sha256: descriptor.sha256, chunks: chunks.length, segments: segments.length }));
