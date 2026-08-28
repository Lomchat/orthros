import { describe, expect, test } from "bun:test";
import {
  createBootloader,
  EXCEPTION_HANDLER_START,
  PF_HALT_TARGET,
  PF_HANDLER_END,
  PF_HANDLER_START,
} from "../../src/worker/core/bootloader";

describe("bootloader page-fault transport", () => {
  test("routes recoverable page faults through their dedicated I/O port", () => {
    const boot = createBootloader(0x401000, 0x100000);
    const handlerAddress = PF_HALT_TARGET - 19;
    const handlerOffset = handlerAddress - boot.loadAddress;
    const handler = boot.code.slice(handlerOffset, handlerOffset + 23);

    expect(Array.from(handler.slice(0, 13))).toEqual([
      0x50,
      0x52,
      0xb8, 0x0e, 0x00, 0xad, 0xde,
      0xba, 0x78, 0xb0, 0x00, 0x00,
      0xef,
    ]);
    expect(PF_HANDLER_START).toBe(handlerAddress);
    expect(PF_HANDLER_END - PF_HANDLER_START).toBe(23);
  });

  test("routes every other CPU exception away from the Win32 thunk port", () => {
    const boot = createBootloader(0x401000, 0x100000);
    const handler = (slot: number) =>
      boot.code.slice(EXCEPTION_HANDLER_START - boot.loadAddress + slot * 25,
        EXCEPTION_HANDLER_START - boot.loadAddress + slot * 25 + 12);
    const port = (bytes: Uint8Array) =>
      new DataView(bytes.buffer, bytes.byteOffset + 6, 4).getUint32(0, true);

    expect(port(handler(0))).toBe(0xB079); // generic
    expect(port(handler(1))).toBe(0xB07A); // #UD
    expect(port(handler(2))).toBe(0xB07B); // #GP
    expect(port(handler(4))).toBe(0xB07D); // int 2e
    expect(port(handler(5))).toBe(0xB07E); // int 80
    expect(port(handler(6))).toBe(0xB07C); // #DE
  });
});
