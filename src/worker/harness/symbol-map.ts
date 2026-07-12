/**
 * Sidecar symbol map — the static-RE ↔ dynamic-harness bridge.
 *
 * moduleRegistry.resolveAddress only maps address -> nearest EXPORT label, and
 * getExportAddress only resolves EXPORTS. C++ internals like UInput::ReadInput
 * are not exports, so breakOnSymbol needs a sidecar {name -> RVA} map (produced
 * by the RE layer, e.g. tools/re exportSymbolMap) loaded per game and relocated
 * against the live module base. Kept OUT of moduleRegistry (it's the RE bridge).
 */

import { proc } from "./serialize";

interface LoadedMap {
    /** symbol name -> RVA (offset from module base). */
    symbols: Map<string, number>;
}

class SymbolMapRegistry {
    /** moduleName(lowercased, no .dll) -> map. */
    private maps = new Map<string, LoadedMap>();

    /** Load/replace a module's sidecar map. entries: {name -> RVA}. */
    load(moduleName: string, entries: Record<string, number>): number {
        const key = this.norm(moduleName);
        const symbols = new Map<string, number>();
        for (const [name, rva] of Object.entries(entries)) symbols.set(name, rva >>> 0);
        this.maps.set(key, { symbols });
        return symbols.size;
    }

    clear(): void {
        this.maps.clear();
    }

    loaded(): Array<{ module: string; symbols: number }> {
        return [...this.maps.entries()].map(([module, m]) => ({ module, symbols: m.symbols.size }));
    }

    /**
     * Resolve a symbol to a live linear address. Accepts "module!Symbol",
     * "module.dll!Symbol", or a bare "Symbol" (searched across all loaded maps).
     * Returns the RVA relocated against the module's live base.
     */
    resolve(name: string): number | undefined {
        const bang = name.indexOf("!");
        if (bang >= 0) {
            const mod = this.norm(name.slice(0, bang));
            return this.resolveIn(mod, name.slice(bang + 1));
        }
        for (const mod of this.maps.keys()) {
            const addr = this.resolveIn(mod, name);
            if (addr !== undefined) return addr;
        }
        return undefined;
    }

    private resolveIn(moduleKey: string, symbol: string): number | undefined {
        const m = this.maps.get(moduleKey);
        if (!m) return undefined;
        const rva = m.symbols.get(symbol);
        if (rva === undefined) return undefined;
        const base = this.moduleBase(moduleKey);
        if (base === undefined) return undefined;
        return (base + rva) >>> 0;
    }

    /** Live base address of a loaded module (by name, .dll-insensitive). */
    private moduleBase(moduleKey: string): number | undefined {
        const mr: any = proc()?.moduleRegistry as any;
        if (!mr?.getAllModules) return undefined;
        for (const m of mr.getAllModules()) {
            if (this.norm(m.name) === moduleKey) return m.baseAddress >>> 0;
        }
        return undefined;
    }

    private norm(name: string): string {
        return name.toLowerCase().replace(/\.dll$/i, "");
    }
}

export const symbolMap = new SymbolMapRegistry();
