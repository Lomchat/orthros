import { createHash } from 'node:crypto';
import { copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const source = path.join(root, 'vendor/v86/build/v86.wasm');
const destination = path.join(root, 'public/v86.wasm');

const digest = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');

let sourceBytes: Uint8Array;
try {
    sourceBytes = await readFile(source);
} catch (error) {
    throw new Error(
        `Missing ${path.relative(root, source)}; build the v86 submodule before building Orthros`,
        { cause: error },
    );
}

const sourceHash = digest(sourceBytes);
let destinationHash: string | null = null;
try {
    destinationHash = digest(await readFile(destination));
} catch {
    // A fresh checkout may not have the public artifact yet.
}

if (destinationHash !== sourceHash) {
    await copyFile(source, destination);
}

const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
const verifiedHash = digest(await readFile(destination));
if (verifiedHash !== sourceHash || destinationStat.size !== sourceStat.size) {
    throw new Error('v86.wasm synchronization failed: public artifact differs from the submodule build');
}

console.log(
    `[v86] ${destinationHash === sourceHash ? 'verified' : 'synchronized'} ` +
    `${sourceStat.size} bytes sha256=${sourceHash.slice(0, 16)}`,
);
