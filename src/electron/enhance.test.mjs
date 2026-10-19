import { describe, it, expect } from "vitest";
import { enhance, applyMerge, enhanceAndWrite } from "../electron/enhance.cjs";
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

describe("applyMerge 空键处理", () => {
  const keys = ["rules", "proxies", "proxy-groups", "proxy-providers", "rule-providers"];

  it("YAML 里的空键（值为 null）不会把 null 写进配置", () => {
    // 回归：`rules:` 这种空键会被 js-yaml 载入为 null，直接赋值会产出 `rules: null`，
    // mihomo 判定规则集非数组后拒绝整份配置 —— 分流全失效甚至内核起不来。
    for (const k of keys) {
      const cfg = { [k]: [{ name: "keep-me" }] };
      const warnings = applyMerge(cfg, `${k}:\n`);
      expect(cfg[k], `${k} 不应被 null 覆盖`).toEqual([{ name: "keep-me" }]);
      expect(warnings.some((w) => w.includes(k)), `${k} 应产生告警`).toBe(true);
    }
  });

  it("非空键正常写入", () => {
    const cfg = {};
    applyMerge(cfg, "rules:\n  - MATCH,DIRECT\n");
    expect(cfg.rules).toEqual(["MATCH,DIRECT"]);
  });
});

describe("enhanceAndWrite 原子写", () => {
  it("写出完整内容，且不留下临时文件", () => {
    const { root, profiles, runtime } = tempDirs();
    try {
      fs.mkdirSync(profiles, { recursive: true });
      enhanceAndWrite(profiles, runtime, { mixedPort: 7897 });
      const text = fs.readFileSync(runtime, "utf8");
      expect(text).toContain("mixed-port");
      // tmp+rename 的临时文件必须被清理干净，否则用户目录会越来越乱
      const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
