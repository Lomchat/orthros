/**
 * Kernel32 Environment functions
 *
 * Atomic implementation for environment variable operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import { encodeAnsi } from '../codepage-utils';

export const exports: Record<string, ThunkImplementation> = (() => {
    const exports: Record<string, ThunkImplementation> = {};

    exports['GetEnvironmentVariableW'] = (ctx, mem, args) => {
        const lpName = args[0];
        const lpBuffer = args[1];
        const nSize = args[2];

        const name = Marshaler.readWideString(mem, lpName);
        Logger.verbose(LogCategory.KERNEL32, `GetEnvironmentVariableW("${name}", ${nSize})`);

        const process = System.getInstance().process;
        if (!process) {
            return 0;
        }

        const value = process.environment.get(name.toUpperCase());
        if (value === undefined) {
            return 0; // Variable not found
        }

        const charsNeeded = value.length + 1; // with null

        if (nSize < charsNeeded) {
            return charsNeeded; // Return required buffer size
        }

        if (lpBuffer) {
            Marshaler.writeWideString(mem, lpBuffer, value, nSize);
        }

        return charsNeeded - 1; // Length without null terminator
    };

    exports['GetEnvironmentVariableA'] = (ctx, mem, args) => {
        const lpName = args[0];
        const lpBuffer = args[1];
        const nSize = args[2];

        const name = Marshaler.readString(mem, lpName);
        Logger.verbose(LogCategory.KERNEL32, `GetEnvironmentVariableA("${name}", ${nSize})`);

        const process = System.getInstance().process;
        if (!process) {
            return 0;
        }

        const value = process.environment.get(name.toUpperCase());
        if (value === undefined) {
            return 0; // Variable not found
        }

        const bytesNeeded = encodeAnsi(value + "\0").length;

        if (nSize < bytesNeeded) {
            return bytesNeeded; // Return required buffer size
        }

        if (lpBuffer) {
            Marshaler.writeString(mem, lpBuffer, value, nSize);
        }

        return bytesNeeded - 1; // Length without null terminator
    };

    exports['SetEnvironmentVariableW'] = (ctx, mem, args) => {
        const lpName = args[0];
        const lpValue = args[1];

        const name = Marshaler.readWideString(mem, lpName);
        const value = lpValue ? Marshaler.readWideString(mem, lpValue) : null;

        Logger.log(LogCategory.KERNEL32, `SetEnvironmentVariableW("${name}", "${value}")`);

        const process = System.getInstance().process;
        if (!process) {
            return 0; // FALSE
        }

        if (value !== null) {
            process.environment.set(name.toUpperCase(), value);
        } else {
            process.environment.delete(name.toUpperCase());
        }

        return 1; // TRUE
    };

    exports['SetEnvironmentVariableA'] = (ctx, mem, args) => {
        const lpName = args[0];
        const lpValue = args[1];

        const name = Marshaler.readString(mem, lpName);
        const value = lpValue ? Marshaler.readString(mem, lpValue) : null;

        Logger.log(LogCategory.KERNEL32, `SetEnvironmentVariableA("${name}", "${value}")`);

        const process = System.getInstance().process;
        if (!process) {
            return 0; // FALSE
        }

        if (value !== null) {
            process.environment.set(name.toUpperCase(), value);
        } else {
            process.environment.delete(name.toUpperCase());
        }

        return 1; // TRUE
    };

    exports['GetEnvironmentStrings'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, 'GetEnvironmentStrings()');

        const process = System.getInstance().process;
        if (!process) {
            return 0;
        }

        // Create environment block
        let totalSize = 1; // Final null
        for (const [key, value] of process.environment) {
            totalSize += key.length + 1 + value.length + 1; // key=value\0
        }

        const address = process.allocateMemory(totalSize);
        if (address) {
            let offset = 0;
            for (const [key, value] of process.environment) {
                const line = `${key}=${value}`;
                offset += Marshaler.writeString(mem, address + offset, line);
            }
            mem[address + offset] = 0; // Final null
            return address;
        }

        return 0;
    };

    exports['GetEnvironmentStringsW'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, 'GetEnvironmentStringsW()');

        const process = System.getInstance().process;
        if (!process) {
            return 0;
        }

        // Create wide environment block
        let totalChars = 1; // Final null
        for (const [key, value] of process.environment) {
            totalChars += key.length + 1 + value.length + 1; // key=value\0
        }

        const address = process.allocateMemory(totalChars * 2);
        if (address) {
            let offset = 0;
            for (const [key, value] of process.environment) {
                const line = `${key}=${value}`;
                offset += Marshaler.writeWideString(mem, address + offset, line);
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(address + offset, 0, true); // Final null
            return address;
        }

        return 0;
    };

    exports['FreeEnvironmentStringsA'] = (ctx, mem, args) => {
        const lpszEnvironmentBlock = args[0];

        Logger.verbose(LogCategory.KERNEL32, `FreeEnvironmentStringsA(0x${lpszEnvironmentBlock.toString(16)})`);

        // For now, just return success
        // In a real implementation, this would free the memory
        return 1; // TRUE
    };

    exports['FreeEnvironmentStringsW'] = (ctx, mem, args) => {
        const lpszEnvironmentBlock = args[0];

        Logger.verbose(LogCategory.KERNEL32, `FreeEnvironmentStringsW(0x${lpszEnvironmentBlock.toString(16)})`);

        // For now, just return success
        // In a real implementation, this would free the memory
        return 1; // TRUE
    };

    return exports;
})();