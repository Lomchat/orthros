/* tslint:disable */
/* eslint-disable */

/**
 * Extract every entry from an in-memory 7z archive.
 *
 * Returns a JS `Array` of `{ name: string, data: Uint8Array }`. Directory
 * entries are skipped (only files are returned). Unsupported coders (BCJ2,
 * PPMd, AES-encrypted streams) surface as a JS exception with a clear message.
 */
export function extract_7z(bytes: Uint8Array): Array<any>;

/**
 * Inflate a raw DEFLATE stream (no zlib/gzip header).
 *
 * `expected_size`, when provided, pre-sizes the output buffer for speed and is
 * used as the bound for the fixed-output path. When omitted, output grows
 * dynamically.
 */
export function inflate_raw(bytes: Uint8Array, expected_size?: number | null): Uint8Array;

/**
 * Decode a raw LZMA1 stream given explicit props, dictionary size, and the
 * uncompressed output size.
 *
 * `props` is the 5-byte LZMA props header in the *standard* encoding
 * (1 byte lc/lp/pb + 4 bytes LE dict size). If only the 1-byte lc/lp/pb is
 * supplied, `dict_size` is used to synthesise the 4 dict bytes.
 */
export function lzma_decode(props: Uint8Array, dict_size: number, data: Uint8Array, out_size: bigint): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly extract_7z: (a: number, b: number, c: number) => void;
    readonly inflate_raw: (a: number, b: number, c: number, d: number) => void;
    readonly lzma_decode: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
