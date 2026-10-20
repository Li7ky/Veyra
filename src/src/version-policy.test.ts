import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 版本策略：每个版本最多 5 个 beta（beta.1–beta.5）。
 * 到 5 之后必须升版本号重新计数，避免出现 beta.6 / beta.7 这种无限延长。
 * 这条测试挂在 npm test 里，改版本号时会被卡住。
 */
const conf = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")
) as { version: string };

describe("版本策略", () => {
  it("beta 序号不超过 5", () => {
    const match = /-beta\.(\d+)$/.exec(conf.version);
    if (!match) return; // 正式版不检查
    expect(Number(match[1])).toBeLessThanOrEqual(5);
  });

  it("版本号格式为 x.y.z 或 x.y.z-beta.N", () => {
    expect(conf.version).toMatch(/^\d+\.\d+\.\d+(?:-beta\.[1-5])?$/);
  });
});
