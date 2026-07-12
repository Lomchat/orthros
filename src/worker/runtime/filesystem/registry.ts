import { RegistryPersistence, RegistryAccessLogEntry, PersistedRegistryState } from "./registry-persistence";
import { Logger, LogCategory } from "../../core/logger";

export type RegistryValueType = "REG_SZ" | "REG_DWORD" | "REG_BINARY" | "REG_MULTI_SZ";

const VALID_REG_TYPES = new Set<string>(["REG_SZ", "REG_DWORD", "REG_BINARY", "REG_MULTI_SZ"]);
const IMPLICIT_EMPTY_KEYS = new Set<string>([
    "hkcu\\software",
    "hklm\\software",
]);

function validateRegType(type: string): RegistryValueType {
    if (!VALID_REG_TYPES.has(type)) {
        throw new Error(`Unknown registry type "${type}". Valid types: ${[...VALID_REG_TYPES].join(", ")}`);
    }
    return type as RegistryValueType;
}

export interface RegistryValue {
    name: string;
    type: RegistryValueType;
    data: string | number;
}

export interface RegistrySeed {
    root: string;
    path: string;
    values: RegistryValue[];
}

export class RegistryStore {
    private keys: Map<string, Map<string, RegistryValue>> = new Map();
    private gameId: string = "";
    private accessLogBuffer: RegistryAccessLogEntry[] = [];
    private onChangeCallback: (() => void) | null = null;
    private readonly MAX_LOG_BUFFER_SIZE = 1000;

    reset(): void {
        this.keys.clear();
        this.accessLogBuffer = [];
        this.gameId = "";
        this.onChangeCallback = null;
    }

    seed(seed: RegistrySeed | RegistrySeed[] | any): void {
        // Support array of RegistrySeed objects
        if (Array.isArray(seed)) {
            Logger.log(LogCategory.SYSTEM, `Registry seed: processing array of ${seed.length} entries`);
            for (const entry of seed) {
                this.seed(entry);
            }
            return;
        }
        // Support single RegistrySeed object
        if (seed.root && seed.path && Array.isArray(seed.values)) {
            const key = this.normalizeKey(seed.root, seed.path);
            Logger.log(LogCategory.SYSTEM, `Registry seed: ${key} (${seed.values.length} values)`);
            let existing = this.keys.get(key);
            if (!existing) {
                existing = new Map();
                this.keys.set(key, existing);
            }
            for (const value of seed.values) {
                existing.set(value.name.toLowerCase(), {
                    ...value,
                    type: validateRegType(value.type),
                });
            }
        } else {
            // Hierarchical format: { "HKEY_LOCAL_MACHINE": { "Software": { ... } } }
            this.seedHierarchical(seed);
        }
    }

