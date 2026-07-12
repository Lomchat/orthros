import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { decodeAnsiString, encodeAnsiString, getAnsiCodePage } from "./codepage-utils";

// WinInet error codes
const ERROR_INTERNET_INVALID_URL         = 12005;
const ERROR_INTERNET_EXTENDED_ERROR      = 12003;
const ERROR_INSUFFICIENT_BUFFER          = 122;
const ERROR_INVALID_PARAMETER            = 87;
const ERROR_INTERNET_ITEM_NOT_FOUND      = 12028;

// InternetSetOptionEx flags
const ISO_GLOBAL = 0x00000001;

// INTERNET_FLAG_NEED_FILE etc — not needed, just for reference

// URL_COMPONENTS field offsets (ANSI, all DWORD unless noted)
// dwStructSize       +0
// lpszScheme         +4   (ptr)
// dwSchemeLength     +8
// nScheme            +12  (INTERNET_SCHEME enum)
// lpszHostName       +16  (ptr)
// dwHostNameLength   +20
// nPort              +24  (INTERNET_PORT = WORD, padded to DWORD in struct)
// lpszUserName       +28  (ptr)
// dwUserNameLength   +32
// lpszPassword       +36  (ptr)
// dwPasswordLength   +40
// lpszUrlPath        +44  (ptr)
// dwUrlPathLength    +48
// lpszExtraInfo      +52  (ptr)
// dwExtraInfoLength  +56
// sizeof = 60
const URL_COMPONENTS_SIZE = 60;

// INTERNET_SCHEME values
const INTERNET_SCHEME_HTTP  = 3;
const INTERNET_SCHEME_HTTPS = 4;
const INTERNET_SCHEME_FTP   = 1;
const INTERNET_SCHEME_FILE  = 8;

// Default ports
const INTERNET_DEFAULT_HTTP_PORT  = 80;
const INTERNET_DEFAULT_HTTPS_PORT = 443;
const INTERNET_DEFAULT_FTP_PORT   = 21;
const INTERNET_INVALID_PORT_NUMBER = 0;

// ICU_ flags for InternetCanonicalizeUrlA
const ICU_NO_ENCODE    = 0x20000000;
const ICU_DECODE       = 0x10000000;
const ICU_NO_META      = 0x08000000;
const ICU_ENCODE_SPACES_ONLY = 0x04000000;
const ICU_BROWSER_MODE = 0x02000000;

const TRUE  = 1;
const FALSE = 0;

/** Read a null-terminated ANSI string from guest memory, up to maxLen bytes. */
function readGuestStringA(mem: Uint8Array, ptr: number, maxLen = 2048): string {
    if (!ptr) return "";
    let len = 0;
    while (len < maxLen && ptr + len < mem.length && mem[ptr + len] !== 0) len++;
    // Decode with the active ANSI code page, consistent with every other ANSI reader
    // (and with writeGuestStringA below) — not a hardcoded windows-1252.
    return decodeAnsiString(mem, ptr, len, getAnsiCodePage());
}

/** Write a null-terminated ANSI string into guest memory; returns byte count written (including NUL). */
function writeGuestStringA(mem: Uint8Array, ptr: number, str: string, maxLen: number): number {
    if (!ptr || maxLen <= 0) return 0;
    // Encode with the active ANSI code page (was UTF-8, which round-tripped every
    // byte >= 0x80 to a different, longer sequence than readGuestStringA decoded).
    const encoded = encodeAnsiString(str, getAnsiCodePage());
    const copyLen = Math.min(encoded.length, maxLen - 1);
    for (let i = 0; i < copyLen; i++) mem[ptr + i] = encoded[i]!;
    mem[ptr + copyLen] = 0;
    return copyLen + 1;
}

