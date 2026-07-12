/**
 * VFS CreateDirectory + CreateFile path semantics (NFSU ZDIR.BIN pattern).
 */
import { describe, expect, test, beforeEach } from "bun:test";

// Minimal harness: exercise VirtualFileSystem without OPFS by mocking overlay later.
// We test path helpers via a lightweight stand-in that mirrors the logic under test.

function normalizePath(path: string): string {
    const cleaned = path.replace(/\//g, "\\");
    const driveMatch = cleaned.match(/^([A-Za-z]):/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : "C";
    const rest = cleaned.replace(/^[A-Za-z]:\\?/, "");
    const parts = rest.split("\\").filter(Boolean);
    const stack: string[] = [];
    for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") {
            stack.pop();
            continue;
        }
        stack.push(part);
    }
    return `${drive}:\\${stack.join("\\")}`;
}

function parentDirectoryExists(
    fullPath: string,
    directoryExists: (p: string) => boolean,
): boolean {
    const normalized = normalizePath(fullPath);
    const lastSlash = normalized.lastIndexOf("\\");
    if (lastSlash <= 2) return true;
    return directoryExists(normalized.slice(0, lastSlash));
}

describe("VFS create path semantics", () => {
    const dirs = new Set<string>(["C:\\"]);

    const directoryExists = (p: string) => dirs.has(normalizePath(p));

    beforeEach(() => {
        dirs.clear();
        dirs.add("C:\\");
    });

    test("ZDIR.BIN requires NFSUNDER parent", () => {
        expect(parentDirectoryExists("C:\\NFSUNDER\\ZDIR.BIN", directoryExists)).toBe(false);
        dirs.add("C:\\NFSUNDER");
        expect(parentDirectoryExists("C:\\NFSUNDER\\ZDIR.BIN", directoryExists)).toBe(true);
    });

    test("CreateDirectory registers parent before file create", () => {
        const mkdir = (p: string) => {
            dirs.add(normalizePath(p));
            return true;
        };
        expect(mkdir("C:\\NFSUNDER")).toBe(true);
        expect(parentDirectoryExists("C:\\NFSUNDER\\ZDIR.BIN", directoryExists)).toBe(true);
    });
});