    private seedHierarchical(obj: any, currentRoot: string = "", currentPath: string = ""): void {
        for (const [name, value] of Object.entries(obj)) {
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                if (!currentRoot) {
                    // Top level is root (HKLM, HKCU, etc)
                    this.seedHierarchical(value, name, "");
                } else {
                    // Nested is a subkey
                    const newPath = currentPath ? `${currentPath}\\${name}` : name;
                    this.seedHierarchical(value, currentRoot, newPath);
                }
            } else {
                // It's a value for the current key
                if (currentRoot) {
                    const keyHandle = this.normalizeKey(currentRoot, currentPath);
                    let values = this.keys.get(keyHandle);
                    if (!values) {
                        values = new Map();
                        this.keys.set(keyHandle, values);
                    }
                    
                    const regValue: RegistryValue = {
                        name: name,
                        type: typeof value === "number" ? "REG_DWORD" : "REG_SZ",
                        data: value as string | number
                    };
                    values.set(name.toLowerCase(), regValue);
                }
            }
        }
    }

    open(root: string, path: string): string | null {
        const key = this.normalizeKey(root, path);
        if (this.keys.has(key)) return key;
        if (IMPLICIT_EMPTY_KEYS.has(key)) return key;
        // Support opening intermediate keys: if any stored key starts with this prefix,
        // the intermediate key implicitly exists (Windows registry semantics).
        const prefix = key + "\\";
        for (const k of this.keys.keys()) {
            if (k.startsWith(prefix)) {
                // Create the intermediate key so future lookups are O(1)
                this.keys.set(key, new Map());
                return key;
            }
        }
        return null;
    }

    getValue(keyHandle: string, valueName: string): RegistryValue | null {
        const values = this.keys.get(keyHandle);
        const value = values ? values.get(valueName.toLowerCase()) ?? null : null;

        // Log access
        this.logAccess({
            ts: Date.now(),
            op: "RegQueryValueEx",
            key: keyHandle,
            value: valueName,
            result: value ? "success" : "not_found",
            data: value?.data,
        });

        return value;
    }

    setValue(keyHandle: string, valueName: string, value: RegistryValue): void {
        let values = this.keys.get(keyHandle);
        if (!values) {
            values = new Map();
            this.keys.set(keyHandle, values);
        }
        values.set(valueName.toLowerCase(), value);

        // Log access
        this.logAccess({
            ts: Date.now(),
            op: "RegSetValueEx",
            key: keyHandle,
            value: valueName,
            result: "success",
            data: value.data,
        });

        // Notify change
        this.notifyChange();
    }

    createKey(root: string, path: string): { key: string; isNew: boolean } {
        const key = this.normalizeKey(root, path);
        const isNew = !this.keys.has(key);
        if (isNew) {
            this.keys.set(key, new Map());

            // Log access
            this.logAccess({
                ts: Date.now(),
                op: "RegCreateKeyEx",
                key: key,
                value: "",
                result: "success",
            });

            // Notify change
            this.notifyChange();
        }
        return { key, isNew };
    }

    deleteKey(baseKey: string, subKey?: string): boolean {
        const fullKey = this.resolveKey(baseKey, subKey);
        const toDelete: string[] = [];
        for (const key of this.keys.keys()) {
            if (key === fullKey || key.startsWith(`${fullKey}\\`)) {
                toDelete.push(key);
            }
        }
        if (toDelete.length === 0) {
            this.logAccess({
                ts: Date.now(),
                op: "RegDeleteKey",
                key: fullKey,
                value: "",
                result: "not_found",
            });
            return false;
        }

        for (const key of toDelete) {
            this.keys.delete(key);
        }

        this.logAccess({
            ts: Date.now(),
            op: "RegDeleteKey",
            key: fullKey,
            value: "",
            result: "success",
        });

        this.notifyChange();
        return true;
    }

    deleteValue(baseKey: string, valueName: string): boolean {
        const fullKey = this.resolveKey(baseKey);
        const values = this.keys.get(fullKey);
        if (!values) {
            this.logAccess({
                ts: Date.now(),
                op: "RegDeleteValue",
                key: fullKey,
                value: valueName,
                result: "not_found",
            });
            return false;
        }

        const deleted = values.delete(valueName.toLowerCase());
        this.logAccess({
            ts: Date.now(),
            op: "RegDeleteValue",
            key: fullKey,
            value: valueName,
            result: deleted ? "success" : "not_found",
        });

        if (deleted) {
            this.notifyChange();
        }
        return deleted;
    }

    enumValues(keyHandle: string): RegistryValue[] {
        const values = this.keys.get(keyHandle);
        if (!values) return [];
        return Array.from(values.values());
    }

    getKeyInfo(keyHandle: string): { valueCount: number; maxValueNameLen: number; maxValueDataLen: number } {
        const values = this.keys.get(keyHandle);
        if (!values) return { valueCount: 0, maxValueNameLen: 0, maxValueDataLen: 0 };

        let maxNameLen = 0;
        let maxDataLen = 0;
        for (const val of values.values()) {
            maxNameLen = Math.max(maxNameLen, val.name.length);
            if (val.type === "REG_DWORD") {
                maxDataLen = Math.max(maxDataLen, 4);
            } else if (val.type === "REG_BINARY" || val.type === "REG_MULTI_SZ") {
                maxDataLen = Math.max(maxDataLen, String(val.data).length / 2);
            } else {
                // REG_SZ — include null terminator byte
                maxDataLen = Math.max(maxDataLen, String(val.data).length + 1);
            }
        }
        return { valueCount: values.size, maxValueNameLen: maxNameLen, maxValueDataLen: maxDataLen };
    }

    enumSubKeys(baseKey: string): string[] {
        const fullKey = this.resolveKey(baseKey);
        const prefix = `${fullKey}\\`;
        const names = new Set<string>();

        for (const key of this.keys.keys()) {
            if (!key.startsWith(prefix)) continue;
            const remainder = key.slice(prefix.length);
            const next = remainder.split("\\")[0];
            if (next) names.add(next);
        }

        const list = Array.from(names);
        list.sort();

        this.logAccess({
            ts: Date.now(),
            op: "RegEnumKeyEx",
            key: fullKey,
            value: "",
            result: list.length > 0 ? "success" : "not_found",
        });

        return list;
    }

    private normalizeKey(root: string, path: string): string {
        const cleanRoot = root.toUpperCase();
        const cleanPath = path.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
        return `${cleanRoot}\\${cleanPath}`.toLowerCase();
    }

    private resolveKey(baseKey: string, subKey?: string): string {
        const cleanBase = baseKey.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "").toLowerCase();
        if (!subKey) return cleanBase;
        const cleanSub = subKey.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
        if (!cleanSub) return cleanBase;
        if (cleanBase.includes("\\")) {
            return `${cleanBase}\\${cleanSub}`.toLowerCase();
        }
        return this.normalizeKey(cleanBase, cleanSub);
    }

    /**
     * Set the current game ID for persistence
     */
    setGameId(gameId: string): void {
        this.gameId = gameId;
    }

    /**
     * Set callback to be called when registry changes
     */
    setOnChange(callback: (() => void) | null): void {
        this.onChangeCallback = callback;
    }

    /**
     * Serialize current registry state for persistence
     */
    serialize(): PersistedRegistryState {
        const keysObj: Record<string, Record<string, { name: string; type: string; data: string | number }>> = {};

        for (const [keyPath, values] of this.keys.entries()) {
            const valuesObj: Record<string, { name: string; type: string; data: string | number }> = {};
            for (const [valueName, value] of values.entries()) {
                valuesObj[valueName] = {
                    name: value.name,
                    type: value.type,
                    data: value.data,
                };
            }
            keysObj[keyPath] = valuesObj;
        }

        return {
            version: 2,
            gameId: this.gameId,
            lastModified: Date.now(),
            keys: keysObj,
        };
    }

    /**
     * Restore registry state from persisted data
     */
    restore(state: PersistedRegistryState): void {
        for (const [keyPath, valuesObj] of Object.entries(state.keys)) {
            const values = new Map<string, RegistryValue>();
            for (const [valueName, valueData] of Object.entries(valuesObj)) {
                values.set(valueName.toLowerCase(), {
                    name: valueData.name,
                    type: validateRegType(valueData.type),
                    data: valueData.data,
                });
            }
            this.keys.set(keyPath, values);
        }
    }

    /**
     * Log registry access operation
     */
    private logAccess(entry: RegistryAccessLogEntry): void {
        // Add to buffer (ring buffer behavior)
        this.accessLogBuffer.push(entry);
        if (this.accessLogBuffer.length > this.MAX_LOG_BUFFER_SIZE) {
            this.accessLogBuffer.shift();
        }
    }

    /**
     * Notify change listeners
     */
    private notifyChange(): void {
        if (this.onChangeCallback) {
            this.onChangeCallback();
        }
    }

    /**
     * Flush access log buffer to OPFS
     */
    async flushAccessLog(): Promise<void> {
        if (this.accessLogBuffer.length === 0 || !this.gameId) {
            return;
        }

        const entries = [...this.accessLogBuffer];
        this.accessLogBuffer = [];

        await RegistryPersistence.appendAccessLog(this.gameId, entries);
    }

    /**
     * Get current access log buffer (for UI display)
     */
    getAccessLogBuffer(): RegistryAccessLogEntry[] {
        return [...this.accessLogBuffer];
    }
}
