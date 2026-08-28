import { describe, expect, test } from "bun:test";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { exports as processExports } from "../../src/worker/modules/kernel32/process/process";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

describe("kernel32 debugger detection", () => {
  test("declares CheckRemoteDebuggerPresent as a two-argument stdcall", () => {
    const descriptor = kernel32Module.functions.find((fn) => fn.name === "CheckRemoteDebuggerPresent");
    expect(descriptor?.callingConvention).toBe("stdcall");
    expect(descriptor?.params).toHaveLength(2);
  });

  test("reports a valid call with no debugger attached", () => {
    const mem = new Uint8Array(64);
    Mem.bind(() => mem);
    mem.fill(0xff, 16, 20);
    expect(processExports.CheckRemoteDebuggerPresent!({} as never, mem, [0xffffffff, 16])).toBe(1);
    expect(new DataView(mem.buffer).getUint32(16, true)).toBe(0);
  });
});
