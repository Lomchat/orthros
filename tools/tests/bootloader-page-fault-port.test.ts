import { describe, expect, test } from "bun:test";
import {
  createBootloader,
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
});
