import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import profiles from "./profiles.cjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "veyra-profiles-"));
}

describe("profiles content validation", () => {
  it("rejects non-text profile content before writing", () => {
    const root = tempDir();
    try {
      const item = profiles.importLocal(root, "main", "mode: rule\n");
      expect(() => profiles.writeContent(root, item.uid, null)).toThrow(/必须是文本/);
      expect(profiles.readContent(root, item.uid)).toBe("mode: rule\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
