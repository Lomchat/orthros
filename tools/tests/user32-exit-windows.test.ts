import { describe, expect, test } from "bun:test";
import { user32Module } from "../../src/worker/api/user32.api";
import { createSystemExports } from "../../src/worker/modules/user32/system";

describe("user32 ExitWindowsEx", () => {
  test("declares the two-argument stdcall ABI", () => {
    const descriptor = user32Module.functions.find((fn) => fn.name === "ExitWindowsEx");
    expect(descriptor?.callingConvention).toBe("stdcall");
    expect(descriptor?.params).toHaveLength(2);
  });

  test("acknowledges the request without shutting down the browser host", () => {
    const result = createSystemExports().ExitWindowsEx!({} as never, new Uint8Array(), [0x2, 0]);
    expect(result).toBe(1);
  });
});
