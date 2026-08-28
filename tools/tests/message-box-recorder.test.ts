import { beforeEach, describe, expect, test } from "bun:test";
import {
  getGuestMessageBoxes,
  recordGuestMessageBox,
  resetGuestMessageBoxes,
} from "../../src/worker/core/diagnostics/message-box-recorder";

describe("guest MessageBox recorder", () => {
  beforeEach(resetGuestMessageBoxes);

  test("keeps a defensive copy of recent messages", () => {
    recordGuestMessageBox({ kind: "MessageBoxA", caption: "Error", text: "missing asset", style: 0x10, eip: 0x401000 });
    const first = getGuestMessageBoxes();
    first[0]!.text = "mutated";
    expect(getGuestMessageBoxes()).toEqual([
      { kind: "MessageBoxA", caption: "Error", text: "missing asset", style: 0x10, eip: 0x401000 },
    ]);
  });

  test("bounds the diagnostic ring", () => {
    for (let i = 0; i < 12; i++) {
      recordGuestMessageBox({ kind: "MessageBoxW", caption: `c${i}`, text: `t${i}`, style: i, eip: i });
    }
    const records = getGuestMessageBoxes();
    expect(records).toHaveLength(8);
    expect(records[0]!.text).toBe("t4");
    expect(records[7]!.text).toBe("t11");
  });
});
