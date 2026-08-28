import { beforeEach, describe, expect, test } from "bun:test";
import { getMissingFiles, recordMissingFile, resetMissingFiles } from "../../src/worker/core/diagnostics/missing-file-recorder";

describe("missing file recorder", () => {
  beforeEach(resetMissingFiles);

  test("keeps the latest 64 probes in chronological order", () => {
    for (let i = 0; i < 70; i++) recordMissingFile("CreateFileW", `C:\\f${i}`, i, i);
    const rows = getMissingFiles();
    expect(rows).toHaveLength(64);
    expect(rows[0]!.path).toBe("C:\\f6");
    expect(rows[63]!.path).toBe("C:\\f69");
  });
});
