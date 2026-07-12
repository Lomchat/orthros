import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import type { RegionPerms } from "./address-space";

export function isValidAddress(mem: Uint8Array, address: number, size?: number, perms?: RegionPerms): boolean;
export function isValidAddress(address: number, size?: number, perms?: RegionPerms): boolean;
export function isValidAddress(
    memOrAddress: Uint8Array | number,
    addressOrSize?: number,
    sizeOrPerms?: number | RegionPerms,
    perms: RegionPerms = "rw"
): boolean {
    const address = typeof memOrAddress === "number" ? memOrAddress : (addressOrSize ?? 0);
    const size = typeof sizeOrPerms === "number" ? sizeOrPerms : 1;
    const finalPerms = typeof sizeOrPerms === "string" ? sizeOrPerms : perms;

    if (address < 0 || size < 0) {
        return false;
    }

    const space = System.getInstance().process?.addressSpace;
    if (!space) return true;

    const valid = space.validateRange(address, size, finalPerms);
    if (!valid) {
        Logger.warn(LogCategory.SYSTEM, `AddressGuard: invalid access 0x${address.toString(16)}+${size.toString(16)} perms=${finalPerms}`);
    }
    return valid;
}

/**
 * Check if an address range overlaps with THUNK_CODE region.
 * THUNK_CODE is executable code that must never be written to by surfaces or game code.
 *
 * @param address Starting address
 * @param size Size of the range
 * @returns true if overlaps with THUNK_CODE, false otherwise
 */
export function overlapsThunkCode(address: number, size: number): boolean {
    if (address < 0 || size < 0) {
        return false;
    }

    const space = System.getInstance().process?.addressSpace;
    if (!space) return false;

    // THUNK_CODE is now created by ThunkMemoryManager, not as a layout bucket
    const thunkRegion = space.findRegionByKind("THUNK_CODE") ?? space.getLayoutBucket("THUNK_CODE");
    if (!thunkRegion) return false;

    const end = address + size;
    const thunkEnd = thunkRegion.base + thunkRegion.size;

    return address < thunkEnd && end > thunkRegion.base;
}

/**
 * Check if an address range is safe for surface pixels (not in THUNK_CODE or other protected regions).
 *
 * @param address Starting address
 * @param size Size of the range
 * @returns true if safe to use as surface memory, false otherwise
 */
export function isSafeSurfaceAddress(address: number, size: number): boolean {
    if (address < 0 || size < 0) {
        return false;
    }

    // Check basic validity (not in noaccess regions)
    if (!isValidAddress(address, size, "rw")) {
        return false;
    }

    // Explicitly check THUNK_CODE overlap
    if (overlapsThunkCode(address, size)) {
        Logger.error(LogCategory.SYSTEM,
            `🚨 isSafeSurfaceAddress: BLOCKED - address 0x${address.toString(16)} size 0x${size.toString(16)} ` +
            `overlaps THUNK_CODE region!`);
        return false;
    }

    return true;
}
