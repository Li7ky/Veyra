import { describe, it, expect } from "vitest";
import { enhance } from "../electron/enhance.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-enhance-"));
  return { root, profiles: path.join(root, "profiles"), runtime: path.join(root, "config.yaml") };
}

describe("enhance defaults", () => {
  it("uses the default controller port when omitted", () => {
    const { root, profiles, runtime } = tempDirs();
    try {
      fs.mkdirSync(profiles, { recursive: true });
      const result = enhance(profiles, runtime, { mixedPort: 7897 });
      expect(result.config["external-controller"]).toBe("127.0.0.1:19097");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