/** Percent-encode characters not allowed in URLs (ASCII safe subset). */
function percentEncode(raw: string): string {
    // We let encodeURI handle the bulk; only additionally encode characters
    // that are technically allowed by encodeURI but should be encoded for canonical form.
    return encodeURI(raw).replace(/#/g, "%23");
}

/** Minimal URL canonicaliser matching WinInet semantics for the stub world. */
function canonicalizeUrl(url: string, flags: number): string {
    if (flags & ICU_DECODE) {
        try { url = decodeURIComponent(url.replace(/\+/g, " ")); } catch { /* leave as-is */ }
    }
    if (!(flags & ICU_NO_ENCODE)) {
        // Encode unsafe characters while preserving already-encoded sequences
        url = url.replace(/[^\x21-\x7E]/g, (ch) => encodeURIComponent(ch));
    }
    if (!(flags & ICU_NO_META)) {
        // Collapse /./  and /../ in the path component
        try {
            const u = new URL(url);
            // URL constructor already resolves dot segments in the pathname
            url = u.toString();
        } catch {
            // Relative URL or malformed — best effort path collapse
            url = url.replace(/\/\.\//, "/").replace(/\/[^/]+\/\.\.\//, "/");
        }
    }
    return url;
}

export class Wininet implements IModule {
    name = "wininet";
    exports: Record<string, ThunkImplementation> = {};

    /** Stored per-session extended error info written by InternetGetLastResponseInfoA. */
    private lastErrorCode = 0;
    private lastErrorText = "";

    initialize(_process: Process): void {

        // ── Existing stubs ──────────────────────────────────────────────────

        // InternetOpenA/W — returns NULL (no internet)
        this.exports["InternetOpenA"] = this.exports["InternetOpenW"] = (_ctx, _mem, _args) => {
            Logger.info(LogCategory.SYSTEM, "wininet:InternetOpen: stub, returning NULL (no internet)");
            return { value: 0, stackCleanup: 20 };
        };

        // InternetOpenUrlA/W — returns NULL
        this.exports["InternetOpenUrlA"] = this.exports["InternetOpenUrlW"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 24 };
        };

        // InternetConnectA/W — returns NULL
        this.exports["InternetConnectA"] = this.exports["InternetConnectW"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 32 };
        };

        // HttpOpenRequestA/W — returns NULL
        this.exports["HttpOpenRequestA"] = this.exports["HttpOpenRequestW"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 32 };
        };

        // HttpSendRequestA/W — returns FALSE
        this.exports["HttpSendRequestA"] = this.exports["HttpSendRequestW"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 20 };
        };

        // HttpQueryInfoA/W — returns FALSE
        this.exports["HttpQueryInfoA"] = this.exports["HttpQueryInfoW"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 20 };
        };

        // InternetReadFile — returns FALSE
        this.exports["InternetReadFile"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 16 };
        };

        // InternetCloseHandle — returns TRUE
        this.exports["InternetCloseHandle"] = (_ctx, _mem, _args) => {
            return { value: 1, stackCleanup: 4 };
        };

        // InternetSetOptionA/W — returns TRUE
        this.exports["InternetSetOptionA"] = this.exports["InternetSetOptionW"] = (_ctx, _mem, _args) => {
            return { value: 1, stackCleanup: 16 };
        };

        // InternetQueryOptionA/W — returns FALSE
        this.exports["InternetQueryOptionA"] = this.exports["InternetQueryOptionW"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 16 };
        };

        // InternetGetConnectedState — returns FALSE (not connected)
        this.exports["InternetGetConnectedState"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 8 };
        };

        // InternetCheckConnectionA/W — returns FALSE
        this.exports["InternetCheckConnectionA"] = this.exports["InternetCheckConnectionW"] = (_ctx, _mem, _args) => {
            return { value: 0, stackCleanup: 12 };
        };

        // ── New implementations ─────────────────────────────────────────────

        /**
         * BOOL InternetSetOptionExA(
         *     HINTERNET hInternet,   // args[0]
         *     DWORD     dwOption,    // args[1]
         *     LPVOID    lpBuffer,    // args[2]
         *     DWORD     dwBufferLength, // args[3]
         *     DWORD     dwFlags      // args[4]
         * )
         *
         * Since all handles are NULL (no real internet session), we accept
         * ISO_GLOBAL calls silently and reject per-handle calls with
         * ERROR_INVALID_PARAMETER. Either way we return TRUE so callers
         * that probe options during startup don't fail hard.
         */
        this.exports["InternetSetOptionExA"] = (_ctx, _mem, args) => {
            const hInternet  = args[0] >>> 0;
            const dwOption   = args[1] >>> 0;
            const dwFlags    = args[4] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `wininet:InternetSetOptionExA(h=0x${hInternet.toString(16)}, opt=${dwOption}, flags=0x${dwFlags.toString(16)}) -> TRUE`
            );
            return { value: TRUE, stackCleanup: 20 };
        };

        /**
         * INTERNET_STATUS_CALLBACK InternetSetStatusCallback(
         *     HINTERNET                hInternet,  // args[0]
         *     INTERNET_STATUS_CALLBACK lpfnInternetCallback // args[1]
         * )
         *
         * Returns the previous callback (NULL — no previous). Because no
         * real requests are ever in flight the callback will never fire,
         * so we just park it silently.
         */
        this.exports["InternetSetStatusCallback"] = (_ctx, _mem, args) => {
            const hInternet = args[0] >>> 0;
            const lpfnCb    = args[1] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `wininet:InternetSetStatusCallback(h=0x${hInternet.toString(16)}, cb=0x${lpfnCb.toString(16)}) -> NULL (prev)`
            );
            // Return INTERNET_INVALID_STATUS_CALLBACK (0xFFFFFFFF) on error,
            // NULL for "no previous callback" on success. Handle is always NULL
            // in this stub world so treat as valid-enough and return NULL prev.
            return { value: 0, stackCleanup: 8 };
        };

        /**
         * BOOL InternetWriteFile(
         *     HINTERNET hFile,        // args[0]
         *     LPCVOID   lpBuffer,     // args[1]
         *     DWORD     dwNumberOfBytesToWrite, // args[2]
         *     LPDWORD   lpdwNumberOfBytesWritten // args[3]
         * )
         *
         * No live handles exist; write 0 bytes written and return FALSE.
         * Writes 0 into *lpdwNumberOfBytesWritten so callers don't see
         * garbage.
         */
        this.exports["InternetWriteFile"] = (_ctx, _mem, args) => {
            const lpdwWritten = args[3] >>> 0;
            if (lpdwWritten) Mem.writeUint32(lpdwWritten, 0);
            this.setLastError(ERROR_INVALID_PARAMETER);
            Logger.verbose(LogCategory.SYSTEM, "wininet:InternetWriteFile -> FALSE (no handle)");
            return { value: FALSE, stackCleanup: 16 };
        };

        /**
         * DWORD InternetSetFilePointer(
         *     HINTERNET hFile,            // args[0]
         *     LONG      lDistanceToMove,  // args[1]
         *     LPVOID    pReserved,        // args[2]  (must be NULL)
         *     DWORD     dwMoveMethod,     // args[3]
         *     DWORD     dwContext         // args[4]
         * )
         *
         * Returns INVALID_SET_FILE_POINTER (0xFFFFFFFF) — no seekable handle.
         */
        this.exports["InternetSetFilePointer"] = (_ctx, _mem, args) => {
            const hFile = args[0] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `wininet:InternetSetFilePointer(h=0x${hFile.toString(16)}) -> INVALID_SET_FILE_POINTER`
            );
            this.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0xFFFFFFFF, stackCleanup: 20 };
        };

        /**
         * BOOL InternetQueryDataAvailable(
         *     HINTERNET hFile,                     // args[0]
         *     LPDWORD   lpdwNumberOfBytesAvailable, // args[1]
         *     DWORD     dwFlags,                   // args[2]
         *     DWORD_PTR dwContext                  // args[3]
         * )
         *
         * No data is ever available (no live connection). Writes 0 into
         * *lpdwNumberOfBytesAvailable and returns TRUE per MSDN — the
         * function succeeds even when 0 bytes are available; EOF is inferred
         * by the caller when a subsequent ReadFile returns 0.
         */
        this.exports["InternetQueryDataAvailable"] = (_ctx, _mem, args) => {
            const lpdwAvail = args[1] >>> 0;
            if (lpdwAvail) Mem.writeUint32(lpdwAvail, 0);
            Logger.verbose(
                LogCategory.SYSTEM,
                "wininet:InternetQueryDataAvailable -> TRUE, 0 bytes available"
            );
            return { value: TRUE, stackCleanup: 16 };
        };

        /**
         * BOOL InternetCanonicalizeUrlA(
         *     LPCSTR lpszUrl,         // args[0]
         *     LPSTR  lpszBuffer,      // args[1]
         *     LPDWORD lpdwBufferLength, // args[2]
         *     DWORD  dwFlags          // args[3]
         * )
         *
         * Canonicalises the URL in-process (no network call needed).
         * Returns FALSE + ERROR_INSUFFICIENT_BUFFER when the buffer is too
         * small, updating *lpdwBufferLength to the required byte count
         * (including NUL), matching WinInet semantics.
         */
        this.exports["InternetCanonicalizeUrlA"] = (_ctx, mem, args) => {
            const lpszUrl    = args[0] >>> 0;
            const lpszBuffer = args[1] >>> 0;
            const lpdwBufLen = args[2] >>> 0;
            const dwFlags    = args[3] >>> 0;

            if (!lpszUrl || !lpdwBufLen) {
                this.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 16 };
            }

            const url = readGuestStringA(mem, lpszUrl);
            const canonical = canonicalizeUrl(url, dwFlags);
            const needed = canonical.length + 1; // NUL terminator

            const bufLen = Mem.readUint32(lpdwBufLen) ?? 0;

            if (!lpszBuffer || bufLen < needed) {
                Mem.writeUint32(lpdwBufLen, needed);
                this.setLastError(ERROR_INSUFFICIENT_BUFFER);
                Logger.verbose(
                    LogCategory.SYSTEM,
                    `wininet:InternetCanonicalizeUrlA("${url}") -> FALSE, need ${needed} bytes`
                );
                return { value: FALSE, stackCleanup: 16 };
            }

            writeGuestStringA(mem, lpszBuffer, canonical, bufLen);
            Mem.writeUint32(lpdwBufLen, canonical.length); // written length excl. NUL, per MSDN
            Logger.verbose(
                LogCategory.SYSTEM,
                `wininet:InternetCanonicalizeUrlA("${url}") -> "${canonical}"`
            );
            return { value: TRUE, stackCleanup: 16 };
        };

        /**
         * BOOL InternetGetLastResponseInfoA(
         *     LPDWORD lpdwError,       // args[0]  — extended error code
         *     LPSTR   lpszBuffer,      // args[1]  — text buffer
         *     LPDWORD lpdwBufferLength // args[2]  — in/out buffer size
         * )
         *
         * Returns the stored extended error info set by the last failed
         * WinInet call. In this stub implementation that is always an empty
         * string with code 0 (no real requests take place).
         */
        this.exports["InternetGetLastResponseInfoA"] = (_ctx, mem, args) => {
            const lpdwError   = args[0] >>> 0;
            const lpszBuffer  = args[1] >>> 0;
            const lpdwBufLen  = args[2] >>> 0;

            if (lpdwError)  Mem.writeUint32(lpdwError, this.lastErrorCode);

            const text   = this.lastErrorText;
            const needed = text.length + 1;

            if (!lpdwBufLen) {
                this.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 12 };
            }

            const bufLen = Mem.readUint32(lpdwBufLen) ?? 0;
            if (!lpszBuffer || bufLen < needed) {
                Mem.writeUint32(lpdwBufLen, needed);
                this.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return { value: FALSE, stackCleanup: 12 };
            }

            writeGuestStringA(mem, lpszBuffer, text, bufLen);
            Mem.writeUint32(lpdwBufLen, text.length);

            Logger.verbose(
                LogCategory.SYSTEM,
                `wininet:InternetGetLastResponseInfoA -> code=${this.lastErrorCode}, text="${text}"`
            );
            return { value: TRUE, stackCleanup: 12 };
        };

        /**
         * BOOL InternetCrackUrlA(
         *     LPCSTR          lpszUrl,        // args[0]
         *     DWORD           dwUrlLength,    // args[1]  0 = use strlen
         *     DWORD           dwFlags,        // args[2]
         *     LPURL_COMPONENTS lpUrlComponents // args[3]
         * )
         *
         * Parses the URL into the URL_COMPONENTS struct at lpUrlComponents.
         * Per MSDN: if a component pointer is NULL its length field is
         * ignored. If the pointer is non-NULL and the length is 0, the
         * pointer is set to point into the original URL string (not copied).
         * If both are non-zero the component is copied into the supplied
         * buffer and the length field is updated to the component length
         * (excluding NUL).
         *
         * Struct layout (ANSI, x86):
         *   +0   dwStructSize        DWORD
         *   +4   lpszScheme          DWORD ptr
         *   +8   dwSchemeLength      DWORD
         *   +12  nScheme             DWORD (INTERNET_SCHEME)
         *   +16  lpszHostName        DWORD ptr
         *   +20  dwHostNameLength    DWORD
         *   +24  nPort               DWORD (stored as DWORD on x86)
         *   +28  lpszUserName        DWORD ptr
         *   +32  dwUserNameLength    DWORD
         *   +36  lpszPassword        DWORD ptr
         *   +40  dwPasswordLength    DWORD
         *   +44  lpszUrlPath         DWORD ptr
         *   +48  dwUrlPathLength     DWORD
         *   +52  lpszExtraInfo       DWORD ptr
         *   +56  dwExtraInfoLength   DWORD
         */
        this.exports["InternetCrackUrlA"] = (_ctx, mem, args) => {
            const lpszUrl        = args[0] >>> 0;
            const dwUrlLength    = args[1] >>> 0;
            const dwFlags        = args[2] >>> 0;
            const lpUrlComponents = args[3] >>> 0;

            if (!lpszUrl || !lpUrlComponents) {
                this.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 16 };
            }

            // Read the struct size for validation
            const structSize = Mem.readUint32(lpUrlComponents) ?? 0;
            if (structSize !== URL_COMPONENTS_SIZE) {
                Logger.verbose(
                    LogCategory.SYSTEM,
                    `wininet:InternetCrackUrlA — bad dwStructSize ${structSize}, expected ${URL_COMPONENTS_SIZE}`
                );
                this.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 16 };
            }

            // Read the URL string from guest memory
            const maxLen = dwUrlLength > 0 ? dwUrlLength : 2048;
            let urlStr = readGuestStringA(mem, lpszUrl, maxLen);
            if (dwUrlLength > 0) urlStr = urlStr.slice(0, dwUrlLength);

            // Optionally decode percent-encoding before parsing
            if (dwFlags & ICU_DECODE) {
                try { urlStr = decodeURIComponent(urlStr.replace(/\+/g, " ")); } catch { /* keep as-is */ }
            }

            // Parse with the built-in URL constructor; fall back to a regex
            // for relative/scheme-only strings the parser may reject.
            let scheme = "", host = "", portStr = "", user = "", pass = "", path = "", extra = "";
            let nPort = INTERNET_INVALID_PORT_NUMBER;
            let nScheme = 0;

            try {
                const u = new URL(urlStr);
                scheme  = u.protocol.replace(/:$/, "");          // "http", "https", …
                host    = u.hostname;
                portStr = u.port;
                user    = decodeURIComponent(u.username);
                pass    = decodeURIComponent(u.password);
                path    = u.pathname;
                extra   = u.search + u.hash;                      // "?query#fragment"
                nPort   = portStr ? parseInt(portStr, 10) : defaultPortForScheme(scheme);
                nScheme = schemeToEnum(scheme);
            } catch {
                // Malformed URL — propagate ERROR_INTERNET_INVALID_URL
                Logger.verbose(LogCategory.SYSTEM, `wininet:InternetCrackUrlA — URL parse failed for "${urlStr}"`);
                this.setLastError(ERROR_INTERNET_INVALID_URL);
                return { value: FALSE, stackCleanup: 16 };
            }

            // Helper: write a component field pair (ptr+len) into the struct.
            // offsetPtr  = byte offset of the DWORD pointer field in URL_COMPONENTS
            // offsetLen  = byte offset of the DWORD length field
            // component  = the parsed component string (without NUL)
            // srcOffset  = byte offset of component start inside the original URL string
            //              (used for the "point into original" mode)
            const writeComponent = (
                offsetPtr: number,
                offsetLen: number,
                component: string,
                srcOffset: number
            ): boolean => {
                const ptrVal = Mem.readUint32(lpUrlComponents + offsetPtr) ?? 0;
                const lenVal = Mem.readUint32(lpUrlComponents + offsetLen) ?? 0;

                if (ptrVal === 0) {
                    // Caller doesn't want this component
                    return true;
                }

                if (ptrVal !== 0 && lenVal === 0) {
                    // Point into original URL — store pointer to the component
                    // within the guest URL string and write back the length.
                    const compPtr = lpszUrl + srcOffset;
                    Mem.writeUint32(lpUrlComponents + offsetPtr, compPtr);
                    Mem.writeUint32(lpUrlComponents + offsetLen, component.length);
                    return true;
                }

                // Copy into caller-supplied buffer
                if (component.length + 1 > lenVal) {
                    this.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return false;
                }
                writeGuestStringA(mem, ptrVal, component, lenVal);
                Mem.writeUint32(lpUrlComponents + offsetLen, component.length);
                return true;
            };

            // Locate component offsets inside the raw URL string for
            // "point into original" mode.
            const schemeEnd   = urlStr.indexOf("://");
            const schemeStart = 0;
            const authorityStart = schemeEnd >= 0 ? schemeEnd + 3 : 0;
            const atSign      = urlStr.indexOf("@", authorityStart);
            const hostStart   = atSign >= 0 ? atSign + 1 : authorityStart;
            const pathStart   = urlStr.indexOf("/", hostStart);
            const qStart      = urlStr.indexOf("?", pathStart >= 0 ? pathStart : hostStart);
            const hashStart   = urlStr.indexOf("#", qStart >= 0 ? qStart : (pathStart >= 0 ? pathStart : hostStart));
            const extraStart  = qStart >= 0 ? qStart : (hashStart >= 0 ? hashStart : urlStr.length);

            let userStart = 0, passStart = 0;
            if (atSign >= 0) {
                const colonInAuth = urlStr.indexOf(":", authorityStart);
                userStart = authorityStart;
                passStart = colonInAuth >= 0 && colonInAuth < atSign ? colonInAuth + 1 : atSign;
            }

            // Write nScheme and nPort (always updated)
            Mem.writeUint32(lpUrlComponents + 12, nScheme);
            Mem.writeUint32(lpUrlComponents + 24, nPort);

            // Write each component
            if (!writeComponent(4,  8,  scheme,    schemeStart))       return { value: FALSE, stackCleanup: 16 };
            if (!writeComponent(16, 20, host,      hostStart))         return { value: FALSE, stackCleanup: 16 };
            if (!writeComponent(28, 32, user,      userStart))         return { value: FALSE, stackCleanup: 16 };
            if (!writeComponent(36, 40, pass,      passStart))         return { value: FALSE, stackCleanup: 16 };
            if (!writeComponent(44, 48, path,      pathStart >= 0 ? pathStart : urlStr.length)) return { value: FALSE, stackCleanup: 16 };
            if (!writeComponent(52, 56, extra,     extraStart))        return { value: FALSE, stackCleanup: 16 };

            Logger.verbose(
                LogCategory.SYSTEM,
                `wininet:InternetCrackUrlA("${urlStr}") -> scheme=${scheme} host=${host}:${nPort} path=${path}`
            );
            return { value: TRUE, stackCleanup: 16 };
        };
    }

    reset(): void {
        this.lastErrorCode = 0;
        this.lastErrorText = "";
    }

    private setLastError(code: number): void {
        System.getInstance().scheduler.setLastError(code);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function schemeToEnum(scheme: string): number {
    switch (scheme.toLowerCase()) {
        case "ftp":   return INTERNET_SCHEME_FTP;
        case "http":  return INTERNET_SCHEME_HTTP;
        case "https": return INTERNET_SCHEME_HTTPS;
        case "file":  return INTERNET_SCHEME_FILE;
        default:      return 0;
    }
}

function defaultPortForScheme(scheme: string): number {
    switch (scheme.toLowerCase()) {
        case "http":  return INTERNET_DEFAULT_HTTP_PORT;
        case "https": return INTERNET_DEFAULT_HTTPS_PORT;
        case "ftp":   return INTERNET_DEFAULT_FTP_PORT;
        default:      return INTERNET_INVALID_PORT_NUMBER;
    }
}
